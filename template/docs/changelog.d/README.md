# Changelog fragments

This directory solves one problem: **many coding agents run against this repo at
once, and they used to collide editing `docs/changelog.md`.** Instead of every
agent prepending to that one shared file (a race on a single file — the whole
tree is shared), each agent drops its entry here as its own uniquely-named
**fragment**. No two agents ever touch the same path, so the collision is
structurally impossible. A separate, serialized step later folds the fragments
into `docs/changelog.md`.

This is the [Changesets](https://github.com/changesets/changesets) /
[Towncrier](https://towncrier.readthedocs.io/) pattern.

## Writing a fragment (what `/changelog-update` does)

Create **one file per session's changelog update**:

```
docs/changelog.d/<YYYY-MM-DD>-<slug>-<token>.md
```

- `<YYYY-MM-DD>` — today's date. **The fold reads the date from the filename**, so
  the file itself has no `## DATE` header.
- `<slug>` — a short kebab-case topic (e.g. `session-cookie-rotation`).
- `<token>` — a few random chars so two agents on the same topic can't collide
  (e.g. `openssl rand -hex 2` → `a3f9`).

Contents are exactly what you'd write in the changelog, minus the date header:
`### Category` sections (**Added / Changed / Fixed / Removed / Security**) with
`- **Bold subject** — …` bullets, following all the usual concision rules.

```markdown
### Fixed
- **Wide dialogs clamped to 640px** — a `sm:`-prefixed base width beat callers'
  unprefixed overrides. [`dialog.tsx`](../src/components/ui/dialog.tsx).

### Security
- **Webhook accepted unsigned events** — an absent signature header
  short-circuited verification. The secret is now constant-time-compared and an
  unset secret never matches. [`route.ts`](../src/app/api/webhook/route.ts).
```

**Link hrefs are written relative to `docs/`** — i.e. `../src/…`, `audits/…` —
*exactly* as they will appear once folded into `docs/changelog.md`, **not**
relative to this `changelog.d/` folder. The fold copies bullet lines
byte-for-byte, so the text must already match its final form.

When you commit, **stage only your own fragment file** (never `git add -A`).

## Folding fragments into the changelog (serialized, single-owner)

Run when the tree is quiet — this is the only step that writes `changelog.md`:

```bash
{{FOLD_CMD_DRY}}  # preview
{{FOLD_CMD}}  # fold + delete fragments
```

Then commit `docs/changelog.md` together with the fragment deletions.
`/changelog-condense` runs the fold first, so condensing always sees a complete
file.

## Why the fold is byte-preserving

`mergeFragmentsIntoChangelog` (`scripts/collect-changelog.mjs`) copies bullet
lines verbatim and never reformats them. That keeps the fold a pure *move*: a
folded entry reads exactly as authored, and `git log -S "<bullet text>"` still
finds the feature commit that introduced it rather than the mechanical fold
commit.

Everything in this directory except this `README.md` is transient.
