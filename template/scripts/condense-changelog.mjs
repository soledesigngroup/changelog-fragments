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
 *   4. (Archive year shed) With --shed-year <YYYY>, moves the oldest complete
 *      calendar year out of the archive into a static changelog-archive-<YYYY>.md
 *      and refreshes the "Earlier years" pointer. A pure partition, verified
 *      heading-for-heading and line-for-line (Check I).
 *
 * Planning: --plan --today <DATE> writes nothing and prints which headings fall in
 * which tier plus the exact anchor/cutoff flags to use. Prefer it over working the
 * dates out by hand.
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
 *      (no single-day heading, no kept range below a dropped one), and every
 *      dropped range overlaps some archive heading, so its detail survives.
 *   I. (if --shed-year) the year being shed is the oldest present and not the only
 *      one, its target file doesn't already exist, and the partition conserves
 *      every archive heading and every non-blank line exactly once.
 *
 * Self-contained: no imports beyond node builtins, no build step, no deps.
 * Dates are compared as ISO strings (YYYY-MM-DD sorts lexicographically), so
 * there is no timezone handling to get wrong. `shiftDays` is the one exception —
 * see the note on it.
 *
 * Managed by changelog-fragments — re-run its install.mjs to update.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"

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

const uniqSorted = (xs) => [...new Set(xs)].sort()

/** Single-quote for a shell, so a backtick in an anchor can't run as a command. */
const shq = (s) => `'${s.split("'").join(`'\\''`)}'`

/**
 * Anchors are matched as plain substrings, so a prefix will do — and a shorter one
 * is better when the full line carries backticks or quotes (the seeded archive
 * placeholder does). Only shorten while the prefix still resolves uniquely.
 */
function shortestUniqueAnchor(line, haystack) {
  const cut = line.search(/[`'"]/)
  if (cut < 8) return line
  const prefix = line.slice(0, cut).trimEnd()
  return countOccurrences(haystack, prefix) === 1 ? prefix : line
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
function planTiers(clText, arText, today) {
  const keepDetailedSince = shiftDays(today, -3) // Tier 1: 0-3 days
  const tier2From = shiftDays(today, -14) // Tier 2: 4-14 days
  const tier3From = shiftDays(today, -42) // Tier 3: 15-42 days; Tier 4 below

  const fullDetail = [...clText.matchAll(reH2Date())].map((m) => m[1])
  const summary = summarySection(clText)
  const summaryDays = [...summary.matchAll(reH3Date())].map((m) => m[1])
  const summaryRanges = [...summary.matchAll(reH3Range())].map((m) => [m[1], m[2]])

  const tier1 = uniqSorted(fullDetail.filter((d) => d >= keepDetailedSince)).reverse()
  const condensing = fullDetail.filter((d) => d < keepDetailedSince)
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

  // The splice rewrites one contiguous region, from the newest heading that
  // changes down to (exclusive) the first heading below the LAST one that changes.
  // Dates that stay put can sit inside that span — an existing Tier-2 entry is
  // newer than the ones now aging into a week-range — so the region can enclose
  // headings the model must re-emit verbatim.
  const changedSummaryKeys = new Set([...collapsing, ...beyondTier3])
  const summaryHeadings = [...summary.matchAll(reAnyHeading())].map((m) => ({
    text: m[0].trim(),
    key: m[2] ? `${m[1]} to ${m[2]}` : m[1],
  }))
  let lastChanged = -1
  summaryHeadings.forEach((h, i) => {
    if (changedSummaryKeys.has(h.key)) lastChanged = i
  })

  let clStart = null
  if (condensing.length) clStart = `## ${uniqSorted(condensing).reverse()[0]}`
  else if (lastChanged !== -1) clStart = summaryHeadings.find((h) => changedSummaryKeys.has(h.key)).text

  const clEnd =
    clStart === null ? null : (summaryHeadings[lastChanged + 1]?.text ?? FOOTER)
  // Headings swallowed by the region that this run does not change.
  const reEmit = summaryHeadings
    .slice(0, lastChanged + 1)
    .filter((h) => !changedSummaryKeys.has(h.key))
    .map((h) => h.text)

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
    // The sentinel is inside the rewritten region whenever the region starts at a
    // full-detail `## DATE` heading, so cl-mid has to re-open the summary section.
    spliceIncludesSentinel: clStart !== null && clStart.startsWith("## "),
    arBefore,
    needsArchive: collapsing.length > 0 || beyondTier3.length > 0,
    dropRangesBefore: tier3From,
    shedYear,
    archiveLines: arLines,
  }
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
  out.push("")

  if (!p.clStart && !p.droppableRanges.length) {
    out.push("Nothing has aged out yet — no condense run needed today.")
    return out.join("\n")
  }

  const cmd = ["node scripts/condense-changelog.mjs \\"]
  cmd.push(`    --changelog ${args.changelog} \\`)
  if (p.clStart) {
    cmd.push(`    --cl-start ${shq(p.clStart)} \\`)
    cmd.push(`    --cl-end   ${shq(p.clEnd)} \\`)
    cmd.push(`    --cl-mid   /tmp/cl-mid.md \\`)
  }
  cmd.push(`    --archive ${args.archive ?? "docs/changelog-archive.md"} \\`)
  if (p.needsArchive) {
    cmd.push(`    --ar-before ${shq(p.arBefore ?? "<newest archive heading>")} \\`)
    cmd.push(`    --ar-content /tmp/ar-new.md \\`)
  }
  if (p.clStart) cmd.push(`    --keep-detailed-since ${p.keepDetailedSince} \\`)
  if (p.shedYear) cmd.push(`    --shed-year ${p.shedYear} \\`)
  cmd.push(`    --drop-ranges-before ${p.dropRangesBefore}`)

  if (p.clStart) {
    out.push(
      `Write /tmp/cl-mid.md — it replaces everything from ${JSON.stringify(p.clStart)} up to ` +
        `(not including) ${JSON.stringify(p.clEnd)}, and must contain, in order:`
    )
    if (p.spliceIncludesSentinel) out.push(`  - the '## Earlier Changes (Summary)' heading`)
    if (p.toTier2.length) out.push(`  - new '### DATE' per-day summaries for ${list(p.toTier2)}`)
    if (p.reEmit.length)
      out.push(`  - these existing entries, copied VERBATIM (unchanged this run): ${list(p.reEmit)}`)
    if (p.collapsing.length)
      out.push(`  - new '### X to Y' week-range summaries covering ${list(p.collapsing)}`)
    out.push(`  ...newest first throughout.`)
    if (p.needsArchive)
      out.push(
        `Write /tmp/ar-new.md: per-day detail for ${list(p.collapsing.concat(p.beyondTier3))}, ` +
          `newest first, each followed by a '---' line.`
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
    "--shed-year",
    "--today",
  ])
  const args = { dryRun: false, plan: false }
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
  for (const k of ["keepDetailedSince", "dropRangesBefore", "today"]) {
    if (args[k] && !DATE_RE.test(args[k])) usageError(`--${k} must be YYYY-MM-DD`)
  }
  if (args.shedYear && !/^\d{4}$/.test(args.shedYear)) usageError("--shed-year must be YYYY")

  const oldCl = readFileSync(args.changelog, "utf8")
  const fails = []

  // --- Planning mode: read-only, returns before any splice ---
  if (args.plan) {
    if (!args.today) {
      usageError("--plan requires --today YYYY-MM-DD (pass it explicitly; the clock is never read)")
    }
    const arText = args.archive ? readFileSync(args.archive, "utf8") : ""
    console.log(formatPlan(planTiers(oldCl, arText, args.today), args))
    return 0
  }
  if (args.today) usageError("--today is only meaningful with --plan")

  // --- Which operations were requested? ---
  const clFlags = [args.clStart, args.clEnd, args.clMid]
  const haveSplice = clFlags.some(Boolean)
  if (haveSplice && !clFlags.every(Boolean)) {
    fails.push("Tier-2/3 splice needs all of --cl-start, --cl-end, --cl-mid (or none)")
    return abort(fails)
  }
  if (!haveSplice && !args.dropRangesBefore && !args.shedYear) {
    fails.push(
      "nothing to do: pass the --cl-* splice group, --drop-ranges-before and/or --shed-year " +
        "(or --plan --today to see what this run should do)"
    )
    return abort(fails)
  }
  if (args.dropRangesBefore && !args.archive) {
    fails.push("--drop-ranges-before requires --archive (read-only) for the coverage check")
    return abort(fails)
  }
  if (args.shedYear && !args.archive) {
    fails.push("--shed-year requires --archive")
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
  if (args.dropRangesBefore) {
    ;[newCl, dropped] = dropOldRanges(newCl, args.dropRangesBefore, fails)
    if (fails.length) return abort(fails)
    for (const [x, y] of uncoveredByArchive(dropped, archiveAll))
      fails.push(`H: dropped range '${x} to ${y}' overlaps no archive heading - its detail would be lost`)
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

  writeFileSync(args.changelog, newCl)
  if (doArchive || shed) writeFileSync(args.archive, newAr)
  if (shed) writeFileSync(shed.yearPath, shed.yearText)
  console.log("Written.")
  return 0
}

process.exit(main())
