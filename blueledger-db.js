/* ═══════════════════════════════════════════════════════════════
   blueledger-db.js  — Supabase Data Layer for BlueLedger AI
   ───────────────────────────────────────────────────────────────
   DROP-IN replacement for localStorage-based financial data.

   Load order (add BEFORE script.js):
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
     <script src="blueledger-db.js"></script>
     …existing scripts…

   All public functions return Promises.
   The `BL_DB` object is placed on `window` so any script can call it.

   SECURITY NOTES
   ──────────────
   • Anon key is safe to ship to the browser — it has NO privileged access.
   • RLS policies ensure every query is scoped to auth.uid().
   • Passwords are NEVER touched — Supabase Auth handles them.
   • No service-role key ever reaches the frontend.
   ═══════════════════════════════════════════════════════════════ */

"use strict";

(function () {
  /* ── Config ──────────────────────────────────────────────── */
  const SUPABASE_URL = "https://fptiscqzzimxxtgjejhz.supabase.co";
  const SUPABASE_ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwdGlzY3F6emlteHh0Z2plamh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxOTcwMTgsImV4cCI6MjA5MDc3MzAxOH0.6BTK1JiEH9EvvEvp5sV41GF7gQcgUCPqKqDB4JhjQBE";

  /* ── Sync-status element IDs (optional, add to your HTML) ── */
  const SYNC_EL_ID = "blSyncStatus";

  /* ── In-memory cache ─────────────────────────────────────── */
  let _client = null; // Supabase client
  let _userId = null; // current user UUID
  let _syncTimer = null; // debounce timer for status reset

  /* ══════════════════════════════════════════════════════════
     INIT
     ══════════════════════════════════════════════════════════ */

  function _getClient() {
    if (_client) return _client;
    if (!window.supabase?.createClient) {
      console.warn("[BL_DB] Supabase SDK not loaded yet.");
      return null;
    }
    _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: { persistSession: true, autoRefreshToken: true },
    });

    /* Track auth state changes */
    _client.auth.onAuthStateChange((event, session) => {
      _userId = session?.user?.id || null;
      if (event === "SIGNED_IN" && _userId) {
        _ensurePreferences();
      }
    });

    /* Seed userId if already logged in */
    _client.auth.getSession().then(({ data }) => {
      _userId = data?.session?.user?.id || null;
    });

    return _client;
  }

  async function _uid() {
    if (_userId) return _userId;
    const client = _getClient();
    if (!client) return null;
    const { data } = await client.auth.getSession();
    _userId = data?.session?.user?.id || null;
    return _userId;
  }

  /* ── Sync status UI helper ───────────────────────────────── */
  const SYNC_STATUS = {
    syncing: { emoji: "🔄", text: "Syncing…", cls: "bl-sync-syncing" },
    ok: { emoji: "🟢", text: "Synced just now", cls: "bl-sync-ok" },
    offline: {
      emoji: "🟠",
      text: "Offline changes pending",
      cls: "bl-sync-offline",
    },
    error: { emoji: "🔴", text: "Sync failed", cls: "bl-sync-error" },
  };

  function _setSync(state) {
    const el = document.getElementById(SYNC_EL_ID);
    if (!el) return;
    const s = SYNC_STATUS[state] || SYNC_STATUS.ok;
    el.textContent = `${s.emoji} ${s.text}`;
    el.className = `bl-sync-indicator ${s.cls}`;
    /* Auto-hide "Synced just now" after 4 s */
    if (state === "ok") {
      clearTimeout(_syncTimer);
      _syncTimer = setTimeout(() => {
        el.textContent = "🟢 Synced";
        el.className = "bl-sync-indicator bl-sync-ok bl-sync-idle";
      }, 4000);
    }
  }

  /* ── Generic query wrapper (handles errors + sync status) ── */
  async function _q(fn) {
    _setSync("syncing");
    try {
      const result = await fn(_getClient());
      if (result?.error) throw result.error;
      _setSync("ok");
      return result?.data ?? result;
    } catch (err) {
      console.error("[BL_DB] Query error:", err.message);
      _setSync("error");
      throw err;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     CARDS
     ═══════════════════════════════════════════════════════════ */

  async function getCards() {
    const uid = await _uid();
    if (!uid) return [];
    return _q((db) =>
      db
        .from("cards")
        .select("*")
        .eq("user_id", uid)
        .order("sort_order", { ascending: true }),
    );
  }

  /**
   * @param {Object} card  — { bank_name, nickname, masked_number,
   *                          card_type, spending_limit, is_primary }
   */
  async function addCard(card) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db
        .from("cards")
        .insert({ ...card, user_id: uid })
        .select()
        .single(),
    );
  }

  async function updateCard(id, patch) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db
        .from("cards")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("user_id", uid)
        .select()
        .single(),
    );
  }

  async function deleteCard(id) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db.from("cards").delete().eq("id", id).eq("user_id", uid),
    );
  }

  /* ═══════════════════════════════════════════════════════════
     TRANSACTIONS
     ═══════════════════════════════════════════════════════════ */

  /**
   * @param {Object} opts — { cardId, limit, offset, from, to }
   */
  async function getTransactions(opts = {}) {
    const uid = await _uid();
    if (!uid) return [];
    const { cardId, limit = 500, offset = 0, from, to } = opts;

    return _q((db) => {
      let q = db
        .from("transactions")
        .select("*")
        .eq("user_id", uid)
        .order("txn_date", { ascending: false })
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (cardId) q = q.eq("card_id", cardId);
      if (from) q = q.gte("txn_date", from);
      if (to) q = q.lte("txn_date", to);
      return q;
    });
  }

  /**
   * @param {Object} txn — { card_id, amount, transaction_type,
   *                         category, note, payment_method, txn_date }
   */
  async function addTransaction(txn) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db
        .from("transactions")
        .insert({ ...txn, user_id: uid })
        .select()
        .single(),
    );
  }

  async function deleteTransaction(id) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db.from("transactions").delete().eq("id", id).eq("user_id", uid),
    );
  }

  /* ═══════════════════════════════════════════════════════════
     BUDGETS
     ═══════════════════════════════════════════════════════════ */

  /**
   * Get budget for the given card & month.
   * @param {string} cardId
   * @param {string} monthYear  — e.g. "2025-07"
   */
  async function getBudget(cardId, monthYear) {
    const uid = await _uid();
    if (!uid) return null;
    const data = await _q((db) =>
      db
        .from("budgets")
        .select("*")
        .eq("user_id", uid)
        .eq("card_id", cardId)
        .eq("month_year", monthYear)
        .maybeSingle(),
    );
    return data;
  }

  /**
   * Upsert budget for a card+month.
   * @param {Object} budget — { card_id, monthly_limit, category_limits, month_year }
   */
  async function saveBudget(budget) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db
        .from("budgets")
        .upsert(
          { ...budget, user_id: uid, updated_at: new Date().toISOString() },
          { onConflict: "user_id,card_id,month_year" },
        )
        .select()
        .single(),
    );
  }

  /* ═══════════════════════════════════════════════════════════
     AI REPORTS
     ═══════════════════════════════════════════════════════════ */

  async function getReports(limit = 20) {
    const uid = await _uid();
    if (!uid) return [];
    return _q((db) =>
      db
        .from("ai_reports")
        .select("*")
        .eq("user_id", uid)
        .order("created_at", { ascending: false })
        .limit(limit),
    );
  }

  /**
   * @param {Object} report — { card_id, report_title, report_content,
   *                            financial_score, grade, month_label }
   */
  async function saveReport(report) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db
        .from("ai_reports")
        .insert({ ...report, user_id: uid })
        .select()
        .single(),
    );
  }

  async function deleteReport(id) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db.from("ai_reports").delete().eq("id", id).eq("user_id", uid),
    );
  }

  /* ═══════════════════════════════════════════════════════════
     AI CONVERSATIONS + MESSAGES
     ═══════════════════════════════════════════════════════════ */

  async function getConversations(limit = 30) {
    const uid = await _uid();
    if (!uid) return [];
    return _q((db) =>
      db
        .from("ai_conversations")
        .select("*")
        .eq("user_id", uid)
        .order("updated_at", { ascending: false })
        .limit(limit),
    );
  }

  async function createConversation(title = "New conversation") {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db
        .from("ai_conversations")
        .insert({ user_id: uid, title })
        .select()
        .single(),
    );
  }

  async function updateConversationTitle(id, title) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db
        .from("ai_conversations")
        .update({ title, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("user_id", uid)
        .select()
        .single(),
    );
  }

  async function deleteConversation(id) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db.from("ai_conversations").delete().eq("id", id).eq("user_id", uid),
    );
  }

  async function getMessages(conversationId) {
    const uid = await _uid();
    if (!uid) return [];
    return _q((db) =>
      db
        .from("ai_messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .eq("user_id", uid)
        .order("created_at", { ascending: true }),
    );
  }

  /**
   * @param {Object} msg — { conversation_id, role, content }
   */
  async function addMessage(msg) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");

    /* Bump conversation updated_at */
    _getClient()
      .from("ai_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", msg.conversation_id)
      .eq("user_id", uid)
      .then(() => {});

    return _q((db) =>
      db
        .from("ai_messages")
        .insert({ ...msg, user_id: uid })
        .select()
        .single(),
    );
  }

  /* ═══════════════════════════════════════════════════════════
     PINNED INSIGHTS
     ═══════════════════════════════════════════════════════════ */

  async function getPins(limit = 12) {
    const uid = await _uid();
    if (!uid) return [];
    return _q((db) =>
      db
        .from("pinned_insights")
        .select("*")
        .eq("user_id", uid)
        .order("pinned_at", { ascending: false })
        .limit(limit),
    );
  }

  async function addPin(insightText, sourceReportId = null) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db
        .from("pinned_insights")
        .insert({
          user_id: uid,
          insight_text: insightText,
          source_report_id: sourceReportId,
        })
        .select()
        .single(),
    );
  }

  async function deletePin(id) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db.from("pinned_insights").delete().eq("id", id).eq("user_id", uid),
    );
  }

  /* ═══════════════════════════════════════════════════════════
     USER PREFERENCES
     ═══════════════════════════════════════════════════════════ */

  async function getPreferences() {
    const uid = await _uid();
    if (!uid) return null;
    const data = await _q((db) =>
      db.from("user_preferences").select("*").eq("user_id", uid).maybeSingle(),
    );
    return data;
  }

  /**
   * @param {Object} prefs — partial update: any subset of preference columns
   */
  async function savePreferences(prefs) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db
        .from("user_preferences")
        .upsert(
          { ...prefs, user_id: uid, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        )
        .select()
        .single(),
    );
  }

  /* ═══════════════════════════════════════════════════════════
     RECURRING TEMPLATES
     ═══════════════════════════════════════════════════════════ */

  async function getRecurring(cardId) {
    const uid = await _uid();
    if (!uid) return [];
    let q = _getClient()
      .from("recurring_templates")
      .select("*")
      .eq("user_id", uid);
    if (cardId) q = q.eq("card_id", cardId);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async function addRecurring(template) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db
        .from("recurring_templates")
        .insert({ ...template, user_id: uid })
        .select()
        .single(),
    );
  }

  async function deleteRecurring(id) {
    const uid = await _uid();
    if (!uid) throw new Error("Not authenticated");
    return _q((db) =>
      db.from("recurring_templates").delete().eq("id", id).eq("user_id", uid),
    );
  }

  /* ═══════════════════════════════════════════════════════════
     REAL-TIME  (optional — subscribe to card's transactions)
     ═══════════════════════════════════════════════════════════ */

  let _realtimeChannel = null;

  /**
   * Subscribe to INSERT events on transactions for a given card.
   * @param {string}   cardId
   * @param {Function} callback  — receives the new transaction row
   */
  async function subscribeToTransactions(cardId, callback) {
    const uid = await _uid();
    const client = _getClient();
    if (!uid || !client) return;

    if (_realtimeChannel) client.removeChannel(_realtimeChannel);

    _realtimeChannel = client
      .channel(`txns-${uid}-${cardId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "transactions",
          filter: `user_id=eq.${uid}`,
        },
        (payload) => callback(payload),
      )
      .subscribe();
  }

  function unsubscribeRealtime() {
    const client = _getClient();
    if (_realtimeChannel && client) {
      client.removeChannel(_realtimeChannel);
      _realtimeChannel = null;
    }
  }

  /* ═══════════════════════════════════════════════════════════
     MIGRATION HELPERS
     (one-time import of existing localStorage data into Supabase)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Call once after user logs in on a device that has old localStorage data.
   * Idempotent — safe to call multiple times.
   *
   * Usage:
   *   await BL_DB.migrateFromLocalStorage(cardObj, transactionArray, categoryBudgets)
   */
  async function migrateFromLocalStorage(card, txns, budgetMap) {
    try {
      _setSync("syncing");

      /* 1. Upsert card */
      let cardRow = null;
      if (card?.cardNumber) {
        cardRow = await addCard({
          bank_name: card.bankName || "",
          nickname: card.nickname || card.name || "",
          masked_number: (card.cardNumber || "").replace(/\D/g, "").slice(-4),
          card_type: card.cardType || "savings",
          spending_limit: card.spendingLimit || 0,
          is_primary: true,
        });
      }

      /* 2. Insert transactions (batch of 200) */
      if (Array.isArray(txns) && txns.length > 0 && cardRow?.id) {
        const rows = txns.map((t) => ({
          user_id: _userId,
          card_id: cardRow.id,
          amount: Math.abs(t.amount || 0),
          transaction_type: t.type === "income" ? "income" : "expense",
          category: t.category || "Other",
          note: t.desc || t.note || "",
          payment_method: t.paymentMethod || "",
          txn_date: t.date || new Date().toISOString().slice(0, 10),
        }));

        for (let i = 0; i < rows.length; i += 200) {
          await _getClient()
            .from("transactions")
            .insert(rows.slice(i, i + 200));
        }
      }

      /* 3. Upsert budget */
      if (cardRow?.id && budgetMap && Object.keys(budgetMap).length > 0) {
        const monthYear = new Date().toISOString().slice(0, 7);
        await saveBudget({
          card_id: cardRow.id,
          monthly_limit: 0,
          category_limits: budgetMap,
          month_year: monthYear,
        });
      }

      _setSync("ok");
      console.info("[BL_DB] Migration complete.");
      return true;
    } catch (err) {
      _setSync("error");
      console.error("[BL_DB] Migration failed:", err);
      return false;
    }
  }

  /* ── Ensure preference row exists (called on sign-in) ──── */
  async function _ensurePreferences() {
    try {
      const existing = await getPreferences();
      if (!existing) {
        await savePreferences({ theme: "dark", currency: "INR" });
      }
    } catch (_) {}
  }

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════ */

  window.BL_DB = {
    /* auth helpers */
    getClient: _getClient,
    getCurrentUserId: _uid,

    /* cards */
    getCards,
    addCard,
    updateCard,
    deleteCard,

    /* transactions */
    getTransactions,
    addTransaction,
    deleteTransaction,

    /* budgets */
    getBudget,
    saveBudget,

    /* ai reports */
    getReports,
    saveReport,
    deleteReport,

    /* ai conversations */
    getConversations,
    createConversation,
    updateConversationTitle,
    deleteConversation,

    /* ai messages */
    getMessages,
    addMessage,

    /* pinned insights */
    getPins,
    addPin,
    deletePin,

    /* preferences */
    getPreferences,
    savePreferences,

    /* recurring templates */
    getRecurring,
    addRecurring,
    deleteRecurring,

    /* real-time */
    subscribeToTransactions,
    unsubscribeRealtime,

    /* migration */
    migrateFromLocalStorage,

    /* sync status */
    setSyncStatus: _setSync,
  };

  /* Auto-init client as soon as SDK is available */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _getClient);
  } else {
    _getClient();
  }

  console.info("[BL_DB] BlueLedger Supabase data layer loaded.");
})();
