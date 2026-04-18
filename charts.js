/* ═══════════════════════════════════════════════════════════════
   chart.js — BlueLedger Chart System (Chart.js powered)
   Handles: overview bar chart, category stacked bar chart.
   Depends on: utils.js (must load first), Chart.js global
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ── Internal state ─────────────────────────────────────────── */
let _overviewChart = null;
let _categoryChart = null;
let _currentOverviewPeriod = "monthly";

/* ── Theme tokens ────────────────────────────────────────────── */
const INCOME_COLOR = "#10b981";
const EXPENSE_COLOR = "#f97316";
const INCOME_FILL = "rgba(16,185,129,0.15)";
const EXPENSE_FILL = "rgba(249,115,22,0.15)";

/* ══════════════════════════════════════════════════════════════
   DATA HELPERS
   ══════════════════════════════════════════════════════════════ */

/**
 * Get color for a named category. Consistent hash-based for custom cats.
 * @param {string} cat
 * @returns {string} CSS color
 */
function getCatColor(cat) {
  const colors = window.CAT_COLORS || {};
  if (colors[cat]) return colors[cat];
  let hash = 0;
  for (let i = 0; i < (cat || "").length; i++) {
    hash = cat.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 65%, 55%)`;
}

/**
 * Get chart data for the given period.
 * Calls getAnalyticsTransactions() from main.js if available,
 * otherwise falls back to the global `transactions` array.
 * @param {"daily"|"weekly"|"monthly"} period
 * @returns {Array<{label:string, income:number, expense:number, active:boolean}>}
 */
function getChartData(period) {
  const sourceTxns =
    typeof getAnalyticsTransactions === "function"
      ? getAnalyticsTransactions()
      : typeof transactions !== "undefined"
        ? transactions
        : [];

  const now = new Date();
  const localDateStr = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const toDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const sumInc = (txns) =>
    txns
      .filter((t) => t.type === "income")
      .reduce((s, t) => s + (t.amount || 0), 0);
  const sumExp = (txns) =>
    txns
      .filter((t) => t.type === "expense")
      .reduce((s, t) => s + Math.abs(t.amount || 0), 0);

  if (period === "daily") {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - (6 - i),
      );
      const ds = localDateStr(d);
      const tx = sourceTxns.filter((t) => t.date === ds);
      return {
        label: d.toLocaleDateString("en-US", { weekday: "short" }),
        income: sumInc(tx),
        expense: sumExp(tx),
        active: i === 6,
      };
    });
  }

  if (period === "weekly") {
    const dow = now.getDay();
    const daysToMon = dow === 0 ? -6 : 1 - dow;
    const thisMonday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + daysToMon,
    );
    return Array.from({ length: 8 }, (_, i) => {
      const ws = new Date(
        thisMonday.getFullYear(),
        thisMonday.getMonth(),
        thisMonday.getDate() - (7 - i) * 7,
      );
      const we = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 6);
      const tx = sourceTxns.filter((t) => {
        const d = toDay(new Date(t.date + "T00:00:00"));
        return d >= ws && d <= we;
      });
      return {
        label:
          ws.getDate() + " " + ws.toLocaleString("en-IN", { month: "short" }),
        income: sumInc(tx),
        expense: sumExp(tx),
        active: i === 7,
      };
    });
  }

  // Monthly — last 6 months
  const monthLabels = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return Array.from({ length: 6 }, (_, i) => {
    const offset = 5 - i;
    const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const yr = d.getFullYear();
    const mi = d.getMonth();
    const tx = sourceTxns.filter((t) => {
      const td = new Date(t.date + "T00:00:00");
      return td.getFullYear() === yr && td.getMonth() === mi;
    });
    return {
      label: monthLabels[mi],
      fullLabel: `${monthLabels[mi]} ${yr}`,
      income: sumInc(tx),
      expense: sumExp(tx),
      active: offset === 0,
    };
  });
}

/* ══════════════════════════════════════════════════════════════
   OVERVIEW BAR CHART
   ══════════════════════════════════════════════════════════════ */

/**
 * First-time initialisation. Creates the canvas, period buttons,
 * and Chart.js instance inside #chartContainer.
 */
function initOverviewChart() {
  const container = safeGet("chartContainer");
  if (!container) return;

  // Destroy any previous instance
  if (_overviewChart) {
    _overviewChart.destroy();
    _overviewChart = null;
  }

  container.innerHTML = "";
  container.style.position = "relative";
  container.style.padding = "0";

  // Period toggle buttons
  const cardHeader = container.closest(".card")?.querySelector(".card-header");
  if (cardHeader) {
    const existing = cardHeader.querySelector(".chart-period-controls");
    if (existing) existing.remove();

    const controls = document.createElement("div");
    controls.className = "chart-period-controls";
    controls.innerHTML = `
      <button class="cpc-btn ${_currentOverviewPeriod === "daily" ? "cpc-btn--active" : ""}" onclick="setChartPeriod('daily')">Daily</button>
      <button class="cpc-btn ${_currentOverviewPeriod === "weekly" ? "cpc-btn--active" : ""}" onclick="setChartPeriod('weekly')">Weekly</button>
      <button class="cpc-btn ${_currentOverviewPeriod === "monthly" ? "cpc-btn--active" : ""}" onclick="setChartPeriod('monthly')">Monthly</button>
    `;
    cardHeader.appendChild(controls);
  }

  // Canvas
  const canvas = document.createElement("canvas");
  canvas.id = "overviewCanvas";
  canvas.style.width = "100%";
  canvas.style.maxHeight = "220px";
  container.appendChild(canvas);

  // Hide legacy labels div if present
  const labelsDiv = safeGet("chartLabels");
  if (labelsDiv) labelsDiv.style.display = "none";

  _buildOverviewChart(canvas);
}

function _buildOverviewChart(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const data = getChartData(_currentOverviewPeriod);

  if (!data || data.length === 0) {
    console.warn("BlueLedger Charts: No chart data available");
    return;
  }

  if (_overviewChart) {
    _overviewChart.destroy();
    _overviewChart = null;
  }

  const isDark =
    document.documentElement.getAttribute("data-theme") !== "light";
  const gridCol = isDark ? "rgba(148,163,184,0.08)" : "rgba(0,0,0,0.06)";
  const tickCol = isDark ? "#64748b" : "#94a3b8";

  const labels = data.map((d) => d.label || "");
  const incomes = data.map((d) => d.income || 0);
  const expenses = data.map((d) => d.expense || 0);

  _overviewChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Income",
          data: incomes,
          backgroundColor: incomes.map((_, i) =>
            data[i]?.active ? INCOME_COLOR : "rgba(16,185,129,0.45)",
          ),
          borderRadius: 6,
          borderSkipped: false,
          barPercentage: 0.55,
          categoryPercentage: 0.7,
        },
        {
          label: "Expense",
          data: expenses,
          backgroundColor: expenses.map((_, i) =>
            data[i]?.active ? EXPENSE_COLOR : "rgba(249,115,22,0.45)",
          ),
          borderRadius: 6,
          borderSkipped: false,
          barPercentage: 0.55,
          categoryPercentage: 0.7,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(15,23,42,0.92)",
          borderColor: "rgba(148,163,184,0.15)",
          borderWidth: 1,
          titleColor: "#e2e8f0",
          bodyColor: "#94a3b8",
          padding: 12,
          cornerRadius: 10,
          callbacks: {
            title(items) {
              if (!items || !items[0]) return "";
              const idx = items[0].dataIndex;
              return _tooltipTitle(_currentOverviewPeriod, data, idx);
            },
            label(item) {
              const val = item.raw || 0;
              const sym = item.datasetIndex === 0 ? "↑" : "↓";
              const col = item.datasetIndex === 0 ? "Income " : "Expense";
              return `  ${sym} ${col}: ₹${val.toLocaleString("en-IN")}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: tickCol, font: { size: 11 } },
          border: { display: false },
        },
        y: {
          grid: { color: gridCol, drawBorder: false },
          ticks: {
            color: tickCol,
            font: { size: 11 },
            callback: (v) =>
              v === 0
                ? "₹0"
                : v >= 1000
                  ? "₹" + (v / 1000).toFixed(0) + "k"
                  : "₹" + v,
          },
          border: { display: false },
        },
      },
    },
  });
}

function _tooltipTitle(period, data, idx) {
  if (!data || !data[idx]) return "";
  const now = new Date();

  if (period === "daily") {
    const d = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - (6 - idx),
    );
    return d.toLocaleDateString("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }

  if (period === "weekly") {
    return data[idx]?.label ? `Week of ${data[idx].label}` : "";
  }

  return data[idx]?.fullLabel || data[idx]?.label || "";
}

/**
 * Update chart for a given period (or re-use current if no argument).
 * Safe to call at any time — handles empty data state gracefully.
 * @param {string} [period]
 */
function updateOverviewChart(period) {
  _currentOverviewPeriod = period || _currentOverviewPeriod;

  // Update period button active states
  document.querySelectorAll(".cpc-btn").forEach((btn) => {
    btn.classList.toggle(
      "cpc-btn--active",
      btn.textContent.trim().toLowerCase() === _currentOverviewPeriod,
    );
  });

  const canvas = safeGet("overviewCanvas");
  const container = safeGet("chartContainer");

  // Chart not yet set up — initialise fully
  if (!canvas) {
    initOverviewChart();
    return;
  }

  if (!_overviewChart) {
    _buildOverviewChart(canvas);
    return;
  }

  const data = getChartData(_currentOverviewPeriod);
  const hasData =
    Array.isArray(data) &&
    data.some((d) => (d.income || 0) > 0 || (d.expense || 0) > 0);

  // Handle empty state
  if (!hasData) {
    canvas.style.display = "none";
    if (container && !container.querySelector(".chart-empty-chartjs")) {
      const empty = document.createElement("div");
      empty.className = "chart-empty chart-empty-chartjs";
      empty.innerHTML = `<i class="fas fa-chart-bar"></i><p>Add transactions to see your overview</p>`;
      container.appendChild(empty);
    }
    return;
  }

  // Remove empty state if it was shown
  container?.querySelector(".chart-empty-chartjs")?.remove();
  canvas.style.display = "block";

  // Update chart data in-place (no full rebuild — smooth animation)
  const labels = data.map((d) => d.label || "");
  const incomes = data.map((d) => d.income || 0);
  const expenses = data.map((d) => d.expense || 0);

  _overviewChart.data.labels = labels;
  _overviewChart.data.datasets[0].data = incomes;
  _overviewChart.data.datasets[0].backgroundColor = incomes.map((_, i) =>
    data[i]?.active ? INCOME_COLOR : "rgba(16,185,129,0.45)",
  );
  _overviewChart.data.datasets[1].data = expenses;
  _overviewChart.data.datasets[1].backgroundColor = expenses.map((_, i) =>
    data[i]?.active ? EXPENSE_COLOR : "rgba(249,115,22,0.45)",
  );

  _overviewChart.update();
}

/* ══════════════════════════════════════════════════════════════
   CATEGORY STACKED BAR (thin horizontal bar)
   ══════════════════════════════════════════════════════════════ */

/**
 * One-time setup: replaces the .color-bar element with a canvas wrapper.
 */
function initCategoryChart() {
  if (safeGet("categoryChartWrap")) return; // already initialised

  const colorBar = document.querySelector(".color-bar");
  if (!colorBar) return;

  colorBar.outerHTML = `<div id="categoryChartWrap" style="position:relative;width:100%;height:8px;margin:.6rem 0 .4rem;overflow:hidden;border-radius:4px;"><canvas id="categoryCanvas" height="8"></canvas></div>`;
}

/**
 * Update the horizontal stacked category bar.
 * @param {Array<{label:string, value:number, color:string}>} catsData
 */
function updateCategoryChart(catsData) {
  const wrap = safeGet("categoryChartWrap");
  if (!wrap) return;

  const total = (catsData || []).reduce((s, c) => s + (c.value || 0), 0);

  if (total === 0 || !catsData || catsData.length === 0) {
    if (_categoryChart) {
      _categoryChart.destroy();
      _categoryChart = null;
    }
    wrap.innerHTML = `<div class="color-bar" style="display:flex;gap:2px;height:8px;border-radius:4px;overflow:hidden;background:rgba(148,163,184,0.12)"></div>`;
    return;
  }

  // Rebuild canvas if the wrapper was replaced
  let canvas = safeGet("categoryCanvas");
  if (!canvas) {
    wrap.innerHTML = `<canvas id="categoryCanvas" height="8"></canvas>`;
    canvas = safeGet("categoryCanvas");
    if (!canvas) return;
  }

  if (_categoryChart) {
    _categoryChart.destroy();
    _categoryChart = null;
  }

  wrap.style.height = "8px";
  canvas.height = 8;

  _categoryChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: [""],
      datasets: (catsData || []).map((c) => ({
        label: c.label,
        data: [c.value || 0],
        backgroundColor: c.color,
        borderRadius: 0,
        borderSkipped: false,
      })),
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(15,23,42,0.92)",
          borderColor: "rgba(148,163,184,0.15)",
          borderWidth: 1,
          titleColor: "#e2e8f0",
          bodyColor: "#94a3b8",
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            title: () => "Category breakdown",
            label: (item) =>
              `  ${item.dataset.label || ""}: ₹${(item.raw || 0).toLocaleString("en-IN")}`,
          },
        },
      },
      scales: {
        x: { stacked: true, display: false },
        y: { stacked: true, display: false },
      },
      animation: { duration: 400, easing: "easeOutQuart" },
    },
  });
}

/* ══════════════════════════════════════════════════════════════
   PUBLIC API — called from main.js / script.js
   ══════════════════════════════════════════════════════════════ */

/**
 * Backward-compatible wrapper. Called by main.js setChartPeriod().
 * @param {string} period
 * @param {Array}  [sourceTxns] — ignored; data fetched internally
 */
function renderChartJS(period, sourceTxns) {
  updateOverviewChart(period);
}

/**
 * Render horizontal category bar from sorted category data.
 * @param {Array<[string, number]>} sortedCats — [categoryName, amount][]
 */
function renderCategoryChartJS(sortedCats) {
  const data = (sortedCats || []).map(([name, val]) => ({
    label: name,
    value: val || 0,
    color: getCatColor(name),
  }));
  updateCategoryChart(data);
}

/* ── Expose to global scope ──────────────────────────────────── */
window.getCatColor = getCatColor;
window.getChartData = getChartData;
window.initOverviewChart = initOverviewChart;
window.updateOverviewChart = updateOverviewChart;
window.initCategoryChart = initCategoryChart;
window.updateCategoryChart = updateCategoryChart;
window.renderChartJS = renderChartJS;
window.renderCategoryChartJS = renderCategoryChartJS;
