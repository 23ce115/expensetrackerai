/* ═══════════════════════════════════════════════════════════════
   script-db-patch.js  — Supabase sync layer for BlueLedger core
   ───────────────────────────────────────────────────────────────
   Load AFTER script.js AND blueledger-db.js.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

(function () {
  const _cardUuidMap = new Map();

  /* ── guard: prevent loadCloudData re-entering while running ── */
  let _cloudLoadInProgress = false;

  function _db() {
    return window.BL_DB || null;
  }

  /* ══════════════════════════════════════════════════════════
     LOAD CLOUD DATA INTO MEMORY
     ══════════════════════════════════════════════════════════ */

  async function loadCloudData() {
    const db = _db();
    if (!db) return;
    if (_cloudLoadInProgress) return; /* ← prevent re-entrant calls */
    _cloudLoadInProgress = true;

    const uid = await db.getCurrentUserId();
    if (!uid) {
      _cloudLoadInProgress = false;
      return;
    }

    try {
      const cloudCards = await db.getCards();
      if (!Array.isArray(cloudCards) || cloudCards.length === 0) {
        _cloudLoadInProgress = false;
        return;
      }

      const builtCards = [];
      for (let i = 0; i < cloudCards.length; i++) {
        const cc = cloudCards[i];
        _cardUuidMap.set(i, cc.id);

        const txns = await db.getTransactions({ cardId: cc.id, limit: 2000 });
        const now = new Date().toISOString().slice(0, 7);
        const budget = await db.getBudget(cc.id, now);

        builtCards.push({
          userData: {
            name: cc.nickname || "",
            nickname: cc.nickname || "",
            bank: cc.bank_name || "",
            cardNumber: cc.masked_number || "0000",
            cardType: cc.card_type || "savings",
            spendingLimit: cc.spending_limit || 0,
            _cloudId: cc.id,
          },
          transactions: (txns || []).map(_cloudTxnToLocal),
          customCategories: [],
          categoryBudgets: budget?.category_limits || {},
          recurringTemplates: [],
        });
      }

      if (builtCards.length === 0) {
        _cloudLoadInProgress = false;
        return;
      }

      if (typeof applyVaultPayload === "function") {
        applyVaultPayload({ cards: builtCards, activeCardIdx: 0 });
      } else {
        window.cards = builtCards;
        window.activeCardIdx = 0;
        if (typeof loadActiveCard === "function") loadActiveCard();
      }

      if (typeof refreshAll === "function") refreshAll();
      if (typeof renderCardSwitcher === "function") renderCardSwitcher();
    } catch (err) {
      console.error("[SCRIPT-patch] loadCloudData error:", err.message);
    } finally {
      _cloudLoadInProgress = false;
    }
  }

  /* ── Map Supabase row → local transaction shape ───────────── */
  function _cloudTxnToLocal(t) {
    const isExpense = t.transaction_type === "expense";
    return {
      id: t.id,
      type: t.transaction_type /* "income" | "expense" */,
      amount: isExpense
        ? -Math.abs(t.amount)
        : Math.abs(t.amount) /* correct sign */,
      category: t.category,
      desc: t.note,
      description: t.note /* script.js uses both field names */,
      paymentMethod: t.payment_method,
      date: t.txn_date,
      _cloudId: t.id,
    };
  }

  /* ══════════════════════════════════════════════════════════
     PUSH CARD TO CLOUD
     Only called explicitly (addCard / card settings save).
     NOT called on every saveToStorage.
     ══════════════════════════════════════════════════════════ */

  async function pushCard(cardIdx) {
    const db = _db();
    if (!db) return;

    const card = (window.cards || [])[cardIdx];
    if (!card?.userData) return;

    const u = card.userData;
    const payload = {
      bank_name: u.bank || u.bankName || "",
      nickname: u.nickname || u.name || "",
      masked_number: String(u.cardNumber || "")
        .replace(/\D/g, "")
        .slice(-4),
      card_type: (u.cardType || "savings").toLowerCase(),
      spending_limit: u.spendingLimit || 0,
      is_primary: cardIdx === 0,
      sort_order: cardIdx,
    };

    try {
      const existingId = _cardUuidMap.get(cardIdx) || u._cloudId;
      let row;
      if (existingId) {
        try {
          row = await db.updateCard(existingId, payload);
        } catch (updateErr) {
          /* 406 = stale UUID, row deleted — insert fresh */
          console.warn(
            "[SCRIPT-patch] updateCard 406, reinserting:",
            updateErr.message,
          );
          _cardUuidMap.delete(cardIdx);
          if (window.cards?.[cardIdx])
            delete window.cards[cardIdx].userData._cloudId;
          row = await db.addCard(payload);
        }
      } else {
        row = await db.addCard(payload);
      }
      if (row?.id) {
        _cardUuidMap.set(cardIdx, row.id);
        if (window.cards?.[cardIdx]) {
          window.cards[cardIdx].userData._cloudId = row.id;
        }
      }
    } catch (err) {
      console.error("[SCRIPT-patch] pushCard error:", err.message);
    }
  }

  /* ══════════════════════════════════════════════════════════
     PUSH TRANSACTION TO CLOUD
     ══════════════════════════════════════════════════════════ */

  async function pushTransaction(localTxn, cardIdx) {
    const db = _db();
    if (!db) return;

    let cardId =
      _cardUuidMap.get(cardIdx) || window.cards?.[cardIdx]?.userData?._cloudId;

    if (!cardId) {
      await pushCard(cardIdx);
      cardId = _cardUuidMap.get(cardIdx);
    }
    if (!cardId) return;

    try {
      const row = await db.addTransaction({
        card_id: cardId,
        amount: Math.abs(localTxn.amount || 0),
        transaction_type:
          localTxn.type === "income" ? "income" : "expense" /* ← explicit */,
        category: localTxn.category || "Other",
        note: localTxn.desc || localTxn.description || localTxn.note || "",
        payment_method: localTxn.paymentMethod || "",
        txn_date: localTxn.date || new Date().toISOString().slice(0, 10),
      });
      if (row?.id && localTxn) localTxn._cloudId = row.id;
    } catch (err) {
      console.error("[SCRIPT-patch] pushTransaction error:", err.message);
    }
  }

  async function deleteTransaction(cloudId) {
    const db = _db();
    if (!db || !cloudId) return;
    try {
      await db.deleteTransaction(cloudId);
    } catch (err) {
      console.error("[SCRIPT-patch] deleteTransaction error:", err.message);
    }
  }

  /* ══════════════════════════════════════════════════════════
     PUSH BUDGET TO CLOUD
     ══════════════════════════════════════════════════════════ */

  async function pushBudget(cardIdx) {
    const db = _db();
    if (!db) return;

    let cardId =
      _cardUuidMap.get(cardIdx) || window.cards?.[cardIdx]?.userData?._cloudId;
    if (!cardId) return;

    const catBudgets = window.categoryBudgets || {};
    const monthYear = new Date().toISOString().slice(0, 7);

    try {
      await db.saveBudget({
        card_id: cardId,
        monthly_limit: 0,
        category_limits: catBudgets,
        month_year: monthYear,
      });
    } catch (err) {
      console.error("[SCRIPT-patch] pushBudget error:", err.message);
    }
  }

  /* ══════════════════════════════════════════════════════════
     PATCH saveToStorage
     ── IMPORTANT: Do NOT call pushCard here. ──
     pushCard → Supabase card update → realtime fires →
     loadCloudData → overwrites freshly-added local transaction
     with stale cloud data. saveToStorage is called on every
     transaction add; card metadata rarely changes.
     Call BL_CLOUD.pushCard() explicitly only when card details
     are actually edited (addCard, settings save).
     ══════════════════════════════════════════════════════════ */

  const _origSaveToStorage = window.saveToStorage;
  window.saveToStorage = function (options = {}) {
    if (typeof _origSaveToStorage === "function") _origSaveToStorage(options);
    /* No pushCard here — intentional. See comment above. */
  };

  /* ══════════════════════════════════════════════════════════
     PUBLIC HOOKS  (called from script.js)
     ══════════════════════════════════════════════════════════ */

  function onTransactionAdded(txn) {
    const idx =
      typeof window.activeCardIdx === "number" ? window.activeCardIdx : 0;
    pushTransaction(txn, idx).catch(() => {});
  }

  function onTransactionDeleted(cloudId) {
    deleteTransaction(cloudId).catch(() => {});
  }

  function onBudgetSaved() {
    const idx =
      typeof window.activeCardIdx === "number" ? window.activeCardIdx : 0;
    pushBudget(idx).catch(() => {});
  }

  /* ══════════════════════════════════════════════════════════
     REAL-TIME SUBSCRIPTION
     Only reload on DELETE / UPDATE from other devices.
     INSERT events are our own writes — skip them to avoid
     overwriting fresh local state with stale cloud data.
     ══════════════════════════════════════════════════════════ */

  async function _subscribeRealtime(cardIdx) {
    const db = _db();
    if (!db) return;
    const cardId =
      _cardUuidMap.get(cardIdx) || window.cards?.[cardIdx]?.userData?._cloudId;
    if (!cardId) return;

    await db.subscribeToTransactions(cardId, async (payload) => {
      if (payload.eventType === "INSERT") return; /* skip own writes */
      console.info(
        "[SCRIPT-patch] Realtime change (external):",
        payload.eventType,
      );
      await loadCloudData();
    });
  }

  /* ══════════════════════════════════════════════════════════
     AUTO-INIT
     ══════════════════════════════════════════════════════════ */

  async function _init() {
    const db = _db();
    if (!db) {
      setTimeout(_init, 600);
      return;
    }

    const uid = await db.getCurrentUserId();
    if (uid) {
      await loadCloudData();
      await _subscribeRealtime(0);
    }

    const client = db.getClient();
    if (client) {
      client.auth.onAuthStateChange(async (event) => {
        if (event === "SIGNED_IN") {
          await loadCloudData();
          await _subscribeRealtime(0);
        } else if (event === "SIGNED_OUT") {
          db.unsubscribeRealtime();
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _init);
  } else {
    _init();
  }

  /* ══════════════════════════════════════════════════════════
     PUBLIC API
     ══════════════════════════════════════════════════════════ */

  window.BL_CLOUD = {
    loadCloudData,
    pushCard,
    pushTransaction,
    onTransactionAdded,
    onTransactionDeleted,
    onBudgetSaved,
  };

  console.info("[SCRIPT-patch] script-db-patch.js loaded.");
})();
