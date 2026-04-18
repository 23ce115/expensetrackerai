/* ═══════════════════════════════════════════════════════════════
   charts.js — BlueLedger Chart System (Chart.js powered)
   OWNS: _overviewChart, _categoryChart, _currentOverviewPeriod,
         all chart colours, getChartData(), initOverviewChart(),
         updateOverviewChart(), initCategoryChart(), updateCategoryChart(),
         renderChartJS(), renderCategoryChartJS(), setChartPeriod()
   Depends on: utils.js (must load first), Chart.js global
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ── Internal state ─────────────────────────────────────────────
   ONLY declared here. script.js and main.js must NOT re-declare
   _overviewChart, _categoryChart, or _currentOverviewPeriod.
   ────────────────────────────────────────────────────────────── */
let _overviewChart = null;
let _categoryChart = null;
let _currentOverviewPeriod = "monthly";

/* ── Theme tokens ────────────────────────────────────────────── */
const INCOME_COLOR = "#10b981";
const EXPENSE_COLOR = "#f97316";

/* ══════════════════════════════════════════════════════════════
   DATA HELPERS
   ══════════════════════════════════════════════════════════════ */

/**
 * Get color for a named category. Falls back to hash-based HSL.
 * Reads window.CAT_COLORS which is set by main.js.
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
 * Build chart data for the given period.
 * Reads from getAnalyticsTransactions() (provided by main.js / script.js)
 * or falls back to the global `transactions` array.
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

function initOverviewChart() {
  const container = safeGet("chartContainer");
  if (!container) return;

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

  const canvas = document.createElement("canvas");
  canvas.id = "overviewCanvas";
  canvas.style.width = "100%";
  canvas.style.maxHeight = "220px";
  container.appendChild(canvas);

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
              return _tooltipTitle(
                _currentOverviewPeriod,
                data,
                items[0].dataIndex,
              );
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
 * Public API — update the chart for a given period.
 * Safe to call at any time from any module.
 * @param {string} [period]
 */
function updateOverviewChart(period) {
  _currentOverviewPeriod = period || _currentOverviewPeriod;

  document.querySelectorAll(".cpc-btn").forEach((btn) => {
    btn.classList.toggle(
      "cpc-btn--active",
      btn.textContent.trim().toLowerCase() === _currentOverviewPeriod,
    );
  });

  const canvas = safeGet("overviewCanvas");
  const container = safeGet("chartContainer");

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

  container?.querySelector(".chart-empty-chartjs")?.remove();
  canvas.style.display = "block";

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
   CHART PERIOD SETTER
   Single source of truth — owned here because chart state lives here.
   script.js delegates to this function; it no longer manages chartPeriod.
   ══════════════════════════════════════════════════════════════ */

/**
 * Change the active chart period and redraw.
 * Called by the period-toggle buttons AND by script.js / main.js.
 * @param {string} period — "daily" | "weekly" | "monthly"
 */
function setChartPeriod(period) {
  _currentOverviewPeriod = period;
  updateOverviewChart(period);
}

/* ══════════════════════════════════════════════════════════════
   CATEGORY STACKED BAR
   ══════════════════════════════════════════════════════════════ */

function initCategoryChart() {
  if (safeGet("categoryChartWrap")) return;
  const colorBar = document.querySelector(".color-bar");
  if (!colorBar) return;
  colorBar.outerHTML = `<div id="categoryChartWrap" style="position:relative;width:100%;height:8px;margin:.6rem 0 .4rem;overflow:hidden;border-radius:4px;"><canvas id="categoryCanvas" height="8"></canvas></div>`;
}

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
   PUBLIC API — backward-compat wrappers
   ══════════════════════════════════════════════════════════════ */

function renderChartJS(period) {
  updateOverviewChart(period);
}

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
window.setChartPeriod = setChartPeriod; // ← owned here, exposed globally
