/* ═══════════════════════════════════════════════════════════════
   main.js — BlueLedger App Entry Point
   Initialises the app, connects all modules, attaches
   event listeners, and manages global application state.

   LOAD ORDER (in HTML):
     1. utils.js
     2. ai.js
     3. voice.js
     4. receipt.js
     5. chart.js  (or charts.js)
     6. main.js   ← this file
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ══════════════════════════════════════════════════════════════
   GLOBAL CONSTANTS
   ══════════════════════════════════════════════════════════════ */

window.BASE_INCOME_CATS = [
  "Salary",
  "Freelance",
  "Business",
  "Investment",
  "Insurance",
];
window.BASE_EXPENSE_CATS = [
  "Food",
  "Entertainment",
  "Shopping",
  "Transport",
  "Health",
  "Investment",
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

window.CAT_COLORS = {
  Food: "#f97316",
  Entertainment: "#f59e0b",
  Shopping: "#eab308",
  Transport: "#3b82f6",
  Health: "#ec4899",
  Investment: "#10b981",
  Salary: "#06b6d4",
  Freelance: "#0ea5e9",
  Business: "#6366f1",
  Insurance: "#8b5cf6",
  Other: "#a78bfa",
};

/* ── Security & auth ─────────────────────────────────────────── */
const STORAGE_KEY = "bl_vault";
const VERIFY_TOKEN = "BL_OK_v1";
const VERIFY_TOKEN_V2 = "BL_OK_v2";
const VAULT_SCHEMA_VERSION = 1;
const SYNC_PENDING_KEY = "bl_sync_pending_v1";
const SYNC_DEVICE_KEY = "bl_sync_device_v1";
const SYNC_TABLE = "encrypted_vaults";
const SYNC_POLL_MS = 30 * 1000;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 30 * 1000;
const AUTO_LOCK_MS = 5 * 60 * 1000;
const AUTH_MODE_KEY = "bl_auth_mode";
const WEBAUTHN_CRED_ID_KEY = "bl_webauthn_cred_id";
const WEBAUTHN_PWD_VAULT_KEY = "bl_webauthn_pwd_vault";
const WEBAUTHN_RP_ID_KEY = "bl_webauthn_rp_id";

/* ── Supabase ────────────────────────────────────────────────── */
const BL_SUPABASE_URL = "https://fptiscqzzimxxtgjejhz.supabase.co";
const BL_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwdGlzY3F6emlteHh0Z2plamh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxOTcwMTgsImV4cCI6MjA5MDc3MzAxOH0.6BTK1JiEH9EvvEvp5sV41GF7gQcgUCPqKqDB4JhjQBE";

/* ══════════════════════════════════════════════════════════════
   MUTABLE APPLICATION STATE
   ══════════════════════════════════════════════════════════════ */

let sessionPin = null;
let autoLockTimer = null;
let pinBuffer = "";
let pinAttempts = 0;
let pinLockedUntil = 0;

let cards = [];
let activeCardIdx = 0;
let addingNewCard = false;

// Active card data — synced to/from cards[] by loadActiveCard / syncActiveToCards
let userData = null;
let transactions = [];
let customCategories = [];
let categoryBudgets = {};
let recurringTemplates = [];

let currentPeriod = "monthly";
let chartPeriod = "monthly";
let sortCfg = { field: "date", order: "desc" };
let filterCfg = { type: "all", cats: [] };
let ctxId = null;
let searchQuery = "";
let deleteTargetId = null;
let summaryMonth = new Date().getMonth();
let summaryYear = new Date().getFullYear();
let txnExpanded = false;
let pendingAddFlow = null;
let syncConfig = null;
let supabaseClient = null;
let syncChannel = null;
let syncPushTimer = null;
let syncPollTimer = null;
let syncBusy = false;
let suppressSyncPush = false;
let syncFocusHandlerBound = false;

const CARD_ACCENT_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ec4899"];
const TXN_PREVIEW_LIMITS = { daily: 6, weekly: 7, monthly: 8, picked: 8 };

/* ══════════════════════════════════════════════════════════════
   CRYPTO HELPERS
   ══════════════════════════════════════════════════════════════ */

function encrypt(data, pin) {
  return CryptoJS.AES.encrypt(JSON.stringify(data), pin).toString();
}

function tryDecrypt(ciphertext, pin) {
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, pin);
    return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   SUPABASE CLIENT
   ══════════════════════════════════════════════════════════════ */

function getBLClient() {
  if (!supabaseClient) {
    supabaseClient = supabase.createClient(
      BL_SUPABASE_URL,
      BL_SUPABASE_ANON_KEY,
    );
  }
  return supabaseClient;
}

/* ══════════════════════════════════════════════════════════════
   ANALYTICS / CHART DATA ACCESSOR
   Used by chart.js to get the right transaction slice.
   ══════════════════════════════════════════════════════════════ */

/**
 * Returns the transactions that should be used for analytics.
 * Respects the active card context.
 * @returns {Array}
 */
function getAnalyticsTransactions() {
  return Array.isArray(transactions) ? transactions : [];
}

/* ══════════════════════════════════════════════════════════════
   DATE / MATHS HELPERS
   ══════════════════════════════════════════════════════════════ */

function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function sumInc(txns) {
  return (txns || [])
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + (t.amount || 0), 0);
}

function sumExp(txns) {
  return (txns || [])
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + Math.abs(t.amount || 0), 0);
}

function fmt(n) {
  return formatINR(n);
}

function getBounds(period) {
  const now = new Date();
  if (period === "daily") {
    const start = toDay(now);
    return { start, end: start };
  }
  if (period === "weekly") {
    const dow = now.getDay();
    const daysToMon = dow === 0 ? -6 : 1 - dow;
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + daysToMon,
    );
    const end = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + 6,
    );
    return { start, end };
  }
  // monthly (default)
  return {
    start: new Date(now.getFullYear(), now.getMonth(), 1),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 0),
  };
}

function getTxns(period, sourceTxns = transactions) {
  const { start, end } = getBounds(period);
  return (sourceTxns || []).filter((t) => {
    const d = toDay(new Date(t.date + "T00:00:00"));
    return d >= start && d <= end;
  });
}

/* ══════════════════════════════════════════════════════════════
   CHART INTEGRATION
   ══════════════════════════════════════════════════════════════ */

/**
 * Set chart period and trigger a redraw.
 * @param {string} period — "daily" | "weekly" | "monthly"
 */
function setChartPeriod(period) {
  chartPeriod = period;
  if (typeof updateOverviewChart === "function") {
    updateOverviewChart(period);
  } else {
    console.warn("updateOverviewChart not available");
  }
}

/**
 * Backward-compatible chart render shim.
 */
function renderChart(period, sourceTxns) {
  if (typeof updateOverviewChart === "function") {
    updateOverviewChart(period || chartPeriod);
  }
}

/* ══════════════════════════════════════════════════════════════
   SYNC CONFIG DEFAULTS
   ══════════════════════════════════════════════════════════════ */

function defaultSyncConfig() {
  return {
    enabled: false,
    url: BL_SUPABASE_URL,
    anonKey: BL_SUPABASE_ANON_KEY,
    email: "",
    userId: "",
    syncKeyHex: "",
    deviceId: "",
    lastSyncedHash: "",
    lastSyncedAt: "",
    lastRemoteUpdatedAt: "",
    lastLocalChangeAt: "",
    status: "local",
  };
}

syncConfig = defaultSyncConfig();

function cleanSyncConfig(raw) {
  return { ...defaultSyncConfig(), ...(raw || {}) };
}

function getDeviceId() {
  let id = localStorage.getItem(SYNC_DEVICE_KEY);
  if (!id) {
    id =
      (window.crypto?.randomUUID && window.crypto.randomUUID()) ||
      `device-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    localStorage.setItem(SYNC_DEVICE_KEY, id);
  }
  return id;
}

/* ══════════════════════════════════════════════════════════════
   MULTI-CARD HELPERS
   ══════════════════════════════════════════════════════════════ */

function syncActiveToCards() {
  if (cards[activeCardIdx]) {
    cards[activeCardIdx] = {
      ...cards[activeCardIdx],
      userData,
      transactions,
      customCategories,
      categoryBudgets,
      recurringTemplates,
    };
  }
}

function loadActiveCard() {
  const c = cards[activeCardIdx];
  if (!c) return;
  userData = c.userData || null;
  transactions = c.transactions || [];
  customCategories = c.customCategories || [];
  categoryBudgets = c.categoryBudgets || {};
  recurringTemplates = c.recurringTemplates || [];
}

function getCardDisplayName(card, idx = 0) {
  if (!card) return `Account ${idx + 1}`;
  const nickname = card.userData?.nickname?.trim();
  if (nickname) return nickname;
  const name = card.userData?.name?.trim();
  if (name) return name;
  const last4 = (card.userData?.cardNumber || "").replace(/\D/g, "").slice(-4);
  return last4 ? `Account ${last4}` : `Account ${idx + 1}`;
}

function getCardDisplaySub(card) {
  const last4 = (card?.userData?.cardNumber || "").replace(/\D/g, "").slice(-4);
  return last4 ? `Card ending ${last4}` : "Stored account";
}

/* ══════════════════════════════════════════════════════════════
   VAULT
   ══════════════════════════════════════════════════════════════ */

function hasStoredData() {
  return !!localStorage.getItem(STORAGE_KEY);
}

function getVaultPayload() {
  syncActiveToCards();
  return { cards, activeCardIdx };
}

function applyVaultPayload(payload) {
  cards = Array.isArray(payload?.cards) ? payload.cards : [];
  activeCardIdx = Math.max(
    0,
    Math.min(payload?.activeCardIdx || 0, Math.max(cards.length - 1, 0)),
  );
  if (cards.length > 0) loadActiveCard();
  else {
    userData = null;
    transactions = [];
    customCategories = [];
    categoryBudgets = {};
    recurringTemplates = [];
  }
}

function hashVaultPayload(payload) {
  return CryptoJS.SHA256(JSON.stringify(payload || {})).toString();
}

/* ══════════════════════════════════════════════════════════════
   NOTIFICATION (toast)
   ══════════════════════════════════════════════════════════════ */

/**
 * Show a toast notification. Looks for #notificationToast in the DOM;
 * falls back to console if not found.
 * @param {string} message
 * @param {"info"|"success"|"error"|"warn"} type
 */
function notify(message, type = "info") {
  const toast = safeGet("notificationToast");
  if (!toast) {
    console.info(`[${type.toUpperCase()}] ${message}`);
    return;
  }

  toast.textContent = message;
  toast.className = `notification-toast notification-toast--${type} notification-toast--show`;

  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    safeRemoveClass(toast, "notification-toast--show");
  }, 3000);
}

/* ══════════════════════════════════════════════════════════════
   GLOBAL REFRESH
   ══════════════════════════════════════════════════════════════ */

/**
 * Master refresh — call after any data change.
 * Triggers chart update, category bar update, and all UI renders.
 */
function refreshAll() {
  try {
    // Update overview chart
    if (typeof updateOverviewChart === "function") {
      updateOverviewChart(chartPeriod);
    }

    // Update category chart if renderAllExpenses is available
    if (typeof renderAllExpenses === "function") {
      renderAllExpenses(currentPeriod);
    }

    // Render transaction list if available
    if (typeof renderTransactions === "function") {
      renderTransactions();
    }

    // Refresh summary cards if available
    if (typeof renderSummary === "function") {
      renderSummary();
    }

    // Refresh recurring templates if available
    if (typeof renderRecurring === "function") {
      renderRecurring();
    }
  } catch (e) {
    console.warn("refreshAll error:", e);
  }
}

/* ══════════════════════════════════════════════════════════════
   CATEGORY SELECT POPULATION
   ══════════════════════════════════════════════════════════════ */

function populateCategorySelects() {
  const incOpts = [...window.BASE_INCOME_CATS, ...customCategories, "Other"];
  const expOpts = [...window.BASE_EXPENSE_CATS, ...customCategories, "Other"];
  const allOpts = [...new Set([...incOpts, ...expOpts])];

  [
    ["incomeCategory", incOpts, true],
    ["expenseCategory", expOpts, true],
    ["editCategory", allOpts, false],
  ].forEach(([id, opts, placeholder]) => {
    const el = safeGet(id);
    if (!el) return;
    const cur = el.value;
    el.innerHTML =
      (placeholder ? '<option value="">Select category</option>' : "") +
      opts
        .map(
          (c) =>
            `<option value="${c}"${cur === c ? " selected" : ""}>${c}</option>`,
        )
        .join("");
  });
}

function getAllCategories() {
  return [
    ...new Set([
      ...window.BASE_INCOME_CATS,
      ...window.BASE_EXPENSE_CATS,
      ...customCategories,
      "Other",
    ]),
  ];
}

/* ══════════════════════════════════════════════════════════════
   AUTO-LOCK
   ══════════════════════════════════════════════════════════════ */

function resetAutoLock() {
  clearTimeout(autoLockTimer);
  if (!sessionPin) return;
  autoLockTimer = setTimeout(() => {
    sessionPin = null;
    if (typeof showLockScreen === "function") showLockScreen();
  }, AUTO_LOCK_MS);
}

function _attachAutoLockListeners() {
  ["click", "keydown", "touchstart"].forEach((evt) => {
    document.addEventListener(evt, resetAutoLock, { passive: true });
  });
}

/* ══════════════════════════════════════════════════════════════
   CURSOR GRADIENT EFFECT
   ══════════════════════════════════════════════════════════════ */

function _attachCursorGradient() {
  document.addEventListener(
    "mousemove",
    (e) => {
      document.body.style.setProperty("--x", `${e.clientX}px`);
      document.body.style.setProperty("--y", `${e.clientY}px`);
    },
    { passive: true },
  );
}

/* ══════════════════════════════════════════════════════════════
   FAB / SYNC VISIBILITY SHIMS
   ══════════════════════════════════════════════════════════════ */

/**
 * Show or hide the sync FAB based on sync state.
 * Delegates to the real implementation in script.js if available.
 */
function syncFabVisibility() {
  const fab = safeGet("syncFab");
  if (!fab) return;
  fab.style.display = syncConfig?.enabled ? "flex" : "none";
}

/* ══════════════════════════════════════════════════════════════
   CARD SWITCHER SHIM
   ══════════════════════════════════════════════════════════════ */

function renderCardSwitcher() {
  // Implemented in the main script; this is a safe no-op if not yet available.
  if (typeof _renderCardSwitcher === "function") {
    _renderCardSwitcher();
  }
}

/* ══════════════════════════════════════════════════════════════
   ACCOUNT UI UPDATE
   ══════════════════════════════════════════════════════════════ */

function updateAddAccountUI() {
  const currentName = getCardDisplayName(cards[activeCardIdx], activeCardIdx);
  safeSetText(safeGet("bnCurrentAccountLabel"), currentName);
  safeSetText(safeGet("incomeAccountName"), currentName);
  safeSetText(safeGet("expenseAccountName"), currentName);
}

/* ══════════════════════════════════════════════════════════════
   GLOBAL EVENT LISTENERS
   ══════════════════════════════════════════════════════════════ */

function _attachGlobalListeners() {
  // Ask BlueLedger overlay click → close
  const askBlOverlay = safeGet("askBlOverlay");
  if (askBlOverlay) {
    askBlOverlay.addEventListener("click", () => {
      if (typeof closeAskBl === "function") closeAskBl();
    });
  }

  // Ask BlueLedger input — send on Enter
  const askBlInput = safeGet("askBlInput");
  if (askBlInput) {
    askBlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (typeof askBlSend === "function") askBlSend();
      }
    });
  }

  // Description inputs → trigger AI auto-category on keyup
  ["income", "expense"].forEach((type) => {
    const descEl = safeGet(`${type}Desc`);
    if (descEl) {
      descEl.addEventListener("input", () => {
        if (typeof aiAutoCategory === "function") {
          aiAutoCategory(type, descEl.value);
        }
      });
    }

    const catEl = safeGet(`${type}Category`);
    if (catEl) {
      catEl.addEventListener("change", () => {
        if (typeof aiCategorySelectionChanged === "function") {
          aiCategorySelectionChanged(type);
        }
      });
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   INITIALISATION
   ══════════════════════════════════════════════════════════════ */

/**
 * Bootstrap the app on first load.
 * Waits for DOM ready before touching any elements.
 */
function _bootApp() {
  try {
    // Cursor gradient
    _attachCursorGradient();

    // Auto-lock activity listeners
    _attachAutoLockListeners();

    // Global event listeners for modules
    _attachGlobalListeners();

    // Initialise chart system
    if (typeof initOverviewChart === "function") {
      initOverviewChart();
    }
    if (typeof initCategoryChart === "function") {
      initCategoryChart();
    }

    // Populate category dropdowns
    populateCategorySelects();

    // Set initial chart period
    setChartPeriod(chartPeriod);

    // Refresh all UI panels
    refreshAll();

    // Sync FAB
    syncFabVisibility();

    console.info("BlueLedger: modules initialised");
  } catch (e) {
    console.warn("BlueLedger boot error:", e);
  }
}

/* ── Chart init guard on load ───────────────────────────────── */
window.addEventListener("load", () => {
  document.body.style.setProperty("--x", "50%");
  document.body.style.setProperty("--y", "50%");

  try {
    if (typeof initOverviewChart === "function") {
      initOverviewChart();
      updateOverviewChart("monthly");
    }
  } catch (e) {
    console.error("Chart init failed on load:", e);
  }
});

/* ── DOM ready boot ─────────────────────────────────────────── */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _bootApp);
} else {
  _bootApp();
}

/* ══════════════════════════════════════════════════════════════
   GLOBAL EXPORTS
   Functions that need to be accessible from inline HTML onclick
   handlers or other scripts.
   ══════════════════════════════════════════════════════════════ */

window.notify = notify;
window.refreshAll = refreshAll;
window.setChartPeriod = setChartPeriod;
window.renderChart = renderChart;
window.populateCategorySelects = populateCategorySelects;
window.getAllCategories = getAllCategories;
window.getAnalyticsTransactions = getAnalyticsTransactions;
window.syncFabVisibility = syncFabVisibility;
window.renderCardSwitcher = renderCardSwitcher;
window.updateAddAccountUI = updateAddAccountUI;
window.getBounds = getBounds;
window.getTxns = getTxns;
window.sumInc = sumInc;
window.sumExp = sumExp;
window.fmt = fmt;
window.localDateStr = localDateStr;
window.toDay = toDay;
window.encrypt = encrypt;
window.tryDecrypt = tryDecrypt;
window.getBLClient = getBLClient;
window.hashVaultPayload = hashVaultPayload;
window.getVaultPayload = getVaultPayload;
window.applyVaultPayload = applyVaultPayload;
window.syncActiveToCards = syncActiveToCards;
window.loadActiveCard = loadActiveCard;
window.getCardDisplayName = getCardDisplayName;
window.getCardDisplaySub = getCardDisplaySub;
window.hasStoredData = hasStoredData;
window.defaultSyncConfig = defaultSyncConfig;
window.cleanSyncConfig = cleanSyncConfig;
window.getDeviceId = getDeviceId;
window.resetAutoLock = resetAutoLock;
window.MONTH_NAMES = MONTH_NAMES;
window.STORAGE_KEY = STORAGE_KEY;
window.VERIFY_TOKEN = VERIFY_TOKEN;
window.VERIFY_TOKEN_V2 = VERIFY_TOKEN_V2;
window.VAULT_SCHEMA_VERSION = VAULT_SCHEMA_VERSION;
window.SYNC_PENDING_KEY = SYNC_PENDING_KEY;
window.SYNC_DEVICE_KEY = SYNC_DEVICE_KEY;
window.SYNC_TABLE = SYNC_TABLE;
window.SYNC_POLL_MS = SYNC_POLL_MS;
window.AUTH_MODE_KEY = AUTH_MODE_KEY;
window.WEBAUTHN_CRED_ID_KEY = WEBAUTHN_CRED_ID_KEY;
window.WEBAUTHN_PWD_VAULT_KEY = WEBAUTHN_PWD_VAULT_KEY;
window.WEBAUTHN_RP_ID_KEY = WEBAUTHN_RP_ID_KEY;
window.BL_SUPABASE_URL = BL_SUPABASE_URL;
window.BL_SUPABASE_ANON_KEY = BL_SUPABASE_ANON_KEY;
window.AI_MODEL = "claude-sonnet-4-20250514";
