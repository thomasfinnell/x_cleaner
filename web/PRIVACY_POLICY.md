# Privacy Policy — X Cleaner

**Operated by:** d2fl  
**Effective date:** June 21, 2026  
**Last updated:** June 21, 2026

**Public URL (Chrome Web Store):** https://d2fl.com/cleaner/privacy-policy.html

A ready-to-host HTML version can be generated from this MD or similar to remover.

---

## Summary

The X Cleaner Chrome Extension stores your lists and settings **locally in your browser**. It interacts with **X (x.com)** only while you use it. We do **not** sell your data or run separate advertising/analytics services for this Extension.

---

## 1. Information we process

- **Your X account handle** — from an open, logged-in X tab when you claim it
- **List data** — usernames/profiles from collection (following or followers) or CSV you load
- **Enrichment data** — last post times, bio, counts, flags (mutual, blue, bot signals) computed locally
- **Activity / status logs** — timestamps and results of collections/filters (local only)
- **Extension settings** — fetch mode (Fast riskier vs Gentle), fresh start per-branch, filter prefs, delays
- **Usage limits** — local free-tier counters
- **Subscription status** — Pro eligibility cached locally (X @d2fl subscription check or built-in owner accounts)
- **X session data** — cookies/session used only in your browser to verify subscription status on X; not sent to d2fl servers

## 2. Where data is stored

- **chrome.storage.local** — lists per type, settings, logs, usage, subscription cache, enrich archive (persists until cleared or uninstall)
- **chrome.storage.session** — short-lived session flags (cleared when the browser session ends)

We do not operate a central server database for your lists or logs.

## 3. How we use information

- Collect and manage your X lists (following / followers)
- Cross-populate mutual flags when collecting one side if user already in other
- Run filters (mutuals, verified, inactive last-post for Following only, bots for Followers only)
- Save progress for pause/resume across restarts
- Enforce limits shown in the UI
- Determine Pro status for full export
- Display status in the popup and HUD
- Hydrate prior enrichments on fresh start for the selected branch only

## 4. Network activity and third parties

The Extension communicates with **X (x.com / twitter.com)** only. It does not upload your lists, logs, or personal data to d2fl during normal operation.

Clicking **Subscribe @d2fl for unlimited** opens X’s website; X’s policies apply there. We are not affiliated with X Corp.

Fast mode uses more aggressive X API calls (higher risk of temporary limits); Gentle mode uses page-native signals for lower profile.

## 5. Permissions

| Permission | Purpose |
|------------|---------|
| storage | Save lists, settings, progress, caches locally (per-branch) |
| tabs | Open/focus X tab, handoff to HUD |
| scripting | Run actions / capture on X when you start a session |
| activeTab | Interact with your active X tab |
| cookies | Read X session cookies for subscription verification |
| x.com / twitter.com | Required for all Extension functionality |

## 6. Data sharing and sale

We do **not** sell or share your data for marketing. Data stays on your device unless you export a CSV yourself. Cross-branch mutual detection happens locally only.

## 7. Deletion

- **Clear lists** or stop/clear in UI
- Fresh start for selected branch only (leaves the other intact)
- Uninstall the Extension from Chrome (local storage removed)
- Clear browser data for the extension

## 8. Children

Not directed to children under 13.

## 9. Security

Data remains on your device under Chrome’s extension model. No remote transmission of your lists.

## 10. Changes

We may update this policy; the date above will change.

## 11. Contact

- admin@d2fl.com
- support@d2fl.com
- https://d2fl.com

---

Copyright © 2026 d2fl. All rights reserved.
