  /* ═══════════════════════════════════════════════════════════════
    charts.js — BlueLedger Chart Rendering (Chart.js) — FINAL
    Premium Edition: gradient fills, smooth animations, no grid lines
    Responsive Edition: ResizeObserver + debounced resize, no stale canvas
    ═══════════════════════════════════════════════════════════════ */

  "use strict";

  /* ── Private chart state ──────────────────────────────────────── */
  let _overviewChart = null;
  let _categoryChart = null;
  let _currentOverviewPeriod = "monthly";

  // ResizeObserver instance — single observer, torn down cleanly on rebuild
  let _overviewResizeObserver = null;
  // Debounce timer handle
  let _resizeDebounceTimer = null;
  // Track last known container width to avoid no-op rebuilds
  let _lastContainerWidth = 0;

  const INCOME_COLOR = "#059669"; // emerald 600
  const EXPENSE_COLOR = "#DC2626"; // red 600
  const INCOME_COLOR_DIM = "rgba(52,211,153,0.08)";
  const EXPENSE_COLOR_DIM = "rgba(249,115,22,0.08)";

  /* ══════════════════════════════════════════════════════════════
    RESPONSIVE RESIZE SYSTEM
    ══════════════════════════════════════════════════════════════ */

  /**
   * Debounce a function call. Returns a cancel handle.
   */
  function _debounce(fn, delay) {
    let timer = null;
    const debounced = function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
  }

  /**
   * Fully destroy the overview chart and clean up all associated
   * resources: Chart.js instance, canvas element, ResizeObserver.
   * Safe to call multiple times.
   */
  function _destroyOverviewChart() {
    // 1. Tear down the ResizeObserver first — prevents it firing
    //    during destruction and triggering a rebuild loop.
    if (_overviewResizeObserver) {
      _overviewResizeObserver.disconnect();
      _overviewResizeObserver = null;
    }

    // 2. Cancel any in-flight debounce timers.
    if (_resizeDebounceTimer) {
      clearTimeout(_resizeDebounceTimer);
      _resizeDebounceTimer = null;
    }

    // 3. Destroy Chart.js instance (releases WebGL/2D context resources).
    if (_overviewChart) {
      _overviewChart.destroy();
      _overviewChart = null;
    }

    _lastContainerWidth = 0;
  }

  /**
   * Reset a canvas element so Chart.js gets a clean slate.
   * Stale width/height attributes are the primary cause of
   * the "stretched chart" bug after viewport switches.
   */
  function _resetCanvas(canvas) {
    if (!canvas) return;
    // Remove explicit width/height attributes — let CSS + Chart.js own them.
    canvas.removeAttribute("width");
    canvas.removeAttribute("height");
    canvas.style.width = "100%";
    canvas.style.height = "";
    canvas.style.maxHeight = "220px";
  }

  /**
   * Attach a ResizeObserver to the chart container. When the
   * container's width changes by more than 1px, the chart is
   * rebuilt after a short debounce so rapid DevTools drags
   * don't trigger a flood of rebuilds.
   */
  function _attachResizeObserver(container) {
    if (!container) return;
    if (!window.ResizeObserver) {
      // Fallback for older browsers: window resize event.
      _attachWindowResizeFallback();
      return;
    }

    const debouncedRebuild = _debounce(() => {
      const newWidth = container.getBoundingClientRect().width;
      // Skip if width hasn't meaningfully changed (avoids sub-pixel jitter).
      if (Math.abs(newWidth - _lastContainerWidth) < 2) return;
      _lastContainerWidth = newWidth;
      _rebuildOverviewChart();
    }, 120);

    _overviewResizeObserver = new ResizeObserver(debouncedRebuild);
    _overviewResizeObserver.observe(container);
  }

  /**
   * Window-resize fallback for browsers without ResizeObserver.
   * Uses a module-scoped debounced handler stored on window so
   * it can be removed without leaking listeners.
   */
  function _attachWindowResizeFallback() {
    // Remove any previously attached handler first.
    if (window.__blChartResizeHandler) {
      window.removeEventListener("resize", window.__blChartResizeHandler);
    }
    window.__blChartResizeHandler = _debounce(() => {
      _rebuildOverviewChart();
    }, 150);
    window.addEventListener("resize", window.__blChartResizeHandler, {
      passive: true,
    });
  }

  /**
   * Rebuild the overview chart in-place:
   *  1. Destroy the existing instance (clears stale canvas state).
   *  2. Re-create the canvas fresh inside the container.
   *  3. Re-run _buildOverviewChart on the new canvas.
   *
   * The ResizeObserver is intentionally NOT detached here because
   * _destroyOverviewChart() is NOT called — we only destroy the
   * Chart.js instance and reset the canvas, preserving the observer.
   */
  function _rebuildOverviewChart() {
    // Destroy chart instance only — keep the observer alive.
    if (_overviewChart) {
      _overviewChart.destroy();
      _overviewChart = null;
    }

    const container = safeGet("chartContainer");
    if (!container) return;

    // Remove the old canvas and create a fresh one.
    // A fresh canvas element guarantees no stale internal dimensions.
    const old = safeGet("overviewCanvas");
    if (old) old.remove();

    const canvas = document.createElement("canvas");
    canvas.id = "overviewCanvas";
    _resetCanvas(canvas);
    container.appendChild(canvas);

    _buildOverviewChart(canvas);
  }

  /* ══════════════════════════════════════════════════════════════
    OVERVIEW CHART — init
    ══════════════════════════════════════════════════════════════ */

  function initOverviewChart() {
    const container = safeGet("chartContainer");
    if (!container) return;

    // Full teardown — destroy chart, observer, debounce timers.
    _destroyOverviewChart();

    container.innerHTML = "";
    container.style.position = "relative";
    container.style.padding = "0";

    // ── Period controls ──────────────────────────────────────────
    const cardHeader =
      container.closest(".card")?.querySelector(".card-header") ||
      container.closest(".db-chart-card")?.querySelector(".dcc-header");
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

    // ── Fresh canvas ─────────────────────────────────────────────
    const canvas = document.createElement("canvas");
    canvas.id = "overviewCanvas";
    _resetCanvas(canvas);
    container.appendChild(canvas);

    const labelsDiv = safeGet("chartLabels");
    if (labelsDiv) labelsDiv.style.display = "none";

    _buildOverviewChart(canvas);

    // Attach the resize observer AFTER the chart is built so the
    // initial render width is captured as the baseline.
    _lastContainerWidth = container.getBoundingClientRect().width;
    _attachResizeObserver(container);
  }

  /* ── Create gradient fill for chart ───────────────────────────── */
  function _makeGradient(ctx, color, alpha1 = 0.28, alpha2 = 0.0) {
    try {
      const gradient = ctx.createLinearGradient(0, 0, 0, 220);
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      gradient.addColorStop(0, `rgba(${r},${g},${b},${alpha1})`);
      gradient.addColorStop(0.6, `rgba(${r},${g},${b},${alpha2 * 0.5})`);
      gradient.addColorStop(1, `rgba(${r},${g},${b},${alpha2})`);
      return gradient;
    } catch (e) {
      return "transparent";
    }
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

    // Guard: destroy any lingering instance that might have snuck in.
    if (_overviewChart) {
      _overviewChart.destroy();
      _overviewChart = null;
    }

    const isDark =
      document.documentElement.getAttribute("data-theme") !== "light";
    const gridCol = isDark ? "rgba(255,255,255,0.06)" : "rgba(15,23,42,0.05)";

    const tickCol = isDark ? "rgba(230,237,243,0.4)" : "#94A3B8";

    const labels = data.map((d) => d.label || "");
    const incomes = data.map((d) => d.income || 0);
    const expenses = data.map((d) => d.expense || 0);

    const incGradient = _makeGradient(ctx, "#34d399", 0.32, 0.0);
    const expGradient = _makeGradient(ctx, "#f97316", 0.28, 0.0);

    canvas.style.background = "transparent";

    _overviewChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Income",
            data: incomes,
            borderColor: INCOME_COLOR,
            backgroundColor: incGradient,
            pointBackgroundColor: INCOME_COLOR,
            pointBorderColor: "#08090f",
            pointBorderWidth: 2,
            pointRadius: 5,
            pointHoverRadius: 8,
            pointHoverBorderWidth: 3,
            fill: true,
            tension: 0.42,
          },
          {
            label: "Expense",
            data: expenses,
            borderColor: EXPENSE_COLOR,
            backgroundColor: expGradient,
            pointBackgroundColor: EXPENSE_COLOR,
            pointBorderColor: "#08090f",
            pointBorderWidth: 2,
            pointRadius: 5,
            pointHoverRadius: 8,
            pointHoverBorderWidth: 3,
            fill: true,
            tension: 0.38,
          },
        ],
      },
      options: {
        responsive: true,
        // Must be false — true causes Chart.js to lock the canvas to its
        // initial aspect ratio and ignore container width changes, which
        // is the root cause of the "stretched chart after resize" bug.
        maintainAspectRatio: false,
        animation: {
          duration: 700,
          easing: "easeOutQuart",
        },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "rgba(8,9,20,0.96)",
            borderColor: "rgba(129,140,248,0.22)",
            borderWidth: 1,
            titleColor: "#e2e8f0",
            bodyColor: "#94a3b8",
            padding: 12,
            cornerRadius: 10,
            callbacks: {
              title(items) {
                if (!items?.[0]) return "";
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
            ticks: { color: tickCol, font: { size: 11 }, maxRotation: 0 },
            border: { display: false },
          },
          y: {
            grid: {
              color: gridCol,
              drawBorder: false,
              lineWidth: 1,
            },
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

    // Rebuild gradients (canvas context dimensions may have changed).
    const ctx = canvas.getContext("2d");
    _overviewChart.data.datasets[0].backgroundColor = _makeGradient(
      ctx,
      "#34d399",
      0.32,
      0.0,
    );
    _overviewChart.data.datasets[1].backgroundColor = _makeGradient(
      ctx,
      "#f97316",
      0.28,
      0.0,
    );

    _overviewChart.data.labels = labels;
    _overviewChart.data.datasets[0].data = incomes;
    _overviewChart.data.datasets[1].data = expenses;
    _overviewChart.update("active");
  }

  /* ══════════════════════════════════════════════════════════════
    CHART PERIOD
    ══════════════════════════════════════════════════════════════ */

  function setChartPeriod(period) {
    try {
      chartPeriod = period;
    } catch (e) {
      /* ok */
    }
    _currentOverviewPeriod = period;
    updateOverviewChart(period);
  }

  /* ══════════════════════════════════════════════════════════════
    CATEGORY STACKED BAR (thin 8px strip)
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
          borderRadius: 2,
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
            backgroundColor: "rgba(8,9,20,0.96)",
            borderColor: "rgba(129,140,248,0.22)",
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
        animation: { duration: 500, easing: "easeOutQuart" },
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
