import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import type { ImportMapping } from '../detect.js';
import type {
  ComponentInfo,
  ExampleInfo,
  InheritedProps,
  PropInfo,
  VariantInfo,
} from '../types.js';
import { relativePath, toPosix } from '../util/paths.js';
import { isPascalCase, truncate, unique } from '../util/strings.js';
import { classText, findVariantDefinitions, type VariantDefinition } from './cva.js';
import {
  createProgram,
  isProjectFile,
  projectFiles,
  readProjectConfig,
  type ProjectConfig,
} from './program.js';

export interface ExtractComponentsOptions {
  root: string;
  /** Absolute paths of the component source files. */
  files: string[];
  tsconfig?: string | undefined;
  /** Package name the design system is imported from; overrides tsconfig path inference. */
  importPath?: string | undefined;
  /** Specifiers from the `exports` of the package that holds the components; checked before tsconfig paths. */
  imports?: ImportMapping[] | undefined;
  /** Previous program, to let TypeScript reuse unchanged source files when watching. */
  oldProgram?: ts.Program | undefined;
}

export interface ExtractComponentsResult {
  components: ComponentInfo[];
  propSets: Record<string, string[]>;
  /** Every value the component files export, components or not (`Icons`, `buttonVariants`). */
  exports: string[];
  warnings: string[];
  program: ts.Program;
  /** Project files extraction depends on: the tsconfig chain and every module the components import. */
  dependencies: string[];
}

/**
 * Extracts React components from source with the TypeScript checker: props
 * (types, required, defaults, JSDoc), `cva()`/`tv()` variants, the native
 * element they wrap, and compound structure (`CardHeader` under `Card`,
 * `Tabs.List` via static members or `Object.assign`).
 */
export function extractComponents(options: ExtractComponentsOptions): ExtractComponentsResult {
  const project = readProjectConfig(options.root, options.tsconfig);
  const program = createProgram(options.files, project, options.oldProgram);
  const checker = program.getTypeChecker();
  const propSets = new Map<string, string[]>();
  const warnings: string[] = [];
  const components: ComponentInfo[] = [];
  const exports = new Set<string>();
  const seen = new Set<ts.Node>();

  for (const file of options.files) {
    const sourceFile = program.getSourceFile(file);
    const rel = relativePath(options.root, file);
    if (!sourceFile) {
      warnings.push(`${rel}: could not be read by TypeScript`);
      continue;
    }
    for (const name of valueExports(checker, sourceFile)) exports.add(name);
    const context: FileContext = {
      checker,
      sourceFile,
      rel,
      importPath: importPathFor(options, project, file),
      definitions: findVariantDefinitions(sourceFile),
      propSets,
    };
    const candidates = findCandidates(context).filter((c) => {
      if (seen.has(c.declaration)) return false;
      seen.add(c.declaration);
      return true;
    });
    const fileComponents = candidates.map((candidate) => buildComponent(context, candidate));
    linkComposition(fileComponents);
    components.push(...fileComponents);
  }

  return {
    components,
    propSets: Object.fromEntries(propSets),
    exports: [...exports].sort(),
    warnings,
    program,
    dependencies: unique([...project.configFiles.filter(isProjectFile), ...projectFiles(program)]),
  };
}

interface FileContext {
  checker: ts.TypeChecker;
  sourceFile: ts.SourceFile;
  rel: string;
  importPath: string;
  definitions: Map<string, VariantDefinition>;
  propSets: Map<string, string[]>;
}

interface Candidate {
  /** JSX name: `Button` or `Tabs.List`. */
  name: string;
  exportName: string;
  /** Local identifier of the declaration (`TabsList`). */
  localName: string;
  declaration: ts.Node;
  /** The render function, with forwardRef/memo unwrapped. */
  fn?: ts.SignatureDeclaration | undefined;
  /** Explicit props type from `forwardRef<El, Props>`, `FC<Props>` or a class heritage clause. */
  propsTypeNode?: ts.TypeNode | undefined;
  /** First type argument of `forwardRef<El, Props>`. */
  refTypeNode?: ts.TypeNode | undefined;
  /** Props from the call signature, for aliases such as `const Dialog = DialogPrimitive.Root`. */
  propsType?: ts.Type | undefined;
  /** Symbol to read JSDoc from. */
  symbol?: ts.Symbol | undefined;
  /** Static members: `Card.Header = CardHeader` or `Object.assign(Root, { Header })`. */
  members: Map<string, ts.Expression>;
  aliases: string[];
  parent?: string | undefined;
}

// ─── Discovery ──────────────────────────────────────────────────────────────

function findCandidates(context: FileContext): Candidate[] {
  const { checker, sourceFile } = context;
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];

  const byLocal = new Map<string, Candidate>();
  const candidates: Candidate[] = [];

  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (!declaration || declaration.getSourceFile() !== sourceFile) continue;
    const localName = declarationName(declaration);
    const exportName = exported.getName();
    const name = exportName === 'default' ? (localName ?? '') : exportName;
    if (!isPascalCase(name)) continue;
    const analysis = analyze(declaration, checker);
    if (!analysis) continue;
    const candidate: Candidate = {
      name,
      exportName,
      localName: localName ?? name,
      declaration,
      symbol,
      aliases: [],
      ...analysis,
    };
    byLocal.set(candidate.localName, candidate);
    candidates.push(candidate);
  }

  // `Card.Header = CardHeader` statements.
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement)) continue;
    const expr = statement.expression;
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expr.left) &&
      ts.isIdentifier(expr.left.expression)
    ) {
      const owner = byLocal.get(expr.left.expression.text);
      if (owner) owner.members.set(expr.left.name.text, expr.right);
    }
  }

  // Resolve members into candidates of their own (or aliases of exported ones).
  for (const owner of [...candidates]) {
    for (const [member, expression] of owner.members) {
      const accessName = `${owner.name}.${member}`;
      const target = ts.isIdentifier(expression) ? byLocal.get(expression.text) : undefined;
      if (target) {
        target.aliases.push(accessName);
        target.parent ??= owner.name;
        continue;
      }
      const resolved = resolveExpression(expression, checker);
      if (!resolved) {
        // `Root: TooltipPrimitive.Root` or `Action: Banner.Action`: a library's component,
        // or another component's member, as `const Dialog = DialogPrimitive.Root` is.
        const access = skipOuter(expression);
        const analysis = ts.isPropertyAccessExpression(access)
          ? analyzeLibraryComponent(access, checker)
          : undefined;
        if (!analysis) continue;
        candidates.push({
          name: accessName,
          exportName: accessName,
          localName: accessName,
          declaration: access,
          aliases: [],
          parent: owner.name,
          ...analysis,
        });
        continue;
      }
      const analysis = analyze(resolved.declaration, checker);
      if (!analysis) continue;
      const candidate: Candidate = {
        name: accessName,
        exportName: accessName,
        localName: resolved.name ?? accessName,
        declaration: resolved.declaration,
        symbol: resolved.symbol,
        aliases: [],
        parent: owner.name,
        ...analysis,
      };
      byLocal.set(candidate.localName, candidate);
      candidates.push(candidate);
    }
  }
  return candidates;
}

interface Analysis {
  fn?: ts.SignatureDeclaration | undefined;
  propsTypeNode?: ts.TypeNode | undefined;
  refTypeNode?: ts.TypeNode | undefined;
  propsType?: ts.Type | undefined;
  members: Map<string, ts.Expression>;
}

/** Decides whether a declaration is a component and finds its render function. */
function analyze(declaration: ts.Node, checker: ts.TypeChecker, depth = 0): Analysis | undefined {
  if (depth > 5) return undefined;
  if (ts.isFunctionDeclaration(declaration)) {
    return { fn: declaration, members: new Map() };
  }
  if (ts.isClassDeclaration(declaration)) {
    const heritage = declaration.heritageClauses?.find(
      (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
    )?.types[0];
    if (!heritage || !/Component$/.test(heritage.expression.getText())) return undefined;
    return { propsTypeNode: heritage.typeArguments?.[0], members: new Map() };
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const result = analyzeExpression(declaration.initializer, checker, depth);
    if (!result) return undefined;
    // `const Button: React.FC<ButtonProps> = (props) => ...`
    if (!result.propsTypeNode && declaration.type && ts.isTypeReferenceNode(declaration.type)) {
      result.propsTypeNode = declaration.type.typeArguments?.[0];
    }
    return result;
  }
  return undefined;
}

function analyzeExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  depth: number,
): Analysis | undefined {
  const expr = skipOuter(expression);
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return { fn: expr, members: new Map() };
  }
  if (ts.isIdentifier(expr)) {
    const resolved = resolveExpression(expr, checker);
    return resolved
      ? analyze(resolved.declaration, checker, depth + 1)
      : analyzeLibraryComponent(expr, checker);
  }
  // `const Dialog = DialogPrimitive.Root`
  if (ts.isPropertyAccessExpression(expr)) return analyzeLibraryComponent(expr, checker);
  if (!ts.isCallExpression(expr)) return undefined;

  const callee = expr.expression.getText();
  const [first, second] = expr.arguments;
  if (/(^|\.)(forwardRef|memo)$/.test(callee) && first) {
    const inner = analyzeExpression(first, checker, depth + 1);
    if (!inner) return undefined;
    if (/forwardRef$/.test(callee) && expr.typeArguments) {
      inner.refTypeNode ??= expr.typeArguments[0];
      inner.propsTypeNode ??= expr.typeArguments[1];
    } else if (/memo$/.test(callee) && expr.typeArguments) {
      inner.propsTypeNode ??= expr.typeArguments[0];
    }
    return inner;
  }
  if (callee === 'Object.assign' && first && second && ts.isObjectLiteralExpression(second)) {
    const inner = analyzeExpression(first, checker, depth + 1);
    if (!inner) return undefined;
    for (const prop of second.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        inner.members.set(prop.name.text, prop.initializer);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        inner.members.set(prop.name.text, prop.name);
      }
    }
    return inner;
  }
  return undefined;
}

/**
 * A component re-exported from a library (`const Dialog = DialogPrimitive.Root`,
 * `const Form = FormProvider`), whose declaration lives in a `.d.ts` file: its
 * type is callable or constructible, and its props are the first parameter.
 */
function analyzeLibraryComponent(
  expr: ts.Identifier | ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
): Analysis | undefined {
  const type = checker.getTypeAtLocation(expr);
  if (isAny(type)) {
    // The library's types are not installed. An import is still most likely a
    // component here; keep it with open props rather than report it missing.
    let root: ts.Expression = expr;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    const symbol = ts.isIdentifier(root) ? checker.getSymbolAtLocation(root) : undefined;
    return symbol && symbol.flags & ts.SymbolFlags.Alias ? { members: new Map() } : undefined;
  }
  const signature = type.getCallSignatures()[0] ?? type.getConstructSignatures()[0];
  if (!signature) return undefined;
  const param = signature.getParameters()[0];
  return {
    propsType: param ? checker.getTypeOfSymbolAtLocation(param, expr) : undefined,
    members: new Map(),
  };
}

function resolveExpression(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): { declaration: ts.Node; symbol: ts.Symbol; name?: string | undefined } | undefined {
  const expr = skipOuter(expression);
  if (!ts.isIdentifier(expr)) {
    return undefined;
  }
  // `Object.assign(Root, { Title })`: the shorthand's name is the property, its value the function.
  let symbol =
    ts.isShorthandPropertyAssignment(expr.parent) && expr.parent.name === expr
      ? checker.getShorthandAssignmentValueSymbol(expr.parent)
      : checker.getSymbolAtLocation(expr);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration || declaration.getSourceFile().isDeclarationFile) return undefined;
  return { declaration, symbol, name: declarationName(declaration) };
}

function skipOuter(expression: ts.Expression): ts.Expression {
  let expr = expression;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

function declarationName(declaration: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) &&
    declaration.name
  ) {
    return declaration.name.text;
  }
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    return declaration.name.text;
  }
  return undefined;
}

// ─── Building the component ─────────────────────────────────────────────────

function buildComponent(context: FileContext, candidate: Candidate): ComponentInfo {
  const { checker, sourceFile } = context;
  const param = candidate.fn?.parameters[0];
  const typeNode = candidate.propsTypeNode ?? param?.type;
  const { primary, nested } = linkedDefinitions(context, candidate, typeNode);
  const definitions = [...primary, ...nested];
  const { props, inherits, openProps } = extractProps(context, candidate, typeNode, param);
  // A definition used further in adds only the keys the component's own lack and that it
  // takes as props: React Aria's checkbox sizes its inner box, while documenso's Button
  // already has a `size` that its spinner's `loaderVariants` must not add classes to.
  const own = new Set(primary.flatMap((d) => d.variants.map((v) => v.name)));
  const variants = mergeVariants([
    ...primary.flatMap((d) => d.variants),
    ...nested
      .flatMap((d) => d.variants)
      .filter((v) => !own.has(v.name) && props.some((p) => p.name === v.name)),
  ]);
  mergeVariantProps(props, variants);
  applyDestructuredDefaults(props, param);

  const position = sourceFile.getLineAndCharacterOfPosition(candidate.declaration.getStart());
  const info: ComponentInfo = {
    name: candidate.name,
    aliases: unique(candidate.aliases),
    importPath: context.importPath,
    exportName: candidate.exportName,
    source: { file: context.rel, line: position.line + 1 },
    subcomponents: [],
    props,
    inherits,
    openProps,
    variants,
    compoundVariants: (primary.length ? primary : nested).flatMap((d) => d.compoundVariants),
    examples: [],
    classNames: [],
    cssVars: [],
  };

  const symbol = candidate.symbol;
  if (symbol) {
    const description = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
    if (description) info.description = description;
    for (const tag of symbol.getJsDocTags(checker)) {
      const text = ts.displayPartsToString(tag.text).trim();
      if (tag.name === 'deprecated') info.deprecated = text || true;
      if (tag.name === 'example' && text) info.examples.push(jsdocExample(text));
    }
  }
  if (candidate.parent) info.parent = candidate.parent;

  const element = inferElement(context, candidate, typeNode);
  if (element) info.element = element;

  const classSources: ts.Node[] = definitions.map((d) => d.node);
  if (candidate.fn) classSources.push(candidate.fn);
  const classes = collectClasses(classSources);
  info.classNames = classes.classNames;
  info.cssVars = classes.cssVars;
  return info;
}

function jsdocExample(text: string): ExampleInfo {
  const fenced = /```(\w+)?[^\n]*\n([\s\S]*?)```/.exec(text);
  return {
    code: (fenced?.[2] ?? text).trim(),
    lang: fenced?.[1] ?? 'tsx',
    source: 'jsdoc',
  };
}

/**
 * cva/tv definitions that belong to this component. `primary`: those its props
 * take through `VariantProps<typeof x>`, and those called in the className of
 * the element it returns. `nested`: the rest it calls or names, which style
 * something inside it (documenso's `loaderVariants` on the spinner in its
 * Button). Without a primary one, every reference is primary, as before.
 */
function linkedDefinitions(
  context: FileContext,
  candidate: Candidate,
  typeNode: ts.TypeNode | undefined,
): { primary: VariantDefinition[]; nested: VariantDefinition[] } {
  const { definitions } = context;
  if (!definitions.size) return { primary: [], nested: [] };
  const typeText = typeNode ? expandLocalTypeText(context, typeNode) : '';
  const bodyText = candidate.fn?.getText() ?? '';
  const rootClasses = candidate.fn ? rootClassText(candidate.fn) : '';
  const called = (d: VariantDefinition, text: string) =>
    new RegExp(`\\b${d.name}\\s*\\(`).test(text);
  const referenced = [...definitions.values()].filter(
    (d) => new RegExp(`typeof\\s+${d.name}\\b`).test(typeText) || called(d, bodyText),
  );
  const primary = referenced.filter(
    (d) =>
      new RegExp(`VariantProps\\s*<\\s*typeof\\s+${d.name}\\b`).test(typeText) ||
      called(d, rootClasses),
  );
  if (!primary.length) return { primary: referenced, nested: [] };
  return { primary, nested: referenced.filter((d) => !primary.includes(d)) };
}

/** The className (or class) expressions of the elements a render function returns, as text. */
function rootClassText(fn: ts.SignatureDeclaration): string {
  const returned: ts.Expression[] = [];
  const body = (fn as { body?: ts.Node }).body;
  if (body && !ts.isBlock(body)) returned.push(body as ts.Expression);
  else if (body) {
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node)) {
        if (node.expression) returned.push(node.expression);
        return;
      }
      if (ts.isFunctionLike(node)) return;
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
  }
  const texts: string[] = [];
  const stack = [...returned];
  for (let expr = stack.pop(); expr; expr = stack.pop()) {
    if (ts.isParenthesizedExpression(expr)) stack.push(expr.expression);
    else if (ts.isConditionalExpression(expr)) stack.push(expr.whenTrue, expr.whenFalse);
    else if (ts.isBinaryExpression(expr)) stack.push(expr.left, expr.right);
    else if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr)) {
      const opening = ts.isJsxElement(expr) ? expr.openingElement : expr;
      for (const attribute of opening.attributes.properties) {
        if (
          ts.isJsxAttribute(attribute) &&
          /^(?:className|class)$/.test(attribute.name.getText())
        ) {
          texts.push(attribute.initializer?.getText() ?? '');
        }
      }
    } else if (ts.isJsxFragment(expr)) {
      for (const child of expr.children) {
        if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) stack.push(child);
      }
    }
  }
  return texts.join('\n');
}

/**
 * The text of a props type plus any local interfaces/aliases it references,
 * so `interface ButtonProps extends VariantProps<typeof buttonVariants>` and
 * `ButtonHTMLAttributes<HTMLButtonElement>` are visible to text heuristics.
 */
function expandLocalTypeText(context: FileContext, typeNode: ts.Node, depth = 0): string {
  let text = typeNode.getText();
  if (depth > 4) return text;
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
      const nameNode = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
      const symbol = context.checker.getSymbolAtLocation(nameNode);
      for (const declaration of symbol?.declarations ?? []) {
        if (
          declaration.getSourceFile() === context.sourceFile &&
          (ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))
        ) {
          text += `\n${expandLocalTypeText(context, declaration, depth + 1)}`;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(typeNode);
  return text;
}

// ─── Props ──────────────────────────────────────────────────────────────────

/** Whether a type mentions a type parameter, at the top or inside a conditional or an intersection. */
function dependsOnTypeParameter(type: ts.Type, depth = 0): boolean {
  if (depth > 4) return false;
  if (type.flags & ts.TypeFlags.TypeParameter) return true;
  if (type.flags & (ts.TypeFlags.Conditional | ts.TypeFlags.Index | ts.TypeFlags.IndexedAccess)) {
    return true;
  }
  if (type.isUnionOrIntersection()) {
    return type.types.some((t) => dependsOnTypeParameter(t, depth + 1));
  }
  const args = (type as ts.TypeReference).aliasTypeArguments ?? [];
  return args.some((t) => dependsOnTypeParameter(t, depth + 1));
}

interface ExtractedProps {
  props: PropInfo[];
  inherits: InheritedProps[];
  openProps: boolean;
}

function extractProps(
  context: FileContext,
  candidate: Candidate,
  typeNode: ts.TypeNode | undefined,
  param: ts.ParameterDeclaration | undefined,
): ExtractedProps {
  const { checker } = context;
  const location = typeNode ?? param ?? candidate.declaration;
  let type: ts.Type | undefined;
  if (typeNode) type = checker.getTypeFromTypeNode(typeNode);
  else if (param) type = checker.getTypeAtLocation(param);
  else type = candidate.propsType;
  if (!type) return { props: [], inherits: [], openProps: !candidate.fn && !typeNode };

  let openProps = false;
  let types: ts.Type[];
  if (isAny(type)) {
    // An unresolved part (e.g. React types not installed) collapses the whole
    // intersection to `any`. Recover the parts that do resolve.
    openProps = true;
    types = typeNode ? constituents(context, typeNode).filter((t) => !isAny(t)) : [];
  } else {
    types = type.isUnion() ? type.types : [type];
    if (typeNode && hasUnresolvedPart(context.checker, typeNode)) openProps = true;
  }
  // A generic component's props depend on its type argument (cal.com's
  // `Skeleton<T>({ as }: SkeletonProps<T>)` takes the props of whatever `as` renders):
  // what the checker gives for the bare parameter is not the list.
  if (candidate.fn?.typeParameters?.length && dependsOnTypeParameter(type)) openProps = true;

  const own = new Map<string, { symbol: ts.Symbol; requiredIn: number; origin: string }>();
  for (const t of types) {
    if (checker.getIndexInfosOfType(t).length) openProps = true;
    for (const symbol of checker.getPropertiesOfType(t)) {
      const entry = own.get(symbol.getName()) ?? {
        symbol,
        requiredIn: 0,
        origin: originOf(symbol),
      };
      if (!(symbol.flags & ts.SymbolFlags.Optional)) entry.requiredIn++;
      own.set(symbol.getName(), entry);
    }
  }

  // Props declared by React's DOM typings, or by a package contributing a
  // large set, are summarised; the rest are documented individually.
  const byOrigin = new Map<string, string[]>();
  for (const [name, { origin }] of own) {
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), name]);
  }
  const summarised = new Set(
    [...byOrigin]
      .filter(
        ([origin, names]) =>
          origin === 'react' || (origin !== 'own' && names.length > MAX_LISTED_INHERITED),
      )
      .map(([origin]) => origin),
  );

  const props: PropInfo[] = [];
  for (const [name, { symbol, requiredIn, origin }] of own) {
    if (summarised.has(origin)) continue;
    props.push(describeProp(context, name, symbol, location, requiredIn === types.length, origin));
  }

  const inherits: InheritedProps[] = [];
  for (const origin of summarised) {
    const names = (byOrigin.get(origin) ?? []).sort();
    const key = registerPropSet(context.propSets, names);
    const from = origin === 'react' ? inheritedLabel(context, typeNode) : origin;
    const deprecated = names.filter((name) => {
      const symbol = own.get(name)?.symbol;
      return symbol?.getJsDocTags(checker).some((tag) => tag.name === 'deprecated');
    });
    inherits.push({
      from,
      count: names.length,
      set: key,
      ...(deprecated.length ? { deprecated } : {}),
    });
  }
  return { props, inherits, openProps };
}

/** Packages contributing more props than this are summarised instead of listed. */
const MAX_LISTED_INHERITED = 40;

/** Flattens intersections and local aliases into the types they are built from. */
function constituents(context: FileContext, typeNode: ts.TypeNode, depth = 0): ts.Type[] {
  const { checker } = context;
  if (depth > 4) return [checker.getTypeFromTypeNode(typeNode)];
  if (ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.flatMap((t) => constituents(context, t, depth + 1));
  }
  if (ts.isParenthesizedTypeNode(typeNode)) return constituents(context, typeNode.type, depth + 1);
  if (ts.isTypeReferenceNode(typeNode)) {
    const symbol = checker.getSymbolAtLocation(typeNode.typeName);
    const alias = symbol?.declarations?.find(ts.isTypeAliasDeclaration);
    if (alias && alias.getSourceFile() === context.sourceFile && !alias.typeParameters) {
      return constituents(context, alias.type, depth + 1);
    }
    // A local interface: its own members plus whatever it extends.
    const iface = symbol?.declarations?.find(ts.isInterfaceDeclaration);
    if (iface && iface.getSourceFile() === context.sourceFile) {
      const bases = (iface.heritageClauses ?? []).flatMap((clause) =>
        clause.types.map((t) => checker.getTypeAtLocation(t)),
      );
      return [checker.getTypeFromTypeNode(typeNode), ...bases];
    }
  }
  return [checker.getTypeFromTypeNode(typeNode)];
}

/**
 * Whether part of a props type does not resolve (e.g. React types not
 * installed), looking through intersections and unions, type arguments
 * (`Omit<ButtonProps, "type">`), and the aliases and interfaces of any project
 * file, including what those interfaces extend. Such props are open: the
 * linter cannot see them, so it must not report them as unknown.
 */
function hasUnresolvedPart(
  checker: ts.TypeChecker,
  typeNode: ts.TypeNode,
  seen = new Set<ts.Node>(),
  depth = 0,
): boolean {
  if (depth > 16) return false;
  if (isAny(checker.getTypeFromTypeNode(typeNode))) return true;
  const next = (node: ts.TypeNode) => hasUnresolvedPart(checker, node, seen, depth + 1);
  if (ts.isIntersectionTypeNode(typeNode) || ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.some(next);
  }
  if (ts.isParenthesizedTypeNode(typeNode)) return next(typeNode.type);
  if (!ts.isTypeReferenceNode(typeNode) && !ts.isExpressionWithTypeArguments(typeNode)) {
    return false;
  }
  if (typeNode.typeArguments?.some(next)) return true;
  const symbol = checker.getSymbolAtLocation(
    ts.isTypeReferenceNode(typeNode) ? typeNode.typeName : typeNode.expression,
  );
  const declared =
    symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  for (const declaration of declared?.declarations ?? []) {
    if (seen.has(declaration) || !isProjectFile(declaration.getSourceFile().fileName)) continue;
    seen.add(declaration);
    if (ts.isTypeAliasDeclaration(declaration) && next(declaration.type)) return true;
    if (
      ts.isInterfaceDeclaration(declaration) &&
      (declaration.heritageClauses ?? []).some((clause) => clause.types.some(next))
    ) {
      return true;
    }
  }
  return false;
}

/** Where a prop is declared: the project, React's DOM typings, or another package. */
export function originOf(symbol: ts.Symbol): string {
  const declaration = symbol.declarations?.[0];
  if (!declaration) return 'own';
  const file = toPosix(declaration.getSourceFile().fileName);
  const index = file.lastIndexOf('/node_modules/');
  if (index === -1) return declaration.getSourceFile().isDeclarationFile ? 'react' : 'own';
  const rest = file.slice(index + '/node_modules/'.length).split('/');
  const pkg = rest[0]?.startsWith('@') ? `${rest[0]}/${rest[1] ?? ''}` : (rest[0] ?? '');
  if (pkg === '@types/react' || pkg === 'typescript') return 'react';
  return pkg;
}

function describeProp(
  context: FileContext,
  name: string,
  symbol: ts.Symbol,
  location: ts.Node,
  required: boolean,
  origin: string,
): PropInfo {
  const { checker } = context;
  const declared = checker.getTypeOfSymbolAtLocation(symbol, location);
  const type = checker.getNonNullableType(declared);
  // Print the declared type so aliases such as `ReactNode` survive, then drop
  // the `undefined` that optional props carry.
  const printed = checker
    .typeToString(
      declared,
      undefined,
      ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
    )
    .replace(/^(?:(?:undefined|null) \| )+|(?: \| (?:undefined|null))+$/g, '');
  const prop: PropInfo = {
    name,
    type: truncate(unwrapParens(printed) || 'unknown', 200),
    required,
    kind: 'prop',
  };
  const values = literalValues(type);
  if (values) prop.values = values;
  const description = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
  if (description) prop.description = description;
  for (const tag of symbol.getJsDocTags(checker)) {
    const text = ts.displayPartsToString(tag.text).trim();
    if ((tag.name === 'default' || tag.name === 'defaultValue') && text) prop.default = text;
    if (tag.name === 'deprecated') prop.deprecated = text || true;
  }
  if (origin !== 'own') {
    prop.description = [prop.description, `From ${origin}.`].filter(Boolean).join(' ');
  }
  return prop;
}

/** `(() => void)` → `() => void`, but leaves `(a) => (b)` alone. */
export function unwrapParens(text: string): string {
  if (!text.startsWith('(') || !text.endsWith(')')) return text;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    if (depth === 0 && i < text.length - 1) return text;
  }
  return text.slice(1, -1);
}

function literalValues(type: ts.Type): string[] | undefined {
  const members = type.isUnion() ? type.types : [type];
  if (!members.every((t) => t.isStringLiteral())) return undefined;
  return members.map((t) => t.value);
}

function isAny(type: ts.Type): boolean {
  return (type.flags & ts.TypeFlags.Any) !== 0;
}

export function registerPropSet(sets: Map<string, string[]>, names: string[]): string {
  const key = createHash('sha1').update(names.join(',')).digest('hex').slice(0, 10);
  if (!sets.has(key)) sets.set(key, names);
  return key;
}

/** `React.ComponentProps<"button">`, or the heritage clauses of a props interface. */
function inheritedLabel(context: FileContext, typeNode: ts.TypeNode | undefined): string {
  if (!typeNode) return 'React DOM attributes';
  const parts: string[] = [];
  const visit = (node: ts.TypeNode, depth: number): void => {
    if (depth > 4) return;
    if (ts.isIntersectionTypeNode(node)) {
      node.types.forEach((t) => {
        visit(t, depth + 1);
      });
      return;
    }
    if (ts.isTypeReferenceNode(node)) {
      const symbol = context.checker.getSymbolAtLocation(node.typeName);
      const local = symbol?.declarations?.find((d) => d.getSourceFile() === context.sourceFile);
      if (local && ts.isTypeAliasDeclaration(local)) {
        visit(local.type, depth + 1);
        return;
      }
      if (local && ts.isInterfaceDeclaration(local)) {
        for (const clause of local.heritageClauses ?? []) {
          for (const t of clause.types)
            if (!/VariantProps/.test(t.getText())) parts.push(t.getText());
        }
        return;
      }
      if (!/VariantProps/.test(node.getText())) parts.push(node.getText());
    }
  };
  visit(typeNode, 0);
  return parts.length ? parts.join(' & ') : 'React DOM attributes';
}

/**
 * A boolean key named like a render state (`isDisabled`, `isPending`, `isSelected`) styles a
 * state the component reports, as React Aria's starter passes `renderProps` into `tv()`. It is
 * not a variant callers choose; the prop, if the component takes one, stays a plain prop.
 */
function isStateKey(variant: VariantInfo): boolean {
  return (
    /^is[A-Z]/.test(variant.name) && variant.values.every((v) => v === 'true' || v === 'false')
  );
}

/**
 * The variants a component offers, once each: several linked definitions (a box and its label,
 * a base the component extends) can declare the same key. Values keep their first order.
 */
function mergeVariants(variants: VariantInfo[]): VariantInfo[] {
  const merged = new Map<string, VariantInfo>();
  for (const variant of variants) {
    if (isStateKey(variant)) continue;
    const existing = merged.get(variant.name);
    if (!existing) {
      merged.set(variant.name, {
        ...variant,
        values: [...variant.values],
        classes: { ...variant.classes },
      });
      continue;
    }
    for (const value of variant.values) {
      if (!existing.values.includes(value)) existing.values.push(value);
      const classes = variant.classes[value];
      if (classes) {
        existing.classes[value] = [existing.classes[value], classes].filter(Boolean).join(' ');
      }
    }
    existing.default ??= variant.default;
  }
  return [...merged.values()];
}

/** Adds or enriches variant props from cva/tv definitions (works without type info). */
function mergeVariantProps(props: PropInfo[], variants: VariantInfo[]): void {
  for (const variant of variants) {
    const isBoolean = variant.values.every((v) => v === 'true' || v === 'false');
    const existing = props.find((p) => p.name === variant.name);
    const prop: PropInfo = existing ?? {
      name: variant.name,
      type: isBoolean ? 'boolean' : variant.values.map((v) => JSON.stringify(v)).join(' | '),
      required: false,
      kind: 'variant',
    };
    prop.kind = 'variant';
    if (!isBoolean) {
      // The checker orders union members arbitrarily; the cva config order is the meaningful one.
      prop.values = [...variant.values];
      prop.type = variant.values.map((v) => JSON.stringify(v)).join(' | ');
    }
    if (variant.default !== undefined)
      prop.default = isBoolean ? variant.default : JSON.stringify(variant.default);
    if (!existing) props.push(prop);
  }
  // Variants first: they are what callers most often get wrong.
  props.sort((a, b) => Number(b.kind === 'variant') - Number(a.kind === 'variant'));
}

function applyDestructuredDefaults(
  props: PropInfo[],
  param: ts.ParameterDeclaration | undefined,
): void {
  if (!param || !ts.isObjectBindingPattern(param.name)) return;
  for (const element of param.name.elements) {
    if (!element.initializer || element.dotDotDotToken) continue;
    const nameNode = element.propertyName ?? element.name;
    if (!ts.isIdentifier(nameNode) && !ts.isStringLiteral(nameNode)) continue;
    const prop = props.find((p) => p.name === nameNode.text);
    if (prop) prop.default = element.initializer.getText();
  }
}

// ─── Element inference ──────────────────────────────────────────────────────

export const ELEMENT_INTERFACES: Record<string, string> = {
  Anchor: 'a',
  Button: 'button',
  Input: 'input',
  TextArea: 'textarea',
  Select: 'select',
  Label: 'label',
  Dialog: 'dialog',
  Form: 'form',
  Image: 'img',
  Table: 'table',
  HR: 'hr',
  Progress: 'progress',
  Meter: 'meter',
  Div: 'div',
  Span: 'span',
  Paragraph: 'p',
  Heading: 'h2',
  UList: 'ul',
  OList: 'ol',
  LI: 'li',
  Details: 'details',
  FieldSet: 'fieldset',
  Output: 'output',
};

function inferElement(
  context: FileContext,
  candidate: Candidate,
  typeNode: ts.TypeNode | undefined,
): string | undefined {
  const typeText = typeNode ? expandLocalTypeText(context, typeNode) : '';
  const componentProps = /ComponentProps(?:WithRef|WithoutRef)?<\s*["'`](\w+)["'`]\s*>/.exec(
    typeText,
  );
  if (componentProps?.[1]) return componentProps[1];
  const htmlAttributes = /HTMLAttributes<\s*HTML(\w+)Element\s*>/.exec(typeText);
  if (htmlAttributes?.[1]) return ELEMENT_INTERFACES[htmlAttributes[1]];
  const ref = candidate.refTypeNode?.getText();
  const refElement = ref ? /^HTML(\w+)Element$/.exec(ref)?.[1] : undefined;
  if (refElement) return ELEMENT_INTERFACES[refElement];
  return candidate.fn ? renderedElement(candidate.fn) : undefined;
}

/** The intrinsic element returned by the render function, following `const Comp = asChild ? Slot : "button"`. */
function renderedElement(fn: ts.SignatureDeclaration): string | undefined {
  let found: string | undefined;
  const stringAssignments = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const literal = firstStringLiteral(node.initializer);
      if (literal) stringAssignments.set(node.name.text, literal);
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
      if (ts.isIdentifier(tag)) {
        found = /^[a-z]/.test(tag.text) ? tag.text : stringAssignments.get(tag.text);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

function firstStringLiteral(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isConditionalExpression(node)) {
    return firstStringLiteral(node.whenFalse) ?? firstStringLiteral(node.whenTrue);
  }
  return undefined;
}

// ─── Classes and composition ────────────────────────────────────────────────

/** Utility classes and CSS variables referenced from class strings in the given nodes. */
function collectClasses(nodes: ts.Node[]): { classNames: string[]; cssVars: string[] } {
  const classNames = new Set<string>();
  const cssVars = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && /^(className|class)$/.test(node.name.getText())) {
      addClasses(node.initializer ? classText(node.initializer) : '');
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      if (
        /^(cn|clsx|cx|twMerge|twJoin|classNames|cva|tv)$/.test(callee) ||
        /Variants$/.test(callee)
      ) {
        node.arguments.forEach((arg) => {
          addClasses(classText(arg));
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  const addClasses = (text: string) => {
    for (const cls of text.split(/\s+/)) {
      if (!cls) continue;
      classNames.add(cls);
      for (const match of cls.matchAll(/--[\w-]+/g)) cssVars.add(match[0]);
    }
  };
  nodes.forEach(visit);
  return { classNames: [...classNames], cssVars: [...cssVars] };
}

/**
 * shadcn/ui-style flat parts (`CardHeader` next to `Card` in card.tsx) belong
 * to the longest component name they extend in the same file.
 */
function linkComposition(components: ComponentInfo[]): void {
  const names = components.map((c) => c.name);
  const flat = new Map<string, ComponentInfo[]>();
  for (const component of components) {
    if (component.parent || component.name.includes('.')) continue;
    const parent = names
      .filter(
        (n) =>
          n !== component.name &&
          !n.includes('.') &&
          component.name.startsWith(n) &&
          /^[A-Z]/.test(component.name.charAt(n.length)),
      )
      .sort((a, b) => b.length - a.length)[0];
    if (!parent) continue;
    component.parent = parent;
    flat.set(parent, [...(flat.get(parent) ?? []), component]);
  }
  // `CheckboxGroup` next to `Checkbox` (Jolly UI, React Aria's starter) holds checkboxes; it is
  // not a part of one. When every name-prefix part of a component is such a container, none
  // of them is a part. A family with other parts (`SelectGroup` beside `SelectItem`) is one.
  for (const [parent, parts] of flat) {
    if (parts.every((part) => /^(Group|List)$/.test(part.name.slice(parent.length)))) {
      for (const part of parts) delete part.parent;
    }
  }
  for (const component of components) {
    component.subcomponents = components
      .filter((c) => c.parent === component.name)
      .map((c) => c.name);
  }
}

// ─── Import paths ───────────────────────────────────────────────────────────

/**
 * The specifier an app would import this file with: the configured package
 * name (or `@acme/ui/{path}` pattern), a tsconfig `paths` alias
 * (`@/components/ui/button`), or a path relative to the root.
 */
function importPathFor(
  options: ExtractComponentsOptions,
  project: ProjectConfig,
  file: string,
): string {
  if (options.importPath?.includes('{path}')) {
    return options.importPath.replace('{path}', packagePath(file));
  }
  if (options.importPath) return options.importPath;
  const fromExports = exportSpecifier(options.imports ?? [], relativePath(options.root, file));
  if (fromExports) return fromExports;
  const withoutExt = file.replace(/\.(tsx?|jsx?|mts|cts)$/, '').replace(/\/index$/, '');
  for (const [pattern, targets] of Object.entries(project.paths)) {
    if (!pattern.endsWith('/*')) continue;
    for (const target of targets) {
      if (!target.endsWith('/*')) continue;
      const targetDir = path.resolve(project.pathsBase, target.slice(0, -2));
      const rel = path.relative(targetDir, withoutExt);
      if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        return `${pattern.slice(0, -2)}/${toPosix(rel)}`;
      }
    }
  }
  const rel = relativePath(options.root, withoutExt);
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** `primitives/button` for `…/packages/ui/primitives/button.tsx`: the file within its package, without extension. */
function packagePath(file: string): string {
  const module = file.replace(/\.(tsx?|jsx?|mts|cts)$/, '').replace(/\/index$/, '');
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return toPosix(path.relative(dir, module));
  }
  return toPosix(path.basename(module));
}

/** `@midday/ui/button` for `…/src/components/button.tsx`, through an exact or `*` export. */
function exportSpecifier(imports: ImportMapping[], file: string): string | undefined {
  for (const { specifier, target } of imports) {
    const star = target.indexOf('*');
    if (star === -1) {
      if (target === file) return specifier;
      continue;
    }
    const before = target.slice(0, star);
    const after = target.slice(star + 1);
    if (
      file.length >= before.length + after.length &&
      file.startsWith(before) &&
      file.endsWith(after)
    ) {
      return specifier.replace('*', file.slice(before.length, file.length - after.length));
    }
  }
  return undefined;
}

/** Names a module exports as values (types cannot be JSX tags), without `default`. */
function valueExports(checker: ts.TypeChecker, sourceFile: ts.SourceFile): string[] {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];
  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((symbol) => {
      if (symbol.name === 'default') return false;
      // A re-export that does not resolve (missing node_modules) comes back as the
      // checker's `unknown` property symbol, so it counts as a value: better to
      // trust it than to report it as invented.
      const target =
        symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return (target.flags & ts.SymbolFlags.Value) !== 0;
    })
    .map((symbol) => symbol.name);
}
