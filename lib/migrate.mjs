/**
 * Migrate an EXISTING docs/changelog.md into the layout the fold + condense
 * tooling requires, without rewriting a single character of entry text.
 *
 * This is the fiddly half of adopting the system. A real repo's changelog is
 * whatever shape it grew into: day headings may carry parentheticals
 * (`## 2026-07-03 (DocuSeal implementation plan)`), the same date may appear
 * several times, there may be no `---` separators and no summary section. The
 * tooling needs four structural things, all purely additive:
 *
 *   1. A `---` header rule above the first heading of ANY shape. `tier1Bounds()`
 *      treats the first `---` in the file as the top of the Tier-1 zone — without
 *      one at the top, the first separator the fold itself writes would become the
 *      boundary and every later entry would be inserted BELOW the newest day. The
 *      rule goes above `## [Unreleased]` / `## [1.2.0]` too, not just above the
 *      first parseable day: a Keep-a-Changelog file has no `## YYYY-MM-DD` heading
 *      at all, so anchoring to the day zone would drop the rule at EOF and bury
 *      every new entry under the whole history.
 *   2. A `---` separator between day blocks, so folded and pre-existing days look
 *      the same and a condense splice anchored at a day heading always has the
 *      `---` that Check F needs sitting right before it.
 *   3. The `## Earlier Changes (Summary)` sentinel, which bounds the Tier-1 zone
 *      and is where condensed entries land (Check F).
 *   4. The archive footer pointer (Check G).
 *
 * Legacy heading text is preserved byte-for-byte — including parentheticals and
 * duplicate dates. The fold and the condense planner both read the leading ISO date
 * off such a heading and ignore the trailing text, so a legacy day still sorts and
 * still ages out; only bracketed shapes with no ISO date (`## [1.2.0]`) stay opaque,
 * sinking down the Tier-1 zone as newer days land above them. Normalizing any of it
 * would mean merging same-date sections, i.e. editing history, which this
 * deliberately does not do.
 *
 * Every migration is verified lossless: each non-blank line of the original must
 * appear in the output, in the same order (`---` excepted — see `assertLossless`).
 * Anything else throws.
 */

const DAY_HEADING = /^## \d{4}-\d{2}-\d{2}/
/** Any `## ` heading, parseable as a day or not — where the header rule goes above. */
const ANY_H2 = /^##\s+\S/
const SUMMARY_HEADING = /^##\s+Earlier Changes/i
const HR = /^-{3,}\s*$/
const FOOTER_TEXT = "> Full per-day details available in [changelog-archive.md](changelog-archive.md)"
const SUMMARY_PLACEHOLDER =
  "_Nothing has aged out of full detail yet — `/changelog-condense` writes per-day summaries here once entries pass 3 days old._"

export class MigrationError extends Error {}

/** True when the file already has everything the tooling needs. */
export function isMigrated(text) {
  return (
    text.includes("---\n\n## Earlier Changes (Summary)") &&
    text.includes("> Full per-day details available in")
  )
}

/**
 * Reshape `text` into the canonical layout.
 *
 * Returns { text, changed, stats } — `stats` reports what was added so the
 * installer can show the user exactly what it did.
 */
export function migrateChangelog(text, { projectName = "this project" } = {}) {
  if (isMigrated(text)) {
    return { text, changed: false, stats: { dayBlocks: countDayBlocks(text), added: [] } }
  }

  const lines = text.split("\n")

  // --- Partition: preamble | day blocks | tail ------------------------------
  let firstDay = lines.findIndex((l) => DAY_HEADING.test(l))
  let summaryAt = lines.findIndex((l) => SUMMARY_HEADING.test(l))
  if (firstDay === -1) firstDay = summaryAt === -1 ? lines.length : summaryAt
  if (summaryAt !== -1 && summaryAt < firstDay) {
    throw new MigrationError(
      "'Earlier Changes' section appears before the first day heading — refusing to guess the layout"
    )
  }

  const preamble = lines.slice(0, firstDay)
  const dayZone = lines.slice(firstDay, summaryAt === -1 ? lines.length : summaryAt)
  const tail = summaryAt === -1 ? [] : lines.slice(summaryAt)

  const added = []

  // --- Preamble: title + intro, ending in a `---` header rule ---------------
  const pre = [...preamble]
  while (pre.length && pre[pre.length - 1].trim() === "") pre.pop()
  if (pre.length === 0) {
    pre.push("# Changelog", "", `All notable changes to ${projectName} are documented in this file.`)
    added.push("title + intro")
  } else if (!pre.some((l) => l.trim().startsWith("# "))) {
    // A title must go BELOW any YAML frontmatter — frontmatter is only frontmatter
    // when it's the first thing in the file (Docusaurus, VitePress, Jekyll).
    const at = frontmatterEnd(pre)
    pre.splice(at, 0, ...(at > 0 ? ["", "# Changelog", ""] : ["# Changelog", ""]))
    added.push("title")
  }
  // The rule marks the TOP of the Tier-1 zone, so it belongs above every entry —
  // including `##` headings this migrator can't read as days (`## [Unreleased]`,
  // `## [1.2.0] - 2026-03-29`). Those stay in the preamble, so appending the rule
  // to the end of it would put the boundary BELOW the whole history and new days
  // would fold in underneath. Only the rule moves; the legacy zone stays opaque.
  let ruleAt = pre.findIndex((l) => ANY_H2.test(l))
  if (ruleAt === -1) ruleAt = pre.length
  let above = ruleAt - 1
  while (above >= 0 && pre[above].trim() === "") above--
  if (above < 0 || !HR.test(pre[above])) {
    pre.splice(ruleAt, 0, "", "---", "")
    added.push("header rule")
  }

  // --- Day zone: one block per day heading, joined by `---` -----------------
  const blocks = []
  let cur = null
  for (const line of dayZone) {
    if (DAY_HEADING.test(line)) {
      if (cur) blocks.push(cur)
      cur = [line]
    } else if (cur) {
      cur.push(line)
    } else if (line.trim() !== "" && !HR.test(line)) {
      // Stray content between the header rule and the first day heading.
      throw new MigrationError(
        `unexpected content before the first day heading: ${JSON.stringify(line.slice(0, 60))}`
      )
    }
  }
  if (cur) blocks.push(cur)

  const trimmed = blocks.map((b) => {
    const out = [...b]
    while (out.length && (out[out.length - 1].trim() === "" || HR.test(out[out.length - 1]))) out.pop()
    return out
  })
  if (trimmed.length > 1) added.push(`${trimmed.length - 1} day separators`)

  // --- Tail: summary sentinel + footer --------------------------------------
  let tailLines
  if (tail.length === 0) {
    tailLines = ["## Earlier Changes (Summary)", "", SUMMARY_PLACEHOLDER, "", FOOTER_TEXT]
    added.push("'Earlier Changes' sentinel", "archive footer")
  } else {
    tailLines = [...tail]
    while (tailLines.length && tailLines[tailLines.length - 1].trim() === "") tailLines.pop()
    if (!tailLines.some((l) => l.startsWith("> Full per-day details available in"))) {
      tailLines.push("", FOOTER_TEXT)
      added.push("archive footer")
    }
  }

  // --- Reassemble ------------------------------------------------------------
  const out = [...pre, ""]
  for (const block of trimmed) out.push(...block, "", "---", "")
  if (trimmed.length === 0) {
    // The sentinel still needs a `---` directly above it (Check F) — unless the
    // header rule is already the last thing written, which it is for a file with
    // no headings at all. Pushing one unconditionally emitted a doubled rule.
    let last = out.length - 1
    while (last >= 0 && out[last].trim() === "") last--
    if (last < 0 || !HR.test(out[last])) out.push("---", "")
  }
  out.push(...tailLines, "")

  const result = out.join("\n").replace(/\n{3,}/g, "\n\n")
  assertLossless(text, result, added)

  return {
    text: result,
    changed: true,
    stats: { dayBlocks: trimmed.length, added },
  }
}

/**
 * Index just past a leading YAML frontmatter block, or 0 if there isn't one.
 * `lines[0]` must be the opening `---` for it to count as frontmatter at all.
 */
function frontmatterEnd(lines) {
  if (!lines.length || lines[0].trim() !== "---") return 0
  for (let i = 1; i < lines.length; i++) {
    if (HR.test(lines[i])) return i + 1
  }
  return 0 // unterminated — not frontmatter, don't guess
}

function countDayBlocks(text) {
  return text.split("\n").filter((l) => DAY_HEADING.test(l)).length
}

/**
 * Every non-blank line of the original must survive, in order. The only lines
 * the output may add are the structural ones this module inserts.
 *
 * `---` is exempt from the comparison entirely, on both sides. It carries no
 * content, and this module both inserts rules and re-emits them (a day block's
 * trailing rule is popped and rewritten between blocks), so it is neither
 * position- nor count-stable — the header rule in particular now lands ABOVE
 * legacy content it used to follow. Everything that isn't a rule or a blank must
 * still line up exactly.
 */
function assertLossless(before, after, added) {
  const structural = new Set([
    "# Changelog",
    "## Earlier Changes (Summary)",
    SUMMARY_PLACEHOLDER,
    FOOTER_TEXT,
  ])
  const carries = (l) => l.trim() !== "" && !HR.test(l)
  const oldLines = before.split("\n").filter(carries)
  const newLines = after.split("\n").filter(carries)

  // The rest are only exempt when this run actually added them; a sentinel or a
  // title that existed before must still be matched positionally.
  const kept = []
  const budget = new Map()
  for (const l of newLines) {
    if (structural.has(l) || /^All notable changes to .* are documented in this file\.$/.test(l)) {
      const seen = budget.get(l) ?? 0
      const allowance = oldLines.filter((o) => o === l).length
      if (seen >= allowance) {
        budget.set(l, seen + 1)
        continue // an added structural line — skip it
      }
      budget.set(l, seen + 1)
    }
    kept.push(l)
  }

  if (kept.length !== oldLines.length) {
    throw new MigrationError(
      `migration would change content: ${oldLines.length} source lines vs ${kept.length} preserved ` +
        `(added: ${added.join(", ") || "none"})`
    )
  }
  for (let i = 0; i < kept.length; i++) {
    if (kept[i] !== oldLines[i]) {
      throw new MigrationError(
        `migration would change content at line ${i + 1}:\n` +
          `  before: ${oldLines[i].slice(0, 100)}\n` +
          `  after:  ${kept[i].slice(0, 100)}`
      )
    }
  }
}
