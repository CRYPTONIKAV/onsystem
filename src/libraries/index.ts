import fs from 'node:fs';
import path from 'node:path';

import type { ComponentInfo, Token } from '../types.js';
import { mui } from './mui.js';

/**
 * A published component library that onsystem reads from its type declarations rather than
 * from source: what an app gets from `npm install`, with no components folder of its own. Each
 * library is an adapter: its package, how to read its declarations and its theme. MUI is the
 * first; Chakra UI, Mantine, HeroUI and Radix Themes fit the same shape.
 */
export interface LibraryAdapter {
  /** The package apps depend on and import components from: `@mui/material`. */
  package: string;
  /** Its name, for `inspect` and messages: `MUI`. */
  title: string;
  /**
   * Source that augments the library's types, which the app's own files can do to add or remove
   * variant values (`declare module "@mui/material/Button"`). Files that match are read with the
   * declarations, so the values they add are allowed.
   */
  augments: RegExp;
  /** A component's description from its JSDoc, or undefined for none. Default: the JSDoc as is. */
  describe?(jsdoc: string, name: string): string | undefined;
  /** What the library's types do not say about a component: a child its Tooltip labels. */
  annotate?(component: ComponentInfo): void;
  /** The theme the app creates for the library, read from its source: tokens and added values. */
  theme?: ThemeReader;
}

/** Reads the app's theme from the source files that `matches` selects. */
export interface ThemeReader {
  /** Which files to read. */
  matches: RegExp;
  read(
    files: { file: string; text: string }[],
    root: string,
  ): {
    tokens: Token[];
    warnings: string[];
    values: AddedValue[];
    /** Other files read, such as the modules a theme imports its colors from. */
    files?: string[];
  };
}

/**
 * A value the app's theme adds to a prop at runtime, which a JavaScript app need not declare in
 * types: a custom palette color (`teal`) or component variant (`dashed`).
 */
export interface AddedValue {
  /** The component it applies to; without one, each of the library's components. */
  component?: string | undefined;
  prop: string;
  value: string;
  /** Without a component, only props that already allow this value (`primary`): palette colors. */
  alongside?: string | undefined;
}

/** The libraries onsystem can read, by package. */
export const LIBRARIES: readonly LibraryAdapter[] = [mui];

/** A library an app depends on, and where it is installed. */
export interface LibrarySource {
  package: string;
  /** The installed package's folder, absolute; undefined when it is a dependency but not installed. */
  dir?: string | undefined;
  /** The installed version. */
  version?: string | undefined;
}

export function libraryAdapter(name: string): LibraryAdapter | undefined {
  return LIBRARIES.find((library) => library.package === name);
}

/**
 * The libraries `root`'s package.json depends on (dependencies, devDependencies or
 * peerDependencies), each found where Node.js would find it: in `node_modules` at the root or a
 * folder above it, as a monorepo hoists it. Nothing in the package is run.
 */
export function detectLibraries(root: string): LibrarySource[] {
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg) return [];
  const dependencies = new Set(
    ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((field) => {
      const value = pkg[field];
      return value && typeof value === 'object' ? Object.keys(value) : [];
    }),
  );
  return LIBRARIES.filter((library) => dependencies.has(library.package)).map((library) => {
    const dir = installedPackage(root, library.package);
    const version = dir ? readJson(path.join(dir, 'package.json'))?.version : undefined;
    return {
      package: library.package,
      dir,
      version: typeof version === 'string' ? version : undefined,
    };
  });
}

/** The folder `name` is installed in for code in `root`, looking up through `node_modules` folders. */
function installedPackage(root: string, name: string): string | undefined {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === path.dirname(dir)) return undefined;
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
