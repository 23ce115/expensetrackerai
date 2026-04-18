/* ═══════════════════════════════════════════════════════════════
   ai.js — BlueLedger AI Module
   Handles: Anthropic API calls, auto-categorization,
            local keyword classifier, AskBL chat, AI Insights.
   Depends on: utils.js (must load first)
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ── Constants ───────────────────────────────────────────────── */
const AI_MODEL = "claude-sonnet-4-20250514";

/* ── Internal state ─────────────────────────────────────────── */
let _aiCatTimers = {};
let _aiCatGeneration = {};
let _aiCatDismissed = {};
let _aiCatState = {};
let _askBlHistory = [];
let _askBlBusy = false;
let _aiInsightsBusy = false;

/* ══════════════════════════════════════════════════════════════
   KEYWORD MAPS
   ══════════════════════════════════════════════════════════════ */
const _AI_KEYWORD_MAP = {
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
    "hbo",
    "apple tv",
    "jio",
    "sonyliv",
    "zee",
    "music",
    "stream",
  ],
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

/* ══════════════════════════════════════════════════════════════
   CORE API CALL
   ══════════════════════════════════════════════════════════════ */

/**
 * Shared Anthropic /v1/messages wrapper.
 * @param {Array}  messages
 * @param {string} systemPrompt
 * @param {number} [maxTokens=300]
 * @returns {Promise<string>}
 */
async function _callAI(messages, systemPrompt, maxTokens = 300) {
  /* ── Proxy route: browser → /api/ai (Vercel fn) → Anthropic ──
     Direct browser→Anthropic calls are blocked by CORS (by design).
     /api/ai holds the API key server-side and forwards the request.
     See /api/ai.js for setup instructions.
  ── */
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `AI API error ${res.status}`);
  }
  const data = await res.json();
  return (data.content || []).map((b) => b.text || "").join("") || "";
}

/* ══════════════════════════════════════════════════════════════
   CATEGORY HELPERS
   ══════════════════════════════════════════════════════════════ */

/**
 * Get allowed categories for a transaction type.
 * @param {"income"|"expense"} type
 * @returns {string[]}
 */
function _getAiCategories(type) {
  const custom =
    typeof customCategories !== "undefined" && Array.isArray(customCategories)
      ? customCategories
      : [];
  if (type === "income") {
    return [...(window.BASE_INCOME_CATS || []), ...custom, "Other"];
  }
  return [...(window.BASE_EXPENSE_CATS || []), ...custom, "Other"];
}

/**
 * Get or initialise per-type AI state object.
 * @param {"income"|"expense"} type
 * @returns {object}
 */
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
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "from",
    "this",
    "that",
    "your",
  ]);
  return [
    ...new Set(
      (
        String(text || "")
          .toLowerCase()
          .match(/[a-z0-9]+/g) || []
      ).filter((t) => t.length >= 3 && !stopWords.has(t)),
    ),
  ];
}

/**
 * Local keyword-based category guess — instant, no API call.
 * @param {"income"|"expense"} type
 * @param {string} desc
 * @returns {string|null}
 */
function _localKeywordGuess(type, desc) {
  if (!desc || desc.length < 2) return null;
  const lower = desc.toLowerCase();
  const allowed = new Set(_getAiCategories(type));
  const descTokens = _tokenizeAiText(desc);
  const scores = {};
  const strongest = {};

  // Keyword map match
  for (const [cat, keywords] of Object.entries(_AI_KEYWORD_MAP)) {
    if (!allowed.has(cat)) continue;
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        const phraseBonus = kw.includes(" ") ? 8 : 0;
        _addAiScore(scores, strongest, cat, kw.length + phraseBonus);
      }
    }
  }

  // Direct category name in description
  for (const cat of allowed) {
    const catLower = cat.toLowerCase();
    if (lower.includes(catLower)) {
      _addAiScore(scores, strongest, cat, catLower.length + 6);
    }
    const catTokens = _tokenizeAiText(cat);
    const overlap = catTokens.filter((t) => descTokens.includes(t)).length;
    if (overlap) _addAiScore(scores, strongest, cat, overlap * 5);

    for (const seed of _getCategorySeeds(cat)) {
      if (lower.includes(seed)) {
        _addAiScore(
          scores,
          strongest,
          cat,
          seed.length + (seed.includes(" ") ? 10 : 4),
        );
      }
    }
  }

  // Historical transaction match
  const txns =
    typeof transactions !== "undefined" && Array.isArray(transactions)
      ? transactions
      : [];
  for (const txn of txns.slice(0, 300)) {
    if (txn.type !== type || !allowed.has(txn.category)) continue;
    const txnDesc = (txn.description || "").trim();
    if (!txnDesc) continue;
    const txnLower = txnDesc.toLowerCase();
    const txnTokens = _tokenizeAiText(txnDesc);
    const overlap = txnTokens.filter((t) => descTokens.includes(t)).length;

    if (lower === txnLower) {
      _addAiScore(scores, strongest, txn.category, 40);
      continue;
    }
    if (lower.includes(txnLower) || txnLower.includes(lower)) {
      _addAiScore(scores, strongest, txn.category, 20);
    }
    if (overlap > 0) _addAiScore(scores, strongest, txn.category, overlap * 7);
  }

  if (!Object.keys(scores).length) return null;
  return Object.entries(scores).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return (strongest[b[0]] || 0) - (strongest[a[0]] || 0);
  })[0][0];
}

/* ══════════════════════════════════════════════════════════════
   AI BADGE RENDERING
   ══════════════════════════════════════════════════════════════ */

function _clearAiSuggestion(type) {
  const badgeEl = safeGet(`${type}AiBadge`);
  const state = _getAiCatState(type);
  state.suggestedCategory = "";
  state.suggestedDesc = "";
  if (badgeEl) {
    badgeEl.style.display = "none";
    badgeEl.dataset.lastDesc = "";
    badgeEl.dataset.suggestedMatch = "";
  }
}

function _showAiBadge(type, match, desc, isFinal) {
  const badgeEl = safeGet(`${type}AiBadge`);
  const selectEl = safeGet(`${type}Category`);
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
        <strong>${safeText(match)}</strong>
        ${!isFinal ? "<span class='ai-cat-pending'>AI is confirming...</span>" : ""}
      </div>
      <div class="ai-cat-help">${safeText(helperText)}</div>
    </div>
    <div class="ai-cat-actions">
      ${
        !isApplied
          ? `<button class="ai-cat-apply" onclick="aiApplyCategory('${type}','${safeText(match)}')">Use</button>`
          : `<span class="ai-cat-applied"><i class="fas fa-check"></i> Applied</span>`
      }
      <button class="ai-cat-dismiss" onclick="aiDismissBadge('${type}')" title="Dismiss">
        <i class="fas fa-times"></i>
      </button>
    </div>
  `;
}

/* ══════════════════════════════════════════════════════════════
   AUTO-CATEGORIZATION — PUBLIC API
   ══════════════════════════════════════════════════════════════ */

/**
 * Main entry point: called on every description keystroke.
 * Shows instant local guess, then debounces an AI call.
 * @param {"income"|"expense"} type
 * @param {string} value — current description input value
 */
function aiAutoCategory(type, value) {
  clearTimeout(_aiCatTimers[type]);
  const badgeEl = safeGet(`${type}AiBadge`);
  if (!badgeEl) return;

  const trimmed = value ? value.trim() : "";
  const state = _getAiCatState(type);

  // Reset accepted state if description changed
  if (state.acceptedDesc !== trimmed) {
    state.acceptedCategory = "";
    state.acceptedDesc = "";
  }

  if (!trimmed || trimmed.length < 3) {
    _aiCatDismissed[type] = "";
    _clearAiSuggestion(type);
    return;
  }

  // Do not re-show a dismissed suggestion for the same text
  if (_aiCatDismissed[type] === trimmed) return;

  _clearAiSuggestion(type);

  // Instant local guess
  const localGuess = _localKeywordGuess(type, trimmed);
  if (localGuess) {
    _showAiBadge(type, localGuess, trimmed, false);
  }

  // Debounced AI call (700 ms)
  _aiCatGeneration[type] = (_aiCatGeneration[type] || 0) + 1;
  const myGen = _aiCatGeneration[type];

  _aiCatTimers[type] = setTimeout(async () => {
    if (_aiCatGeneration[type] !== myGen) return;
    await _runAiCat(type, trimmed, myGen);
  }, 700);
}

async function _runAiCat(type, desc, generation) {
  const cats = _getAiCategories(type);
  const badgeEl = safeGet(`${type}AiBadge`);
  const selectEl = safeGet(`${type}Category`);
  if (!badgeEl || !selectEl) return;

  try {
    const system =
      `You are a financial transaction categorizer for an Indian personal finance app.\n` +
      `Given a transaction description, return ONLY the single best matching category name from the list.\n` +
      `Do not explain. Do not add punctuation. Return only the category name exactly as given.\n` +
      `Categories: ${cats.join(", ")}`;

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
    console.warn("AI categorization failed:", e);
  }
}

/**
 * Apply AI-suggested category to the select field.
 */
function aiApplyCategory(type, category) {
  const selectEl = safeGet(`${type}Category`);
  const descEl = safeGet(`${type}Desc`);
  const state = _getAiCatState(type);
  if (selectEl) selectEl.value = category;
  state.acceptedCategory = category;
  state.acceptedDesc = descEl ? safeGetValue(descEl) : "";
  _showAiBadge(type, category, state.acceptedDesc, true);
}

/**
 * Dismiss the AI badge for the current description text.
 */
function aiDismissBadge(type) {
  const descEl = safeGet(`${type}Desc`);
  _aiCatDismissed[type] = descEl ? safeGetValue(descEl) : "";
  _clearAiSuggestion(type);
}

/**
 * Called when user manually changes the category dropdown.
 */
function aiCategorySelectionChanged(type) {
  const descEl = safeGet(`${type}Desc`);
  const selectEl = safeGet(`${type}Category`);
  const state = _getAiCatState(type);
  const desc = descEl ? safeGetValue(descEl) : "";

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

/**
 * Full reset — call when opening/closing a modal form.
 */
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
  const badgeEl = safeGet(`${type}AiBadge`);
  if (badgeEl) {
    badgeEl.style.display = "none";
    badgeEl.dataset.lastDesc = "";
    badgeEl.dataset.suggestedMatch = "";
  }
}

/* ══════════════════════════════════════════════════════════════
   ASK BLUELEDGER — NL CHAT
   ══════════════════════════════════════════════════════════════ */

function openAskBl() {
  safeAddClass(safeGet("askBlPanel"), "ask-bl-panel--open");
  safeAddClass(safeGet("askBlOverlay"), "ask-bl-overlay--open");
  setTimeout(() => safeGet("askBlInput")?.focus(), 300);
}

function closeAskBl() {
  safeRemoveClass(safeGet("askBlPanel"), "ask-bl-panel--open");
  safeRemoveClass(safeGet("askBlOverlay"), "ask-bl-overlay--open");
}

function _buildFinanceSummary() {
  const txns =
    typeof transactions !== "undefined" && Array.isArray(transactions)
      ? transactions.slice(0, 300)
      : [];
  const now = new Date();
  const thisMonth = txns.filter((t) => {
    const d = new Date(t.date);
    return (
      d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
    );
  });

  const totalIncome = txns
    .filter((t) => t.type === "income")
    .reduce((s, t) => s + t.amount, 0);
  const totalExpense = txns
    .filter((t) => t.type === "expense")
    .reduce((s, t) => s + Math.abs(t.amount), 0);

  const catMap = {};
  txns.forEach((t) => {
    if (t.type !== "expense") return;
    catMap[t.category] = (catMap[t.category] || 0) + Math.abs(t.amount);
  });
  const catLines = Object.entries(catMap)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `  ${c}: ${formatINR(v)}`)
    .join("\n");

  const recent = txns
    .slice(0, 30)
    .map(
      (t) =>
        `${t.date} | ${t.type} | ${t.category} | ${t.description || "-"} | ${t.type === "income" ? "+" : "-"}${formatINR(t.amount)}`,
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
Total transactions available: ${txns.length}
Current month: ${now.toLocaleString("en-IN", { month: "long", year: "numeric" })}
This month income: ${formatINR(monthIncome)} | This month expenses: ${formatINR(monthExpense)}
All-time income: ${formatINR(totalIncome)} | All-time expenses: ${formatINR(totalExpense)}

Spending by category (all time):
${catLines || "  No expense data yet"}

Recent transactions (up to 30):
Date | Type | Category | Description | Amount
${recent || "  No transactions yet"}`;
}

async function askBlSend(prefill) {
  if (_askBlBusy) return;
  const inputEl = safeGet("askBlInput");
  const question = (prefill || (inputEl ? inputEl.value : "") || "").trim();
  if (!question) return;
  if (inputEl) inputEl.value = "";

  _appendAskBlMsg("user", safeText(question));
  _askBlHistory.push({ role: "user", content: question });

  const typingId = "askbl-typing-" + Date.now();
  _appendAskBlMsg(
    "assistant",
    `<span id="${typingId}" class="ask-bl-typing"><span></span><span></span><span></span></span>`,
  );

  _askBlBusy = true;
  const sendBtn = safeGet("askBlSendBtn");
  if (sendBtn) sendBtn.disabled = true;

  try {
    const system =
      `You are BlueLedger AI, a friendly and concise personal finance assistant.\n` +
      `The user's financial data is provided below. Answer directly using the data.\n` +
      `Be concise, warm, and use ₹ for amounts. Use emojis sparingly.\n` +
      `If the data is insufficient, say so honestly. Never invent transactions.\n\n` +
      _buildFinanceSummary();

    const reply = await _callAI(_askBlHistory, system, 400);

    safeGet(typingId)?.closest(".ask-bl-msg")?.remove();

    _askBlHistory.push({ role: "assistant", content: reply });
    if (_askBlHistory.length > 20) _askBlHistory = _askBlHistory.slice(-20);

    _appendAskBlMsg("assistant", markdownToHtml(reply));
  } catch (e) {
    safeGet(typingId)?.closest(".ask-bl-msg")?.remove();
    _appendAskBlMsg(
      "assistant",
      "Sorry, I couldn't connect to the AI right now. Please try again.",
    );
    console.warn("Ask BlueLedger failed:", e);
  } finally {
    _askBlBusy = false;
    const btn = safeGet("askBlSendBtn");
    if (btn) btn.disabled = false;
  }
}

function _appendAskBlMsg(role, html) {
  const container = safeGet("askBlMessages");
  if (!container) return;

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

/* ══════════════════════════════════════════════════════════════
   AI SPENDING INSIGHTS
   ══════════════════════════════════════════════════════════════ */

async function runAiInsights() {
  if (_aiInsightsBusy) return;
  _aiInsightsBusy = true;

  const btn = safeGet("aiInsightsBtn");
  const panel = safeGet("aiInsightsPanel");
  if (!panel) {
    _aiInsightsBusy = false;
    return;
  }

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
    const txns =
      typeof transactions !== "undefined" && Array.isArray(transactions)
        ? transactions
        : [];
    const now = new Date();

    const thisMonth = txns.filter((t) => {
      const d = new Date(t.date + "T00:00:00");
      return (
        d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      );
    });
    const lastMonth = txns.filter((t) => {
      const d = new Date(t.date + "T00:00:00");
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return (
        d.getFullYear() === lm.getFullYear() && d.getMonth() === lm.getMonth()
      );
    });

    const catTotals = {};
    const thisMonthCats = {};
    const lastMonthCats = {};

    txns
      .slice(0, 200)
      .filter((t) => t.type === "expense")
      .forEach((t) => {
        catTotals[t.category] =
          (catTotals[t.category] || 0) + Math.abs(t.amount);
      });
    thisMonth
      .filter((t) => t.type === "expense")
      .forEach((t) => {
        thisMonthCats[t.category] =
          (thisMonthCats[t.category] || 0) + Math.abs(t.amount);
      });
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

    const daysInMonth = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
    ).getDate();
    const daysLeft = daysInMonth - now.getDate();
    const spendingLimit =
      (typeof userData !== "undefined" && userData?.spendingLimit) || 0;

    const catCompare = Object.keys({ ...thisMonthCats, ...lastMonthCats })
      .map((cat) => {
        const cur = thisMonthCats[cat] || 0;
        const prev = lastMonthCats[cat] || 0;
        const diff = prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null;
        return `  ${cat}: this month ${formatINR(cur)}${prev > 0 ? `, last month ${formatINR(prev)}${diff !== null ? ` (${diff > 0 ? "+" : ""}${diff}%)` : ""}` : ""}`;
      })
      .join("\n");

    const recentTxns = txns
      .slice(0, 20)
      .map(
        (t) =>
          `  ${t.date} | ${t.type} | ${t.category} | ${t.description || "-"} | ${t.type === "income" ? "+" : "-"}${formatINR(t.amount)}`,
      )
      .join("\n");

    const dataContext = `Financial snapshot:
Current month: ${now.toLocaleString("en-IN", { month: "long", year: "numeric" })} (day ${now.getDate()} of ${daysInMonth}, ${daysLeft} days left)
This month income: ${formatINR(thisMonthIncome)} | expenses: ${formatINR(thisMonthExpense)}
Last month expenses: ${formatINR(lastMonthExpense)}
${spendingLimit > 0 ? `Monthly spending limit: ${formatINR(spendingLimit)} (${Math.round((thisMonthExpense / spendingLimit) * 100)}% used)` : "No spending limit set"}
Total transactions: ${txns.length}

Category comparison (this month vs last month):
${catCompare || "  Not enough data"}

Recent 20 transactions:
${recentTxns || "  None yet"}`;

    const system =
      `You are BlueLedger AI, an expert personal finance advisor for an Indian user.\n` +
      `Analyse the spending data and provide a concise, actionable, warm financial advice report.\n\n` +
      `Structure your response EXACTLY as valid JSON (no markdown fences) with this shape:\n` +
      `{"summary":"One sentence overall assessment","prediction":{"amount":12500,"reasoning":"Brief reason"},"tips":[{"icon":"fa-fire","color":"#ef4444","title":"Short title","body":"Specific advice"}],"alerts":[{"title":"Anomaly title","body":"Explanation"}]}\n\n` +
      `Rules:\n- prediction.amount is an integer in rupees\n- Generate 2-4 tips specific to this user's data\n- Generate 0-3 alerts only for genuinely unusual patterns\n- Use ₹ for amounts, Indian formatting\n- Return ONLY the JSON object.`;

    const raw = await _callAI(
      [{ role: "user", content: dataContext }],
      system,
      800,
    );
    const parsed = extractJsonFromText(raw);
    if (!parsed) throw new Error("Could not parse AI insights response");

    const alertsHtml = (Array.isArray(parsed.alerts) ? parsed.alerts : [])
      .map(
        (a) => `
      <div class="ai-alert-item">
        <i class="fas fa-exclamation-triangle" style="color:#f59e0b;flex-shrink:0;margin-top:.15rem"></i>
        <div><div class="ai-alert-title">${safeText(a.title)}</div><div class="ai-alert-body">${safeText(a.body)}</div></div>
      </div>`,
      )
      .join("");

    const tipsHtml = (Array.isArray(parsed.tips) ? parsed.tips : [])
      .map(
        (t) => `
      <div class="ai-tip-card">
        <div class="ai-tip-icon" style="background:${safeText(t.color)}22;color:${safeText(t.color)}"><i class="fas ${safeText(t.icon)}"></i></div>
        <div><div class="ai-tip-title">${safeText(t.title)}</div><div class="ai-tip-body">${safeText(t.body)}</div></div>
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
      ? `<div class="ai-prediction-row">
           <div class="ai-prediction-label"><i class="fas fa-chart-line" style="color:${predColor}"></i> AI Month-end Prediction</div>
           <div class="ai-prediction-amount" style="color:${predColor}">${formatINR(predAmt)}</div>
           <div class="ai-prediction-reason">${safeText(parsed.prediction.reasoning)}</div>
         </div>`
      : "";

    panel.innerHTML = `
      <div class="ai-insights-result">
        <div class="ai-insights-summary">
          <i class="fas fa-robot" style="color:#a78bfa;flex-shrink:0"></i>
          <span>${safeText(parsed.summary)}</span>
        </div>
        ${predHtml}
        ${alertsHtml ? `<div class="ai-alerts-section">${alertsHtml}</div>` : ""}
        <div class="ai-tips-grid">${tipsHtml}</div>
        <div class="ai-insights-footer">
          <button class="ai-refresh-btn" onclick="runAiInsights()"><i class="fas fa-rotate-right"></i> Refresh</button>
          <button class="ai-dismiss-btn" onclick="safeGet('aiInsightsPanel').style.display='none'"><i class="fas fa-times"></i> Dismiss</button>
        </div>
      </div>`;
  } catch (e) {
    if (panel) {
      panel.innerHTML = `<div class="ai-insights-error"><i class="fas fa-circle-exclamation" style="color:#ef4444"></i> Could not load AI insights. Check your connection and try again.</div>`;
    }
    console.warn("AI insights failed:", e);
  } finally {
    _aiInsightsBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> AI Advice';
    }
  }
}

/* ── Expose to global scope ──────────────────────────────────── */
window._callAI = _callAI;
window._getAiCategories = _getAiCategories;
window._getAiCatState = _getAiCatState;
window._localKeywordGuess = _localKeywordGuess;
window.aiAutoCategory = aiAutoCategory;
window.aiApplyCategory = aiApplyCategory;
window.aiDismissBadge = aiDismissBadge;
window.aiCategorySelectionChanged = aiCategorySelectionChanged;
window.resetAiCatBadge = resetAiCatBadge;
window.openAskBl = openAskBl;
window.closeAskBl = closeAskBl;
window.askBlSend = askBlSend;
window.runAiInsights = runAiInsights;
