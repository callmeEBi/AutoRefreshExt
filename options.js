// ─────────────────────────────────────────────────────────────
// OPTIONS PAGE LOGIC
// Loads the saved interval on page open, saves on button click.
// ─────────────────────────────────────────────────────────────

const intervalInput = document.getElementById("intervalInput");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

let statusTimer = null; // Tracks the fade-out timer so we can reset it.

// ── Load saved value when the options page opens ──────────────
chrome.storage.sync.get({ intervalSeconds: 1 }, (data) => {
  intervalInput.value = data.intervalSeconds;
});

// ── Save on button click ──────────────────────────────────────
saveBtn.addEventListener("click", () => {
  const raw = parseFloat(intervalInput.value);

  // Validate: must be a positive number.
  if (isNaN(raw) || raw <= 0) {
    showStatus("⚠ Please enter a valid positive number.", "#dc2626");
    return;
  }

  // Round to 2 decimal places to avoid floating-point noise.
  const intervalSeconds = Math.round(raw * 100) / 100;

  chrome.storage.sync.set({ intervalSeconds }, () => {
    showStatus("✓ Settings saved!", "#16a34a");
    console.log(`[Options] Saved interval: ${intervalSeconds}s`);
  });
});

// ── Also save when the user presses Enter in the input ────────
intervalInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});

/**
 * Shows a temporary status message below the save button.
 * @param {string} message
 * @param {string} color  CSS color string
 */
function showStatus(message, color) {
  statusEl.textContent = message;
  statusEl.style.color = color;
  statusEl.classList.add("visible");

  // Clear any previous timer so rapid saves don't stack.
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.classList.remove("visible");
  }, 2500);
}
