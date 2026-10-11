# Troubleshooting

Most problems show up in `npx onsystem inspect`: from the app's folder it prints the root, the config it read, how it found the design system (`detected`), and every component and token category it extracted; from a monorepo root, the same for each project. `npx onsystem inspect --explain` adds why: every candidate zero config looked at (`components.json`, the package's `exports`, each dependency named like a design system, a flat `src/`) and why it was taken or turned down, the resolved config, tokens whose value reads a custom property no token file defines, and components whose props did not resolve, with the reason. Start there.

## inspect found nothing

`inspect` prints `Components (0 + 0 parts)`, or `check` says `No design system found (no components or color tokens)`.

1. **Run it from the app's folder**, the one with the app's `package.json` and, in a shadcn/ui project, `components.json`, or from the monorepo root: see the [next section](#a-monorepo-root-misses-a-project).
2. **Read the `detected` line,** or run `inspect --explain` for each candidate's reason (`the ui alias ~/ui resolves through neither tsconfig paths nor a workspace package`, `not a workspace package: an installed package is compiled`). It says how the components were found. With no `detected` line, none of the [zero-config layouts](configuration.md#zero-config) matched: a `components.json`, a design-system package's `exports`, a workspace dependency named like a design system (`@acme/ui`), or a flat `src/` of components that wrap a primitives library.
3. **Point at them with a config file.** `npx onsystem init` asks where the components and tokens are and writes it. An `onsystem.config.json` in the app's folder with a `components` glob is enough; add `tokens` when the stylesheet is not one of the default paths:

   ```json
   {
     "$schema": "https://unpkg.com/onsystem/schema.json",
     "components": ["src/ui/**/*.tsx"],
     "tokens": ["src/styles/theme.css"]
   }
   ```

4. **`Tokens (0)`, or `No color tokens found`,** means no stylesheet or `*.tokens.json` defined any. Set `tokens` in the config to the file with the custom properties or the Tailwind `@theme`.

In CI, `check --require-design-system` turns "nothing found" into a failure (exit code 2), so a moved design system cannot pass by checking nothing. An app on MUI passes with MUI's components alone: when its palette cannot be read (built in code or from Sass variables), `check` says that `no-hardcoded-color` did not run rather than fail.

## A monorepo root misses a project

At a workspace root, `inspect` lists every project it found (`apps/remix (@documenso/remix)`, with what was detected in it) and then `Without a design system`, the packages where zero config found no components. On Documenso, `inspect` at the root finds `apps/remix` with `@documenso/ui`'s 99 components; on Cal.com, `apps/web`, `packages/ui`, `packages/coss-ui`, `packages/platform/atoms` and the feature packages that use `@calcom/ui`. [How projects are found](configuration.md#monorepo-roots).

- **A package is listed without a design system.** Run `npx onsystem inspect --root packages/that-one` to see what zero config looked at there, and give it an `onsystem.config.json` with `components` if its layout is not one zero config reads: a package with a config of its own is always a project.
- **The root is read as one project.** A `components.json`, a `components/ui` folder at the root, or a root config that sets `components` makes the root one project, as before. Move `components` into each app's config, or remove it from the root's.
- **The MCP tools answer for the wrong app.** At a root the tools need the file being edited: `get_component` with `path`, `check_ui` with `path` or `filename`. Without one they list every project together, and a name that two packages use (`Button` in `@calcom/ui` and `@coss/ui`) comes back as a list to pick from.
- **One app per job in CI:** `working-directory: apps/web` checks that app alone, and `--require-design-system` there fails when its design system goes missing; at the root it fails only when no package has one.

## Components show 0 props

`inspect` lists components that wrap a library, such as a Radix `Dialog` or `DropdownMenu`, with `0 props`, and `no-unknown-prop` never reports on them.

Their props come from the types of the packages they wrap, so they resolve only when the project's dependencies are installed. Without `node_modules`, extraction marks those props as open rather than guess, and `no-unknown-prop` skips the component. `inspect --explain` lists them under `Props` and says whether the dependencies are installed. On a checkout of Vercel's chatbot without its dependencies, `Dialog`, `DropdownMenu` and `Popover` show 0 props; in the demo, with them, `Dialog` has 5.

Install the dependencies (`npm install`, `pnpm install`, …) before running `inspect`, `check` or the server, and in CI before `check` (`npm ci`). If the counts still show 0, run once with `--no-cache`.

## A min-release-age policy blocks npx

The Claude Code hook says once that `onsystem could not check …: npm found no version of onsystem@<version> it may install (ENOVERSIONS)`, or `npx onsystem` fails with `ENOVERSIONS`.

npm's `min-release-age` (a number of days, usually in `.npmrc`) makes npm and npx install only versions published longer ago than that. pnpm's `minimumReleaseAge` does the same for pnpm, in minutes, and defaults to a day from pnpm 11. The plugin runs the exact version it was released with, so for the first days after a release that version can be too new for the policy; `npx onsystem` without a version takes the newest version that is old enough.

- **Install it in the project** as a dev dependency. The hook and CI then run that copy, which your lockfile pins, instead of npx: `npm install --save-dev onsystem`.
- **With pnpm,** exempt it: `minimumReleaseAgeExclude: [onsystem]` in `pnpm-workspace.yaml` (pnpm 10.16 or later).
- **For one command,** override the setting: `npx --min-release-age=0 onsystem check .`.
- **Or wait** until the release is older than the policy's limit.

## Still stuck

Open an [issue](https://github.com/dgesteves/onsystem/issues/new/choose) with the output of `npx onsystem inspect`, the smallest snippet that shows the problem, and the version (`npx onsystem --version`). False positives are the reports that help most.
