/*
 * SCORING — pure functions, no page drawing, no downloading.
 * A direct port of core/scoring.py: same curves, bands, rules and wording.
 *
 * Colour levels used everywhere:
 *   green = more favourable for a long-term buyer
 *   amber = neutral / caution
 *   red   = less favourable, or higher risk
 */
(function () {
  const C = window.CONFIG;
  const D = window.Data;

  /** Straight-line interpolation, clamped at both ends (like numpy.interp). */
  function interp(x, curve) {
    if (x <= curve[0][0]) return curve[0][1];
    for (let i = 1; i < curve.length; i++) {
      const [x1, y1] = curve[i], [x0, y0] = curve[i - 1];
      if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
    return curve[curve.length - 1][1];
  }

  /** bands: [[minimum, label, level], ...] sorted high -> low */
  function band(value, bands) {
    for (const [min, label, level] of bands) if (value >= min) return [label, level];
    const b = bands[bands.length - 1];
    return [b[1], b[2]];
  }

  // ---------------------------------------------------------------- per-indicator labels
  function indicatorLabel(ind) {
    const v = ind.value;
    if (v === null || v === undefined) return ["No data", "none"];
    switch (ind.key) {
      case "vix":
        if (v >= 30) return ["High fear", "green"];
        if (v >= 20) return ["Worried", "green"];
        if (v >= 15) return ["Normal", "amber"];
        return ["Calm", "red"];
      case "fear_greed":
        if (v < 25) return ["Extreme fear", "green"];
        if (v < 45) return ["Fear", "green"];
        if (v <= 55) return ["Neutral", "amber"];
        if (v <= 75) return ["Greed", "red"];
        return ["Extreme greed", "red"];
      case "trend":
        if (v < -3) return ["Below trend", "green"];
        if (v < 3) return ["Near trend", "amber"];
        if (v < 10) return ["Above trend", "amber"];
        return ["Stretched", "red"];
      case "breadth":
        if (v < 30) return ["Weak (washed out)", "green"];
        if (v < 70) return ["Mixed", "amber"];
        return ["Broad uptrend", "red"];
      case "credit":
        if (v >= 5) return ["Stress", "green"];
        if (v >= 4) return ["Widening", "amber"];
        return ["Calm", "red"];
    }
    return ["", "none"];
  }

  function reasonText(ind) {
    const v = ind.value;
    switch (ind.key) {
      case "vix":
        return `VIX at ${v.toFixed(1)} — ${indicatorLabel(ind)[0].toLowerCase()} level of expected volatility.`;
      case "fear_greed": {
        const r = (ind.extra && ind.extra.rating) || indicatorLabel(ind)[0];
        return `CNN Fear & Greed at ${v.toFixed(0)} (${r.toLowerCase()}).`;
      }
      case "trend":
        return `S&P 500 is ${Math.abs(v).toFixed(1)}% ${v >= 0 ? "above" : "below"} its 200-day average.`;
      case "breadth":
        return `${ind.extra.count} of ${ind.extra.total} sectors are above their 200-day average.`;
      case "credit": {
        const ch = ind.extra ? ind.extra.change_3m : undefined;
        const tail = ch === undefined || ch === null ? ""
          : ch > 0.25 ? " and widening" : ch < -0.25 ? " and narrowing" : ", stable";
        return `High-yield credit spread at ${v.toFixed(2)} pp${tail}.`;
      }
    }
    return "";
  }

  // ---------------------------------------------------------------- Market Opportunity Score
  function computeMarketScore(indicators) {
    let totalW = 0;
    for (const w of Object.values(C.WEIGHTS)) totalW += w;
    const comps = {}, missing = [];
    let usedW = 0, acc = 0;
    for (const [key, w] of Object.entries(C.WEIGHTS)) {
      if (w <= 0) continue;  // weight 0 = switched off
      const ind = indicators[key];
      if (!D.usable(ind)) { comps[key] = null; missing.push(ind ? ind.name : key); continue; }
      const sub = interp(ind.value, C.SUBSCORE_CURVES[key]);
      comps[key] = sub; usedW += w; acc += w * sub;
    }
    const partial = usedW ? acc / usedW : null;
    const ms = { valid: missing.length === 0, score: null, partial_score: partial,
      coverage: totalW ? usedW / totalW : 0, components: comps,
      status: "Incomplete data", level: "none", missing };
    if (ms.valid) {
      ms.score = partial;
      [ms.status, ms.level] = band(partial, C.SCORE_BANDS);
    }
    return ms;
  }

  // ---------------------------------------------------------------- Risk warning
  function computeRisk(indicators) {
    const r = C.RISK_RULES, flags = [];
    const { vix, trend, breadth, credit } = indicators;
    if (D.usable(vix) && vix.value > r.vix_above) flags.push(`VIX above ${r.vix_above}`);
    if (r.trend_below_ma && D.usable(trend) && trend.value < 0) flags.push("S&P 500 below its 200-day average");
    if (D.usable(breadth) && breadth.value < r.breadth_below) flags.push("Few sectors in an uptrend");
    if (D.usable(credit)) {
      if (credit.value > r.credit_above) flags.push(`Credit spreads above ${r.credit_above.toFixed(0)} pp`);
      const ch = credit.extra.change_3m;
      if (ch !== undefined && ch !== null && ch > r.credit_widening_3m) flags.push("Credit spreads widening fast");
    }
    const complete = [vix, trend, breadth, credit].every((i) => D.usable(i));
    let label = "Low", level = "green";
    for (const [min, lab, lev] of C.RISK_LEVELS) {
      if (flags.length >= min) { label = lab; level = lev; break; }
    }
    if (!complete && !flags.length) { label = "Unknown"; level = "none"; }
    return { label, level, flags, complete };
  }

  // ---------------------------------------------------------------- Suggested action
  function suggestAction(ms, risk, indicators) {
    if (!ms.valid) {
      return { action: "Keep your regular investing plan. Don't change it based on incomplete data.",
        reasons: [`Missing or stale: ${ms.missing.join(", ")}.`] };
    }
    let action;
    if (ms.level === "green") {
      action = risk.level === "green"
        ? "Continue regular investing. Adding extra to ETFs, in small steps, is reasonable to consider."
        : "Continue regular investing. If you add extra, spread it over several weeks — market stress is high.";
    } else if (ms.level === "amber") {
      action = "Continue regular investing as planned.";
    } else {
      action = "Continue regular investing. No signal to add extra now — avoid chasing recent winners.";
    }
    // the indicators pushing the score most in the direction of its band (stable sort, like Python)
    const scored = Object.entries(ms.components).filter(([, s]) => s !== null);
    if (ms.level === "green") scored.sort((a, b) => b[1] - a[1]);
    else if (ms.level === "red") scored.sort((a, b) => a[1] - b[1]);
    else scored.sort((a, b) => Math.abs(b[1] - 50) - Math.abs(a[1] - 50));
    let reasons = scored.slice(0, 2).map(([k]) => reasonText(indicators[k]));
    if (risk.level === "red") {
      reasons = [`Risk warning: ${risk.flags.slice(0, 2).join(", ").toLowerCase()}.`].concat(reasons.slice(0, 1));
    }
    return { action, reasons };
  }

  // ---------------------------------------------------------------- Historical (rebuilt) score
  /**
   * Daily score rebuilt from each indicator's history. Only days where ALL active
   * indicators have a value are kept (gaps of up to 3 rows are carried forward, for
   * holidays and publication lags), weekdays only. Same as score_history() in Python.
   * Returns { dates, score, values: {key: [...]}, subs: {key: [...]} } or null.
   */
  function scoreHistory(indicators) {
    const active = Object.entries(C.WEIGHTS).filter(([, w]) => w > 0);
    const maps = {};
    for (const [key] of active) {
      const ind = indicators[key];
      if (!ind || !ind.series || !ind.series.values.length) return null;
      const m = new Map();
      ind.series.dates.forEach((d, i) => m.set(d, ind.series.values[i]));
      maps[key] = m;
    }
    const allDates = [...new Set(Object.values(maps).flatMap((m) => [...m.keys()]))].sort();
    const lastVal = {}, gap = {};
    const out = { dates: [], score: [], values: {}, subs: {} };
    active.forEach(([k]) => { out.values[k] = []; out.subs[k] = []; lastVal[k] = null; gap[k] = 0; });
    const wSum = active.reduce((a, [, w]) => a + w, 0);
    for (const date of allDates) {
      const row = {};
      let complete = true;
      for (const [k] of active) {
        if (maps[k].has(date)) { lastVal[k] = maps[k].get(date); gap[k] = 0; }
        else if (lastVal[k] !== null) gap[k] += 1;
        row[k] = lastVal[k] !== null && gap[k] <= 3 ? lastVal[k] : null;
        if (row[k] === null) complete = false;
      }
      const wd = new Date(date + "T00:00:00Z").getUTCDay();
      if (!complete || wd === 0 || wd === 6) continue;
      let acc = 0;
      for (const [k, w] of active) {
        const s = interp(row[k], C.SUBSCORE_CURVES[k]);
        out.values[k].push(row[k]); out.subs[k].push(s); acc += w * s;
      }
      out.dates.push(date);
      out.score.push(acc / wSum);
    }
    return out.dates.length ? out : null;
  }

  /**
   * Signal log, rebuilt from history: one entry each time the market status or the
   * risk level changed. Uses the same score, risk and action rules as "today".
   */
  function signalLog(indicators, hist) {
    if (!hist) return [];
    const credit = indicators.credit, breadth = indicators.breadth;
    const creditIdx = new Map((credit.series ? credit.series.dates : []).map((d, i) => [d, i]));
    const breadthIdx = new Map((breadth.series ? breadth.series.dates : []).map((d, i) => [d, i]));
    const entries = [];
    let prevKey = null;
    hist.dates.forEach((date, i) => {
      const day = {};
      for (const k of Object.keys(hist.values)) {
        day[k] = { key: k, name: indicators[k].name, value: hist.values[k][i], status: "delayed", extra: {} };
      }
      if (day.credit && creditIdx.has(date)) {
        const ch = D.creditChange3m(credit.series, creditIdx.get(date));
        if (ch !== null) day.credit.extra.change_3m = ch;
      }
      if (day.breadth) {
        const bi = breadthIdx.get(date);
        day.breadth.extra.total = breadth.extra.total;
        day.breadth.extra.count = bi !== undefined ? breadth.extra.countSeries[bi]
          : Math.round((day.breadth.value / 100) * breadth.extra.total);
      }
      // indicators switched off (weight 0) still need an entry for the risk rules
      for (const k of ["vix", "trend", "breadth", "credit", "fear_greed"]) {
        if (!day[k]) day[k] = { key: k, name: indicators[k].name, value: null, status: "unavailable", extra: {} };
      }
      const ms = computeMarketScore(day);
      const risk = computeRisk(day);
      const key = ms.status + "|" + risk.label;
      if (key !== prevKey) {
        const sug = suggestAction(ms, risk, day);
        entries.push({ date, score: ms.score, status: ms.status, level: ms.level, risk: risk.label,
          action: sug.action, reasons: sug.reasons.join(" ") });
        prevKey = key;
      }
    });
    return entries.slice(1).reverse();  // the first row is just the start of the data
  }

  // ---------------------------------------------------------------- ETFs and stocks
  function priceStats(p) {
    const s = p && p.close;
    if (!s || !s.values.length) return null;
    const v = s.values, n = v.length, lastV = v[n - 1];
    const high = Math.max(...v.slice(-252));
    const out = {
      last: lastV, high_52w: high, drawdown: (1 - lastV / high) * 100,
      ret_1m: n > 22 ? (lastV / v[n - 22] - 1) * 100 : null,
      ret_1y: n > 252 ? (lastV / v[n - 252] - 1) * 100 : null,
      vs_ma200: null,
    };
    if (n >= 200) {
      const ma = D.rollingMean(v, 200);
      out.vs_ma200 = (lastV / ma[n - 1] - 1) * 100;
    }
    return out;
  }

  /** Descriptive only (no colour): an uptrend is not automatically good or bad. */
  function trendLabel(st) {
    const v = st.vs_ma200, m = st.ret_1m;
    if (v === null) return "Trend unknown";
    if (v > 0 && (m === null || m >= 0)) return "↗ Uptrend";
    if (v < 0 && (m === null || m <= 0)) return "↘ Downtrend";
    return "→ Mixed";
  }

  function etfAssessment(p, ms) {
    const st = priceStats(p);
    if (!st) return { stats: null, suggestion: "No price data — keep your regular contribution." };
    const [ddLabel, ddLevel] = band(st.drawdown, C.DRAWDOWN_BANDS);
    let sugg;
    if (!ms.valid) sugg = "Keep your regular contribution. The market score is incomplete today.";
    else if (st.drawdown >= 10 && ms.score >= 50) {
      sugg = "Keep your regular contribution. Price is well below its high — an extra amount, in steps, is reasonable to consider.";
    } else if (st.drawdown < 5 && ms.score < 35) {
      sugg = "Keep your regular contribution only. Price is near its high and the market is calm.";
    } else sugg = "Keep your regular contribution.";
    return { stats: st, dd_label: ddLabel, dd_level: ddLevel, trend: trendLabel(st), suggestion: sugg };
  }

  function stockAssessment(p, f) {
    const st = priceStats(p);
    const res = { stats: st, trend: st ? trendLabel(st) : "No price data", valid: false, score: null,
      level: "none", missing: [], parts: {} };
    let metric = null, val = null;
    if (f.forward_pe !== null && f.forward_pe !== undefined) {
      metric = "forward_pe"; val = f.forward_pe; res.val_text = `Forward P/E ${val.toFixed(0)}`;
    } else if (f.price_to_sales !== null && f.price_to_sales !== undefined) {
      metric = "price_to_sales"; val = f.price_to_sales;
      res.val_text = `Price/Sales ${val.toFixed(1)} (no meaningful P/E)`;
    } else res.val_text = "Valuation data unavailable";
    if (metric) [res.val_label, res.val_level] = band(val, C.VALUATION_LABELS[metric]);
    else { res.val_label = "Unknown"; res.val_level = "none"; }

    const parts = res.parts;
    if (metric) parts.valuation = interp(val, C.STOCK_CURVES[metric]);
    else res.missing.push("valuation");
    if (st) {
      parts.drawdown = interp(st.drawdown, C.STOCK_CURVES.drawdown);
      if (st.vs_ma200 !== null) parts.trend = interp(st.vs_ma200, C.STOCK_CURVES.trend);
      else res.missing.push("200-day trend");
    } else res.missing.push("price");

    const usablePrice = ["live", "delayed", "mock"].includes(p.status);
    if (!usablePrice && st) res.missing.push("fresh price");
    const w = C.STOCK_WEIGHTS;
    if (Object.keys(parts).length === Object.keys(w).length && usablePrice) {
      let acc = 0, ws = 0;
      for (const k of Object.keys(w)) { acc += parts[k] * w[k]; ws += w[k]; }
      res.score = acc / ws;
      res.valid = true;
      res.level = band(res.score, C.SCORE_BANDS)[1];
    }
    if (!res.valid) res.next_step = "Not enough data to score. Check the company's latest report before deciding anything.";
    else if (res.score >= 65) res.next_step = "Worth researching: read the latest earnings report and check whether the main risk has changed.";
    else if (res.score >= 35) res.next_step = "Keep on your watchlist and re-check after the next earnings report.";
    else res.next_step = "No action: price looks stretched. Wait for a better entry or stick with ETFs.";
    return res;
  }

  window.Scoring = {
    interp, band, indicatorLabel, reasonText, computeMarketScore, computeRisk, suggestAction,
    scoreHistory, signalLog, priceStats, trendLabel, etfAssessment, stockAssessment,
  };
})();
