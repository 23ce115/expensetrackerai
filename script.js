/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SECURITY — AES-256 PIN ENCRYPTION
   sessionPin lives ONLY in RAM. localStorage holds
   only encrypted ciphertext — unreadable without PIN.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

let sessionPin = null;
let autoLockTimer = null;
let pinBuffer = "";
let pinAttempts = 0;
let pinLockedUntil = 0;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 30 * 1000; // 30 seconds
const AUTO_LOCK_MS = 5 * 60 * 1000;
const STORAGE_KEY = "bl_vault";
const VERIFY_TOKEN = "BL_OK_v1";

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

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MULTI-CARD STATE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

window.addEventListener("load", () => {
  document.body.style.setProperty("--x", "50%");
  document.body.style.setProperty("--y", "50%");
});

let cards = [];
let activeCardIdx = 0;
let addingNewCard = false;

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

const BASE_INCOME_CATS = [
  "Salary",
  "Freelance",
  "Business",
  "Investment",
  "Insurance",
];
const BASE_EXPENSE_CATS = [
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

const CAT_COLORS = {
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

const CARD_ACCENT_COLORS = ["#10b981", "#3b82f6", "#f59e0b", "#ec4899"];

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MULTI-CARD HELPERS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

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

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ENCRYPTED PERSISTENCE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function saveToStorage() {
  if (!sessionPin) return;
  syncActiveToCards();
  try {
    const vault = { verify: VERIFY_TOKEN, cards, activeCardIdx };
    localStorage.setItem(STORAGE_KEY, encrypt(vault, sessionPin));
  } catch (e) {
    console.warn("Save failed", e);
  }
}

// Returns true if encrypted data exists (show lock screen), false if first launch
function hasStoredData() {
  return !!localStorage.getItem(STORAGE_KEY);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   LOCK SCREEN
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function showLockScreen(subtitle) {
  const fab = document.querySelector(".add-buttons");
  if (fab) fab.style.display = "none";
  pinBuffer = "";
  updatePinDots();
  document.getElementById("lockScreen").style.display = "flex";
  document.getElementById("lockError").textContent = "";
  if (subtitle) document.getElementById("lockSubtitle").textContent = subtitle;
  else
    document.getElementById("lockSubtitle").textContent =
      "Enter your PIN to continue";
  document.getElementById("onboardingModal").style.display = "none";
}

function hideLockScreen() {
  document.getElementById("lockScreen").style.display = "none";
  syncFabVisibility();
}

function pinPress(digit) {
  if (pinBuffer.length >= 4) return;
  // Haptic feedback on mobile
  if (navigator.vibrate) navigator.vibrate(8);
  pinBuffer += digit;
  updatePinDots();
  // auto-attempt after brief pause
  clearTimeout(window._pinT);
  if (pinBuffer.length === 4) {
    window._pinT = setTimeout(attemptUnlock, 250);
  }
}

function pinBackspace() {
  clearTimeout(window._pinT);
  pinBuffer = pinBuffer.slice(0, -1);
  updatePinDots();
}

function updatePinDots() {
  const len = pinBuffer.length;
  for (let i = 1; i <= 4; i++) {
    document.getElementById("pd" + i).classList.toggle("filled", i <= len);
  }
}

function attemptUnlock() {
  clearTimeout(window._pinT);
  const pin = pinBuffer;
  if (pin.length < 4) return;

  // Rate limiting check
  const now = Date.now();
  if (now < pinLockedUntil) {
    const secs = Math.ceil((pinLockedUntil - now) / 1000);
    document.getElementById("lockError").textContent =
      `Too many attempts. Wait ${secs}s`;
    document.getElementById("lockAttempts").textContent = "";
    pinBuffer = "";
    updatePinDots();
    return;
  }

  const raw = localStorage.getItem(STORAGE_KEY);
  const vault = tryDecrypt(raw, pin);

  if (!vault || vault.verify !== VERIFY_TOKEN) {
    pinAttempts++;
    const remaining = MAX_PIN_ATTEMPTS - pinAttempts;
    const dots = document.getElementById("pinDots");
    dots.classList.add("shake");

    if (pinAttempts >= MAX_PIN_ATTEMPTS) {
      pinLockedUntil = Date.now() + PIN_LOCKOUT_MS;
      pinAttempts = 0;
      document.getElementById("lockError").textContent =
        "Too many attempts — locked for 30s";
      document.getElementById("lockAttempts").textContent = "";
      // Countdown timer
      const countdown = setInterval(() => {
        const s = Math.ceil((pinLockedUntil - Date.now()) / 1000);
        if (s <= 0) {
          clearInterval(countdown);
          document.getElementById("lockError").textContent = "";
        } else
          document.getElementById("lockError").textContent =
            `Locked — try again in ${s}s`;
      }, 500);
    } else {
      document.getElementById("lockError").textContent =
        "Incorrect PIN — try again";
      document.getElementById("lockAttempts").textContent =
        remaining === 1
          ? "1 attempt remaining"
          : `${remaining} attempts remaining`;
    }

    setTimeout(() => {
      dots.classList.remove("shake");
      pinBuffer = "";
      updatePinDots();
      if (pinAttempts < MAX_PIN_ATTEMPTS)
        document.getElementById("lockError").textContent = "";
    }, 700);
    return;
  }

  // Correct PIN — reset attempts
  pinAttempts = 0;
  pinLockedUntil = 0;
  document.getElementById("lockAttempts").textContent = "";

  // Correct PIN
  sessionPin = pin;
  cards = vault.cards || [];
  activeCardIdx = vault.activeCardIdx || 0;
  if (activeCardIdx >= cards.length) activeCardIdx = 0;
  if (cards.length > 0) loadActiveCard();

  hideLockScreen();
  resetAutoLock();
  renderCardSwitcher();
  if (userData) {
    updateMyCardWidget();
    processRecurring();
  }
  populateCategorySelects();
  refreshAll();
}

// Keyboard support on lock screen
document.addEventListener("keydown", (e) => {
  if (document.getElementById("lockScreen").style.display === "none") return;
  if (e.key >= "0" && e.key <= "9") pinPress(e.key);
  else if (e.key === "Backspace") pinBackspace();
  else if (e.key === "Enter") attemptUnlock();
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AUTO-LOCK & MANUAL LOCK
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function resetAutoLock() {
  clearTimeout(autoLockTimer);
  autoLockTimer = setTimeout(lockApp, AUTO_LOCK_MS);
}

["click", "keydown", "mousemove", "touchstart", "scroll"].forEach((ev) => {
  document.addEventListener(
    ev,
    () => {
      if (sessionPin) resetAutoLock();
    },
    { passive: true },
  );
});

function lockApp() {
  if (!sessionPin) return;
  saveToStorage();
  sessionPin = null;
  pinBuffer = "";
  clearTimeout(autoLockTimer);
  // Wipe all sensitive data from memory
  cards = [];
  activeCardIdx = 0;
  userData = null;
  transactions = [];
  customCategories = [];
  categoryBudgets = {};
  recurringTemplates = [];
  showLockScreen();
  notify("App locked", "info");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CHANGE PIN
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function openChangePinModal() {
  openModal("changePinModal");
}
function changePin() {
  const oldPin = document.getElementById("cpOld").value.trim();
  const newPin = document.getElementById("cpNew").value.trim();
  const newPin2 = document.getElementById("cpNew2").value.trim();
  if (oldPin !== sessionPin) {
    notify("Current PIN is incorrect", "error");
    return;
  }
  if (!/^\d{4,6}$/.test(newPin)) {
    notify("PIN must be 4–6 digits", "error");
    return;
  }
  if (newPin !== newPin2) {
    notify("New PINs don't match", "error");
    return;
  }
  sessionPin = newPin;
  saveToStorage();
  closeModal("changePinModal");
  ["cpOld", "cpNew", "cpNew2"].forEach(
    (id) => (document.getElementById(id).value = ""),
  );
  notify("PIN updated", "success");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CARD SWITCHER UI
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function renderCardSwitcher() {
  const strip = document.getElementById("cardSwitcher");
  if (!strip) return;
  let html = cards
    .map((c, i) => {
      const last4 = (c.userData?.cardNumber || "••••").slice(-4);
      const nickname = c.userData?.nickname?.trim();
      const first = nickname || c.userData?.name?.split(" ")[0] || "Card";
      const color = CARD_ACCENT_COLORS[i];
      const active = i === activeCardIdx ? "card-tab--active" : "";
      const del =
        cards.length > 1
          ? `<button class="card-tab__del" onclick="event.stopPropagation();confirmDeleteCard(${i})" title="Remove"><i class="fas fa-times"></i></button>`
          : "";
      return `<div class="card-tab ${active}" onclick="switchCard(${i})">
        <span class="card-tab__dot" style="background:${color}"></span>
        <span class="card-tab__name">${first}</span>
        <span class="card-tab__num">••••${last4}</span>
        ${del}
      </div>`;
    })
    .join("");
  if (cards.length < 4) {
    html += `<button class="card-tab card-tab--add" onclick="addNewCard()"><i class="fas fa-plus"></i><span>Add Card</span></button>`;
  }
  strip.innerHTML = html;
}

function switchCard(idx) {
  if (idx === activeCardIdx) return;
  syncActiveToCards();
  saveToStorage();
  activeCardIdx = idx;
  loadActiveCard();
  renderCardSwitcher();
  updateMyCardWidget();
  processRecurring();
  populateCategorySelects();
  searchQuery = "";
  const si = document.getElementById("txnSearch");
  if (si) si.value = "";
  filterCfg = { type: "all", cats: [] };
  refreshAll();
  const cardLabel =
    userData?.nickname?.trim() ||
    (userData?.cardNumber
      ? `Card ending ${userData.cardNumber.slice(-4)}`
      : "card");
  notify(`Switched to ${cardLabel}`, "info");
}

function addNewCard() {
  if (cards.length >= 4) {
    notify("Maximum 4 cards supported", "error");
    return;
  }

  // No card set up yet — must complete first card setup before adding more
  if (cards.length === 0 || !userData) {
    notify("Please complete your profile setup first!", "error");
    setTimeout(() => {
      const modal = document.getElementById("onboardingModal");
      modal.querySelector(".ob-sub").textContent =
        "Your personal finance dashboard — let's get you set up";
      modal.querySelector(".btn-onboard").textContent = "Get Started";
      const pinSection = modal.querySelector(".pin-section");
      if (pinSection) pinSection.style.display = "";
      addingNewCard = false;
      ["ob-name", "ob-card", "ob-limit", "ob-pin", "ob-pin2"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = "";
      });
      openModal("onboardingModal");
    }, 800);
    return;
  }

  addingNewCard = true;
  ["ob-name", "ob-card", "ob-limit", "ob-pin", "ob-pin2"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const modal = document.getElementById("onboardingModal");
  modal.querySelector(".ob-sub").textContent =
    "Add a new card wallet to track separately";
  modal.querySelector(".btn-onboard").textContent = "Add Card";
  const pinSection = modal.querySelector(".pin-section");
  if (pinSection) pinSection.style.display = "none";
  openModal("onboardingModal");
}

let deleteCardTargetIdx = null;
function confirmDeleteCard(idx) {
  if (cards.length <= 1) {
    notify("You need at least one card", "error");
    return;
  }
  deleteCardTargetIdx = idx;
  const name = cards[idx]?.userData?.name?.split(" ")[0] || "Card";
  document.getElementById("deleteCardName").textContent = name + "'s";
  openModal("deleteCardModal");
}
function doDeleteCard() {
  const idx = deleteCardTargetIdx;
  if (idx === null) return;
  const name = cards[idx]?.userData?.name?.split(" ")[0] || "Card";
  cards.splice(idx, 1);
  if (activeCardIdx >= cards.length) activeCardIdx = cards.length - 1;
  loadActiveCard();
  saveToStorage();
  renderCardSwitcher();
  updateMyCardWidget();
  closeModal("deleteCardModal");
  populateCategorySelects();
  refreshAll();
  notify(name + "'s card removed", "error");
  deleteCardTargetIdx = null;
}

function updateMyCardWidget() {
  if (!userData) return;
  document.getElementById("cardNumberDisplay").textContent =
    userData.cardNumber;
  document.getElementById("cardHolderDisplay").textContent =
    userData.name.toUpperCase();
  document.getElementById("spendLimitVal").textContent = fmt(
    userData.spendingLimit,
  );
  const nicknameEl = document.getElementById("cardNicknameDisplay");
  if (nicknameEl)
    nicknameEl.textContent = userData.nickname?.trim() || "Primary wallet";
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   RECURRING TRANSACTIONS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function processRecurring() {
  if (!recurringTemplates.length) return;
  const today = todayStr();
  let generated = 0;
  recurringTemplates.forEach((tmpl) => {
    let next = tmpl.nextDate,
      safety = 24;
    while (next <= today && safety-- > 0) {
      const exists = transactions.some(
        (t) => t.recurringId === tmpl.id && t.date === next,
      );
      if (!exists) {
        transactions.unshift({
          id: Date.now() + Math.random(),
          date: next,
          category: tmpl.category,
          amount: tmpl.type === "income" ? tmpl.amount : -tmpl.amount,
          description: (tmpl.description || tmpl.category) + " (recurring)",
          type: tmpl.type,
          recurringId: tmpl.id,
        });
        generated++;
      }
      const d = new Date(next + "T00:00:00");
      if (tmpl.frequency === "weekly") d.setDate(d.getDate() + 7);
      else d.setMonth(d.getMonth() + 1);
      next = d.toISOString().split("T")[0];
    }
    tmpl.nextDate = next;
  });
  if (generated > 0) {
    saveToStorage();
    notify(
      `${generated} recurring transaction${generated > 1 ? "s" : ""} generated`,
      "info",
    );
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   UTILITIES
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

document.addEventListener("mousemove", (e) => {
  document.body.style.setProperty("--x", e.clientX + "px");
  document.body.style.setProperty("--y", e.clientY + "px");
});

const fmt = (n) => "₹" + n.toLocaleString("en-IN");
const toDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const localDateStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
};
const todayStr = () => localDateStr(new Date());

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MONTH PICKER — view any past month in full
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

let pickedMonth = null; // { year, month } when in "pick month" mode
let pickerYear = new Date().getFullYear();
let pickerSelected = null; // { year, month } currently highlighted in picker

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function openMonthPicker() {
  document.getElementById("periodMenu").classList.remove("open");
  pickerYear = new Date().getFullYear();
  pickerSelected = pickedMonth ? { ...pickedMonth } : null;
  renderPickerGrid();
  openModal("monthPickerModal");
}

function shiftPickerYear(dir) {
  pickerYear += dir;
  renderPickerGrid();
}

function renderPickerGrid() {
  document.getElementById("mpYear").textContent = pickerYear;
  const now = new Date();
  const grid = document.getElementById("mpGrid");
  grid.innerHTML = MONTH_SHORT.map((name, i) => {
    const isFuture =
      pickerYear > now.getFullYear() ||
      (pickerYear === now.getFullYear() && i > now.getMonth());
    const isSelected =
      pickerSelected &&
      pickerSelected.year === pickerYear &&
      pickerSelected.month === i;
    const hasTxns = transactions.some((t) => {
      const d = new Date(t.date + "T00:00:00");
      return d.getFullYear() === pickerYear && d.getMonth() === i;
    });
    return `<div class="mp-cell ${isSelected ? "mp-selected" : ""} ${isFuture ? "mp-future" : ""} ${hasTxns ? "mp-has-data" : ""}"
      onclick="${isFuture ? "" : `selectPickerMonth(${pickerYear},${i})`}">
      ${name}
      ${hasTxns ? '<span class="mp-dot"></span>' : ""}
    </div>`;
  }).join("");
  updatePickerFooter();
}

function selectPickerMonth(year, month) {
  pickerSelected = { year, month };
  renderPickerGrid();
}

function updatePickerFooter() {
  const label = document.getElementById("mpSelectedLabel");
  const viewBtn = document.getElementById("mpViewBtn");
  const dlBtn = document.getElementById("mpDownloadBtn");
  if (pickerSelected) {
    const name = MONTH_SHORT[pickerSelected.month] + " " + pickerSelected.year;
    label.textContent = name + " selected";
    viewBtn.style.display = "";
    // Only show download if there are transactions in that month
    const hasTxns = transactions.some((t) => {
      const d = new Date(t.date + "T00:00:00");
      return (
        d.getFullYear() === pickerSelected.year &&
        d.getMonth() === pickerSelected.month
      );
    });
    dlBtn.style.display = hasTxns ? "" : "none";
  } else {
    label.textContent = "No month selected";
    viewBtn.style.display = "none";
    dlBtn.style.display = "none";
  }
}

function applyPickedMonth() {
  if (!pickerSelected) return;
  pickedMonth = { ...pickerSelected };
  currentPeriod = "picked";
  closeModal("monthPickerModal");
  const name = MONTH_SHORT[pickedMonth.month] + " " + pickedMonth.year;
  document.getElementById("periodLabel").textContent = name;
  // Update active state on period menu
  document
    .querySelectorAll(".period-menu-item")
    .forEach((el) =>
      el.classList.toggle("active", el.textContent.trim() === "Pick Month"),
    );
  refreshAll();
  notify("Viewing " + name, "info");
}

function exportMonthCSV() {
  if (!pickerSelected) return;
  const { year, month } = pickerSelected;
  const monthTxns = transactions.filter((t) => {
    const d = new Date(t.date + "T00:00:00");
    return d.getFullYear() === year && d.getMonth() === month;
  });
  if (!monthTxns.length) {
    notify("No transactions in this month", "error");
    return;
  }
  const rows = [
    ["Date", "Type", "Category", "Description", "Amount", "Recurring"],
  ];
  monthTxns
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((t) =>
      rows.push([
        t.date,
        t.type,
        t.category,
        t.description || "",
        Math.abs(t.amount),
        t.recurringId ? "Yes" : "No",
      ]),
    );
  const csv = rows.map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
  const name = MONTH_SHORT[month] + "-" + year;
  const a = document.createElement("a");
  a.href = "data:text/csv," + encodeURIComponent(csv);
  a.download = `blueledger-${userData?.name?.split(" ")[0] || "export"}-${name}.csv`;
  a.click();
  notify(`Downloaded ${name} CSV`, "success");
}

function getBounds(period) {
  const today = toDay(new Date());
  if (period === "daily") return { start: today, end: today };
  if (period === "weekly") {
    const dow = today.getDay(),
      off = dow === 0 ? -6 : 1 - dow;
    const s = new Date(today);
    s.setDate(today.getDate() + off);
    return { start: s, end: today };
  }
  if (period === "picked" && pickedMonth) {
    const { year, month } = pickedMonth;
    return {
      start: new Date(year, month, 1),
      end: new Date(year, month + 1, 0),
    };
  }
  return {
    start: new Date(today.getFullYear(), today.getMonth(), 1),
    end: today,
  };
}

function getTxns(period) {
  const { start, end } = getBounds(period);
  return transactions.filter((t) => {
    const d = toDay(new Date(t.date + "T00:00:00"));
    return d >= start && d <= end;
  });
}

const sumInc = (tx) =>
  tx.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
const sumExp = (tx) =>
  tx
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + Math.abs(t.amount), 0);

function getCatColor(cat) {
  if (CAT_COLORS[cat]) return CAT_COLORS[cat];
  let hash = 0;
  for (let i = 0; i < cat.length; i++)
    hash = cat.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 65%, 55%)`;
}

function getAllCategories() {
  return [
    ...new Set([
      ...BASE_INCOME_CATS,
      ...BASE_EXPENSE_CATS,
      ...customCategories,
      "Other",
    ]),
  ];
}

function populateCategorySelects() {
  const incOpts = [...BASE_INCOME_CATS, ...customCategories, "Other"];
  const expOpts = [...BASE_EXPENSE_CATS, ...customCategories, "Other"];
  const allOpts = [...new Set([...incOpts, ...expOpts])];
  [
    ["incomeCategory", incOpts, true],
    ["expenseCategory", expOpts, true],
    ["editCategory", allOpts, false],
  ].forEach(([id, opts, placeholder]) => {
    const el = document.getElementById(id);
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

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CHART
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function getChartData(period) {
  const now = new Date();
  if (period === "daily") {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - (6 - i),
      );
      const ds = localDateStr(d);
      const tx = transactions.filter((t) => t.date === ds);
      return {
        label: d.toLocaleDateString("en-US", { weekday: "short" }),
        income: sumInc(tx),
        expense: sumExp(tx),
        active: i === 6,
      };
    });
  }
  if (period === "weekly") {
    const dow = now.getDay();
    const daysToMon = dow === 0 ? -6 : 1 - dow;
    const thisMonday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + daysToMon,
    );
    return Array.from({ length: 8 }, (_, i) => {
      const ws = new Date(
        thisMonday.getFullYear(),
        thisMonday.getMonth(),
        thisMonday.getDate() - (7 - i) * 7,
      );
      const we = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 6);
      const tx = transactions.filter((t) => {
        const d = toDay(new Date(t.date + "T00:00:00"));
        return d >= ws && d <= we;
      });
      return {
        label:
          ws.getDate() + " " + ws.toLocaleString("en-IN", { month: "short" }),
        income: sumInc(tx),
        expense: sumExp(tx),
        active: i === 7,
      };
    });
  }
  const yr = now.getFullYear();
  return [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].map((lb, mi) => {
    const tx = transactions.filter((t) => {
      const d = new Date(t.date + "T00:00:00");
      return d.getFullYear() === yr && d.getMonth() === mi;
    });
    return {
      label: lb,
      income: sumInc(tx),
      expense: sumExp(tx),
      active: mi === now.getMonth(),
    };
  });
}

function setChartPeriod(p) {
  chartPeriod = p;
  ["daily", "weekly", "monthly"].forEach((x) => {
    const btn = document.getElementById(
      "cp" + x.charAt(0).toUpperCase() + x.slice(1),
    );
    if (btn) btn.classList.toggle("active", x === p);
  });
  renderChart(p);
}

function renderChart(period) {
  const data = getChartData(period);
  const container = document.getElementById("chartContainer");
  const labelsDiv = document.getElementById("chartLabels");
  const hasData = data.some((d) => d.income > 0 || d.expense > 0);
  if (!hasData) {
    container.innerHTML = `<div class="chart-empty"><i class="fas fa-chart-bar"></i><p>Add transactions to see your overview</p></div>`;
    labelsDiv.innerHTML = "";
    return;
  }
  const max = Math.max(...data.map((d) => Math.max(d.income, d.expense)), 1);
  container.innerHTML = data
    .map((d) => {
      const ih = Math.round((d.income / max) * 100),
        eh = Math.round((d.expense / max) * 100);
      return `<div class="bar-group${d.active ? " active" : ""}">
      <div class="bar income-bar" style="height:${ih}%" title="Income: ${fmt(d.income)}"></div>
      <div class="bar expense-bar" style="height:${eh}%" title="Expense: ${fmt(d.expense)}"></div>
    </div>`;
    })
    .join("");
  labelsDiv.innerHTML = data.map((d) => `<span>${d.label}</span>`).join("");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ALL EXPENSES PANEL
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function renderAllExpenses(period) {
  const { start, end } = getBounds(period);
  document.getElementById("expBadge").textContent =
    `(${period.charAt(0).toUpperCase() + period.slice(1)})`;
  const exp = transactions.filter((t) => {
    if (t.type !== "expense") return false;
    const d = toDay(new Date(t.date + "T00:00:00"));
    return d >= start && d <= end;
  });
  const cats = {};
  exp.forEach((t) => {
    cats[t.category] = (cats[t.category] || 0) + Math.abs(t.amount);
  });
  const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, a]) => s + a, 0);

  const allExpTotal = document.getElementById("allExpTotal");
  if (allExpTotal) allExpTotal.textContent = fmt(total);

  ["Daily", "Weekly", "Monthly"].forEach((p) => {
    const el = document.getElementById("pv" + p);
    if (el)
      el.textContent = fmt(
        sumExp(getTxns(p.toLowerCase()).filter((t) => t.type === "expense")),
      );
  });

  const colorBar = document.querySelector(".color-bar");
  if (colorBar && sorted.length > 0) {
    colorBar.innerHTML = sorted
      .map(
        ([c, a]) =>
          `<div style="flex:${a};background:${getCatColor(c)};height:100%;border-radius:3px;" title="${c}: ${fmt(a)}"></div>`,
      )
      .join("");
    colorBar.style.display = "flex";
    colorBar.style.gap = "2px";
  }

  const list = document.getElementById("categoryList");
  if (!list) return;
  if (sorted.length === 0) {
    list.innerHTML =
      '<li style="color:#64748b;font-size:.85rem;padding:.5rem 0;text-align:center;">No expenses this period</li>';
    return;
  }
  list.innerHTML = sorted
    .map(([c, a]) => {
      const budget = categoryBudgets[c];
      const pct = budget ? Math.min((a / budget) * 100, 100) : 0;
      const over = budget && a > budget;
      const budgetBar = budget
        ? `
      <div class="cat-budget-row">
        <div class="cat-budget-bar-bg"><div class="cat-budget-bar-fill" style="width:${pct}%;background:${over ? "#ef4444" : getCatColor(c)};"></div></div>
        <span class="cat-budget-label">${fmt(a)} / ${fmt(budget)}${over ? " (Over)" : ""}</span>
      </div>`
        : "";
      return `<li class="expense-category" style="flex-direction:column;align-items:flex-start;gap:.15rem;">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center;">
        <div class="category-info"><div class="category-dot" style="background:${getCatColor(c)};"></div><span>${c}</span></div>
        <span class="category-amount">${fmt(a)}</span>
      </div>${budgetBar}
    </li>`;
    })
    .join("");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   DASHBOARD CARDS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function prevPeriodSum(period, type) {
  const now = new Date();
  let s, e;
  if (period === "daily") {
    s = e = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  } else if (period === "weekly") {
    const dow = now.getDay(),
      off = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + off,
    );
    e = new Date(mon);
    e.setDate(mon.getDate() - 1);
    s = new Date(e);
    s.setDate(e.getDate() - 6);
  } else {
    s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    e = new Date(now.getFullYear(), now.getMonth(), 0);
  }
  const tx = transactions.filter((t) => {
    const d = toDay(new Date(t.date + "T00:00:00"));
    return d >= s && d <= e;
  });
  return type === "income"
    ? sumInc(tx)
    : sumExp(tx.filter((t) => t.type === "expense"));
}

function renderChange(elId, cur, prev, label, isGood) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (prev === 0 && cur === 0) {
    el.innerHTML = '<i class="fas fa-minus"></i>&nbsp;No transactions yet';
    el.className = "change";
    return;
  }
  if (prev === 0) {
    el.innerHTML = `<i class="fas fa-arrow-up"></i>&nbsp;New data`;
    el.className = "change up";
    return;
  }
  const pct = Math.round(((cur - prev) / prev) * 100),
    up = pct >= 0;
  el.innerHTML = `<i class="fas fa-arrow-${up ? "up" : "down"}"></i>&nbsp;${Math.abs(pct)}% ${label}`;
  el.className =
    "change " + (up ? (isGood ? "up" : "down") : isGood ? "down" : "up");
}

function renderDashboard(period) {
  const txns = getTxns(period);
  const inc = sumInc(txns),
    exp = sumExp(txns.filter((t) => t.type === "expense")),
    net = inc - exp;
  document.getElementById("dashIncome").textContent = fmt(inc) + ".00";
  document.getElementById("dashExpense").textContent = fmt(exp) + ".00";
  const netEl = document.getElementById("dashNet"),
    signEl = document.getElementById("dashNetSign");
  if (netEl) {
    netEl.textContent = fmt(Math.abs(net)) + ".00";
    netEl.className = "amount " + (net >= 0 ? "net-positive" : "net-negative");
  }
  if (signEl) signEl.textContent = net >= 0 ? "Surplus" : "Deficit";
  const compLabel = {
    daily: "vs Yesterday",
    weekly: "vs Last Week",
    monthly: "vs Last Month",
  }[period];
  const pInc = prevPeriodSum(period, "income"),
    pExp = prevPeriodSum(period, "expense");
  renderChange("dashIncomeChange", inc, pInc, compLabel, true);
  renderChange("dashExpenseChange", exp, pExp, compLabel, false);
  renderChange("dashNetChange", net, pInc - pExp, compLabel, true);
  const pLabel = period.charAt(0).toUpperCase() + period.slice(1);
  ["badge1", "badge2", "badge3", "txnBadge"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "(" + pLabel + ")";
  });
  // sync period menu active state
  document.querySelectorAll(".period-menu-item").forEach((el) => {
    const txt = el.textContent.trim().toLowerCase();
    el.classList.toggle("active", txt === period);
  });
  document.getElementById("periodLabel").textContent = pLabel;
  document
    .querySelectorAll(".period-menu-item")
    .forEach((el) =>
      el.classList.toggle(
        "active",
        el.textContent.trim().toLowerCase() === period,
      ),
    );
  if (userData) {
    const mExp = sumExp(getTxns("monthly").filter((t) => t.type === "expense"));
    const pct = Math.min((mExp / userData.spendingLimit) * 100, 100);
    document.getElementById("spendLimitVal").textContent = fmt(
      userData.spendingLimit,
    );
    document.getElementById("spendUsedVal").textContent = "Used: " + fmt(mExp);
    const fill = document.getElementById("progressFill");
    fill.style.width = pct + "%";
    fill.style.background =
      pct >= 100 ? "#ef4444" : pct >= 80 ? "#f59e0b" : "#f97316";
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   TRANSACTION TABLE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function renderTxns(period) {
  let txns = getTxns(period);
  const totalAll = txns.length;
  if (filterCfg.type !== "all")
    txns = txns.filter((t) => t.type === filterCfg.type);
  if (filterCfg.cats.length > 0)
    txns = txns.filter((t) => filterCfg.cats.includes(t.category));
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    txns = txns.filter(
      (t) =>
        t.category.toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q),
    );
  }
  txns = [...txns].sort((a, b) => {
    let va, vb;
    if (sortCfg.field === "date") {
      va = a.date;
      vb = b.date;
    } else if (sortCfg.field === "amount") {
      va = Math.abs(a.amount);
      vb = Math.abs(b.amount);
    } else {
      va = a.category;
      vb = b.category;
    }
    if (va < vb) return sortCfg.order === "asc" ? -1 : 1;
    if (va > vb) return sortCfg.order === "asc" ? 1 : -1;
    return 0;
  });
  const countEl = document.getElementById("txnCount");
  if (countEl) {
    const isFiltered =
      searchQuery || filterCfg.type !== "all" || filterCfg.cats.length > 0;
    countEl.textContent = isFiltered
      ? `Showing ${txns.length} of ${totalAll}`
      : `${totalAll} transaction${totalAll !== 1 ? "s" : ""}`;
  }
  document
    .getElementById("filterBtn")
    .classList.toggle(
      "active-filter",
      filterCfg.type !== "all" || filterCfg.cats.length > 0,
    );
  const body = document.getElementById("txnBody");
  const mobileList = document.getElementById("txnMobileList");
  if (txns.length === 0) {
    const emptyHtml = `<div class="empty-transactions"><i class="fas fa-receipt"></i>${searchQuery ? "No results" : "No transactions for this period"}</div>`;
    body.innerHTML = `<tr><td colspan="6">${emptyHtml}</td></tr>`;
    if (mobileList) mobileList.innerHTML = emptyHtml;
    return;
  }
  const tableRows = txns
    .map((t) => {
      const ds = new Date(t.date + "T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const isInc = t.type === "income";
      const typeBadge = `<span class="${isInc ? "type-income" : "type-expense"}">${isInc ? "Income" : "Expense"}</span>`;
      const recurIcon = t.recurringId
        ? ` <i class="fas fa-sync-alt" style="font-size:.65rem;color:#94a3b8;" title="Recurring"></i>`
        : "";
      return `<tr>
      <td>${ds}</td>
      <td><span style="display:inline-flex;align-items:center;gap:.35rem;"><span style="width:7px;height:7px;border-radius:50%;background:${getCatColor(t.category)};display:inline-block;"></span>${t.category}</span></td>
      <td style="color:#9ca3af;font-size:.8rem;">${t.description || "-"}${t.notes ? `<span style="display:block;font-size:.7rem;color:#64748b;margin-top:1px;">${t.notes}</span>` : ""}${recurIcon}</td>
      <td style="color:${isInc ? "#10b981" : "#ef4444"};font-weight:700;">${isInc ? "+" : "-"}${fmt(Math.abs(t.amount))}</td>
      <td>${typeBadge}</td>
      <td><button class="action-btn" onclick="openCtx(event,${t.id})"><i class="fas fa-ellipsis-h"></i></button></td>
    </tr>`;
    })
    .join("");
  const mobileCards = txns
    .map((t) => {
      const ds = new Date(t.date + "T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const isInc = t.type === "income";
      const typeBadge = `<span class="${isInc ? "type-income" : "type-expense"}">${isInc ? "Income" : "Expense"}</span>`;
      const recurringBadge = t.recurringId
        ? `<span class="txn-mobile-pill"><i class="fas fa-sync-alt"></i>Recurring</span>`
        : "";
      return `<div class="txn-mobile-card">
      <div class="txn-mobile-top">
        <div class="txn-mobile-category">
          <span class="txn-mobile-dot" style="background:${getCatColor(t.category)}"></span>
          <span>${t.category}</span>
        </div>
        <div class="txn-mobile-right">
          <div class="txn-mobile-amount ${isInc ? "txn-mobile-amount--income" : "txn-mobile-amount--expense"}">${isInc ? "+" : "-"}${fmt(Math.abs(t.amount))}</div>
          <button class="action-btn txn-mobile-action" onclick="openCtx(event,${t.id})" aria-label="Transaction actions">
            <i class="fas fa-ellipsis-h"></i>
          </button>
        </div>
      </div>
      <div class="txn-mobile-desc">${t.description || "No description"}</div>
      ${t.notes ? `<div class="txn-mobile-notes">${t.notes}</div>` : ""}
      <div class="txn-mobile-meta">
        <span class="txn-mobile-date"><i class="fas fa-calendar-alt"></i>${ds}</span>
        <div class="txn-mobile-badges">${typeBadge}${recurringBadge}</div>
      </div>
    </div>`;
    })
    .join("");
  body.innerHTML = tableRows;
  if (mobileList) mobileList.innerHTML = mobileCards;
}

function onSearchInput(val) {
  searchQuery = val;
  renderTxns(currentPeriod);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   EXPENSE ANALYSER — INSIGHTS ENGINE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function renderInsights() {
  const section = document.getElementById("insightsSection");
  if (!section) return;
  const allExp = transactions.filter((t) => t.type === "expense");
  if (allExp.length < 3) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";

  const now = new Date();
  const thisMonth = transactions.filter((t) => {
    const d = new Date(t.date + "T00:00:00");
    return (
      t.type === "expense" &&
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth()
    );
  });
  const lastMonth = transactions.filter((t) => {
    const d = new Date(t.date + "T00:00:00");
    const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return (
      t.type === "expense" &&
      d.getFullYear() === lm.getFullYear() &&
      d.getMonth() === lm.getMonth()
    );
  });

  const totalThisMonth = sumExp(thisMonth);
  const totalLastMonth = sumExp(lastMonth);

  // Category breakdown
  const cats = {};
  thisMonth.forEach((t) => {
    cats[t.category] = (cats[t.category] || 0) + Math.abs(t.amount);
  });
  const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);

  // Prediction
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
  ).getDate();
  const dailyAvg = dayOfMonth > 0 ? totalThisMonth / dayOfMonth : 0;
  const predicted = Math.round(dailyAvg * daysInMonth);
  const limit = userData?.spendingLimit || 0;
  const progressPct =
    limit > 0
      ? Math.min((totalThisMonth / limit) * 100, 100)
      : Math.min((totalThisMonth / Math.max(predicted, 1)) * 100, 100);
  const predictedPct =
    limit > 0 ? Math.min((predicted / limit) * 100, 100) : 100;

  // Anomaly detection (Z-score)
  const catStats = {};
  allExp.forEach((t) => {
    if (!catStats[t.category]) catStats[t.category] = [];
    catStats[t.category].push(Math.abs(t.amount));
  });
  const anomalies = [];
  thisMonth.forEach((t) => {
    const vals = catStats[t.category] || [];
    if (vals.length < 3) return;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(
      vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length,
    );
    const amt = Math.abs(t.amount);
    if (std > 0 && amt > mean + 2 * std && amt > mean * 1.5)
      anomalies.push({ t, mean, amt });
  });

  // Day of week
  const dow = [0, 0, 0, 0, 0, 0, 0];
  allExp.slice(0, 90).forEach((t) => {
    dow[new Date(t.date + "T00:00:00").getDay()] += Math.abs(t.amount);
  });
  const dowMax = Math.max(...dow, 1);
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  // Savings rate
  const monthInc = sumInc(
    transactions.filter((t) => {
      const d = new Date(t.date + "T00:00:00");
      return (
        t.type === "income" &&
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth()
      );
    }),
  );
  const savingsRate =
    monthInc > 0
      ? Math.round(((monthInc - totalThisMonth) / monthInc) * 100)
      : null;

  // Anomaly alerts
  const alertsEl = document.getElementById("anomalyAlerts");
  alertsEl.innerHTML = anomalies
    .slice(0, 3)
    .map(
      (a) =>
        `<div class="anomaly-alert"><i class="fas fa-exclamation-triangle"></i>
     <span>Unusually high <strong>${a.t.category}</strong>: ${fmt(a.amt)} — avg is ${fmt(Math.round(a.mean))}</span></div>`,
    )
    .join("");

  // Insight cards
  const cards = [];
  const topCat = sorted[0];
  if (topCat && totalThisMonth > 0) {
    const pct = Math.round((topCat[1] / totalThisMonth) * 100);
    cards.push(`<div class="insight-card">
      <div class="insight-icon" style="background:rgba(249,115,22,.15);color:#f97316"><i class="fas fa-fire"></i></div>
      <div class="insight-body">
        <div class="insight-value" style="color:#f97316">${pct}% on ${topCat[0]}</div>
        <div class="insight-label">Top spending category this month</div>
      </div></div>`);
  }
  if (totalLastMonth > 0) {
    const diff = totalThisMonth - totalLastMonth;
    const dp = Math.abs(Math.round((diff / totalLastMonth) * 100));
    const up = diff > 0;
    const diffColor = up ? "#ef4444" : "#10b981";
    cards.push(`<div class="insight-card">
      <div class="insight-icon" style="background:${up ? "rgba(239,68,68,.15)" : "rgba(16,185,129,.15)"};color:${diffColor}">
        <i class="fas fa-arrow-${up ? "up" : "down"}"></i></div>
      <div class="insight-body">
        <div class="insight-value" style="color:${diffColor}">${dp}% ${up ? "more" : "less"} than last month</div>
        <div class="insight-label">${fmt(totalThisMonth)} vs ${fmt(totalLastMonth)} last month</div>
      </div></div>`);
  }
  if (savingsRate !== null) {
    const color =
      savingsRate >= 20 ? "#10b981" : savingsRate >= 0 ? "#f59e0b" : "#ef4444";
    const label =
      savingsRate >= 20
        ? "Great savings rate!"
        : savingsRate >= 0
          ? "Try to save more"
          : "Spending exceeds income";
    cards.push(`<div class="insight-card">
      <div class="insight-icon" style="background:rgba(167,139,250,.15);color:#a78bfa"><i class="fas fa-piggy-bank"></i></div>
      <div class="insight-body">
        <div class="insight-value" style="color:${color}">${savingsRate}% savings rate</div>
        <div class="insight-label">${label}</div>
      </div></div>`);
  }
  if (dailyAvg > 0) {
    cards.push(`<div class="insight-card">
      <div class="insight-icon" style="background:rgba(59,130,246,.15);color:#3b82f6"><i class="fas fa-calendar-day"></i></div>
      <div class="insight-body">
        <div class="insight-value" style="color:#3b82f6">${fmt(Math.round(dailyAvg))} / day</div>
        <div class="insight-label">Average daily spending this month</div>
      </div></div>`);
  }
  if (sorted.length >= 2) {
    const second = sorted[1];
    const sp = Math.round((second[1] / totalThisMonth) * 100);
    cards.push(`<div class="insight-card">
      <div class="insight-icon" style="background:rgba(236,72,153,.15);color:#ec4899"><i class="fas fa-tags"></i></div>
      <div class="insight-body">
        <div class="insight-value" style="color:#ec4899">${sp}% on ${second[0]}</div>
        <div class="insight-label">Second biggest category this month</div>
      </div></div>`);
  }
  const maxDow = dow.indexOf(Math.max(...dow));
  if (dow[maxDow] > 0) {
    cards.push(`<div class="insight-card">
      <div class="insight-icon" style="background:rgba(245,158,11,.15);color:#f59e0b"><i class="fas fa-clock"></i></div>
      <div class="insight-body">
        <div class="insight-value" style="color:#f59e0b">${dowNames[maxDow]} is your biggest spend day</div>
        <div class="insight-label">${fmt(Math.round(dow[maxDow]))} on ${dowNames[maxDow]}s recently</div>
      </div></div>`);
  }
  document.getElementById("insightsGrid").innerHTML = cards.join("");

  // Prediction bar
  const predBar = document.getElementById("predictionBar");
  if (dailyAvg > 0 && dayOfMonth < daysInMonth) {
    predBar.style.display = "block";
    const over = limit > 0 && predicted > limit;
    document.getElementById("predAmount").textContent =
      fmt(predicted) + (limit > 0 ? ` of ${fmt(limit)} limit` : "");
    document.getElementById("predAmount").style.color = over
      ? "#ef4444"
      : "#10b981";
    document.getElementById("predActual").style.width = progressPct + "%";
    document.getElementById("predProjected").style.width =
      Math.max(0, Math.min(predictedPct - progressPct, 100 - progressPct)) +
      "%";
    const daysLeft = daysInMonth - dayOfMonth;
    document.getElementById("predSub").textContent =
      `${daysLeft} days left · ${fmt(Math.round(dailyAvg))}/day avg` +
      (over ? ` · On track to exceed by ${fmt(predicted - limit)}` : "");
  } else {
    predBar.style.display = "none";
  }

  // Day of week bars
  const dowSect = document.getElementById("dowSection");
  if (dow.some((v) => v > 0)) {
    dowSect.style.display = "block";
    document.getElementById("dowBars").innerHTML = dowNames
      .map((name, i) => {
        const h = Math.round((dow[i] / dowMax) * 64);
        const isMax = i === maxDow;
        return `<div class="dow-col">
        <div class="dow-bar-wrap"><div class="dow-bar" style="height:${Math.max(h, 3)}px;background:${isMax ? "#f59e0b" : "#3b82f6"};"></div></div>
        <div class="dow-label" style="color:${isMax ? "#f59e0b" : "#64748b"}">${name}</div>
      </div>`;
      })
      .join("");
  } else {
    dowSect.style.display = "none";
  }

  const badge = document.getElementById("insightsBadge");
  if (badge)
    badge.textContent =
      anomalies.length > 0
        ? `${anomalies.length} alert${anomalies.length > 1 ? "s" : ""}`
        : "This month";
}

function refreshAll() {
  renderDashboard(currentPeriod);
  renderChart(chartPeriod);
  renderAllExpenses(currentPeriod);
  renderTxns(currentPeriod);
  renderInsights();
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PERIOD / CONTEXT MENU
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function togglePeriodMenu() {
  document.getElementById("periodMenu").classList.toggle("open");
}
function setPeriod(p) {
  currentPeriod = p;
  pickedMonth = null;
  document.getElementById("periodMenu").classList.remove("open");
  refreshAll();
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".period-dropdown"))
    document.getElementById("periodMenu").classList.remove("open");
  if (!e.target.closest(".action-btn") && !e.target.closest("#contextMenu"))
    closeCtx();
});

function openCtx(e, id) {
  e.stopPropagation();
  ctxId = id;
  const menu = document.getElementById("contextMenu");
  menu.style.display = "block";
  const r = e.currentTarget.getBoundingClientRect();
  let left = r.left - 145;
  if (left < 8) left = r.right + 4;
  let top = r.bottom + 4;
  if (top + 80 > window.innerHeight) top = r.top - 80;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}
function closeCtx() {
  document.getElementById("contextMenu").style.display = "none";
  ctxId = null;
}

function handleCtxEdit() {
  const t = transactions.find((x) => x.id === ctxId);
  if (!t) return;
  document.getElementById("editId").value = t.id;
  document.getElementById("editType").value = t.type;
  document.getElementById("editAmount").value = Math.abs(t.amount);
  document.getElementById("editDate").value = t.date;
  document.getElementById("editDesc").value = t.description || "";
  const en = document.getElementById("editNotes");
  if (en) en.value = t.notes || "";
  populateCategorySelects();
  document.getElementById("editCategory").value = t.category;
  closeCtx();
  openModal("editModal");
}
function handleCtxDelete() {
  if (!ctxId) return;
  deleteTargetId = ctxId;
  closeCtx();
  openModal("deleteModal");
}
function confirmDelete() {
  if (!deleteTargetId) return;
  transactions = transactions.filter((t) => t.id !== deleteTargetId);
  deleteTargetId = null;
  closeModal("deleteModal");
  saveToStorage();
  refreshAll();
  notify("Transaction deleted", "error");
}

function showCardInfo(card) {
  const msgs = {
    income: `Showing ${currentPeriod} income`,
    expense: `Showing ${currentPeriod} expenses`,
    net: `Net = Income − Expenses`,
    mycard: "Your linked card (last 4 digits only)",
    chart: "Income vs Expense overview",
    allexp: `Expense breakdown`,
  };
  notify(msgs[card] || "Info", "info");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ADD INCOME & EXPENSE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function addIncome() {
  const amt = parseFloat(document.getElementById("incomeAmount").value);
  const cat = document.getElementById("incomeCategory").value;
  const desc = document.getElementById("incomeDesc").value.trim();
  const date = document.getElementById("incomeDate").value;
  const recurring = document.getElementById("incomeRecurring").checked;
  const frequency = document.getElementById("incomeFrequency").value;
  const notes = document.getElementById("incomeNotes")?.value.trim() || "";
  if (!amt || amt <= 0 || !cat || !date) {
    notify("Please fill all required fields", "error");
    return;
  }
  transactions.unshift({
    id: Date.now(),
    date,
    category: cat,
    amount: amt,
    description: desc,
    notes,
    type: "income",
  });
  if (recurring) {
    const nd = new Date(date + "T00:00:00");
    if (frequency === "weekly") nd.setDate(nd.getDate() + 7);
    else nd.setMonth(nd.getMonth() + 1);
    recurringTemplates.push({
      id: Date.now() + 1,
      type: "income",
      amount: amt,
      category: cat,
      description: desc,
      frequency,
      nextDate: nd.toISOString().split("T")[0],
    });
  }
  closeModal("incomeModal");
  saveToStorage();
  refreshAll();
  notify(
    recurring ? "Income added and recurring set up" : "Income added",
    "success",
  );
}

function addExpense() {
  const amt = parseFloat(document.getElementById("expenseAmount").value);
  const cat = document.getElementById("expenseCategory").value;
  const desc = document.getElementById("expenseDesc").value.trim();
  const date = document.getElementById("expenseDate").value;
  const recurring = document.getElementById("expenseRecurring").checked;
  const frequency = document.getElementById("expenseFrequency").value;
  const notes = document.getElementById("expenseNotes")?.value.trim() || "";
  if (!amt || amt <= 0 || !cat || !date) {
    notify("Please fill all required fields", "error");
    return;
  }
  transactions.unshift({
    id: Date.now(),
    date,
    category: cat,
    amount: -amt,
    description: desc,
    notes,
    type: "expense",
  });
  if (recurring) {
    const nd = new Date(date + "T00:00:00");
    if (frequency === "weekly") nd.setDate(nd.getDate() + 7);
    else nd.setMonth(nd.getMonth() + 1);
    recurringTemplates.push({
      id: Date.now() + 1,
      type: "expense",
      amount: amt,
      category: cat,
      description: desc,
      frequency,
      nextDate: nd.toISOString().split("T")[0],
    });
  }
  closeModal("expenseModal");
  saveToStorage();
  refreshAll();
  if (userData) {
    const mExp = sumExp(getTxns("monthly").filter((t) => t.type === "expense"));
    const pct = (mExp / userData.spendingLimit) * 100;
    if (pct >= 100) notify("Monthly limit exceeded", "error");
    else if (pct >= 80) notify(`${Math.round(pct)}% of limit used`, "info");
    else
      notify(
        recurring ? "Expense added and recurring set up" : "Expense added",
        "success",
      );
  }
}

function saveEdit() {
  const id = Number(document.getElementById("editId").value);
  const type = document.getElementById("editType").value;
  const amt = parseFloat(document.getElementById("editAmount").value);
  const date = document.getElementById("editDate").value;
  const cat = document.getElementById("editCategory").value;
  const desc = document.getElementById("editDesc").value.trim();
  const notes = document.getElementById("editNotes")?.value.trim() || "";
  if (!amt || !date || !cat) {
    notify("Please fill all fields", "error");
    return;
  }
  const t = transactions.find((x) => x.id === id);
  if (t) {
    t.amount = type === "income" ? amt : -amt;
    t.date = date;
    t.category = cat;
    t.description = desc;
    t.notes = notes;
  }
  closeModal("editModal");
  saveToStorage();
  refreshAll();
  notify("Transaction updated", "success");
}

function toggleRecurringUI(prefix) {
  const checked = document.getElementById(prefix + "Recurring").checked;
  document.getElementById(prefix + "FrequencyRow").style.display = checked
    ? "block"
    : "none";
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SORT / FILTER
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function openSortModal() {
  document.querySelector(`input[name="sf"][value="${sortCfg.field}"]`).checked =
    true;
  document.querySelector(`input[name="so"][value="${sortCfg.order}"]`).checked =
    true;
  openModal("sortModal");
}
function applySort() {
  sortCfg.field = document.querySelector('input[name="sf"]:checked').value;
  sortCfg.order = document.querySelector('input[name="so"]:checked').value;
  closeModal("sortModal");
  renderTxns(currentPeriod);
  notify("Sorted", "success");
}
function openFilterModal() {
  const allCats = [...new Set(transactions.map((t) => t.category))].sort();
  document.getElementById("filterCatList").innerHTML =
    allCats.length === 0
      ? '<span style="font-size:.8rem;color:#64748b;">No categories yet</span>'
      : allCats
          .map(
            (c) =>
              `<label class="sf-option"><input type="checkbox" name="fc" value="${c}" ${filterCfg.cats.includes(c) ? "checked" : ""}/><label>${c}</label></label>`,
          )
          .join("");
  document.querySelector(
    `input[name="ft"][value="${filterCfg.type}"]`,
  ).checked = true;
  openModal("filterModal");
}
function applyFilter() {
  filterCfg.type = document.querySelector('input[name="ft"]:checked').value;
  filterCfg.cats = [
    ...document.querySelectorAll('input[name="fc"]:checked'),
  ].map((i) => i.value);
  closeModal("filterModal");
  renderTxns(currentPeriod);
  notify(
    filterCfg.type !== "all" || filterCfg.cats.length > 0
      ? "Filter applied"
      : "Filter cleared",
    "success",
  );
}
function resetFilter() {
  filterCfg = { type: "all", cats: [] };
  document.querySelector('input[name="ft"][value="all"]').checked = true;
  document
    .querySelectorAll('input[name="fc"]')
    .forEach((i) => (i.checked = false));
  closeModal("filterModal");
  renderTxns(currentPeriod);
  notify("Filter cleared", "success");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CUSTOM CATEGORIES
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function openCategoryManager() {
  renderCategoryManager();
  openModal("categoryModal");
}
function renderCategoryManager() {
  const list = document.getElementById("customCatList");
  list.innerHTML =
    customCategories.length === 0
      ? '<p style="color:#64748b;font-size:.85rem;text-align:center;padding:.5rem 0;">No custom categories yet.</p>'
      : customCategories
          .map(
            (c, i) => `
        <div class="custom-cat-item">
          <span style="display:inline-flex;align-items:center;gap:.45rem;font-size:.875rem;">
            <span style="width:9px;height:9px;border-radius:50%;background:${getCatColor(c)};display:inline-block;flex-shrink:0;"></span>${c}
          </span>
          <button class="btn-cat-remove" onclick="removeCustomCategory(${i})" title="Remove"><i class="fas fa-times"></i></button>
        </div>`,
          )
          .join("");
}
function addCustomCategory() {
  const input = document.getElementById("newCatInput");
  const name = input.value.trim();
  if (!name) {
    notify("Enter a category name", "error");
    return;
  }
  if (
    getAllCategories()
      .map((c) => c.toLowerCase())
      .includes(name.toLowerCase())
  ) {
    notify("Already exists", "error");
    return;
  }
  customCategories.push(name);
  input.value = "";
  saveToStorage();
  populateCategorySelects();
  renderCategoryManager();
  notify(`"${name}" added`, "success");
}
function removeCustomCategory(index) {
  const removed = customCategories[index];
  customCategories.splice(index, 1);
  saveToStorage();
  populateCategorySelects();
  renderCategoryManager();
  notify(`"${removed}" removed`, "info");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CATEGORY BUDGETS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function openBudgetModal() {
  renderBudgetModal();
  openModal("budgetModal");
}
function renderBudgetModal() {
  const allCats = [
    ...new Set([...BASE_EXPENSE_CATS, ...customCategories, "Other"]),
  ];
  document.getElementById("budgetList").innerHTML = allCats
    .map(
      (c) => `
    <div class="budget-input-row">
      <label style="display:flex;align-items:center;gap:.5rem;font-size:.875rem;color:#e2e8f0;flex:1;">
        <span style="width:8px;height:8px;border-radius:50%;background:${getCatColor(c)};display:inline-block;flex-shrink:0;"></span>${c}
      </label>
      <input type="number" class="form-input budget-amt-input" placeholder="No limit" min="0"
        value="${categoryBudgets[c] || ""}" data-cat="${c}"
        style="width:130px;text-align:right;padding:.45rem .65rem;font-size:.85rem;"/>
    </div>`,
    )
    .join("");
}
function saveBudgets() {
  document.querySelectorAll(".budget-amt-input").forEach((input) => {
    const cat = input.dataset.cat,
      val = parseFloat(input.value);
    if (val > 0) categoryBudgets[cat] = val;
    else delete categoryBudgets[cat];
  });
  saveToStorage();
  closeModal("budgetModal");
  refreshAll();
  notify("Budgets saved", "success");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MONTHLY SUMMARY
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function setSummaryModalMeta(reportTitle, breakdownTitle, showNav = true) {
  const modalTitle = document.getElementById("summaryModalTitle");
  if (modalTitle) modalTitle.textContent = reportTitle;

  const breakdownEl = document.getElementById("summaryBreakdownTitle");
  if (breakdownEl) breakdownEl.textContent = breakdownTitle;

  const nav = document.querySelector(".summary-month-nav");
  if (nav) nav.style.display = showNav ? "" : "none";
}

function openMonthlySummary() {
  setSummaryModalMeta("Monthly Report", "Expense Breakdown", true);
  summaryMonth = new Date().getMonth();
  summaryYear = new Date().getFullYear();
  renderMonthlySummary();
  openModal("summaryModal");
}
function shiftSummaryMonth(dir) {
  summaryMonth += dir;
  if (summaryMonth < 0) {
    summaryMonth = 11;
    summaryYear--;
  }
  if (summaryMonth > 11) {
    summaryMonth = 0;
    summaryYear++;
  }
  renderMonthlySummary();
}
function renderMonthlySummary() {
  setSummaryModalMeta("Monthly Report", "Expense Breakdown", true);
  document.getElementById("summaryMonthTitle").textContent =
    MONTH_NAMES[summaryMonth] + " " + summaryYear;
  const tx = transactions.filter((t) => {
    const d = new Date(t.date + "T00:00:00");
    return d.getFullYear() === summaryYear && d.getMonth() === summaryMonth;
  });
  const inc = sumInc(tx),
    exp = sumExp(tx.filter((t) => t.type === "expense")),
    net = inc - exp;
  const rate = inc > 0 ? Math.round((net / inc) * 100) : 0;
  const cats = {};
  tx.filter((t) => t.type === "expense").forEach((t) => {
    cats[t.category] = (cats[t.category] || 0) + Math.abs(t.amount);
  });
  const sortedCats = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const topCat = sortedCats[0];
  const biggest = [...tx.filter((t) => t.type === "expense")].sort(
    (a, b) => Math.abs(b.amount) - Math.abs(a.amount),
  )[0];
  document.getElementById("summaryInc").textContent = fmt(inc);
  document.getElementById("summaryExp").textContent = fmt(exp);
  document.getElementById("summaryNet").textContent =
    (net >= 0 ? "+" : "-") + fmt(Math.abs(net));
  document.getElementById("summaryNet").className =
    "summary-value " + (net >= 0 ? "positive" : "negative");
  document.getElementById("summaryRate").textContent = rate + "%";
  document.getElementById("summaryRate").className =
    "summary-value " + (rate >= 0 ? "positive" : "negative");
  document.getElementById("summaryTopCat").textContent = topCat
    ? `${topCat[0]} (${fmt(topCat[1])})`
    : "—";
  document.getElementById("summaryBiggest").textContent = biggest
    ? `${biggest.description || biggest.category} (${fmt(Math.abs(biggest.amount))})`
    : "—";
  document.getElementById("summaryCatList").innerHTML =
    sortedCats.length === 0
      ? '<p style="color:#64748b;font-size:.85rem;text-align:center;padding:1rem 0;">No expenses this month</p>'
      : sortedCats
          .map(([c, a]) => {
            const pct = exp > 0 ? Math.round((a / exp) * 100) : 0;
            return `<div class="summary-cat-row">
          <div style="display:flex;align-items:center;gap:.5rem;min-width:110px;">
            <span style="width:8px;height:8px;border-radius:50%;background:${getCatColor(c)};display:inline-block;flex-shrink:0;"></span>
            <span style="font-size:.82rem;">${c}</span>
          </div>
          <div style="display:flex;align-items:center;gap:.75rem;flex:1;justify-content:flex-end;">
            <div class="summary-cat-bar-bg"><div class="summary-cat-bar-fill" style="width:${pct}%;background:${getCatColor(c)};"></div></div>
            <span style="font-size:.8rem;font-weight:600;min-width:75px;text-align:right;">${fmt(a)}</span>
            <span style="font-size:.75rem;color:#64748b;min-width:32px;text-align:right;">${pct}%</span>
          </div>
        </div>`;
          })
          .join("");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   EXPORT CSV
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function exportCSV() {
  if (!transactions.length) {
    notify("No transactions to export", "error");
    return;
  }
  const rows = [
    ["Date", "Type", "Category", "Description", "Amount", "Recurring"],
  ];
  transactions.forEach((t) =>
    rows.push([
      t.date,
      t.type,
      t.category,
      t.description || "",
      Math.abs(t.amount),
      t.recurringId ? "Yes" : "No",
    ]),
  );
  const csv = rows.map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = "data:text/csv," + encodeURIComponent(csv);
  a.download = `blueledger-${userData?.name?.split(" ")[0] || "export"}-${todayStr()}.csv`;
  a.click();
  notify("Exported", "success");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MODALS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function syncFabVisibility() {
  const isMobile = window.innerWidth <= 768;
  const locked =
    document.getElementById("lockScreen")?.style.display !== "none";
  const ready = !!userData && !locked;

  // Desktop: show/hide header buttons
  document
    .querySelectorAll(
      ".hdr-income-btn,.hdr-expense-btn,.hdr-cat-btn,.report-btn.desktop-only",
    )
    .forEach((el) => {
      el.style.display = ready && !isMobile ? "" : "none";
    });

  // Mobile: show/hide bottom nav
  const nav = document.getElementById("bottomNav");
  if (nav) nav.style.display = ready && isMobile ? "flex" : "none";

  // Add padding to main content so it clears bottom nav on mobile
  const main = document.querySelector(".main-content");
  if (main) main.style.paddingBottom = ready && isMobile ? "80px" : "";
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   BOTTOM NAV LOGIC
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function bnSwitch(tab) {
  // Clear active state
  document
    .querySelectorAll(".bn-tab")
    .forEach((t) => t.classList.remove("bn-tab--active"));

  if (tab === "add") {
    // Don't mark Add as active — open sheet instead
    openBnSheet();
    return;
  }
  if (tab === "report") {
    document.getElementById("bnReport").classList.add("bn-tab--active");
    openBnReport();
    return;
  }
  if (tab === "cat") {
    document.getElementById("bnCat").classList.add("bn-tab--active");
    openCategoryManager();
    setTimeout(() => {
      document
        .querySelectorAll(".bn-tab")
        .forEach((t) => t.classList.remove("bn-tab--active"));
      document.getElementById("bnHome").classList.add("bn-tab--active");
    }, 300);
    return;
  }
  if (tab === "settings") {
    document.getElementById("bnSettings").classList.add("bn-tab--active");
    openBnSettings();
    return;
  }
  // Home
  document.getElementById("bnHome").classList.add("bn-tab--active");
}

function openBnSheet() {
  document.getElementById("bnAddSheet").classList.add("open");
  document.getElementById("bnSheetOverlay").classList.add("open");
}
function closeBnSheet() {
  document.getElementById("bnAddSheet")?.classList.remove("open");
  document.getElementById("bnSheetOverlay")?.classList.remove("open");
  // Return active to Home
  document
    .querySelectorAll(".bn-tab")
    .forEach((t) => t.classList.remove("bn-tab--active"));
  document.getElementById("bnHome")?.classList.add("bn-tab--active");
}

function openBnSettings() {
  document.getElementById("bnSettingsPanel").classList.add("open");
  document.getElementById("bnSettingsOverlay").classList.add("open");
}

function openBnReport() {
  document.getElementById("bnReportSheet").classList.add("open");
  document.getElementById("bnReportOverlay").classList.add("open");
}
function closeBnReport() {
  document.getElementById("bnReportSheet")?.classList.remove("open");
  document.getElementById("bnReportOverlay")?.classList.remove("open");
  document
    .querySelectorAll(".bn-tab")
    .forEach((t) => t.classList.remove("bn-tab--active"));
  document.getElementById("bnHome")?.classList.add("bn-tab--active");
}

function openReportFor(period) {
  if (period === "yearly") {
    openYearlyReport();
    return;
  }
  if (period === "monthly") {
    openMonthlySummary();
    return;
  }
  // Daily / Weekly — show period-specific summary
  openPeriodReport(period);
}

function openPeriodReport(period) {
  const now = new Date();
  const isDaily = period === "daily";
  setSummaryModalMeta(
    isDaily ? "Daily Report" : "Weekly Report",
    "Expense Breakdown",
    false,
  );

  let txns, title;
  if (isDaily) {
    const ds = localDateStr(now);
    txns = transactions.filter((t) => t.date === ds);
    title =
      "Today — " +
      now.toLocaleDateString("en-IN", { day: "numeric", month: "long" });
  } else {
    // Weekly — Mon to today
    const dow = now.getDay(),
      off = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + off,
    );
    txns = transactions.filter((t) => {
      const d = toDay(new Date(t.date + "T00:00:00"));
      return d >= mon && d <= toDay(now);
    });
    title =
      mon.getDate() +
      " " +
      mon.toLocaleString("en-IN", { month: "short" }) +
      " – " +
      now.getDate() +
      " " +
      now.toLocaleString("en-IN", { month: "short" });
  }

  const inc = sumInc(txns);
  const exp = sumExp(txns.filter((t) => t.type === "expense"));
  const net = inc - exp;
  const rate = inc > 0 ? Math.round((net / inc) * 100) : 0;
  const cats = {};
  txns
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      cats[t.category] = (cats[t.category] || 0) + Math.abs(t.amount);
    });
  const sortedCats = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const topCat = sortedCats[0];
  const biggest = [...txns.filter((t) => t.type === "expense")].sort(
    (a, b) => Math.abs(b.amount) - Math.abs(a.amount),
  )[0];

  document.getElementById("summaryMonthTitle").textContent = title;
  document.getElementById("summaryInc").textContent = fmt(inc);
  document.getElementById("summaryExp").textContent = fmt(exp);
  document.getElementById("summaryNet").textContent =
    (net >= 0 ? "+" : "-") + fmt(Math.abs(net));
  document.getElementById("summaryNet").className =
    "summary-value " + (net >= 0 ? "positive" : "negative");
  document.getElementById("summaryRate").textContent = rate + "%";
  document.getElementById("summaryRate").className =
    "summary-value " + (rate >= 0 ? "positive" : "negative");
  document.getElementById("summaryTopCat").textContent = topCat
    ? topCat[0] + " (" + fmt(topCat[1]) + ")"
    : "—";
  document.getElementById("summaryBiggest").textContent = biggest
    ? (biggest.description || biggest.category) +
      " (" +
      fmt(Math.abs(biggest.amount)) +
      ")"
    : "—";
  document.getElementById("summaryCatList").innerHTML =
    sortedCats.length === 0
      ? "<p style='color:#64748b;font-size:.85rem;text-align:center;padding:1rem 0;'>No expenses</p>"
      : sortedCats
          .map(([c, a]) => {
            const pct = exp > 0 ? Math.round((a / exp) * 100) : 0;
            return `<div class="summary-cat-row">
          <div style="display:flex;align-items:center;gap:.5rem;min-width:110px;">
            <span style="width:8px;height:8px;border-radius:50%;background:${getCatColor(c)};display:inline-block;flex-shrink:0;"></span>
            <span style="font-size:.82rem;">${c}</span>
          </div>
          <div style="display:flex;align-items:center;gap:.75rem;flex:1;justify-content:flex-end;">
            <div class="summary-cat-bar-bg"><div class="summary-cat-bar-fill" style="width:${pct}%;background:${getCatColor(c)};"></div></div>
            <span style="font-size:.8rem;font-weight:600;min-width:75px;text-align:right;">${fmt(a)}</span>
            <span style="font-size:.75rem;color:#64748b;min-width:32px;text-align:right;">${pct}%</span>
          </div></div>`;
          })
          .join("");
  openModal("summaryModal");
}

function openYearlyReport() {
  setSummaryModalMeta("Yearly Report", "Monthly Breakdown", false);
  const now = new Date();
  const year = now.getFullYear();
  const yearTxns = transactions.filter(
    (t) => new Date(t.date + "T00:00:00").getFullYear() === year,
  );
  const inc = sumInc(yearTxns);
  const exp = sumExp(yearTxns.filter((t) => t.type === "expense"));
  const net = inc - exp;
  const rate = inc > 0 ? Math.round(((inc - exp) / inc) * 100) : 0;

  // Build monthly breakdown for the year
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const breakdown = months
    .map((m, i) => {
      const mt = yearTxns.filter(
        (t) => new Date(t.date + "T00:00:00").getMonth() === i,
      );
      const mi = sumInc(mt),
        me = sumExp(mt.filter((t) => t.type === "expense"));
      return { month: m, income: mi, expense: me };
    })
    .filter((r) => r.income > 0 || r.expense > 0);

  // Reuse summary modal with yearly data
  document.getElementById("summaryMonthTitle").textContent = "Year " + year;
  document.getElementById("summaryInc").textContent = fmt(inc);
  document.getElementById("summaryExp").textContent = fmt(exp);
  document.getElementById("summaryNet").textContent = fmt(Math.abs(net));
  document.getElementById("summaryNet").className =
    "summary-value " + (net >= 0 ? "positive" : "negative");
  document.getElementById("summaryRate").textContent = rate + "%";
  document.getElementById("summaryRate").className =
    "summary-value " + (rate >= 20 ? "positive" : rate >= 0 ? "" : "negative");

  // Top category
  const cats = {};
  yearTxns
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      cats[t.category] = (cats[t.category] || 0) + Math.abs(t.amount);
    });
  const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
  document.getElementById("summaryTopCat").textContent = topCat
    ? topCat[0] + " (" + fmt(topCat[1]) + ")"
    : "—";

  // Biggest single expense
  const biggest = yearTxns
    .filter((t) => t.type === "expense")
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
  document.getElementById("summaryBiggest").textContent = biggest
    ? fmt(Math.abs(biggest.amount)) +
      " – " +
      (biggest.description || biggest.category)
    : "—";

  // Monthly breakdown table
  document.getElementById("summaryCatList").innerHTML =
    breakdown
      .map(
        (r) =>
          `<div class="summary-year-row">
      <span class="summary-year-month">${r.month}</span>
      <span class="summary-year-income">+${fmt(r.income)}</span>
      <span class="summary-year-expense">-${fmt(r.expense)}</span>
      <span class="summary-year-net" style="color:${r.income >= r.expense ? "#10b981" : "#ef4444"}">${fmt(Math.abs(r.income - r.expense))}</span>
    </div>`,
      )
      .join("") || "<div class='summary-empty'>No transactions this year</div>";
  openModal("summaryModal");
}

function closeBnSettings() {
  document.getElementById("bnSettingsPanel")?.classList.remove("open");
  document.getElementById("bnSettingsOverlay")?.classList.remove("open");
  document
    .querySelectorAll(".bn-tab")
    .forEach((t) => t.classList.remove("bn-tab--active"));
  document.getElementById("bnHome")?.classList.add("bn-tab--active");
}

function toggleActionSheet() {
  const sheet = document.getElementById("actionSheet");
  const overlay = document.getElementById("actionSheetOverlay");
  const icon = document.getElementById("fabMainIcon");
  const isOpen = sheet.classList.contains("open");
  if (isOpen) {
    sheet.classList.remove("open");
    overlay.classList.remove("open");
    if (icon) {
      icon.className = "fas fa-plus";
    }
  } else {
    sheet.classList.add("open");
    overlay.classList.add("open");
    if (icon) {
      icon.className = "fas fa-times";
    }
  }
}

function closeActionSheet() {
  document.getElementById("actionSheet")?.classList.remove("open");
  document.getElementById("actionSheetOverlay")?.classList.remove("open");
  const icon = document.getElementById("fabMainIcon");
  if (icon) icon.className = "fas fa-plus";
}

function openModal(id) {
  closeBnSheet();
  document.getElementById(id).style.display = "block";
  document.body.style.overflow = "hidden";
  syncFabVisibility();
  const t = todayStr();
  if (id === "incomeModal") {
    ["incomeAmount", "incomeDesc"].forEach(
      (el) => (document.getElementById(el).value = ""),
    );
    const inEl = document.getElementById("incomeNotes");
    if (inEl) inEl.value = "";
    document.getElementById("incomeDate").value = t;
    document.getElementById("incomeRecurring").checked = false;
    document.getElementById("incomeFrequencyRow").style.display = "none";
    populateCategorySelects();
    document.getElementById("incomeCategory").value = "";
  }
  if (id === "expenseModal") {
    ["expenseAmount", "expenseDesc"].forEach(
      (el) => (document.getElementById(el).value = ""),
    );
    const exEl = document.getElementById("expenseNotes");
    if (exEl) exEl.value = "";
    document.getElementById("expenseDate").value = t;
    document.getElementById("expenseRecurring").checked = false;
    document.getElementById("expenseFrequencyRow").style.display = "none";
    populateCategorySelects();
    document.getElementById("expenseCategory").value = "";
  }
}

function closeModal(id) {
  if (id === "summaryModal") {
    const nav = document.querySelector(".summary-month-nav");
    if (nav) nav.style.display = "";
  }
  document.getElementById(id).style.display = "none";
  document.body.style.overflow = "auto";
  syncFabVisibility();
  if (id === "onboardingModal" && addingNewCard) {
    addingNewCard = false;
    const modal = document.getElementById("onboardingModal");
    modal.querySelector(".ob-sub").textContent =
      "Your personal finance dashboard — let's get you set up";
    modal.querySelector(".btn-onboard").textContent = "Get Started";
    const pinSection = modal.querySelector(".pin-section");
    if (pinSection) pinSection.style.display = "";
  }
  // If no user yet, show splash screen instead of blank screen
  if (id === "onboardingModal" && !userData) {
    document.getElementById("splashScreen").style.display = "flex";
  }
}

const ALL_MODALS = [
  "incomeModal",
  "expenseModal",
  "editModal",
  "sortModal",
  "filterModal",
  "deleteModal",
  "deleteCardModal",
  "categoryModal",
  "budgetModal",
  "summaryModal",
  "changePinModal",
  "resetModal",
  "editLimitModal",
  "importModal",
  "privacyModal",
];
window.addEventListener("click", (e) => {
  ALL_MODALS.forEach((id) => {
    if (e.target === document.getElementById(id)) closeModal(id);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   TOAST NOTIFICATIONS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const activeNotifs = [];
function notify(msg, type = "success") {
  const c = {
    success: "linear-gradient(135deg,#34d399,#10b981)",
    error: "linear-gradient(135deg,#f87171,#ef4444)",
    info: "linear-gradient(135deg,#60a5fa,#3b82f6)",
  };
  const n = document.createElement("div");
  activeNotifs.push(n);
  n.style.cssText = `position:fixed;top:${1.25 + (activeNotifs.length - 1) * 3.6}rem;right:1.5rem;color:white;padding:.75rem 1.2rem;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.25);z-index:9999;animation:slideInRight .3s ease;background:${c[type] || c.success};font-weight:600;font-size:.85rem;max-width:275px;transition:top .25s;`;
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => {
    n.style.animation = "slideOutRight .3s ease forwards";
    setTimeout(() => {
      n.remove();
      const idx = activeNotifs.indexOf(n);
      if (idx > -1) activeNotifs.splice(idx, 1);
      activeNotifs.forEach((el, i) => {
        el.style.top = 1.25 + i * 3.6 + "rem";
      });
    }, 320);
  }, 2800);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ONBOARDING
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function completeOnboarding() {
  const name = document.getElementById("ob-name").value.trim();
  const last4 = document
    .getElementById("ob-card")
    .value.replace(/\D/g, "")
    .slice(-4);
  const limit = parseFloat(document.getElementById("ob-limit").value);

  if (!name) {
    notify("Please enter your name", "error");
    return;
  }
  if (last4.length !== 4) {
    notify("Please enter the last 4 digits of your card", "error");
    return;
  }
  if (!limit || limit <= 0) {
    notify("Please enter a valid spending limit", "error");
    return;
  }

  // PIN only required on first card setup (not when adding additional cards)
  let pinToUse = sessionPin;
  if (!addingNewCard) {
    const pin = document.getElementById("ob-pin").value.trim();
    const pin2 = document.getElementById("ob-pin2").value.trim();
    if (!/^\d{4,6}$/.test(pin)) {
      notify("PIN must be 4–6 digits", "error");
      return;
    }
    if (pin !== pin2) {
      notify("PINs don't match", "error");
      return;
    }
    pinToUse = pin;
  }

  const nickname = document.getElementById("ob-nickname")?.value.trim() || "";
  const cardDisplay = `•••• •••• •••• ${last4}`;
  const newCardData = {
    userData: { name, nickname, cardNumber: cardDisplay, spendingLimit: limit },
    transactions: [],
    customCategories: [],
    categoryBudgets: {},
    recurringTemplates: [],
  };

  if (addingNewCard) {
    syncActiveToCards();
    cards.push(newCardData);
    activeCardIdx = cards.length - 1;
  } else {
    cards = [newCardData];
    activeCardIdx = 0;
  }

  userData = newCardData.userData;
  transactions = newCardData.transactions;
  customCategories = newCardData.customCategories;
  categoryBudgets = newCardData.categoryBudgets;
  recurringTemplates = newCardData.recurringTemplates;

  sessionPin = pinToUse;
  addingNewCard = false;

  const modal = document.getElementById("onboardingModal");
  modal.querySelector(".ob-sub").textContent =
    "Your personal finance dashboard — let's get you set up";
  modal.querySelector(".btn-onboard").textContent = "Get Started";
  const pinSection = modal.querySelector(".pin-section");
  if (pinSection) pinSection.style.display = "";

  closeModal("onboardingModal");
  saveToStorage();
  resetAutoLock();
  renderCardSwitcher();
  updateMyCardWidget();
  populateCategorySelects();
  refreshAll();
  syncFabVisibility();
  notify(
    "Welcome, " + name.split(" ")[0] + "! Encrypted and secured.",
    "success",
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   MY CARD OPTIONS MENU + EDIT SPENDING LIMIT
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function openCardOptionsMenu(e) {
  e.stopPropagation();
  const menu = document.getElementById("cardOptionsMenu");
  menu.style.display = "block";
  const r = e.currentTarget.getBoundingClientRect();
  let left = r.left - 160;
  if (left < 8) left = r.right + 4;
  let top = r.bottom + 4;
  if (top + 100 > window.innerHeight) top = r.top - 100;
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

function closeCardOptionsMenu() {
  document.getElementById("cardOptionsMenu").style.display = "none";
}

document.addEventListener("click", (e) => {
  if (
    !e.target.closest("#cardOptionsMenu") &&
    !e.target.closest(".my-card-dots") &&
    !e.target.closest(".my-card .card-menu-btn")
  ) {
    closeCardOptionsMenu();
  }
});
// Close card options menu on scroll
window.addEventListener("scroll", () => closeCardOptionsMenu(), {
  passive: true,
});
document.addEventListener("scroll", () => closeCardOptionsMenu(), true);

function openEditLimitModal() {
  const el = document.getElementById("newSpendLimit");
  if (el && userData) el.value = userData.spendingLimit;
  openModal("editLimitModal");
}

function saveSpendingLimit() {
  const val = parseFloat(document.getElementById("newSpendLimit").value);
  if (!val || val <= 0) {
    notify("Enter a valid spending limit", "error");
    return;
  }
  userData.spendingLimit = val;
  saveToStorage();
  closeModal("editLimitModal");
  refreshAll();
  notify("Spending limit updated", "success");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SETTINGS MENU
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   DARK / LIGHT THEME
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function syncThemeUi(theme) {
  const cls = theme === "dark" ? "fas fa-moon" : "fas fa-sun";
  ["themeIcon", "themeIconMobile", "themeIconDesktop", "themeIconMenu"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.className = cls;
    },
  );

  const mobileLabel = document.getElementById("themeModeLabelMobile");
  if (mobileLabel)
    mobileLabel.textContent = theme === "dark" ? "Dark mode" : "Light mode";
}

function toggleTheme() {
  const html = document.documentElement;
  const isDark = html.getAttribute("data-theme") === "dark";
  const newTheme = isDark ? "light" : "dark";
  html.setAttribute("data-theme", newTheme);
  localStorage.setItem("bl_theme", newTheme);
  syncThemeUi(newTheme);
}

function loadTheme() {
  const saved = localStorage.getItem("bl_theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  syncThemeUi(saved);
}

function toggleSettingsMenu() {
  const menu = document.getElementById("settingsMenu");
  menu.classList.toggle("open");
}

function closeSettingsMenu() {
  document.getElementById("settingsMenu").classList.remove("open");
}

// Onboarding tooltips
function showTip(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "flex";
}
function hideTip(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = "none";
}

// Privacy policy
function openPrivacyModal() {
  openModal("privacyModal");
}

// Close settings menu when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest("#settingsDropdown")) closeSettingsMenu();
});

function openResetModal() {
  openModal("resetModal");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   IMPORT CSV
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

let importedRows = [];
const IMPORT_TEMPLATE_ROWS = [
  ["Date", "Type", "Category", "Description", "Amount", "Recurring"],
  ["2026-03-01", "expense", "Food", "Lunch", "250", "No"],
  ["2026-03-02", "income", "Salary", "March salary", "50000", "No"],
  ["2026-03-03", "expense", "Transport", "Cab to office", "180", "No"],
];
const IMPORT_HEADER_ALIASES = {
  date: [
    "date",
    "transactiondate",
    "txndate",
    "entrydate",
    "posteddate",
    "valuedate",
  ],
  type: [
    "type",
    "transactiontype",
    "entrytype",
    "kind",
    "flow",
    "incomeexpense",
    "creditdebit",
    "drcr",
  ],
  category: [
    "category",
    "categories",
    "group",
    "expensecategory",
    "incomecategory",
  ],
  description: [
    "description",
    "desc",
    "details",
    "detail",
    "merchant",
    "narration",
    "note",
    "notes",
    "remark",
    "remarks",
    "particulars",
  ],
  amount: ["amount", "value", "total", "sum", "transactionamount"],
  credit: ["credit", "deposit", "income", "moneyin", "cr"],
  debit: ["debit", "withdrawal", "expense", "moneyout", "dr"],
  recurring: ["recurring", "repeat", "isrecurring", "recurrence"],
};

function getImportTemplateCsv() {
  return IMPORT_TEMPLATE_ROWS.map((row) => row.join(",")).join("\n");
}

function downloadImportTemplate() {
  const blob = new Blob([getImportTemplateCsv()], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "blueledger-import-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function splitCsvLine(line) {
  return (
    line
      .match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g)
      ?.map((v) => v.replace(/^"|"$/g, "").trim()) || []
  );
}

function normalizeImportHeader(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function detectImportColumns(headers) {
  const normalized = headers.map(normalizeImportHeader);
  const map = {};
  Object.entries(IMPORT_HEADER_ALIASES).forEach(([field, aliases]) => {
    const idx = normalized.findIndex((h) => aliases.includes(h));
    if (idx > -1) map[field] = idx;
  });
  const recognized = Object.keys(map).length;
  const looksLikeHeader =
    recognized >= 3 ||
    normalized.includes("date") ||
    normalized.includes("amount") ||
    normalized.includes("type");
  return { looksLikeHeader, map };
}

function getImportValue(cols, map, key) {
  const idx = map[key];
  if (idx === undefined || idx < 0 || idx >= cols.length) return "";
  return cols[idx]?.trim() || "";
}

function parseImportAmount(raw) {
  if (raw === null || raw === undefined) return NaN;
  let val = String(raw).trim();
  if (!val) return NaN;
  let negative = false;
  if (val.startsWith("(") && val.endsWith(")")) {
    negative = true;
    val = val.slice(1, -1);
  }
  val = val.replace(/[₹$,]/g, "").replace(/\s+/g, "");
  if (val.endsWith("-")) {
    negative = true;
    val = val.slice(0, -1);
  }
  const num = parseFloat(val);
  if (isNaN(num)) return NaN;
  return negative ? -Math.abs(num) : num;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function normalizeImportDate(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const parts = value.split(/[\/.\-]/).map((x) => x.trim());
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      const [y, m, d] = parts.map(Number);
      if (y && m && d) return `${y}-${pad2(m)}-${pad2(d)}`;
    }
    if (parts[2].length === 4) {
      let [a, b, y] = parts.map(Number);
      if (y && a && b) {
        let d = a;
        let m = b;
        if (a <= 12 && b > 12) {
          d = b;
          m = a;
        }
        return `${y}-${pad2(m)}-${pad2(d)}`;
      }
    }
  }

  const parsed = new Date(value);
  if (!isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
  }
  return "";
}

function normalizeImportType(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (!value) return "";
  if (["income", "credit", "deposit", "in"].includes(value)) return "income";
  if (["expense", "debit", "withdrawal", "out"].includes(value))
    return "expense";
  return "";
}

function openImportModal() {
  importedRows = [];
  document.getElementById("importPreview").style.display = "none";
  document.getElementById("importConfirmBtn").style.display = "none";
  document.getElementById("importFileInput").value = "";
  openModal("importModal");
}

function handleDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add("dragover");
}
function handleDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) parseCSVFile(file);
}
function handleImportFile(input) {
  const file = input.files[0];
  if (file) parseCSVFile(file);
}

function parseCSVFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const lines = text
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim());
    if (lines.length < 1) {
      notify("CSV file appears empty", "error");
      return;
    }
    const defaultMap = {
      date: 0,
      type: 1,
      category: 2,
      description: 3,
      amount: 4,
      recurring: 5,
    };
    const firstCols = splitCsvLine(lines[0]);
    const detected = detectImportColumns(firstCols);
    const activeMap = detected.looksLikeHeader ? detected.map : defaultMap;
    const dataLines = detected.looksLikeHeader ? lines.slice(1) : lines;

    importedRows = [];
    let skipped = 0;
    dataLines.forEach((line, i) => {
      const cols = splitCsvLine(line);
      if (cols.length < 2) {
        skipped++;
        return;
      }

      const date = normalizeImportDate(getImportValue(cols, activeMap, "date"));
      const description = getImportValue(cols, activeMap, "description");
      const category = getImportValue(cols, activeMap, "category") || "Other";
      let type = normalizeImportType(getImportValue(cols, activeMap, "type"));
      let amount = parseImportAmount(getImportValue(cols, activeMap, "amount"));
      const credit = parseImportAmount(
        getImportValue(cols, activeMap, "credit"),
      );
      const debit = parseImportAmount(getImportValue(cols, activeMap, "debit"));

      if (!isNaN(credit) && Math.abs(credit) > 0) {
        type = "income";
        amount = Math.abs(credit);
      } else if (!isNaN(debit) && Math.abs(debit) > 0) {
        type = "expense";
        amount = -Math.abs(debit);
      } else if (!isNaN(amount)) {
        if (!type) type = amount < 0 ? "expense" : "income";
        amount = type === "income" ? Math.abs(amount) : -Math.abs(amount);
      }

      if (!date || !category || !type || isNaN(amount)) {
        skipped++;
        return;
      }
      importedRows.push({
        id: Date.now() + Math.random() + i,
        date,
        type,
        category: category.trim(),
        description: description?.trim() || "",
        amount,
      });
    });

    // Show preview
    const preview = document.getElementById("importPreview");
    const previewText = document.getElementById("importPreviewText");
    const summary = document.getElementById("importSummary");
    const confirmBtn = document.getElementById("importConfirmBtn");

    if (importedRows.length === 0) {
      notify("No valid rows found in CSV", "error");
      return;
    }

    const sample = importedRows
      .slice(0, 5)
      .map(
        (r) =>
          `${r.date}  ${r.type}  ${r.category}  ${r.description || "-"}  ₹${Math.abs(r.amount).toLocaleString("en-IN")}`,
      )
      .join("\n");

    previewText.textContent =
      sample +
      (importedRows.length > 5
        ? `\n... and ${importedRows.length - 5} more`
        : "");
    summary.textContent = `${importedRows.length} transactions ready to import${skipped > 0 ? ` (${skipped} rows skipped)` : ""}`;
    const sourceType = detected.looksLikeHeader
      ? "Mapped from your headers"
      : "Used BlueLedger default column order";
    summary.textContent += ` â€¢ ${sourceType}`;
    preview.style.display = "block";
    confirmBtn.style.display = "inline-flex";
  };
  reader.readAsText(file);
}

function confirmImport() {
  if (!importedRows.length) return;
  let dupes = 0;
  importedRows.forEach((row) => {
    // Skip duplicates (same date, amount, category)
    const isDupe = transactions.some(
      (t) =>
        t.date === row.date &&
        t.amount === row.amount &&
        t.category === row.category,
    );
    if (!isDupe) transactions.unshift(row);
    else dupes++;
  });
  saveToStorage();
  refreshAll();
  closeModal("importModal");
  const imported = importedRows.length - dupes;
  notify(
    `Imported ${imported} transaction${imported !== 1 ? "s" : ""}${dupes > 0 ? ` (${dupes} duplicates skipped)` : ""}`,
    "success",
  );
  importedRows = [];
}

function confirmReset() {
  localStorage.clear();
  closeModal("resetModal");
  notify("App reset. Reloading...", "info");
  setTimeout(() => location.reload(), 1000);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   STARTUP
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

window.addEventListener("resize", syncFabVisibility);
document.getElementById("headerDate").textContent =
  new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
loadTheme();

// Register PWA service worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

if (hasStoredData()) {
  // Existing user — show lock screen, decrypt on PIN entry
  document.getElementById("onboardingModal").style.display = "none";
  showLockScreen();
} else {
  // First launch — show onboarding
  document.getElementById("onboardingModal").style.display = "block";
  document.getElementById("lockScreen").style.display = "none";
}

renderCardSwitcher();
populateCategorySelects();
setChartPeriod(chartPeriod);
refreshAll();
syncFabVisibility();
