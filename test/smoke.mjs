#!/usr/bin/env node
/**
 * End-to-end smoke test: install into throwaway repos, then exercise the real
 * fold + condense scripts against the installed files.
 *
 * Covers the two cases a real adoption hits — a repo with a messy pre-existing
 * changelog (parenthetical day headings, duplicate dates, no separators, no
 * summary section) and a repo with no changelog at all — plus same-date fragment
 * merging and install idempotency.
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

let passed = 0
const cleanup = []

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

/** Like run(), but returns stdout + stderr together (warnings go to stderr). */
const runBoth = (cmd, cmdArgs, cwd) => {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8" })
  return (r.stdout ?? "") + (r.stderr ?? "")
}

const install = (dir, extra = []) => run("node", [INSTALL, dir, ...extra], ROOT)
const fold = (dir, extra = []) => run("node", ["scripts/collect-changelog.mjs", ...extra], dir)
const read = (dir, rel) => readFileSync(join(dir, rel), "utf8")

const fragment = (dir, name, body) => {
  writeFileSync(join(dir, "docs/changelog.d", name), body)
}

const contentLines = (s) => s.split("\n").filter((l) => l.trim() !== "")

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

console.log("\nmigrating an existing messy changelog")

const messy = newRepo({ "docs/changelog.md": MESSY, "package.json": '{\n  "name": "demo-app"\n}\n' })
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
  assert.ok(read(messy, ".claude/commands/changelog-condense.md").includes("npm run changelog:fold"))
  assert.ok(!read(messy, ".claude/commands/changelog-update.md").includes("{{"))
})

console.log("\nfolding fragments")

fragment(
  messy,
  "2026-07-26-first-a1b2.md",
  "### Fixed\n- **Fix one** — details.\n\n### Added\n- **Add one** — details.\n"
)

test("dry run writes nothing", () => {
  const snapshot = read(messy, "docs/changelog.md")
  fold(messy, ["--dry-run"])
  assert.equal(read(messy, "docs/changelog.md"), snapshot)
  assert.ok(existsSync(join(messy, "docs/changelog.d/2026-07-26-first-a1b2.md")))
})

test("new day lands on top, categories in canonical order, fragment deleted", () => {
  fold(messy)
  const cl = read(messy, "docs/changelog.md")
  const lines = cl.split("\n")
  const firstDay = lines.findIndex((l) => l.startsWith("## 2026-"))
  assert.equal(lines[firstDay], "## 2026-07-26")
  assert.ok(cl.indexOf("### Added") < cl.indexOf("### Fixed"))
  assert.ok(!existsSync(join(messy, "docs/changelog.d/2026-07-26-first-a1b2.md")))
})

test("a second fragment on the same date merges into the existing day", () => {
  fragment(messy, "2026-07-26-second-c3d4.md", "### Fixed\n- **Fix two** — details.\n")
  fold(messy)
  const cl = read(messy, "docs/changelog.md")
  assert.equal(cl.split("\n").filter((l) => l === "## 2026-07-26").length, 1)
  assert.ok(cl.includes("- **Fix one** — details."))
  assert.ok(cl.includes("- **Fix two** — details."))
})

test("bullet text is copied byte-for-byte", () => {
  const weird = "- **Odd — text** with `code`, [a link](../src/x.ts), and 2 spaces:  end."
  fragment(messy, "2026-07-27-verbatim-e5f6.md", `### Changed\n${weird}\n`)
  fold(messy)
  assert.ok(read(messy, "docs/changelog.md").includes(weird))
})

test("a malformed fragment name is skipped, not folded", () => {
  fragment(messy, "no-date-prefix.md", "### Fixed\n- **Nope** — should not fold.\n")
  const out = runBoth("node", ["scripts/collect-changelog.mjs"], messy)
  assert.ok(out.includes("filename must start with YYYY-MM-DD-"))
  assert.ok(existsSync(join(messy, "docs/changelog.d/no-date-prefix.md")))
  assert.ok(!read(messy, "docs/changelog.md").includes("should not fold"))
  rmSync(join(messy, "docs/changelog.d/no-date-prefix.md"))
})

console.log("\ncondense helper")

test("Tier-4 dry run passes every structural check on a freshly installed file", () => {
  const out = run(
    "node",
    [
      "scripts/condense-changelog.mjs",
      "--changelog",
      "docs/changelog.md",
      "--archive",
      "docs/changelog-archive.md",
      "--drop-ranges-before",
      "2026-01-01",
      "--dry-run",
    ],
    messy
  )
  assert.ok(out.includes("All checks passed."))
  assert.ok(out.includes("Dry run - nothing written."))
})

test("condense refuses a splice whose anchors are ambiguous", () => {
  writeFileSync(join(messy, "cl-mid.md"), "## Earlier Changes (Summary)\n")
  assert.throws(
    () =>
      run(
        "node",
        [
          "scripts/condense-changelog.mjs",
          "--changelog",
          "docs/changelog.md",
          "--cl-start",
          "### Added",
          "--cl-end",
          "> Full per-day details available in",
          "--cl-mid",
          "cl-mid.md",
        ],
        messy
      ),
    /./
  )
  rmSync(join(messy, "cl-mid.md"))
})

console.log("\nfresh repo with no changelog")

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
})

test("the first fold into an empty changelog lands above the sentinel", () => {
  fragment(fresh, "2026-07-26-hello-a1b2.md", "### Added\n- **First entry** — hello.\n")
  fold(fresh)
  const cl = read(fresh, "docs/changelog.md")
  assert.ok(cl.indexOf("## 2026-07-26") < cl.indexOf("## Earlier Changes (Summary)"))
  assert.ok(cl.indexOf("---") < cl.indexOf("## 2026-07-26"))
})

console.log("\nidempotency")

test("re-running install leaves an already-migrated changelog byte-identical", () => {
  const snapshot = read(messy, "docs/changelog.md")
  const out = install(messy)
  assert.equal(read(messy, "docs/changelog.md"), snapshot)
  assert.ok(out.includes("already in the expected layout"))
})

test("re-running install reports the scripts as unchanged", () => {
  const out = install(messy)
  assert.ok(/unchanged\s+scripts\/collect-changelog\.mjs/.test(out))
})

test("--no-commands skips the slash commands", () => {
  const out = install(messy, ["--no-commands"])
  assert.ok(out.includes("--no-commands"))
})

// ---------------------------------------------------------------------------

for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} passed${process.exitCode ? ", FAILURES above" : ""}\n`)
