# X Cleaner — High-Level Flows

High-level architecture and flows. Focused on user choices and risk levels. Fast mode is riskier (bulk operations); Gentle mode is for low-count or overnight use with lower detection risk.

Diagrams are in `diagrams/` as Mermaid (.mmd) files for rendering in GitHub, VSCode, etc.

**Key distinction:**
- **Fast mode (riskier)**: Uses bulk REST/GraphQL for speed. Higher chance of rate limits or account flags.
- **Gentle mode (recommended for small lists or overnight)**: Uses page sniffer + natural scroll/DOM. Lower risk, slower.

Fresh start, CSV cross-populate, filters, and account isolation all apply per branch (following or followers independently).

---

## 1. High-Level Architecture

See `diagrams/01_architecture.mmd`

(High level: Popup/HUD entry → Background → X interaction (sniffer or REST) → Local storage only. Subscription gate for full export. No central servers.)

---

## 2. Collection with Modes + Cross Mutuals

See `diagrams/02_collection_modes.mmd`

When collecting a branch:
- Choose Fast (riskier) or Gentle.
- As data arrives, automatically query the other branch.
- If username present in other: mark mutual flags (you_follow + follows_you) on both sides.
- This populates blanks early and reduces need for extra tail/recovery fetches for mutual-heavy accounts.

See also `diagrams/03_csv_cross.mmd` for same logic on CSV import.

Fresh start (checkbox) only affects the selected branch: clears its cache/persist, archives its prior enrichments (for re-hydrate during new collect), leaves other branch intact.

See `diagrams/05_fresh_start.mmd`

---

## 3. Filters (High Level)

See `diagrams/04_filters.mmd`

Filters run on collected data (local):
- Mutuals removal: requires both branches + cross flags.
- Remove verified.
- Remove inactive (last post analysis): available only for Following.
- Bot check: available only for Followers.

---

## 4. Account Switch Cleanup

See `diagrams/06_account_switch.mmd`

On detecting different X user: cancel any active work, clear other users' in-memory data, restore only for active user. Per-account isolation.

---

## 5. Import / Export

- CSV load: supports replace/append, applies cross-mutual population if names overlap with other branch (see diagram 03).
- Export: full lists require @d2fl subscription; free tier limited.
- All data local only.

---

## 6. Subscription

Local check for @d2fl sub (or owner handles) to lift fetch/export caps. No data sent to d2fl for this.

---

Update date: 2026-06-21. Reflects current high-level behavior (cross populate on collect/CSV, per-branch fresh start, gentle vs fast risk distinction, local only).

For detailed (outdated) prior versions see git history of this file.
