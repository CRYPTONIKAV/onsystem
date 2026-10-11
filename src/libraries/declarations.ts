import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import {
  ELEMENT_INTERFACES,
  originOf,
  registerPropSet,
  unwrapParens,
} from '../extract/components.js';
import { projectFiles, type ProjectConfig } from '../extract/program.js';
import type { ComponentInfo, InheritedProps, PropInfo, VariantInfo } from '../types.js';
import { relativePath } from '../util/paths.js';
import { truncate, unique } from '../util/strings.js';
import type { LibraryAdapter } from './index.js';

export interface ExtractLibraryOptions {
  root: string;
  adapter: LibraryAdapter;
  /** The installed package's folder, as found (it may be a link, as pnpm installs it). */
  dir: string;
  project: ProjectConfig;
  /** The app's files that augment the library's types, read with its declarations. */
  augmentations: string[];
}

export interface LibraryExtraction {
  components: ComponentInfo[];
  propSets: Record<string, string[]>;
  /** Every value the package exports, components or not (`createTheme`, `ButtonGroupContext`). */
  exports: string[];
  warnings: string[];
  /** Project files read: the augmentations and the modules they import. */
  dependencies: string[];
}

/** Packages contributing more props than this are summarised, as in source extraction. */
const MAX_LISTED_INHERITED = 40;

/**
 * Reads a published library's components from its type declarations with the TypeScript
 * checker: every value its entry exports under a capitalised name whose type takes props
 * (function and class components, `forwardRef` and MUI's `OverridableComponent`), with the
 * props of each call signature, their string-literal values (custom ones the app declares by
 * module augmentation included), JSDoc, the element it renders, and the module that
 * default-exports it. A signature generic over the element to render (MUI's `component`) marks
 * that prop as polymorphic instead of adding its props.
 */
export function extractLibrary(options: ExtractLibraryOptions): LibraryExtraction {
  const { root, adapter, dir } = options;
  const warnings: string[] = [];
  const empty = (warning: string): LibraryExtraction => ({
    components: [],
    propSets: {},
    exports: [],
    warnings: [warning],
    dependencies: [],
  });
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return empty(`${adapter.package}: ${dir} could not be read`);
  }
  // The declarations the app's own imports resolve to, through the package's `exports`: MUI
  // ships `.d.mts` for `import` beside `.d.ts`, and augmentations apply to the ones resolved.
  const resolve = (specifier: string) =>
    ts.resolveModuleName(
      specifier,
      path.join(root, '__onsystem__.tsx'),
      options.project.options,
      ts.sys,
    ).resolvedModule?.resolvedFileName;
  const entry = resolve(adapter.package) ?? path.join(real, typesEntry(real));
  if (!fs.existsSync(entry) || !/\.d\.[cm]?ts$/.test(entry)) {
    return empty(`${adapter.package}: no type declarations at ${relativePath(root, entry)}`);
  }
  const program = ts.createProgram({
    rootNames: [entry, ...options.augmentations],
    options: options.project.options,
  });
  const checker = program.getTypeChecker();
  const entryFile = program.getSourceFile(entry);
  const moduleSymbol = entryFile ? checker.getSymbolAtLocation(entryFile) : undefined;
  if (!moduleSymbol) return empty(`${adapter.package}: ${entry} has no exports`);

  // Where a file is, as the app sees the package (`node_modules/@mui/material/…`).
  const shown = (file: string) =>
    relativePath(
      root,
      file.startsWith(`${real}${path.sep}`) || file.startsWith(`${real}/`)
        ? path.join(dir, path.relative(real, file))
        : file,
    );
  const context: Context = {
    checker,
    adapter,
    propSets: new Map(),
    scope: adapter.package.startsWith('@')
      ? `${adapter.package.split('/')[0] ?? ''}/`
      : adapter.package,
  };

  const exportNames = new Set<string>();
  const bySymbol = new Map<ts.Symbol, ComponentInfo>();
  const components: ComponentInfo[] = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const name = exported.getName();
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (!(symbol.flags & ts.SymbolFlags.Value)) continue;
    exportNames.add(name);
    if (!/^[A-Z]/.test(name)) continue;
    const known = bySymbol.get(symbol);
    if (known) {
      known.aliases.push(name);
      continue;
    }
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration) continue;
    const component = buildComponent(context, name, symbol);
    if (!component) continue;
    const file = declaration.getSourceFile();
    const line = file.getLineAndCharacterOfPosition(declaration.getStart(file)).line + 1;
    component.source = { file: shown(file.fileName), line };
    const defaultImport = defaultModule(program, checker, resolve, adapter.package, file, symbol);
    if (defaultImport) component.defaultImport = defaultImport;
    bySymbol.set(symbol, component);
    components.push(component);
  }
  linkSlots(components);

  return {
    components,
    propSets: Object.fromEntries(context.propSets),
    exports: [...exportNames].sort(),
    warnings,
    dependencies: unique(projectFiles(program)),
  };
}

interface Context {
  checker: ts.TypeChecker;
  adapter: LibraryAdapter;
  propSets: Map<string, string[]>;
  /** Props declared by these packages are the component's own: `@mui/`. */
  scope: string;
}

/** The declaration entry of an installed package: its `types`, else `index.d.ts`. */
function typesEntry(dir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      types?: unknown;
      typings?: unknown;
    };
    const types = typeof pkg.types === 'string' ? pkg.types : pkg.typings;
    if (typeof types === 'string' && types.endsWith('.d.ts')) return types;
  } catch {
    // No readable package.json: the conventional entry.
  }
  return 'index.d.ts';
}

/** Call and construct signatures that take props, across a union (`React.ComponentType`). */
function propSignatures(type: ts.Type): ts.Signature[] {
  const members = type.isUnion() ? type.types : [type];
  return members
    .flatMap((member) => [...member.getCallSignatures(), ...member.getConstructSignatures()])
    .filter((signature) => signature.getParameters().length >= 1);
}

/** A React context (`ButtonGroupContext`): callable in React 19's types, but not a component to offer. */
function isContext(checker: ts.TypeChecker, type: ts.Type): boolean {
  return (
    checker.getPropertyOfType(type, 'Provider') !== undefined &&
    checker.getPropertyOfType(type, 'Consumer') !== undefined
  );
}

/**
 * The prop a generic signature renders in the component's place (`component: RootComponent`
 * where `RootComponent extends React.ElementType`), which then takes that element's props.
 */
function polymorphicProp(
  checker: ts.TypeChecker,
  signature: ts.Signature,
): { name: string; symbol: ts.Symbol } | undefined {
  const parameters = signature.getTypeParameters();
  if (!parameters?.length) return undefined;
  const props = signature.getParameters()[0];
  if (!props) return undefined;
  for (const prop of checker.getPropertiesOfType(checker.getTypeOfSymbol(props))) {
    const type = checker.getNonNullableType(checker.getTypeOfSymbol(prop));
    if (!(type.flags & ts.TypeFlags.TypeParameter)) continue;
    const declaration = type.symbol.declarations?.find(ts.isTypeParameterDeclaration);
    if (
      parameters.includes(type) &&
      declaration?.constraint &&
      /\bElementType\b/.test(declaration.constraint.getText())
    ) {
      return { name: prop.getName(), symbol: prop };
    }
  }
  return undefined;
}

interface PropEntry {
  symbols: ts.Symbol[];
  required: number;
  origin: string;
}

function buildComponent(
  context: Context,
  name: string,
  symbol: ts.Symbol,
): ComponentInfo | undefined {
  const { checker, adapter } = context;
  const type = checker.getTypeOfSymbol(symbol);
  if (isContext(checker, type)) return undefined;
  const signatures = propSignatures(type);
  if (!signatures.length) return undefined;

  let polymorphic: { name: string; symbol: ts.Symbol } | undefined;
  const plain: ts.Signature[] = [];
  for (const signature of signatures) {
    const prop = polymorphicProp(checker, signature);
    if (prop) polymorphic ??= prop;
    else plain.push(signature);
  }
  const used = plain.length ? plain : signatures;

  // Every prop any of its signatures takes: `<Button href target>` is its anchor signature.
  const entries = new Map<string, PropEntry>();
  let members = 0;
  let openProps = false;
  for (const signature of used) {
    const param = signature.getParameters()[0];
    if (!param) continue;
    const propsType = checker.getTypeOfSymbol(param);
    if (propsType.flags & ts.TypeFlags.Any) {
      openProps = true;
      continue;
    }
    for (const part of propsType.isUnion() ? propsType.types : [propsType]) {
      members++;
      if (checker.getIndexInfosOfType(part).length) openProps = true;
      for (const prop of checker.getPropertiesOfType(part)) {
        const propName = prop.getName();
        const entry = entries.get(propName) ?? { symbols: [], required: 0, origin: originOf(prop) };
        entry.symbols.push(prop);
        if (!(prop.flags & ts.SymbolFlags.Optional)) entry.required++;
        entries.set(propName, entry);
      }
    }
  }
  if (!members && !openProps) return undefined;
  // `component`, which the default signature leaves out: listed, though its props are not checked.
  if (polymorphic && !entries.has(polymorphic.name)) {
    entries.set(polymorphic.name, {
      symbols: [polymorphic.symbol],
      required: 0,
      origin: originOf(polymorphic.symbol),
    });
  }

  // The library's own props are listed; React's DOM attributes, and a large set from another
  // package, are summarised.
  const own = (origin: string) =>
    origin === adapter.package || origin.startsWith(context.scope) || origin === 'own';
  const byOrigin = new Map<string, string[]>();
  for (const [propName, { origin }] of entries) {
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), propName]);
  }
  const summarised = new Set(
    [...byOrigin]
      .filter(
        ([origin, names]) =>
          !own(origin) && (origin === 'react' || names.length > MAX_LISTED_INHERITED),
      )
      .map(([origin]) => origin),
  );

  const element = renderedElement(checker, used.at(-1));
  const props: PropInfo[] = [];
  const variants: VariantInfo[] = [];
  for (const [propName, entry] of entries) {
    if (summarised.has(entry.origin)) continue;
    const prop = describeProp(checker, propName, entry, entry.required === members);
    if (propName === polymorphic?.name) prop.type = 'React.ElementType';
    if (!own(entry.origin)) {
      prop.description = [prop.description, `From ${entry.origin}.`].filter(Boolean).join(' ');
    }
    if (prop.values && prop.values.length > 1) {
      prop.kind = 'variant';
      const fallback = prop.default?.replace(/^(['"])(.*)\1$/, '$2');
      variants.push({
        name: propName,
        values: [...prop.values],
        ...(fallback !== undefined && prop.values.includes(fallback) ? { default: fallback } : {}),
        classes: {},
      });
    }
    props.push(prop);
  }
  // Variants first, as for source components: they are what callers most often get wrong.
  props.sort((a, b) => Number(b.kind === 'variant') - Number(a.kind === 'variant'));

  const inherits: InheritedProps[] = [];
  for (const origin of summarised) {
    const names = (byOrigin.get(origin) ?? []).sort();
    const deprecated = names.filter((propName) =>
      entries
        .get(propName)
        ?.symbols[0]?.getJsDocTags(checker)
        .some((tag) => tag.name === 'deprecated'),
    );
    inherits.push({
      from:
        origin === 'react'
          ? element
            ? `React.ComponentPropsWithRef<"${element}">`
            : 'React DOM attributes'
          : origin,
      count: names.length,
      set: registerPropSet(context.propSets, names),
      ...(deprecated.length ? { deprecated } : {}),
    });
  }

  const info: ComponentInfo = {
    name,
    aliases: [],
    importPath: adapter.package,
    exportName: name,
    source: { file: '', line: 0 },
    subcomponents: [],
    props,
    inherits,
    openProps,
    variants,
    compoundVariants: [],
    examples: [],
    classNames: [],
    cssVars: [],
    library: adapter.package,
  };
  if (polymorphic) info.polymorphic = polymorphic.name;
  if (element) info.element = element;
  const jsdoc = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  const description = jsdoc ? (adapter.describe?.(jsdoc, name) ?? jsdoc) : undefined;
  if (description) info.description = description;
  for (const tag of symbol.getJsDocTags(checker)) {
    if (tag.name !== 'deprecated') continue;
    info.deprecated = ts.displayPartsToString(tag.text).trim() || true;
  }
  adapter.annotate?.(info);
  return info;
}

function describeProp(
  checker: ts.TypeChecker,
  name: string,
  entry: PropEntry,
  required: boolean,
): PropInfo {
  const [first] = entry.symbols;
  const declared = first ? checker.getTypeOfSymbol(first) : undefined;
  const printed = declared
    ? checker
        .typeToString(
          declared,
          undefined,
          ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
        )
        .replace(/^(?:(?:undefined|null) \| )+|(?: \| (?:undefined|null))+$/g, '')
    : 'unknown';
  // The values every signature allows, when each declares a set of string literals.
  let values: string[] | undefined = [];
  for (const symbol of entry.symbols) {
    const found = literalValues(checker, checker.getTypeOfSymbol(symbol));
    if (!found) {
      values = undefined;
      break;
    }
    values.push(...found);
  }
  const ordered = values?.length
    ? declarationOrder(unique(values), entry.symbols, checker)
    : undefined;
  const prop: PropInfo = {
    name,
    type: ordered
      ? ordered.map((v) => JSON.stringify(v)).join(' | ')
      : truncate(unwrapParens(printed) || 'unknown', 200),
    required,
    kind: 'prop',
  };
  if (ordered) prop.values = ordered;
  const documented = entry.symbols.find((s) => s.getDocumentationComment(checker).length);
  const description = documented
    ? ts.displayPartsToString(documented.getDocumentationComment(checker)).trim()
    : '';
  if (description) prop.description = description;
  for (const tag of (documented ?? first)?.getJsDocTags(checker) ?? []) {
    const text = ts.displayPartsToString(tag.text).trim();
    if ((tag.name === 'default' || tag.name === 'defaultValue') && text) prop.default = text;
    if (tag.name === 'deprecated') prop.deprecated = text || true;
  }
  return prop;
}

/**
 * Values in the order the declaration writes them (`'small' | 'medium' | 'large'`), which the
 * checker does not keep; values it does not write (an app's augmentation adds them) go last.
 */
function declarationOrder(
  values: string[],
  symbols: ts.Symbol[],
  checker: ts.TypeChecker,
): string[] {
  const text = symbols
    .map((s) => {
      const declaration = s.valueDeclaration ?? s.declarations?.[0];
      return declaration &&
        (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) &&
        declaration.type
        ? typeText(checker, declaration.type, 0)
        : '';
    })
    .join('\n');
  const at = (value: string) => {
    const index = Math.max(text.indexOf(`'${value}'`), text.indexOf(`"${value}"`));
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return values
    .map((value, i) => ({ value, at: at(value), i }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((entry) => entry.value);
}

/**
 * A type as written, with the type parameters and aliases it names written out too
 * (`Variant` → `Variant extends TextFieldVariants` → `'outlined' | 'standard' | 'filled'`).
 */
function typeText(checker: ts.TypeChecker, node: ts.TypeNode, depth: number): string {
  let text = node.getText();
  if (depth > 2) return text;
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) {
      const symbol = checker.getSymbolAtLocation(child.typeName);
      for (const declaration of symbol?.declarations ?? []) {
        const referenced = ts.isTypeParameterDeclaration(declaration)
          ? declaration.constraint
          : ts.isTypeAliasDeclaration(declaration)
            ? declaration.type
            : undefined;
        if (referenced) text += `\n${typeText(checker, referenced, depth + 1)}`;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return text;
}

/**
 * The string literals a type allows, without `undefined` and `null`: a type parameter's
 * constraint (`variant?: Variant` where `Variant extends "outlined" | "filled"`). Undefined
 * when any member is not a string literal (`string & {}` leaves the set open).
 */
function literalValues(checker: ts.TypeChecker, type: ts.Type, depth = 0): string[] | undefined {
  if (depth > 4) return undefined;
  const values: string[] = [];
  for (const member of type.isUnion() ? type.types : [type]) {
    if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
    if (member.isStringLiteral()) {
      values.push(member.value);
      continue;
    }
    const constraint =
      member.flags & ts.TypeFlags.TypeParameter
        ? checker.getBaseConstraintOfType(member)
        : undefined;
    const inner =
      constraint && constraint !== member
        ? literalValues(checker, constraint, depth + 1)
        : undefined;
    if (!inner) return undefined;
    values.push(...inner);
  }
  return values.length ? unique(values) : undefined;
}

/** The native element behind a signature, from the type of the `ref` its props take. */
function renderedElement(
  checker: ts.TypeChecker,
  signature: ts.Signature | undefined,
): string | undefined {
  const param = signature?.getParameters()[0];
  if (!param) return undefined;
  const ref = checker.getPropertyOfType(checker.getTypeOfSymbol(param), 'ref');
  if (!ref) return undefined;
  const text = checker.typeToString(checker.getTypeOfSymbol(ref));
  const element = /\bHTML(\w+?)Element\b/.exec(text)?.[1];
  return element ? ELEMENT_INTERFACES[element] : undefined;
}

/**
 * The folder module that default-exports a component (`@mui/material/Button` for
 * `Button/Button.d.ts`), when the package has one for it.
 */
function defaultModule(
  program: ts.Program,
  checker: ts.TypeChecker,
  resolve: (specifier: string) => string | undefined,
  name: string,
  file: ts.SourceFile,
  symbol: ts.Symbol,
): string | undefined {
  // The folder the declaration is in, under the package: `Button` for `…/Button/Button.d.mts`.
  const folder = path.basename(path.dirname(file.fileName));
  if (!/^[A-Za-z_][\w-]*$/.test(folder)) return undefined;
  const resolved = resolve(`${name}/${folder}`);
  const index = resolved ? program.getSourceFile(resolved) : undefined;
  const module = index ? checker.getSymbolAtLocation(index) : undefined;
  const exported = module
    ? checker.getExportsOfModule(module).find((e) => e.getName() === 'default')
    : undefined;
  if (!exported) return undefined;
  const target =
    exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  return target === symbol ? `${name}/${folder}` : undefined;
}

/**
 * Styled slots a library exports next to the component they belong to (`SliderThumb` in
 * `Slider.d.ts`) become its parts, so lists show the component and its parts under it.
 */
function linkSlots(components: ComponentInfo[]): void {
  const byFile = new Map<string, ComponentInfo[]>();
  for (const component of components) {
    byFile.set(component.source.file, [...(byFile.get(component.source.file) ?? []), component]);
  }
  for (const group of byFile.values()) {
    for (const component of group) {
      const owner = group
        .filter(
          (other) =>
            other !== component &&
            component.name.length > other.name.length &&
            component.name.startsWith(other.name),
        )
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (!owner) continue;
      component.parent = owner.name;
      owner.subcomponents.push(component.name);
    }
  }
}
