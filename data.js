/*
 * DATA LAYER — loading, freshness labels, indicator building, demo (mock) data.
 * Ported from core/models.py, core/data_loader.py and core/data_mock.py.
 *
 * Live mode reads data/market.js, a file written by the GitHub Action
 * (tools/update_data.py). The browser never calls Yahoo, FRED or CNN itself.
 * Demo mode uses invented data made below. The two are never mixed.
 */
(function () {
  const C = window.CONFIG;

  const STATUS_LABELS = {
    live: "Live", delayed: "Delayed", stale: "Stale", unavailable: "Unavailable", mock: "MOCK DATA",
  };
  const STATUS_RANK = { live: 0, delayed: 1, mock: 1, stale: 2, unavailable: 3 };

  const ALL_TICKERS = [C.VIX_TICKER, C.SP500_INDEX_TICKER]
    .concat(Object.values(C.ETFS).map((e) => e[0]))
    .concat(C.SECTOR_ETFS)
    .concat(Object.keys(C.STOCKS));

  // ---------------------------------------------------------------- helpers
  /** A series is { dates: ["YYYY-MM-DD", ...], values: [number, ...] } with no gaps/nulls. */
  function makeSeries(dates, values) {
    const d = [], v = [];
    for (let i = 0; i < dates.length; i++) {
      const x = values[i];
      if (x !== null && x !== undefined && !Number.isNaN(x)) { d.push(dates[i]); v.push(Number(x)); }
    }
    return { dates: d, values: v };
  }
  const last = (s) => (s && s.values.length ? s.values[s.values.length - 1] : null);

  function sliceLast(s, n) {
    if (!s) return s;
    return { dates: s.dates.slice(-n), values: s.values.slice(-n) };
  }

  function isoDate(d) {
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(d.getUTCDate()).padStart(2, "0");
  }

  /** Same day N months earlier (clamped to month end), like pandas DateOffset(months=n). */
  function minusMonths(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    let mm = m - 1 - n, yy = y;
    while (mm < 0) { mm += 12; yy -= 1; }
    const dim = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
    return isoDate(new Date(Date.UTC(yy, mm, Math.min(d, dim))));
  }

  function freshnessStatus(asOf, realtimeSource) {
    if (!asOf) return "unavailable";
    const t = new Date(asOf).getTime();
    if (Number.isNaN(t)) return "unavailable";
    const ageH = (Date.now() - t) / 3.6e6;
    if (ageH > C.STALE_AFTER_HOURS) return "stale";
    if (realtimeSource && ageH * 60 <= C.LIVE_MAX_MINUTES) return "live";
    return "delayed";
  }

  function rollingMean(values, window) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= window) sum -= values[i - window];
      if (i >= window - 1) out[i] = sum / window;
    }
    return out;
  }

  /** % distance of price above its N-day moving average (first N-1 days dropped). */
  function pctAboveMA(s, window = 200) {
    const ma = rollingMean(s.values, window);
    const d = [], v = [];
    for (let i = window - 1; i < s.values.length; i++) {
      d.push(s.dates[i]); v.push((s.values[i] / ma[i] - 1) * 100);
    }
    return { dates: d, values: v };
  }

  function maSeries(s, window = 200) {
    const ma = rollingMean(s.values, window);
    return { dates: s.dates, values: ma };
  }

  // ---------------------------------------------------------------- indicator builders
  function newIndicator(key, name, unit, source) {
    return { key, name, unit, value: null, series: null, as_of: null, status: "unavailable",
      source, error: "", extra: {} };
  }
  const usable = (ind) => ind && ind.value !== null && ["live", "delayed", "mock"].includes(ind.status);

  function buildVix(p) {
    const ind = newIndicator("vix", "VIX (volatility)", "", p.source + " · ticker ^VIX");
    if (p.close && p.close.values.length) {
      Object.assign(ind, { series: p.close, value: last(p.close), as_of: p.as_of, status: p.status });
    } else ind.error = p.error;
    return ind;
  }

  function buildTrend(p) {
    const ind = newIndicator("trend", "S&P 500 vs 200-day avg", "%",
      p.source + " · ^GSPC, 200-day simple moving average");
    if (!p.close || p.close.values.length < 210) {
      ind.error = p.error || "Not enough price history for a 200-day average";
      return ind;
    }
    const s = pctAboveMA(p.close);
    Object.assign(ind, { series: s, value: last(s), as_of: p.as_of, status: p.status });
    const ma = rollingMean(p.close.values, 200);
    ind.extra.price = last(p.close);
    ind.extra.ma200 = ma[ma.length - 1];
    return ind;
  }

  function buildBreadth(prices) {
    const first = prices[C.SECTOR_ETFS[0]] || Object.values(prices)[0];
    const ind = newIndicator("breadth", "Market breadth", "%",
      "Share of the 11 S&P 500 sector ETFs trading above their own 200-day average " +
      "(a simple breadth proxy). Prices: " + (first ? first.source : ""));
    const above = {}, statuses = [], stamps = [];
    for (const t of C.SECTOR_ETFS) {
      const p = prices[t];
      if (!p || !p.close || p.close.values.length < 210) continue;
      const pct = pctAboveMA(p.close);
      const m = new Map();
      pct.dates.forEach((d, i) => m.set(d, pct.values[i] > 0 ? 1 : 0));
      above[t] = m;
      statuses.push(p.status);
      stamps.push(p.as_of);
    }
    const tickers = Object.keys(above);
    if (tickers.length < 9) {
      ind.error = `Only ${tickers.length} of ${C.SECTOR_ETFS.length} sector ETFs available`;
      return ind;
    }
    // dates where every available sector has a value (like DataFrame.dropna())
    const allDates = [...new Set(tickers.flatMap((t) => [...above[t].keys()]))].sort();
    const d = [], v = [], counts = [];
    for (const date of allDates) {
      if (!tickers.every((t) => above[t].has(date))) continue;
      const c = tickers.reduce((a, t) => a + above[t].get(date), 0);
      d.push(date); v.push((c / tickers.length) * 100); counts.push(c);
    }
    if (!d.length) { ind.error = "Sector histories do not overlap"; return ind; }
    ind.series = { dates: d, values: v };
    ind.value = last(ind.series);
    ind.as_of = stamps.slice().sort()[0];
    ind.status = statuses.reduce((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a));
    ind.extra.count = counts[counts.length - 1];
    ind.extra.total = tickers.length;
    ind.extra.countSeries = counts;   // used when rebuilding history
    return ind;
  }

  function creditChange3m(series, idx) {
    // value at idx minus the last value on/before (date - 3 months)
    const cutoff = minusMonths(series.dates[idx], 3);
    for (let j = idx; j >= 0; j--) {
      if (series.dates[j] <= cutoff) return series.values[idx] - series.values[j];
    }
    return null;
  }

  function buildCredit(c, source) {
    const ind = newIndicator("credit", "High-yield credit spread", " pp", source);
    if (!c || !c.series || !c.series.values.length) {
      ind.error = (c && c.error) || "No data"; return ind;
    }
    Object.assign(ind, { series: c.series, value: last(c.series), as_of: c.as_of, status: c.status });
    const ch = creditChange3m(c.series, c.series.values.length - 1);
    if (ch !== null) ind.extra.change_3m = ch;
    return ind;
  }

  function buildFearGreed(fg, source) {
    const ind = newIndicator("fear_greed", "CNN Fear & Greed", "", source);
    if (!fg || fg.value === null || fg.value === undefined) {
      ind.error = (fg && fg.error) || "No data"; return ind;
    }
    Object.assign(ind, { value: fg.value, as_of: fg.as_of, status: fg.status, series: fg.series });
    ind.extra.rating = fg.rating || "";
    return ind;
  }

  function buildMarketData(demo, prices, fg, credit, fundamentals, meta) {
    const fgSrc = demo ? MOCK_SOURCE : "CNN Business Fear & Greed Index (unofficial public endpoint)";
    const hySrc = demo ? MOCK_SOURCE
      : "FRED, series BAMLH0A0HYM2 (ICE BofA US High Yield option-adjusted spread)";
    const indicators = {
      vix: buildVix(prices[C.VIX_TICKER]),
      fear_greed: buildFearGreed(fg, fgSrc),
      trend: buildTrend(prices[C.SP500_INDEX_TICKER]),
      breadth: buildBreadth(prices),
      credit: buildCredit(credit, hySrc),
    };
    const errors = Object.values(indicators).filter((i) => i.error).map((i) => `${i.name}: ${i.error}`);
    return { demo, prices, indicators, fundamentals, meta: meta || {}, errors };
  }

  // ---------------------------------------------------------------- live bundle
  const LIVE_PRICE_SOURCE = "Yahoo Finance (delayed)";

  /** Turn the file written by tools/update_data.py into the app's data structures. */
  function fromBundle(b) {
    const prices = {};
    const pd = (b && b.prices) || { dates: [], series: {}, meta: {} };
    for (const t of ALL_TICKERS) {
      const raw = pd.series ? pd.series[t] : null;
      const meta = (pd.meta && pd.meta[t]) || {};
      const p = { ticker: t, close: null, as_of: null, status: "unavailable",
        source: LIVE_PRICE_SOURCE, error: meta.error || (b ? "Ticker missing from data file" : "No data file") };
      if (raw) {
        const s = makeSeries(pd.dates, raw);
        if (s.values.length) {
          p.close = s; p.as_of = meta.as_of || null; p.error = "";
          // Re-check freshness NOW: the file may be old.
          p.status = freshnessStatus(p.as_of, false);
        }
      }
      prices[t] = p;
    }

    const f = (b && b.fear_greed) || {};
    const fg = { value: f.value ?? null, rating: f.rating || "", as_of: f.as_of || null,
      series: f.dates ? makeSeries(f.dates, f.values) : null,
      status: f.value !== null && f.value !== undefined ? freshnessStatus(f.as_of, true) : "unavailable",
      error: f.error || (b ? "" : "No data file") };

    const c = (b && b.credit) || {};
    const credit = { series: c.dates ? makeSeries(c.dates, c.values) : null, as_of: c.as_of || null,
      error: c.error || (b ? "" : "No data file") };
    credit.status = credit.series && credit.series.values.length ? freshnessStatus(credit.as_of, false) : "unavailable";

    const fundamentals = {};
    for (const t of Object.keys(C.STOCKS)) {
      const r = (b && b.fundamentals && b.fundamentals[t]) || null;
      fundamentals[t] = r && !r.error
        ? Object.assign({ ticker: t, status: "delayed", source: "Yahoo Finance", error: "" }, r,
          { forward_pe: r.forward_pe > 0 ? r.forward_pe : null })
        : { ticker: t, name: C.STOCKS[t].name, status: "unavailable", source: "Yahoo Finance",
          error: r ? r.error : "No data file" };
    }
    return buildMarketData(false, prices, fg, credit, fundamentals,
      { generated_at: b ? b.generated_at : null });
  }

  /** Load data/market.js by adding a <script> tag (works on GitHub Pages AND when
   *  index.html is opened straight from disk, unlike fetch()). */
  function loadLiveBundle() {
    return new Promise((resolve) => {
      const old = document.getElementById("market-data-script");
      if (old) old.remove();
      window.MARKET_DATA = undefined;
      const s = document.createElement("script");
      s.id = "market-data-script";
      s.src = "data/market.js?t=" + Date.now();  // skip cached copies
      s.onload = () => resolve(window.MARKET_DATA || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }

  // ---------------------------------------------------------------- MOCK data (demo mode only)
  const MOCK_SOURCE = "MOCK — invented demo data";
  const START_PRICES = { "^GSPC": 5000, SPY: 500, QQQ: 430, "^VIX": 16, MSFT: 420, GOOGL: 165,
    AMZN: 185, TSM: 170, RKLB: 22, MRVL: 75 };
  const MOCK_FUNDAMENTALS = {
    MSFT: { forward_pe: 31, trailing_pe: 36, price_to_sales: 12.5, revenue_growth: 0.15, profit_margin: 0.36 },
    GOOGL: { forward_pe: 21, trailing_pe: 24, price_to_sales: 6.4, revenue_growth: 0.13, profit_margin: 0.29 },
    AMZN: { forward_pe: 33, trailing_pe: 40, price_to_sales: 3.4, revenue_growth: 0.11, profit_margin: 0.09 },
    TSM: { forward_pe: 20, trailing_pe: 25, price_to_sales: 9.0, revenue_growth: 0.30, profit_margin: 0.40 },
    RKLB: { forward_pe: null, trailing_pe: null, price_to_sales: 25.0, revenue_growth: 0.40, profit_margin: -0.40 },
    MRVL: { forward_pe: 28, trailing_pe: null, price_to_sales: 11.0, revenue_growth: 0.35, profit_margin: -0.05 },
  };

  function rng(seed) {  // mulberry32 + Box-Muller: repeatable random numbers
    let a = seed >>> 0;
    const u = () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return (mean, sd) => mean + sd * Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
  }

  function businessDays(n) {
    const out = [];
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    while (out.length < n) {
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) out.push(isoDate(d));
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return out.reverse();
  }
  const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

  function mockMarketData() {
    const dates2y = businessDays(504), dates1y = dates2y.slice(-252);
    const now = new Date().toISOString();
    const prices = {};
    ALL_TICKERS.forEach((t, i) => {
      let values;
      if (t === "^VIX") {
        const r = rng(7);
        values = [16];
        for (let k = 1; k < dates2y.length; k++) {
          values.push(Math.max(10, values[k - 1] + 0.05 * (17 - values[k - 1]) + r(0, 1.1)));
        }
        const ramp = linspace(0, 6, 40);
        for (let k = 0; k < 40; k++) values[values.length - 40 + k] += ramp[k];
      } else {
        const r = rng(100 + i);
        const vol = t === "RKLB" || t === "MRVL" ? 0.025 : 0.011;
        let acc = 0;
        values = dates2y.map(() => { acc += r(0.0004, vol); return (START_PRICES[t] || 50 + 5 * i) * Math.exp(acc); });
        const ramp = linspace(1, 0.93, 40);
        for (let k = 0; k < 40; k++) values[values.length - 40 + k] *= ramp[k];
      }
      prices[t] = { ticker: t, close: { dates: dates2y, values }, as_of: now, status: "mock",
        source: MOCK_SOURCE, error: "" };
    });

    const r1 = rng(11);
    let acc = 0;
    const fgv = dates1y.map(() => { acc += r1(0, 3); return Math.min(95, Math.max(5, 50 + acc * 0.5)); });
    const tail = linspace(fgv[fgv.length - 40], 32, 40);
    for (let k = 0; k < 40; k++) fgv[fgv.length - 40 + k] = tail[k];
    const fg = { value: fgv[fgv.length - 1], rating: "Fear", as_of: now,
      series: { dates: dates1y, values: fgv }, status: "mock", error: "" };

    const r2 = rng(13);
    let a2 = 0;
    const hy = dates2y.map(() => { a2 += r2(0, 0.03); return Math.min(7, Math.max(2.6, 3.4 + a2)); });
    const ramp = linspace(0, 0.5, 40);
    for (let k = 0; k < 40; k++) hy[hy.length - 40 + k] += ramp[k];
    const credit = { series: { dates: dates2y, values: hy }, as_of: now, status: "mock", error: "" };

    const fundamentals = {};
    for (const t of Object.keys(C.STOCKS)) {
      fundamentals[t] = Object.assign({ ticker: t, name: C.STOCKS[t].name, status: "mock",
        source: MOCK_SOURCE, error: "", market_cap: null }, MOCK_FUNDAMENTALS[t] || {});
    }
    return buildMarketData(true, prices, fg, credit, fundamentals, { generated_at: null });
  }

  // ---------------------------------------------------------------- data quality summary
  function overallQuality(indicators) {
    const vals = Object.values(indicators);
    if (vals.some((i) => i.status === "mock")) {
      return ["MOCK DATA", "mock", "Demo mode — every number is invented, not real or current."];
    }
    const bad = vals.filter((i) => i.status === "unavailable" || i.status === "stale").map((i) => i.name);
    if (!bad.length) {
      const live = vals.every((i) => i.status === "live");
      return [live ? "Live" : "Delayed", "green",
        "All 5 indicators loaded. Data is updated about hourly on weekdays and is delayed."];
    }
    if (bad.length === vals.length) {
      if (vals.every((i) => i.status === "stale")) {
        return ["Stale", "amber", "All data is older than expected — the update job may have stopped. Check the Actions tab in GitHub."];
      }
      return ["Unavailable", "red", "No market data could be loaded."];
    }
    return ["Partial", "amber", "Missing or stale: " + bad.join(", ") + "."];
  }

  window.Data = {
    STATUS_LABELS, ALL_TICKERS, MOCK_SOURCE,
    usable, last, sliceLast, maSeries, rollingMean, freshnessStatus, minusMonths, creditChange3m,
    fromBundle, loadLiveBundle, mockMarketData, overallQuality,
  };
})();
