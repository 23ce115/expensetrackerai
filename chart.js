/* ═══════════════════════════════════════════════════════════════
   charts.js — BlueLedger Chart System (Chart.js powered)
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
const GRID_COLOR = "rgba(148,163,184,0.08)";
const TICK_COLOR = "#64748b";

/* ═══════════════════════════════════════════════════════════════
   OVERVIEW CHART
   ═══════════════════════════════════════════════════════════════ */

function initOverviewChart() {
  const container = document.getElementById("chartContainer");
  if (!container) return;

  /* Replace static container with canvas + controls */
  container.innerHTML = "";
  container.style.position = "relative";
  container.style.padding = "0";

  /* Period toggle buttons — glassmorphism style */
  const controls = document.createElement("div");
  controls.className = "chart-period-controls";
  controls.innerHTML = `
    <button class="cpc-btn ${_currentOverviewPeriod === "daily" ? "cpc-btn--active" : ""}" onclick="setChartPeriod('daily')">Daily</button>
    <button class="cpc-btn ${_currentOverviewPeriod === "weekly" ? "cpc-btn--active" : ""}" onclick="setChartPeriod('weekly')">Weekly</button>
    <button class="cpc-btn ${_currentOverviewPeriod === "monthly" ? "cpc-btn--active" : ""}" onclick="setChartPeriod('monthly')">Monthly</button>
  `;
  container.parentElement.querySelector(".card-header").appendChild(controls);

  /* Canvas */
  const canvas = document.createElement("canvas");
  canvas.id = "overviewCanvas";
  canvas.style.width = "100%";
  canvas.style.maxHeight = "220px";
  container.appendChild(canvas);

  /* Hide old labels div */
  const labelsDiv = document.getElementById("chartLabels");
  if (labelsDiv) labelsDiv.style.display = "none";

  /* Hide old legend (we keep the HTML one) */
  _buildOverviewChart(canvas);
}

function _buildOverviewChart(canvas) {
  const ctx = canvas.getContext("2d");
  const data = getChartData(_currentOverviewPeriod);
  const labels = data.map((d) => d.label);
  const incomes = data.map((d) => d.income);
  const expenses = data.map((d) => d.expense);

  if (_overviewChart) {
    _overviewChart.destroy();
    _overviewChart = null;
  }

  const isDark =
    document.documentElement.getAttribute("data-theme") !== "light";
  const gridCol = isDark ? "rgba(148,163,184,0.08)" : "rgba(0,0,0,0.06)";
  const tickCol = isDark ? "#64748b" : "#94a3b8";

  _overviewChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: "Income",
          data: incomes,
          backgroundColor: incomes.map((_, i) =>
            data[i].active ? INCOME_COLOR : "rgba(16,185,129,0.45)",
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
            data[i].active ? EXPENSE_COLOR : "rgba(249,115,22,0.45)",
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
              const idx = items[0].dataIndex;
              return _tooltipTitle(_currentOverviewPeriod, data, idx);
            },
            label(item) {
              const val = item.raw;
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
  const now = new Date();
  if (period === "daily") {
    /* Rebuild actual date for this bar */
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
    /* label is "D Mon", reconstruct range */
    return `Week of ${data[idx].label}`;
  }
  /* monthly */
  return data[idx].fullLabel || data[idx].label;
}

function updateOverviewChart(period) {
  _currentOverviewPeriod = period || _currentOverviewPeriod;

  /* Update button active states */
  document.querySelectorAll(".cpc-btn").forEach((btn) => {
    btn.classList.toggle(
      "cpc-btn--active",
      btn.textContent.toLowerCase() === _currentOverviewPeriod,
    );
  });

  const canvas = document.getElementById("overviewCanvas");
  if (!canvas) {
    initOverviewChart();
    return;
  }

  const data = getChartData(_currentOverviewPeriod);
  if (!_overviewChart) {
    _buildOverviewChart(canvas);
    return;
  }

  const hasData = data.some((d) => d.income > 0 || d.expense > 0);
  const container = document.getElementById("chartContainer");

  /* Empty state */
  const emptyEl = container.querySelector(".chart-empty-chartjs");
  if (!hasData) {
    canvas.style.display = "none";
    if (!emptyEl) {
      const empty = document.createElement("div");
      empty.className = "chart-empty chart-empty-chartjs";
      empty.innerHTML = `<i class="fas fa-chart-bar"></i><p>Add transactions to see your overview</p>`;
      container.appendChild(empty);
    }
    return;
  }
  if (emptyEl) emptyEl.remove();
  canvas.style.display = "block";

  const labels = data.map((d) => d.label);
  const incomes = data.map((d) => d.income);
  const expenses = data.map((d) => d.expense);

  _overviewChart.data.labels = labels;
  _overviewChart.data.datasets[0].data = incomes;
  _overviewChart.data.datasets[0].backgroundColor = incomes.map((_, i) =>
    data[i].active ? INCOME_COLOR : "rgba(16,185,129,0.45)",
  );
  _overviewChart.data.datasets[1].data = expenses;
  _overviewChart.data.datasets[1].backgroundColor = expenses.map((_, i) =>
    data[i].active ? EXPENSE_COLOR : "rgba(249,115,22,0.45)",
  );
  _overviewChart.update("active");
}

/* ═══════════════════════════════════════════════════════════════
   CATEGORY DOUGHNUT CHART
   ═══════════════════════════════════════════════════════════════ */

function initCategoryChart() {
  const colorBar = document.querySelector(".color-bar");
  if (!colorBar) return;

  /* Replace the color-bar with a canvas */
  colorBar.outerHTML = `<div id="categoryChartWrap" style="position:relative;width:100%;height:8px;margin:.6rem 0 .4rem;"><canvas id="categoryCanvas" height="8"></canvas></div>`;
}

function updateCategoryChart(catsData) {
  /* catsData: array of { label, value, color } */
  const wrap = document.getElementById("categoryChartWrap");
  if (!wrap) return;

  /* Use a thin horizontal stacked bar (custom drawn) */
  let canvas = document.getElementById("categoryCanvas");
  if (!canvas) return;

  const total = catsData.reduce((s, c) => s + c.value, 0);
  if (total === 0) {
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    if (_categoryChart) {
      _categoryChart.destroy();
      _categoryChart = null;
    }
    /* Show a flat gradient bar */
    wrap.innerHTML = `<div class="color-bar" style="display:flex;gap:2px;height:8px;border-radius:4px;overflow:hidden;background:rgba(148,163,184,0.12)"></div>`;
    return;
  }

  /* Rebuild canvas if needed */
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
      datasets: catsData.map((c) => ({
        label: c.label,
        data: [c.value],
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
              `  ${item.dataset.label}: ₹${item.raw.toLocaleString("en-IN")}`,
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

/* ═══════════════════════════════════════════════════════════════
   PUBLIC API — called from script.js
   ═══════════════════════════════════════════════════════════════ */

/**
 * Called by script.js instead of renderChart()
 * Accepts same signature for backward-compat.
 */
function renderChartJS(period, sourceTxns) {
  updateOverviewChart(period);
}

/**
 * Called by script.js instead of renderAllExpenses() color-bar part
 */
function renderCategoryChartJS(sortedCats) {
  /* sortedCats: array of [categoryName, amount] */
  const data = sortedCats.map(([name, val]) => ({
    label: name,
    value: val,
    color: getCatColor(name),
  }));
  updateCategoryChart(data);
}
