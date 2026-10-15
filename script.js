/*
 * PAGE DRAWING — turns data + scores into the four screens.
 * Ported from app.py, views/*.py, ui/components.py and ui/charts.py.
 * No scoring rules live here; they are all in scoring.js.
 */
(function () {
  // Stop early (index.html then shows which file is missing) if a core file did not load.
  if (!window.CONFIG || !window.Data || !window.Scoring) return;
  const C = window.CONFIG, D = window.Data, S = window.Scoring;
  const COLORS = { line: "#2f5bd3", ma: "#b26a00", muted: "#5f6b7a", grid: "#e6e9ef", ink: "#1d2430",
    red: "#c62828", bgRed: "#fdeaea", bgAmber: "#fff3e0", bgGreen: "#e7f5ec" };

  const state = { md: null, ms: null, risk: null, sug: null, hist: undefined, range: "1Y" };
  const charts = [];   // live Chart.js instances, destroyed on every redraw
  const app = document.getElementById("app");

  // ================================================================ formatting
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const nf = (v, d) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

  const fmtPrice = (v) => (!isNum(v) ? "—" : v < 1000 ? "$" + nf(v, 2) : "$" + nf(v, 0));
  const fmtNum = (v, d = 1) => (!isNum(v) ? "—" : nf(v, d));
  const fmtPct = (v, d = 1, signed = true) => (!isNum(v) ? "—" : (signed && v >= 0 ? "+" : "") + v.toFixed(d) + "%");
  function fmtBig(v) {
    if (!isNum(v)) return "—";
    for (const [u, div] of [["T", 1e12], ["B", 1e9], ["M", 1e6]]) if (Math.abs(v) >= div) return "$" + (v / div).toFixed(1) + u;
    return "$" + nf(v, 0);
  }
  const ET = "America/New_York";
  function fmtDt(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const yr = (x) => new Intl.DateTimeFormat("en-US", { timeZone: ET, year: "numeric" }).format(x);
    const opts = { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    if (yr(d) !== yr(new Date())) opts.year = "numeric";
    return new Intl.DateTimeFormat("en-US", opts).format(d) + " ET";
  }
  const fmtAsof = (iso, status) => (status === "mock" ? "Invented demo data — no real date" : fmtDt(iso));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(ds) {  // "YYYY-MM-DD" -> "Oct 15, 2026"
    const [y, m, d] = ds.split("-").map(Number);
    return `${MONTHS[m - 1]} ${d}, ${y}`;
  }
  const fmtTick = (ds) => { const [y, m] = ds.split("-"); return `${MONTHS[+m - 1]} '${y.slice(2)}`; };

  // ================================================================ small pieces (ui/components.py)
  const badge = (label, level) => `<span class="badge b-${level}">${esc(label)}</span>`;
  function dataTag(status) {
    const level = { live: "green", delayed: "green", stale: "amber", unavailable: "red", mock: "mock" }[status] || "none";
    return `<span class="tag t-${level}">${esc(D.STATUS_LABELS[status] || status)}</span>`;
  }
  function sparkline(series, points = 90) {
    if (!series || series.values.length < 5) return "";
    const y = series.values.slice(-points);
    const lo = Math.min(...y), hi = Math.max(...y), rng = hi - lo || 1;
    const pts = y.map((v, i) => [(i / (y.length - 1)) * 100, 30 - ((v - lo) / rng) * 26 - 2]);
    const [lx, ly] = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label="trend over recent months">` +
      `<polyline points="${pts.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ")}" fill="none" stroke="${COLORS.line}" ` +
      `stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>` +
      `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="2.2" fill="${COLORS.line}"/></svg>`;
  }
  function scoreScale(score) {
    const pos = Math.max(0, Math.min(100, score));
    return `<div class="scale"><div class="scale-marker" style="left:${pos.toFixed(1)}%"></div></div>` +
      `<div class="scale-labels"><span>0 Calm</span><span>35</span><span>65</span><span>100 Fearful</span></div>`;
  }
  const kvGrid = (rows) => `<div class="kv">${rows.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join("")}</div>`;
  let chartId = 0;
  const chartBox = (h) => { const id = "c" + ++chartId; return [id, `<div class="chart" style="height:${h}px"><canvas id="${id}"></canvas></div>`]; };
  const expander = (title, body, attrs = "") => `<details class="exp" ${attrs}><summary>${esc(title)}</summary><div class="exp-body">${body}</div></details>`;

  // ================================================================ charts (ui/charts.py, Chart.js version)
  const HAS_CHART = typeof window.Chart !== "undefined";  // false if lib/chart.umd.min.js is missing
  if (HAS_CHART) {
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = COLORS.muted;
  }

  const bandsPlugin = {  // shaded red/amber/green bands behind the score line
    id: "scoreBands",
    beforeDatasetsDraw(chart, _a, opts) {
      if (!opts || !opts.bands) return;
      const { ctx, chartArea: a, scales: { y } } = chart;
      ctx.save();
      for (const [lo, hi, color] of opts.bands) {
        const top = y.getPixelForValue(hi), bot = y.getPixelForValue(lo);
        ctx.fillStyle = color;
        ctx.fillRect(a.left, top, a.right - a.left, bot - top);
      }
      ctx.restore();
    },
  };

  function baseOptions(o) {
    const fmtY = o.fmtY || ((v) => nf(v, 0));
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 4, right: 0, left: 0, bottom: 0 } },
      plugins: {
        legend: { display: false },
        scoreBands: { bands: o.bands || null },
        tooltip: {
          backgroundColor: "#fff", titleColor: COLORS.ink, bodyColor: COLORS.ink, borderColor: "#d5dae1",
          borderWidth: 1, padding: 10, titleFont: { size: 13, weight: "600" }, bodyFont: { size: 14 },
          displayColors: false,
          filter: (item) => !item.dataset.isRef,
          callbacks: {
            title: (items) => (items.length ? fmtDate(items[0].label) : ""),
            label: (item) => (item.dataset.prefix || "") + o.fmtHover(item.parsed.y),
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: "#d5dae1" },
          ticks: { maxTicksLimit: 4, maxRotation: 0, autoSkip: true, autoSkipPadding: 12,
            callback(v) { return fmtTick(this.getLabelForValue(v)); } } },
        y: { position: "right", grid: { color: COLORS.grid }, border: { display: false },
          min: o.min, max: o.max,
          afterBuildTicks: o.tickValues ? (axis) => { axis.ticks = o.tickValues.map((value) => ({ value })); } : undefined,
          ticks: { maxTicksLimit: 5, callback: (v) => fmtY(v) } },
      },
    };
  }

  /** Line chart: price/indicator, optional dotted 200-day average and dashed reference lines. */
  function lineChart(id, series, o = {}) {
    const el = document.getElementById(id);
    if (!el || !series || !series.values.length) return;
    if (!HAS_CHART) {
      const box = el.parentElement;
      box.style.height = "auto";
      box.innerHTML = '<p class="muted">Chart unavailable: the file lib/chart.umd.min.js was not found.</p>';
      return;
    }
    const suffix = o.suffix || "";
    const hd = o.hoverDigits ?? 2;
    const datasets = [{ data: series.values, borderColor: COLORS.line, borderWidth: 2, pointRadius: 0,
      pointHitRadius: 8, tension: 0, fill: o.fill || false, backgroundColor: o.fillColor }];
    if (o.ma) {
      datasets.push({ data: o.ma.values, borderColor: COLORS.ma, borderWidth: 1.6, borderDash: [2, 3],
        pointRadius: 0, prefix: "200-day avg ", spanGaps: false });
    }
    for (const ref of o.refs || []) {
      datasets.push({ data: series.values.map(() => ref), borderColor: COLORS.muted, borderWidth: 1,
        borderDash: [5, 4], pointRadius: 0, isRef: true });
    }
    if (o.lineColor) datasets[0].borderColor = o.lineColor;
    if (o.prefix) datasets[0].prefix = o.prefix;
    const opts = baseOptions({
      fmtY: o.fmtY, min: o.min, max: o.max, tickValues: o.tickValues, bands: o.bands,
      fmtHover: (v) => (o.hoverSigned && v >= 0 ? "+" : "") + nf(v, hd) + suffix,
    });
    charts.push(new Chart(el, { type: "line", data: { labels: series.dates, datasets }, options: opts, plugins: [bandsPlugin] }));
  }

  /** Expander charts are drawn the first time they are opened (a hidden canvas has no size). */
  function drawOnOpen(detailsId, fn) {
    const el = document.getElementById(detailsId);
    if (!el) return;
    let done = false;
    el.addEventListener("toggle", () => { if (el.open && !done) { done = true; fn(); } });
  }

  function clearCharts() { while (charts.length) charts.pop().destroy(); }

  // ================================================================ MARKET screen (views/market.py)
  const EXPLAIN = {
    vix: "The VIX measures how much the S&P 500 is expected to swing over the next 30 days, based on option prices. Below 15 = calm, 20–30 = worried, above 30 = fear. High fear has often been a better time to invest regularly, but it can stay high for weeks.",
    fear_greed: "CNN combines seven signals (momentum, volatility, demand for safe assets and more) into one 0–100 reading. 0 = extreme fear, 100 = extreme greed. This dashboard treats fear as more opportunity and greed as less (a contrarian view).",
    trend: "How far the S&P 500 is above or below its average price of the last 200 trading days. Far above = the market has run up a lot; below = the market is in a weaker phase, often with lower prices for new money.",
    breadth: "How many of the 11 sector groups (tech, banks, energy …) are above their own 200-day average. High = most of the market is rising together. Very low = a broad sell-off. This is a simple proxy, not the official % of all 500 stocks.",
    credit: "The extra yield investors demand to lend to riskier companies, in percentage points (pp). Rising spreads mean lenders are nervous about the economy; very high spreads usually come with stock market stress.",
  };
  const VFMT = {
    vix: (v) => v.toFixed(1), fear_greed: (v) => v.toFixed(0), trend: (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + "%",
    breadth: (v) => v.toFixed(0) + "%", credit: (v) => v.toFixed(2) + " pp",
  };
  const CHART_OPTS = {  // y-axis format, hover digits, suffix, reference lines
    vix: { fmtY: (v) => v.toFixed(0), hoverDigits: 1, refs: [20, 30] },
    fear_greed: { fmtY: (v) => v.toFixed(0), hoverDigits: 0, refs: [50] },
    trend: { fmtY: (v) => (v > 0 ? "+" : "") + v.toFixed(0) + "%", hoverDigits: 1, suffix: "%", hoverSigned: true, refs: [0] },
    breadth: { fmtY: (v) => v.toFixed(0) + "%", hoverDigits: 0, suffix: "%", refs: [50] },
    credit: { fmtY: (v) => v.toFixed(1) + " pp", hoverDigits: 2, suffix: " pp", refs: [5] },
  };

  function summaryHtml() {
    const { md, ms, risk, sug } = state;
    const [qLabel, qLevel, qMsg] = D.overallQuality(md.indicators);
    const sp = md.prices[C.SP500_INDEX_TICKER];
    const pricesAsOf = sp && sp.as_of ? fmtAsof(sp.as_of, sp.status) : "—";
    let scoreHtml;
    if (ms.valid) {
      scoreHtml = `<div class="card-row"><div><div class="card-sub">Market Opportunity Score</div>` +
        `<div><span class="score-num">${ms.score.toFixed(0)}</span><span class="card-sub"> / 100</span></div></div>` +
        `${badge(ms.status, ms.level)}</div>${scoreScale(ms.score)}`;
    } else {
      const partial = ms.partial_score === null ? "" :
        `<div class="muted">Partial estimate ${ms.partial_score.toFixed(0)} from ${(ms.coverage * 100).toFixed(0)}% of inputs — <b>not a valid score</b>.</div>`;
      scoreHtml = `<div class="card-row"><div><div class="card-sub">Market Opportunity Score</div>` +
        `<div class="score-num">—</div></div>${badge("Incomplete data", "none")}</div>${partial}`;
    }
    const riskDetail = risk.flags.length ? risk.flags.join(", ")
      : risk.complete ? "No risk flags triggered." : "Not enough data to judge risk.";
    return `<div class="hero">${scoreHtml}` +
      `<div class="box b-${risk.level}" style="margin-top:12px"><div class="card-row"><span class="card-title">Market Risk Warning</span>` +
      `${badge(risk.label, risk.level)}</div><div class="muted" style="margin-top:2px">${esc(riskDetail)}</div></div>` +
      `<div class="box soft"><div class="card-sub">Suggested action</div><div class="action">${esc(sug.action)}</div>` +
      `<ul>${sug.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>` +
      `<div class="card-row" style="margin-top:10px;flex-wrap:wrap"><span class="muted">${md.demo ? "Prices: " : "Prices as of "}${esc(pricesAsOf)}</span>` +
      `<span class="badge b-${qLevel}">Data: ${esc(qLabel)}</span></div><div class="muted">${esc(qMsg)}</div></div>`;
  }

  function historyCompare(ind, s) {
    const vf = VFMT[ind.key];
    const pct = (s.values.filter((v) => v < ind.value).length / s.values.length) * 100;
    const yr = s.values.slice(-252);
    const mean = yr.reduce((a, b) => a + b, 0) / yr.length;
    const span = s.values.length > 300 ? "2 years" : "year";
    return `<p>Today is higher than <b>${pct.toFixed(0)}%</b> of days in the last ${span}. ` +
      `1-year range: ${esc(vf(Math.min(...yr)))} to ${esc(vf(Math.max(...yr)))}, average ${esc(vf(mean))}.</p>`;
  }

  function indicatorCard(ind, sub, after) {
    const [label, level] = S.indicatorLabel(ind);
    const value = ind.value !== null ? VFMT[ind.key](ind.value) : "Unavailable";
    const when = ind.as_of ? fmtAsof(ind.as_of, ind.status) : "No timestamp";
    const hasHist = ind.series && ind.series.values.length > 5;
    let body = "";
    let chartIdV = null;
    if (hasHist) {
      const [id, box] = chartBox(220);
      chartIdV = id;
      body += box + historyCompare(ind, D.sliceLast(ind.series, 504));
    } else if (ind.error) {
      body += `<p class="muted">Why unavailable: ${esc(ind.error)}</p>`;
    }
    body += `<p>${esc(EXPLAIN[ind.key])}</p>`;
    if (sub !== null && sub !== undefined) body += `<p class="muted">Contribution to the score: sub-score ${sub.toFixed(0)}/100.</p>`;
    body += `<p class="muted">Source: ${esc(ind.source)}</p>`;
    const detId = "det-" + ind.key;
    if (chartIdV) {
      after.push(() => drawOnOpen(detId, () => {
        const o = CHART_OPTS[ind.key];
        lineChart(chartIdV, D.sliceLast(ind.series, 504), o);
      }));
    }
    return `<div class="card"><div class="card-row"><span class="card-title">${esc(ind.name)}</span>` +
      `${ind.value !== null ? badge(label, level) : badge("No data", "none")}</div>` +
      `<div class="card-row" style="margin-top:4px"><span class="mid">${esc(value)}</span>${sparkline(ind.series)}</div>` +
      `<div class="card-row"><span class="muted">${esc(when)}</span>${dataTag(ind.status)}</div>` +
      expander("Details", body, `id="${detId}"`) + `</div>`;
  }

  function renderMarket(after) {
    const { md, ms } = state;
    const keys = ["vix", "fear_greed", "trend", "breadth", "credit"];
    return summaryHtml() + `<h3>Indicators</h3><div class="grid2">` +
      keys.map((k) => indicatorCard(md.indicators[k], ms.components[k], after)).join("") + `</div>` +
      expander("How the score works",
        `<p>Each indicator is turned into a 0–100 sub-score (higher = more fear, which has historically meant cheaper prices for long-term buyers). The score is their weighted average. It is shown only when all five indicators are available and up to date. The Risk Warning is separate: it flags market stress that can make prices fall further first.</p>` +
        `<p class="muted">Weights and thresholds are in config.js. The score describes market mood; it does not predict returns and is not financial advice.</p>`);
  }

  // ================================================================ ETF screen (views/etfs.py)
  function etfCard(key, after) {
    const { md, ms } = state;
    const [ticker, name, desc] = C.ETFS[key];
    const p = md.prices[ticker];
    const a = S.etfAssessment(p, ms);
    const st = a.stats;
    if (!st) {
      return `<div class="card"><div class="card-row"><span class="card-title">${esc(name)} <span class="card-sub">${ticker}</span></span>${dataTag(p.status)}</div>` +
        `<div class="muted" style="margin-top:6px">Price data unavailable. ${esc(p.error)}</div>` +
        `<div class="box b-none"><div class="action">${esc(a.suggestion)}</div></div></div>`;
    }
    const ctx = ms.valid ? `Market score ${ms.score.toFixed(0)}/100 · ${ms.status}` : "Market score incomplete today";
    const [id1, box1] = chartBox(170);
    const [id2, box2] = chartBox(160);
    const detId = "det-etf-" + key;
    const yr = D.sliceLast(p.close, 252), ma = D.sliceLast(D.maSeries(p.close), 252);
    after.push(() => lineChart(id1, yr, { ma, fmtY: (v) => nf(v, 0), hoverDigits: 2, refs: [] }));
    after.push(() => drawOnOpen(detId, () => {
      const s = D.sliceLast(p.close, 504);
      let peak = -Infinity;
      const dd = { dates: s.dates, values: s.values.map((v) => { peak = Math.max(peak, v); return (v / peak - 1) * 100; }) };
      lineChart(id2, dd, { fmtY: (v) => v.toFixed(0) + "%", hoverDigits: 1, suffix: "% from high",
        lineColor: COLORS.red, fill: "origin", fillColor: COLORS.bgRed });
    }));
    return `<div class="card"><div class="card-row"><span class="card-title">${esc(name)} <span class="card-sub">· ${ticker}</span></span>${dataTag(p.status)}</div>` +
      `<div class="card-sub">${esc(desc)}</div>` +
      `<div class="card-row" style="margin-top:6px"><span class="big">${fmtPrice(st.last)}</span><span class="card-sub">${esc(a.trend)}</span></div>` +
      `<div class="card-row" style="margin-top:4px"><span class="muted">${fmtPct(-st.drawdown)} from 52-week high</span>${badge(a.dd_label, a.dd_level)}</div>` +
      `<div class="muted">${esc(fmtAsof(p.as_of, p.status))}</div>` + box1 +
      `<div class="muted chart-note">1 year · blue = price · dotted = 200-day average</div>` +
      `<div class="box soft"><div class="card-sub">${esc(ctx)}</div><div class="action">${esc(a.suggestion)}</div></div>` +
      expander(`More on ${name}`, `<p><b>Drop from running high (2 years)</b></p>${box2}` +
        kvGrid([["52-week high", fmtPrice(st.high_52w)], ["vs 200-day average", fmtPct(st.vs_ma200)],
          ["1-month return", fmtPct(st.ret_1m)], ["1-year return", fmtPct(st.ret_1y)]]) +
        `<p class="muted">Blue line = price, dotted = 200-day average. Source: ${esc(p.source)}, ticker ${ticker}. Price-only returns (dividends not included).</p>`,
      `id="${detId}"`) + `</div>`;
  }

  function renderEtfs(after) {
    return `<div class="muted">The market score describes today's mood. <b>It is not a guarantee of future returns.</b> ` +
      `Regular investing on a fixed schedule stays the base plan in every situation.</div>` +
      `<div class="grid2">${Object.keys(C.ETFS).map((k) => etfCard(k, after)).join("")}</div>`;
  }

  // ================================================================ STOCKS screen (views/stocks.py)
  const scoreBadge = (a) => (a.valid ? badge(`Score ${a.score.toFixed(0)}`, a.level) : badge("No score", "none"));

  function stockCard(t) {
    const { md } = state;
    const p = md.prices[t], f = md.fundamentals[t];
    const a = S.stockAssessment(p, f);
    const name = f.name || C.STOCKS[t].name;
    const price = a.stats ? fmtPrice(a.stats.last) : "Unavailable";
    return `<div class="card"><div class="card-row"><span class="card-title">${t} <span class="card-sub">· ${esc(name)}</span></span>${scoreBadge(a)}</div>` +
      `<div class="card-row" style="margin-top:4px"><span class="mid">${price}</span><span class="card-sub">${esc(a.trend)}</span></div>` +
      `<div class="card-row"><span class="muted">${esc(fmtAsof(p.as_of, p.status))}</span>${dataTag(p.status)}</div>` +
      `<div class="card-row" style="margin-top:6px"><span class="muted">${esc(a.val_text)}</span>${badge(a.val_label, a.val_level)}</div>` +
      `<div class="muted" style="margin-top:6px"><b>Main risk:</b> ${esc(C.STOCKS[t].risk)}</div>` +
      `<div class="muted" style="margin-top:4px"><b>Next step:</b> ${esc(a.next_step)}</div>` +
      `<a class="btn" href="#stocks/${encodeURIComponent(t)}">Open ${t} details</a></div>`;
  }

  function stockDetail(t, after) {
    const { md } = state;
    const p = md.prices[t], f = md.fundamentals[t];
    const a = S.stockAssessment(p, f);
    const st = a.stats;
    const name = f.name || C.STOCKS[t].name;
    const scoreLine = a.valid ? badge(`Score ${a.score.toFixed(0)}/100`, a.level)
      : badge("No score — " + a.missing.join(", ") + " missing", "none");
    let html = `<a class="btn" href="#stocks" style="margin-top:0">← All stocks</a>` +
      `<div class="card"><div class="card-row"><span class="card-title" style="font-size:1.1rem">${t} <span class="card-sub">· ${esc(name)}</span></span>${dataTag(p.status)}</div>` +
      `<div class="card-row" style="margin-top:4px;flex-wrap:wrap"><span class="big">${st ? fmtPrice(st.last) : "Unavailable"}</span>${scoreLine}</div>` +
      `<div class="muted">${esc(fmtAsof(p.as_of, p.status))} · ${esc(a.trend)}</div>` +
      `<div class="box soft"><div class="card-sub">Suggested next step</div><div class="action">${esc(a.next_step)}</div></div></div>`;
    if (st) {
      const [id, box] = chartBox(220);
      html += `<h3>Price, 1 year</h3>${box}<div class="muted chart-note">Blue = price · dotted = 200-day average</div>`;
      after.push(() => lineChart(id, D.sliceLast(p.close, 252),
        { ma: D.sliceLast(D.maSeries(p.close), 252), fmtY: (v) => nf(v, 0), hoverDigits: 2 }));
    }
    const pctOrDash = (x, signed = true) => (isNum(x) ? fmtPct(x * 100, 1, signed) : "—");
    html += `<h3>Valuation</h3><div class="card"><div class="card-row" style="margin-bottom:8px"><span class="card-title">${esc(a.val_text)}</span>${badge(a.val_label, a.val_level)}</div>` +
      kvGrid([["Forward P/E", fmtNum(f.forward_pe, 1)], ["Trailing P/E", fmtNum(f.trailing_pe, 1)],
        ["Price / Sales", fmtNum(f.price_to_sales, 1)], ["Market cap", fmtBig(f.market_cap)]]) + `</div>` +
      `<h3>Fundamentals &amp; price</h3><div class="card">` +
      kvGrid([["Revenue growth (yoy)", pctOrDash(f.revenue_growth)], ["Profit margin", pctOrDash(f.profit_margin, false)],
        ["From 52-week high", st ? fmtPct(-st.drawdown) : "—"], ["vs 200-day average", st ? fmtPct(st.vs_ma200) : "—"],
        ["1-year return", st ? fmtPct(st.ret_1y) : "—"]]) + `</div>` +
      `<h3>Main risk</h3><div class="card">${esc(C.STOCKS[t].risk)}<div class="muted" style="margin-top:4px">Your own note, edited in config.js — not live data.</div></div>`;
    const pt = a.parts;
    const n0 = (v) => (isNum(v) ? v.toFixed(0) : "—");
    html += expander("How this stock's score works",
      `<p>Three parts, each 0–100 (higher = more attractive entry for a long-term buyer): valuation ${n0(pt.valuation)}, ` +
      `drop from 52-week high ${n0(pt.drawdown)}, trend vs 200-day average ${n0(pt.trend)}. ` +
      `A cheap-looking or falling stock can keep falling for good reasons — the score only tells you where to start researching.</p>` +
      `<p class="muted">Prices: ${esc(p.source)}. Fundamentals: ${esc(f.source)}${f.error ? " (" + esc(f.error) + ")" : ""}.</p>`);
    return html;
  }

  function renderStocks(after, sel) {
    if (sel && C.STOCKS[sel]) return stockDetail(sel, after);
    return `<div class="muted">Individual stocks carry more risk than ETFs. Use these cards to decide what to research, not what to buy.</div>` +
      `<div class="grid2">${Object.keys(C.STOCKS).map(stockCard).join("")}</div>`;
  }

  // ================================================================ HISTORY screen (views/history.py)
  const RANGES = { "3M": 63, "6M": 126, "1Y": 252, "2Y": 504 };

  function levelFor(score) {
    for (const [min, , level] of C.SCORE_BANDS) if (score >= min) return level;
    return "none";
  }

  function renderHistory(after) {
    const { md } = state;
    const n = RANGES[state.range] || 252;
    let html = `<div class="seg" role="group" aria-label="Period">` +
      Object.keys(RANGES).map((r) => `<button type="button" data-range="${r}" aria-pressed="${r === state.range}">${r}</button>`).join("") + `</div>`;

    html += `<h3>Market Opportunity Score</h3>`;
    const hist = state.hist;
    if (!hist) {
      html += `<div class="card muted">Score history is unavailable because at least one indicator has no history right now. Only complete scores are drawn.</div>`;
    } else {
      const dates = hist.dates.slice(-n), score = hist.score.slice(-n);
      const [id, box] = chartBox(240);
      html += box + `<p class="muted">Rebuilt day by day from each indicator's history (only days with all 5 indicators). ` +
        `Shaded bands: red &lt; 35 · amber 35–65 · green ≥ 65. Range shown: ${fmtDate(dates[0])} – ${fmtDate(dates[dates.length - 1])}. ` +
        `Fear &amp; Greed history may be shorter than other series.</p>` + (md.demo ? `<p class="muted">MOCK history in Demo mode.</p>` : "");
      after.push(() => lineChart(id, { dates, values: score }, {
        lineColor: COLORS.ink, min: 0, max: 100, fmtY: (v) => v.toFixed(0), hoverDigits: 0, prefix: "Score ",
        tickValues: [0, 35, 65, 100],
        bands: [[0, 35, COLORS.bgRed], [35, 65, COLORS.bgAmber], [65, 100, COLORS.bgGreen]],
      }));
    }

    html += `<h3>S&amp;P 500</h3>`;
    const sp = md.prices[C.SP500_INDEX_TICKER];
    if (!sp || !sp.close || !sp.close.values.length) {
      html += `<div class="card muted">S&amp;P 500 price history unavailable.</div>`;
    } else {
      const s = D.sliceLast(sp.close, n);
      const [id, box] = chartBox(200);
      html += box + `<p class="muted">Index level, ${fmtDate(s.dates[0])} – ${fmtDate(s.dates[s.dates.length - 1])}. Dotted = 200-day average. Source: ${esc(sp.source)}.</p>`;
      after.push(() => lineChart(id, s, { ma: D.sliceLast(D.maSeries(sp.close), n), fmtY: (v) => nf(v, 0), hoverDigits: 0 }));
    }

    html += `<h3>Signal log</h3>`;
    const log = S.signalLog(md.indicators, hist);
    if (!log.length) {
      html += `<p class="muted">No signal changes to show yet. Entries appear when the market status or risk level changes in the indicator history.</p>`;
    } else {
      const item = (r) => `<div class="list-item"><div class="card-row"><span class="card-title">${esc(fmtDate(r.date))}</span>` +
        `${badge(`${r.score.toFixed(0)} · ${r.status}`, levelFor(r.score))}</div>` +
        `<div class="muted">Risk: ${esc(r.risk)}</div><div style="font-size:0.92rem;margin-top:2px">${esc(r.action)}</div>` +
        `<div class="muted">${esc(r.reasons)}</div></div>`;
      html += `<div class="card">${log.slice(0, 5).map(item).join("")}</div>`;
      if (log.length > 5) html += expander(`Older signals (${log.length - 5})`, `<div class="card">${log.slice(5).map(item).join("")}</div>`);
      html += `<p class="muted">Rebuilt from the indicator history: one entry each time the market status or risk level changed, ` +
        `using today's rules${md.demo ? ". MOCK entries in Demo mode" : ""}.</p>`;
    }
    return html;
  }

  // ================================================================ app shell (app.py)
  function parseRoute() {
    const h = decodeURIComponent((location.hash || "#market").slice(1));
    const [page, sub] = h.split("/");
    return { page: ["market", "etfs", "stocks", "history"].includes(page) ? page : "market", sub: sub || null };
  }

  function isDemo() {
    const q = new URLSearchParams(location.search).get("demo");
    if (q === "1" || q === "0") return q === "1";
    try { return localStorage.getItem("demo") === "1"; } catch (e) { return false; }
  }

  function render() {
    clearCharts();
    const { md } = state;
    const route = parseRoute();
    document.querySelectorAll(".nav a").forEach((a) => {
      const on = a.dataset.page === route.page;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });

    let banner = "";
    if (md.demo) {
      banner = `<div class="mock-banner">DEMO MODE — all numbers below are invented mock data, not real or current. Turn off Demo mode in Settings for live data.</div>`;
    } else if (!md.meta.generated_at) {
      banner = `<div class="error-banner">No market data file yet. Run the “Update market data” action in your GitHub repository (see README), then tap Refresh in Settings below. To explore the app with invented numbers, switch on Demo mode.</div>`;
    } else if (Object.values(md.indicators).every((i) => i.status === "unavailable")) {
      banner = `<div class="error-banner">Live data could not be loaded. Check the “Update market data” action in GitHub, then tap Refresh in Settings below. To explore the app with invented numbers, switch on Demo mode.</div>`;
    }
    document.getElementById("banner").innerHTML = banner;

    const after = [];
    let html;
    if (route.page === "market") html = renderMarket(after);
    else if (route.page === "etfs") html = renderEtfs(after);
    else if (route.page === "stocks") html = renderStocks(after, route.sub);
    else html = renderHistory(after);
    app.innerHTML = html;
    after.forEach((fn) => fn());

    app.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
      state.range = b.dataset.range;
      render();
    }));

    document.getElementById("data-info").textContent =
      (md.demo ? "Demo mode: no data file used. " : `Data file written ${fmtDt(md.meta.generated_at)}. `) +
      "Sources: Yahoo Finance (via yfinance), FRED, CNN — downloaded by a scheduled GitHub Action, not by your browser. " +
      "Free sources can be delayed, change, or break without notice.";
  }

  async function load() {
    try {
      await loadInner();
    } catch (err) {
      app.innerHTML = `<div class="error-banner"><b>Something went wrong while drawing the dashboard.</b><br>${esc(err && err.message)}</div>`;
      console.error(err);
    }
  }

  async function loadInner() {
    const demo = isDemo();
    document.getElementById("demo-toggle").checked = demo;
    app.innerHTML = `<div class="muted loading">Loading…</div>`;
    const md = demo ? D.mockMarketData() : D.fromBundle(await D.loadLiveBundle());
    state.md = md;
    state.ms = S.computeMarketScore(md.indicators);
    state.risk = S.computeRisk(md.indicators);
    state.sug = S.suggestAction(state.ms, state.risk, md.indicators);
    state.hist = S.scoreHistory(md.indicators);
    render();
  }

  // navigation, settings
  let lastPage = parseRoute().page;
  window.addEventListener("hashchange", () => {
    render();
    const p = parseRoute().page;
    if (p !== lastPage || p === "stocks") window.scrollTo(0, 0);
    lastPage = p;
  });
  document.getElementById("demo-toggle").addEventListener("change", (e) => {
    try { localStorage.setItem("demo", e.target.checked ? "1" : "0"); } catch (err) { /* private mode */ }
    const url = new URL(location.href);
    url.searchParams.delete("demo");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    load();
  });
  document.getElementById("refresh-btn").addEventListener("click", load);

  // expose for automated tests
  window.App = { state, load, render };
  load();
})();
