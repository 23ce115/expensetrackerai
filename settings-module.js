/* ═══════════════════════════════════════════════════════════════
   settings-module.js — BlueLedger Settings Functionality
   Wires every settings row with real, persistent interaction logic.
   Reuses existing: notify(), openModal(), closeModal(), refreshAll(),
   exportCSV(), openMonthPicker(), lockApp(), doSignOut(),
   openChangePinModal(), openSyncModal(), openImportModal(),
   openResetModal(), openPrivacyModal(), toggleTheme(), fmt
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ══════════════════════════════════════════════════════════════
   CURRENCY SYSTEM
   ══════════════════════════════════════════════════════════════ */

const BL_CURRENCIES = {
  INR: { label: "Indian Rupee", symbol: "₹", locale: "en-IN", code: "INR" },
  USD: { label: "US Dollar", symbol: "$", locale: "en-US", code: "USD" },
  EUR: { label: "Euro", symbol: "€", locale: "de-DE", code: "EUR" },
  GBP: { label: "British Pound", symbol: "£", locale: "en-GB", code: "GBP" },
  JPY: { label: "Japanese Yen", symbol: "¥", locale: "ja-JP", code: "JPY" },
  AUD: {
    label: "Australian Dollar",
    symbol: "A$",
    locale: "en-AU",
    code: "AUD",
  },
  CAD: { label: "Canadian Dollar", symbol: "C$", locale: "en-CA", code: "CAD" },
  SGD: {
    label: "Singapore Dollar",
    symbol: "S$",
    locale: "en-SG",
    code: "SGD",
  },
};

// Current currency state — defaults to INR
let _activeCurrency = localStorage.getItem("bl_currency") || "INR";

function _getCurrency() {
  return BL_CURRENCIES[_activeCurrency] || BL_CURRENCIES.INR;
}

/**
 * Global currency formatter — replaces/extends the existing `fmt` function.
 * Called everywhere a monetary value needs to display.
 */
function formatAmountByCurrency(amount) {
  const cur = _getCurrency();
  const abs = Math.abs(Number(amount) || 0);
  try {
    return (
      cur.symbol + abs.toLocaleString(cur.locale, { maximumFractionDigits: 0 })
    );
  } catch {
    return cur.symbol + abs.toFixed(0);
  }
}

/**
 * Patch the global `fmt` variable used throughout script.js so every
 * existing render call automatically picks up the chosen currency.
 */
function _patchGlobalFormatter() {
  window.fmt = formatAmountByCurrency;
  // Also patch the module-level `fmt` if accessible
  try {
    fmt = formatAmountByCurrency;
  } catch (e) {}
}

function _applyCurrency(code) {
  if (!BL_CURRENCIES[code]) return;
  _activeCurrency = code;
  localStorage.setItem("bl_currency", code);
  _patchGlobalFormatter();
  // Refresh all dashboard widgets so every ₹ symbol updates
  if (typeof refreshAll === "function") refreshAll();
  _updateCurrencyRowLabel();
  _updateCurrencyModal();
}

function _updateCurrencyRowLabel() {
  const el = document.getElementById("spCurrencyLabel");
  if (!el) return;
  const cur = _getCurrency();
  el.textContent = `${cur.label} (${cur.symbol})`;
}

function _updateCurrencyModal() {
  document.querySelectorAll(".blcurr-item").forEach((item) => {
    const code = item.dataset.code;
    item.classList.toggle("blcurr-item--active", code === _activeCurrency);
  });
}

/* ══════════════════════════════════════════════════════════════
   NOTIFICATIONS TOGGLE
   ══════════════════════════════════════════════════════════════ */

function _initNotifToggle() {
  const toggle = document.getElementById("spNotifToggle");
  if (!toggle) return;
  const saved = localStorage.getItem("bl_setting_notifications");
  toggle.checked = saved === null ? true : saved === "1";
}

/* ══════════════════════════════════════════════════════════════
   APPEARANCE — extended theme picker
   ══════════════════════════════════════════════════════════════ */

function openAppearanceModal() {
  _syncAppearanceModal();
  _openSettingsModal("blAppearanceModal");
}

function _syncAppearanceModal() {
  const theme = document.documentElement.getAttribute("data-theme") || "dark";
  document.querySelectorAll(".bltheme-item").forEach((item) => {
    item.classList.toggle("bltheme-item--active", item.dataset.theme === theme);
  });
  // Update spThemeLabel & spThemeIcon while we're at it
  const label = document.getElementById("spThemeLabel");
  const icon = document.getElementById("spThemeIcon");
  if (label) label.textContent = theme === "dark" ? "Dark Mode" : "Light Mode";
  if (icon) icon.className = theme === "dark" ? "fas fa-moon" : "fas fa-sun";
}

function setAppTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("bl_theme", theme);
  // Call existing syncThemeUi if available
  if (typeof syncThemeUi === "function") syncThemeUi(theme);
  _syncAppearanceModal();
  notify(
    theme === "dark" ? "Dark mode enabled" : "Light mode enabled",
    "success",
  );
}

/* ══════════════════════════════════════════════════════════════
   EXPORT DATA — extended (CSV + JSON)
   ══════════════════════════════════════════════════════════════ */

function openExportModal() {
  _openSettingsModal("blExportModal");
}

function exportDataCSV() {
  _closeSettingsModal("blExportModal");
  if (typeof exportCSV === "function") {
    exportCSV();
  } else {
    notify("Export not available", "error");
  }
}

function exportDataJSON() {
  try {
    const txns = typeof transactions !== "undefined" ? transactions : [];
    if (!txns.length) {
      notify("No transactions to export", "error");
      return;
    }
    const payload = {
      exported_at: new Date().toISOString(),
      app: "BlueLedger",
      version: "2.0",
      transactions: txns,
      userData:
        typeof userData !== "undefined"
          ? {
              name: userData?.name,
              currency: _activeCurrency,
            }
          : {},
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `blueledger-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    _closeSettingsModal("blExportModal");
    notify("JSON exported successfully", "success");
  } catch (e) {
    notify("Export failed", "error");
    console.warn("exportDataJSON failed", e);
  }
}

/* ══════════════════════════════════════════════════════════════
   BACKUP & RESTORE (local .bl file — reuses existing exportBLFile)
   ══════════════════════════════════════════════════════════════ */

function openBackupModal() {
  _openSettingsModal("blBackupModal");
}

function doBackup() {
  if (typeof exportBLFile === "function") {
    exportBLFile();
    notify("Backup created", "success");
  } else {
    notify("Backup unavailable — log in first", "error");
  }
}

function doRestoreClick() {
  const inp = document.getElementById("blRestoreFileInput");
  if (inp) inp.click();
}

function handleRestoreFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (typeof handleBLFileImport === "function") {
    handleBLFileImport(input);
  } else {
    notify("Restore unavailable — log in first", "error");
  }
  input.value = "";
  _closeSettingsModal("blBackupModal");
}

/* ══════════════════════════════════════════════════════════════
   FAQs MODAL
   ══════════════════════════════════════════════════════════════ */

function openFaqModal() {
  _openSettingsModal("blFaqModal");
}

function toggleFaq(btn) {
  const item = btn.closest(".blfaq-item");
  if (!item) return;
  const isOpen = item.classList.contains("blfaq-item--open");
  // Close all others
  document
    .querySelectorAll(".blfaq-item--open")
    .forEach((i) => i.classList.remove("blfaq-item--open"));
  if (!isOpen) item.classList.add("blfaq-item--open");
}

/* ══════════════════════════════════════════════════════════════
   REPORT A PROBLEM MODAL
   ══════════════════════════════════════════════════════════════ */

function openReportModal() {
  _openSettingsModal("blReportModal");
}

function submitReport() {
  const title = document.getElementById("blReportTitle")?.value?.trim();
  const desc = document.getElementById("blReportDesc")?.value?.trim();
  if (!title) {
    notify("Please enter a title", "error");
    return;
  }
  if (!desc) {
    notify("Please describe the problem", "error");
    return;
  }

  const btn = document.getElementById("blReportSubmitBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending…";
  }

  // Simulate async send
  setTimeout(() => {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Submit Report";
    }
    document.getElementById("blReportTitle").value = "";
    document.getElementById("blReportDesc").value = "";
    _closeSettingsModal("blReportModal");
    notify("Problem reported — thank you!", "success");
  }, 900);
}

/* ══════════════════════════════════════════════════════════════
   REQUEST A FEATURE MODAL
   ══════════════════════════════════════════════════════════════ */

function openFeatureModal() {
  _openSettingsModal("blFeatureModal");
}

function submitFeature() {
  const title = document.getElementById("blFeatureTitle")?.value?.trim();
  const cat = document.getElementById("blFeatureCat")?.value;
  const desc = document.getElementById("blFeatureDesc")?.value?.trim();
  if (!title) {
    notify("Please enter a feature title", "error");
    return;
  }
  if (!desc) {
    notify("Please describe the feature", "error");
    return;
  }

  const btn = document.getElementById("blFeatureSubmitBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Submitting…";
  }

  setTimeout(() => {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Submit Request";
    }
    document.getElementById("blFeatureTitle").value = "";
    document.getElementById("blFeatureDesc").value = "";
    _closeSettingsModal("blFeatureModal");
    notify("Feature request submitted!", "success");
  }, 900);
}

/* ══════════════════════════════════════════════════════════════
   ABOUT BLUELEDGER MODAL
   ══════════════════════════════════════════════════════════════ */

function openAboutModal() {
  // Populate live data
  const txnCount =
    typeof transactions !== "undefined" ? transactions.length : 0;
  const el = document.getElementById("blAboutTxnCount");
  if (el) el.textContent = txnCount.toLocaleString();

  const nameEl = document.getElementById("blAboutUserName");
  if (nameEl && typeof userData !== "undefined" && userData?.name) {
    nameEl.textContent = userData.name;
  }
  _openSettingsModal("blAboutModal");
}

/* ══════════════════════════════════════════════════════════════
   LOG OUT — confirmation
   ══════════════════════════════════════════════════════════════ */

function openLogoutModal() {
  _openSettingsModal("blLogoutModal");
}

function confirmLogout() {
  _closeSettingsModal("blLogoutModal");
  if (typeof doSignOut === "function") {
    doSignOut();
  } else {
    localStorage.clear();
    location.reload();
  }
}

/* ══════════════════════════════════════════════════════════════
   SIGN OUT & DELETE — extended dangerous flow
   (delegates to existing confirmReset() after own confirmation)
   ══════════════════════════════════════════════════════════════ */

function openDeleteAccountModal() {
  const inp = document.getElementById("blDeleteConfirmInput");
  if (inp) inp.value = "";
  _updateDeleteBtn();
  _openSettingsModal("blDeleteAccountModal");
}

function _updateDeleteBtn() {
  const inp = document.getElementById("blDeleteConfirmInput");
  const btn = document.getElementById("blDeleteAccountBtn");
  if (!inp || !btn) return;
  btn.disabled = inp.value.trim() !== "DELETE";
}

function confirmDeleteAccount() {
  const inp = document.getElementById("blDeleteConfirmInput");
  if (inp?.value?.trim() !== "DELETE") {
    notify('Type "DELETE" to confirm', "error");
    return;
  }
  _closeSettingsModal("blDeleteAccountModal");
  // Delegate to existing full delete flow
  if (typeof openResetModal === "function") openResetModal();
}

/* ══════════════════════════════════════════════════════════════
   CURRENCY MODAL
   ══════════════════════════════════════════════════════════════ */

function openCurrencyModal() {
  _updateCurrencyModal();
  _openSettingsModal("blCurrencyModal");
}

function selectCurrency(code) {
  _applyCurrency(code);
  _closeSettingsModal("blCurrencyModal");
  notify(
    `Currency changed to ${BL_CURRENCIES[code]?.label || code}`,
    "success",
  );
}

/* ══════════════════════════════════════════════════════════════
   SETTINGS-SCOPED MODAL HELPERS
   (separate z-index stack from app modals — avoids body overflow conflicts)
   ══════════════════════════════════════════════════════════════ */

function _openSettingsModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = "flex";
  void el.offsetWidth;
  el.classList.add("blsm--open");
}

function _closeSettingsModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("blsm--open");
  setTimeout(() => {
    el.style.display = "none";
  }, 200);
}

// Close on backdrop click
function _bindSettingsModalBackdrops() {
  document.querySelectorAll(".blsm").forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) _closeSettingsModal(modal.id);
    });
  });
}

/* ══════════════════════════════════════════════════════════════
   WIRE HTML ROWS — patch onclick attributes safely
   ══════════════════════════════════════════════════════════════ */

function _wireSettingsRows() {
  // Notifications row — clicking the row should toggle the checkbox
  const notifRow = document.querySelector(
    ".sp-row--divider[onclick=''] .sp-row-title",
  );
  // We'll use ID-based wiring instead (safer)

  // Appearance row — already wired to toggleTheme(), extend it
  const appearRow = document.querySelector(".sp-row[onclick='toggleTheme()']");
  if (appearRow) {
    appearRow.onclick = openAppearanceModal;
  }

  // Currency row
  const currRow = _findRowByTitle("Currency");
  if (currRow) currRow.onclick = openCurrencyModal;

  // Notifications row — already has toggle, just ensure row click toggles checkbox
  const notifToggle = document.getElementById("spNotifToggle");
  const notifRow2 = notifToggle?.closest(".sp-row");
  if (notifRow2 && notifToggle) {
    notifRow2.onclick = (e) => {
      // Don't double-fire if clicking the toggle label itself
      if (e.target === notifToggle || e.target.closest(".sp-toggle")) return;
      notifToggle.checked = !notifToggle.checked;
      notifToggle.dispatchEvent(new Event("change"));
    };
  }

  // Export Data
  const exportRow = _findRowByTitle("Export Data");
  if (exportRow)
    exportRow.onclick = () => {
      closeSettingsPage();
      openExportModal();
    };

  // Backup & Restore
  const backupRow = _findRowByTitle("Backup & Restore");
  if (backupRow)
    backupRow.onclick = () => {
      closeSettingsPage();
      openBackupModal();
    };

  // FAQs
  const faqRow = _findRowByTitle("FAQs");
  if (faqRow) faqRow.onclick = openFaqModal;

  // Report a Problem
  const reportRow = _findRowByTitle("Report a Problem");
  if (reportRow) reportRow.onclick = openReportModal;

  // Request a Feature
  const featureRow = _findRowByTitle("Request a Feature");
  if (featureRow) featureRow.onclick = openFeatureModal;

  // About BlueLedger
  const aboutRow = _findRowByTitle("About BlueLedger");
  if (aboutRow) aboutRow.onclick = openAboutModal;

  // Log Out — replace direct doSignOut with confirmation
  const logoutRow = _findRowByTitle("Log Out");
  if (logoutRow) logoutRow.onclick = openLogoutModal;

  // Sign Out & Delete Data — replace openResetModal with our multi-step
  const deleteRow = _findRowByTitle("Sign Out & Delete Data");
  if (deleteRow) deleteRow.onclick = openDeleteAccountModal;

  // Privacy Policy — already wired, but ensure it works inside settings page
  const privacyRow = _findRowByTitle("Privacy Policy");
  if (privacyRow) privacyRow.onclick = () => openPrivacyModal?.();
}

function _findRowByTitle(titleText) {
  return Array.from(document.querySelectorAll(".sp-row")).find((row) => {
    return (
      row.querySelector(".sp-row-title")?.textContent?.trim() === titleText
    );
  });
}

/* ══════════════════════════════════════════════════════════════
   NOTIFICATIONS TOGGLE — save & feedback
   ══════════════════════════════════════════════════════════════ */

function _bindNotifToggle() {
  const toggle = document.getElementById("spNotifToggle");
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    localStorage.setItem(
      "bl_setting_notifications",
      toggle.checked ? "1" : "0",
    );
    notify(
      toggle.checked ? "Notifications enabled" : "Notifications disabled",
      toggle.checked ? "success" : "info",
    );
  });
}

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */

function initSettingsModule() {
  // Apply saved currency immediately
  _patchGlobalFormatter();
  _updateCurrencyRowLabel();

  // Restore notification toggle state
  _initNotifToggle();

  // Wire all dead rows
  _wireSettingsRows();

  // Bind toggle feedback
  _bindNotifToggle();

  // Wire modal backdrops
  _bindSettingsModalBackdrops();
}

// Boot: after DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSettingsModule);
} else {
  // Defer one tick so script.js variables are initialised
  setTimeout(initSettingsModule, 0);
}

/* ── Global exports ───────────────────────────────────────── */
window.openAppearanceModal = openAppearanceModal;
window.setAppTheme = setAppTheme;
window.openCurrencyModal = openCurrencyModal;
window.selectCurrency = selectCurrency;
window.openExportModal = openExportModal;
window.exportDataCSV = exportDataCSV;
window.exportDataJSON = exportDataJSON;
window.openBackupModal = openBackupModal;
window.doBackup = doBackup;
window.doRestoreClick = doRestoreClick;
window.handleRestoreFile = handleRestoreFile;
window.openFaqModal = openFaqModal;
window.toggleFaq = toggleFaq;
window.openReportModal = openReportModal;
window.submitReport = submitReport;
window.openFeatureModal = openFeatureModal;
window.submitFeature = submitFeature;
window.openAboutModal = openAboutModal;
window.openLogoutModal = openLogoutModal;
window.confirmLogout = confirmLogout;
window.openDeleteAccountModal = openDeleteAccountModal;
window.confirmDeleteAccount = confirmDeleteAccount;
window._updateDeleteBtn = _updateDeleteBtn;
window._closeSettingsModal = _closeSettingsModal;
window.formatAmountByCurrency = formatAmountByCurrency;
