#!/usr/bin/env node
/**
 * Install (or update) the fragment-based changelog system in a target repo.
 *
 * Idempotent by design — re-run it to pull newer versions of the scripts and
 * slash commands. It only ever *seeds* `docs/changelog.md` / `changelog-archive.md`
 * when they're missing; an existing changelog is migrated in place (additively,
 * verified lossless) and never re-migrated.
 *
 * Usage:
 *   node install.mjs <target-repo> [--dry-run] [--name "Project Name"] [--no-commands]
 *
 *   --dry-run      report what would change, write nothing
 *   --name         project name used in the seeded changelog header
 *   --no-commands  don't touch .claude/commands/ (for repos that customized them)
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs"
import { dirname, join, resolve, basename } from "node:path"
import { fileURLToPath } from "node:url"

import { migrateChangelog, isMigrated, MigrationError } from "./lib/migrate.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(HERE, "template")

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dryRun: false, noCommands: false, target: null, name: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--dry-run") args.dryRun = true
    else if (a === "--no-commands") args.noCommands = true
    else if (a === "--name") {
      const v = argv[++i]
      if (v === undefined || v.startsWith("--")) die("--name needs a value")
      args.name = v
    } else if (a === "-h" || a === "--help") args.help = true
    else if (a.startsWith("--")) die(`unknown argument ${a}`)
    else if (args.target === null) args.target = a
    else die(`unexpected argument ${a}`)
  }
  return args
}

function die(msg) {
  console.error(`install: ${msg}`)
  process.exit(1)
}

/**
 * "tamarack-room" → "Tamarack Room". Short vowel-less words are treated as
 * acronyms ("sdg" → "SDG", "mcp" → "MCP") since that's what they almost always
 * are in a repo slug; anything pronounceable is just capitalized ("app" → "App").
 * It's a guess either way — `--name` overrides it.
 */
function titleize(slug) {
  const acronym = (w) => w.length <= 4 && !/[aeiou]/.test(w)
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (acronym(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2))

if (args.help || !args.target) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, ""))
  process.exit(args.help ? 0 : 1)
}

const target = resolve(args.target)
if (!existsSync(target) || !statSync(target).isDirectory()) die(`${target} is not a directory`)
if (!existsSync(join(target, ".git"))) {
  console.warn(`! ${target} is not a git repo — the changelog migration has no undo. Ctrl-C now if that's wrong.\n`)
}

// --- Substitutions ---------------------------------------------------------

const pkgPath = join(target, "package.json")
const hasPkg = existsSync(pkgPath)
const pkgRaw = hasPkg ? readFileSync(pkgPath, "utf8") : null
let pkg = null
if (hasPkg) {
  try {
    pkg = JSON.parse(pkgRaw)
  } catch (err) {
    // A stray comment or trailing comma in someone else's package.json shouldn't
    // surface as a raw stack trace from a tool they just pointed at their repo.
    die(`${pkgPath} is not valid JSON — ${err.message}`)
  }
}

/**
 * Whatever the target already indents package.json with — reserialize with the
 * same thing, so adding one script isn't a whole-file reformat in their diff.
 */
const pkgIndent = pkgRaw?.match(/^\{[\r\n]+([ \t]+)/)?.[1] ?? 2

const FOLD_CMD = hasPkg ? "npm run changelog:fold" : "node scripts/collect-changelog.mjs"
const FOLD_CMD_DRY = hasPkg
  ? "npm run changelog:fold -- --dry-run"
  : "node scripts/collect-changelog.mjs --dry-run"
const FOLD_CMD_CHECK = hasPkg
  ? "npm run changelog:fold -- --check"
  : "node scripts/collect-changelog.mjs --check"

const projectName = args.name || titleize(pkg?.name || basename(target))

const SUBS = {
  "{{FOLD_CMD}}": FOLD_CMD,
  "{{FOLD_CMD_DRY}}": FOLD_CMD_DRY,
  "{{FOLD_CMD_DRY_INLINE}}": "`" + FOLD_CMD_DRY + "`",
  "{{FOLD_CMD_CHECK}}": FOLD_CMD_CHECK,
  "{{PROJECT_NAME}}": projectName,
}

function substitute(text) {
  let out = text
  for (const [k, v] of Object.entries(SUBS)) out = out.split(k).join(v)
  return out
}

// --- Actions ---------------------------------------------------------------

const actions = []
const record = (verb, path, note) => actions.push({ verb, path, note })

function writeOut(relPath, content, { mode } = {}) {
  const abs = join(target, relPath)
  const existed = existsSync(abs)
  if (existed && readFileSync(abs, "utf8") === content) {
    record("unchanged", relPath)
    return
  }
  if (!args.dryRun) {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    if (mode) chmodSync(abs, mode)
  }
  record(existed ? "updated" : "created", relPath)
}

function copyTemplate(relFrom, relTo, { raw = false, mode } = {}) {
  const src = readFileSync(join(TEMPLATE, relFrom), "utf8")
  writeOut(relTo, raw ? src : substitute(src), { mode })
}

// 1. Scripts (self-contained, no deps, no build step)
copyTemplate("scripts/collect-changelog.mjs", "scripts/collect-changelog.mjs", { raw: true, mode: 0o755 })
copyTemplate("scripts/condense-changelog.mjs", "scripts/condense-changelog.mjs", { raw: true, mode: 0o755 })

// 2. Slash commands
if (!args.noCommands) {
  copyTemplate(".claude/commands/changelog-update.md", ".claude/commands/changelog-update.md")
  copyTemplate(".claude/commands/changelog-condense.md", ".claude/commands/changelog-condense.md")
} else {
  record("skipped", ".claude/commands/ (--no-commands)")
}

// 3. Fragment directory + its README
copyTemplate("docs/changelog.d/README.md", "docs/changelog.d/README.md")

// 4. changelog.md — seed if absent, migrate in place if present
const clPath = join(target, "docs/changelog.md")
if (!existsSync(clPath)) {
  copyTemplate("docs/changelog.md", "docs/changelog.md")
} else {
  const before = readFileSync(clPath, "utf8")
  if (isMigrated(before)) {
    record("unchanged", "docs/changelog.md", "already in the expected layout")
  } else {
    let migrated
    try {
      migrated = migrateChangelog(before, { projectName })
    } catch (err) {
      if (err instanceof MigrationError) {
        console.error(`\nABORT — docs/changelog.md could not be migrated safely:\n  ${err.message}`)
        console.error("Nothing was written. Fix the file by hand or migrate it manually.\n")
        process.exit(1)
      }
      throw err
    }
    if (!args.dryRun) writeFileSync(clPath, migrated.text)
    record(
      "migrated",
      "docs/changelog.md",
      `${migrated.stats.dayBlocks} day blocks kept verbatim; added ${migrated.stats.added.join(", ")}`
    )
  }
}

// 5. changelog-archive.md — seed if absent or empty
const arPath = join(target, "docs/changelog-archive.md")
if (!existsSync(arPath) || readFileSync(arPath, "utf8").trim() === "") {
  copyTemplate("docs/changelog-archive.md", "docs/changelog-archive.md")
} else {
  record("unchanged", "docs/changelog-archive.md", "already has content")
}

// 6. npm script
if (hasPkg) {
  pkg.scripts ??= {}
  if (pkg.scripts["changelog:fold"] !== "node scripts/collect-changelog.mjs") {
    pkg.scripts["changelog:fold"] = "node scripts/collect-changelog.mjs"
    if (!args.dryRun) writeFileSync(pkgPath, JSON.stringify(pkg, null, pkgIndent) + "\n")
    record("updated", "package.json", 'added "changelog:fold" script')
  } else {
    record("unchanged", "package.json")
  }
}

// --- Report ----------------------------------------------------------------

const width = Math.max(...actions.map((a) => a.verb.length))
console.log(`\nchangelog-fragments → ${target}${args.dryRun ? "  (dry run — nothing written)" : ""}\n`)
for (const a of actions) {
  console.log(`  ${a.verb.padEnd(width)}  ${a.path}${a.note ? `  — ${a.note}` : ""}`)
}

const snippet = substitute(readFileSync(join(TEMPLATE, "claude-md-snippet.md"), "utf8"))
const claudeMd = join(target, "CLAUDE.md")
const alreadyDocumented =
  existsSync(claudeMd) && readFileSync(claudeMd, "utf8").includes("docs/changelog.d/")

console.log("\nNext steps:")
if (alreadyDocumented) {
  console.log("  1. CLAUDE.md already mentions docs/changelog.d/ — check it matches the snippet below.")
} else {
  console.log("  1. Paste this into CLAUDE.md (replacing any existing Changelog section):\n")
  console.log(snippet.replace(/^/gm, "     "))
}
console.log(
  `  2. Point any commit/audit workflow docs at fragments instead of changelog.md\n` +
    `     (e.g. a /git-commit-push command that says "read docs/changelog.md").`
)
console.log(`  3. Verify: write a fragment, then run \`${FOLD_CMD_DRY}\`.\n`)
