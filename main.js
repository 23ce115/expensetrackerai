/* ═══════════════════════════════════════════════════════════════
   main.js — BlueLedger Bootstrap (thin wiring layer)

   PURPOSE: Wire up event listeners and fire the initial render
   after all scripts have loaded. Nothing else.

   DOES NOT DECLARE any variable or function that script.js
   already declares. With script.js loaded before main.js,
   all app state (transactions, chartPeriod, notify, etc.)
   is already on the global scope.

   Load order:
     1. Chart.js CDN
     2. utils.js
     3. ai.js
     4. voice.js
     5. receipt.js
     6. charts.js   ← setChartPeriod, updateOverviewChart
     7. script.js   ← all app state, notify, refreshAll, etc.
     8. main.js     ← THIS FILE (runs last, wires everything)
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ══════════════════════════════════════════════════════════════
   BOOTSTRAP
   Called once after DOMContentLoaded.
   All globals from script.js and charts.js are available here.
   ══════════════════════════════════════════════════════════════ */

function _bootApp() {
  try {
    /* Cursor gradient effect */
    document.addEventListener(
      "mousemove",
      (e) => {
        document.body.style.setProperty("--x", e.clientX + "px");
        document.body.style.setProperty("--y", e.clientY + "px");
      },
      { passive: true },
    );

    /* Wire up Ask BlueLedger overlay close */
    const askBlOverlay = safeGet("askBlOverlay");
    if (askBlOverlay) {
      askBlOverlay.addEventListener("click", () => {
        if (typeof closeAskBl === "function") closeAskBl();
      });
    }

    /* Wire up Ask BlueLedger input — send on Enter */
    const askBlInput = safeGet("askBlInput");
    if (askBlInput) {
      askBlInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (typeof askBlSend === "function") askBlSend();
        }
      });
    }

    /* Wire description inputs to AI auto-category */
    ["income", "expense"].forEach((type) => {
      const descEl = safeGet(`${type}Desc`);
      if (descEl) {
        descEl.addEventListener("input", () => {
          if (typeof aiAutoCategory === "function")
            aiAutoCategory(type, descEl.value);
        });
      }
      const catEl = safeGet(`${type}Category`);
      if (catEl) {
        catEl.addEventListener("change", () => {
          if (typeof aiCategorySelectionChanged === "function")
            aiCategorySelectionChanged(type);
        });
      }
    });

    /* MONTH_NAMES: script.js now sets window.MONTH_NAMES first as a fallback,
       so this guard is a safe no-op in normal operation. Kept for resilience
       in case load order ever changes. */
    if (!window.MONTH_NAMES) {
      window.MONTH_NAMES = [
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
    }

    /* Expose category arrays if not already set by script.js */
    if (!window.BASE_INCOME_CATS) {
      window.BASE_INCOME_CATS = [
        "Salary",
        "Freelance",
        "Business",
        "Investment",
        "Insurance",
      ];
    }
    if (!window.BASE_EXPENSE_CATS) {
      window.BASE_EXPENSE_CATS = [
        "Food",
        "Entertainment",
        "Shopping",
        "Transport",
        "Health",
        "Investment",
      ];
    }

    /* Chart init is intentionally deferred to the window "load" event below.
       DOMContentLoaded fires before script.js (266 KB) has fully executed,
       so getChartData() is not yet on window at this point.
       The window.load listener is the safe place to init charts. */

    /* Register service worker safely */
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }

    console.info("BlueLedger main.js: bootstrap complete");
  } catch (e) {
    console.warn("BlueLedger main.js boot error:", e);
  }
}

/* ── Chart re-init guard on window load ─────────────────────── */
window.addEventListener("load", () => {
  document.body.style.setProperty("--x", "50%");
  document.body.style.setProperty("--y", "50%");

  /* ── Chart init (window.load = all scripts fully executed) ── */
  try {
    if (typeof initCategoryChart === "function") initCategoryChart();

    if (typeof initOverviewChart === "function") {
      initOverviewChart();
    }
    /* Give Chart.js one tick to register the canvas, then feed data */
    setTimeout(function () {
      try {
        const period =
          typeof chartPeriod !== "undefined" ? chartPeriod : "monthly";
        if (typeof updateOverviewChart === "function")
          updateOverviewChart(period);
        if (typeof setChartPeriod === "function") setChartPeriod(period);
      } catch (e) {
        console.error("Chart data update failed:", e);
      }
    }, 0);
  } catch (e) {
    console.error("Chart init failed on load:", e);
  }
});

/* ── Fire bootstrap (guarded against double-fire) ──────────── */
if (typeof _BL_MAIN_BOOTED === "undefined") {
  var _BL_MAIN_BOOTED = false;
}
function _bootAppOnce() {
  if (_BL_MAIN_BOOTED) return;
  _BL_MAIN_BOOTED = true;
  _bootApp();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _bootAppOnce);
} else {
  _bootAppOnce();
}
