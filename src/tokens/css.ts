import postcss, {
  type AtRule,
  type ChildNode,
  type Comment,
  type Container,
  type Declaration,
  type Rule,
} from 'postcss';

import { TAILWIND_PALETTE } from '../lint/tailwind-palette.js';
import type { Token, TokenCategory } from '../types.js';
import { parseColor } from './color.js';
import { usageFor } from './usage.js';

interface RawVar {
  name: string;
  value: string;
  file: string;
  line: number;
  comment?: string;
}

interface ThemeVar extends RawVar {
  inline: boolean;
}

/** What one or more stylesheets declare, before it becomes tokens. */
export interface CssSheet {
  base: Map<string, RawVar>;
  modes: Map<string, Map<string, RawVar>>;
  theme: Map<string, ThemeVar>;
  /** Namespaces cleared with `--radius-*: initial`; `*` for `--*: initial`. */
  resets: Set<string>;
  /** The first file that imports Tailwind, and so brings its default theme. */
  tailwind?: string | undefined;
}

/** Tailwind v4 theme namespaces → token category. Longest prefixes first. */
const NAMESPACES: [prefix: string, category: TokenCategory][] = [
  ['--inset-shadow-', 'shadow'],
  ['--font-weight-', 'typography'],
  ['--drop-shadow-', 'shadow'],
  ['--text-shadow-', 'shadow'],
  ['--tracking-', 'typography'],
  ['--leading-', 'typography'],
  ['--spacing-', 'spacing'],
  ['--radius-', 'radius'],
  ['--shadow-', 'shadow'],
  ['--color-', 'color'],
  ['--font-', 'typography'],
  ['--text-', 'typography'],
];

/**
 * A Tailwind v4 theme variable split into its namespace and key: `--color-primary` →
 * `--color` and `primary`, `--spacing` → `--spacing` and `''` (the spacing unit).
 */
export function themeVariable(
  name: string,
): { namespace: string; key: string; category: TokenCategory } | undefined {
  if (name === '--spacing') return { namespace: '--spacing', key: '', category: 'spacing' };
  const found = NAMESPACES.find(
    ([prefix]) => name.startsWith(prefix) && name.length > prefix.length,
  );
  return (
    found && {
      namespace: found[0].slice(0, -1),
      key: name.slice(found[0].length),
      category: found[1],
    }
  );
}

const TAILWIND_DEFAULT_SPACING = '0.25rem';
/** Tailwind v4's default `--radius-*` scale; a theme overrides keys one by one. */
const TAILWIND_DEFAULT_RADIUS: Record<string, string> = {
  xs: '0.125rem',
  sm: '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
  '2xl': '1rem',
  '3xl': '1.5rem',
  '4xl': '2rem',
};

/**
 * Reads design tokens from CSS custom properties, the way shadcn/ui and
 * Tailwind v4 projects define them:
 *
 * - `:root { --primary: oklch(...) }` holds the values,
 * - `.dark { --primary: ... }` (or a dark media query / data attribute) holds modes,
 * - `@theme inline { --color-primary: var(--primary) }` exposes them to Tailwind.
 */
export function parseCssTokens(css: string, file: string): { tokens: Token[]; warnings: string[] } {
  return cssSheetTokens([readCssSheet(css, file)]);
}

/** Collects the custom properties of one stylesheet. Throws on invalid CSS. */
export function readCssSheet(css: string, file: string): CssSheet {
  const root = postcss.parse(css, { from: file });
  const sheet: CssSheet = {
    base: new Map(),
    modes: new Map(),
    theme: new Map(),
    resets: new Set(),
  };
  const importsTailwind = root.nodes.some(
    (node) =>
      node.type === 'atrule' &&
      node.name === 'import' &&
      /["']tailwindcss(?:\/theme(?:\.css)?)?["']/.test(node.params),
  );
  if (importsTailwind) sheet.tailwind = file;

  root.walkDecls(/^--/, (decl) => {
    const raw: RawVar = {
      name: decl.prop,
      value: decl.value.trim(),
      file,
      line: decl.source?.start?.line ?? 1,
      ...withComment(decl),
    };
    const themeRule = closestAtRule(decl, 'theme');
    if (themeRule) {
      // `--color-*: initial` style resets clear Tailwind's defaults; they are not tokens.
      if (raw.value === 'initial' || raw.name.includes('*')) {
        const reset = /^--(?:([\w-]+)-)?\*$/.exec(raw.name);
        if (reset) sheet.resets.add(reset[1] ?? '*');
        return;
      }
      sheet.theme.set(raw.name, { ...raw, inline: /\binline\b/.test(themeRule.params) });
      return;
    }
    const mode = modeOf(decl);
    if (mode === undefined) return;
    if (mode === '') sheet.base.set(raw.name, raw);
    else {
      const map = sheet.modes.get(mode) ?? new Map<string, RawVar>();
      map.set(raw.name, raw);
      sheet.modes.set(mode, map);
    }
  });
  return sheet;
}

/**
 * Turns stylesheets into tokens, reading them as one theme: a `.dark` block
 * in one file is a mode of the `:root` values in another, and a namespace
 * reset applies to Tailwind's defaults whichever file imports them. When two
 * files declare the same variable, the first one wins.
 */
export function cssSheetTokens(sheets: readonly CssSheet[]): {
  tokens: Token[];
  warnings: string[];
} {
  const { base, modes, theme, resets, tailwind } = combine(sheets);
  const warnings: string[] = [];

  // Without a plain base theme (`[data-theme="light"]` and `[data-theme="dark"]`
  // only), the light mode is the base. No other mode stands in for it: a
  // `.dark` block whose light values are missing would invert every fix, and
  // `.sidebar { --sidebar-width: ... }` is a component scope, not a theme.
  const light = modes.get('light');
  for (const [name, variable] of light ?? []) {
    if (base.has(name)) continue;
    base.set(name, variable);
    light?.delete(name);
  }
  if (light && !light.size) modes.delete('light');
  // Dark values of `@theme` variables are modes of those; the rest have nothing to be a mode of.
  const orphans = [...(modes.get('dark')?.values() ?? [])].filter((v) => !theme.has(v.name));
  if (base.size === 0 && orphans.length) {
    const files = [...new Set(orphans.map((v) => v.file))].join(', ');
    warnings.push(
      `${files}: found dark-mode variables but no base theme (:root or light), so they are not used as tokens`,
    );
  }

  const lookup = (name: string): string | undefined =>
    base.get(name)?.value ?? theme.get(name)?.value ?? tailwindColor(name);

  const tokens: Token[] = [];
  const consumed = new Set<string>();
  // Tokens whose own value is `var(--other)`, by the variable they read.
  const aliases = new Map<Token, string>();
  const add = (token: Token, raw: string) => {
    tokens.push(token);
    const alias = varAlias(raw);
    if (alias) aliases.set(token, alias);
  };

  for (const variable of theme.values()) {
    const namespace = NAMESPACES.find(([prefix]) => variable.name.startsWith(prefix));
    const isSpacingBase = variable.name === '--spacing';
    if (!namespace && !isSpacingBase) continue;
    // `--text-sm--line-height` and friends are sub-properties of another token.
    if (/[a-z0-9]--[a-z]/.test(variable.name.slice(2))) continue;
    const category = isSpacingBase ? 'spacing' : (namespace?.[1] ?? 'other');
    const tailwindKey = isSpacingBase ? '' : variable.name.slice(namespace?.[0].length ?? 0);
    const tailwindNamespace = isSpacingBase ? '--spacing' : (namespace?.[0].slice(0, -1) ?? '');

    const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(variable.value)?.[1];
    const target = alias ? base.get(alias) : undefined;
    if (alias && target) {
      consumed.add(alias);
      add(
        finalize({
          name: alias.slice(2),
          category,
          value: resolveValue(target.value, lookup),
          modes: modeValues(alias, modes, lookup),
          cssVar: alias,
          tailwind: tailwindKey,
          tailwindNamespace,
          description: target.comment ?? variable.comment,
          line: target.line,
          file: target.file,
        }),
        target.value,
      );
      continue;
    }
    add(
      finalize({
        name: variable.name.slice(2),
        category,
        value: variable.value,
        modes: modeValues(variable.name, modes, lookup),
        // Inline theme variables are compiled into utilities and never emitted as custom properties.
        cssVar: variable.inline ? undefined : variable.name,
        tailwind: tailwindKey,
        tailwindNamespace,
        description: variable.comment,
        line: variable.line,
        file: variable.file,
      }),
      variable.value,
    );
  }

  for (const variable of base.values()) {
    if (consumed.has(variable.name)) continue;
    add(
      finalize({
        name: variable.name.slice(2),
        category: categorize(variable.name, resolveValue(variable.value, lookup)),
        value: resolveValue(variable.value, lookup),
        modes: modeValues(variable.name, modes, lookup),
        cssVar: variable.name,
        description: variable.comment,
        line: variable.line,
        file: variable.file,
      }),
      variable.value,
    );
  }

  // `--card: var(--background)` is an alias of the background token, which an export keeps as
  // a reference. A variable no token defines (Tailwind's palette, `next/font`) is no alias.
  const byVar = new Map(tokens.map((t) => [t.cssVar ?? `--${t.name}`, t]));
  for (const [token, name] of aliases) {
    const target = byVar.get(name);
    if (target && target !== token) token.aliasOf = target.name;
  }

  // `--spacing-*: initial` clears `--spacing` too: `p-4` no longer exists, only the named steps.
  const cleared = (namespace: string) => resets.has('*') || resets.has(namespace);
  if (tailwind && !cleared('spacing') && !theme.has('--spacing') && !base.has('--spacing')) {
    tokens.push({
      ...finalize({
        name: 'spacing',
        category: 'spacing',
        value: TAILWIND_DEFAULT_SPACING,
        cssVar: '--spacing',
        tailwind: '',
        tailwindNamespace: '--spacing',
        description: 'Tailwind spacing unit: p-4 = 4 × 0.25rem = 1rem.',
        line: 1,
        file: tailwind,
      }),
      origin: 'tailwind-default',
    });
  }
  if (tailwind && !cleared('radius')) {
    for (const [key, value] of Object.entries(TAILWIND_DEFAULT_RADIUS)) {
      if (theme.has(`--radius-${key}`)) continue;
      tokens.push({
        ...finalize({
          name: `radius-${key}`,
          category: 'radius',
          value,
          cssVar: `--radius-${key}`,
          tailwind: key,
          tailwindNamespace: '--radius',
          description: "Tailwind's default radius scale.",
          line: 1,
          file: tailwind,
        }),
        origin: 'tailwind-default',
      });
    }
  }

  return { tokens, warnings };
}

/**
 * Tailwind v4's own theme colors, which `var(--color-neutral-800)` reads
 * without the project declaring them (coss/ui and other registries build their
 * tokens on them).
 */
function tailwindColor(name: string): string | undefined {
  if (name === '--color-black') return '#000';
  if (name === '--color-white') return '#fff';
  const match = /^--color-([a-z]+)-(50|[1-9]00|950)$/.exec(name);
  return match?.[1] && match[2] ? TAILWIND_PALETTE[match[1]]?.[match[2]] : undefined;
}

/** One sheet from many (a copy: promoting the light mode edits it); the first declaration of a variable wins. */
function combine(sheets: readonly CssSheet[]): CssSheet {
  const out: CssSheet = { base: new Map(), modes: new Map(), theme: new Map(), resets: new Set() };
  const add = <V>(into: Map<string, V>, from: Map<string, V>) => {
    for (const [name, value] of from) if (!into.has(name)) into.set(name, value);
  };
  for (const sheet of sheets) {
    add(out.base, sheet.base);
    add(out.theme, sheet.theme);
    for (const [mode, vars] of sheet.modes) {
      const map = out.modes.get(mode) ?? new Map<string, RawVar>();
      add(map, vars);
      out.modes.set(mode, map);
    }
    for (const reset of sheet.resets) out.resets.add(reset);
    out.tailwind ??= sheet.tailwind;
  }
  return out;
}

function finalize(input: {
  name: string;
  category: TokenCategory;
  value: string;
  modes?: Record<string, string> | undefined;
  cssVar?: string | undefined;
  tailwind?: string | undefined;
  tailwindNamespace?: string | undefined;
  description?: string | undefined;
  line: number;
  file: string;
}): Token {
  const token: Token = {
    name: input.name,
    category: input.category,
    value: input.value,
    usage: [],
    source: { file: input.file, line: input.line },
  };
  if (input.modes && Object.keys(input.modes).length) token.modes = input.modes;
  if (input.cssVar) token.cssVar = input.cssVar;
  if (input.tailwind !== undefined) token.tailwind = input.tailwind;
  if (input.description) token.description = input.description;
  token.usage = usageFor(token, input.tailwindNamespace);
  return token;
}

function categorize(name: string, value: string): TokenCategory {
  const n = name.toLowerCase();
  if (/radius|rounded|corner/.test(n)) return 'radius';
  if (/shadow|elevation/.test(n)) return 'shadow';
  if (/spacing|space|gap|gutter|inset|padding|margin/.test(n)) return 'spacing';
  if (/font|text-size|leading|line-height|tracking|letter-spacing|typography/.test(n)) {
    return 'typography';
  }
  if (parseColor(value, { bareHsl: true })) return 'color';
  return 'other';
}

/** `--x` for a value that is exactly `var(--x)`. */
function varAlias(value: string): string | undefined {
  return /^var\(\s*(--[\w-]+)\s*\)$/.exec(value.trim())?.[1];
}

/** Follows plain `var(--x)` aliases so the token shows its concrete value. */
function resolveValue(
  value: string,
  lookup: (name: string) => string | undefined,
  depth = 0,
): string {
  const alias = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)?.[1];
  if (!alias || depth > 16) return value;
  const next = lookup(alias);
  return next === undefined ? value : resolveValue(next, lookup, depth + 1);
}

function modeValues(
  name: string,
  modes: Map<string, Map<string, RawVar>>,
  lookup: (name: string) => string | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [mode, vars] of modes) {
    const variable = vars.get(name);
    if (variable) out[mode] = resolveValue(variable.value, (n) => vars.get(n)?.value ?? lookup(n));
  }
  return Object.keys(out).length ? out : undefined;
}

function closestAtRule(node: Declaration, name: string): AtRule | undefined {
  let parent: Container | undefined = node.parent;
  while (parent) {
    if (parent.type === 'atrule' && (parent as AtRule).name === name) return parent as AtRule;
    parent = parent.parent as Container | undefined;
  }
  return undefined;
}

/**
 * The theme mode a declaration belongs to: `''` for the base theme, `"dark"`
 * for `.dark`, `[data-theme="dark"]`, `prefers-color-scheme: dark` or
 * `@variant dark`, and undefined for selectors that are not theme scopes
 * (component-level vars) or conditional overrides (`@media (min-width)`,
 * `@supports`).
 */
function modeOf(decl: Declaration): string | undefined {
  let scheme: string | undefined;
  let selector: string | undefined;
  let parent: Container | undefined = decl.parent;
  while (parent) {
    if (parent.type === 'rule') selector ??= (parent as Rule).selector;
    else if (parent.type === 'atrule') {
      const { name, params } = parent as AtRule;
      if (name === 'media') {
        const media = /prefers-color-scheme:\s*(\w+)/.exec(params)?.[1];
        if (!media) return undefined;
        scheme ??= media;
      } else if (name === 'variant') {
        if (params.trim() !== 'dark') return undefined;
        scheme ??= 'dark';
      } else if (name !== 'layer') {
        return undefined;
      }
    }
    parent = parent.parent as Container | undefined;
  }
  if (selector === undefined) return undefined;
  const parts = selector.split(',').map((s) => s.trim());
  // `:root, .light`, `html, body` and `:root:not(.dark)` all hold the base theme.
  if (parts.some((s) => /^(?::root|html|:host)(?::not\([^()]*\))?$/.test(s))) {
    return scheme === 'dark' ? 'dark' : '';
  }
  for (const part of parts) {
    const attr = /\[data-(?:theme|mode|color-scheme)\s*=\s*["']?([\w-]+)["']?\]/.exec(part)?.[1];
    if (attr) return attr;
    const cls = /^(?::root|html)?\.([\w-]+)$/.exec(part)?.[1];
    if (cls) return cls;
  }
  return undefined;
}

/**
 * The comment that describes a declaration: one that follows it on the same
 * line, else one on the lines before it. A comment on the line where the
 * previous declaration ends describes that declaration, not this one.
 */
function withComment(decl: Declaration): { comment?: string } {
  const line = decl.source?.end?.line;
  const next = decl.next();
  const trailing =
    next?.type === 'comment' && line !== undefined && next.source?.start?.line === line
      ? next
      : undefined;
  const prev = decl.prev();
  const leading = prev?.type === 'comment' && !trails(prev, prev.prev()) ? prev : undefined;
  const text = (trailing ?? leading)?.text.trim();
  return text ? { comment: text } : {};
}

/** True when `comment` sits on the line where `before` ends. */
function trails(comment: Comment, before: ChildNode | undefined): boolean {
  const line = before?.source?.end?.line;
  return line !== undefined && comment.source?.start?.line === line;
}
