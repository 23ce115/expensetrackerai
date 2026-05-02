/* ══════════════════════════════════════════════════════════════════════
   PREMIUM CARD STACK v2  — card-stack-logic.js
   Include AFTER script.js:
     <script src="card-stack-logic.js"></script>
   ══════════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  let hoverCardIndex = null;

  const getContainer = () => document.getElementById("cardStackContainer");
  const getDotsEl = () => document.getElementById("cardStackDots");

  const fmtMoney = (n) =>
    typeof window.fmt === "function"
      ? window.fmt(n)
      : "₹" + (+n || 0).toLocaleString("en-IN");

  /* ─── Inner HTML for one card ───────────────────────────────────── */
  function cardHTML(card, cardIdx, isTop) {
    const ud = card?.userData || {};
    const nick = ud.nickname?.trim() || ud.bank?.trim() || "Card";
    const num = ud.cardNumber
      ? `\u2022\u2022\u2022\u2022 ${String(ud.cardNumber).slice(-4)}`
      : "\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022";
    const holder = (ud.name || "YOUR NAME").toUpperCase();
    const bank = (ud.bank || "").toUpperCase();
    const limit = ud.spendingLimit || 0;
    const spent = (card.transactions || [])
      .filter((t) => t.type === "expense")
      .reduce((s, t) => s + Math.abs(t.amount || 0), 0);
    const pct = limit > 0 ? Math.min((spent / limit) * 100, 100).toFixed(1) : 0;

    const spending = isTop
      ? `
      <div class="ci-spending">
        <div class="ci-spend-row">
          <span class="ci-spend-label">Spending Limit</span>
          <span class="ci-spend-limit">${fmtMoney(limit)}</span>
        </div>
        <div class="ci-spend-used">Used: ${fmtMoney(spent)}</div>
        <div class="ci-progress"><div class="ci-progress-fill" style="width:${pct}%"></div></div>
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
      ${spending}
      ${isTop ? `<span class="ci-active-badge">Active</span>` : ""}
    `;
  }

  /* ─── Core render ───────────────────────────────────────────────── */
  function renderCardStack() {
    const container = getContainer();
    const dotsEl = getDotsEl();
    if (!container) return;

    const cardList = window.cards || [];
    const activeIdx = window.activeCardIdx != null ? window.activeCardIdx : 0;
    const accents = window.CARD_ACCENT_COLORS || [
      "#10b981",
      "#3b82f6",
      "#f59e0b",
      "#ec4899",
    ];

    /* Empty state */
    if (!cardList.length) {
      container.innerHTML = `
        <div class="csv2-empty-state" onclick="typeof addNewCard==='function'&&addNewCard()">
          <div class="csv2-empty-icon"><i class="fas fa-credit-card"></i></div>
          <div class="csv2-empty-title">No card added yet</div>
          <div class="csv2-empty-sub">Tap to add your first card</div>
          <div class="csv2-empty-btn"><i class="fas fa-plus"></i> Add Card</div>
        </div>`;
      if (dotsEl) dotsEl.innerHTML = "";
      return;
    }

    /* Order: top card first */
    const topIdx = hoverCardIndex !== null ? hoverCardIndex : activeIdx;
    const order = [
      topIdx,
      ...cardList.map((_, i) => i).filter((i) => i !== topIdx),
    ];

    /* Node cache (keeps event listeners alive across re-renders) */
    if (!container._cardNodes) container._cardNodes = {};
    const cache = container._cardNodes;

    /* Prune cache for deleted cards */
    Object.keys(cache).forEach((k) => {
      if (+k >= cardList.length) delete cache[k];
    });

    /* Detach all children cleanly */
    while (container.firstChild) container.removeChild(container.firstChild);

    /* Append bottom→top (last appended = painted on top) */
    [...order].reverse().forEach((cardIdx, reversedRank) => {
      const rankFromTop = order.length - 1 - reversedRank;
      const card = cardList[cardIdx];
      const isTop = rankFromTop === 0;
      const isActive = cardIdx === activeIdx;
      const isHovered = cardIdx === hoverCardIndex;
      const rank = Math.min(rankFromTop, 3);

      let el = cache[cardIdx];
      if (!el) {
        el = document.createElement("div");
        el.dataset.cardIndex = String(cardIdx);

        el.addEventListener("mouseenter", () => {
          hoverCardIndex = cardIdx;
          container.classList.add("hovering");
          renderCardStack();
        });

        el.addEventListener("click", (e) => {
          const rect = el.getBoundingClientRect();
          const ripple = document.createElement("span");
          ripple.className = "ci-ripple";
          ripple.style.top = e.clientY - rect.top + "px";
          ripple.style.left = e.clientX - rect.left + "px";
          el.appendChild(ripple);
          setTimeout(() => ripple.remove(), 600);

          if (cardIdx !== window.activeCardIdx) {
            if (typeof window.switchCard === "function")
              window.switchCard(cardIdx);
            hoverCardIndex = null;
            container.classList.remove("hovering");
          }
        });

        cache[cardIdx] = el;
      }

      el.className = `card-item rank-${rank}`;
      if (isTop) el.classList.add("is-top");
      if (isActive) el.classList.add("is-active");
      if (isHovered) el.classList.add("is-hovered");

      el.dataset.theme = String(cardIdx % accents.length);
      el.style.zIndex = isTop ? "10" : String(10 - rankFromTop);
      const ops = [1, 0.82, 0.62, 0.44];
      el.style.setProperty("--base-opacity", String(ops[rank] ?? 0.44));

      el.innerHTML = cardHTML(card, cardIdx, isTop);
      container.appendChild(el);
    });

    /* Bind container mouseleave once */
    if (!container._leaveBound) {
      container._leaveBound = true;
      container.addEventListener("mouseleave", () => {
        hoverCardIndex = null;
        container.classList.remove("hovering");
        renderCardStack();
      });
    }

    /* Dots */
    if (dotsEl) {
      dotsEl.innerHTML = cardList
        .map(
          (_, i) =>
            `<div class="cs-dot${i === activeIdx ? " is-active" : ""}" data-dot-idx="${i}"></div>`,
        )
        .join("");
      dotsEl.querySelectorAll(".cs-dot").forEach((dot) => {
        dot.addEventListener("click", () => {
          const idx = +dot.dataset.dotIdx;
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

  /* ─── Public ────────────────────────────────────────────────────── */
  window.renderCardStack = renderCardStack;

  /* ─── Patch existing functions after DOM ready ──────────────────── */
  function patchFunctions() {
    const _w = window.updateMyCardWidget;
    if (typeof _w === "function") {
      window.updateMyCardWidget = function () {
        _w.apply(this, arguments);
        renderCardStack();
      };
    }
    const _rs = window.renderCardSwitcher;
    if (typeof _rs === "function") {
      window.renderCardSwitcher = function () {
        _rs.apply(this, arguments);
        renderCardStack();
      };
    }
    const _sc = window.switchCard;
    if (typeof _sc === "function") {
      window.switchCard = function (idx) {
        hoverCardIndex = null;
        _sc.apply(this, arguments);
      };
    }
    renderCardStack();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", patchFunctions);
  } else {
    // script.js runs synchronously before this file, so functions are ready
    patchFunctions();
  }
})();
