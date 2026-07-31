# Changelog

Releases of the **distributor** — `install.mjs` and the payload it copies into target repos. (A repo
that *uses* this system keeps its own history in `docs/changelog.md`; this file is not that.)

Every entry states whether re-running `install.mjs` over an existing installation is safe, because
that's the only question a downstream repo actually has. Versions are semver, read as:

| Bump | Meaning | Downstream action |
|---|---|---|
| **patch** | Installer or script bugfix, docs, tests. | None — re-run whenever. |
| **minor** | New capability. Existing installs keep working untouched. | None — re-run to get it. |
| **major** | A shared structural anchor, the category vocabulary, or the fragment filename convention changed. | **Required** — an existing `changelog.md` may stop passing `--check`, or old fragments may stop folding. |

Pin a version with `npx degit soledesigngroup/changelog-fragments#v1.1.0`.

---

## [1.1.0] — 2026-07-31

The greppability release: summarization no longer destroys detail, and two fold defects that could
silently duplicate or misfile entries are fixed. **Upgrade: recommended — re-run `install.mjs`. Safe
on an existing installation**; an archive built under 1.0.x keeps working, and `--plan` detects the
one transition case (see the note at the end).

### Added

- **The condense helper archives full detail verbatim, automatically** (Check J). The moment a
  `## DATE` block leaves Tier 1, the script itself moves it byte-for-byte into
  `docs/changelog-archive.md` as a `### DATE` entry — the model writes only the summary that stays in
  `changelog.md` and never re-types (or paraphrases away) the detail. Until now the original text was
  deleted at Tier 2 and the archive received only summaries at Tier 3, so anything older than ~4 days
  was greppable only through git archaeology, and the archive's own "full per-day details" header was
  wrong. Check J refuses a run whose `--ar-content` would collide with the auto-archive, and verifies
  the move conserves every line. Same-date legacy blocks merge under one canonical heading; a legacy
  heading's parenthetical survives as an italic note line.
- **Interrupted folds are recovered, not refolded** (`scripts/collect-changelog.mjs`). The changelog
  write is atomic but fragment deletion happens after it, so a fold killed between the two left
  fragments on disk whose content was already in the file — and the next run folded them again,
  silently duplicating entries. The fold now recognizes a fragment whose every line already sits
  under its day and deletes it instead.
- **`--check` flags duplicate `### Category` sections within one day block** — the layout the two
  fold defects above used to produce, and a hand-edit smell either way.
- **A documented one-liner for searching all history**, in the README and the `CLAUDE.md` snippet:
  `grep -rn "<term>" docs/changelog.md docs/changelog.d/ docs/changelog-archive*.md`. Pending
  fragments are part of recent history and the snippet now says so.
- **Issue/PR refs in entries** — `/changelog-update` asks for `(#123)` at the end of a bullet when a
  ref exists, and `/changelog-condense` + `--plan` instruct carrying bold subjects, anchor-file
  links, and refs through every summary tier, so the condensed view stays greppable by the things
  people actually search for.

### Fixed

- **A condense run can no longer delete a migrated Keep-a-Changelog history** (Check K). The splice
  region routinely swallows the opaque legacy blocks (`## [Unreleased]`, `## [1.2.0]`) that sit at
  the bottom of the Tier-1 zone, but `--plan` never told the model to re-emit them and no check
  noticed their loss — an obedient model following the plan verbatim would have discarded the entire
  legacy history, with "All checks passed". The script now re-emits those blocks itself, `--plan`
  says so, and Check K verifies heading counts and content lines survive any splice.
- **A late fragment folding into an existing day now merges into its `### Category` sections**
  instead of appending duplicate ones out of canonical order.

### Changed

- **`--ar-content` is transition-only.** New-flow archives receive detail automatically at Tier 2, so
  nothing moves at Tier 3; `--plan` requests `--ar-content` solely for summary dates collapsing whose
  detail was never archived — i.e. changelogs condensed under the 1.0.x flow. Existing anchors,
  flags, and checks are otherwise unchanged.

### Note for existing installs

A changelog condensed under 1.0.x has `### DATE` summaries whose full detail was already discarded
(it survives only in git history). Nothing breaks: when such a date collapses into a week-range,
`--plan` asks for `--ar-content` exactly as before, and the summary is archived as the best remaining
record. Days folded after this upgrade get the verbatim treatment from their first condense on.

---

## [1.0.1] — 2026-07-28

Three adoption bugs found installing over an existing Keep a Changelog file. **Upgrade: recommended —
re-run `install.mjs`. Safe on an existing installation.** If you already installed over a
Keep-a-Changelog-style file, see the note at the end.

### Fixed

- **The header rule now goes above the first heading of any shape**, not above the first heading the
  migrator reads as a day (`lib/migrate.mjs`). `tier1Bounds()` takes the first `---` in the file as
  the top of the Tier-1 zone, and a Keep a Changelog file (`## [Unreleased]`, `## [1.2.0]`) has no
  `## YYYY-MM-DD` heading at all — so the rule was appended at EOF, some pre-existing separator
  mid-history became the boundary, and every folded entry landed *below* the whole history. `--check`
  reported "structure intact" throughout. Only the rule's insertion point moved; the legacy zone is
  still parsed exactly as before.
- **The migrator no longer emits a doubled `---`** on the same path (a file with no parseable day
  blocks got both the preamble rule and the sentinel's).
- **`condense-changelog.mjs` now reads a day heading the way the fold does** — `## YYYY-MM-DD` with
  any trailing text. Its anchored regex made a migrated `## 2026-07-03 (DocuSeal implementation plan)`
  invisible: ordered correctly by the fold, classified into no tier by `--plan`, never swept into a
  splice region, and so unable to ever age out. The `###` regexes stay anchored — relaxing those would
  make a week-range parse as a single day. `--plan` also anchors on the heading **as written**, so two
  same-date legacy headings still yield a `--cl-start` that resolves exactly once (Check A).

### Added

- **`--check` now catches a mis-anchored Tier-1 zone** — a `##` heading sitting above the `---` that
  opens the zone. That is precisely the layout the header-rule bug produced, and the old check passed
  it as "structure intact"; running `--check` will now tell a 1.0.0-migrated repo that it needs the
  one-line repair described below.
- **The installer audits a changelog it decides not to touch.** `isMigrated()` only claims the
  sentinel and footer are present, so a file migrated by 1.0.0 looks settled and is correctly left
  alone — silently, until now. The install report says the structure needs a look and prints what
  `--check` would say. It's a warning, not an abort: everything else still installs.

### Changed

- **`--changelog` and `--archive` default to `docs/changelog.md` and `docs/changelog-archive.md`**,
  resolved from the script's own parent directory like the fold already does — so `--plan` and a
  Tier-4-only run need no paths spelled out. An explicitly named path that doesn't exist is now a
  clean usage error instead of a raw `ENOENT` stack trace; a missing archive at the *conventional*
  path reads as "nothing archived yet". Nothing is waved through: Check H still reports every dropped
  range as uncovered against an empty archive, and Check I still refuses a shed with no headings.

### Note for existing installs

Re-running the installer will **not** repair a `changelog.md` that was migrated by 1.0.0 —
`isMigrated()` correctly declines to touch a file that already has the sentinel and footer, and
re-migrating one that does would mean rewriting history. It will now *tell you*, though: the install
report flags the layout and prints the problem. The repair is one line — move the `---` that follows
your title so it sits above the first `##` heading, and delete the stray one it was paired with. Then
`node scripts/collect-changelog.mjs --check` will confirm the order.

---

## [1.0.0] — 2026-07-26

First tagged release. **Upgrade: n/a.**

### Added

- **The fold** (`scripts/collect-changelog.mjs`) — batches every pending `docs/changelog.d/*.md`
  fragment into `docs/changelog.md` and deletes them. Bullet lines are copied **byte-for-byte**, so a
  folded entry reads exactly as authored and `git log -S "<bullet text>"` still resolves to the feature
  commit. Days are inserted in date order, so a fragment folded late still lands below newer entries.
- **Serialized, crash-safe folding** — an atomic `.fold.lock` (reclaimed if the holder pid is gone)
  means a second fold exits rather than racing, and `changelog.md` is written through a temp file +
  rename, so an interrupted run leaves the tree either untouched or fully folded.
- **Nothing is dropped silently** — a fragment containing an unrecognized `### heading` or text above
  the first category is reported, **left on disk**, and exits non-zero. The accepted vocabulary is the
  six Keep a Changelog categories: Added, Changed, Deprecated, Fixed, Removed, Security.
- **`--check`** — verifies pending fragments are foldable and that `changelog.md`'s structure holds
  (descending date order, no duplicate day, sentinel and footer intact). Writes nothing; suitable for
  CI or a pre-commit hook. A pending fragment is normal, not a failure.
- **The condense helper** (`scripts/condense-changelog.mjs`) — ages entries down four tiers (full
  detail → per-day → week-range → archive-only) so `changelog.md` stays a fixed rolling window. The
  model writes the summary prose; the script does the mechanical splice and runs nine structural
  checks (A–I). **It writes nothing unless every check passes**, and there is no `--force`.
- **`--plan --today <DATE>`** — classifies every heading into its tier and prints the exact anchors and
  cutoffs, so date arithmetic never happens by hand in front of a destructive splice. Read-only.
- **`--shed-year <YYYY>`** — retires the archive's oldest complete year into a static per-year file,
  verified heading-for-heading and line-for-line (Check I).
- **The installer** (`install.mjs`) — idempotent: re-run it to update scripts and slash commands in
  place. `--dry-run` reports without writing, `--name` sets the seeded header, `--no-commands` leaves
  `.claude/commands/` alone. Adds a `changelog:fold` npm script only if the target has a
  `package.json`, and prints the `CLAUDE.md` snippet rather than appending it.
- **In-place migration of an existing changelog** (`lib/migrate.mjs`) — purely additive, and verified
  lossless before anything is written: every non-blank source line must survive in order or the
  install aborts having written nothing. Legacy day headings the tooling can't parse (parentheticals,
  repeated dates) are kept byte-for-byte rather than normalized, since merging same-date sections
  would mean editing history.
- **Slash commands** — `/changelog-update` writes a fragment; `/changelog-condense` folds first, then
  ages entries down the tiers.
- **69 end-to-end smoke tests** — install into throwaway repos and drive the real scripts, so a
  template edit is covered without a separate fixture. Every condense check A–I has a failing-path
  test asserting its specific check ID.
- **MIT license and CI** — tested on Node 18, 20, 22, and 24 (Linux) plus macOS. No dependencies, no
  build step, no install step.

### Notes

- Requires **Node 18+**. The payload is dependency-free ESM on node builtins only, so it runs in a
  TypeScript repo, a Python repo, or a repo with no `package.json` at all.
- The documented workflows assume a POSIX shell (`$(date +%F)`, `/tmp`, `openssl rand`) — on Windows,
  use WSL or Git Bash.

[1.0.0]: https://github.com/soledesigngroup/changelog-fragments/releases/tag/v1.0.0
