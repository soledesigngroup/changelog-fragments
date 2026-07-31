#!/usr/bin/env node
/**
 * Fold pending changelog fragments (docs/changelog.d/*.md) into docs/changelog.md.
 *
 * WHY THIS EXISTS: many coding agents run against this tree at once. If each one
 * edits docs/changelog.md directly they collide (a filesystem race on one file).
 * Instead, `/changelog-update` has every agent write its own uniquely-named
 * fragment file — no two agents ever touch the same path, so collisions are
 * structurally impossible. This script is the SERIALIZED fold: run it when the
 * tree is quiet (single owner) to batch all pending fragments into changelog.md
 * and delete them. It is the only writer of changelog.md's Tier-1 zone.
 *
 * VERBATIM GUARANTEE: a fragment's bullet lines are copied byte-for-byte — never
 * reformatted. That keeps the fold a pure move (a folded entry reads exactly as
 * it was authored) and lets `git log -S "<bullet text>"` still find the commit
 * that introduced it rather than the mechanical fold commit.
 *
 * NOTHING IS DROPPED SILENTLY: a fragment whose content this script can't account
 * for (an unrecognized heading, text outside a `### Category` block) is reported
 * and left on disk rather than partly folded and deleted.
 *
 * Self-contained: no imports beyond node builtins, no build step, no deps.
 *
 * Usage:
 *   node scripts/collect-changelog.mjs             # fold + delete fragments
 *   node scripts/collect-changelog.mjs --dry-run   # report only, write nothing
 *   node scripts/collect-changelog.mjs --check     # verify structure, write nothing
 *
 * Exit 0 = clean. Exit 1 = something needs a human: a fragment was skipped (even if
 * the others folded fine), another fold holds the lock, --check found a problem, or
 * the fragment directory is gone. Exit 2 = bad arguments.
 *
 * Only one fold runs at a time (an exclusive `.fold.lock` in the fragment dir), and
 * changelog.md is written through a temp file + rename, so a killed fold leaves the
 * changelog either untouched or fully folded — never half-way. Fragment deletion
 * happens after that write; a fold killed between the two leaves already-folded
 * fragments on disk, and the next run recognizes them (every line already sits
 * under their day) and deletes them instead of folding them in twice.
 *
 * Paths are resolved relative to this script's parent directory, not the process
 * cwd, so the fold behaves identically from a subdirectory or a git hook.
 *
 * Managed by changelog-fragments — re-run its install.mjs to update.
 */

import { readdirSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SELF = fileURLToPath(import.meta.url)
const ROOT = resolve(dirname(SELF), "..")

// Displayed in messages; the absolute forms below are what actually get read.
const FRAGMENT_DIR = "docs/changelog.d"
const CHANGELOG_PATH = "docs/changelog.md"

const fragmentDir = join(ROOT, FRAGMENT_DIR)
const changelogPath = join(ROOT, CHANGELOG_PATH)
const lockPath = join(fragmentDir, ".fold.lock")

// ---------------------------------------------------------------------------
// Fold logic (pure — no IO)
// ---------------------------------------------------------------------------

/** Canonical section order within a day (matches the changelog-update command). */
const CATEGORY_ORDER = ["Added", "Changed", "Deprecated", "Fixed", "Removed", "Security"]

const CATEGORY_LABEL = new Map(CATEGORY_ORDER.map((c) => [c.toLowerCase(), c]))

const DATE_RE = /^##\s+\d{4}-\d{2}-\d{2}\s*$/
const CATEGORY_RE = new RegExp(`^###\\s+(${CATEGORY_ORDER.join("|")})\\s*$`, "i")
const HR_RE = /^-{3,}\s*$/
const DAY_HEADING_RE = /^##\s+/
/** An `#`/`##`/`###` heading of any shape — used to reject the ones we can't place. */
const ANY_HEADING_RE = /^#{1,3}\s+\S/
/** A day heading's leading ISO date, tolerating legacy trailing text. */
const DAY_DATE_RE = /^##\s+(\d{4}-\d{2}-\d{2})/

/** A fragment this script refuses to fold rather than fold incompletely. */
export class FragmentError extends Error {}

/** The `YYYY-MM-DD` prefix of a fragment filename, or null if it doesn't match. */
export function fragmentDateFromFilename(name) {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})-/)
  return m ? m[1] : null
}

/**
 * Extract verbatim category blocks from one fragment's markdown. Bullet lines
 * are preserved exactly (only surrounding blank lines and any stray `---` are
 * dropped) so the folded entry is byte-identical to the fragment.
 *
 * Throws FragmentError on anything it would otherwise have to discard: an
 * unrecognized heading (a mis-spelled or non-canonical category would previously
 * be swallowed into the preceding block) or body text sitting above the first
 * `### Category` heading. The caller leaves such a fragment on disk.
 */
export function extractFragmentBlocks(markdown) {
  const lines = markdown.split("\n")
  const blocks = []
  let current = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Ignore a stray `## DATE` header if an author included one.
    if (DATE_RE.test(line)) {
      current = null
      continue
    }
    const cat = line.match(CATEGORY_RE)
    if (cat) {
      current = { category: CATEGORY_LABEL.get(cat[1].toLowerCase()), rawLines: [] }
      blocks.push(current)
      continue
    }
    if (ANY_HEADING_RE.test(line)) {
      throw new FragmentError(
        `line ${i + 1}: unrecognized heading ${JSON.stringify(line.trim())} — expected one of ` +
          CATEGORY_ORDER.map((c) => `"### ${c}"`).join(", ")
      )
    }
    if (HR_RE.test(line)) continue // `---` would corrupt day boundaries once folded
    if (!current) {
      if (line.trim() === "") continue
      throw new FragmentError(
        `line ${i + 1}: content above the first "### Category" heading: ` +
          JSON.stringify(line.trim().slice(0, 60))
      )
    }
    current.rawLines.push(line)
  }

  for (const b of blocks) {
    while (b.rawLines.length && b.rawLines[0].trim() === "") b.rawLines.shift()
    while (b.rawLines.length && b.rawLines[b.rawLines.length - 1].trim() === "")
      b.rawLines.pop()
  }
  return blocks.filter((b) => b.rawLines.some((l) => l.trim() !== ""))
}

/** Render a day's merged categories (canonical order) as changelog lines. */
function renderDayLines(cats) {
  const out = []
  for (const label of CATEGORY_ORDER) {
    const raw = cats.get(label)
    if (!raw || raw.length === 0) continue
    if (out.length) out.push("")
    out.push(`### ${label}`)
    for (const l of raw) out.push(l)
  }
  return out
}

/** Tier-1 zone = after the header rule, before the "Earlier Changes" sentinel. */
function tier1Bounds(lines) {
  let start = 0
  for (let i = 0; i < lines.length; i++) {
    if (HR_RE.test(lines[i])) {
      start = i + 1
      break
    }
  }
  let end = lines.length
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+Earlier Changes/i.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

/** The canonical label of a `### Category` line, or null. */
function categoryOf(line) {
  const m = line.match(CATEGORY_RE)
  return m ? CATEGORY_LABEL.get(m[1].toLowerCase()) : null
}

/**
 * Merge one day's categories into the lines of an EXISTING day block (everything
 * below its `## DATE` heading, trailing `---` included). Bullets for a category
 * the day already has are appended to that section; a category the day lacks is
 * inserted in canonical position among the sections already there. Appending
 * whole blocks instead used to leave a second `### Fixed` under the same day —
 * a duplicate heading, out of canonical order — whenever a fragment folded late.
 */
function mergeIntoExistingDay(regionLines, cats) {
  const out = [...regionLines]
  const isHeading = (l) => /^#{2,3}\s/.test(l)

  const findCategory = (label) => out.findIndex((l) => categoryOf(l) === label)
  /** Index of the section's last content line (bullets end before the next heading/rule). */
  const sectionLastContent = (idx) => {
    let last = idx
    for (let i = idx + 1; i < out.length; i++) {
      if (isHeading(out[i]) || HR_RE.test(out[i])) break
      if (out[i].trim() !== "") last = i
    }
    return last
  }
  const dayLastContent = () => {
    let last = -1
    for (let i = 0; i < out.length; i++) {
      if (out[i].trim() !== "" && !HR_RE.test(out[i])) last = i
    }
    return last
  }

  for (const label of CATEGORY_ORDER) {
    const raw = cats.get(label)
    if (!raw || raw.length === 0) continue
    const at = findCategory(label)
    if (at !== -1) {
      out.splice(sectionLastContent(at) + 1, 0, ...raw)
      continue
    }
    // New section → before the first existing canonical section that sorts later,
    // or after the day's last content when nothing does (legacy content included).
    const later = out.findIndex((l) => {
      const c = categoryOf(l)
      return c !== null && CATEGORY_ORDER.indexOf(c) > CATEGORY_ORDER.indexOf(label)
    })
    if (later === -1) out.splice(dayLastContent() + 1, 0, "", `### ${label}`, ...raw)
    else out.splice(later, 0, `### ${label}`, ...raw, "")
  }
  return out
}

/** Splice one day's merged categories into (or onto) the Tier-1 zone. */
function spliceDate(lines, date, cats) {
  const { start, end } = tier1Bounds(lines)

  // Does a `## <date>` section already exist in Tier-1?
  let dayIdx = -1
  for (let i = start; i < end; i++) {
    if (lines[i].trim() === `## ${date}`) {
      dayIdx = i
      break
    }
  }

  if (dayIdx === -1) {
    // New day → insert above the first day block that is OLDER than it, so the
    // zone stays reverse-chronological even when a fragment is folded late (a
    // session that crossed midnight, a branch merged after a fold). A heading
    // with no parseable date stops the scan, matching the old top-insert.
    let insertAt = end
    for (let i = start; i < end; i++) {
      if (!DAY_HEADING_RE.test(lines[i])) continue
      const other = lines[i].match(DAY_DATE_RE)?.[1]
      if (other === undefined || other < date) {
        insertAt = i
        break
      }
    }
    const block = [`## ${date}`, "", ...renderDayLines(cats), "", "---", ""]
    return [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)]
  }

  // Existing day → merge category-by-category into the sections already there.
  let dayEnd = end
  for (let i = dayIdx + 1; i < end; i++) {
    if (DAY_HEADING_RE.test(lines[i])) {
      dayEnd = i
      break
    }
  }
  const merged = mergeIntoExistingDay(lines.slice(dayIdx + 1, dayEnd), cats)
  return [...lines.slice(0, dayIdx + 1), ...merged, ...lines.slice(dayEnd)]
}

/**
 * Fold a set of fragments into changelog.md. Groups fragments by date, merges
 * same-date categories in canonical order, then inserts each day (ascending, so
 * the newest ends up on top). Untouched regions of the file are preserved
 * byte-for-byte. Returns the new changelog markdown.
 */
export function mergeFragmentsIntoChangelog(changelogMd, fragments) {
  const byDate = new Map()
  for (const f of fragments) {
    let cats = byDate.get(f.date)
    if (!cats) {
      cats = new Map()
      byDate.set(f.date, cats)
    }
    for (const b of f.blocks) {
      const existing = cats.get(b.category) ?? []
      cats.set(b.category, existing.concat(b.rawLines))
    }
  }

  let lines = changelogMd.split("\n")
  // Insert ascending so that after each top-insert the newest date sits on top.
  for (const date of [...byDate.keys()].sort()) {
    lines = spliceDate(lines, date, byDate.get(date))
  }
  return lines.join("\n")
}

/**
 * Structural problems in a changelog's Tier-1 zone. Nothing but this script may
 * write that zone, so anything here is a hand-edit or an out-of-order fold.
 * Returns a list of human-readable strings (empty = healthy).
 */
export function auditChangelog(changelogMd) {
  const problems = []
  const lines = changelogMd.split("\n")
  const { start, end } = tier1Bounds(lines)

  const days = []
  for (let i = start; i < end; i++) {
    if (!DAY_HEADING_RE.test(lines[i])) continue
    const date = lines[i].match(DAY_DATE_RE)?.[1] ?? null
    days.push({ line: i + 1, text: lines[i].trim(), date, canonical: DATE_RE.test(lines[i]) })
  }

  // Order: dates must not increase as you read down. Equal dates are allowed —
  // a migrated changelog may legitimately carry repeated legacy day headings.
  const dated = days.filter((d) => d.date !== null)
  for (let i = 1; i < dated.length; i++) {
    if (dated[i].date > dated[i - 1].date) {
      problems.push(
        `Tier-1 zone is out of order: '${dated[i].text}' (line ${dated[i].line}) sits below ` +
          `'${dated[i - 1].text}' (line ${dated[i - 1].line})`
      )
    }
  }

  // Duplicates: only among canonical `## YYYY-MM-DD` headings. Repeated legacy
  // headings (`## DATE (parenthetical)`) are preserved on purpose by the migrator.
  const byDate = new Map()
  for (const d of days.filter((x) => x.canonical)) {
    byDate.set(d.date, (byDate.get(d.date) ?? []).concat(d.line))
  }
  for (const [date, at] of [...byDate].sort()) {
    if (at.length > 1) problems.push(`duplicate day heading '## ${date}' (lines ${at.join(", ")})`)
  }

  // Duplicate category sections within one day block: the fold merges same-day
  // fragments into one section per category, so a second '### Fixed' under the
  // same day heading is a hand-edit or an interrupted pre-1.1 fold.
  for (let i = start; i < end; i++) {
    if (!DAY_HEADING_RE.test(lines[i]) || !DAY_DATE_RE.test(lines[i])) continue
    const seen = new Map()
    for (let j = i + 1; j < end && !DAY_HEADING_RE.test(lines[j]); j++) {
      const m = lines[j].match(CATEGORY_RE)
      if (!m) continue
      const label = CATEGORY_LABEL.get(m[1].toLowerCase())
      seen.set(label, (seen.get(label) ?? []).concat(j + 1))
    }
    for (const [label, at] of seen) {
      if (at.length > 1)
        problems.push(
          `duplicate '### ${label}' sections under '${lines[i].trim()}' (lines ${at.join(", ")})`
        )
    }
  }

  // The zone's top boundary is the FIRST `---` in the file. A `##` heading above
  // it means the boundary sits below entries that belong inside the zone, so every
  // fold lands mid-file instead of on top — silently, which is how a migration
  // that put the header rule at the bottom went unnoticed.
  for (let i = 0; i < start - 1; i++) {
    if (!DAY_HEADING_RE.test(lines[i])) continue
    problems.push(
      `'${lines[i].trim()}' (line ${i + 1}) sits above the '---' that opens the Tier-1 zone ` +
        `(line ${start}) — move that rule above the first '##' heading`
    )
    break
  }

  if (!changelogMd.includes("---\n\n## Earlier Changes (Summary)"))
    problems.push("missing '---' separator immediately before '## Earlier Changes (Summary)'")
  if (!changelogMd.includes("> Full per-day details available in"))
    problems.push("missing footer pointer to changelog-archive.md")

  return problems
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

/** Fragment filenames, sorted so ordering within a date is deterministic. */
function listFragmentFiles() {
  return readdirSync(fragmentDir)
    .filter((n) => n.endsWith(".md") && n !== "README.md")
    .sort()
}

function requireFragmentDir() {
  try {
    readdirSync(fragmentDir)
  } catch {
    console.error(
      `[collect-changelog] ${FRAGMENT_DIR}/ is missing under ${ROOT} — re-run the ` +
        `changelog-fragments installer, or check that this script still lives in scripts/.`
    )
    process.exit(1)
  }
}

/** Write via temp file + rename so a crash can't leave a half-written changelog. */
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

/**
 * Take the fold lock, or exit. `wx` fails if the file exists, which is atomic on
 * every platform we care about — two folds can never both proceed. A lock left
 * behind by a killed process is reclaimed once its pid is gone.
 */
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" })
      return
    } catch (err) {
      if (err.code !== "EEXIST") throw err
      const holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10)
      if (attempt === 0 && Number.isInteger(holder) && !isAlive(holder)) {
        console.warn(`[collect-changelog] reclaiming stale lock from dead pid ${holder}`)
        rmSync(lockPath, { force: true })
        continue
      }
      console.error(
        `[collect-changelog] another fold is running (pid ${holder || "unknown"}). The fold is ` +
          `serialized on purpose — wait for it, or delete ${join(FRAGMENT_DIR, ".fold.lock")} if ` +
          `you're certain it's stale.`
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

const releaseLock = () => rmSync(lockPath, { force: true })

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Read every pending fragment, partitioning into foldable and unfoldable. */
function readFragments() {
  const fragments = []
  const skipped = []

  for (const name of listFragmentFiles()) {
    const path = join(fragmentDir, name)
    const date = fragmentDateFromFilename(name)
    if (!date) {
      skipped.push({ name, reason: "filename must start with YYYY-MM-DD-" })
      continue
    }
    let blocks
    try {
      blocks = extractFragmentBlocks(readFileSync(path, "utf8"))
    } catch (err) {
      if (!(err instanceof FragmentError)) throw err
      skipped.push({ name, reason: err.message })
      continue
    }
    if (blocks.length === 0) {
      skipped.push({ name, reason: 'no "### Category" bullet blocks found' })
      continue
    }
    fragments.push({ name, path, date, blocks })
  }
  return { fragments, skipped }
}

const bulletCount = (blocks) =>
  blocks.reduce((sum, b) => sum + b.rawLines.filter((l) => l.trim().startsWith("- ")).length, 0)

/**
 * Every content line already sitting under a Tier-1 day heading for `date`
 * (all same-date blocks, legacy headings included). Used to recognize a
 * fragment whose bullets a previous — interrupted — fold already moved in: the
 * changelog write is atomic but the fragment deletions after it are not, so a
 * fold killed between the two leaves fragments on disk whose content is
 * already in the file, and refolding them would silently duplicate entries.
 */
function foldedDayContent(clLines, date) {
  const { start, end } = tier1Bounds(clLines)
  const have = new Set()
  let inDay = false
  for (let i = start; i < end; i++) {
    if (DAY_HEADING_RE.test(clLines[i])) inDay = clLines[i].match(DAY_DATE_RE)?.[1] === date
    else if (inDay) have.add(clLines[i])
  }
  return have
}

function runFold({ dryRun }) {
  requireFragmentDir()

  if (listFragmentFiles().length === 0) {
    console.log("[collect-changelog] no pending fragments — nothing to do")
    return 0
  }

  if (!dryRun) acquireLock()
  try {
    const { fragments: readable, skipped } = readFragments()

    for (const { name, reason } of skipped) {
      console.warn(`[collect-changelog] skip ${name}: ${reason}`)
    }

    const changelogMd = readFileSync(changelogPath, "utf8")
    const clLines = changelogMd.split("\n")
    const fragments = []
    for (const f of readable) {
      const content = f.blocks.flatMap((b) => b.rawLines).filter((l) => l.trim() !== "")
      const have = foldedDayContent(clLines, f.date)
      if (content.length && content.every((l) => have.has(l))) {
        console.warn(
          `[collect-changelog] ${f.name}: every line already sits under its day in ` +
            `${CHANGELOG_PATH} — ${dryRun ? "would delete" : "deleting"} the fragment ` +
            `(recovering an interrupted fold) instead of folding it twice`
        )
        if (!dryRun) rmSync(f.path, { force: true })
        continue
      }
      fragments.push(f)
    }

    for (const f of fragments) {
      const n = bulletCount(f.blocks)
      console.log(
        `  • ${f.name}  →  ${f.date}  (${f.blocks.map((b) => b.category).join(", ")}; ` +
          `${n} bullet${n === 1 ? "" : "s"})`
      )
    }

    if (fragments.length === 0) {
      console.log(`[collect-changelog] nothing foldable (${skipped.length} skipped)`)
      return skipped.length ? 1 : 0
    }

    const merged = mergeFragmentsIntoChangelog(changelogMd, fragments)

    if (dryRun) {
      console.log(
        `[collect-changelog] dry-run: would fold ${fragments.length} fragment(s) into ` +
          `${CHANGELOG_PATH} and delete them (${skipped.length} skipped). Nothing written.`
      )
      return 0
    }

    writeAtomic(changelogPath, merged)
    // force: an interrupted fold that already unlinked some fragments must be
    // re-runnable, not a crash.
    for (const f of fragments) rmSync(f.path, { force: true })

    console.log(
      `[collect-changelog] folded ${fragments.length} fragment(s) into ${CHANGELOG_PATH} and ` +
        `deleted them (${skipped.length} skipped).`
    )
    console.log("[collect-changelog] next: commit changelog.md + the fragment deletions together.")
    return skipped.length ? 1 : 0
  } finally {
    if (!dryRun) releaseLock()
  }
}

/**
 * Verify what the fold and condense steps depend on, without writing anything:
 * every pending fragment is foldable, and changelog.md's Tier-1 zone still looks
 * like something only this script has written. Suitable for CI or a git hook.
 *
 * A pending fragment is NOT a failure — that's the normal mid-session state.
 */
function runCheck() {
  requireFragmentDir()

  const problems = []
  const { fragments, skipped } = readFragments()
  for (const { name, reason } of skipped) problems.push(`${FRAGMENT_DIR}/${name}: ${reason}`)

  let changelog
  try {
    changelog = readFileSync(changelogPath, "utf8")
  } catch {
    problems.push(`${CHANGELOG_PATH} is missing`)
  }
  if (changelog !== undefined) {
    for (const p of auditChangelog(changelog)) problems.push(`${CHANGELOG_PATH}: ${p}`)
  }

  if (problems.length) {
    console.error("[collect-changelog] check FAILED:")
    for (const p of problems) console.error(`  - ${p}`)
    return 1
  }
  console.log(
    `[collect-changelog] check passed — ${fragments.length} fragment(s) pending, ` +
      `${CHANGELOG_PATH} structure intact.`
  )
  return 0
}

function main() {
  const argv = process.argv.slice(2)
  const flags = new Set(argv)
  for (const a of argv) {
    if (!["--dry-run", "--check", "-h", "--help"].includes(a)) {
      console.error(`[collect-changelog] unknown argument ${a}`)
      console.error("Usage: collect-changelog.mjs [--dry-run | --check]")
      return 2
    }
  }
  if (flags.has("-h") || flags.has("--help")) {
    console.log(readFileSync(SELF, "utf8").split("*/")[0].replace(/^#!.*\n/, ""))
    return 0
  }
  if (flags.has("--check")) return runCheck()
  return runFold({ dryRun: flags.has("--dry-run") })
}

// Only run the CLI when executed directly, so the fold helpers stay importable.
// Compare resolved filesystem paths, never URL strings: `file://${process.argv[1]}`
// mismatches import.meta.url whenever the path needs percent-encoding (a space in
// any directory name) or passes through a symlink (/tmp, /var, container mounts),
// and the fold would then no-op with exit 0 and no output at all.
function invokedDirectly() {
  const arg = process.argv[1]
  if (!arg) return false
  if (resolve(arg) === SELF) return true
  try {
    return realpathSync(arg) === SELF
  } catch {
    return false
  }
}

if (invokedDirectly()) process.exit(main())
