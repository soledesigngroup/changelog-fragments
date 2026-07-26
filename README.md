# changelog-fragments

A collision-free changelog workflow for repos where **several coding agents work at once**, plus the
tooling to keep the changelog from growing without bound.

Two scripts, two slash commands, zero dependencies.

## The problem

A single `docs/changelog.md` is a filesystem race when more than one agent is running. Two sessions
both read the file, both prepend their entry, and the second write silently drops the first. It
happens quietly and you find out later.

## The fix

Nobody edits `changelog.md`. Each session writes its own uniquely-named **fragment**:

```
docs/changelog.d/2026-07-26-webhook-signature-a3f9.md
```

No two agents ever touch the same path, so the collision is structurally impossible. A separate,
serialized **fold** step batches every pending fragment into `changelog.md` and deletes them. This is
the [Changesets](https://github.com/changesets/changesets) / [Towncrier](https://towncrier.readthedocs.io/)
pattern, adapted for agent-written history.

A second step, **condense**, ages entries down through four tiers (full detail → per-day summary →
week-range → archive-only) so `changelog.md` stays a fixed rolling window instead of an ever-growing
file that every session pays to read.

## Install

```bash
gh repo clone soledesigngroup/changelog-fragments
node changelog-fragments/install.mjs /path/to/your-repo
```

Already have it cloned? `git pull` first — `install.mjs` is idempotent, so re-running it against a repo
just updates the scripts and commands in place.

> This repo is private, so the usual `npx degit soledesigngroup/changelog-fragments` one-liner won't
> resolve. Make it public if you want that to work.

Flags: `--dry-run` (report only), `--name "Project Name"` (used in the seeded header),
`--no-commands` (leave `.claude/commands/` alone).

Requires Node 18+. Nothing is installed into the target repo — the two scripts are plain `.mjs` with
only node builtins, so they run in a TypeScript repo, a Python repo, or a repo with no `package.json`
at all.

## What lands in the target repo

| Path | Purpose |
|------|---------|
| `docs/changelog.d/` + `README.md` | where fragments are written |
| `scripts/collect-changelog.mjs` | the fold — the only writer of `changelog.md`'s Tier-1 zone |
| `scripts/condense-changelog.mjs` | the splice-and-verify helper behind `/changelog-condense` |
| `.claude/commands/changelog-update.md` | `/changelog-update` — writes a fragment |
| `.claude/commands/changelog-condense.md` | `/changelog-condense` — folds, then ages entries down |
| `docs/changelog.md`, `docs/changelog-archive.md` | seeded if absent, **migrated in place** if present |
| `package.json` | gains a `changelog:fold` script (only if a `package.json` exists) |

The installer prints a `CLAUDE.md` snippet to paste — it deliberately doesn't auto-append, because
every `CLAUDE.md` is laid out differently.

## Daily workflow

```bash
# during a session — one fragment per session, stage only your own file
/changelog-update

# when the tree is quiet — serialized, single owner
npm run changelog:fold -- --dry-run
npm run changelog:fold

# periodically — folds first, then ages older entries down the tiers
/changelog-condense
```

## Adopting a repo that already has a changelog

`install.mjs` migrates an existing `docs/changelog.md` into the layout the tooling needs. The
migration is **purely additive** — it inserts a header rule, a `---` between day blocks, the
`## Earlier Changes (Summary)` sentinel, and the archive footer, and it **rewrites no entry text**.

Legacy day headings are preserved byte-for-byte, including shapes the tooling doesn't parse
(`## 2026-07-03 (some parenthetical)`) and repeated dates. Those headings are simply invisible to the
fold and condense regexes; they age out naturally as condensing rewrites them. Normalizing them would
mean merging same-date sections — editing history — which this deliberately doesn't do.

Every migration is verified lossless before anything is written: each non-blank line of the original
must appear in the output, in order, or the install aborts having written nothing. Re-running the
installer never re-migrates a file that's already in the expected layout.

## Design notes

**The fold is byte-preserving.** Bullet lines are copied verbatim, never reformatted. That makes the
fold a pure *move*: a folded entry reads exactly as authored, and `git log -S "<bullet text>"` still
finds the feature commit that introduced it rather than the mechanical fold commit.

**The condense helper does the mechanics, the model does the judgment.** The model writes the summary
prose to temp files; the script performs the splice and runs eight structural checks (anchors
unambiguous and ordered, no duplicate headings, nothing collapsed without being archived, the 0–3 day
window untouched, no per-day heading covered by a week-range, separator and footer preserved, Tier-4
drops only fully-archived week-ranges). **It writes nothing unless every check passes.**

**Dates are compared as ISO strings.** `YYYY-MM-DD` sorts lexicographically, so there is no timezone
handling anywhere and no way for a local-midnight bug to move an entry to the wrong day.

## Updating an installed repo

Re-run `install.mjs` against it. Scripts, commands, and the fragment README are overwritten; your
changelog files are never touched once migrated. `--dry-run` first if you want to see the diff
surface, and `--no-commands` if that repo has customized the slash commands.

## Tests

```bash
npm test
```

Installs into throwaway repos and exercises the real scripts: messy-changelog migration, the
losslessness guarantee, fold ordering and same-date merging, byte-verbatim bullets, malformed
fragment names, the condense checks, the no-`package.json` fallback, and install idempotency.

## What's intentionally not here

The system this was extracted from also synced folded bullets into a Postgres table with commit
attribution, to power an in-app "What's New" page. That half is application-specific and stays out —
the byte-verbatim fold is what makes it reconstructable later via `git log -S` if a repo ever wants it.
