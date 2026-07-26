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
 * Self-contained: no imports beyond node builtins, no build step, no deps.
 *
 * Usage:
 *   node scripts/collect-changelog.mjs             # fold + delete fragments
 *   node scripts/collect-changelog.mjs --dry-run   # report only, write nothing
 *
 * Managed by changelog-fragments — re-run its install.mjs to update.
 */

import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"

const FRAGMENT_DIR = "docs/changelog.d"
const CHANGELOG_PATH = "docs/changelog.md"

// ---------------------------------------------------------------------------
// Fold logic (pure — no IO)
// ---------------------------------------------------------------------------

/** Canonical section order within a day (matches the changelog-update command). */
const CATEGORY_ORDER = ["Added", "Changed", "Fixed", "Removed", "Security"]

const CATEGORY_LABEL = {
  added: "Added",
  changed: "Changed",
  fixed: "Fixed",
  removed: "Removed",
  security: "Security",
}

const DATE_RE = /^##\s+\d{4}-\d{2}-\d{2}\s*$/
const CATEGORY_RE = /^###\s+(Added|Changed|Fixed|Removed|Security)\s*$/i
const HR_RE = /^-{3,}\s*$/
const DAY_HEADING_RE = /^##\s+/

/** The `YYYY-MM-DD` prefix of a fragment filename, or null if it doesn't match. */
export function fragmentDateFromFilename(name) {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})-/)
  return m ? m[1] : null
}

/**
 * Extract verbatim category blocks from one fragment's markdown. Bullet lines
 * are preserved exactly (only surrounding blank lines and any stray `---` are
 * dropped) so the folded entry is byte-identical to the fragment.
 */
export function extractFragmentBlocks(markdown) {
  const lines = markdown.split("\n")
  const blocks = []
  let current = null

  for (const line of lines) {
    // Ignore a stray `## DATE` header if an author included one.
    if (DATE_RE.test(line)) {
      current = null
      continue
    }
    const cat = line.match(CATEGORY_RE)
    if (cat) {
      current = { category: CATEGORY_LABEL[cat[1].toLowerCase()], rawLines: [] }
      blocks.push(current)
      continue
    }
    if (!current) continue
    if (HR_RE.test(line)) continue // `---` would corrupt day boundaries once folded
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

/** Splice one day's rendered blocks into (or onto) the Tier-1 zone. */
function spliceDate(lines, date, dayLines) {
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
    // New day → insert at the top of the Tier-1 zone, above the newest day.
    let insertAt = end
    for (let i = start; i < end; i++) {
      if (DAY_HEADING_RE.test(lines[i])) {
        insertAt = i
        break
      }
    }
    const block = [`## ${date}`, "", ...dayLines, "", "---", ""]
    return [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)]
  }

  // Existing day → append after its last bullet, before any trailing `---`/blanks.
  let dayEnd = end
  for (let i = dayIdx + 1; i < end; i++) {
    if (DAY_HEADING_RE.test(lines[i])) {
      dayEnd = i
      break
    }
  }
  let lastContent = dayIdx
  for (let i = dayIdx + 1; i < dayEnd; i++) {
    if (lines[i].trim() !== "" && !HR_RE.test(lines[i])) lastContent = i
  }
  const insertAt = lastContent + 1
  return [...lines.slice(0, insertAt), "", ...dayLines, ...lines.slice(insertAt)]
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
    lines = spliceDate(lines, date, renderDayLines(byDate.get(date)))
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const dryRun = process.argv.includes("--dry-run")

  let names
  try {
    names = readdirSync(FRAGMENT_DIR)
  } catch {
    console.log(`[collect-changelog] no ${FRAGMENT_DIR}/ directory — nothing to do`)
    return
  }

  // Sort by filename so ordering within a date is deterministic across runs.
  const fragmentFiles = names.filter((n) => n.endsWith(".md") && n !== "README.md").sort()

  if (fragmentFiles.length === 0) {
    console.log("[collect-changelog] no pending fragments — nothing to do")
    return
  }

  const fragments = []
  const consumed = []
  let skipped = 0

  for (const name of fragmentFiles) {
    const path = join(FRAGMENT_DIR, name)
    const date = fragmentDateFromFilename(name)
    if (!date) {
      console.warn(`[collect-changelog] skip ${name}: filename must start with YYYY-MM-DD-`)
      skipped++
      continue
    }
    const blocks = extractFragmentBlocks(readFileSync(path, "utf8"))
    if (blocks.length === 0) {
      console.warn(`[collect-changelog] skip ${name}: no "### Category" bullet blocks found`)
      skipped++
      continue
    }
    fragments.push({ date, blocks })
    consumed.push(path)
    const n = blocks.reduce(
      (sum, b) => sum + b.rawLines.filter((l) => l.trim().startsWith("- ")).length,
      0
    )
    console.log(
      `  • ${name}  →  ${date}  (${blocks.map((b) => b.category).join(", ")}; ${n} bullet${n === 1 ? "" : "s"})`
    )
  }

  if (fragments.length === 0) {
    console.log(`[collect-changelog] nothing foldable (${skipped} skipped)`)
    return
  }

  const merged = mergeFragmentsIntoChangelog(readFileSync(CHANGELOG_PATH, "utf8"), fragments)

  if (dryRun) {
    console.log(
      `[collect-changelog] dry-run: would fold ${fragments.length} fragment(s) into ${CHANGELOG_PATH} and delete them (${skipped} skipped). Nothing written.`
    )
    return
  }

  writeFileSync(CHANGELOG_PATH, merged)
  for (const path of consumed) rmSync(path)

  console.log(
    `[collect-changelog] folded ${fragments.length} fragment(s) into ${CHANGELOG_PATH} and deleted them (${skipped} skipped).`
  )
  console.log("[collect-changelog] next: commit changelog.md + the fragment deletions together.")
}

// Only run the CLI when executed directly, so the fold helpers stay importable.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
