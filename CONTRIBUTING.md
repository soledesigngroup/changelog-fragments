# Contributing

Issues and PRs welcome. This is a small, dependency-free repo — there's no build step, no linter, and
no `node_modules`. `npm test` is the only check.

## Read this first: what kind of repo this is

`changelog-fragments` is a **distributor**, not an application. The changelog system defined here
doesn't run against this repo — `install.mjs` copies it into *other* repos. There are two layers:

| Layer | Files | Ships to a target repo? |
|---|---|---|
| Installer | `install.mjs`, `lib/migrate.mjs` | No — runs from here |
| Payload | everything under `template/` | Yes — verbatim or substituted |

So editing `template/scripts/collect-changelog.mjs` means editing a file that will live in someone
else's repo, with no dependencies, no build step, and possibly no `package.json`. Keep payload
scripts on Node builtins only (Node 18+), and keep them importable.

## The invariants are load-bearing

[CLAUDE.md](CLAUDE.md) lists them. Each is enforced by code **and** by a test, and breaking one
silently corrupts a downstream repo's history — the failure mode is a changelog that quietly loses an
entry, not a crash. Read that file before changing behavior.

The one that catches people out: the **shared structural anchors** (`## Earlier Changes (Summary)`,
the `> Full per-day details available in` footer, the `## YYYY-MM-DD` heading shapes) are a wire
format living in other people's git history. Changing one is a breaking change to a file you don't
own and can't migrate for them.

Likewise, the six categories in `CATEGORY_ORDER` are the entire accepted vocabulary. Adding a seventh
is forward-incompatible: fragments written under the new vocabulary won't fold in an older install.
If you add one, add it to `CATEGORY_ORDER` **and** to all four docs that list them.

## Tests

```bash
npm test                  # everything
npm test -- fold          # only groups whose name matches "fold"
```

`test/smoke.mjs` installs into throwaway `mkdtemp` repos and shells out to the real scripts, so a
template edit is covered end-to-end without a separate fixture to update.

It's organized into `group()`s that each build their own temp repos. Tests **within** a group are
ordered and stateful on purpose (a fold test wants the file the previous fold produced), but nothing
crosses a group boundary. **New cases belong in the group whose fixture they need**, not appended to
the end of the file.

Failing paths matter as much as happy ones. Every condense check (A–I) has a test that makes it fire,
and `assertCheckFails` asserts the *specific check ID* — because a bare "it exited non-zero" also
passes when the script has a syntax error.

## Exercising the installer by hand

```bash
node install.mjs /path/to/scratch-repo --dry-run
node install.mjs /path/to/scratch-repo --name "Scratch" [--no-commands]
```

## Releases

Tagged, and noted in [CHANGELOG.md](CHANGELOG.md). Every entry states whether re-running
`install.mjs` over an existing installation is safe — that's the only question a downstream repo
actually has. Semver here is read in those terms:

- **patch** — installer or script bugfix. Re-running is always safe.
- **minor** — new capability. Re-running is safe; existing installs keep working untouched.
- **major** — a structural anchor, the category vocabulary, or the filename convention changed.
  Re-running requires action in the target repo.

Users pin with `npx degit soledesigngroup/changelog-fragments#v1.0.0`.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
