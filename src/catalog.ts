import fs from 'node:fs';
import path from 'node:path';

import type { DesignSystem } from './design-system.js';
import { buildSearchIndex, searchComponents, type SearchHit } from './search/index.js';
import type { ComponentInfo, Token, TokenCategory } from './types.js';
import { relativePath } from './util/paths.js';
import { closest, unique } from './util/strings.js';

/** One project's design system at a workspace root. */
export interface ServedProject {
  ds: DesignSystem;
  /** Folder relative to the workspace root, with forward slashes. */
  dir: string;
  name?: string | undefined;
}

/**
 * The projects of a workspace root, as the MCP server serves them: one design system per
 * path, and all of them for the merged catalog.
 */
export interface ProjectSet {
  root: string;
  /** Folders of the projects with a design system, relative to the root. */
  dirs: string[];
  /** The design system that checks `target`, a file or folder relative to the root. */
  forPath(target: string): Promise<ServedProject>;
  /** Every project with a design system, loaded. */
  all(): Promise<ServedProject[]>;
  /** Their components and tokens together, rebuilt when a project reloads. */
  catalog(): Promise<Catalog>;
}

/** A component of the merged catalog: one source declaration, whichever projects use it. */
export interface CatalogEntry {
  /** As the first project that has it describes it, with `source.file` relative to the workspace root. */
  component: ComponentInfo;
  /** The design system to render it with (its props, tokens and parts). */
  ds: DesignSystem;
  /** The package its source file belongs to: `@acme/ui`, or the app's own name. */
  package: string;
  /** Folders of the projects that use it. */
  projects: string[];
  /** Another component of the catalog has the same name. */
  ambiguous: boolean;
}

export interface CatalogToken {
  token: Token;
  ds: DesignSystem;
  package: string;
  projects: string[];
}

/**
 * Every project's components and tokens in one list, for a workspace root when no path
 * picks a project. A component used by several projects (a design-system package) is
 * listed once, tagged with its package; two different components under one name are both
 * listed, each with its package, and a lookup by that name returns both.
 */
export class Catalog {
  readonly entries: CatalogEntry[];
  readonly tokens: CatalogToken[];
  private readonly index;

  constructor(
    readonly root: string,
    readonly projects: ServedProject[],
  ) {
    const byKey = new Map<string, CatalogEntry>();
    const owner = packageOwner(root);
    for (const { ds, dir } of projects) {
      for (const component of ds.components) {
        const file = path.resolve(ds.root, component.source.file);
        const key = `${file}\0${component.name}`;
        const known = byKey.get(key);
        if (known) {
          if (!known.projects.includes(dir)) known.projects.push(dir);
          // A consuming app imports it by package name: prefer that import over the package's own.
          if (isBare(component.importPath) && !isBare(known.component.importPath)) {
            known.component = rebase(component, root, file);
            known.ds = ds;
          }
          continue;
        }
        byKey.set(key, {
          component: rebase(component, root, file),
          ds,
          package: component.library ?? owner(file),
          projects: [dir],
          ambiguous: false,
        });
      }
    }
    this.entries = [...byKey.values()];
    const names = new Map<string, number>();
    for (const entry of this.entries) {
      names.set(entry.component.name, (names.get(entry.component.name) ?? 0) + 1);
    }
    for (const entry of this.entries) entry.ambiguous = (names.get(entry.component.name) ?? 0) > 1;
    this.index = buildSearchIndex(this.entries.map((e) => e.component));

    const tokens = new Map<string, CatalogToken>();
    for (const { ds, dir } of projects) {
      for (const token of ds.getTokens()) {
        const file = path.resolve(ds.root, token.source.file);
        const key = `${file}\0${token.name}\0${token.value}`;
        const known = tokens.get(key);
        if (known) {
          if (!known.projects.includes(dir)) known.projects.push(dir);
          continue;
        }
        tokens.set(key, {
          token: { ...token, source: { ...token.source, file: relativePath(root, file) } },
          ds,
          package: owner(file),
          projects: [dir],
        });
      }
    }
    this.tokens = [...tokens.values()];
  }

  /** Top-level components, not parts of another. */
  roots(): CatalogEntry[] {
    return this.entries.filter((e) => !e.component.parent);
  }

  /** Every distinct component a name resolves to, through each project's lookup. */
  find(name: string): CatalogEntry[] {
    const found: CatalogEntry[] = [];
    for (const { ds } of this.projects) {
      const component = ds.getComponent(name);
      if (!component) continue;
      const file = path.resolve(ds.root, component.source.file);
      const entry = this.entries.find(
        (e) =>
          e.component.name === component.name &&
          path.resolve(this.root, e.component.source.file) === file,
      );
      if (entry && !found.includes(entry)) found.push(entry);
    }
    return found;
  }

  suggest(name: string): string | undefined {
    return closest(name, unique(this.entries.map((e) => e.component.name)), 0.5);
  }

  search(query: string, limit = 5): (SearchHit & { entry: CatalogEntry })[] {
    return searchComponents(this.index, query, limit).flatMap((hit) => {
      const entry = this.entries.find((e) => e.component === hit.component);
      return entry ? [{ ...hit, entry }] : [];
    });
  }

  /** Tokens as `get_tokens` filters them, core ones before scoped families. */
  getTokens(
    filter: { category?: TokenCategory | undefined; query?: string | undefined } = {},
  ): CatalogToken[] {
    const query = filter.query?.toLowerCase();
    const scoped = (t: CatalogToken) =>
      Number(t.ds.tokenIndex.scopedFamilyOf(t.token) !== undefined);
    return this.tokens
      .filter(
        ({ token: t }) =>
          (!filter.category || t.category === filter.category) &&
          (!query ||
            t.name.toLowerCase().includes(query) ||
            (t.description ?? '').toLowerCase().includes(query) ||
            t.usage.some((u) => u.toLowerCase().includes(query))),
      )
      .sort((a, b) => scoped(a) - scoped(b));
  }
}

/** A specifier apps import by package name, not a relative path or a tsconfig alias. */
function isBare(specifier: string): boolean {
  return !/^(?:\.|@\/|~\/|#)/.test(specifier);
}

function rebase(component: ComponentInfo, root: string, file: string): ComponentInfo {
  return { ...component, source: { ...component.source, file: relativePath(root, file) } };
}

/** The name of the package a file belongs to (its nearest package.json), cached per folder. */
function packageOwner(root: string): (file: string) => string {
  const names = new Map<string, string>();
  return (file) => {
    const visited: string[] = [];
    let name: string | undefined;
    for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
      const known = names.get(dir);
      if (known !== undefined) {
        name = known;
        break;
      }
      visited.push(dir);
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
          name?: unknown;
        };
        name = typeof pkg.name === 'string' ? pkg.name : relativePath(root, dir) || '.';
        break;
      } catch {
        // No package.json here: look further up.
      }
      if (dir === root || dir === path.dirname(dir)) {
        name = relativePath(root, dir) || '.';
        break;
      }
    }
    for (const dir of visited) names.set(dir, name);
    return name;
  };
}
