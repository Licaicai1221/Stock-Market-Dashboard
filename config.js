/*
 * All tunable settings: tickers, weights, thresholds and data-freshness rules.
 * Same values as config.py in the Python version.
 *
 * Beginner tip: change numbers here, save, and reload the page.
 * If you change TICKERS, also change them in tools/update_data.py so they get downloaded.
 */
window.CONFIG = {
  VIX_TICKER: "^VIX",
  SP500_INDEX_TICKER: "^GSPC",

  // key: [ticker, display name, short description]
  ETFS: {
    sp500: ["SPY", "S&P 500", "500 large US companies"],
    nasdaq100: ["QQQ", "Nasdaq-100", "100 large non-financial Nasdaq companies"],
  },

  // 11 S&P 500 sector ETFs, a simple market-breadth proxy
  SECTOR_ETFS: ["XLK", "XLF", "XLV", "XLY", "XLP", "XLE", "XLI", "XLB", "XLU", "XLRE", "XLC"],

  // Your watchlist. "risk" is a short editorial note YOU maintain — it is not live data.
  STOCKS: {
    MSFT: { name: "Microsoft", risk: "Very high AI spending must turn into revenue growth." },
    GOOGL: { name: "Alphabet", risk: "Search ads could lose share to AI assistants; regulation." },
    AMZN: { name: "Amazon", risk: "Thin retail margins; heavy capex on AWS and AI." },
    TSM: { name: "Taiwan Semiconductor", risk: "Geopolitical risk around Taiwan; chip cycle swings." },
    RKLB: { name: "Rocket Lab", risk: "Not yet profitable; depends on new rocket (Neutron) succeeding." },
    MRVL: { name: "Marvell Technology", risk: "Revenue concentrated in a few large AI/cloud customers." },
  },

  // ---------------- Market Opportunity Score ----------------
  // Higher = market more fearful / cheaper. NOT a prediction, NOT a guarantee.
  // Set a weight to 0 to switch an indicator off.
  WEIGHTS: { vix: 0.20, fear_greed: 0.20, trend: 0.25, breadth: 0.15, credit: 0.20 },

  // [indicator value, sub-score] points, joined by straight lines
  SUBSCORE_CURVES: {
    vix: [[12, 15], [16, 35], [20, 50], [25, 65], [30, 80], [40, 95]],
    fear_greed: [[0, 100], [25, 80], [50, 50], [75, 20], [100, 0]],
    trend: [[-15, 95], [-8, 85], [-3, 70], [0, 55], [3, 45], [8, 30], [12, 15]],
    breadth: [[10, 90], [30, 75], [50, 55], [70, 40], [90, 25]],
    credit: [[2.5, 20], [3.5, 40], [4.5, 60], [6.0, 75], [8.0, 90]],
  },

  // [minimum score, status label, colour level]
  SCORE_BANDS: [
    [65, "Fearful market — opportunity", "green"],
    [35, "Neutral market", "amber"],
    [0, "Calm / greedy market", "red"],
  ],

  // ---------------- Market Risk Warning (separate from the score) ----------------
  RISK_RULES: {
    vix_above: 30,
    trend_below_ma: true,
    breadth_below: 30,
    credit_above: 5.0,
    credit_widening_3m: 1.0,
  },
  // [number of flags, label, colour level]
  RISK_LEVELS: [[2, "High", "red"], [1, "Elevated", "amber"], [0, "Low", "green"]],

  // ---------------- ETFs: drawdown from 52-week high ----------------
  DRAWDOWN_BANDS: [
    [20, "Bear-market drop", "green"],
    [10, "Correction", "green"],
    [5, "Pullback", "amber"],
    [0, "Near highs", "red"],
  ],

  // ---------------- Stocks ----------------
  STOCK_WEIGHTS: { valuation: 0.4, drawdown: 0.3, trend: 0.3 },
  STOCK_CURVES: {
    forward_pe: [[10, 90], [18, 70], [25, 50], [35, 30], [60, 10]],
    price_to_sales: [[2, 85], [5, 65], [10, 45], [20, 25], [40, 10]],
    drawdown: [[0, 20], [10, 45], [20, 65], [35, 85], [50, 95]],
    trend: [[-25, 80], [-10, 65], [0, 50], [15, 35], [30, 20]],
  },
  VALUATION_LABELS: {
    forward_pe: [[35, "Expensive", "red"], [22, "Full", "amber"], [0, "Reasonable", "green"]],
    price_to_sales: [[20, "Expensive", "red"], [8, "Full", "amber"], [0, "Reasonable", "green"]],
  },

  // ---------------- Data freshness ----------------
  LIVE_MAX_MINUTES: 20,     // newer -> "Live" (real-time sources only)
  STALE_AFTER_HOURS: 96,    // older -> "Stale" (covers normal weekends)
};
