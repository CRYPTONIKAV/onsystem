# Design tokens

onsystem reads design tokens from stylesheets, W3C DTCG 2025.10 files and a DESIGN.md, and `onsystem export` writes the tokens it found as a DTCG file or a DESIGN.md.

## Where tokens come from

| Source                 | Zero config reads                                                                                     | In `tokens` |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ----------- |
| CSS custom properties  | The stylesheet [zero config](configuration.md#zero-config) finds, else `app/globals.css` and the like | `*.css`     |
| W3C DTCG 2025.10       | `**/*.tokens.json`                                                                                    | `*.json`    |
| DESIGN.md front matter | `DESIGN.md` in the root, only when none of the files above exist                                      | `*.md`      |

`tokens` in the [config](configuration.md#config-file), or `--tokens`, replaces what zero config reads: a `DESIGN.md` listed there is read next to the other files. `inspect --explain` shows which files were read.

## DTCG 2025.10

DTCG files are read as the [Format Module 2025.10](https://www.designtokens.org/tr/2025.10/format/) defines them, and files written to older drafts still work:

- values as objects (`{ "colorSpace": "oklch", "components": [0.205, 0, 0] }`, `{ "value": 0.5, "unit": "rem" }`) or as strings (`"#ff0000"`, `"16px"`),
- `$type` inherited from groups, `$description`, and `$deprecated`,
- aliases (`"{color.brand.500}"`) and JSON Pointers (`{ "$ref": "#/color/brand/500" }`),
- `$root` tokens: the token a group has for itself. `color.accent.$root` is referenced as `{color.accent.$root}` and its custom property is `--color-accent`,
- groups that extend another: `"$extends": "{button}"` (or JSON Schema's `"$ref": "#/button"`) gives the group every token and property of `button`, and its own tokens replace the ones at the same path. Circular extension, a reference that resolves to nothing and `$extends` that names a token are reported by `inspect` and left out.

A token is named by its path (`color.brand.500`), and its custom property is the path with dashes (`--color-brand-500`, or `--acme-color-brand-500` with `"prefix": "acme"`). Values for other themes can sit under `$extensions.modes` (`{ "dark": "#000" }`). A DTCG file and the CSS generated from it are merged by custom property.

### onsystem's extension

DTCG has no field for how code uses a token, so onsystem keeps it under `$extensions["com.github.dgesteves.onsystem"]`, which other tools ignore:

| Field      | What it holds                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `cssVar`   | The custom property code reads: `--primary`. A token with the extension and no `cssVar` has none (a Tailwind `@theme inline` value) |
| `tailwind` | The Tailwind theme variable that makes the class: `--color-primary` for `bg-primary`, `--spacing` for the spacing unit              |
| `modes`    | Values in other themes, in the form of `$value`: `{ "dark": { "colorSpace": "oklch", "components": [0.922, 0, 0] } }`               |
| `channels` | `"hsl"` when the custom property holds bare HSL channels (Tailwind v3), used as `hsl(var(--border))`                                |

## DESIGN.md

A [DESIGN.md](https://github.com/google-labs-code/design.md) describes a design system to agents: YAML front matter with tokens, then prose. onsystem reads the front matter's `colors`, `typography`, `rounded` and `spacing`, named by their path (`colors.primary`, as `{colors.primary}` references them). `components` holds styling for each component rather than tokens to pick from, and the prose is guidance for the agent, so neither is read. A spacing value without a unit (a column count) is no length, and stays out of the spacing scale.

A DESIGN.md does not say how code reads its tokens, so they have no class or custom property: `check` names the token a hardcoded color matches (`Matches token colors.primary`) without a fix, and snaps an off-scale length to the nearest step.

Hex colors must be quoted (`primary: "#1A1C1E"`): in YAML, `#` starts a comment, and `inspect` warns about the empty value.

## Export

`onsystem export` prints the project's tokens, or writes them to a file with `--out`:

```sh
npx -y onsystem export --format dtcg --out design.tokens.json
npx -y onsystem export --format design-md --out DESIGN.md
```

At a monorepo root, pass `--root` with the project to export.

### DTCG

One group per category (`color`, `spacing`, `radius`, `typography`, `shadow`, `other`), with the token's name inside it: `--primary` is `color.primary`, `--radius-md` is `radius.md`, and Tailwind's spacing unit is `spacing.$root`.

```json
{
  "color": {
    "destructive": {
      "$type": "color",
      "$value": { "colorSpace": "oklch", "components": [0.577, 0.245, 27.325] },
      "$description": "Errors and irreversible actions.",
      "$extensions": {
        "com.github.dgesteves.onsystem": {
          "cssVar": "--destructive",
          "tailwind": "--color-destructive",
          "modes": { "dark": { "colorSpace": "oklch", "components": [0.704, 0.191, 22.216] } }
        }
      }
    }
  }
}
```

- Colors are color objects in the color space they are written in; an 8-bit sRGB color also has its `hex`.
- Lengths are `{ value, unit }` in `px` or `rem`. A length computed from other tokens, such as `calc(var(--radius) - 4px)`, is written as its value in px.
- Typography tokens and shadows get their DTCG types (`fontFamily`, `fontWeight`, `dimension`, `number`, `typography`, `shadow`).
- An alias stays a reference: `--card: var(--background)` is `"{color.background}"`.
- What DTCG has no type for (`color-mix()`, a `var()` no token defines, lengths in `em` or `%`) is written as the CSS string, without `$type`.

Read back as a token source, the file gives the same tokens, named by their path: the shadcn demo's `check` reports the same findings from its exported file as from `globals.css`, with `color.destructive` where the stylesheet says `destructive`. The test suite runs this round trip.

### DESIGN.md

Front matter in the DESIGN.md schema (`version`, `name`, `colors`, `typography`, `rounded`, `spacing`), then a section per category in the format's order (Colors, Typography, Layout, Elevation & Depth, Shapes, and Other tokens), each with one sentence and a table of the tokens: their value, a column per mode, the class and custom property code uses, and the description. Values the schema cannot hold, such as a `var()` font family, are left out of the front matter and kept in the table. Aliases stay references (`"{colors.background}"`).
