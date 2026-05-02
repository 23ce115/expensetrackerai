/* ═══════════════════════════════════════════════════════════════════
   card-stack-logic.js — BlueLedger Premium Card Stack
   Horizontal Fan Interaction (Option 2)

   OWNS:
     renderCardStack()         → full re-render from cards[] + activeCardIdx
     _fanOpen / _fanClose      → fan animation drivers
     _applyCardTransforms()    → single source of truth for all transforms

   READS from script.js (do NOT redeclare):
     cards[], activeCardIdx, switchCard(idx)
     getCardDisplayName(), CARD_ACCENT_COLORS

   Load order: … → charts.js → script.js → card-stack-logic.js
   ═══════════════════════════════════════════════════════════════════ */

"use strict";

/* ── Module state ─────────────────────────────────────────────────── */
let _hoverIdx = null; // which card is currently hovered (null = none)
let _fanIsOpen = false; // fan-open state flag
let _rafPending = false; // animation frame guard

/* ── Fan geometry constants (per card count) ─────────────────────── */
const FAN_CFG = {
  1: { spread: 0, rotMax: 0, yLift: 0 },
  2: { spread: 52, rotMax: 9, yLift: -10 },
  3: { spread: 68, rotMax: 13, yLift: -12 },
  4: { spread: 80, rotMax: 16, yLift: -14 },
};

/* ── Theme accent colours (mirrors CARD_ACCENT_COLORS in script.js) ── */
const THEME_GLOW = [
  { ring: "rgba(16,185,129,0.72)", glow: "rgba(16,185,129,0.28)" }, // emerald
  { ring: "rgba(59,130,246,0.72)", glow: "rgba(59,130,246,0.28)" }, // blue
  { ring: "rgba(245,158,11,0.72)", glow: "rgba(245,158,11,0.28)" }, // amber
  { ring: "rgba(236,72,153,0.72)", glow: "rgba(236,72,153,0.28)" }, // pink
];

/* ══════════════════════════════════════════════════════════════════
   PUBLIC: renderCardStack
   Called by updateMyCardWidget() every time card data changes.
   ══════════════════════════════════════════════════════════════════ */
function renderCardStack() {
  const container = document.getElementById("cardStackContainer");
  const dotsEl = document.getElementById("cardStackDots");
  if (!container) return;

  /* Reset hover state on every re-render */
  _hoverIdx = null;
  _fanIsOpen = false;

  /* ── No cards yet → show empty state ──────────────────────────── */
  if (!window.cards || window.cards.length === 0) {
    container.innerHTML = `
      <div class="csv2-empty-state">
        <i class="fas fa-credit-card" style="font-size:1.4rem;opacity:.25"></i>
        <span>No card added yet</span>
        <button onclick="openCardSetup ? openCardSetup() : null()">Set up card</button>
      </div>`;
    if (dotsEl) dotsEl.innerHTML = "";
    return;
  }

  const cardCount = window.cards.length;
  const cfg = FAN_CFG[Math.min(cardCount, 4)] || FAN_CFG[4];
  const activeIdx = window.activeCardIdx ?? 0;

  /* ── Build card DOM ─────────────────────────────────────────────── */
  container.innerHTML = "";

  window.cards.forEach((card, i) => {
    const ud = card.userData || {};
    const theme = i % 4;
    const isTop = i === activeIdx;
    const last4 = (ud.cardNumber || "").replace(/\D/g, "").slice(-4);
    const maskedNum = last4 ? `•••• •••• •••• ${last4}` : "•••• •••• •••• ••••";
    const nick =
      ud.nickname?.trim() || ud.name?.split(" ")[0] || `Card ${i + 1}`;
    const holder = (ud.name || "").toUpperCase() || "CARD HOLDER";
    const limit = ud.spendingLimit || ud.limit || 0;
    const used = _getUsed(card);
    const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    const isDanger = pct >= 85;

    /* Rank: 0 = active on top, others in original insertion order */
    const rank = _rankOf(i, activeIdx, cardCount);

    const el = document.createElement("div");
    el.className = `card-item rank-${rank}${isTop ? " is-top is-active" : ""}`;
    el.dataset.idx = i;
    el.dataset.theme = theme;
    el.dataset.rank = rank;
    /* CSS custom property for per-theme glow ring */
    el.style.setProperty("--card-accent", THEME_GLOW[theme].ring);
    el.style.setProperty("--card-accent-glow", THEME_GLOW[theme].glow);
    el.style.setProperty(
      "--base-opacity",
      isTop ? "1" : rank === 1 ? "0.82" : "0.62",
    );
    el.style.zIndex = String(cardCount - rank + 2);

    el.innerHTML = `
      <div class="ci-top">
        <span class="ci-nick">${nick}</span>
        <div class="ci-chip"></div>
      </div>
      <div class="ci-number">${maskedNum}</div>
      <div class="ci-bottom">
        <div>
          <div class="ci-holder">${holder}</div>
          <div class="ci-bank">${ud.bankName || ""}</div>
        </div>
        <div class="ci-expiry-col">
          <div class="ci-exp-label">Valid thru</div>
          <div class="ci-exp-val">${ud.cardExpiry || "••/••"}</div>
        </div>
      </div>
      ${
        isTop && limit > 0
          ? `
      <div class="ci-spending">
        <div class="ci-spend-row">
          <span class="ci-spend-label">Spending limit</span>
          <span class="ci-spend-limit">₹${limit.toLocaleString("en-IN")}</span>
        </div>
        <div class="ci-spend-used">Used: ₹${used.toLocaleString("en-IN")}</div>
        <div class="ci-progress">
          <div class="ci-progress-fill${isDanger ? " ci-progress-danger" : ""}"
               style="width:${pct.toFixed(1)}%"></div>
        </div>
      </div>`
          : ""
      }
      <div class="ci-active-badge">active</div>
    `;

    /* ── Mouse events ─────────────────────────────────────────────── */
    el.addEventListener("mouseenter", () => _onCardEnter(i));
    el.addEventListener("click", (e) => _onCardClick(e, i));

    container.appendChild(el);
  });

  /* ── Container-level mouse leave → close fan ─────────────────────── */
  container.onmouseleave = _onStackLeave;

  /* ── Dot indicators ─────────────────────────────────────────────── */
  _renderDots(dotsEl, cardCount, activeIdx);

  /* ── Apply initial (stacked) positions ───────────────────────────── */
  _applyCardTransforms(false, cfg);
}

/* ══════════════════════════════════════════════════════════════════
   EVENT HANDLERS
   ══════════════════════════════════════════════════════════════════ */

function _onCardEnter(idx) {
  _hoverIdx = idx;
  _fanIsOpen = true;
  _scheduleRender();
  _updateDotHover(idx);
}

function _onStackLeave() {
  _hoverIdx = null;
  _fanIsOpen = false;
  _scheduleRender();
  _updateDotHover(null);
}

function _onCardClick(e, idx) {
  /* Ripple */
  _spawnRipple(e, e.currentTarget);

  /* If clicking already-active card just close fan */
  if (idx === (window.activeCardIdx ?? 0)) {
    _hoverIdx = null;
    _fanIsOpen = false;
    _scheduleRender();
    return;
  }

  /* Switch card — script.js handles full state update,
     which calls updateMyCardWidget() → renderCardStack() */
  if (typeof window.switchCard === "function") {
    window.switchCard(idx);
  }
}

/* ══════════════════════════════════════════════════════════════════
   TRANSFORM ENGINE — single source of truth
   ══════════════════════════════════════════════════════════════════ */

function _scheduleRender() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    const container = document.getElementById("cardStackContainer");
    if (!container) return;
    const cardCount = window.cards?.length || 0;
    const cfg = FAN_CFG[Math.min(cardCount, 4)] || FAN_CFG[4];
    _applyCardTransforms(_fanIsOpen, cfg);
  });
}

function _applyCardTransforms(fanOpen, cfg) {
  const container = document.getElementById("cardStackContainer");
  if (!container) return;

  const items = container.querySelectorAll(".card-item");
  const count = items.length;
  const activeIdx = window.activeCardIdx ?? 0;

  /* Toggle class so CSS siblings can also respond */
  container.classList.toggle("hovering", fanOpen && _hoverIdx !== null);
  container.classList.toggle("fan-open", fanOpen);

  items.forEach((el) => {
    const i = parseInt(el.dataset.idx, 10);
    const rank = _rankOf(i, activeIdx, count);
    const isTop = i === activeIdx;

    if (!fanOpen) {
      /* ── STACKED (default) position ──────────────────────────────── */
      el.className = `card-item rank-${rank}${isTop ? " is-top is-active" : ""}`;
      el.style.transform = ""; /* let CSS rank-N class drive it */
      el.style.opacity = "";
      el.style.filter = "";
      el.style.boxShadow = "";
      el.style.zIndex = String(count - rank + 2);
    } else {
      /* ── FAN OPEN position ───────────────────────────────────────── */
      const isHov = i === _hoverIdx;

      /* Fan position: centre the spread around 0 */
      const fanPos = _fanPosition(i, activeIdx, count); /* -1 … +1 */
      const tx = fanPos * cfg.spread; /* px */
      const rot = fanPos * cfg.rotMax; /* deg */
      const ty = isHov ? cfg.yLift - 8 : cfg.yLift * 0.4;
      const sc = isHov ? 1.05 : 0.97;

      /* z-index: hovered = top, active = second, others by position */
      const z = isHov ? count + 10 : isTop ? count + 5 : count - rank + 2;

      el.style.zIndex = String(z);
      el.style.transform = `translateX(${tx.toFixed(1)}px) translateY(${ty.toFixed(1)}px) rotateZ(${rot.toFixed(2)}deg) scale(${sc})`;

      /* Opacity / filter */
      if (isHov) {
        el.style.opacity = "1";
        el.style.filter = "brightness(1.1)";
      } else if (_hoverIdx !== null) {
        /* Another card is hovered → dim this one */
        el.style.opacity = isTop ? "0.72" : "0.52";
        el.style.filter = "brightness(0.62)";
      } else {
        el.style.opacity = "";
        el.style.filter = "";
      }

      /* Classes */
      const cls = [
        "card-item",
        `rank-${rank}`,
        isTop ? "is-top" : "",
        isTop ? "is-active" : "",
        isHov ? "is-hovered" : "",
      ]
        .filter(Boolean)
        .join(" ");
      el.className = cls;

      /* Box shadow */
      el.style.boxShadow = isHov
        ? `0 28px 64px rgba(0,0,0,0.62),
           0 0 90px ${THEME_GLOW[parseInt(el.dataset.theme, 10)].glow},
           0 1px 0 rgba(255,255,255,0.12) inset`
        : "";
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   FAN GEOMETRY HELPERS
   ══════════════════════════════════════════════════════════════════ */

/**
 * Returns a normalised position in the fan arc.
 * Active card → center (0). Others spread left/right symmetrically.
 * Result range: -1 … +1
 */
function _fanPosition(cardIdx, activeIdx, total) {
  if (total === 1) return 0;

  /* Re-order so active card is always in the visual center.
     Build a display order where active card = index 0,
     and others alternate left/right by original insertion order. */
  const order = _fanOrder(activeIdx, total);
  const pos = order.indexOf(cardIdx);
  /* pos 0 = center, convert to -1…+1 symmetric */
  const half = (total - 1) / 2;
  return (pos - half) / half;
}

/**
 * Returns an array of card indices arranged for the fan:
 * active card in the middle, others fanned outward.
 * e.g. 4 cards, active=1  →  [2, 0, 1, 3]
 *                                L  L  C  R
 */
function _fanOrder(activeIdx, total) {
  const others = [];
  for (let i = 0; i < total; i++) {
    if (i !== activeIdx) others.push(i);
  }
  /* Interleave others around center */
  const result = [];
  let lo = 0,
    hi = others.length - 1;
  let side = -1; /* -1=left first, +1=right first */
  while (lo <= hi) {
    if (side < 0) {
      result.unshift(others[lo++]);
    } else {
      result.push(others[hi--]);
    }
    side *= -1;
  }
  /* Insert active card in the middle */
  const mid = Math.floor(result.length / 2);
  result.splice(mid, 0, activeIdx);
  return result;
}

/** Stacking rank: 0 = visually on top (active), increasing = further back */
function _rankOf(cardIdx, activeIdx, total) {
  if (cardIdx === activeIdx) return 0;
  /* Distance-based so nearest insertion wins */
  const dist = Math.abs(cardIdx - activeIdx);
  return Math.min(dist, total - 1);
}

/* ══════════════════════════════════════════════════════════════════
   DOT INDICATORS
   ══════════════════════════════════════════════════════════════════ */

function _renderDots(dotsEl, count, activeIdx) {
  if (!dotsEl) return;
  if (count <= 1) {
    dotsEl.innerHTML = "";
    return;
  }

  dotsEl.innerHTML = Array.from(
    { length: count },
    (_, i) => `
    <div class="cs-dot${i === activeIdx ? " is-active" : ""}"
         data-dot="${i}"
         onclick="_dotClick(${i})"
         title="Card ${i + 1}"></div>
  `,
  ).join("");
}

function _updateDotHover(hovIdx) {
  document.querySelectorAll(".cs-dot").forEach((dot) => {
    const i = parseInt(dot.dataset.dot, 10);
    dot.classList.toggle("is-hovered", i === hovIdx);
  });
}

function _dotClick(idx) {
  if (typeof window.switchCard === "function") window.switchCard(idx);
}
window._dotClick = _dotClick;

/* ══════════════════════════════════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════════════════════════════════ */

function _getUsed(card) {
  const txns = card.transactions || [];
  return txns
    .filter((t) => t.type === "expense" || t.amount < 0)
    .reduce((s, t) => s + Math.abs(t.amount || 0), 0);
}

function _spawnRipple(e, el) {
  const ripple = document.createElement("div");
  ripple.className = "ci-ripple";
  const rect = el.getBoundingClientRect();
  ripple.style.left = e.clientX - rect.left + "px";
  ripple.style.top = e.clientY - rect.top + "px";
  el.appendChild(ripple);
  setTimeout(() => ripple.remove(), 620);
}

/* ── Global exposure ─────────────────────────────────────────────── */
window.renderCardStack = renderCardStack;
