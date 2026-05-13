/* ═══════════════════════════════════════════════════════════════
   script-db-patch.js  — Supabase sync layer for BlueLedger core
   ───────────────────────────────────────────────────────────────
   Load AFTER script.js AND blueledger-db.js.

   What this does:
   ───────────────
   1. After every card add/update → mirrors to Supabase `cards`
   2. After every transaction add/delete → mirrors to Supabase `transactions`
   3. After every budget save → mirrors to Supabase `budgets`
   4. On login → loads cloud data into in-memory arrays
   5. Exports `BL_CLOUD.*` helpers for the rest of the app

   What this does NOT do:
   ──────────────────────
   • Does NOT remove the encrypted localStorage vault — it remains
     as the auth-gate (PIN screen) and offline fallback.
   • Does NOT change any UI or DOM logic.
   • Does NOT touch passwords — Supabase Auth owns that entirely.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

(function () {
  /* ── Card UUID map: localCardIdx → Supabase card row id ──── */
  /* We keep this so we can associate transactions with cloud card ids */
  const _cardUuidMap = new Map(); /* cardIdx → supabase uuid */

  function _db() {
    return window.BL_DB || null;
  }

  /* ══════════════════════════════════════════════════════════
     LOAD CLOUD DATA INTO MEMORY
     Called after successful login / auth state change.
     ══════════════════════════════════════════════════════════ */

  async function loadCloudData() {
    const db = _db();
    if (!db) return;

    const uid = await db.getCurrentUserId();
    if (!uid) return;

    try {
      /* 1. Load cards from cloud */
      const cloudCards = await db.getCards();
      if (!Array.isArray(cloudCards) || cloudCards.length === 0) {
        /* No cloud data yet — nothing to restore */
        return;
      }

      /* 2. For each cloud card, load its transactions */
      const builtCards = [];
      for (let i = 0; i < cloudCards.length; i++) {
        const cc = cloudCards[i];
        _cardUuidMap.set(i, cc.id);

        const txns = await db.getTransactions({ cardId: cc.id, limit: 2000 });
        const now = new Date().toISOString().slice(0, 7);
        const budget = await db.getBudget(cc.id, now);

        /* Re-hydrate into the legacy in-memory card shape */
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

      if (builtCards.length === 0) return;

      /* 3. Overwrite in-memory state — this is the cross-device sync moment */
      if (typeof applyVaultPayload === "function") {
        applyVaultPayload({ cards: builtCards, activeCardIdx: 0 });
      } else {
        /* Fallback: set globals directly */
        window.cards = builtCards;
        window.activeCardIdx = 0;
        if (typeof loadActiveCard === "function") loadActiveCard();
      }

      if (typeof refreshAll === "function") refreshAll();
      if (typeof renderCardSwitcher === "function") renderCardSwitcher();
      if (typeof notify === "function")
        notify("Cloud data loaded ☁️", "success");
    } catch (err) {
      console.error("[SCRIPT-patch] loadCloudData error:", err.message);
    }
  }

  /* Map Supabase transaction row → legacy local transaction shape */
  function _cloudTxnToLocal(t) {
    return {
      id: t.id,
      type: t.transaction_type,
      amount: t.amount,
      category: t.category,
      desc: t.note,
      paymentMethod: t.payment_method,
      date: t.txn_date,
      _cloudId: t.id,
    };
  }

  /* ══════════════════════════════════════════════════════════
     PUSH CARD TO CLOUD  (called after addCard / updateCard)
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
        row = await db.updateCard(existingId, payload);
      } else {
        row = await db.addCard(payload);
      }
      if (row?.id) {
        _cardUuidMap.set(cardIdx, row.id);
        /* Persist the cloud id back into userData so we can find it next time */
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

  /**
   * Call this after a new transaction is pushed into the local `transactions` array.
   * @param {Object} localTxn  — the local transaction object
   * @param {number} cardIdx   — current activeCardIdx
   */
  async function pushTransaction(localTxn, cardIdx) {
    const db = _db();
    if (!db) return;

    let cardId =
      _cardUuidMap.get(cardIdx) || window.cards?.[cardIdx]?.userData?._cloudId;

    /* If card not yet in cloud, push it first */
    if (!cardId) {
      await pushCard(cardIdx);
      cardId = _cardUuidMap.get(cardIdx);
    }
    if (!cardId) return; /* Still no cloud card — skip */

    try {
      const row = await db.addTransaction({
        card_id: cardId,
        amount: Math.abs(localTxn.amount || 0),
        transaction_type: localTxn.type === "income" ? "income" : "expense",
        category: localTxn.category || "Other",
        note: localTxn.desc || localTxn.note || "",
        payment_method: localTxn.paymentMethod || "",
        txn_date: localTxn.date || new Date().toISOString().slice(0, 10),
      });
      /* Attach cloud id to the local object for future reference */
      if (row?.id && localTxn) localTxn._cloudId = row.id;
    } catch (err) {
      console.error("[SCRIPT-patch] pushTransaction error:", err.message);
    }
  }

  /**
   * Call this when a transaction is deleted locally.
   * @param {string} cloudId  — txn._cloudId (Supabase UUID)
   */
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
     PATCH saveToStorage  (the core save function in script.js)
     ══════════════════════════════════════════════════════════ */

  const _origSaveToStorage = window.saveToStorage;
  window.saveToStorage = function (options = {}) {
    /* Always call the original (keeps encrypted vault + cloud sync intact) */
    if (typeof _origSaveToStorage === "function") _origSaveToStorage(options);

    /* Mirror to Supabase asynchronously (fire-and-forget) */
    const idx =
      typeof window.activeCardIdx === "number" ? window.activeCardIdx : 0;
    pushCard(idx).catch(() => {});
  };

  /* ══════════════════════════════════════════════════════════
     PATCH addTransaction / deleteTransaction in script.js
     ══════════════════════════════════════════════════════════ */

  /* We intercept the global addIncome / addExpense flow by wrapping
     the final notify call site.  Because script.js constructs the txn
     object inline, the cleanest approach is to wrap the global
     `saveToStorage` (done above) AND expose a hook the app calls. */

  /**
   * Call this from script.js right after pushing a new txn into `transactions[]`.
   * Example (in script.js addIncome / addExpense):
   *   transactions.unshift(txn);
   *   BL_CLOUD.onTransactionAdded(txn);   ← add this line
   */
  function onTransactionAdded(txn) {
    const idx =
      typeof window.activeCardIdx === "number" ? window.activeCardIdx : 0;
    pushTransaction(txn, idx).catch(() => {});
  }

  /**
   * Call this from script.js right before splicing a txn out of `transactions[]`.
   *   BL_CLOUD.onTransactionDeleted(txn._cloudId);   ← add this line
   */
  function onTransactionDeleted(cloudId) {
    deleteTransaction(cloudId).catch(() => {});
  }

  /**
   * Call this after saving budgets (saveBudgets / budget modal close).
   *   BL_CLOUD.onBudgetSaved();   ← add this line
   */
  function onBudgetSaved() {
    const idx =
      typeof window.activeCardIdx === "number" ? window.activeCardIdx : 0;
    pushBudget(idx).catch(() => {});
  }

  /* ══════════════════════════════════════════════════════════
     REAL-TIME SUBSCRIPTION
     Subscribe after cloud data is loaded so we receive updates
     from other devices instantly.
     ══════════════════════════════════════════════════════════ */

  async function _subscribeRealtime(cardIdx) {
    const db = _db();
    if (!db) return;
    const cardId =
      _cardUuidMap.get(cardIdx) || window.cards?.[cardIdx]?.userData?._cloudId;
    if (!cardId) return;

    await db.subscribeToTransactions(cardId, async (payload) => {
      /* Another device made a change — reload from cloud */
      console.info(
        "[SCRIPT-patch] Realtime change detected. Reloading...",
        payload.eventType,
      );
      await loadCloudData();
    });
  }

  /* ══════════════════════════════════════════════════════════
     AUTO-INIT  (fires after Supabase auth is confirmed)
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

    /* Watch for future sign-ins */
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
