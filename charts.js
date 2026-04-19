/* ═══════════════════════════════════════════════════════════════
   charts.js — BlueLedger Chart Rendering (Chart.js)

   OWNS:
     _overviewChart, _categoryChart, _currentOverviewPeriod
     initOverviewChart(), updateOverviewChart()
     initCategoryChart(), updateCategoryChart()
     setChartPeriod()
     renderChartJS(), renderCategoryChartJS()

   READS from script.js (do NOT redeclare here):
     getCatColor(), getChartData(), chartPeriod

   Load order:  Chart.js CDN → utils.js → ai.js → voice.js →
                receipt.js → charts.js → script.js → main.js
   ═══════════════════════════════════════════════════════════════ */

"use strict";

/* ── Private chart state (single source of truth) ────────────── */
let _overviewChart = null;
let _categoryChart = null;
let _currentOverviewPeriod = "monthly";

const INCOME_COLOR = "#10b981";
const EXPENSE_COLOR = "#f97316";

/* ══════════════════════════════════════════════════════════════
   OVERVIEW CHART — init
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
  if (typeof getChartData !== "function") {
    console.warn("charts.js: getChartData() not ready");
    return;
  }

  const ctx = canvas.getContext("2d");
  const data = getChartData(_currentOverviewPeriod);
  if (!data || data.length === 0) return;

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
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Income",
          data: incomes,
          borderColor: INCOME_COLOR,
          backgroundColor: "rgba(16,185,129,0.08)",
          pointBackgroundColor: INCOME_COLOR,
          pointRadius: 4,
          pointHoverRadius: 6,
          borderWidth: 2.5,
          fill: true,
          tension: 0.4,
        },
        {
          label: "Expense",
          data: expenses,
          borderColor: EXPENSE_COLOR,
          backgroundColor: "rgba(249,115,22,0.08)",
          pointBackgroundColor: EXPENSE_COLOR,
          pointRadius: 4,
          pointHoverRadius: 6,
          borderWidth: 2.5,
          fill: true,
          tension: 0.4,
        },
      ],
    },function _tooltipTitle(period, data, idx) {
  if (!data?.[idx]) return "";
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
  if (period === "weekly")
    return data[idx]?.label ? `Week of ${data[idx].label}` : "";
  return data[idx]?.fullLabel || data[idx]?.label || "";
}

/* ══════════════════════════════════════════════════════════════
   OVERVIEW CHART — public update
   ══════════════════════════════════════════════════════════════ */

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
  if (typeof getChartData !== "function") return;

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
   CHART PERIOD — single definition
   Syncs script.js global `chartPeriod` and redraws.
   ══════════════════════════════════════════════════════════════ */

function setChartPeriod(period) {
  /* Keep the script.js `chartPeriod` global in sync */
  try {
    chartPeriod = period;
  } catch (e) {
    /* not yet declared — safe to ignore */
  }
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

  if (!total || !catsData?.length) {
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
      datasets: catsData.map((c) => ({
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
   BACKWARD-COMPAT WRAPPERS
   ══════════════════════════════════════════════════════════════ */

function renderChartJS(period) {
  updateOverviewChart(period);
}

function renderCategoryChartJS(sortedCats) {
  if (typeof getCatColor !== "function") return;
  const data = (sortedCats || []).map(([name, val]) => ({
    label: name,
    value: val || 0,
    color: getCatColor(name),
  }));
  updateCategoryChart(data);
}

/* ── Global exposure ─────────────────────────────────────────── */
window.initOverviewChart = initOverviewChart;
window.updateOverviewChart = updateOverviewChart;
window.setChartPeriod = setChartPeriod;
window.initCategoryChart = initCategoryChart;
window.updateCategoryChart = updateCategoryChart;
window.renderChartJS = renderChartJS;
window.renderCategoryChartJS = renderCategoryChartJS;
