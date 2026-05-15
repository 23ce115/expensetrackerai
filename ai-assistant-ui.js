/* ═══════════════════════════════════════════════════════════════
   ai-assistant-ui-patch.js  — Full UI improvement patch
   ───────────────────────────────────────────────────────────────
   Load AFTER ai-assistant.js, ai-assistant-db-patch.js,
   and ai-assistant-sidebar-patch.js.

   Covers:
   #2  Tab bar  — Tabler icons (already in sidebar patch aiaSetMode)
   #3  Score ring  — animated entrance, grade glow
   #4  Insight cards  — Tabler icons, per-row pin button,
                        emoji-free bstat chips, rec icons
   #5  Deep analysis  — shimmer skeleton, section dividers,
                        pred grid, emoji-free warn/savings rows
   #6  CTA bar  — hint text, Tabler icon on button
   ═══════════════════════════════════════════════════════════════ */

"use strict";

(function () {
  /* ══════════════════════════════════════════════════════════════
     ICON MAPS  (replaces all emoji in rendered HTML)
     ══════════════════════════════════════════════════════════════ */

  /* Insight row type → Tabler icon class */
  const INS_ICON = {
    positive: "ti-trending-up",
    warn: "ti-alert-triangle",
    danger: "ti-alert-circle",
    info: "ti-bulb",
  };

  /* Factor type → Tabler icon class */
  const FACTOR_ICON = {
    pos: "ti-circle-check",
    neg: "ti-circle-x",
    neu: "ti-minus",
  };

  /* bstat: category label → Tabler icon + tint */
  function _bstatIcon(label) {
    const l = (label || "").toLowerCase();
    if (l.includes("top cat") || l.includes("category"))
      return {
        icon: "ti-trophy",
        bg: "rgba(251,191,36,0.1)",
        color: "#fbbf24",
      };
    if (l.includes("highest spend") || l.includes("spend day"))
      return {
        icon: "ti-calendar-event",
        bg: "rgba(129,140,248,0.1)",
        color: "#818cf8",
      };
    if (l.includes("growing") || l.includes("fastest"))
      return {
        icon: "ti-trending-up",
        bg: "rgba(239,68,68,0.1)",
        color: "#ef4444",
      };
    if (l.includes("last month") || l.includes("vs "))
      return {
        icon: "ti-arrows-diff",
        bg: "rgba(52,211,153,0.1)",
        color: "#34d399",
      };
    return {
      icon: "ti-chart-bar",
      bg: "rgba(255,255,255,0.06)",
      color: "var(--t2)",
    };
  }

  /* Deep section → Tabler icon class */
  const DEEP_SEC_ICON = {
    insights: "ti-bulb",
    predictions: "ti-chart-line",
    action: "ti-list-check",
  };

  /* ══════════════════════════════════════════════════════════════
     #3  SCORE RING ANIMATION
     Runs after _renderAnalysis injects the SVG into the DOM.
     ══════════════════════════════════════════════════════════════ */

  function _animateRing() {
    const ring = document.querySelector(".aia-ring-arc");
    const wrap = document.querySelector(".aia-ring-wrap");
    if (!ring || !wrap) return;

    /* Read the target dashoffset the server already set inline */
    const target = parseFloat(ring.getAttribute("stroke-dashoffset") || "0");
    const total = parseFloat(ring.getAttribute("stroke-dasharray") || "264");
    const color = ring.getAttribute("stroke") || "#10b981";

    /* Start from full offset (empty ring), then animate to target */
    ring.style.transition = "none";
    ring.setAttribute("stroke-dashoffset", total);

    /* Set glow colour as CSS variable on the wrap */
    wrap.style.setProperty("--ring-glow", color + "26");

    /* One frame delay lets the browser register the reset */
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        ring.classList.add("animated");
        ring.setAttribute("stroke-dashoffset", target);
        /* Trigger glow after ring starts filling */
        setTimeout(() => wrap.classList.add("glowing"), 300);
      }),
    );
  }

  /* ══════════════════════════════════════════════════════════════
     #4  PATCH _renderAnalysis  — rewrite HTML, remove all emojis
     ══════════════════════════════════════════════════════════════ */

  const _origRenderAnalysis = window._renderAnalysis;

  window._renderAnalysis = function () {
    /* Run original to get the DOM painted */
    if (typeof _origRenderAnalysis === "function") _origRenderAnalysis();

    /* ── Post-process: upgrade each section ── */
    _upgradeFactors();
    _upgradePredWarnSavings();
    _upgradeBstatChips();
    _upgradeInsightRows();
    _upgradeRecRows();
    _upgradeCTABar();
    _animateRing();
  };

  /* ── Factor rows: swap FA icons for Tabler ── */
  function _upgradeFactors() {
    document.querySelectorAll(".aia-factor").forEach((el) => {
      const ic = el.querySelector("i");
      if (!ic) return;
      const t = el.classList.contains("aia-factor--pos")
        ? "pos"
        : el.classList.contains("aia-factor--neg")
          ? "neg"
          : "neu";
      ic.className = `ti ${FACTOR_ICON[t]}`;
    });
  }

  /* ── Pred warn / savings: inject icon, remove emoji ── */
  function _upgradePredWarnSavings() {
    const warn = document.querySelector(".aia-pred-warn");
    if (warn) {
      const txt = warn.textContent
        .replace(/[⚠️💰₹\d,\s\-–]/g, (m) => (/[⚠️💰]/.test(m) ? "" : m))
        .trim();
      warn.innerHTML = `<i class="ti ti-alert-triangle"></i>${warn.textContent.replace(/^[⚠️💰\s]+/, "")}`;
    }
    const sav = document.querySelector(".aia-pred-savings");
    if (sav) {
      sav.innerHTML = `<i class="ti ti-piggy-bank"></i>${sav.textContent.replace(/^[💰\s]+/, "")}`;
    }
  }

  /* ── bstat chips: replace emoji span with icon div ── */
  function _upgradeBstatChips() {
    document.querySelectorAll(".aia-bstat").forEach((chip) => {
      const emEl = chip.querySelector(".aia-bstat-em");
      const lbl = chip.querySelector(".aia-bstat-lbl");
      if (!lbl) return;
      const { icon, bg, color } = _bstatIcon(lbl.textContent);
      /* Build icon div */
      const iconDiv = document.createElement("div");
      iconDiv.className = "aia-bstat-icon";
      iconDiv.style.background = bg;
      iconDiv.style.color = color;
      iconDiv.innerHTML = `<i class="ti ${icon}"></i>`;
      /* Replace or prepend */
      if (emEl) {
        chip.replaceChild(iconDiv, emEl);
      } else {
        chip.prepend(iconDiv);
      }
    });
  }

  /* ── Insight rows: icon div + content wrapper + per-row pin ── */
  function _upgradeInsightRows() {
    document.querySelectorAll(".aia-ins-row").forEach((row) => {
      /* Already upgraded guard */
      if (row.dataset.upgraded) return;
      row.dataset.upgraded = "1";

      const type =
        ["positive", "warn", "danger", "info"].find((t) =>
          row.classList.contains(`aia-ins-row--${t}`),
        ) || "info";

      /* Grab existing content */
      const emEl = row.querySelector(".aia-ins-em");
      const titleEl = row.querySelector(".aia-ins-title");
      const bodyEl = row.querySelector(".aia-ins-body");

      const titleTxt = titleEl?.textContent || "";
      const bodyTxt = bodyEl?.textContent || "";

      /* Rebuild innerHTML */
      row.innerHTML = `
        <div class="aia-ins-icon">
          <i class="ti ${INS_ICON[type]}"></i>
        </div>
        <div class="aia-ins-content">
          <div class="aia-ins-title">${safeText(titleTxt)}</div>
          <div class="aia-ins-body">${safeText(bodyTxt)}</div>
        </div>
        <button class="aia-ins-pin-btn"
                title="Pin this insight"
                aria-label="Pin insight"
                data-text="${titleTxt.replace(/"/g, "&quot;")}">
          <i class="ti ti-pin"></i>
        </button>`;

      /* Wire per-row pin */
      row
        .querySelector(".aia-ins-pin-btn")
        .addEventListener("click", async (e) => {
          e.stopPropagation();
          const text = e.currentTarget.dataset.text;
          if (typeof _addPin === "function") await _addPin(text);
          if (typeof _renderSidebar === "function") _renderSidebar();
          if (typeof toast === "function") toast("Insight pinned", "success");
        });
    });

    /* Upgrade section Pin button icon */
    const pinBtn = document.querySelector(".aia-pin-btn");
    if (pinBtn) {
      const ic = pinBtn.querySelector("i");
      if (ic) ic.className = "ti ti-pin";
    }
  }

  /* ── Budget rec rows: replace emoji with icon div ── */
  function _upgradeRecRows() {
    document.querySelectorAll(".aia-rec").forEach((rec) => {
      if (rec.dataset.upgraded) return;
      rec.dataset.upgraded = "1";

      const emEl = rec.querySelector(".aia-rec-icon");
      if (emEl) emEl.style.display = "none";

      /* Prepend icon div if not present */
      if (!rec.querySelector(".aia-rec-ico")) {
        const d = document.createElement("div");
        d.className = "aia-rec-ico";
        d.innerHTML = `<i class="ti ti-sparkles"></i>`;
        rec.prepend(d);
      }
    });
  }

  /* ── CTA bar: add hint text + upgrade icon ── */
  function _upgradeCTABar() {
    const bar = document.querySelector(".aia-cta-bar");
    if (!bar || bar.dataset.upgraded) return;
    bar.dataset.upgraded = "1";

    const btn = bar.querySelector(".aia-cta-btn");
    if (!btn) return;

    /* Add hint text before button */
    const hint = document.createElement("span");
    hint.className = "aia-cta-hint";
    hint.textContent = "Ask follow-up questions about your finances";
    bar.insertBefore(hint, btn);

    /* Swap icon */
    const ic = btn.querySelector("i");
    if (ic) ic.className = "ti ti-message-dots";
  }

  /* ══════════════════════════════════════════════════════════════
     #5  PATCH aiaRunDeep  — shimmer skeleton + section icons
     ══════════════════════════════════════════════════════════════ */

  const _origRunDeep = window.aiaRunDeep;

  window.aiaRunDeep = async function () {
    const btn = document.getElementById("aiaDeepBtn");
    const res = document.getElementById("aiaDeepResult");
    if (!btn || !res) return;

    /* Upgrade button icon before disabling */
    const ic = btn.querySelector("i");
    if (ic) ic.className = "ti ti-brain";

    btn.disabled = true;
    btn.innerHTML = `<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> Analysing…`;

    /* Shimmer skeleton */
    res.innerHTML = `
      <div class="aia-deep-skeleton">
        <div class="aia-skel-row" style="width:60%"></div>
        <div class="aia-skel-row" style="width:90%"></div>
        <div class="aia-skel-row" style="width:75%"></div>
        <div class="aia-skel-row" style="width:50%;margin-top:.4rem"></div>
        <div class="aia-skel-row" style="width:85%"></div>
        <div class="aia-skel-row" style="width:70%"></div>
        <div class="aia-skel-row" style="width:40%;margin-top:.4rem"></div>
        <div class="aia-skel-row" style="width:80%"></div>
        <div class="aia-skel-row" style="width:65%"></div>
      </div>`;

    /* Delegate to original logic then upgrade the result */
    /* We replicate only the result-rendering patch here;
       the API call logic stays in the original function.
       Strategy: run original, then post-process. */

    /* Because original sets res.innerHTML at the end, we watch for it */
    const _origHTML = res.innerHTML;
    await (typeof _origRunDeep === "function"
      ? _origRunDeep()
      : Promise.resolve());

    /* Post-process deep result */
    _upgradeDeepResult(res);
  };

  function _upgradeDeepResult(res) {
    if (!res) return;

    /* Upgrade section header icons */
    res.querySelectorAll(".aia-deep-sec").forEach((sec) => {
      const txt = sec.textContent.toLowerCase();
      const key = txt.includes("insight")
        ? "insights"
        : txt.includes("predict")
          ? "predictions"
          : "action";
      const ic = sec.querySelector("i");
      if (ic) ic.className = `ti ${DEEP_SEC_ICON[key]}`;
    });

    /* Upgrade dismiss/pin button icons */
    const dismiss = res.querySelector(".aia-deep-dismiss i");
    if (dismiss) dismiss.className = "ti ti-x";
    const pin = res.querySelector(".aia-deep-pin i");
    if (pin) pin.className = "ti ti-pin";

    /* Source badge icon */
    const src = res.querySelector(".aia-deep-src i");
    if (src) {
      const isLocal = src.closest(".aia-deep-src--local");
      src.className = isLocal ? "ti ti-bolt" : "ti ti-robot";
    }
  }

  /* ══════════════════════════════════════════════════════════════
     SPIN KEYFRAME (for loading spinner)
     ══════════════════════════════════════════════════════════════ */

  (function _injectSpin() {
    if (document.getElementById("aia-spin-style")) return;
    const s = document.createElement("style");
    s.id = "aia-spin-style";
    s.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
    document.head.appendChild(s);
  })();

  /* ══════════════════════════════════════════════════════════════
     RE-RUN UPGRADES after sidebar is re-rendered (pin events)
     ══════════════════════════════════════════════════════════════ */

  const _origRenderSidebar = window._renderSidebar;
  window._renderSidebar = function () {
    if (typeof _origRenderSidebar === "function") _origRenderSidebar();
    /* No extra work needed here — sidebar patch handles it */
  };

  /* ══════════════════════════════════════════════════════════════
     TOPBAR ICON SWAP  (#2 — supplement sidebar patch)
     Ensure bars/hamburger and close icons use Tabler
     ══════════════════════════════════════════════════════════════ */

  function _upgradeTopbar() {
    /* Hamburger */
    const ham = document.querySelector(".aia-topbar-l .aia-icon-btn i");
    if (ham) ham.className = "ti ti-menu-2";

    /* Close */
    const close = document.querySelector(".aia-topbar-r .aia-icon-btn i");
    if (close) close.className = "ti ti-x";

    /* Tab icons */
    const tabA = document.querySelector("#aiaTabA i");
    if (tabA) tabA.className = "ti ti-chart-pie";
    const tabC = document.querySelector("#aiaTabC i");
    if (tabC) tabC.className = "ti ti-message-dots";
  }

  /* ══════════════════════════════════════════════════════════════
     HOOK INTO openAIAssistant
     ══════════════════════════════════════════════════════════════ */

  const _prevOpen = window.openAIAssistant;
  window.openAIAssistant = async function () {
    if (typeof _prevOpen === "function") await _prevOpen();
    _upgradeTopbar();
    /* _renderAnalysis is called inside openAIAssistant already,
       so upgrades run automatically via the patched _renderAnalysis */
  };

  console.info("[UI-patch] ai-assistant-ui-patch.js loaded.");
})();
