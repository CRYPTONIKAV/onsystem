# Make it a required check on agent pull requests

Coding agents open pull requests on their own now: GitHub Copilot's cloud agent, Codex, Claude in GitHub Actions, background agents in Cursor. Each one runs your CI like any contributor, so the surest way to hold all of them to the design system is a required check: the pull request cannot merge until `onsystem check` passes on what it changed. In Claude Code the [plugin's hook](plugin.md) catches the same findings while the agent writes; the check is the gate for everything else.

## The workflow

`.github/workflows/onsystem.yml`:

```yaml
name: Design system
on:
  pull_request:
  merge_group:
permissions:
  contents: read
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
      - uses: dgesteves/onsystem@v0
```

The action runs `onsystem check` on the files, honours the [baseline](ci.md#adopting-it-in-an-existing-codebase), and reports the findings on the lines the pull request changed: as annotations on those lines, and as a table in the job summary (GitHub shows at most ten annotations of each kind per step). It fails the job when one of them is an error. Findings on lines the pull request did not touch are counted in the summary, not reported, so an existing codebase can turn the check on before it is clean. A hunk that only deletes lines counts the lines either side of it, so removing an `aria-label` is caught on the button around it.

Install the dependencies first, as above: without them the props of components that wrap a library (Radix, React Aria) are unknown, and `no-unknown-prop` skips those components. The default checkout is enough: the action fetches the history it needs to find where the pull request branched off. `merge_group` makes it run in a merge queue too, which a required check needs if the branch uses one.

`@v0` follows the latest 0.x release, and each release of the action runs the CLI of the same version (`npx onsystem@<version>`). To stay on one release, pin a commit SHA.

| Input                   | Default | What it does                                                                                                                     |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `paths`                 | `.`     | Files, folders or globs to check, relative to `working-directory`, separated by spaces or new lines                              |
| `working-directory`     | `.`     | Where to run the check, such as one app of a monorepo; its config and baseline are used                                          |
| `baseline`              |         | Baseline file, relative to `working-directory`; by default `onsystem.baseline.json` in the project root, whenever it exists      |
| `fail-on`               | `error` | `error`, `warning` (errors or warnings) or `none`                                                                                |
| `only-changed-lines`    | `true`  | On pull requests and merge groups, report only findings on the changed lines; `false` reports every finding in the checked files |
| `require-design-system` | `true`  | Fail when no components or no color tokens are found, so the check cannot pass by checking nothing ([CI and baselines](ci.md))   |

An app on a [published library](configuration.md#published-libraries-mui) (MUI) passes `require-design-system` with the library's components alone; when its theme's colors cannot be read, the step's log says that `no-hardcoded-color` did not run. The outputs `errors`, `warnings` and `outside-diff` count what was reported and what was left out. In a monorepo, add a job per app with `working-directory: apps/web`, each with its own design system and baseline.

## Make the check required

The check is named after the job, `onsystem`, and it can be required once it has run on a pull request.

- **Rulesets:** Settings → Rules → Rulesets → New ruleset → New branch ruleset. Target the default branch, turn on **Require status checks to pass**, add `onsystem` (choose GitHub Actions as its source), and set enforcement to Active.
- **Branch protection:** Settings → Branches → Add branch protection rule for `main`, turn on **Require status checks to pass before merging**, and add `onsystem`.

Or create the ruleset with the GitHub CLI (`15368` is the GitHub Actions app, so only a workflow can report the check):

```sh
gh api repos/OWNER/REPO/rulesets --method POST --input - <<'EOF'
{
  "name": "Design system",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "onsystem", "integration_id": 15368 }]
      }
    }
  ]
}
EOF
```

## Pull requests from agents

- **GitHub Copilot cloud agent:** by default, workflows do not run on its pull requests until someone clicks **Approve and run workflows**, and a required check waits until then; the cloud agent's settings can let them run without approval. Give the agent the MCP server too, so it checks its work before it pushes: repository Settings → Copilot → MCP servers, then this MCP configuration (the tools only read):

  ```json
  {
    "mcpServers": {
      "onsystem": { "type": "local", "command": "npx", "args": ["-y", "onsystem"], "tools": ["*"] }
    }
  }
  ```

  Install the project's dependencies in its `copilot-setup-steps.yml`, for the same reason as in CI.

- **Codex:** it opens pull requests through its GitHub connector, so the check runs on them as on any other. Comment `@codex fix the CI failures` on the pull request to have it fix what the check reported.
- **Claude in GitHub Actions** (`anthropics/claude-code-action`): it pushes to a branch with the Claude GitHub app's token, which starts workflows. With `github_token` set to the workflow's `GITHUB_TOKEN`, pushes start no workflows and pull requests start them only after approval, so the check never reports on its own. With `actions: read`, Claude can read the check's results when tagged on the pull request.
- **Anything else that pushes with a workflow's `GITHUB_TOKEN`:** the same applies. Push with a GitHub App token or a personal access token, or approve the runs.

## Code scanning instead of annotations

`--format sarif` puts the findings in GitHub code scanning, which shows them as alerts and, on a pull request, on the lines it changed; code scanning then fails its own check on new errors, and that check can be required instead. The workflow is in [CI and baselines](ci.md#code-scanning-and-other-sarif-tools):

```yaml
- run: npx onsystem check . --format sarif --require-design-system > onsystem.sarif || test $? -eq 1
- uses: github/codeql-action/upload-sarif@v4
  with:
    sarif_file: onsystem.sarif
    category: onsystem
```

`|| test $? -eq 1` uploads the findings when there are some (exit code 1) and still fails the job when the check could not run (exit code 2). The job needs `security-events: write`. Code scanning is free for public repositories; private ones need GitHub Code Security.

## Gate the whole codebase with a baseline

Changed lines are the right gate for pull requests. To also catch findings that appear on lines nobody touched (a config change, a component that lost a variant), record the existing findings once and commit the baseline:

```sh
npx -y onsystem check . --update-baseline
git add onsystem.baseline.json
```

Then check every line against it, on pull requests and on pushes to `main`:

```yaml
- uses: dgesteves/onsystem@v0
  with:
    only-changed-lines: false
```

Only findings that are not in the baseline fail. When findings get fixed, `check` says so and prints the command that drops them from the baseline; run it and commit the smaller file, so they cannot come back.
