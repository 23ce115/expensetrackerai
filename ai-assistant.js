/* ═══════════════════════════════════════════════════════════════
   ai-assistant.js  —  BlueLedger Persistent Financial Copilot
   v3 — Full redesign: ChatGPT-style sidebar + analysis dashboard
        + persistent chat history + financial memory

   Architecture
   ─────────────
   BL_CHAT_STORE  : localStorage key "bl_ai_chats_v3"
   BL_PINS_STORE  : localStorage key "bl_ai_pins_v1"
   Analysis engine: local-first, zero API dependency for dashboard
   Chat engine    : _callAI with 20 s timeout + local fallback

   Depends on: utils.js, ai.js  (must load before this file)
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ══════════════════════════════════════════════════════════════
   CONSTANTS
   ══════════════════════════════════════════════════════════════ */

const BL_CHAT_STORE = "bl_ai_chats_v3";
const BL_PINS_STORE = "bl_ai_pins_v1";
const BL_SIDEBAR_KEY = "bl_ai_sidebar_v3";
const MAX_SESSIONS = 60;
const MAX_MSG_CTX = 20; // messages kept per session for context

/* ══════════════════════════════════════════════════════════════
   FINANCIAL ANALYSIS ENGINE  (pure functions, no side-effects)
   ══════════════════════════════════════════════════════════════ */

function _getTxns() {
  return typeof transactions !== "undefined" && Array.isArray(transactions)
    ? transactions
    : [];
}

function _thisMonthTxns() {
  const now = new Date();
  return _getTxns().filter((t) => {
    const d = new Date(t.date + "T00:00:00");
    return (
      d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    );
  });
}

function _lastMonthTxns() {
  const now = new Date();
  const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return _getTxns().filter((t) => {
    const d = new Date(t.date + "T00:00:00");
    return (
      d.getFullYear() === lm.getFullYear() && d.getMonth() === lm.getMonth()
    );
  });
}

function _sum(txns, type) {
  return txns
    .filter((t) => t.type === type)
    .reduce((s, t) => s + Math.abs(t.amount), 0);
}

function _catTotals(txns) {
  const map = {};
  txns
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      map[t.category] = (map[t.category] || 0) + Math.abs(t.amount);
    });
  return map;
}

function _dowTotals(txns) {
  const map = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  txns
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      map[new Date(t.date + "T00:00:00").getDay()] += Math.abs(t.amount);
    });
  return map;
}

function _avgDailyExpense(txns) {
  const days = Math.max(new Date().getDate(), 1);
  return (
    _sum(
      txns.filter((t) => t.type === "expense"),
      "expense",
    ) / days
  );
}

function _projectedMonthlySpend(txns) {
  const now = new Date();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.round(_avgDailyExpense(txns) * dim);
}

function _fastestGrowingCat() {
  const cur = _catTotals(_thisMonthTxns());
  const prev = _catTotals(_lastMonthTxns());
  let best = null,
    bestPct = 0;
  Object.keys(cur).forEach((cat) => {
    if (prev[cat] > 0) {
      const pct = ((cur[cat] - prev[cat]) / prev[cat]) * 100;
      if (pct > bestPct) {
        bestPct = pct;
        best = { category: cat, pct: Math.round(pct) };
      }
    }
  });
  return best;
}

/** Slim context for AI (~200 tokens, avoids 504 timeouts) */
function _buildFinanceCtx() {
  const txns = _getTxns();
  const now = new Date();
  const tm = _thisMonthTxns();
  const lm = _lastMonthTxns();
  const tmIn = _sum(tm, "income");
  const tmEx = _sum(tm, "expense");
  const lmEx = _sum(lm, "expense");
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dLeft = dim - now.getDate();
  const avgD = Math.round(_avgDailyExpense(tm));
  const proj = _projectedMonthlySpend(tm);
  const lim = (typeof userData !== "undefined" && userData?.spendingLimit) || 0;
  const savRate = tmIn > 0 ? Math.round(((tmIn - tmEx) / tmIn) * 100) : 0;
  const mom = lmEx > 0 ? Math.round(((tmEx - lmEx) / lmEx) * 100) : 0;
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const topDow = Object.entries(_dowTotals(tm)).sort((a, b) => b[1] - a[1])[0];

  const cats = Object.entries(_catTotals(tm))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([c, v]) => `  ${c}: ₹${Math.round(v)}`)
    .join("\n");

  const recent = txns
    .slice(0, 5)
    .map(
      (t) =>
        `  ${t.date} ${t.type} ${t.category} ${t.type === "income" ? "+" : "-"}₹${Math.round(Math.abs(t.amount))}`,
    )
    .join("\n");

  return `=== BlueLedger Financial Summary ===
${now.toLocaleDateString("en-IN")} | Day ${now.getDate()}/${dim} | ${dLeft} days left
Income ₹${Math.round(tmIn)} | Expense ₹${Math.round(tmEx)} | Net ₹${Math.round(tmIn - tmEx)}
Savings ${savRate}% | ₹${avgD}/day | Projected ₹${proj}
${lim > 0 ? `Budget ₹${lim} (${Math.round((tmEx / lim) * 100)}% used)` : "No budget set"} | MoM ${mom > 0 ? "+" : ""}${mom}%
Total txns: ${txns.length}
Top categories:
${cats || "  None"}
Highest spend day: ${topDow ? dowNames[topDow[0]] : "N/A"}
Recent 5:
${recent || "  None"}`;
}

/** 0–100 financial health score */
function computeHealthScore() {
  const txns = _getTxns();
  if (!txns.length)
    return { score: 0, grade: "N/A", color: "#64748b", factors: [] };

  const tm = _thisMonthTxns();
  const lm = _lastMonthTxns();
  const tmIn = _sum(tm, "income");
  const tmEx = _sum(tm, "expense");
  const lmEx = _sum(lm, "expense");
  const lim = (typeof userData !== "undefined" && userData?.spendingLimit) || 0;
  let score = 50;
  const factors = [];

  if (tmIn > 0) {
    const r = (tmIn - tmEx) / tmIn;
    if (r >= 0.3) {
      score += 20;
      factors.push({
        t: "pos",
        text: `Strong savings: ${Math.round(r * 100)}% of income`,
      });
    } else if (r >= 0.1) {
      score += 10;
      factors.push({
        t: "neu",
        text: `Moderate savings rate: ${Math.round(r * 100)}%`,
      });
    } else if (r < 0) {
      score -= 15;
      factors.push({ t: "neg", text: "Spending exceeds income this month" });
    } else {
      factors.push({
        t: "neu",
        text: `Low savings rate: ${Math.round(r * 100)}%`,
      });
    }
  }
  if (lmEx > 0 && tmEx > 0) {
    const tr = (tmEx - lmEx) / lmEx;
    if (tr < -0.1) {
      score += 15;
      factors.push({
        t: "pos",
        text: `Expenses down ${Math.round(-tr * 100)}% vs last month`,
      });
    } else if (tr > 0.25) {
      score -= 10;
      factors.push({
        t: "neg",
        text: `Expenses up ${Math.round(tr * 100)}% vs last month`,
      });
    }
  }
  if (lim > 0) {
    const u = tmEx / lim;
    if (u <= 0.8) {
      score += 10;
      factors.push({
        t: "pos",
        text: `Well within budget (${Math.round(u * 100)}% used)`,
      });
    } else if (u > 1) {
      score -= 15;
      factors.push({
        t: "neg",
        text: `Over budget — ${Math.round((u - 1) * 100)}% exceeded`,
      });
    } else {
      factors.push({
        t: "neu",
        text: `Approaching budget limit (${Math.round(u * 100)}%)`,
      });
    }
  }
  if (Object.keys(_catTotals(tm)).length >= 4) score += 5;
  if (txns.length >= 10) {
    score += 5;
    factors.push({ t: "pos", text: "Consistent financial tracking" });
  }
  if (txns.some((t) => t.category === "Investment" && t.type === "expense")) {
    score += 5;
    factors.push({ t: "pos", text: "Active investment activity" });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let grade = "Poor",
    color = "#ef4444";
  if (score >= 85) {
    grade = "Excellent";
    color = "#10b981";
  } else if (score >= 70) {
    grade = "Good";
    color = "#34d399";
  } else if (score >= 55) {
    grade = "Fair";
    color = "#fbbf24";
  } else if (score >= 40) {
    grade = "Needs Work";
    color = "#f97316";
  }

  return { score, grade, color, factors };
}

/** Dynamic local insights (instant, no API) */
function generateLocalInsights() {
  const txns = _getTxns();
  if (!txns.length)
    return [
      {
        icon: "💡",
        text: "Add your first transaction to unlock AI insights.",
        t: "info",
      },
    ];

  const now = new Date();
  const tm = _thisMonthTxns();
  const lm = _lastMonthTxns();
  const ins = [];
  const tmIn = _sum(tm, "income"),
    tmEx = _sum(tm, "expense");
  const lmEx = _sum(lm, "expense");
  const curC = _catTotals(tm);
  const avgD = _avgDailyExpense(tm);
  const proj = _projectedMonthlySpend(tm);
  const lim = (typeof userData !== "undefined" && userData?.spendingLimit) || 0;

  if (tmIn > 0) {
    const r = Math.round(((tmIn - tmEx) / tmIn) * 100);
    ins.push(
      tmEx > tmIn
        ? {
            icon: "⚠️",
            text: `Spending exceeds income by ₹${Math.round(tmEx - tmIn).toLocaleString("en-IN")} this month.`,
            t: "danger",
          }
        : {
            icon: "💰",
            text: `Saving ${r}% of income — ₹${Math.round(tmIn - tmEx).toLocaleString("en-IN")} this month.`,
            t: "positive",
          },
    );
  }
  if (lmEx > 0 && tmEx > 0) {
    const p = Math.round(((tmEx - lmEx) / lmEx) * 100);
    if (Math.abs(p) >= 5)
      ins.push({
        icon: p > 0 ? "📈" : "📉",
        text: `Spending ${p > 0 ? p + "% higher" : Math.abs(p) + "% lower"} than last month.`,
        t: p > 0 ? "warn" : "positive",
      });
  }
  const fg = _fastestGrowingCat();
  if (fg && fg.pct >= 15)
    ins.push({
      icon: "🔥",
      text: `${fg.category} spending grew ${fg.pct}% vs last month.`,
      t: "warn",
    });
  const top = Object.entries(curC).sort((a, b) => b[1] - a[1])[0];
  if (top)
    ins.push({
      icon: "🏆",
      text: `${top[0]} is top category at ₹${Math.round(top[1]).toLocaleString("en-IN")}.`,
      t: "info",
    });
  if (avgD > 0)
    ins.push({
      icon: "📅",
      text: `Average daily spend: ₹${Math.round(avgD).toLocaleString("en-IN")}.`,
      t: "info",
    });
  if (proj > 0) {
    if (lim > 0 && proj > lim)
      ins.push({
        icon: "🚨",
        text: `Projected to overspend by ₹${(proj - lim).toLocaleString("en-IN")} at this pace.`,
        t: "danger",
      });
    else
      ins.push({
        icon: "🔮",
        text: `Projected month-end spend: ₹${proj.toLocaleString("en-IN")}.`,
        t: "info",
      });
  }
  const dow = _dowTotals(tm);
  const topDow = Object.entries(dow).sort((a, b) => b[1] - a[1])[0];
  if (topDow && topDow[1] > 0)
    ins.push({
      icon: "📆",
      text: `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][topDow[0]]} is your highest spending day.`,
      t: "info",
    });

  return ins.slice(0, 7);
}

/** Budget recommendations (instant, no API) */
function generateBudgetRecs() {
  const tm = _thisMonthTxns();
  const curC = _catTotals(tm);
  const tmIn = _sum(tm, "income");
  const recs = [];

  const RATIOS = {
    Food: 0.2,
    Entertainment: 0.1,
    Shopping: 0.15,
    Transport: 0.1,
    Health: 0.1,
  };
  Object.entries(RATIOS).forEach(([cat, ratio]) => {
    if (curC[cat] && tmIn > 0) {
      const a = curC[cat] / tmIn;
      if (a > ratio * 1.3)
        recs.push({
          icon: "✂️",
          title: `Trim ${cat} by ${Math.round((a - ratio) * 100)}%`,
          body: `Spending ${Math.round(a * 100)}% of income on ${cat}. Target ~${Math.round(ratio * 100)}%. Saves ₹${Math.round((a - ratio) * tmIn).toLocaleString("en-IN")}/month.`,
        });
    }
  });
  const fg = _fastestGrowingCat();
  if (fg && fg.pct >= 20)
    recs.push({
      icon: "📉",
      title: `Watch ${fg.category} growth`,
      body: `${fg.category} up ${fg.pct}% this month — review recent transactions.`,
    });
  if (tmIn > 0) {
    const tmEx = _sum(tm, "expense");
    if ((tmIn - tmEx) / tmIn < 0.2)
      recs.push({
        icon: "🎯",
        title: "Boost savings to 20%",
        body: `Target ₹${Math.round(tmIn * 0.2).toLocaleString("en-IN")}/month by trimming discretionary spend.`,
      });
  }
  if (!recs.length)
    recs.push({
      icon: "🌟",
      title: "Great financial discipline!",
      body: "Spending patterns look healthy. Keep this balance.",
    });
  return recs.slice(0, 4);
}

/** Local deep analysis fallback (instant) */
function _buildLocalDeepResult() {
  const tm = _thisMonthTxns();
  const lm = _lastMonthTxns();
  const tmIn = _sum(tm, "income"),
    tmEx = _sum(tm, "expense");
  const lmEx = _sum(lm, "expense");
  const proj = _projectedMonthlySpend(tm);
  const avgD = Math.round(_avgDailyExpense(tm));
  const curC = _catTotals(tm);
  const mom = lmEx > 0 ? Math.round(((tmEx - lmEx) / lmEx) * 100) : 0;
  const savR = tmIn > 0 ? Math.round(((tmIn - tmEx) / tmIn) * 100) : 0;
  const lim = (typeof userData !== "undefined" && userData?.spendingLimit) || 0;
  const { score, grade } = computeHealthScore();
  const fg = _fastestGrowingCat();

  const headline =
    tmEx > tmIn
      ? "⚠️ Spending Exceeds Income — Action Needed"
      : mom > 20
        ? `📈 Expenses Up ${mom}% — Review Categories`
        : savR >= 20
          ? `✅ Healthy Finances — ${savR}% Savings Rate`
          : `📊 Financial Health: ${grade} (${score}/100)`;

  const assessment = [
    tmIn > 0
      ? `Income ₹${Math.round(tmIn).toLocaleString("en-IN")}, spent ₹${Math.round(tmEx).toLocaleString("en-IN")} — saving ${savR}%.`
      : `Spent ₹${Math.round(tmEx).toLocaleString("en-IN")} with no income recorded.`,
    mom !== 0
      ? `Expenses ${Math.abs(mom)}% ${mom > 0 ? "higher" : "lower"} than last month.`
      : "Spending steady vs last month.",
    `Projected month-end: ₹${proj.toLocaleString("en-IN")} at ₹${avgD}/day.`,
  ].join(" ");

  const topInsights = generateLocalInsights()
    .slice(0, 4)
    .map((i) => ({
      title: i.text.split(".")[0] + ".",
      body: i.text,
      severity: i.t === "danger" ? "high" : i.t === "warn" ? "medium" : "low",
    }));

  const predictions = [
    {
      label: "Month-end Spend",
      value: `₹${proj.toLocaleString("en-IN")}`,
      reasoning: `₹${avgD}/day × ${new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()} days`,
    },
  ];
  if (fg)
    predictions.push({
      label: `${fg.category} Trend`,
      value: `+${fg.pct}% growth`,
      reasoning: "Based on current month trajectory",
    });
  if (lim > 0) {
    const rem = lim - tmEx;
    const dLeft =
      new Date(
        new Date().getFullYear(),
        new Date().getMonth() + 1,
        0,
      ).getDate() - new Date().getDate();
    predictions.push({
      label: "Budget Remaining",
      value:
        rem > 0 ? `₹${Math.round(rem).toLocaleString("en-IN")}` : "Over budget",
      reasoning: `${dLeft} days remaining`,
    });
  }

  const actionPlan = generateBudgetRecs()
    .slice(0, 3)
    .map((r) => ({ step: r.title, impact: r.body }));
  if (!actionPlan.length)
    actionPlan.push({
      step: "Track consistently",
      impact: "Better data unlocks better insights over time.",
    });

  return {
    headline,
    overallAssessment: assessment,
    topInsights,
    predictions,
    actionPlan,
    _isLocal: true,
  };
}

/* ══════════════════════════════════════════════════════════════
   TIMEOUT WRAPPER
   ══════════════════════════════════════════════════════════════ */

function _withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

/* ══════════════════════════════════════════════════════════════
   PERSISTENT CHAT SESSIONS  (localStorage, separate from vault)
   ══════════════════════════════════════════════════════════════ */

function _loadSessions() {
  try {
    return JSON.parse(localStorage.getItem(BL_CHAT_STORE) || "[]");
  } catch {
    return [];
  }
}
function _saveSessions(arr) {
  try {
    localStorage.setItem(
      BL_CHAT_STORE,
      JSON.stringify(arr.slice(0, MAX_SESSIONS)),
    );
  } catch (e) {
    console.warn("BL AI save", e);
  }
}
function _loadPins() {
  try {
    return JSON.parse(localStorage.getItem(BL_PINS_STORE) || "[]");
  } catch {
    return [];
  }
}
function _savePins(arr) {
  try {
    localStorage.setItem(BL_PINS_STORE, JSON.stringify(arr.slice(0, 20)));
  } catch {}
}

function _newSession(title) {
  return {
    id: "bls_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    title: title || "Financial Analysis",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pinned: false,
    messages: [], // { role, content, html, ts }
  };
}

function _getSession(id) {
  return _loadSessions().find((s) => s.id === id) || null;
}

function _upsertSession(s) {
  s.updatedAt = new Date().toISOString();
  const arr = _loadSessions();
  const i = arr.findIndex((x) => x.id === s.id);
  if (i >= 0) arr[i] = s;
  else arr.unshift(s);
  _saveSessions(arr);
}

function _deleteSession(id) {
  _saveSessions(_loadSessions().filter((s) => s.id !== id));
}
function _renameSession(id, t) {
  const a = _loadSessions();
  const s = a.find((x) => x.id === id);
  if (s) {
    s.title = t;
    s.updatedAt = new Date().toISOString();
    _saveSessions(a);
  }
}
function _togglePin(id) {
  const a = _loadSessions();
  const s = a.find((x) => x.id === id);
  if (s) {
    s.pinned = !s.pinned;
    s.updatedAt = new Date().toISOString();
    _saveSessions(a);
  }
  return _getSession(id)?.pinned;
}

/** Auto-generate chat title from first message */
function _autoTitle(msg) {
  const m = msg.toLowerCase();
  if (/food|eat|lunch|dinner|restaurant|swiggy|zomato/.test(m))
    return "Food Spending Review";
  if (/transport|uber|ola|cab|petrol|fuel|metro/.test(m))
    return "Transport Analysis";
  if (/entertain|movie|netflix|spotify|subscription/.test(m))
    return "Entertainment Review";
  if (/invest|stock|mutual fund|sip/.test(m)) return "Investment Planning";
  if (/sav(e|ing|ings)/.test(m)) return "Savings Analysis";
  if (/budget|limit|overspend/.test(m)) return "Budget Strategy";
  if (/predict|forecast|project|next month/.test(m)) return "Spending Forecast";
  if (/health|score|overall/.test(m)) return "Financial Health Check";
  if (/biggest|most|highest|top/.test(m)) return "Top Spending Analysis";
  if (/week|daily/.test(m)) return "Daily Spending Review";
  if (/month/.test(m)) return "Monthly Analysis";
  if (/reduc|cut|decreas/.test(m)) return "Expense Optimization";
  return msg.length > 32 ? msg.slice(0, 30) + "…" : msg;
}

/* ══════════════════════════════════════════════════════════════
   UI STATE
   ══════════════════════════════════════════════════════════════ */

let _aiaOpen = false;
let _aiaMode = "analysis"; // "analysis" | "chat"
let _sSidebarCol = false; // sidebar collapsed
let _sCurrId = null; // active session id
let _sChatBusy = false;
let _sVoiceActive = false;
let _sRecognition = null;

/* ══════════════════════════════════════════════════════════════
   OPEN / CLOSE
   ══════════════════════════════════════════════════════════════ */

function openAIAssistant() {
  if (!document.getElementById("aiaPage")) _buildPage();
  _sSidebarCol = localStorage.getItem(BL_SIDEBAR_KEY) === "1";
  _applyCollapsed();
  document.getElementById("aiaPage").style.display = "flex";
  document.body.style.overflow = "hidden";
  _aiaOpen = true;
  aiaSetMode("analysis"); // always open to analysis
  _renderSidebar();
  _renderAnalysis();
}

function closeAIAssistant() {
  const p = document.getElementById("aiaPage");
  if (p) p.style.display = "none";
  document.body.style.overflow = "";
  _aiaOpen = false;
}

/* ══════════════════════════════════════════════════════════════
   PAGE BUILDER  (builds DOM once on first openAIAssistant call)
   ══════════════════════════════════════════════════════════════ */

function _buildPage() {
  const el = document.createElement("div");
  el.id = "aiaPage";
  el.className = "aia-page";
  el.style.display = "none";
  el.innerHTML = `
<div class="aia-shell" id="aiaShell">

  <!-- ════════════════════════════════════
       SIDEBAR
       ════════════════════════════════════ -->
  <aside class="aia-sidebar" id="aiaSidebar">

    <!-- Brand -->
    <div class="aia-sb-brand" id="aiaSbBrand">
      <div class="aia-sb-brand-icon"><i class="fas fa-brain"></i></div>
      <span class="aia-sb-text">BlueLedger AI</span>
      <button class="aia-sb-collapse-btn" onclick="aiaToggleSidebar()" title="Collapse">
        <i class="fas fa-chevron-left" id="aiaCollapseIcon"></i>
      </button>
    </div>

    <!-- New chat -->
    <button class="aia-sb-new" onclick="aiaNewSession()">
      <i class="fas fa-plus"></i>
      <span class="aia-sb-text">New Analysis</span>
    </button>

    <!-- Search -->
    <div class="aia-sb-search-wrap aia-sb-text" id="aiaSbSearchWrap">
      <i class="fas fa-magnifying-glass aia-sb-search-icon"></i>
      <input class="aia-sb-search" id="aiaSbSearch" placeholder="Search conversations…" oninput="aiaFilterSessions(this.value)" />
    </div>

    <!-- Pinned -->
    <div class="aia-sb-section-label aia-sb-text">📌 Pinned</div>
    <div class="aia-sb-list" id="aiaPinnedList"></div>

    <!-- Recent -->
    <div class="aia-sb-section-label aia-sb-text">🕓 Recent</div>
    <div class="aia-sb-list" id="aiaRecentList"></div>

    <!-- Bottom -->
    <div class="aia-sb-bottom">
      <button class="aia-sb-icon-btn aia-sb-close-btn" onclick="closeAIAssistant()" title="Close AI">
        <i class="fas fa-times"></i>
        <span class="aia-sb-text">Close</span>
      </button>
    </div>

  </aside>

  <!-- ════════════════════════════════════
       MAIN AREA
       ════════════════════════════════════ -->
  <main class="aia-main" id="aiaMain">

    <!-- Topbar -->
    <header class="aia-topbar">
      <div class="aia-topbar-l">
        <button class="aia-topbar-menu-btn" onclick="aiaToggleSidebar()" title="Toggle sidebar">
          <i class="fas fa-bars"></i>
        </button>
        <div class="aia-topbar-title" id="aiaTopTitle">
          <i class="fas fa-chart-line" style="color:#818cf8;margin-right:.4rem"></i>
          Financial Analysis
        </div>
      </div>
      <div class="aia-topbar-r">
        <button class="aia-tab-btn" id="aiaTabA" onclick="aiaSetMode('analysis')">
          <i class="fas fa-chart-pie"></i><span>Analysis</span>
        </button>
        <button class="aia-tab-btn" id="aiaTabC" onclick="aiaSetMode('chat')">
          <i class="fas fa-comment-dots"></i><span>Chat</span>
        </button>
        <button class="aia-topbar-close-btn" onclick="closeAIAssistant()" title="Close">
          <i class="fas fa-times"></i>
        </button>
      </div>
    </header>

    <!-- ── ANALYSIS VIEW ───────────────── -->
    <div class="aia-view" id="aiaViewA">

      <div class="aia-analysis-scroll">
        <div class="aia-analysis-grid">

          <!-- Row 1: Score + Prediction -->
          <div class="aia-acard aia-acard--score" id="acScore"></div>
          <div class="aia-acard aia-acard--pred"  id="acPred"></div>

          <!-- Row 2: Behaviour (full width) -->
          <div class="aia-acard aia-acard--wide" id="acBehav"></div>

          <!-- Row 3: Smart Insights (full width) -->
          <div class="aia-acard aia-acard--wide" id="acInsights"></div>

          <!-- Row 4: Recs + Deep Analysis -->
          <div class="aia-acard" id="acRecs"></div>
          <div class="aia-acard" id="acDeep">
            <div class="aia-acard-hdr">
              <span class="aia-acard-hdr-icon" style="background:rgba(163,92,244,0.15);color:#a78bfa"><i class="fas fa-wand-magic-sparkles"></i></span>
              <span class="aia-acard-hdr-title">AI Deep Analysis</span>
            </div>
            <p class="aia-acard-desc">Get a full AI-powered financial intelligence report with risk detection, predictions &amp; an action plan.</p>
            <button class="aia-deep-run-btn" id="aiaDeepBtn" onclick="aiaRunDeep()">
              <i class="fas fa-brain"></i> Run Deep Analysis
            </button>
            <div id="aiaDeepResult"></div>
          </div>

        </div>
      </div>

      <!-- CTA -->
      <div class="aia-analysis-cta">
        <button class="aia-cta-btn" onclick="aiaNewSession()">
          <i class="fas fa-comment-dots"></i> Continue with AI Assistant
        </button>
      </div>

    </div>

    <!-- ── CHAT VIEW ───────────────────── -->
    <div class="aia-view" id="aiaViewC" style="display:none">

      <!-- Session bar -->
      <div class="aia-session-bar" id="aiaSessionBar">
        <span class="aia-session-title" id="aiaSessionTitle">New Analysis</span>
        <div class="aia-session-actions">
          <button class="aia-session-btn" onclick="aiaRenameActive()" title="Rename"><i class="fas fa-pen"></i></button>
          <button class="aia-session-btn" id="aiaPinBtn" onclick="aiaPinActive()" title="Pin"><i class="fas fa-thumbtack"></i></button>
          <button class="aia-session-btn aia-session-btn--del" onclick="aiaDeleteActive()" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
      </div>

      <!-- Messages -->
      <div class="aia-chat-msgs" id="aiaChatMsgs">
        <div class="aia-chat-welcome" id="aiaChatWelcome">
          <div class="aia-welcome-icon"><i class="fas fa-robot"></i></div>
          <div class="aia-welcome-title">Your Financial Copilot</div>
          <div class="aia-welcome-sub">Ask me anything about your finances. I remember our conversations.</div>
          <div class="aia-qprompts">
            <button class="aia-qp" onclick="aiaAsk('Analyse this month\\'s spending')">Analyse this month</button>
            <button class="aia-qp" onclick="aiaAsk('How can I save more money?')">How can I save more?</button>
            <button class="aia-qp" onclick="aiaAsk('Predict next month\\'s expenses')">Predict next month</button>
            <button class="aia-qp" onclick="aiaAsk('What is my biggest spending mistake?')">Biggest mistake</button>
            <button class="aia-qp" onclick="aiaAsk('Build me a weekly budget plan')">Weekly budget</button>
            <button class="aia-qp" onclick="aiaAsk('How do I improve my savings rate?')">Improve savings rate</button>
            <button class="aia-qp" onclick="aiaAsk('Which spending categories should I cut?')">Where to cut?</button>
          </div>
        </div>
      </div>

      <!-- Input bar -->
      <div class="aia-input-bar">
        <button class="aia-voice-btn" id="aiaVoiceBtn" onclick="aiaToggleVoice()" title="Voice input">
          <i class="fas fa-microphone" id="aiaVoiceIcon"></i>
        </button>
        <div class="aia-textarea-wrap">
          <textarea
            class="aia-textarea"
            id="aiaInput"
            rows="1"
            placeholder="Ask about your finances…"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();aiaSend();}"
            oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"
          ></textarea>
        </div>
        <button class="aia-send-btn" id="aiaSendBtn" onclick="aiaSend()">
          <i class="fas fa-paper-plane"></i>
        </button>
      </div>

    </div>
  </main>

</div>`;
  document.body.appendChild(el);
  _applyCollapsed();
}

/* ══════════════════════════════════════════════════════════════
   SIDEBAR
   ══════════════════════════════════════════════════════════════ */

function aiaToggleSidebar() {
  _sSidebarCol = !_sSidebarCol;
  localStorage.setItem(BL_SIDEBAR_KEY, _sSidebarCol ? "1" : "0");
  _applyCollapsed();
}
window.aiaToggleSidebar = aiaToggleSidebar;

function _applyCollapsed() {
  const sb = document.getElementById("aiaSidebar");
  const sh = document.getElementById("aiaShell");
  const icon = document.getElementById("aiaCollapseIcon");
  if (!sb || !sh) return;
  if (_sSidebarCol) {
    sb.classList.add("aia-sidebar--col");
    sh.classList.add("aia-shell--col");
    if (icon) {
      icon.className = "fas fa-chevron-right";
    }
  } else {
    sb.classList.remove("aia-sidebar--col");
    sh.classList.remove("aia-shell--col");
    if (icon) {
      icon.className = "fas fa-chevron-left";
    }
  }
}

function _renderSidebar(filter) {
  const all = _loadSessions();
  const q = (filter || "").toLowerCase();
  const list = q ? all.filter((s) => s.title.toLowerCase().includes(q)) : all;
  const pinned = list.filter((s) => s.pinned);
  const recent = list.filter((s) => !s.pinned);
  const pel = document.getElementById("aiaPinnedList");
  const rel = document.getElementById("aiaRecentList");
  if (!pel || !rel) return;

  const item = (s) => `
    <div class="aia-sb-item ${s.id === _sCurrId ? "aia-sb-item--active" : ""}" id="sbitem-${s.id}" onclick="aiaLoadSession('${s.id}')">
      <i class="fas fa-${s.pinned ? "thumbtack" : "message"} aia-sb-item-icon"></i>
      <span class="aia-sb-item-title aia-sb-text">${safeText(s.title)}</span>
      <div class="aia-sb-item-menu">
        <button onclick="event.stopPropagation();aiaSbRename('${s.id}')" title="Rename"><i class="fas fa-pen"></i></button>
        <button onclick="event.stopPropagation();aiaSbPin('${s.id}')" title="${s.pinned ? "Unpin" : "Pin"}"><i class="fas fa-thumbtack"></i></button>
        <button onclick="event.stopPropagation();aiaSbDelete('${s.id}')" title="Delete" style="color:#ef4444"><i class="fas fa-trash"></i></button>
      </div>
    </div>`;

  pel.innerHTML = pinned.length
    ? pinned.map(item).join("")
    : `<div class="aia-sb-empty aia-sb-text">No pinned chats</div>`;
  rel.innerHTML = recent.length
    ? recent.map(item).join("")
    : `<div class="aia-sb-empty aia-sb-text">No recent chats</div>`;
}

function aiaFilterSessions(q) {
  _renderSidebar(q);
}
window.aiaFilterSessions = aiaFilterSessions;

/* ══════════════════════════════════════════════════════════════
   SESSION CRUD  (exposed to inline onclick)
   ══════════════════════════════════════════════════════════════ */

function aiaLoadSession(id) {
  const s = _getSession(id);
  if (!s) return;
  _sCurrId = id;
  aiaSetMode("chat");
  _clearChatUI();
  s.messages.forEach((m) =>
    _appendMsg(m.role, m.html || safeText(m.content), m.ts, false),
  );
  _updateSessionBar(s.title, s.pinned);
  _renderSidebar();
  const msgs = document.getElementById("aiaChatMsgs");
  if (msgs) setTimeout(() => (msgs.scrollTop = msgs.scrollHeight), 30);
}
window.aiaLoadSession = aiaLoadSession;

function aiaNewSession() {
  _sCurrId = null;
  aiaSetMode("chat");
  _clearChatUI();
  _updateSessionBar("New Analysis", false);
  _renderSidebar();
  document.getElementById("aiaInput")?.focus();
}
window.aiaNewSession = aiaNewSession;

function aiaRenameActive() {
  if (!_sCurrId) return;
  const s = _getSession(_sCurrId);
  const t = prompt("Rename:", s?.title || "");
  if (t?.trim()) {
    _renameSession(_sCurrId, t.trim());
    _updateSessionBar(t.trim(), s?.pinned);
    _renderSidebar();
  }
}
window.aiaRenameActive = aiaRenameActive;

function aiaPinActive() {
  if (!_sCurrId) return;
  const pinned = _togglePin(_sCurrId);
  const s = _getSession(_sCurrId);
  _updateSessionBar(s?.title || "", pinned);
  _renderSidebar();
}
window.aiaPinActive = aiaPinActive;

function aiaDeleteActive() {
  if (!_sCurrId) return;
  if (!confirm("Delete this conversation?")) return;
  _deleteSession(_sCurrId);
  _sCurrId = null;
  aiaNewSession();
}
window.aiaDeleteActive = aiaDeleteActive;

function aiaSbRename(id) {
  const s = _getSession(id);
  const t = prompt("Rename:", s?.title || "");
  if (t?.trim()) {
    _renameSession(id, t.trim());
    if (_sCurrId === id) _updateSessionBar(t.trim(), s?.pinned);
    _renderSidebar();
  }
}
window.aiaSbRename = aiaSbRename;

function aiaSbPin(id) {
  _togglePin(id);
  _renderSidebar();
}
window.aiaSbPin = aiaSbPin;

function aiaSbDelete(id) {
  if (!confirm("Delete this conversation?")) return;
  _deleteSession(id);
  if (_sCurrId === id) {
    _sCurrId = null;
    _clearChatUI();
    _updateSessionBar("New Analysis", false);
  }
  _renderSidebar();
}
window.aiaSbDelete = aiaSbDelete;

/* ══════════════════════════════════════════════════════════════
   MODE SWITCHING
   ══════════════════════════════════════════════════════════════ */

function aiaSetMode(mode) {
  _aiaMode = mode;
  const va = document.getElementById("aiaViewA");
  const vc = document.getElementById("aiaViewC");
  const tabA = document.getElementById("aiaTabA");
  const tabC = document.getElementById("aiaTabC");
  const ttl = document.getElementById("aiaTopTitle");
  if (!va || !vc) return;
  if (mode === "analysis") {
    va.style.display = "";
    vc.style.display = "none";
    tabA?.classList.add("active");
    tabC?.classList.remove("active");
    if (ttl)
      ttl.innerHTML = `<i class="fas fa-chart-line" style="color:#818cf8;margin-right:.4rem"></i>Financial Analysis`;
    _renderAnalysis();
  } else {
    va.style.display = "none";
    vc.style.display = "";
    tabA?.classList.remove("active");
    tabC?.classList.add("active");
    if (ttl)
      ttl.innerHTML = `<i class="fas fa-comment-dots" style="color:#818cf8;margin-right:.4rem"></i>AI Copilot`;
  }
}
window.aiaSetMode = aiaSetMode;

/* ══════════════════════════════════════════════════════════════
   ANALYSIS VIEW
   ══════════════════════════════════════════════════════════════ */

function _renderAnalysis() {
  _renderScore();
  _renderPred();
  _renderBehav();
  _renderInsights();
  _renderRecs();
}

/* Health Score */
function _renderScore() {
  const el = document.getElementById("acScore");
  if (!el) return;
  const txns = _getTxns();
  if (!txns.length) {
    el.innerHTML = `<div class="aia-acard-empty"><i class="fas fa-chart-pie"></i><span>Add transactions to see your score</span></div>`;
    return;
  }
  const { score, grade, color, factors } = computeHealthScore();
  const C = 2 * Math.PI * 42;
  const off = C - (score / 100) * C;
  const fHtml = factors
    .map(
      (f) => `
    <div class="aia-factor aia-factor--${f.t}">
      <i class="fas fa-${f.t === "pos" ? "check-circle" : f.t === "neg" ? "times-circle" : "minus-circle"}"></i>
      <span>${safeText(f.text)}</span>
    </div>`,
    )
    .join("");
  el.innerHTML = `
    <div class="aia-acard-hdr">
      <span class="aia-acard-hdr-icon" style="background:rgba(99,102,241,0.15);color:#818cf8"><i class="fas fa-heart-pulse"></i></span>
      <span class="aia-acard-hdr-title">Financial Health Score</span>
    </div>
    <div class="aia-score-body">
      <div class="aia-score-ring-wrap">
        <svg viewBox="0 0 100 100" width="120" height="120">
          <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
          <circle cx="50" cy="50" r="42" fill="none" stroke="${color}" stroke-width="8"
            stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}"
            transform="rotate(-90 50 50)" style="transition:stroke-dashoffset 1.2s ease"/>
        </svg>
        <div class="aia-score-center">
          <div class="aia-score-num" style="color:${color}">${score}</div>
          <div class="aia-score-den">/100</div>
        </div>
      </div>
      <div class="aia-score-info">
        <div class="aia-score-grade" style="color:${color}">${grade}</div>
        <div class="aia-score-sub">Financial Health</div>
        <div class="aia-factors">${fHtml}</div>
      </div>
    </div>`;
}

/* Prediction */
function _renderPred() {
  const el = document.getElementById("acPred");
  if (!el) return;
  const tm = _thisMonthTxns();
  if (!tm.length) {
    el.innerHTML = `<div class="aia-acard-empty"><i class="fas fa-crystal-ball"></i><span>No data this month</span></div>`;
    return;
  }
  const now = new Date();
  const proj = _projectedMonthlySpend(tm);
  const tmEx = _sum(tm, "expense");
  const avgD = Math.round(_avgDailyExpense(tm));
  const dLeft =
    new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() -
    now.getDate();
  const lim = (typeof userData !== "undefined" && userData?.spendingLimit) || 0;
  const over = lim > 0 && proj > lim;
  const col = over ? "#ef4444" : "#10b981";
  el.innerHTML = `
    <div class="aia-acard-hdr">
      <span class="aia-acard-hdr-icon" style="background:rgba(16,185,129,0.12);color:${col}"><i class="fas fa-chart-line"></i></span>
      <span class="aia-acard-hdr-title">Month-end Prediction</span>
    </div>
    <div class="aia-pred-amount" style="color:${col}">₹${proj.toLocaleString("en-IN")}</div>
    <div class="aia-pred-meta">
      <span><i class="fas fa-calendar-day"></i> ${dLeft}d left</span>
      <span><i class="fas fa-coins"></i> ₹${avgD}/day</span>
      <span><i class="fas fa-wallet"></i> ₹${Math.round(tmEx).toLocaleString("en-IN")} spent</span>
    </div>
    ${over ? `<div class="aia-pred-warn">⚠️ ₹${(proj - lim).toLocaleString("en-IN")} over ₹${lim.toLocaleString("en-IN")} budget</div>` : ""}`;
}

/* Spending Behaviour */
function _renderBehav() {
  const el = document.getElementById("acBehav");
  if (!el) return;
  const tm = _thisMonthTxns();
  const lm = _lastMonthTxns();
  const curC = _catTotals(tm);
  const dow = _dowTotals(tm);
  const dN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const topD = Object.entries(dow).sort((a, b) => b[1] - a[1]);
  const fg = _fastestGrowingCat();
  const topC = Object.entries(curC).sort((a, b) => b[1] - a[1])[0];
  const tmEx = _sum(tm, "expense"),
    lmEx = _sum(lm, "expense");

  const stats = [];
  if (topC)
    stats.push({
      icon: "🏆",
      lbl: "Top category",
      val: `${topC[0]}: ₹${Math.round(topC[1]).toLocaleString("en-IN")}`,
    });
  if (topD[0] && topD[0][1] > 0)
    stats.push({ icon: "📆", lbl: "Highest spend day", val: dN[topD[0][0]] });
  if (fg)
    stats.push({
      icon: "📈",
      lbl: "Fastest growing",
      val: `${fg.category} +${fg.pct}%`,
      warn: true,
    });
  if (lmEx > 0 && tmEx > 0) {
    const p = Math.round(((tmEx - lmEx) / lmEx) * 100);
    stats.push({
      icon: p > 0 ? "📈" : "📉",
      lbl: "vs last month",
      val: `${p > 0 ? "+" : ""}${p}%`,
      warn: p > 10,
    });
  }
  const maxDow = Math.max(...Object.values(dow), 1);
  const barHtml = [1, 2, 3, 4, 5, 6, 0]
    .map((d) => {
      const h = Math.max(4, Math.round((dow[d] / maxDow) * 44));
      const active = d === parseInt(topD[0]?.[0]);
      return `<div class="aia-dow-col">
      <div class="aia-dow-bar ${active ? "aia-dow-bar--top" : ""}" style="height:${h}px"></div>
      <div class="aia-dow-lbl">${dN[d]}</div>
    </div>`;
    })
    .join("");

  el.innerHTML = `
    <div class="aia-acard-hdr">
      <span class="aia-acard-hdr-icon" style="background:rgba(163,92,244,0.12);color:#a78bfa"><i class="fas fa-brain"></i></span>
      <span class="aia-acard-hdr-title">Spending Behaviour</span>
    </div>
    <div class="aia-behav-stats">
      ${stats
        .map(
          (s) => `
        <div class="aia-bstat ${s.warn ? "aia-bstat--warn" : ""}">
          <span class="aia-bstat-icon">${s.icon}</span>
          <div><div class="aia-bstat-val">${safeText(s.val)}</div><div class="aia-bstat-lbl">${safeText(s.lbl)}</div></div>
        </div>`,
        )
        .join("")}
    </div>
    <div class="aia-dow-chart">${barHtml}</div>`;
}

/* Smart Insights */
function _renderInsights() {
  const el = document.getElementById("acInsights");
  if (!el) return;
  const ins = generateLocalInsights();
  el.innerHTML = `
    <div class="aia-acard-hdr">
      <span class="aia-acard-hdr-icon" style="background:rgba(251,191,36,0.12);color:#fbbf24"><i class="fas fa-lightbulb"></i></span>
      <span class="aia-acard-hdr-title">Smart Insights</span>
      <button class="aia-pin-ins-btn" onclick="aiaPinInsights()" title="Pin insights"><i class="fas fa-thumbtack"></i></button>
    </div>
    <div class="aia-ins-list">
      ${ins
        .map(
          (i) => `
        <div class="aia-ins-row aia-ins-row--${i.t || "info"}">
          <span class="aia-ins-emoji">${i.icon}</span>
          <span>${safeText(i.text)}</span>
        </div>`,
        )
        .join("")}
    </div>`;
}

/* Budget Recommendations */
function _renderRecs() {
  const el = document.getElementById("acRecs");
  if (!el) return;
  const recs = generateBudgetRecs();
  el.innerHTML = `
    <div class="aia-acard-hdr">
      <span class="aia-acard-hdr-icon" style="background:rgba(52,211,153,0.12);color:#34d399"><i class="fas fa-piggy-bank"></i></span>
      <span class="aia-acard-hdr-title">Budget Recommendations</span>
    </div>
    <div class="aia-recs">
      ${recs
        .map(
          (r) => `
        <div class="aia-rec">
          <div class="aia-rec-icon">${r.icon}</div>
          <div><div class="aia-rec-title">${safeText(r.title)}</div><div class="aia-rec-body">${safeText(r.body)}</div></div>
        </div>`,
        )
        .join("")}
    </div>`;
}

/* Pin insights to sidebar */
function aiaPinInsights() {
  const ins = generateLocalInsights();
  const pins = _loadPins();
  pins.unshift({
    text: ins
      .slice(0, 3)
      .map((i) => i.text)
      .join(" | "),
    ts: new Date().toISOString(),
  });
  _savePins(pins);
  if (typeof toast === "function") toast("Insights pinned!", "success");
}
window.aiaPinInsights = aiaPinInsights;

/* ══════════════════════════════════════════════════════════════
   DEEP AI ANALYSIS
   ══════════════════════════════════════════════════════════════ */

async function aiaRunDeep() {
  const btn = document.getElementById("aiaDeepBtn");
  const res = document.getElementById("aiaDeepResult");
  if (!btn || !res) return;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analysing…';
  res.innerHTML = `<div class="aia-deep-loading"><i class="fas fa-brain"></i> Running financial analysis…</div>`;

  let parsed = null;
  try {
    const sys = `You are BlueLedger AI. Return ONLY valid JSON (no markdown):
{"headline":"string","overallAssessment":"string","topInsights":[{"title":"string","body":"string","severity":"low|medium|high"}],"predictions":[{"label":"string","value":"string","reasoning":"string"}],"actionPlan":[{"step":"string","impact":"string"}]}
Rules: topInsights=3, predictions=2, actionPlan=3. Use ₹. Indian finance context.`;
    const raw = await _withTimeout(
      _callAI([{ role: "user", content: _buildFinanceCtx() }], sys, 600),
      20000,
    );
    parsed = extractJsonFromText(raw);
  } catch (e) {
    console.info("BL AI: deep API unavailable", e.message);
  }
  if (!parsed?.headline) {
    parsed = _buildLocalDeepResult();
  }

  const insHtml = (parsed.topInsights || [])
    .map(
      (i) => `
    <div class="aia-di aia-di--${i.severity || "low"}">
      <div class="aia-di-title">${safeText(i.title)}</div>
      <div class="aia-di-body">${safeText(i.body)}</div>
    </div>`,
    )
    .join("");
  const pHtml = (parsed.predictions || [])
    .map(
      (p) => `
    <div class="aia-dp">
      <div class="aia-dp-lbl">${safeText(p.label)}</div>
      <div class="aia-dp-val">${safeText(p.value)}</div>
      <div class="aia-dp-rsn">${safeText(p.reasoning)}</div>
    </div>`,
    )
    .join("");
  const aHtml = (parsed.actionPlan || [])
    .map(
      (s, i) => `
    <div class="aia-da">
      <div class="aia-da-num">${i + 1}</div>
      <div><div class="aia-da-title">${safeText(s.step)}</div><div class="aia-da-impact">${safeText(s.impact)}</div></div>
    </div>`,
    )
    .join("");

  res.innerHTML = `
    <div class="aia-deep-card">
      <div class="aia-deep-src ${parsed._isLocal ? "aia-deep-src--local" : ""}">
        <i class="fas fa-${parsed._isLocal ? "bolt" : "robot"}"></i>
        ${parsed._isLocal ? "Instant local analysis" : "AI-powered analysis"}
      </div>
      <div class="aia-deep-headline">${safeText(parsed.headline || "")}</div>
      <div class="aia-deep-assess">${safeText(parsed.overallAssessment || "")}</div>
      <div class="aia-deep-sec"><i class="fas fa-lightbulb" style="color:#fbbf24"></i> Key Insights</div>
      <div class="aia-di-list">${insHtml}</div>
      <div class="aia-deep-sec"><i class="fas fa-chart-line" style="color:#818cf8"></i> Predictions</div>
      <div class="aia-dp-grid">${pHtml}</div>
      <div class="aia-deep-sec"><i class="fas fa-list-check" style="color:#34d399"></i> Action Plan</div>
      <div class="aia-da-list">${aHtml}</div>
      <button class="aia-deep-dismiss" onclick="document.getElementById('aiaDeepResult').innerHTML='';document.getElementById('aiaDeepBtn').disabled=false;document.getElementById('aiaDeepBtn').innerHTML='<i class=\\'fas fa-brain\\'></i> Run Deep Analysis'">
        <i class="fas fa-times"></i> Dismiss
      </button>
    </div>`;
  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-brain"></i> Re-run Analysis';
}
window.aiaRunDeep = aiaRunDeep;

/* ══════════════════════════════════════════════════════════════
   CHAT ENGINE
   ══════════════════════════════════════════════════════════════ */

function _clearChatUI() {
  const c = document.getElementById("aiaChatMsgs");
  if (!c) return;
  c.innerHTML = `
    <div class="aia-chat-welcome" id="aiaChatWelcome">
      <div class="aia-welcome-icon"><i class="fas fa-robot"></i></div>
      <div class="aia-welcome-title">Your Financial Copilot</div>
      <div class="aia-welcome-sub">Ask me anything about your finances. I remember our conversations.</div>
      <div class="aia-qprompts">
        <button class="aia-qp" onclick="aiaAsk('Analyse this month\\'s spending')">Analyse this month</button>
        <button class="aia-qp" onclick="aiaAsk('How can I save more money?')">How can I save more?</button>
        <button class="aia-qp" onclick="aiaAsk('Predict next month\\'s expenses')">Predict next month</button>
        <button class="aia-qp" onclick="aiaAsk('What is my biggest spending mistake?')">Biggest mistake</button>
        <button class="aia-qp" onclick="aiaAsk('Build me a weekly budget plan')">Weekly budget</button>
        <button class="aia-qp" onclick="aiaAsk('How do I improve my savings rate?')">Improve savings rate</button>
        <button class="aia-qp" onclick="aiaAsk('Which spending categories should I cut?')">Where to cut?</button>
      </div>
    </div>`;
}

function _updateSessionBar(title, pinned) {
  const te = document.getElementById("aiaSessionTitle");
  const pb = document.getElementById("aiaPinBtn");
  if (te) te.textContent = title;
  if (pb) pb.style.color = pinned ? "#818cf8" : "";
}

function aiaAsk(q) {
  const inp = document.getElementById("aiaInput");
  if (inp) inp.value = q;
  aiaSend();
}
window.aiaAsk = aiaAsk;

async function aiaSend() {
  if (_sChatBusy) return;
  const inp = document.getElementById("aiaInput");
  const q = (inp?.value || "").trim();
  if (!q) return;
  if (inp) {
    inp.value = "";
    inp.style.height = "auto";
  }

  // Hide welcome
  const w = document.getElementById("aiaChatWelcome");
  if (w) w.style.display = "none";

  const ts = new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  _appendMsg("user", safeText(q), ts, true);

  // Create or update session
  if (!_sCurrId) {
    const title = _autoTitle(q);
    const s = _newSession(title);
    _sCurrId = s.id;
    s.messages.push({ role: "user", content: q, html: safeText(q), ts });
    _upsertSession(s);
    _updateSessionBar(title, false);
  } else {
    const s = _getSession(_sCurrId) || _newSession("Chat");
    if (s.id !== _sCurrId) s.id = _sCurrId;
    s.messages.push({ role: "user", content: q, html: safeText(q), ts });
    _upsertSession(s);
  }
  _renderSidebar();

  // Typing indicator
  const tid = "t_" + Date.now();
  _appendTyping(tid);
  _sChatBusy = true;
  const sb = document.getElementById("aiaSendBtn");
  if (sb) sb.disabled = true;

  try {
    const session = _getSession(_sCurrId);
    const hist = (session?.messages || [])
      .slice(-MAX_MSG_CTX)
      .map((m) => ({ role: m.role, content: m.content }));
    const sys = `You are BlueLedger AI, an intelligent personal finance copilot for an Indian user.
Answer ONLY from the financial data below. Be specific with ₹ amounts. Max 150 words.
Use markdown (bold, bullets). Sound analytical. Never invent data.

${_buildFinanceCtx()}`;
    const reply = await _withTimeout(_callAI(hist, sys, 500), 20000);
    document.getElementById(tid)?.closest(".aia-msg-ai")?.remove();

    const rHtml = markdownToHtml(reply);
    const rTs = new Date().toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    _appendMsg("assistant", rHtml, rTs, true);

    const s2 = _getSession(_sCurrId);
    if (s2) {
      s2.messages.push({
        role: "assistant",
        content: reply,
        html: rHtml,
        ts: rTs,
      });
      if (s2.messages.length > MAX_MSG_CTX)
        s2.messages = s2.messages.slice(-MAX_MSG_CTX);
      _upsertSession(s2);
    }
    _renderSidebar();
  } catch (e) {
    document.getElementById(tid)?.closest(".aia-msg-ai")?.remove();
    _appendMsg(
      "assistant",
      "Sorry, I couldn't connect right now. Please check your connection.",
      new Date().toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      true,
    );
    console.warn("BL AI chat:", e);
  } finally {
    _sChatBusy = false;
    if (sb) sb.disabled = false;
    document.getElementById("aiaInput")?.focus();
  }
}
window.aiaSend = aiaSend;

function _appendMsg(role, html, ts, scroll) {
  const c = document.getElementById("aiaChatMsgs");
  if (!c) return;
  const d = document.createElement("div");
  if (role === "assistant") {
    d.className = "aia-msg-ai";
    d.innerHTML = `
      <div class="aia-msg-avatar"><i class="fas fa-robot"></i></div>
      <div class="aia-msg-ai-body">
        <div class="aia-bubble-ai">${html}</div>
        <div class="aia-msg-meta">
          <span>${ts || ""}</span>
          <button class="aia-copy-btn" onclick="aiaCopyMsg(this)" title="Copy"><i class="fas fa-copy"></i></button>
        </div>
      </div>`;
  } else {
    d.className = "aia-msg-user";
    d.innerHTML = `
      <div class="aia-msg-user-body">
        <div class="aia-bubble-user">${html}</div>
        <div class="aia-msg-meta aia-msg-meta--r"><span>${ts || ""}</span></div>
      </div>`;
  }
  c.appendChild(d);
  if (scroll) c.scrollTop = c.scrollHeight;
}

function _appendTyping(id) {
  const c = document.getElementById("aiaChatMsgs");
  if (!c) return;
  const d = document.createElement("div");
  d.className = "aia-msg-ai";
  d.innerHTML = `
    <div class="aia-msg-avatar"><i class="fas fa-robot"></i></div>
    <div class="aia-msg-ai-body">
      <div class="aia-bubble-ai">
        <span id="${id}" class="aia-typing"><span></span><span></span><span></span></span>
      </div>
    </div>`;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
}

function aiaCopyMsg(btn) {
  const bubble = btn
    .closest(".aia-msg-ai-body")
    ?.querySelector(".aia-bubble-ai");
  if (!bubble) return;
  navigator.clipboard?.writeText(bubble.innerText || bubble.textContent || "");
  btn.innerHTML = '<i class="fas fa-check"></i>';
  setTimeout(() => (btn.innerHTML = '<i class="fas fa-copy"></i>'), 1500);
}
window.aiaCopyMsg = aiaCopyMsg;

/* ══════════════════════════════════════════════════════════════
   VOICE INPUT
   ══════════════════════════════════════════════════════════════ */

function aiaToggleVoice() {
  const btn = document.getElementById("aiaVoiceBtn");
  const icon = document.getElementById("aiaVoiceIcon");
  const inp = document.getElementById("aiaInput");
  if (_sVoiceActive) {
    _sRecognition?.stop();
    _sVoiceActive = false;
    btn?.classList.remove("aia-voice--active");
    if (icon) icon.className = "fas fa-microphone";
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    if (typeof toast === "function")
      toast("Voice not supported in this browser", "warn");
    return;
  }
  _sRecognition = new SR();
  _sRecognition.lang = "en-IN";
  _sRecognition.interimResults = false;
  _sRecognition.onstart = () => {
    _sVoiceActive = true;
    btn?.classList.add("aia-voice--active");
    if (icon) icon.className = "fas fa-circle-dot";
  };
  _sRecognition.onresult = (e) => {
    if (inp) inp.value = e.results[0][0].transcript;
    _sVoiceActive = false;
    btn?.classList.remove("aia-voice--active");
    if (icon) icon.className = "fas fa-microphone";
    setTimeout(() => aiaSend(), 200);
  };
  _sRecognition.onerror = () => {
    _sVoiceActive = false;
    btn?.classList.remove("aia-voice--active");
    if (icon) icon.className = "fas fa-microphone";
  };
  _sRecognition.onend = () => {
    _sVoiceActive = false;
    btn?.classList.remove("aia-voice--active");
    if (icon) icon.className = "fas fa-microphone";
  };
  _sRecognition.start();
}
window.aiaToggleVoice = aiaToggleVoice;

/* ══════════════════════════════════════════════════════════════
   REFRESH HOOK  (called by refreshAll in script.js)
   ══════════════════════════════════════════════════════════════ */

function aiaRefresh() {
  if (!_aiaOpen) return;
  if (_aiaMode === "analysis") _renderAnalysis();
}
window.aiaRefresh = aiaRefresh;

/* ══════════════════════════════════════════════════════════════
   GLOBAL EXPORTS
   ══════════════════════════════════════════════════════════════ */

window.openAIAssistant = openAIAssistant;
window.closeAIAssistant = closeAIAssistant;
window.computeHealthScore = computeHealthScore;
window.generateLocalInsights = generateLocalInsights;
window.generateBudgetRecs = generateBudgetRecs;
