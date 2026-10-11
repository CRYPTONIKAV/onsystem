import fs from 'node:fs/promises';
import path from 'node:path';

import type { Token, TokenCategory } from '../types.js';
import { relativePath } from '../util/paths.js';
import {
  CLOSE_COLOR,
  colorDistance,
  hueDistance,
  isTinted,
  parseColor,
  sameHue,
  STATUS_HUE_TOLERANCE,
  type Oklch,
} from './color.js';
import { cssSheetTokens, readCssSheet, type CssSheet } from './css.js';
import { parseDtcgTokens, type DtcgOptions } from './dtcg.js';
import {
  isNamedScope,
  isStatusToken,
  roleFit,
  scopedFamilies,
  tokenFamily,
  type ColorRole,
  type RoleFit,
  type ScopedFamily,
} from './roles.js';
import { evaluateLength, lengthToPx } from './units.js';

export { parseCssTokens } from './css.js';
export { parseDtcgTokens } from './dtcg.js';

export interface TokenSource {
  file: string;
  /** DTCG only: prefix for generated custom property names. */
  prefix?: string | undefined;
}

export async function loadTokens(
  root: string,
  sources: TokenSource[],
): Promise<{ tokens: Token[]; warnings: string[] }> {
  const warnings: string[] = [];
  const all: Token[] = [];
  // Stylesheets form one theme (`.dark` in one file, `:root` in another), so
  // they become tokens together, where the first of them was listed.
  const sheets: CssSheet[] = [];
  let sheetsAt: number | undefined;
  for (const source of sources) {
    const rel = relativePath(root, source.file);
    let text: string;
    try {
      text = await fs.readFile(source.file, 'utf8');
    } catch {
      warnings.push(`${rel}: token file not found`);
      continue;
    }
    const ext = path.extname(source.file).toLowerCase();
    try {
      if (ext === '.json') {
        const options: DtcgOptions = source.prefix ? { prefix: source.prefix } : {};
        const result = parseDtcgTokens(text, rel, options);
        all.push(...result.tokens);
        warnings.push(...result.warnings);
      } else {
        sheets.push(readCssSheet(text, rel));
        sheetsAt ??= all.length;
      }
    } catch (error) {
      warnings.push(`${rel}: could not parse tokens (${(error as Error).message})`);
    }
  }
  if (sheets.length) {
    const result = cssSheetTokens(sheets);
    all.splice(sheetsAt ?? all.length, 0, ...result.tokens);
    warnings.push(...result.warnings);
  }
  return { tokens: mergeTokens(all), warnings };
}

/**
 * DTCG files and the CSS generated from them often describe the same tokens.
 * Merge entries that share a custom property: keep the DTCG name and
 * description, and add the Tailwind mapping from CSS.
 */
export function mergeTokens(tokens: Token[]): Token[] {
  // Tailwind's built-in defaults (`--spacing`) only stand in until the project
  // sets its own value, in whichever file that is.
  const overridden = new Set(
    tokens.filter((t) => t.origin !== 'tailwind-default').map((t) => themeKey(t)),
  );
  const byVar = new Map<string, Token>();
  const out: Token[] = [];
  for (const token of tokens) {
    if (token.origin === 'tailwind-default' && overridden.has(themeKey(token))) continue;
    const existing = token.cssVar ? byVar.get(token.cssVar) : undefined;
    if (!existing) {
      if (token.cssVar) byVar.set(token.cssVar, token);
      out.push(token);
      continue;
    }
    if (existing.tailwind === undefined && token.tailwind !== undefined) {
      existing.tailwind = token.tailwind;
    }
    existing.usage = [...new Set([...token.usage, ...existing.usage])];
    existing.description ??= token.description;
    if (token.modes) existing.modes = { ...token.modes, ...existing.modes };
  }
  return out;
}

/** `spacing:` for `--spacing`, `radius:md` for `--radius-md`: what a Tailwind class resolves to. */
function themeKey(token: Token): string {
  return token.tailwind === undefined ? '' : `${token.category}:${token.tailwind}`;
}

export interface ColorCandidate {
  token: Token;
  color: Oklch;
  /** Values in other theme modes (`dark`), where the token has one. */
  modes?: Record<string, Oklch>;
}

export interface LengthCandidate {
  token: Token;
  px: number;
  /** Tailwind key for the step (`3` for `p-3`, `md` for `rounded-md`), if any. */
  key?: string;
}

export interface Nearest<T> {
  candidate: T;
  distance: number;
}

export interface ColorQuery {
  /** What the color paints: `text-*` is best served by a foreground, `bg-*` by a surface. */
  role?: ColorRole | undefined;
  /** The scoped families the code is in (`sidebar` in `app-sidebar.tsx`), whose tokens then compete like any other. */
  scopes?: ReadonlySet<ScopedFamily> | undefined;
  /** Whether the color is a hue rather than a gray. Default: from its chroma. */
  tinted?: boolean | undefined;
  /** The theme mode the color applies in (`dark` for `dark:bg-*`): tokens are compared by their value there. */
  mode?: string | undefined;
}

export interface ColorSuggestion {
  /** A token that can replace the color as is: close, of the same hue (or both gray), and not made for another role. */
  match?: Nearest<ColorCandidate> | undefined;
  /** The token to name: the match, else the nearest, preferring the same hue and the role. */
  nearest: Nearest<ColorCandidate>;
  /**
   * Why the nearest token is no match: no token of its hue (or no gray), too far,
   * made for another role, a status color whose hue is not close enough, or a
   * token of a family scoped to another part of the UI.
   */
  reason?: 'far' | 'hue' | 'role' | 'status' | 'scoped' | undefined;
  /** With reason `status`: how far apart the hues are, in degrees. */
  hueOff?: number | undefined;
  /** Other tokens with the nearest one's value. */
  sameValue: Token[];
}

export interface NearestLength extends Nearest<LengthCandidate> {
  /** A radius so far above the scale that it means "fully rounded" (`rounded-full`). */
  pill?: boolean;
}

/** Radius values from here up are pills (`9999px`, `rounded-full`), not sizes. */
const PILL_PX = 1000;
/**
 * A radius this many times the largest finite step reads as "fully rounded":
 * `rounded-[100px]` or `[999px]` is a pill, not a large `rounded-4xl`.
 */
const PILL_FACTOR = 3;

/**
 * `rounded-full` is a static utility rather than a theme variable. 9999px is
 * the conventional way to write it by hand (and its Tailwind v3 value).
 */
const ROUNDED_FULL: Token = {
  name: 'radius-full',
  category: 'radius',
  value: 'calc(infinity * 1px)',
  tailwind: 'full',
  usage: ['rounded-full'],
  origin: 'tailwind-default',
  source: { file: '', line: 0 },
};

/** Query helpers over the token list: lookups and nearest-token search. */
export class TokenIndex {
  readonly colors: ColorCandidate[] = [];
  readonly spacing: LengthCandidate[] = [];
  readonly radius: LengthCandidate[] = [];
  /** Tailwind color keys the design system defines (`primary`, `muted-foreground`). */
  readonly colorKeys = new Set<string>();
  /** Base unit when spacing follows Tailwind's multiplier model. */
  readonly spacingUnitPx: number | undefined;
  private readonly spacingUnit: Token | undefined;
  private readonly byVar = new Map<string, Token>();
  /** Families suggested only in their own part of the UI (`sidebar`, `chart`, `sh`). */
  readonly scopedFamilies: ReadonlySet<ScopedFamily>;
  /** Family → the design-system files that use its tokens. */
  readonly familyFiles: ReadonlyMap<string, ReadonlySet<string>>;

  /**
   * `filesUsing` maps each token family to the design-system files that use it;
   * a family that at most one of them uses is scoped. Without it, only sidebar
   * and chart are.
   */
  constructor(
    readonly tokens: Token[],
    options: { filesUsing?: ReadonlyMap<string, ReadonlySet<string>> | undefined } = {},
  ) {
    this.scopedFamilies = scopedFamilies(tokens, options.filesUsing);
    this.familyFiles = options.filesUsing ?? new Map();
    for (const token of tokens) if (token.cssVar) this.byVar.set(token.cssVar, token);
    const resolve = (name: string) => this.byVar.get(name)?.value;

    let unit: number | undefined;
    for (const token of tokens) {
      if (token.category === 'color') {
        const color = parseColor(token.value, { bareHsl: true });
        if (color) this.colors.push({ token, color, ...colorModes(token) });
        if (token.tailwind) this.colorKeys.add(token.tailwind);
      } else if (
        (token.category === 'spacing' || token.category === 'radius') &&
        token.origin !== 'library'
      ) {
        const px = evaluateLength(token.value, resolve);
        if (px === undefined) continue;
        if (token.category === 'spacing' && token.tailwind === '') {
          unit = px;
          continue;
        }
        const list = token.category === 'spacing' ? this.spacing : this.radius;
        const candidate: LengthCandidate = { token, px };
        if (token.tailwind) candidate.key = token.tailwind;
        list.push(candidate);
      }
    }
    this.spacingUnitPx = unit;
    if (unit !== undefined) {
      this.spacingUnit = tokens.find((t) => t.category === 'spacing' && t.tailwind === '');
    }
    if (this.radius.some((c) => c.key !== undefined)) {
      this.radius.push({ token: ROUNDED_FULL, px: 9999, key: 'full' });
    }
  }

  has(category: TokenCategory): boolean {
    if (category === 'color') return this.colors.length > 0;
    if (category === 'spacing') return this.spacing.length > 0 || this.spacingUnit !== undefined;
    if (category === 'radius') return this.radius.length > 0;
    return this.tokens.some((t) => t.category === category);
  }

  byCssVar(name: string): Token | undefined {
    return this.byVar.get(name);
  }

  /** The scoped family a token belongs to, if any. */
  scopedFamilyOf(token: Token): ScopedFamily | undefined {
    if (token.category !== 'color') return undefined;
    const family = tokenFamily(token);
    return this.scopedFamilies.has(family) ? family : undefined;
  }

  nearestColor(color: Oklch, limit = 3): Nearest<ColorCandidate>[] {
    return this.colors
      .map((candidate) => ({ candidate, distance: colorDistance(color, candidate.color) }))
      .sort(
        (a, b) => a.distance - b.distance || preferTailwind(a.candidate.token, b.candidate.token),
      )
      .slice(0, limit);
  }

  /**
   * The token to suggest for a color. Perceptual distance alone picks badly:
   * several tokens share a value (`muted`, `accent`, `sidebar-accent`,
   * `chart-2`...), and a pale yellow sits 0.07 from a light gray. So among the
   * tokens close enough to swap in, of the same hue, it prefers the ones made
   * for the role (`muted-foreground` for `text-gray-500`), and sidebar and
   * chart tokens only in a sidebar or a chart.
   */
  suggestColor(color: Oklch, query: ColorQuery = {}): ColorSuggestion | undefined {
    const valueOf = (candidate: ColorCandidate) =>
      (query.mode && candidate.modes?.[query.mode]) || candidate.color;
    const tinted = query.tinted ?? isTinted(color);
    const scored: Scored[] = this.colors.map((candidate, index) => {
      const family = this.scopedFamilyOf(candidate.token);
      const value = valueOf(candidate);
      const hue = sameHue(color, value, tinted);
      // A status color replaces only a color of nearly its hue: never a gray, a brand orange
      // for `destructive` or a gray for `destructive-foreground`.
      const status = isStatusToken(candidate.token);
      return {
        candidate,
        distance: colorDistance(color, value),
        hue: status ? tinted && hue && hueDistance(color, value) <= STATUS_HUE_TOLERANCE : hue,
        looseHue: hue,
        status,
        fit: roleFit(candidate.token, query.role),
        scoped: family !== undefined && !query.scopes?.has(family),
        inScope: family !== undefined && query.scopes?.has(family) === true,
        // Out of scope, and scoped by usage: syntax colors are never swapped in elsewhere.
        foreign: family !== undefined && !query.scopes?.has(family) && !isNamedScope(family),
        index,
      };
    });
    // Scoped families stand in only for a design system made of nothing else, and then only
    // sidebar and chart as fixes: a design system whose only colors are syntax colors gets none.
    const pool = scored.some((s) => !s.scoped) ? scored.filter((s) => !s.scoped) : scored;
    const match = pool
      .filter((s) => s.hue && !s.foreign && s.fit.tier < 2 && s.distance < CLOSE_COLOR)
      .sort((a, b) => a.fit.tier - b.fit.tier || byDistance(a, b))[0];
    const named =
      match ??
      [...pool].sort(
        (a, b) =>
          Number(b.hue) - Number(a.hue) ||
          Number(a.fit.tier === 2) - Number(b.fit.tier === 2) ||
          byDistance(a, b),
      )[0];
    if (!named) return undefined;
    const sameValue = pool
      .filter(
        (s) => s !== named && colorDistance(valueOf(s.candidate), valueOf(named.candidate)) < 1e-4,
      )
      .map((s) => s.candidate.token);
    const nearest = { candidate: named.candidate, distance: named.distance };
    if (match) return { match: nearest, nearest, sameValue };
    // The nearest token of the same hue comes first, so another hue means the design system has none.
    if (!named.hue && named.status && named.looseHue && tinted) {
      const hueOff = Math.round(hueDistance(color, valueOf(named.candidate)));
      return { nearest, reason: 'status', hueOff, sameValue };
    }
    const reason = !named.hue
      ? 'hue'
      : named.distance >= CLOSE_COLOR
        ? 'far'
        : named.foreign
          ? 'scoped'
          : 'role';
    return { nearest, reason, sameValue };
  }

  /** The step closest to the magnitude of `px`; callers keep the sign. */
  nearestLength(category: 'spacing' | 'radius', px: number): NearestLength | undefined {
    const target = Math.abs(px);
    let list =
      category === 'spacing' ? [...this.spacing, ...this.spacingSteps(target)] : this.radius;
    let pill = false;
    if (category === 'radius') {
      // Far above the largest finite step, a radius means "fully rounded":
      // the pill tokens are the answer, and below that they never are.
      const finite = list.filter((c) => c.px < PILL_PX);
      const pills = list.filter((c) => c.px >= PILL_PX);
      const largest = Math.max(0, ...finite.map((c) => c.px));
      pill =
        pills.length > 0 &&
        finite.length > 0 &&
        (target >= PILL_FACTOR * largest || target >= PILL_PX);
      list = pill || !finite.length ? pills : finite;
    }
    let best: NearestLength | undefined;
    for (const candidate of list) {
      const distance = Math.abs(candidate.px - target);
      if (
        !best ||
        distance < best.distance - 1e-9 ||
        (Math.abs(distance - best.distance) < 1e-9 &&
          preferTailwind(candidate.token, best.candidate.token) < 0)
      ) {
        best = { candidate, distance };
      }
    }
    if (best && pill) best.pill = true;
    return best;
  }

  /**
   * Tailwind v4 derives `p-<n>` from `--spacing` for any n. Whole and half
   * steps (`p-13`, `p-4.5`) count as the scale, plus the static `p-px`;
   * quarter steps are valid but off-grid, like the arbitrary values they replace.
   */
  private spacingSteps(px: number): LengthCandidate[] {
    const unit = this.spacingUnitPx;
    const token = this.spacingUnit;
    if (!unit || !token) return [];
    const lower = Math.floor((px / unit) * 2) / 2;
    const upper = Math.ceil((px / unit) * 2) / 2;
    return [
      { token, px: 1, key: 'px' },
      ...[...new Set([lower, upper])].map((n) => ({ token, px: n * unit, key: String(n) })),
    ];
  }

  /** px value of a token-like length string, resolving `var()` against the token set. */
  toPx(value: string): number | undefined {
    return lengthToPx(value) ?? evaluateLength(value, (name) => this.byVar.get(name)?.value);
  }
}

function colorModes(token: Token): { modes?: Record<string, Oklch> } {
  const modes: Record<string, Oklch> = {};
  for (const [mode, value] of Object.entries(token.modes ?? {})) {
    const color = parseColor(value, { bareHsl: true });
    if (color) modes[mode] = color;
  }
  return Object.keys(modes).length ? { modes } : {};
}

function preferTailwind(a: Token, b: Token): number {
  return Number(b.tailwind !== undefined) - Number(a.tailwind !== undefined);
}

interface Scored extends Nearest<ColorCandidate> {
  /** Of the same hue, as tightly as the token needs (status colors more tightly). */
  hue: boolean;
  /** Of the same hue by the general tolerance. */
  looseHue: boolean;
  /** Of a family scoped by usage to another part of the UI. */
  foreign: boolean;
  status: boolean;
  fit: RoleFit;
  /** Of a scoped family the code is not in (a sidebar token outside the sidebar). */
  scoped: boolean;
  /** Of the scoped family the code is in. */
  inScope: boolean;
  index: number;
}

/**
 * Nearest first; equal values by the family the code is in (`sidebar-accent`
 * in a sidebar), the role's preference, Tailwind classes, then declaration order.
 */
function byDistance(a: Scored, b: Scored): number {
  return (
    Math.round(a.distance * 1e4) - Math.round(b.distance * 1e4) ||
    Number(b.inScope) - Number(a.inScope) ||
    a.fit.rank - b.fit.rank ||
    preferTailwind(a.candidate.token, b.candidate.token) ||
    a.index - b.index
  );
}
