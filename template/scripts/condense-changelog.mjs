#!/usr/bin/env node
/**
 * Splice-and-verify helper for the /changelog-condense flow.
 *
 * Division of labor:
 *   - With --auto, THERE IS NO JUDGMENT WORK: the whole run — tier boundaries,
 *     Tier-2/3 summary text (built from each entry's **bold subject**, anchor
 *     link, and issue refs), archival, Tier-4 drop, year shed — is derived
 *     deterministically and verified by the same checks. This is the zero-input
 *     path: `--auto --today YYYY-MM-DD`.
 *   - Without --auto, the MODEL writes only the NEW summary prose (--cl-mid,
 *     optionally --ar-content) and THIS script does everything mechanical: it
 *     re-opens the sentinel, re-emits unchanged and legacy entries the region
 *     swallows, orders everything newest-first, moves detail verbatim, and runs
 *     un-skippable verification. It writes nothing unless every check passes.
 *
 * What it does:
 *   1. (Tier 2/3 splice) Rebuilds the changelog region from --cl-start (inclusive)
 *      through --cl-end (EXCLUSIVE): the NEW entries in --cl-mid plus everything
 *      in the old region that isn't condensing this run — unchanged `### DATE` /
 *      `### X to Y` entries and the summary sentinel are re-emitted by the script
 *      itself (an entry missing from cl-mid used to vanish silently), sorted
 *      newest-first. Everything before --cl-start (the Tier-1 full-detail entries)
 *      and from --cl-end onward (older week-ranges + footer) is preserved
 *      byte-for-byte. This group is optional; omit all three --cl-* flags on a
 *      Tier-4-only run. An old entry leaves the region only for a stated reason:
 *      replaced by key in cl-mid, collapsed into a covering range (Check C), or —
 *      per-day summaries — older than --drop-ranges-before (archive-only age).
 *   2. (Verbatim auto-archive) Every full-detail `## DATE` block the splice
 *      removes is moved into the archive by THIS script, byte-for-byte, as a
 *      per-day `### DATE` entry, each placed by date so the archive stays newest
 *      first (Check N). The model never re-types detail, the archive genuinely
 *      holds the full text of every entry that has aged out of Tier 1, and
 *      grepping the docs/ tree finds history verbatim instead of a paraphrase.
 *      A block for a day the archive ALREADY holds — a late fragment, folded
 *      after an earlier run condensed its day — merges into that entry instead,
 *      bullet by bullet under its `### Category` sections (the fold's own
 *      same-day rule), adding nothing the entry already has; its summary entry
 *      or week-range line gains the new subjects the same way. Verified — Check J.
 *   3. (Legacy block re-emit) A `##` heading with no ISO date (`## [1.2.0]`,
 *      `## [Unreleased]`) that the splice region swallows is re-emitted above the
 *      new content by the script itself, so a migrated Keep-a-Changelog history
 *      can never be lost to a condense run. Verified — Check K.
 *   4. (Optional) Inserts --ar-content into the archive immediately BEFORE
 *      --ar-before. Only needed for summary-section dates collapsing into
 *      week-ranges whose detail was never archived — i.e. changelogs condensed
 *      under the pre-1.1 flow, where Tier-2 summarization discarded the detail.
 *      The anchor is taken literally, so Check N catches one that would leave the
 *      archive out of date order.
 *   5. (Tier 4 drop) With --drop-ranges-before <DATE>, removes trailing week-range
 *      blocks whose END date is older than <DATE> from the changelog entirely.
 *      Their per-day detail already lives in the archive (verified — Check H), so
 *      this is lossless dedup that stops the file growing without bound. Requires
 *      --archive (read-only) for the coverage check; nothing is written to it.
 *   6. (Archive year shed) With --shed-year <YYYY>, moves the oldest complete
 *      calendar year out of the archive into a static changelog-archive-<YYYY>.md
 *      and refreshes the "Earlier years" pointer. A pure partition, verified
 *      heading-for-heading and line-for-line (Check I).
 *
 * Planning: --plan --today <DATE> writes nothing and prints which headings fall in
 * which tier plus the exact anchor/cutoff flags to use. Prefer it over working the
 * dates out by hand. It also counts the `##` blocks it CANNOT classify and refuses
 * to call the run an all-clear while any of them lead with a date — see below.
 *
 * Deterministic mode: --auto --today <DATE> derives the plan and executes it in one
 * step with generated summaries — Tier-2 entries keep each bullet's subject + first
 * anchor link + issue refs; Tier-3 ranges are one per absolute calendar week
 * (extending a partial week's existing range instead of adding a second one) with
 * per-day subject lines, and a week that holds a single day is written as that day
 * rather than as a range from it to itself. Pre-1.1 summary-only dates are archived
 * as-is, marked. Suitable for cron/CI. Refuses to run while fragments are pending
 * (Check L), and refuses to report "nothing to do" on a file it can't fully read.
 *
 * A run that will write takes the fold's own lock (`.fold.lock` in the
 * changelog.d/ next to --changelog) for the whole read -> write span, so a fold
 * can't land between this run's read and its write and be silently overwritten.
 * --plan and --dry-run write nothing and stay lock-free. Writes go through a
 * temp file + rename, receiving file first (year file, then archive, then
 * changelog): a crash between writes leaves detail duplicated across two files,
 * never removed from one and not yet in the other — and the next run, finding
 * that day's detail already archived, finishes the move without adding it twice.
 *
 * Other flags:
 *   --dry-run   run every check and print the same report, then stop without writing
 *   -h, --help  print this header
 *
 * --changelog and --archive default to docs/changelog.md and docs/changelog-archive.md
 * resolved from THIS SCRIPT's parent directory (not the cwd), matching the fold, so
 * `--plan` and a Tier-4-only run need no paths spelled out. A path passed explicitly
 * must exist; the conventional archive merely being absent reads as "nothing archived".
 *
 * A day heading is `## YYYY-MM-DD`, optionally in square brackets, with any trailing
 * text and no whitespace required before it — `## 2026-07-03 (parenthetical)`,
 * `## 2026-07-03(retro)`, `## [2026-07-03]` are all one day. One shape, spelled once
 * as H2_DAY_SRC and matching the fold's DAY_DATE_RE exactly, so a heading a migrator
 * preserved ages out like any other instead of being stuck in Tier 1 forever, and no
 * two readers can disagree about one.
 *
 * A `##` block this script can't classify is COUNTED, never assumed away. One that
 * leads with a date in a wrapper it can't parse (`## (2026-07-26)`) is stuck: in no
 * tier, never swept into a splice region, unable to age out. --plan and --auto name
 * those blocks and exit 1 rather than report "nothing has aged out" about a file
 * they never parsed; with real work also pending they do the work and warn. A block
 * whose leading token isn't a date (`## [Unreleased]`, `## [1.2.0] - 2026-03-29`) is
 * the documented legacy zone: counted, reported, and otherwise left alone.
 *
 * Exit 0 = wrote (or would have written), or a plan that answers the question.
 * Exit 1 = verification failed (nothing written), or the file is too unreadable for
 * the answer to mean anything. Exit 2 = bad arguments.
 *
 * Example (Tier 2/3 + Tier 4 in one run):
 *   node scripts/condense-changelog.mjs \
 *       --changelog docs/changelog.md \
 *       --cl-start "## 2026-06-14" \
 *       --cl-end   "### 2026-05-17 to 2026-05-20" \
 *       --cl-mid   /tmp/changelog-mid.md \
 *       --archive  docs/changelog-archive.md \
 *       --ar-before "### 2026-05-20" \
 *       --ar-content /tmp/archive-new.md \
 *       --keep-detailed-since 2026-06-15 \
 *       --drop-ranges-before 2026-05-04
 *
 * Example (Tier-4-only run — just age old week-ranges out of the changelog):
 *   node scripts/condense-changelog.mjs \
 *       --changelog docs/changelog.md \
 *       --archive docs/changelog-archive.md \
 *       --drop-ranges-before 2026-06-04
 *
 * Example (work out what this run should do, writing nothing):
 *   node scripts/condense-changelog.mjs \
 *       --changelog docs/changelog.md \
 *       --archive docs/changelog-archive.md \
 *       --plan --today 2026-07-26
 *
 * Verification (all must pass or nothing is written):
 *   A. Each anchor occurs exactly once in its file, and --cl-start precedes --cl-end.
 *   B. No date heading (single day or "X to Y" range) appears twice within a file.
 *   C. Every single-date heading removed from the changelog this run exists as a
 *      per-day entry in the archive (nothing collapses without being archived).
 *   D. (if --keep-detailed-since) every "## DATE" >= that date stays a full-detail
 *      "## DATE" heading in the new changelog (the 0-3 day window is untouched).
 *   E. In the changelog, no per-day heading is also covered by a week-range.
 *   F. The "---" separator before "## Earlier Changes (Summary)" is preserved.
 *   G. The footer pointer to the archive is preserved.
 *   H. (if --drop-ranges-before) the Tier-4 drop region holds only week-ranges
 *      (no single-day heading, no kept range below a dropped one), and every day
 *      a dropped range names has its own archive entry, so its detail survives.
 *      A range naming no days falls back to a span-overlap test, reported.
 *   I. (if --shed-year) the year being shed is the oldest present and not the only
 *      one, its target file doesn't already exist, and the partition conserves
 *      every archive heading and every non-blank line exactly once.
 *   J. A full-detail day leaving the changelog must not also be written by this
 *      run's --ar-content (the script archives it verbatim itself — that copy
 *      would duplicate it), and the auto-archive must conserve every line. A day
 *      the archive already held before the run is merged into, not refused.
 *   K. Legacy `##` blocks with no ISO date survive any splice: same heading
 *      count as before, and every content line still present.
 *   L. A splice refuses to run while fragments are pending in docs/changelog.d —
 *      a fold-first ordering the command doc used to merely request. Tier-4-only
 *      and shed runs warn instead (they never touch Tier 1).
 *   M. --cl-mid (and the region itself) must parse into placeable blocks; content
 *      sitting under no heading is refused rather than guessed at or dropped.
 *   N. An archive that was in descending date order still is after this run — a
 *      regression check, so an archive that arrived scrambled is left alone
 *      rather than re-sorted (re-sorting a file this system didn't scramble is
 *      editing history).
 *
 * Self-contained: no imports beyond node builtins and its sibling
 * collect-changelog.mjs (installed beside it, for the fold's same-day merge), no
 * build step, no deps. Dates are compared as ISO strings (YYYY-MM-DD sorts lexicographically), so
 * there is no timezone handling to get wrong. `shiftDays` is the one exception —
 * see the note on it.
 *
 * Managed by changelog-fragments — re-run its install.mjs to update.
 */

import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The fold's own parser and same-day merge, so a late fragment's bullets land in
// an archived day by exactly the rule that merges them into a Tier-1 day.
import { extractFragmentBlocks, FragmentError, mergeIntoExistingDay } from "./collect-changelog.mjs"

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SELF), "..")

// Conventional paths, resolved from this script's own directory rather than the
// process cwd (the fold does the same), so running the helper by hand from a
// subdirectory works. An explicit --changelog / --archive always wins.
const DEFAULT_CHANGELOG = join(ROOT, "docs/changelog.md")
const DEFAULT_ARCHIVE = join(ROOT, "docs/changelog-archive.md")

// Fresh regex per call — a shared /g regex carries lastIndex between scans.
/**
 * THE full-detail day heading shape — one source, because every reader in this
 * file has to agree with every other one AND with the fold's DAY_DATE_RE.
 *
 * Deliberately tolerant of the legacy trailing text the migrator preserves
 * (`## 2026-07-03 (DocuSeal implementation plan)`), with no whitespace required
 * before it: `## 2026-07-20(retro)` is one heading, and four regexes spelled out
 * by hand disagreed about it. `dayBlocksIn` read it as a day and moved its detail
 * to the archive; `legacyBlocksIn` and `parseRegionBlocks` read it as an opaque
 * legacy block and re-emitted it into the changelog; `reH2Day` saw nothing, so
 * the "did it survive the splice?" test looked for a date the new file could
 * never report. Every check passed on a run that left the same day's detail in
 * both files, permanently — the block stays in Tier 1, so nothing ever moves it
 * again. m[1] is the date, m[2] the trailing text (trimmed, "" when absent).
 *
 * A digit may not follow the date: `## 2026-07-263` is not 2026-07-26 plus a
 * stray `3`, and both sides now agree it is opaque rather than one side dating it.
 *
 * SQUARE BRACKETS around the date are accepted — `## [2026-07-26]` — because a
 * pre-1.0.1 migrator wrote whole histories that way, borrowing Keep a Changelog's
 * bracket convention for the date instead of the version. Those blocks were in no
 * tier and could never age out; one repo's entire history sat in that shape.
 * `## [1.2.0] - 2026-03-29` still doesn't match and must not: what follows `[` has
 * to BE the date, so a bracketed version stays the opaque legacy zone it is.
 * Brackets only — `## (2026-07-26)` and `## **2026-07-26**` stay unreadable AND
 * get reported by STUCK_DAY_RE, which is the right trade: guessing at every
 * wrapper someone might type is how a parser starts inventing days.
 */
const H2_DAY_SRC = String.raw`^##[ \t]+\[?(\d{4}-\d{2}-\d{2})(?!\d)\]?[ \t]*(.*?)[ \t]*$`
const reH2Day = () => new RegExp(H2_DAY_SRC, "gm")
/**
 * The same shape against a single line — m[1] = date, m[2] = trailing text.
 * Safe to share one instance, unlike the /g scanners above: no `g` flag means no
 * `lastIndex` to carry between calls.
 */
const RE_H2_DAY_LINE = new RegExp(H2_DAY_SRC)
const matchH2Day = (line) => line.match(RE_H2_DAY_LINE)
const reH3Date = () => /^### (\d{4}-\d{2}-\d{2})[ \t]*$/gm
const reH3Range = () => /^### (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})[ \t]*$/gm
const reAnyHeading = () =>
  /^#{2,3} (\d{4}-\d{2}-\d{2})(?: to (\d{4}-\d{2}-\d{2}))?[ \t]*$/gm

/**
 * A `##` heading that LEADS with an ISO date in a wrapper this file can't read —
 * `## (2026-07-26)`, `## **2026-07-26**`, `## _2026-07-26_`. Square brackets are
 * NOT among them: H2_DAY_SRC parses those, so they never reach this test.
 *
 * Such a block is STUCK: in no tier, never swept into a splice region, unable to
 * ever age out. It reads as an ordinary opaque legacy block, which is why
 * `--plan` used to answer "nothing has aged out yet" on a changelog where every
 * single day was months overdue — a green light an agent then acted on by
 * summarizing history in the editor instead. Reported, never guessed at.
 *
 * This stays a *reporting* net rather than growing into the parser one wrapper at
 * a time. Teaching H2_DAY_SRC every delimiter someone might type is how a parser
 * starts inventing days; brackets earned their place by being a real migrator's
 * output across whole histories, not by being imaginable.
 *
 * Leading is the whole test, so the genuinely opaque legacy zone stays quiet:
 * `## [1.2.0] - 2026-03-29` leads with a version and `## [Unreleased]` with a
 * word, and both are documented as sinking harmlessly under newer days.
 */
const STUCK_DAY_RE = /^##[ \t]+[^\w\s]{1,2}[ \t]*\d{4}-\d{2}-\d{2}/

const FOOTER = "> Full per-day details available in"
const SENTINEL = "## Earlier Changes (Summary)"
const SEP_BEFORE_SUMMARY = "---\n\n## Earlier Changes (Summary)"
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const reSentinel = /^##\s+Earlier Changes/i

/** Dates that appear as a single-day heading (## or ###), as a Set of strings. */
function singleDates(text) {
  const out = new Set()
  for (const m of text.matchAll(reH2Day())) out.add(m[1])
  for (const m of text.matchAll(reH3Date())) out.add(m[1])
  return out
}

function h2Dates(text) {
  const out = new Set()
  for (const m of text.matchAll(reH2Day())) out.add(m[1])
  return out
}

function rangesOf(text) {
  return [...text.matchAll(reH3Range())].map((m) => [m[1], m[2]])
}

/** Every date-heading identity in order, for duplicate detection. */
function headingKeys(text) {
  return [...text.matchAll(reAnyHeading())].map((m) => (m[2] ? `${m[1]} to ${m[2]}` : m[1]))
}

/**
 * Where `anchor` begins a line of `text` (after optional indentation), in order.
 *
 * Anchors are heading lines, or a prefix of one. A bare substring search found
 * `## 2026-07-20` inside `### 2026-07-20` — precisely the pair a late fragment
 * produces (a Tier-1 block and a summary entry for the same day) — so Check A
 * called a perfectly good anchor ambiguous and the run could never proceed.
 */
function anchorIndexes(text, anchor) {
  const out = []
  if (!anchor) return out
  for (let i = text.indexOf(anchor); i !== -1; i = text.indexOf(anchor, i + 1)) {
    let k = i
    while (k > 0 && (text[k - 1] === " " || text[k - 1] === "\t")) k--
    if (k === 0 || text[k - 1] === "\n") out.push(i)
  }
  return out
}
const countAnchor = (text, anchor) => anchorIndexes(text, anchor).length
const anchorIndex = (text, anchor) => anchorIndexes(text, anchor)[0] ?? -1

const stripTrailingJunk = (lines) => {
  while (lines.length && (lines[lines.length - 1].trim() === "" || /^-{3,}\s*$/.test(lines[lines.length - 1])))
    lines.pop()
  while (lines.length && lines[0].trim() === "") lines.shift()
  return lines
}

/**
 * The verbatim `## DATE …` full-detail blocks in a stretch of changelog text, in
 * file order (newest first in a well-ordered Tier-1 zone). `trailing` carries a
 * legacy heading's text after the date; `body` is every line under the heading,
 * byte-for-byte, minus surrounding blanks and the block's trailing `---`.
 */
function dayBlocksIn(text) {
  const blocks = []
  let cur = null
  for (const line of text.split("\n")) {
    if (/^##[ \t]/.test(line)) {
      if (cur) blocks.push(cur)
      const m = matchH2Day(line)
      cur = m ? { date: m[1], trailing: m[2], body: [] } : null
    } else if (cur) {
      cur.body.push(line)
    }
  }
  if (cur) blocks.push(cur)
  for (const b of blocks) stripTrailingJunk(b.body)
  return blocks
}

/**
 * `##` blocks whose heading carries no ISO date (`## [Unreleased]`,
 * `## [1.2.0] - 2026-03-29`) — the opaque legacy zone a migrated Keep-a-Changelog
 * file keeps at the bottom of Tier-1. The splice region swallows them whenever a
 * full-detail day condenses, so the script re-emits them itself (and Check K
 * verifies nothing of theirs was lost).
 */
function legacyBlocksIn(text) {
  const blocks = []
  let cur = null
  for (const line of text.split("\n")) {
    if (/^##[ \t]/.test(line)) {
      if (cur) blocks.push(cur)
      const isDay = matchH2Day(line) !== null
      const isSentinel = reSentinel.test(line)
      cur = !isDay && !isSentinel ? { heading: line, body: [] } : null
    } else if (cur) {
      cur.body.push(line)
    }
  }
  if (cur) blocks.push(cur)
  for (const b of blocks) {
    stripTrailingJunk(b.body)
    b.text = [b.heading, "", ...b.body].join("\n")
  }
  return blocks
}

/**
 * Parse a run of changelog text into the blocks the splice can place: full-detail
 * days (`## DATE …`), legacy no-date `##` blocks, the summary sentinel, per-day
 * summaries (`### DATE`), and week-ranges (`### X to Y`). A `### Category`
 * heading belongs to the enclosing block's body, never to the top level.
 *
 * Content that sits under no block at all is unplaceable — it is reported as a
 * Check M problem rather than silently attached to a neighbour or dropped.
 * Blank lines and stray `---` rules between blocks are structural, not content.
 */
function parseRegionBlocks(text, label, problems) {
  const blocks = []
  let cur = null
  const lines = text.split("\n")
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    if (/^##[ \t]/.test(line)) {
      const day = matchH2Day(line)
      if (day) cur = { kind: "h2day", date: day[1], heading: line.trimEnd(), body: [] }
      else if (reSentinel.test(line)) cur = { kind: "sentinel", heading: SENTINEL, body: [] }
      else cur = { kind: "legacy", heading: line.trimEnd(), body: [] }
      blocks.push(cur)
      continue
    }
    const range = line.match(/^### (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})[ \t]*$/)
    if (range) {
      cur = { kind: "range", from: range[1], to: range[2], heading: line.trim(), body: [] }
      blocks.push(cur)
      continue
    }
    const day = line.match(/^### (\d{4}-\d{2}-\d{2})[ \t]*$/)
    if (day) {
      cur = { kind: "day", date: day[1], heading: line.trim(), body: [] }
      blocks.push(cur)
      continue
    }
    if (cur) {
      cur.body.push(line)
      continue
    }
    if (line.trim() === "" || /^-{3,}\s*$/.test(line)) continue
    problems.push(
      `M: ${label} line ${li + 1}: content sits under no heading the splice can place: ` +
        JSON.stringify(line.trim().slice(0, 60))
    )
  }
  for (const b of blocks) stripTrailingJunk(b.body)
  return blocks
}

/** Newest first: by a block's own (or end) date, single days above a range that ends the same day. */
function byNewestFirst(a, b) {
  const ka = a.kind === "range" ? a.to : a.date
  const kb = b.kind === "range" ? b.to : b.date
  if (ka !== kb) return ka < kb ? 1 : -1
  if (a.kind !== b.kind) return a.kind === "day" ? -1 : 1
  const sa = a.kind === "range" ? a.from : a.date
  const sb = b.kind === "range" ? b.from : b.date
  return sa < sb ? 1 : sa > sb ? -1 : 0
}

/** True when the last non-blank line of `text` is a `---` rule. */
function endsWithRule(text) {
  const lines = text.split("\n")
  let i = lines.length - 1
  while (i >= 0 && lines[i].trim() === "") i--
  return i >= 0 && /^-{3,}\s*$/.test(lines[i])
}

/**
 * Assemble the new splice region from the old region plus --cl-mid, so cl-mid
 * only ever has to carry NEW summary text. Everything mechanical happens here:
 *
 *   - The sentinel is re-opened by this function whenever the old region held it
 *     (a copy in cl-mid is deduplicated, and a mangled one is canonicalized).
 *   - Legacy no-date blocks are re-emitted from the old region verbatim; a copy
 *     in cl-mid wins so an author CAN restate one, and Check K verifies it.
 *   - An unchanged `### DATE` / `### X to Y` entry the region swallows is
 *     re-emitted verbatim instead of relying on the author to re-type it —
 *     before this, an entry missing from cl-mid silently vanished (its detail
 *     was archived, so no check fired, but the changelog lost its index line).
 *   - Old entries leave the region only for a stated reason: replaced by the
 *     same heading in cl-mid, collapsed into a range that covers them (Check C
 *     then requires their archive entry), or — per-day summaries only — older
 *     than `removeDaysBefore` (the Tier-4 cutoff: past it, a range would itself
 *     be dropped, so the archive is the only home left).
 *   - Blocks are ordered newest-first by this function; cl-mid's order is
 *     irrelevant.
 *
 * Returns the assembled region text, or null after pushing onto `fails`.
 */
function assembleRegion(regionText, midText, beforeText, fails, { removeDaysBefore = null } = {}) {
  const problems = []
  const old = parseRegionBlocks(regionText, "changelog region", problems)
  const mid = parseRegionBlocks(midText, "--cl-mid", problems)
  if (problems.length) {
    fails.push(...problems)
    return null
  }

  const rangeKey = (b) => `${b.from} to ${b.to}`
  const midRanges = mid.filter((b) => b.kind === "range")
  const midRangeKeys = new Set(midRanges.map(rangeKey))
  const midDayKeys = new Set(mid.filter((b) => b.kind === "day").map((b) => b.date))

  // An old range survives unless cl-mid replaces it by key or reshapes it with an
  // overlapping range (how --auto extends a partial week; Check B still guards
  // an exact duplicate).
  const keptOldRanges = old.filter(
    (r) =>
      r.kind === "range" &&
      !midRangeKeys.has(rangeKey(r)) &&
      !midRanges.some((m) => m.from <= r.to && r.from <= m.to)
  )
  const coverRanges = [...midRanges, ...keptOldRanges]
  const keptOldDays = old.filter(
    (b) =>
      b.kind === "day" &&
      !midDayKeys.has(b.date) &&
      !coverRanges.some((r) => r.from <= b.date && b.date <= r.to) &&
      !(removeDaysBefore !== null && b.date < removeDaysBefore)
  )

  // Legacy blocks keep their original order; a copy in cl-mid substitutes for
  // the old text (Check K verifies it lost nothing).
  const consumed = new Set()
  const legacyOut = []
  for (const b of old.filter((x) => x.kind === "legacy")) {
    const copy = mid.find(
      (x) => x.kind === "legacy" && !consumed.has(x) && x.heading.trim() === b.heading.trim()
    )
    if (copy) consumed.add(copy)
    legacyOut.push(copy ?? b)
  }
  for (const b of mid.filter((x) => x.kind === "legacy")) if (!consumed.has(b)) legacyOut.push(b)

  // The sentinel re-opens iff the old region swallowed it. Anything attached
  // under it survives, except the seeded "_Nothing has aged out…_" placeholder
  // once real entries replace it.
  const oldSent = old.find((b) => b.kind === "sentinel")
  const midSent = mid.find((b) => b.kind === "sentinel")
  let sentinelBody = null
  if (oldSent) {
    sentinelBody = stripTrailingJunk(
      (midSent?.body?.length ? midSent.body : oldSent.body).filter(
        (l) => !l.trimStart().startsWith("_Nothing has aged out")
      )
    )
  }

  const h2Days = mid
    .filter((b) => b.kind === "h2day")
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  const dated = [
    ...mid.filter((b) => b.kind === "day"),
    ...midRanges,
    ...keptOldDays,
    ...keptOldRanges,
  ].sort(byNewestFirst)

  const segs = []
  const withRule = (b) =>
    b.body.length ? `${b.heading}\n\n${b.body.join("\n")}\n\n---` : `${b.heading}\n\n---`
  for (const b of h2Days) segs.push(withRule(b))
  for (const b of legacyOut) segs.push(withRule(b))
  if (sentinelBody !== null)
    segs.push(sentinelBody.length ? `${SENTINEL}\n\n${sentinelBody.join("\n")}` : SENTINEL)
  for (const b of dated) segs.push(b.body.length ? `${b.heading}\n${b.body.join("\n")}` : b.heading)

  if (segs.length === 0) return ""
  let out = segs.join("\n\n") + "\n\n"
  // Check F wants the day-separator rule directly above the sentinel; the text
  // before the region normally ends with one, but supply it when it doesn't.
  if (sentinelBody !== null && !endsWithRule(beforeText)) out = `---\n\n${out}`
  return out
}

/**
 * Insert dated `entries` into the archive, newest at top, each placed by date.
 *
 * `entries` is a [date, text][]; each text is a complete `### DATE\n\n…\n\n---\n\n`
 * block. Placement is per entry, not per batch: the verbatim auto-archive path
 * always supplies dates newer than everything already archived, but the pre-1.1
 * summary-only path (`buildAutoArchiveExtras`) archives summary-zone dates that
 * can be OLDER than existing entries. Dropping the whole batch above the newest
 * heading put those older dates above entries that predate them, leaving the
 * archive non-descending — which `--shed-year` then mis-reads, since it slices
 * from the first heading of a year through EOF and trusts years to be contiguous.
 *
 * An entry older than every existing one lands below the last entry but above the
 * archive's trailing notes (the "Earlier years" pointer, the seeded placeholder),
 * which belong to the file rather than to any entry. An archive with no date
 * headings yet seeds at the top of the date zone; an absent one gets a minimal
 * header so the first condense of a repo that never had an archive still lands
 * somewhere sensible.
 */
function insertIntoArchive(arText, entries) {
  const sorted = [...entries].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
  const body = sorted.map(([, text]) => text).join("")
  if (!body) return arText

  if (!arText.trim()) {
    return (
      "# Changelog Archive\n\nFull per-day detail for entries that have aged out of " +
      "`docs/changelog.md`. Newest at top.\n\n---\n\n" + body
    )
  }
  if ([...arText.matchAll(reAnyHeading())].length === 0) {
    const ph = arText.match(/^[ \t]*_Nothing archived[^\n]*/m)
    if (ph) return arText.slice(0, ph.index) + body + arText.slice(ph.index)
    const hr = arText.match(/^-{3,}[ \t]*$/m)
    if (hr) {
      const at = hr.index + hr[0].length
      return arText.slice(0, at) + "\n\n" + body.replace(/\n+$/, "\n") + arText.slice(at)
    }
    return arText.replace(/\n*$/, "\n\n") + body
  }

  // Newest first, so each insert only ever scans an archive whose head is already
  // settled. A range heading compares on its start date, as everywhere else.
  let out = arText
  for (const [date, text] of sorted) {
    const below = [...out.matchAll(reAnyHeading())].find((m) => m[1] < date)
    out = below
      ? out.slice(0, below.index) + text + out.slice(below.index)
      : appendBelowLastEntry(out, text)
  }
  return out
}

/** A date heading of any shape the archive can hold — the boundary between entries. */
const isDateHeadingLine = (line) =>
  /^### \d{4}-\d{2}-\d{2}(?: to \d{4}-\d{2}-\d{2})?[ \t]*$/.test(line) || matchH2Day(line) !== null

/**
 * The units a block contributes, as [start, end) line ranges: each bullet (a
 * column-0 `- ` line plus its continuation lines) or loose paragraph.
 */
function unitsOf(lines) {
  const units = []
  let start = -1
  for (let i = 0; i <= lines.length; i++) {
    const l = lines[i]
    if (start !== -1 && (i === lines.length || l.trim() === "" || /^- /.test(l))) {
      units.push([start, i])
      start = -1
    }
    if (i < lines.length && l.trim() !== "" && start === -1) start = i
  }
  return units
}

/**
 * `lines` minus every unit the archive entry already holds verbatim, line for
 * line — so a block whose detail is partly or wholly archived (an interrupted
 * run, or a late fragment folded beside an already-moved block) adds only what
 * is new. Returns [kept lines, units added, units already there].
 */
function withoutArchivedUnits(lines, entryText) {
  const haystack = `\n${entryText}\n`
  const drop = new Set()
  let added = 0
  let present = 0
  for (const [a, b] of unitsOf(lines)) {
    if (haystack.includes(`\n${lines.slice(a, b).join("\n")}\n`)) {
      present++
      for (let i = a; i < b; i++) drop.add(i)
    } else added++
  }
  const kept = lines.filter((l, i) => !drop.has(i))
  // Dropping a unit can leave two blank lines meeting; one is enough.
  const tidy = kept.filter((l, i) => !(l.trim() === "" && i > 0 && kept[i - 1].trim() === ""))
  return [stripTrailingJunk(tidy), added, present]
}

/**
 * Merge a full-detail block into the archive entry its day ALREADY has.
 *
 * That is the shape a late fragment leaves: written on one day, folded after an
 * earlier condense had already archived that day, so it sits in Tier 1 as a
 * second block for a day the archive holds. Inserting a second `### DATE` for it
 * would duplicate the heading (Check B); refusing — what Check J did through
 * v1.5.0 — stranded the block in Tier 1 with no tool able to move it.
 *
 * A block in canonical `### Category` shape merges bullet by bullet through the
 * fold's own `mergeIntoExistingDay`: an existing section gains the new bullets,
 * a missing one is inserted in canonical position. Anything else (a legacy
 * heading's block, prose outside a category) is appended below the entry's last
 * line as-is, its trailing heading text kept as an italic note, the same way a
 * fresh entry keeps it. Either way a unit the entry already holds verbatim is
 * not added twice, which is also what lets the run after an interrupted write
 * finish the move instead of duplicating it.
 *
 * Returns { text, added, present } — units added, and units already archived.
 */
function mergeIntoArchivedDay(arText, block) {
  const lines = arText.split("\n")
  const h = lines.findIndex(
    (l) => l.match(/^### (\d{4}-\d{2}-\d{2})[ \t]*$/)?.[1] === block.date || matchH2Day(l)?.[1] === block.date
  )
  let end = lines.findIndex((l, i) => i > h && isDateHeadingLine(l))
  if (end === -1) {
    // The last entry: the archive's trailing notes (the "Earlier years" pointer,
    // the seeded placeholder) describe the file, not this day — stay above them.
    end = lines.length
    while (end > h + 1 && (lines[end - 1].trim() === "" || /^[ \t]*[_>]/.test(lines[end - 1]))) end--
  }
  const entry = lines.slice(h + 1, end)
  const entryText = entry.join("\n")

  let cats = null
  if (!block.trailing) {
    try {
      cats = extractFragmentBlocks(block.body.join("\n"))
    } catch (err) {
      if (!(err instanceof FragmentError)) throw err
    }
  }

  let merged
  let added = 0
  let present = 0
  if (cats) {
    const byCategory = new Map()
    for (const { category, rawLines } of cats) {
      const [fresh, a, p] = withoutArchivedUnits(rawLines, entryText)
      added += a
      present += p
      if (fresh.length) byCategory.set(category, (byCategory.get(category) ?? []).concat(fresh))
    }
    merged = mergeIntoExistingDay(entry, byCategory)
  } else {
    const body = (block.trailing ? [`_${block.trailing}_`, ""] : []).concat(block.body)
    const [fresh, a, p] = withoutArchivedUnits(body, entryText)
    added = a
    present = p
    merged = [...entry]
    if (fresh.length) {
      let last = -1
      merged.forEach((l, i) => {
        if (l.trim() !== "" && !/^-{3,}\s*$/.test(l)) last = i
      })
      merged.splice(last + 1, 0, "", ...fresh)
    }
  }
  return { text: [...lines.slice(0, h + 1), ...merged, ...lines.slice(end)].join("\n"), added, present }
}

/**
 * Append `text` below the archive's last entry but above any trailing note lines.
 * Only a trailing run of blanks and note lines (`_italic_`, `> pointer`) is
 * peeled — never a `---` or a body line, so an entry can't be spliced into the
 * middle of the block above it.
 */
function appendBelowLastEntry(arText, text) {
  const lines = arText.split("\n")
  let cut = lines.length
  while (cut > 0 && (lines[cut - 1].trim() === "" || /^[ \t]*[_>]/.test(lines[cut - 1]))) cut--
  const tail = lines.slice(cut)
  if (!tail.some((l) => /^[ \t]*[_>]/.test(l))) return arText.replace(/\n*$/, "\n\n") + text
  const head = lines.slice(0, cut).join("\n").replace(/\n+$/, "")
  return `${head}\n\n${text}${tail.join("\n").replace(/^\n+/, "")}`
}

/**
 * Tier 4: remove trailing week-range blocks whose END date < cutoff.
 *
 * Returns [newText, dropped] where `dropped` is the list of removed ranges as
 * {from, to, body} — the body is what Check H reads to learn which days the
 * range summarizes. Appends to `fails` on any structural surprise (the caller
 * aborts if `fails` is non-empty). Removal is a single splice from the topmost
 * droppable range through the footer, so the last KEPT block, the blank line
 * before the footer, and the footer are all preserved verbatim.
 */
function dropOldRanges(text, cutoff, fails) {
  if (!text.includes(FOOTER)) {
    fails.push("H: cannot run Tier-4 drop - no footer anchor in changelog")
    return [text, []]
  }
  const foot = text.indexOf(FOOTER)
  // A range's body runs to the next heading of any level, or to the footer.
  const heads = [...text.matchAll(reAnyHeading())].map((m) => m.index).filter((i) => i < foot)

  let dropStart = null
  const dropped = []
  for (const m of text.matchAll(reH3Range())) {
    if (m.index >= foot) continue
    if (m[2] < cutoff) {
      if (dropStart === null) dropStart = m.index
      const end = heads.find((i) => i > m.index) ?? foot
      dropped.push({ from: m[1], to: m[2], body: text.slice(m.index + m[0].length, end) })
    }
  }

  if (dropStart === null) return [text, []] // nothing aged past the Tier-4 cutoff

  // The drop region (dropStart .. footer) must contain ONLY droppable ranges:
  // no kept range (would mean ranges are out of chronological order) and no
  // single-day heading (Tier 4 drops week-ranges only, never per-day detail).
  for (const m of text.matchAll(reAnyHeading())) {
    if (!(m.index >= dropStart && m.index < foot)) continue
    if (m[2] === undefined) {
      fails.push(
        `H: single-day heading '${m[1]}' sits in the Tier-4 drop region - ` +
          `refusing (Tier 4 drops week-ranges only)`
      )
    } else if (m[2] >= cutoff) {
      fails.push(
        `H: kept range '${m[1]} to ${m[2]}' (end >= ${cutoff}) sits below a ` +
          `dropped range - ranges out of order, refusing`
      )
    }
  }

  return [text.slice(0, dropStart) + text.slice(foot), dropped]
}

// ---------------------------------------------------------------------------
// Tier planning (--plan)
// ---------------------------------------------------------------------------

/**
 * Shift an ISO date by whole days.
 *
 * This is the ONLY arithmetic on a date anywhere in the payload; entries are
 * always *compared* as strings. It is safe for the same reason that rule exists:
 * `iso` is passed in explicitly via --today and never read from the clock, and the
 * math runs in UTC, so there is no local-midnight boundary to land on the wrong
 * side of. Both inputs and outputs stay plain YYYY-MM-DD strings.
 */
function shiftDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10)
}

/**
 * Absolute week index of an ISO date (days-since-epoch / 7). Same carve-out as
 * `shiftDays`, for the same reasons: the input arrives explicitly (never the
 * clock), the math is pure UTC, and only YYYY-MM-DD strings cross the boundary.
 * Absolute — not anchored to --today — so the bucket a date falls in never
 * changes between runs, which is what lets --auto extend a partial week's range
 * instead of laying a second one beside it.
 */
function weekBucket(iso) {
  const [y, m, d] = iso.split("-").map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / (86400000 * 7))
}

const uniqSorted = (xs) => [...new Set(xs)].sort()

/** Single-quote for a shell, so a backtick in an anchor can't run as a command. */
const shq = (s) => `'${s.split("'").join(`'\\''`)}'`

/**
 * Anchors are matched where they begin a line, so a prefix will do — and a shorter one
 * is better when the full line carries backticks or quotes (the seeded archive
 * placeholder does). Only shorten while the prefix still resolves uniquely.
 */
function shortestUniqueAnchor(line, haystack) {
  const cut = line.search(/[`'"]/)
  if (cut < 8) return line
  const prefix = line.slice(0, cut).trimEnd()
  return countAnchor(haystack, prefix) === 1 ? prefix : line
}

/** The summary section (everything from the sentinel down), or "" if absent. */
function summarySection(clText) {
  const i = clText.search(/^##\s+Earlier Changes/im)
  return i === -1 ? "" : clText.slice(i)
}

/**
 * Classify every heading in changelog.md into tiers for `today`, and derive the
 * anchors a condense run needs. Pure — reads no files, writes nothing.
 */
function planTiers(clText, arText, today, { autoRanges = false } = {}) {
  const keepDetailedSince = shiftDays(today, -3) // Tier 1: 0-3 days
  const tier2From = shiftDays(today, -14) // Tier 2: 4-14 days
  const tier3From = shiftDays(today, -42) // Tier 3: 15-42 days; Tier 4 below

  // Heading TEXT is kept alongside the date: a legacy heading's anchor has to be
  // the line as written, not a reconstructed `## DATE`, so that two same-date
  // legacy headings still yield an anchor that resolves exactly once (Check A).
  const fullDetailHeads = [...clText.matchAll(reH2Day())].map((m) => ({
    date: m[1],
    text: m[0].trim(),
  }))
  const fullDetail = fullDetailHeads.map((h) => h.date)
  const summary = summarySection(clText)
  const summaryDays = [...summary.matchAll(reH3Date())].map((m) => m[1])
  const summaryRanges = [...summary.matchAll(reH3Range())].map((m) => [m[1], m[2]])

  const tier1 = uniqSorted(fullDetail.filter((d) => d >= keepDetailedSince)).reverse()
  const condensingHeads = fullDetailHeads.filter((h) => h.date < keepDetailedSince)
  const condensing = condensingHeads.map((h) => h.date)
  // A day only ages one tier at a time in the normal case, but a long-neglected
  // changelog can have Tier-1 blocks that belong straight in a week-range.
  const toTier2 = uniqSorted(condensing.filter((d) => d >= tier2From)).reverse()
  const collapsing = uniqSorted(
    condensing.filter((d) => d < tier2From && d >= tier3From).concat(
      summaryDays.filter((d) => d < tier2From && d >= tier3From)
    )
  ).reverse()
  const beyondTier3 = uniqSorted(
    condensing.filter((d) => d < tier3From).concat(summaryDays.filter((d) => d < tier3From))
  ).reverse()
  const droppableRanges = summaryRanges.filter(([, end]) => end < tier3From)

  // Full-detail days leaving Tier 1 are moved into the archive verbatim by the
  // run itself. --ar-content is only for summary-section dates collapsing whose
  // detail was never archived — changelogs condensed under the pre-1.1 flow,
  // where Tier-2 summarization discarded the full text.
  const condensingSet = new Set(condensing)
  const arSingles = singleDates(arText)
  const autoArchive = uniqSorted(condensing).reverse()
  const needArContent = uniqSorted(
    [...collapsing, ...beyondTier3].filter((d) => !condensingSet.has(d) && !arSingles.has(d))
  ).reverse()

  // A LATE day: a fragment folded after an earlier run had already condensed its
  // day, so a full-detail block is leaving Tier 1 for a day the archive (and
  // usually the summary zone) already holds. The run merges the block into that
  // archive entry. Its summary has to change too — a Tier-2 `### DATE` gains the
  // new subjects, and (manual flow) a range already covering the day is
  // rewritten rather than overlapped — so those headings join the splice region;
  // left outside it, the new entry would sit beside the old one (Check B).
  const lateArchived = uniqSorted(condensing.filter((d) => arSingles.has(d))).reverse()
  const summaryDaySet = new Set(summaryDays)
  const rejoining = toTier2.filter((d) => summaryDaySet.has(d))
  const coveringRanges = autoRanges
    ? [] // --auto reaches these through mergeRangeKeys, extending the day's line in place
    : summaryRanges
        .filter(([a, b]) => condensing.some((d) => a <= d && d <= b))
        .map(([a, b]) => `${a} to ${b}`)

  // --auto merges a partial week's new days into an existing range in the same
  // absolute week bucket (rather than laying a second range beside it), which
  // requires that range to sit INSIDE the splice region — so it counts as
  // "changed" here. Only ranges wholly within one bucket qualify; a hand-written
  // range spanning buckets is left alone.
  const mergeRangeKeys = !autoRanges
    ? []
    : (() => {
        const buckets = new Set(collapsing.map(weekBucket))
        return summaryRanges
          .filter(([a, b]) => weekBucket(a) === weekBucket(b) && buckets.has(weekBucket(a)))
          .map(([a, b]) => `${a} to ${b}`)
      })()

  // The splice rewrites one contiguous region, from the newest heading that
  // changes down to (exclusive) the first heading below the LAST one that changes.
  // Dates that stay put can sit inside that span — an existing Tier-2 entry is
  // newer than the ones now aging into a week-range — so the region can enclose
  // headings the run re-emits verbatim itself.
  const changedSummaryKeys = new Set([
    ...collapsing,
    ...beyondTier3,
    ...mergeRangeKeys,
    ...rejoining,
    ...coveringRanges,
  ])
  const summaryHeadings = [...summary.matchAll(reAnyHeading())].map((m) => ({
    text: m[0].trim(),
    key: m[2] ? `${m[1]} to ${m[2]}` : m[1],
  }))
  let lastChanged = -1
  summaryHeadings.forEach((h, i) => {
    if (changedSummaryKeys.has(h.key)) lastChanged = i
  })

  // The splice is positional, so the anchor is the TOPMOST heading that changes —
  // in a well-ordered Tier-1 zone that is also the newest one.
  let clStart = null
  if (condensingHeads.length) clStart = condensingHeads[0].text
  else if (lastChanged !== -1) clStart = summaryHeadings.find((h) => changedSummaryKeys.has(h.key)).text

  const clEnd =
    clStart === null ? null : (summaryHeadings[lastChanged + 1]?.text ?? FOOTER)
  // Headings swallowed by the region that this run does not change.
  const reEmit = summaryHeadings
    .slice(0, lastChanged + 1)
    .filter((h) => !changedSummaryKeys.has(h.key))
    .map((h) => h.text)

  // Legacy no-date blocks the region swallows — the run re-emits them itself.
  let legacyInRegion = []
  if (clStart !== null) {
    const i = anchorIndex(clText, clStart)
    const j = anchorIndex(clText, clEnd)
    if (i !== -1 && j > i) legacyInRegion = legacyBlocksIn(clText.slice(i, j)).map((b) => b.heading)
  }

  // Archive anchor: insert above the newest existing entry, or above the seeded
  // placeholder line on the very first Tier-3 run.
  let arBefore = null
  if (arText) {
    const first = [...arText.matchAll(reAnyHeading())][0]
    if (first) arBefore = first[0].trim()
    else {
      const placeholder = arText.split("\n").find((l) => l.trimStart().startsWith("_Nothing archived"))
      if (placeholder) arBefore = shortestUniqueAnchor(placeholder.trim(), arText)
    }
  }

  // Blocks no reader here can classify. `stuck` is the load-bearing half: a day
  // heading in a shape this file can't parse is invisible to every tier, so it
  // contributes nothing to `condensing`/`collapsing` and the run below reports
  // "nothing has aged out" — indistinguishable, until now, from a changelog that
  // genuinely has nothing to do. `legacyOpaque` is the benign remainder, carried
  // through untouched by design; it is counted so the two are never conflated.
  const opaqueHeads = legacyBlocksIn(clText).map((b) => b.heading.trim())
  const stuck = opaqueHeads.filter((h) => STUCK_DAY_RE.test(h))
  const legacyOpaque = opaqueHeads.filter((h) => !STUCK_DAY_RE.test(h))

  // The archive can shed its oldest complete year once it's big enough to matter.
  const arYears = uniqSorted([...arText.matchAll(reAnyHeading())].map((m) => m[1].slice(0, 4)))
  const arLines = arText ? arText.split("\n").length : 0
  const shedYear = arLines > 2000 && arYears.length > 1 ? arYears[0] : null

  return {
    today,
    keepDetailedSince,
    tier2From,
    tier3From,
    tier1,
    toTier2,
    collapsing,
    beyondTier3,
    droppableRanges,
    clStart,
    clEnd,
    reEmit,
    autoArchive,
    needArContent,
    legacyInRegion,
    mergeRangeKeys,
    lateArchived,
    rejoining,
    coveringRanges,
    stuck,
    legacyOpaque,
    arBefore,
    needsArchive: needArContent.length > 0,
    dropRangesBefore: tier3From,
    shedYear,
    archiveLines: arLines,
  }
}

/**
 * The unreadable `##` blocks, spelled out with the fix. Shared by --plan and
 * --auto so both name the problem identically — the failure this exists to stop
 * is a caller being told there is nothing to do and believing it.
 */
function unreadableReport(stuck) {
  const out = [
    `${stuck.length} '##' block(s) lead with a date this tooling cannot read, so they sit in`,
    "no tier at all and no condense run can ever move them:",
    "",
  ]
  for (const h of stuck.slice(0, 8)) out.push(`    ${h}`)
  if (stuck.length > 8) out.push(`    … and ${stuck.length - 8} more`)
  out.push(
    "",
    "  A day heading must be '## YYYY-MM-DD'. Trailing text after the date is fine",
    "  ('## 2026-07-26 (retro)'); brackets or emphasis around it are not.",
    "",
    "  Fix the headings — leaving every body line byte-for-byte — and re-run. Do not",
    "  summarize or trim these entries by hand instead: this script is what moves detail",
    "  to the archive, and detail rewritten in an editor is detail gone."
  )
  return out.join("\n")
}

/** Human-readable plan + the exact command to run. */
function formatPlan(p, args) {
  const out = []
  const list = (xs) => (xs.length ? xs.join(", ") : "(none)")

  out.push(`Plan for --today ${p.today} — nothing written.`)
  out.push("")
  out.push(`  Tier 1  full detail, never touched   (>= ${p.keepDetailedSince}): ${list(p.tier1)}`)
  out.push(`  Tier 2  condense to '### DATE'       (>= ${p.tier2From}): ${list(p.toTier2)}`)
  out.push(`  Tier 3  collapse into week-ranges    (>= ${p.tier3From}): ${list(p.collapsing)}`)
  if (p.beyondTier3.length)
    out.push(`  past T3 archive only, no range       (< ${p.tier3From}): ${list(p.beyondTier3)}`)
  out.push(
    `  Tier 4  week-ranges to drop          (end < ${p.tier3From}): ` +
      list(p.droppableRanges.map(([x, y]) => `${x} to ${y}`))
  )
  // Same column as the tier rows above: an unreadable block is not a fifth tier,
  // it is the reason a tier row above it may be lying by omission.
  const extraRow = (tag, label, n) => `  ${tag.padEnd(6)}  ${label.padEnd(44)}: ${n} block(s)`
  if (p.stuck.length)
    out.push(extraRow("??", "UNREADABLE — in no tier, cannot age out", p.stuck.length))
  if (p.legacyOpaque.length)
    out.push(extraRow("--", "legacy, no date — kept as is, never condensed", p.legacyOpaque.length))
  out.push("")

  if (!p.clStart && !p.droppableRanges.length) {
    // The distinction this branch exists to make. "Nothing aged out" and
    // "nothing I can READ aged out" are the same tier tables and opposite
    // situations, and reporting the second as the first is how a changelog gets
    // hand-edited: the tool says there is no work, the entries plainly need it.
    if (p.stuck.length) {
      out.push(
        "NOT an all-clear. Nothing this tool can read has aged out — but it cannot read",
        "everything in this file, so it has no idea whether a condense is due.",
        "",
        unreadableReport(p.stuck)
      )
      return out.join("\n")
    }
    out.push("Nothing has aged out yet — no condense run needed today.")
    return out.join("\n")
  }

  if (p.stuck.length)
    out.push(
      "WARNING — the plan below is partial:",
      "",
      unreadableReport(p.stuck),
      "",
      "The run described below is still correct for the entries it CAN read; it splices",
      "around the blocks above and conserves them (Check K). Fix them to age them out.",
      ""
    )

  out.push(
    "Deterministic option — no temp files, no summaries to write; generates every tier from the",
    "entries' **bold subjects**, anchor links, and issue refs, then runs the same checks:",
    `  node scripts/condense-changelog.mjs --auto --today ${p.today} [--dry-run]`,
    "",
    "Or write the summaries yourself:",
    ""
  )

  const cmd = ["node scripts/condense-changelog.mjs \\"]
  cmd.push(`    --changelog ${forDisplay(args.changelog)} \\`)
  if (p.clStart) {
    cmd.push(`    --cl-start ${shq(p.clStart)} \\`)
    cmd.push(`    --cl-end   ${shq(p.clEnd)} \\`)
    cmd.push(`    --cl-mid   /tmp/cl-mid.md \\`)
  }
  cmd.push(`    --archive ${forDisplay(args.archive)} \\`)
  if (p.needsArchive) {
    cmd.push(`    --ar-before ${shq(p.arBefore ?? "<newest archive heading>")} \\`)
    cmd.push(`    --ar-content /tmp/ar-new.md \\`)
  }
  if (p.clStart) cmd.push(`    --keep-detailed-since ${p.keepDetailedSince} \\`)
  if (p.shedYear) cmd.push(`    --shed-year ${p.shedYear} \\`)
  cmd.push(`    --drop-ranges-before ${p.dropRangesBefore}`)

  if (p.clStart) {
    out.push(
      `Write /tmp/cl-mid.md — the NEW summary text only, in any order (the run re-opens the ` +
        `section, re-emits what doesn't change, and sorts everything newest-first itself):`
    )
    if (p.toTier2.length) out.push(`  - new '### DATE' per-day summaries for ${list(p.toTier2)}`)
    if (p.collapsing.length)
      out.push(`  - new '### X to Y' week-range summaries covering ${list(p.collapsing)}`)
    out.push(
      `Carry each entry's **bold subject**, anchor-file links, and issue/PR refs into the ` +
        `summaries — they are what future greps find.`
    )
    if (p.reEmit.length)
      out.push(
        `Unchanged entries inside the region (${list(p.reEmit)}) are re-emitted by the run ` +
          `automatically — leave them out of cl-mid.`
      )
    if (p.autoArchive.length)
      out.push(
        `The run moves the full-detail blocks for ${list(p.autoArchive)} into the archive ` +
          `verbatim itself — do not re-type them in cl-mid or ar-new.md.`
      )
    if (p.lateArchived.length)
      out.push(
        `${list(p.lateArchived)} already in the archive (a fragment folded after an earlier ` +
          `condense): the run merges the new bullets into that entry — it gets no second one.`
      )
    if (p.rejoining.length)
      out.push(
        `${list(p.rejoining)} already summarized: your '### DATE' replaces that entry, so carry its ` +
          `lines over alongside the new subjects.`
      )
    if (p.coveringRanges.length)
      out.push(
        `Range(s) ${list(p.coveringRanges)} already cover a late day: write that week's range to ` +
          `replace it, carrying its lines over, rather than a per-day entry beside it (Check E).`
      )
    if (p.legacyInRegion.length)
      out.push(
        `Legacy block(s) inside the region (${p.legacyInRegion.join(", ")}) are re-emitted by ` +
          `the run automatically — leave them out of cl-mid.`
      )
    if (p.needsArchive)
      out.push(
        `Write /tmp/ar-new.md: per-day detail for ${list(p.needArContent)} (the changelog holds ` +
          `only their summaries — the pre-1.1 flow discarded the detail), newest first, each ` +
          `followed by a '---' line.`
      )
    out.push("")
  }
  if (p.shedYear)
    out.push(
      `Archive is ${p.archiveLines} lines — shedding ${p.shedYear} into a per-year file.\n`
    )
  out.push("Then run:")
  out.push(cmd.join("\n"))
  return out.join("\n")
}

// ---------------------------------------------------------------------------
// Deterministic summaries (--auto)
// ---------------------------------------------------------------------------

/**
 * The bullets of a block body: each is a column-0 `- ` line plus its indented
 * continuation lines. `### Category` headings and blank lines delimit; they are
 * context, not bullet content.
 */
function bulletsOf(bodyLines) {
  const bullets = []
  let cur = null
  for (const line of bodyLines) {
    if (/^- /.test(line)) {
      if (cur) bullets.push(cur)
      cur = [line]
    } else if (cur && line.trim() !== "" && !/^#{2,4}[ \t]/.test(line)) {
      cur.push(line)
    } else if (cur) {
      bullets.push(cur)
      cur = null
    }
  }
  if (cur) bullets.push(cur)
  return bullets
}

/**
 * A bullet's retrieval keys — the same ones the fragment lint asks for. The
 * summary tiers exist to keep these greppable while the archive holds the full
 * text, so a deterministic summary is exactly: subject + first anchor link +
 * issue/PR refs. A bullet with no **bold subject** can't be condensed without
 * inventing prose, so its first line rides along verbatim instead.
 */
function bulletKeys(bulletLines) {
  const text = bulletLines.map((l) => l.trim()).join(" ")
  return {
    subject: text.match(/^- \*\*([^*]+)\*\*/)?.[1] ?? null,
    link: text.match(/\[[^\]]*\]\([^)]*\)/)?.[0] ?? null,
    refs: [...text.matchAll(/\(#\d+\)/g)].map((m) => m[0]),
    firstLine: bulletLines[0],
  }
}

/** One Tier-2 summary line per source bullet. */
function tier2Line(bulletLines) {
  const k = bulletKeys(bulletLines)
  if (!k.subject) return k.firstLine
  return `- **${k.subject}**${k.link ? ` — ${k.link}` : ""}${k.refs.length ? ` ${k.refs.join(" ")}` : ""}`
}

/** One Tier-3 item per source bullet — subject + refs; links live on in the archive. */
function tier3Item(bulletLines) {
  const k = bulletKeys(bulletLines)
  if (!k.subject) return k.firstLine.replace(/^- /, "")
  return `**${k.subject}**${k.refs.length ? ` ${k.refs.join(" ")}` : ""}`
}

/**
 * Build the --cl-mid content for an --auto run: Tier-2 per-day entries from the
 * full-detail blocks leaving Tier 1, and Tier-3 week-ranges (one per absolute
 * week bucket) from the collapsing days' existing summaries. A range already in
 * the same bucket is extended — its body is carried over and the new day lines
 * appended — rather than duplicated beside it.
 */
function buildAutoMid(clText, plan) {
  const summaryBlocks = parseRegionBlocks(summarySection(clText), "summary", [])
  const summaryDayBody = (date) =>
    summaryBlocks.find((b) => b.kind === "day" && b.date === date)?.body ?? null
  const fullDetailBody = (date) =>
    dayBlocksIn(clText)
      .filter((b) => b.date === date)
      .flatMap((b) => (b.trailing ? [`_${b.trailing}_`] : []).concat(b.body))
  // A late day has BOTH sources: the summary an earlier run wrote, and the
  // full-detail block a fragment folded after that run. Its entry is fed by both,
  // the existing summary first and nothing said twice — reading only the summary
  // (what this did through v1.5.0) left the late fragment's subjects out.
  const sourceItems = (date) => [
    ...new Set(
      [...bulletsOf(summaryDayBody(date) ?? []), ...bulletsOf(fullDetailBody(date))].map(tier3Item)
    ),
  ]

  const parts = []
  for (const date of plan.toTier2) {
    // An existing Tier-2 entry keeps its lines verbatim; the new ones follow.
    const existing = summaryDayBody(date) ?? []
    const fresh = bulletsOf(fullDetailBody(date))
      .map(tier2Line)
      .filter((l) => !existing.includes(l))
    const lines = [...existing, ...fresh]
    if (lines.length) parts.push(`### ${date}\n${lines.join("\n")}`)
  }

  const buckets = new Map()
  for (const d of plan.collapsing) {
    const k = weekBucket(d)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(d)
  }
  const mergeKeys = new Set(plan.mergeRangeKeys)
  for (const [k, days] of [...buckets].sort((a, b) => b[0] - a[0])) {
    days.sort()
    let from = days[0]
    let to = days[days.length - 1]
    const body = []
    let extending = false
    for (const r of summaryBlocks.filter(
      (b) => b.kind === "range" && mergeKeys.has(`${b.from} to ${b.to}`) && weekBucket(b.from) === k
    )) {
      extending = true
      if (r.from < from) from = r.from
      if (r.to > to) to = r.to
      body.push(...r.body)
    }

    // A week that holds exactly one day is written as that day, not as a range
    // from it to itself. `### D to D` was valid to every regex and wrong to every
    // reader: it claims a span that doesn't exist, and --report filed it under
    // "summary ranges" so a repo whose Tier 3 was all single days reported zero
    // summary days. The entry keeps Tier-3 content (subject + refs, no links —
    // those live on in the archive), which is exactly what a later run reads back
    // out of it if more days in this week arrive and it becomes a real range.
    //
    // Only when nothing is being extended: merging into an existing range has to
    // keep the range shape, or the old heading would survive beside the new day
    // and Check E would refuse the run for covering one with the other.
    if (!extending && from === to) {
      const items = sourceItems(from).map((item) => `- ${item}`)
      parts.push(items.length ? `### ${from}\n${items.join("\n")}` : `### ${from}`)
      continue
    }

    for (const d of [...days].reverse()) {
      const items = sourceItems(d)
      // The range already names a late day: that line gains the new items in
      // place, instead of a second `- DATE —` line for the same day below it.
      const at = body.findIndex((l) => l.startsWith(`- ${d} — `))
      if (at === -1) {
        body.push(`- ${d} — ${items.join("; ")}`)
        continue
      }
      const missing = items.filter((item) => !body[at].includes(item))
      if (missing.length) body[at] = `${body[at]}; ${missing.join("; ")}`
    }
    parts.push(`### ${from} to ${to}\n${body.join("\n")}`)
  }
  return parts.length ? parts.join("\n\n") + "\n" : ""
}

/**
 * Archive entries for the pre-1.1 gap: summary-section dates collapsing whose
 * full detail was never archived (the old flow discarded it). The only content
 * that still exists is the summary itself, so it moves to the archive verbatim,
 * marked for what it is. Map of date → entry body.
 */
function buildAutoArchiveExtras(clText, plan) {
  const summaryBlocks = parseRegionBlocks(summarySection(clText), "summary", [])
  const extras = new Map()
  for (const date of plan.needArContent) {
    const body = summaryBlocks.find((b) => b.kind === "day" && b.date === date)?.body
    if (body?.length)
      extras.set(
        date,
        `_Summary only — the full detail predates the verbatim archive._\n\n${body.join("\n")}`
      )
  }
  return extras
}

/** Pending fragment filenames next to `changelogPath`, or [] when none/unreadable. */
function pendingFragments(changelogPath) {
  try {
    return readdirSync(join(dirname(resolve(changelogPath)), "changelog.d")).filter(
      (n) => n.endsWith(".md") && n !== "README.md"
    )
  } catch {
    return []
  }
}

/**
 * Take the fold's lock for a run that writes, or exit. This run reads the
 * changelog, computes, and writes it back; a fold landing inside that span
 * would be silently overwritten — the same read-modify-write race the fragment
 * system exists to remove, so it is serialized on the same file with the same
 * wx-create and dead-pid reclaim the fold uses. A missing changelog.d/ means no
 * fold can run against this changelog at all: nothing to serialize with, no
 * lock taken.
 */
function acquireFoldLock(changelogPath) {
  const lockPath = join(dirname(resolve(changelogPath)), "changelog.d", ".fold.lock")
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" })
      process.on("exit", () => rmSync(lockPath, { force: true }))
      return
    } catch (err) {
      if (err.code === "ENOENT") return // no changelog.d/ — no fold to serialize with
      if (err.code !== "EEXIST") throw err
      const holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10)
      if (attempt === 0 && Number.isInteger(holder) && !isAlive(holder)) {
        console.warn(`condense-changelog: reclaiming stale lock from dead pid ${holder}`)
        rmSync(lockPath, { force: true })
        continue
      }
      console.error(
        `condense-changelog: a fold or another condense is running (pid ${holder || "unknown"}) — ` +
          `wait for it, or delete ${lockPath} if you're certain it's stale.`
      )
      process.exit(1)
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === "EPERM" // exists, owned by someone else
  }
}

/** Write via temp file + rename so a crash can't leave a half-written file. */
function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true }) // don't leave a stray temp file in the tree
    throw err
  }
}

// ---------------------------------------------------------------------------
// Archive year shed (--shed-year)
// ---------------------------------------------------------------------------

/**
 * Partition the oldest complete year out of the archive.
 *
 * Returns { archive, yearText, yearPath, moved } or null on failure (with reasons
 * pushed onto `fails`). No entry text is rewritten: the moved block is copied
 * verbatim under a new title, and what stays is the untouched prefix plus any
 * trailing note lines.
 */
function shedYearFromArchive(arText, year, archivePath, fails) {
  const headings = [...arText.matchAll(reAnyHeading())]
  if (headings.length === 0) {
    fails.push(`I: --shed-year ${year}: archive has no date headings to shed`)
    return null
  }
  const years = uniqSorted(headings.map((m) => m[1].slice(0, 4)))
  if (!years.includes(year)) {
    fails.push(`I: --shed-year ${year}: no archive heading falls in ${year} (present: ${years.join(", ")})`)
    return null
  }
  if (years.length === 1) {
    fails.push(`I: --shed-year ${year}: it is the only year in the archive — refusing to empty it`)
    return null
  }
  if (year !== years[0]) {
    fails.push(
      `I: --shed-year ${year}: shed the OLDEST year first (${years[0]}) — one year per run`
    )
    return null
  }

  const yearPath = archivePath.endsWith(".md")
    ? `${archivePath.slice(0, -3)}-${year}.md`
    : `${archivePath}-${year}.md`
  if (existsSync(yearPath)) {
    fails.push(`I: --shed-year ${year}: ${yearPath} already exists — refusing to overwrite`)
    return null
  }

  const blockStart = headings.find((m) => m[1].slice(0, 4) === year).index
  const lines = arText.slice(blockStart).split("\n")

  // Trailing note lines (the seeded placeholder, a pointer) belong to the archive,
  // not to the year being moved. Only peel a trailing run that actually looks like
  // a note — never a bullet's continuation line.
  let cut = lines.length
  while (cut > 0 && !/^#{1,6}\s/.test(lines[cut - 1]) && !lines[cut - 1].trimStart().startsWith("- ")) {
    cut--
  }
  const tail = lines.slice(cut)
  const isNote = tail.some((l) => /^\s*[_>]/.test(l))
  const moved = (isNote ? lines.slice(0, cut) : lines).join("\n").replace(/\n+$/, "")
  const keptTail = isNote ? tail.join("\n").replace(/^\n+/, "") : ""

  const yearText = `# Changelog Archive — ${year}\n\nEntries from ${year}, moved out of \`changelog-archive.md\` verbatim. Static — no tool writes this file.\n\n---\n\n${moved}\n`

  let archive = arText.slice(0, blockStart).replace(/\n+$/, "\n")
  if (keptTail) archive += `\n${keptTail.replace(/\n+$/, "")}\n`

  // Refresh the "Earlier years" pointer so shed history stays discoverable.
  const fileFor = (y) => {
    const base = (archivePath.split("/").pop() ?? archivePath).replace(/\.md$/, "")
    return `${base}-${y}.md`
  }
  const oldPointer = arText.match(/^> Earlier years:.*$/m)?.[0] ?? null
  const shedSoFar = uniqSorted([
    year,
    ...[...(oldPointer ?? "").matchAll(/\[(\d{4})\]/g)].map((m) => m[1]),
  ]).reverse()
  const pointer = `> Earlier years: ${shedSoFar.map((y) => `[${y}](${fileFor(y)})`).join(", ")}`

  if (/^> Earlier years:.*$/m.test(archive)) {
    archive = archive.replace(/^> Earlier years:.*$/m, pointer)
  } else {
    const arLines = archive.split("\n")
    const at = arLines.findIndex((l) => /^-{3,}\s*$/.test(l))
    const insertAt = at === -1 ? arLines.findIndex((l) => l.startsWith("# ")) + 1 : at + 1
    arLines.splice(insertAt, 0, "", pointer)
    archive = arLines.join("\n")
  }

  // Check I: the partition conserves every heading and every non-blank line.
  const keyOf = (m) => (m[2] ? `${m[1]} to ${m[2]}` : m[1])
  const beforeKeys = headings.map(keyOf).sort()
  const afterKeys = [...archive.matchAll(reAnyHeading())]
    .map(keyOf)
    .concat([...yearText.matchAll(reAnyHeading())].map(keyOf))
    .sort()
  if (beforeKeys.join("|") !== afterKeys.join("|")) {
    fails.push(
      `I: --shed-year ${year}: heading set changed (${beforeKeys.length} before, ${afterKeys.length} after)`
    )
    return null
  }

  const added = new Set([pointer, `# Changelog Archive — ${year}`,
    `Entries from ${year}, moved out of \`changelog-archive.md\` verbatim. Static — no tool writes this file.`])
  const bag = new Map()
  for (const l of arText.split("\n")) if (l.trim() !== "") bag.set(l, (bag.get(l) ?? 0) + 1)
  if (oldPointer) bag.delete(oldPointer) // superseded by the refreshed pointer
  for (const l of `${archive}\n${yearText}`.split("\n")) {
    if (l.trim() === "") continue
    if (bag.get(l)) bag.set(l, bag.get(l) - 1)
    else if (added.has(l) || /^-{3,}\s*$/.test(l)) continue
    else {
      fails.push(`I: --shed-year ${year}: partition invented a line: ${JSON.stringify(l.slice(0, 60))}`)
      return null
    }
  }
  for (const [l, n] of bag) {
    if (n > 0) {
      fails.push(`I: --shed-year ${year}: partition lost a line: ${JSON.stringify(l.slice(0, 60))}`)
      return null
    }
  }

  return { archive, yearText, yearPath, moved: [...new Set(headings.map(keyOf).filter((k) => k.slice(0, 4) === year))] }
}

/**
 * The days a week-range body names — the `- YYYY-MM-DD — …` lines `--auto`
 * writes, one per day the range summarizes.
 */
function daysNamedInRange(body) {
  return uniqSorted(
    [...body.matchAll(/^[ \t]*-[ \t]+(\d{4}-\d{2}-\d{2})(?=[ \t]|$)/gm)].map((m) => m[1])
  )
}

/**
 * Check H's archive-coverage test for the ranges Tier 4 is about to delete.
 *
 * A range built by `--auto` names the days it summarizes, so coverage is
 * checkable day by day: each of those days must have its own archive entry,
 * because once the range paragraph goes the archive is the only copy left.
 * Testing the span for *any* overlapping archive heading — what this did before
 * v1.4.1 — waves through a range whose days are only PARTLY archived, which is
 * exactly the shape a repo upgrading from pre-1.1 has: days condensed under the
 * old flow got no archive entry, days condensed since got a verbatim one, and
 * one calendar week can hold both. The overlap then found the archived day and
 * the drop silently took the others' last trace with it.
 *
 * A hand-written range names no days and there is nothing to enumerate, so it
 * falls back to that span test — reported in `loose` rather than waved through
 * quietly. Returns {missing, loose}.
 */
function archiveCoverage(dropped, arText) {
  const arSingles = [...singleDates(arText)]
  const arRanges = rangesOf(arText)
  const archived = (d) => arSingles.includes(d) || arRanges.some(([a, b]) => a <= d && d <= b)

  const missing = []
  const loose = []
  for (const { from, to, body } of dropped) {
    const days = daysNamedInRange(body)
    if (days.length) {
      const gaps = days.filter((d) => !archived(d))
      if (gaps.length) missing.push({ from, to, days: gaps })
    } else if (
      !arSingles.some((s) => from <= s && s <= to) &&
      !arRanges.some(([a, b]) => a <= to && b >= from)
    ) {
      missing.push({ from, to, days: null })
    } else {
      loose.push({ from, to })
    }
  }
  return { missing, loose }
}

function parseArgs(argv) {
  const known = new Set([
    "--changelog",
    "--cl-start",
    "--cl-end",
    "--cl-mid",
    "--archive",
    "--ar-before",
    "--ar-content",
    "--keep-detailed-since",
    "--drop-ranges-before",
    "--shed-year",
    "--today",
  ])
  const args = { dryRun: false, plan: false, auto: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run") {
      args.dryRun = true
      continue
    }
    if (a === "--plan") {
      args.plan = true
      continue
    }
    if (a === "--auto") {
      args.auto = true
      continue
    }
    if (a === "-h" || a === "--help") {
      args.help = true
      continue
    }
    if (!known.has(a)) usageError(`unknown argument ${a}`)
    const v = argv[++i]
    if (v === undefined || v.startsWith("--")) usageError(`${a} needs a value`)
    args[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v
  }
  return args
}

function usageError(msg) {
  console.error(`condense-changelog: ${msg}`)
  console.error("See the header of this file for usage, or run with --help.")
  process.exit(2)
}

/** Read a file the run can't proceed without, without a raw ENOENT stack trace. */
function readRequired(path, flag) {
  try {
    return readFileSync(path, "utf8")
  } catch (err) {
    if (err.code === "ENOENT") usageError(`${path} not found — pass ${flag} <path>`)
    throw err
  }
}

/** Repo-relative where possible, so the command --plan prints stays pasteable. */
const forDisplay = (path) => (path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path)

function abort(fails) {
  console.error("ABORT - nothing written. Verification failed:")
  for (const f of fails) console.error(`  - ${f}`)
  return 1
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    console.log(readFileSync(SELF, "utf8").split("*/")[0])
    return 0
  }
  for (const k of ["keepDetailedSince", "dropRangesBefore", "today"]) {
    if (args[k] && !DATE_RE.test(args[k])) usageError(`--${k} must be YYYY-MM-DD`)
  }
  if (args.shedYear && !/^\d{4}$/.test(args.shedYear)) usageError("--shed-year must be YYYY")

  // A path the caller named must exist (a typo is worth stopping for); the
  // conventional archive merely not being there yet reads as "nothing archived".
  const namedArchive = Boolean(args.archive)
  args.changelog ??= DEFAULT_CHANGELOG
  args.archive ??= DEFAULT_ARCHIVE
  const readArchive = () =>
    namedArchive || existsSync(args.archive) ? readRequired(args.archive, "--archive") : ""

  // The critical section is this read -> the writes at the bottom of main.
  // --plan and --dry-run never reach those writes, so they stay lock-free —
  // the same rule that keeps --report safe to run against a fold in flight.
  if (!args.plan && !args.dryRun) acquireFoldLock(args.changelog)

  const oldCl = readRequired(args.changelog, "--changelog")
  const fails = []

  // --- Planning mode: read-only, returns before any splice ---
  if (args.plan) {
    if (args.auto) usageError("pick one of --plan (read-only) or --auto (derive and run)")
    if (!args.today) {
      usageError("--plan requires --today YYYY-MM-DD (pass it explicitly; the clock is never read)")
    }
    const pending = pendingFragments(args.changelog)
    if (pending.length)
      console.log(
        `NOTE: ${pending.length} pending fragment(s) in docs/changelog.d — fold them first so ` +
          `this plan (and the run it prints) sees a complete file.\n`
      )
    const plan = planTiers(oldCl, readArchive(), args.today)
    console.log(formatPlan(plan, args))
    // A plan is read-only, so it exits 0 on everything it can answer — including
    // a genuine "nothing to do". The one non-zero case is the one where it cannot
    // answer at all: unreadable blocks and no readable work, where returning 0
    // would be reporting "no condense needed" about a file it never parsed.
    // A partial plan (unreadable blocks AND real work) warns and still exits 0 —
    // that work is worth doing, and gating it would only stop the fixable case.
    return plan.stuck.length && !plan.clStart && !plan.droppableRanges.length ? 1 : 0
  }
  if (args.today && !args.auto) usageError("--today is only meaningful with --plan or --auto")

  // --- Deterministic mode: derive the whole run from the plan ---
  let autoMidText = null
  let autoArchiveExtras = null
  if (args.auto) {
    if (!args.today) {
      usageError("--auto requires --today YYYY-MM-DD (pass it explicitly; the clock is never read)")
    }
    for (const [k, flag] of [
      ["clStart", "--cl-start"],
      ["clEnd", "--cl-end"],
      ["clMid", "--cl-mid"],
      ["arBefore", "--ar-before"],
      ["arContent", "--ar-content"],
      ["keepDetailedSince", "--keep-detailed-since"],
      ["dropRangesBefore", "--drop-ranges-before"],
      ["shedYear", "--shed-year"],
    ]) {
      if (args[k]) usageError(`--auto derives the whole run itself — drop ${flag}`)
    }
    const plan = planTiers(oldCl, readArchive(), args.today, { autoRanges: true })
    if (!plan.clStart && !plan.droppableRanges.length && !plan.shedYear) {
      // Same distinction --plan makes, and the more important place to make it:
      // this is the command cron and /changelog-condense actually run, so "nothing
      // to do" here is the sentence a caller acts on.
      if (plan.stuck.length) {
        fails.push(
          "unreadable changelog: nothing this script can read has aged out, and it cannot read " +
            "everything in this file — refusing to report 'nothing to do'.\n\n" +
            unreadableReport(plan.stuck)
        )
        return abort(fails)
      }
      console.log(`Nothing has aged out for --today ${args.today} — nothing to do.`)
      return 0
    }
    if (plan.stuck.length)
      console.warn(
        `condense-changelog: WARNING — this run is partial.\n\n${unreadableReport(plan.stuck)}\n\n` +
          `  It splices around those blocks and conserves them (Check K); they never age out.\n`
      )
    args.keepDetailedSince = plan.keepDetailedSince
    args.dropRangesBefore = plan.dropRangesBefore
    if (plan.shedYear) args.shedYear = plan.shedYear
    if (plan.clStart) {
      args.clStart = plan.clStart
      args.clEnd = plan.clEnd
      autoMidText = buildAutoMid(oldCl, plan)
      autoArchiveExtras = buildAutoArchiveExtras(oldCl, plan)
    }
  }

  // --- Which operations were requested? ---
  const clFlags = [args.clStart, args.clEnd, args.clMid]
  const haveSplice = clFlags.some(Boolean) || autoMidText !== null
  if (haveSplice && autoMidText === null && !clFlags.every(Boolean)) {
    fails.push("Tier-2/3 splice needs all of --cl-start, --cl-end, --cl-mid (or none)")
    return abort(fails)
  }
  if (!haveSplice && !args.dropRangesBefore && !args.shedYear) {
    fails.push(
      "nothing to do: pass the --cl-* splice group, --drop-ranges-before and/or --shed-year " +
        "(or --plan --today to see what this run should do, or --auto --today to just do it)"
    )
    return abort(fails)
  }

  // A splice must start from a complete changelog: a pending fragment is a Tier-1
  // day the file doesn't have yet, and one with a stale date could even belong to
  // a day this run condenses. Tier-4-only and shed runs never touch that zone, so
  // they only warn.
  const pending = pendingFragments(args.changelog)
  if (pending.length && haveSplice) {
    fails.push(
      `L: ${pending.length} pending fragment(s) in docs/changelog.d — fold them into the ` +
        `changelog first (the fold only adds Tier-1 days, never disturbing what this run ` +
        `condenses), or fix/remove any unfoldable ones`
    )
    return abort(fails)
  }
  if (pending.length) {
    console.warn(
      `condense-changelog: note — ${pending.length} pending fragment(s) in docs/changelog.d; ` +
        `this run doesn't touch Tier 1, but fold them soon`
    )
  }
  // --archive is never unset now (it defaults to the conventional path), so the
  // coverage checks below always have something to read. An archive that is empty
  // or absent isn't waved through: Check H reports every dropped range as
  // uncovered, and Check I refuses a shed with no headings to move.

  // --- Check A + Tier-2/3 splice (optional) ---
  let newCl = oldCl
  let removedDayBlocks = []
  if (haveSplice) {
    const mid = autoMidText ?? readFileSync(args.clMid, "utf8")
    const nStart = countAnchor(oldCl, args.clStart)
    const nEnd = countAnchor(oldCl, args.clEnd)
    if (nStart !== 1)
      fails.push(`A: --cl-start '${args.clStart}' occurs ${nStart}x in changelog (need 1)`)
    if (nEnd !== 1) fails.push(`A: --cl-end '${args.clEnd}' occurs ${nEnd}x in changelog (need 1)`)
    if (!fails.length && anchorIndex(oldCl, args.clStart) >= anchorIndex(oldCl, args.clEnd))
      fails.push("A: --cl-start does not precede --cl-end")
    if (fails.length) return abort(fails)

    const i = anchorIndex(oldCl, args.clStart)
    const j = anchorIndex(oldCl, args.clEnd)
    const region = oldCl.slice(i, j)
    // cl-mid carries only the NEW summary text; the assembler re-opens the
    // sentinel, re-emits unchanged and legacy blocks from the old region, and
    // orders everything — see assembleRegion. Checks C/D/E/K then verify the
    // result the same way they verified a hand-assembled region.
    const assembled = assembleRegion(region, mid, oldCl.slice(0, i), fails, {
      removeDaysBefore: args.dropRangesBefore ?? null,
    })
    if (fails.length) return abort(fails)
    newCl = oldCl.slice(0, i) + assembled + oldCl.slice(j)
    const kept = h2Dates(newCl)
    removedDayBlocks = dayBlocksIn(region).filter((b) => !kept.has(b.date))
  }

  // --- Archive splice (optional) ---
  const doArchive = Boolean(args.arBefore && args.arContent)
  if ((args.arBefore || args.arContent) && !doArchive) {
    fails.push("archive splice needs both --ar-before and --ar-content (or neither)")
    return abort(fails)
  }

  const oldAr = readArchive()
  let newAr = oldAr
  let arContent = ""
  if (doArchive) {
    arContent = readFileSync(args.arContent, "utf8")
    const nBefore = countAnchor(oldAr, args.arBefore)
    if (nBefore !== 1) {
      fails.push(`A: --ar-before '${args.arBefore}' occurs ${nBefore}x in archive (need 1)`)
      return abort(fails)
    }
    const k = anchorIndex(oldAr, args.arBefore)
    newAr = oldAr.slice(0, k) + arContent + oldAr.slice(k)
  }

  // --- Verbatim auto-archive of removed full-detail days (Check J) ---
  // The archive, not git archaeology, is where a grep for old detail lands — so
  // the detail moves there byte-for-byte the moment it leaves Tier 1. The model
  // never re-types it and never summarizes it away.
  let autoArchived = []
  const mergedLate = []
  const archiveExtras = autoArchiveExtras ?? new Map()
  if (removedDayBlocks.length || archiveExtras.size) {
    // A day this run's --ar-content also writes is a collision: the run archives
    // removed days itself, so that copy would be a second entry for the day. A day
    // the archive held BEFORE this run is a late fragment (or the run after an
    // interrupted write) — merged below, not refused.
    const fromArContent = singleDates(arContent)
    for (const date of uniqSorted(removedDayBlocks.map((b) => b.date))) {
      if (fromArContent.has(date))
        fails.push(
          `J: full-detail day '${date}' leaving the changelog also has an --ar-content entry - ` +
            `the run archives removed days verbatim itself; remove '### ${date}' from --ar-content`
        )
    }
    const already = singleDates(newAr)
    for (const date of [...archiveExtras.keys()].sort()) {
      if (already.has(date))
        fails.push(`J: '${date}' already has an archive entry - refusing to add a second one`)
    }
    if (fails.length) return abort(fails)

    const preArchived = singleDates(oldAr)
    for (const b of removedDayBlocks.filter((x) => preArchived.has(x.date))) {
      const r = mergeIntoArchivedDay(newAr, b)
      newAr = r.text
      const prev = mergedLate.find((m) => m.date === b.date)
      if (prev) {
        prev.added += r.added
        prev.present += r.present
      } else mergedLate.push({ date: b.date, added: r.added, present: r.present })
    }

    // Same-date blocks (legacy duplicates) merge under one canonical heading; a
    // legacy heading's trailing text is kept as an italic note line above its
    // block, so nothing greppable is lost when the heading canonicalizes.
    const byDate = new Map()
    for (const b of removedDayBlocks.filter((x) => !preArchived.has(x.date))) {
      if (!byDate.has(b.date)) byDate.set(b.date, [])
      if (b.trailing) byDate.get(b.date).push(`_${b.trailing}_`)
      byDate.get(b.date).push(b.body.join("\n"))
    }
    // --auto's pre-1.1 extras: the collapsing summary is the only text that still
    // exists for these dates, so it is what moves in.
    for (const [d, text] of archiveExtras) if (!byDate.has(d)) byDate.set(d, [text])
    autoArchived = uniqSorted([...byDate.keys()]).reverse()
    newAr = insertIntoArchive(
      newAr,
      autoArchived.map((d) => [d, `### ${d}\n\n${byDate.get(d).join("\n\n")}\n\n---\n\n`])
    )
    const lost = (date, l) =>
      fails.push(`J: auto-archive lost a line of '${date}': ${JSON.stringify(l.slice(0, 60))}`)
    for (const b of removedDayBlocks) {
      for (const l of b.body) {
        if (l.trim() === "" || /^-{3,}\s*$/.test(l)) continue
        if (!newAr.includes(l)) lost(b.date, l)
      }
    }
    for (const [d, text] of archiveExtras) {
      for (const l of text.split("\n")) {
        if (l.trim() === "" || /^-{3,}\s*$/.test(l)) continue
        if (!newAr.includes(l)) lost(d, l)
      }
    }
    if (fails.length) return abort(fails)
  }

  // --- Archive year shed (optional, Check I) ---
  let shed = null
  if (args.shedYear) {
    shed = shedYearFromArchive(newAr, args.shedYear, args.archive, fails)
    if (fails.length || !shed) return abort(fails)
    newAr = shed.archive
  }

  // Coverage checks below must see everything the archive holds, including a year
  // just moved into its own file — shedding must never make a drop look unsafe.
  const archiveAll = shed ? `${newAr}\n${shed.yearText}` : newAr

  // --- Tier 4 drop (optional) ---
  let dropped = []
  let looselyCovered = []
  if (args.dropRangesBefore) {
    ;[newCl, dropped] = dropOldRanges(newCl, args.dropRangesBefore, fails)
    if (fails.length) return abort(fails)
    const { missing, loose } = archiveCoverage(dropped, archiveAll)
    looselyCovered = loose
    for (const { from, to, days } of missing)
      fails.push(
        days
          ? `H: dropped range '${from} to ${to}' names ${days.length} day(s) with no archive ` +
            `entry - their detail would be lost: ${days.join(", ")}`
          : `H: dropped range '${from} to ${to}' overlaps no archive heading - its detail would be lost`
      )
  }

  // --- Check B (no duplicate headings within a file) ---
  for (const [label, text] of [
    ["changelog", newCl],
    ["archive", newAr],
    ...(shed ? [[shed.yearPath, shed.yearText]] : []),
  ]) {
    if (!text) continue
    const seen = new Set()
    const dups = new Set()
    for (const key of headingKeys(text)) {
      if (seen.has(key)) dups.add(key)
      else seen.add(key)
    }
    for (const key of [...dups].sort()) fails.push(`B: duplicate heading '${key}' in ${label}`)
  }

  // --- Check C (every collapsed date got archived) ---
  const newSingles = singleDates(newCl)
  const removed = [...singleDates(oldCl)].filter((x) => !newSingles.has(x))
  const archived = singleDates(archiveAll)
  for (const date of removed.filter((x) => !archived.has(x)).sort())
    fails.push(`C: ${date} removed from changelog but has no per-day entry in archive`)

  // --- Check D (Tier-1 window untouched) ---
  if (args.keepDetailedSince) {
    const newFull = h2Dates(newCl)
    for (const date of [...h2Dates(oldCl)].sort())
      if (date >= args.keepDetailedSince && !newFull.has(date))
        fails.push(
          `D: ${date} (>= ${args.keepDetailedSince}) is no longer a full-detail '## ${date}' heading`
        )
  }

  // --- Check E (no per-day heading also covered by a range, in changelog) ---
  const rs = rangesOf(newCl)
  for (const date of [...newSingles].sort()) {
    for (const [a, b] of rs) {
      if (a <= date && date <= b) {
        fails.push(`E: changelog has per-day '${date}' AND range '${a} to ${b}' covering it`)
        break
      }
    }
  }

  // --- Check F / G (structure preserved) ---
  if (!newCl.includes(SEP_BEFORE_SUMMARY))
    fails.push("F: missing '---' separator immediately before '## Earlier Changes (Summary)'")
  if (!newCl.includes(FOOTER)) fails.push("G: missing footer pointer to changelog-archive.md")

  // --- Check K (legacy blocks with no ISO date survive any splice) ---
  if (haveSplice) {
    const lineCount = (text, line) => text.split("\n").filter((x) => x === line).length
    for (const b of legacyBlocksIn(oldCl)) {
      const before = lineCount(oldCl, b.heading)
      const after = lineCount(newCl, b.heading)
      if (after !== before) {
        fails.push(
          `K: legacy heading '${b.heading}' appears ${after}x in the new changelog ` +
            `(${before}x before) - the run re-emits legacy blocks itself; don't ` +
            `${after > before ? "repeat" : "remove"} them in --cl-mid`
        )
        continue
      }
      for (const l of b.body) {
        if (l.trim() === "" || /^-{3,}\s*$/.test(l)) continue
        if (!newCl.includes(l))
          fails.push(
            `K: legacy block '${b.heading}' lost line ${JSON.stringify(l.slice(0, 60))} - ` +
              `copy legacy blocks verbatim or leave them out of --cl-mid entirely`
          )
      }
    }
  }

  // --- Check N (the run never un-sorts the archive) ---
  // A regression guard, not a format rule: an archive that arrives out of order
  // stays the operator's business, but a run that takes a descending archive and
  // returns a non-descending one has mis-placed what it inserted, and --shed-year
  // reads that order as authoritative.
  const descending = (text) => {
    const keys = [...text.matchAll(reAnyHeading())].map((m) => m[1])
    return keys.every((k, i) => i === 0 || keys[i - 1] >= k)
  }
  for (const [label, before, after] of [
    ["archive", oldAr, newAr],
    ...(shed ? [[shed.yearPath, "", shed.yearText]] : []),
  ]) {
    if (!descending(after) && descending(before))
      fails.push(`N: ${label} is no longer in descending date order after this run`)
  }

  if (fails.length) return abort(fails)

  // --- Report ---
  const lineCount = (s) => s.split("\n").length
  console.log("All checks passed.")
  console.log(`  changelog: ${lineCount(oldCl)} -> ${lineCount(newCl)} lines`)
  if (doArchive || autoArchived.length || mergedLate.length)
    console.log(`  archive:   ${lineCount(oldAr)} -> ${lineCount(newAr)} lines`)
  if (autoArchived.length)
    console.log(`  archived ${autoArchived.length} full-detail day(s) verbatim: ${autoArchived.join(", ")}`)
  if (mergedLate.length)
    console.log(
      `  merged ${mergedLate.length} late day(s) into the archive entry each already had: ` +
        mergedLate
          .sort((a, b) => (a.date < b.date ? 1 : -1))
          .map(
            (m) =>
              `${m.date} (${m.added} new` + (m.present ? `, ${m.present} already archived` : "") + ")"
          )
          .join(", ")
    )
  if (archiveExtras.size)
    console.log(
      `  (of those, ${archiveExtras.size} pre-1.1 day(s) had only a summary left to move: ` +
        `${[...archiveExtras.keys()].sort().reverse().join(", ")})`
    )
  if (doArchive) {
    console.log(`  archived ${removed.length} collapsed date(s): ${removed.sort().join(", ") || "(none)"}`)
  }
  if (dropped.length) {
    console.log(
      `  Tier-4 dropped ${dropped.length} week-range(s): ` +
        dropped.map(({ from, to }) => `${from} to ${to}`).join(", ")
    )
  }
  if (looselyCovered.length) {
    // Not a failure — but the day-by-day coverage test couldn't run on these, so
    // say which ones rode on a span overlap instead of letting it pass unsaid.
    console.log(
      `  note: ${looselyCovered.length} dropped range(s) name no days; coverage was checked ` +
        `against the span only: ${looselyCovered.map(({ from, to }) => `${from} to ${to}`).join(", ")}`
    )
  }
  if (shed) {
    console.log(
      `  shed ${shed.moved.length} ${args.shedYear} entr${shed.moved.length === 1 ? "y" : "ies"} ` +
        `into ${shed.yearPath} (archive: ${lineCount(oldAr)} -> ${lineCount(newAr)} lines)`
    )
  }
  if (args.dryRun) {
    console.log("Dry run - nothing written.")
    return 0
  }

  // Detail flows changelog -> archive -> year file, so the receiving file lands
  // first: a crash between writes leaves the moved text in two files, never
  // removed from one and not yet in the other. The next run finds that day's
  // detail already archived and finishes the move without adding it twice.
  if (shed) writeAtomic(shed.yearPath, shed.yearText)
  if (doArchive || shed || autoArchived.length || mergedLate.length) writeAtomic(args.archive, newAr)
  writeAtomic(args.changelog, newCl)
  console.log("Written.")
  return 0
}

process.exit(main())
