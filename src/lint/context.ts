import type ts from 'typescript';

import type { RuleId, RuleOptions } from '../config.js';
import type { ComponentInfo, Severity, TextEdit } from '../types.js';
import type { Analysis, JsxNode } from './analyze.js';
import type { LintTarget } from './target.js';

export interface Report {
  start: number;
  end: number;
  message: string;
  suggestion?: string | undefined;
  fix?: TextEdit[] | undefined;
  /** Rules may downgrade (never upgrade) their configured severity for low-confidence findings. */
  severity?: Severity;
}

export interface RuleContext {
  file: string;
  text: string;
  sourceFile: ts.SourceFile;
  target: LintTarget;
  analysis: Analysis;
  options: RuleOptions;
  /** True when the checked file is one of the design system's own component sources. */
  isDesignSystemSource: boolean;
  resolve(element: JsxNode): Resolution;
  report(report: Report): void;
  /** Records a component the model does not include, which the rules cannot check. */
  unchecked(name: string, module: string): void;
}

export interface Rule {
  id: RuleId;
  description: string;
  run(context: RuleContext): void;
}

export type Resolution =
  /** A design-system component. */
  | { kind: 'component'; component: ComponentInfo }
  /** A lowercase JSX tag. */
  | { kind: 'intrinsic'; tag: string }
  /** Imported from the design system's path, but the design system has no such component. */
  | { kind: 'missing-export'; name: string; source: string }
  /** `Card.Header` where `Card` is a design-system component without that member. */
  | { kind: 'missing-member'; owner: ComponentInfo; member: string }
  /** Not imported, not declared and not a design-system component. */
  | { kind: 'unresolved'; name: string }
  /** Imported from elsewhere or declared locally: not our business. */
  | { kind: 'external' };

/**
 * Resolves a JSX tag to a design-system component, following imports and
 * aliases. `file` is the checked file relative to the root, for relative imports.
 */
export function resolveElement(
  element: JsxNode,
  analysis: Analysis,
  target: LintTarget,
  file: string,
): Resolution {
  const tag = element.tag;
  if (/^[a-z]/.test(tag) && !tag.includes('.')) return { kind: 'intrinsic', tag };
  const [head = '', ...rest] = tag.split('.');
  const binding = analysis.imports.get(head);

  // `UI.Button` with `import * as UI from "@/components/ui"`.
  if (binding?.imported === '*' && rest.length) {
    if (!target.isDesignSystemImport(binding.source, file)) return { kind: 'external' };
    const name = rest.join('.');
    const library = target.libraryOf(binding.source);
    if (library) return fromLibrary(target, library, name, binding.source, rest.length > 1);
    const component = target.components.get(name);
    if (component) return { kind: 'component', component };
    // `UI.Icons.Add`: a member of a real export that is not a component (an
    // icon map). A bare `<UI.Icons />` renders an object, so it stays reported.
    const member = rest[0] ?? '';
    if (rest.length > 1 && target.exports.has(member) && !target.components.has(member)) {
      return { kind: 'external' };
    }
    return { kind: 'missing-export', name, source: binding.source };
  }

  let owner: ComponentInfo | undefined;
  // Imported and declared again in an inner scope (`const Icon = icons[name]` next to an
  // imported `Icon` type): which one a tag means depends on scope, so it is not judged.
  if (binding && analysis.declared.has(head)) return { kind: 'external' };
  const library = binding ? target.libraryOf(binding.source) : undefined;
  if (binding && library) {
    const imported =
      binding.imported === 'default'
        ? target.defaultExport(binding.source, file)?.name
        : binding.imported;
    // A default export that is no component the model has: a module of the package's own.
    if (imported === undefined) return { kind: 'external' };
    const resolved = fromLibrary(target, library, imported, binding.source, rest.length > 0);
    if (resolved.kind !== 'component') return resolved;
    owner = resolved.component;
  } else if (binding) {
    if (!target.isDesignSystemImport(binding.source, file)) return { kind: 'external' };
    const imported =
      binding.imported === 'default'
        ? (target.defaultExport(binding.source, file)?.name ?? head)
        : binding.imported;
    owner = target.componentFor(imported, binding.source, file);
    // The import leads to another declaration of that name than the model's.
    if (!owner && target.components.has(imported)) return { kind: 'external' };
    if (!owner) {
      // `<Icons.Add />` from `@acme/ui/icons`: a member of an export that is
      // not a component. A bare `<Icons />` renders an object, so it stays reported.
      if (rest.length && target.exports.has(imported)) return { kind: 'external' };
      return { kind: 'missing-export', name: imported, source: binding.source };
    }
  } else if (analysis.declared.has(head)) {
    return { kind: 'external' };
  } else {
    owner = target.components.get(head);
    if (!owner) return { kind: 'unresolved', name: tag };
  }

  if (!rest.length) return { kind: 'component', component: owner };
  const member = target.components.get(`${owner.name}.${rest.join('.')}`);
  return member
    ? { kind: 'component', component: member }
    : { kind: 'missing-member', owner, member: rest.join('.') };
}

/**
 * `name` from a library (`@mui/material`, or a module of it such as `@mui/material/Button`): its
 * own component of that name, never a wrapper the project has. A name the package exports that
 * is no component (a context, a styled slot it does not offer), or one imported from one of its
 * modules rather than the package itself, is not judged; one the package does not export at all
 * is invented.
 */
function fromLibrary(
  target: LintTarget,
  library: string,
  name: string,
  source: string,
  member: boolean,
): Resolution {
  const component = target.libraryComponent(name, library);
  if (component) return { kind: 'component', component };
  if (source !== library || target.exports.has(name) || member) return { kind: 'external' };
  return { kind: 'missing-export', name, source };
}
