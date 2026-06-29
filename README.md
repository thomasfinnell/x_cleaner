# X Cleaner Chrome Extension

Version: 0.99

**v0.99.2 changes:** Core REST fetch is now more robust (adaptive rate limiting with header respect, progressive backoff using server reset times, light jitter on delays) while keeping all existing behavior.

Export your X (Twitter) **Following** and **Followers** lists to CSV. Filter lists (mutuals, inactive, bots, etc.) and load CSV files for offline editing or handoff to [X Follower Remover](https://github.com/thomasfinnell/X-follower-Remover).

## How it works

This extension uses **X's internal APIs** (GraphQL and REST), not DOM scraping. That means:

- Your tab does **not** need to navigate to profile or following pages
- The screen does **not** scroll or refresh while collecting
- Pagination happens in the **background** via API calls

You must have an open, logged-in `x.com` tab so the extension can use your session cookies.

## Installation

1. Open Chrome: `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder (`x_cleaner`), or a copy built with `pack-local.ps1`

Do not drag a `.crx` onto Chrome — modern Chrome blocks sideloaded CRX files.

## Usage

1. Keep a logged-in x.com tab open
2. Click the extension icon (or use the on-page HUD panel)
3. Leave **Fast** unchecked for gentle overnight pacing (default). Check **Fast** only if you need speed and accept possible reduced reach on X.
4. Choose **Following** or **Followers**, then **Start Collection**
5. Optionally run **Filter** (remove mutuals, blue checks, inactive accounts, bots)
6. **Export CSV** when ready (requires @d2fl subscription), or use **Load CSV** to replace/append a list from a prior export

Free tier: fetch and CSV import are capped at 200 records. Subscribe to [@d2fl on X](https://x.com/d2fl/creator-subscriptions/subscribe) for unlimited fetch/export.

Note: X changes API query IDs occasionally — the extension fetches current IDs from x.com on startup with fallbacks.

See **[FLOWCHART.md](FLOWCHART.md)** for high-level Mermaid flows (Fast riskier bulk mode vs Gentle low-risk/overnight; cross-mutual population on collect + CSV; per-branch fresh start; filters; sub gate; account isolation). No low-level fetch details.