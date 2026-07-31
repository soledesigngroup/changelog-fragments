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
**"Earlier Changes (Summary)"** section. Preserve **bold** feature names, anchor-file links, and
issue/PR refs — they are what future greps find; group fixes and minor changes into single bullets.
**The script moves each day's full-detail block into `docs/changelog-archive.md` verbatim at the
same time** (Check J), so the summary is an index, never the only copy — don't re-type detail into
any file yourself.

### Tier 3 — Week-range summary (15–42 days old)
Collapse per-day entries into `### YYYY-MM-DD to YYYY-MM-DD` headings in `changelog.md`, each with a
1–2 line prose theme summary (**no bullet points**). The collapsed dates' full detail already sits in
`docs/changelog-archive.md` — it moved there verbatim when they left Tier 1 — so normally nothing
more moves. The exception is a changelog condensed under the pre-1.1 flow, where Tier-2
summarization discarded the detail: `--plan` detects dates collapsing with no archive entry and asks
for `--ar-content` for exactly those.

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

1. **Ask the script what this run should do.** Don't work the tier boundaries out by hand — that's
   date arithmetic guarding a destructive splice. `--plan` writes nothing and prints the tier
   classification, the exact anchors, and a ready-to-paste command:
   ```bash
   node scripts/condense-changelog.mjs \
     --changelog docs/changelog.md \
     --archive docs/changelog-archive.md \
     --plan --today $(date +%F)
   ```
   `--today` is required and never defaults to the clock. If `--plan` reports nothing has aged out,
   stop — there's no work to do. Otherwise it tells you which temp files to write and what goes in
   them; the steps below explain the shape of that content.
2. **Write the new "Earlier Changes (Summary)" section** to the temp file `--plan` named (e.g.
   `/tmp/cl-mid.md`). It replaces everything from `--cl-start` up to — not including — `--cl-end`, and
   contains, newest first, exactly what `--plan` listed: the `## Earlier Changes (Summary)` heading
   (whenever the region starts at a `## DATE` block), the new Tier-2 per-day entries, **any existing
   entries the region swallows that this run doesn't change — copied verbatim**, then the new Tier-3
   week-ranges. Carry **bold subjects, anchor-file links, and issue/PR refs** into every summary.
   - **Check F requires the literal `---` + blank line immediately before that heading.** Every day
     block in `changelog.md` ends with a `---` separator, so the text preceding `--cl-start` normally
     supplies it. If it doesn't (e.g. `--cl-end` is the footer on an early run), start `cl-mid.md`
     with `---` + a blank line yourself.
   - **Leave the full-detail blocks and any legacy no-date blocks out of `cl-mid.md`.** The script
     archives the removed `## DATE` blocks verbatim itself (Check J), and re-emits any
     `## [Unreleased]`-style legacy blocks the region swallows (Check K) — re-typing either would
     duplicate them or lose content, and the checks refuse both.
3. **Only if `--plan` asked for `--ar-content`** (dates collapsing whose detail was never archived —
   a changelog condensed under the pre-1.1 flow), write their per-day summaries (newest first, each
   followed by a `---` line) to a second temp file (e.g. `/tmp/ar-new.md`) for the archive.
   - On the first such run the archive may have no date headings yet; `--plan` returns the
     placeholder line at the bottom of `changelog-archive.md` as the `--ar-before` anchor.
4. **Run the command `--plan` printed** (add `--dry-run` first to preview). Its shape:
   ```bash
   node scripts/condense-changelog.mjs \
     --changelog docs/changelog.md \
     --cl-start "<first ## date heading being condensed>" \
     --cl-end   "<first heading below the last one that changes>" \
     --cl-mid   /tmp/cl-mid.md \
     --keep-detailed-since <today minus 3 days, YYYY-MM-DD> \
     --drop-ranges-before <today minus 42 days, YYYY-MM-DD> \
     [--archive docs/changelog-archive.md \
      --ar-before "<newest existing archive heading>" \
      --ar-content /tmp/ar-new.md]
   ```
   Omit the three `--ar-*` flags unless `--plan` asked for them. **Pass
   `--drop-ranges-before <today − 42 days>` on every run** to age old week-ranges out (Tier 4) — the
   script computes which trailing ranges to drop and no-ops if none qualify. It reads `--archive` for
   the coverage check (read-only; nothing is written there), so keep `--archive docs/changelog-archive.md`
   on the command even for a Tier-4-only run — it defaults to that path, but a destructive run should
   say what it's reading. The three `--cl-*` flags are optional — omit them to run Tier 4 alone.

The script enforces: anchors are unambiguous and ordered; no duplicate headings within a file; every
date removed from the changelog is present as a per-day entry in the archive; the 0–3 day window
stays full-detail (`--keep-detailed-since`); no per-day heading overlaps a week-range; the `---`
separator + archive footer are preserved; the verbatim auto-archive conserves every line and never
collides with an existing archive entry (Check J); and legacy no-date blocks survive any splice
(Check K). If it aborts, fix the temp files and re-run — don't hand-patch around it.

## Archive size guard — shed completed years into per-year files

`changelog-archive.md` is **cold storage** — nothing on the hot path reads it (only this command's
coverage check does), so its size costs disk, not context. But left alone it grows forever, so once
it holds more than a full year of detail, retire the **oldest complete calendar year** into its own
static file. This keeps `changelog-archive.md` a rolling ~1-year window while `condense-changelog.mjs`
keeps writing only to its top — **the split never touches the helper's target, anchors, or checks.**

`--plan` watches this for you and adds `--shed-year <YYYY>` to the command it prints when the archive
exceeds **~2,000 lines** *and* holds a year older than its newest. Below that size it isn't worth
splitting; if only one year is present there's nothing to shed until the calendar rolls over.

The flag does the whole partition and verifies it (Check I) — **don't do this by hand:**

```bash
node scripts/condense-changelog.mjs \
  --changelog docs/changelog.md \
  --archive docs/changelog-archive.md \
  --shed-year 2025 \
  --drop-ranges-before <today minus 42 days>
```

It writes `docs/changelog-archive-2025.md` (a static file no tool touches again) with the year's block
copied **verbatim**, removes that block from `changelog-archive.md`, and refreshes the
`> Earlier years: [2025](changelog-archive-2025.md)` pointer near the top. Trailing note lines stay
behind in `changelog-archive.md`. It refuses to run unless the year you named is the **oldest** one
present (one year per run, oldest first), it isn't the only year, its target file doesn't already
exist, and the partition conserves every heading and every non-blank line exactly once.

Coverage checks still see the shed year, so a `--shed-year` and a Tier-4 `--drop-ranges-before` in the
same run can't make each other look unsafe.

## Rules
- **Get the boundaries from `--plan --today $(date +%F)`, not from your own date arithmetic.**
- **Never modify the 0–3 day window.** `--keep-detailed-since` (set to today − 3 days) enforces this.
- **Never re-type detail.** The script moves full-detail blocks into the archive verbatim itself;
  your summaries are an index over that detail, not a replacement for it. Carry bold subjects,
  anchor-file links, and issue/PR refs through every summary tier.
- **Tier 4 only drops week-ranges, never per-day detail.** `--drop-ranges-before` removes trailing
  `### X to Y` blocks whose end date < cutoff and refuses (Check H) if a dropped range isn't still
  covered in the archive. The archive is the sole home for anything older than ~6 weeks — never delete
  the archived per-day entry a dropped week-range points at.
- **Archive format is per-day** (`### YYYY-MM-DD`), holding the verbatim full-detail block of each
  day that left Tier 1.
- Cross-file pairing is correct, not a duplicate: a Tier-2 date appears as a summary in
  `changelog.md` **and** as full detail in the archive; a collapsed date appears as a week-range in
  `changelog.md` **and** a per-day entry in the archive. Within a single file, no date may appear
  twice.
- Keep `changelog-archive.md` in reverse-chronological order (newest at top).
- **Shed completed years past ~2,000 lines** with `--shed-year` (see "Archive size guard") — never by
  hand. It's a pure partition; the only file `condense-changelog.mjs` keeps appending to is `changelog-archive.md`.
- Keep this footer at the bottom of `changelog.md`:
  ```
  > Full per-day details available in [changelog-archive.md](changelog-archive.md)
  ```
