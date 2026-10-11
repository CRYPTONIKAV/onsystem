import type { Token, TokenCategory } from '../types.js';
import { themeVariable } from './css.js';
import { usageFor } from './usage.js';

/**
 * Parser for the W3C Design Tokens Community Group format 2025.10
 * (https://www.designtokens.org/tr/2025.10/format/). Supports both the stable
 * object values (`{ colorSpace, components }`, `{ value, unit }`) and the
 * older string values (`"#ff0000"`, `"16px"`), `$type` inheritance from
 * groups, `$root` tokens, groups that `$extends` another, `{alias.references}`,
 * `$ref` pointers, and `$deprecated`.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/**
 * The `$extensions` key under which onsystem keeps what DTCG has no field for: the custom
 * property code uses, the Tailwind theme variable and the values in other modes.
 */
export const ONSYSTEM_EXTENSION = 'com.github.dgesteves.onsystem';

/** What a token keeps under `$extensions["com.github.dgesteves.onsystem"]`. */
export interface OnsystemExtension {
  /** The custom property code uses: `--primary`. */
  cssVar?: string;
  /** The Tailwind theme variable that exposes the token: `--color-primary` makes `bg-primary`. */
  tailwind?: string;
  /**
   * `hsl` when the custom property holds bare HSL channels (Tailwind v3, shadcn/ui before
   * v4), so code reads it as `hsl(var(--border))`.
   */
  channels?: 'hsl';
  /** Values in other theme modes, in the form of `$value`: `{ "dark": { "colorSpace": … } }`. */
  modes?: Record<string, Json>;
}

interface RawToken {
  path: string[];
  value: Json;
  type?: string;
  description?: string;
  deprecated?: string | true;
  modes?: Record<string, Json>;
  /** The token's onsystem extension, without its modes, when it has one. */
  own?: Omit<OnsystemExtension, 'modes'>;
  line: number;
}

export interface DtcgOptions {
  /** Prefix for generated custom property names: `ds` → `--ds-color-primary`. */
  prefix?: string;
}

export function parseDtcgTokens(
  text: string,
  file: string,
  options: DtcgOptions = {},
): { tokens: Token[]; warnings: string[] } {
  const warnings: string[] = [];
  let json: Json;
  try {
    json = JSON.parse(text) as Json;
  } catch (error) {
    return { tokens: [], warnings: [`${file}: invalid JSON (${(error as Error).message})`] };
  }
  if (!isObject(json)) return { tokens: [], warnings: [`${file}: expected a JSON object`] };

  const lines = lineIndex(text);
  // Tokens a group inherits through `$extends` are reported where they are written.
  const origins = new WeakMap<JsonObject, string[]>();
  recordPaths(json, [], origins);
  const tree = extendGroups(json, (message) => warnings.push(`${file}: ${message}`));
  const raw: RawToken[] = [];
  walk(tree, [], undefined, raw, (node, path) => lines(origins.get(node) ?? path));
  const byPath = new Map(raw.map((t) => [t.path.join('.'), t]));

  const resolve = (value: Json, seen: Set<string>): Json => {
    if (typeof value === 'string') {
      const alias = /^\{([^{}]+)\}$/.exec(value)?.[1];
      if (alias) {
        const target = byPath.get(alias);
        if (!target) {
          warnings.push(`${file}: unresolved alias {${alias}}`);
          return value;
        }
        if (seen.has(alias)) {
          warnings.push(`${file}: circular alias {${alias}}`);
          return value;
        }
        return resolve(target.value, new Set([...seen, alias]));
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => resolve(v, seen));
    if (isObject(value)) {
      const ref = value.$ref;
      if (typeof ref === 'string' && Object.keys(value).length === 1) {
        const pointer = ref
          .replace(/^#\//, '')
          .split('/')
          .filter((p) => p !== '$value');
        return resolve(`{${pointer.join('.')}}`, seen);
      }
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, seen)]));
    }
    return value;
  };

  const aliasTarget = (value: Json): string | undefined =>
    typeof value === 'string' ? /^\{([^{}]+)\}$/.exec(value)?.[1] : undefined;
  /** `$type` of a token, or of the token its alias chain ends at. */
  const typeOf = (token: RawToken, seen = new Set<string>()): string | undefined => {
    if (token.type) return token.type;
    const alias = aliasTarget(token.value);
    if (alias === undefined || seen.has(alias)) return undefined;
    seen.add(alias);
    const target = byPath.get(alias);
    return target ? typeOf(target, seen) : undefined;
  };

  const tokens = raw.map((t): Token => {
    const name = t.path.join('.');
    const aliasOf = aliasTarget(t.value);
    const type = typeOf(t);
    const format = (value: Json) => {
      const resolved = resolve(value, new Set([name]));
      return (t.own?.channels === 'hsl' && hslChannels(resolved)) || formatValue(resolved, type);
    };
    // `color.accent.$root` is the group's own value: `--color-accent`.
    const segments = [options.prefix, ...t.path.filter((p) => p !== '$root')].filter(Boolean);
    const generated = segments.length
      ? `--${segments.join('-').replace(/[^\w-]+/g, '-')}`
      : undefined;
    const theme = t.own?.tailwind ? themeVariable(t.own.tailwind) : undefined;
    const token: Token = {
      name,
      category: categorize(type, t.path),
      value: format(t.value),
      usage: [],
      source: { file, line: t.line },
    };
    // With onsystem's extension, the token has the custom property it names, or none (a
    // Tailwind `@theme inline` variable); without it, one named after its path.
    const cssVar = t.own ? t.own.cssVar : generated;
    if (cssVar) token.cssVar = cssVar;
    if (theme) token.tailwind = theme.key;
    if (aliasOf) token.aliasOf = aliasOf;
    if (t.description) token.description = t.description;
    if (t.deprecated) token.deprecated = t.deprecated;
    if (t.modes) {
      token.modes = Object.fromEntries(
        Object.entries(t.modes).map(([mode, v]) => [mode, format(v)]),
      );
    }
    token.usage = usageFor(token, theme?.namespace);
    return token;
  });

  return { tokens, warnings };
}

function walk(
  node: JsonObject,
  path: string[],
  inheritedType: string | undefined,
  out: RawToken[],
  lineOf: (node: JsonObject, path: string[]) => number,
): void {
  const type = typeof node.$type === 'string' ? node.$type : inheritedType;
  if ('$value' in node) {
    const token: RawToken = { path, value: node.$value ?? null, line: lineOf(node, path) };
    if (type) token.type = type;
    if (typeof node.$description === 'string') token.description = node.$description;
    if (node.$deprecated === true) token.deprecated = true;
    else if (typeof node.$deprecated === 'string') token.deprecated = node.$deprecated;
    const extension = onsystemExtension(node.$extensions);
    const modes = extension?.modes ?? modesOf(node.$extensions);
    if (modes) token.modes = modes;
    if (extension) {
      const { modes: _modes, ...own } = extension;
      token.own = own;
    }
    out.push(token);
    return;
  }
  // `$root` is a token of the group itself; every other `$` key is a property.
  for (const [key, child] of Object.entries(node)) {
    if ((key.startsWith('$') && key !== '$root') || !isObject(child)) continue;
    walk(child, [...path, key], type, out, lineOf);
  }
}

/** Where each object of the file is, by path. */
function recordPaths(node: JsonObject, path: string[], into: WeakMap<JsonObject, string[]>): void {
  into.set(node, path);
  if ('$value' in node) return;
  for (const [key, child] of Object.entries(node)) {
    if ((key.startsWith('$') && key !== '$root') || !isObject(child)) continue;
    recordPaths(child, [...path, key], into);
  }
}

/**
 * Resolves group extension: a group with `$extends` (or JSON Schema's `$ref`, its equivalent)
 * takes on every token and property of the group it names, and its own win where both define
 * one, group by group (a token is replaced whole). A `$ref` on an object without `$value`
 * that points at a token makes it an alias of that token. Unresolvable and circular
 * references, and `$extends` that names a token, are reported and left out.
 */
function extendGroups(root: JsonObject, warn: (message: string) => void): JsonObject {
  const done = new Map<string, JsonObject>();
  const active = new Set<string>();
  const expand = (node: JsonObject, path: string[]): JsonObject => {
    if ('$value' in node) return node;
    const key = JSON.stringify(path);
    const cached = done.get(key);
    if (cached) return cached;
    active.add(key);
    const extendsRef = typeof node.$extends === 'string' ? node.$extends : undefined;
    const ref = extendsRef ?? (typeof node.$ref === 'string' ? node.$ref : undefined);
    const label = extendsRef === undefined ? '$ref' : '$extends';
    let out: JsonObject = {};
    let result: JsonObject | undefined;
    if (ref !== undefined) {
      const target = referencePath(ref);
      const found = target && lookup(root, target);
      if (!target || !found) warn(`unresolved ${label} ${ref}`);
      else if ('$value' in found) {
        if (extendsRef !== undefined) warn(`$extends ${ref} names a token, not a group`);
        else {
          const { $ref: _ref, ...rest } = node;
          result = { ...rest, $value: `{${target.join('.')}}` };
        }
      } else if (active.has(JSON.stringify(target))) warn(`circular ${label} ${ref}`);
      else out = { ...expand(found, target) };
    }
    if (!result) {
      for (const [k, v] of Object.entries(node)) {
        if (k === '$extends' || (k === '$ref' && extendsRef === undefined)) continue;
        if (isObject(v) && (!k.startsWith('$') || k === '$root')) {
          const child = expand(v, [...path, k]);
          const inherited = out[k];
          out[k] = isGroup(inherited) && isGroup(child) ? mergeGroups(inherited, child) : child;
        } else {
          out[k] = v;
        }
      }
      result = out;
    }
    active.delete(key);
    done.set(key, result);
    return result;
  };
  return expand(root, []);
}

/** `base` with `own` over it: tokens and properties replaced whole, groups merged. */
function mergeGroups(base: JsonObject, own: JsonObject): JsonObject {
  const out = { ...base };
  for (const [key, value] of Object.entries(own)) {
    const inherited = out[key];
    const child = !key.startsWith('$') || key === '$root';
    out[key] =
      child && isGroup(inherited) && isGroup(value) ? mergeGroups(inherited, value) : value;
  }
  return out;
}

/** `{button}` or `#/button` → `["button"]`; a pointer's trailing `$value` is the token itself. */
function referencePath(ref: string): string[] | undefined {
  const curly = /^\{([^{}]+)\}$/.exec(ref.trim())?.[1];
  if (curly) return curly.split('.');
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref
    .slice(2)
    .split('/')
    .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (parts.at(-1) === '$value') parts.pop();
  return parts.length ? parts : undefined;
}

function lookup(root: JsonObject, path: string[]): JsonObject | undefined {
  let node: Json | undefined = root;
  for (const key of path) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return isObject(node) ? node : undefined;
}

function isGroup(value: Json | undefined): value is JsonObject {
  return isObject(value) && !('$value' in value);
}

/** The fields onsystem reads from its own `$extensions` entry, when they are well formed. */
function onsystemExtension(extensions: Json | undefined): OnsystemExtension | undefined {
  const own = isObject(extensions) ? extensions[ONSYSTEM_EXTENSION] : undefined;
  if (!isObject(own)) return undefined;
  const out: OnsystemExtension = {};
  if (typeof own.cssVar === 'string' && /^--[\w-]+$/.test(own.cssVar)) out.cssVar = own.cssVar;
  if (typeof own.tailwind === 'string' && themeVariable(own.tailwind)) {
    out.tailwind = own.tailwind;
  }
  if (own.channels === 'hsl') out.channels = 'hsl';
  if (isObject(own.modes)) out.modes = own.modes;
  return out;
}

/** Modes are not standardised yet; accept the common `$extensions.mode(s)` shape. */
function modesOf(extensions: Json | undefined): Record<string, Json> | undefined {
  if (!isObject(extensions)) return undefined;
  for (const key of ['modes', 'mode']) {
    const value = extensions[key];
    if (isObject(value)) return value;
  }
  return undefined;
}

function categorize(type: string | undefined, path: string[]): TokenCategory {
  const p = path.join('.').toLowerCase();
  switch (type) {
    case 'color':
      return 'color';
    case 'shadow':
      return 'shadow';
    case 'fontFamily':
    case 'fontWeight':
    case 'typography':
    case 'letterSpacing':
    case 'lineHeight':
      return 'typography';
    case 'dimension':
    case 'number':
      if (/radius|radii|rounded|corner/.test(p)) return 'radius';
      if (/font|text|typography|line-?height|letter-?spacing|leading|tracking/.test(p)) {
        return 'typography';
      }
      if (/spac|gap|padding|margin|inset|gutter|space/.test(p)) return 'spacing';
      return 'other';
    default:
      if (/colou?r/.test(p)) return 'color';
      return 'other';
  }
}

/** `214.3 31.8% 91.4%`: an HSL color as the bare channels a Tailwind v3 custom property holds. */
function hslChannels(value: Json): string | undefined {
  if (!isObject(value) || value.colorSpace !== 'hsl' || !Array.isArray(value.components)) {
    return undefined;
  }
  const [h, s, l] = value.components.map((c) => formatValue(c, undefined));
  if (h === undefined || s === undefined || l === undefined) return undefined;
  const alpha = typeof value.alpha === 'number' && value.alpha < 1 ? ` / ${value.alpha}` : '';
  return `${h} ${s}% ${l}%${alpha}`;
}

function formatValue(value: Json, type: string | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return '';
  if (Array.isArray(value)) {
    if (type === 'cubicBezier') {
      return `cubic-bezier(${value.map((v) => formatValue(v, undefined)).join(', ')})`;
    }
    if (type === 'fontFamily') return value.map((v) => formatValue(v, undefined)).join(', ');
    return value.map((v) => formatValue(v, type)).join(', ');
  }
  if (type === 'color' || ('colorSpace' in value && 'components' in value)) {
    return formatColor(value);
  }
  if ('value' in value && 'unit' in value) {
    return `${formatValue(value.value ?? '', undefined)}${formatValue(value.unit ?? '', undefined)}`;
  }
  if (type === 'shadow') {
    const s = value;
    return [s.inset === true ? 'inset' : undefined, s.offsetX, s.offsetY, s.blur, s.spread, s.color]
      .filter((v) => v !== undefined)
      .map((v) => formatValue(v ?? '', undefined))
      .join(' ');
  }
  return Object.entries(value)
    .map(([k, v]) => `${k}: ${formatValue(v, undefined)}`)
    .join('; ');
}

const COLOR_SPACES: Record<string, (c: string[]) => string> = {
  srgb: ([r, g, b]) => `rgb(${pct255(r)} ${pct255(g)} ${pct255(b)}`,
  hsl: ([h, s, l]) => `hsl(${h} ${s}% ${l}%`,
  hwb: ([h, w, b]) => `hwb(${h} ${w}% ${b}%`,
  lab: ([l, a, b]) => `lab(${l} ${a} ${b}`,
  lch: ([l, c, h]) => `lch(${l} ${c} ${h}`,
  oklab: ([l, a, b]) => `oklab(${l} ${a} ${b}`,
  oklch: ([l, c, h]) => `oklch(${l} ${c} ${h}`,
};

function formatColor(value: JsonObject): string {
  const alpha = typeof value.alpha === 'number' && value.alpha < 1 ? value.alpha : undefined;
  if (typeof value.hex === 'string' && alpha === undefined) return value.hex;
  const space = typeof value.colorSpace === 'string' ? value.colorSpace : 'srgb';
  const components = Array.isArray(value.components)
    ? value.components.map((c) => formatValue(c, undefined))
    : [];
  const make = COLOR_SPACES[space];
  const body = make ? make(components) : `color(${space} ${components.join(' ')}`;
  return `${body}${alpha === undefined ? '' : ` / ${alpha}`})`;
}

function pct255(component: string | undefined): string {
  if (component === undefined || component === 'none') return 'none';
  return String(Math.round(Number(component) * 255));
}

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Best-effort line numbers for token paths: finds each key in order, scoped to
 * where its parent key was found. Good enough for `file:line` references.
 */
function lineIndex(text: string): (path: string[]) => number {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  return (path) => {
    let offset = 0;
    for (const key of path) {
      const found = text.indexOf(JSON.stringify(key), offset);
      if (found === -1) break;
      offset = found;
    }
    return lineAt(offset);
  };
}
