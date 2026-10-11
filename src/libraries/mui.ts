import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { parseColor } from '../tokens/color.js';
import type { Token, TokenCategory } from '../types.js';
import { isInside, relativePath } from '../util/paths.js';
import type { AddedValue, LibraryAdapter } from './index.js';

/** The palette groups MUI's components take as a `color` value (`<Button color="primary">`). */
const ROLES = new Set(['primary', 'secondary', 'error', 'warning', 'info', 'success']);

/** Palette keys that are settings, not colors. */
const SETTINGS = new Set([
  'mode',
  'contrastThreshold',
  'tonalOffset',
  'augmentColor',
  'getContrastText',
]);

/** Functions that build an MUI theme from an options object. */
const THEME_CALLS = /^(?:createTheme|extendTheme|experimental_extendTheme|createMuiTheme)$/;

/**
 * MUI (`@mui/material`): components from its type declarations, and tokens from the theme the
 * app creates with `createTheme`, where its values are written out.
 */
export const mui: LibraryAdapter = {
  id: 'mui',
  package: '@mui/material',
  title: 'MUI',
  augments: /declare\s+module\s+['"]@mui\/(?:material|system|types)(?:\/[\w./-]*)?['"]/,
  describe: describeMui,
  annotate(component) {
    // A string `title` becomes the child's `aria-label`; with `describeChild`, its description.
    if (component.name === 'Tooltip')
      component.labelsChild = { prop: 'title', unless: 'describeChild' };
  },
  theme: {
    // Theme options, palette groups (`teal: { main }`) and component variants (`variants: [`).
    matches:
      /\b(?:createTheme|extendTheme|experimental_extendTheme|createMuiTheme)\s*\(|\bmain\s*:|\bvariants\s*:/,
    read: readThemes,
  },
};

/** The keys of a palette color group: `teal: { light, main, dark, contrastText }`. */
const SHADES = /^(?:light|main|dark|contrastText|lighter|darker|A?\d{2,3})$/;

/**
 * MUI's JSDoc lists demos and API pages rather than describing the component: keep any prose,
 * then the demo titles and the API page, which also feed search.
 */
function describeMui(jsdoc: string): string | undefined {
  const [prose = '', rest = ''] = jsdoc.split(/^Demos:\s*$/m);
  const demos = [...(rest.split(/^API:\s*$/m)[0] ?? '').matchAll(/^- \[([^\]]+)\]\(/gm)].map(
    (m) => m[1],
  );
  const api = /\[[^\]]+ API\]\((https:[^)\s]+)\)/.exec(rest)?.[1];
  const parts = [
    prose.trim(),
    demos.length ? `Demos: ${demos.join(', ')}.` : '',
    api ? `API: ${api}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('\n\n') : undefined;
}

// ─── Theme ──────────────────────────────────────────────────────────────────

type Value = string | number | boolean | Value[] | { [key: string]: Value } | undefined;
type Literal = { [key: string]: Value };

/** Tests, stories, mocks and fixtures: themes there are not the app's. */
const NOT_THE_APP = /(?:^|\/)[^/]*(?:test|spec|stor(?:y|ies)|mock|fixture)[^/]*(?:\/|$)/i;

/**
 * Tokens from the options objects passed to `createTheme` (or `extendTheme`) in `files`:
 * palette colors (`primary.main`, `background.paper`, `divider`) with their dark values from
 * `colorSchemes.dark`, and the spacing unit, border radius and font family. Values written as
 * literals are read, through constants of the same file or imported from another of the app's
 * files by a relative path; anything computed is left out. Nothing runs. Tests, stories and
 * their helpers are skipped: a theme there is not the app's.
 */
function readThemes(
  files: { file: string; text: string }[],
  root: string,
): { tokens: Token[]; warnings: string[]; values: AddedValue[]; files: string[] } {
  const tokens = new Map<string, Token>();
  const values: AddedValue[] = [];
  const scopes = new Scopes(root);
  for (const { file, text } of files) {
    const rel = relativePath(root, file);
    if (NOT_THE_APP.test(rel)) continue;
    const scope = scopes.of(file, text);
    if (!scope) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && THEME_CALLS.test(calleeName(node.expression) ?? '')) {
        const [first] = node.arguments;
        const options = first ? scopes.evaluate(first, scope, 0) : undefined;
        const literal = object(options);
        if (literal) {
          const line =
            scope.source.getLineAndCharacterOfPosition(node.getStart(scope.source)).line + 1;
          for (const token of themeTokens(literal, { file: rel, line })) {
            // The first theme a name comes from wins: an app has one, sometimes rebuilt.
            if (!tokens.has(token.name)) tokens.set(token.name, token);
          }
        }
      }
      if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.initializer)) {
        values.push(...addedValues(node.name, node.initializer));
      }
      ts.forEachChild(node, visit);
    };
    visit(scope.source);
  }
  return { tokens: [...tokens.values()], warnings: [], values, files: scopes.read() };
}

/**
 * Values a theme adds, whether or not its options can be read: a palette group
 * (`teal: { main: …, dark: … }`) makes `teal` a color of every component's `color`, and a
 * component's `variants: [{ props: { variant: "dashed" } }]` (under `MuiButton`) a value of
 * that prop. Over-reading only allows more; it never reports anything.
 */
function addedValues(name: ts.PropertyName, value: ts.ObjectLiteralExpression): AddedValue[] {
  const key = keyOf(name);
  if (key === undefined) return [];
  const keys = value.properties.map((p) => (p.name ? keyOf(p.name) : undefined));
  if (keys.includes('main') && keys.every((k) => k !== undefined && SHADES.test(k))) {
    return [{ prop: 'color', value: key, alongside: 'primary' }];
  }
  const component = /^Mui([A-Z]\w*)$/.exec(key)?.[1];
  if (!component) return [];
  const found: AddedValue[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      keyOf(node.name) === 'props' &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteralLike(prop.initializer)) continue;
        const propName = keyOf(prop.name);
        if (propName) found.push({ component, prop: propName, value: prop.initializer.text });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(value);
  return found;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/** What a file declares at its top level, for following a theme's values into it. */
interface Scope {
  file: string;
  source: ts.SourceFile;
  /** `const` declarations, by name. */
  constants: Map<string, ts.Expression>;
  /** Bindings imported by a relative path: local name → the module and its export's name. */
  imports: Map<string, { specifier: string; name: string }>;
  /** Exported name → local name (`export const a`, `export { a as b }`, `export default a`). */
  exports: Map<string, string>;
}

const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

/** The app's files a theme reads from, each parsed once. */
class Scopes {
  private readonly scopes = new Map<string, Scope | null>();

  constructor(private readonly root: string) {}

  /** The files read beyond those passed in: the modules a theme imports. */
  read(): string[] {
    return [...this.scopes.keys()];
  }

  of(file: string, text?: string): Scope | undefined {
    const known = this.scopes.get(file);
    if (known !== undefined) return known ?? undefined;
    let scope: Scope | null;
    try {
      const source = ts.createSourceFile(
        file,
        text ?? fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        scriptKind(file),
      );
      scope = scopeOf(file, source);
    } catch {
      // Unreadable: nothing to follow into.
      scope = null;
    }
    this.scopes.set(file, scope);
    return scope ?? undefined;
  }

  /** A literal value, following constants and relative imports; undefined for anything computed. */
  evaluate(node: ts.Expression, scope: Scope, depth: number): Value {
    if (depth > 24) return undefined;
    const next = (n: ts.Expression, s: Scope = scope) => this.evaluate(n, s, depth + 1);
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return next(node.expression);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isIdentifier(node)) return this.binding(node.text, scope, depth);
    if (ts.isPropertyAccessExpression(node)) return member(next(node.expression), node.name.text);
    if (ts.isElementAccessExpression(node)) {
      const key = next(node.argumentExpression);
      return typeof key === 'string' || typeof key === 'number'
        ? member(next(node.expression), String(key))
        : undefined;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => next(element));
    if (ts.isObjectLiteralExpression(node)) {
      const result: Literal = {};
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const key = keyOf(property.name);
          if (key !== undefined) result[key] = next(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          result[property.name.text] = next(property.name);
        } else if (ts.isSpreadAssignment(property)) {
          const spread = object(next(property.expression));
          if (spread) Object.assign(result, spread);
        }
      }
      return result;
    }
    return undefined;
  }

  /** The value of a name in a scope: one of its constants, or what it imports by that name. */
  private binding(name: string, scope: Scope, depth: number): Value {
    const constant = scope.constants.get(name);
    if (constant) return this.evaluate(constant, scope, depth + 1);
    const imported = scope.imports.get(name);
    if (!imported) return undefined;
    const target = this.resolve(imported.specifier, scope.file);
    const module = target ? this.of(target) : undefined;
    const local = module?.exports.get(imported.name);
    return module && local ? this.binding(local, module, depth + 1) : undefined;
  }

  /** A relative import's file, among the app's own files. */
  private resolve(specifier: string, from: string): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const base = path.resolve(path.dirname(from), specifier);
    if (!isInside(this.root, base) || /[\\/]node_modules[\\/]/.test(base)) return undefined;
    const stem = base.replace(/\.[cm]?js$/, '');
    for (const candidate of [
      base,
      ...SCRIPT_EXTENSIONS.map((ext) => `${stem}${ext}`),
      ...SCRIPT_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
    ]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return undefined;
  }
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function scopeOf(file: string, source: ts.SourceFile): Scope {
  const scope: Scope = {
    file,
    source,
    constants: new Map(),
    imports: new Map(),
    exports: new Map(),
  };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name) scope.imports.set(clause.name.text, { specifier, name: 'default' });
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          scope.imports.set(element.name.text, {
            specifier,
            name: (element.propertyName ?? element.name).text,
          });
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      const list = statement.declarationList;
      if (!(list.flags & ts.NodeFlags.Const)) continue;
      const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      for (const declaration of list.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        scope.constants.set(declaration.name.text, declaration.initializer);
        if (exported) scope.exports.set(declaration.name.text, declaration.name.text);
      }
    } else if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          scope.exports.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (ts.isIdentifier(statement.expression)) {
        scope.exports.set('default', statement.expression.text);
      } else {
        scope.constants.set('default', statement.expression);
        scope.exports.set('default', 'default');
      }
    }
  }
  return scope;
}

/** A property of an object read so far (`neonBlue[400]`, `palette.primary`). */
function member(value: Value, key: string): Value {
  if (Array.isArray(value)) return /^\d+$/.test(key) ? value[Number(key)] : undefined;
  return object(value)?.[key];
}

function keyOf(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function object(value: Value): Literal | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** The colors of a palette, by path: `primary.main`, `background.paper`, `divider`. */
function paletteColors(palette: Literal | undefined): Map<string, string> {
  const colors = new Map<string, string>();
  for (const [key, value] of Object.entries(palette ?? {})) {
    if (SETTINGS.has(key)) continue;
    if (typeof value === 'string') {
      if (parseColor(value)) colors.set(key, value);
      continue;
    }
    for (const [shade, color] of Object.entries(object(value) ?? {})) {
      if (typeof color === 'string' && parseColor(color)) colors.set(`${key}.${shade}`, color);
    }
  }
  return colors;
}

function themeTokens(options: Literal, source: { file: string; line: number }): Token[] {
  const tokens: Token[] = [];
  const schemes = object(options.colorSchemes);
  const light = paletteColors(object(object(schemes?.light)?.palette) ?? object(options.palette));
  const dark = paletteColors(object(object(schemes?.dark)?.palette));
  const variables = options.cssVariables !== undefined && options.cssVariables !== false;
  const add = (name: string, category: TokenCategory, value: string, usage: string[]) =>
    tokens.push({ name, category, value, usage, source, description: 'From the MUI theme.' });

  for (const name of new Set([...light.keys(), ...dark.keys()])) {
    const value = light.get(name) ?? dark.get(name) ?? '';
    const [group = name, shade] = name.split('.');
    // The `sx` key a palette color goes with: backgrounds fill, the divider draws borders.
    const key = group === 'background' ? 'bgcolor' : group === 'divider' ? 'borderColor' : 'color';
    const usage = [
      ...(ROLES.has(group) && shade === 'main' ? [`color="${group}"`] : []),
      `sx={{ ${key}: '${name}' }}`,
      `theme.palette.${name}`,
    ];
    add(name, 'color', value, usage);
    const token = tokens.at(-1);
    if (!token) continue;
    if (variables) token.cssVar = `--mui-palette-${name.replace(/\./g, '-')}`;
    const darkValue = dark.get(name);
    if (darkValue !== undefined && light.has(name) && darkValue !== value) {
      token.modes = { dark: darkValue };
    }
  }

  const spacing = options.spacing;
  if (typeof spacing === 'number' || typeof spacing === 'string') {
    add('spacing', 'spacing', typeof spacing === 'number' ? `${spacing}px` : spacing, [
      'theme.spacing(1)',
      'sx={{ p: 1 }}',
    ]);
  }
  const radius = object(options.shape)?.borderRadius;
  if (typeof radius === 'number' || typeof radius === 'string') {
    add('shape.borderRadius', 'radius', typeof radius === 'number' ? `${radius}px` : radius, [
      'theme.shape.borderRadius',
      'sx={{ borderRadius: 1 }}',
    ]);
  }
  const family = object(options.typography)?.fontFamily;
  if (typeof family === 'string') {
    add('typography.fontFamily', 'typography', family, ['theme.typography.fontFamily']);
  }
  // A library's theme: spacing and radius scale by multiples here (`theme.spacing(2)`,
  // `borderRadius: 2`), which the length rules, built on Tailwind's scales, do not model, so they
  // are listed but not enforced; colors are matched as any others.
  for (const token of tokens) token.origin = 'library';
  return tokens;
}
