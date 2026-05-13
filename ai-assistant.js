/* ═══════════════════════════════════════════════════════════════
   ai-assistant.js  —  BlueLedger AI Financial Workspace
   v4 — Financial workspace sidebar (reports + pins, no chat history)
        Single-column analysis layout · Duplicate text bug fixed
        Deep analysis fills full width · Local-first, 504-safe

   Depends on: utils.js, ai.js  (must load before this file)
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ─── Storage keys ──────────────────────────────────────────── */
const BL_REPORTS_KEY = "bl_ai_reports_v4"; // saved financial reports
const BL_PINS_KEY = "bl_ai_pins_v4"; // pinned insights
const BL_SIDEBAR_KEY = "bl_ai_sidebar_v4"; // collapsed state
const MAX_REPORTS = 10;

/* ══════════════════════════════════════════════════════════════
   FINANCIAL ANALYSIS ENGINE  (pure, no DOM side-effects)
   ══════════════════════════════════════════════════════════════ */

function _getTxns() {
  return typeof transactions !== "undefined" && Array.isArray(transactions)
    ? transactions
    : [];
}
function _thisMonthTxns() {
  const n = new Date();
  return _getTxns().filter((t) => {
    const d = new Date(t.date + "T00:00:00");
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
  });
}
function _lastMonthTxns() {
  const n = new Date();
  const lm = new Date(n.getFullYear(), n.getMonth() - 1, 1);
  return _getTxns().filter((t) => {
    const d = new Date(t.date + "T00:00:00");
    return (
      d.getFullYear() === lm.getFullYear() && d.getMonth() === lm.getMonth()
    );
  });
}
function _sumType(txns, type) {
  return txns
    .filter((t) => t.type === type)
    .reduce((s, t) => s + Math.abs(t.amount), 0);
}
function _catTotals(txns) {
  const m = {};
  txns
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      m[t.category] = (m[t.category] || 0) + Math.abs(t.amount);
    });
  return m;
}
function _dowTotals(txns) {
  const m = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  txns
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      m[new Date(t.date + "T00:00:00").getDay()] += Math.abs(t.amount);
    });
  return m;
}
function _avgDaily(txns) {
  return (
    _sumType(
      txns.filter((t) => t.type === "expense"),
      "expense",
    ) / Math.max(new Date().getDate(), 1)
  );
}
function _projected(txns) {
  const n = new Date();
  return Math.round(
    _avgDaily(txns) * new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate(),
  );
}
function _fastestCat() {
  const c = _catTotals(_thisMonthTxns()),
    p = _catTotals(_lastMonthTxns());
  let best = null,
    bPct = 0;
  Object.keys(c).forEach((k) => {
    if (p[k] > 0) {
      const pct = ((c[k] - p[k]) / p[k]) * 100;
      if (pct > bPct) {
        bPct = pct;
        best = { category: k, pct: Math.round(pct) };
      }
    }
  });
  return best;
}
function _getLimit() {
  return (typeof userData !== "undefined" && userData?.spendingLimit) || 0;
}

/** Slim AI prompt context (~200 tokens) */
function _buildCtx() {
  const txns = _getTxns(),
    n = new Date(),
    tm = _thisMonthTxns(),
    lm = _lastMonthTxns();
  const tmIn = _sumType(tm, "income"),
    tmEx = _sumType(tm, "expense"),
    lmEx = _sumType(lm, "expense");
  const dim = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
  const avgD = Math.round(_avgDaily(tm)),
    proj = _projected(tm),
    lim = _getLimit();
  const savR = tmIn > 0 ? Math.round(((tmIn - tmEx) / tmIn) * 100) : 0;
  const mom = lmEx > 0 ? Math.round(((tmEx - lmEx) / lmEx) * 100) : 0;
  const dN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const topDow = Object.entries(_dowTotals(tm)).sort((a, b) => b[1] - a[1])[0];
  const cats = Object.entries(_catTotals(tm))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([c, v]) => `  ${c}: ₹${Math.round(v)}`)
    .join("\n");
  const rec = txns
    .slice(0, 5)
    .map(
      (t) =>
        `  ${t.date} ${t.type} ${t.category} ${t.type === "income" ? "+" : "-"}₹${Math.round(Math.abs(t.amount))}`,
    )
    .join("\n");
  return `=== BlueLedger Summary ===
${n.toLocaleDateString("en-IN")} | Day ${n.getDate()}/${dim} | ${dim - n.getDate()} days left
Income ₹${Math.round(tmIn)} | Expense ₹${Math.round(tmEx)} | Net ₹${Math.round(tmIn - tmEx)}
Savings ${savR}% | ₹${avgD}/day | Projected ₹${proj}
${lim > 0 ? `Budget ₹${lim} (${Math.round((tmEx / lim) * 100)}% used)` : "No budget"} | MoM ${mom > 0 ? "+" : ""}${mom}%
Txns: ${txns.length}
Top cats:\n${cats || "  None"}
Top spend day: ${topDow ? dN[topDow[0]] : "N/A"}
Recent 5:\n${rec || "  None"}`;
}

/* ── Health Score ────────────────────────────────────────────── */
function computeHealthScore() {
  const txns = _getTxns();
  if (!txns.length)
    return { score: 0, grade: "N/A", color: "#64748b", factors: [] };
  const tm = _thisMonthTxns(),
    lm = _lastMonthTxns();
  const tmIn = _sumType(tm, "income"),
    tmEx = _sumType(tm, "expense"),
    lmEx = _sumType(lm, "expense"),
    lim = _getLimit();
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
        text: `Moderate savings: ${Math.round(r * 100)}%`,
      });
    } else if (r < 0) {
      score -= 15;
      factors.push({ t: "neg", text: "Spending exceeds income" });
    } else {
      factors.push({ t: "neu", text: `Low savings: ${Math.round(r * 100)}%` });
    }
  }
  if (lmEx > 0 && tmEx > 0) {
    const tr = (tmEx - lmEx) / lmEx;
    if (tr < -0.1) {
      score += 15;
      factors.push({
        t: "pos",
        text: `Expenses down ${Math.round(-tr * 100)}% MoM`,
      });
    } else if (tr > 0.25) {
      score -= 10;
      factors.push({
        t: "neg",
        text: `Expenses up ${Math.round(tr * 100)}% MoM`,
      });
    }
  }
  if (lim > 0) {
    const u = tmEx / lim;
    if (u <= 0.8) {
      score += 10;
      factors.push({
        t: "pos",
        text: `Within budget (${Math.round(u * 100)}% used)`,
      });
    } else if (u > 1) {
      score -= 15;
      factors.push({
        t: "neg",
        text: `Over budget by ${Math.round((u - 1) * 100)}%`,
      });
    } else {
      factors.push({
        t: "neu",
        text: `Approaching limit (${Math.round(u * 100)}%)`,
      });
    }
  }
  if (Object.keys(_catTotals(tm)).length >= 4) score += 5;
  if (txns.length >= 10) {
    score += 5;
    factors.push({ t: "pos", text: "Consistent tracking" });
  }
  if (txns.some((t) => t.category === "Investment" && t.type === "expense")) {
    score += 5;
    factors.push({ t: "pos", text: "Active investments" });
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

/* ── Smart Insights (distinct title + body, no duplication) ──── */
function generateLocalInsights() {
  const txns = _getTxns();
  if (!txns.length)
    return [
      {
        icon: "💡",
        title: "No data yet",
        body: "Add your first transaction to unlock AI insights.",
        t: "info",
      },
    ];
  const tm = _thisMonthTxns(),
    lm = _lastMonthTxns(),
    ins = [];
  const tmIn = _sumType(tm, "income"),
    tmEx = _sumType(tm, "expense"),
    lmEx = _sumType(lm, "expense");
  const curC = _catTotals(tm),
    avgD = _avgDaily(tm),
    proj = _projected(tm),
    lim = _getLimit();

  // Savings
  if (tmIn > 0) {
    const r = Math.round(((tmIn - tmEx) / tmIn) * 100);
    ins.push(
      tmEx > tmIn
        ? {
            icon: "⚠️",
            title: "Spending exceeds income",
            body: `You are ₹${Math.round(tmEx - tmIn).toLocaleString("en-IN")} over your income this month.`,
            t: "danger",
          }
        : {
            icon: "💰",
            title: `Saving ${r}% of income`,
            body: `You have set aside ₹${Math.round(tmIn - tmEx).toLocaleString("en-IN")} in net savings this month.`,
            t: "positive",
          },
    );
  }
  // MoM
  if (lmEx > 0 && tmEx > 0) {
    const p = Math.round(((tmEx - lmEx) / lmEx) * 100);
    if (Math.abs(p) >= 5)
      ins.push({
        icon: p > 0 ? "📈" : "📉",
        title: `Spending ${p > 0 ? "up" : "down"} ${Math.abs(p)}% vs last month`,
        body: `This month: ₹${Math.round(tmEx).toLocaleString("en-IN")} vs ₹${Math.round(lmEx).toLocaleString("en-IN")} last month.`,
        t: p > 0 ? "warn" : "positive",
      });
  }
  // Fastest growing cat
  const fg = _fastestCat();
  if (fg && fg.pct >= 15)
    ins.push({
      icon: "🔥",
      title: `${fg.category} up ${fg.pct}%`,
      body: `${fg.category} spending grew ${fg.pct}% compared to last month.`,
      t: "warn",
    });
  // Top category
  const top = Object.entries(curC).sort((a, b) => b[1] - a[1])[0];
  if (top)
    ins.push({
      icon: "🏆",
      title: `${top[0]} is top category`,
      body: `₹${Math.round(top[1]).toLocaleString("en-IN")} spent on ${top[0]} this month.`,
      t: "info",
    });
  // Daily avg
  if (avgD > 0)
    ins.push({
      icon: "📅",
      title: `₹${Math.round(avgD).toLocaleString("en-IN")} average daily spend`,
      body: `Based on ${new Date().getDate()} days of transactions so far this month.`,
      t: "info",
    });
  // Projection
  if (proj > 0) {
    if (lim > 0 && proj > lim)
      ins.push({
        icon: "🚨",
        title: `Budget overrun predicted`,
        body: `Projected ₹${proj.toLocaleString("en-IN")} vs ₹${lim.toLocaleString("en-IN")} budget — ₹${(proj - lim).toLocaleString("en-IN")} over.`,
        t: "danger",
      });
    else
      ins.push({
        icon: "🔮",
        title: `Projected month-end: ₹${proj.toLocaleString("en-IN")}`,
        body: `At ₹${Math.round(avgD).toLocaleString("en-IN")}/day for ${new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()} days.`,
        t: "info",
      });
  }
  // Top spend day
  const dow = _dowTotals(tm),
    topDow = Object.entries(dow).sort((a, b) => b[1] - a[1])[0];
  if (topDow && topDow[1] > 0)
    ins.push({
      icon: "📆",
      title: `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][topDow[0]]} is highest spend day`,
      body: `₹${Math.round(topDow[1]).toLocaleString("en-IN")} spent on ${["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][topDow[0]]} this month.`,
      t: "info",
    });
  return ins.slice(0, 7);
}

/* ── Budget Recommendations ──────────────────────────────────── */
function generateBudgetRecs() {
  const tm = _thisMonthTxns(),
    curC = _catTotals(tm),
    tmIn = _sumType(tm, "income"),
    recs = [];
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
          title: `Trim ${cat} spending`,
          body: `At ${Math.round(a * 100)}% of income (target ~${Math.round(ratio * 100)}%). Cutting to target saves ₹${Math.round((a - ratio) * tmIn).toLocaleString("en-IN")}/month.`,
        });
    }
  });
  const fg = _fastestCat();
  if (fg && fg.pct >= 20)
    recs.push({
      icon: "📉",
      title: `Monitor ${fg.category}`,
      body: `Up ${fg.pct}% this month. Review recent ${fg.category} transactions to find savings.`,
    });
  if (tmIn > 0) {
    const tmEx = _sumType(tm, "expense");
    if ((tmIn - tmEx) / tmIn < 0.2)
      recs.push({
        icon: "🎯",
        title: "Aim for 20% savings rate",
        body: `Target ₹${Math.round(tmIn * 0.2).toLocaleString("en-IN")}/month. Trim discretionary categories to close the gap.`,
      });
  }
  if (!recs.length)
    recs.push({
      icon: "🌟",
      title: "Great financial discipline",
      body: "Your spending patterns look healthy. Maintain this balance.",
    });
  return recs.slice(0, 4);
}

/* ── Local deep analysis fallback (instant, no API) ─────────── */
function _buildLocalDeep() {
  const tm = _thisMonthTxns(),
    lm = _lastMonthTxns();
  const tmIn = _sumType(tm, "income"),
    tmEx = _sumType(tm, "expense"),
    lmEx = _sumType(lm, "expense");
  const proj = _projected(tm),
    avgD = Math.round(_avgDaily(tm)),
    lim = _getLimit();
  const mom = lmEx > 0 ? Math.round(((tmEx - lmEx) / lmEx) * 100) : 0;
  const savR = tmIn > 0 ? Math.round(((tmIn - tmEx) / tmIn) * 100) : 0;
  const { score, grade } = computeHealthScore(),
    fg = _fastestCat();

  const headline =
    tmEx > tmIn
      ? "⚠️ Spending Exceeds Income"
      : mom > 20
        ? `📈 Expenses Up ${mom}% This Month`
        : savR >= 20
          ? `✅ Healthy Finances — ${savR}% Savings Rate`
          : `📊 Financial Health: ${grade} (${score}/100)`;

  const assessment = [
    tmIn > 0
      ? `You earned ₹${Math.round(tmIn).toLocaleString("en-IN")} and spent ₹${Math.round(tmEx).toLocaleString("en-IN")} — saving ${savR}% this month.`
      : `Spent ₹${Math.round(tmEx).toLocaleString("en-IN")} with no income recorded.`,
    mom !== 0
      ? `Expenses ${Math.abs(mom)}% ${mom > 0 ? "higher" : "lower"} than last month.`
      : "Spending steady versus last month.",
    `At ₹${avgD}/day, month-end projected at ₹${proj.toLocaleString("en-IN")}.`,
  ].join(" ");

  // Use distinct title + body (not the same text twice)
  const topInsights = generateLocalInsights()
    .slice(0, 4)
    .map((i) => ({
      title: i.title, // short label
      body: i.body, // full detail sentence
      severity: i.t === "danger" ? "high" : i.t === "warn" ? "medium" : "low",
    }));

  const n = new Date(),
    dLeft =
      new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate() - n.getDate();
  const predictions = [
    {
      label: "Month-end Spend",
      value: `₹${proj.toLocaleString("en-IN")}`,
      reasoning: `₹${avgD}/day × ${new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate()} days`,
    },
  ];
  if (fg)
    predictions.push({
      label: `${fg.category} Trend`,
      value: `+${fg.pct}% growth`,
      reasoning: "Trajectory based on current month vs last month",
    });
  if (lim > 0) {
    const rem = lim - tmEx;
    predictions.push({
      label: "Budget Remaining",
      value:
        rem > 0 ? `₹${Math.round(rem).toLocaleString("en-IN")}` : "Over budget",
      reasoning: `${dLeft} days left in month`,
    });
  }

  const actionPlan = generateBudgetRecs()
    .slice(0, 3)
    .map((r) => ({ step: r.title, impact: r.body }));
  if (!actionPlan.length)
    actionPlan.push({
      step: "Maintain current discipline",
      impact: "Your patterns look healthy. Continue tracking consistently.",
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

/* ═══════════════════════════════════════════════════════════════
   REPORT PERSISTENCE  (saved financial reports, not chat history)
   ═══════════════════════════════════════════════════════════════ */

function _loadReports() {
  try {
    return JSON.parse(localStorage.getItem(BL_REPORTS_KEY) || "[]");
  } catch {
    return [];
  }
}
function _saveReports(r) {
  try {
    localStorage.setItem(
      BL_REPORTS_KEY,
      JSON.stringify(r.slice(0, MAX_REPORTS)),
    );
  } catch (e) {
    console.warn(e);
  }
}
function _loadPins() {
  try {
    return JSON.parse(localStorage.getItem(BL_PINS_KEY) || "[]");
  } catch {
    return [];
  }
}
function _savePins(p) {
  try {
    localStorage.setItem(BL_PINS_KEY, JSON.stringify(p.slice(0, 12)));
  } catch {}
}

function _saveReport(headline, score, grade, color) {
  const reports = _loadReports();
  const now = new Date();
  const month = now.toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });
  reports.unshift({
    id: "rpt_" + Date.now(),
    title: headline.replace(/[⚠️✅📊📈]/g, "").trim() || `${month} Analysis`,
    month,
    score,
    grade,
    color,
    ts: now.toISOString(),
    tsDisplay: now.toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }),
  });
  _saveReports(reports);
}

function _deleteReport(id) {
  _saveReports(_loadReports().filter((r) => r.id !== id));
  _renderSidebar();
}
window._deleteReport = _deleteReport;

function _addPin(text) {
  const pins = _loadPins();
  pins.unshift({ id: "pin_" + Date.now(), text, ts: new Date().toISOString() });
  _savePins(pins);
}

function _deletePin(id) {
  _savePins(_loadPins().filter((p) => p.id !== id));
  _renderSidebar();
}
window._deletePin = _deletePin;

/* ═══════════════════════════════════════════════════════════════
   UI STATE
   ═══════════════════════════════════════════════════════════════ */

let _aiaOpen = false;
let _aiaMode = "analysis";
let _sbCollapsed = false;
let _chatHistory = []; // in-memory only, intentionally not persisted
let _chatBusy = false;
let _voiceActive = false;
let _recognition = null;

/* ═══════════════════════════════════════════════════════════════
   OPEN / CLOSE
   ═══════════════════════════════════════════════════════════════ */

function openAIAssistant() {
  if (!document.getElementById("aiaPage")) _buildPage();
  _sbCollapsed = localStorage.getItem(BL_SIDEBAR_KEY) === "1";
  _applyCollapsed();
  document.getElementById("aiaPage").style.display = "flex";
  document.body.style.overflow = "hidden";
  _aiaOpen = true;
  aiaSetMode("analysis");
  _renderSidebar();
  _renderAnalysis();
}
function closeAIAssistant() {
  const p = document.getElementById("aiaPage");
  if (p) p.style.display = "none";
  document.body.style.overflow = "";
  _aiaOpen = false;
}

/* ═══════════════════════════════════════════════════════════════
   PAGE BUILDER  (builds DOM once)
   ═══════════════════════════════════════════════════════════════ */

function _buildPage() {
  const el = document.createElement("div");
  el.id = "aiaPage";
  el.className = "aia-page";
  el.style.display = "none";
  el.innerHTML = `
<div class="aia-shell" id="aiaShell">

  <!-- ══ SIDEBAR ══════════════════════════════════════════ -->
  <aside class="aia-sidebar" id="aiaSidebar">

    <div class="aia-sb-brand">
      <div class="aia-sb-brand-icon"><i class="fas fa-brain"></i></div>
      <span class="aia-sb-text aia-sb-brand-label">BlueLedger AI</span>
      <button class="aia-sb-collapse-btn" onclick="aiaToggleSidebar()" title="Collapse sidebar">
        <i class="fas fa-chevron-left" id="aiaCollapseIcon"></i>
      </button>
    </div>

    <button class="aia-sb-new-btn" onclick="aiaSetMode('analysis');_renderAnalysis();">
      <i class="fas fa-chart-bar"></i>
      <span class="aia-sb-text">New Analysis</span>
    </button>

    <!-- Recent Reports -->
    <div class="aia-sb-section aia-sb-text">
      <i class="fas fa-file-chart-column"></i> Recent Reports
    </div>
    <div class="aia-sb-list" id="aiaSbReports"></div>

    <!-- Pinned Insights -->
    <div class="aia-sb-section aia-sb-text">
      <i class="fas fa-thumbtack"></i> Pinned Insights
    </div>
    <div class="aia-sb-list" id="aiaSbPins"></div>

    <div class="aia-sb-bottom">
      <button class="aia-sb-bottom-btn" onclick="closeAIAssistant()" title="Close">
        <i class="fas fa-times"></i>
        <span class="aia-sb-text">Close</span>
      </button>
    </div>

  </aside>

  <!-- ══ MAIN ══════════════════════════════════════════════ -->
  <main class="aia-main">

    <header class="aia-topbar">
      <div class="aia-topbar-l">
        <button class="aia-icon-btn" onclick="aiaToggleSidebar()" title="Toggle sidebar"><i class="fas fa-bars"></i></button>
        <span class="aia-topbar-title" id="aiaTopTitle"><i class="fas fa-chart-line" style="color:#818cf8;margin-right:.4rem"></i>Financial Analysis</span>
      </div>
      <div class="aia-topbar-r">
        <button class="aia-tab-btn" id="aiaTabA" onclick="aiaSetMode('analysis')"><i class="fas fa-chart-pie"></i><span>Analysis</span></button>
        <button class="aia-tab-btn" id="aiaTabC" onclick="aiaSetMode('chat')"><i class="fas fa-comment-dots"></i><span>Chat</span></button>
        <button class="aia-icon-btn" onclick="closeAIAssistant()" title="Close"><i class="fas fa-times"></i></button>
      </div>
    </header>

    <!-- ── ANALYSIS VIEW ─────────────────────────────────── -->
    <div class="aia-view" id="aiaViewA">
      <div class="aia-scroll">
        <div class="aia-col" id="aiaAnalysisCol">
          <!-- cards injected by _renderAnalysis() -->
        </div>
      </div>
      <div class="aia-cta-bar">
        <button class="aia-cta-btn" onclick="aiaSetMode('chat');_clearChat();">
          <i class="fas fa-comment-dots"></i> Continue with AI Assistant
        </button>
      </div>
    </div>

    <!-- ── CHAT VIEW ──────────────────────────────────────── -->
    <div class="aia-view" id="aiaViewC" style="display:none">
      <div class="aia-chat-msgs" id="aiaChatMsgs">
        <div class="aia-welcome" id="aiaWelcome">
          <div class="aia-welcome-icon"><i class="fas fa-robot"></i></div>
          <div class="aia-welcome-title">Ask your Financial Copilot</div>
          <div class="aia-welcome-sub">I analyse your real transaction data to give contextual financial guidance.</div>
          <div class="aia-qps">
            <button class="aia-qp" onclick="aiaAsk('Analyse this month\\'s spending')">Analyse this month</button>
            <button class="aia-qp" onclick="aiaAsk('How can I save more?')">How to save more?</button>
            <button class="aia-qp" onclick="aiaAsk('Predict next month\\'s expenses')">Predict next month</button>
            <button class="aia-qp" onclick="aiaAsk('What is my biggest spending mistake?')">Biggest mistake</button>
            <button class="aia-qp" onclick="aiaAsk('Build me a weekly budget')">Weekly budget</button>
            <button class="aia-qp" onclick="aiaAsk('Improve my savings rate')">Improve savings</button>
            <button class="aia-qp" onclick="aiaAsk('Which categories should I cut?')">Where to cut?</button>
          </div>
        </div>
      </div>
      <div class="aia-input-bar">
        <button class="aia-voice-btn" id="aiaVoiceBtn" onclick="aiaToggleVoice()" title="Voice input"><i class="fas fa-microphone" id="aiaVoiceIcon"></i></button>
        <div class="aia-input-wrap">
          <textarea class="aia-input" id="aiaInput" rows="1" placeholder="Ask about your finances…"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();aiaSend();}"
            oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"></textarea>
        </div>
        <button class="aia-send-btn" id="aiaSendBtn" onclick="aiaSend()"><i class="fas fa-paper-plane"></i></button>
      </div>
    </div>

  </main>
</div>`;
  document.body.appendChild(el);
  _applyCollapsed();
}

/* ═══════════════════════════════════════════════════════════════
   SIDEBAR
   ═══════════════════════════════════════════════════════════════ */

function aiaToggleSidebar() {
  _sbCollapsed = !_sbCollapsed;
  localStorage.setItem(BL_SIDEBAR_KEY, _sbCollapsed ? "1" : "0");
  _applyCollapsed();
}
window.aiaToggleSidebar = aiaToggleSidebar;

function _applyCollapsed() {
  const sb = document.getElementById("aiaSidebar"),
    sh = document.getElementById("aiaShell"),
    ic = document.getElementById("aiaCollapseIcon");
  if (!sb || !sh) return;
  sb.classList.toggle("aia-sb--col", _sbCollapsed);
  sh.classList.toggle("aia-shell--col", _sbCollapsed);
  if (ic)
    ic.className = _sbCollapsed
      ? "fas fa-chevron-right"
      : "fas fa-chevron-left";
}

function _renderSidebar() {
  const reports = _loadReports(),
    pins = _loadPins();
  const rEl = document.getElementById("aiaSbReports"),
    pEl = document.getElementById("aiaSbPins");
  if (!rEl || !pEl) return;

  // Status badge helper
  const badge = (grade, color) =>
    `<span class="aia-sb-badge" style="background:${color}20;color:${color};border-color:${color}40">${grade}</span>`;
  const scoreColor = (s) =>
    s >= 85
      ? "#10b981"
      : s >= 70
        ? "#34d399"
        : s >= 55
          ? "#fbbf24"
          : s >= 40
            ? "#f97316"
            : "#ef4444";

  rEl.innerHTML = reports.length
    ? reports
        .map(
          (r) => `
    <div class="aia-sb-report" onclick="aiaSetMode('analysis');_renderAnalysis();">
      <div class="aia-sb-report-top">
        <span class="aia-sb-report-title aia-sb-text">${safeText(r.title)}</span>
        <button class="aia-sb-del" onclick="event.stopPropagation();_deleteReport('${r.id}')" title="Delete"><i class="fas fa-times"></i></button>
      </div>
      <div class="aia-sb-report-meta aia-sb-text">
        <span class="aia-sb-report-score" style="color:${r.color || scoreColor(r.score || 0)}">${r.score || "-"}/100</span>
        ${badge(r.grade || "—", r.color || "#64748b")}
        <span class="aia-sb-report-ts">${r.tsDisplay || ""}</span>
      </div>
    </div>`,
        )
        .join("")
    : `<div class="aia-sb-empty aia-sb-text">Run an analysis to save a report</div>`;

  pEl.innerHTML = pins.length
    ? pins
        .map(
          (p) => `
    <div class="aia-sb-pin">
      <i class="fas fa-thumbtack aia-sb-pin-icon"></i>
      <span class="aia-sb-pin-text aia-sb-text">${safeText(p.text)}</span>
      <button class="aia-sb-del" onclick="_deletePin('${p.id}')" title="Remove"><i class="fas fa-times"></i></button>
    </div>`,
        )
        .join("")
    : `<div class="aia-sb-empty aia-sb-text">Pin insights to keep them here</div>`;
}

/* ═══════════════════════════════════════════════════════════════
   MODE SWITCHING
   ═══════════════════════════════════════════════════════════════ */

function aiaSetMode(mode) {
  _aiaMode = mode;
  const va = document.getElementById("aiaViewA"),
    vc = document.getElementById("aiaViewC");
  const tabA = document.getElementById("aiaTabA"),
    tabC = document.getElementById("aiaTabC");
  const ttl = document.getElementById("aiaTopTitle");
  if (!va || !vc) return;
  if (mode === "analysis") {
    va.style.display = "";
    vc.style.display = "none";
    tabA?.classList.add("active");
    tabC?.classList.remove("active");
    if (ttl)
      ttl.innerHTML = `<i class="fas fa-chart-line" style="color:#818cf8;margin-right:.4rem"></i>Financial Analysis`;
  } else {
    va.style.display = "none";
    vc.style.display = "";
    tabA?.classList.remove("active");
    tabC?.classList.add("active");
    if (ttl)
      ttl.innerHTML = `<i class="fas fa-comment-dots" style="color:#818cf8;margin-right:.4rem"></i>AI Financial Chat`;
  }
}
window.aiaSetMode = aiaSetMode;

/* ═══════════════════════════════════════════════════════════════
   ANALYSIS VIEW — single column, no left/right split
   ═══════════════════════════════════════════════════════════════ */

function _renderAnalysis() {
  const col = document.getElementById("aiaAnalysisCol");
  if (!col) return;

  const txns = _getTxns();
  const tm = _thisMonthTxns(),
    lm = _lastMonthTxns();
  const tmIn = _sumType(tm, "income"),
    tmEx = _sumType(tm, "expense"),
    lmEx = _sumType(lm, "expense");
  const { score, grade, color, factors } = computeHealthScore();
  const proj = _projected(tm),
    avgD = Math.round(_avgDaily(tm)),
    lim = _getLimit();
  const dLeft =
    new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() -
    new Date().getDate();
  const mom = lmEx > 0 ? Math.round(((tmEx - lmEx) / lmEx) * 100) : 0;
  const savR = tmIn > 0 ? Math.round(((tmIn - tmEx) / tmIn) * 100) : 0;
  const over = lim > 0 && proj > lim;
  const predColor = over ? "#ef4444" : "#10b981";

  // Score ring
  const C = 2 * Math.PI * 42,
    off = C - (score / 100) * C;
  const factorsHtml = factors
    .map(
      (f) => `
    <div class="aia-factor aia-factor--${f.t}">
      <i class="fas fa-${f.t === "pos" ? "check-circle" : f.t === "neg" ? "times-circle" : "minus-circle"}"></i>
      <span>${safeText(f.text)}</span>
    </div>`,
    )
    .join("");

  // Behaviour
  const dow = _dowTotals(tm),
    dN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const topDow = Object.entries(dow).sort((a, b) => b[1] - a[1]);
  const topCat = Object.entries(_catTotals(tm)).sort((a, b) => b[1] - a[1])[0];
  const fg = _fastestCat();
  const maxDow = Math.max(...Object.values(dow), 1);
  const barHtml = [1, 2, 3, 4, 5, 6, 0]
    .map((d) => {
      const h = Math.max(4, Math.round((dow[d] / maxDow) * 44)),
        isTop = d === parseInt(topDow[0]?.[0]);
      return `<div class="aia-dow-col"><div class="aia-dow-bar${isTop ? " aia-dow-bar--top" : ""}" style="height:${h}px"></div><div class="aia-dow-lbl">${dN[d]}</div></div>`;
    })
    .join("");

  // Insights
  const ins = generateLocalInsights();
  const insHtml = ins
    .map(
      (i) => `
    <div class="aia-ins-row aia-ins-row--${i.t || "info"}">
      <span class="aia-ins-em">${i.icon}</span>
      <div><div class="aia-ins-title">${safeText(i.title)}</div><div class="aia-ins-body">${safeText(i.body)}</div></div>
    </div>`,
    )
    .join("");

  // Recs
  const recs = generateBudgetRecs();
  const recsHtml = recs
    .map(
      (r) => `
    <div class="aia-rec">
      <span class="aia-rec-icon">${r.icon}</span>
      <div><div class="aia-rec-title">${safeText(r.title)}</div><div class="aia-rec-body">${safeText(r.body)}</div></div>
    </div>`,
    )
    .join("");

  col.innerHTML = `

  <!-- ── Row 1: Score + Prediction ──────────────────────── -->
  <div class="aia-row-2">

    <div class="aia-card aia-card--score">
      <div class="aia-card-hdr">
        <div class="aia-card-icon" style="background:rgba(99,102,241,0.14);color:#818cf8"><i class="fas fa-heart-pulse"></i></div>
        <span class="aia-card-title">Financial Health Score</span>
      </div>
      <div class="aia-score-body">
        <div class="aia-ring-wrap">
          <svg viewBox="0 0 100 100" width="110" height="110">
            <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
            <circle cx="50" cy="50" r="42" fill="none" stroke="${color}" stroke-width="8"
              stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${off}"
              transform="rotate(-90 50 50)" style="transition:stroke-dashoffset 1.2s ease"/>
          </svg>
          <div class="aia-ring-center">
            <div class="aia-ring-num" style="color:${color}">${score}</div>
            <div class="aia-ring-den">/100</div>
          </div>
        </div>
        <div class="aia-score-info">
          <div class="aia-score-grade" style="color:${color}">${grade}</div>
          <div class="aia-score-sub">Financial Health</div>
          <div class="aia-factors">${factorsHtml}</div>
        </div>
      </div>
    </div>

    <div class="aia-card aia-card--pred">
      <div class="aia-card-hdr">
        <div class="aia-card-icon" style="background:rgba(16,185,129,0.12);color:${predColor}"><i class="fas fa-chart-line"></i></div>
        <span class="aia-card-title">Month-end Prediction</span>
      </div>
      <div class="aia-pred-amt" style="color:${predColor}">₹${proj.toLocaleString("en-IN")}</div>
      <div class="aia-pred-meta">
        <span><i class="fas fa-calendar-day"></i> ${dLeft}d left</span>
        <span><i class="fas fa-coins"></i> ₹${avgD}/day</span>
        <span><i class="fas fa-wallet"></i> ₹${Math.round(tmEx).toLocaleString("en-IN")} spent</span>
      </div>
      ${over ? `<div class="aia-pred-warn">⚠️ ₹${(proj - lim).toLocaleString("en-IN")} over ₹${lim.toLocaleString("en-IN")} budget</div>` : ""}
      ${tmIn > 0 ? `<div class="aia-pred-savings">💰 Savings: ₹${Math.round(tmIn - tmEx).toLocaleString("en-IN")} (${savR}%)</div>` : ""}
    </div>

  </div>

  <!-- ── Row 2: Spending Behaviour ─────────────────────── -->
  <div class="aia-card">
    <div class="aia-card-hdr">
      <div class="aia-card-icon" style="background:rgba(163,92,244,0.12);color:#a78bfa"><i class="fas fa-brain"></i></div>
      <span class="aia-card-title">Spending Behaviour</span>
    </div>
    <div class="aia-behav-stats">
      ${topCat ? `<div class="aia-bstat"><span class="aia-bstat-em">🏆</span><div><div class="aia-bstat-val">${safeText(topCat[0])}: ₹${Math.round(topCat[1]).toLocaleString("en-IN")}</div><div class="aia-bstat-lbl">Top category</div></div></div>` : ""}
      ${topDow[0] && topDow[0][1] > 0 ? `<div class="aia-bstat"><span class="aia-bstat-em">📆</span><div><div class="aia-bstat-val">${dN[topDow[0][0]]}</div><div class="aia-bstat-lbl">Highest spend day</div></div></div>` : ""}
      ${fg ? `<div class="aia-bstat aia-bstat--warn"><span class="aia-bstat-em">📈</span><div><div class="aia-bstat-val">${safeText(fg.category)} +${fg.pct}%</div><div class="aia-bstat-lbl">Fastest growing</div></div></div>` : ""}
      ${lmEx > 0 && tmEx > 0 ? `<div class="aia-bstat ${mom > 10 ? "aia-bstat--warn" : ""}"><span class="aia-bstat-em">${mom > 0 ? "📈" : "📉"}</span><div><div class="aia-bstat-val">${mom > 0 ? "+" : ""}${mom}%</div><div class="aia-bstat-lbl">vs last month</div></div></div>` : ""}
    </div>
    <div class="aia-dow-chart">${barHtml}</div>
  </div>

  <!-- ── Row 3: Smart Insights ─────────────────────────── -->
  <div class="aia-card">
    <div class="aia-card-hdr">
      <div class="aia-card-icon" style="background:rgba(251,191,36,0.12);color:#fbbf24"><i class="fas fa-lightbulb"></i></div>
      <span class="aia-card-title">Smart Insights</span>
      <button class="aia-pin-btn" onclick="aiaPinInsights()" title="Pin these insights"><i class="fas fa-thumbtack"></i> Pin</button>
    </div>
    <div class="aia-ins-list">${insHtml}</div>
  </div>

  <!-- ── Row 4: Budget Recommendations ─────────────────── -->
  <div class="aia-card">
    <div class="aia-card-hdr">
      <div class="aia-card-icon" style="background:rgba(52,211,153,0.12);color:#34d399"><i class="fas fa-piggy-bank"></i></div>
      <span class="aia-card-title">Budget Recommendations</span>
    </div>
    <div class="aia-recs">${recsHtml}</div>
  </div>

  <!-- ── Row 5: AI Deep Analysis ───────────────────────── -->
  <div class="aia-card" id="acDeep">
    <div class="aia-card-hdr">
      <div class="aia-card-icon" style="background:rgba(163,92,244,0.14);color:#a78bfa"><i class="fas fa-wand-magic-sparkles"></i></div>
      <span class="aia-card-title">AI Deep Analysis</span>
    </div>
    <p class="aia-card-desc">Generate a full financial intelligence report with risk detection, predictions and a personalised action plan.</p>
    <button class="aia-deep-btn" id="aiaDeepBtn" onclick="aiaRunDeep()">
      <i class="fas fa-brain"></i> Run Deep Analysis
    </button>
    <div id="aiaDeepResult"></div>
  </div>

  `;
}
window._renderAnalysis = _renderAnalysis;

/* ── Pin insights ────────────────────────────────────────────── */
function aiaPinInsights() {
  const ins = generateLocalInsights();
  ins.slice(0, 3).forEach((i) => _addPin(i.title));
  _renderSidebar();
  if (typeof toast === "function")
    toast("Insights pinned to sidebar", "success");
}
window.aiaPinInsights = aiaPinInsights;

/* ═══════════════════════════════════════════════════════════════
   DEEP AI ANALYSIS  (single column, full width)
   ═══════════════════════════════════════════════════════════════ */

async function aiaRunDeep() {
  const btn = document.getElementById("aiaDeepBtn"),
    res = document.getElementById("aiaDeepResult");
  if (!btn || !res) return;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analysing…';
  res.innerHTML = `<div class="aia-deep-loading"><i class="fas fa-brain"></i> Running financial analysis…</div>`;

  let parsed = null;
  try {
    const sys = `You are BlueLedger AI. Return ONLY valid JSON (no markdown fences):
{"headline":"string","overallAssessment":"string","topInsights":[{"title":"short label","body":"detail sentence","severity":"low|medium|high"}],"predictions":[{"label":"string","value":"string","reasoning":"string"}],"actionPlan":[{"step":"string","impact":"string"}]}
Rules: topInsights=3 items (title≠body), predictions=2, actionPlan=3. Use ₹. Indian finance.`;
    const raw = await _withTimeout(
      _callAI([{ role: "user", content: _buildCtx() }], sys, 600),
      20000,
    );
    parsed = extractJsonFromText(raw);
  } catch (e) {
    console.info("BL AI: deep API unavailable", e.message);
  }
  if (!parsed?.headline) parsed = _buildLocalDeep();

  // Save report to sidebar
  const { score, grade, color } = computeHealthScore();
  _saveReport(parsed.headline, score, grade, color);
  _renderSidebar();

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
      <div><div class="aia-da-step">${safeText(s.step)}</div><div class="aia-da-impact">${safeText(s.impact)}</div></div>
    </div>`,
    )
    .join("");

  res.innerHTML = `
    <div class="aia-deep-card">
      <div class="aia-deep-src${parsed._isLocal ? " aia-deep-src--local" : ""}">
        <i class="fas fa-${parsed._isLocal ? "bolt" : "robot"}"></i>
        ${parsed._isLocal ? "Instant local analysis — your real transaction data" : "AI-powered analysis"}
      </div>
      <div class="aia-deep-headline">${safeText(parsed.headline)}</div>
      <div class="aia-deep-assess">${safeText(parsed.overallAssessment)}</div>
      <div class="aia-deep-sec"><i class="fas fa-lightbulb" style="color:#fbbf24"></i> Key Insights</div>
      <div class="aia-di-list">${insHtml}</div>
      <div class="aia-deep-sec"><i class="fas fa-chart-line" style="color:#818cf8"></i> Predictions</div>
      <div class="aia-dp-grid">${pHtml}</div>
      <div class="aia-deep-sec"><i class="fas fa-list-check" style="color:#34d399"></i> Action Plan</div>
      <div class="aia-da-list">${aHtml}</div>
      <div class="aia-deep-actions">
        <button class="aia-deep-dismiss" onclick="document.getElementById('aiaDeepResult').innerHTML='';document.getElementById('aiaDeepBtn').disabled=false;document.getElementById('aiaDeepBtn').innerHTML='<i class=\\'fas fa-redo\\'></i> Re-run Analysis'">
          <i class="fas fa-times"></i> Dismiss
        </button>
        <button class="aia-deep-pin" onclick="aiaPinInsights()">
          <i class="fas fa-thumbtack"></i> Pin Insights
        </button>
      </div>
    </div>`;

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-redo"></i> Re-run Analysis';
}
window.aiaRunDeep = aiaRunDeep;

/* ═══════════════════════════════════════════════════════════════
   CHAT ENGINE  (in-memory only, not persisted — focused on analysis)
   ═══════════════════════════════════════════════════════════════ */

function _clearChat() {
  _chatHistory = [];
  const c = document.getElementById("aiaChatMsgs");
  if (!c) return;
  c.innerHTML = `
    <div class="aia-welcome" id="aiaWelcome">
      <div class="aia-welcome-icon"><i class="fas fa-robot"></i></div>
      <div class="aia-welcome-title">Ask your Financial Copilot</div>
      <div class="aia-welcome-sub">I analyse your real transaction data to give contextual financial guidance.</div>
      <div class="aia-qps">
        <button class="aia-qp" onclick="aiaAsk('Analyse this month\\'s spending')">Analyse this month</button>
        <button class="aia-qp" onclick="aiaAsk('How can I save more?')">How to save more?</button>
        <button class="aia-qp" onclick="aiaAsk('Predict next month\\'s expenses')">Predict next month</button>
        <button class="aia-qp" onclick="aiaAsk('What is my biggest spending mistake?')">Biggest mistake</button>
        <button class="aia-qp" onclick="aiaAsk('Build me a weekly budget')">Weekly budget</button>
        <button class="aia-qp" onclick="aiaAsk('Improve my savings rate')">Improve savings</button>
        <button class="aia-qp" onclick="aiaAsk('Which categories should I cut?')">Where to cut?</button>
      </div>
    </div>`;
}
window._clearChat = _clearChat;

function aiaAsk(q) {
  const el = document.getElementById("aiaInput");
  if (el) el.value = q;
  aiaSend();
}
window.aiaAsk = aiaAsk;

async function aiaSend() {
  if (_chatBusy) return;
  const el = document.getElementById("aiaInput");
  const q = (el?.value || "").trim();
  if (!q) return;
  if (el) {
    el.value = "";
    el.style.height = "auto";
  }
  const w = document.getElementById("aiaWelcome");
  if (w) w.style.display = "none";
  const ts = new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  _appendMsg("user", safeText(q), ts, true);
  _chatHistory.push({ role: "user", content: q });
  const tid = "t_" + Date.now();
  _appendTyping(tid);
  _chatBusy = true;
  const sb = document.getElementById("aiaSendBtn");
  if (sb) sb.disabled = true;
  try {
    const sys = `You are BlueLedger AI, an intelligent personal finance copilot for an Indian user.
Answer using ONLY the data below. Be specific with ₹. Max 150 words. Use markdown (bold, bullets).
Never invent transactions. Sound analytical and concise.\n\n${_buildCtx()}`;
    const reply = await _withTimeout(
      _callAI(_chatHistory.slice(-20), sys, 500),
      20000,
    );
    document.getElementById(tid)?.closest(".aia-msg-ai")?.remove();
    const rHtml = markdownToHtml(reply);
    const rTs = new Date().toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    _appendMsg("assistant", rHtml, rTs, true);
    _chatHistory.push({ role: "assistant", content: reply });
    if (_chatHistory.length > 40) _chatHistory = _chatHistory.slice(-40);
  } catch (e) {
    document.getElementById(tid)?.closest(".aia-msg-ai")?.remove();
    _appendMsg(
      "assistant",
      "Connection issue — please try again.",
      new Date().toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      true,
    );
    console.warn("BL AI chat:", e);
  } finally {
    _chatBusy = false;
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
    d.innerHTML = `<div class="aia-msg-av"><i class="fas fa-robot"></i></div>
      <div class="aia-msg-ai-body">
        <div class="aia-bubble-ai">${html}</div>
        <div class="aia-msg-meta"><span>${ts}</span><button class="aia-copy-btn" onclick="aiaCopyMsg(this)" title="Copy"><i class="fas fa-copy"></i></button></div>
      </div>`;
  } else {
    d.className = "aia-msg-user";
    d.innerHTML = `<div class="aia-msg-user-body"><div class="aia-bubble-user">${html}</div><div class="aia-msg-meta aia-msg-meta--r"><span>${ts}</span></div></div>`;
  }
  c.appendChild(d);
  if (scroll) c.scrollTop = c.scrollHeight;
}

function _appendTyping(id) {
  const c = document.getElementById("aiaChatMsgs");
  if (!c) return;
  const d = document.createElement("div");
  d.className = "aia-msg-ai";
  d.innerHTML = `<div class="aia-msg-av"><i class="fas fa-robot"></i></div><div class="aia-msg-ai-body"><div class="aia-bubble-ai"><span id="${id}" class="aia-typing"><span></span><span></span><span></span></span></div></div>`;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
}

function aiaCopyMsg(btn) {
  const b = btn.closest(".aia-msg-ai-body")?.querySelector(".aia-bubble-ai");
  if (!b) return;
  navigator.clipboard?.writeText(b.innerText || b.textContent || "");
  btn.innerHTML = '<i class="fas fa-check"></i>';
  setTimeout(() => (btn.innerHTML = '<i class="fas fa-copy"></i>'), 1500);
}
window.aiaCopyMsg = aiaCopyMsg;

/* ═══════════════════════════════════════════════════════════════
   VOICE
   ═══════════════════════════════════════════════════════════════ */

function aiaToggleVoice() {
  const btn = document.getElementById("aiaVoiceBtn"),
    ic = document.getElementById("aiaVoiceIcon"),
    inp = document.getElementById("aiaInput");
  if (_voiceActive) {
    _recognition?.stop();
    _voiceActive = false;
    btn?.classList.remove("aia-voice--on");
    if (ic) ic.className = "fas fa-microphone";
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    if (typeof toast === "function") toast("Voice not supported", "warn");
    return;
  }
  _recognition = new SR();
  _recognition.lang = "en-IN";
  _recognition.interimResults = false;
  _recognition.onstart = () => {
    _voiceActive = true;
    btn?.classList.add("aia-voice--on");
    if (ic) ic.className = "fas fa-circle-dot";
  };
  _recognition.onresult = (e) => {
    if (inp) inp.value = e.results[0][0].transcript;
    _voiceActive = false;
    btn?.classList.remove("aia-voice--on");
    if (ic) ic.className = "fas fa-microphone";
    setTimeout(() => aiaSend(), 200);
  };
  _recognition.onerror = _recognition.onend = () => {
    _voiceActive = false;
    btn?.classList.remove("aia-voice--on");
    if (ic) ic.className = "fas fa-microphone";
  };
  _recognition.start();
}
window.aiaToggleVoice = aiaToggleVoice;

/* ═══════════════════════════════════════════════════════════════
   TIMEOUT
   ═══════════════════════════════════════════════════════════════ */
function _withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms)),
  ]);
}

/* ═══════════════════════════════════════════════════════════════
   REFRESH HOOK  (called by refreshAll in script.js)
   ═══════════════════════════════════════════════════════════════ */
function aiaRefresh() {
  if (!_aiaOpen) return;
  if (_aiaMode === "analysis") _renderAnalysis();
}
window.aiaRefresh = aiaRefresh;

/* ═══════════════════════════════════════════════════════════════
   EXPORTS
   ═══════════════════════════════════════════════════════════════ */
window.openAIAssistant = openAIAssistant;
window.closeAIAssistant = closeAIAssistant;
window.computeHealthScore = computeHealthScore;
window.generateLocalInsights = generateLocalInsights;
window.generateBudgetRecs = generateBudgetRecs;
