---
description: Update the changelog file after completing any changes to the codebase.
---

# Update Changelog

Record this conversation's changes by writing a **changelog fragment** — a small
file in `docs/changelog.d/`. **Do NOT edit `docs/changelog.md` directly.** Many
coding agents run against this tree at once; when they each prepend to that one
shared file they collide (a filesystem race). A fragment has a unique filename,
so no two agents ever touch the same path. A serialized fold step
(`/changelog-condense` or `{{FOLD_CMD}}`) later batches fragments into
`docs/changelog.md`. See `docs/changelog.d/README.md`.

The changelog is a **scannable record of history**, not a PR description or a post-mortem.
Depth belongs in three other places, so don't duplicate it here:
- **How it works now** → the relevant `guides/` doc.
- **Proof it works** (verification steps, build output, test counts) → the commit body or the audit doc.
- **Full rationale** → the audit doc under `docs/audits/`, when there is one.

The changelog answers one question for a future reader scanning history: *what changed, and why.*

The diff's full story already lives in git — the changelog is the **index**, not the archive. That's why the depth above goes to the commit body, not here.

## Instructions

1. Review the changes made during this conversation (files created, modified, deleted).
2. Write **one** fragment file for this session:
   ```
   docs/changelog.d/<YYYY-MM-DD>-<slug>-<token>.md
   ```
   - `<YYYY-MM-DD>` is today's date — the fold reads the date from the filename, so the fragment has **no `## DATE` header**.
   - `<slug>` is a short kebab-case topic (e.g. `session-cookie-rotation`).
   - `<token>` is a few random chars so two agents on the same topic can't collide. Generate it with `openssl rand -hex 2` (falls back to any 4 random hex chars).
   - Put **all** of this session's entries in this one file; add more `### Category` sections rather than a second file.
3. Fill it with `### Category` sections (**Added**, **Changed**, **Fixed**, **Removed**, or **Security**) and `- **bold subject** — …` bullets.
4. Keep each entry within the concision rules below.
5. When committing, **stage only your fragment file** (explicit path — never `git add -A`). Do not touch `docs/changelog.md`.

## Concision Rules (hard limits)

- **1–2 sentences per entry.** If you need more, the detail belongs in a guide, commit body, or audit doc — link to it instead.
- **Lead with the change, not the story.** Bold a short subject, then say what changed and why in the same breath.
- **Name the anchor file(s)** — the one or two paths a reader would open — nothing more. Don't enumerate every touched file.
- **No verification noise.** Never include build/lint/typecheck output, test counts, "0 errors", "browser-verified", or "green". Passing checks are table stakes, not news.
- **No blow-by-blow narratives** ("logged into a throwaway session… the lone console 403 was…"). That's PR-review evidence — put it in the commit body.
- **No re-explaining mechanics** the guide already documents. A behavior change is news; the internals aren't.
- **Link, don't retell.** If a change came from an audit, cite it (`(auth audit R7)`) rather than re-summarizing the finding.

### The one exception: Security entries

Security entries may run slightly longer (up to ~3 sentences) because the changelog is a real reference for the recurring vuln classes in a repo. Even so: state the vuln, the fix, and the anchor file — then point to the audit doc or commit for the proof.

## Format

- The fragment has **no date header** (the date is in the filename).
- `###` for category headers.
- Bullet points with a **bold subject** followed by the description.
- Use a relative markdown link for the anchor file, written **relative to `docs/`** (its final home) — `` [`file.ts`](../src/…/file.ts) ``, `` [`x.md`](audits/x.md) `` — **not** relative to `changelog.d/`. The fold copies bullet text verbatim, so it must already read as it will in `changelog.md`.

## Examples

### Good — a fragment (`docs/changelog.d/2026-07-05-dialog-width-9b2c.md`)

```markdown
### Changed
- **Nav sidebar** — split the settings pages out of the Monitoring sidebar into their own section; Monitoring is now ops-only. [`sidebar.tsx`](../src/components/sidebar.tsx).

### Fixed
- **Wide dialogs clamped to 640px** — a `sm:`-prefixed base width beat callers' unprefixed overrides (tailwind-merge only de-dupes within a variant); moved the default to the unprefixed scope. [`dialog.tsx`](../src/components/ui/dialog.tsx).

### Security
- **Webhook accepted unsigned events** — an absent signature header short-circuited verification, so anyone could post a state change. The secret is now constant-time-compared and an unset secret never matches. [`webhook/route.ts`](../src/app/api/webhook/route.ts).
```

### Bad — an entry that should have been three lines

```markdown
### Changed
- **Removed the completed-tasks metric from the Tasks column (admin: "just looks like noise").** The cell showed three counts — overdue, active, and completed — but the completed total was visual clutter that padded rows with no actionable signal (e.g. a row with only finished tasks lit up the column). Dropped the completed block, so the cell now shows only overdue + active… Also updated the sort comparator… removed the now-unused import… The data plumbing is left intact for future use. Build passed, 0 errors.
```

Why it's bad: far too long for a UI tweak, restates internals a reader doesn't need from *history*, and ends with a banned build-status line. Everything past "shows only overdue + active" belongs in the commit body, not here.
