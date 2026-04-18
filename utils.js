/* ═══════════════════════════════════════════════════════════════
   utils.js — BlueLedger Core Safety Layer
   All DOM operations MUST go through these helpers.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ── DOM Safety Helpers ──────────────────────────────────────── */

/**
 * Safe getElementById — never throws, returns null if not found.
 * @param {string} id
 * @returns {HTMLElement|null}
 */
function safeGet(id) {
  if (!id || typeof id !== "string") return null;
  return document.getElementById(id) || null;
}

/**
 * Add a CSS class to an element safely.
 * @param {HTMLElement|null} el
 * @param {string} className
 */
function safeAddClass(el, className) {
  if (el && className && el.classList) {
    el.classList.add(className);
  }
}

/**
 * Remove a CSS class from an element safely.
 * @param {HTMLElement|null} el
 * @param {string} className
 */
function safeRemoveClass(el, className) {
  if (el && className && el.classList) {
    el.classList.remove(className);
  }
}

/**
 * Toggle a CSS class on an element safely.
 * @param {HTMLElement|null} el
 * @param {string} className
 * @param {boolean} [condition] — if provided, force add/remove
 */
function safeToggleClass(el, className, condition) {
  if (el && className && el.classList) {
    if (typeof condition === "boolean") {
      el.classList.toggle(className, condition);
    } else {
      el.classList.toggle(className);
    }
  }
}

/**
 * Check if an element has a CSS class.
 * @param {HTMLElement|null} el
 * @param {string} className
 * @returns {boolean}
 */
function hasClass(el, className) {
  if (!el || !className || !el.classList) return false;
  return el.classList.contains(className);
}

/**
 * Safely set textContent on an element.
 * @param {HTMLElement|null} el
 * @param {string} text
 */
function safeSetText(el, text) {
  if (el) el.textContent = String(text ?? "");
}

/**
 * Safely set innerHTML on an element.
 * @param {HTMLElement|null} el
 * @param {string} html
 */
function safeSetHTML(el, html) {
  if (el) el.innerHTML = String(html ?? "");
}

/**
 * Safely get value from a form input element.
 * @param {HTMLElement|null} el
 * @returns {string}
 */
function safeGetValue(el) {
  if (!el) return "";
  return (el.value ?? "").toString().trim();
}

/**
 * Safely set value on a form input element.
 * @param {HTMLElement|null} el
 * @param {string|number} value
 */
function safeSetValue(el, value) {
  if (el) el.value = value ?? "";
}

/* ── String / Number Utilities ───────────────────────────────── */

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function safeText(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Format a number as Indian Rupees string.
 * @param {number} n
 * @returns {string}
 */
function formatINR(n) {
  const abs = Math.abs(n || 0);
  return "₹" + abs.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

/**
 * Return today's date as YYYY-MM-DD string.
 * @returns {string}
 */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Safe JSON parse — returns null on failure instead of throwing.
 * @param {string} raw
 * @returns {any|null}
 */
function safeJsonParse(raw) {
  try {
    if (!raw || typeof raw !== "string") return null;
    // Strip markdown fences if AI wrapped in them
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

/**
 * Extract first JSON object from a string even if surrounded by text.
 * @param {string} raw
 * @returns {any|null}
 */
function extractJsonFromText(raw) {
  if (!raw || typeof raw !== "string") return null;
  const parsed = safeJsonParse(raw);
  if (parsed) return parsed;
  // Try to find JSON block within the text
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) return safeJsonParse(match[0]);
  return null;
}

/**
 * Debounce a function call.
 * @param {Function} fn
 * @param {number} delay — milliseconds
 * @returns {Function}
 */
function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Convert basic Markdown to safe HTML (no XSS).
 * @param {string} text
 * @returns {string}
 */
function markdownToHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

/**
 * Notify the user with a toast. Looks for a global `notify` function
 * injected by main.js; no-ops safely if not yet available.
 * @param {string} msg
 * @param {"info"|"success"|"error"|"warn"} type
 */
function toast(msg, type = "info") {
  if (typeof notify === "function") {
    notify(msg, type);
  } else {
    console.info(`[${type.toUpperCase()}] ${msg}`);
  }
}

function safeNumber(n) {
  return typeof n === "number" && !isNaN(n) ? n : 0;
}

/* ── Expose to global scope ──────────────────────────────────── */
window.safeGet = safeGet;
window.safeAddClass = safeAddClass;
window.safeRemoveClass = safeRemoveClass;
window.safeToggleClass = safeToggleClass;
window.hasClass = hasClass;
window.safeSetText = safeSetText;
window.safeSetHTML = safeSetHTML;
window.safeGetValue = safeGetValue;
window.safeSetValue = safeSetValue;
window.safeText = safeText;
window.formatINR = formatINR;
window.todayStr = todayStr;
window.safeJsonParse = safeJsonParse;
window.extractJsonFromText = extractJsonFromText;
window.debounce = debounce;
window.markdownToHtml = markdownToHtml;
window.toast = toast;
