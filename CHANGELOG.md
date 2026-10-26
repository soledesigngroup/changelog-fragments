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

Pin a version with `npx degit soledesigngroup/changelog-fragments#v1.6.0`.

---

## [1.6.0] — 2026-10-25

**Upgrade: recommended — re-run `install.mjs`. Safe on an existing installation**; no shared anchor,
category, or filename convention changed. One behavior change: a condense that Check J used to refuse
— a full-detail day leaving Tier 1 whose day the archive already holds — now succeeds by merging.
Check J still refuses a day this run's own `--ar-content` writes.

### Added

- **A late fragment merges into the day it belongs to.** A fragment written on 2026-09-22 and
  committed on 2026-10-14 (after a condense had archived 09-22) folded fine, then stopped every later
  condense: Check J called the block a collision with the existing archive entry, and nothing else may
  move Tier-1 detail, so it was stranded. The block now merges into that entry by the fold's own
  same-day rule (bullets join their `### Category` section, a missing category goes in canonical
  position), and its summary follows — an existing `### DATE` gains the new lines, and a week-range
  that already names the day extends that day's line instead of adding a second. `--plan` names late
  days and says what the manual flow must carry over.

### Fixed

- **The run after an interrupted write finishes the move.** A crash between the archive write and the
  changelog write leaves the day's detail in both files; the next run used to abort on Check J. It now
  recognizes the archived units, adds nothing twice, and lets the block leave the changelog.
- **Anchors match where they begin a line.** Check A counted `--cl-start '## 2026-07-20'` twice when
  the summary held `### 2026-07-20` — a substring of it, and exactly the pair a late day produces.

### Changed

- **`condense-changelog.mjs` imports from `collect-changelog.mjs`** (`extractFragmentBlocks`,
  `FragmentError`, `mergeIntoExistingDay`, the last newly exported). The installer always ships the two
  side by side; a copied-alone condense script now needs its sibling.

---

## [1.5.0] — 2026-08-13

**Upgrade: recommended — re-run `install.mjs`. Safe on an existing installation**; no shared anchor,
category, or filename convention changed, and the shape the fold *writes* is untouched.

Two behavior changes to know about, both of the same kind as v1.4.1's: nothing that was safe becomes
unsafe, but things that looked fine stop claiming to be.

- **`--check` can newly fail** on a changelog whose day headings are `## [YYYY-MM-DD]`. Those blocks
  were invisible to its ordering and duplicate-category rules; now they are audited like any other
  day. A file that starts failing was already broken — it just had no way to say so. Re-run
  `--check` before wiring this version into CI. (No repo we scanned has such a heading.)
- **`--plan` and `--auto` can exit non-zero** where they exited 0, when the file holds day headings
  they can't parse and nothing they can read has aged out. That exit is the fix; see below.

### Added

- **`--plan` and `--auto` refuse to report a false all-clear.** A heading no regex parses lands in no
  tier, so it feeds no cutoff — which meant a changelog whose every day was written in an unreadable
  shape classified cleanly into *nothing* and drew `Nothing has aged out yet — no condense run needed
  today`, exit 0, while months overdue. `--check` called the structure intact beside it.

  That green light is worse than an error. An agent told there is no work, looking at entries that
  plainly need it, edits the file by hand — and the archive is populated by the script, so detail
  rewritten in an editor is detail gone. It is how one repo lost roughly 17,500 words.

  `planTiers` now counts what it couldn't classify: `stuck` (a `##` block whose heading *leads* with
  an ISO date in a wrapper the parser doesn't read) apart from `legacyOpaque` (everything else). Both
  modes name every such block, print the heading shape they need, and **exit 1** rather than answer a
  question they never parsed the file to answer. A run that has real work *and* unreadable blocks does
  the work and says loudly that it was partial — gating there would only punish the half-fixable repo.

  Leading is the whole test, so the legacy zone stays quiet: `## [Unreleased]` and
  `## [1.2.0] - 2026-03-29` are opaque by design, and a warning that fires on every migrated
  Keep-a-Changelog repo forever is a warning nobody reads.

### Fixed

- **`## [YYYY-MM-DD]` is a day.** A pre-1.0.1 migrator borrowed Keep a Changelog's bracket convention
  for the *date* rather than the version and wrote whole histories that way. Those blocks sat outside
  every tier and could never age out. `H2_DAY_SRC` and the fold's `DAY_DATE_RE` now accept the form —
  together, as they must. `## [1.2.0] - 2026-03-29` stays opaque: what follows `[` has to *be* the
  date, so the brackets are not the signal.

  Brackets only, deliberately. `## (2026-07-26)` and `## **2026-07-26**` stay unreadable and get
  *reported* by the refusal above. Teaching the parser every delimiter someone might type is how a
  parser starts inventing days; brackets earned their place by being a real migrator's output across
  whole histories, not by being imaginable.

  Three silent failures rode on that shape: `--check` skipped those blocks in its ordering and
  duplicate-category rules; the fold's insert scan stops at the first heading it can't date, so a late
  fragment landed *above* history newer than it, with the ordering check equally blind to the result;
  and `--report` counted the blocks but not their dates, so its git coverage check reported a day with
  a full detail block in the file as **undocumented**. That section is the only place under-capture is
  visible at all, which makes a false positive there the expensive kind.

- **One day-heading shape, spelled once.** `## 2026-07-20(retro)` — trailing text with no space before
  it — was a day to the fold and to `dayBlocksIn`, an opaque legacy block to `legacyBlocksIn` and
  `parseRegionBlocks`, and nothing at all to `reH2Day`. So the "did it survive the splice?" test looked
  for a date the new file could never report, and **every check passed on a run that archived the day's
  detail verbatim *and* re-emitted the block into the changelog**: the same text in both files,
  permanently, because a Tier-1 block nothing can classify never moves again.

  All five readers now go through `H2_DAY_SRC`. A digit may no longer follow the date, so
  `## 2026-07-263` is opaque to both scripts rather than 2026-07-26 to one of them.

- **A Tier-3 week holding one day is written as that day.** `--auto` emitted `### D to D`, valid to
  every regex and wrong to every reader: it claims a span that doesn't exist, and `--report` filed it
  under "summary ranges", so a Tier 3 made entirely of single days reported zero summary days. The
  entry carries Tier-3 content (subject and issue refs, links left to the archive), so a later run
  reads it straight back out when the week gains a day and becomes a real range. Only when no existing
  range is being extended — merging has to keep the range shape, or the old heading survives beside the
  new day and Check E refuses the run. Existing `### D to D` entries are left alone to age out on their
  own; re-sorting a file this system didn't scramble is editing history.

---

## [1.4.1] — 2026-08-13

**Upgrade: recommended — re-run `install.mjs`. Safe on an existing installation**; no shared anchor,
category, or filename convention changed. One behavior change to know about: a `--drop-ranges-before`
run that passed before can now **refuse**, and that refusal is the fix — it means the drop was about
to destroy the last copy of a day. Nothing that was safe becomes unsafe; some things that looked safe
stop claiming to be.

### Fixed

- **Check H now verifies Tier-4 coverage day by day, not span by span.** A `--auto` week-range names
  the days it summarizes (`- YYYY-MM-DD — …`); the check now requires **each** of those days to have
  its own archive entry before the range paragraph is deleted. The old test asked only whether the
  range's span overlapped *some* archive heading, so a range whose days were only **partly** archived
  was waved through and the drop took the unarchived days' last trace with it.

  That partial shape is not hypothetical — it is precisely what a repo upgrading from **pre-1.1**
  looks like. Days condensed under the old flow (which discarded detail rather than archiving it
  verbatim) have no archive entry; days condensed since have one; a single calendar week can hold
  both. The overlap found the archived day and reported the whole week covered.

  A hand-written range names no days, so there is nothing to enumerate and the span test still
  applies — but the run now **prints** which ranges rode on it rather than letting a weakened test
  pass unsaid.

- **`--report` no longer counts a nested sub-bullet as its own entry.** `countBullets` matched any
  line whose *trimmed* text began `- `, so an indented sub-item — detail belonging to the bullet
  above it — was tallied as a separate entry. Every other reader of these files (the fold's
  `extractFragmentBlocks`, condense's `bulletsOf`) treats a bullet as starting at column 0, and now
  the report does too. The skew was confined to the dashboard, but it was large and one-sided: an
  installed repo that nests lists reported **133** Tier-1 bullets against 81 real entries, while the
  pending-fragment counts printed directly above stayed correct, because fragments rarely nest.

- **Check N is listed in the script's own verification docblock**, and the README's check count is
  corrected from thirteen to fourteen. `N` shipped in v1.3.1 but was never added to either list.

**Upgrade: recommended — re-run `install.mjs`. Safe on an existing installation**; no shared anchor,
category, or filename convention changed, and every existing flag behaves identically. This is the
release that makes "which version is installed?" answerable from inside a target repo, so the answer
only exists going forward — a repo installed before this says nothing until it is re-installed.

### Added

- **An installed repo now names its version.** `docs/changelog.d/README.md` ends with a
  `## Which version is installed` section filled from a new `{{VERSION}}` substitution, and the
  installer prints the same number in its header line (`changelog-fragments v1.4.0 → /path/to/repo`).
  The only provenance a target repo carried before was an unversioned "Managed by changelog-fragments"
  comment at the top of each script, so telling a 1.2.0 install from a 1.3.1 one meant diffing the
  scripts against a tag.
- **The stamp lives in the fragment README on purpose.** That is the one seeded doc the installer
  rewrites on *every* run, so the version it names is the version of the scripts sitting beside it.
  `changelog.md` and `changelog-archive.md` are written only when absent — a stamp there would freeze
  at whatever seeded the repo and start lying at the first upgrade, and a repo whose changelog was
  *migrated* rather than seeded would never carry one at all. The payload scripts can't hold it
  either: they are copied `raw: true`, which is exactly what lets them ship placeholders literally.
  So there is no `--version` flag and `--report` prints no version — the number is a doc, not an API.

### Fixed

- **A writing condense now takes the fold's lock.** It is a read–modify–write of the same file the
  fold writes, but it never held `.fold.lock` — fold-vs-condense was serialized by convention, the
  exact race this whole system exists to remove. The lock is now held for the entire read→write span
  (longer than the fold's, since a fold landing inside it would be silently overwritten), a dead
  holder's lock is reclaimed, and it is released on every exit path. `--plan` and `--dry-run` stay
  lock-free, like `--report`.
- **A crashed condense can no longer destroy the detail it was moving.** Its writes land via temp
  file + rename, **receiving file first** — year file, then archive, then changelog. Detail flows
  changelog→archive→year file, so a crash between writes now leaves the moved text in two files
  (Check J flags the duplicate loudly on the next run) instead of removed from one and not yet
  written to the other. Previously the changelog was written first, so a crash before the archive
  write silently destroyed the detail in flight.
- **This file had lost its `## [1.2.0]` heading.** The 1.3.0 release commit replaced that heading
  rather than inserting above it, so every 1.2.0 entry had been rendering as part of 1.3.0 since
  2026-08-09. Restored with its original date; no entry text changed.

---

## [1.3.1] — 2026-08-09

**Upgrade: recommended — re-run `install.mjs`. Safe on an existing installation**; no anchor,
category, or flag behaviour changed. An archive an earlier run already left out of order is not
rewritten — see below.

### Fixed

- **A condense could leave `changelog-archive.md` out of date order.** `insertIntoArchive` put the
  whole batch above the newest existing heading. That is right for the verbatim auto-archive, whose
  dates are always newer than everything archived, but the pre-1.1 summary-only path archives
  *summary-zone* dates, which can be older than entries an earlier run already wrote — so those
  landed above entries that predate them. Entries are now placed individually by date, and one
  older than all of them lands above the archive's trailing notes (`> Earlier years:`, the seeded
  placeholder) rather than below them. No content was ever lost to this; the ordering was.
- **`--shed-year` was the reason it mattered.** It slices from the first heading of a year through
  EOF and trusts years to be contiguous, so a misplaced older-year entry would have carried every
  newer year into the shed file. Unreachable in practice before now, since only the summary-only
  path can insert out of order and it had never met a multi-year archive.

### Added

- **Check N** — a run that takes a descending archive and returns a non-descending one aborts.
  Deliberately a regression check, not a format rule: an archive that arrives out of order passes
  untouched, because re-sorting a file this system didn't scramble is editing history. It also
  covers the manual `--ar-before` / `--ar-content` path, whose anchor is taken literally.

Repos condensed before this release may have an out-of-order archive. It is cosmetic — `--report`
reads archive entries as a set and `--check` doesn't read the archive at all — but sort it before
the first `--shed-year` on a multi-year archive.

---

## [1.3.0] — 2026-08-09

The determinism release: a condense no longer needs a model, and the model-written flow can no
longer lose an entry. **Upgrade: recommended — re-run `install.mjs`. Safe on an existing
installation**; no shared anchor, category, or filename convention changed, every existing flag
behaves identically, and an already-written `--cl-mid` that followed the old instructions (sentinel
and unchanged entries re-typed) still verifies — the assembler dedupes the sentinel and Check K
covers restated legacy blocks.

### Added

- **`condense-changelog.mjs --auto --today <DATE>`** — the whole condense derived and executed in
  one deterministic command: tier boundaries, Tier-2 per-day summaries built from each bullet's
  **bold subject** + first anchor link + issue refs (the keys the fragment lint already enforces),
  Tier-3 week-ranges, verbatim archival, the Tier-4 drop, and the year shed, all under the same
  verification suite. Suitable for cron/CI; `--plan` now prints it as the default path. Pre-1.1
  summary-only dates (detail discarded by the old flow) are archived as-is, marked
  `_Summary only …_` — the summary is the only text that still exists for them.
- **Absolute week buckets for `--auto`'s Tier-3 ranges** (`weekBucket`, epoch-days ÷ 7). A date's
  bucket never changes between runs, so a later run *extends* a partial week's existing range —
  body kept, new per-day lines appended, heading widened — instead of laying a second range beside
  it.
- **Check L — fold-first is enforced, not requested.** A splice (manual or `--auto`) refuses to run
  while fragments are pending in `docs/changelog.d/`; Tier-4-only and shed runs warn instead, and
  `--plan` flags the pending count up front.
- **Check M** — `--cl-mid` (and the splice region itself) must parse into placeable blocks; content
  sitting under no heading is refused rather than guessed at or silently dropped.
- **`{{CATEGORIES}}` / `{{CATEGORIES_BOLD}}` substitution.** The docs that list the category
  vocabulary are filled from the payload's now-exported `CATEGORY_ORDER`, so adding a category is a
  one-array change plus a re-install, not a four-doc sync.

### Changed

- **The splice region is assembled; `--cl-mid` carries only the NEW summary text.** The script
  re-opens the `## Earlier Changes (Summary)` sentinel itself (a mangled copy in cl-mid is
  canonicalized, a duplicate deduped), re-emits unchanged `### DATE` / `### X to Y` entries and
  legacy blocks the region swallows, and sorts everything newest-first — cl-mid's order is
  irrelevant. An old entry now leaves the region only for a stated reason: replaced by key in
  cl-mid, collapsed into a covering range (Check C then demands its archive entry), or a per-day
  summary older than `--drop-ranges-before`, whose only home is the archive.
- **`/changelog-condense` shrank to match** — the tier table, the fold-first note, `--auto` as the
  default path, and a three-step manual flow that defers to `--plan` instead of restating it.
- **The installer prints the CLAUDE.md snippet in both branches.** When a target's CLAUDE.md
  already mentions `docs/changelog.d/`, the output said "check it matches the snippet below" and
  then printed nothing to compare against.

### Fixed

- **An unchanged entry omitted from `--cl-mid` was silently deleted.** Its detail was already in
  the archive, so Check C passed, Check D only guards `##` headings, and no check covered a dropped
  week-range at all — the changelog just lost its index line with every check green. The assembler
  re-emits such entries instead; the plan no longer asks anyone to copy anything verbatim.

---

## [1.2.0] — 2026-08-03

The observability release: one read-only command answers "is this system actually being used?"
**Upgrade: optional — re-run `install.mjs`. Safe on an existing installation**; nothing about the
fold, the condense, or any file format changed, and every existing flag behaves identically.

### Added

- **`collect-changelog.mjs --report`** — a read-only census of the whole system: pending fragments
  by category with their lint warnings, each tier's size and date span, the structural problems
  `--check` would fail on, and a **capture-coverage** section built from git. It writes nothing,
  takes no lock, and always exits 0 once it can read the files — it is a dashboard, not a gate.
- **Capture coverage answers the one question nothing else could.** Every other failure mode here is
  loud: an unfoldable fragment exits non-zero and stays on disk, a hand-edited changelog fails
  `--check`, an interrupted fold is recovered by the next run. But a session that simply never wrote
  a fragment emits no event — the failure is the *absence* of one, so no log or counter inside these
  scripts could ever record it. The report asks git which days had commits touching anything but the
  changelog's own files, then names the ones no tier documents. A day counts as documented by a
  pending fragment, a Tier-1 block, a summary entry, an archived day, or a week-range containing it.
- **`--json` and `--since`.** `--json` emits the same census as one object, so CI can trend the
  numbers instead of a human eyeballing them; `--since` takes any git date expression (default
  `30.days`). Both are refused outside `--report` rather than silently ignored.
- **Two exported pure helpers** — `summarizeChangelog` and `summarizeArchive` — so a repo can build
  its own dashboard, or aggregate several installations, without reimplementing the parsing.
- **`{{FOLD_CMD_REPORT}}`** joins the installer's substitutions, and the printed `CLAUDE.md` snippet
  is now covered by a test in both the `package.json` and bare-`node` branches (it is printed rather
  than written, so no file assertion reached it before).

### Note on telemetry

The report deliberately writes **no** log file. Fold and condense activity is already recorded — in
git, in the commits that move fragments into `changelog.md` — and an append-only log committed
alongside it would conflict on every concurrent write, recreating exactly the shared-file race this
system exists to remove. What was genuinely invisible was under-capture, and that is a ratio, not an
event. `--report` computes the ratio; nothing new is persisted.

`--report` shells out to `git` (the only subprocess either payload script spawns). Payload scripts
remain dependency-free — no git, no repo, or a shallow clone simply drops the coverage section and
still prints the filesystem census.

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
