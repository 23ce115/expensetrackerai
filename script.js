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
const VAULT_SCHEMA_VERSION = 1;
const SYNC_PENDING_KEY = "bl_sync_pending_v1";
const SYNC_DEVICE_KEY = "bl_sync_device_v1";
const SYNC_TABLE = "encrypted_vaults";
const SYNC_POLL_MS = 30 * 1000;

/* ── BlueLedger hosted Supabase (hardcoded) ── */
const BL_SUPABASE_URL = "https://fptiscqzzimxxtgjejhz.supabase.co";
const BL_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwdGlzY3F6emlteHh0Z2plamh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxOTcwMTgsImV4cCI6MjA5MDc3MzAxOH0.6BTK1JiEH9EvvEvp5sV41GF7gQcgUCPqKqDB4JhjQBE";
const AUTH_MODE_KEY = "bl_auth_mode"; // "password" | "pin" (legacy)
const VERIFY_TOKEN_V2 = "BL_OK_v2";
const WEBAUTHN_CRED_ID_KEY = "bl_webauthn_cred_id";
const WEBAUTHN_PWD_VAULT_KEY = "bl_webauthn_pwd_vault";
const WEBAUTHN_RP_ID_KEY = "bl_webauthn_rp_id";

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

let currentPeriod = "monthly"; // always monthly
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
const TXN_PREVIEW_LIMITS = {
  daily: 6,
  weekly: 7,
  monthly: 8,
  picked: 8,
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AI FEATURES — AUTO-CATEGORIZATION & ASK BLUELEDGER
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const AI_MODEL = "claude-sonnet-4-20250514";
let _aiCatTimers = {};
let _aiCatGeneration = {}; // generation counter per type — stale responses are ignored
let _aiCatDismissed = {}; // exact description text dismissed by the user
let _aiCatState = {};
let _askBlHistory = [];
let _askBlBusy = false;

/* ── Shared Anthropic API call ── */
async function _callAI(messages, systemPrompt, maxTokens = 300) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`AI API error ${res.status}`);
  const data = await res.json();
  return data.content?.map((b) => b.text || "").join("") || "";
}

/* ──────────────────────────────────────────────
   LOCAL KEYWORD CLASSIFIER
   Runs instantly on every keystroke for immediate
   feedback. Falls back to Claude API for ambiguous
   cases after a debounce delay.
────────────────────────────────────────────── */
const _AI_KEYWORD_MAP = {
  // Food & Dining
  Food: [
    "starbucks",
    "coffee",
    "cafe",
    "restaurant",
    "lunch",
    "dinner",
    "breakfast",
    "zomato",
    "swiggy",
    "dominos",
    "pizza",
    "burger",
    "biryani",
    "food",
    "grocery",
    "supermarket",
    "vegetables",
    "fruits",
    "milk",
    "bread",
    "chai",
    "tea",
    "snack",
    "meal",
    "eat",
    "dunkin",
    "mcdonalds",
    "kfc",
    "subway",
    "barbeque",
    "bakery",
    "hotel",
    "canteen",
    "tiffin",
    "dine",
    "dining",
    "juice",
    "coca",
    "pepsi",
    "maggi",
    "rice",
    "dal",
    "apple",
    "banana",
    "orange",
    "mango",
    "grapes",
    "fruit",
    "vegetable",
    "tomato",
    "potato",
    "onion",
    "egg",
    "eggs",
    "chicken",
    "paneer",
    "biscuit",
    "biscuits",
    "chips",
    "chocolate",
    "dosa",
    "masala dosa",
    "idli",
    "vada",
    "sambar",
    "uttapam",
    "poha",
    "upma",
    "paratha",
    "roti",
    "naan",
    "sabzi",
    "thali",
    "sandwich",
    "shawarma",
    "wrap",
    "roll",
    "momo",
    "momos",
    "noodles",
    "pasta",
    "ice cream",
    "kulfi",
    "mithai",
    "sweet",
    "sweets",
    "lassi",
  ],
  // Transport
  Transport: [
    "uber",
    "ola",
    "rapido",
    "auto",
    "taxi",
    "cab",
    "petrol",
    "diesel",
    "fuel",
    "metro",
    "bus",
    "train",
    "flight",
    "airways",
    "airline",
    "travel",
    "transport",
    "toll",
    "parking",
    "irctc",
    "indigo",
    "spicejet",
    "air india",
    "vistara",
    "redbus",
    "rickshaw",
    "bike",
    "carpool",
    "share",
    "commute",
    "railway",
    "station",
  ],
  // Shopping
  Shopping: [
    "amazon",
    "flipkart",
    "myntra",
    "ajio",
    "nykaa",
    "meesho",
    "zepto",
    "blinkit",
    "bigbasket",
    "reliance",
    "dmart",
    "mall",
    "shopping",
    "clothes",
    "shirt",
    "shoes",
    "fashion",
    "apparel",
    "dress",
    "watch",
    "bag",
    "accessories",
    "cosmetics",
    "beauty",
    "electronics",
    "mobile",
    "laptop",
    "gadget",
    "appliance",
    "furniture",
    "decor",
    "gift",
    "toys",
    "toy",
    "perfume",
    "soap",
    "shampoo",
    "detergent",
    "bucket",
    "bottle",
    "utensils",
    "kitchen",
  ],
  // Entertainment
  Entertainment: [
    "netflix",
    "hotstar",
    "prime",
    "disney",
    "apple music",
    "youtube music",
    "amazon prime",
    "prime video",
    "spotify",
    "youtube",
    "gaming",
    "game",
    "movie",
    "cinema",
    "pvr",
    "inox",
    "concert",
    "event",
    "ticket",
    "show",
    "play",
    "netflix",
    "hbo",
    "apple tv",
    "jio",
    "sonyliv",
    "zee",
    "music",
    "stream",
  ],
  // Health
  Health: [
    "pharmacy",
    "medicine",
    "doctor",
    "hospital",
    "clinic",
    "apollo",
    "medplus",
    "health",
    "gym",
    "fitness",
    "yoga",
    "physiotherapy",
    "dental",
    "optician",
    "lab",
    "test",
    "pathology",
    "prescription",
    "tablet",
    "capsule",
    "syrup",
    "ayurvedic",
    "wellness",
    "therapy",
    "insurance",
    "mediclaim",
    "condom",
    "condoms",
    "sanitary pad",
    "sanitary pads",
    "pad",
    "pads",
    "tampon",
    "pregnancy test",
    "mask",
    "masks",
    "first aid",
    "bandage",
    "painkiller",
    "medical",
    "wellwoman",
  ],
  // Education
  Education: [
    "udemy",
    "coursera",
    "school",
    "college",
    "university",
    "fees",
    "course",
    "book",
    "stationery",
    "tuition",
    "coaching",
    "class",
    "exam",
    "study",
    "subscription",
    "skill",
    "certificate",
    "degree",
    "notes",
    "pen",
    "pencil",
  ],
  // Utilities
  Utilities: [
    "electricity",
    "water",
    "gas",
    "broadband",
    "wifi",
    "internet",
    "mobile recharge",
    "recharge",
    "dth",
    "cable",
    "postpaid",
    "prepaid",
    "rent",
    "maintenance",
    "society",
    "bsnl",
    "airtel",
    "jio",
    "vi",
    "vodafone",
    "idea",
    "tata",
    "dish",
    "tatasky",
    "telephone",
    "bill",
    "utility",
    "municipal",
  ],
  // Salary / Income
  Salary: [
    "salary",
    "payroll",
    "wage",
    "stipend",
    "ctc",
    "increment",
    "hike",
    "bonus",
    "appraisal",
    "employer",
    "company",
    "office",
    "paycheck",
    "remuneration",
    "payslip",
    "salary credit",
    "monthly salary",
  ],
  // Freelance
  Freelance: [
    "freelance",
    "client",
    "project",
    "invoice",
    "contract",
    "consulting",
    "upwork",
    "fiverr",
    "toptal",
    "design",
    "development",
    "writing",
    "gig",
    "work from home",
    "payment received",
    "milestone",
    "retainer",
  ],
};

const _AI_CATEGORY_SEEDS = {
  Food: [
    "coffee",
    "tea",
    "snack",
    "meal",
    "restaurant",
    "breakfast",
    "lunch",
    "dinner",
    "grocery",
  ],
  Entertainment: [
    "music",
    "movie",
    "game",
    "concert",
    "show",
    "ott",
    "streaming",
  ],
  Shopping: [
    "shopping",
    "clothes",
    "shoes",
    "gift",
    "accessory",
    "cosmetic",
    "bag",
  ],
  Transport: [
    "uber",
    "ola",
    "taxi",
    "metro",
    "bus",
    "fuel",
    "petrol",
    "diesel",
  ],
  Health: [
    "medicine",
    "pharmacy",
    "doctor",
    "clinic",
    "hospital",
    "condom",
    "sanitary",
    "medical",
  ],
  Investment: ["sip", "mutual fund", "stock", "shares", "investment", "fd"],
  Salary: ["salary", "payroll", "payslip", "salary credit"],
  Freelance: ["client", "invoice", "project", "gig", "retainer"],
  Business: ["business", "vendor", "gst", "shop", "inventory"],
  Insurance: ["insurance", "premium", "policy", "mediclaim"],
  Furniture: [
    "bed",
    "mattress",
    "sofa",
    "couch",
    "chair",
    "table",
    "desk",
    "wardrobe",
    "cupboard",
    "shelf",
    "pillow",
    "blanket",
    "lamp",
    "furniture",
  ],
  Electronics: [
    "mobile",
    "phone",
    "laptop",
    "charger",
    "headphones",
    "earbuds",
    "tv",
    "monitor",
  ],
  Groceries: [
    "grocery",
    "vegetable",
    "fruit",
    "milk",
    "bread",
    "rice",
    "dal",
    "egg",
  ],
  Utilities: [
    "electricity",
    "water",
    "wifi",
    "internet",
    "recharge",
    "rent",
    "maintenance",
    "bill",
  ],
  Education: ["course", "fees", "book", "exam", "tuition", "class", "study"],
  Travel: ["flight", "hotel", "trip", "booking", "train", "bus", "travel"],
  Fitness: ["gym", "protein", "workout", "yoga", "fitness"],
  Beauty: ["salon", "spa", "makeup", "cosmetic", "skincare", "perfume"],
  Pets: ["dog", "cat", "pet", "vet", "pet food", "litter"],
  Kids: ["toy", "school", "diaper", "baby", "formula", "stroller"],
};

function _getAiCategories(type) {
  return type === "income"
    ? [...BASE_INCOME_CATS, ...customCategories, "Other"]
    : [...BASE_EXPENSE_CATS, ...customCategories, "Other"];
}

function _getAiCatState(type) {
  if (!_aiCatState[type]) {
    _aiCatState[type] = {
      suggestedCategory: "",
      suggestedDesc: "",
      acceptedCategory: "",
      acceptedDesc: "",
    };
  }
  return _aiCatState[type];
}

function _addAiScore(scores, strongest, cat, score) {
  if (!cat || !score) return;
  scores[cat] = (scores[cat] || 0) + score;
  strongest[cat] = Math.max(strongest[cat] || 0, score);
}

function _getCategorySeeds(cat) {
  if (!cat) return [];
  const exact = _AI_CATEGORY_SEEDS[cat];
  if (exact) return exact;
  const found = Object.entries(_AI_CATEGORY_SEEDS).find(
    ([name]) => name.toLowerCase() === cat.toLowerCase(),
  );
  return found ? found[1] : [];
}

function _tokenizeAiText(text) {
  return [
    ...new Set(
      (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
        (token) =>
          token.length >= 3 &&
          ![
            "the",
            "and",
            "for",
            "with",
            "from",
            "this",
            "that",
            "your",
          ].includes(token),
      ),
    ),
  ];
}

function _localKeywordGuess(type, desc) {
  const lower = desc.toLowerCase();
  const allowed = new Set(_getAiCategories(type));
  const descTokens = _tokenizeAiText(desc);
  const scores = {};
  const strongest = {};

  for (const [cat, keywords] of Object.entries(_AI_KEYWORD_MAP)) {
    if (!allowed.has(cat)) continue;
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        const phraseBonus = kw.includes(" ") ? 8 : 0;
        const score = kw.length + phraseBonus;
        _addAiScore(scores, strongest, cat, score);
      }
    }
  }

  for (const cat of allowed) {
    const catLower = cat.toLowerCase();
    if (lower.includes(catLower)) {
      _addAiScore(scores, strongest, cat, catLower.length + 6);
    }

    const catTokens = _tokenizeAiText(cat);
    const overlap = catTokens.filter((token) =>
      descTokens.includes(token),
    ).length;
    if (overlap) {
      _addAiScore(scores, strongest, cat, overlap * 5);
    }

    for (const seed of _getCategorySeeds(cat)) {
      if (lower.includes(seed)) {
        const seedScore = seed.length + (seed.includes(" ") ? 10 : 4);
        _addAiScore(scores, strongest, cat, seedScore);
      }
    }
  }

  for (const txn of (transactions || []).slice(0, 300)) {
    if (txn.type !== type || !allowed.has(txn.category)) continue;
    const txnDesc = (txn.description || "").trim();
    if (!txnDesc) continue;

    const txnLower = txnDesc.toLowerCase();
    const txnTokens = _tokenizeAiText(txnDesc);
    const overlap = txnTokens.filter((token) =>
      descTokens.includes(token),
    ).length;

    if (lower === txnLower) {
      _addAiScore(scores, strongest, txn.category, 40);
      continue;
    }
    if (lower.includes(txnLower) || txnLower.includes(lower)) {
      _addAiScore(scores, strongest, txn.category, 20);
    }
    if (overlap > 0) {
      _addAiScore(scores, strongest, txn.category, overlap * 7);
    }
  }

  if (!Object.keys(scores).length) return null;
  return Object.entries(scores).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return (strongest[b[0]] || 0) - (strongest[a[0]] || 0);
  })[0][0];
}

/* ──────────────────────────────────────────────
   FEATURE 1: AI AUTO-CATEGORIZATION
   1. Instant local guess shown immediately (no API wait)
   2. Claude API called after 700ms debounce for accuracy
   3. Generation counter ensures stale API responses
      never overwrite a newer result
   4. Badge persists — only hides on dismiss or modal close
────────────────────────────────────────────── */
function aiAutoCategory(type, value) {
  clearTimeout(_aiCatTimers[type]);
  const badgeEl = document.getElementById(`${type}AiBadge`);
  if (!badgeEl) return;

  const trimmed = value ? value.trim() : "";

  // Reset dismissed state when user changes text significantly
  if (!trimmed || trimmed.length < 3) {
    // Only hide if user hasn't already seen + kept a good suggestion
    const currentlyApplied = badgeEl.dataset.appliedMatch;
    if (!currentlyApplied) {
      badgeEl.style.display = "none";
      badgeEl.dataset.appliedMatch = "";
    }
    _aiCatDismissed[type] = false;
    return;
  }

  // If user dismissed the badge for this exact text, don't re-show
  if (_aiCatDismissed[type] && badgeEl.dataset.lastDesc === trimmed) return;
  _aiCatDismissed[type] = false;

  // ── Step 1: Instant local guess ──
  const localGuess = _localKeywordGuess(trimmed);
  if (localGuess) {
    _showAiBadge(type, localGuess, trimmed, false /* not final yet */);
  } else if (badgeEl.style.display === "none") {
    // Show "thinking" only if badge isn't already showing a good result
    badgeEl.style.display = "flex";
    badgeEl.innerHTML = `<i class="fas fa-spinner fa-spin" style="color:#a78bfa"></i><span style="color:#94a3b8">Thinking…</span>`;
  }

  // ── Step 2: Debounced Claude API call for accuracy ──
  _aiCatGeneration[type] = (_aiCatGeneration[type] || 0) + 1;
  const myGen = _aiCatGeneration[type];

  _aiCatTimers[type] = setTimeout(async () => {
    // If a newer call has been scheduled, bail out
    if (_aiCatGeneration[type] !== myGen) return;
    await _runAiCat(type, trimmed, myGen);
  }, 700);
}

async function _runAiCat(type, desc, generation) {
  const cats =
    type === "income"
      ? [...BASE_INCOME_CATS, ...customCategories, "Other"]
      : [...BASE_EXPENSE_CATS, ...customCategories, "Other"];
  const badgeEl = document.getElementById(`${type}AiBadge`);
  const selectEl = document.getElementById(`${type}Category`);
  if (!badgeEl || !selectEl) return;

  try {
    const system = `You are a financial transaction categorizer for an Indian personal finance app.
Given a transaction description, return ONLY the single best matching category name from the list.
Do not explain. Do not add punctuation. Return only the category name exactly as given.
Categories: ${cats.join(", ")}`;
    const result = await _callAI([{ role: "user", content: desc }], system, 20);

    // Stale response guard — generation must still match
    if (_aiCatGeneration[type] !== generation) return;

    const suggested = result.trim();
    const match =
      cats.find((c) => c.toLowerCase() === suggested.toLowerCase()) ||
      cats.find((c) => suggested.toLowerCase().includes(c.toLowerCase()));

    if (!match) {
      // API gave no match — keep local guess if we had one, else hide
      const localGuess = _localKeywordGuess(desc);
      if (!localGuess) badgeEl.style.display = "none";
      return;
    }

    _showAiBadge(type, match, desc, true /* final */);
  } catch (e) {
    // Network/API failure — keep local guess if shown, else silently hide
    if (_aiCatGeneration[type] !== generation) return;
    const localGuess = _localKeywordGuess(desc);
    if (!localGuess) badgeEl.style.display = "none";
    console.warn("AI categorization failed", e);
  }
}

function _showAiBadge(type, match, desc, isFinal) {
  const badgeEl = document.getElementById(`${type}AiBadge`);
  const selectEl = document.getElementById(`${type}Category`);
  if (!badgeEl || !selectEl) return;

  // Don't overwrite a user-dismissed badge for the same description
  if (_aiCatDismissed[type] && badgeEl.dataset.lastDesc === desc) return;

  // Auto-apply only if no category is selected yet
  if (!selectEl.value || selectEl.value === "") {
    selectEl.value = match;
  }

  const isApplied = selectEl.value === match;
  badgeEl.dataset.appliedMatch = isApplied ? match : "";
  badgeEl.dataset.lastDesc = desc;

  const confidenceIcon = isFinal
    ? `<i class="fas fa-wand-magic-sparkles" style="color:#a78bfa;flex-shrink:0"></i>`
    : `<i class="fas fa-bolt" style="color:#f59e0b;flex-shrink:0" title="Quick guess — AI confirming…"></i>`;

  badgeEl.style.display = "flex";
  badgeEl.innerHTML = `
    ${confidenceIcon}
    <span>AI suggests: <strong style="color:#e2e8f0">${match}</strong>${isFinal ? "" : " <span style='color:#64748b;font-size:.72rem'>(confirming…)</span>"}</span>
    ${!isApplied ? `<button class="ai-cat-apply" onclick="aiApplyCategory('${type}','${match}')">Apply</button>` : `<span class="ai-cat-applied"><i class="fas fa-check"></i> Applied</span>`}
    <button class="ai-cat-dismiss" onclick="aiDismissBadge('${type}')" title="Dismiss"><i class="fas fa-times"></i></button>
  `;
}

function aiApplyCategory(type, category) {
  const selectEl = document.getElementById(`${type}Category`);
  const badgeEl = document.getElementById(`${type}AiBadge`);
  if (selectEl) selectEl.value = category;
  if (badgeEl) {
    badgeEl.dataset.appliedMatch = category;
    badgeEl.innerHTML = `
      <i class="fas fa-wand-magic-sparkles" style="color:#a78bfa;flex-shrink:0"></i>
      <span>AI suggests: <strong style="color:#e2e8f0">${category}</strong></span>
      <span class="ai-cat-applied"><i class="fas fa-check"></i> Applied</span>
      <button class="ai-cat-dismiss" onclick="aiDismissBadge('${type}')" title="Dismiss"><i class="fas fa-times"></i></button>
    `;
  }
}

function aiDismissBadge(type) {
  const badgeEl = document.getElementById(`${type}AiBadge`);
  if (badgeEl) {
    badgeEl.style.display = "none";
    badgeEl.dataset.appliedMatch = "";
    _aiCatDismissed[type] = true;
  }
}

/* Called by openModal / closeModal to reset badge state for fresh entries */
function resetAiCatBadge(type) {
  clearTimeout(_aiCatTimers[type]);
  _aiCatGeneration[type] = (_aiCatGeneration[type] || 0) + 1; // invalidate any in-flight calls
  _aiCatDismissed[type] = false;
  const badgeEl = document.getElementById(`${type}AiBadge`);
  if (badgeEl) {
    badgeEl.style.display = "none";
    badgeEl.dataset.appliedMatch = "";
    badgeEl.dataset.lastDesc = "";
  }
}

/* ──────────────────────────────────────────────
   FEATURE 2: ASK BLUELEDGER — NL Query
   Opens a slide-up panel. Passes transaction
   summary to Claude and answers in plain English.
────────────────────────────────────────────── */
function openAskBl() {
  document.getElementById("askBlPanel").classList.add("ask-bl-panel--open");
  document.getElementById("askBlOverlay").classList.add("ask-bl-overlay--open");
  setTimeout(() => document.getElementById("askBlInput")?.focus(), 300);
}
function closeAskBl() {
  document.getElementById("askBlPanel").classList.remove("ask-bl-panel--open");
  document
    .getElementById("askBlOverlay")
    .classList.remove("ask-bl-overlay--open");
}

function _buildFinanceSummary() {
  // Build a compact but rich summary of the user's data to pass to the AI
  const allTxns = transactions.slice(0, 300); // cap to avoid token overflow
  const now = new Date();
  const thisMonth = allTxns.filter((t) => {
    const d = new Date(t.date);
    return (
      d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    );
  });

  const fmt = (n) =>
    `₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  const totalIncome = allTxns
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + t.amount, 0);
  const totalExpense = allTxns
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + Math.abs(t.amount), 0);

  // Per-category breakdown
  const catMap = {};
  allTxns.forEach((t) => {
    if (t.type !== "expense") return;
    catMap[t.category] = (catMap[t.category] || 0) + Math.abs(t.amount);
  });
  const catLines = Object.entries(catMap)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `  ${c}: ${fmt(v)}`)
    .join("\n");

  // Last 30 transactions (compact)
  const recent = allTxns
    .slice(0, 30)
    .map(
      (t) =>
        `${t.date} | ${t.type} | ${t.category} | ${t.description || "-"} | ${t.type === "income" ? "+" : "-"}${fmt(t.amount)}`,
    )
    .join("\n");

  const monthIncome = thisMonth
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + t.amount, 0);
  const monthExpense = thisMonth
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + Math.abs(t.amount), 0);

  return `User financial data (BlueLedger app):
Currency: Indian Rupees (₹)
Total transactions available: ${allTxns.length}
Current month: ${now.toLocaleString("en-IN", { month: "long", year: "numeric" })}
This month income: ${fmt(monthIncome)} | This month expenses: ${fmt(monthExpense)}
All-time income: ${fmt(totalIncome)} | All-time expenses: ${fmt(totalExpense)}

Spending by category (all time):
${catLines || "  No expense data yet"}

Recent transactions (up to 30):
Date | Type | Category | Description | Amount
${recent || "  No transactions yet"}`;
}

async function askBlSend(prefill) {
  if (_askBlBusy) return;
  const inputEl = document.getElementById("askBlInput");
  const question = (prefill || inputEl?.value || "").trim();
  if (!question) return;
  if (inputEl) inputEl.value = "";

  // Append user message
  _appendAskBlMsg("user", question);
  _askBlHistory.push({ role: "user", content: question });

  // Typing indicator
  const typingId = "askbl-typing-" + Date.now();
  _appendAskBlMsg(
    "assistant",
    `<span id="${typingId}" class="ask-bl-typing"><span></span><span></span><span></span></span>`,
  );

  _askBlBusy = true;
  document.getElementById("askBlSendBtn").disabled = true;

  try {
    const system = `You are BlueLedger AI, a friendly and concise personal finance assistant built into the BlueLedger app.
The user's financial data is provided below. Answer their question directly using the data.
Be concise, warm, and use ₹ for amounts. Use emojis sparingly. 
If the data is insufficient to answer, say so honestly.
Never make up transactions. Format numbers in Indian style (lakhs/crores if large).

${_buildFinanceSummary()}`;

    const reply = await _callAI(_askBlHistory, system, 400);

    // Replace typing indicator
    const typingEl = document.getElementById(typingId)?.closest(".ask-bl-msg");
    if (typingEl) typingEl.remove();

    _askBlHistory.push({ role: "assistant", content: reply });
    // Keep history manageable (last 10 turns)
    if (_askBlHistory.length > 20) _askBlHistory = _askBlHistory.slice(-20);

    _appendAskBlMsg("assistant", _markdownToHtml(reply));
  } catch (e) {
    const typingEl = document.getElementById(typingId)?.closest(".ask-bl-msg");
    if (typingEl) typingEl.remove();
    _appendAskBlMsg(
      "assistant",
      "Sorry, I couldn't connect to the AI right now. Please try again.",
    );
    console.warn("Ask BlueLedger failed", e);
  } finally {
    _askBlBusy = false;
    const btn = document.getElementById("askBlSendBtn");
    if (btn) btn.disabled = false;
  }
}

function _appendAskBlMsg(role, html) {
  const container = document.getElementById("askBlMessages");
  if (!container) return;
  // Hide welcome screen on first message
  const welcome = container.querySelector(".ask-bl-welcome");
  if (welcome) welcome.style.display = "none";

  const div = document.createElement("div");
  div.className = `ask-bl-msg ask-bl-msg--${role}`;
  div.innerHTML =
    role === "assistant"
      ? `<div class="ask-bl-avatar"><i class="fas fa-robot"></i></div><div class="ask-bl-bubble">${html}</div>`
      : `<div class="ask-bl-bubble">${html}</div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function _markdownToHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

/* ──────────────────────────────────────────────
   FEATURE 3 & 4: AI SPENDING INSIGHTS + PREDICTIVE BUDGETING
   Button in the Insights card header triggers this.
   Sends full transaction history → Claude gives:
   - Personalised anomaly explanations
   - Spending tips
   - AI month-end prediction with seasonal reasoning
────────────────────────────────────────────── */
let _aiInsightsBusy = false;

async function runAiInsights() {
  if (_aiInsightsBusy) return;
  _aiInsightsBusy = true;

  const btn = document.getElementById("aiInsightsBtn");
  const panel = document.getElementById("aiInsightsPanel");
  if (!panel) return;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analysing…';
  }
  panel.style.display = "block";
  panel.innerHTML = `
    <div class="ai-insights-loading">
      <i class="fas fa-brain" style="color:#a78bfa;font-size:1.4rem"></i>
      <div>
        <div style="font-weight:700;color:#e2e8f0;font-size:.88rem">AI is analysing your spending…</div>
        <div style="color:#64748b;font-size:.78rem;margin-top:.2rem">Looking for patterns, anomalies &amp; opportunities</div>
      </div>
    </div>`;

  try {
    const now = new Date();
    const thisMonth = transactions.filter((t) => {
      const d = new Date(t.date + "T00:00:00");
      return (
        d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      );
    });
    const lastMonth = transactions.filter((t) => {
      const d = new Date(t.date + "T00:00:00");
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return (
        d.getFullYear() === lm.getFullYear() && d.getMonth() === lm.getMonth()
      );
    });

    // Build a detailed summary for the AI
    const fmtAmt = (n) =>
      `₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
    const catTotals = {};
    transactions
      .slice(0, 200)
      .filter((t) => t.type === "expense")
      .forEach((t) => {
        catTotals[t.category] =
          (catTotals[t.category] || 0) + Math.abs(t.amount);
      });
    const thisMonthCats = {};
    thisMonth
      .filter((t) => t.type === "expense")
      .forEach((t) => {
        thisMonthCats[t.category] =
          (thisMonthCats[t.category] || 0) + Math.abs(t.amount);
      });
    const lastMonthCats = {};
    lastMonth
      .filter((t) => t.type === "expense")
      .forEach((t) => {
        lastMonthCats[t.category] =
          (lastMonthCats[t.category] || 0) + Math.abs(t.amount);
      });

    const thisMonthIncome = thisMonth
      .filter((t) => t.type === "income")
      .reduce((s, t) => s + t.amount, 0);
    const thisMonthExpense = thisMonth
      .filter((t) => t.type === "expense")
      .reduce((s, t) => s + Math.abs(t.amount), 0);
    const lastMonthExpense = lastMonth
      .filter((t) => t.type === "expense")
      .reduce((s, t) => s + Math.abs(t.amount), 0);

    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
    ).getDate();
    const daysLeft = daysInMonth - dayOfMonth;
    const spendingLimit = userData?.spendingLimit || 0;

    const catCompare = Object.keys({ ...thisMonthCats, ...lastMonthCats })
      .map((cat) => {
        const cur = thisMonthCats[cat] || 0;
        const prev = lastMonthCats[cat] || 0;
        const diff = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
        return `  ${cat}: this month ${fmtAmt(cur)}${prev > 0 ? `, last month ${fmtAmt(prev)}${diff !== null ? ` (${diff > 0 ? "+" : ""}${diff}%)` : ""}` : ""}`;
      })
      .join("\n");

    const recentTxns = transactions
      .slice(0, 20)
      .map(
        (t) =>
          `  ${t.date} | ${t.type} | ${t.category} | ${t.description || "-"} | ${t.type === "income" ? "+" : "-"}${fmtAmt(t.amount)}`,
      )
      .join("\n");

    const dataContext = `Financial snapshot:
Current month: ${now.toLocaleString("en-IN", { month: "long", year: "numeric" })} (day ${dayOfMonth} of ${daysInMonth}, ${daysLeft} days left)
This month income: ${fmtAmt(thisMonthIncome)} | expenses: ${fmtAmt(thisMonthExpense)}
Last month expenses: ${fmtAmt(lastMonthExpense)}
${spendingLimit > 0 ? `Monthly spending limit: ${fmtAmt(spendingLimit)} (${Math.round((thisMonthExpense / spendingLimit) * 100)}% used)` : "No spending limit set"}
Total transactions: ${transactions.length}

Category comparison (this month vs last month):
${catCompare || "  Not enough data"}

Recent 20 transactions:
${recentTxns || "  None yet"}`;

    const system = `You are BlueLedger AI, an expert personal finance advisor for an Indian user.
Analyse the spending data and provide a concise, actionable, warm financial advice report.

Structure your response EXACTLY as valid JSON (no markdown fences) with this shape:
{
  "summary": "One sentence overall assessment",
  "prediction": {
    "amount": 12500,
    "reasoning": "Brief reason for the prediction"
  },
  "tips": [
    { "icon": "fa-fire", "color": "#ef4444", "title": "Short title", "body": "Specific actionable advice" },
    { "icon": "fa-piggy-bank", "color": "#10b981", "title": "Short title", "body": "Specific actionable advice" }
  ],
  "alerts": [
    { "title": "Anomaly title", "body": "Explanation of why this is unusual and what to do" }
  ]
}

Rules:
- prediction.amount is an integer in rupees representing your AI-estimated month-end total expense
- Generate 2-4 tips, each specific to this user's actual data (not generic advice)
- Generate 0-3 alerts only for genuinely unusual patterns
- Use ₹ for amounts, Indian number formatting (lakhs/crores if applicable)
- Be warm, specific, non-judgmental. Reference real categories and amounts from the data.
- Return ONLY the JSON object, nothing else.`;

    const raw = await _callAI(
      [{ role: "user", content: dataContext }],
      system,
      800,
    );

    let parsed;
    try {
      const clean = raw.replace(/```json|```/g, "").trim();
      parsed = JSON.parse(clean);
    } catch {
      throw new Error("Could not parse AI response");
    }

    // Render the AI advice panel
    const alertsHtml = (parsed.alerts || [])
      .map(
        (a) => `
      <div class="ai-alert-item">
        <i class="fas fa-exclamation-triangle" style="color:#f59e0b;flex-shrink:0;margin-top:.15rem"></i>
        <div><div class="ai-alert-title">${_safeText(a.title)}</div><div class="ai-alert-body">${_safeText(a.body)}</div></div>
      </div>`,
      )
      .join("");

    const tipsHtml = (parsed.tips || [])
      .map(
        (t) => `
      <div class="ai-tip-card">
        <div class="ai-tip-icon" style="background:${t.color}22;color:${t.color}"><i class="fas ${t.icon}"></i></div>
        <div><div class="ai-tip-title">${_safeText(t.title)}</div><div class="ai-tip-body">${_safeText(t.body)}</div></div>
      </div>`,
      )
      .join("");

    const predAmt = parsed.prediction?.amount;
    const predOver = spendingLimit > 0 && predAmt > spendingLimit;
    const predColor = predOver
      ? "#ef4444"
      : predAmt > thisMonthExpense * 1.2
        ? "#f59e0b"
        : "#10b981";
    const predHtml = predAmt
      ? `
      <div class="ai-prediction-row">
        <div class="ai-prediction-label"><i class="fas fa-chart-line" style="color:${predColor}"></i> AI Month-end Prediction</div>
        <div class="ai-prediction-amount" style="color:${predColor}">${fmtAmt(predAmt)}</div>
        <div class="ai-prediction-reason">${_safeText(parsed.prediction.reasoning)}</div>
      </div>`
      : "";

    panel.innerHTML = `
      <div class="ai-insights-result">
        <div class="ai-insights-summary">
          <i class="fas fa-robot" style="color:#a78bfa;flex-shrink:0"></i>
          <span>${_safeText(parsed.summary)}</span>
        </div>
        ${predHtml}
        ${alertsHtml ? `<div class="ai-alerts-section">${alertsHtml}</div>` : ""}
        <div class="ai-tips-grid">${tipsHtml}</div>
        <div class="ai-insights-footer">
          <button class="ai-refresh-btn" onclick="runAiInsights()"><i class="fas fa-rotate-right"></i> Refresh</button>
          <button class="ai-dismiss-btn" onclick="document.getElementById('aiInsightsPanel').style.display='none'"><i class="fas fa-times"></i> Dismiss</button>
        </div>
      </div>`;
  } catch (e) {
    panel.innerHTML = `<div class="ai-insights-error"><i class="fas fa-circle-exclamation" style="color:#ef4444"></i> Could not load AI insights. Check your connection and try again.</div>`;
    console.warn("AI insights failed", e);
  } finally {
    _aiInsightsBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> AI Advice';
    }
  }
}

function _safeText(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* ──────────────────────────────────────────────
   FEATURE 5: VOICE LOGGING
   Mic button in Income/Expense modal footers.
   Uses Web Speech API → transcribes → Claude
   parses amount, description, category → pre-fills form.
────────────────────────────────────────────── */
const VOICE_BACKEND_TIMEOUT_MS = 6500;
const VOICE_IDLE_MESSAGE =
  "Tap the mic and speak a transaction. We'll fill the draft for you.";
const VOICE_EXPENSE_ACTION_PATTERN =
  "spend|spent|pay|paid|use|used|buy|bought|order|ordered|book|booked|give|gave|purchase|purchased|charge|charged|expense";
const VOICE_INCOME_ACTION_PATTERN =
  "receive|received|earn|earned|get|got|make|made|credit|credited|income|salary|refund|bonus";
const VOICE_NUMBER_WORDS = {
  a: 1,
  an: 1,
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const VOICE_NUMBER_WORD_PATTERN = Object.keys(VOICE_NUMBER_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const VOICE_UI_COPY = {
  idle: {
    icon: "fa-microphone",
    title: "Log by voice",
    hint: 'Say "Spent 200 rupees on lunch"',
  },
  starting: {
    icon: "fa-spinner fa-spin",
    title: "Preparing mic",
    hint: "Allow microphone access if the browser asks.",
  },
  listening: {
    icon: "fa-wave-square",
    title: "Listening...",
    hint: "Tap again to stop listening.",
  },
  processing: {
    icon: "fa-spinner fa-spin",
    title: "Processing...",
    hint: "Turning speech into a draft.",
  },
  success: {
    icon: "fa-check",
    title: "Draft ready",
    hint: "Review the fields, then confirm the entry.",
  },
  error: {
    icon: "fa-rotate-right",
    title: "Try again",
    hint: "Tap to retry voice logging.",
  },
  unsupported: {
    icon: "fa-circle-info",
    title: "Voice unavailable",
    hint: "Use Chrome or Edge with microphone access.",
  },
};

let _voiceRecognition = null;
let _voiceBusy = false;
let _voiceSession = {
  id: 0,
  type: "",
  resultReceived: false,
};

function startVoiceLog(type) {
  const activeType = _voiceSession.type;

  if (_voiceBusy && activeType === type) {
    _cancelVoiceCapture(
      type,
      "Listening stopped. Tap again when you're ready.",
    );
    return;
  }

  if (_voiceBusy && activeType && activeType !== type) {
    _cancelVoiceCapture(activeType);
  }

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    _hideVoicePreview(type);
    _setVoiceUi(
      type,
      "unsupported",
      "Voice dictation needs Chrome or Edge with microphone access.",
    );
    return;
  }

  const recognition = new SpeechRecognition();
  const sessionId = Date.now() + Math.random();
  _voiceRecognition = recognition;
  _voiceBusy = true;
  _voiceSession = {
    id: sessionId,
    type,
    resultReceived: false,
  };

  _hideVoicePreview(type);
  _setVoiceUi(type, "starting", "Requesting microphone access...");

  recognition.lang = navigator.language || "en-IN";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 3;

  recognition.onstart = () => {
    if (_voiceSession.id !== sessionId) return;
    _setVoiceUi(
      type,
      "listening",
      'Listening... say "Spent 200 rupees on lunch".',
    );
  };

  recognition.onresult = async (event) => {
    if (_voiceSession.id !== sessionId) return;

    let interimTranscript = "";
    let finalTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const piece = event.results[i][0]?.transcript?.trim();
      if (!piece) continue;
      if (event.results[i].isFinal) finalTranscript += `${piece} `;
      else interimTranscript += `${piece} `;
    }

    finalTranscript = finalTranscript.trim();
    interimTranscript = interimTranscript.trim();

    if (finalTranscript) {
      _voiceSession.resultReceived = true;
      _voiceBusy = false;
      _renderVoicePreview(type, finalTranscript);
      _setVoiceUi(type, "processing", "Processing what you said...");
      try {
        recognition.stop();
      } catch {}
      _voiceRecognition = null;
      await _handleVoiceTranscript(type, finalTranscript);
      return;
    }

    if (interimTranscript) {
      _setVoiceUi(type, "listening", `Hearing: "${interimTranscript}"`);
    }
  };

  recognition.onerror = (event) => {
    if (_voiceSession.id !== sessionId) return;
    const errorCode = event?.error || "unknown";
    _voiceRecognition = null;
    _voiceBusy = false;
    _voiceSession = {
      id: 0,
      type: "",
      resultReceived: false,
    };
    _setVoiceUi(type, "error", _getVoiceErrorMessage(errorCode));
  };

  recognition.onend = () => {
    if (_voiceSession.id !== sessionId) return;
    _voiceRecognition = null;

    if (_voiceBusy && !_voiceSession.resultReceived) {
      _voiceBusy = false;
      _voiceSession = {
        id: 0,
        type: "",
        resultReceived: false,
      };
      _setVoiceUi(
        type,
        "error",
        "No speech detected. Try again and speak a little closer to the mic.",
      );
      return;
    }

    if (_voiceSession.resultReceived) {
      _voiceSession = {
        id: 0,
        type: "",
        resultReceived: false,
      };
    }
  };

  try {
    recognition.start();
  } catch (error) {
    _voiceRecognition = null;
    _voiceBusy = false;
    _voiceSession = {
      id: 0,
      type: "",
      resultReceived: false,
    };
    _setVoiceUi(
      type,
      "error",
      "The microphone couldn't start in this browser. Refresh and try again.",
    );
    console.warn("Voice recognition start failed", error);
  }
}

function _cancelVoiceCapture(type, message = VOICE_IDLE_MESSAGE) {
  try {
    _voiceRecognition?.stop();
  } catch {}
  _voiceRecognition = null;
  _voiceBusy = false;
  _voiceSession = {
    id: 0,
    type: "",
    resultReceived: false,
  };
  _setVoiceUi(type, "idle", message);
}

function resetVoiceUi(type) {
  if (_voiceBusy && _voiceSession.type === type) {
    _cancelVoiceCapture(type);
    return;
  }

  _hideVoicePreview(type);
  _setVoiceUi(type, "idle", VOICE_IDLE_MESSAGE);
}

function _getVoiceElements(type) {
  return {
    btn: document.getElementById(`${type}VoiceBtn`),
    icon: document.querySelector(`#${type}VoiceBtn .voice-btn-icon i`),
    title: document.querySelector(`#${type}VoiceBtn .voice-btn-title`),
    hint: document.querySelector(`#${type}VoiceBtn .voice-btn-hint`),
    status: document.getElementById(`${type}VoiceStatus`),
    preview: document.getElementById(`${type}VoicePreview`),
    transcript: document.getElementById(`${type}VoiceTranscript`),
    chips: document.getElementById(`${type}VoiceChips`),
  };
}

function _setVoiceUi(type, state, message) {
  const els = _getVoiceElements(type);
  if (!els.btn || !els.status) return;

  const copy = VOICE_UI_COPY[state] || VOICE_UI_COPY.idle;
  els.btn.dataset.state = state;
  els.status.dataset.state = state;
  els.btn.disabled = state === "starting" || state === "processing";

  if (els.icon) els.icon.className = `fas ${copy.icon}`;
  if (els.title) els.title.textContent = copy.title;
  if (els.hint) els.hint.textContent = copy.hint;
  els.status.textContent = message || VOICE_IDLE_MESSAGE;
}

function _hideVoicePreview(type) {
  const els = _getVoiceElements(type);
  if (!els.preview) return;
  els.preview.hidden = true;
  if (els.transcript) els.transcript.textContent = "";
  if (els.chips) els.chips.innerHTML = "";
}

function _renderVoicePreview(type, transcript, draft = null) {
  const els = _getVoiceElements(type);
  if (!els.preview || !els.transcript || !els.chips) return;

  els.preview.hidden = false;
  els.transcript.textContent = transcript;
  els.chips.innerHTML = "";

  if (!draft) return;
  if (draft.amount) {
    _appendVoiceChip(
      els.chips,
      `₹${Number(draft.amount).toLocaleString("en-IN")}`,
      "amount",
    );
  }
  if (draft.category) {
    _appendVoiceChip(els.chips, draft.category, "category");
  }
  if (draft.description) {
    _appendVoiceChip(els.chips, draft.description, "description");
  }
}

function _appendVoiceChip(container, label, variant = "default") {
  const chip = document.createElement("span");
  chip.className = `voice-preview-chip voice-preview-chip--${variant}`;
  chip.textContent = label;
  container.appendChild(chip);
}

function _getVoiceErrorMessage(errorCode) {
  const messages = {
    "audio-capture":
      "No microphone was found (audio-capture). Check device mic access and try again.",
    "not-allowed":
      "Microphone access was blocked (not-allowed). Allow mic permission and try again.",
    "service-not-allowed":
      "This browser blocked speech services (service-not-allowed). Try Chrome or Edge.",
    network:
      "Speech recognition lost its network connection (network). Check connectivity and try again.",
    "no-speech":
      "No speech was detected (no-speech). Speak a little louder or closer to the mic.",
    "language-not-supported":
      "This browser can't recognize the current language setting (language-not-supported).",
    aborted: "Listening stopped.",
  };

  return (
    messages[errorCode] ||
    `Voice capture failed (${errorCode}). Please try again.`
  );
}

function _escapeVoiceRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function _scaleVoiceAmount(numberText, multiplierText) {
  let amount = Number.parseFloat(String(numberText).replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const multiplier = String(multiplierText || "").toLowerCase();
  if (multiplier === "k" || multiplier === "thousand") amount *= 1000;
  if (multiplier === "lakh" || multiplier === "lac") amount *= 100000;
  return Math.round(amount * 100) / 100;
}

function _parseWordNumber(phrase) {
  const tokens = String(phrase)
    .toLowerCase()
    .replace(/-/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;

  let total = 0;
  let current = 0;
  let decimal = "";
  let afterPoint = false;
  let seenNumber = false;

  for (const token of tokens) {
    if (token === "and") continue;
    if (token === "point") {
      afterPoint = true;
      continue;
    }

    if (afterPoint) {
      if (!(token in VOICE_NUMBER_WORDS)) return null;
      const digit = VOICE_NUMBER_WORDS[token];
      if (digit < 0 || digit > 9) return null;
      decimal += String(digit);
      seenNumber = true;
      continue;
    }

    if (token === "hundred") {
      current = (current || 1) * 100;
      seenNumber = true;
      continue;
    }
    if (token === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
      seenNumber = true;
      continue;
    }
    if (token === "lakh" || token === "lac") {
      total += (current || 1) * 100000;
      current = 0;
      seenNumber = true;
      continue;
    }

    const value = VOICE_NUMBER_WORDS[token];
    if (value === undefined) return null;
    current += value;
    seenNumber = true;
  }

  if (!seenNumber) return null;
  const whole = total + current;
  if (!decimal) return whole || null;
  return Number.parseFloat(`${whole}.${decimal}`);
}

function _extractWordAmount(transcript) {
  const patterns = [
    new RegExp(
      `\\b((?:(?:${VOICE_NUMBER_WORD_PATTERN}|hundred|thousand|lakh|lac|point|and)\\s+){0,10}(?:${VOICE_NUMBER_WORD_PATTERN}|hundred|thousand|lakh|lac))\\s+(?:rupees?|rs|inr)\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:${VOICE_EXPENSE_ACTION_PATTERN}|${VOICE_INCOME_ACTION_PATTERN})(?:\\s+of)?\\s+((?:(?:${VOICE_NUMBER_WORD_PATTERN}|hundred|thousand|lakh|lac|point|and)\\s+){0,10}(?:${VOICE_NUMBER_WORD_PATTERN}|hundred|thousand|lakh|lac))\\b`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = transcript.match(pattern);
    if (!match) continue;
    const amount = _parseWordNumber(match[1]);
    if (amount) {
      return {
        amount,
        matchedText: match[0],
      };
    }
  }

  return {
    amount: null,
    matchedText: "",
  };
}

function _extractVoiceAmount(transcript) {
  const patterns = [
    /\b(?:rs\.?|inr|rupees?)\s*(\d+(?:,\d+)*(?:\.\d+)?)\s*(k|thousand|lakh|lac)?\b/i,
    /\b(\d+(?:,\d+)*(?:\.\d+)?)\s*(k|thousand|lakh|lac)\b/i,
    /\b(\d+(?:,\d+)*(?:\.\d+)?)\s*(?:rs\.?|inr|rupees?)\b/i,
    new RegExp(
      `\\b(?:${VOICE_EXPENSE_ACTION_PATTERN}|${VOICE_INCOME_ACTION_PATTERN})(?:\\s+of)?\\s+(\\d+(?:,\\d+)*(?:\\.\\d+)?)\\s*(k|thousand|lakh|lac)?\\b`,
      "i",
    ),
    /\b(\d+(?:,\d+)*(?:\.\d+)?)\s+(?:on|for|towards|at|from)\b/i,
  ];

  for (const pattern of patterns) {
    const match = transcript.match(pattern);
    if (!match) continue;
    const amount = _scaleVoiceAmount(match[1], match[2]);
    if (amount) {
      return {
        amount,
        matchedText: match[0],
      };
    }
  }

  return _extractWordAmount(transcript);
}

function _fallbackVoiceDescription(type, transcript, category) {
  if (category && category !== "Other") {
    if (type === "income") {
      if (category === "Salary") return "Salary";
      if (category === "Freelance") return "Freelance payment";
      return `${category} income`;
    }
    if (category === "Food") return "Food expense";
    if (category === "Transport") return "Transport expense";
    return `${category} expense`;
  }

  const trimmed = String(transcript || "").trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : "";
}

function _cleanVoiceDescription(type, transcript, matchedText) {
  let cleaned = String(transcript || "");

  if (matchedText) {
    cleaned = cleaned.replace(
      new RegExp(_escapeVoiceRegExp(matchedText), "i"),
      " ",
    );
  }

  const actionPattern =
    type === "income"
      ? new RegExp(
          `\\b(?:please\\s+)?(?:add|log|record|note)?\\s*(?:i\\s+)?(?:just\\s+)?(?:${VOICE_INCOME_ACTION_PATTERN})(?:\\s+from|\\s+payment|\\s+of)?\\b`,
          "gi",
        )
      : new RegExp(
          `\\b(?:please\\s+)?(?:add|log|record|note)?\\s*(?:i\\s+)?(?:just\\s+)?(?:${VOICE_EXPENSE_ACTION_PATTERN})(?:\\s+for)?\\b`,
          "gi",
        );

  cleaned = cleaned
    .replace(actionPattern, " ")
    .replace(/\b(?:rs\.?|inr|rupees?)\b/gi, " ")
    .replace(/\b(?:today|right now|just now|please|transaction|entry)\b/gi, " ")
    .replace(/^[\s,.-]*(?:on|for|from|towards|to|at|via|of)\b/gi, " ")
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function _parseVoiceLocally(type, transcript) {
  const allowedCategories = _getAiCategories(type);
  const amountResult = _extractVoiceAmount(transcript);
  const directCategory =
    _localKeywordGuess(type, transcript) || _localKeywordGuess(type, "");
  let description = _cleanVoiceDescription(
    type,
    transcript,
    amountResult.matchedText,
  );
  let category =
    _localKeywordGuess(type, description) || directCategory || "Other";

  const matchedCategory = allowedCategories.find(
    (item) => item.toLowerCase() === String(category).toLowerCase(),
  );
  category =
    matchedCategory || (allowedCategories.includes("Other") ? "Other" : "");

  if (!description) {
    description = _fallbackVoiceDescription(type, transcript, category);
  }

  let confidence = 0;
  if (amountResult.amount) confidence += 0.5;
  if (description && description.toLowerCase() !== transcript.toLowerCase()) {
    confidence += 0.2;
  }
  if (category && category !== "Other") confidence += 0.2;
  if (
    amountResult.matchedText &&
    /rs|inr|rupees?|k|thousand|lakh|lac/i.test(amountResult.matchedText)
  ) {
    confidence += 0.1;
  }

  return {
    amount: amountResult.amount,
    description,
    category,
    date: todayStr(),
    confidence: Math.min(confidence, 1),
    source: "local",
  };
}

function _needsVoiceBackendFallback(draft) {
  return (
    !draft.amount ||
    !draft.description ||
    !draft.category ||
    draft.category === "Other" ||
    draft.confidence < 0.75
  );
}

function _getVoiceAiEndpoint() {
  return String(
    window.BLUELEDGER_VOICE_AI_ENDPOINT ||
      document.body?.dataset.voiceAiEndpoint ||
      localStorage.getItem("bl_voice_ai_endpoint") ||
      "",
  ).trim();
}

function _sanitizeVoiceDraft(type, payload) {
  const source = payload?.draft || payload;
  if (!source || typeof source !== "object") return null;

  const allowedCategories = _getAiCategories(type);
  const amount = _scaleVoiceAmount(source.amount, "");
  let description = String(source.description || "").trim();
  let category = String(source.category || "").trim();

  if (!description) description = "";
  const matchedCategory = allowedCategories.find(
    (item) => item.toLowerCase() === category.toLowerCase(),
  );
  category = matchedCategory || "";

  return {
    amount,
    description,
    category,
    date: todayStr(),
    confidence: 1,
    source: "backend",
  };
}

async function _parseVoiceWithBackend(type, transcript, localDraft) {
  const endpoint = _getVoiceAiEndpoint();
  if (!endpoint) return null;

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), VOICE_BACKEND_TIMEOUT_MS)
    : null;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transcript,
        type,
        categories: _getAiCategories(type),
        localDraft,
      }),
      signal: controller?.signal,
    });

    if (!response.ok) {
      throw new Error(`Voice AI endpoint error ${response.status}`);
    }

    const payload = await response.json();
    return _sanitizeVoiceDraft(type, payload);
  } catch (error) {
    console.warn("Voice AI fallback skipped", error);
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function _applyVoiceDraft(type, draft) {
  const amtEl = document.getElementById(`${type}Amount`);
  const descEl = document.getElementById(`${type}Desc`);
  const catEl = document.getElementById(`${type}Category`);
  const dateEl = document.getElementById(`${type}Date`);

  if (amtEl && draft.amount) {
    amtEl.value = draft.amount;
  }
  if (descEl && draft.description) {
    descEl.value = draft.description;
  }
  if (dateEl && !dateEl.value) {
    dateEl.value = draft.date || todayStr();
  }
  if (catEl && draft.category) {
    catEl.value = draft.category;
  }

  if (
    descEl &&
    draft.description &&
    (!draft.category || draft.category === "Other")
  ) {
    aiAutoCategory(type, draft.description);
  }
}

async function _handleVoiceTranscript(type, transcript) {
  const localDraft = _parseVoiceLocally(type, transcript);
  let finalDraft = localDraft;

  if (_needsVoiceBackendFallback(localDraft)) {
    const backendDraft = await _parseVoiceWithBackend(
      type,
      transcript,
      localDraft,
    );
    if (backendDraft) {
      finalDraft = {
        ...localDraft,
        ...backendDraft,
        amount: backendDraft.amount || localDraft.amount,
        description: backendDraft.description || localDraft.description,
        category: backendDraft.category || localDraft.category,
      };
    }
  }

  _renderVoicePreview(type, transcript, finalDraft);
  _applyVoiceDraft(type, {
    ...finalDraft,
    amount: finalDraft.amount || null,
  });

  if (!finalDraft.amount) {
    _setVoiceUi(
      type,
      "error",
      "I heard the transcript, but couldn't detect the amount. Try again or type the amount manually.",
    );
    return;
  }

  if (!finalDraft.category) {
    finalDraft.category = "Other";
  }
  if (!finalDraft.description) {
    finalDraft.description = _fallbackVoiceDescription(
      type,
      transcript,
      finalDraft.category,
    );
  }

  _applyVoiceDraft(type, finalDraft);
  _renderVoicePreview(type, transcript, finalDraft);
  _setVoiceUi(
    type,
    "success",
    `Draft ready${finalDraft.source === "backend" ? " with AI assist" : ""}. Review the fields, then confirm the entry.`,
  );
}

/* ──────────────────────────────────────────────
   FEATURE 6: RECEIPT SCANNING
   Camera/upload icon shown in income & expense modals.
   User uploads a receipt photo → base64 → Claude vision
   → extracts amount, date, description, category → pre-fills form.
────────────────────────────────────────────── */
function openReceiptScanner(type) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.capture = "environment"; // prefer rear camera on mobile
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (file) _processReceiptImage(type, file);
  };
  input.click();
}

async function _processReceiptImage(type, file) {
  const btn = document.getElementById(`${type}ReceiptBtn`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  }
  notify("Scanning receipt…", "info");

  try {
    // Convert to base64
    const base64 = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => res(reader.result.split(",")[1]);
      reader.onerror = () => rej(new Error("File read failed"));
      reader.readAsDataURL(file);
    });

    const mediaType = file.type || "image/jpeg";
    const cats =
      type === "income"
        ? [...BASE_INCOME_CATS, ...customCategories, "Other"]
        : [...BASE_EXPENSE_CATS, ...customCategories, "Other"];

    const system = `You are a receipt scanner for an Indian personal finance app.
Extract transaction data from this receipt image and return ONLY valid JSON:
{
  "amount": 450,
  "description": "Coffee and snacks",
  "category": "Food",
  "date": "2025-04-03",
  "notes": "Any relevant extra detail"
}
Rules:
- amount is total paid in rupees as a number (no symbol). If unclear, use null.
- description: concise merchant + item summary.
- category must be exactly one from: ${cats.join(", ")}
- date: ISO format YYYY-MM-DD if visible, otherwise null.
- notes: any useful extra detail (items, GST, etc.) or empty string.
- Return ONLY the JSON, no explanation or markdown.`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 300,
        system,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              {
                type: "text",
                text: "Extract the transaction details from this receipt.",
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) throw new Error(`API error ${response.status}`);
    const data = await response.json();
    const raw = data.content?.map((b) => b.text || "").join("") || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    // Pre-fill form
    if (parsed.amount) {
      const amtEl = document.getElementById(`${type}Amount`);
      if (amtEl) amtEl.value = parsed.amount;
    }
    if (parsed.description) {
      const descEl = document.getElementById(`${type}Desc`);
      if (descEl) {
        descEl.value = parsed.description;
        aiAutoCategory(type, parsed.description);
      }
    }
    if (parsed.category) {
      const catEl = document.getElementById(`${type}Category`);
      if (catEl) {
        const match = cats.find(
          (c) => c.toLowerCase() === parsed.category.toLowerCase(),
        );
        if (match) catEl.value = match;
      }
    }
    if (parsed.date) {
      const dateEl = document.getElementById(`${type}Date`);
      if (dateEl && parsed.date) dateEl.value = parsed.date;
    }
    if (parsed.notes) {
      const notesEl = document.getElementById(`${type}Notes`);
      if (notesEl) notesEl.value = parsed.notes;
    }
    notify("Receipt scanned — please review and confirm ✓", "success");
  } catch (e) {
    notify("Receipt scan failed. Please fill in manually.", "error");
    console.warn("Receipt scan failed", e);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-camera"></i>';
    }
  }
}

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

function updateAddAccountUI() {
  const currentName = getCardDisplayName(cards[activeCardIdx], activeCardIdx);
  const currentLabel = document.getElementById("bnCurrentAccountLabel");
  if (currentLabel) currentLabel.textContent = currentName;
  const incomeName = document.getElementById("incomeAccountName");
  if (incomeName) incomeName.textContent = currentName;
  const expenseName = document.getElementById("expenseAccountName");
  if (expenseName) expenseName.textContent = currentName;
}

function cleanSyncConfig(raw) {
  return {
    ...defaultSyncConfig(),
    ...(raw || {}),
  };
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

function getVaultPayload() {
  syncActiveToCards();
  return {
    cards,
    activeCardIdx,
  };
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

function getPendingSyncSetup() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_PENDING_KEY) || "null");
  } catch {
    return null;
  }
}

function setPendingSyncSetup(cfg) {
  localStorage.setItem(SYNC_PENDING_KEY, JSON.stringify(cfg));
}

function clearPendingSyncSetup() {
  localStorage.removeItem(SYNC_PENDING_KEY);
}

/* currentSyncFormValues removed — hardcoded BL Supabase is used */

async function deriveSyncKeyHex(passphrase, userId) {
  const words = CryptoJS.PBKDF2(passphrase, userId, {
    keySize: 256 / 32,
    iterations: 120000,
  });
  return words.toString();
}

/* ── Google OAuth vault key: PBKDF2(deviceId, userId) ── */
async function deriveGoogleVaultKey(userId) {
  const deviceId = getDeviceId();
  // Store a stable per-user random salt so the key is consistent across reloads
  const saltKey = "bl_google_salt_" + userId;
  let salt = localStorage.getItem(saltKey);
  if (!salt) {
    const arr = crypto.getRandomValues(new Uint8Array(32));
    salt = Array.from(arr)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    localStorage.setItem(saltKey, salt);
  }
  const words = CryptoJS.PBKDF2(deviceId + userId, salt, {
    keySize: 256 / 32,
    iterations: 120000,
  });
  return words.toString();
}

async function doGoogleSignIn() {
  const btn = document.getElementById("googleSignInBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Redirecting…';
  }
  try {
    const client = getBLClient();
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.href.split("?")[0].split("#")[0],
        queryParams: { access_type: "offline", prompt: "select_account" },
      },
    });
    if (error) {
      notify(error.message || "Google sign-in failed", "error");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML =
          '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Continue with Google';
      }
    }
    // If no error, browser will redirect — nothing more to do here
  } catch (e) {
    notify(e.message || "Google sign-in failed", "error");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg> Continue with Google';
    }
  }
}

async function _unlockGoogleUser(session) {
  const userId = session.user.id;
  const displayName =
    session.user.user_metadata?.full_name ||
    session.user.user_metadata?.name ||
    session.user.email?.split("@")[0] ||
    "User";
  const email = session.user.email || "";

  const vaultKey = await deriveGoogleVaultKey(userId);
  sessionPin = vaultKey;
  localStorage.setItem(AUTH_MODE_KEY, "password");
  localStorage.setItem("bl_last_email", email);
  localStorage.setItem("bl_is_google_auth", "1");

  // Try local vault first
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const vault = tryDecrypt(raw, vaultKey);
    if (
      vault &&
      (vault.verify === VERIFY_TOKEN || vault.verify === VERIFY_TOKEN_V2)
    ) {
      cards = vault.cards || [];
      activeCardIdx = vault.activeCardIdx || 0;
      syncConfig = cleanSyncConfig(vault.syncConfig);
      if (activeCardIdx >= cards.length) activeCardIdx = 0;
      if (cards.length > 0) loadActiveCard();
      hideAuthScreen();
      hideLockScreen();
      _afterUnlock(vaultKey, userId);
      return;
    }
  }

  // Try cloud vault
  const syncKeyHex = await deriveSyncKeyHex(vaultKey, userId);
  syncConfig = {
    ...defaultSyncConfig(),
    enabled: true,
    userId,
    syncKeyHex,
    deviceId: getDeviceId(),
    status: "ok",
  };
  try {
    const client = getBLClient();
    const { data: remote } = await client
      .from(SYNC_TABLE)
      .select("ciphertext,updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (remote?.ciphertext) {
      const remotePayload = tryDecrypt(remote.ciphertext, syncKeyHex);
      if (remotePayload) {
        applyVaultPayload(remotePayload);
        hideAuthScreen();
        hideLockScreen();
        _afterUnlock(vaultKey, userId);
        notify("Vault loaded from cloud sync", "success");
        return;
      }
    }
  } catch (e) {
    console.warn("Cloud fetch on Google login failed", e);
  }

  // New Google user — card setup
  _pendingCardSetup = { name: displayName, email, password: vaultKey, userId };
  hideAuthScreen();
  _openCardSetupModal();
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ENCRYPTED PERSISTENCE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function saveToStorage(options = {}) {
  if (!sessionPin) return;
  syncActiveToCards();
  try {
    if (!options.skipDirtyMark && syncConfig?.enabled) {
      syncConfig.lastLocalChangeAt = new Date().toISOString();
      syncConfig.status = "dirty";
    }
    const vault = {
      verify: VERIFY_TOKEN,
      schemaVersion: VAULT_SCHEMA_VERSION,
      cards,
      activeCardIdx,
      syncConfig,
    };
    localStorage.setItem(STORAGE_KEY, encrypt(vault, sessionPin));
  } catch (e) {
    console.warn("Save failed", e);
  }
  if (!options.skipCloudPush) scheduleSyncPush();
}

// Returns true if encrypted data exists (show lock screen), false if first launch
function hasStoredData() {
  return !!localStorage.getItem(STORAGE_KEY);
}

function updateSyncStatus(kind, badgeText, bodyText, metaText) {
  if (syncConfig) syncConfig.status = kind;
  const badge = document.getElementById("syncStatusBadge");
  const body = document.getElementById("syncStatusText");
  const meta = document.getElementById("syncStatusMeta");
  if (badge) {
    badge.textContent = badgeText;
    badge.className = "sync-status-badge";
    if (kind === "ok") badge.classList.add("sync-status-badge--ok");
    if (kind === "warn") badge.classList.add("sync-status-badge--warn");
  }
  if (body) body.textContent = bodyText;
  if (meta)
    meta.textContent =
      metaText ||
      (syncConfig?.lastSyncedAt
        ? `Last synced ${new Date(syncConfig.lastSyncedAt).toLocaleString("en-IN")}`
        : "Local-only vault");
  // Update settings menu sync row if open
  const dot = document.getElementById("settingsSyncDot");
  const label = document.getElementById("settingsSyncLabel");
  if (dot && label) {
    if (kind === "ok") {
      dot.style.background = "#10b981";
      label.style.color = "#10b981";
      const mins = syncConfig?.lastSyncedAt
        ? Math.round((Date.now() - new Date(syncConfig.lastSyncedAt)) / 60000)
        : 0;
      label.textContent = mins < 1 ? "Synced just now" : `Synced ${mins}m ago`;
    } else if (kind === "warn") {
      dot.style.background = "#f59e0b";
      label.style.color = "#f59e0b";
      label.textContent = "Sync needs attention";
    } else {
      dot.style.background = "#475569";
      label.style.color = "#64748b";
      label.textContent = "Sync not active";
    }
  }
}

function openSyncModal() {
  populateSyncModal();
  openModal("syncModal");
}

function populateSyncModal() {
  if (syncConfig?.enabled && syncConfig?.lastSyncedAt) {
    updateSyncStatus(
      "ok",
      "Connected",
      "Encrypted cloud sync is active.",
      `Last synced ${new Date(syncConfig.lastSyncedAt).toLocaleString("en-IN")}`,
    );
  } else if (syncConfig?.enabled) {
    updateSyncStatus("ok", "Connected", "Encrypted cloud sync is active.", "");
  } else {
    updateSyncStatus(
      "local",
      "Not connected",
      "Log in to activate cloud sync.",
      "Local-only vault",
    );
  }
}

function getBLClient() {
  if (!supabaseClient) {
    if (!window.supabase?.createClient)
      throw new Error("Supabase client library not loaded");
    supabaseClient = window.supabase.createClient(
      BL_SUPABASE_URL,
      BL_SUPABASE_ANON_KEY,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      },
    );
  }
  return supabaseClient;
}

function ensureSupabaseClient(url, anonKey) {
  // Always return the hardcoded BL client regardless of params
  return getBLClient();
}

async function getSyncUser(url, anonKey) {
  const client = ensureSupabaseClient(url, anonKey);
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  return data.user;
}

function stopCloudSync() {
  clearTimeout(syncPushTimer);
  clearInterval(syncPollTimer);
  syncPushTimer = null;
  syncPollTimer = null;
  if (syncChannel && supabaseClient) {
    supabaseClient.removeChannel(syncChannel);
  }
  syncChannel = null;
}

/* sendSyncMagicLink removed — auth now handled via email+password signup */

/* finishSyncLink removed — auth now handled via email+password */

/* disconnectSync removed — use doSignOut() instead */

function scheduleSyncPush() {
  if (!sessionPin || !syncConfig?.enabled || suppressSyncPush) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => {
    pushCloudVault("auto").catch((e) => {
      console.warn("Cloud push failed", e);
      updateSyncStatus(
        "warn",
        "Sync paused",
        "Automatic cloud sync hit an error.",
      );
    });
  }, 1200);
}

async function fetchRemoteVault() {
  const client = getBLClient();
  const { data, error } = await client
    .from(SYNC_TABLE)
    .select("ciphertext,updated_at,updated_by")
    .eq("user_id", syncConfig.userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function upsertRemoteVault(payload) {
  const client = getBLClient();
  const ciphertext = encrypt(payload, syncConfig.syncKeyHex);
  const { error } = await client.from(SYNC_TABLE).upsert(
    {
      user_id: syncConfig.userId,
      ciphertext,
      updated_by: syncConfig.deviceId || getDeviceId(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
  syncConfig.lastSyncedHash = hashVaultPayload(payload);
  syncConfig.lastSyncedAt = new Date().toISOString();
  syncConfig.lastRemoteUpdatedAt = syncConfig.lastSyncedAt;
  syncConfig.status = "ok";
  saveToStorage({ skipCloudPush: true, skipDirtyMark: true });
  updateSyncStatus("ok", "Connected", "Encrypted cloud sync is active.");
}

async function pullRemoteVault(reason = "manual") {
  if (!syncConfig?.enabled || syncBusy) return;
  syncBusy = true;
  try {
    const remote = await fetchRemoteVault();
    if (!remote?.ciphertext) {
      if (reason !== "event") {
        await upsertRemoteVault(getVaultPayload());
      }
      return;
    }
    const remotePayload = tryDecrypt(remote.ciphertext, syncConfig.syncKeyHex);
    if (!remotePayload) throw new Error("Cloud vault could not be decrypted");

    const localPayload = getVaultPayload();
    const remoteHash = hashVaultPayload(remotePayload);
    const localHash = hashVaultPayload(localPayload);

    if (remoteHash === localHash) {
      syncConfig.lastSyncedHash = remoteHash;
      syncConfig.lastSyncedAt = new Date().toISOString();
      syncConfig.lastRemoteUpdatedAt = remote.updated_at || "";
      saveToStorage({ skipCloudPush: true, skipDirtyMark: true });
      updateSyncStatus("ok", "Connected", "Encrypted cloud sync is active.");
      return;
    }

    if (
      syncConfig.lastSyncedHash &&
      localHash !== syncConfig.lastSyncedHash &&
      remoteHash !== syncConfig.lastSyncedHash
    ) {
      const remoteTime = new Date(remote.updated_at || 0).getTime();
      const localTime = new Date(syncConfig.lastLocalChangeAt || 0).getTime();
      if (localTime > remoteTime) {
        await upsertRemoteVault(localPayload);
        return;
      }
      localStorage.setItem(
        "bl_sync_conflict_backup",
        encrypt(
          {
            savedAt: new Date().toISOString(),
            payload: localPayload,
          },
          sessionPin,
        ),
      );
      notify("Cloud had newer changes. A local backup was saved.", "info");
    }

    applyVaultPayload(remotePayload);
    populateCategorySelects();
    updateMyCardWidget();
    updateAddAccountUI();
    refreshAll();
    syncConfig.lastSyncedHash = remoteHash;
    syncConfig.lastSyncedAt = new Date().toISOString();
    syncConfig.lastRemoteUpdatedAt = remote.updated_at || "";
    suppressSyncPush = true;
    saveToStorage({ skipCloudPush: true, skipDirtyMark: true });
    suppressSyncPush = false;
    updateSyncStatus(
      "ok",
      "Connected",
      "Loaded the latest encrypted cloud data.",
    );
  } finally {
    syncBusy = false;
  }
}

async function pushCloudVault(reason = "manual") {
  if (!syncConfig?.enabled || syncBusy) return;
  syncBusy = true;
  try {
    await upsertRemoteVault(getVaultPayload());
  } finally {
    syncBusy = false;
  }
}

async function syncNow() {
  try {
    await initSyncAfterUnlock({ forceSyncNow: true });
    notify("Sync complete", "success");
  } catch (e) {
    notify(e.message || "Sync failed", "error");
  }
}

function subscribeToCloudChanges() {
  if (!supabaseClient || !syncConfig?.enabled) return;
  if (syncChannel) supabaseClient.removeChannel(syncChannel);
  syncChannel = supabaseClient
    .channel(`vault-${syncConfig.userId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: SYNC_TABLE,
        filter: `user_id=eq.${syncConfig.userId}`,
      },
      (payload) => {
        if (payload.new?.updated_by === syncConfig.deviceId) return;
        pullRemoteVault("event").catch((e) =>
          console.warn("Realtime pull failed", e),
        );
      },
    )
    .subscribe();
}

async function initSyncAfterUnlock(options = {}) {
  if (!sessionPin) return;
  if (!syncConfig?.enabled) {
    populateSyncModal();
    return;
  }
  try {
    const client = getBLClient();
    const { data } = await client.auth.getSession();
    if (!data.session) {
      updateSyncStatus(
        "warn",
        "Session expired",
        "Please lock and log in again to reconnect sync.",
      );
      return;
    }
    // Ensure userId is set from live session
    if (!syncConfig.userId && data.session.user?.id) {
      syncConfig.userId = data.session.user.id;
    }
    subscribeToCloudChanges();
    clearInterval(syncPollTimer);
    syncPollTimer = setInterval(() => {
      pullRemoteVault("poll").catch((e) => console.warn("Sync poll failed", e));
    }, SYNC_POLL_MS);
    if (options.forceSyncNow) {
      await pullRemoteVault("manual");
    } else {
      updateSyncStatus("ok", "Connected", "Encrypted cloud sync is active.");
    }
    if (!syncFocusHandlerBound) {
      syncFocusHandlerBound = true;
      window.addEventListener(
        "focus",
        () => {
          if (sessionPin && syncConfig?.enabled)
            pullRemoteVault("focus").catch(() => {});
        },
        { passive: true },
      );
    }
  } catch (e) {
    console.warn("initSyncAfterUnlock error", e);
    updateSyncStatus("warn", "Sync error", "Cloud sync encountered an issue.");
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AUTH — SIGNUP / LOGIN / BIOMETRIC / MIGRATION
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

let _pendingCardSetup = null; // { name, email, password, userId }
let _migrationVault = null; // decrypted old PIN vault awaiting re-encryption

function showAuthScreen(tab = "login") {
  document.getElementById("authScreen").style.display = "flex";
  document.getElementById("onboardingModal").style.display = "none";
  document.getElementById("lockScreen").style.display = "none";

  // Show biometric button in login popup if available
  _checkBiometricAvailable().then((canBio) => {
    const bioBtn = document.getElementById("authBiometricBtn");
    const bioDivider = document.getElementById("authBiometricDivider");
    if (bioBtn && bioDivider) {
      bioBtn.style.display = canBio ? "flex" : "none";
      bioDivider.style.display = canBio ? "block" : "none";
      const hasWebAuthn = localStorage.getItem("bl_has_webauthn") === "1";
      const iconEl = document.getElementById("authBioIcon");
      const labelEl = document.getElementById("authBioLabel");
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const isMac =
        /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
      const isWindows = /Windows/.test(navigator.userAgent);
      if (isIOS || isMac) {
        if (iconEl) iconEl.className = "fas fa-face-smile";
        if (labelEl) labelEl.textContent = "Use Face ID";
      } else if (isWindows) {
        if (iconEl) iconEl.className = "fab fa-windows";
        if (labelEl) labelEl.textContent = "Use Windows Hello";
      } else {
        if (iconEl) iconEl.className = "fas fa-fingerprint";
        if (labelEl) labelEl.textContent = "Use Fingerprint / Biometric";
      }
    }
  });

  if (tab === "login") openAuthPopup("login");
}

function openAuthPopup(type) {
  const overlay = document.getElementById(
    type === "login" ? "loginPopupOverlay" : "signupPopupOverlay",
  );
  if (overlay) overlay.classList.add("open");
  // Clear errors
  const errId = type === "login" ? "loginError" : "signupError";
  const errEl = document.getElementById(errId);
  if (errEl) errEl.textContent = "";
}

function closeAuthPopup(type) {
  const overlay = document.getElementById(
    type === "login" ? "loginPopupOverlay" : "signupPopupOverlay",
  );
  if (overlay) overlay.classList.remove("open");
}

/* openBiometricSetup — called from Settings */
async function openBiometricSetup() {
  const canBio = await _checkBiometricAvailable();
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isMac =
    /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  const hasWebAuthn = localStorage.getItem("bl_has_webauthn") === "1";

  const titleEl = document.getElementById("bioModalTitle");
  const descEl = document.getElementById("bioModalDesc");
  const iconEl = document.getElementById("bioModalIcon");
  const btnEl = document.getElementById("bioModalEnableBtn");

  // Treat as not-set-up if vault or credId is missing (partial registration failure)
  const hasValidWebAuthn =
    hasWebAuthn &&
    !!localStorage.getItem(WEBAUTHN_CRED_ID_KEY) &&
    !!localStorage.getItem(WEBAUTHN_PWD_VAULT_KEY);
  if (!hasValidWebAuthn && hasWebAuthn) {
    // Clean up stale partial state
    _clearWebAuthnState();
  }

  if (hasValidWebAuthn) {
    // Already set up — offer to remove
    if (titleEl)
      titleEl.innerHTML =
        '<i class="fas fa-fingerprint" style="color:#10b981;margin-right:.5rem"></i>Biometric Login Active';
    if (descEl)
      descEl.innerHTML =
        'Face ID / fingerprint login is <strong style="color:#10b981">enabled</strong>.<br>You can disable it below.';
    if (iconEl)
      iconEl.innerHTML =
        '<i class="fas fa-check-circle" style="color:#10b981"></i>';
    if (btnEl) {
      btnEl.textContent = "Disable Biometrics";
      btnEl.onclick = () => {
        _clearWebAuthnState();
        document.getElementById("biometricSetupModal").style.display = "none";
        notify("Biometric login disabled", "info");
        _refreshBiometricSettingsRow();
      };
    }
  } else {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isMac =
      /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
    const isWindows = /Windows/.test(navigator.userAgent);
    const isAndroid = /Android/.test(navigator.userAgent);

    let bioTitle, bioDesc, bioIconClass, bioBtnText;
    if (isIOS || isMac) {
      bioTitle = "Enable Face ID";
      bioDesc =
        'Use <strong style="color:#e2e8f0">Face ID</strong> to unlock BlueLedger instantly.<br>Your password is still required on new devices.';
      bioIconClass = "fas fa-face-smile";
      bioBtnText = '<i class="fas fa-face-smile"></i> Enable';
    } else if (isWindows) {
      bioTitle = "Enable Windows Hello";
      bioDesc =
        'Use <strong style="color:#e2e8f0">Windows Hello</strong> (PIN, fingerprint, or face) to unlock BlueLedger instantly.';
      bioIconClass = "fab fa-windows";
      bioBtnText = '<i class="fab fa-windows"></i> Enable';
    } else if (isAndroid) {
      bioTitle = "Enable Fingerprint Login";
      bioDesc =
        'Use your <strong style="color:#e2e8f0">fingerprint</strong> to unlock BlueLedger instantly.';
      bioIconClass = "fas fa-fingerprint";
      bioBtnText = '<i class="fas fa-fingerprint"></i> Enable';
    } else {
      bioTitle = "Enable Biometric Login";
      bioDesc =
        'Use your device\'s <strong style="color:#e2e8f0">biometric sensor</strong> to unlock BlueLedger instantly.';
      bioIconClass = "fas fa-fingerprint";
      bioBtnText = '<i class="fas fa-fingerprint"></i> Enable';
    }

    if (titleEl)
      titleEl.innerHTML = `<i class="${bioIconClass}" style="color:#3b82f6;margin-right:.5rem"></i>${bioTitle}`;
    if (descEl) descEl.innerHTML = bioDesc;
    if (iconEl)
      iconEl.innerHTML = `<i class="${bioIconClass}" style="color:#3b82f6;font-size:3rem"></i>`;
    if (btnEl) {
      btnEl.innerHTML = bioBtnText;
      btnEl.onclick = registerBiometricNow;
    }
  }
  document.getElementById("biometricSetupModal").style.display = "flex";
}

/* ── Detect platform biometric label ── */
function _getBiometricLabel(hasWebAuthn) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isMac =
    /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  const isWindows = /Windows/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);

  if (isIOS || isMac) {
    return hasWebAuthn ? "Face ID" : "Enable Face ID";
  } else if (isAndroid) {
    return hasWebAuthn ? "Fingerprint" : "Enable Fingerprint";
  } else if (isWindows) {
    return hasWebAuthn ? "Windows Hello" : "Enable Windows Hello";
  } else {
    return hasWebAuthn ? "Biometric Login" : "Enable Biometrics";
  }
}

function _getBiometricIcon(hasWebAuthn) {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isMac =
    /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
  const isWindows = /Windows/.test(navigator.userAgent);
  if (isIOS || isMac) return hasWebAuthn ? "fa-face-smile" : "fa-face-smile";
  if (isWindows) return "fa-windows";
  return "fa-fingerprint";
}

function _refreshBiometricSettingsRow() {
  const hasWebAuthn = localStorage.getItem("bl_has_webauthn") === "1";
  const label = _getBiometricLabel(hasWebAuthn);

  ["bnBiometricRow", "settingsBiometricRow"].forEach((id) => {
    const row = document.getElementById(id);
    if (row) row.style.display = "flex";
  });
  ["bnBiometricLabel", "settingsBiometricLabel"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  });
}

function _canUsePasswordCredentialFlow() {
  return (
    /Android/i.test(navigator.userAgent) &&
    "credentials" in navigator &&
    !!window.PasswordCredential
  );
}

function _clearUnsupportedPasswordCredentialState() {
  if (!_canUsePasswordCredentialFlow()) {
    localStorage.removeItem("bl_has_stored_creds");
  }
}

// Show/hide biometric row in settings on load
_checkBiometricAvailable().then((canBio) => {
  if (canBio || window.PublicKeyCredential) _refreshBiometricSettingsRow();
});

function switchAuthTab(tab) {
  // Legacy compat — now just opens popups
  if (tab === "login") openAuthPopup("login");
  else openAuthPopup("signup");
}

async function _checkBiometricAvailable() {
  // Android Chrome — PasswordCredential stored
  if (
    localStorage.getItem("bl_has_stored_creds") === "1" &&
    _canUsePasswordCredentialFlow()
  )
    return true;
  // iOS Safari / any platform — WebAuthn: both cred_id AND pwd_vault must exist
  // Guard against partial registration leaving stale bl_has_webauthn flag
  if (localStorage.getItem("bl_has_webauthn") === "1") {
    const credOk = !!localStorage.getItem(WEBAUTHN_CRED_ID_KEY);
    const vaultOk = !!localStorage.getItem(WEBAUTHN_PWD_VAULT_KEY);
    if (credOk && vaultOk && window.PublicKeyCredential) return true;
    // Partial/stale registration — clear it so the button is not shown
    _clearWebAuthnState();
  }
  // Check if the device has a platform authenticator available (for showing the Settings setup row)
  if (window.PublicKeyCredential) {
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }
  return false;
}

/* ── WebAuthn helpers (iOS Face ID / Touch ID, Windows Hello) ── */

function _getCurrentWebAuthnRpId() {
  return location.hostname || "";
}

function _getStoredWebAuthnRpId() {
  return localStorage.getItem(WEBAUTHN_RP_ID_KEY) || "";
}

function _clearWebAuthnState() {
  localStorage.removeItem("bl_has_webauthn");
  localStorage.removeItem(WEBAUTHN_CRED_ID_KEY);
  localStorage.removeItem(WEBAUTHN_PWD_VAULT_KEY);
  localStorage.removeItem(WEBAUTHN_RP_ID_KEY);
}

async function _webAuthnRegister(email) {
  if (!window.PublicKeyCredential) throw new Error("WebAuthn not supported");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const rpId = _getCurrentWebAuthnRpId();
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: rpId ? { name: "BlueLedger", id: rpId } : { name: "BlueLedger" },
      user: {
        id: userId,
        name: email || "blueledger-user",
        displayName: "BlueLedger",
      },
      pubKeyCredParams: [
        { alg: -7, type: "public-key" }, // ES256
        { alg: -257, type: "public-key" }, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "preferred",
      },
      timeout: 60000,
      attestation: "none",
    },
  });
  // Store credential ID for later assertion
  const rawId = new Uint8Array(credential.rawId);
  const credIdB64 = btoa(String.fromCharCode(...rawId));
  localStorage.setItem(WEBAUTHN_CRED_ID_KEY, credIdB64);
  if (rpId) localStorage.setItem(WEBAUTHN_RP_ID_KEY, rpId);
  else localStorage.removeItem(WEBAUTHN_RP_ID_KEY);
  return credIdB64;
}

async function _webAuthnAuthenticate() {
  if (!window.PublicKeyCredential) throw new Error("WebAuthn not supported");
  const credIdB64 = localStorage.getItem(WEBAUTHN_CRED_ID_KEY);
  if (!credIdB64) throw new Error("No WebAuthn credential registered");
  const storedRpId = _getStoredWebAuthnRpId();
  const currentRpId = _getCurrentWebAuthnRpId();
  if (storedRpId && currentRpId && storedRpId !== currentRpId) {
    throw new Error(
      "Windows Hello was set up on a different app address. Disable it and enable it again here.",
    );
  }
  const credId = Uint8Array.from(atob(credIdB64), (c) => c.charCodeAt(0));
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const getOptions = {
    publicKey: {
      challenge,
      allowCredentials: [{ id: credId, type: "public-key" }],
      userVerification: "required",
      timeout: 60000,
    },
  };
  // rpId must match registration exactly — omit when hostname is empty (file://)
  const rpId = storedRpId || currentRpId;
  if (rpId) getOptions.publicKey.rpId = rpId;
  const assertion = await navigator.credentials.get(getOptions);
  if (!assertion) throw new Error("Authentication failed");
  // Return the stored password (WebAuthn just gates access to it)
  const vaultRaw = localStorage.getItem(WEBAUTHN_PWD_VAULT_KEY);
  if (!vaultRaw) throw new Error("No password vault found");
  // Simple XOR obfuscation keyed on credId (not real crypto — the biometric IS the auth gate)
  const key = credIdB64.slice(0, 64).padEnd(64, "x");
  const decoded = atob(vaultRaw);
  const pwd = decoded
    .split("")
    .map((c, i) =>
      String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length)),
    )
    .join("");
  return pwd;
}

function _webAuthnStorePassword(password) {
  const credIdB64 = localStorage.getItem(WEBAUTHN_CRED_ID_KEY);
  if (!credIdB64) {
    _clearWebAuthnState();
    throw new Error("No WebAuthn credential available");
  }
  const key = credIdB64.slice(0, 64).padEnd(64, "x");
  const obfuscated = btoa(
    password
      .split("")
      .map((c, i) =>
        String.fromCharCode(c.charCodeAt(0) ^ key.charCodeAt(i % key.length)),
      )
      .join(""),
  );
  localStorage.setItem(WEBAUTHN_PWD_VAULT_KEY, obfuscated);
  localStorage.setItem("bl_has_webauthn", "1");
}

function hideAuthScreen() {
  document.getElementById("authScreen").style.display = "none";
  // Close any open popups
  ["loginPopupOverlay", "signupPopupOverlay"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("open");
  });
}

// Legacy switchAuthTab stub — kept for compatibility (real implementation above)

async function doSignUp() {
  const name = document.getElementById("signupName").value.trim();
  const email = document.getElementById("signupEmail").value.trim();
  const password = document.getElementById("signupPassword").value;
  const password2 = document.getElementById("signupPassword2").value;
  const errEl = document.getElementById("signupError");

  if (!name || !email || !password) {
    errEl.textContent = "All fields are required";
    return;
  }
  if (password.length < 8) {
    errEl.textContent = "Password must be at least 8 characters";
    return;
  }
  if (password !== password2) {
    errEl.textContent = "Passwords do not match";
    return;
  }

  const btn = document.getElementById("signupBtn");
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating account…';
  errEl.textContent = "";

  try {
    const client = getBLClient();
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        data: { name },
        emailRedirectTo: "https://expensetrackerai-six.vercel.app/",
      },
    });
    if (error) throw error;

    if (data.user && !data.session) {
      // FIX 4: Supabase silently returns a non-null user with an EMPTY
      // identities array when the email is already registered and email
      // confirmation is enabled. This is their documented "stealth dupe"
      // behaviour — detect it and show a clear error immediately.
      if (
        Array.isArray(data.user.identities) &&
        data.user.identities.length === 0
      ) {
        errEl.innerHTML = `Account already exists for <strong>${email}</strong>.
          <a href="#" onclick="
            document.getElementById('loginEmail').value='${email}';
            closeAuthPopup('signup');
            openAuthPopup('login');
            return false"
            style="color:#3b82f6;text-decoration:underline;margin-left:4px">
            Log in instead →</a>`;
        return;
      }

      // Store pending credentials so we can sign in after confirmation
      localStorage.setItem(
        "bl_pending_signup",
        JSON.stringify({ email, name }),
      );
      // Email confirmation required
      document.getElementById("authScreen").innerHTML = `
        <div class="auth-card">
          <div class="auth-logo"><img src="icon-192.png" alt="BlueLedger" /></div>
          <div class="auth-brand">Blue<span style="color:#3b82f6">Ledger</span></div>
          <div style="text-align:center;padding:2rem 1.5rem">
            <i class="fas fa-envelope-open-text" style="font-size:2.5rem;color:#3b82f6;margin-bottom:1rem;display:block"></i>
            <p style="font-size:1rem;font-weight:600;color:#e2e8f0;margin-bottom:.6rem">Check your email</p>
            <p style="color:#94a3b8;font-size:.88rem;line-height:1.6">
              We sent a confirmation link to <strong style="color:#e2e8f0">${email}</strong>.<br>
              Open it on <strong style="color:#e2e8f0">this device</strong>, then come back and log in.
            </p>
            <div style="margin-top:1.5rem;display:flex;flex-direction:column;gap:.75rem">
              <button class="btn btn-primary" style="justify-content:center" onclick="switchToLoginAfterConfirm('${email}')">
                <i class="fas fa-sign-in-alt"></i> Go to Login
              </button>
              <button class="btn btn-secondary" onclick="switchToLoginAfterConfirm('${email}')">
                I've confirmed — let me log in
              </button>
            </div>
          </div>
        </div>`;
      return;
    }

    if (data.session) {
      const userId = data.user.id;
      _pendingCardSetup = { name, email, password, userId };

      if (_migrationVault) {
        await _applyMigrationVault(password, userId);
      } else {
        hideAuthScreen();
        _openCardSetupModal();
      }
    }
  } catch (e) {
    const msg = e.message || "";
    if (
      msg.toLowerCase().includes("already registered") ||
      msg.toLowerCase().includes("already been registered") ||
      msg.toLowerCase().includes("user already exists")
    ) {
      errEl.innerHTML = `An account with this email already exists. 
        <a href="#" onclick="
          document.getElementById('loginEmail').value='${email}';
          switchAuthTab('login');
          return false"
          style="color:#3b82f6;text-decoration:underline">Log in instead</a>`;
    } else {
      errEl.textContent = msg || "Signup failed. Try again.";
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-user-plus"></i> Create Account';
  }
}

async function switchToLoginAfterConfirm(email) {
  // Rebuild the auth screen and switch to login tab with email pre-filled
  location.reload();
}

// Pre-fill handled inside initApp

async function doSignIn() {
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");

  if (!email || !password) {
    errEl.textContent = "Enter your email and password";
    return;
  }

  const btn = document.getElementById("loginBtn");
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in…';
  errEl.textContent = "";

  try {
    const client = getBLClient();
    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      // Check if email is not confirmed
      if (error.message?.toLowerCase().includes("email not confirmed")) {
        errEl.innerHTML = `Your email isn't confirmed yet. 
          <a href="#" onclick="resendConfirmationEmail('${email}');return false" 
             style="color:#3b82f6;text-decoration:underline">Resend confirmation email</a>`;
        return;
      }
      // Try to distinguish wrong email vs wrong password
      // Attempt password reset — if user doesn't exist, Supabase returns an error
      // We use this only for UX messaging, not security
      const { error: resetErr } = await client.auth.resetPasswordForEmail(
        email,
        {
          redirectTo: "https://expensetrackerai-six.vercel.app/",
        },
      );
      // Cancel: we don't actually want to send a reset email here
      // Use the error code to detect if user exists
      if (
        resetErr &&
        (resetErr.message?.includes("User not found") ||
          resetErr.status === 422)
      ) {
        errEl.textContent = "No account found with this email. Please sign up.";
        document.getElementById("signupEmail").value = email;
        setTimeout(() => switchAuthTab("signup"), 1500);
      } else {
        errEl.textContent = "Wrong password. Try again or use Forgot Password.";
      }
      return;
    }

    await _unlockWithPassword(
      password,
      data.user.id,
      data.user.user_metadata?.name || "",
    );

    // Store email for biometric re-auth (both PasswordCredential and WebAuthn paths)
    try {
      localStorage.setItem("bl_last_email", email);
    } catch {}
    try {
      if (_canUsePasswordCredentialFlow()) {
        const cred = new PasswordCredential({ id: email, password });
        await navigator.credentials.store(cred);
        localStorage.setItem("bl_has_stored_creds", "1");
      } else {
        localStorage.removeItem("bl_has_stored_creds");
      }
    } catch {}
  } catch (e) {
    errEl.textContent = e.message || "Sign in failed. Check your details.";
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Log In';
  }
}

async function forgotPassword() {
  const email = document.getElementById("loginEmail").value.trim();
  if (!email) {
    document.getElementById("loginError").textContent =
      "Enter your email address first";
    document.getElementById("loginEmail").focus();
    return;
  }
  const btn = document.getElementById("forgotPasswordBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Sending…";
  }
  try {
    const client = getBLClient();
    const { error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: "https://expensetrackerai-six.vercel.app/",
    });
    if (error) throw error;
    document.getElementById("loginError").style.color = "#10b981";
    document.getElementById("loginError").textContent =
      `Password reset link sent to ${email}`;
  } catch (e) {
    document.getElementById("loginError").style.color = "#ef4444";
    document.getElementById("loginError").textContent =
      e.message || "Could not send reset email";
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Forgot Password?";
    }
  }
}

async function resendConfirmationEmail(email) {
  try {
    const client = getBLClient();
    const { error } = await client.auth.resend({
      type: "signup",
      email: email || document.getElementById("loginEmail").value.trim(),
    });
    if (error) throw error;
    notify("Confirmation email resent — check your inbox", "success");
  } catch (e) {
    notify(e.message || "Could not resend email", "error");
  }
}

async function tryBiometricLogin() {
  const bioBtn = document.getElementById("authBiometricBtn");
  if (bioBtn) {
    bioBtn.disabled = true;
    bioBtn.style.opacity = "0.7";
  }
  try {
    // Android Chrome — PasswordCredential
    if (
      localStorage.getItem("bl_has_webauthn") !== "1" &&
      _canUsePasswordCredentialFlow() &&
      localStorage.getItem("bl_has_stored_creds") === "1"
    ) {
      const cred = await navigator.credentials.get({
        password: true,
        mediation: "required",
      });
      if (cred) {
        document.getElementById("loginEmail").value = cred.id;
        document.getElementById("loginPassword").value = cred.password;
        await doSignIn();
        return;
      }
    }
    // iOS / WebAuthn path (Face ID / Touch ID / Windows Hello)
    if (localStorage.getItem("bl_has_webauthn") === "1") {
      const password = await _webAuthnAuthenticate();
      // Google auth users: the WebAuthn vault holds the derived vault key, not
      // a real password. Re-use the live Supabase session to unlock instead of
      // calling signInWithPassword (which would always fail for Google accounts).
      const isGoogleAuth = localStorage.getItem("bl_is_google_auth") === "1";
      if (isGoogleAuth) {
        try {
          const client = getBLClient();
          const { data } = await client.auth.getSession();
          if (data?.session) {
            await _unlockGoogleUser(data.session);
            return;
          }
        } catch {}
      }
      const emailEl = document.getElementById("loginEmail");
      if (!emailEl.value) {
        emailEl.value = localStorage.getItem("bl_last_email") || "";
      }
      if (!emailEl.value || !emailEl.value.includes("@")) {
        throw new Error(
          "No account email is saved for Windows Hello. Log in once with your password, then enable it again.",
        );
      }
      document.getElementById("loginPassword").value = password;
      await doSignIn();
      return;
    }
    // Device supports biometrics but not registered yet — guide user to set up
    notify("Set up Face ID / Fingerprint in Settings first", "info");
  } catch (e) {
    if (e && e.name !== "NotAllowedError") {
      // NotAllowedError = user cancelled — silent. Other errors show message.
      notify("Biometric authentication failed. Use your password.", "error");
    }
    console.warn("Biometric login failed", e);
  } finally {
    if (bioBtn) {
      bioBtn.disabled = false;
      bioBtn.style.opacity = "1";
    }
  }
}

async function _unlockWithPassword(password, userId, displayName) {
  sessionPin = password;
  localStorage.setItem(AUTH_MODE_KEY, "password");

  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const vault = tryDecrypt(raw, password);
    if (
      vault &&
      (vault.verify === VERIFY_TOKEN || vault.verify === VERIFY_TOKEN_V2)
    ) {
      cards = vault.cards || [];
      activeCardIdx = vault.activeCardIdx || 0;
      syncConfig = cleanSyncConfig(vault.syncConfig);
      if (activeCardIdx >= cards.length) activeCardIdx = 0;
      if (cards.length > 0) loadActiveCard();
      hideAuthScreen();
      hideLockScreen();
      _afterUnlock(password, userId);
      return;
    }
  }

  // No valid local vault — try fetching from cloud
  const syncKeyHex = await deriveSyncKeyHex(password, userId);
  syncConfig = {
    ...defaultSyncConfig(),
    enabled: true,
    userId,
    syncKeyHex,
    deviceId: getDeviceId(),
    status: "ok",
  };

  try {
    const client = getBLClient();
    const { data: remote } = await client
      .from(SYNC_TABLE)
      .select("ciphertext,updated_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (remote?.ciphertext) {
      const remotePayload = tryDecrypt(remote.ciphertext, syncKeyHex);
      if (remotePayload) {
        applyVaultPayload(remotePayload);
        hideAuthScreen();
        hideLockScreen();
        _afterUnlock(password, userId);
        notify("Vault loaded from cloud sync", "success");
        return;
      }
    }
  } catch (e) {
    console.warn("Cloud fetch on login failed", e);
  }

  // Brand new user — show card setup
  _pendingCardSetup = { name: displayName, email: "", password, userId };
  hideAuthScreen();
  _openCardSetupModal();
}

async function _afterUnlock(password, userId) {
  if (!syncConfig.syncKeyHex) {
    syncConfig.syncKeyHex = await deriveSyncKeyHex(password, userId);
  }
  syncConfig.enabled = true;
  syncConfig.url = BL_SUPABASE_URL;
  syncConfig.anonKey = BL_SUPABASE_ANON_KEY;
  syncConfig.userId = syncConfig.userId || userId;
  syncConfig.deviceId = syncConfig.deviceId || getDeviceId();

  resetAutoLock();
  renderCardSwitcher();
  if (userData) {
    updateMyCardWidget();
    processRecurring();
  }
  populateCategorySelects();
  updateAddAccountUI();
  refreshAll();
  populateSyncModal();
  initSyncAfterUnlock().catch((e) => console.warn("Sync init failed", e));
}

/* ── Card Setup (after signup / fresh login) ── */

function _openCardSetupModal() {
  const cs = document.getElementById("cardSetupModal");
  if (!cs) return;
  cs.style.display = "flex";
}

async function completeCardSetup() {
  const { name, password, userId } = _pendingCardSetup || {};
  const nickname = document.getElementById("cs-nickname").value.trim();
  const bank = document.getElementById("cs-bank").value.trim();
  const card4 = document.getElementById("cs-card4").value.trim();
  const cardType = document.getElementById("cs-cardtype").value;
  const limit = parseFloat(document.getElementById("cs-limit").value) || 0;

  if (!card4 || !/^\d{4}$/.test(card4)) {
    notify("Enter the last 4 digits of your card (numbers only)", "error");
    return;
  }

  const newCardData = {
    userData: {
      name: name || userData?.name || "",
      nickname: nickname || bank || "My Card",
      bank: bank || "",
      cardNumber: card4,
      cardType: cardType || "Debit",
      limit,
    },
    transactions: [],
    customCategories: [],
    categoryBudgets: {},
    recurringTemplates: [],
  };

  if (addingNewCard) {
    // Adding an additional card to existing account
    syncActiveToCards();
    cards.push(newCardData);
    activeCardIdx = cards.length - 1;
    loadActiveCard();
    addingNewCard = false;
    document.getElementById("cardSetupModal").style.display = "none";
    // Reset modal title back
    document
      .getElementById("cardSetupModal")
      .querySelector(".modal-title").innerHTML =
      '<i class="fas fa-credit-card" style="color:#10b981;margin-right:.5rem"></i>Set Up Your First Card';
    saveToStorage();
    renderCardSwitcher();
    updateMyCardWidget();
    populateCategorySelects();
    updateAddAccountUI();
    refreshAll();
    notify("Card added successfully", "success");
    return;
  }

  // First-time card setup after signup
  sessionPin = password;
  localStorage.setItem(AUTH_MODE_KEY, "password");

  userData = newCardData.userData;
  cards = [newCardData];
  activeCardIdx = 0;
  loadActiveCard();

  const syncKeyHex = await deriveSyncKeyHex(password, userId);
  syncConfig = {
    ...defaultSyncConfig(),
    enabled: true,
    userId,
    syncKeyHex,
    deviceId: getDeviceId(),
    status: "ok",
  };

  saveToStorage({ skipCloudPush: false });
  document.getElementById("cardSetupModal").style.display = "none";

  renderCardSwitcher();
  updateMyCardWidget();
  populateCategorySelects();
  updateAddAccountUI();
  refreshAll();
  initSyncAfterUnlock({ forceSyncNow: true }).catch(() => {});

  notify(
    `Welcome to BlueLedger${name ? ", " + name.split(" ")[0] : ""}! 🎉`,
    "success",
  );

  setTimeout(async () => {
    // Show biometric setup if device supports PasswordCredential (Android) OR WebAuthn (iOS)
    const canPasswordCred = _canUsePasswordCredentialFlow();
    let canWebAuthn = false;
    if (window.PublicKeyCredential) {
      try {
        canWebAuthn =
          await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
      } catch {}
    }
    if (canPasswordCred || canWebAuthn) {
      const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
      const isMac =
        /Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 0;
      const isWindows = /Windows/.test(navigator.userAgent);
      const isAndroid = /Android/.test(navigator.userAgent);
      const titleEl = document.getElementById("bioModalTitle");
      const iconEl = document.getElementById("bioModalIcon");
      const descEl = document.getElementById("bioModalDesc");
      const btnEl = document.getElementById("bioModalEnableBtn");

      if (isIOS || (isMac && canWebAuthn && !canPasswordCred)) {
        if (titleEl)
          titleEl.innerHTML =
            '<i class="fas fa-face-smile" style="color:#3b82f6;margin-right:.5rem"></i>Enable Face ID';
        if (iconEl)
          iconEl.innerHTML =
            '<i class="fas fa-face-smile" style="color:#3b82f6;font-size:3rem"></i>';
        if (descEl)
          descEl.innerHTML =
            'Use <strong style="color:#e2e8f0">Face ID</strong> to unlock BlueLedger instantly.<br>Your password is still required on new devices.';
        if (btnEl) btnEl.innerHTML = '<i class="fas fa-face-smile"></i> Enable';
      } else if (isWindows && canWebAuthn) {
        if (titleEl)
          titleEl.innerHTML =
            '<i class="fab fa-windows" style="color:#3b82f6;margin-right:.5rem"></i>Enable Windows Hello';
        if (iconEl)
          iconEl.innerHTML =
            '<i class="fab fa-windows" style="color:#3b82f6;font-size:3rem"></i>';
        if (descEl)
          descEl.innerHTML =
            'Use <strong style="color:#e2e8f0">Windows Hello</strong> (PIN, fingerprint, or face) to unlock BlueLedger instantly.';
        if (btnEl) btnEl.innerHTML = '<i class="fab fa-windows"></i> Enable';
      } else if (isAndroid || canPasswordCred) {
        if (titleEl)
          titleEl.innerHTML =
            '<i class="fas fa-fingerprint" style="color:#3b82f6;margin-right:.5rem"></i>Enable Fingerprint Login';
        if (iconEl)
          iconEl.innerHTML =
            '<i class="fas fa-fingerprint" style="color:#3b82f6;font-size:3rem"></i>';
        if (descEl)
          descEl.innerHTML =
            'Use your <strong style="color:#e2e8f0">fingerprint</strong> to unlock BlueLedger instantly.';
        if (btnEl)
          btnEl.innerHTML = '<i class="fas fa-fingerprint"></i> Enable';
      } else {
        if (titleEl)
          titleEl.innerHTML =
            '<i class="fas fa-fingerprint" style="color:#3b82f6;margin-right:.5rem"></i>Enable Biometric Login';
        if (iconEl)
          iconEl.innerHTML =
            '<i class="fas fa-fingerprint" style="color:#3b82f6;font-size:3rem"></i>';
        if (descEl)
          descEl.innerHTML =
            'Use your <strong style="color:#e2e8f0">device biometrics</strong> to unlock BlueLedger instantly.';
        if (btnEl)
          btnEl.innerHTML = '<i class="fas fa-fingerprint"></i> Enable';
      }
      document.getElementById("biometricSetupModal").style.display = "flex";
    }
  }, 800);
}

async function registerBiometricNow() {
  const btnEl = document.getElementById("bioModalEnableBtn");
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.style.opacity = "0.6";
  }
  try {
    const setupData = _pendingCardSetup || {};
    const email =
      setupData.email ||
      localStorage.getItem("bl_last_email") ||
      "blueledger-user";
    const password = setupData.password || sessionPin;

    // Guard: if password is unavailable, abort — storing an empty vault breaks auth
    if (!password) {
      notify(
        "Please log in first, then enable biometrics from Settings.",
        "error",
      );
      document.getElementById("biometricSetupModal").style.display = "none";
      return;
    }

    const isAndroid = /Android/i.test(navigator.userAgent);
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isMac =
      /Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
    const canPasswordCred = _canUsePasswordCredentialFlow();
    const canWebAuthn = !!window.PublicKeyCredential;

    // Only use PasswordCredential on Android (it shows the fingerprint prompt there).
    // On Windows/desktop, PasswordCredential just shows the "Save password?" browser dialog — use WebAuthn instead.
    if (isAndroid && canPasswordCred && email && password) {
      const cred = new PasswordCredential({ id: email, password });
      await navigator.credentials.store(cred);
      localStorage.setItem("bl_has_stored_creds", "1");
      notify("Fingerprint login enabled ✓", "success");
    } else if (canWebAuthn) {
      if (!email || !email.includes("@")) {
        notify(
          "Log in once with your real email before enabling Windows Hello.",
          "error",
        );
        return;
      }
      await _webAuthnRegister(email);
      _webAuthnStorePassword(password);
      localStorage.removeItem("bl_has_stored_creds");
      localStorage.setItem("bl_last_email", email);
      const isWindows = /Windows/.test(navigator.userAgent);
      notify(
        isIOS || isMac
          ? "Face ID enabled ✓"
          : isWindows
            ? "Windows Hello enabled ✓"
            : "Biometric login enabled ✓",
        "success",
      );
    } else {
      notify("Biometric authentication not supported on this device", "error");
    }
    _refreshBiometricSettingsRow();
  } catch (e) {
    console.warn("Biometric registration failed", e);
    if (e && e.name === "NotAllowedError") {
      notify("Biometric setup cancelled", "info");
    } else {
      notify("Could not enable biometric login. Try again.", "error");
    }
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.style.opacity = "1";
    }
    document.getElementById("biometricSetupModal").style.display = "none";
  }
}

/* ── Lock screen — password mode ── */

async function tryLockScreenBiometric() {
  const btn = document.getElementById("lockBiometricBtn");
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = "0.6";
  }
  try {
    // Android Chrome — PasswordCredential
    if (
      localStorage.getItem("bl_has_webauthn") !== "1" &&
      _canUsePasswordCredentialFlow() &&
      localStorage.getItem("bl_has_stored_creds") === "1"
    ) {
      const cred = await navigator.credentials.get({
        password: true,
        mediation: "required",
      });
      if (!cred) return;
      const raw = localStorage.getItem(STORAGE_KEY);
      const vault = tryDecrypt(raw, cred.password);
      if (
        vault &&
        (vault.verify === VERIFY_TOKEN || vault.verify === VERIFY_TOKEN_V2)
      ) {
        await _lockScreenSuccess(cred.password, vault);
        return;
      }
      document.getElementById("lockError").textContent =
        "Biometric credential mismatch. Use your password.";
      return;
    }
    // iOS Safari / WebAuthn path — Face ID / Touch ID / Windows Hello
    if (localStorage.getItem("bl_has_webauthn") === "1") {
      const password = await _webAuthnAuthenticate();

      // Google auth users: vault key is derived, not a password — re-derive and unlock
      const isGoogleAuth = localStorage.getItem("bl_is_google_auth") === "1";
      if (isGoogleAuth) {
        try {
          const client = getBLClient();
          const { data } = await client.auth.getSession();
          if (data?.session) {
            await _unlockGoogleUser(data.session);
            return;
          }
        } catch {}
        document.getElementById("lockError").textContent =
          "Session expired. Please sign in again.";
        return;
      }

      // Regular password user — decrypt local vault with recovered password
      const raw = localStorage.getItem(STORAGE_KEY);
      const vault = raw ? tryDecrypt(raw, password) : null;
      if (
        vault &&
        (vault.verify === VERIFY_TOKEN || vault.verify === VERIFY_TOKEN_V2)
      ) {
        await _lockScreenSuccess(password, vault);
        return;
      }
      // Local vault not found — try cloud unlock (password users only)
      document.getElementById("lockPasswordInput").value = password;
      await unlockWithLockPassword();
    }
  } catch (e) {
    if (e && e.name !== "NotAllowedError") {
      // NotAllowedError = user cancelled — silent. Show error for real failures.
      document.getElementById("lockError").textContent =
        "Biometric failed. Enter your password.";
    }
    console.warn("Lock screen biometric failed", e);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = "1";
    }
  }
}

async function unlockWithLockPassword() {
  const password = document.getElementById("lockPasswordInput").value;
  if (!password) return;

  // Clear any previous attempt feedback immediately
  document.getElementById("lockAttempts").textContent = "";
  document.getElementById("lockError").textContent = "";

  const now = Date.now();
  if (now < pinLockedUntil) {
    document.getElementById("lockError").textContent =
      `Too many attempts. Wait ${Math.ceil((pinLockedUntil - now) / 1000)}s`;
    return;
  }

  const btn = document.getElementById("lockUnlockBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Unlocking…';
  }

  const errEl = document.getElementById("lockError");
  errEl.textContent = "";

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const vault = raw ? tryDecrypt(raw, password) : null;

    if (
      vault &&
      (vault.verify === VERIFY_TOKEN || vault.verify === VERIFY_TOKEN_V2)
    ) {
      // Local vault decrypted successfully
      pinAttempts = 0;
      pinLockedUntil = 0;
      await _lockScreenSuccess(password, vault);
      return;
    }

    // Local decrypt failed — try cloud with active session
    errEl.textContent = "Checking cloud…";
    const client = getBLClient();
    const { data: sessionData } = await client.auth.getSession();

    if (sessionData?.session) {
      const userId = sessionData.session.user.id;
      // Re-authenticate to confirm password is correct
      const userEmail = sessionData.session.user.email;
      const { error: signInErr } = await client.auth.signInWithPassword({
        email: userEmail,
        password,
      });

      if (signInErr) {
        // Wrong password
        errEl.textContent = "";
        _lockFailure(errEl);
        return;
      }

      // Password correct — fetch cloud vault
      const syncKeyHex = await deriveSyncKeyHex(password, userId);
      const { data: remote } = await client
        .from(SYNC_TABLE)
        .select("ciphertext,updated_at")
        .eq("user_id", userId)
        .maybeSingle();

      if (remote?.ciphertext) {
        const remotePayload = tryDecrypt(remote.ciphertext, syncKeyHex);
        if (remotePayload) {
          // Cloud vault decrypted — bootstrap local vault
          sessionPin = password;
          localStorage.setItem(AUTH_MODE_KEY, "password");
          syncConfig = {
            ...defaultSyncConfig(),
            enabled: true,
            userId,
            syncKeyHex,
            deviceId: getDeviceId(),
            status: "ok",
          };
          applyVaultPayload(remotePayload);
          saveToStorage({ skipCloudPush: true, skipDirtyMark: true });
          pinAttempts = 0;
          hideLockScreen();
          await _afterUnlock(password, userId);
          notify("Synced from cloud", "success");
          return;
        }
      }

      // Correct password but no cloud vault yet — fresh start
      sessionPin = password;
      localStorage.setItem(AUTH_MODE_KEY, "password");
      const displayName = sessionData.session.user.user_metadata?.name || "";
      syncConfig = {
        ...defaultSyncConfig(),
        enabled: true,
        userId,
        syncKeyHex,
        deviceId: getDeviceId(),
        status: "ok",
      };
      _pendingCardSetup = {
        name: displayName,
        email: userEmail,
        password,
        userId,
      };
      hideLockScreen();
      _openCardSetupModal();
      return;
    }

    // No session — wrong password
    errEl.textContent = "";
    _lockFailure(errEl);
  } catch (e) {
    console.warn("Unlock error", e);
    errEl.textContent = "Something went wrong. Try again.";
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-unlock-alt"></i> Unlock';
    }
  }
}

function _lockFailure(errEl) {
  document.getElementById("lockPasswordInput").value = "";
  const dots = document.getElementById("pinDots");
  dots?.classList.add("shake");
  setTimeout(() => dots?.classList.remove("shake"), 700);

  pinAttempts++;
  const remaining = MAX_PIN_ATTEMPTS - pinAttempts;

  if (pinAttempts >= MAX_PIN_ATTEMPTS) {
    pinLockedUntil = Date.now() + PIN_LOCKOUT_MS;
    pinAttempts = 0;
    errEl.textContent = "Too many attempts — locked for 30s";
    const countdown = setInterval(() => {
      const s = Math.ceil((pinLockedUntil - Date.now()) / 1000);
      if (s <= 0) {
        clearInterval(countdown);
        errEl.textContent = "";
      } else errEl.textContent = `Locked — try again in ${s}s`;
    }, 500);
  } else if (pinAttempts >= 2) {
    errEl.innerHTML = `Wrong password (${remaining} left). 
      <a href="#" onclick="doSignOut();return false" 
         style="color:#f87171;text-decoration:underline">Sign out &amp; start fresh</a>`;
  } else {
    errEl.textContent = `Wrong password — ${remaining} attempt${remaining === 1 ? "" : "s"} remaining`;
    setTimeout(() => {
      errEl.textContent = "";
    }, 2500);
  }
}

async function _lockScreenSuccess(password, vault) {
  sessionPin = password;
  cards = vault.cards || [];
  activeCardIdx = vault.activeCardIdx || 0;
  syncConfig = cleanSyncConfig(vault.syncConfig);
  syncConfig.deviceId = syncConfig.deviceId || getDeviceId();
  if (activeCardIdx >= cards.length) activeCardIdx = 0;
  if (cards.length > 0) loadActiveCard();

  // Get userId from live session
  let userId = syncConfig.userId;
  try {
    const { data } = await getBLClient().auth.getSession();
    if (data.session?.user?.id) userId = data.session.user.id;
  } catch {}

  hideLockScreen();
  _afterUnlock(password, userId);
}

/* ── Migration: PIN → Password ── */

async function startMigration() {
  const pin = document.getElementById("migrationPin").value.trim();
  const errEl = document.getElementById("migrationError");
  if (!pin) {
    errEl.textContent = "Enter your current PIN";
    return;
  }

  const now = Date.now();
  if (now < pinLockedUntil) {
    errEl.textContent = `Too many attempts. Wait ${Math.ceil((pinLockedUntil - now) / 1000)}s`;
    return;
  }

  const raw = localStorage.getItem(STORAGE_KEY);
  const vault = tryDecrypt(raw, pin);
  if (!vault || vault.verify !== VERIFY_TOKEN) {
    pinAttempts++;
    if (pinAttempts >= MAX_PIN_ATTEMPTS) {
      pinLockedUntil = Date.now() + PIN_LOCKOUT_MS;
      pinAttempts = 0;
    }
    errEl.textContent = "Incorrect PIN";
    return;
  }

  pinAttempts = 0;
  _migrationVault = vault;
  document.getElementById("migrationModal").style.display = "none";

  // Pre-fill signup name from old vault
  const existingName = vault.cards?.[0]?.userData?.name || "";
  showAuthScreen("signup");
  document.getElementById("signupName").value = existingName;
  notify("PIN verified — create your account to continue", "info");
}

async function _applyMigrationVault(password, userId) {
  const vault = _migrationVault;
  _migrationVault = null;

  sessionPin = password;
  localStorage.setItem(AUTH_MODE_KEY, "password");

  cards = vault.cards || [];
  activeCardIdx = vault.activeCardIdx || 0;
  if (cards.length > 0) loadActiveCard();

  const syncKeyHex = await deriveSyncKeyHex(password, userId);
  syncConfig = {
    ...defaultSyncConfig(),
    enabled: true,
    userId,
    syncKeyHex,
    deviceId: getDeviceId(),
    status: "ok",
  };

  saveToStorage({ skipCloudPush: false });
  hideAuthScreen();

  renderCardSwitcher();
  if (userData) {
    updateMyCardWidget();
    processRecurring();
  }
  populateCategorySelects();
  updateAddAccountUI();
  refreshAll();
  initSyncAfterUnlock({ forceSyncNow: true }).catch(() => {});
  notify("Account upgraded successfully!", "success");
}

/* ── Sign out ── */
async function doSignOut() {
  try {
    stopCloudSync();
    saveToStorage();
    sessionPin = null;
    cards = [];
    activeCardIdx = 0;
    userData = null;
    transactions = [];
    customCategories = [];
    categoryBudgets = {};
    recurringTemplates = [];
    syncConfig = defaultSyncConfig();
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(AUTH_MODE_KEY);
    const client = getBLClient();
    await client.auth.signOut();
    location.reload();
  } catch (e) {
    console.warn("Sign out error", e);
    location.reload();
  }
}

/* ── Backup: .bl file export/import + QR ── */

function exportBLFile() {
  if (!sessionPin) {
    notify("Unlock the app first", "error");
    return;
  }
  const payload = getVaultPayload();
  const encrypted = encrypt(payload, sessionPin);
  const blob = new Blob([JSON.stringify({ bl: 1, data: encrypted })], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `blueledger-backup-${new Date().toISOString().slice(0, 10)}.bl`;
  a.click();
  notify("Backup file downloaded", "success");
}

function importBLFileClick() {
  document.getElementById("blFileInput").click();
}

async function handleBLFileImport(input) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    if (!obj.bl || !obj.data)
      throw new Error("Not a valid BlueLedger backup file");
    const password = prompt(
      "Enter the password used when this backup was created:",
    );
    if (!password) return;
    const payload = tryDecrypt(obj.data, password);
    if (!payload) {
      notify("Wrong password — cannot decrypt backup", "error");
      return;
    }
    if (!confirm("This will replace your current data. Continue?")) return;
    applyVaultPayload(payload);
    saveToStorage();
    renderCardSwitcher();
    if (userData) {
      updateMyCardWidget();
      processRecurring();
    }
    populateCategorySelects();
    updateAddAccountUI();
    refreshAll();
    notify("Backup restored successfully", "success");
  } catch (e) {
    notify(e.message || "Import failed", "error");
  }
  input.value = "";
}

async function exportQRCode() {
  if (!sessionPin) {
    notify("Unlock the app first", "error");
    return;
  }
  const payload = getVaultPayload();
  const encrypted = encrypt(payload, sessionPin);
  const jsonStr = JSON.stringify({ bl: 1, data: encrypted });

  if (jsonStr.length > 2500) {
    notify(
      "Vault is too large for a QR code. Use the .bl backup file instead.",
      "warn",
    );
    return;
  }

  // Use QRServer API for QR generation
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(jsonStr)}`;
  const win = window.open("", "_blank");
  win.document.write(`
    <html><head><title>BlueLedger QR Backup</title></head>
    <body style="background:#0f172a;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;color:#e2e8f0;font-family:system-ui">
      <p style="margin-bottom:1rem;font-size:.9rem;color:#94a3b8">Scan this QR code on your other device to restore your vault</p>
      <img src="${qrUrl}" style="border-radius:12px;background:white;padding:12px" />
      <p style="margin-top:1rem;font-size:.8rem;color:#64748b">You'll need your password to decrypt the vault after scanning</p>
    </body></html>`);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   LOCK SCREEN
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function showLockScreen(subtitle) {
  const fab = document.querySelector(".add-buttons");
  if (fab) fab.style.display = "none";

  // Always reset attempt counter when showing lock screen
  pinAttempts = 0;
  pinLockedUntil = 0;

  const authMode = localStorage.getItem(AUTH_MODE_KEY);
  const ls = document.getElementById("lockScreen");
  ls.style.display = "flex";

  if (authMode === "password") {
    ls.classList.add("lock-screen--password");
    // Hide PIN pad, show password form
    const pinArea = document.getElementById("pinArea");
    const pwdArea = document.getElementById("passwordArea");
    if (pinArea) pinArea.style.display = "none";
    if (pwdArea) pwdArea.style.display = "block";
    const pwdInput = document.getElementById("lockPasswordInput");
    if (pwdInput) {
      pwdInput.value = "";
      setTimeout(() => pwdInput.focus(), 300);
    }
    // Show biometric button if available
    const bioBtn = document.getElementById("lockBiometricBtn");
    const bioDivider = document.getElementById("lockBiometricDivider");
    if (bioBtn) {
      const hasPasswordCred =
        localStorage.getItem("bl_has_stored_creds") === "1" &&
        _canUsePasswordCredentialFlow();
      const hasWebAuthn =
        localStorage.getItem("bl_has_webauthn") === "1" &&
        !!window.PublicKeyCredential;
      const canBio = hasPasswordCred || hasWebAuthn;
      bioBtn.style.display = canBio ? "flex" : "none";
      if (bioDivider) bioDivider.style.display = canBio ? "block" : "none";
      // Label the button appropriately per platform
      if (canBio) {
        const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
        const isMac =
          /Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 0;
        const isWindows = /Windows/.test(navigator.userAgent);
        const labelEl = document.getElementById("lockBiometricLabel");
        const iconEl = document.getElementById("lockBiometricIcon");
        if (isIOS || (isMac && hasWebAuthn && !hasPasswordCred)) {
          if (labelEl) labelEl.textContent = "Use Face ID";
          if (iconEl) iconEl.className = "fas fa-face-smile";
        } else if (isWindows && hasWebAuthn) {
          if (labelEl) labelEl.textContent = "Use Windows Hello";
          if (iconEl) iconEl.className = "fab fa-windows";
        } else {
          if (labelEl) labelEl.textContent = "Use Fingerprint / Biometric";
          if (iconEl) iconEl.className = "fas fa-fingerprint";
        }
        if (!isWindows) setTimeout(tryLockScreenBiometric, 600);
      }
    }
    document.getElementById("lockSubtitle").textContent =
      subtitle || "Enter your password to continue";
  } else {
    ls.classList.remove("lock-screen--password");
    pinBuffer = "";
    updatePinDots();
    const pinArea = document.getElementById("pinArea");
    const pwdArea = document.getElementById("passwordArea");
    if (pinArea) pinArea.style.display = "block";
    if (pwdArea) pwdArea.style.display = "none";
    document.getElementById("lockSubtitle").textContent =
      subtitle || "Enter your PIN to continue";
  }

  document.getElementById("lockError").textContent = "";
  document.getElementById("lockAttempts").textContent = "";
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
  syncConfig = cleanSyncConfig(vault.syncConfig);
  syncConfig.deviceId = syncConfig.deviceId || getDeviceId();
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
  updateAddAccountUI();
  refreshAll();
  initSyncAfterUnlock().catch((e) => {
    console.warn("Sync init failed", e);
    updateSyncStatus(
      "warn",
      "Cloud sync needs attention",
      "Open Cloud Sync in Settings to reconnect.",
    );
  });
}

// Keyboard support on lock screen (PIN mode only — skip entirely in password mode)
document.addEventListener("keydown", (e) => {
  if (document.getElementById("lockScreen").style.display === "none") return;
  // In password mode the real input field handles everything — don't intercept digits
  if (localStorage.getItem(AUTH_MODE_KEY) === "password") return;
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
  stopCloudSync();
  sessionPin = null;
  pinBuffer = "";
  clearTimeout(autoLockTimer);
  cards = [];
  activeCardIdx = 0;
  userData = null;
  transactions = [];
  customCategories = [];
  categoryBudgets = {};
  recurringTemplates = [];
  syncConfig = defaultSyncConfig();
  showLockScreen();
  notify("App locked", "info");
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CHANGE PIN
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function openChangePinModal() {
  openModal("changePinModal");
}
async function changePin() {
  const oldPin = document.getElementById("cpOld").value.trim();
  const newPin = document.getElementById("cpNew").value.trim();
  const newPin2 = document.getElementById("cpNew2").value.trim();

  const authMode = localStorage.getItem(AUTH_MODE_KEY);

  if (oldPin !== sessionPin) {
    notify("Current password is incorrect", "error");
    return;
  }

  if (authMode === "password") {
    if (newPin.length < 8) {
      notify("New password must be at least 8 characters", "error");
      return;
    }
  } else {
    if (!/^\d{4,6}$/.test(newPin)) {
      notify("PIN must be 4–6 digits", "error");
      return;
    }
  }

  if (newPin !== newPin2) {
    notify("New passwords don't match", "error");
    return;
  }

  const oldPass = sessionPin;
  sessionPin = newPin;

  // If password mode, update Supabase password + re-derive sync key
  if (authMode === "password" && syncConfig?.userId) {
    try {
      const client = getBLClient();
      const { error } = await client.auth.updateUser({ password: newPin });
      if (error) throw error;
      // Re-derive sync key with new password
      syncConfig.syncKeyHex = await deriveSyncKeyHex(newPin, syncConfig.userId);
    } catch (e) {
      sessionPin = oldPass;
      notify(e.message || "Password update failed", "error");
      return;
    }
  }

  saveToStorage();
  closeModal("changePinModal");
  ["cpOld", "cpNew", "cpNew2"].forEach(
    (id) => (document.getElementById(id).value = ""),
  );
  // Keep WebAuthn vault in sync with new password
  if (
    authMode === "password" &&
    localStorage.getItem("bl_has_webauthn") === "1"
  ) {
    try {
      _webAuthnStorePassword(newPin);
    } catch {}
  }
  // Keep PasswordCredential in sync with new password
  if (
    authMode === "password" &&
    localStorage.getItem("bl_has_stored_creds") === "1" &&
    _canUsePasswordCredentialFlow()
  ) {
    try {
      const email = localStorage.getItem("bl_last_email");
      if (email && window.PasswordCredential) {
        await navigator.credentials.store(
          new PasswordCredential({ id: email, password: newPin }),
        );
      }
    } catch {}
  } else if (!_canUsePasswordCredentialFlow()) {
    localStorage.removeItem("bl_has_stored_creds");
  }
  notify(
    authMode === "password" ? "Password updated" : "PIN updated",
    "success",
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CARD SWITCHER UI
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function renderCardSwitcher() {
  const strip = document.getElementById("cardSwitcher");
  if (!strip) return;

  // ── Desktop pill tabs ──────────────────────────
  let pillHtml = cards
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
    pillHtml += `<button class="card-tab card-tab--add" onclick="addNewCard()"><i class="fas fa-plus"></i><span>Add Card</span></button>`;
  }

  // ── Mobile circular ring ───────────────────────
  let ringHtml = `<div class="card-ring-row">`;
  ringHtml += cards
    .map((c, i) => {
      const nickname = c.userData?.nickname?.trim();
      const first = nickname || c.userData?.name?.split(" ")[0] || "Card";
      // Initial letter(s) for the avatar
      const initials = first.slice(0, 2).toUpperCase();
      const color = CARD_ACCENT_COLORS[i];
      const active = i === activeCardIdx ? "card-ring--active" : "";
      return `<div class="card-ring ${active}" onclick="switchCard(${i})">
        <div class="card-ring__circle" style="border-color:${color};${active ? `box-shadow:0 0 0 2px ${color}44,0 4px 16px rgba(0,0,0,0.3)` : ""}">
          ${initials}
        </div>
        <span class="card-ring__label">${first}</span>
      </div>`;
    })
    .join("");
  if (cards.length < 4) {
    ringHtml += `<div class="card-ring card-ring--add" onclick="addNewCard()">
      <div class="card-ring__circle"><i class="fas fa-plus"></i></div>
      <span class="card-ring__label">Add</span>
    </div>`;
  }
  ringHtml += `</div>`;

  strip.innerHTML = pillHtml + ringHtml;
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
  updateAddAccountUI();
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
  if (cards.length === 0 || !userData) {
    notify("Complete your profile setup first", "error");
    return;
  }
  // Reuse card setup modal for adding additional cards
  addingNewCard = true;
  ["cs-nickname", "cs-bank", "cs-card4", "cs-limit"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const modal = document.getElementById("cardSetupModal");
  if (modal) {
    modal.querySelector(".modal-title").innerHTML =
      '<i class="fas fa-credit-card" style="color:#10b981;margin-right:.5rem"></i>Add New Card';
    modal.style.display = "flex";
  }
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
  txnExpanded = false;
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

function getAnalyticsTransactions() {
  if (!cards.length) return [...transactions];
  syncActiveToCards();
  return cards.reduce((all, card) => {
    const txns = Array.isArray(card?.transactions) ? card.transactions : [];
    return all.concat(txns);
  }, []);
}

function getTxns(period, sourceTxns = transactions) {
  const { start, end } = getBounds(period);
  return sourceTxns.filter((t) => {
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

function isTransferLikeTransaction(t) {
  if (!t || t.type !== "expense") return false;
  const category = (t.category || "").trim();
  const text = [t.category, t.description, t.notes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    /^to\s+/i.test(category) ||
    /^from\s+/i.test(category) ||
    /\bself transfer\b/.test(text) ||
    /\bbank transfer\b/.test(text) ||
    /\btransfer to\b/.test(text) ||
    /\btransfer from\b/.test(text) ||
    /\bcredit card bill\b/.test(text) ||
    /\bcard bill\b/.test(text)
  );
}

function getSpendingExpenses(tx) {
  return tx.filter(
    (t) => t.type === "expense" && !isTransferLikeTransaction(t),
  );
}

function sumSpend(tx) {
  return getSpendingExpenses(tx).reduce((s, t) => s + Math.abs(t.amount), 0);
}

function getTxnPreviewLimit(period) {
  return TXN_PREVIEW_LIMITS[period] || TXN_PREVIEW_LIMITS.monthly;
}

function toggleTxnExpanded() {
  txnExpanded = !txnExpanded;
  renderTxns(currentPeriod);
}

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

function getChartData(period, sourceTxns = getAnalyticsTransactions()) {
  const now = new Date();
  if (period === "daily") {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - (6 - i),
      );
      const ds = localDateStr(d);
      const tx = sourceTxns.filter((t) => t.date === ds);
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
      const tx = sourceTxns.filter((t) => {
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
  // FIX 2: Show last 6 months instead of all 12 so bars are
  // visible and the active month is always in view at the right.
  const monthLabels = [
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
  return Array.from({ length: 6 }, (_, i) => {
    const offset = 5 - i; // 5 months ago → now
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const yr2 = d.getFullYear(),
      mi = d.getMonth();
    const tx = sourceTxns.filter((t) => {
      const td = new Date(t.date + "T00:00:00");
      return td.getFullYear() === yr2 && td.getMonth() === mi;
    });
    return {
      label: monthLabels[mi],
      income: sumInc(tx),
      expense: sumExp(tx),
      active: offset === 0,
    };
  });
}

function setChartPeriod(p) {
  chartPeriod = p;
  // Delegate to Chart.js system
  if (typeof updateOverviewChart === "function") {
    updateOverviewChart(p);
  }
}

function renderChart(period, sourceTxns) {
  // Kept for backward-compat; delegates to Chart.js
  if (typeof updateOverviewChart === "function") {
    updateOverviewChart(period || chartPeriod);
  }
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ALL EXPENSES PANEL
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function renderAllExpenses(period, sourceTxns = getAnalyticsTransactions()) {
  const analyticsTxns = sourceTxns;
  const { start, end } = getBounds(period);
  document.getElementById("expBadge").textContent =
    `(${period.charAt(0).toUpperCase() + period.slice(1)})`;
  const exp = analyticsTxns.filter((t) => {
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
        sumExp(
          getTxns(p.toLowerCase(), analyticsTxns).filter(
            (t) => t.type === "expense",
          ),
        ),
      );
  });

  // Delegate category bar to Chart.js system
  if (typeof renderCategoryChartJS === "function") {
    renderCategoryChartJS(sorted);
  } else {
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

function prevPeriodSum(period, type, sourceTxns = transactions) {
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
  const tx = sourceTxns.filter((t) => {
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

function renderDashboard(period, sourceTxns = getAnalyticsTransactions()) {
  const analyticsTxns = sourceTxns;
  const txns = getTxns(period, analyticsTxns);
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
  const pInc = prevPeriodSum(period, "income", analyticsTxns),
    pExp = prevPeriodSum(period, "expense", analyticsTxns);
  renderChange("dashIncomeChange", inc, pInc, compLabel, true);
  renderChange("dashExpenseChange", exp, pExp, compLabel, false);
  renderChange("dashNetChange", net, pInc - pExp, compLabel, true);
  const pLabel = period.charAt(0).toUpperCase() + period.slice(1);
  ["badge1", "badge2", "badge3", "txnBadge"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
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
    const limit = userData.spendingLimit || 0;
    const mExp = sumSpend(getTxns("monthly"));
    const pct = limit > 0 ? Math.min((mExp / limit) * 100, 100) : 0;
    document.getElementById("spendLimitVal").textContent = fmt(limit);
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
  const isFilteredBase =
    !!searchQuery || filterCfg.type !== "all" || filterCfg.cats.length > 0;
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
  const previewLimit = getTxnPreviewLimit(period);
  const shouldClamp =
    !isFilteredBase && !txnExpanded && txns.length > previewLimit;
  const visibleTxns = shouldClamp ? txns.slice(0, previewLimit) : txns;
  const countEl = document.getElementById("txnCount");
  if (countEl) {
    if (isFilteredBase) {
      countEl.textContent = `Showing ${txns.length} of ${totalAll}`;
    } else if (shouldClamp) {
      countEl.textContent = `Showing ${visibleTxns.length} of ${txns.length}`;
    } else {
      countEl.textContent = `${totalAll} transaction${totalAll !== 1 ? "s" : ""}`;
    }
  }
  document
    .getElementById("filterBtn")
    .classList.toggle(
      "active-filter",
      filterCfg.type !== "all" || filterCfg.cats.length > 0,
    );
  const body = document.getElementById("txnBody");
  const mobileList = document.getElementById("txnMobileList");
  const footer = document.getElementById("txnListFooter");
  if (txns.length === 0) {
    const emptyHtml = `<div class="empty-transactions"><i class="fas fa-receipt"></i>${searchQuery ? "No results" : "No transactions for this period"}</div>`;
    body.innerHTML = `<tr><td colspan="6">${emptyHtml}</td></tr>`;
    if (mobileList) mobileList.innerHTML = emptyHtml;
    if (footer) footer.innerHTML = "";
    return;
  }
  const tableRows = visibleTxns
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
  const mobileCards = visibleTxns
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
  if (footer) {
    if (!isFilteredBase && txns.length > previewLimit) {
      footer.innerHTML = `<button class="txn-toggle-btn" onclick="toggleTxnExpanded()">${txnExpanded ? "Show less" : `Show all ${txns.length} transactions`}</button>${txnExpanded ? "" : `<div class="txn-toggle-hint">Home is previewing the latest ${previewLimit} transactions for this view.</div>`}`;
    } else {
      footer.innerHTML = "";
    }
  }
}

function onSearchInput(val) {
  searchQuery = val;
  renderTxns(currentPeriod);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   EXPENSE ANALYSER — INSIGHTS ENGINE
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function renderInsights(sourceTxns = getAnalyticsTransactions()) {
  const section = document.getElementById("insightsSection");
  if (!section) return;
  const analyticsTxns = sourceTxns;
  const spendingTxns = getSpendingExpenses(analyticsTxns);
  const allExp = spendingTxns;
  if (allExp.length < 3) {
    section.style.display = "none";
    return;
  }
  section.style.display = "block";

  const now = new Date();
  const thisMonth = spendingTxns.filter((t) => {
    const d = new Date(t.date + "T00:00:00");
    return (
      d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    );
  });
  const lastMonth = spendingTxns.filter((t) => {
    const d = new Date(t.date + "T00:00:00");
    const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return (
      d.getFullYear() === lm.getFullYear() && d.getMonth() === lm.getMonth()
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
  [...allExp]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 90)
    .forEach((t) => {
      dow[new Date(t.date + "T00:00:00").getDay()] += Math.abs(t.amount);
    });
  const dowMax = Math.max(...dow, 1);
  const dowNames = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  // Savings rate
  const monthInc = sumInc(
    analyticsTxns.filter((t) => {
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
        <div class="insight-label">Average daily spending so far this month</div>
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
  const analyticsTxns = getAnalyticsTransactions();
  renderDashboard(currentPeriod, analyticsTxns);
  renderChart(chartPeriod, analyticsTxns);
  renderAllExpenses(currentPeriod, analyticsTxns);
  renderTxns(currentPeriod);
  renderInsights(analyticsTxns);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PERIOD / CONTEXT MENU
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function togglePeriodMenu() {
  document.getElementById("periodMenu").classList.toggle("open");
}
function setPeriod(p) {
  // Only monthly and picked are supported; daily/weekly are disabled
  if (p === "daily" || p === "weekly") return;
  currentPeriod = p;
  pickedMonth = null;
  txnExpanded = false;
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
  // FIX 1: Flush any pending card state BEFORE mutating transactions,
  // preventing stale card data from overwriting the new entry on re-sync.
  syncActiveToCards();
  transactions.unshift({
    id: Date.now(),
    date,
    category: cat,
    amount: amt,
    description: desc,
    notes,
    type: "income",
  });
  // Immediately push the new transaction into the cards array so that
  // getAnalyticsTransactions() in refreshAll() sees it right away.
  syncActiveToCards();
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
  // FIX 1: Flush any pending card state BEFORE mutating transactions.
  syncActiveToCards();
  transactions.unshift({
    id: Date.now(),
    date,
    category: cat,
    amount: -amt,
    description: desc,
    notes,
    type: "expense",
  });
  // Immediately push the new transaction into the cards array so that
  // getAnalyticsTransactions() in refreshAll() sees it right away.
  syncActiveToCards();
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
    const limit = userData.spendingLimit || 0;
    const mExp = sumSpend(getTxns("monthly"));
    const pct = limit > 0 ? (mExp / limit) * 100 : 0;
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
  updateAddAccountUI();
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

function captureTxnDraft(type) {
  return {
    amount: document.getElementById(type + "Amount")?.value || "",
    date: document.getElementById(type + "Date")?.value || todayStr(),
    category: document.getElementById(type + "Category")?.value || "",
    desc: document.getElementById(type + "Desc")?.value || "",
    notes: document.getElementById(type + "Notes")?.value || "",
    recurring: !!document.getElementById(type + "Recurring")?.checked,
    frequency: document.getElementById(type + "Frequency")?.value || "monthly",
  };
}

function applyTxnDraft(type, draft) {
  if (!draft) return;
  document.getElementById(type + "Amount").value = draft.amount || "";
  document.getElementById(type + "Date").value = draft.date || todayStr();
  document.getElementById(type + "Category").value = draft.category || "";
  document.getElementById(type + "Desc").value = draft.desc || "";
  const notesEl = document.getElementById(type + "Notes");
  if (notesEl) notesEl.value = draft.notes || "";
  const recurringEl = document.getElementById(type + "Recurring");
  if (recurringEl) recurringEl.checked = !!draft.recurring;
  document.getElementById(type + "FrequencyRow").style.display = draft.recurring
    ? "block"
    : "none";
  document.getElementById(type + "Frequency").value =
    draft.frequency || "monthly";
}

function closeAddTargetSheet() {
  pendingAddFlow = null;
  document.getElementById("bnAddTargetSheet")?.classList.remove("open");
  document.getElementById("bnAddTargetOverlay")?.classList.remove("open");
}

function openAddTargetPicker(type, source = "sheet") {
  if (cards.length < 2) {
    notify("Add another account first to use this shortcut", "info");
    return;
  }
  pendingAddFlow = {
    type,
    draft: source === "modal" ? captureTxnDraft(type) : null,
  };
  if (source === "modal") {
    closeModal(type === "income" ? "incomeModal" : "expenseModal");
  } else {
    closeBnSheet();
  }

  const title = document.getElementById("bnAddTargetTitle");
  if (title)
    title.textContent = type === "income" ? "Add Income To" : "Add Expense To";
  const flow = document.getElementById("bnAddTargetFlow");
  if (flow) flow.textContent = type === "income" ? "income" : "expense";

  const list = document.getElementById("bnAddTargetList");
  if (list) {
    list.innerHTML = cards
      .map((card, idx) => {
        if (idx === activeCardIdx) return "";
        return `<button type="button" class="bn-account-option" onclick="switchCardForAdd(${idx})">
          <div class="bn-account-meta">
            <span class="bn-account-dot" style="background:${CARD_ACCENT_COLORS[idx % CARD_ACCENT_COLORS.length]}"></span>
            <div>
              <div class="bn-account-name">${getCardDisplayName(card, idx)}</div>
              <div class="bn-account-sub">${getCardDisplaySub(card)}</div>
            </div>
          </div>
          <i class="fas fa-chevron-right"></i>
        </button>`;
      })
      .join("");
  }

  document.getElementById("bnAddTargetSheet").classList.add("open");
  document.getElementById("bnAddTargetOverlay").classList.add("open");
}

function switchCardForAdd(idx) {
  const flow = pendingAddFlow;
  closeAddTargetSheet();
  if (!flow) return;
  switchCard(idx);
  const modalId = flow.type === "income" ? "incomeModal" : "expenseModal";
  openModal(modalId, { draft: flow.draft });
}

function openBnSettings() {
  document.getElementById("bnSettingsPanel").classList.add("open");
  document.getElementById("bnSettingsOverlay").classList.add("open");
  openBnSettingsWithSync();
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

function openModal(id, options = {}) {
  closeBnSheet();
  closeAddTargetSheet();
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
    resetAiCatBadge("income");
    resetVoiceUi("income");
    applyTxnDraft("income", options.draft);
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
    resetAiCatBadge("expense");
    resetVoiceUi("expense");
    applyTxnDraft("expense", options.draft);
  }
  if (id === "syncModal") {
    populateSyncModal();
  }
  updateAddAccountUI();
}

function closeModal(id) {
  if (id === "summaryModal") {
    const nav = document.querySelector(".summary-month-nav");
    if (nav) nav.style.display = "";
  }
  if (id === "incomeModal") resetVoiceUi("income");
  if (id === "expenseModal") resetVoiceUi("expense");
  document.getElementById(id).style.display = "none";
  document.body.style.overflow = "";
  syncFabVisibility();
  // If closing card setup while adding a new card, reset the flag
  if (id === "cardSetupModal" && addingNewCard) {
    addingNewCard = false;
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
  "syncModal",
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
   ONBOARDING — legacy stub (replaced by email auth)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function completeOnboarding() {
  // Old PIN onboarding replaced by email+password auth
  // Redirect to auth screen if called
  closeModal("onboardingModal");
  showAuthScreen("signup");
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

function setGlassOpacity(val) {
  const v = parseInt(val);
  // Map 0-100 to opacity 0.02-0.18, blur 8-36px
  const opacity = (v / 100) * 0.16 + 0.02;
  const blur = (v / 100) * 28 + 8;
  const border = (v / 100) * 0.18 + 0.04;
  const shadow = (v / 100) * 0.35 + 0.25;
  document.documentElement.style.setProperty(
    "--glass-opacity",
    opacity.toFixed(3),
  );
  document.documentElement.style.setProperty(
    "--glass-blur",
    blur.toFixed(0) + "px",
  );
  document.documentElement.style.setProperty(
    "--glass-border",
    border.toFixed(3),
  );
  document.documentElement.style.setProperty(
    "--glass-shadow",
    shadow.toFixed(2),
  );
  localStorage.setItem("bl_glass_opacity", val);
  // Update both sliders (desktop + mobile) so the blue fill line tracks the thumb
  ["glassSlider", "bnGlassSlider"].forEach((id) => {
    const slider = document.getElementById(id);
    if (slider) {
      if (slider.value !== String(val)) slider.value = val;
      slider.style.setProperty("--val", v + "%");
    }
  });
}

function loadGlassOpacity() {
  const saved = localStorage.getItem("bl_glass_opacity") || "50";
  setGlassOpacity(parseInt(saved));
}

function loadTheme() {
  const saved = localStorage.getItem("bl_theme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  syncThemeUi(saved);
}

function toggleSettingsMenu() {
  const menu = document.getElementById("settingsMenu");
  const isOpen = menu.classList.contains("open");
  menu.classList.toggle("open");

  if (!isOpen) {
    // Sync both sliders on open
    const saved = localStorage.getItem("bl_glass_opacity") || "50";
    ["glassSlider", "bnGlassSlider"].forEach((id) => {
      const slider = document.getElementById(id);
      if (slider) {
        slider.value = saved;
        slider.style.setProperty("--val", saved + "%");
      }
    });

    // Update sync status row
    const dot = document.getElementById("settingsSyncDot");
    const label = document.getElementById("settingsSyncLabel");
    if (dot && label) {
      if (syncConfig?.enabled && syncConfig?.lastSyncedAt) {
        const mins = Math.round(
          (Date.now() - new Date(syncConfig.lastSyncedAt)) / 60000,
        );
        dot.style.background = "#10b981";
        label.style.color = "#10b981";
        label.textContent =
          mins < 1 ? "Synced just now" : `Synced ${mins}m ago`;
      } else if (syncConfig?.enabled) {
        dot.style.background = "#f59e0b";
        label.style.color = "#f59e0b";
        label.textContent = "Sync connecting…";
      } else {
        dot.style.background = "#475569";
        label.style.color = "#64748b";
        label.textContent = "Sync not active";
      }
    }

    // Reset sub-panels to closed
    const glassPanel = document.getElementById("glassSliderPanel");
    const txnPanel = document.getElementById("settingsTxnPanel");
    const glassChevron = document.getElementById("glassChevron");
    const txnChevron = document.getElementById("txnChevron");
    if (glassPanel) glassPanel.style.display = "none";
    if (txnPanel) txnPanel.style.display = "none";
    if (glassChevron) glassChevron.style.transform = "";
    if (txnChevron) txnChevron.style.transform = "";
  }
}

function closeSettingsMenu() {
  document.getElementById("settingsMenu").classList.remove("open");
}

function toggleBnGlassSlider() {
  const panel = document.getElementById("bnGlassPanel");
  const chevron = document.getElementById("bnGlassChevron");
  if (!panel) return;
  const isOpen = panel.style.display !== "none";
  panel.style.display = isOpen ? "none" : "block";
  if (chevron) chevron.style.transform = isOpen ? "" : "rotate(180deg)";
  if (!isOpen) {
    const saved = localStorage.getItem("bl_glass_opacity") || "50";
    const slider = document.getElementById("bnGlassSlider");
    if (slider) slider.value = saved;
  }
}

function openTxnFullPage() {
  const page = document.getElementById("txnFullPage");
  if (!page) return;
  const body = document.getElementById("txnPageBody");
  const subtitle = document.getElementById("txnPageSubtitle");

  syncActiveToCards();
  let allTxns = [];
  cards.forEach((card, ci) => {
    const cardName =
      card.userData?.nickname?.trim() ||
      card.userData?.name?.trim() ||
      `Card ${ci + 1}`;
    const last4 = (card.userData?.cardNumber || "")
      .replace(/\D/g, "")
      .slice(-4);
    const accountLabel = last4 ? `${cardName} ••••${last4}` : cardName;
    (card.transactions || []).forEach((t) =>
      allTxns.push({ ...t, _account: accountLabel }),
    );
  });

  if (!allTxns.length) {
    body.innerHTML =
      '<div style="text-align:center;padding:3rem;color:#475569"><i class="fas fa-inbox" style="font-size:2rem;display:block;margin-bottom:.75rem"></i>No transactions yet</div>';
    subtitle.textContent = "No data";
    page.classList.remove("txn-page-closing");
    requestAnimationFrame(() => page.classList.add("txn-page-open"));
    return;
  }

  allTxns.sort((a, b) => new Date(b.date) - new Date(a.date));

  const groups = {};
  allTxns.forEach((t) => {
    const d = new Date(t.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });
    if (!groups[key]) groups[key] = { label, txns: [] };
    groups[key].txns.push(t);
  });

  const monthCount = Object.keys(groups).length;
  subtitle.textContent = `${allTxns.length} transactions · ${monthCount} month${monthCount !== 1 ? "s" : ""}`;

  body.innerHTML = Object.entries(groups)
    .map(([, g]) => {
      const rows = g.txns
        .map((t) => {
          const isInc = t.type === "income";
          const amt = Math.abs(t.amount);
          const dateStr = new Date(t.date).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "short",
          });
          const desc = (t.description?.trim() || t.category || "").substring(
            0,
            35,
          );
          return `<div class="txn-full-row">
        <div class="txn-full-date">${dateStr}</div>
        <div><div class="txn-full-desc">${desc}</div><div class="txn-full-cat">${t.category}</div></div>
        <div class="txn-full-account">${t._account}</div>
        <div class="txn-full-amt ${isInc ? "pos" : "neg"}">${isInc ? "+" : "-"}₹${amt.toLocaleString("en-IN")}</div>
      </div>`;
        })
        .join("");
      return `<div class="txn-month-group"><div class="txn-month-label">${g.label}</div>${rows}</div>`;
    })
    .join("");

  page.classList.remove("txn-page-closing");
  requestAnimationFrame(() => page.classList.add("txn-page-open"));
}

function closeTxnFullPage() {
  const page = document.getElementById("txnFullPage");
  if (!page) return;
  page.classList.add("txn-page-closing");
  page.classList.remove("txn-page-open");
  setTimeout(() => page.classList.remove("txn-page-closing"), 600);
}

function openBnSettingsWithSync() {
  const dot = document.getElementById("bnSyncDot");
  const label = document.getElementById("bnSyncLabel");
  if (dot && label) {
    if (syncConfig?.enabled && syncConfig?.lastSyncedAt) {
      const mins = Math.round(
        (Date.now() - new Date(syncConfig.lastSyncedAt)) / 60000,
      );
      dot.style.background = "#10b981";
      label.style.color = "#10b981";
      label.textContent = mins < 1 ? "Synced just now" : `Synced ${mins}m ago`;
    } else if (syncConfig?.enabled) {
      dot.style.background = "#f59e0b";
      label.style.color = "#f59e0b";
      label.textContent = "Sync connecting…";
    }
  }
  const saved = localStorage.getItem("bl_glass_opacity") || "50";
  const sl = document.getElementById("bnGlassSlider");
  if (sl) sl.value = saved;
}

function toggleGlassSlider() {
  const panel = document.getElementById("glassSliderPanel");
  const chevron = document.getElementById("glassChevron");
  const txnPanel = document.getElementById("settingsTxnPanel");
  const txnChevron = document.getElementById("txnChevron");
  if (txnPanel && txnPanel.style.display !== "none") {
    txnPanel.style.display = "none";
    if (txnChevron) txnChevron.style.transform = "";
  }
  if (!panel) return;
  const isOpen = panel.style.display !== "none";
  panel.style.display = isOpen ? "none" : "block";
  if (chevron) chevron.style.transform = isOpen ? "" : "rotate(180deg)";
  if (!isOpen) {
    const saved = localStorage.getItem("bl_glass_opacity") || "50";
    const slider = document.getElementById("glassSlider");
    if (slider) slider.value = saved;
  }
}

function toggleSettingsTransactions() {
  const panel = document.getElementById("settingsTxnPanel");
  const chevron = document.getElementById("txnChevron");
  const glassPanel = document.getElementById("glassSliderPanel");
  const glassChevron = document.getElementById("glassChevron");
  if (glassPanel && glassPanel.style.display !== "none") {
    glassPanel.style.display = "none";
    if (glassChevron) glassChevron.style.transform = "";
  }
  if (!panel) return;
  const isOpen = panel.style.display !== "none";
  panel.style.display = isOpen ? "none" : "block";
  if (chevron) chevron.style.transform = isOpen ? "" : "rotate(180deg)";
  if (!isOpen) renderSettingsTransactions();
}

function renderSettingsTransactions() {
  const list = document.getElementById("settingsTxnList");
  if (!list) return;
  const now = new Date();
  const thisMonth = (transactions || [])
    .filter((t) => {
      const d = new Date(t.date);
      return (
        d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
      );
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 20);

  if (!thisMonth.length) {
    list.innerHTML =
      '<div class="settings-txn-empty">No transactions this month</div>';
    return;
  }
  list.innerHTML = thisMonth
    .map((t) => {
      const isIncome = t.type === "income";
      const amt = Math.abs(t.amount);
      const amtClass = isIncome ? "txn-amt-pos" : "txn-amt-neg";
      const sign = isIncome ? "+" : "-";
      const desc = (t.description?.trim() || t.category || "").substring(0, 22);
      const dateStr = new Date(t.date).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
      });
      return `<div class="settings-txn-item">
      <div style="display:flex;flex-direction:column;gap:.1rem">
        <span style="color:#e2e8f0">${desc}</span>
        <span class="txn-cat">${t.category} · ${dateStr}</span>
      </div>
      <span class="${amtClass}">${sign}₹${amt.toLocaleString("en-IN")}</span>
    </div>`;
    })
    .join("");
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
    summary.textContent += ` • ${sourceType}`;
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

async function confirmReset() {
  try {
    stopCloudSync();

    const client = getBLClient();

    // FIX 5a: Delete the encrypted vault row from the cloud database
    // so no ciphertext remains on the server for this account.
    try {
      const {
        data: { user },
      } = await client.auth.getUser();
      if (user?.id) {
        await client
          .from(SYNC_TABLE) // "encrypted_vaults"
          .delete()
          .eq("user_id", user.id);
      }
    } catch (e) {
      // Non-fatal — vault may not exist in cloud (local-only user)
      console.warn("Cloud vault deletion failed (non-fatal):", e);
    }

    // FIX 5b: Sign out from Supabase auth session
    try {
      await client.auth.signOut();
    } catch (e) {
      console.warn("Sign out during reset failed:", e);
    }

    // FIX 5c: Wipe ALL sensitive in-RAM state so no data leaks
    // if the page doesn't fully reload (e.g. back/forward cache)
    sessionPin = null;
    cards = [];
    activeCardIdx = 0;
    userData = null;
    transactions = [];
    customCategories = [];
    categoryBudgets = {};
    recurringTemplates = [];
    syncConfig = defaultSyncConfig();

    // FIX 5d: Clear ALL localStorage keys — not just the vault
    localStorage.clear();

    closeModal("resetModal");
    notify("Signed out and all data deleted. Reloading...", "info");
    setTimeout(() => location.reload(), 900);
  } catch (e) {
    console.warn("confirmReset failed", e);
    notify("Could not complete sign out. Please try again.", "error");
  }
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
loadGlassOpacity();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

(async function initApp() {
  const authMode = localStorage.getItem(AUTH_MODE_KEY);
  const hasVault = hasStoredData();

  document.getElementById("onboardingModal").style.display = "none";
  document.getElementById("lockScreen").style.display = "none";
  document.getElementById("authScreen").style.display = "none";

  try {
    const client = getBLClient();

    // Detect Supabase email confirmation / password reset redirect
    const hash = window.location.hash;
    const isAuthRedirect =
      hash.includes("access_token") ||
      hash.includes("type=signup") ||
      hash.includes("type=recovery");

    if (isAuthRedirect) {
      await new Promise((r) => setTimeout(r, 800));
      const { data: fresh } = await client.auth.getSession();
      history.replaceState(null, "", window.location.pathname);

      if (fresh?.session) {
        const userEmail = fresh.session.user?.email || "";
        const provider = fresh.session.user?.app_metadata?.provider;
        const isRecovery = hash.includes("type=recovery");

        // Google OAuth redirect
        if (provider === "google" && !isRecovery) {
          await _unlockGoogleUser(fresh.session);
          return;
        }

        if (isRecovery) {
          // Password reset — show reset password UI
          document.getElementById("authScreen").style.display = "flex";
          document.getElementById("authScreen").innerHTML = `
            <div class="auth-card">
              <div class="auth-logo"><img src="icon-192.png" alt="BlueLedger" /></div>
              <div class="auth-brand">Blue<span style="color:#3b82f6">Ledger</span></div>
              <div style="padding:1.5rem">
                <p style="font-size:.95rem;font-weight:700;color:#e2e8f0;margin-bottom:1rem;text-align:center">
                  <i class="fas fa-key" style="color:#f59e0b;margin-right:.4rem"></i>Set New Password
                </p>
                <div class="form-group">
                  <label class="form-label">New Password <span style="color:#64748b;font-weight:400">(min 8 characters)</span></label>
                  <input type="password" class="form-input" id="resetNewPassword" placeholder="New password" />
                </div>
                <div class="form-group">
                  <label class="form-label">Confirm New Password</label>
                  <input type="password" class="form-input" id="resetNewPassword2" placeholder="Repeat password"
                    onkeydown="if(event.key==='Enter') doPasswordReset()" />
                </div>
                <div class="auth-error" id="resetError"></div>
                <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:.5rem" onclick="doPasswordReset()">
                  <i class="fas fa-check"></i> Set New Password
                </button>
              </div>
            </div>`;
          return;
        }

        // Email confirmed
        document.getElementById("authScreen").style.display = "flex";
        document.getElementById("authScreen").innerHTML = `
          <div class="auth-card">
            <div class="auth-logo"><img src="icon-192.png" alt="BlueLedger" /></div>
            <div class="auth-brand">Blue<span style="color:#3b82f6">Ledger</span></div>
            <div style="text-align:center;padding:2rem 1.5rem">
              <div style="font-size:3rem;margin-bottom:1rem">✅</div>
              <p style="font-size:1.1rem;font-weight:700;color:#10b981;margin-bottom:.6rem">Email Confirmed!</p>
              <p style="color:#94a3b8;font-size:.88rem;line-height:1.7;margin-bottom:1.5rem">
                You're all set. Log in with your password to get started.
              </p>
              <button class="btn btn-primary" style="width:100%;justify-content:center;font-size:1rem"
                onclick="_goToLoginAfterConfirm('${userEmail}')">
                <i class="fas fa-sign-in-alt"></i> Log In Now
              </button>
            </div>
          </div>`;
        return;
      }
    }

    const { data: sessionData } = await client.auth.getSession();
    const hasSession = !!sessionData?.session;

    // One-time migration: clear any old PIN-only vault that has no authMode set
    // This runs once and sets a flag so it never repeats
    if (hasVault && !authMode && !localStorage.getItem("bl_v2_migrated")) {
      const keysToKeep = [
        "bl_sync_device_v1",
        "bl_has_stored_creds",
        "bl_glass_opacity",
        "bl_theme",
      ];
      const saved = {};
      keysToKeep.forEach((k) => {
        const v = localStorage.getItem(k);
        if (v) saved[k] = v;
      });
      localStorage.clear();
      keysToKeep.forEach((k) => {
        if (saved[k]) localStorage.setItem(k, saved[k]);
      });
      localStorage.setItem("bl_v2_migrated", "1");
      showAuthScreen(hasSession ? "login" : "signup");
      return;
    }
    if (hasVault && authMode === "pin") {
      // Legacy PIN vault — prompt migration
      document.getElementById("migrationModal").style.display = "flex";
    } else if (hasVault && authMode === "password" && hasSession) {
      // Check if this is a Google auth user — skip password lock, re-derive vault key
      const isGoogleAuth = localStorage.getItem("bl_is_google_auth") === "1";
      const provider = sessionData.session?.user?.app_metadata?.provider;
      if (isGoogleAuth || provider === "google") {
        await _unlockGoogleUser(sessionData.session);
      } else {
        // Regular password user — show password lock screen
        showLockScreen();
      }
    } else if (hasVault && authMode === "password" && !hasSession) {
      // Vault exists but session expired — show login
      showAuthScreen("login");
    } else if (hasVault && !authMode) {
      // Old data from before new auth system (no authMode set)
      // Clear stale localStorage and show fresh auth screen
      const keysToKeep = ["bl_sync_device_v1", "bl_has_stored_creds"];
      const saved = {};
      keysToKeep.forEach((k) => {
        const v = localStorage.getItem(k);
        if (v) saved[k] = v;
      });
      localStorage.clear();
      keysToKeep.forEach((k) => {
        if (saved[k]) localStorage.setItem(k, saved[k]);
      });
      if (hasSession) {
        showAuthScreen("login");
      } else {
        showAuthScreen("signup");
      }
    } else if (!hasVault) {
      showAuthScreen(hasSession ? "login" : "signup");
    } else {
      showAuthScreen("login");
    }

    // Pre-fill login if returning after email confirmation
    try {
      const pending = JSON.parse(
        localStorage.getItem("bl_pending_signup") || "null",
      );
      if (pending?.email) {
        setTimeout(() => {
          const el = document.getElementById("loginEmail");
          if (el) el.value = pending.email;
          switchAuthTab("login");
          localStorage.removeItem("bl_pending_signup");
        }, 400);
      }
    } catch {}
  } catch (e) {
    console.warn("initApp error", e);
    const am = localStorage.getItem(AUTH_MODE_KEY);
    if (hasStoredData() && am === "password") showLockScreen();
    else showAuthScreen("signup");
  }
})();

function _goToLoginAfterConfirm(email) {
  document.getElementById("authScreen").innerHTML = "";
  showAuthScreen("login");
  setTimeout(() => {
    const el = document.getElementById("loginEmail");
    if (el && email) el.value = email;
    document.getElementById("loginPassword")?.focus();
  }, 200);
}

async function doPasswordReset() {
  const p1 = document.getElementById("resetNewPassword").value;
  const p2 = document.getElementById("resetNewPassword2").value;
  const errEl = document.getElementById("resetError");
  if (p1.length < 8) {
    errEl.textContent = "Password must be at least 8 characters";
    return;
  }
  if (p1 !== p2) {
    errEl.textContent = "Passwords do not match";
    return;
  }
  try {
    const client = getBLClient();
    const { error } = await client.auth.updateUser({ password: p1 });
    if (error) throw error;
    if (localStorage.getItem("bl_has_webauthn") === "1") {
      try {
        _webAuthnStorePassword(p1);
      } catch {
        _clearWebAuthnState();
        notify(
          "Password updated. Re-enable Windows Hello in Settings.",
          "info",
        );
      }
    }
    if (
      localStorage.getItem("bl_has_stored_creds") === "1" &&
      _canUsePasswordCredentialFlow()
    ) {
      const email = localStorage.getItem("bl_last_email");
      if (email) {
        await navigator.credentials.store(
          new PasswordCredential({ id: email, password: p1 }),
        );
      }
    } else if (!_canUsePasswordCredentialFlow()) {
      localStorage.removeItem("bl_has_stored_creds");
    }
    document.getElementById("authScreen").innerHTML = "";
    showAuthScreen("login");
    notify("Password updated! Log in with your new password.", "success");
  } catch (e) {
    document.getElementById("resetError").textContent =
      e.message || "Failed to update password";
  }
}

renderCardSwitcher();
populateCategorySelects();
// Init Chart.js charts before first render
if (typeof initOverviewChart === "function") initOverviewChart();
if (typeof initCategoryChart === "function") initCategoryChart();
setChartPeriod(chartPeriod);
refreshAll();
syncFabVisibility();

function _clearAiSuggestion(type) {
  const badgeEl = document.getElementById(`${type}AiBadge`);
  const state = _getAiCatState(type);
  state.suggestedCategory = "";
  state.suggestedDesc = "";
  if (badgeEl) {
    badgeEl.style.display = "none";
    badgeEl.dataset.lastDesc = "";
    badgeEl.dataset.suggestedMatch = "";
  }
}

function aiAutoCategory(type, value) {
  clearTimeout(_aiCatTimers[type]);
  const badgeEl = document.getElementById(`${type}AiBadge`);
  if (!badgeEl) return;

  const trimmed = value ? value.trim() : "";
  const state = _getAiCatState(type);

  if (state.acceptedDesc !== trimmed) {
    state.acceptedCategory = "";
    state.acceptedDesc = "";
  }

  if (!trimmed || trimmed.length < 3) {
    _aiCatDismissed[type] = "";
    _clearAiSuggestion(type);
    return;
  }

  if (_aiCatDismissed[type] === trimmed) return;

  _clearAiSuggestion(type);

  const localGuess = _localKeywordGuess(type, trimmed);
  if (localGuess) {
    _showAiBadge(type, localGuess, trimmed, false);
  }

  _aiCatGeneration[type] = (_aiCatGeneration[type] || 0) + 1;
  const myGen = _aiCatGeneration[type];

  _aiCatTimers[type] = setTimeout(async () => {
    if (_aiCatGeneration[type] !== myGen) return;
    await _runAiCat(type, trimmed, myGen);
  }, 700);
}

async function _runAiCat(type, desc, generation) {
  const cats = _getAiCategories(type);
  const badgeEl = document.getElementById(`${type}AiBadge`);
  const selectEl = document.getElementById(`${type}Category`);
  if (!badgeEl || !selectEl) return;

  try {
    const system = `You are a financial transaction categorizer for an Indian personal finance app.
Given a transaction description, return ONLY the single best matching category name from the list.
Do not explain. Do not add punctuation. Return only the category name exactly as given.
Categories: ${cats.join(", ")}`;
    const result = await _callAI([{ role: "user", content: desc }], system, 20);

    if (_aiCatGeneration[type] !== generation) return;

    const suggested = result.trim();
    const match =
      cats.find((c) => c.toLowerCase() === suggested.toLowerCase()) ||
      cats.find((c) => suggested.toLowerCase().includes(c.toLowerCase()));

    if (!match) {
      const localGuess = _localKeywordGuess(type, desc);
      if (!localGuess) _clearAiSuggestion(type);
      return;
    }

    _showAiBadge(type, match, desc, true);
  } catch (e) {
    if (_aiCatGeneration[type] !== generation) return;
    const localGuess = _localKeywordGuess(type, desc);
    if (!localGuess) _clearAiSuggestion(type);
    console.warn("AI categorization failed", e);
  }
}

function _showAiBadge(type, match, desc, isFinal) {
  const badgeEl = document.getElementById(`${type}AiBadge`);
  const selectEl = document.getElementById(`${type}Category`);
  if (!badgeEl || !selectEl) return;
  const state = _getAiCatState(type);

  if (_aiCatDismissed[type] === desc) return;

  state.suggestedCategory = match;
  state.suggestedDesc = desc;

  const isApplied =
    state.acceptedCategory === match && state.acceptedDesc === desc;
  badgeEl.dataset.lastDesc = desc;
  badgeEl.dataset.suggestedMatch = match;

  const confidenceIcon = isFinal
    ? `<i class="fas fa-wand-magic-sparkles" style="color:#a78bfa;flex-shrink:0"></i>`
    : `<i class="fas fa-bolt" style="color:#f59e0b;flex-shrink:0" title="Quick guess while AI confirms"></i>`;

  const helperText = isApplied
    ? "Applied to the category field."
    : isFinal
      ? "Review it, then tap Use if it looks right."
      : "Quick guess while AI confirms the category.";

  badgeEl.style.display = "flex";
  badgeEl.innerHTML = `
    <div class="ai-cat-copy">
      <div class="ai-cat-title-row">
        ${confidenceIcon}
        <span class="ai-cat-title">Suggested category</span>
      </div>
      <div class="ai-cat-main">
        <strong>${match}</strong>
        ${!isFinal ? "<span class='ai-cat-pending'>AI is confirming...</span>" : ""}
      </div>
      <div class="ai-cat-help">${helperText}</div>
    </div>
    <div class="ai-cat-actions">
      ${!isApplied ? `<button class="ai-cat-apply" onclick="aiApplyCategory('${type}','${match}')">Use</button>` : `<span class="ai-cat-applied"><i class="fas fa-check"></i> Applied</span>`}
      <button class="ai-cat-dismiss" onclick="aiDismissBadge('${type}')" title="Dismiss"><i class="fas fa-times"></i></button>
    </div>
  `;
}

function aiApplyCategory(type, category) {
  const selectEl = document.getElementById(`${type}Category`);
  const descEl = document.getElementById(`${type}Desc`);
  const state = _getAiCatState(type);
  if (selectEl) selectEl.value = category;
  state.acceptedCategory = category;
  state.acceptedDesc = descEl?.value.trim() || "";
  _showAiBadge(type, category, state.acceptedDesc, true);
}

function aiDismissBadge(type) {
  const descEl = document.getElementById(`${type}Desc`);
  _aiCatDismissed[type] = descEl?.value.trim() || "";
  _clearAiSuggestion(type);
}

function aiCategorySelectionChanged(type) {
  const descEl = document.getElementById(`${type}Desc`);
  const selectEl = document.getElementById(`${type}Category`);
  const state = _getAiCatState(type);
  const desc = descEl?.value.trim() || "";

  if (
    state.acceptedCategory &&
    selectEl &&
    selectEl.value !== state.acceptedCategory
  ) {
    state.acceptedCategory = "";
    state.acceptedDesc = "";
  }

  if (desc) _aiCatDismissed[type] = desc;
  _clearAiSuggestion(type);
}

function resetAiCatBadge(type) {
  clearTimeout(_aiCatTimers[type]);
  _aiCatGeneration[type] = (_aiCatGeneration[type] || 0) + 1;
  _aiCatDismissed[type] = "";
  _aiCatState[type] = {
    suggestedCategory: "",
    suggestedDesc: "",
    acceptedCategory: "",
    acceptedDesc: "",
  };
  const badgeEl = document.getElementById(`${type}AiBadge`);
  if (badgeEl) {
    badgeEl.style.display = "none";
    badgeEl.dataset.lastDesc = "";
    badgeEl.dataset.suggestedMatch = "";
  }
}
