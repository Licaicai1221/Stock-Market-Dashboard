# US Market Dashboard — static website for GitHub Pages

The browser version of the Streamlit dashboard: the same screens, scoring rules and labels,
written in plain HTML, CSS and JavaScript. Personal research tool — not financial advice,
never places orders.

## How it works

```
GitHub Action (runs on GitHub's computers, about hourly on weekdays)
   └─ tools/update_data.py downloads Yahoo Finance, FRED and CNN data
        └─ saves data/market.js in your repository
             └─ your phone opens the website, which reads data/market.js
                  └─ config.js + scoring.js calculate every score in the browser
```

A web page can't download from Yahoo, FRED or CNN itself; those sites block requests from other
websites' pages. The Action does the downloading instead. No API keys are needed anywhere.
Data on the site is therefore **delayed by up to about an hour** during US market hours.

## Files (keep this exact folder layout)

```
index.html                      the page
style.css                       look and layout
config.js                       tickers, weights, thresholds, your stock risk notes — edit here
data.js                         reads data/market.js, data labels, Demo-mode data
scoring.js                      all scoring rules (same as core/scoring.py)
script.js                       draws the four screens and charts
lib/chart.umd.min.js            Chart.js 4.5.1 (chart library, MIT licence)
data/market.js                  market data, written by the Action (starts as an empty placeholder)
tools/update_data.py            the downloader the Action runs
tools/requirements.txt          Python packages for the downloader
.github/workflows/update-data.yml   the schedule for the Action
.nojekyll                       tells GitHub Pages to serve files as they are (optional)
README.md
```

## Try it on your computer first

Double-click `index.html`. Before the first data download it shows "No market data file yet".
Open **Settings → Demo mode** to explore with clearly labelled invented data.

## Put it on GitHub Pages

1. **Create the repository.** On github.com click **+ → New repository**. Name it, for example,
   `market-dashboard`. Choose **Public** (free GitHub Pages needs a public repository — see the
   note at the end). Click **Create repository**.

2. **Upload the files.** On the new repository page click **uploading an existing file**. Open the
   unzipped folder on your computer, select everything inside it (not the folder itself) and drag it
   into the browser. Click **Commit changes**.
   - Check that `lib/chart.umd.min.js`, `data/market.js` and `tools/update_data.py` appear in
     their folders.
   - **The `.github` folder is hidden on Mac and often on Windows, so it is easy to miss.** If you
     don't see `.github/workflows/update-data.yml` in the repository, click **Add file → Create new
     file**, type the name `.github/workflows/update-data.yml` (the slashes create the folders),
     paste in the contents of that file, and click **Commit changes**.

3. **Turn on GitHub Pages.** Go to **Settings → Pages**. Under *Build and deployment*, set
   **Source: Deploy from a branch**, **Branch: main**, folder **/ (root)**, then **Save**.
   After a minute or two the page shows your address:
   `https://YOUR-USERNAME.github.io/market-dashboard/`

4. **Download the data the first time.** Go to the **Actions** tab. If asked, click the button to
   enable workflows. Click **Update market data → Run workflow → Run workflow**. Wait for a green
   tick (about 1–2 minutes), wait another minute for Pages to update, then open your site.
   - Red cross with "Permission denied" or "403" when saving: go to **Settings → Actions → General →
     Workflow permissions**, choose **Read and write permissions**, **Save**, and run it again.
   - Red cross after "All sources failed": the data sites refused GitHub's servers at that moment.
     The next scheduled run usually works.

5. **Add it to your phone's home screen.** Open the address on your phone.
   iPhone (Safari): **Share → Add to Home Screen**. Android (Chrome): **⋮ → Add to Home screen**.

After this the Action runs by itself on weekdays. Each run saves a new `data/market.js`, and the
website shows when that file was written (Settings at the bottom of every screen).

## Data labels

**Live** (minutes old) · **Delayed** (normal here) · **Stale** (older than 96 hours — the Action has
probably stopped) · **Unavailable** · **MOCK DATA** (Demo mode only). The score is shown only when all
five indicators are fresh; otherwise it says "Incomplete data". Demo data is never mixed with real data.

## Changing things

- Weights, thresholds, stock risk notes: edit `config.js` on GitHub (open the file, pencil icon,
  **Commit changes**). The site updates within a minute or two.
- Adding or removing a stock: change `STOCKS` in **both** `config.js` and `tools/update_data.py`,
  then run the Action once.

## Differences from the Streamlit version

- Data is downloaded by the scheduled Action, not when you open the page.
- The signal log is rebuilt from the indicator history (one entry each time the market status or
  risk level changed). The Streamlit version saved a row each day you opened it; a static site can't
  save files.
- When every indicator is stale, the data badge now says "Stale" instead of "Unavailable".

## Good to know

- **Public repository.** On a free account, GitHub Pages sites are public, and so is the repository
  — anyone with the link can see the dashboard and your stock risk notes. There are no passwords or
  keys in it.
- **Paused schedules.** GitHub may pause scheduled Actions in a repository with no activity for 60
  days and sends you an email first. Re-enable it on the Actions tab.
- **Fragile free sources.** CNN's Fear & Greed endpoint is unofficial and can break. If it does, set
  `fear_greed: 0` in `WEIGHTS` in `config.js` to score without it.
