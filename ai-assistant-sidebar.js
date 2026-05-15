/* ═══════════════════════════════════════════════════════════════
   ai-assistant-sidebar-patch.js  — Sidebar redesign
   ───────────────────────────────────────────────────────────────
   Load AFTER ai-assistant.js (and ai-assistant-db-patch.js).

   What this replaces / extends:
   1. _buildPage()       → rewrites the sidebar HTML block only
   2. _renderSidebar()   → score dot + sparkline + subtitle line,
                           search filter, per-pin delete
   3. Adds              → aiaToggleSettingsDropdown(),
                           aiaSettingsAction(), _aiaClearHistory(),
                           sidebar search wiring
   ═══════════════════════════════════════════════════════════════ */

"use strict";

(function () {
  /* ══════════════════════════════════════════════════════════════
     HELPERS
     ══════════════════════════════════════════════════════════════ */

  function _scoreColor(s) {
    if (!s && s !== 0) return "#64748b";
    if (s >= 85) return "#10b981";
    if (s >= 70) return "#34d399";
    if (s >= 55) return "#fbbf24";
    if (s >= 40) return "#f97316";
    return "#ef4444";
  }

  function _gradeLabel(s) {
    if (!s && s !== 0) return "N/A";
    if (s >= 85) return "Excellent";
    if (s >= 70) return "Good";
    if (s >= 55) return "Fair";
    if (s >= 40) return "Weak";
    return "Poor";
  }

  /* Fake sparkline heights from score value — 5 bars, last = current */
  function _sparkBars(score, color) {
    if (!score) return "";
    const jitter = (i) =>
      Math.max(4, Math.round(score * 0.18 + ((i * 1.7) % 8)));
    const bars = [0, 1, 2, 3]
      .map(
        (i) =>
          `<div class="aia-sb-spark-bar" style="height:${jitter(i)}px"></div>`,
      )
      .join("");
    const topBar = `<div class="aia-sb-spark-bar aia-sb-spark-bar--top" style="height:20px;background:${color}80"></div>`;
    return `<div class="aia-sb-spark">${bars}${topBar}</div>`;
  }

  /* Active currency label for dropdown subtitle */
  function _currencyLabel() {
    const code = localStorage.getItem("bl_currency") || "INR";
    const symbols = {
      INR: "₹",
      USD: "$",
      EUR: "€",
      GBP: "£",
      JPY: "¥",
      AUD: "A$",
      CAD: "C$",
      SGD: "S$",
    };
    return `${code} (${symbols[code] || code})`;
  }

  /* ══════════════════════════════════════════════════════════════
     PATCH _buildPage — replace sidebar inner HTML only
     ══════════════════════════════════════════════════════════════ */

  const _origBuildPage = window._buildPage;

  /* We patch by wrapping openAIAssistant so _buildPage runs first,
     then we replace the sidebar subtree before anything renders. */
  function _rewriteSidebar() {
    const sb = document.getElementById("aiaSidebar");
    if (!sb || sb.dataset.patched === "1") return;
    sb.dataset.patched = "1";

    sb.innerHTML = `

      <!-- Brand bar -->
      <div class="aia-sb-brand">
        <div class="aia-sb-brand-icon">
          <i class="ti ti-brain"></i>
        </div>
        <span class="aia-sb-text aia-sb-brand-label">BlueLedger AI</span>
        <button class="aia-sb-collapse-btn" onclick="aiaToggleSidebar()" title="Collapse sidebar" aria-label="Collapse sidebar">
          <i class="ti ti-chevron-left" id="aiaCollapseIcon"></i>
        </button>
      </div>

      <!-- Search -->
      <div class="aia-sb-search aia-sb-text">
        <i class="ti ti-search" aria-hidden="true"></i>
        <input
          class="aia-sb-search-input"
          id="aiaSbSearch"
          type="search"
          placeholder="Search reports..."
          autocomplete="off"
          aria-label="Search saved reports"
        >
      </div>

      <!-- New Analysis -->
      <button class="aia-sb-new-btn" onclick="aiaSetMode('analysis');_renderAnalysis();" aria-label="New analysis">
        <i class="ti ti-plus" aria-hidden="true"></i>
        <span class="aia-sb-text">New Analysis</span>
      </button>

      <!-- Recent Reports -->
      <div class="aia-sb-section aia-sb-text">
        <i class="ti ti-file-analytics" aria-hidden="true"></i>
        Recent Reports
      </div>
      <div class="aia-sb-list" id="aiaSbReports" role="list" aria-label="Saved reports"></div>

      <!-- Pinned Insights -->
      <div class="aia-sb-section aia-sb-text">
        <i class="ti ti-pin" aria-hidden="true"></i>
        Pinned Insights
      </div>
      <div class="aia-sb-list" id="aiaSbPins" role="list" aria-label="Pinned insights"></div>

      <!-- Bottom: Settings only -->
      <div class="aia-sb-bottom">

        <!-- Settings dropdown (opens above) -->
        <div class="aia-sb-dropdown" id="aiaSettingsDropdown" role="menu" aria-label="AI assistant settings">

          <div class="aia-sb-dd-header">AI Assistant</div>

          <div class="aia-sb-dd-item" role="menuitem" tabindex="0"
               onclick="aiaSettingsAction('appearance')"
               onkeydown="if(event.key==='Enter')aiaSettingsAction('appearance')">
            <div class="aia-sb-dd-icon aia-sb-dd-icon--purple">
              <i class="ti ti-moon" aria-hidden="true"></i>
            </div>
            <div class="aia-sb-dd-body">
              <div class="aia-sb-dd-label">Appearance</div>
              <div class="aia-sb-dd-sub">Dark mode · Light mode</div>
            </div>
          </div>

          <div class="aia-sb-dd-item" role="menuitem" tabindex="0"
               onclick="aiaSettingsAction('currency')"
               onkeydown="if(event.key==='Enter')aiaSettingsAction('currency')">
            <div class="aia-sb-dd-icon aia-sb-dd-icon--teal">
              <i class="ti ti-currency-rupee" aria-hidden="true"></i>
            </div>
            <div class="aia-sb-dd-body">
              <div class="aia-sb-dd-label">Currency</div>
              <div class="aia-sb-dd-sub" id="aiaDdCurrencySub">Currently: ${_currencyLabel()}</div>
            </div>
          </div>

          <div class="aia-sb-dd-item" role="menuitem" tabindex="0"
               onclick="aiaSettingsAction('export')"
               onkeydown="if(event.key==='Enter')aiaSettingsAction('export')">
            <div class="aia-sb-dd-icon aia-sb-dd-icon--amber">
              <i class="ti ti-download" aria-hidden="true"></i>
            </div>
            <div class="aia-sb-dd-body">
              <div class="aia-sb-dd-label">Export report</div>
              <div class="aia-sb-dd-sub">CSV or JSON</div>
            </div>
          </div>

          <div class="aia-sb-dd-item aia-sb-dd-item--danger" id="aiaDdClear"
               role="menuitem" tabindex="0"
               onclick="aiaSettingsAction('clear')"
               onkeydown="if(event.key==='Enter')aiaSettingsAction('clear')">
            <div class="aia-sb-dd-icon">
              <i class="ti ti-trash" aria-hidden="true"></i>
            </div>
            <div class="aia-sb-dd-body">
              <div class="aia-sb-dd-label">Clear history</div>
              <div class="aia-sb-dd-sub">Remove all saved reports</div>
            </div>
          </div>

          <div class="aia-sb-dd-item aia-sb-dd-item--more" role="menuitem" tabindex="0"
               onclick="aiaSettingsAction('more')"
               onkeydown="if(event.key==='Enter')aiaSettingsAction('more')">
            <div class="aia-sb-dd-body">
              <div class="aia-sb-dd-label">More settings</div>
            </div>
            <i class="ti ti-arrow-right aia-sb-dd-chevron" aria-hidden="true"></i>
          </div>

        </div>

        <!-- Settings trigger button -->
        <button class="aia-sb-settings-btn"
                id="aiaSettingsBtn"
                onclick="aiaToggleSettingsDropdown()"
                aria-haspopup="true"
                aria-expanded="false"
                aria-controls="aiaSettingsDropdown">
          <i class="ti ti-settings" aria-hidden="true"></i>
          <span class="aia-sb-text">Settings</span>
        </button>

      </div>
    `;

    /* Wire search input */
    const searchInput = document.getElementById("aiaSbSearch");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        _renderSidebarReports(searchInput.value.trim().toLowerCase());
      });
    }

    /* Close dropdown on outside click */
    document.addEventListener(
      "click",
      (e) => {
        const dd = document.getElementById("aiaSettingsDropdown");
        const btn = document.getElementById("aiaSettingsBtn");
        if (!dd || !btn) return;
        if (!dd.contains(e.target) && !btn.contains(e.target)) {
          _closeSettingsDropdown();
        }
      },
      true,
    );

    /* Close dropdown on Escape */
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") _closeSettingsDropdown();
    });
  }

  /* ══════════════════════════════════════════════════════════════
     SETTINGS DROPDOWN TOGGLE
     ══════════════════════════════════════════════════════════════ */

  function _closeSettingsDropdown() {
    const dd = document.getElementById("aiaSettingsDropdown");
    const btn = document.getElementById("aiaSettingsBtn");
    if (dd) dd.classList.remove("open");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  window.aiaToggleSettingsDropdown = function () {
    const dd = document.getElementById("aiaSettingsDropdown");
    const btn = document.getElementById("aiaSettingsBtn");
    if (!dd) return;
    const isOpen = dd.classList.toggle("open");
    if (btn) btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    /* Refresh currency label each open in case it changed */
    const sub = document.getElementById("aiaDdCurrencySub");
    if (sub) sub.textContent = "Currently: " + _currencyLabel();
  };

  /* ══════════════════════════════════════════════════════════════
     SETTINGS ACTIONS
     ══════════════════════════════════════════════════════════════ */

  let _clearConfirmTimer = null;

  window.aiaSettingsAction = function (action) {
    if (action !== "clear") _closeSettingsDropdown();

    switch (action) {
      case "appearance":
        if (typeof openAppearanceModal === "function") openAppearanceModal();
        break;

      case "currency":
        if (typeof openCurrencyModal === "function") openCurrencyModal();
        break;

      case "export":
        if (typeof openExportModal === "function") openExportModal();
        break;

      case "clear":
        _aiaClearHistory();
        break;

      case "more":
        /* Close AI overlay and open the main settings page */
        if (typeof closeAIAssistant === "function") closeAIAssistant();
        setTimeout(() => {
          const settingsBtn =
            document.querySelector("[onclick*='openSettings']") ||
            document.querySelector("[onclick*='settingsPage']") ||
            document.getElementById("settingsBtn");
          if (settingsBtn) settingsBtn.click();
        }, 200);
        break;
    }
  };

  function _aiaClearHistory() {
    const item = document.getElementById("aiaDdClear");
    if (!item) return;

    if (item.classList.contains("confirm")) {
      /* Second tap — actually clear */
      clearTimeout(_clearConfirmTimer);
      item.classList.remove("confirm");
      localStorage.removeItem("bl_ai_reports_v4");
      /* Also clear Supabase cache if patch is loaded */
      if (window.BL_DB) {
        /* Soft clear — just re-render; cloud data stays unless explicitly deleted */
      }
      _closeSettingsDropdown();
      if (typeof _renderSidebar === "function") _renderSidebar();
      if (typeof toast === "function") toast("Report history cleared", "info");
    } else {
      /* First tap — ask for confirmation */
      item.classList.add("confirm");
      _clearConfirmTimer = setTimeout(() => {
        item.classList.remove("confirm");
      }, 2500);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     REPLACE _renderSidebar
     ══════════════════════════════════════════════════════════════ */

  /* Render report rows, optionally filtered by search query */
  function _renderSidebarReports(query) {
    const rEl = document.getElementById("aiaSbReports");
    if (!rEl) return;

    let reports = typeof _loadReports === "function" ? _loadReports() : [];
    if (query) {
      reports = reports.filter((r) =>
        (r.title || "").toLowerCase().includes(query),
      );
    }

    if (!reports.length) {
      rEl.innerHTML = query
        ? `<div class="aia-sb-empty aia-sb-text">No reports match "${query}"</div>`
        : `<div class="aia-sb-empty aia-sb-text">Run an analysis to save a report</div>`;
      return;
    }

    rEl.innerHTML = reports
      .map((r) => {
        const score = r.score || 0;
        const color = _scoreColor(score);
        const grade = _gradeLabel(score);
        const dotStyle = `color:${color};border-color:${color}30;background:${color}12`;
        const spark = _sparkBars(score, color);

        return `
        <div class="aia-sb-report" role="listitem"
             onclick="aiaSetMode('analysis');_renderAnalysis();"
             title="${(r.title || "").replace(/"/g, "&quot;")}">
          <div class="aia-sb-score-dot" style="${dotStyle}">${score || "-"}</div>
          <div class="aia-sb-report-body">
            <div class="aia-sb-report-title">${safeText(r.title)}</div>
            <div class="aia-sb-report-subtitle">${grade} &middot; ${r.tsDisplay || ""}</div>
          </div>
          ${spark}
          <button class="aia-sb-del"
                  onclick="event.stopPropagation();_deleteReport('${r.id}')"
                  title="Delete report"
                  aria-label="Delete report">
            <i class="ti ti-x" aria-hidden="true"></i>
          </button>
        </div>`;
      })
      .join("");
  }

  function _renderSidebarPins() {
    const pEl = document.getElementById("aiaSbPins");
    if (!pEl) return;

    const pins = typeof _loadPins === "function" ? _loadPins() : [];
    if (!pins.length) {
      pEl.innerHTML = `<div class="aia-sb-empty aia-sb-text">Pin insights to keep them here</div>`;
      return;
    }

    pEl.innerHTML = pins
      .map(
        (p) => `
      <div class="aia-sb-pin" role="listitem">
        <i class="ti ti-pin aia-sb-pin-icon" aria-hidden="true"></i>
        <span class="aia-sb-pin-text aia-sb-text">${safeText(p.text)}</span>
        <button class="aia-sb-del"
                onclick="_deletePin('${p.id}')"
                title="Remove pin"
                aria-label="Remove pin">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </div>`,
      )
      .join("");
  }

  /* Override the global _renderSidebar */
  window._renderSidebar = function () {
    const query = (document.getElementById("aiaSbSearch")?.value || "")
      .trim()
      .toLowerCase();
    _renderSidebarReports(query);
    _renderSidebarPins();
  };

  /* ══════════════════════════════════════════════════════════════
     PATCH openAIAssistant to run sidebar rewrite after page build
     ══════════════════════════════════════════════════════════════ */

  const _prevOpenAIA = window.openAIAssistant;
  window.openAIAssistant = async function () {
    if (typeof _prevOpenAIA === "function") await _prevOpenAIA();
    _rewriteSidebar();
    if (typeof _renderSidebar === "function") _renderSidebar();
  };

  /* ══════════════════════════════════════════════════════════════
     PATCH aiaSetMode — swap FA icons for Tabler in topbar title
     ══════════════════════════════════════════════════════════════ */

  const _prevSetMode = window.aiaSetMode;
  window.aiaSetMode = function (mode) {
    if (typeof _prevSetMode === "function") _prevSetMode(mode);
    const ttl = document.getElementById("aiaTopTitle");
    if (!ttl) return;
    if (mode === "analysis") {
      ttl.innerHTML = `<i class="ti ti-chart-line" style="color:#818cf8;margin-right:.4rem" aria-hidden="true"></i>Financial Analysis`;
    } else {
      ttl.innerHTML = `<i class="ti ti-message-dots" style="color:#818cf8;margin-right:.4rem" aria-hidden="true"></i>AI Financial Chat`;
    }
  };

  console.info("[SB-patch] ai-assistant-sidebar-patch.js loaded.");
})();
