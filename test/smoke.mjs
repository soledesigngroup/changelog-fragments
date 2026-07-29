#!/usr/bin/env node
/**
 * End-to-end smoke test: install into throwaway repos, then exercise the real
 * fold + condense scripts against the installed files.
 *
 * Structure: tests live in `group()`s, and each group creates the repos it needs.
 * Tests within a group are still ordered and stateful (that's the point — a fold
 * test wants the file the previous fold produced), but no state crosses a group
 * boundary, so a single group can be run on its own:
 *
 *   npm test                 # everything
 *   npm test -- fold         # only groups whose name matches "fold"
 *
 * Run: npm test
 */

import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const INSTALL = join(ROOT, "install.mjs")

const filter = process.argv[2] ?? null

let passed = 0
let skippedGroups = 0
const cleanup = []

/**
 * A named batch of tests with its own fixtures. The body runs only if the group
 * matches the filter, so fixtures aren't built for groups that won't run.
 */
function group(name, fn) {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) {
    skippedGroups++
    return
  }
  console.log(`\n${name}`)
  try {
    fn()
  } catch (err) {
    console.error(`  ✗ ${name} — fixture setup failed\n    ${err.message.split("\n").join("\n    ")}`)
    process.exitCode = 1
  }
}

function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message.split("\n").join("\n    ")}`)
    process.exitCode = 1
  }
}

function newRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "clf-test-"))
  cleanup.push(dir)
  mkdirSync(join(dir, ".git"), { recursive: true }) // silence the not-a-repo warning
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

const run = (cmd, cmdArgs, cwd) =>
  execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

/** Exit status + combined output, for the cases where failing IS the behavior. */
function attempt(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8" })
  return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") }
}

const install = (dir, extra = []) => run("node", [INSTALL, dir, ...extra], ROOT)
const fold = (dir, extra = []) => run("node", ["scripts/collect-changelog.mjs", ...extra], dir)
const foldAttempt = (dir, extra = []) =>
  attempt("node", ["scripts/collect-changelog.mjs", ...extra], dir)
const condense = (dir, extra) => attempt("node", ["scripts/condense-changelog.mjs", ...extra], dir)
const read = (dir, rel) => readFileSync(join(dir, rel), "utf8")
const write = (dir, rel, body) => writeFileSync(join(dir, rel), body)

const fragment = (dir, name, body) => {
  writeFileSync(join(dir, "docs/changelog.d", name), body)
}

const contentLines = (s) => s.split("\n").filter((l) => l.trim() !== "")
const dayHeadings = (s) => s.split("\n").filter((l) => /^## \d{4}-/.test(l))
/** Just the dates of the day headings, in file order. */
const dayDates = (s) => dayHeadings(s).map((l) => l.match(/^## (\d{4}-\d{2}-\d{2})/)[1])

/** Assert a condense run aborted, naming the check that should have caught it. */
function assertCheckFails(result, checkId) {
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}:\n${result.out}`)
  assert.match(result.out, /ABORT - nothing written/, result.out)
  assert.match(
    result.out,
    new RegExp(`^\\s*- ${checkId}: `, "m"),
    `expected check ${checkId} to fire, got:\n${result.out}`
  )
}

// ---------------------------------------------------------------------------

const MESSY = `# Changelog

## 2026-07-13

### Removed
- **Venue rules card** — folded into the contract itself.

## 2026-07-03 (DocuSeal implementation plan)

### Added
- **Plan doc** — retargeted from DocuSign.

## 2026-07-03 (Provider decision finalized)

### Changed
- **Provider** — committed to DocuSeal.

## 2026-04-11

### Added
- Initial database schema with 8 tables
`

group("migrating an existing messy changelog", () => {
  const messy = newRepo({
    "docs/changelog.md": MESSY,
    "package.json": '{\n  "name": "demo-app"\n}\n',
  })
  const before = read(messy, "docs/changelog.md")
  install(messy)
  const after = read(messy, "docs/changelog.md")

  test("every original content line survives, in order", () => {
    const added = new Set(["---", "## Earlier Changes (Summary)"])
    const kept = contentLines(after).filter(
      (l) =>
        !added.has(l) &&
        !l.startsWith("_Nothing has aged out") &&
        !l.startsWith("> Full per-day details available in") &&
        !/^All notable changes to .* are documented in this file\.$/.test(l)
    )
    assert.deepEqual(kept, contentLines(before))
  })

  test("legacy parenthetical headings and duplicate dates are untouched", () => {
    assert.ok(after.includes("## 2026-07-03 (DocuSeal implementation plan)"))
    assert.ok(after.includes("## 2026-07-03 (Provider decision finalized)"))
  })

  test("header rule + one separator per day block", () => {
    assert.equal(after.split("\n").filter((l) => l === "---").length, 5) // 1 header + 4 days
  })

  test("Check F / G structure is present", () => {
    assert.ok(after.includes("---\n\n## Earlier Changes (Summary)"))
    assert.ok(after.includes("> Full per-day details available in"))
  })

  test("migration leaves the existing preamble alone (no invented intro prose)", () => {
    assert.ok(after.startsWith("# Changelog\n\n---\n"))
    assert.ok(!after.includes("All notable changes"))
  })

  test("a repo with a package.json but no changelog gets a titleized seed", () => {
    const named = newRepo({ "package.json": '{\n  "name": "demo-app"\n}\n' })
    install(named)
    assert.ok(
      read(named, "docs/changelog.md").includes(
        "All notable changes to Demo App are documented in this file."
      )
    )
  })

  test("npm script was added", () => {
    const pkg = JSON.parse(read(messy, "package.json"))
    assert.equal(pkg.scripts["changelog:fold"], "node scripts/collect-changelog.mjs")
  })

  test("archive was seeded with an --ar-before anchor", () => {
    assert.ok(read(messy, "docs/changelog-archive.md").includes("--ar-before"))
  })

  test("commands reference the npm fold command", () => {
    assert.ok(
      read(messy, ".claude/commands/changelog-condense.md").includes("npm run changelog:fold")
    )
    assert.ok(!read(messy, ".claude/commands/changelog-update.md").includes("{{"))
    assert.ok(!read(messy, "docs/changelog.d/README.md").includes("{{"))
  })

  test("an added title lands below YAML frontmatter, not above it", () => {
    const fm = newRepo({
      "docs/changelog.md":
        "---\ntitle: Changelog\nsidebar_position: 9\n---\n\n## 2026-07-13\n\n### Added\n- **Thing** — did it.\n",
    })
    install(fm)
    const out = read(fm, "docs/changelog.md")
    assert.ok(out.startsWith("---\ntitle: Changelog\nsidebar_position: 9\n---\n"), out.slice(0, 80))
    assert.ok(out.indexOf("# Changelog") > out.indexOf("sidebar_position"))
  })

  test("package.json indentation is preserved, not reformatted to 2 spaces", () => {
    const tabbed = newRepo({ "package.json": '{\n\t"name": "tabbed"\n}\n' })
    install(tabbed)
    assert.match(read(tabbed, "package.json"), /\n\t"scripts": \{\n\t\t"changelog:fold"/)
  })

  test("--name without a value is rejected", () => {
    const r = attempt("node", [INSTALL, newRepo(), "--name", "--dry-run"], ROOT)
    assert.equal(r.status, 1)
    assert.match(r.out, /--name needs a value/)
  })
})

/**
 * The other real-world shape: bracketed release headings, no `## YYYY-MM-DD`
 * anywhere, and a `---` already sitting in the middle of the history.
 */
const KEEP_A_CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Nothing yet.

## [1.2.0] - 2026-03-29

### Added

- Widget rendering.

---

## [1.1.0] - 2026-02-01

### Fixed

- Crash on empty input.
`

group("migrating a Keep-a-Changelog file", () => {
  const repo = newRepo({ "docs/changelog.md": KEEP_A_CHANGELOG })
  const before = read(repo, "docs/changelog.md")
  install(repo)
  const after = read(repo, "docs/changelog.md")

  const noRules = (s) => contentLines(s).filter((l) => l !== "---")

  test("the header rule lands above the history, not at EOF", () => {
    // tier1Bounds() takes the FIRST `---` in the file. Appending the rule to the
    // end of the preamble — which here is the whole file — made some pre-existing
    // separator mid-history the Tier-1 boundary.
    const lines = after.split("\n")
    const rule = lines.indexOf("---")
    const firstHeading = lines.findIndex((l) => l.startsWith("## "))
    assert.ok(rule !== -1 && rule < firstHeading, `rule at ${rule}, heading at ${firstHeading}`)
    assert.equal(lines[firstHeading], "## [Unreleased]")
  })

  test("no doubled separator on the zero-day-block path", () => {
    assert.doesNotMatch(after, /---\n\n---/, after)
  })

  test("bracketed headings survive byte-for-byte", () => {
    for (const h of ["## [Unreleased]", "## [1.2.0] - 2026-03-29", "## [1.1.0] - 2026-02-01"]) {
      assert.ok(after.includes(h), h)
    }
    const kept = noRules(after).filter(
      (l) =>
        l !== "## Earlier Changes (Summary)" &&
        !l.startsWith("_Nothing has aged out") &&
        !l.startsWith("> Full per-day details available in")
    )
    assert.deepEqual(kept, noRules(before))
  })

  test("a folded entry lands on top, above the whole legacy history", () => {
    fragment(repo, "2026-07-28-brand-new-a1b2.md", "### Added\n- **Brand new** — thing.\n")
    fold(repo)
    const cl = read(repo, "docs/changelog.md")
    assert.ok(cl.indexOf("## 2026-07-28") < cl.indexOf("## [Unreleased]"), cl)
    assert.ok(cl.indexOf("---") < cl.indexOf("## 2026-07-28"), cl)
  })

  test("the result passes --check", () => {
    assert.equal(foldAttempt(repo, ["--check"]).status, 0)
  })

  test("an [Unreleased] section above dated days doesn't push the rule below it", () => {
    const mixed = newRepo({
      "docs/changelog.md":
        "# Changelog\n\n## [Unreleased]\n\n- pending thing\n\n## 2026-07-13\n\n### Added\n- **Dated** — entry.\n",
    })
    install(mixed)
    const lines = read(mixed, "docs/changelog.md").split("\n")
    assert.ok(lines.indexOf("---") < lines.indexOf("## [Unreleased]"))

    fragment(mixed, "2026-07-28-newest-a1b2.md", "### Added\n- **Newest** — entry.\n")
    fold(mixed)
    const folded = read(mixed, "docs/changelog.md")
    assert.ok(folded.indexOf("## 2026-07-28") < folded.indexOf("## [Unreleased]"), folded)
    assert.equal(foldAttempt(mixed, ["--check"]).status, 0)
  })

  test("an existing header rule above the first heading is reused, not duplicated", () => {
    const ruled = newRepo({
      "docs/changelog.md": "# Changelog\n\nIntro.\n\n---\n\n## [Unreleased]\n\n- pending thing\n",
    })
    const out = install(ruled)
    assert.ok(!out.includes("header rule"), out)
    assert.ok(read(ruled, "docs/changelog.md").startsWith("# Changelog\n\nIntro.\n\n---\n\n## [Unreleased]"))
  })
})

group("folding fragments", () => {
  const repo = newRepo({ "docs/changelog.md": MESSY, "package.json": '{\n  "name": "demo-app"\n}\n' })
  install(repo)

  fragment(
    repo,
    "2026-07-26-first-a1b2.md",
    "### Fixed\n- **Fix one** — details.\n\n### Added\n- **Add one** — details.\n"
  )

  test("dry run writes nothing", () => {
    const snapshot = read(repo, "docs/changelog.md")
    fold(repo, ["--dry-run"])
    assert.equal(read(repo, "docs/changelog.md"), snapshot)
    assert.ok(existsSync(join(repo, "docs/changelog.d/2026-07-26-first-a1b2.md")))
  })

  test("new day lands on top, categories in canonical order, fragment deleted", () => {
    fold(repo)
    const cl = read(repo, "docs/changelog.md")
    const lines = cl.split("\n")
    const firstDay = lines.findIndex((l) => l.startsWith("## 2026-"))
    assert.equal(lines[firstDay], "## 2026-07-26")
    assert.ok(cl.indexOf("### Added") < cl.indexOf("### Fixed"))
    assert.ok(!existsSync(join(repo, "docs/changelog.d/2026-07-26-first-a1b2.md")))
  })

  test("a second fragment on the same date merges into the existing day", () => {
    fragment(repo, "2026-07-26-second-c3d4.md", "### Fixed\n- **Fix two** — details.\n")
    fold(repo)
    const cl = read(repo, "docs/changelog.md")
    assert.equal(cl.split("\n").filter((l) => l === "## 2026-07-26").length, 1)
    assert.ok(cl.includes("- **Fix one** — details."))
    assert.ok(cl.includes("- **Fix two** — details."))
  })

  test("bullet text is copied byte-for-byte", () => {
    const weird = "- **Odd — text** with `code`, [a link](../src/x.ts), and 2 spaces:  end."
    fragment(repo, "2026-07-27-verbatim-e5f6.md", `### Changed\n${weird}\n`)
    fold(repo)
    assert.ok(read(repo, "docs/changelog.md").includes(weird))
  })

  test("a malformed fragment name is skipped, not folded", () => {
    fragment(repo, "no-date-prefix.md", "### Fixed\n- **Nope** — should not fold.\n")
    const r = foldAttempt(repo)
    assert.match(r.out, /filename must start with YYYY-MM-DD-/)
    assert.equal(r.status, 1, "a skipped fragment must not report success")
    assert.ok(existsSync(join(repo, "docs/changelog.d/no-date-prefix.md")))
    assert.ok(!read(repo, "docs/changelog.md").includes("should not fold"))
    rmSync(join(repo, "docs/changelog.d/no-date-prefix.md"))
  })

  test("Deprecated is a canonical category", () => {
    fragment(repo, "2026-07-28-dep-0a0a.md", "### Deprecated\n- **Old API** — going away.\n")
    fold(repo)
    const cl = read(repo, "docs/changelog.md")
    assert.ok(cl.includes("### Deprecated"))
    assert.ok(cl.includes("- **Old API** — going away."))
  })

  test("an unrecognized category is refused, not swallowed into the block above", () => {
    fragment(
      repo,
      "2026-07-29-unknown-0b0b.md",
      "### Added\n- **Real** — yes.\n\n### Docs\n- **Readme** — updated.\n"
    )
    const r = foldAttempt(repo)
    assert.equal(r.status, 1)
    assert.match(r.out, /unrecognized heading "### Docs"/)
    assert.ok(
      existsSync(join(repo, "docs/changelog.d/2026-07-29-unknown-0b0b.md")),
      "an unfoldable fragment must be left on disk"
    )
    assert.ok(!read(repo, "docs/changelog.md").includes("**Readme**"))
    rmSync(join(repo, "docs/changelog.d/2026-07-29-unknown-0b0b.md"))
  })

  test("a bullet above the first category heading is refused, not dropped", () => {
    fragment(
      repo,
      "2026-07-29-orphan-0c0c.md",
      "- **Orphan bullet** — no heading above me.\n\n### Fixed\n- **Kept** — yes.\n"
    )
    const r = foldAttempt(repo)
    assert.equal(r.status, 1)
    assert.match(r.out, /content above the first "### Category" heading/)
    assert.ok(existsSync(join(repo, "docs/changelog.d/2026-07-29-orphan-0c0c.md")))
    assert.ok(!read(repo, "docs/changelog.md").includes("Orphan bullet"))
    rmSync(join(repo, "docs/changelog.d/2026-07-29-orphan-0c0c.md"))
  })

  test("an older fragment folded late still lands below newer days", () => {
    fragment(repo, "2026-07-24-late-0d0d.md", "### Fixed\n- **Backdated** — crossed midnight.\n")
    fold(repo)
    const cl = read(repo, "docs/changelog.md")
    // Non-increasing, not strictly: the migrated fixture keeps two legacy headings
    // that share a date on purpose.
    const dates = dayDates(cl)
    assert.deepEqual(
      dates,
      [...dates].sort().reverse(),
      `Tier-1 day headings must stay descending, got:\n${dayHeadings(cl).join("\n")}`
    )
    assert.ok(dates.includes("2026-07-24"))
    assert.ok(dates.indexOf("2026-07-26") < dates.indexOf("2026-07-24"))
  })

  test("the fold is cwd-independent", () => {
    mkdirSync(join(repo, "src/deep"), { recursive: true })
    fragment(repo, "2026-07-30-subdir-0e0e.md", "### Added\n- **From a subdir** — folded.\n")
    const r = attempt("node", [join(repo, "scripts/collect-changelog.mjs")], join(repo, "src/deep"))
    assert.equal(r.status, 0, r.out)
    assert.ok(read(repo, "docs/changelog.md").includes("**From a subdir**"))
  })

  test("a path with a space in it still folds", () => {
    const parent = mkdtempSync(join(tmpdir(), "clf-space-"))
    cleanup.push(parent)
    const spaced = join(parent, "My Repos", "demo")
    mkdirSync(join(spaced, ".git"), { recursive: true })
    install(spaced)
    fragment(spaced, "2026-07-26-space-0f0f.md", "### Added\n- **Spaced path** — folded.\n")
    const r = attempt("node", ["scripts/collect-changelog.mjs"], spaced)
    assert.equal(r.status, 0, r.out)
    assert.ok(
      read(spaced, "docs/changelog.md").includes("**Spaced path**"),
      "the CLI guard must not compare URL strings to raw paths"
    )
  })

  test("a second concurrent fold refuses instead of racing", () => {
    fragment(repo, "2026-07-31-race-1a1a.md", "### Added\n- **Race one** — x.\n")
    writeFileSync(join(repo, "docs/changelog.d/.fold.lock"), `${process.pid}\n`)
    const r = foldAttempt(repo)
    assert.equal(r.status, 1)
    assert.match(r.out, /another fold is running/)
    assert.ok(existsSync(join(repo, "docs/changelog.d/2026-07-31-race-1a1a.md")))
    rmSync(join(repo, "docs/changelog.d/.fold.lock"))
  })

  test("a lock from a dead process is reclaimed", () => {
    writeFileSync(join(repo, "docs/changelog.d/.fold.lock"), "2147483none\n")
    writeFileSync(join(repo, "docs/changelog.d/.fold.lock"), "999999999\n")
    const r = foldAttempt(repo)
    assert.match(r.out, /reclaiming stale lock/)
    assert.equal(r.status, 0, r.out)
    assert.ok(read(repo, "docs/changelog.md").includes("**Race one**"))
    assert.ok(!existsSync(join(repo, "docs/changelog.d/.fold.lock")), "lock must be released")
  })

  test("the lock file is never mistaken for a fragment", () => {
    const r = foldAttempt(repo)
    assert.ok(!r.out.includes(".fold.lock"))
  })
})

group("fold --check", () => {
  const repo = newRepo({ "package.json": '{\n  "name": "checked"\n}\n' })
  install(repo)

  test("passes on a freshly installed repo", () => {
    const r = foldAttempt(repo, ["--check"])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /check passed/)
  })

  test("a pending fragment is reported but is not a failure", () => {
    fragment(repo, "2026-07-26-pending-2a2a.md", "### Added\n- **Pending** — mid-session.\n")
    const r = foldAttempt(repo, ["--check"])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /1 fragment\(s\) pending/)
  })

  test("an unfoldable fragment fails the check", () => {
    fragment(repo, "2026-07-26-bad-2b2b.md", "### Nope\n- **Bad heading** — x.\n")
    const r = foldAttempt(repo, ["--check"])
    assert.equal(r.status, 1)
    assert.match(r.out, /unrecognized heading "### Nope"/)
    rmSync(join(repo, "docs/changelog.d/2026-07-26-bad-2b2b.md"))
  })

  test("an out-of-order hand-edit fails the check", () => {
    fold(repo)
    const cl = read(repo, "docs/changelog.md")
    write(
      repo,
      "docs/changelog.md",
      cl.replace("## 2026-07-26", "## 2026-07-01\n\n### Added\n- hand-edited\n\n---\n\n## 2026-07-26")
    )
    const r = foldAttempt(repo, ["--check"])
    assert.equal(r.status, 1)
    assert.match(r.out, /out of order/)
    write(repo, "docs/changelog.md", cl)
  })

  test("a duplicated day heading fails the check", () => {
    const cl = read(repo, "docs/changelog.md")
    write(
      repo,
      "docs/changelog.md",
      cl.replace("## 2026-07-26", "## 2026-07-26\n\n### Added\n- dupe\n\n---\n\n## 2026-07-26")
    )
    const r = foldAttempt(repo, ["--check"])
    assert.equal(r.status, 1)
    assert.match(r.out, /duplicate day heading '## 2026-07-26'/)
    write(repo, "docs/changelog.md", cl)
  })

  test("a Tier-1 zone that opens below the history fails the check", () => {
    // What a pre-1.0.1 migration of a Keep a Changelog file produced: the header
    // rule at the bottom, so the boundary sits under entries that belong above it.
    const stale = newRepo()
    install(stale)
    write(
      stale,
      "docs/changelog.md",
      "# Changelog\n\n## [Unreleased]\n\n- pending thing\n\n---\n\n## Earlier Changes (Summary)\n\n" +
        "> Full per-day details available in [changelog-archive.md](changelog-archive.md)\n"
    )
    const r = foldAttempt(stale, ["--check"])
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /sits above the '---' that opens the Tier-1 zone/, r.out)
  })

  test("a missing footer fails the check", () => {
    const cl = read(repo, "docs/changelog.md")
    write(repo, "docs/changelog.md", cl.replace(/> Full per-day details available in.*/, ""))
    const r = foldAttempt(repo, ["--check"])
    assert.equal(r.status, 1)
    assert.match(r.out, /missing footer pointer/)
    write(repo, "docs/changelog.md", cl)
  })

  test("repeated legacy day headings do not fail the check", () => {
    const legacy = newRepo({ "docs/changelog.md": MESSY })
    install(legacy)
    const r = foldAttempt(legacy, ["--check"])
    assert.equal(r.status, 0, r.out)
  })
})

// A changelog mid-life: Tier-1 days, existing Tier-2 summaries, Tier-3 ranges.
const MIDLIFE_CL = `# Changelog

All notable changes to Demo are documented in this file.

---

## 2026-07-26

### Added
- **Today thing** — x.

---

## 2026-07-25

### Fixed
- **Yesterday fix** — y.

---

## 2026-07-20

### Changed
- **Six days ago** — z.

---

## 2026-07-18

### Added
- **Eight days ago** — w.

---

## Earlier Changes (Summary)

### 2026-07-14
- **Twelve days ago** — still Tier 2.

### 2026-07-05
- **Three weeks ago** — must collapse to Tier 3.

### 2026-07-02
- **Also aging** — must collapse to Tier 3.

### 2026-06-01 to 2026-06-07
Theme summary for early June.

### 2026-05-04 to 2026-05-10
Theme summary for early May.

> Full per-day details available in [changelog-archive.md](changelog-archive.md)
`

const MIDLIFE_AR = `# Changelog Archive

Full per-day detail for entries that have aged out of \`docs/changelog.md\`. Newest at top.

---

### 2026-06-07
- **June seven** — detail.

### 2026-06-01
- **June one** — detail.

### 2026-05-10
- **May ten** — detail.

### 2026-05-04
- **May four** — detail.

### 2025-12-20
- **Last December** — detail.

### 2025-11-02
- **Last November** — detail.

_Nothing archived yet — \`/changelog-condense\` inserts per-day entries above this line, newest first._
`

const midlifeRepo = () => {
  const dir = newRepo({ "package.json": '{\n  "name": "midlife"\n}\n' })
  install(dir)
  write(dir, "docs/changelog.md", MIDLIFE_CL)
  write(dir, "docs/changelog-archive.md", MIDLIFE_AR)
  return dir
}

const CL_AR = ["--changelog", "docs/changelog.md", "--archive", "docs/changelog-archive.md"]

group("condense --plan", () => {
  const repo = midlifeRepo()

  test("classifies every heading into a tier", () => {
    const r = condense(repo, [...CL_AR, "--plan", "--today", "2026-07-26"])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /Tier 1 .*\(>= 2026-07-23\): 2026-07-26, 2026-07-25/)
    assert.match(r.out, /Tier 2 .*\(>= 2026-07-12\): 2026-07-20, 2026-07-18/)
    assert.match(r.out, /Tier 3 .*\(>= 2026-06-14\): 2026-07-05, 2026-07-02/)
    assert.match(r.out, /Tier 4 .*2026-06-01 to 2026-06-07, 2026-05-04 to 2026-05-10/)
  })

  test("--cl-end clears the last heading that changes, not the first that doesn't", () => {
    const r = condense(repo, [...CL_AR, "--plan", "--today", "2026-07-26"])
    assert.match(r.out, /--cl-start '## 2026-07-20'/)
    assert.match(r.out, /--cl-end\s+'### 2026-06-01 to 2026-06-07'/)
    assert.match(r.out, /copied VERBATIM \(unchanged this run\): ### 2026-07-14/)
  })

  test("computes the cutoffs and the archive anchor", () => {
    const r = condense(repo, [...CL_AR, "--plan", "--today", "2026-07-26"])
    assert.match(r.out, /--keep-detailed-since 2026-07-23/)
    assert.match(r.out, /--drop-ranges-before 2026-06-14/)
    assert.match(r.out, /--ar-before '### 2026-06-07'/)
  })

  test("the printed command is safe to paste into a shell", () => {
    // The seeded archive placeholder contains backticks; an anchor carrying them
    // unquoted would command-substitute when pasted.
    const fresh = newRepo()
    install(fresh)
    write(fresh, "docs/changelog.md", MIDLIFE_CL)
    const r = condense(fresh, [...CL_AR, "--plan", "--today", "2026-07-26"])
    const cmdLines = r.out.split("\n").filter((l) => l.trim().startsWith("--"))
    assert.ok(cmdLines.length > 0, r.out)
    for (const l of cmdLines) {
      const value = l.slice(l.indexOf(" ", l.indexOf("--")) + 1).trim().replace(/ \\$/, "")
      if (!value.startsWith("'")) assert.doesNotMatch(value, /[`$"]/, `unquoted anchor: ${l}`)
    }
    assert.match(r.out, /--ar-before '_Nothing archived yet[^`']*'/)
  })

  test("writes nothing", () => {
    const before = read(repo, "docs/changelog.md")
    const beforeAr = read(repo, "docs/changelog-archive.md")
    condense(repo, [...CL_AR, "--plan", "--today", "2026-07-26"])
    assert.equal(read(repo, "docs/changelog.md"), before)
    assert.equal(read(repo, "docs/changelog-archive.md"), beforeAr)
  })

  test("--today is required, and only valid with --plan", () => {
    const noToday = condense(repo, [...CL_AR, "--plan"])
    assert.equal(noToday.status, 2)
    assert.match(noToday.out, /--plan requires --today/)

    const strayToday = condense(repo, [...CL_AR, "--today", "2026-07-26", "--drop-ranges-before", "2026-01-01"])
    assert.equal(strayToday.status, 2)
    assert.match(strayToday.out, /--today is only meaningful with --plan/)

    const bad = condense(repo, [...CL_AR, "--plan", "--today", "26-07-2026"])
    assert.equal(bad.status, 2)
    assert.match(bad.out, /must be YYYY-MM-DD/)
  })

  test("says so when nothing has aged out", () => {
    const fresh = newRepo()
    install(fresh, ["--name", "Fresh"])
    const r = condense(fresh, [...CL_AR, "--plan", "--today", "2026-07-26"])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /Nothing has aged out yet/)
  })

  test("the plan's own command verifies end to end", () => {
    // Exactly what --plan asked for: rewrite 07-20/07-18 as Tier-2, re-emit 07-14
    // verbatim, collapse 07-05 + 07-02 into a week-range, archive their detail.
    write(
      repo,
      "cl-mid.md",
      `## Earlier Changes (Summary)

### 2026-07-20
- **Six days ago** — condensed.

### 2026-07-18
- **Eight days ago** — condensed.

### 2026-07-14
- **Twelve days ago** — still Tier 2.

### 2026-07-02 to 2026-07-05
Early July theme summary.

`
    )
    write(
      repo,
      "ar-new.md",
      `### 2026-07-05
- **Three weeks ago** — detail.

---

### 2026-07-02
- **Also aging** — detail.

---

`
    )
    const r = condense(repo, [
      "--changelog", "docs/changelog.md",
      "--cl-start", "## 2026-07-20",
      "--cl-end", "### 2026-06-01 to 2026-06-07",
      "--cl-mid", "cl-mid.md",
      "--archive", "docs/changelog-archive.md",
      "--ar-before", "### 2026-06-07",
      "--ar-content", "ar-new.md",
      "--keep-detailed-since", "2026-07-23",
      "--drop-ranges-before", "2026-06-14",
    ])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /All checks passed/)

    const cl = read(repo, "docs/changelog.md")
    assert.match(cl, /^## 2026-07-26$/m, "Tier 1 kept")
    assert.match(cl, /^## 2026-07-25$/m, "Tier 1 kept")
    assert.doesNotMatch(cl, /^## 2026-07-20$/m, "07-20 left full detail")
    assert.match(cl, /^### 2026-07-20$/m, "07-20 is now a per-day summary")
    assert.match(cl, /^### 2026-07-02 to 2026-07-05$/m, "collapsed into a range")
    assert.doesNotMatch(cl, /^### 2026-06-01 to 2026-06-07$/m, "Tier-4 range dropped")
    assert.doesNotMatch(cl, /^### 2026-05-04 to 2026-05-10$/m, "Tier-4 range dropped")
    assert.ok(cl.includes("> Full per-day details available in"), "footer kept")
    assert.ok(cl.includes("---\n\n## Earlier Changes (Summary)"), "separator kept")

    const ar = read(repo, "docs/changelog-archive.md")
    assert.ok(ar.indexOf("### 2026-07-05") < ar.indexOf("### 2026-06-07"), "archive newest-first")
    assert.ok(ar.includes("### 2026-07-02"))
  })

  test("the post-condense file still passes fold --check", () => {
    const r = foldAttempt(repo, ["--check"])
    assert.equal(r.status, 0, r.out)
  })
})

group("condense sees the same day headings the fold does", () => {
  /** MIDLIFE_CL with legacy trailing text on the topmost condensing day. */
  const legacyRepo = (heading = "## 2026-07-20 (DocuSeal implementation plan)") => {
    const dir = midlifeRepo()
    write(dir, "docs/changelog.md", MIDLIFE_CL.replace("## 2026-07-20", heading))
    return dir
  }

  test("a legacy parenthetical heading is classified into a tier", () => {
    // The fold orders it (its DAY_DATE_RE tolerates trailing text); an anchored
    // regex here left it in no tier at all, unable to ever age out.
    const r = condense(legacyRepo(), [...CL_AR, "--plan", "--today", "2026-07-26"])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /Tier 2 .*\(>= 2026-07-12\): 2026-07-20, 2026-07-18/)
  })

  test("its anchor is the heading as written, not a reconstructed '## DATE'", () => {
    const r = condense(legacyRepo(), [...CL_AR, "--plan", "--today", "2026-07-26"])
    assert.match(r.out, /--cl-start '## 2026-07-20 \(DocuSeal implementation plan\)'/, r.out)
  })

  test("two same-date legacy headings still yield an anchor that resolves once", () => {
    const dir = midlifeRepo()
    write(
      dir,
      "docs/changelog.md",
      MIDLIFE_CL.replace(
        "## 2026-07-20\n",
        "## 2026-07-20 (provider decision)\n\n### Changed\n- **Same day, twice** — q.\n\n---\n\n## 2026-07-20 (retro)\n"
      )
    )
    const r = condense(dir, [...CL_AR, "--plan", "--today", "2026-07-26"])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /--cl-start '## 2026-07-20 \(provider decision\)'/, r.out)
  })

  test("a legacy day actually ages out end to end", () => {
    const dir = legacyRepo()
    write(
      dir,
      "cl-mid.md",
      `## Earlier Changes (Summary)

### 2026-07-20
- **Six days ago** — condensed.

### 2026-07-18
- **Eight days ago** — condensed.

### 2026-07-14
- **Twelve days ago** — still Tier 2.

### 2026-07-02 to 2026-07-05
Early July theme summary.

`
    )
    write(dir, "ar-new.md", "### 2026-07-05\n- d.\n\n---\n\n### 2026-07-02\n- d.\n\n---\n\n")
    const r = condense(dir, [
      ...CL_AR,
      "--cl-start", "## 2026-07-20 (DocuSeal implementation plan)",
      "--cl-end", "### 2026-06-01 to 2026-06-07",
      "--cl-mid", "cl-mid.md",
      "--ar-before", "### 2026-06-07",
      "--ar-content", "ar-new.md",
      "--keep-detailed-since", "2026-07-23",
      "--drop-ranges-before", "2026-06-14",
    ])
    assert.equal(r.status, 0, r.out)
    const cl = read(dir, "docs/changelog.md")
    assert.ok(!cl.includes("(DocuSeal implementation plan)"), "legacy heading is gone")
    assert.match(cl, /^### 2026-07-20$/m, "and came back as a canonical Tier-2 entry")
    assert.equal(foldAttempt(dir, ["--check"]).status, 0)
  })

  test("Check C catches a legacy day dropped without being archived", () => {
    const dir = legacyRepo("## 2026-07-20 (retro)")
    write(dir, "cl-mid.md", "## Earlier Changes (Summary)\n\n")
    assertCheckFails(
      condense(dir, [
        ...CL_AR,
        "--cl-start", "## 2026-07-20 (retro)",
        "--cl-end", "### 2026-06-01 to 2026-06-07",
        "--cl-mid", "cl-mid.md",
      ]),
      "C"
    )
  })
})

group("condense verification checks", () => {
  test("A: an ambiguous --cl-start anchor aborts", () => {
    const repo = midlifeRepo()
    write(repo, "cl-mid.md", "## Earlier Changes (Summary)\n")
    assertCheckFails(
      condense(repo, [
        "--changelog", "docs/changelog.md",
        "--cl-start", "### Added",
        "--cl-end", "> Full per-day details available in",
        "--cl-mid", "cl-mid.md",
      ]),
      "A"
    )
  })

  test("A: --cl-start must precede --cl-end", () => {
    const repo = midlifeRepo()
    write(repo, "cl-mid.md", "## Earlier Changes (Summary)\n")
    assertCheckFails(
      condense(repo, [
        "--changelog", "docs/changelog.md",
        "--cl-start", "### 2026-07-14",
        "--cl-end", "## 2026-07-20",
        "--cl-mid", "cl-mid.md",
      ]),
      "A"
    )
  })

  test("B: a duplicated heading in the spliced text aborts", () => {
    const repo = midlifeRepo()
    write(
      repo,
      "cl-mid.md",
      "## Earlier Changes (Summary)\n\n### 2026-07-14\n- dupe.\n\n### 2026-07-14\n- dupe.\n\n"
    )
    assertCheckFails(
      condense(repo, [
        "--changelog", "docs/changelog.md",
        "--cl-start", "## 2026-07-20",
        "--cl-end", "### 2026-07-05",
        "--cl-mid", "cl-mid.md",
      ]),
      "B"
    )
  })

  test("C: dropping a per-day date without archiving it aborts", () => {
    const repo = midlifeRepo()
    // 07-05 and 07-02 vanish from the changelog with no archive entry for them.
    write(repo, "cl-mid.md", "## Earlier Changes (Summary)\n\n### 2026-07-14\n- kept.\n\n")
    assertCheckFails(
      condense(repo, [
        "--changelog", "docs/changelog.md",
        "--cl-start", "## 2026-07-20",
        "--cl-end", "### 2026-06-01 to 2026-06-07",
        "--cl-mid", "cl-mid.md",
        "--archive", "docs/changelog-archive.md",
      ]),
      "C"
    )
  })

  test("D: condensing inside the 0-3 day window aborts", () => {
    const repo = midlifeRepo()
    write(repo, "cl-mid.md", "## Earlier Changes (Summary)\n\n### 2026-07-25\n- too soon.\n\n")
    assertCheckFails(
      condense(repo, [
        "--changelog", "docs/changelog.md",
        "--cl-start", "## 2026-07-25",
        "--cl-end", "### 2026-07-14",
        "--cl-mid", "cl-mid.md",
        "--archive", "docs/changelog-archive.md",
        "--keep-detailed-since", "2026-07-23",
      ]),
      "D"
    )
  })

  test("E: a week-range covering a surviving per-day heading aborts", () => {
    const repo = midlifeRepo()
    // The range swallows 07-14, which the same file still lists per-day.
    write(
      repo,
      "cl-mid.md",
      "## Earlier Changes (Summary)\n\n### 2026-07-10 to 2026-07-20\nOverlapping theme.\n\n### 2026-07-14\n- still here.\n\n"
    )
    assertCheckFails(
      condense(repo, [
        "--changelog", "docs/changelog.md",
        "--cl-start", "## 2026-07-20",
        "--cl-end", "### 2026-07-05",
        "--cl-mid", "cl-mid.md",
        "--archive", "docs/changelog-archive.md",
      ]),
      "E"
    )
  })

  test("F: losing the separator before the summary sentinel aborts", () => {
    const repo = midlifeRepo()
    write(repo, "cl-mid.md", "## Earlier Changes\n\n### 2026-07-14\n- renamed sentinel.\n\n")
    assertCheckFails(
      condense(repo, [
        "--changelog", "docs/changelog.md",
        "--cl-start", "## 2026-07-20",
        "--cl-end", "### 2026-07-05",
        "--cl-mid", "cl-mid.md",
        "--archive", "docs/changelog-archive.md",
      ]),
      "F"
    )
  })

  test("G: a changelog whose archive footer is already gone aborts", () => {
    const repo = midlifeRepo()
    // The footer sits below --cl-end on every real run, so the way it goes missing
    // is a hand-edit. Refuse to splice such a file rather than entrench the damage.
    write(repo, "docs/changelog.md", MIDLIFE_CL.replace(/^> Full per-day details.*$/m, ""))
    write(repo, "cl-mid.md", "### 2026-07-14\n- unchanged.\n\n")
    assertCheckFails(
      condense(repo, [
        "--changelog", "docs/changelog.md",
        "--cl-start", "### 2026-07-14",
        "--cl-end", "### 2026-07-05",
        "--cl-mid", "cl-mid.md",
        "--archive", "docs/changelog-archive.md",
      ]),
      "G"
    )
  })

  test("H: dropping a week-range the archive doesn't cover aborts", () => {
    const repo = midlifeRepo()
    // Empty the archive of May/June detail, then try to drop those ranges.
    write(
      repo,
      "docs/changelog-archive.md",
      "# Changelog Archive\n\n---\n\n### 2026-07-05\n- **Only July** — detail.\n"
    )
    assertCheckFails(
      condense(repo, [...CL_AR, "--drop-ranges-before", "2026-06-14"]),
      "H"
    )
  })

  test("H: a per-day heading inside the Tier-4 drop region aborts", () => {
    const repo = midlifeRepo()
    write(
      repo,
      "docs/changelog.md",
      MIDLIFE_CL.replace(
        "### 2026-05-04 to 2026-05-10\nTheme summary for early May.",
        "### 2026-05-04 to 2026-05-10\nTheme summary for early May.\n\n### 2026-04-02\n- stray per-day detail."
      )
    )
    assertCheckFails(
      condense(repo, [...CL_AR, "--drop-ranges-before", "2026-06-14"]),
      "H"
    )
  })

  test("nothing is written when a check fails", () => {
    const repo = midlifeRepo()
    const before = read(repo, "docs/changelog.md")
    const beforeAr = read(repo, "docs/changelog-archive.md")
    write(repo, "cl-mid.md", "## Earlier Changes (Summary)\n\n### 2026-07-14\n- kept.\n\n")
    condense(repo, [
      "--changelog", "docs/changelog.md",
      "--cl-start", "## 2026-07-20",
      "--cl-end", "### 2026-06-01 to 2026-06-07",
      "--cl-mid", "cl-mid.md",
      "--archive", "docs/changelog-archive.md",
    ])
    assert.equal(read(repo, "docs/changelog.md"), before)
    assert.equal(read(repo, "docs/changelog-archive.md"), beforeAr)
  })

  test("a Tier-4-only dry run passes on a freshly installed file", () => {
    const fresh = newRepo()
    install(fresh)
    const r = condense(fresh, [...CL_AR, "--drop-ranges-before", "2026-01-01", "--dry-run"])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /All checks passed\./)
    assert.match(r.out, /Dry run - nothing written\./)
  })

  test("a run with no operation requested aborts", () => {
    const repo = midlifeRepo()
    const r = condense(repo, [...CL_AR])
    assert.equal(r.status, 1)
    assert.match(r.out, /nothing to do/)
  })
})

group("condense --shed-year", () => {
  test("moves the oldest year into its own file, verified", () => {
    const repo = midlifeRepo()
    const before = read(repo, "docs/changelog-archive.md")
    const r = condense(repo, [...CL_AR, "--shed-year", "2025"])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /shed 2 2025 entries/)

    const ar = read(repo, "docs/changelog-archive.md")
    const yearFile = read(repo, "docs/changelog-archive-2025.md")
    assert.ok(!ar.includes("### 2025-"), "2025 left the archive")
    assert.ok(yearFile.includes("### 2025-12-20") && yearFile.includes("### 2025-11-02"))
    assert.ok(yearFile.startsWith("# Changelog Archive — 2025"))
    assert.ok(ar.includes("> Earlier years: [2025](changelog-archive-2025.md)"))
    assert.ok(ar.includes("_Nothing archived yet"), "trailing note stays in the archive")
    assert.ok(!yearFile.includes("_Nothing archived yet"), "trailing note is not moved")

    // Every heading and every entry line survives the partition exactly once.
    // `---` is structural: both files legitimately carry their own header rule.
    const headings = (s) => s.split("\n").filter((l) => l.startsWith("### ")).sort()
    assert.deepEqual(headings(before), [...headings(ar), ...headings(yearFile)].sort())
    for (const line of contentLines(before)) {
      if (line === "---" || line.startsWith("_Nothing archived")) continue
      const n =
        contentLines(ar).filter((l) => l === line).length +
        contentLines(yearFile).filter((l) => l === line).length
      assert.equal(n, 1, `line should appear exactly once after the shed: ${line}`)
    }
  })

  test("--dry-run writes no year file", () => {
    const repo = midlifeRepo()
    const r = condense(repo, [...CL_AR, "--shed-year", "2025", "--dry-run"])
    assert.equal(r.status, 0, r.out)
    assert.ok(!existsSync(join(repo, "docs/changelog-archive-2025.md")))
    assert.equal(read(repo, "docs/changelog-archive.md"), MIDLIFE_AR)
  })

  test("refuses a year that isn't the oldest", () => {
    const repo = midlifeRepo()
    write(
      repo,
      "docs/changelog-archive.md",
      MIDLIFE_AR.replace("_Nothing archived", "### 2024-08-08\n- **Older still** — detail.\n\n_Nothing archived")
    )
    assertCheckFails(condense(repo, [...CL_AR, "--shed-year", "2025"]), "I")
    assert.match(
      condense(repo, [...CL_AR, "--shed-year", "2025"]).out,
      /shed the OLDEST year first \(2024\)/
    )
  })

  test("refuses the only year, and refuses to overwrite an existing year file", () => {
    const repo = midlifeRepo()
    condense(repo, [...CL_AR, "--shed-year", "2025"])
    assertCheckFails(condense(repo, [...CL_AR, "--shed-year", "2026"]), "I")
    assert.match(condense(repo, [...CL_AR, "--shed-year", "2026"]).out, /only year/)

    // Put 2025 back so the target file collision is what fails, not absence.
    write(repo, "docs/changelog-archive.md", MIDLIFE_AR)
    assert.match(
      condense(repo, [...CL_AR, "--shed-year", "2025"]).out,
      /already exists — refusing to overwrite/
    )
  })

  test("successive sheds accumulate the pointer", () => {
    const repo = midlifeRepo()
    write(
      repo,
      "docs/changelog-archive.md",
      MIDLIFE_AR.replace("_Nothing archived", "### 2024-08-08\n- **Older still** — detail.\n\n_Nothing archived")
    )
    assert.equal(condense(repo, [...CL_AR, "--shed-year", "2024"]).status, 0)
    assert.equal(condense(repo, [...CL_AR, "--shed-year", "2025"]).status, 0)
    const ar = read(repo, "docs/changelog-archive.md")
    assert.match(
      ar,
      /^> Earlier years: \[2025\]\(changelog-archive-2025\.md\), \[2024\]\(changelog-archive-2024\.md\)$/m
    )
    assert.equal(ar.match(/^> Earlier years:/gm).length, 1, "one pointer line, not two")
  })

  test("a shed year still counts as archive coverage for a Tier-4 drop", () => {
    const repo = midlifeRepo()
    // Age the archive so the only cover for a dropped range is in the shed year.
    write(
      repo,
      "docs/changelog-archive.md",
      `# Changelog Archive

---

### 2026-06-07
- **June seven** — detail.

### 2025-12-20
- **Last December** — detail.
`
    )
    write(
      repo,
      "docs/changelog.md",
      MIDLIFE_CL.replace("### 2026-05-04 to 2026-05-10", "### 2025-12-18 to 2025-12-22")
    )
    const r = condense(repo, [
      ...CL_AR,
      "--shed-year", "2025",
      "--drop-ranges-before", "2026-06-14",
    ])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /Tier-4 dropped 2 week-range\(s\)/)
  })

  test("--archive defaults to the conventional path, no flag needed", () => {
    const repo = midlifeRepo()
    const r = condense(repo, ["--shed-year", "2025"])
    assert.equal(r.status, 0, r.out)
    assert.ok(existsSync(join(repo, "docs/changelog-archive-2025.md")))
  })

  test("a named archive that doesn't exist is a usage error, not a stack trace", () => {
    const repo = midlifeRepo()
    const r = condense(repo, ["--archive", "docs/nope.md", "--shed-year", "2025"])
    assert.equal(r.status, 2, r.out)
    assert.match(r.out, /not found — pass --archive/)
    assert.doesNotMatch(r.out, /ENOENT|at Object\./, r.out)
  })
})

group("condense path defaults", () => {
  const repo = midlifeRepo()

  test("--plan needs no --changelog or --archive", () => {
    const r = condense(repo, ["--plan", "--today", "2026-07-26"])
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /Tier 3 .*\(>= 2026-06-14\): 2026-07-05, 2026-07-02/)
  })

  test("the printed command stays repo-relative, not absolute", () => {
    const r = condense(repo, ["--plan", "--today", "2026-07-26"])
    assert.match(r.out, /^\s+--changelog docs\/changelog\.md \\$/m, r.out)
    assert.match(r.out, /^\s+--archive docs\/changelog-archive\.md \\$/m, r.out)
  })

  test("paths resolve from the script, not the cwd", () => {
    const r = attempt(
      "node",
      [join(repo, "scripts/condense-changelog.mjs"), "--plan", "--today", "2026-07-26"],
      join(repo, "docs")
    )
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /Tier 1 .*2026-07-26, 2026-07-25/)
  })

  test("a named changelog that doesn't exist is a usage error", () => {
    const r = condense(repo, ["--changelog", "docs/nope.md", "--plan", "--today", "2026-07-26"])
    assert.equal(r.status, 2, r.out)
    assert.match(r.out, /not found — pass --changelog/)
  })

  test("a missing conventional archive reads as 'nothing archived', not an error", () => {
    const bare = midlifeRepo()
    rmSync(join(bare, "docs/changelog-archive.md"))
    const r = condense(bare, ["--plan", "--today", "2026-07-26"])
    assert.equal(r.status, 0, r.out)
  })
})

group("fresh repo with no changelog", () => {
  const fresh = newRepo()
  install(fresh, ["--name", "Fresh Project"])

  test("changelog + archive are seeded", () => {
    const cl = read(fresh, "docs/changelog.md")
    assert.ok(cl.includes("All notable changes to Fresh Project are documented in this file."))
    assert.ok(cl.includes("---\n\n## Earlier Changes (Summary)"))
    assert.ok(cl.includes("> Full per-day details available in"))
  })

  test("commands fall back to plain node when there's no package.json", () => {
    assert.ok(
      read(fresh, ".claude/commands/changelog-condense.md").includes(
        "node scripts/collect-changelog.mjs"
      )
    )
    assert.ok(read(fresh, "docs/changelog.d/README.md").includes("collect-changelog.mjs --check"))
  })

  test("the first fold into an empty changelog lands above the sentinel", () => {
    fragment(fresh, "2026-07-26-hello-a1b2.md", "### Added\n- **First entry** — hello.\n")
    fold(fresh)
    const cl = read(fresh, "docs/changelog.md")
    assert.ok(cl.indexOf("## 2026-07-26") < cl.indexOf("## Earlier Changes (Summary)"))
    assert.ok(cl.indexOf("---") < cl.indexOf("## 2026-07-26"))
  })
})

group("installing over a changelog the installer won't touch", () => {
  /** What a pre-1.0.1 migration of a Keep a Changelog file left behind. */
  const STALE = `# Changelog

## [Unreleased]

- pending thing

---

## Earlier Changes (Summary)

> Full per-day details available in [changelog-archive.md](changelog-archive.md)
`

  test("an already-migrated file with a bad layout is reported, not silently kept", () => {
    const repo = newRepo({ "docs/changelog.md": STALE })
    const r = attempt("node", [INSTALL, repo], ROOT) // the detail goes to stderr
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /unchanged\s+docs\/changelog\.md\s+— already in the expected layout, but/, r.out)
    assert.match(r.out, /sits above the '---' that opens the Tier-1 zone/, r.out)
    assert.match(r.out, /Re-running this installer will not repair it/, r.out)
  })

  test("it is a warning, not an abort — the rest of the install still lands", () => {
    const repo = newRepo({ "docs/changelog.md": STALE })
    install(repo)
    assert.equal(read(repo, "docs/changelog.md"), STALE, "changelog left byte-identical")
    assert.ok(existsSync(join(repo, "scripts/collect-changelog.mjs")))
    assert.ok(existsSync(join(repo, "docs/changelog-archive.md")))
  })

  test("a healthy already-migrated file says nothing extra", () => {
    const repo = newRepo()
    install(repo)
    const out = install(repo)
    assert.match(out, /unchanged\s+docs\/changelog\.md\s+— already in the expected layout$/m, out)
    assert.doesNotMatch(out, /needs a look/, out)
  })
})

group("idempotency", () => {
  const repo = newRepo({ "docs/changelog.md": MESSY, "package.json": '{\n  "name": "demo-app"\n}\n' })
  install(repo)

  test("re-running install leaves an already-migrated changelog byte-identical", () => {
    const snapshot = read(repo, "docs/changelog.md")
    const out = install(repo)
    assert.equal(read(repo, "docs/changelog.md"), snapshot)
    assert.ok(out.includes("already in the expected layout"))
  })

  test("re-running install reports the scripts as unchanged", () => {
    const out = install(repo)
    assert.ok(/unchanged\s+scripts\/collect-changelog\.mjs/.test(out))
  })

  test("--no-commands skips the slash commands", () => {
    const out = install(repo, ["--no-commands"])
    assert.ok(out.includes("--no-commands"))
  })

  test("re-running install leaves package.json unchanged", () => {
    const snapshot = read(repo, "package.json")
    const out = install(repo)
    assert.equal(read(repo, "package.json"), snapshot)
    assert.ok(/unchanged\s+package\.json/.test(out))
  })
})

// ---------------------------------------------------------------------------

for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })

const skipNote = skippedGroups ? `, ${skippedGroups} group(s) skipped by filter "${filter}"` : ""
console.log(`\n${passed} passed${process.exitCode ? ", FAILURES above" : ""}${skipNote}\n`)
