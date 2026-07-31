## Changelog

The changelog is **fragment-based**. After completing any changes, write a fragment — **never edit
`docs/changelog.md` directly.** Multiple coding agents run against this tree at once, and each one
prepending to that single shared file is a filesystem race; a uniquely-named fragment makes the
collision structurally impossible.

1. **Write one fragment per session** at `docs/changelog.d/<YYYY-MM-DD>-<slug>-<token>.md`
   (`<token>` = `openssl rand -hex 2`). It has **no `## DATE` header** — the fold reads the date from
   the filename. Inside: `### Category` sections (**Added / Changed / Deprecated / Fixed / Removed /
   Security** — no other heading, and no text above the first one) with `- **bold subject** — …`
   bullets. Link hrefs are written relative to `docs/` (`../src/…`), i.e. as they'll read once folded.
   Run `/changelog-update` to do this properly.
2. **Stage only your own fragment** when committing (explicit path — never `git add -A`).
3. **Folding is a separate, serialized step** run when the tree is quiet: `{{FOLD_CMD}}`
   ({{FOLD_CMD_DRY_INLINE}} to preview) batches every pending fragment into `docs/changelog.md` and
   deletes them. `/changelog-condense` runs the fold first, then ages older entries down through the
   summary tiers into `docs/changelog-archive.md`. `{{FOLD_CMD_CHECK}}` verifies fragments and
   changelog structure without writing anything.

Entries are a **scannable index of history**, not PR descriptions: 1–2 sentences each (Security may
run to ~3), name the one or two anchor files, append the issue/PR ref when one exists (`(#123)`),
and no verification noise (build/lint/test output, "0 errors", "green"). Depth goes to the commit
body, an audit doc under `docs/audits/`, or the relevant `guides/` doc — link, don't retell.

**Searching change history**: recent history is `docs/changelog.md` **plus any pending fragments**
in `docs/changelog.d/`; older full detail lives verbatim in `docs/changelog-archive*.md`. One
command covers all of it:

```bash
grep -rn "<term>" docs/changelog.md docs/changelog.d/ docs/changelog-archive*.md
```

See `docs/changelog.d/README.md` for the full mechanics.
