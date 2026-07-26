#!/usr/bin/env node
/**
 * Splice-and-verify helper for the /changelog-condense flow.
 *
 * Division of labor:
 *   - The MODEL does the judgment work: it writes the new Tier-2 / Tier-3 summary
 *     text to temp files (--cl-mid, optionally --ar-content).
 *   - THIS script does the mechanical move (so Tier-1 full-detail blocks are never
 *     re-typed by hand) and runs un-skippable verification. It writes nothing
 *     unless every check passes.
 *
 * What it does:
 *   1. (Tier 2/3 splice) Replaces the changelog region from --cl-start (inclusive)
 *      through --cl-end (EXCLUSIVE) with the contents of --cl-mid. Everything
 *      before --cl-start (the Tier-1 full-detail entries) and from --cl-end onward
 *      (older week-ranges + footer) is preserved byte-for-byte. This group is
 *      optional; omit all three --cl-* flags on a Tier-4-only run.
 *   2. (Optional) Inserts --ar-content into the archive immediately BEFORE
 *      --ar-before. Only used on runs where dates age past Tier 3 and collapse
 *      into week-ranges.
 *   3. (Tier 4 drop) With --drop-ranges-before <DATE>, removes trailing week-range
 *      blocks whose END date is older than <DATE> from the changelog entirely.
 *      Their per-day detail already lives in the archive (verified — Check H), so
 *      this is lossless dedup that stops the file growing without bound. Requires
 *      --archive (read-only) for the coverage check; nothing is written to it.
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
 *      (no single-day heading, no kept range below a dropped one), and every
 *      dropped range overlaps some archive heading, so its detail survives.
 *
 * Self-contained: no imports beyond node builtins, no build step, no deps.
 * Dates are compared as ISO strings (YYYY-MM-DD sorts lexicographically), so
 * there is no timezone handling to get wrong.
 *
 * Managed by changelog-fragments — re-run its install.mjs to update.
 */

import { readFileSync, writeFileSync } from "node:fs"

// Fresh regex per call — a shared /g regex carries lastIndex between scans.
const reH2Date = () => /^## (\d{4}-\d{2}-\d{2})[ \t]*$/gm
const reH3Date = () => /^### (\d{4}-\d{2}-\d{2})[ \t]*$/gm
const reH3Range = () => /^### (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})[ \t]*$/gm
const reAnyHeading = () =>
  /^#{2,3} (\d{4}-\d{2}-\d{2})(?: to (\d{4}-\d{2}-\d{2}))?[ \t]*$/gm

const FOOTER = "> Full per-day details available in"
const SEP_BEFORE_SUMMARY = "---\n\n## Earlier Changes (Summary)"
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Dates that appear as a single-day heading (## or ###), as a Set of strings. */
function singleDates(text) {
  const out = new Set()
  for (const m of text.matchAll(reH2Date())) out.add(m[1])
  for (const m of text.matchAll(reH3Date())) out.add(m[1])
  return out
}

function h2Dates(text) {
  const out = new Set()
  for (const m of text.matchAll(reH2Date())) out.add(m[1])
  return out
}

function rangesOf(text) {
  return [...text.matchAll(reH3Range())].map((m) => [m[1], m[2]])
}

/** Every date-heading identity in order, for duplicate detection. */
function headingKeys(text) {
  return [...text.matchAll(reAnyHeading())].map((m) => (m[2] ? `${m[1]} to ${m[2]}` : m[1]))
}

function countOccurrences(text, sub) {
  if (!sub) return 0
  let n = 0
  let i = text.indexOf(sub)
  while (i !== -1) {
    n++
    i = text.indexOf(sub, i + sub.length)
  }
  return n
}

/** Replace text from `start` (inclusive) to `end` (exclusive) with `replacement`. */
function spliceReplace(text, start, end, replacement) {
  const i = text.indexOf(start)
  const j = text.indexOf(end)
  return text.slice(0, i) + replacement + text.slice(j)
}

/**
 * Tier 4: remove trailing week-range blocks whose END date < cutoff.
 *
 * Returns [newText, dropped] where `dropped` is the list of [start, end] date
 * pairs removed. Appends to `fails` on any structural surprise (the caller
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

  let dropStart = null
  const dropped = []
  for (const m of text.matchAll(reH3Range())) {
    if (m.index >= foot) continue
    if (m[2] < cutoff) {
      if (dropStart === null) dropStart = m.index
      dropped.push([m[1], m[2]])
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

/** Return the dropped ranges whose span overlaps NO archive heading. */
function uncoveredByArchive(dropped, arText) {
  const arSingles = [...singleDates(arText)]
  const arRanges = rangesOf(arText)
  const missing = []
  for (const [x, y] of dropped) {
    const covered =
      arSingles.some((s) => x <= s && s <= y) || arRanges.some(([a, b]) => a <= y && b >= x)
    if (!covered) missing.push([x, y])
  }
  return missing
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
  ])
  const args = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run") {
      args.dryRun = true
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

function abort(fails) {
  console.error("ABORT - nothing written. Verification failed:")
  for (const f of fails) console.error(`  - ${f}`)
  return 1
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0])
    return 0
  }
  if (!args.changelog) usageError("--changelog is required")
  for (const k of ["keepDetailedSince", "dropRangesBefore"]) {
    if (args[k] && !DATE_RE.test(args[k])) usageError(`--${k} must be YYYY-MM-DD`)
  }

  const oldCl = readFileSync(args.changelog, "utf8")
  const fails = []

  // --- Which operations were requested? ---
  const clFlags = [args.clStart, args.clEnd, args.clMid]
  const haveSplice = clFlags.some(Boolean)
  if (haveSplice && !clFlags.every(Boolean)) {
    fails.push("Tier-2/3 splice needs all of --cl-start, --cl-end, --cl-mid (or none)")
    return abort(fails)
  }
  if (!haveSplice && !args.dropRangesBefore) {
    fails.push("nothing to do: pass the --cl-* splice group and/or --drop-ranges-before")
    return abort(fails)
  }
  if (args.dropRangesBefore && !args.archive) {
    fails.push("--drop-ranges-before requires --archive (read-only) for the coverage check")
    return abort(fails)
  }

  // --- Check A + Tier-2/3 splice (optional) ---
  let newCl = oldCl
  if (haveSplice) {
    const mid = readFileSync(args.clMid, "utf8")
    const nStart = countOccurrences(oldCl, args.clStart)
    const nEnd = countOccurrences(oldCl, args.clEnd)
    if (nStart !== 1)
      fails.push(`A: --cl-start '${args.clStart}' occurs ${nStart}x in changelog (need 1)`)
    if (nEnd !== 1) fails.push(`A: --cl-end '${args.clEnd}' occurs ${nEnd}x in changelog (need 1)`)
    if (!fails.length && oldCl.indexOf(args.clStart) >= oldCl.indexOf(args.clEnd))
      fails.push("A: --cl-start does not precede --cl-end")
    if (fails.length) return abort(fails)
    newCl = spliceReplace(oldCl, args.clStart, args.clEnd, mid)
  }

  // --- Archive splice (optional) ---
  const doArchive = Boolean(args.archive && args.arBefore && args.arContent)
  if ((args.arBefore || args.arContent) && !doArchive) {
    fails.push("archive splice needs all of --archive, --ar-before, --ar-content (or none)")
    return abort(fails)
  }

  const oldAr = args.archive ? readFileSync(args.archive, "utf8") : ""
  let newAr = oldAr
  if (doArchive) {
    const arContent = readFileSync(args.arContent, "utf8")
    const nBefore = countOccurrences(oldAr, args.arBefore)
    if (nBefore !== 1) {
      fails.push(`A: --ar-before '${args.arBefore}' occurs ${nBefore}x in archive (need 1)`)
      return abort(fails)
    }
    const k = oldAr.indexOf(args.arBefore)
    newAr = oldAr.slice(0, k) + arContent + oldAr.slice(k)
  }

  // --- Tier 4 drop (optional) ---
  let dropped = []
  if (args.dropRangesBefore) {
    ;[newCl, dropped] = dropOldRanges(newCl, args.dropRangesBefore, fails)
    if (fails.length) return abort(fails)
    for (const [x, y] of uncoveredByArchive(dropped, newAr))
      fails.push(`H: dropped range '${x} to ${y}' overlaps no archive heading - its detail would be lost`)
  }

  // --- Check B (no duplicate headings within a file) ---
  for (const [label, text] of [
    ["changelog", newCl],
    ["archive", newAr],
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
  const archived = singleDates(newAr)
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

  if (fails.length) return abort(fails)

  // --- Report ---
  const lineCount = (s) => s.split("\n").length
  console.log("All checks passed.")
  console.log(`  changelog: ${lineCount(oldCl)} -> ${lineCount(newCl)} lines`)
  if (doArchive) {
    console.log(`  archive:   ${lineCount(oldAr)} -> ${lineCount(newAr)} lines`)
    console.log(`  archived ${removed.length} collapsed date(s): ${removed.sort().join(", ") || "(none)"}`)
  }
  if (dropped.length) {
    console.log(
      `  Tier-4 dropped ${dropped.length} week-range(s): ` +
        dropped.map(([x, y]) => `${x} to ${y}`).join(", ")
    )
  }
  if (args.dryRun) {
    console.log("Dry run - nothing written.")
    return 0
  }

  writeFileSync(args.changelog, newCl)
  if (doArchive) writeFileSync(args.archive, newAr)
  console.log("Written.")
  return 0
}

process.exit(main())
