# CI and baselines

The check that runs after each edit in Claude Code also gates every pull request, whoever or whatever wrote it. `onsystem check` runs the same rules as `check_ui` and exits 1 on errors (or on more than `--max-warnings` warnings). It skips the design system's own component files, the ones `components` matches: they implement the scale and the primitives the rules enforce, so a fresh shadcn/ui project's `p-[3px]` is not a finding. `--include-design-system`, or `"includeDesignSystem": true` in the config, lints them too.

In folders and globs, `check` also leaves out tests and stories (`*.test.tsx`, `*.spec.tsx`, `*.stories.tsx`, and whatever is in `__tests__`, `__stories__` and `__mocks__` folders; `--include-tests` checks them), what the config's `exclude` lists, and what git ignores (through `git check-ignore`, so nested `.gitignore` files count); a file named outright is always checked. A file that renders an image or an email is not checked, since tokens and classes don't apply there: one that imports `next/og`, `@vercel/og`, `satori` or `@react-email/*`, a Next.js `opengraph-image`, `twitter-image`, `icon` or `apple-icon` route, or a file in an `og` folder. The summary line counts what was left out.

Pin it as a dev dependency, so CI, the plugin's hook and everyone on the team run the same version:

```sh
npm install --save-dev onsystem
```

A GitHub Actions job, `.github/workflows/onsystem.yml`:

```yaml
name: Design system
on: pull_request
jobs:
  onsystem:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npx onsystem check . --format github --require-design-system
```

Or use the GitHub Action, `uses: dgesteves/onsystem@v0`, which runs the same check, honours the baseline and reports only the lines a pull request changed: [Make it a required check on agent pull requests](required-check.md) has the workflow and how to require it.

Install the dependencies first: without them, the props of components that wrap a library (Radix, React Aria) are unknown, and `no-unknown-prop` skips those components ([troubleshooting](troubleshooting.md#components-show-0-props)). `--format github` prints workflow commands, so findings show up as annotations on the pull request; their paths are relative to the repository root, so a job that runs in a folder (`working-directory: apps/web`) annotates the right files. `--format json` prints the raw results, and `--format sarif` a SARIF log for [code scanning](#code-scanning-and-other-sarif-tools). From a [monorepo root](configuration.md#monorepo-roots), `check .` checks each file against its own project's design system and keeps one baseline at the root; there, `--require-design-system` fails only when no workspace package has components and color tokens (or a component library such as MUI), so a job per app (`working-directory: apps/web`) is the stricter gate.

When no components or no color tokens are found, `check` and `check_ui` say which rules could not run and link to the [configuration docs](configuration.md), so a clean result is not mistaken for a checked one. In CI, `--require-design-system` turns that into a failure (exit code 2), for when the design system moves and the globs stop matching. An app whose components come from a [published library](configuration.md#published-libraries-mui) (MUI) has a design system even when its theme's colors cannot be read, as with a palette from Sass variables: the check runs and says that `no-hardcoded-color` did not.

## Code scanning and other SARIF tools

`--format sarif` prints a [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) log: each rule with its description and a link to its entry in the rules catalog, and each finding with its level, message and location. Paths are relative to the repository root, wherever `check` runs from (the git top-level, or `GITHUB_WORKSPACE` where git is missing), and each finding carries a fingerprint built like a baseline entry (file, rule and the offending text), so an alert keeps its identity when the lines above it move. Findings in the baseline are left out. Upload it to GitHub code scanning, which shows the findings as alerts and, on a pull request, on the lines it changed:

```yaml
name: Design system
on:
  pull_request:
  push:
    branches: [main]
jobs:
  onsystem:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npx onsystem check . --format sarif --require-design-system > onsystem.sarif || test $? -eq 1
      - uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: onsystem.sarif
          category: onsystem
```

`|| test $? -eq 1` lets exit code 1 through: there are findings, and they are uploaded for code scanning to judge, through its own check on the pull request. Exit code 2 (no design system found, a broken config, a bad option) still fails the job, rather than uploading an empty log that passes. Code scanning is free for public repositories; private ones need GitHub Code Security.

## Adopting it in an existing codebase

An established app can start with hundreds of findings (midday's dashboard has 1,232). `npx onsystem init` offers to record them right after it writes the config (`--yes` does it without asking). Or record them yourself, once, and commit the file:

```sh
npx -y onsystem check src --update-baseline
# Baseline: 1,232 findings in 269 files → onsystem.baseline.json
```

From then on, `check` reads `onsystem.baseline.json` from the root whenever it exists and fails only on new findings: `No new problems in 569 files (1,232 in the baseline).` Entries are keyed by file, rule and the offending text with a count, not by line, so edits elsewhere in a file do not invalidate them, while a second `bg-[#f7f7f7]` where the baseline accepts one is reported. When findings get fixed, `check` says so and prints the command that drops them, which locks in the progress. Entries of a rule you turn off are kept rather than reported as fixed, a malformed baseline (a bad merge, say) is an error rather than something to overwrite, and paths are matched by their real spelling, so `APP/` on macOS or a linked checkout finds the same entries. `--ignore-baseline` shows everything, and `--baseline <file>` uses another path. The baseline applies to the CLI only: `check_ui` still shows an agent every finding in the file it is editing.
