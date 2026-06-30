// ─────────────────────────────────────────────────────────────
//  OPTIONS PAGE — options.js
//  Loads saved interval on open, saves on button click.
//  Preset buttons fill the input for quick selection.
// ─────────────────────────────────────────────────────────────

const intervalInput = document.getElementById("intervalInput");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");
const presetBtns = document.querySelectorAll(".preset-btn");

let statusTimer = null;

// ── Load saved value when the options page opens ──────────────
chrome.storage.sync.get({ intervalSeconds: 5 }, (data) => {
  intervalInput.value = data.intervalSeconds;
});

// ── Preset buttons fill the input field ──────────────────────
presetBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    intervalInput.value = btn.dataset.value;
    // Immediately save when a preset is clicked for convenience.
    saveSettings();
  });
});

// ── Save button ───────────────────────────────────────────────
saveBtn.addEventListener("click", saveSettings);

// ── Enter key in input ────────────────────────────────────────
intervalInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveSettings();
});

/**
 * Validates the input and persists the interval to sync storage.
 */
function saveSettings() {
  const raw = parseFloat(intervalInput.value);

  if (isNaN(raw) || raw < 0.5) {
    showStatus("⚠ Minimum interval is 0.5 seconds.", "#dc2626");
    intervalInput.focus();
    return;
  }

  // Round to 2 decimal places.
  const intervalSeconds = Math.round(raw * 100) / 100;

  chrome.storage.sync.set({ intervalSeconds }, () => {
    showStatus("✓ Saved! Active tabs will use this on next toggle.", "#16a34a");
    console.log(`[Options] Saved intervalSeconds = ${intervalSeconds}`);
  });
}

/**
 * Displays a temporary status message with auto-fade.
 * @param {string} message
 * @param {string} color
 */
function showStatus(message, color) {
  statusEl.textContent = message;
  statusEl.style.color = color;
  statusEl.classList.add("visible");

  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.classList.remove("visible");
  }, 3000);
}
