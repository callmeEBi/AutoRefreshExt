// ═══════════════════════════════════════════════════════════════
//  AUTO REFRESH — BACKGROUND SERVICE WORKER  (Manifest V3)
//
//  Architecture:
//    1. User clicks icon  →  toggle ON/OFF for that tabId
//    2. ON:  save {tabId, interval} to session storage
//            inject reloadScript into the tab (setTimeout → reload)
//            start a countdown ticker in THIS worker (setInterval)
//    3. Tab finishes reloading  →  tabs.onUpdated fires
//            if tabId is active in session  →  re-inject + restart ticker
//    4. OFF: remove from session, clear ticker, clear badge
// ═══════════════════════════════════════════════════════════════

const DEFAULT_INTERVAL = 5; // seconds — fallback if storage is empty

// In-memory map of active countdown tickers.
// Key: tabId (number)  Value: setInterval ID (number)
// This lives only in the service worker's memory; it is rebuilt
// from session storage whenever the worker wakes up.
const countdownTickers = new Map();

// ───────────────────────────────────────────────────────────────
// STORAGE HELPERS
// chrome.storage.session  →  which tabs are active + their interval
// chrome.storage.sync     →  user's preferred interval from options page
// ───────────────────────────────────────────────────────────────

/**
 * Returns the full map of active tabs from session storage.
 * Shape: { [tabId: string]: { interval: number, startedAt: number } }
 * @returns {Promise<Object>}
 */
async function getActiveTabs() {
  const result = await chrome.storage.session.get("activeTabs");
  return result.activeTabs ?? {};
}

/**
 * Persists the full active-tabs map back to session storage.
 * @param {Object} map
 */
async function setActiveTabs(map) {
  await chrome.storage.session.set({ activeTabs: map });
}

/**
 * Checks if a specific tab is currently active.
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function isTabActive(tabId) {
  const map = await getActiveTabs();
  return Object.prototype.hasOwnProperty.call(map, String(tabId));
}

/**
 * Reads the user-configured interval from sync storage.
 * @returns {Promise<number>} seconds
 */
async function getUserInterval() {
  const result = await chrome.storage.sync.get({
    intervalSeconds: DEFAULT_INTERVAL,
  });
  const val = parseFloat(result.intervalSeconds);
  return isNaN(val) || val < 0.5 ? DEFAULT_INTERVAL : val;
}

// ───────────────────────────────────────────────────────────────
// BADGE HELPERS
// ───────────────────────────────────────────────────────────────

/**
 * Sets the badge to show a countdown number (green background).
 * @param {number} tabId
 * @param {number} seconds  — the number to display
 */
function setBadgeCountdown(tabId, seconds) {
  const label = seconds > 99 ? "99+" : String(Math.ceil(seconds));
  chrome.action.setBadgeText({ text: label, tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#16a34a", tabId });
}

/**
 * Clears the badge (OFF state).
 * @param {number} tabId
 */
function clearBadge(tabId) {
  chrome.action.setBadgeText({ text: "", tabId });
  chrome.action.setTitle({
    title: "Auto Refresh: OFF — Click to start",
    tabId,
  });
}

/**
 * Sets the badge to a static "ON" flash shown right after a reload,
 * before the countdown restarts.
 * @param {number} tabId
 */
function setBadgeOn(tabId) {
  chrome.action.setBadgeText({ text: "ON", tabId });
  chrome.action.setBadgeBackgroundColor({ color: "#16a34a", tabId });
  chrome.action.setTitle({ title: "Auto Refresh: ON — Click to stop", tabId });
}

// ───────────────────────────────────────────────────────────────
// COUNTDOWN TICKER
// Runs entirely inside the service worker using setInterval.
// Counts down from `interval` to 1, updating the badge each second.
// The tab reload itself is handled by the injected script — this
// ticker is purely visual.
// ───────────────────────────────────────────────────────────────

/**
 * Stops and removes the countdown ticker for a tab.
 * @param {number} tabId
 */
function stopTicker(tabId) {
  if (countdownTickers.has(tabId)) {
    clearInterval(countdownTickers.get(tabId));
    countdownTickers.delete(tabId);
  }
}

/**
 * Starts a new countdown ticker for a tab.
 * Counts down from `intervalSeconds` to 1, then stops
 * (the reload event will restart it via tabs.onUpdated).
 *
 * @param {number} tabId
 * @param {number} intervalSeconds
 */
function startTicker(tabId, intervalSeconds) {
  // Always clear any existing ticker first to avoid duplicates.
  stopTicker(tabId);

  // Remaining time starts at the full interval.
  let remaining = intervalSeconds;
  setBadgeCountdown(tabId, remaining);

  const tickerId = setInterval(() => {
    remaining -= 1;

    if (remaining <= 0) {
      // The injected script is about to fire window.location.reload().
      // Show "ON" as a visual bridge until the page reloads and
      // tabs.onUpdated restarts the ticker.
      setBadgeOn(tabId);
      stopTicker(tabId);
      return;
    }

    setBadgeCountdown(tabId, remaining);
  }, 1000); // tick every real second

  countdownTickers.set(tabId, tickerId);
}

// ───────────────────────────────────────────────────────────────
// SCRIPT INJECTION
// Injects a tiny self-contained script into the tab.
// The script uses setTimeout to call window.location.reload()
// after the specified interval. It stores its timeout ID on
// window so it can be cancelled by a follow-up injection.
// ───────────────────────────────────────────────────────────────

/**
 * Injects the reload script into a tab.
 * @param {number} tabId
 * @param {number} intervalSeconds
 */
async function injectReloadScript(tabId, intervalSeconds) {
  const ms = Math.round(intervalSeconds * 1000);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      // `func` is serialised and run in the page's context.
      // It must be self-contained — no closure variables from
      // background.js are available inside it.
      func: (delayMs) => {
        // Cancel any previously injected timeout to prevent
        // double-reloads if the script is injected more than once.
        if (window.__autoRefreshTimeoutId !== undefined) {
          clearTimeout(window.__autoRefreshTimeoutId);
        }

        window.__autoRefreshTimeoutId = setTimeout(() => {
          window.location.reload();
        }, delayMs);
      },
      args: [ms],
    });
  } catch (err) {
    // Injection can fail on chrome:// pages, the new-tab page, etc.
    // In that case, silently stop refreshing this tab.
    console.warn(`[AutoRefresh] Cannot inject into tab ${tabId}:`, err.message);
    await deactivateTab(tabId);
  }
}

/**
 * Injects a cancellation script to clear the pending setTimeout.
 * Called when the user toggles OFF.
 * @param {number} tabId
 */
async function injectCancelScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (window.__autoRefreshTimeoutId !== undefined) {
          clearTimeout(window.__autoRefreshTimeoutId);
          window.__autoRefreshTimeoutId = undefined;
        }
      },
    });
  } catch {
    // Tab may already be gone or on a restricted page — that's fine.
  }
}

// ───────────────────────────────────────────────────────────────
// ACTIVATE / DEACTIVATE
// ───────────────────────────────────────────────────────────────

/**
 * Activates auto-refresh for a tab.
 * @param {number} tabId
 */
async function activateTab(tabId) {
  const interval = await getUserInterval();

  // Persist to session storage so we survive service worker restarts.
  const map = await getActiveTabs();
  map[String(tabId)] = { interval, startedAt: Date.now() };
  await setActiveTabs(map);

  // Inject the reload script into the live tab.
  await injectReloadScript(tabId, interval);

  // Start the visual countdown in the service worker.
  startTicker(tabId, interval);

  console.log(`[AutoRefresh] Activated tab ${tabId} — interval: ${interval}s`);
}

/**
 * Deactivates auto-refresh for a tab.
 * @param {number} tabId
 */
async function deactivateTab(tabId) {
  // Remove from session storage.
  const map = await getActiveTabs();
  delete map[String(tabId)];
  await setActiveTabs(map);

  // Stop the countdown ticker.
  stopTicker(tabId);

  // Cancel the pending setTimeout inside the tab (best-effort).
  await injectCancelScript(tabId);

  // Clear the badge.
  clearBadge(tabId);

  console.log(`[AutoRefresh] Deactivated tab ${tabId}`);
}

// ───────────────────────────────────────────────────────────────
// EVENT: TOOLBAR ICON CLICKED  →  toggle ON / OFF
// ───────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  const active = await isTabActive(tab.id);

  if (active) {
    await deactivateTab(tab.id);
  } else {
    await activateTab(tab.id);
  }
});

// ───────────────────────────────────────────────────────────────
// EVENT: TAB UPDATED  →  re-inject after each reload completes
//
// This is the core of the loop:
//   page reloads  →  status becomes 'complete'  →  we re-inject
//   the setTimeout script  →  page reloads again  →  repeat
// ───────────────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // We only care about tabs that have finished loading.
  if (changeInfo.status !== "complete") return;

  const map = await getActiveTabs();
  const entry = map[String(tabId)];

  // Not one of our active tabs — ignore.
  if (!entry) return;

  const { interval } = entry;

  // Re-inject the reload script now that the page is fresh.
  await injectReloadScript(tabId, interval);

  // Restart the visual countdown.
  startTicker(tabId, interval);

  console.log(
    `[AutoRefresh] Tab ${tabId} reloaded — re-injected, countdown restarted`,
  );
});

// ───────────────────────────────────────────────────────────────
// EVENT: TAB CLOSED  →  clean up
// ───────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const active = await isTabActive(tabId);
  if (!active) return;

  // Just clean up storage and ticker — no need to inject cancel script.
  const map = await getActiveTabs();
  delete map[String(tabId)];
  await setActiveTabs(map);

  stopTicker(tabId);
  console.log(`[AutoRefresh] Tab ${tabId} closed — cleaned up`);
});

// ───────────────────────────────────────────────────────────────
// SERVICE WORKER WAKE-UP  →  restore tickers from session storage
//
// When Chrome restarts the service worker (after it went dormant),
// countdownTickers is empty. We rebuild it from session storage
// so any previously-active tabs resume their countdown display.
// The reload loop itself will continue via tabs.onUpdated as long
// as the injected script is still running in the tab.
// ───────────────────────────────────────────────────────────────

async function restoreActiveState() {
  const map = await getActiveTabs();

  for (const [tabIdStr, entry] of Object.entries(map)) {
    const tabId = parseInt(tabIdStr, 10);
    if (isNaN(tabId)) continue;

    // Verify the tab still exists.
    try {
      await chrome.tabs.get(tabId);
    } catch {
      // Tab is gone — remove stale entry.
      delete map[tabIdStr];
      continue;
    }

    // Restart the ticker so the badge shows a live countdown again.
    startTicker(tabId, entry.interval);
    setBadgeOn(tabId);
    console.log(`[AutoRefresh] Restored ticker for tab ${tabId}`);
  }

  // Persist cleaned-up map (stale tabs removed).
  await setActiveTabs(map);
}

// Runs when the service worker first installs or Chrome starts.
chrome.runtime.onInstalled.addListener(restoreActiveState);
chrome.runtime.onStartup.addListener(restoreActiveState);
