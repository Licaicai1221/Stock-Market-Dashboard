"""
Downloads market data and writes data/market.js for the static website.

This runs inside GitHub Actions on a schedule (see .github/workflows/update-data.yml),
so your phone never needs Python. You can also run it on your own computer:

    pip install -r tools/requirements.txt
    python tools/update_data.py

It only downloads raw data. All scoring happens in the browser (scoring.js), so
there is one set of rules. Download code is the same as core/data_live.py in the
Streamlit version. Nothing here is ever replaced by mock data: if a source fails,
the file records the error and the website shows "Unavailable".
"""
from __future__ import annotations

import io
import json
import math
import sys
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import requests

# Keep in sync with config.js
VIX_TICKER = "^VIX"
SP500_INDEX_TICKER = "^GSPC"
ETF_TICKERS = ["SPY", "QQQ"]
SECTOR_ETFS = ["XLK", "XLF", "XLV", "XLY", "XLP", "XLE", "XLI", "XLB", "XLU", "XLRE", "XLC"]
STOCKS = {"MSFT": "Microsoft", "GOOGL": "Alphabet", "AMZN": "Amazon",
          "TSM": "Taiwan Semiconductor", "RKLB": "Rocket Lab", "MRVL": "Marvell Technology"}
ALL_TICKERS = [VIX_TICKER, SP500_INDEX_TICKER] + ETF_TICKERS + SECTOR_ETFS + list(STOCKS)
HISTORY_YEARS = 2

OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "market.js"
ET = ZoneInfo("America/New_York")
TIMEOUT = 20
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}


def _iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def _bar_timestamp(bar_date: pd.Timestamp) -> datetime:
    """Timestamp for a daily bar: the 4 pm ET close, or 'now' for today's unfinished bar."""
    close_dt = datetime.combine(bar_date.date(), time(16, 0), tzinfo=ET)
    return min(close_dt, datetime.now(ET)).astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# Fetchers (same as core/data_live.py)
# ---------------------------------------------------------------------------
def fetch_prices(tickers: list[str], years: int) -> dict:
    """Returns {ticker: (series or None, as_of or None, error)}."""
    out = {t: (None, None, "") for t in tickers}
    try:
        import yfinance as yf
        raw = yf.download(tickers, period=f"{years}y", interval="1d", auto_adjust=True,
                          progress=False, group_by="column", threads=True)
    except Exception as exc:
        return {t: (None, None, f"Download failed: {exc}") for t in tickers}
    if raw is None or raw.empty or "Close" not in raw:
        return {t: (None, None, "No data returned by Yahoo Finance") for t in tickers}
    closes = raw["Close"]
    if isinstance(closes, pd.Series):
        closes = closes.to_frame(tickers[0])
    for t in tickers:
        if t not in closes:
            out[t] = (None, None, "Ticker missing from download")
            continue
        s = closes[t].dropna()
        if s.empty:
            out[t] = (None, None, "No prices returned")
            continue
        s.index = pd.to_datetime(s.index).tz_localize(None)
        out[t] = (s, _bar_timestamp(s.index[-1]), "")
    return out


FRED_HY_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2"


def fetch_hy_spread(years: int):
    """Returns (series in percentage points, as_of, error)."""
    try:
        r = requests.get(FRED_HY_URL, timeout=TIMEOUT, headers=BROWSER_HEADERS)
        r.raise_for_status()
        df = pd.read_csv(io.StringIO(r.text), na_values=".")
        s = pd.Series(df.iloc[:, 1].values, index=pd.to_datetime(df.iloc[:, 0]), dtype="float64").dropna()
    except Exception as exc:
        return None, None, f"FRED request failed: {exc}"
    if s.empty:
        return None, None, "FRED returned no values"
    s = s[s.index >= s.index[-1] - pd.DateOffset(years=years)]
    as_of = datetime.combine(s.index[-1].date(), time(17, 0), tzinfo=ET).astimezone(timezone.utc)
    return s, as_of, ""


CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata/{start}"


def fetch_fear_greed(years: int = 1):
    """Returns (value, rating, as_of, series, error)."""
    start = (datetime.now(timezone.utc) - timedelta(days=365 * years)).strftime("%Y-%m-%d")
    try:
        r = requests.get(CNN_URL.format(start=start), timeout=TIMEOUT, headers=BROWSER_HEADERS)
        r.raise_for_status()
        payload = r.json()
        fg = payload["fear_and_greed"]
        value = float(fg["score"])
        rating = str(fg.get("rating", "")).title()
        ts = pd.Timestamp(fg["timestamp"])
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        hist = payload.get("fear_and_greed_historical", {}).get("data", [])
        series = None
        if hist:
            idx = pd.to_datetime([p["x"] for p in hist], unit="ms").normalize()
            series = pd.Series([float(p["y"]) for p in hist], index=idx)
            series = series[~series.index.duplicated(keep="last")].sort_index()
    except Exception as exc:
        return None, "", None, None, f"CNN request failed: {exc}"
    return value, rating, ts.to_pydatetime(), series, ""


def _num(info: dict, key: str):
    try:
        v = float(info.get(key))
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def fetch_fundamentals(ticker: str) -> dict:
    try:
        import yfinance as yf
        info = yf.Ticker(ticker).info or {}
    except Exception as exc:
        return {"error": f"Fundamentals request failed: {exc}"}
    if len(info) < 5:
        return {"error": "No fundamentals returned"}
    fpe = _num(info, "forwardPE")
    return {
        "name": info.get("shortName") or info.get("longName") or STOCKS.get(ticker, ticker),
        "forward_pe": fpe if fpe is not None and fpe > 0 else None,
        "trailing_pe": _num(info, "trailingPE"),
        "price_to_sales": _num(info, "priceToSalesTrailing12Months"),
        "revenue_growth": _num(info, "revenueGrowth"),
        "profit_margin": _num(info, "profitMargins"),
        "market_cap": _num(info, "marketCap"),
        "error": "",
    }


# ---------------------------------------------------------------------------
# Bundle
# ---------------------------------------------------------------------------
def _clean(v, digits):
    if v is None:
        return None
    v = float(v)
    return round(v, digits) if math.isfinite(v) else None


def _series_json(s: pd.Series | None, digits: int):
    if s is None or s.empty:
        return None, None
    return [d.strftime("%Y-%m-%d") for d in s.index], [_clean(v, digits) for v in s.values]


def build_bundle(prices: dict, fg: tuple, hy: tuple, fundamentals: dict) -> dict:
    """prices: {ticker: (series, as_of, error)}; fg: (value, rating, as_of, series, error);
    hy: (series, as_of, error); fundamentals: {ticker: dict}."""
    good = [s for s, _, _ in prices.values() if s is not None]
    all_dates = sorted(set().union(*[set(s.index) for s in good])) if good else []
    series, meta = {}, {}
    for t, (s, as_of, err) in prices.items():
        meta[t] = {"as_of": _iso(as_of), "error": err}
        if s is not None:
            aligned = s.reindex(all_dates)
            digits = 2 if t != VIX_TICKER else 2
            series[t] = [None if pd.isna(v) else _clean(v, digits) for v in aligned.values]

    fg_value, fg_rating, fg_asof, fg_series, fg_err = fg
    fg_dates, fg_vals = _series_json(fg_series, 1)
    hy_series, hy_asof, hy_err = hy
    hy_dates, hy_vals = _series_json(hy_series, 2)
    return {
        "schema": 1,
        "generated_at": _iso(datetime.now(timezone.utc)),
        "prices": {"dates": [d.strftime("%Y-%m-%d") for d in all_dates], "series": series, "meta": meta},
        "fear_greed": {"value": _clean(fg_value, 1), "rating": fg_rating, "as_of": _iso(fg_asof),
                       "dates": fg_dates, "values": fg_vals, "error": fg_err},
        "credit": {"as_of": _iso(hy_asof), "dates": hy_dates, "values": hy_vals, "error": hy_err},
        "fundamentals": fundamentals,
    }


def write_bundle(bundle: dict, path: Path = OUT_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(bundle, separators=(",", ":"), allow_nan=False)
    path.write_text(
        "// Written automatically by tools/update_data.py — do not edit by hand.\n"
        f"window.MARKET_DATA = {text};\n", encoding="utf-8")


def main() -> int:
    prices = fetch_prices(ALL_TICKERS, HISTORY_YEARS)
    fg = fetch_fear_greed(1)
    hy = fetch_hy_spread(HISTORY_YEARS)
    fundamentals = {t: fetch_fundamentals(t) for t in STOCKS}
    bundle = build_bundle(prices, fg, hy, fundamentals)

    ok_prices = sum(1 for s, _, _ in prices.values() if s is not None)
    print(f"Prices: {ok_prices}/{len(ALL_TICKERS)} tickers")
    print("Fear & Greed:", "ok" if fg[0] is not None else fg[4])
    print("Credit spread:", "ok" if hy[0] is not None else hy[2])
    print("Fundamentals:", sum(1 for f in fundamentals.values() if not f.get("error")), "/", len(STOCKS))

    if ok_prices == 0 and fg[0] is None and hy[0] is None and OUT_PATH.exists():
        # Every source failed: keep the previous file. The website will mark it Stale
        # once it is old enough, rather than showing nothing.
        print("All sources failed; keeping the previous data file.")
        return 1
    write_bundle(bundle)
    print("Wrote", OUT_PATH)
    return 0


if __name__ == "__main__":
    sys.exit(main())
