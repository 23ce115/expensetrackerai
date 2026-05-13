/* ═══════════════════════════════════════════════════════════════
   ai-assistant-db-patch.js  — Cloud persistence for AI Assistant
   ───────────────────────────────────────────────────────────────
   Load AFTER ai-assistant.js.
   Replaces the localStorage-based _loadReports / _saveReports /
   _loadPins / _savePins / _saveReport / _deleteReport /
   _addPin / _deletePin functions with Supabase equivalents.

   Also patches _renderSidebar() to be async-safe by using a
   local in-memory cache that is refreshed from Supabase.

   NO changes to CSS or DOM structure.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

(function () {
  /* ── In-memory caches (kept warm so _renderSidebar stays sync) */
  let _cachedReports = [];
  let _cachedPins = [];
  let _cacheLoaded = false;

  /* ── Ensure BL_DB is ready ──────────────────────────────── */
  function _db() {
    return window.BL_DB || null;
  }

  /* ══════════════════════════════════════════════════════════
     CACHE REFRESH  (called on open + after mutations)
     ══════════════════════════════════════════════════════════ */

  async function _refreshCache() {
    const db = _db();
    if (!db) return;
    try {
      const [reports, pins] = await Promise.all([
        db.getReports(20),
        db.getPins(12),
      ]);
      _cachedReports = Array.isArray(reports) ? reports : [];
      _cachedPins = Array.isArray(pins) ? pins : [];
      _cacheLoaded = true;
    } catch (err) {
      console.warn("[AIA-patch] Cache refresh failed:", err.message);
      /* Fall through — cached data still usable */
    }
  }

  /* ══════════════════════════════════════════════════════════
     REPLACE REPORT PERSISTENCE
     ══════════════════════════════════════════════════════════ */

  /* Old _loadReports() — now returns cached Supabase data */
  window._loadReports = function () {
    return _cachedReports.map((r) => ({
      id: r.id,
      title: r.report_title,
      month: r.month_label || "",
      score: r.financial_score,
      grade: r.grade || "",
      color: _scoreColor(r.financial_score),
      ts: r.created_at,
      tsDisplay: new Date(r.created_at).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      }),
    }));
  };

  /* Old _saveReport(headline, score, grade, color) */
  window._saveReport = async function (headline, score, grade /*, color */) {
    const db = _db();
    if (!db) return;
    const now = new Date();
    const monthLabel = now.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });

    try {
      await db.saveReport({
        report_title:
          headline.replace(/[⚠️✅📊📈]/g, "").trim() ||
          `${monthLabel} Analysis`,
        report_content: "", // caller can pass full markdown text as 5th arg if desired
        financial_score: score || 0,
        grade: grade || "",
        month_label: monthLabel,
      });
      await _refreshCache();
    } catch (err) {
      console.error("[AIA-patch] saveReport failed:", err.message);
      /* Graceful fallback: also persist locally */
      try {
        const local = JSON.parse(
          localStorage.getItem("bl_ai_reports_v4") || "[]",
        );
        local.unshift({
          id: "rpt_" + Date.now(),
          title: headline,
          month: monthLabel,
          score,
          grade,
          ts: now.toISOString(),
        });
        localStorage.setItem(
          "bl_ai_reports_v4",
          JSON.stringify(local.slice(0, 10)),
        );
      } catch (_) {}
    }
  };

  /* Old _deleteReport(id) */
  window._deleteReport = async function (id) {
    const db = _db();
    if (!db) {
      /* Fallback to localStorage */
      const local = JSON.parse(
        localStorage.getItem("bl_ai_reports_v4") || "[]",
      );
      localStorage.setItem(
        "bl_ai_reports_v4",
        JSON.stringify(local.filter((r) => r.id !== id)),
      );
      if (typeof _renderSidebar === "function") _renderSidebar();
      return;
    }
    try {
      await db.deleteReport(id);
      await _refreshCache();
      if (typeof _renderSidebar === "function") _renderSidebar();
    } catch (err) {
      console.error("[AIA-patch] deleteReport failed:", err.message);
    }
  };

  /* ══════════════════════════════════════════════════════════
     REPLACE PIN PERSISTENCE
     ══════════════════════════════════════════════════════════ */

  window._loadPins = function () {
    return _cachedPins.map((p) => ({
      id: p.id,
      text: p.insight_text,
      ts: p.pinned_at,
    }));
  };

  window._addPin = async function (text) {
    const db = _db();
    if (!db) {
      /* Fallback */
      const local = JSON.parse(localStorage.getItem("bl_ai_pins_v4") || "[]");
      local.unshift({
        id: "pin_" + Date.now(),
        text,
        ts: new Date().toISOString(),
      });
      localStorage.setItem("bl_ai_pins_v4", JSON.stringify(local.slice(0, 12)));
      return;
    }
    try {
      await db.addPin(text);
      await _refreshCache();
    } catch (err) {
      console.error("[AIA-patch] addPin failed:", err.message);
    }
  };

  window._deletePin = async function (id) {
    const db = _db();
    if (!db) {
      const local = JSON.parse(localStorage.getItem("bl_ai_pins_v4") || "[]");
      localStorage.setItem(
        "bl_ai_pins_v4",
        JSON.stringify(local.filter((p) => p.id !== id)),
      );
      if (typeof _renderSidebar === "function") _renderSidebar();
      return;
    }
    try {
      await db.deletePin(id);
      await _refreshCache();
      if (typeof _renderSidebar === "function") _renderSidebar();
    } catch (err) {
      console.error("[AIA-patch] deletePin failed:", err.message);
    }
  };

  /* ══════════════════════════════════════════════════════════
     PATCH openAIAssistant to refresh cache before rendering
     ══════════════════════════════════════════════════════════ */

  const _origOpen = window.openAIAssistant;
  window.openAIAssistant = async function () {
    if (!_cacheLoaded) await _refreshCache();
    if (typeof _origOpen === "function") _origOpen();
    /* Re-render sidebar after async data loads */
    _refreshCache().then(() => {
      if (typeof _renderSidebar === "function") _renderSidebar();
    });
  };

  /* ══════════════════════════════════════════════════════════
     PATCH aiaPinInsights — was sync, now async
     ══════════════════════════════════════════════════════════ */

  window.aiaPinInsights = async function () {
    if (typeof generateLocalInsights !== "function") return;
    const ins = generateLocalInsights();
    for (const i of ins.slice(0, 3)) {
      await window._addPin(i.title);
    }
    if (typeof _renderSidebar === "function") _renderSidebar();
    if (typeof toast === "function")
      toast("Insights pinned to sidebar", "success");
  };

  /* ══════════════════════════════════════════════════════════
     SIDEBAR collapse state — keep in localStorage (UI only)
     ══════════════════════════════════════════════════════════ */
  /* No change needed — BL_SIDEBAR_KEY remains in localStorage
     per spec. Nothing to patch. */

  /* ══════════════════════════════════════════════════════════
     UTILITY
     ══════════════════════════════════════════════════════════ */

  function _scoreColor(s) {
    if (!s) return "#64748b";
    if (s >= 85) return "#10b981";
    if (s >= 70) return "#34d399";
    if (s >= 55) return "#fbbf24";
    if (s >= 40) return "#f97316";
    return "#ef4444";
  }

  /* ══════════════════════════════════════════════════════════
     AUTO-INIT: load cache when user is already signed in
     ══════════════════════════════════════════════════════════ */

  async function _init() {
    if (!_db()) {
      /* Retry until BL_DB is ready */
      setTimeout(_init, 500);
      return;
    }
    const uid = await _db().getCurrentUserId();
    if (uid) {
      await _refreshCache();
      console.info(
        "[AIA-patch] Cloud persistence active. Reports:",
        _cachedReports.length,
        "Pins:",
        _cachedPins.length,
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }

  console.info("[AIA-patch] ai-assistant-db-patch.js loaded.");
})();
