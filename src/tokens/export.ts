import { converter, formatHex, parse, type Color } from 'culori';
import { stringify } from 'yaml';

import { TOKEN_CATEGORIES, type Token, type TokenCategory } from '../types.js';
import { isBareHsl, parseColor } from './color.js';
import { ONSYSTEM_EXTENSION, type Json, type JsonObject, type OnsystemExtension } from './dtcg.js';
import { evaluateLength } from './units.js';
import { cssReference } from './usage.js';

/**
 * Writes the tokens onsystem found as a DTCG 2025.10 file or a DESIGN.md. Both are grouped by
 * category; reading the DTCG file back gives the same tokens, with names that are its paths.
 */

export interface Exported {
  text: string;
  /** How many tokens were written. */
  count: number;
  /** Tokens left out, and why. */
  warnings: string[];
}

/** Group names a DTCG or DESIGN.md token path may already start with, per category. */
const GROUP_NAMES: Record<TokenCategory, readonly string[]> = {
  color: ['color', 'colors', 'colour', 'colours'],
  spacing: ['spacing', 'space'],
  radius: ['radius', 'radii', 'rounded'],
  typography: ['typography', 'font', 'fonts'],
  shadow: ['shadow', 'shadows', 'elevation'],
  other: [],
};

// ─── DTCG ───────────────────────────────────────────────────────────────────

/**
 * The tokens as a DTCG 2025.10 file: a group per category, colors as color objects in their
 * own color space, lengths as `{ value, unit }`, aliases as references, and what DTCG has no
 * field for (the custom property, the Tailwind theme variable, dark and other modes) under
 * `$extensions["com.github.dgesteves.onsystem"]`.
 */
export function toDtcg(tokens: readonly Token[]): Exported {
  const warnings: string[] = [];
  const paths = assignPaths(tokens, warnings);
  const lookup = varLookup(tokens);
  const byName = new Map(tokens.map((t) => [t.name, t]));
  const tree: JsonObject = {};
  let count = 0;
  for (const category of TOKEN_CATEGORIES) {
    for (const token of tokens) {
      const path = token.category === category ? paths.get(token) : undefined;
      if (!path) continue;
      const own = typed(token.value, token, lookup);
      const target = token.aliasOf ? byName.get(token.aliasOf) : undefined;
      const targetPath = target ? paths.get(target) : undefined;
      const node: JsonObject = {};
      const type = target && targetPath ? typed(target.value, target, lookup).type : own.type;
      if (type) node.$type = type;
      node.$value = targetPath ? `{${targetPath.join('.')}}` : own.value;
      if (token.description) node.$description = token.description;
      if (token.deprecated) node.$deprecated = token.deprecated;
      const extension: OnsystemExtension = {};
      if (token.cssVar) extension.cssVar = token.cssVar;
      const tailwind = tailwindVariable(token);
      if (tailwind) extension.tailwind = tailwind;
      if (own.channels) extension.channels = 'hsl';
      if (token.modes && Object.keys(token.modes).length) {
        extension.modes = Object.fromEntries(
          Object.entries(token.modes).map(([mode, value]) => [
            mode,
            typed(value, token, lookup).value,
          ]),
        );
      }
      if (Object.keys(extension).length) {
        node.$extensions = { [ONSYSTEM_EXTENSION]: extension as JsonObject };
      }
      insert(tree, path, node);
      count++;
    }
  }
  // Arrays of numbers and strings (color components, font stacks) on one line.
  const text = JSON.stringify(tree, null, 2).replace(
    /\[\n\s*([^[\]{}]*?)\n\s*\]/g,
    (_, items: string) => `[${items.split(/,\n\s*/).join(', ')}]`,
  );
  return { text: `${text}\n`, count, warnings };
}

/**
 * Each token's path: its category, then its name without that category (`primary` →
 * `color.primary`, `radius-md` → `radius.md`, `color.brand.500` as it is). The spacing unit,
 * named like its group, is the group's `$root`; so is a token whose path is also a group.
 */
function assignPaths(tokens: readonly Token[], warnings: string[]): Map<Token, string[]> {
  const out = new Map<Token, string[]>();
  const taken = new Set<string>();
  const key = (path: string[]) => JSON.stringify(path);
  for (const token of tokens) {
    const path = [
      [token.category, ...leaf(token)],
      [token.category, ...token.name.split('.')],
    ].find((p) => !taken.has(key(p)));
    if (!path) {
      warnings.push(`${token.name} is left out: another token has the same path`);
      continue;
    }
    taken.add(key(path));
    out.set(token, path);
  }
  const groups = new Set<string>();
  for (const path of out.values()) {
    for (let i = 1; i < path.length; i++) groups.add(key(path.slice(0, i)));
  }
  for (const [token, path] of out) {
    if (!groups.has(key(path))) continue;
    const root = [...path, '$root'];
    if (taken.has(key(root))) {
      warnings.push(`${token.name} is left out: another token has the same path`);
      out.delete(token);
      continue;
    }
    taken.add(key(root));
    out.set(token, root);
  }
  return out;
}

/** A token's path within its category group. */
function leaf(token: Token): string[] {
  const group = token.category;
  if (token.name.includes('.')) {
    const parts = token.name.split('.');
    const [first = ''] = parts;
    return parts.length > 1 && GROUP_NAMES[group].includes(first.toLowerCase())
      ? parts.slice(1)
      : parts;
  }
  if (token.name.startsWith(`${group}-`)) return [token.name.slice(group.length + 1)];
  if (token.name !== group) return [token.name];
  return [token.tailwind || '$root'];
}

function insert(tree: JsonObject, path: string[], node: JsonObject): void {
  let group = tree;
  for (const key of path.slice(0, -1)) {
    const next = group[key];
    if (isObject(next)) {
      group = next;
    } else {
      const created: JsonObject = {};
      group[key] = created;
      group = created;
    }
  }
  group[path.at(-1) ?? ''] = node;
}

/**
 * The Tailwind theme variable a token is exposed through: `--color-primary` for `bg-primary`,
 * `--spacing` for the spacing unit. Tailwind v3 colors come from its config, and read the same.
 */
function tailwindVariable(token: Token): string | undefined {
  const key = token.tailwind;
  if (key === undefined) return undefined;
  const utility = token.usage.find((u) => !u.includes('(')) ?? '';
  switch (token.category) {
    case 'color':
      return `--color-${key}`;
    case 'spacing':
      return key ? `--spacing-${key}` : '--spacing';
    case 'radius':
      return `--radius-${key}`;
    case 'shadow': {
      const namespace = /^(inset-shadow|drop-shadow|text-shadow|shadow)-/.exec(utility)?.[1];
      return `--${namespace ?? 'shadow'}-${key}`;
    }
    case 'typography': {
      const kind = typographyKind(token);
      if (kind === 'fontWeight') return `--font-weight-${key}`;
      if (kind === 'fontFamily') return `--font-${key}`;
      if (kind === 'lineHeight') return `--leading-${key}`;
      if (kind === 'letterSpacing') return `--tracking-${key}`;
      if (kind === 'fontSize') return `--text-${key}`;
      return undefined;
    }
    default:
      return undefined;
  }
}

// ─── Values ─────────────────────────────────────────────────────────────────

interface Typed {
  type?: string;
  value: Json;
  /** The CSS value is bare HSL channels (Tailwind v3). */
  channels?: boolean;
}

type Lookup = (name: string) => string | undefined;

/** Custom property → value, for lengths that read another token (`calc(var(--radius) - 4px)`). */
function varLookup(tokens: readonly Token[]): Lookup {
  const values = new Map<string, string>();
  for (const token of tokens) values.set(token.cssVar ?? `--${token.name}`, token.value);
  return (name) => values.get(name);
}

/**
 * A CSS value in DTCG form. Values DTCG has no type for (`color-mix()`, `var()` without a
 * token, lengths in `em` or `%`) stay strings without `$type`, which onsystem reads back as is.
 */
function typed(value: string, token: Token, lookup: Lookup): Typed {
  switch (token.category) {
    case 'color':
      return colorValue(value);
    case 'spacing':
    case 'radius':
      return dimensionValue(value, lookup) ?? { value };
    case 'typography':
      return typographyValue(value, token) ?? { value };
    case 'shadow': {
      const shadow = shadowValue(value);
      return shadow ? { type: 'shadow', value: shadow } : { value };
    }
    default:
      return { value };
  }
}

function colorValue(value: string): Typed {
  // Keywords (`transparent`, `currentColor`) and `var()` are no color onsystem compares with.
  if (!parseColor(value, { bareHsl: true })) return { value };
  const bare = isBareHsl(value);
  const color = colorObject(bare ? `hsl(${value.replace(/,/g, ' ')})` : value);
  if (!color) return { value };
  return bare ? { type: 'color', value: color, channels: true } : { type: 'color', value: color };
}

/** culori mode → DTCG color space, its channels, and the factor from culori's range to DTCG's. */
const COLOR_SPACES: Record<string, { space: string; channels: string[]; scale?: number[] }> = {
  rgb: { space: 'srgb', channels: ['r', 'g', 'b'] },
  lrgb: { space: 'srgb-linear', channels: ['r', 'g', 'b'] },
  hsl: { space: 'hsl', channels: ['h', 's', 'l'], scale: [1, 100, 100] },
  hwb: { space: 'hwb', channels: ['h', 'w', 'b'], scale: [1, 100, 100] },
  lab: { space: 'lab', channels: ['l', 'a', 'b'] },
  lch: { space: 'lch', channels: ['l', 'c', 'h'] },
  oklab: { space: 'oklab', channels: ['l', 'a', 'b'] },
  oklch: { space: 'oklch', channels: ['l', 'c', 'h'] },
  p3: { space: 'display-p3', channels: ['r', 'g', 'b'] },
  a98: { space: 'a98-rgb', channels: ['r', 'g', 'b'] },
  prophoto: { space: 'prophoto-rgb', channels: ['r', 'g', 'b'] },
  rec2020: { space: 'rec2020', channels: ['r', 'g', 'b'] },
  xyz65: { space: 'xyz-d65', channels: ['x', 'y', 'z'] },
  xyz50: { space: 'xyz-d50', channels: ['x', 'y', 'z'] },
};
const toOklch = converter('oklch');

/**
 * A CSS color as a DTCG color object, in the color space it is written in (others in OKLCH).
 * An 8-bit sRGB color also gets its `hex`.
 */
function colorObject(css: string): JsonObject | undefined {
  const parsed = parse(css);
  if (!parsed) return undefined;
  const known = COLOR_SPACES[parsed.mode];
  const color: Color = known ? parsed : toOklch(parsed);
  const spec = known ?? { space: 'oklch', channels: ['l', 'c', 'h'] };
  const channels = color as unknown as Record<string, number | undefined>;
  const components: Json[] = spec.channels.map((channel, i) => {
    const v = channels[channel];
    return v === undefined || Number.isNaN(v) ? 'none' : round(v * (spec.scale?.[i] ?? 1));
  });
  const out: JsonObject = { colorSpace: spec.space, components };
  const alpha = color.alpha;
  if (alpha !== undefined && alpha < 1) out.alpha = round(alpha);
  else if (
    spec.space === 'srgb' &&
    components.every((c) => typeof c === 'number' && Math.abs(c * 255 - Math.round(c * 255)) < 1e-3)
  ) {
    out.hex = formatHex(color);
  }
  return out;
}

const PLAIN_LENGTH = /^(-?(?:\d+\.?\d*|\.\d+))(px|rem)$/;

/** `0.5rem` → `{ value: 0.5, unit: "rem" }`; a `calc()` of tokens → its px value. */
function dimensionValue(value: string, lookup: Lookup): Typed | undefined {
  const plain = plainDimension(value);
  if (plain) return { type: 'dimension', value: plain };
  const px = evaluateLength(value, lookup);
  if (px === undefined || !Number.isFinite(px)) return undefined;
  return { type: 'dimension', value: { value: round(px), unit: 'px' } };
}

function plainDimension(value: string): JsonObject | undefined {
  const text = value.trim();
  if (text === '0') return { value: 0, unit: 'px' };
  const match = PLAIN_LENGTH.exec(text);
  return match ? { value: Number(match[1]), unit: match[2] ?? 'px' } : undefined;
}

type TypographyKind =
  'fontFamily' | 'fontWeight' | 'fontSize' | 'lineHeight' | 'letterSpacing' | 'composite';

const COMPOSITE = /^[\w-]+\s*:\s*[^;]+(?:;\s*[\w-]+\s*:\s*[^;]+)*;?$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)$/;

/** What a typography token sets, from its name and Tailwind class (`font-sans`, `text-sm`). */
function typographyKind(token: Token): TypographyKind | undefined {
  const value = token.value.trim();
  if (COMPOSITE.test(value)) return 'composite';
  const utility = token.usage.find((u) => !u.includes('(')) ?? '';
  const name = `${token.name} ${utility}`.toLowerCase();
  if (/weight/.test(name) || (utility.startsWith('font-') && /^\d+$/.test(value))) {
    return 'fontWeight';
  }
  if (/leading|line-?height/.test(name)) return 'lineHeight';
  if (/tracking|letter-?spacing/.test(name)) return 'letterSpacing';
  if (/(?:^|[\s.-])text-|size/.test(name)) return 'fontSize';
  if (/font|family/.test(name)) return 'fontFamily';
  return undefined;
}

function typographyValue(value: string, token: Token): Typed | undefined {
  const text = value.trim();
  switch (typographyKind(token)) {
    case 'fontFamily':
      return { type: 'fontFamily', value: fontFamilies(text) };
    case 'fontWeight': {
      const n = weight(text);
      return n === undefined ? undefined : { type: 'fontWeight', value: n };
    }
    case 'lineHeight': {
      if (NUMBER.test(text)) return { type: 'number', value: Number(text) };
      const length = plainDimension(text);
      return length && { type: 'dimension', value: length };
    }
    case 'fontSize':
    case 'letterSpacing': {
      const length = plainDimension(text);
      return length && { type: 'dimension', value: length };
    }
    case 'composite':
      return { type: 'typography', value: composite(text) };
    default:
      return undefined;
  }
}

/** `fontFamily: Inter; fontSize: 16px` → `{ fontFamily: "Inter", fontSize: { value: 16, unit: "px" } }`. */
function composite(text: string): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of pairs(text)) {
    if (key === 'fontFamily') out[key] = fontFamilies(value);
    else if (key === 'fontWeight') out[key] = weight(value) ?? value;
    else if (key === 'lineHeight' && NUMBER.test(value)) out[key] = Number(value);
    else out[key] = plainDimension(value) ?? value;
  }
  return out;
}

/** `fontFamily: Inter; fontSize: 16px` → `[["fontFamily", "Inter"], ["fontSize", "16px"]]`. */
function pairs(text: string): [string, string][] {
  return text.split(';').flatMap((part): [string, string][] => {
    const colon = part.indexOf(':');
    const key = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    return colon > 0 && key && value ? [[key, value]] : [];
  });
}

function weight(value: string): number | undefined {
  const n = Number(value);
  return /^\d+$/.test(value) && n >= 1 && n <= 1000 ? n : undefined;
}

/** `"Geist", ui-sans-serif` → `["Geist", "ui-sans-serif"]`; one family, or a `var()`, stays a string. */
function fontFamilies(value: string): Json {
  if (value.includes('var(')) return value;
  const families = splitTopLevel(value, ',')
    .map((f) => f.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .filter(Boolean);
  return families.length === 1 ? (families[0] ?? value) : families;
}

/** `0 1px 2px 0 rgb(0 0 0 / 0.05)` → a DTCG shadow object; several layers → an array of them. */
function shadowValue(value: string): Json | undefined {
  const layers: JsonObject[] = [];
  for (const layer of splitTopLevel(value, ',')) {
    let inset = false;
    let color: JsonObject | undefined;
    const lengths: JsonObject[] = [];
    for (const part of splitTopLevel(layer.trim(), ' ')) {
      if (!part) continue;
      const length = plainDimension(part);
      if (part === 'inset') inset = true;
      else if (length) lengths.push(length);
      else if (!color && parseColor(part)) color = colorObject(part);
      else return undefined;
    }
    const [offsetX, offsetY, blur = zero(), spread = zero()] = lengths;
    if (!color || !offsetX || !offsetY || lengths.length > 4) return undefined;
    layers.push({ color, offsetX, offsetY, blur, spread, ...(inset ? { inset: true } : {}) });
  }
  if (!layers.length) return undefined;
  return layers.length === 1 ? (layers[0] ?? null) : layers;
}

function zero(): JsonObject {
  return { value: 0, unit: 'px' };
}

/** Splits on `separator` outside parentheses and quotes. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && (separator === ' ' ? /\s/.test(ch ?? '') : ch === separator)) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function round(n: number): number {
  return Number(n.toFixed(6));
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── DESIGN.md ──────────────────────────────────────────────────────────────

/** DESIGN.md sections in the spec's order, each with the front matter key it fills. */
const SECTIONS: {
  category: TokenCategory;
  heading: string;
  key?: 'colors' | 'typography' | 'spacing' | 'rounded';
  intro: string;
}[] = [
  {
    category: 'color',
    heading: 'Colors',
    key: 'colors',
    intro: 'Use these colors instead of hex, rgb() or Tailwind palette values.',
  },
  {
    category: 'typography',
    heading: 'Typography',
    key: 'typography',
    intro: 'The font families, sizes and weights of the design system.',
  },
  {
    category: 'spacing',
    heading: 'Layout',
    key: 'spacing',
    intro: 'Use these spacing steps instead of arbitrary lengths.',
  },
  {
    category: 'shadow',
    heading: 'Elevation & Depth',
    intro: 'The shadows of the design system.',
  },
  {
    category: 'radius',
    heading: 'Shapes',
    key: 'rounded',
    intro: 'Use these corner radii instead of arbitrary values.',
  },
  {
    category: 'other',
    heading: 'Other tokens',
    intro: 'Tokens that are not colors, typography, spacing, shadows or radii.',
  },
];

/** The front matter keys, in the order of the spec's schema. */
const FRONT_MATTER_ORDER = ['colors', 'typography', 'rounded', 'spacing'] as const;

/**
 * The tokens as a DESIGN.md: front matter with the colors, typography, rounded corners and
 * spacing in the spec's schema, then a heading per category with a table of its tokens, their
 * values in each mode and how code uses them.
 */
export function toDesignMd(tokens: readonly Token[], options: { name: string }): Exported {
  const warnings: string[] = [];
  const lookup = varLookup(tokens);
  const keys = designKeys(tokens);
  const front: Record<string, unknown> = { version: 'alpha', name: options.name };
  const sections: Record<string, Record<string, unknown>> = {};
  const body: string[] = [`# ${options.name}`];
  const byName = new Map(tokens.map((t) => [t.name, t]));

  for (const section of SECTIONS) {
    const list = tokens.filter((t) => t.category === section.category);
    if (!list.length) continue;
    if (section.key) {
      const values: Record<string, unknown> = {};
      for (const token of list) {
        const key = keys.get(token);
        if (key === undefined) continue;
        // An alias stays a reference to a token of the same section that the front matter has.
        const target = token.aliasOf ? byName.get(token.aliasOf) : undefined;
        const targetKey =
          target?.category === token.category &&
          frontMatterValue(target, section.key, lookup) !== undefined
            ? keys.get(target)
            : undefined;
        const value =
          targetKey === undefined
            ? frontMatterValue(token, section.key, lookup)
            : `{${section.key}.${targetKey}}`;
        if (value === undefined) continue;
        if (key in values) {
          warnings.push(`${token.name} is left out of the front matter: another token has its key`);
          continue;
        }
        values[key] = value;
      }
      if (Object.keys(values).length) sections[section.key] = values;
    }
    body.push('', `## ${section.heading}`, '', section.intro, '', ...table(list, keys));
  }
  for (const key of FRONT_MATTER_ORDER) if (sections[key]) front[key] = sections[key];
  const yaml = stringify(front, { lineWidth: 0 });
  return { text: `---\n${yaml}---\n\n${body.join('\n')}\n`, count: tokens.length, warnings };
}

/** Each token's key in its section: its DTCG path without the group, joined with `-`. */
function designKeys(tokens: readonly Token[]): Map<Token, string> {
  const out = new Map<Token, string>();
  for (const token of tokens) {
    const parts = leaf(token).filter((p) => p !== '$root');
    out.set(token, parts.join('-') || 'base');
  }
  return out;
}

function frontMatterValue(
  token: Token,
  key: (typeof FRONT_MATTER_ORDER)[number],
  lookup: Lookup,
): unknown {
  const value = token.value.trim();
  switch (key) {
    case 'colors':
      if (!parseColor(value, { bareHsl: true })) return undefined;
      return isBareHsl(value) ? `hsl(${value})` : value;
    case 'rounded':
    case 'spacing': {
      if (DESIGN_DIMENSION.test(value) || value === '0') return value;
      const px = evaluateLength(value, lookup);
      return px === undefined || !Number.isFinite(px) ? undefined : `${round(px)}px`;
    }
    case 'typography':
      return designTypography(token);
  }
}

/** A DESIGN.md dimension: px, em or rem. */
const DESIGN_DIMENSION = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em)$/;

/**
 * A typography token as a DESIGN.md typography level: `{ fontFamily: "Inter" }` for
 * `--font-sans`, every property of a composite. A `var()` is no font name (`next/font` sets
 * it at runtime), and a value the schema has no form for is left out.
 */
function designTypography(token: Token): Record<string, string | number> | undefined {
  const value = token.value.trim();
  const kind = typographyKind(token);
  const entries = kind === 'composite' ? pairs(value) : kind ? [[kind, value] as const] : [];
  const out: Record<string, string | number> = {};
  for (const [property, v] of entries) {
    if (property === 'fontFamily') {
      if (!v.includes('var(')) out[property] = v;
    } else if (property === 'fontWeight') {
      const n = weight(v);
      if (n !== undefined) out[property] = n;
    } else if (property === 'lineHeight') {
      if (NUMBER.test(v)) out[property] = Number(v);
      else if (DESIGN_DIMENSION.test(v)) out[property] = v;
    } else if (property === 'fontSize' || property === 'letterSpacing') {
      if (DESIGN_DIMENSION.test(v)) out[property] = v;
    } else {
      out[property] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** A Markdown table of tokens: key, value, a column per mode, how code uses it, and the description. */
function table(tokens: readonly Token[], keys: Map<Token, string>): string[] {
  const modes = [...new Set(tokens.flatMap((t) => Object.keys(t.modes ?? {})))];
  const described = tokens.some((t) => t.description);
  const header = [
    'Token',
    'Value',
    ...modes.map((m) => m.charAt(0).toUpperCase() + m.slice(1)),
    'Use',
    ...(described ? ['Description'] : []),
  ];
  const code = (text: string | undefined) => (text ? `\`${text}\`` : '');
  const rows = tokens.map((token) => [
    code(keys.get(token) ?? token.name),
    code(token.value),
    ...modes.map((m) => code(token.modes?.[m])),
    use(token),
    ...(described ? [token.description ?? ''] : []),
  ]);
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)];
}

/** `bg-primary`, `var(--primary)`: the first utility class and the CSS reference. */
function use(token: Token): string {
  const utility = token.usage.find((u) => !u.includes('('));
  const reference = cssReference(token);
  return [utility, reference]
    .filter((u): u is string => Boolean(u))
    .map((u) => `\`${u}\``)
    .join(', ');
}
