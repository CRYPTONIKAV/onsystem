import ts from 'typescript';

import { propertyName } from '../../extract/cva.js';
import {
  findColorLiterals,
  formatDeltaE,
  isNamedColor,
  isTinted,
  parseColor,
  SAME_COLOR,
  type Oklch,
} from '../../tokens/color.js';
import type { ColorSuggestion } from '../../tokens/index.js';
import { colorRole, scopesIn, type ColorRole, type ScopedFamily } from '../../tokens/roles.js';
import { formatPx, lengthToPx } from '../../tokens/units.js';
import { cssReference } from '../../tokens/usage.js';
import type { Token } from '../../types.js';
import { attributeName, literalValues, valueBranches, type JsxNode } from '../analyze.js';
import type { Rule, RuleContext } from '../context.js';
import {
  COLOR_PREFIXES,
  NEGATIVE_PREFIXES,
  RADIUS_PREFIXES,
  SPACING_PREFIXES,
  STYLE_COLOR_PROPERTIES,
  STYLE_RADIUS_PROPERTIES,
  STYLE_SPACING_PROPERTIES,
  cssColorProperty,
  isColorAttribute,
  paletteColor,
  parseUtility,
  splitClasses,
  withBase,
  type Utility,
} from '../tailwind.js';

// ─── Colors ─────────────────────────────────────────────────────────────────

export const noHardcodedColor: Rule = {
  id: 'no-hardcoded-color',
  description:
    'Colors must come from design tokens: no hex/rgb/oklch literals, arbitrary Tailwind colors or default-palette classes.',
  run(context) {
    const { tokens } = context.target;
    if (!tokens.has('color')) return;
    const allow = new Set((context.options.allow ?? []).map((v) => v.toLowerCase()));

    for (const classString of context.analysis.classStrings) {
      for (const token of splitClasses(classString.text, classString.start)) {
        if (allow.has(token.value.toLowerCase())) continue;
        const utility = parseUtility(token.value);
        const element = classString.element;

        if (
          utility.arbitrary !== undefined &&
          utility.prefix &&
          COLOR_PREFIXES.includes(utility.prefix)
        ) {
          const value = utility.arbitrary.replace(/^color:/, '').trim();
          const whole = parseColor(value);
          // `shadow-[0_1px_2px_#000]`: report the color inside, but no class can replace it 1:1.
          const literal = whole ? { text: value, color: whole } : findColorLiterals(value)[0];
          if (!literal || allow.has(literal.text.toLowerCase())) continue;
          reportColor(context, {
            start: token.start,
            end: token.end,
            what: `Hardcoded color \`${token.value}\``,
            color: literal.color,
            prefix: whole ? utility.prefix : undefined,
            place: 'class',
            utility,
            element,
            classes: classString.text,
          });
          continue;
        }

        const property = utility.property ? cssColorProperty(utility.property) : undefined;
        if (property && utility.arbitrary !== undefined) {
          // `[background-color:#f00]`: the property's own utility replaces the whole class.
          const value = utility.arbitrary.trim();
          const whole = parseColor(value);
          const literal = whole ? { text: value, color: whole } : findColorLiterals(value)[0];
          if (!literal || allow.has(literal.text.toLowerCase())) continue;
          reportColor(context, {
            start: token.start,
            end: token.end,
            what: `Hardcoded color \`${token.value}\``,
            color: literal.color,
            prefix: whole ? property.prefix : undefined,
            place: 'class',
            utility,
            element,
            classes: classString.text,
          });
          continue;
        }

        const palette = paletteColor(utility.base);
        if (palette && !tokens.colorKeys.has(palette.key)) {
          const color = parseColor(palette.value);
          if (!color) continue;
          reportColor(context, {
            start: token.start,
            end: token.end,
            what: `\`${token.value}\` is Tailwind's default palette, not a design-system color`,
            color,
            tinted: !palette.gray,
            prefix: palette.prefix,
            place: 'class',
            utility,
            element,
            classes: classString.text,
          });
        }
      }
    }

    for (const { object, element } of context.analysis.styles) {
      for (const prop of object.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = propertyName(prop.name);
        if (name === undefined || !(name in STYLE_COLOR_PROPERTIES)) continue;
        // `isPressed ? "#ef4444" : undefined`: each literal branch is a value.
        for (const value of valueBranches(prop.initializer)) {
          if (!ts.isStringLiteralLike(value)) continue;
          reportLiteralColors(context, value, element, {
            where: `style.${name}`,
            prefix: STYLE_COLOR_PROPERTIES[name],
            place: 'style',
            named: true,
            allow,
          });
        }
      }
    }

    for (const element of context.analysis.elements) {
      // On native and SVG elements `color` and `fill` are colors. On a component
      // they are props, often a variant (`<Badge color="green">`): skip props with
      // known values, and read only hex and color functions as colors.
      const resolution = context.resolve(element);
      for (const attribute of element.attributes) {
        const name = attributeName(attribute);
        if (!isColorAttribute(name)) continue;
        if (
          resolution.kind === 'component' &&
          resolution.component.props.some((p) => p.name === name && p.values?.length)
        ) {
          continue;
        }
        const prefix = name === 'fill' || name === 'stroke' ? name : 'text';
        for (const literal of literalValues(attribute)) {
          reportLiteralColors(context, literal, element, {
            where: `${name}="…"`,
            prefix,
            place: 'attribute',
            named: resolution.kind === 'intrinsic',
            allow,
          });
        }
      }
    }
  },
};

function reportLiteralColors(
  context: RuleContext,
  literal: ts.StringLiteralLike,
  element: JsxNode,
  options: {
    where: string;
    prefix: string | undefined;
    place: 'style' | 'attribute';
    /** Whether a named color (`red`) counts, as it does in CSS but not in a component's prop. */
    named: boolean;
    allow: Set<string>;
  },
): void {
  const start = literal.getStart(context.sourceFile) + 1;
  // Match the source as written: offsets into `literal.text` drift after an escape such as `\"`.
  const text = context.text.slice(start, literal.end - 1);
  const matches = findColorLiterals(text);
  const trimmed = text.trim();
  if (!matches.length && options.named && isNamedColor(trimmed)) {
    const color = parseColor(trimmed);
    if (color) matches.push({ text: trimmed, index: text.indexOf(trimmed), color });
  }
  for (const match of matches) {
    if (options.allow.has(match.text.toLowerCase())) continue;
    reportColor(context, {
      start: start + match.index,
      end: start + match.index + match.text.length,
      what: `Hardcoded color \`${match.text}\` in ${options.where}`,
      color: match.color,
      prefix: options.prefix,
      place: options.place,
      element,
    });
  }
}

function reportColor(
  context: RuleContext,
  input: {
    start: number;
    end: number;
    what: string;
    color: Oklch;
    /** A hue rather than a gray, when the source says so (`bg-sky-50` is blue, however pale). */
    tinted?: boolean;
    /** Tailwind prefix to build the replacement class with (`bg`, `text`, `border-t`). */
    prefix: string | undefined;
    /**
     * Where the literal sits: a class list (replace the class), a style value
     * (replace with `var(--token)`), or a JSX attribute such as `fill` or an
     * icon's `color` (move it to className; SVG attributes cannot use `var()`).
     */
    place: 'class' | 'style' | 'attribute';
    utility?: Utility;
    element?: JsxNode | undefined;
    /** The class string the color is in, which can place it in a sidebar or chart. */
    classes?: string | undefined;
  },
): void {
  const role = colorRole(input.prefix ?? input.utility?.prefix);
  // `dark:bg-slate-900` is the dark-mode color: compare it with the tokens' dark values.
  const mode = input.utility?.variants.includes('dark') ? 'dark' : undefined;
  const suggestion = context.target.tokens.suggestColor(input.color, {
    role,
    scopes: scopes(context, input.element, input.classes),
    tinted: input.tinted,
    mode,
  });
  if (!suggestion) return;
  const { match, nearest, reason, sameValue, hueOff } = suggestion;
  const token = nearest.candidate.token;

  const cls = input.prefix && token.tailwind ? `${input.prefix}-${token.tailwind}` : undefined;
  const cssVar = cssReference(token);
  const close = match !== undefined;
  const variant = cls && input.element ? variantApplying(context, input.element, cls) : undefined;

  let replacement: string | undefined;
  let advice: string | undefined;
  let edit: string | undefined;
  if (input.place === 'class') {
    replacement = cls ?? (cssVar && input.prefix ? `${input.prefix}-[${cssVar}]` : cssVar);
    if (replacement)
      advice = `\`${input.utility && input.prefix ? withBase(input.utility, replacement) : replacement}\``;
    if (replacement && input.prefix && input.utility) edit = withBase(input.utility, replacement);
  } else if (input.place === 'style') {
    replacement = cls ?? cssVar;
    advice = [cls, cssVar]
      .filter(Boolean)
      .map((v) => `\`${String(v)}\``)
      .join(' or ');
    edit = cssVar;
  } else {
    replacement = cls ? `className="${cls}"` : cssVar;
    advice = cls ? `\`${cls}\` in className` : undefined;
  }

  const same = sameValue.length ? `, same value as ${sameValue.map((t) => t.name).join(', ')}` : '';
  const inMode = mode && token.modes?.[mode] !== undefined ? ` in ${mode} mode` : '';
  const found = `${token.name}${inMode} (${formatDeltaE(nearest.distance)}${same})`;
  let message: string;
  if (close) {
    message = `${input.what}. ${nearest.distance < SAME_COLOR ? 'Matches token' : 'Nearest token'} ${found}`;
    if (advice) message += ` → ${advice}`;
    if (variant) message += `, or use ${variant}`;
    message += '.';
  } else {
    const tinted = input.tinted ?? isTinted(input.color);
    message = `${input.what}. ${noMatch(reason, role, tinted, nearest.candidate.color, found, hueOff)} Pick the semantic token that fits.`;
  }
  const owner =
    !variant && input.prefix && input.element
      ? variantProp(context, input.element, input.prefix)
      : undefined;
  if (owner)
    message += ` <${owner.component}> already sets ${input.prefix}-* through \`${owner.prop}\`; prefer a variant over overriding it.`;

  context.report({
    start: input.start,
    end: input.end,
    message,
    suggestion: close ? (variant ?? replacement) : undefined,
    fix: close && edit ? [{ range: [input.start, input.end], text: edit }] : undefined,
  });
}

const ROLE_WORDS: Record<ColorRole, string> = {
  text: 'text',
  surface: 'backgrounds',
  line: 'borders',
};

/** Why no token replaces the color, naming the nearest one (`found`). */
function noMatch(
  reason: ColorSuggestion['reason'],
  role: ColorRole | undefined,
  tinted: boolean,
  token: Oklch,
  found: string,
  hueOff: number | undefined,
): string {
  if (reason === 'status') {
    return `Nearest is ${found}, a status color ${String(hueOff)}° away in hue; status colors are only suggested for their own hue.`;
  }
  if (reason === 'scoped') {
    return `Nearest is ${found}, a token one part of the UI uses (not this one).`;
  }
  if (reason === 'hue') {
    if (!tinted) return `No gray token is close; nearest is ${found}, which is tinted.`;
    return `No token has this hue; nearest is ${found}, ${isTinted(token) ? 'another hue' : 'a gray'}.`;
  }
  if (reason === 'role' && role)
    return `No close token is meant for ${ROLE_WORDS[role]}; nearest is ${found}.`;
  return `No close token; nearest is ${found}.`;
}

/**
 * The scoped token families (sidebar, chart, and any a single file uses) the
 * code is in: the file, the element and the elements around it, or its classes.
 */
function scopes(
  context: RuleContext,
  element: JsxNode | undefined,
  classes: string | undefined,
): Set<ScopedFamily> {
  const tags: string[] = [];
  for (let node: ts.Node | undefined = element?.node; node; node = node.parent) {
    const tag = ts.isJsxElement(node)
      ? node.openingElement.tagName
      : ts.isJsxSelfClosingElement(node)
        ? node.tagName
        : undefined;
    const name = tag?.getText(context.sourceFile);
    // A page laid out next to the sidebar is not in it.
    if (name && !/^Sidebar(?:Provider|Inset)$/.test(name)) tags.push(name);
  }
  const { tokens, components } = context.target;
  const found = scopesIn(tokens.scopedFamilies, context.file, classes, ...tags);
  // Inside a component that uses a family (<CodeBlock> for syntax colors), its tokens fit.
  const files = new Set([context.file]);
  for (const tag of tags) {
    const file = components.get(tag)?.source.file;
    if (file) files.add(file);
  }
  for (const family of tokens.scopedFamilies) {
    const using = tokens.familyFiles.get(family);
    if (using && [...files].some((file) => using.has(file))) found.add(family);
  }
  return found;
}

/** The variant prop of the element's component that already sets `prefix-*` classes, if any. */
function variantProp(
  context: RuleContext,
  element: JsxNode,
  prefix: string,
): { component: string; prop: string } | undefined {
  const resolution = context.resolve(element);
  if (resolution.kind !== 'component') return undefined;
  const variant = resolution.component.variants.find((v) =>
    Object.values(v.classes).some((classes) =>
      classes.split(/\s+/).some((c) => c.startsWith(`${prefix}-`)),
    ),
  );
  return variant ? { component: resolution.component.name, prop: variant.name } : undefined;
}

/** `variant="destructive"` when a variant of the element's component already applies `cls`. */
function variantApplying(context: RuleContext, element: JsxNode, cls: string): string | undefined {
  const resolution = context.resolve(element);
  if (resolution.kind !== 'component') return undefined;
  for (const variant of resolution.component.variants) {
    for (const [value, classes] of Object.entries(variant.classes)) {
      if (classes.split(/\s+/).includes(cls)) return `${variant.name}="${value}"`;
    }
  }
  return undefined;
}

// ─── Spacing and radius ─────────────────────────────────────────────────────

interface LengthRuleSpec {
  category: 'spacing' | 'radius';
  prefixes: Set<string>;
  styleProperties: Record<string, string>;
}

/** The source text of a number in a style object, sign included: `6`, `-8`. */
function numberValue(init: ts.Expression): string | undefined {
  if (ts.isNumericLiteral(init)) return init.text;
  if (
    ts.isPrefixUnaryExpression(init) &&
    ts.isNumericLiteral(init.operand) &&
    (init.operator === ts.SyntaxKind.MinusToken || init.operator === ts.SyntaxKind.PlusToken)
  ) {
    return `${init.operator === ts.SyntaxKind.MinusToken ? '-' : ''}${init.operand.text}`;
  }
  return undefined;
}

function lengthRule(id: Rule['id'], description: string, spec: LengthRuleSpec): Rule {
  return {
    id,
    description,
    run(context) {
      const { tokens } = context.target;
      if (!tokens.has(spec.category)) return;
      const allow = new Set(context.options.allow ?? []);

      for (const classString of context.analysis.classStrings) {
        for (const token of splitClasses(classString.text, classString.start)) {
          const utility = parseUtility(token.value);
          if (
            !utility.prefix ||
            utility.arbitrary === undefined ||
            !spec.prefixes.has(utility.prefix)
          )
            continue;
          if (allow.has(token.value) || allow.has(utility.arbitrary)) continue;
          const px = lengthToPx(utility.arbitrary);
          if (px === undefined || px === 0) continue;
          // `-mt-[3px]` and `mt-[-3px]` are the same negative margin; the fix keeps the sign.
          const negative = utility.negative !== px < 0;
          if (negative && !NEGATIVE_PREFIXES.has(utility.prefix)) continue;
          const replacement = lengthReplacement(context, spec.category, px, utility.prefix);
          if (!replacement || unnamed(replacement)) continue;
          const fixed = withBase({ ...utility, negative }, replacement.cls);
          const message = replacement.exact
            ? `\`${token.value}\` is ${formatPx(px)}, which is on the ${spec.category} scale: use \`${fixed}\`.`
            : replacement.pill
              ? `\`${token.value}\` (${formatPx(px)}) is far above the radius scale, so it reads as fully rounded: use \`${fixed}\`.`
              : `Hardcoded ${spec.category} \`${token.value}\` (${formatPx(px)}) is off the scale. Nearest: \`${fixed}\` (${formatPx(replacement.px)})` +
                (replacement.far ? ', too far off to replace automatically.' : '.');
          context.report({
            start: token.start,
            end: token.end,
            message,
            suggestion: fixed,
            fix: replacement.far ? undefined : [{ range: [token.start, token.end], text: fixed }],
          });
        }
      }

      for (const { object } of context.analysis.styles) {
        for (const prop of object.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const name = propertyName(prop.name);
          const prefix = name === undefined ? undefined : spec.styleProperties[name];
          if (!prefix) continue;
          // `isPressed ? 6 : 0`: each branch is a value.
          for (const init of valueBranches(prop.initializer)) {
            const number = numberValue(init);
            const raw = number ?? (ts.isStringLiteralLike(init) ? init.text : undefined);
            if (raw === undefined || allow.has(raw)) continue;
            const values = raw.trim().split(/\s+/);
            const lengths = values.map((v) => (number !== undefined ? Number(v) : lengthToPx(v)));
            if (lengths.some((px) => px === undefined) || lengths.every((px) => px === 0)) continue;
            const px = lengths.find((v) => v !== 0) ?? 0;
            const negative = px < 0;
            if (negative && !NEGATIVE_PREFIXES.has(prefix)) continue;
            const replacement =
              values.length === 1
                ? lengthReplacement(context, spec.category, px, prefix)
                : undefined;
            if (replacement && unnamed(replacement)) continue;
            const cls = replacement && `${negative ? '-' : ''}${replacement.cls}`;
            const cssVar =
              replacement?.cssVar &&
              (negative ? `calc(${replacement.cssVar} * -1)` : replacement.cssVar);
            const shown = number !== undefined ? `${name}: ${raw}` : `${name}: "${raw}"`;
            const size = replacement?.pill ? 'fully rounded' : formatPx(replacement?.px ?? 0);
            const advice = replacement
              ? replacement.tailwind
                ? `Use \`${cls}\` (${size}) in className instead of an inline style.`
                : `Use \`${cssVar ?? cls}\` (${size}).`
              : `Use ${spec.category} tokens instead.`;
            context.report({
              start: init.getStart(context.sourceFile),
              end: init.end,
              message: `Hardcoded ${spec.category} \`${shown}\` in style. ${advice}`,
              suggestion: replacement ? (replacement.tailwind ? cls : cssVar) : undefined,
              fix:
                replacement && !replacement.tailwind && cssVar && replacement.exact
                  ? [{ range: [init.getStart(context.sourceFile), init.end], text: `"${cssVar}"` }]
                  : undefined,
            });
          }
        }
      }
    },
  };
}

/**
 * A value on the scale whose token code cannot name, with neither a Tailwind class nor a
 * custom property (a DESIGN.md's `spacing.md`): there is nothing better to write.
 */
function unnamed(replacement: { exact: boolean; tailwind: boolean; cssVar?: string | undefined }) {
  return replacement.exact && !replacement.tailwind && !replacement.cssVar;
}

/** The nearest step is "far" when it is off by more than half the value and more than 4px. */
const FAR_RATIO = 0.5;
const FAR_PX = 4;

function lengthReplacement(
  context: RuleContext,
  category: 'spacing' | 'radius',
  px: number,
  prefix: string,
):
  | {
      cls: string;
      px: number;
      exact: boolean;
      /** A fully rounded radius (`rounded-full`) for a value far above the scale. */
      pill: boolean;
      /** The nearest step is too far off to swap in without changing the design. */
      far: boolean;
      tailwind: boolean;
      cssVar?: string | undefined;
      token: Token;
    }
  | undefined {
  const nearest = context.target.tokens.nearestLength(category, px);
  if (!nearest) return undefined;
  const { candidate } = nearest;
  const exact = nearest.distance < 0.01;
  const pill = nearest.pill === true;
  const far = !exact && !pill && nearest.distance > Math.max(FAR_PX, Math.abs(px) * FAR_RATIO);
  const cssVar = candidate.token.cssVar ? `var(${candidate.token.cssVar})` : undefined;
  const common = { px: candidate.px, exact, pill, far, cssVar, token: candidate.token };
  if (candidate.key !== undefined) {
    const key = candidate.key === 'DEFAULT' ? '' : `-${candidate.key}`;
    return { ...common, cls: `${prefix}${key}`, tailwind: true };
  }
  return {
    ...common,
    cls: cssVar ? `${prefix}-[${cssVar}]` : `${prefix}-[${formatPx(candidate.px)}]`,
    tailwind: false,
  };
}

export const noHardcodedSpacing = lengthRule(
  'no-hardcoded-spacing',
  'Padding, margin and gap must use the spacing scale, not arbitrary px/rem values.',
  { category: 'spacing', prefixes: SPACING_PREFIXES, styleProperties: STYLE_SPACING_PROPERTIES },
);

export const noHardcodedRadius = lengthRule(
  'no-hardcoded-radius',
  'Border radius must use radius tokens, not arbitrary values.',
  { category: 'radius', prefixes: RADIUS_PREFIXES, styleProperties: STYLE_RADIUS_PROPERTIES },
);
