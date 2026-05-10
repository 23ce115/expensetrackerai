/* ═══════════════════════════════════════════════════════════════
   ai-assistant.js — BlueLedger AI Financial Assistant
   Full-featured intelligence layer: health score, insights,
   predictions, budget recommendations, conversational chat,
   voice queries — all driven by real transaction data.

   Depends on: utils.js, ai.js (must load first)
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ══════════════════════════════════════════════════════════════
   FINANCIAL ANALYSIS ENGINE
   Pure computation — no UI side-effects.
   ══════════════════════════════════════════════════════════════ */

/**
 * Pull the global transactions array safely.
 * @returns {Array}
 */
function _getTxns() {
  return (typeof transactions !== "undefined" && Array.isArray(transactions))
    ? transactions
    : [];
}

/**
 * Return transactions for the current calendar month.
 */
function _thisMonthTxns() {
  const now = new Date();
  return _getTxns().filter(t => {
    const d = new Date(t.date + "T00:00:00");
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });
}

/**
 * Return transactions for the previous calendar month.
 */
function _lastMonthTxns() {
  const now = new Date();
  const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return _getTxns().filter(t => {
    const d = new Date(t.date + "T00:00:00");
    return d.getFullYear() === lm.getFullYear() && d.getMonth() === lm.getMonth();
  });
}

/**
 * Sum amounts for a given type (income|expense).
 */
function _sum(txns, type) {
  return txns
    .filter(t => t.type === type)
    .reduce((s, t) => s + Math.abs(t.amount), 0);
}

/**
 * Group expense transactions by category and return totals map.
 */
function _catTotals(txns) {
  const map = {};
  txns.filter(t => t.type === "expense").forEach(t => {
    map[t.category] = (map[t.category] || 0) + Math.abs(t.amount);
  });
  return map;
}

/**
 * Group expenses by day-of-week (0=Sun…6=Sat).
 */
function _dowTotals(txns) {
  const map = { 0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0 };
  txns.filter(t => t.type === "expense").forEach(t => {
    const dow = new Date(t.date + "T00:00:00").getDay();
    map[dow] += Math.abs(t.amount);
  });
  return map;
}

/**
 * Average daily expense based on days elapsed this month.
 */
function _avgDailyExpense(txns) {
  const now = new Date();
  const daysPassed = now.getDate();
  const total = _sum(txns.filter(t => t.type === "expense"), "expense");
  return daysPassed > 0 ? total / daysPassed : 0;
}

/**
 * Project end-of-month spending based on current daily average.
 */
function _projectedMonthlySpend(txns) {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.round(_avgDailyExpense(txns) * daysInMonth);
}

/**
 * Find the fastest-growing expense category vs last month.
 * Returns { category, pct } or null.
 */
function _fastestGrowingCat() {
  const cur = _catTotals(_thisMonthTxns());
  const prev = _catTotals(_lastMonthTxns());
  let best = null, bestPct = 0;
  Object.keys(cur).forEach(cat => {
    if (prev[cat] && prev[cat] > 0) {
      const pct = ((cur[cat] - prev[cat]) / prev[cat]) * 100;
      if (pct > bestPct) { bestPct = pct; best = { category: cat, pct: Math.round(pct) }; }
    }
  });
  return best;
}

/**
 * Build a SLIM financial context string for AI prompts.
 * Keeps token count low to avoid 504 timeouts on the free LLM.
 * Uses summary stats only — no raw transaction dump.
 */
function _buildFullFinanceContext() {
  const txns = _getTxns();
  const now = new Date();
  const thisMonth = _thisMonthTxns();
  const lastMonth = _lastMonthTxns();

  const tmIncome  = _sum(thisMonth, "income");
  const tmExpense = _sum(thisMonth, "expense");
  const lmExpense = _sum(lastMonth, "expense");
  const totalTxns = txns.length;

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft    = daysInMonth - now.getDate();
  const avgDaily    = Math.round(_avgDailyExpense(thisMonth));
  const projected   = _projectedMonthlySpend(thisMonth);
  const limit       = (typeof userData !== "undefined" && userData?.spendingLimit) || 0;

  // Category summary: top 6 categories with MoM change
  const curCats  = _catTotals(thisMonth);
  const prevCats = _catTotals(lastMonth);
  const catLines = Object.entries(curCats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([c, cur]) => {
      const prev = prevCats[c] || 0;
      const chg  = prev > 0 ? ` (${cur > prev ? "+" : ""}${Math.round(((cur - prev) / prev) * 100)}% MoM)` : "";
      return `  ${c}: ₹${Math.round(cur)}${chg}`;
    }).join("\n");

  // Day-of-week summary
  const dowMap   = _dowTotals(thisMonth);
  const dowNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const topDow   = Object.entries(dowMap).sort((a,b) => b[1]-a[1])[0];
  const topDowStr = topDow ? `${dowNames[topDow[0]]}: ₹${Math.round(topDow[1])}` : "N/A";

  // 5 most recent transactions only (not 30)
  const recentLines = txns.slice(0, 5)
    .map(t => `  ${t.date} ${t.type} ${t.category} ${t.type==="income"?"+":"-"}₹${Math.round(Math.abs(t.amount))}`)
    .join("\n");

  const savingsRate = tmIncome > 0 ? Math.round(((tmIncome - tmExpense) / tmIncome) * 100) : 0;
  const momTrend    = lmExpense > 0 ? Math.round(((tmExpense - lmExpense) / lmExpense) * 100) : 0;

  return `=== BlueLedger Summary ===
Date: ${now.toLocaleDateString("en-IN")} | Day ${now.getDate()}/${daysInMonth} | ${daysLeft} days left

This month: Income ₹${Math.round(tmIncome)} | Expense ₹${Math.round(tmExpense)} | Net ₹${Math.round(tmIncome-tmExpense)}
Savings rate: ${savingsRate}% | Avg daily: ₹${avgDaily} | Projected: ₹${projected}
${limit > 0 ? `Budget: ₹${limit} (${Math.round((tmExpense/limit)*100)}% used)` : "No budget set"}
Last month expense: ₹${Math.round(lmExpense)} | MoM trend: ${momTrend > 0 ? "+" : ""}${momTrend}%
Total transactions recorded: ${totalTxns}

Top categories this month:
${catLines || "  None yet"}

Highest spending day: ${topDowStr}

Recent 5 transactions:
${recentLines || "  None yet"}`;
}

/* ══════════════════════════════════════════════════════════════
   FINANCIAL HEALTH SCORE ENGINE
   ══════════════════════════════════════════════════════════════ */

/**
 * Compute a 0–100 financial health score from transaction data.
 * Returns { score, grade, factors }
 */
function computeHealthScore() {
  const txns = _getTxns();
  if (!txns.length) return { score: 0, grade: "N/A", factors: [] };

  const thisMonth = _thisMonthTxns();
  const lastMonth = _lastMonthTxns();
  const tmIncome = _sum(thisMonth, "income");
  const tmExpense = _sum(thisMonth, "expense");
  const lmExpense = _sum(lastMonth, "expense");
  const limit = (typeof userData !== "undefined" && userData?.spendingLimit) || 0;

  let score = 50; // baseline
  const factors = [];

  // 1. Savings rate (income > expense this month)
  if (tmIncome > 0) {
    const savingsRate = (tmIncome - tmExpense) / tmIncome;
    if (savingsRate >= 0.3) { score += 20; factors.push({ type: "positive", text: `Strong savings rate: ${Math.round(savingsRate * 100)}% of income saved` }); }
    else if (savingsRate >= 0.1) { score += 10; factors.push({ type: "neutral", text: `Moderate savings rate: ${Math.round(savingsRate * 100)}%` }); }
    else if (savingsRate < 0) { score -= 15; factors.push({ type: "negative", text: "Spending exceeds income this month" }); }
    else { score += 0; factors.push({ type: "neutral", text: `Low savings rate: ${Math.round(savingsRate * 100)}%` }); }
  }

  // 2. Month-over-month expense trend
  if (lmExpense > 0 && tmExpense > 0) {
    const trend = (tmExpense - lmExpense) / lmExpense;
    if (trend < -0.1) { score += 15; factors.push({ type: "positive", text: `Spending down ${Math.round(-trend*100)}% vs last month` }); }
    else if (trend > 0.25) { score -= 10; factors.push({ type: "negative", text: `Spending up ${Math.round(trend*100)}% vs last month` }); }
  }

  // 3. Budget adherence
  if (limit > 0) {
    const used = tmExpense / limit;
    if (used <= 0.8) { score += 10; factors.push({ type: "positive", text: `Well within monthly budget (${Math.round(used*100)}% used)` }); }
    else if (used <= 1.0) { score += 0; factors.push({ type: "neutral", text: `Approaching budget limit (${Math.round(used*100)}% used)` }); }
    else { score -= 15; factors.push({ type: "negative", text: `Over budget — ${Math.round((used-1)*100)}% exceeded` }); }
  }

  // 4. Transaction diversity (healthy spending across multiple categories)
  const cats = Object.keys(_catTotals(thisMonth));
  if (cats.length >= 4) { score += 5; }

  // 5. Consistent recording (enough transactions)
  if (txns.length >= 10) { score += 5; factors.push({ type: "positive", text: "Consistent financial tracking" }); }

  // 6. Investment behaviour
  const hasInvestment = txns.some(t => t.category === "Investment" && t.type === "expense");
  if (hasInvestment) { score += 5; factors.push({ type: "positive", text: "Active investment activity detected" }); }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let grade = "Poor";
  if (score >= 85) grade = "Excellent";
  else if (score >= 70) grade = "Good";
  else if (score >= 55) grade = "Fair";
  else if (score >= 40) grade = "Needs Work";

  return { score, grade, factors };
}

/* ══════════════════════════════════════════════════════════════
   DYNAMIC INSIGHT GENERATOR (LOCAL — instant, no API)
   ══════════════════════════════════════════════════════════════ */

function generateLocalInsights() {
  const txns = _getTxns();
  const now = new Date();
  const thisMonth = _thisMonthTxns();
  const lastMonth = _lastMonthTxns();
  const insights = [];

  if (!txns.length) return [{ icon: "💡", text: "Add your first transaction to unlock AI insights." }];

  const tmIncome = _sum(thisMonth, "income");
  const tmExpense = _sum(thisMonth, "expense");
  const lmExpense = _sum(lastMonth, "expense");
  const curCats = _catTotals(thisMonth);
  const prevCats = _catTotals(lastMonth);
  const avgDaily = _avgDailyExpense(thisMonth);
  const projected = _projectedMonthlySpend(thisMonth);
  const limit = (typeof userData !== "undefined" && userData?.spendingLimit) || 0;

  // 1. Savings rate insight
  if (tmIncome > 0) {
    const rate = ((tmIncome - tmExpense) / tmIncome * 100).toFixed(0);
    if (tmExpense > tmIncome) {
      insights.push({ icon: "⚠️", text: `You're spending more than you earn this month — ₹${Math.round(tmExpense - tmIncome)} over budget.`, type: "danger" });
    } else {
      insights.push({ icon: "💰", text: `You're saving ${rate}% of your income this month (₹${Math.round(tmIncome - tmExpense)}).`, type: "positive" });
    }
  }

  // 2. Month-over-month comparison
  if (lmExpense > 0 && tmExpense > 0) {
    const pct = Math.round(((tmExpense - lmExpense) / lmExpense) * 100);
    if (Math.abs(pct) >= 5) {
      insights.push({
        icon: pct > 0 ? "📈" : "📉",
        text: `Spending is ${pct > 0 ? pct + "% higher" : Math.abs(pct) + "% lower"} than last month.`,
        type: pct > 0 ? "warn" : "positive"
      });
    }
  }

  // 3. Fastest growing category
  const fastest = _fastestGrowingCat();
  if (fastest && fastest.pct >= 15) {
    insights.push({ icon: "🔥", text: `${fastest.category} spending grew ${fastest.pct}% vs last month.`, type: "warn" });
  }

  // 4. Top spending category
  const topCat = Object.entries(curCats).sort((a,b) => b[1]-a[1])[0];
  if (topCat) {
    insights.push({ icon: "🏆", text: `${topCat[0]} is your biggest spend this month at ₹${Math.round(topCat[1])}.`, type: "info" });
  }

  // 5. Average daily spend
  if (avgDaily > 0) {
    insights.push({ icon: "📅", text: `Your average daily spend is ₹${Math.round(avgDaily)} this month.`, type: "info" });
  }

  // 6. Projected monthly spend vs limit
  if (projected > 0) {
    if (limit > 0 && projected > limit) {
      const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
      insights.push({ icon: "🚨", text: `At this pace, you'll spend ₹${projected.toLocaleString("en-IN")} — ₹${(projected-limit).toLocaleString("en-IN")} over your ₹${limit.toLocaleString("en-IN")} budget.`, type: "danger" });
    } else {
      insights.push({ icon: "🔮", text: `Projected month-end spend: ₹${projected.toLocaleString("en-IN")}.`, type: "info" });
    }
  }

  // 7. Weekend vs weekday spending
  const dowMap = _dowTotals(thisMonth);
  const weekdayTotal = [1,2,3,4,5].reduce((s, d) => s + (dowMap[d] || 0), 0);
  const weekendTotal = [0,6].reduce((s, d) => s + (dowMap[d] || 0), 0);
  const txnCount = thisMonth.filter(t => t.type === "expense").length;
  if (txnCount > 5 && weekendTotal > weekdayTotal * 0.6) {
    insights.push({ icon: "🎉", text: "Weekend spending is significantly higher than weekdays — leisure patterns detected.", type: "warn" });
  }

  // 8. Highest spending day of week
  const maxDow = Object.entries(dowMap).sort((a,b) => b[1]-a[1])[0];
  if (maxDow && maxDow[1] > 0) {
    const dayNames = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    insights.push({ icon: "📆", text: `${dayNames[maxDow[0]]} is your highest spending day this month.`, type: "info" });
  }

  return insights.slice(0, 6);
}

/**
 * Generate budget recommendations locally (instant, no API).
 */
function generateBudgetRecs() {
  const thisMonth = _thisMonthTxns();
  const lastMonth = _lastMonthTxns();
  const curCats = _catTotals(thisMonth);
  const prevCats = _catTotals(lastMonth);
  const tmIncome = _sum(thisMonth, "income");
  const recs = [];

  // Category-specific overspend recs
  const SUGGESTED_RATIOS = {
    "Food": 0.20, "Entertainment": 0.10, "Shopping": 0.15,
    "Transport": 0.10, "Health": 0.10
  };
  Object.entries(SUGGESTED_RATIOS).forEach(([cat, ratio]) => {
    if (curCats[cat] && tmIncome > 0) {
      const actual = curCats[cat] / tmIncome;
      if (actual > ratio * 1.3) {
        recs.push({
          icon: "✂️",
          title: `Trim ${cat} by ${Math.round((actual - ratio) * 100)}%`,
          body: `You're spending ${Math.round(actual*100)}% of income on ${cat}. Reducing to ~${Math.round(ratio*100)}% could save ₹${Math.round((actual-ratio)*tmIncome).toLocaleString("en-IN")}/month.`
        });
      }
    }
  });

  // Fastest growing category
  const fastest = _fastestGrowingCat();
  if (fastest && fastest.pct >= 20) {
    recs.push({
      icon: "📉",
      title: `Watch ${fastest.category} growth`,
      body: `${fastest.category} spending rose ${fastest.pct}% this month. Review recent transactions to spot patterns.`
    });
  }

  // Savings recommendation
  if (tmIncome > 0) {
    const tmExpense = _sum(thisMonth, "expense");
    const savingsRate = (tmIncome - tmExpense) / tmIncome;
    if (savingsRate < 0.2) {
      const targetSave = Math.round(tmIncome * 0.2);
      recs.push({
        icon: "🎯",
        title: "Boost savings to 20%",
        body: `Try to save ₹${targetSave.toLocaleString("en-IN")}/month (20% of income) by reducing discretionary spending.`
      });
    }
  }

  // Default if no recs
  if (!recs.length) {
    recs.push({ icon: "🌟", title: "Great financial discipline!", body: "Your spending patterns look healthy. Keep maintaining this balance." });
  }

  return recs.slice(0, 4);
}

/* ══════════════════════════════════════════════════════════════
   AI ASSISTANT PAGE — UI
   ══════════════════════════════════════════════════════════════ */

let _aiaPageOpen = false;
let _aiaChatHistory = [];
let _aiaChatBusy = false;
let _aiaVoiceActive = false;
let _aiaInsightsLoaded = false;
let _aiaScoreLoaded = false;

/**
 * Open (or bring to front) the AI Assistant full-page overlay.
 */
function openAIAssistant() {
  let page = document.getElementById("aiaPage");
  if (!page) {
    _buildAIAssistantPage();
    page = document.getElementById("aiaPage");
  }
  page.style.display = "flex";
  document.body.style.overflow = "hidden";
  _aiaPageOpen = true;

  // Render score + insights if not yet loaded
  if (!_aiaScoreLoaded) { _renderHealthScore(); _aiaScoreLoaded = true; }
  if (!_aiaInsightsLoaded) { _renderInsightCards(); _renderBudgetRecs(); _aiaInsightsLoaded = false; } // always refresh

  requestAnimationFrame(() => {
    _renderHealthScore();
    _renderInsightCards();
    _renderBudgetRecs();
    _renderPredictionBanner();
  });
}

/**
 * Close the AI Assistant page.
 */
function closeAIAssistant() {
  const page = document.getElementById("aiaPage");
  if (page) page.style.display = "none";
  document.body.style.overflow = "";
  _aiaPageOpen = false;
}

/**
 * Build the entire AI assistant HTML into the DOM.
 */
function _buildAIAssistantPage() {
  const el = document.createElement("div");
  el.id = "aiaPage";
  el.className = "aia-page";
  el.style.display = "none";

  el.innerHTML = `
  <div class="aia-layout">
    <!-- HEADER -->
    <header class="aia-header">
      <div class="aia-header-left">
        <div class="aia-header-icon"><i class="fas fa-brain"></i></div>
        <div>
          <div class="aia-header-title">AI Financial Assistant</div>
          <div class="aia-header-sub">Powered by real transaction data</div>
        </div>
      </div>
      <button class="aia-close" onclick="closeAIAssistant()" title="Close">
        <i class="fas fa-times"></i>
      </button>
    </header>

    <!-- BODY: two-column on desktop, stacked on mobile -->
    <div class="aia-body">

      <!-- LEFT PANEL: score + insights + recommendations -->
      <div class="aia-left">

        <!-- Health Score -->
        <div class="aia-card aia-score-card" id="aiaScoreCard">
          <div class="aia-card-loading"><i class="fas fa-spinner fa-spin"></i> Computing score…</div>
        </div>

        <!-- Prediction Banner -->
        <div class="aia-card aia-prediction-banner" id="aiaPredBanner">
          <div class="aia-card-loading"><i class="fas fa-spinner fa-spin"></i> Loading prediction…</div>
        </div>

        <!-- Insight Cards -->
        <div class="aia-section-title"><i class="fas fa-lightbulb" style="color:#fbbf24"></i> Smart Insights</div>
        <div class="aia-insights-grid" id="aiaInsightsGrid">
          <div class="aia-card-loading"><i class="fas fa-spinner fa-spin"></i> Analysing…</div>
        </div>

        <!-- Budget Recommendations -->
        <div class="aia-section-title" style="margin-top:1.25rem"><i class="fas fa-piggy-bank" style="color:#34d399"></i> Budget Recommendations</div>
        <div class="aia-recs-list" id="aiaRecsList">
          <div class="aia-card-loading"><i class="fas fa-spinner fa-spin"></i> Generating…</div>
        </div>

        <!-- AI Deep Analysis Button -->
        <button class="aia-deep-btn" id="aiaDeepBtn" onclick="_aiaRunDeepInsights()">
          <i class="fas fa-wand-magic-sparkles"></i> Run AI Deep Analysis
        </button>
        <div id="aiaDeepPanel" class="aia-deep-panel" style="display:none"></div>

      </div>

      <!-- RIGHT PANEL: Chat -->
      <div class="aia-right">
        <div class="aia-chat-header">
          <div class="aia-chat-title"><i class="fas fa-comment-dots" style="color:#818cf8;margin-right:.4rem"></i>Chat with BlueLedger AI</div>
          <button class="aia-chat-clear" onclick="_aiaClearChat()" title="Clear chat"><i class="fas fa-trash-alt"></i></button>
        </div>

        <div class="aia-chat-messages" id="aiaChatMessages">
          <div class="aia-chat-welcome">
            <div class="aia-chat-welcome-icon"><i class="fas fa-robot"></i></div>
            <div class="aia-chat-welcome-text">Hi! I'm your BlueLedger AI. Ask me anything about your finances.</div>
            <div class="aia-chat-chips">
              <button class="aia-chip" onclick="_aiaQuickAsk('Where did I spend most this month?')">Top spending this month</button>
              <button class="aia-chip" onclick="_aiaQuickAsk('Am I saving enough?')">Am I saving enough?</button>
              <button class="aia-chip" onclick="_aiaQuickAsk('Which category is growing fastest?')">Fastest growing</button>
              <button class="aia-chip" onclick="_aiaQuickAsk('How can I reduce my expenses?')">Reduce expenses</button>
              <button class="aia-chip" onclick="_aiaQuickAsk('Show my biggest transaction this month')">Biggest transaction</button>
              <button class="aia-chip" onclick="_aiaQuickAsk('Predict my spending for rest of month')">Spending prediction</button>
            </div>
          </div>
        </div>

        <div class="aia-chat-input-row">
          <button class="aia-voice-btn" id="aiaVoiceBtn" onclick="_aiaToggleVoice()" title="Voice input">
            <i class="fas fa-microphone" id="aiaVoiceIcon"></i>
          </button>
          <input
            type="text"
            class="aia-chat-input"
            id="aiaChatInput"
            placeholder="Ask about your finances…"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();_aiaSendChat();}"
          />
          <button class="aia-send-btn" id="aiaSendBtn" onclick="_aiaSendChat()">
            <i class="fas fa-paper-plane"></i>
          </button>
        </div>
      </div>

    </div>
  </div>`;

  document.body.appendChild(el);
}

/* ── Health Score Renderer ─────────────────────────────────── */

function _renderHealthScore() {
  const card = document.getElementById("aiaScoreCard");
  if (!card) return;

  const { score, grade, factors } = computeHealthScore();
  const txns = _getTxns();

  if (!txns.length) {
    card.innerHTML = `<div class="aia-score-empty"><i class="fas fa-chart-pie"></i><span>Add transactions to see your score</span></div>`;
    return;
  }

  const color = score >= 85 ? "#10b981" : score >= 70 ? "#34d399" : score >= 55 ? "#fbbf24" : score >= 40 ? "#f97316" : "#ef4444";
  const circumference = 2 * Math.PI * 42;
  const dashOffset = circumference - (score / 100) * circumference;

  const factorsHtml = factors.map(f => `
    <div class="aia-score-factor aia-score-factor--${f.type}">
      <i class="fas fa-${f.type === "positive" ? "check-circle" : f.type === "negative" ? "times-circle" : "minus-circle"}"></i>
      <span>${safeText(f.text)}</span>
    </div>`).join("");

  card.innerHTML = `
    <div class="aia-score-layout">
      <div class="aia-score-ring-wrap">
        <svg class="aia-score-ring" viewBox="0 0 100 100" width="110" height="110">
          <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
          <circle cx="50" cy="50" r="42" fill="none" stroke="${color}" stroke-width="8"
            stroke-linecap="round"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${dashOffset}"
            transform="rotate(-90 50 50)"
            style="transition:stroke-dashoffset 1s ease"/>
        </svg>
        <div class="aia-score-center">
          <div class="aia-score-number" style="color:${color}">${score}</div>
          <div class="aia-score-label">/100</div>
        </div>
      </div>
      <div class="aia-score-details">
        <div class="aia-score-grade" style="color:${color}">${grade}</div>
        <div class="aia-score-subtitle">Financial Health Score</div>
        <div class="aia-score-factors">${factorsHtml}</div>
      </div>
    </div>`;
}

/* ── Prediction Banner ─────────────────────────────────────── */

function _renderPredictionBanner() {
  const banner = document.getElementById("aiaPredBanner");
  if (!banner) return;

  const thisMonth = _thisMonthTxns();
  const projected = _projectedMonthlySpend(thisMonth);
  const tmExpense = _sum(thisMonth, "expense");
  const limit = (typeof userData !== "undefined" && userData?.spendingLimit) || 0;
  const now = new Date();
  const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
  const avgDaily = Math.round(_avgDailyExpense(thisMonth));

  if (!thisMonth.length) {
    banner.innerHTML = `<div class="aia-pred-empty">No transactions this month yet</div>`;
    return;
  }

  const overLimit = limit > 0 && projected > limit;
  const color = overLimit ? "#ef4444" : projected > tmExpense * 1.5 ? "#f59e0b" : "#10b981";

  banner.innerHTML = `
    <div class="aia-pred-row">
      <div class="aia-pred-icon" style="color:${color}"><i class="fas fa-chart-line"></i></div>
      <div class="aia-pred-body">
        <div class="aia-pred-label">Month-end Projection</div>
        <div class="aia-pred-amount" style="color:${color}">₹${projected.toLocaleString("en-IN")}</div>
        <div class="aia-pred-meta">${daysLeft} days left · ₹${avgDaily}/day avg · ${overLimit ? `<span style="color:#ef4444">₹${(projected-limit).toLocaleString("en-IN")} over budget</span>` : `₹${tmExpense.toLocaleString("en-IN")} spent so far`}</div>
      </div>
    </div>`;
}

/* ── Insight Cards Renderer ────────────────────────────────── */

function _renderInsightCards() {
  const grid = document.getElementById("aiaInsightsGrid");
  if (!grid) return;

  const insights = generateLocalInsights();
  const typeColors = { positive: "#10b981", warn: "#f59e0b", danger: "#ef4444", info: "#818cf8" };

  grid.innerHTML = insights.map(ins => `
    <div class="aia-insight-card aia-insight--${ins.type || "info"}">
      <div class="aia-insight-icon">${ins.icon}</div>
      <div class="aia-insight-text">${safeText(ins.text)}</div>
    </div>`).join("");
}

/* ── Budget Recs Renderer ──────────────────────────────────── */

function _renderBudgetRecs() {
  const list = document.getElementById("aiaRecsList");
  if (!list) return;

  const recs = generateBudgetRecs();
  list.innerHTML = recs.map(r => `
    <div class="aia-rec-item">
      <div class="aia-rec-icon">${r.icon}</div>
      <div>
        <div class="aia-rec-title">${safeText(r.title)}</div>
        <div class="aia-rec-body">${safeText(r.body)}</div>
      </div>
    </div>`).join("");
}

/* ── Deep AI Analysis ──────────────────────────────────────── */

/**
 * Wrap a promise with a timeout. Rejects with "timeout" after ms milliseconds.
 */
function _withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    )
  ]);
}

/**
 * Build a deep analysis result entirely from local data — instant, no API.
 * Used as the fallback when the AI API is slow or unavailable.
 */
function _buildLocalDeepResult() {
  const thisMonth   = _thisMonthTxns();
  const lastMonth   = _lastMonthTxns();
  const txns        = _getTxns();
  const tmIncome    = _sum(thisMonth, "income");
  const tmExpense   = _sum(thisMonth, "expense");
  const lmExpense   = _sum(lastMonth, "expense");
  const projected   = _projectedMonthlySpend(thisMonth);
  const avgDaily    = Math.round(_avgDailyExpense(thisMonth));
  const curCats     = _catTotals(thisMonth);
  const momTrend    = lmExpense > 0 ? Math.round(((tmExpense - lmExpense) / lmExpense) * 100) : 0;
  const savingsRate = tmIncome > 0 ? Math.round(((tmIncome - tmExpense) / tmIncome) * 100) : 0;
  const topCat      = Object.entries(curCats).sort((a,b) => b[1]-a[1])[0];
  const fastest     = _fastestGrowingCat();
  const limit       = (typeof userData !== "undefined" && userData?.spendingLimit) || 0;
  const { score, grade } = computeHealthScore();

  // Headline
  const headline = tmExpense > tmIncome
    ? "⚠️ Spending Exceeds Income — Action Needed"
    : momTrend > 20
    ? `📈 Spending Up ${momTrend}% — Review Your Categories`
    : savingsRate >= 20
    ? `✅ Healthy Finances — ${savingsRate}% Savings Rate`
    : `📊 Financial Health: ${grade} (${score}/100)`;

  // Overall assessment
  const assessment = [
    tmIncome > 0
      ? `You've earned ₹${Math.round(tmIncome).toLocaleString("en-IN")} and spent ₹${Math.round(tmExpense).toLocaleString("en-IN")} this month, saving ${savingsRate}% of your income.`
      : `You've spent ₹${Math.round(tmExpense).toLocaleString("en-IN")} this month with no income recorded.`,
    momTrend !== 0
      ? `Expenses are ${Math.abs(momTrend)}% ${momTrend > 0 ? "higher" : "lower"} than last month.`
      : "Spending is steady compared to last month.",
    `At ₹${avgDaily}/day, you're projected to spend ₹${projected.toLocaleString("en-IN")} by month-end.`
  ].join(" ");

  // Top insights from local engine
  const localInsights = generateLocalInsights();
  const topInsights = localInsights.slice(0, 4).map(i => ({
    title: i.text.split(".")[0] + ".",
    body:  i.text,
    severity: i.type === "danger" ? "high" : i.type === "warn" ? "medium" : "low"
  }));

  // Predictions
  const predictions = [];
  predictions.push({
    label: "Month-end Spend",
    value: `₹${projected.toLocaleString("en-IN")}`,
    reasoning: `Based on ₹${avgDaily}/day average over ${new Date().getDate()} days`
  });
  if (fastest) {
    const projCat = Math.round((curCats[fastest.category] || 0) * (1 + fastest.pct / 100));
    predictions.push({
      label: `${fastest.category} Next Month`,
      value: `₹${projCat.toLocaleString("en-IN")}`,
      reasoning: `Up ${fastest.pct}% this month — trend may continue`
    });
  }
  if (limit > 0) {
    const daysLeft = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate() - new Date().getDate();
    const budgetRemaining = limit - tmExpense;
    predictions.push({
      label: "Budget Remaining",
      value: budgetRemaining > 0 ? `₹${Math.round(budgetRemaining).toLocaleString("en-IN")}` : "Over budget",
      reasoning: `${daysLeft} days left, ₹${Math.round(budgetRemaining / Math.max(daysLeft, 1)).toLocaleString("en-IN")}/day headroom`
    });
  }

  // Action plan from budget recs
  const recs = generateBudgetRecs();
  const actionPlan = recs.slice(0, 3).map(r => ({
    step:   r.title,
    impact: r.body
  }));
  if (actionPlan.length === 0) {
    actionPlan.push({ step: "Keep tracking consistently", impact: "Consistent records unlock better predictions and insights over time." });
  }

  return { headline, overallAssessment: assessment, topInsights, predictions, actionPlan };
}

async function _aiaRunDeepInsights() {
  const btn   = document.getElementById("aiaDeepBtn");
  const panel = document.getElementById("aiaDeepPanel");
  if (!panel || !btn) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analysing…';
  panel.style.display = "block";
  panel.innerHTML = `<div class="aia-deep-loading"><i class="fas fa-brain" style="color:#a78bfa"></i><span>Running financial analysis…</span></div>`;

  let parsed = null;

  // ── Attempt AI API with a hard 20-second timeout ──────────────
  try {
    const system = `You are BlueLedger AI, a personal finance advisor for an Indian user.
Return ONLY valid JSON (no markdown, no explanation) in this exact shape:
{"headline":"string","overallAssessment":"string","topInsights":[{"title":"string","body":"string","severity":"low|medium|high"}],"predictions":[{"label":"string","value":"string","reasoning":"string"}],"actionPlan":[{"step":"string","impact":"string"}]}
Rules: topInsights=3 items, predictions=2 items, actionPlan=3 items. Use ₹ for amounts. Indian finance context.`;

    const context = _buildFullFinanceContext();
    const raw = await _withTimeout(
      _callAI([{ role: "user", content: context }], system, 600),
      20000   // 20 s — well under Vercel's 30 s kill
    );
    parsed = extractJsonFromText(raw);
  } catch (e) {
    // 504, timeout, or parse failure — fall through to local
    console.info("AIA: AI API unavailable, using local analysis.", e.message);
  }

  // ── Always fall back to local engine if API failed / returned garbage ──
  if (!parsed || !parsed.headline) {
    parsed = _buildLocalDeepResult();
    // Flag to user that this is local analysis
    parsed._isLocal = true;
  }

  // ── Render the result ─────────────────────────────────────────
  const insightsHtml = (parsed.topInsights || []).map(i => `
    <div class="aia-deep-insight aia-deep-severity--${i.severity || "low"}">
      <div class="aia-deep-insight-title">${safeText(i.title)}</div>
      <div class="aia-deep-insight-body">${safeText(i.body)}</div>
    </div>`).join("");

  const predsHtml = (parsed.predictions || []).map(p => `
    <div class="aia-deep-pred">
      <div class="aia-deep-pred-label">${safeText(p.label)}</div>
      <div class="aia-deep-pred-value">${safeText(p.value)}</div>
      <div class="aia-deep-pred-reason">${safeText(p.reasoning)}</div>
    </div>`).join("");

  const stepsHtml = (parsed.actionPlan || []).map((s, idx) => `
    <div class="aia-deep-step">
      <div class="aia-deep-step-num">${idx + 1}</div>
      <div>
        <div class="aia-deep-step-title">${safeText(s.step)}</div>
        <div class="aia-deep-step-impact">${safeText(s.impact)}</div>
      </div>
    </div>`).join("");

  const sourceNote = parsed._isLocal
    ? `<div class="aia-deep-source-note"><i class="fas fa-bolt" style="color:#fbbf24"></i> Instant local analysis — based on your real transaction data</div>`
    : `<div class="aia-deep-source-note"><i class="fas fa-robot" style="color:#818cf8"></i> AI-generated analysis</div>`;

  panel.innerHTML = `
    <div class="aia-deep-result">
      ${sourceNote}
      <div class="aia-deep-headline">${safeText(parsed.headline || "")}</div>
      <div class="aia-deep-assessment">${safeText(parsed.overallAssessment || "")}</div>

      <div class="aia-deep-section-title"><i class="fas fa-lightbulb" style="color:#fbbf24"></i> Key Insights</div>
      <div class="aia-deep-insights-list">${insightsHtml}</div>

      <div class="aia-deep-section-title" style="margin-top:1rem"><i class="fas fa-chart-line" style="color:#818cf8"></i> Predictions</div>
      <div class="aia-deep-preds-grid">${predsHtml}</div>

      <div class="aia-deep-section-title" style="margin-top:1rem"><i class="fas fa-list-check" style="color:#34d399"></i> Action Plan</div>
      <div class="aia-deep-steps">${stepsHtml}</div>

      <button class="aia-deep-dismiss" onclick="document.getElementById('aiaDeepPanel').style.display='none'">
        <i class="fas fa-times"></i> Dismiss
      </button>
    </div>`;

  btn.disabled = false;
  btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Run AI Deep Analysis';
}

/* ══════════════════════════════════════════════════════════════
   CONVERSATIONAL CHAT
   ══════════════════════════════════════════════════════════════ */

function _aiaQuickAsk(question) {
  const input = document.getElementById("aiaChatInput");
  if (input) input.value = question;
  _aiaSendChat();
}

function _aiaClearChat() {
  _aiaChatHistory = [];
  const msgs = document.getElementById("aiaChatMessages");
  if (!msgs) return;
  msgs.innerHTML = `
    <div class="aia-chat-welcome">
      <div class="aia-chat-welcome-icon"><i class="fas fa-robot"></i></div>
      <div class="aia-chat-welcome-text">Chat cleared. What would you like to know?</div>
      <div class="aia-chat-chips">
        <button class="aia-chip" onclick="_aiaQuickAsk('Where did I spend most this month?')">Top spending</button>
        <button class="aia-chip" onclick="_aiaQuickAsk('Am I saving enough?')">Savings check</button>
        <button class="aia-chip" onclick="_aiaQuickAsk('How can I reduce my expenses?')">Reduce expenses</button>
      </div>
    </div>`;
}

async function _aiaSendChat() {
  if (_aiaChatBusy) return;
  const inputEl = document.getElementById("aiaChatInput");
  const question = ((inputEl ? inputEl.value : "") || "").trim();
  if (!question) return;
  if (inputEl) inputEl.value = "";

  // Hide welcome if visible
  const welcome = document.querySelector("#aiaChatMessages .aia-chat-welcome");
  if (welcome) welcome.style.display = "none";

  _appendChatMsg("user", safeText(question));
  _aiaChatHistory.push({ role: "user", content: question });

  const typingId = "aia-typing-" + Date.now();
  _appendChatMsg("assistant", `<span id="${typingId}" class="aia-typing"><span></span><span></span><span></span></span>`);

  _aiaChatBusy = true;
  const sendBtn = document.getElementById("aiaSendBtn");
  if (sendBtn) sendBtn.disabled = true;

  try {
    const system = `You are BlueLedger AI, a concise personal finance assistant for an Indian user.
Answer using ONLY the data provided. Be specific with ₹ amounts. Max 120 words. Never invent data.

${_buildFullFinanceContext()}`;

    const reply = await _callAI(_aiaChatHistory, system, 400);

    document.getElementById(typingId)?.closest(".aia-chat-msg")?.remove();
    _aiaChatHistory.push({ role: "assistant", content: reply });
    if (_aiaChatHistory.length > 20) _aiaChatHistory = _aiaChatHistory.slice(-20);
    _appendChatMsg("assistant", markdownToHtml(reply));
  } catch (e) {
    document.getElementById(typingId)?.closest(".aia-chat-msg")?.remove();
    _appendChatMsg("assistant", "Sorry, I couldn't connect right now. Please check your connection and try again.");
    console.warn("AIA chat failed:", e);
  } finally {
    _aiaChatBusy = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

function _appendChatMsg(role, html) {
  const container = document.getElementById("aiaChatMessages");
  if (!container) return;

  const ts = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const div = document.createElement("div");
  div.className = `aia-chat-msg aia-chat-msg--${role}`;
  div.innerHTML = role === "assistant"
    ? `<div class="aia-chat-avatar"><i class="fas fa-robot"></i></div>
       <div class="aia-chat-bubble-wrap">
         <div class="aia-chat-bubble">${html}</div>
         <div class="aia-chat-ts">${ts}</div>
       </div>`
    : `<div class="aia-chat-bubble-wrap">
         <div class="aia-chat-bubble">${html}</div>
         <div class="aia-chat-ts" style="text-align:right">${ts}</div>
       </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

/* ══════════════════════════════════════════════════════════════
   VOICE INPUT FOR CHAT
   ══════════════════════════════════════════════════════════════ */

let _aiaRecognition = null;

function _aiaToggleVoice() {
  const btn = document.getElementById("aiaVoiceBtn");
  const icon = document.getElementById("aiaVoiceIcon");
  const input = document.getElementById("aiaChatInput");

  if (_aiaVoiceActive) {
    // Stop
    if (_aiaRecognition) _aiaRecognition.stop();
    _aiaVoiceActive = false;
    if (btn) btn.classList.remove("aia-voice-btn--active");
    if (icon) { icon.className = "fas fa-microphone"; }
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    if (typeof toast === "function") toast("Voice not supported in this browser", "warn");
    return;
  }

  _aiaRecognition = new SpeechRecognition();
  _aiaRecognition.lang = "en-IN";
  _aiaRecognition.interimResults = false;
  _aiaRecognition.maxAlternatives = 1;

  _aiaRecognition.onstart = () => {
    _aiaVoiceActive = true;
    if (btn) btn.classList.add("aia-voice-btn--active");
    if (icon) icon.className = "fas fa-circle-dot";
  };

  _aiaRecognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    if (input) input.value = transcript;
    _aiaVoiceActive = false;
    if (btn) btn.classList.remove("aia-voice-btn--active");
    if (icon) icon.className = "fas fa-microphone";
    setTimeout(() => _aiaSendChat(), 200);
  };

  _aiaRecognition.onerror = () => {
    _aiaVoiceActive = false;
    if (btn) btn.classList.remove("aia-voice-btn--active");
    if (icon) icon.className = "fas fa-microphone";
  };

  _aiaRecognition.onend = () => {
    _aiaVoiceActive = false;
    if (btn) btn.classList.remove("aia-voice-btn--active");
    if (icon) icon.className = "fas fa-microphone";
  };

  _aiaRecognition.start();
}

/* ══════════════════════════════════════════════════════════════
   REFRESH HOOK — call after transactions update
   ══════════════════════════════════════════════════════════════ */

function aiaRefresh() {
  if (!_aiaPageOpen) return;
  _renderHealthScore();
  _renderInsightCards();
  _renderBudgetRecs();
  _renderPredictionBanner();
}

/* ── Expose to global scope ──────────────────────────────────── */
window.openAIAssistant = openAIAssistant;
window.closeAIAssistant = closeAIAssistant;
window.computeHealthScore = computeHealthScore;
window.generateLocalInsights = generateLocalInsights;
window.generateBudgetRecs = generateBudgetRecs;
window.aiaRefresh = aiaRefresh;
window._aiaSendChat = _aiaSendChat;
window._aiaQuickAsk = _aiaQuickAsk;
window._aiaClearChat = _aiaClearChat;
window._aiaToggleVoice = _aiaToggleVoice;
window._aiaRunDeepInsights = _aiaRunDeepInsights;
