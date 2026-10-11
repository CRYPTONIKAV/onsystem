import fsp from 'node:fs/promises';

import { glob } from 'tinyglobby';

import type { ResolvedConfig } from '../config.js';
import { readProjectConfig, type ProjectConfig } from '../extract/program.js';
import type { ComponentInfo, Token } from '../types.js';
import { unique } from '../util/strings.js';
import { extractLibrary } from './declarations.js';
import { libraryAdapter, type AddedValue } from './index.js';

export interface LoadedLibraries {
  components: ComponentInfo[];
  propSets: Record<string, string[]>;
  exports: string[];
  tokens: Token[];
  warnings: string[];
  /** Project files read: module augmentations, the modules they import, and theme files. */
  dependencies: string[];
}

/** App sources read for module augmentations and themes, at most. */
const MAX_SOURCES = 5000;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** Without a tsconfig, where an app's sources are not. */
const NOT_SOURCES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.next/**',
  '**/coverage/**',
  '**/public/**',
];

/**
 * The components and tokens of the libraries `config` found (`config.libraries`): each one's
 * components from its type declarations, read together with the app's files that augment them,
 * and the tokens of the theme the app creates for it.
 */
export async function loadLibraries(config: ResolvedConfig): Promise<LoadedLibraries> {
  const loaded: LoadedLibraries = {
    components: [],
    propSets: {},
    exports: [],
    tokens: [],
    warnings: [],
    dependencies: [],
  };
  const libraries = (config.libraries ?? []).flatMap((source) => {
    const adapter = libraryAdapter(source.package);
    return adapter ? [{ source, adapter }] : [];
  });
  if (!libraries.length) return loaded;

  const project = readProjectConfig(config.root, config.tsconfig);
  const patterns = libraries.flatMap(({ adapter }) => [
    adapter.augments,
    ...(adapter.theme ? [adapter.theme.matches] : []),
  ]);
  const sources = await appSources(config.root, project, patterns);
  for (const { source, adapter } of libraries) {
    if (!source.dir) {
      loaded.warnings.push(
        `${adapter.title} (${source.package}) is a dependency but is not installed, so its components are not known: install the dependencies.`,
      );
      continue;
    }
    const augmentations = sources.filter((s) => adapter.augments.test(s.text)).map((s) => s.file);
    const extracted = extractLibrary({
      root: config.root,
      adapter,
      dir: source.dir,
      project,
      augmentations,
    });
    if (adapter.theme) {
      const { matches } = adapter.theme;
      const themes = sources.filter((s) => matches.test(s.text));
      const read = adapter.theme.read(themes, config.root);
      addValues(extracted.components, read.values);
      loaded.tokens.push(...read.tokens);
      loaded.warnings.push(...read.warnings);
      loaded.dependencies.push(...themes.map((s) => s.file), ...(read.files ?? []));
    }
    loaded.components.push(...extracted.components);
    Object.assign(loaded.propSets, extracted.propSets);
    loaded.exports.push(...extracted.exports);
    loaded.warnings.push(...extracted.warnings);
    loaded.dependencies.push(...extracted.dependencies, ...augmentations);
  }
  loaded.exports = unique(loaded.exports).sort();
  loaded.dependencies = unique(loaded.dependencies);
  return loaded;
}

/** Adds the values the app's theme gives props (`teal`, `dashed`) to the props that take values. */
function addValues(components: ComponentInfo[], values: AddedValue[]): void {
  for (const added of values) {
    for (const component of components) {
      if (added.component !== undefined && component.name !== added.component) continue;
      const prop = component.props.find((p) => p.name === added.prop);
      if (!prop?.values || prop.values.includes(added.value)) continue;
      if (added.alongside !== undefined && !prop.values.includes(added.alongside)) continue;
      prop.values.push(added.value);
      prop.type = prop.values.map((v) => JSON.stringify(v)).join(' | ');
      const variant = component.variants.find((v) => v.name === added.prop);
      if (variant && !variant.values.includes(added.value)) variant.values.push(added.value);
    }
  }
}

/**
 * The app's source files whose text one of `patterns` matches, with that text: the files its
 * tsconfig includes, or without one the scripts under the root, at most `MAX_SOURCES`.
 */
async function appSources(
  root: string,
  project: ProjectConfig,
  patterns: RegExp[],
): Promise<{ file: string; text: string }[]> {
  const included = project.fileNames.filter(
    (file) => SOURCE_FILE.test(file) && !/[\\/]node_modules[\\/]/.test(file),
  );
  const files = (
    included.length
      ? included
      : await glob('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}', {
          cwd: root,
          absolute: true,
          ignore: NOT_SOURCES,
        })
  )
    .sort()
    .slice(0, MAX_SOURCES);
  const found: { file: string; text: string }[] = [];
  // In batches, to stay well under the open-file limit.
  for (let i = 0; i < files.length; i += 64) {
    const batch = await Promise.all(
      files.slice(i, i + 64).map(async (file) => {
        try {
          const text = await fsp.readFile(file, 'utf8');
          return patterns.some((pattern) => pattern.test(text)) ? { file, text } : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    for (const entry of batch) if (entry) found.push(entry);
  }
  return found;
}
