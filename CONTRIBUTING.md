# Contributing

Bug reports with a minimal snippet and the `inspect` output are the most useful contribution: most fixes start from one. For a change in behaviour, open an issue first so we can agree on it before you write it.

## Setup

Node.js 22.18 or later (24 in `.nvmrc`) and pnpm, which Corepack provides at the version `package.json` names:

```sh
corepack enable
pnpm install
```

## Checks

CI runs these on every pull request, in this order:

```sh
pnpm lint            # ESLint
pnpm format:check    # Prettier (pnpm format writes)
pnpm typecheck       # tsc --noEmit
pnpm build           # tsdown, then schema.json from the config schema
pnpm smoke           # the built server over stdio, every tool, against examples/shadcn-demo
pnpm test            # Vitest, on Node 22 and 24 (Linux), and on Windows and macOS
pnpm pack-test       # npm pack, install into a new project, run it (Linux, Windows, macOS)
```

A pull request that touches `src/` also runs the [real-world corpus](#real-world-corpus), which is not a required check yet.

`pnpm smoke` spawns `dist/cli.js` the way an MCP client does, so it catches what unit tests cannot: a broken build, a tool that fails over stdio, output that no longer parses. It connects twice, on the 2025 protocol and on 2026-07-28. Run it after `pnpm build`; add `--verbose` to see every response. CI also runs `check` on the demo's clean page (it must pass) and the Claude Code hook on its draft (it must block).

`pnpm pack-test` (after `pnpm build`) tests the package as a user gets it: it packs the repository with `npm pack`, so the publish hooks run, installs the tarball into a new project in the system temp folder, and runs the installed `onsystem` bin (`--version`, `inspect`, `check`), an MCP stdio handshake with the installed server in both protocol eras, and the Claude Code hook, which picks up the project's own install. It needs the npm registry for the package's dependencies.

Commit `schema.json` when `pnpm build` changes it, and `.github/assets/architecture.svg` when `pnpm assets` does.

## Adding a lint rule

1. Add the rule id to `RULE_IDS` and its default severity to `DEFAULT_SEVERITY` in `src/config.ts`.
2. Write the rule in `src/lint/rules/`: a `Rule` whose `run(context)` walks `context.analysis` (JSX elements, class strings, style objects) and calls `context.report()` with source offsets, a message that says what to write instead, and, when the change is mechanical, a `fix` of text edits. Resolve tags with `context.resolve(element)`; read tokens from `context.target.tokens`.
3. Register it in `RULES` in `src/lint/index.ts`.
4. Test it in `test/lint.test.ts` against code an agent would actually write. Use the demo (`check(code, rule)`), or a throwaway project built from realistic files with `fixture({ 'components/ui/button.tsx': …, 'app/globals.css': … })`; pass `{ nodeModules: true }` when the components need React or Radix types. Cover what it reports, the fix (`applyFixes`), and what it must leave alone. Files that must stay byte-for-byte, such as a stock shadcn/ui `globals.css`, go in `test/fixtures/`, which Prettier skips.
5. Add a row to the Rules table in `docs/rules.md` (the website's rules page is built from it) and to the short table in the README, add an example to `site/scripts/rule-docs.mjs`, and run `pnpm build` so `schema.json` lists the new id.

The same pattern holds for a false positive: reproduce it as a failing test from the real code that triggered it, then fix it.

## Real-world corpus

Synthetic fixtures show that a rule works; they do not show how often it is wrong. `corpus/repos.json` pins public repositories by commit, and `pnpm corpus` (after `pnpm build`) fetches the folders it needs, shallow and sparse, then runs `inspect` and `check` with the built CLI on each and compares the result with two files:

- `corpus/snapshot.json`: per run and per rule, the errors, warnings and fixable findings, plus what `inspect` found.
- `corpus/labels.json`: findings labelled by hand as TP (true positive), FP (false positive) or D (debatable), with a one-line reason. Each is keyed by a fingerprint of the run, file, rule, offending text and occurrence, so it survives edits elsewhere in the file. A label with a `suggestion` applies only while that is the suggestion, for findings whose fix is the problem. `sample` says how it was picked: `random` labels estimate the false-positive rate, `audit` labels are suspicious findings picked by hand.

The run fails when counts change (after a deliberate change, run `pnpm corpus --update` and commit the snapshot, as with Jest snapshots), when a TP is no longer reported, or when an FP that a change fixed comes back. Those two hold even with `--update`: relabel or remove the label if the change is intended. It ends with the false-positive rate of the random sample, raw and weighted by each run's and rule's share of the findings; that is the number to quote for a release.

The repositories are untrusted: only source, styles, manifests and docs are fetched, nothing in them is installed, built or run, and a run whose folder has an `onsystem.config` (or `design-system-mcp.config`) written in code is refused. They live outside this repository (`$TMPDIR/onsystem-corpus`, or `--dir`/`CORPUS_DIR`), since the CLI looks upwards for `node_modules` and workspace roots. Other commands: `pnpm corpus fetch`, `pnpm corpus --only documenso` for one repository or run, and `pnpm corpus sample <run>` to print unlabelled findings with their code and a label to fill in (`--per-rule`, `--seed`, `--rule`, `--file`, `--line`).

An app whose design system is a published library (MUI, read from its type declarations) is the one case where packages are installed: without the library, there is nothing to read. Its `install` in `corpus/repos.json` names the packages per folder, each at an exact version (the library, its peers and React's types), and a `before` date that pins what they depend on, as npm resolves it from packages published by then. `fetch` installs them from npm with `--ignore-scripts` into a folder beside the checkouts (`.installs`, cached with them), and links it as that folder's `node_modules`. The repository's own `package.json` and lockfile are not used, and none of its code runs.

When a change fixes a false positive, add a label for it if there is none, run `pnpm corpus --update`, and put the changed counts (the table it prints) and the new false-positive rate in the pull request.

## Releasing

Releases use [Changesets](https://github.com/changesets/changesets). For any user-facing change, run `pnpm changeset`, pick patch or minor, and describe the change for someone upgrading. Docs-only and internal changes need none.

On merge to `main`, the release workflow opens a "chore: release" pull request: `changeset version` bumps `package.json` and writes `CHANGELOG.md`, and `scripts/sync-versions.mjs` copies the version into `server.json` (MCP Registry), the Claude Code plugin's `plugin.json`, the exact `onsystem@<version>` the plugin's server and hook run, and the same in the Agent Plugins and Cursor packages (`plugins/onsystem-agent`, `plugins/onsystem-cursor`). A test (`node scripts/sync-versions.mjs --check`) fails when they drift from `package.json`. Merging that pull request publishes to npm with provenance (npm trusted publishing, no token), and the same run publishes `server.json` to the MCP Registry. Do not edit `CHANGELOG.md` or those versions by hand.

The skill has one source, `plugins/onsystem/skills/onsystem/SKILL.md`. After editing it, run `pnpm sync-plugins` to copy it into the other packages; a test fails when a copy differs.

### Retiring the old names (one-off, after onsystem 0.4.0 is on npm)

The package was `@dgesteves/design-system-mcp` and its MCP Registry entry `io.github.dgesteves/design-system-mcp` until 0.4.0. Once `onsystem@0.4.0` is published, the maintainer points both at the new name, from a machine logged in to npm and with [`mcp-publisher`](https://github.com/modelcontextprotocol/registry/releases) installed:

```sh
npm deprecate @dgesteves/design-system-mcp "Renamed to onsystem: npm install onsystem. See https://design-system-mcp-demo.vercel.app/docs/migrating"

mcp-publisher login github
mcp-publisher status --status deprecated --all-versions --yes \
  --message "Renamed to io.github.dgesteves/onsystem (npm: onsystem). See https://design-system-mcp-demo.vercel.app/docs/migrating" \
  io.github.dgesteves/design-system-mcp
```

The registry has no field that points one server at another, so the status message carries the new name. Neither command is in a workflow: each runs once.

## Pull requests

One change per pull request, with tests, a changeset when users will notice it, and the docs updated when behaviour changes. The docs live in `docs/*.md`, which GitHub shows as they are and the website renders (`site/scripts/generate.mjs`); link between them with relative paths (`ci.md#adopting-it-in-an-existing-codebase`), which a test checks. The README stays one screen: what it is, what it checks, a quickstart and links, and every number in it comes from a file in the repository (`test/readme.test.ts` checks them against the corpus and the benchmark). Keep messages, docs and README in the same plain voice: say what happens and what to do, without filler.
