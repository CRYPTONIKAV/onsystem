import path from 'node:path';

import type { ResolvedConfig } from '../config.js';
import type { ModuleResolver } from '../modules.js';
import { TokenIndex } from '../tokens/index.js';
import { tokenFamily } from '../tokens/roles.js';
import type { ComponentInfo, DesignSystemModel, Token } from '../types.js';
import { matchesGlob, toPosix } from '../util/paths.js';
import { unique } from '../util/strings.js';
import { COLOR_UTILITY, parseUtility } from './tailwind.js';

/**
 * Elements a design system typically replaces. Containers (`div`, `span`,
 * `p`) are deliberately absent: `Card` renders a `div`, but not every `div`
 * should be a `Card`.
 */
const REPLACEABLE_ELEMENTS = new Set([
  'a',
  'button',
  'dialog',
  'details',
  'hr',
  'img',
  'input',
  'label',
  'meter',
  'progress',
  'select',
  'table',
  'textarea',
]);

/** `<input type>` values that are not text fields; an `Input` component does not cover them. */
export const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'range',
  'file',
  'hidden',
  'color',
  'submit',
  'reset',
  'button',
  'image',
]);

/**
 * Attributes only some replaceable elements take. A component that accepts
 * all of an element's (Radix `Label` takes `htmlFor`) takes that element's
 * attributes, whatever it renders at the top.
 */
const ELEMENT_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'target', 'download'],
  button: ['formAction', 'formNoValidate'],
  img: ['src', 'srcSet', 'alt'],
  input: ['accept', 'checked', 'step'],
  label: ['htmlFor'],
  select: ['multiple', 'size'],
  table: ['cellPadding', 'cellSpacing'],
  textarea: ['rows', 'cols'],
};

/**
 * Component names that say what a native element is: `Button` is a `<button>`,
 * `Link` an `<a>`. Matched whole; a longer name ending in one (`IconButton`,
 * `SearchInput`, `DataTable`) is related more loosely.
 */
const ELEMENT_NAMES: Record<string, string[]> = {
  a: ['Link', 'A'],
  button: ['Button'],
  dialog: ['Dialog', 'Modal'],
  details: ['Details', 'Disclosure'],
  hr: ['Separator', 'Divider', 'Hr'],
  img: ['Img', 'Image'],
  input: ['Input', 'TextInput', 'TextField'],
  label: ['Label'],
  meter: ['Meter'],
  progress: ['Progress', 'ProgressBar'],
  select: ['Select', 'NativeSelect'],
  table: ['Table'],
  textarea: ['Textarea', 'TextArea'],
};

/**
 * Names that may mean the element or something else: Radix's popover `Anchor`,
 * shadcn/ui's `Field` (a layout around a control). Related loosely, like a suffix.
 */
const LOOSE_NAMES: Record<string, string[]> = {
  a: ['Anchor'],
  input: ['Field'],
};

/**
 * How a component's name relates to a native element: `exact` for `Button` and
 * `<button>`, `suffix` for `IconButton` (and the ambiguous `Anchor` or `Field`), or none.
 */
export function nameRelation(name: string, element: string): 'exact' | 'suffix' | undefined {
  const words = ELEMENT_NAMES[element];
  if (!words) return undefined;
  if (words.includes(name)) return 'exact';
  if (LOOSE_NAMES[element]?.includes(name)) return 'suffix';
  return words.some((word) => word.length > 1 && name.length > word.length && name.endsWith(word))
    ? 'suffix'
    : undefined;
}

/** The replaceable element a component is named for, if any: `select` for `Select` and `NativeSelect`. */
function namedFor(name: string): string | undefined {
  return Object.keys(ELEMENT_NAMES).find((element) => nameRelation(name, element) !== undefined);
}

/** What the lint rules need to know about the design system. */
export class LintTarget {
  readonly components = new Map<string, ComponentInfo>();
  /** Every component under each name and alias, when two design systems share one (`Button`). */
  private readonly named = new Map<string, ComponentInfo[]>();
  readonly tokens: TokenIndex;
  /** Native element → the component that replaces it. */
  readonly elements = new Map<string, ComponentInfo>();
  /** The `elements` entries the config sets explicitly. */
  private readonly configured = new Map<string, ComponentInfo>();
  readonly componentFiles: Set<string>;
  /** Every value the component files export, components or not (`Icons`, `buttonVariants`). */
  readonly exports: Set<string>;
  private readonly importPaths: Set<string>;
  private readonly importPrefixes: string[];
  /** Component files relative to the root, without extension (`components/ui/button`). */
  private readonly componentModules = new Set<string>();
  private readonly moduleDirs = new Set<string>();
  /** The files extraction read, when the model says. */
  private readonly sources?: Set<string>;
  /** Published libraries the model read from type declarations: `@mui/material`. */
  readonly libraries: Set<string>;

  /**
   * `resolver` finds the module an import points at and what it exports
   * (`@calcom/ui/components/icon` → `components/icon/index.ts`), so a name from
   * a module the model left out is not taken for an invented one. Without it,
   * every missing name is invented.
   */
  constructor(
    readonly model: DesignSystemModel,
    readonly config: Pick<ResolvedConfig, 'elements' | 'importPath'> &
      Partial<Pick<ResolvedConfig, 'designSystems'>>,
    private readonly resolver?: Pick<ModuleResolver, 'locate' | 'exportsOf'>,
  ) {
    // With several design systems, the most imported one's components win a shared name:
    // registered last, so they overwrite the others. A library's come after the project's own.
    const rank = designSystemRank(config.designSystems);
    this.libraries = new Set(model.components.flatMap((c) => (c.library ? [c.library] : [])));
    const byRank = [...model.components].sort((a, b) => rank(b) - rank(a));
    for (const component of byRank) {
      for (const name of [component.name, ...component.aliases]) {
        this.components.set(name, component);
        this.named.set(name, [...(this.named.get(name) ?? []), component]);
      }
    }
    // Without components there is no usage to tell a scoped family by.
    this.tokens = new TokenIndex(model.tokens, {
      filesUsing: model.components.length ? familyUsage(model) : undefined,
    });
    // The project's own component files: a library's declarations are no module of the project.
    this.componentFiles = new Set(
      model.components.filter((c) => !c.library).map((c) => c.source.file),
    );
    this.exports = new Set(model.exports);

    // Root components only: `BreadcrumbLink` is an `a`, but `<a>` should not become a breadcrumb part.
    // A component replaces an element it is named for (`Button`, `Link`, `Input`). One that only
    // renders the element, or whose name merely ends like it (`IconButton`), replaces it only when
    // it needs nothing the element does not: `<button>` never becomes `<DataTableColumnHeader>`
    // (it needs `column` and `title`), nor `<label>` a `<FileUpload>` that takes no `htmlFor`.
    for (const component of model.components) {
      if (component.parent) continue;
      const named = namedFor(component.name);
      for (const element of REPLACEABLE_ELEMENTS) {
        const relation = nameRelation(component.name, element);
        if (!relation && component.element !== element) continue;
        // `Select` renders a <button> trigger, but it is a select, not a button.
        if (!relation && named) continue;
        if (relation !== 'exact' && !this.plainFor(component, element)) continue;
        const existing = this.elements.get(element);
        // The most imported design system's component first, then the best fit.
        if (
          !existing ||
          rank(component) < rank(existing) ||
          (rank(component) === rank(existing) && fit(component, element) > fit(existing, element))
        ) {
          this.elements.set(element, component);
        }
      }
    }
    for (const [element, name] of Object.entries(config.elements)) {
      const component = this.components.get(name);
      if (!component) continue;
      this.elements.set(element, component);
      this.configured.set(element, component);
    }

    this.importPaths = new Set(model.components.map((c) => c.importPath));
    // A path alias names a directory (`@/components/ui/`), so any module under it
    // belongs to the design system. A configured package name is a single
    // module: `@acme/ui` says nothing about `@acme/icons`. A pattern
    // (`@acme/ui/{path}`) covers what comes before `{path}`.
    const pattern = config.importPath?.indexOf('{path}') ?? -1;
    this.importPrefixes = unique([
      ...(config.importPath
        ? [pattern === -1 ? `${config.importPath}/` : config.importPath.slice(0, pattern)]
        : [...this.importPaths]
            .filter((p) => !p.startsWith('.'))
            // A package's own name (`@dub/ui`, imported through its barrel) covers its
            // subpaths, not its scope: `@dub/analytics` is another package.
            .map((p) => (isPackageName(p) ? `${p}/` : p.slice(0, p.lastIndexOf('/') + 1)))
            .filter(Boolean)),
      // A library's subpaths (`@mui/material/Button`), whatever the config names.
      ...[...this.libraries].map((library) => `${library}/`),
    ]);
    for (const file of this.componentFiles) {
      for (const module of modulePaths(file)) this.componentModules.add(module);
      this.moduleDirs.add(path.posix.dirname(file));
    }
    if (model.sources) this.sources = new Set(model.sources);
  }

  /**
   * Whether an import specifier points at the design system. Relative
   * specifiers are resolved against `fromFile` (relative to the root) and
   * must land on a component file, in a directory that holds one, or on that
   * directory itself (a barrel: `../components/ui` and its index).
   */
  isDesignSystemImport(specifier: string, fromFile = 'snippet.tsx'): boolean {
    if (specifier.startsWith('.')) {
      const resolved = this.resolveRelative(specifier, fromFile);
      return (
        this.componentModules.has(resolved) ||
        this.moduleDirs.has(resolved) ||
        this.moduleDirs.has(path.posix.dirname(resolved))
      );
    }
    if (this.importPaths.has(specifier) || specifier === this.config.importPath) return true;
    // `@/components/ui/button`, or the barrel `@/components/ui` itself.
    return this.importPrefixes.some(
      (prefix) => specifier.startsWith(prefix) || specifier === prefix.slice(0, -1),
    );
  }

  /**
   * Whether `name`, imported from the design system, may be a real export the
   * model left out rather than an invented one: its module exists outside the
   * folders extraction read and exports `name`, or re-exports from such a
   * module (an excluded `icons/` folder, a barrel's `export * from "./icons"`).
   * A module declared in a package's `exports` but not on disk counts too,
   * except the design system's own import path.
   */
  outsideModel(specifier: string, name: string, fromFile = 'snippet.tsx'): boolean {
    const location = this.resolver?.locate(specifier, fromFile);
    if (!location) return false;
    if (!location.file) {
      return !this.importPaths.has(specifier) && specifier !== this.config.importPath;
    }
    return this.mayExport(location.file, name, 0);
  }

  /**
   * The component a JSX tag means when `name` is imported from `specifier`, among the
   * model's components of that name: the one declared where the import leads, through
   * barrels (`export { Button } from "./Button"`, `export *`). `undefined` when it leads to
   * a declaration the model does not have (another package's `Button`, or a file of the
   * same name outside the component folders), which is not ours to check. Where the import
   * cannot be followed, the component of that name, as before.
   */
  componentFor(name: string, specifier: string, fromFile: string): ComponentInfo | undefined {
    const fallback = this.components.get(name);
    const { resolver } = this;
    const file = resolver?.locate(specifier, fromFile)?.file;
    if (!resolver || !file) return fallback;
    const at = (target: string, declared: string) => {
      const modules = modulePaths(target);
      const candidates = this.named.get(declared) ?? [];
      return candidates.find((c) =>
        modulePaths(c.source.file).some((module) => modules.includes(module)),
      );
    };
    const direct = at(file, name);
    if (direct) return direct;
    // An import of a component file the model has, by a name it does not declare: as before.
    if (modulePaths(file).some((module) => this.componentModules.has(module))) return fallback;
    const origin = this.originOf(name, file, 0);
    // Not followed to the end, or not exported there: the model's component of that name.
    if (origin === null || origin === undefined) return fallback;
    // A module namespace (`export * as RadioAreaGroup from "./RadioAreaGroup"`) is no component.
    if ('namespace' in origin) return undefined;
    // `export { Table as TableNew } from "./TableNew"` is TableNew.tsx's `Table`. A
    // declaration the model does not have (a component extraction did not recognise, or a
    // file outside it) is not ours to check.
    return at(origin.file, origin.name);
  }

  /**
   * Where what `file` exports as `name` is declared, following re-exports: the file
   * (relative to the root) and its name there, `{ namespace }` for a module namespace,
   * `undefined` when it does not export it, `null` when a step of the way does not
   * resolve or cannot be read.
   */
  private originOf(
    name: string,
    file: string,
    depth: number,
  ): { file: string; name: string } | { namespace: string } | undefined | null {
    if (depth > 8) return null;
    const exports = this.resolver?.exportsOf(file);
    if (!exports) return null;
    if (exports.declared.includes(name)) return { file, name };
    if (exports.namespaces.has(name)) return { namespace: file };
    const reexport = exports.reexports.get(name);
    if (reexport) {
      return reexport.from === undefined
        ? null
        : this.originOf(reexport.name, reexport.from, depth + 1);
    }
    let unknown = false;
    for (const from of exports.starFrom) {
      if (from === undefined) {
        unknown = true;
        continue;
      }
      const found = this.originOf(name, from, depth + 1);
      if (found) return found;
      if (found === null) unknown = true;
    }
    return unknown ? null : undefined;
  }

  private mayExport(file: string, name: string, depth: number): boolean {
    if (modulePaths(file).some((module) => this.componentModules.has(module))) return false;
    const exports = this.resolver?.exportsOf(file);
    if (!exports) return depth > 0;
    // Declared in a file extraction read (an icon map next to the components), it was seen
    // and is no component; declared anywhere else, the model never looked. A model from
    // before `sources` was recorded counts every file in the components' folders as read.
    if (exports.names.includes(name)) {
      return this.sources
        ? !this.sources.has(file)
        : !this.moduleDirs.has(path.posix.dirname(file));
    }
    return exports.starFrom.some(
      (from) => from === undefined || depth >= 3 || this.mayExport(from, name, depth + 1),
    );
  }

  /**
   * Whether `<Component>` can replace the native element `key` (`a`,
   * `input[type=checkbox]`) by renaming the tag: the config maps it, it
   * renders that element, or it takes the element's own attributes.
   */
  isDropIn(component: ComponentInfo, key: string): boolean {
    if (this.configured.get(key) === component || component.element === key) return true;
    const needed = ELEMENT_ATTRIBUTES[key];
    if (!needed || component.openProps) return false;
    const accepted = new Set(component.props.map((p) => p.name));
    for (const inherited of component.inherits) {
      for (const name of this.model.propSets[inherited.set] ?? []) accepted.add(name);
    }
    return needed.every((name) => accepted.has(name));
  }

  /**
   * Whether a component asks for nothing beyond what the element takes: no
   * required prop of its own, and the element's own attributes (`htmlFor` for a
   * label). Unknown when its props do not fully resolve, so false.
   */
  private plainFor(component: ComponentInfo, element: string): boolean {
    if (component.openProps) return false;
    const accepted = new Set<string>();
    for (const inherited of component.inherits) {
      for (const name of this.model.propSets[inherited.set] ?? []) accepted.add(name);
    }
    if (component.props.some((p) => p.required && !accepted.has(p.name))) return false;
    for (const prop of component.props) accepted.add(prop.name);
    return (ELEMENT_ATTRIBUTES[element] ?? []).every((name) => accepted.has(name));
  }

  /** The component a module exports as `default`, for `import Anything from "..."`. */
  defaultExport(specifier: string, fromFile = 'snippet.tsx'): ComponentInfo | undefined {
    const resolved = specifier.startsWith('.')
      ? this.resolveRelative(specifier, fromFile)
      : undefined;
    // `import Button from "@mui/material/Button"`: a library's folder module.
    const fromLibrary = this.model.components.filter((c) => c.defaultImport === specifier);
    if (fromLibrary.length === 1) return fromLibrary[0];
    const matches = this.model.components.filter(
      (c) =>
        c.exportName === 'default' &&
        (resolved === undefined
          ? // With a package name every component shares it, so it says nothing about the file.
            (!this.config.importPath || this.config.importPath.includes('{path}')) &&
            c.importPath === specifier
          : modulePaths(c.source.file).includes(resolved)),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  private resolveRelative(specifier: string, fromFile: string): string {
    const from = path.isAbsolute(fromFile) ? path.relative(this.model.root, fromFile) : fromFile;
    return path.posix.join(path.posix.dirname(toPosix(from)), stripExtension(specifier));
  }

  /** The library an import specifier points into (`@mui/material/Button`), if any. */
  libraryOf(specifier: string): string | undefined {
    for (const library of this.libraries) {
      if (specifier === library || specifier.startsWith(`${library}/`)) return library;
    }
    return undefined;
  }

  /** The library's own component of that name: `Button` from `@mui/material`, not a wrapper. */
  libraryComponent(name: string, library: string): ComponentInfo | undefined {
    return (this.named.get(name) ?? []).find((c) => c.library === library);
  }

  /** Component names for "did you mean" suggestions. */
  names(): string[] {
    return [...this.components.keys()];
  }
}

/**
 * Token family → the design-system files whose classes or CSS variables use
 * one of its colors (`bg-sidebar-accent`, `var(--sh-class)`).
 */
function familyUsage(model: DesignSystemModel): Map<string, Set<string>> {
  const byKey = new Map<string, Token>();
  const byVar = new Map<string, Token>();
  for (const token of model.tokens) {
    if (token.category !== 'color') continue;
    if (token.tailwind) byKey.set(token.tailwind, token);
    if (token.cssVar) byVar.set(token.cssVar, token);
  }
  const usage = new Map<string, Set<string>>();
  const use = (token: Token | undefined, file: string) => {
    if (!token) return;
    const family = tokenFamily(token);
    const files = usage.get(family) ?? new Set<string>();
    files.add(file);
    usage.set(family, files);
  };
  for (const component of model.components) {
    const file = component.source.file;
    for (const cls of component.classNames) {
      const key = COLOR_UTILITY.exec(parseUtility(cls).base)?.[1];
      if (key) use(byKey.get(key), file);
    }
    for (const cssVar of component.cssVars) use(byVar.get(cssVar), file);
  }
  return usage;
}

/**
 * A component's place among the design systems an app uses: 0 for the most imported, and
 * so on; with one design system, 0 for all. A library's components (MUI) come after them all.
 */
function designSystemRank(
  sources: ResolvedConfig['designSystems'],
): (component: ComponentInfo) => number {
  // A library's components come after the project's own design systems: its wrappers win.
  const last = (sources?.length ?? 1) + 1;
  if (!sources || sources.length < 2) return (component) => (component.library ? last : 0);
  const ranks = new Map<string, number>();
  return (component) => {
    if (component.library) return last;
    const file = component.source.file;
    let rank = ranks.get(file);
    if (rank === undefined) {
      const index = sources.findIndex((s) => s.components.some((glob) => matchesGlob(file, glob)));
      rank = index === -1 ? sources.length : index;
      ranks.set(file, rank);
    }
    return rank;
  };
}

/**
 * How well a component replaces a native element: rendering it counts most
 * (`NativeSelect` over Radix's `Select` for <select>), then being named after
 * it (`Button` over `IconButton` for <button>).
 */
function fit(component: ComponentInfo, element: string): number {
  const relation = nameRelation(component.name, element);
  return (
    (component.element === element ? 2 : 0) +
    (relation === 'exact' ? 1 : relation === 'suffix' ? 0.5 : 0)
  );
}

/** `@dub/ui` or `acme-ui`: a package name with no subpath. */
function isPackageName(specifier: string): boolean {
  return specifier.startsWith('@')
    ? /^@[^/]+\/[^/]+$/.test(specifier)
    : /^[a-z0-9][^/]*$/i.test(specifier);
}

function stripExtension(file: string): string {
  return file.replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

/** `components/ui/button.tsx` → `components/ui/button`; an index file is also its directory. */
function modulePaths(file: string): string[] {
  const module = stripExtension(file);
  return module.endsWith('/index') ? [module, module.slice(0, -'/index'.length)] : [module];
}
