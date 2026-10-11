import { isMap, isScalar, LineCounter, parseDocument, type YAMLMap } from 'yaml';

import type { Token, TokenCategory } from '../types.js';

/**
 * Reads the tokens in a DESIGN.md's YAML front matter (https://github.com/google-labs-code/design.md):
 * `colors`, `typography`, `rounded` and `spacing`. Tokens are named by their path
 * (`colors.primary`), which is how `{colors.primary}` references them. `components` holds
 * per-component styling rather than tokens to choose from, and the Markdown body is prose, so
 * neither is read. A DESIGN.md says nothing about how code reads its tokens, so they have no
 * custom property or Tailwind class: a finding names the nearest token without a fix.
 */

/** Front matter section → category, in the spec's order. */
const SECTIONS: [section: string, category: TokenCategory][] = [
  ['colors', 'color'],
  ['typography', 'typography'],
  ['rounded', 'radius'],
  ['spacing', 'spacing'],
];

/** A DESIGN.md dimension: a number with px, em or rem, or a bare 0. */
const DIMENSION = /^-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em)$|^0$/;

interface RawToken {
  path: string[];
  category: TokenCategory;
  value: string | Record<string, string>;
  line: number;
}

export function parseDesignMd(text: string, file: string): { tokens: Token[]; warnings: string[] } {
  const front = frontMatter(text);
  if (front === undefined) {
    return {
      tokens: [],
      warnings: [`${file}: no YAML front matter (between --- lines at the top)`],
    };
  }
  const lineCounter = new LineCounter();
  const doc = parseDocument(front.yaml, { lineCounter });
  const [error] = doc.errors;
  if (error) {
    const reason = error.message.split('\n')[0] ?? '';
    return { tokens: [], warnings: [`${file}: invalid YAML front matter (${reason})`] };
  }
  if (!isMap(doc.contents)) return { tokens: [], warnings: [] };

  const warnings: string[] = [];
  const raw: RawToken[] = [];
  const lineAt = (offset: number | undefined) =>
    offset === undefined ? 1 : lineCounter.linePos(offset).line + front.line;
  const collect = (map: YAMLMap, path: string[], category: TokenCategory) => {
    for (const pair of map.items) {
      const key = isScalar(pair.key) ? scalar(pair.key.value) : undefined;
      if (key === undefined) continue;
      const at = [...path, key];
      const line = lineAt(isScalar(pair.key) ? pair.key.range?.[0] : undefined);
      const node = pair.value;
      if (isMap(node)) {
        // A typography level is one token; elsewhere a map is a group of tokens.
        if (category === 'typography') {
          const value = Object.fromEntries(
            node.items.flatMap((p) => {
              const property = isScalar(p.key) ? scalar(p.key.value) : undefined;
              const value = isScalar(p.value) ? scalar(p.value.value) : undefined;
              return property === undefined || value === undefined ? [] : [[property, value]];
            }),
          );
          raw.push({ path: at, category, value, line });
        } else {
          collect(node, at, category);
        }
        continue;
      }
      const value = isScalar(node) ? scalar(node.value) : undefined;
      if (value === undefined) {
        warnings.push(
          `${file}: ${at.join('.')} has no value${category === 'color' ? ' (a # starts a YAML comment: quote hex colors)' : ''}`,
        );
        continue;
      }
      // Spacing and rounded also hold plain numbers (column counts): they are no lengths.
      const length = category === 'spacing' || category === 'radius';
      raw.push({
        path: at,
        category: length && !DIMENSION.test(value) && !isReference(value) ? 'other' : category,
        value,
        line,
      });
    }
  };
  for (const [section, category] of SECTIONS) {
    const node = doc.contents.get(section, true);
    if (isMap(node)) collect(node, [section], category);
  }

  const byPath = new Map(raw.map((t) => [t.path.join('.'), t]));
  const resolve = (value: string, seen: Set<string>): string => {
    const alias = reference(value);
    if (alias === undefined) return value;
    const target = byPath.get(alias);
    if (!target || typeof target.value !== 'string') {
      warnings.push(`${file}: unresolved reference {${alias}}`);
      return value;
    }
    if (seen.has(alias)) {
      warnings.push(`${file}: circular reference {${alias}}`);
      return value;
    }
    return resolve(target.value, new Set([...seen, alias]));
  };

  const tokens = raw.map((t): Token => {
    const name = t.path.join('.');
    const value =
      typeof t.value === 'string'
        ? resolve(t.value, new Set([name]))
        : Object.entries(t.value)
            .map(([k, v]) => `${k}: ${resolve(v, new Set([name]))}`)
            .join('; ');
    const token: Token = {
      name,
      category: t.category,
      value,
      usage: [],
      source: { file, line: t.line },
    };
    const alias = typeof t.value === 'string' ? reference(t.value) : undefined;
    if (alias && byPath.has(alias)) token.aliasOf = alias;
    return token;
  });
  return { tokens, warnings };
}

/** The YAML between a first line of exactly `---` and the next such line, and the line it starts on. */
function frontMatter(text: string): { yaml: string; line: number } | undefined {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return undefined;
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---');
  if (end === -1) return undefined;
  return { yaml: lines.slice(1, end).join('\n'), line: 1 };
}

/** A YAML scalar as text: strings, numbers and booleans; null (an empty value) is none. */
function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : undefined;
}

function reference(value: string): string | undefined {
  return /^\{([^{}]+)\}$/.exec(value.trim())?.[1];
}

function isReference(value: string): boolean {
  return reference(value) !== undefined;
}
