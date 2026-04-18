/* ═══════════════════════════════════════════════════════════════
   receipt.js — BlueLedger Receipt Scanner Module

   OWNS:
     openReceiptScanner(type)   — called from HTML onclick
     _processReceiptImage()     — internal Claude vision call

   DEPENDS ON (loaded before this file):
     ai.js  → window._callAI, window._getAiCategories
     utils.js → safeGet, safeNumber, notify/toast

   FIX APPLIED: _getAiCategories aliased from window._getAiCategories
   (ai.js exports it; receipt.js cannot use bare name across files)

   Load order:  utils.js → ai.js → voice.js → receipt.js → charts.js
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ── Alias _getAiCategories from ai.js ───────────────────────────
   FIX: receipt.js previously called _getAiCategories() as a bare
   name, but that function lives in ai.js. In strict-mode scripts
   loaded as separate files, bare names don't cross file boundaries.
   We resolve it via window._getAiCategories (set by ai.js line 1214).
   ─────────────────────────────────────────────────────────────── */
function _getAiCategories(type) {
  // Prefer the live version from ai.js if available
  if (
    typeof window._getAiCategories === "function" &&
    window._getAiCategories !== _getAiCategories
  ) {
    return window._getAiCategories(type);
  }
  // Fallback: build from base category arrays
  const custom =
    typeof customCategories !== "undefined" && Array.isArray(customCategories)
      ? customCategories
      : window.customCategories || [];
  if (type === "income") {
    return [
      ...(window.BASE_INCOME_CATS || [
        "Salary",
        "Freelance",
        "Business",
        "Investment",
        "Insurance",
      ]),
      ...custom,
      "Other",
    ];
  }
  return [
    ...(window.BASE_EXPENSE_CATS || [
      "Food",
      "Entertainment",
      "Shopping",
      "Transport",
      "Health",
      "Investment",
    ]),
    ...custom,
    "Other",
  ];
}

/* ── Module state ─────────────────────────────────────────────── */
let _receiptScanType = "expense"; // "income" | "expense"
let _receiptScanning = false;

/* ══════════════════════════════════════════════════════════════
   PUBLIC: openReceiptScanner
   Called from HTML: onclick="openReceiptScanner('expense')"
   ══════════════════════════════════════════════════════════════ */
function openReceiptScanner(type) {
  _receiptScanType = type || "expense";

  // Reuse the hidden file input if it exists, else create one
  let fileInput = document.getElementById("receiptFileInput");
  if (!fileInput) {
    fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.id = "receiptFileInput";
    fileInput.accept = "image/*";
    fileInput.capture = "environment"; // prefer rear camera on mobile
    fileInput.style.display = "none";
    document.body.appendChild(fileInput);

    fileInput.addEventListener("change", function () {
      const file = fileInput.files && fileInput.files[0];
      if (file) _processReceiptImage(file, _receiptScanType);
      // Reset so same file can be re-selected
      fileInput.value = "";
    });
  }

  fileInput.click();
}

/* ══════════════════════════════════════════════════════════════
   INTERNAL: _processReceiptImage
   Converts image to base64 → sends to Claude vision API →
   auto-fills the transaction form fields.
   ══════════════════════════════════════════════════════════════ */
async function _processReceiptImage(file, type) {
  if (_receiptScanning) return;
  _receiptScanning = true;

  // Show scanning indicator
  const btnId = type === "income" ? "incomeReceiptBtn" : "expenseReceiptBtn";
  const btnEl = safeGet(btnId);
  const origHTML = btnEl ? btnEl.innerHTML : "";
  if (btnEl) btnEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i>`;

  try {
    // 1. Convert file to base64
    const base64 = await _fileToBase64(file);
    const mediaType = file.type || "image/jpeg";

    // 2. Build allowed categories list
    const allowedCats = _getAiCategories(type);

    // 3. Call Claude vision via the shared _callAI helper in ai.js
    const callAI = window._callAI;
    if (typeof callAI !== "function") {
      _receiptNotify("AI module not loaded. Please refresh the page.", "error");
      return;
    }

    const systemPrompt = `You are a receipt parser for a personal finance app.
Extract transaction details from the receipt image and return ONLY a JSON object with these fields:
{
  "amount": <number, positive, no currency symbol>,
  "description": "<merchant name or item description, max 40 chars>",
  "category": "<one of: ${allowedCats.join(", ")}>",
  "date": "<YYYY-MM-DD format, today if unclear>"
}
Rules:
- amount must be a positive number (the total paid)
- category must be exactly one value from the list above
- date must be YYYY-MM-DD
- Return ONLY the JSON object, no explanation, no markdown fences`;

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          {
            type: "text",
            text: "Parse this receipt and return the JSON object.",
          },
        ],
      },
    ];

    // Use the extended vision call (max 500 tokens is plenty for JSON)
    const raw = await callAI(messages, systemPrompt, 500);

    // 4. Parse the response
    const parsed =
      typeof extractJsonFromText === "function"
        ? extractJsonFromText(raw)
        : _safeParseReceiptJson(raw);

    if (!parsed || typeof parsed.amount !== "number") {
      _receiptNotify(
        "Couldn't read the receipt. Please fill in manually.",
        "warn",
      );
      return;
    }

    // 5. Fill the form
    _fillTransactionForm(type, parsed);
    _receiptNotify(
      `Receipt scanned! ₹${safeNumber(parsed.amount).toLocaleString("en-IN")} — ${parsed.description || ""}`,
      "success",
    );
  } catch (err) {
    console.error("receipt.js: scan failed", err);
    _receiptNotify("Receipt scan failed. Please try again.", "error");
  } finally {
    _receiptScanning = false;
    if (btnEl) btnEl.innerHTML = origHTML;
  }
}

/* ── Helpers ─────────────────────────────────────────────────── */

function _fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    const reader = new FileReader();
    reader.onload = function () {
      resolve(reader.result.split(",")[1]);
    };
    reader.onerror = function () {
      reject(new Error("File read failed"));
    };
    reader.readAsDataURL(file);
  });
}

function _safeParseReceiptJson(raw) {
  try {
    const clean = String(raw || "")
      .replace(/```json|```/g, "")
      .trim();
    return JSON.parse(clean);
  } catch {
    try {
      const match = String(raw || "").match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : null;
    } catch {
      return null;
    }
  }
}

function _fillTransactionForm(type, data) {
  // amount
  const amtEl = document.getElementById(type + "Amount");
  if (amtEl && data.amount) amtEl.value = Math.abs(data.amount);

  // description
  const descEl = document.getElementById(type + "Desc");
  if (descEl && data.description) descEl.value = data.description;

  // category
  const catEl = document.getElementById(type + "Category");
  if (catEl && data.category) {
    // Only set if option exists in the <select>
    const opts = Array.from(catEl.options).map((o) => o.value);
    if (opts.includes(data.category)) catEl.value = data.category;
  }

  // date
  const dateEl = document.getElementById(type + "Date");
  if (dateEl && data.date && /^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    dateEl.value = data.date;
  }

  // Trigger AI auto-category in case description changed
  if (typeof aiAutoCategory === "function" && descEl) {
    aiAutoCategory(type, descEl.value);
  }
}

function _receiptNotify(msg, type) {
  if (typeof notify === "function") {
    notify(msg, type);
    return;
  }
  if (typeof toast === "function") {
    toast(msg, type);
    return;
  }
  console.info("[receipt]", msg);
}

/* ── Global exposure ─────────────────────────────────────────── */
window.openReceiptScanner = openReceiptScanner;
window._getAiCategories = window._getAiCategories || _getAiCategories; // don't overwrite ai.js version
