/* ═══════════════════════════════════════════════════════════════════
   BlueLedger — Card Stack Logic v3
   Interaction: Click / Swipe / Arrow → 3D Y-axis flip
   Replaces: hover-based stacking
   Constraints:
     - window.renderCardStack() API preserved (called by script.js)
     - activeCardIdx / switchCard() / CARD_ACCENT_COLORS from script.js
     - cardStackContainer, cardStackDots IDs preserved
   ═══════════════════════════════════════════════════════════════════ */

(function () {
  "use strict";

  /* ── State ──────────────────────────────────────────────────────── */
  let _isAnimating = false;
  let _touchStartX = 0;
  let _touchStartY = 0;
  const FLIP_DURATION = 480; // ms — matches CSS transition

  /* ── Helpers ────────────────────────────────────────────────────── */
  function getCards() {
    return window.cards || [];
  }

  function getActiveIdx() {
    return window.activeCardIdx ?? 0;
  }

  function getAccentColor(idx) {
    const colors = window.CARD_ACCENT_COLORS || [
      "#10b981",
      "#3b82f6",
      "#f59e0b",
      "#ec4899",
    ];
    return colors[idx % colors.length];
  }

  function fmt(n) {
    if (typeof window.fmt === "function") return window.fmt(n);
    return "₹" + Number(n || 0).toLocaleString("en-IN");
  }

  function getCardDisplayName(card, idx) {
    if (typeof window.getCardDisplayName === "function")
      return window.getCardDisplayName(card, idx);
    return card?.userData?.nickname?.trim() || card?.userData?.name || "Card";
  }

  /* ── Build single card face HTML ────────────────────────────────── */
  function buildCardHTML(card, idx) {
    const ud = card?.userData || {};
    const accent = getAccentColor(idx);

    // Theme index drives the CSS gradient class
    const themeIdx = idx % 4;

    // Card number: show last 4 real, rest as dots
    const rawNum = String(ud.cardNumber || "").replace(/\D/g, "");
    const last4 = rawNum.slice(-4) || "0000";
    const displayNum = `•••• •••• •••• ${last4}`;

    // Spending progress
    const limit = Number(ud.spendingLimit || ud.limit || 0);
    const spent = (card.transactions || [])
      .filter((t) => t.type === "expense")
      .reduce((s, t) => s + Number(t.amount || 0), 0);
    const pct = limit > 0 ? Math.min((spent / limit) * 100, 100) : 0;
    const danger = pct >= 90 ? "ci-progress-danger" : "";

    const name = (ud.name || "Cardholder").toUpperCase();
    const bank = (
      ud.nickname?.trim() ||
      ud.name?.split(" ")[0] ||
      "CARD"
    ).toUpperCase();

    return `
      <div class="cs-flip-card__face"
           data-theme="${themeIdx}"
           style="--card-accent:${accent}88; --card-accent-glow:${accent}33; border-color:${accent}33;">

        <!-- Shine overlay -->
        <div class="cs-flip-card__shine" aria-hidden="true"></div>

        <!-- Ambient glow blobs -->
        <div class="cs-flip-card__blob cs-flip-card__blob--tl" aria-hidden="true"></div>
        <div class="cs-flip-card__blob cs-flip-card__blob--br" aria-hidden="true"></div>

        <!-- Top row: bank / chip -->
        <div class="ci-top">
          <span class="ci-nick">${bank}</span>
          <div class="ci-chip"></div>
        </div>

        <!-- Card number -->
        <div class="ci-number">${displayNum}</div>

        <!-- Bottom row: holder + expiry -->
        <div class="ci-bottom">
          <div>
            <div class="ci-holder">${name}</div>
            <div class="ci-bank" style="margin-top:2px;font-size:0.58rem;opacity:0.4;">
              ${card.isPrimary ? "PRIMARY" : ""}
            </div>
          </div>
          <div class="ci-expiry-col">
            <div class="ci-exp-label">VALID THRU</div>
            <div class="ci-exp-val">••/••</div>
          </div>
        </div>

        <!-- Spending section -->
        <div class="ci-spending">
          <div class="ci-spend-row">
            <span>Spending limit</span>
            <span class="ci-spend-limit">${limit > 0 ? fmt(limit) : "—"}</span>
          </div>
          ${
            limit > 0
              ? `<div class="ci-spend-used">Used: ${fmt(spent)}</div>
          <div class="ci-progress">
            <div class="ci-progress-fill ${danger}" style="width:${pct}%"></div>
          </div>`
              : ""
          }
        </div>
      </div>
    `;
  }

  /* ── Build dots ─────────────────────────────────────────────────── */
  function renderDots(total, activeIdx) {
    const dotsEl = document.getElementById("cardStackDots");
    if (!dotsEl) return;

    if (total <= 1) {
      dotsEl.innerHTML = "";
      return;
    }

    dotsEl.innerHTML = Array.from({ length: total }, (_, i) => {
      const active = i === activeIdx ? "is-active" : "";
      return `<span class="cs-dot ${active}" onclick="window._csFlipTo(${i})" aria-label="Card ${i + 1}"></span>`;
    }).join("");
  }

  /* ── Core render function (called by script.js via window.renderCardStack) */
  function renderCardStack() {
    const container = document.getElementById("cardStackContainer");
    if (!container) return;

    const cards = getCards();
    const activeIdx = getActiveIdx();

    /* ── Empty state ────────────────────────────────────────────── */
    if (!cards.length) {
      container.innerHTML = `
        <div class="csv2-empty-state" onclick="addNewCard()">
          <div class="csv2-empty-icon"><i class="fas fa-credit-card"></i></div>
          <div class="csv2-empty-title">No card added yet</div>
          <div class="csv2-empty-sub">Tap to add your first card</div>
          <div class="csv2-empty-btn">+ Add Card</div>
        </div>`;
      renderDots(0, 0);
      return;
    }

    /* ── Build flip scene ───────────────────────────────────────── */
    // The scene holds all cards; only the active one is visible.
    // We use a simple opacity + rotateY approach rather than 3D stacking.

    const card = cards[activeIdx];
    const themeIdx = activeIdx % 4;
    const accent = getAccentColor(activeIdx);

    container.innerHTML = `
      <div class="cs-flip-scene" id="csFlipScene">
        <div class="cs-flip-card" id="csFlipCard" data-theme="${themeIdx}"
             style="--card-accent:${accent}88; --card-accent-glow:${accent}33; border-color:${accent}33;"
             onclick="window._csFlipNext()"
             role="button"
             aria-label="Switch to next card">
          ${buildCardHTML(card, activeIdx)}
        </div>
      </div>

      <!-- Navigation arrows (only shown for 2+ cards) -->
      ${
        cards.length > 1
          ? `
      <div class="cs-flip-nav" aria-label="Card navigation">
        <button class="cs-flip-arrow cs-flip-arrow--prev"
                onclick="event.stopPropagation(); window._csFlipPrev()"
                aria-label="Previous card">
          <i class="fas fa-chevron-left"></i>
        </button>
        <button class="cs-flip-arrow cs-flip-arrow--next"
                onclick="event.stopPropagation(); window._csFlipNext()"
                aria-label="Next card">
          <i class="fas fa-chevron-right"></i>
        </button>
      </div>`
          : ""
      }
    `;

    renderDots(cards.length, activeIdx);
    attachTouchHandlers();
  }

  /* ── Flip animation core ────────────────────────────────────────── */
  function flipTo(nextIdx) {
    if (_isAnimating) return;

    const cards = getCards();
    if (!cards.length) return;

    const clampedIdx = ((nextIdx % cards.length) + cards.length) % cards.length;

    if (clampedIdx === getActiveIdx()) return;

    _isAnimating = true;

    const scene = document.getElementById("csFlipScene");
    const flipCard = document.getElementById("csFlipCard");
    if (!scene || !flipCard) {
      _isAnimating = false;
      return;
    }

    /* Phase 1: rotate current card out (0 → 90deg) */
    flipCard.style.transition = `transform ${FLIP_DURATION / 2}ms cubic-bezier(0.4, 0, 0.6, 1)`;
    flipCard.style.transform = "rotateY(-90deg) scale(0.95)";

    setTimeout(() => {
      /* Phase 2: swap content while card is edge-on */

      /* ── CRITICAL ORDER: save OLD card FIRST, then move index ──
         syncActiveToCards() writes window.transactions into cards[activeCardIdx].
         It MUST run before activeCardIdx changes — otherwise it stamps the
         new card's empty state over the old card's transaction history. */
      try {
        if (typeof window.syncActiveToCards === "function") {
          window.syncActiveToCards();
        }
      } catch (e) {
        console.warn("[CardStack] syncActiveToCards error:", e);
      }

      /* Safe to advance the index now — old card's data is preserved */
      window.activeCardIdx = clampedIdx;

      const newCard = cards[clampedIdx];
      const themeIdx = clampedIdx % 4;
      const accent = getAccentColor(clampedIdx);

      flipCard.dataset.theme = themeIdx;
      flipCard.style.setProperty("--card-accent", accent + "88");
      flipCard.style.setProperty("--card-accent-glow", accent + "33");
      flipCard.style.borderColor = accent + "33";
      flipCard.innerHTML = buildCardHTML(newCard, clampedIdx);

      /* Phase 3: rotate new card in (90 → 0deg) */
      flipCard.style.transition = "none";
      flipCard.style.transform = "rotateY(90deg) scale(0.95)";

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          flipCard.style.transition = `transform ${FLIP_DURATION / 2}ms cubic-bezier(0.4, 0, 0.2, 1)`;
          flipCard.style.transform = "rotateY(0deg) scale(1)";
        });
      });

      /* Update dots */
      renderDots(cards.length, clampedIdx);

      /* Load new card's data and refresh all UI */
      try {
        // loadActiveCard reads cards[activeCardIdx].transactions → window.transactions
        if (typeof window.loadActiveCard === "function") {
          window.loadActiveCard();
        }
        if (typeof window.updateMyCardWidget === "function") {
          window.updateMyCardWidget();
        }
        if (typeof window.renderCardSwitcher === "function") {
          window.renderCardSwitcher();
        }
        // Reset search/filter so new card's list renders cleanly
        if (typeof window.searchQuery !== "undefined") window.searchQuery = "";
        const si = document.getElementById("txnSearch");
        if (si) si.value = "";
        if (typeof window.filterCfg !== "undefined")
          window.filterCfg = { type: "all", cats: [] };
        // Re-render transactions, charts, and summary for new card
        if (typeof window.refreshAll === "function") {
          window.refreshAll();
        }
        if (typeof window.processRecurring === "function") {
          window.processRecurring();
        }
      } catch (e) {
        console.warn("[CardStack] load/refresh error:", e);
      }

      setTimeout(() => {
        _isAnimating = false;
      }, FLIP_DURATION / 2);
    }, FLIP_DURATION / 2);
  }

  /* ── Touch / swipe handlers ─────────────────────────────────────── */
  function attachTouchHandlers() {
    const scene = document.getElementById("csFlipScene");
    if (!scene) return;

    scene.addEventListener(
      "touchstart",
      (e) => {
        _touchStartX = e.changedTouches[0].clientX;
        _touchStartY = e.changedTouches[0].clientY;
      },
      { passive: true },
    );

    scene.addEventListener(
      "touchend",
      (e) => {
        const dx = e.changedTouches[0].clientX - _touchStartX;
        const dy = e.changedTouches[0].clientY - _touchStartY;

        // Only respond to horizontal swipes > 40px with less vertical drift
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          if (dx < 0) {
            flipTo(getActiveIdx() + 1); // swipe left → next
          } else {
            flipTo(getActiveIdx() - 1); // swipe right → prev
          }
        }
      },
      { passive: true },
    );
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  window.renderCardStack = renderCardStack;

  window._csFlipNext = function () {
    const cards = getCards();
    if (cards.length <= 1) return;
    flipTo(getActiveIdx() + 1);
  };

  window._csFlipPrev = function () {
    const cards = getCards();
    if (cards.length <= 1) return;
    flipTo(getActiveIdx() - 1);
  };

  window._csFlipTo = function (idx) {
    flipTo(idx);
  };

  /* ── Keyboard navigation (when card panel is focused) ───────────── */
  document.addEventListener("keydown", (e) => {
    // Only activate if focus is near the card panel
    const panel = document.querySelector(".db-card-panel");
    if (!panel) return;
    if (!panel.matches(":hover") && !panel.contains(document.activeElement))
      return;

    if (e.key === "ArrowRight") window._csFlipNext();
    if (e.key === "ArrowLeft") window._csFlipPrev();
  });
})();
