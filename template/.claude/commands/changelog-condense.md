---
description: Condense and summarize older changelog entries to reduce context bloating.
---

# Condense Changelog

Age out older entries in `docs/changelog.md` so the file stays a fixed rolling window — it's read
whenever an agent orients on recent history, so bloat there is a recurring context cost. Tiers are
computed from **today's date**:

| Tier | Age | Shape in `changelog.md` |
|---|---|---|
| 1 | 0–3 days | `## YYYY-MM-DD` full detail — **never modified** |
| 2 | 4–14 days | `### YYYY-MM-DD` per-day summary under `## Earlier Changes (Summary)` |
| 3 | 15–42 days | `### YYYY-MM-DD to YYYY-MM-DD` week-range |
| 4 | older | dropped from `changelog.md` entirely |

Nothing is ever lost: the moment a day leaves Tier 1, `scripts/condense-changelog.mjs` moves its
full-detail block into `docs/changelog-archive.md` **byte-for-byte**. Every summary tier is an
index over that archive, never the only copy, and dropping a Tier-4 range is lossless dedup — the
script refuses (Check H) when the archive doesn't already cover it.

## Step 0 — fold pending fragments

```bash
{{FOLD_CMD}}  # ({{FOLD_CMD_DRY_INLINE}} to preview)
```

Not optional: the condense helper **refuses to splice while fragments are pending** (Check L), so a
condense always starts from a complete file.

## Default path — the deterministic run

```bash
node scripts/condense-changelog.mjs --auto --today $(date +%F)   # add --dry-run to preview
```

One command, no judgment calls, cron-safe. It derives the tier boundaries, generates every summary
from the entries' own retrieval keys (the **bold subject**, first anchor link, and issue/PR refs
that the fragment lint enforces and future greps find), archives detail verbatim, extends a partial
week's existing range instead of laying a second one beside it, drops aged ranges, sheds an
oversized archive's oldest completed year into `changelog-archive-<YYYY>.md`, and runs the full
A–M verification suite. It writes nothing unless every check passes. `--today` is required — the
clock is never read.

Prefer this path. Hand-written summaries buy slightly nicer prose in exchange for temp files and a
multi-step flow; the archive holds the full text either way.

## Manual path — model-written summaries

When the summaries are worth writing by hand:

1. **Ask the script what this run should do** (read-only, prints the exact command to paste):
   ```bash
   node scripts/condense-changelog.mjs --plan --today $(date +%F)
   ```
2. **Write the temp file(s) it names — new entries only, in any order.** The run re-opens the
   summary section, re-emits unchanged entries and legacy blocks itself, and sorts everything
   newest-first; re-typing what isn't changing is at best redundant and at worst refused
   (Checks K/M). Carry each entry's **bold subject**, anchor-file links, and issue/PR refs into
   every summary — they are what future greps find.
3. **Run the command `--plan` printed** (add `--dry-run` first to preview). If a check fails, fix
   the temp file and re-run — never hand-patch the changelog or the archive around it.

`--plan` only asks for a second temp file (`--ar-content`) for pre-1.1 summary dates whose detail
was never archived; `--auto` handles the same case by moving the summary itself into the archive,
marked as summary-only.

## Rules (each one is script-enforced)

- **Get boundaries from `--plan`/`--auto`**, never from your own date arithmetic.
- **Never modify the 0–3 day window** (Check D), and never hand-edit any changelog file — the
  splice-and-verify run is the only writer of the summary tiers and the archive.
- **Never re-type detail.** Summaries are an index; the verbatim copy is moved to the archive by
  the script (Checks C and J), and Tier 4 only ever drops week-ranges the archive covers (Check H).
- **The archive stays newest-first**, and once it passes ~2,000 lines its oldest completed year is
  shed into a static per-year file — by the script (Check I), never by hand.
- Keep this footer at the bottom of `changelog.md` (Check G):
  ```
  > Full per-day details available in [changelog-archive.md](changelog-archive.md)
  ```
