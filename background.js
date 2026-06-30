// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

// Alarm names are prefixed with the tab ID so each tab
// gets its own independent alarm.
const ALARM_PREFIX = "autorefresh_tab_";

// Default interval in seconds if the user hasn't set one yet.
const DEFAULT_INTERVAL_SECONDS = 1;

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Returns the alarm name for a given tab ID.
 * @param {number} tabId
 * @returns {string}
 */
function alarmName(tabId) {
  return `${ALARM_PREFIX}${tabId}`;
}

/**
 * Reads the user-configured interval from chrome.storage.sync.
 * Falls back to DEFAULT_INTERVAL_SECONDS if not set.
 * @returns {Promise<number>} interval in seconds
 */
async function getIntervalSeconds() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      { intervalSeconds: DEFAULT_INTERVAL_SECONDS },
      (data) => {
        const val = parseFloat(data.intervalSeconds);
        // Guard against nonsensical values (alarms require >= 1 minute
        // for periodInMinutes, but we'll use delayInMinutes trick below).
        resolve(isNaN(val) || val <= 0 ? DEFAULT_INTERVAL_SECONDS : val);
      },
    );
  });
}

/**
 * Checks whether a specific tab currently has an active alarm.
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function isTabRefreshing(tabId) {
  const alarm = await chrome.alarms.get(alarmName(tabId));
  return alarm !== undefined;
}

/**
 * Updates the browser action badge to reflect ON/OFF state.
 * @param {number} tabId
 * @param {boolean} isOn
 */
function updateBadge(tabId, isOn) {
  if (isOn) {
    chrome.action.setBadgeText({ text: "ON", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#16a34a", tabId }); // green-700
    chrome.action.setTitle({
      title: "Auto Refresh: ON — Click to stop",
      tabId,
    });
  } else {
    chrome.action.setBadgeText({ text: "OFF", tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#dc2626", tabId }); // red-600
    chrome.action.setTitle({
      title: "Auto Refresh: OFF — Click to start",
      tabId,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// CORE: START / STOP REFRESH
// ─────────────────────────────────────────────────────────────

/**
 * Starts auto-refresh for a tab by creating a repeating alarm.
 *
 * chrome.alarms minimum period is 1 minute for periodInMinutes.
 * For sub-minute intervals, we chain single-shot alarms:
 *   each alarm fires → reloads tab → schedules the next alarm.
 *
 * @param {number} tabId
 */
async function startRefresh(tabId) {
  const seconds = await getIntervalSeconds();

  // Store the interval alongside the tab so the alarm handler
  // knows how long to wait before scheduling the next shot.
  await chrome.storage.session.set({ [`tab_interval_${tabId}`]: seconds });

  // Create the first single-shot alarm (delayInMinutes accepts decimals).
  chrome.alarms.create(alarmName(tabId), {
    delayInMinutes: seconds / 60,
  });

  updateBadge(tabId, true);
  console.log(`[AutoRefresh] Started for tab ${tabId} every ${seconds}s`);
}

/**
 * Stops auto-refresh for a tab by clearing its alarm.
 * @param {number} tabId
 */
async function stopRefresh(tabId) {
  await chrome.alarms.clear(alarmName(tabId));
  await chrome.storage.session.remove(`tab_interval_${tabId}`);
  updateBadge(tabId, false);
  console.log(`[AutoRefresh] Stopped for tab ${tabId}`);
}

// ─────────────────────────────────────────────────────────────
// EVENT: TOOLBAR ICON CLICKED
// ─────────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  // tab.id can be undefined for some special pages (e.g. chrome://newtab).
  if (!tab.id) return;

  const refreshing = await isTabRefreshing(tab.id);

  if (refreshing) {
    await stopRefresh(tab.id);
  } else {
    await startRefresh(tab.id);
  }
});

// ─────────────────────────────────────────────────────────────
// EVENT: ALARM FIRED → RELOAD TAB + RESCHEDULE
// ─────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Only handle our own alarms.
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;

  // Extract the tab ID from the alarm name.
  const tabId = parseInt(alarm.name.replace(ALARM_PREFIX, ""), 10);
  if (isNaN(tabId)) return;

  // Verify the tab still exists before reloading.
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    // Tab was closed — clean up silently.
    await chrome.storage.session.remove(`tab_interval_${tabId}`);
    console.log(`[AutoRefresh] Tab ${tabId} no longer exists. Stopping.`);
    return;
  }

  // Don't reload if the tab is currently loading (avoid reload storms).
  if (tab.status !== "loading") {
    chrome.tabs.reload(tabId);
    console.log(`[AutoRefresh] Reloaded tab ${tabId}`);
  }

  // Reschedule the next single-shot alarm using the stored interval.
  const result = await chrome.storage.session.get(`tab_interval_${tabId}`);
  const seconds = result[`tab_interval_${tabId}`] ?? DEFAULT_INTERVAL_SECONDS;

  chrome.alarms.create(alarmName(tabId), {
    delayInMinutes: seconds / 60,
  });
});

// ─────────────────────────────────────────────────────────────
// EVENT: TAB CLOSED → AUTO CLEANUP
// ─────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Clear any lingering alarm and session data when a tab closes.
  await chrome.alarms.clear(alarmName(tabId));
  await chrome.storage.session.remove(`tab_interval_${tabId}`);
  console.log(`[AutoRefresh] Cleaned up closed tab ${tabId}`);
});

// ─────────────────────────────────────────────────────────────
// STARTUP: RESTORE BADGE STATE
// ─────────────────────────────────────────────────────────────
// When the service worker restarts, existing alarms survive but
// the badge is visual-only and resets. Re-apply badges for any
// tabs that still have active alarms.

chrome.runtime.onStartup.addListener(restoreBadges);
chrome.runtime.onInstalled.addListener(restoreBadges);

async function restoreBadges() {
  const allAlarms = await chrome.alarms.getAll();
  for (const alarm of allAlarms) {
    if (alarm.name.startsWith(ALARM_PREFIX)) {
      const tabId = parseInt(alarm.name.replace(ALARM_PREFIX, ""), 10);
      if (!isNaN(tabId)) {
        updateBadge(tabId, true);
      }
    }
  }
}
