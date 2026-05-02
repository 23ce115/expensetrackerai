/* ══════════════════════════════════════════════════════════════════════
   PREMIUM CARD STACK v2  — card-stack-logic.js
   Add this block to the bottom of script.js  (or include as a separate
   <script src="card-stack-logic.js"></script> AFTER script.js)

   Requires:
     - window.cards            (array, defined in script.js)
     - window.activeCardIdx    (number, defined in script.js)
     - window.CARD_ACCENT_COLORS (array, defined in script.js)
     - window.switchCard(idx)  (function, defined in script.js)
     - window.fmt(n)           (currency formatter, defined in script.js)
   ══════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  /* ── State ────────────────────────────────────────────────────────── */
  let hoverCardIndex = null; // temporary; never persists

  /* ── Helpers ──────────────────────────────────────────────────────── */
  function getContainer() {
    return document.getElementById("cardStackContainer");
  }
  function getDotsEl() {
    return document.getElementById("cardStackDots");
  }

  /**
   * Build a card's inner HTML.
   * Shows full data only when it's rank-0 (the visible top card);
   * lower ranks show a lighter skeleton for depth illusion.
   */
  function buildCardInnerHTML(card, cardIdx, isTopVisible) {
    const ud = card?.userData || {};
    const accent = CARD_ACCENT_COLORS[cardIdx % CARD_ACCENT_COLORS.length];
    const nick = ud.nickname?.trim() || ud.name?.split(" ")[0] || "Card";
    const num = ud.cardNumber || "•••• •••• •••• ••••";
    const holder = ud.name?.toUpperCase() || "YOUR NAME";
    const bank = ud.bank?.toUpperCase() || "";
    const limit = ud.spendingLimit || 0;

    // Spending progress
    const spent = (card.transactions || [])
      .filter((t) => t.type === "expense")
      .reduce((s, t) => s + Math.abs(t.amount || 0), 0);
    const pct = limit > 0 ? Math.min((spent / limit) * 100, 100).toFixed(1) : 0;
    const fmtFn =
      typeof window.fmt === "function"
        ? window.fmt
        : (n) => "₹" + (+n || 0).toLocaleString("en-IN");

    // Only surface spending details on the top-visible card
    const spendHTML = isTopVisible
      ? `
      <div class="ci-spending">
        <div class="ci-spend-row">
          <span class="ci-spend-label">Spending Limit</span>
          <span class="ci-spend-limit">${fmtFn(limit)}</span>
        </div>
        <div class="ci-spend-used">Used: ${fmtFn(spent)}</div>
        <div class="ci-progress">
          <div class="ci-progress-fill" style="width:${pct}%"></div>
        </div>
      </div>`
      : "";

    return `
      <div class="ci-top">
        <span class="ci-nick">${nick}</span>
        <div class="ci-chip"></div>
      </div>
      <div class="ci-number">${num}</div>
      <div class="ci-holder">${holder}</div>
      ${bank ? `<div class="ci-bank">${bank}</div>` : ""}
      ${spendHTML}
      <span class="ci-active-badge">Active</span>
    `;
  }

  /* ── Core render ──────────────────────────────────────────────────── */
  function renderCardStack() {
    const container = getContainer();
    const dotsEl = getDotsEl();
    if (!container) return;

    const cardList = window.cards || [];
    if (!cardList.length) {
      container.innerHTML = `<div class="csv2-placeholder"><div class="csv2-shimmer"></div></div>`;
      if (dotsEl) dotsEl.innerHTML = "";
      return;
    }

    // Which card is visually on top right now?
    const topIdx =
      hoverCardIndex !== null ? hoverCardIndex : window.activeCardIdx;

    // Build display order: topIdx first, then the rest in their natural order
    // (active card is rank-0 when not hovering)
    const order = buildDisplayOrder(cardList.length, topIdx);

    /* ── Render cards ───────────────────────────────────────────────── */
    // Reuse existing DOM nodes if possible (avoids layout flash)
    const existingItems = Array.from(container.querySelectorAll(".card-item"));
    const existingMap = {};
    existingItems.forEach((el) => {
      existingMap[el.dataset.cardIndex] = el;
    });

    // Remove placeholder
    const placeholder = container.querySelector(".csv2-placeholder");
    if (placeholder) placeholder.remove();

    // Track which card elements we want to keep
    const wanted = new Set(cardList.map((_, i) => String(i)));

    // Remove stale elements
    existingItems.forEach((el) => {
      if (!wanted.has(el.dataset.cardIndex)) el.remove();
    });

    order.forEach((cardIdx, rankFromTop) => {
      const card = cardList[cardIdx];
      const isTop = rankFromTop === 0;
      const isActive = cardIdx === window.activeCardIdx;
      const isHovered = cardIdx === hoverCardIndex;
      const totalRank = Math.min(rankFromTop, 3); // cap at rank-3

      let el = existingMap[cardIdx];
      if (!el) {
        el = document.createElement("div");
        el.className = "card-item";
        el.dataset.cardIndex = cardIdx;
        container.appendChild(el);

        // ── Event: hover enter ──
        el.addEventListener("mouseenter", () => {
          hoverCardIndex = cardIdx;
          container.classList.add("hovering");
          renderCardStack();
        });

        // ── Event: click ──
        el.addEventListener("click", (e) => {
          // Ripple effect
          const rect = el.getBoundingClientRect();
          const ripple = document.createElement("span");
          ripple.className = "ci-ripple";
          ripple.style.top = e.clientY - rect.top + "px";
          ripple.style.left = e.clientX - rect.left + "px";
          el.appendChild(ripple);
          setTimeout(() => ripple.remove(), 600);

          // Switch active card
          if (cardIdx !== window.activeCardIdx) {
            if (typeof window.switchCard === "function") {
              window.switchCard(cardIdx);
            }
            hoverCardIndex = null;
            container.classList.remove("hovering");
          }
        });
      }

      // ── Update classes ──────────────────────────────────────────── //
      el.className = `card-item rank-${totalRank}`;
      if (isTop) el.classList.add("is-top");
      if (isActive) el.classList.add("is-active");
      if (isHovered) el.classList.add("is-hovered");

      // ── z-index: higher rank from top = higher z ─────────────────── //
      const zBase = cardList.length;
      el.style.zIndex = zBase - rankFromTop;

      // ── Accent / theme attr ───────────────────────────────────────── //
      el.dataset.theme = String(cardIdx % CARD_ACCENT_COLORS.length);

      // Expose base opacity as CSS var for sibling fade calculation
      const baseOpacities = [1, 0.82, 0.62, 0.44];
      el.style.setProperty("--base-opacity", baseOpacities[totalRank] || 0.44);

      // ── Inner HTML (only rebuild if stale) ───────────────────────── //
      const wantFull = isTop;
      const hasFull = el.dataset.hasFull === "1";
      const themeMatch = el.dataset.lastTheme === el.dataset.theme;
      if (!themeMatch || wantFull !== hasFull) {
        el.innerHTML = buildCardInnerHTML(card, cardIdx, wantFull);
        el.dataset.hasFull = wantFull ? "1" : "0";
        el.dataset.lastTheme = el.dataset.theme;
      }

      // Always refresh spending bar on top card (data may have changed)
      if (isTop) {
        const fill = el.querySelector(".ci-progress-fill");
        const ud = card?.userData || {};
        const limit = ud.spendingLimit || 0;
        const spent = (card.transactions || [])
          .filter((t) => t.type === "expense")
          .reduce((s, t) => s + Math.abs(t.amount || 0), 0);
        const pct =
          limit > 0 ? Math.min((spent / limit) * 100, 100).toFixed(1) : 0;
        if (fill) fill.style.width = pct + "%";
      }
    });

    /* ── Dot indicators ─────────────────────────────────────────────── */
    if (dotsEl) {
      dotsEl.innerHTML = cardList
        .map((_, i) => {
          const active = i === window.activeCardIdx ? "is-active" : "";
          return `<div class="cs-dot ${active}" data-dot-idx="${i}"></div>`;
        })
        .join("");
      dotsEl.querySelectorAll(".cs-dot").forEach((dot) => {
        dot.addEventListener("click", () => {
          const idx = parseInt(dot.dataset.dotIdx, 10);
          if (
            idx !== window.activeCardIdx &&
            typeof window.switchCard === "function"
          ) {
            window.switchCard(idx);
          }
        });
      });
    }
  }

  /* ── Container mouse-leave → reset hover ────────────────────────── */
  function bindContainerLeave() {
    const container = getContainer();
    if (!container || container._stackLeafBound) return;
    container._stackLeafBound = true;

    container.addEventListener("mouseleave", () => {
      hoverCardIndex = null;
      container.classList.remove("hovering");
      renderCardStack();
    });
  }

  /* ── Build display order array ──────────────────────────────────── */
  // Returns indices ordered from visually TOP to BOTTOM.
  // The topIdx card is first. The rest follow in original order.
  function buildDisplayOrder(count, topIdx) {
    if (count === 0) return [];
    const order = [topIdx];
    for (let i = 0; i < count; i++) {
      if (i !== topIdx) order.push(i);
    }
    return order;
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  // Exposed so script.js can call it wherever it currently calls
  // renderCardSwitcher() or updateMyCardWidget() — just add a call
  // to window.renderCardStack() alongside those.
  window.renderCardStack = function () {
    bindContainerLeave();
    renderCardStack();
  };

  /* ── Also refresh spending data displayed on the top card ───────── */
  // Patch the existing updateMyCardWidget to also refresh the stack
  (function patchUpdateMyCardWidget() {
    const _orig = window.updateMyCardWidget;
    if (typeof _orig !== "function") return;
    window.updateMyCardWidget = function () {
      _orig.apply(this, arguments);
      window.renderCardStack();
    };
  })();

  /* ── Patch switchCard to update dots + re-render ────────────────── */
  (function patchSwitchCard() {
    const _orig = window.switchCard;
    if (typeof _orig !== "function") return;
    window.switchCard = function (idx) {
      hoverCardIndex = null; // always clear hover on explicit switch
      _orig.apply(this, arguments);
      // renderCardStack is called via the patched updateMyCardWidget
    };
  })();

  /* ── Patch renderCardSwitcher to co-render the stack ────────────── */
  (function patchRenderCardSwitcher() {
    const _orig = window.renderCardSwitcher;
    if (typeof _orig !== "function") return;
    window.renderCardSwitcher = function () {
      _orig.apply(this, arguments);
      bindContainerLeave();
      renderCardStack();
    };
  })();

  /* ── Initial render (fires after DOM is ready) ───────────────────── */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      bindContainerLeave();
      renderCardStack();
    });
  } else {
    // DOM already ready
    bindContainerLeave();
    renderCardStack();
  }
})();
