# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **distributor**, not an application. The changelog system defined here doesn't run against this
repo — `install.mjs` copies it into *other* repos. Two layers:

| Layer | Files | Ships to target repo? |
|---|---|---|
| Installer | `install.mjs`, `lib/migrate.mjs` | No — runs from here |
| Payload | everything under `template/` | Yes — verbatim or substituted |

So a change to `template/scripts/collect-changelog.mjs` is a change to a file that will live in
someone else's repo with no `node_modules`, no build step, and possibly no `package.json`. That
constrains everything below.

The system itself: agents each write a uniquely-named **fragment** to `docs/changelog.d/` instead of
editing one shared `changelog.md` (a filesystem race when sessions run concurrently); a serialized
**fold** batches fragments in; a **condense** step ages entries down four tiers so the file stays a
fixed rolling window. README.md covers the rationale in full.

## Commands

```bash
npm test                                  # the only check — no lint, no build, no deps
node install.mjs /path/to/repo --dry-run  # exercise the installer by hand
node install.mjs /path/to/repo --name "X" [--no-commands]
```

In an installed repo, the payload's own entry points:

```bash
node scripts/collect-changelog.mjs [--dry-run|--check]
node scripts/condense-changelog.mjs --changelog … --archive … --plan --today $(date +%F)
```

```bash
npm test -- <substring>                   # run only groups whose name matches
```

`test/smoke.mjs` is organized into `group()`s that each build their own temp repos. Tests **within** a
group are ordered and stateful on purpose (a fold test wants the file the previous fold produced), but
nothing crosses a group boundary — so a group runs correctly on its own, and new cases belong in the
group whose fixture they need rather than at the end of the file.

Tests install into throwaway `mkdtemp` dirs and shell out to the real scripts, so a template edit is
covered end-to-end without a separate fixture to update. Failing paths matter as much as happy ones:
every condense check (A–I) has a test that makes it fire, and `assertCheckFails` asserts the specific
check ID, because a bare "it exited non-zero" also passes when the script has a syntax error.

## Invariants

These are load-bearing. Each is enforced by code and by a test; breaking one silently corrupts a
downstream repo's history.

**Fragment bullets are byte-verbatim.** `extractFragmentBlocks` / `mergeFragmentsIntoChangelog`
(`template/scripts/collect-changelog.mjs`) copy bullet lines exactly and only drop surrounding blanks
and stray `---`. This makes the fold a pure *move*, so `git log -S "<bullet text>"` still resolves to
the feature commit rather than the mechanical fold commit. Never add reformatting, wrapping, or link
rewriting there.

**The fold never discards a line it can't place.** Anything other than blanks, a stray `---`, or a
stray `## DATE` header outside a canonical `### Category` block makes `extractFragmentBlocks` throw
`FragmentError`; the CLI then reports the fragment, **leaves it on disk**, and exits non-zero. The six
canonical categories (`CATEGORY_ORDER`) are the whole accepted vocabulary — an unknown `### heading`
used to get swallowed into the block above it, which silently misfiled or destroyed entries. If you
add a category, add it there and to all four docs that list them.

**Only one fold runs at a time, and it writes atomically.** The fold takes `docs/changelog.d/.fold.lock`
via `wx` (atomic create-or-fail, reclaimed if the holder pid is gone) and writes `changelog.md` through
a temp file + `renameSync`. Fragment deletion uses `force: true` so an interrupted run is re-runnable
instead of an ENOENT crash. Serializing the fold by convention was the last live instance of the race
the whole system exists to remove.

**The direct-invocation guard compares filesystem paths, never URL strings.** `invokedDirectly()` tests
`resolve(process.argv[1])`/`realpathSync(...)` against `fileURLToPath(import.meta.url)`. The obvious
`import.meta.url === \`file://${process.argv[1]}\`` is **wrong**: `import.meta.url` is percent-encoded
and symlink-resolved, so any repo path with a space in it (`~/My Drive/...`) or behind a symlink
(`/tmp`, `/var`, container mounts) made the fold exit 0 having done nothing, with no output at all.

**Payload scripts resolve their own paths.** `collect-changelog.mjs` derives the repo root from its own
location (`<script dir>/..`), not `process.cwd()`, so a git hook or a subdirectory invocation behaves
identically. A missing `docs/changelog.d/` is an error, not a silent success.

**Migration is additive and verified lossless.** `lib/migrate.mjs` inserts only structural lines
(header rule, day separators, the summary sentinel, the archive footer) and `assertLossless` requires
every non-blank source line to survive in order — otherwise `MigrationError` aborts the install with
nothing written. Legacy day headings the tooling can't parse (`## 2026-07-03 (parenthetical)`,
repeated dates) are kept byte-for-byte on purpose: normalizing them would mean merging same-date
sections, i.e. editing history.

**The condense helper writes nothing unless checks A–I pass.** `template/scripts/condense-changelog.mjs`
does the mechanical splice; the *model* supplies the summary prose via temp files. Verification isn't
skippable and has no `--force`. If you add an operation, add its check. `--plan` is the read-only
counterpart: it computes the tier boundaries and anchors so the model never has to, and it must stay
side-effect-free.

**Dates are ISO strings, compared lexicographically.** No `Date` object, no timezone handling, no
arithmetic — with exactly one carve-out: `shiftDays()` in `condense-changelog.mjs`, which `--plan` uses
to turn `--today` into the tier cutoffs. It's safe on the invariant's own terms — the date arrives
explicitly via `--today` (the clock is never read) and the math is `Date.UTC` + whole days, so there's
no local midnight to land on the wrong side of. Don't grow a second one; entry comparison stays string
comparison.

**Payload scripts are dependency-free ESM on node builtins only** (Node 18+), and stay importable:
`collect-changelog.mjs` exports its fold helpers (`extractFragmentBlocks`,
`mergeFragmentsIntoChangelog`, `auditChangelog`, `fragmentDateFromFilename`, `FragmentError`) and
guards the CLI as described above.

**The installer is idempotent.** Re-running it updates scripts and commands in place. `isMigrated()`
gates re-migration; `writeOut()` reports `unchanged` when content matches byte-for-byte.

## Shared structural anchors

These literal strings are the contract between the migrator, the fold, the condense checks, and the
seeded markdown. Changing one means changing it in **all** of them plus the templates:

- `---` — the first one in the file is the top of the Tier-1 zone (`tier1Bounds`), and one separates
  each day block (Check F depends on it sitting before a spliced heading).
- `## Earlier Changes (Summary)` — bounds the bottom of Tier-1 and receives condensed entries.
- `> Full per-day details available in` — the archive footer pointer (Check G, and the Tier-4 drop
  region's end anchor).
- `> Earlier years:` — the per-year archive pointer `--shed-year` writes and refreshes in place. It's
  the one line the shed's losslessness check is allowed to supersede.
- Heading shapes: `## YYYY-MM-DD` (Tier 1 full detail), `### YYYY-MM-DD` (Tier 2 / archive per-day),
  `### YYYY-MM-DD to YYYY-MM-DD` (Tier 3 week-range). Anything else is invisible to the regexes.

## Template substitution

`install.mjs` replaces `{{FOLD_CMD}}`, `{{FOLD_CMD_DRY}}`, `{{FOLD_CMD_DRY_INLINE}}`,
`{{FOLD_CMD_CHECK}}`, and `{{PROJECT_NAME}}` when copying — but the two `.mjs` payload scripts are
copied with `raw: true`,
so a placeholder written into them ships through literally. The `{{FOLD_CMD}}` pair resolves to
`npm run changelog:fold` or bare `node scripts/collect-changelog.mjs` depending on whether the target
has a `package.json`; both branches are covered by tests.

The installer deliberately **prints** the `CLAUDE.md` snippet rather than appending it — every
target's `CLAUDE.md` is laid out differently.

## Ownership of the changelog files

Nothing else may write these; a hand-edit is a bug, not a shortcut:

- `docs/changelog.d/*.md` — written by agents (one fragment per session), deleted by the fold.
- Tier-1 zone of `docs/changelog.md` — written **only** by `collect-changelog.mjs`.
- Tier-2/3/4 zones + `docs/changelog-archive.md` — written **only** by `condense-changelog.mjs`.
- `docs/changelog-archive-<YEAR>.md` — written once by `--shed-year`, static thereafter.

`collect-changelog.mjs --check` is what makes this ownership more than a docstring: it fails on a
Tier-1 zone that isn't in descending date order, a duplicated `## DATE`, a missing sentinel or footer,
or a pending fragment the fold would refuse. Wire it into CI or a pre-commit hook in target repos.
Repeated *legacy* day headings are exempt — the migrator preserves those deliberately.
