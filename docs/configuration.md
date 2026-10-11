# Configuration

Most projects need no config: onsystem finds the design system the way your app imports it. Other layouts take a few globs.

## Zero config

Without a config file (or with one that leaves `components` unset), the server looks for the design system in this order, and `inspect` prints what it found on its `detected` line:

1. **`components.json`** (shadcn/ui): the `ui` alias, resolved through tsconfig `paths` (`@/registry/new-york-v4/ui`) or a workspace package's `exports` (`@workspace/ui/components` in shadcn's monorepo templates), and `tailwind.css` for tokens.
2. **The root is a design-system package** (when it has no `components.json`): its `package.json` `exports` lead to three or more component files (`"./button": "./src/components/button.tsx"` or `"./components/*": "./src/components/*.tsx"`). An export that points at a barrel (`"./components/button": "./components/button/index.ts"`, as `@calcom/ui` has them) stands for the `.tsx` files the barrel re-exports, through `export *`, `export { … } from` and imported bindings exported again. An export built to `dist/` is read from its source: the `entry` of a tsup, tsdown or Vite config (read as text, never run), else the same path under `src/`, and `.` from `src/index.*`, so Dub's `@dub/ui` (`"import": "./dist/index.mjs"`) is read from `src/index.tsx` and what it re-exports. Exported stylesheets that exist are read as tokens, else `src/globals.css` and the like.
3. **A dependency named like a design system** (`@acme/ui`, `@acme/ui-kit`, `@acme/design-system`, `acme-ui`) that resolves to workspace sources, through a `node_modules` link or the workspace's package globs (pnpm, npm, Yarn and Bun). It is read the same way, or through its own `components.json`, and added to what `components.json` found: Cal.com's app has `@coss/ui` in its `components.json` and imports `@calcom/ui` too, and both are read. Without a `components.json`, the app's own `components/ui` is kept alongside it. A package without `exports` that apps import by path, as Documenso imports `@documenso/ui/primitives/button`, is read from the files the app's code imports, each suggested with the specifier it uses, with a stylesheet imported from it as the theme.
4. **A flat `src/` of components** that wrap a primitives library, the way React Aria's Tailwind starter ships them (`src/Button.tsx`, `src/Checkbox.tsx`). It takes all of: a dependency on `react-aria-components`, `react-aria`, Radix, Base UI, Headless UI or Ark UI; no app entry (`main.tsx`, `App.tsx`, `index.tsx`) or `app`, `pages` or `routes` folder in `src/`; and at least five PascalCase `.tsx` files at its top level, four in five of which import that library. An app's `src/` of pages and features does not qualify. A stylesheet such as `src/index.css` is read as the theme.

With more than one design system, the one the app's code imports most is the primary: its components win where two share a name (`Button`) and are the ones suggested for native elements, while the others are still known, so an import from either is checked against its own component. `inspect` shows them on its `detected` line, with their import counts: `primary: workspace package @calcom/ui (993 imports); also: components.json (ui: @coss/ui/components → …) (140 imports)`.

A candidate whose files cannot be found is skipped. Components found through `exports` are suggested with the specifier apps use (`import { Button } from "@acme/ui/button"`, or `@acme/ui` for a package that exports a barrel). Detected stylesheets replace the stylesheet guesses below, while `*.tokens.json` files are still read, and Markdown next to detected components counts as docs. While serving, edits to `components.json`, `package.json` or the tsconfig re-run detection, and workspace packages outside the root are watched like local folders.

## Published libraries (MUI)

An app built on MUI has no components folder of its own: its design system is `@mui/material`, installed in `node_modules`. When the project's `package.json` depends on `@mui/material` and the package is installed, onsystem reads its components from the package's type declarations, the same files the app's own imports resolve to, with the TypeScript checker. `inspect` says so on its `library` line: `library  MUI (@mui/material 9.4.0): 149 components from its type declarations`. This happens whatever the config says about `components`, and works for MUI 5 to 9.

- **Components and props.** Every export with a capitalised name whose type takes props is a component: function and class components and MUI's `OverridableComponent`. Its props are those of each of its call signatures, so `<Button href="…" target="_blank">` is accepted through Button's link signature. MUI's own props are listed and React's DOM attributes summarised, as for any component. Styled slots exported next to a component (`SliderThumb` in `Slider`'s declarations) are its parts. React contexts and functions are not components.
- **Variants.** A prop whose type is a set of strings is a variant, with its values in the order the declarations write them: `variant`, `color` and `size` on `Button`, `severity` on `Alert`, and TextField's `variant` through its type parameter. Values the app adds by module augmentation (`declare module "@mui/material/Button"` in a file its tsconfig includes) are allowed, as TypeScript allows them. So are values its theme adds at runtime, which a JavaScript app need not declare: a palette group (`teal: { main: … }`) for every `color` that takes palette colors, and `components.MuiButton.variants` for that component's props.
- **Theme.** Tokens come from the options passed to `createTheme` (or `extendTheme`) where they are written out, in the same file or in constants it imports by a relative path: palette colors (`primary.main`, `background.paper`, `divider`, with dark values from `colorSchemes.dark`), the spacing unit, `shape.borderRadius` and `typography.fontFamily`. A palette built in code, or from Sass variables, is not read; neither is a theme in a test, story, mock or fixture file. Colors drive `no-hardcoded-color`, whose fixes then name the palette (`sx={{ color: 'primary.main' }}`). The spacing unit and radius are listed by `get_tokens` but do not drive the spacing and radius rules, whose scales are Tailwind's.
- **Checking.** An import from `@mui/material` or one of its modules (`import Button from "@mui/material/Button"`, under any local name) is checked against MUI's own component: invented components, props and variant values are reported as for any design system. A name `@mui/material` does not export is an invented component; one from a module of it that is not a component is not judged. With `component` set (`<Button component={Link} href="/">`), the props are those of what it renders, so they are not checked. A `Tooltip` with a string `title` names the child it wraps, as MUI does, so `<Tooltip title="Delete"><IconButton>…` has an accessible name; a JSX `title`, or `describeChild`, does not. Other MUI packages (`@mui/icons-material`, `@mui/lab`, `@mui/x-*`) are not read, and their components are not checked.
- **The project's own components win.** When the app also has components of its own (a `components/ui` folder, a `components.json`, a design-system package), those are what `list_components`, `search_components` and `get_component` offer where a name is shared, and what `prefer-design-system-component` suggests for a native element: a team that wraps MUI's `Button` wants its wrapper used. Code that imports MUI's `Button` directly is still checked against MUI's.

If `@mui/material` is a dependency but is not installed, `inspect` says so, and its components are not known until it is. At a monorepo root, a workspace package that uses MUI is a project, as one with components of its own is.

## Monorepo roots

A workspace root (a `pnpm-workspace.yaml`, `workspaces` in `package.json` for npm, Yarn and Bun, a `lerna.json`, or an `nx.json`, so Turborepo and Nx repositories too) with no design system of its own is read as the monorepo it is. Every workspace package (and with Nx, every folder with a `project.json`) goes through zero config, or its own config file, and each one where components are found is a project: the apps that use a design system, and the design-system packages themselves. `inspect` at the root lists each project with what was found in it, and the packages without one.

Each file is checked by its own project: the nearest folder at or above it with a config, a `components.json`, a `package.json` or a `project.json`, the same folder the Claude Code hook runs the check from. `check .` at the root reports exactly what `check .` in each of those folders would, file for file; the corpus checks this on Documenso, Dub, openstatus and Cal.com. Each folder's own design-system files are skipped, and one baseline at the root covers every project. The MCP server started there takes a `path` to pick the project ([tools](tools.md)), and without one lists every project's components together, each with its package.

The root stays one project, as before, when it has a design system of its own (a `components.json`, for one), when its config sets `components`, or when `--config`, `--components`, `--tokens` or `--docs` is passed. A config file at the root that does not set `components` applies to every project that has no config of its own, with its paths and `overrides` globs still relative to the root (`"files": ["apps/admin/**"]`) and `exclude` patterns that start with `**/` or with the project's folder. The list of projects is read when the server starts.

## Config file

`onsystem.config.json` (or `.mjs`, `.js`, or `.ts` on Node.js 22.18 or later) in the project root. Every field is optional; the [JSON Schema](../schema.json) gives editor completion. `npx onsystem init` writes one: the folders zero config found, or the default `components/ui` folders when they hold the components, spelled out (it leaves `components` to zero config when a package's exports name more than a few files or import paths a config cannot spell), or your answers to where the components, tokens and import path are when it found nothing. It never replaces an existing config without `--force`. At a monorepo root it writes a config with only `$schema`, for rules all projects share.

```json
{
  "$schema": "https://unpkg.com/onsystem/schema.json",
  "components": ["src/components/**/*.tsx"],
  "exclude": ["**/*.stories.tsx", "**/*.test.tsx"],
  "tokens": ["src/styles/globals.css", { "path": "tokens/*.tokens.json", "prefix": "acme" }],
  "docs": ["docs/components/**/*.mdx"],
  "importPath": "@acme/ui",
  "elements": { "a": "Link" },
  "rules": {
    "no-hardcoded-spacing": "error",
    "no-hardcoded-color": ["error", { "allow": ["#fff"] }],
    "icon-button-accessible-name": "off"
  },
  "overrides": [
    { "files": ["app/legacy/**", "**/*.generated.tsx"], "rules": { "no-hardcoded-color": "warn" } }
  ]
}
```

| Field                 | Default                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components`          | [Detected](#zero-config), else `components/ui/**/*.{tsx,jsx}`, `src/components/ui/**/*.{tsx,jsx}`                                                                                        |
| `tokens`              | Detected, else `app/globals.css`, `src/app/globals.css`, `styles/globals.css`, `src/styles/globals.css`, `src/index.css`, `app/app.css`, `**/*.tokens.json`                              |
| `docs`                | `docs/components/**/*.{md,mdx}` and `.md`/`.mdx` files next to the components                                                                                                            |
| `importPath`          | Inferred from package `exports` (`@acme/ui/button`), then `tsconfig` `paths` (`@/components/ui/button`). `@acme/ui/{path}` suggests each file by its path in its package                 |
| `includeDesignSystem` | `false`: `check` skips the component files themselves ([CI](ci.md))                                                                                                                      |
| `tsconfig`            | `tsconfig.json` in the root                                                                                                                                                              |
| `overrides`           | None. Each entry's `rules` apply over `rules` to the files its `files` globs match, relative to the root; later entries win. Unknown keys and rules are named with the closest valid one |

Paths and globs are relative to the root and use forward slashes. Windows-style backslashes (`components\ui\**\*.tsx`, `.\tsconfig.app.json`) are read as separators, except in a pattern that already uses `/`, where `\` escapes glob syntax (`app/\(marketing\)/**`). A `tsconfig` that does not exist is a config error rather than a silent fallback.

Tokens can be [W3C DTCG](https://www.designtokens.org/) JSON (`$type` inheritance, aliases, object color and dimension values, `$deprecated`, modes under `$extensions.modes`) or CSS custom properties: `:root` values, `.dark` / `[data-theme]` / `prefers-color-scheme` / `@variant dark` modes, and Tailwind v4 `@theme` mappings, with `calc()` evaluated and Tailwind's own palette resolved where a token builds on it (`--primary: var(--color-neutral-800)`). Tailwind v3 works too: bare HSL channels (`--border: 214.3 31.8% 91.4%`) are colors, and class names come from the `colors` in `tailwind.config.*` (the one `components.json` names, else the root's) and the presets it imports from the project, read without running it. When those colors cannot be read, shadcn/ui's names are used (`--sidebar-background` is `bg-sidebar`). Token stylesheets are read as one theme, so `.dark` can live in its own file; without a `:root` block the `light` mode is the base, and a dark mode never is. A DTCG file and the CSS generated from it are merged by custom property.

`elements` maps a native element to the component that replaces it (`{ "a": "Link" }`, or a key such as `input[type=checkbox]` for a non-text input type); a mapped component is treated as a drop-in, so the rename is auto-fixed.

Docs are Markdown or MDX, one file per component, matched by `component:` frontmatter, the first heading or the file name. Fenced `tsx`/`jsx` blocks become examples (`title="..."` in the fence names them); JSDoc `@example` tags work too.

CLI flags override the file: `--root`, `--config`, `--components`, `--tokens`, `--docs` (repeatable), `--no-cache`, `--no-watch`. Run `onsystem --help` for the rest.
