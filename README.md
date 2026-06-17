# X Cleaner Chrome Extension

Version: 0.6

Export your X Following list to CSV.

This project is a **fetch lab** for perfecting the GraphQL following-list code used by X Follower Remover.

## How it works

This extension uses **X's GraphQL API** (the same internal API the website uses), not DOM scraping. That means:

- Your tab does **not** need to navigate to profile or following pages
- The screen does **not** scroll or refresh while collecting
- Pagination happens in the **background** via API calls

You must have an open, logged-in `x.com` tab so the extension can use your session cookies.

## Installation
1. Open Chrome: `chrome://extensions/`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select this folder (`x_cleaner`)

## Usage
1. Keep a logged-in x.com tab open
2. Click the extension icon
3. Click **Start Collection**
4. Watch progress: `collected / total following`
5. Click **Export CSV** in the popup or the on-page panel when ready

Note: X changes API query IDs occasionally — the extension fetches current IDs from x.com on startup with fallbacks.