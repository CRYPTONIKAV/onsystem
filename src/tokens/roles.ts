import type { Token } from '../types.js';

/**
 * What a color utility paints, which decides the tokens that fit it: `text-*`
 * wants a foreground, `bg-*` a surface, `border-*` a border color.
 */
export type ColorRole = 'text' | 'surface' | 'line';

/** The role of a Tailwind color prefix (`bg`, `text`, `border-t`); undefined for shadows and the like. */
export function colorRole(prefix: string | undefined): ColorRole | undefined {
  if (!prefix) return undefined;
  if (/^(?:text|fill|stroke|placeholder|caret|decoration)$/.test(prefix)) return 'text';
  if (/^(?:bg|from|via|to|ring-offset)$/.test(prefix)) return 'surface';
  if (/^(?:border(?:-[xytrblse])?|ring|inset-ring|outline|divide)$/.test(prefix)) return 'line';
  return undefined;
}

/**
 * Token families made for one part of the UI. `sidebar-accent` has the value
 * of `accent` and `chart-2` that of `muted-foreground`, but they only belong
 * in a sidebar or a chart. Beyond these two, any family that is not named for
 * a role and that at most one design-system file uses is scoped the same way:
 * syntax-highlighting colors (`sh-class`), a chart palette (`rainbow-4`), one
 * screen's background (`envelope-editor-background`), or a copy of Tailwind's
 * palette (`color-red-500`).
 */
export type ScopedFamily = string;

const NAMED_SCOPES = new Set(['sidebar', 'chart']);

/** Sidebar and chart, scoped by their name rather than by how little they are used. */
export function isNamedScope(family: ScopedFamily): boolean {
  return NAMED_SCOPES.has(family);
}

/**
 * First name segments of tokens meant for the whole UI: shadcn/ui's roles,
 * status colors and common DTCG names. They are never scoped by usage, since a
 * small design system may use `background` or `destructive` in one file.
 */
const CORE_FAMILIES = new Set([
  'background',
  'foreground',
  'bg',
  'fg',
  'text',
  'surface',
  'canvas',
  'card',
  'popover',
  'primary',
  'secondary',
  'tertiary',
  'muted',
  'accent',
  'brand',
  'border',
  'input',
  'ring',
  'outline',
  'divider',
  'separator',
  'overlay',
  'link',
]);

/** Name segments of status colors: what happened, rather than how it looks. */
const STATUS_WORDS = new Set([
  'destructive',
  'danger',
  'error',
  'critical',
  'negative',
  'invalid',
  'warning',
  'warn',
  'caution',
  'success',
  'positive',
  'valid',
  'info',
  'information',
  'notice',
]);

/** The family a color token belongs to: the first segment of its name (`sidebar`, `sh`, `rainbow`). */
export function tokenFamily(token: Token): string {
  return tokenKey(token).split('-')[0] ?? '';
}

/**
 * The scoped families among `tokens`: sidebar and chart, plus every family not
 * named for a role or a status whose tokens at most one file uses (`filesUsing`:
 * family → the design-system files that reference its tokens).
 */
export function scopedFamilies(
  tokens: readonly Token[],
  filesUsing: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): Set<ScopedFamily> {
  const scoped = new Set<ScopedFamily>();
  for (const token of tokens) {
    if (token.category !== 'color') continue;
    const family = tokenFamily(token);
    if (!family || scoped.has(family)) continue;
    if (NAMED_SCOPES.has(family)) scoped.add(family);
    // Without usage, only the families named for a part of the UI are scoped; nor is a token
    // code has no way to write (a DESIGN.md's: no class, no custom property), whose use is unseen.
    else if (
      filesUsing &&
      token.usage.length > 0 &&
      !CORE_FAMILIES.has(family) &&
      !STATUS_WORDS.has(family) &&
      (filesUsing.get(family)?.size ?? 0) <= 1
    ) {
      scoped.add(family);
    }
  }
  return scoped;
}

/**
 * The scoped families code mentions: `app-sidebar.tsx`, `<SidebarMenuButton>`,
 * `fill-chart-1`, `envelope-editor.tsx`. Sidebar and chart match anywhere in a
 * name; other families as a whole word of it.
 */
export function scopesIn(
  families: ReadonlySet<ScopedFamily>,
  ...texts: (string | undefined)[]
): Set<ScopedFamily> {
  const scopes = new Set<ScopedFamily>();
  for (const text of texts) {
    if (!text) continue;
    const words = new Set(
      text
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .split(/[^a-z0-9]+/),
    );
    for (const family of families) {
      const found = NAMED_SCOPES.has(family)
        ? new RegExp(family, 'i').test(text)
        : words.has(family);
      if (found) scopes.add(family);
    }
  }
  return scopes;
}

/**
 * A status color (`destructive`, `warning`, `success-foreground`): it says that
 * something failed or succeeded, so a fix may only swap it in for nearly the
 * same hue, never for a gray or a brand color.
 */
export function isStatusToken(token: Token): boolean {
  return roleKey(token)
    .split('-')
    .some((segment) => STATUS_WORDS.has(segment));
}

type Kind = 'foreground' | 'surface' | 'line' | 'other';

/** `primary` for `--color-primary`, `text-muted` for the DTCG token `color.text.muted`. */
function tokenKey(token: Token): string {
  return (token.tailwind || token.name)
    .toLowerCase()
    .replace(/[.\s_]+/g, '-')
    .replace(/^colou?rs?-/, '');
}

/** Name segments that say what a token is for, checked in this order (`card-border` is a border). */
const KIND_WORDS: [Kind, string[]][] = [
  ['foreground', ['foreground', 'fg', 'text']],
  ['line', ['border', 'input', 'ring', 'outline', 'divider', 'separator']],
  [
    'surface',
    ['background', 'bg', 'surface', 'canvas', 'card', 'popover', 'muted', 'secondary', 'accent'],
  ],
];

/**
 * The name that says what a token is for: a sidebar's own palette mirrors the
 * core one, so `sidebar-accent` is an `accent` and `sidebar-foreground` a
 * `foreground`. shadcn/ui's sidebar surface is `--sidebar` (v4) or
 * `--sidebar-background` (v3).
 */
function roleKey(token: Token): string {
  const key = tokenKey(token);
  return key === 'sidebar' ? 'background' : key.replace(/^sidebar-/, '');
}

/** What a token is for, from its name: shadcn/ui's conventions and common DTCG names. */
function kindOf(key: string): Kind {
  const segments = key.split('-');
  for (const [kind, words] of KIND_WORDS) {
    if (segments.some((s) => words.includes(s))) return kind;
  }
  return 'other';
}

/** Tokens made for each role, in the order to prefer them when their values tie. */
const PREFERRED: Record<ColorRole, string[]> = {
  text: ['foreground', 'muted-foreground'],
  surface: ['background', 'muted', 'secondary', 'accent', 'card', 'popover'],
  line: ['border', 'input', 'ring'],
};

/** Plain text colors, as opposed to the text that goes on one surface (`card-foreground`). */
const GENERIC_TEXT =
  /^(?:muted-foreground|(?:foreground|text|fg)(?:-(?:default|base|primary|secondary|muted|subtle))?)$/;

export interface RoleFit {
  /**
   * 0: made for the role (`foreground` for text, `muted` for a background,
   * `border` for a border). 1: neutral to it (brand and status colors, the
   * text of a surface such as `primary-foreground`). 2: made for another
   * role (`text-border`, `bg-foreground`), never swapped in automatically.
   */
  tier: 0 | 1 | 2;
  /** Position among the role's preferred tokens, for ties. */
  rank: number;
}

export function roleFit(token: Token, role: ColorRole | undefined): RoleFit {
  if (!role) return { tier: 1, rank: 0 };
  const key = roleKey(token);
  const index = PREFERRED[role].indexOf(key);
  const rank = index === -1 ? PREFERRED[role].length : index;
  const kind = kindOf(key);
  switch (role) {
    case 'text':
      if (kind === 'foreground') return { tier: GENERIC_TEXT.test(key) ? 0 : 1, rank };
      return { tier: kind === 'other' ? 1 : 2, rank };
    case 'surface':
      return { tier: kind === 'surface' ? 0 : kind === 'foreground' ? 2 : 1, rank };
    case 'line':
      return { tier: kind === 'line' ? 0 : kind === 'other' ? 1 : 2, rank };
  }
}
