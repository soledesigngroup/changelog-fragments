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

Pin a version with `npx degit soledesigngroup/changelog-fragments#v1.0.0`.

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
