/* ═══════════════════════════════════════════════════════════════
   receipt.js — BlueLedger Receipt Scanner Module
   Handles: file input, base64 encode, AI vision parse, form fill.
   Depends on: utils.js, ai.js (must load first)
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ══════════════════════════════════════════════════════════════
   PUBLIC ENTRY POINT
   ══════════════════════════════════════════════════════════════ */

/**
 * Open the file picker and kick off receipt scanning.
 * @param {"income"|"expense"} type
 */
function openReceiptScanner(type) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.capture = "environment";

  input.onchange = (e) => {
    const file = e?.target?.files?.[0];
    if (file) _processReceiptImage(type, file);
  };

  input.click();
}

/* ══════════════════════════════════════════════════════════════
   IMAGE PROCESSING PIPELINE
   ══════════════════════════════════════════════════════════════ */

async function _processReceiptImage(type, file) {
  // Guard: file must be an image
  if (!file || !file.type.startsWith("image/")) {
    toast("Please select a valid image file.", "error");
    return;
  }

  const btn = safeGet(`${type}ReceiptBtn`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  }

  toast("Scanning receipt…", "info");

  try {
    /* ── Step 1: Convert to base64 ── */
    const base64 = await _fileToBase64(file);
    const mediaType = file.type || "image/jpeg";

    /* ── Step 2: Build category list ── */
    const cats = _getAiCategories(type);

    /* ── Step 3: Build prompt ── */
    const system =
      `You are a receipt scanner for an Indian personal finance app.\n` +
      `Extract transaction data from this receipt image and return ONLY valid JSON:\n` +
      `{"amount":450,"description":"Coffee and snacks","category":"Food","date":"2025-04-03","notes":"Any relevant extra detail"}\n` +
      `Rules:\n` +
      `- amount is total paid in rupees as a number (no symbol). If unclear, use null.\n` +
      `- description: concise merchant + item summary.\n` +
      `- category must be exactly one from: ${cats.join(", ")}\n` +
      `- date: ISO format YYYY-MM-DD if visible, otherwise null.\n` +
      `- notes: any useful extra detail (items, GST, etc.) or empty string.\n` +
      `- Return ONLY the JSON, no explanation or markdown.`;

    /* ── Step 4: Call AI vision API ── */
    throw new Error("AI disabled: backend required", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: window.AI_MODEL || "claude-sonnet-4-20250514",
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

    if (!response.ok) throw new Error(`API error: ${response.status}`);

    const data = await response.json();
    const text = data?.content?.[0]?.text;
    if (!text) throw new Error("Invalid AI response — no text returned");

    /* ── Step 5: Parse response (with fallback extraction) ── */
    const parsed = extractJsonFromText(text);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Could not parse receipt data from AI response");
    }

    /* ── Step 6: Validate parsed object ── */
    _validateReceiptData(parsed);

    /* ── Step 7: Populate form fields safely ── */
    _applyReceiptToForm(type, parsed);

    toast("Receipt scanned successfully!", "success");
  } catch (err) {
    console.error("Receipt scan error:", err);
    toast(`Failed to scan receipt: ${err.message || "Unknown error"}`, "error");
  } finally {
    // Always restore button state
    const restoreBtn = safeGet(`${type}ReceiptBtn`);
    if (restoreBtn) {
      restoreBtn.disabled = false;
      restoreBtn.innerHTML = '<i class="fas fa-camera"></i>';
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════ */

/**
 * Convert a File object to a base64 string (data portion only).
 * @param {File} file
 * @returns {Promise<string>}
 */
function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = reader.result;
      if (!result || typeof result !== "string") {
        reject(new Error("Empty file result"));
        return;
      }
      // Strip the data URI prefix "data:<mime>;base64,"
      const commaIdx = result.indexOf(",");
      if (commaIdx === -1) {
        reject(new Error("Malformed data URI"));
        return;
      }
      resolve(result.slice(commaIdx + 1));
    };

    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Basic validation of AI-parsed receipt object.
 * Throws if the object is clearly invalid.
 * @param {object} parsed
 */
function _validateReceiptData(parsed) {
  if (parsed.amount !== null && parsed.amount !== undefined) {
    const num = Number(parsed.amount);
    if (!Number.isFinite(num) || num < 0) {
      parsed.amount = null; // Reset invalid amount rather than crashing
    } else {
      parsed.amount = num;
    }
  }

  if (parsed.date) {
    // Validate ISO date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(parsed.date)) {
      parsed.date = null; // Silently discard malformed dates
    }
  }

  parsed.description = String(parsed.description || "").trim();
  parsed.category = String(parsed.category || "").trim();
  parsed.notes = String(parsed.notes || "").trim();
}

/**
 * Apply parsed receipt data to the transaction form.
 * @param {"income"|"expense"} type
 * @param {object} parsed
 */
function _applyReceiptToForm(type, parsed) {
  const amtEl = safeGet(`${type}Amount`);
  const descEl = safeGet(`${type}Desc`);
  const notesEl = safeGet(`${type}Notes`);
  const catEl = safeGet(`${type}Category`);
  const dateEl = safeGet(`${type}Date`);

  if (amtEl && parsed.amount != null) safeSetValue(amtEl, parsed.amount);
  if (descEl) safeSetValue(descEl, parsed.description || "");
  if (notesEl) safeSetValue(notesEl, parsed.notes || "");
  if (dateEl && parsed.date) safeSetValue(dateEl, parsed.date);

  if (catEl && parsed.category) {
    // Only apply if the category exists in the select options
    const options = Array.from(catEl.options || []).map((o) => o.value);
    if (options.includes(parsed.category)) {
      safeSetValue(catEl, parsed.category);
    }
  }

  // Trigger AI auto-category if description available but category not set
  if (parsed.description && (!parsed.category || !catEl?.value)) {
    if (typeof aiAutoCategory === "function") {
      aiAutoCategory(type, parsed.description);
    }
  }
}

/* ── Expose to global scope ──────────────────────────────────── */
window.openReceiptScanner = openReceiptScanner;
