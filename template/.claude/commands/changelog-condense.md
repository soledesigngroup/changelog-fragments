---
description: Condense and summarize older changelog entries to reduce context bloating.
---

# Condense Changelog

Age out older entries in `docs/changelog.md` so the file stays small — it's read on every
`/git-commit-push` and whenever an agent orients on recent history, so bloat there is a recurring
context cost. Tiers are computed from **today's date**, and the boundaries below are inclusive
exactly as written (no overlap):

## Tiers

### Tier 1 — Full detail (0–3 days old)
Keep exactly as-is under `## YYYY-MM-DD` headings. **Never modify these.**

### Tier 2 — Per-day feature summary (4–14 days old)
Condense each day to 1–2 lines per feature/change under a `### YYYY-MM-DD` heading inside the
**"Earlier Changes (Summary)"** section. Preserve **bold** feature names and key technical details;
group fixes and minor changes into single bullets.

### Tier 3 — Week-range summary (15–42 days old)
Collapse per-day entries into `### YYYY-MM-DD to YYYY-MM-DD` headings in `changelog.md`, each with a
1–2 line prose theme summary (**no bullet points**). Before collapsing, the full per-day Tier-2
summary for each collapsed date moves to `docs/changelog-archive.md` (newest at top).

### Tier 4 — Archive-only (older than ~6 weeks / 42 days)
Drop the Tier-3 week-range line from `changelog.md` **entirely** once its end date is older than the
cutoff — the archive already holds its (finer) per-day detail, so this is lossless dedup, not
deletion. Without it, Tier-3 week-ranges accumulate forever and `changelog.md` grows without bound;
Tier 4 makes the file a fixed rolling window (~last 6 weeks of themes) so the recurring read cost stays
flat. The helper does this via `--drop-ranges-before` and refuses (Check H) if any dropped range isn't
still covered in the archive.

## Step 0 — fold pending fragments first

Recent entries are authored as fragments in `docs/changelog.d/` (see that dir's
README), not directly in `changelog.md`. **Fold them in before condensing** so
you're working on a complete file:

```bash
{{FOLD_CMD_DRY}}  # preview what will fold
{{FOLD_CMD}}  # fold + delete the fragments
```

The fold only ever adds recent dates (Tier-1), so it never disturbs the older
entries you're about to condense. Then proceed:

## How to run it — splice + verify, do NOT hand-edit

This is a multi-file move that must never re-type Tier-1 blocks and must never drop or duplicate an
entry. Do the judgment work (writing the summaries), then let `scripts/condense-changelog.mjs` do the
mechanical splice and the verification. **The script writes nothing unless every check passes**, so
prefer it over editing the files by hand.

1. **Read the current `docs/changelog.md`** and, from today's date, work out which `## YYYY-MM-DD`
   day-headings fall in each tier.
2. **Write the new "Earlier Changes (Summary)" section** to a temp file (e.g. `/tmp/cl-mid.md`). It
   must begin with the `## Earlier Changes (Summary)` heading and contain, in order: the new Tier-2
   per-day entries (newest first), then any new Tier-3 week-range entries — stopping just before the
   first existing heading that stays unchanged this run.
   - **Check F requires the literal `---` + blank line immediately before that heading.** Every day
     block in `changelog.md` ends with a `---` separator, so the text preceding `--cl-start` normally
     supplies it. If it doesn't (e.g. `--cl-end` is the footer on an early run), start `cl-mid.md`
     with `---` + a blank line yourself.
3. **If any dates collapse to Tier 3**, write their per-day summaries (newest first, each followed by
   a `---` line) to a second temp file (e.g. `/tmp/ar-new.md`) for the archive.
   - On the **first** Tier-3 run the archive has no date headings yet; use the placeholder line at the
     bottom of `changelog-archive.md` as the `--ar-before` anchor.
4. **Run the helper** (add `--dry-run` first to preview):
   ```bash
   node scripts/condense-changelog.mjs \
     --changelog docs/changelog.md \
     --cl-start "<first ## date heading being condensed>" \
     --cl-end   "<first existing heading to keep unchanged>" \
     --cl-mid   /tmp/cl-mid.md \
     --keep-detailed-since <today minus 3 days, YYYY-MM-DD> \
     --drop-ranges-before <today minus 42 days, YYYY-MM-DD> \
     [--archive docs/changelog-archive.md \
      --ar-before "<newest existing archive heading>" \
      --ar-content /tmp/ar-new.md]
   ```
   Omit the three `--ar-*`/`--archive` flags on runs where nothing has reached Tier 3. **Pass
   `--drop-ranges-before <today − 42 days>` on every run** to age old week-ranges out (Tier 4) — the
   script computes which trailing ranges to drop and no-ops if none qualify. It needs `--archive` for
   the coverage check (read-only; nothing is written there), so include `--archive docs/changelog-archive.md`
   even on a Tier-4-only run. The three `--cl-*` flags are optional — omit them to run Tier 4 alone.

The script enforces: anchors are unambiguous and ordered; no duplicate headings within a file; every
date removed from the changelog is present as a per-day entry in the archive; the 0–3 day window
stays full-detail (`--keep-detailed-since`); no per-day heading overlaps a week-range; and the `---`
separator + archive footer are preserved. If it aborts, fix the temp files and re-run — don't
hand-patch around it.

## Archive size guard — shed completed years into per-year files

`changelog-archive.md` is **cold storage** — nothing on the hot path reads it (only this command's
coverage check does), so its size costs disk, not context. But left alone it grows forever, so once
it holds more than a full year of detail, retire the **oldest complete calendar year** into its own
static file. This keeps `changelog-archive.md` a rolling ~1-year window while `condense-changelog.mjs`
keeps writing only to its top — **the split never touches the helper's target, anchors, or checks.**

**After every condense run, check the guard:**

```bash
wc -l docs/changelog-archive.md
```

**Trigger — shed a year only when BOTH hold:**
- the archive exceeds **~2,000 lines** (below that it isn't worth splitting), AND
- it contains a calendar year *older than* the most recent year present — i.e. a complete past year
  sits at the bottom (everything in the archive is already aged out by definition).

If only the current year is present, the trigger does **not** fire; the file just grows until the
calendar rolls over and last year becomes shed-able.

**How to shed (a pure partition — no entry text is rewritten):**
1. `KEEP` = the newest year in the archive (topmost `### YYYY-…` heading's year); `SHED` = the oldest
   complete year present. Move **one year per run** (the oldest) so each run stays incremental — a
   long-neglected archive sheds its tail one year at a time over successive condense runs.
2. Boundary = the **topmost** `### <SHED>-…` heading. Everything from there to the end of the moved
   year is the "old block"; week-range entries move with the year they belong to.
3. **Create `docs/changelog-archive-<SHED>.md`**: a `# Changelog Archive — <SHED>` header, a blank
   line, then the old block **verbatim** (still newest-at-top). This file is now static — no tool
   writes it again.
4. **Remove the old block** from `changelog-archive.md`, leaving the newer year(s) intact.
5. **Add/refresh a pointer** near the top of `changelog-archive.md` so history stays discoverable,
   e.g. `> Earlier years: [2026](changelog-archive-2026.md), [2025](changelog-archive-2025.md)`.

**Verify before saving (this move has no helper — check by hand):**
- `grep -c '^### ' docs/changelog-archive.md` **before** == that count on the new
  `changelog-archive.md` **+** the count in the new year file. No `### YYYY-MM-DD` heading may be lost
  or duplicated; `grep -l` the boundary date and the oldest date to confirm each resolves to exactly
  one file.
- The next `condense-changelog.mjs` run still passes `--archive docs/changelog-archive.md` and its
  Check H coverage still passes — the dates it ages out are recent and never fall in a shed year.

## Rules
- **Never modify the 0–3 day window.** `--keep-detailed-since` (set to today − 3 days) enforces this.
- **Tier 4 only drops week-ranges, never per-day detail.** `--drop-ranges-before` removes trailing
  `### X to Y` blocks whose end date < cutoff and refuses (Check H) if a dropped range isn't still
  covered in the archive. The archive is the sole home for anything older than ~6 weeks — never delete
  the archived per-day entry a dropped week-range points at.
- **Archive format is per-day** (`### YYYY-MM-DD`).
- A collapsed date appears as a week-range in `changelog.md` **and** a per-day entry in the archive —
  that cross-file pairing is correct, not a duplicate. Within a single file, no date may appear twice.
- Keep `changelog-archive.md` in reverse-chronological order (newest at top).
- **Shed completed years past ~2,000 lines** into `changelog-archive-<YEAR>.md` (see "Archive size
  guard"). It's a pure partition — `condense-changelog.mjs` still only ever writes `changelog-archive.md`.
- Keep this footer at the bottom of `changelog.md`:
  ```
  > Full per-day details available in [changelog-archive.md](changelog-archive.md)
  ```
