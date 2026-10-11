import path from 'node:path';

import ts from 'typescript';

import type { ComponentInfo, PropInfo, TextEdit } from '../../types.js';
import { propertyName } from '../../extract/cva.js';
import { toPosix } from '../../util/paths.js';
import { closest } from '../../util/strings.js';
import {
  asFunction,
  attributeLiterals,
  attributeName,
  findAttribute,
  literalValues,
  returnedExpressions,
  valueBranches,
  type JsxNode,
} from '../analyze.js';
import type { Rule, RuleContext } from '../context.js';
import { NON_TEXT_INPUT_TYPES } from '../target.js';

function renameTag(context: RuleContext, element: JsxNode, name: string): TextEdit[] {
  const edits: TextEdit[] = [
    { range: [element.tagName.getStart(context.sourceFile), element.tagName.end], text: name },
  ];
  if (element.closing) {
    edits.push({
      range: [element.closing.tagName.getStart(context.sourceFile), element.closing.tagName.end],
      text: name,
    });
  }
  return edits;
}

function tagRange(context: RuleContext, element: JsxNode): { start: number; end: number } {
  return { start: element.tagName.getStart(context.sourceFile), end: element.tagName.end };
}

/**
 * How the checked file imports `component`. A package or alias specifier is the same
 * everywhere; a relative one (a project without aliases) is rewritten from the root to the
 * checked file, so `./src/Button` becomes `../src/Button` in `app/page.tsx`.
 */
function importLine(component: ComponentInfo, context: RuleContext): string {
  const binding = component.exportName.split('.')[0] ?? component.name;
  let specifier = component.importPath;
  if (specifier.startsWith('.')) {
    const file = path.isAbsolute(context.file)
      ? path.relative(context.target.model.root, context.file)
      : context.file;
    const relative = path.posix.relative(
      path.posix.dirname(toPosix(file)),
      path.posix.normalize(specifier),
    );
    specifier = relative.startsWith('.') ? relative : `./${relative}`;
  }
  return `import { ${binding} } from "${specifier}"`;
}

// ─── prefer-design-system-component ─────────────────────────────────────────

export const preferDesignSystemComponent: Rule = {
  id: 'prefer-design-system-component',
  description:
    'Use the design-system component instead of the native element it wraps (<Button> over <button>).',
  run(context) {
    if (context.isDesignSystemSource) return;
    const allow = new Set(context.options.allow ?? []);
    for (const element of context.analysis.elements) {
      const resolution = context.resolve(element);
      if (resolution.kind !== 'intrinsic' || allow.has(resolution.tag)) continue;
      let key = resolution.tag;
      if (key === 'input') {
        // `<input {...getInputProps()} />`: every attribute comes from a spread, the type
        // too (react-dropzone's is a file input), so what it is cannot be told.
        if (element.hasSpread && !element.attributes.length) continue;
        const type = attributeLiterals(element, 'type')[0]?.text;
        if (type && NON_TEXT_INPUT_TYPES.has(type)) key = `input[type=${type}]`;
      }
      const component = context.target.elements.get(key);
      if (!component) continue;
      // An element no one sees or reaches is no UI to replace: the off-screen input that
      // carries a custom select's `required`, an `aria-hidden` proxy.
      if (hiddenFromUser(element)) continue;
      // The element a design-system component renders through `asChild` takes that
      // component's styles: `<SidebarMenuButton asChild><button /></SidebarMenuButton>`.
      if (styledByParent(element, context)) continue;
      // A bare element, with no content, class or style of its own, is a slot another
      // component renders into (`<Chip render={<button type="button" />} />`), not UI to restyle.
      if (isBare(element)) continue;
      // Classes from a cva/tv definition in the same file: code that defines its own variants
      // is building a component (Dub's date-picker trigger), not using one.
      if (styledByOwnVariants(element, context)) continue;
      // Inside a component of the same name (a design system's own `Table` around a <table>),
      // the element is how that component is built.
      if (enclosingComponent(element.node) === component.name) continue;
      // Renaming the tag is only safe when the component takes the element's
      // attributes; a match by name (Radix `Dialog` for `<dialog>`, `Select`
      // for `<select>`) needs a rewrite.
      const dropIn = context.target.isDropIn(component, key);
      const styled = Boolean(findAttribute(element, 'className'));
      const rendered = component.element;
      context.report({
        ...tagRange(context, element),
        message:
          `Native <${resolution.tag}> where the design system has <${component.name}>. ` +
          `Use <${component.name}> (${importLine(component, context)})` +
          (!dropIn
            ? rendered && rendered !== resolution.tag
              ? `; it renders a <${rendered}>, not a <${resolution.tag}>, so check its props and parts with get_component.`
              : `; it may not take the attributes of a <${resolution.tag}>, so check its props and parts with get_component.`
            : styled
              ? '; its variants replace the custom classes.'
              : '.'),
        suggestion: `<${component.name}>`,
        fix: dropIn ? renameTag(context, element, component.name) : undefined,
      });
    }
  },
};

const definitionsByFile = new WeakMap<ts.SourceFile, Set<string>>();

/** Whether the element's `className` calls a `cva(...)` or `tv(...)` definition declared in this file. */
function styledByOwnVariants(element: JsxNode, context: RuleContext): boolean {
  const init = findAttribute(element, 'className')?.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return false;
  let definitions = definitionsByFile.get(context.sourceFile);
  if (!definitions) {
    definitions = new Set();
    for (const statement of context.sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          value &&
          ts.isCallExpression(value) &&
          ts.isIdentifier(value.expression) &&
          (value.expression.text === 'cva' || value.expression.text === 'tv')
        ) {
          definitions.add(declaration.name.text);
        }
      }
    }
    definitionsByFile.set(context.sourceFile, definitions);
  }
  if (!definitions.size) return false;
  const known = definitions;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      known.has(node.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(init.expression);
  return found;
}

/**
 * A `button`, `a` or `label`, whose content is its children, self-closing and with no
 * `className` or `style`: an element type to render into, not styled UI. Void elements
 * (`<input />`, `<img />`) are always self-closing and stay UI.
 */
function isBare(element: JsxNode): boolean {
  return (
    ['button', 'a', 'label'].includes(element.tag) &&
    ts.isJsxSelfClosingElement(element.node) &&
    !element.hasSpread &&
    !findAttribute(element, 'className') &&
    !findAttribute(element, 'style')
  );
}

/**
 * Whether `element` is the `asChild` child of a design-system component with classes of
 * its own, directly or as a branch of a condition, so the component styles it.
 */
function styledByParent(element: JsxNode, context: RuleContext): boolean {
  let node: ts.Node = element.node.parent;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isConditionalExpression(node) ||
    ts.isJsxExpression(node) ||
    (ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(node.operatorToken.kind))
  ) {
    node = node.parent;
  }
  if (!ts.isJsxElement(node)) return false;
  const parent = context.analysis.elements.find((e) => e.node === node);
  if (!parent || !findAttribute(parent, 'asChild')) return false;
  const resolution = context.resolve(parent);
  return resolution.kind === 'component' && resolution.component.classNames.length > 0;
}

/**
 * Whether an element is kept from the user: `hidden`, `aria-hidden`, or out of the tab
 * order (`tabIndex={-1}`) and invisible (`opacity: 0`, `opacity-0`, `invisible`, `sr-only`).
 */
function hiddenFromUser(element: JsxNode): boolean {
  const flag = (name: string) => {
    const attribute = findAttribute(element, name);
    if (!attribute) return false;
    const init = attribute.initializer;
    if (!init) return true;
    if (ts.isStringLiteral(init))
      return init.text === 'true' || (name === 'hidden' && init.text !== 'false');
    return (
      ts.isJsxExpression(init) &&
      init.expression !== undefined &&
      init.expression.kind === ts.SyntaxKind.TrueKeyword
    );
  };
  if (flag('hidden') || flag('aria-hidden')) return true;
  const tabIndex = findAttribute(element, 'tabIndex')?.initializer;
  const outOfOrder =
    tabIndex !== undefined &&
    ((ts.isStringLiteral(tabIndex) && tabIndex.text === '-1') ||
      (ts.isJsxExpression(tabIndex) &&
        tabIndex.expression !== undefined &&
        ts.isPrefixUnaryExpression(tabIndex.expression) &&
        tabIndex.expression.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(tabIndex.expression.operand) &&
        tabIndex.expression.operand.text === '1'));
  if (!outOfOrder) return false;
  const classes = attributeLiterals(element, 'className').flatMap((l) => l.text.split(/\s+/));
  if (classes.some((c) => c === 'opacity-0' || c === 'invisible' || c === 'sr-only')) return true;
  const style = findAttribute(element, 'style')?.initializer;
  const object =
    style &&
    ts.isJsxExpression(style) &&
    style.expression &&
    ts.isObjectLiteralExpression(style.expression)
      ? style.expression
      : undefined;
  return (
    object?.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        propertyName(p.name) === 'opacity' &&
        ((ts.isNumericLiteral(p.initializer) && Number(p.initializer.text) === 0) ||
          (ts.isStringLiteral(p.initializer) && Number(p.initializer.text) === 0)),
    ) ?? false
  );
}

/** The PascalCase function or class component a node sits in: `Table` for `const Table = forwardRef(...)`. */
function enclosingComponent(node: ts.Node): string | undefined {
  let name: string | undefined;
  ts.findAncestor(node.parent, (current) => {
    if ((ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) && current.name) {
      name = current.name.text;
    } else if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      // Through `forwardRef(...)` and `memo(...)` to the variable it is assigned to.
      let up: ts.Node = current.parent;
      while (ts.isCallExpression(up) || ts.isParenthesizedExpression(up)) up = up.parent;
      name = ts.isVariableDeclaration(up) && ts.isIdentifier(up.name) ? up.name.text : undefined;
    } else {
      name = undefined;
    }
    return name !== undefined && /^[A-Z]/.test(name);
  });
  return name !== undefined && /^[A-Z]/.test(name) ? name : undefined;
}

// ─── no-unknown-component ───────────────────────────────────────────────────

export const noUnknownComponent: Rule = {
  id: 'no-unknown-component',
  description:
    'Components must exist in the design system: no invented components or dot-notation members.',
  run(context) {
    const { target } = context;
    for (const element of context.analysis.elements) {
      const resolution = context.resolve(element);
      const range = tagRange(context, element);

      // A name from a module the model left out may well be real: the check says once, for all
      // files, that it was not checked, rather than call it invented.
      if (
        resolution.kind === 'missing-export' &&
        target.outsideModel(
          resolution.source,
          resolution.name.split('.')[0] ?? resolution.name,
          context.file,
        )
      ) {
        context.unchecked(resolution.name, resolution.source);
        continue;
      }

      if (resolution.kind === 'missing-member') {
        const { owner, member } = resolution;
        const flat = target.components.get(`${owner.name}${member}`);
        if (flat) {
          context.report({
            ...range,
            message: `<${element.tag}> does not exist: ${owner.name} is composed from flat parts. Use <${flat.name}> (${importLine(flat, context)}).`,
            suggestion: `<${flat.name}>`,
            fix: renameTag(context, element, flat.name),
          });
        } else {
          const parts = owner.subcomponents.length
            ? ` Its parts are ${owner.subcomponents.join(', ')}.`
            : '';
          context.report({ ...range, message: `${owner.name} has no member "${member}".${parts}` });
        }
        continue;
      }

      if (resolution.kind === 'missing-export') {
        const guess = closest(resolution.name, target.names());
        context.report({
          ...range,
          message:
            `"${resolution.name}" is not a design-system component (imported from "${resolution.source}").` +
            (guess
              ? ` Did you mean <${guess}>?`
              : ' Use search_components to find an existing one.'),
          suggestion: guess ? `<${guess}>` : undefined,
        });
        continue;
      }

      if (resolution.kind === 'unresolved') {
        const guess = closest(resolution.name, target.names());
        const component = guess ? target.components.get(guess) : undefined;
        if (guess && component) {
          // A close name is only a safe rename when it is in scope: `<Cards>` in a
          // fragment without imports may be an app component the agent has not
          // imported yet, not a typo of `<Card>`.
          const binding = context.analysis.imports.get(guess.split('.')[0] ?? guess);
          const inScope =
            binding !== undefined && target.isDesignSystemImport(binding.source, context.file);
          context.report({
            ...range,
            message: inScope
              ? `Unknown component <${resolution.name}>. Did you mean <${guess}>?`
              : `Unknown component <${resolution.name}>. Did you mean <${guess}> (${importLine(component, context)})?`,
            suggestion: `<${guess}>`,
            fix: inScope ? renameTag(context, element, guess) : undefined,
          });
        } else if (context.analysis.imports.size > 0) {
          // Only for whole modules: fragments without imports routinely use
          // icons and app components the agent has not imported yet.
          context.report({
            ...range,
            severity: 'warning',
            message: `<${resolution.name}> is not a design-system component and is not imported or declared here.`,
          });
        }
      }
    }
  },
};

// ─── no-unknown-prop ────────────────────────────────────────────────────────

/** Prop names from other libraries → the conventional name in shadcn-style systems. */
const PROP_SYNONYMS: Record<string, string[]> = {
  variant: [
    'tone',
    'intent',
    'kind',
    'appearance',
    'color',
    'colorScheme',
    'colorPalette',
    'look',
    'theme',
    'severity',
    'status',
    'type',
  ],
  size: ['sz', 'scale', 'dimension'],
  disabled: ['isDisabled'],
  required: ['isRequired'],
  open: ['isOpen', 'opened', 'visible', 'show', 'shown'],
  onOpenChange: ['onClose', 'onDismiss', 'onToggle', 'onOpen', 'onVisibleChange'],
  asChild: ['as', 'component', 'render'],
};

/**
 * Props that mean the same thing in different conventions: native elements and Radix on one
 * side, React Aria Components on the other. A native field states `isInvalid` as `aria-invalid`. Whichever spelling an agent writes, the one the
 * component takes is suggested, in either direction. Event handlers are left out: their
 * arguments differ (`onCheckedChange(checked)` against an input's `onChange(event)`).
 */
const PROP_EQUIVALENTS: string[][] = [
  ['disabled', 'isDisabled'],
  ['required', 'isRequired'],
  ['readOnly', 'isReadOnly'],
  ['invalid', 'isInvalid', 'aria-invalid'],
  ['open', 'isOpen'],
  ['checked', 'isSelected', 'selected'],
  ['defaultChecked', 'defaultSelected'],
  ['indeterminate', 'isIndeterminate'],
];

/**
 * Radix composes with `asChild` and a child element, Base UI with a `render`
 * element; shadcn/ui ships both, and agents mix them up. Renaming the prop is
 * not enough, so this explains the other way instead of offering a fix.
 */
function compositionHint(name: string, known: Set<string>, tag: string): string | undefined {
  if (name === 'asChild' && known.has('render')) {
    return `Base UI components compose with render instead: <${tag} render={<Link href="…" />}>…</${tag}>.`;
  }
  if (name === 'render' && known.has('asChild')) {
    return `Radix components compose with asChild and a single child instead: <${tag} asChild><Link href="…">…</Link></${tag}>.`;
  }
  return undefined;
}

export const noUnknownProp: Rule = {
  id: 'no-unknown-prop',
  description: 'Props must exist on the component (own props or the HTML attributes it forwards).',
  run(context) {
    const { propSets } = context.target.model;
    for (const element of context.analysis.elements) {
      const resolution = context.resolve(element);
      if (resolution.kind !== 'component' || resolution.component.openProps) continue;
      const component = resolution.component;
      // `<Button component={Link} prefetch>` takes Link's props too, which the model does not know.
      if (component.polymorphic && findAttribute(element, component.polymorphic)) continue;
      const own = component.props.map((p) => p.name);
      const known = new Set(own);
      for (const inherited of component.inherits) {
        for (const name of propSets[inherited.set] ?? []) known.add(name);
      }
      for (const attribute of element.attributes) {
        const name = attributeName(attribute);
        if (
          known.has(name) ||
          name === 'key' ||
          name === 'ref' ||
          name.includes('-') ||
          name.includes(':')
        ) {
          continue;
        }
        const composition = compositionHint(name, known, element.tag);
        if (composition) {
          context.report({
            start: attribute.name.getStart(context.sourceFile),
            end: attribute.name.end,
            message: `<${element.tag}> has no prop "${name}". ${composition}`,
            suggestion: name === 'asChild' ? 'render' : 'asChild',
          });
          continue;
        }
        const equivalents = PROP_EQUIVALENTS.find((group) => group.includes(name)) ?? [];
        const equivalent =
          equivalents.find((other) => other !== name && own.includes(other)) ??
          equivalents.find((other) => other !== name && known.has(other));
        const synonym = Object.entries(PROP_SYNONYMS).find(
          ([target, aliases]) => known.has(target) && aliases.includes(name),
        )?.[0];
        const guess = equivalent ?? synonym ?? closest(name, own) ?? closest(name, known, 0.25);
        const prop = guess ? component.props.find((p) => p.name === guess) : undefined;
        const values = prop?.values?.length
          ? ` (${prop.values.map((v) => `"${v}"`).join(' | ')})`
          : '';
        const valueOk =
          !prop?.values || literalValues(attribute).every((l) => prop.values?.includes(l.text));
        // Renaming `isOpen` to `open` next to an existing `open` would duplicate it.
        const taken = guess !== undefined && findAttribute(element, guess) !== undefined;
        context.report({
          start: attribute.name.getStart(context.sourceFile),
          end: attribute.name.end,
          message:
            `<${element.tag}> has no prop "${name}".` +
            (guess ? ` Did you mean "${guess}"${values}?` : ''),
          suggestion: guess,
          fix:
            guess && valueOk && !taken
              ? [
                  {
                    range: [attribute.name.getStart(context.sourceFile), attribute.name.end],
                    text: guess,
                  },
                ]
              : undefined,
        });
      }
    }
  },
};

// ─── no-unknown-variant ─────────────────────────────────────────────────────

/**
 * Variant values that mean the same thing across libraries. A value in a
 * group maps to whichever member the component actually accepts, so "error"
 * becomes "destructive" for shadcn/ui and "danger" for a system that uses that.
 */
const VALUE_GROUPS: string[][] = [
  ['destructive', 'danger', 'error', 'delete', 'remove', 'negative', 'critical', 'red', 'alert'],
  ['default', 'primary', 'main', 'solid', 'filled', 'brand', 'contained'],
  ['ghost', 'tertiary', 'text', 'subtle', 'plain', 'minimal', 'flat', 'transparent', 'quiet'],
  ['outline', 'outlined', 'bordered', 'stroke', 'border', 'hollow'],
  ['secondary', 'neutral', 'muted', 'gray', 'grey', 'soft', 'light'],
  ['success', 'positive', 'ok', 'green', 'active', 'valid', 'done'],
  ['warning', 'caution', 'warn', 'yellow', 'amber', 'pending'],
  ['info', 'information', 'note', 'notice', 'blue'],
  ['link', 'anchor', 'href', 'inline'],
  ['sm', 'small', 's', 'xs', 'compact', 'tiny'],
  ['md', 'medium', 'm', 'default', 'normal', 'regular', 'base'],
  ['lg', 'large', 'l', 'big'],
  ['icon', 'iconOnly', 'icon-only', 'square', 'icon-button'],
];

export function suggestValue(value: string, allowed: readonly string[]): string | undefined {
  const lower = value.toLowerCase();
  for (const group of VALUE_GROUPS) {
    if (!group.includes(lower)) continue;
    const match = group.find((member) => member !== lower && allowed.includes(member));
    if (match) return match;
  }
  return closest(value, allowed, 0.5);
}

export const noUnknownVariant: Rule = {
  id: 'no-unknown-variant',
  description:
    'Variant props (cva variants and string-literal unions) only accept their declared values.',
  run(context) {
    for (const element of context.analysis.elements) {
      const resolution = context.resolve(element);
      if (resolution.kind !== 'component') continue;
      for (const attribute of element.attributes) {
        const name = attributeName(attribute);
        const prop: PropInfo | undefined = resolution.component.props.find(
          (p) => p.name === name && p.values?.length,
        );
        if (!prop?.values) continue;
        for (const literal of literalValues(attribute)) {
          if (prop.values.includes(literal.text)) continue;
          const guess = suggestValue(literal.text, prop.values);
          const start = literal.getStart(context.sourceFile) + 1;
          const end = literal.end - 1;
          context.report({
            start: start - 1,
            end: end + 1,
            message:
              `"${literal.text}" is not a valid ${name} for <${element.tag}>. ` +
              `Allowed: ${prop.values.join(', ')}.` +
              (guess ? ` Did you mean "${guess}"?` : ''),
            suggestion: guess ? `${name}="${guess}"` : undefined,
            fix: guess ? [{ range: [start, end], text: guess }] : undefined,
          });
        }
      }
    }
  },
};

// ─── icon-button-accessible-name ────────────────────────────────────────────

const ICON_LABELS: [RegExp, string][] = [
  [/^(Trash|Delete|Bin)/, 'Delete'],
  [/^(X|Close|Cross)(Icon)?$|^X(Circle|Square)/, 'Close'],
  [/^(Plus|Add)/, 'Add'],
  [/^(Pencil|Edit|PenLine|SquarePen)/, 'Edit'],
  [/^Search/, 'Search'],
  [/^(Menu|Hamburger)/, 'Open menu'],
  [/^(Settings|Cog|Gear)/, 'Settings'],
  [/^(Copy|Clipboard)/, 'Copy'],
  [/^Download/, 'Download'],
  [/^Upload/, 'Upload'],
  [/^(MoreHorizontal|MoreVertical|Ellipsis|DotsHorizontal|DotsVertical)/, 'More options'],
  [/^ChevronLeft|^ArrowLeft/, 'Previous'],
  [/^ChevronRight|^ArrowRight/, 'Next'],
  [/^(UserMinus|UserX)/, 'Remove member'],
  [/^(UserPlus)/, 'Invite member'],
  [/^(RefreshCw|RefreshCcw|RotateCw)/, 'Refresh'],
  [/^(Share)/, 'Share'],
  [/^(Filter)/, 'Filter'],
  [/^(Info)/, 'More information'],
];

/**
 * What a button holds: text (or a labelled element), icons only, nothing, or
 * something this rule cannot see into, such as `<AvatarWithText primaryText=…>`
 * or an app component: then it says nothing.
 */
type Content = 'text' | 'unknown' | 'icon' | 'empty';

/** Text wins, then content the rule cannot read, then icons. */
const PRECEDENCE: Content[] = ['text', 'unknown', 'icon', 'empty'];
function combine(a: Content, b: Content): Content {
  return PRECEDENCE.indexOf(a) <= PRECEDENCE.indexOf(b) ? a : b;
}

/** i18n components that render text: react-intl's `Formatted*`, react-i18next's and Lingui's `Trans`. */
const TEXT_COMPONENTS = /^(?:Formatted[A-Z]\w*|Trans|Translate)$/;

/** `XIcon`, `IconX`, `Icon`, `Icons.Add`. */
const ICON_NAME = /^Icons?(?:$|[A-Z.])|Icon$/;

/** Icon libraries, and a project's own icon modules (`@/components/icons`, `@acme/ui/icons`). */
const ICON_SOURCE =
  /^(?:lucide-react|lucide|@lucide\/.+|@heroicons\/.+|@radix-ui\/react-icons|react-icons(?:\/.+)?|@tabler\/icons(?:-react)?|@phosphor-icons\/.+|phosphor-react|@remixicon\/react|react-feather|@mui\/icons-material(?:\/.+)?|iconoir-react|@iconify\/react|@primer\/octicons-react|@fortawesome\/react-fontawesome)$|(?:^|\/)icons?(?:\/|$)/;

/** Props an icon takes; any other prop with text or markup in it means the child shows more than an icon. */
const ICON_PROPS =
  /^(?:className|class|style|size|width|height|color|fill|stroke|strokeWidth|absoluteStrokeWidth|weight|variant|name|icon|viewBox|mirrored|focusable|role|id|key|ref|type|aria-hidden|data-[\w-]+)$/;

/** Common icon names, for fragments that use an icon without importing it. */
const ICON_WORDS =
  /^(?:Chevron|Arrow|Check|Circle|Square|Star|Heart|Bell|Mail|Lock|Unlock|Eye|Calendar|Clock|Home|Loader|Spinner|Send|Save|Pin|Link|External|Sun|Moon|Grip|Drag|Bookmark|Archive|Bold|Italic|Undo|Redo|Play|Pause|Stop|Minus|Ellipsis|Dots|Kebab|Hamburger)/;

/**
 * Whether a PascalCase child is an icon: by its name (`XIcon`), where it comes
 * from (an icon library or icons module), or a common icon name (`Trash2`,
 * `ChevronLeft`) when it is not imported or comes from a design system that
 * re-exports its icons (`import { ChevronLeft } from "@dub/ui"`) without
 * being one of its components.
 */
function isIconLike(tag: string, context: RuleContext): boolean {
  if (ICON_NAME.test(tag)) return true;
  const shaped = ICON_WORDS.test(tag) || ICON_LABELS.some(([pattern]) => pattern.test(tag));
  const head = tag.split('.')[0] ?? tag;
  const binding = context.analysis.imports.get(head);
  if (binding) {
    if (ICON_SOURCE.test(binding.source)) return true;
    const { target } = context;
    return (
      shaped &&
      target.isDesignSystemImport(binding.source, context.file) &&
      !target.components.has(binding.imported)
    );
  }
  if (context.analysis.declared.has(head)) return false;
  return shaped;
}

/** A prop whose value is text or markup (`text="Export"`, `primaryText={<span>…</span>}`), other than an icon's own. */
function hasTextualProps(opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  return opening.attributes.properties.some((attribute) => {
    if (!ts.isJsxAttribute(attribute) || ICON_PROPS.test(attributeName(attribute))) return false;
    const init = attribute.initializer;
    if (!init) return false;
    if (ts.isStringLiteral(init)) return init.text.trim() !== '';
    const value = ts.isJsxExpression(init) ? init.expression : init;
    return (
      value !== undefined &&
      valueBranches(value).some(
        (branch) =>
          ts.isStringLiteralLike(branch) ||
          ts.isTemplateExpression(branch) ||
          ts.isJsxElement(branch) ||
          ts.isJsxSelfClosingElement(branch) ||
          ts.isJsxFragment(branch),
      )
    );
  });
}

/** `<svg><title>Close</title>…</svg>`: the title is the image's accessible name. */
function hasSvgTitle(svg: ts.Node, context: RuleContext): boolean {
  return (
    ts.isJsxElement(svg) &&
    svg.children.some(
      (child) =>
        ts.isJsxElement(child) &&
        child.openingElement.tagName.getText(context.sourceFile) === 'title' &&
        child.children.some((c) =>
          ts.isJsxText(c) ? c.text.trim() !== '' : ts.isJsxExpression(c) && c.expression,
        ),
    )
  );
}

function classify(children: readonly ts.Node[], context: RuleContext, icons: string[]): Content {
  let result: Content = 'empty';
  for (const child of children) {
    let kind: Content = 'empty';
    if (ts.isJsxText(child)) kind = child.text.trim() ? 'text' : 'empty';
    else if (ts.isJsxExpression(child)) {
      // A render prop (`{({ isPending }) => <Trash2 />}`) shows what it returns; any other
      // expression may be text.
      const fn = child.expression && asFunction(child.expression);
      kind = fn ? classifyReturned(fn, context, icons) : child.expression ? 'text' : 'empty';
    } else if (ts.isJsxFragment(child)) kind = classify(child.children, context, icons);
    else if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      const opening = ts.isJsxElement(child) ? child.openingElement : child;
      const tag = opening.tagName.getText(context.sourceFile);
      const hasLabel = opening.attributes.properties.some(
        (a) =>
          ts.isJsxAttribute(a) &&
          /^(aria-label|aria-labelledby|alt|title)$/.test(a.name.getText(context.sourceFile)) &&
          !(a.initializer && ts.isStringLiteral(a.initializer) && !a.initializer.text.trim()),
      );
      if (hasLabel || (tag === 'svg' && hasSvgTitle(child, context))) kind = 'text';
      else if (tag === 'svg' || tag === 'img') kind = 'icon';
      else if (ts.isJsxElement(child) && child.children.length) {
        kind = classify(child.children, context, icons);
      } else if (TEXT_COMPONENTS.test(tag)) {
        kind = 'text';
      } else if (/^[A-Z]/.test(tag)) {
        if (!hasTextualProps(opening) && isIconLike(tag, context)) {
          icons.push(tag);
          kind = 'icon';
        } else {
          kind = 'unknown';
        }
      }
    }
    if (kind === 'text') return 'text';
    result = combine(result, kind);
  }
  return result;
}

/** What a render prop returns, across `return`s and branches: text wins, then icons. */
function classifyReturned(
  fn: ts.ArrowFunction | ts.FunctionExpression,
  context: RuleContext,
  icons: string[],
): Content {
  let result: Content = 'empty';
  for (const value of returnedExpressions(fn).flatMap(valueBranches)) {
    const kind: Content =
      ts.isJsxElement(value) || ts.isJsxSelfClosingElement(value) || ts.isJsxFragment(value)
        ? classify([value], context, icons)
        : value.kind === ts.SyntaxKind.NullKeyword ||
            value.kind === ts.SyntaxKind.FalseKeyword ||
            (ts.isIdentifier(value) && value.text === 'undefined')
          ? 'empty'
          : 'text';
    if (kind === 'text') return 'text';
    result = combine(result, kind);
  }
  return result;
}

/** A button, native or a design-system component that renders or is named like one. */
function isButton(context: RuleContext, element: JsxNode): boolean {
  const resolution = context.resolve(element);
  return (
    (resolution.kind === 'intrinsic' && resolution.tag === 'button') ||
    (resolution.kind === 'component' &&
      (resolution.component.element === 'button' || /Button$/.test(resolution.component.name)))
  );
}

/** `aria-label`, `aria-labelledby` or `title` with a value that is not blank. */
function hasLabel(attributes: readonly ts.JsxAttribute[]): boolean {
  return attributes.some((attribute) => {
    if (!/^(?:aria-label|aria-labelledby|title)$/.test(attributeName(attribute))) return false;
    const values = literalValues(attribute);
    return !values.length || values.some((v) => v.text.trim());
  });
}

/**
 * Whether the element's parent is a component that gives its child an accessible name, as MUI's
 * `<Tooltip title="Delete">` does with a string title (not a JSX one, and not with
 * `describeChild`, which makes it a description).
 */
function labelledByParent(context: RuleContext, element: JsxNode): boolean {
  let node: ts.Node = element.node.parent;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isJsxExpression(node) ||
    (ts.isConditionalExpression(node) && node.condition !== element.node) ||
    (ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(node.operatorToken.kind))
  ) {
    node = node.parent;
  }
  if (!ts.isJsxElement(node)) return false;
  const parent = context.analysis.elements.find((e) => e.node === node);
  if (!parent) return false;
  const resolution = context.resolve(parent);
  const labels = resolution.kind === 'component' ? resolution.component.labelsChild : undefined;
  if (!labels) return false;
  const unless = labels.unless ? findAttribute(parent, labels.unless) : undefined;
  if (unless) {
    const init = unless.initializer;
    const value = init && ts.isJsxExpression(init) ? init.expression : init;
    if (value?.kind !== ts.SyntaxKind.FalseKeyword) return false;
  }
  const label = findAttribute(parent, labels.prop);
  if (!label?.initializer) return false;
  if (ts.isStringLiteral(label.initializer)) return label.initializer.text.trim() !== '';
  const value = ts.isJsxExpression(label.initializer) ? label.initializer.expression : undefined;
  if (!value) return false;
  const literals = literalValues(label);
  if (literals.length) return literals.some((l) => l.text.trim() !== '');
  // A JSX title renders as content, without becoming the child's label.
  return !ts.isJsxElement(value) && !ts.isJsxSelfClosingElement(value) && !ts.isJsxFragment(value);
}

/**
 * The element whose `render` prop this one is, as in Base UI's
 * `<Dialog.Close render={<Button size="icon" />}><XIcon /></Dialog.Close>`:
 * the rendered button takes the host's children and attributes. Also through
 * a condition (`render={disabled ? undefined : <button />}`). `object` when it
 * is the `render` of an object, such as a story's `args`, whose host the rule
 * cannot see.
 */
function renderHost(context: RuleContext, element: JsxNode): JsxNode | 'object' | undefined {
  let node: ts.Node = element.node;
  for (;;) {
    const parent = node.parent;
    if (ts.isParenthesizedExpression(parent)) node = parent;
    else if (ts.isConditionalExpression(parent) && node !== parent.condition) node = parent;
    else if (
      ts.isBinaryExpression(parent) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(parent.operatorToken.kind)
    ) {
      node = parent;
    } else break;
  }
  const parent = node.parent;
  if (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    propertyName(parent.name) === 'render'
  ) {
    return 'object';
  }
  const attribute = ts.isJsxExpression(parent) ? parent.parent : undefined;
  if (!attribute || !ts.isJsxAttribute(attribute) || attributeName(attribute) !== 'render') {
    return undefined;
  }
  const opening = attribute.parent.parent;
  const host = ts.isJsxOpeningElement(opening) ? opening.parent : opening;
  return context.analysis.elements.find((e) => e.node === host);
}

/** `hidden`, `aria-hidden`, `aria-hidden="true"` or `{true}`: not an element anyone reads or clicks. */
function hiddenBy(attributes: ts.JsxAttributes): boolean {
  return attributes.properties.some((attribute) => {
    if (!ts.isJsxAttribute(attribute)) return false;
    const name = attributeName(attribute);
    if (name !== 'hidden' && name !== 'aria-hidden') return false;
    const init = attribute.initializer;
    if (!init) return true;
    const value = ts.isJsxExpression(init) ? init.expression : init;
    if (value?.kind === ts.SyntaxKind.TrueKeyword) return true;
    return (
      value !== undefined &&
      ts.isStringLiteralLike(value) &&
      (name === 'hidden' || value.text === 'true')
    );
  });
}

/** The element or one around it is hidden. */
function isHidden(element: JsxNode): boolean {
  const hidden = ts.findAncestor(element.node, (node) => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    return opening !== undefined && hiddenBy(opening.attributes);
  });
  return hidden !== undefined;
}

export const iconButtonAccessibleName: Rule = {
  id: 'icon-button-accessible-name',
  description:
    'Buttons whose only content is an icon need an aria-label (or visually hidden text).',
  run(context) {
    for (const element of context.analysis.elements) {
      const resolution = context.resolve(element);
      if (!isButton(context, element) || element.hasSpread) continue;
      if (findAttribute(element, 'asChild') || isHidden(element)) continue;
      // A button passed as `render` is judged by its host's children and label, and its own;
      // a host that is a button itself is checked on its own. A story's `args.render` is
      // rendered with args the rule does not follow.
      const host = renderHost(context, element);
      if (host === 'object') continue;
      if (host && (isButton(context, host) || host.hasSpread)) continue;
      if (hasLabel(element.attributes) || (host && hasLabel(host.attributes))) continue;
      if (labelledByParent(context, element)) continue;
      const icons: string[] = [];
      const children = host ? [...host.children, ...element.children] : element.children;
      // A host with no children shows what its props say (`<Chip label=… render={<button />}>`).
      const content: Content =
        host && !children.length ? 'unknown' : classify(children, context, icons);
      const sizeIcon = attributeLiterals(element, 'size').some((v) => v.text.includes('icon'));
      if (
        content === 'text' ||
        content === 'unknown' ||
        (content === 'empty' && !sizeIcon && resolution.kind !== 'intrinsic')
      )
        continue;

      const icon = icons[0];
      const label = icon ? ICON_LABELS.find(([pattern]) => pattern.test(icon))?.[1] : undefined;
      const attribute = `aria-label="${label ?? '…'}"`;
      context.report({
        ...tagRange(context, element),
        message:
          content === 'icon'
            ? `Icon-only <${element.tag}> has no accessible name. Add ${attribute} describing the action, or visually hidden text.`
            : `<${element.tag}> has no content and no accessible name. Add ${attribute}.`,
        suggestion: attribute,
        fix: label
          ? [{ range: [element.tagName.end, element.tagName.end], text: ` ${attribute}` }]
          : undefined,
      });
    }
  },
};
