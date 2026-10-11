import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { glob } from 'tinyglobby';
import type ts from 'typescript';

import { loadConfig, rulesFor, type ResolvedConfig } from './config.js';
import { moduleResolver } from './detect.js';
import { extractComponents } from './extract/components.js';
import { attachDocs, parseDoc, type ParsedDoc } from './extract/docs.js';
import { isProjectFile, projectFiles, readProjectConfig } from './extract/program.js';
import { loadLibraries } from './libraries/load.js';
import { checkSource, LintTarget } from './lint/index.js';
import { ModuleResolver } from './modules.js';
import {
  buildSearchIndex,
  searchComponents,
  type Bm25Index,
  type SearchHit,
} from './search/index.js';
import { loadTokens, type TokenIndex } from './tokens/index.js';
import { applyTailwindColors, readTailwindColors } from './tokens/tailwind-config.js';
import type {
  CheckResult,
  ComponentInfo,
  DesignSystemModel,
  Token,
  TokenCategory,
} from './types.js';
import { silentLogger, type Logger } from './util/log.js';
import { globBase, isInside, relativePath } from './util/paths.js';
import { closest, unique } from './util/strings.js';
import { COLOR_UTILITY, parseUtility } from './lint/tailwind.js';
import { VERSION } from './version.js';

/** A loaded design system: the model plus the indexes the tools query. */
export class DesignSystem {
  readonly lint: LintTarget;
  private readonly searchIndex: Bm25Index<ComponentInfo>;
  /**
   * The components the tools offer: all of them, except a library's (MUI's) where the project
   * has its own of that name, a wrapper the team means to be used. The rules still check code
   * that imports the library's directly against the library's.
   */
  private readonly offered: ComponentInfo[];

  constructor(
    readonly model: DesignSystemModel,
    readonly config: ResolvedConfig,
  ) {
    this.lint = new LintTarget(model, config, new ModuleResolver(config));
    const own = new Set(
      model.components.filter((c) => !c.library).flatMap((c) => [c.name, ...c.aliases]),
    );
    this.offered = model.components.filter(
      (c) => !c.library || !(own.has(c.name) || (c.parent !== undefined && own.has(c.parent))),
    );
    this.searchIndex = buildSearchIndex(this.offered);
  }

  get root(): string {
    return this.model.root;
  }

  get components(): ComponentInfo[] {
    return this.offered;
  }

  get tokens(): Token[] {
    return this.model.tokens;
  }

  get tokenIndex(): TokenIndex {
    return this.lint.tokens;
  }

  /** Top-level components, i.e. not parts of another component. */
  roots(): ComponentInfo[] {
    return this.offered.filter((c) => !c.parent);
  }

  /** Looks a component up by name, alias, `Card.Header`/`CardHeader` or case-insensitively. */
  getComponent(name: string): ComponentInfo | undefined {
    const exact = this.lint.components.get(name);
    if (exact) return exact;
    const key = (n: string) => n.replace(/\./g, '').toLowerCase();
    const wanted = key(name);
    return this.offered.find(
      (c) => key(c.name) === wanted || c.aliases.some((a) => key(a) === wanted),
    );
  }

  suggestComponent(name: string): string | undefined {
    return closest(name, this.lint.names(), 0.5);
  }

  search(query: string, limit = 5): SearchHit[] {
    return searchComponents(this.searchIndex, query, limit);
  }

  /** Tokens, core ones first: scoped families (`sidebar-*`, `chart-*`) follow the rest, which an agent should reach for. */
  getTokens(
    filter: { category?: TokenCategory | undefined; query?: string | undefined } = {},
  ): Token[] {
    const query = filter.query?.toLowerCase();
    return this.model.tokens
      .filter(
        (t) =>
          (!filter.category || t.category === filter.category) &&
          (!query ||
            t.name.toLowerCase().includes(query) ||
            (t.description ?? '').toLowerCase().includes(query) ||
            t.usage.some((u) => u.toLowerCase().includes(query))),
      )
      .sort(
        (a, b) =>
          Number(this.tokenIndex.scopedFamilyOf(a) !== undefined) -
          Number(this.tokenIndex.scopedFamilyOf(b) !== undefined),
      );
  }

  /** Tokens a component's classes and CSS variables reference, e.g. `bg-primary` → `primary`. */
  relatedTokens(component: ComponentInfo): Token[] {
    const byUsage = new Map<string, Token>();
    for (const token of this.model.tokens) {
      for (const usage of token.usage) byUsage.set(usage, token);
    }
    const found = new Map<string, Token>();
    // The spacing unit backs every p-*/gap-* class; listing it says nothing.
    const isUnit = (token: Token) => token.category === 'spacing' && token.tailwind === '';
    for (const cls of component.classNames) {
      const { base } = parseUtility(cls);
      const token = byUsage.get(base) ?? matchUtility(base, this.model.tokens);
      if (token && !isUnit(token)) found.set(token.name, token);
    }
    for (const cssVar of component.cssVars) {
      const token = this.tokenIndex.byCssVar(cssVar);
      if (token) found.set(token.name, token);
    }
    return [...found.values()];
  }

  /**
   * What the rules could not check, when it matters: without components the
   * component rules find nothing, and without color tokens neither does
   * no-hardcoded-color, so a clean result says little. Undefined when both exist.
   * `where` names the projects it applies to, at a workspace root: `in apps/web`.
   */
  notice(where?: string): string | undefined {
    const components = this.model.components.length > 0;
    const colors = this.tokenIndex.has('color');
    if (components && colors) return undefined;
    const see = `See ${CONFIGURATION_DOCS}`;
    const at = where ? ` in ${where}` : '';
    if (!components && !colors) {
      const scale =
        this.tokenIndex.has('spacing') || this.tokenIndex.has('radius')
          ? ' and the spacing and radius rules'
          : '';
      return `No design system found${at} (no components or color tokens): only the accessibility rule${scale} ran. ${see}`;
    }
    return components
      ? `No color tokens found${at}: no-hardcoded-color did not run. ${see}`
      : `No design-system components found${at}: the component rules did not run. ${see}`;
  }

  check(code: string, filename?: string): CheckResult {
    return checkSource(code, this.lint, { filename, rules: rulesFor(this.config, filename) });
  }
}

const CONFIGURATION_DOCS = 'https://onsystem.vercel.app/docs/configuration';

/** `border-ring` → token `ring`, for color utilities a token's usage list does not spell out. */
function matchUtility(base: string, tokens: Token[]): Token | undefined {
  const key = COLOR_UTILITY.exec(base)?.[1];
  return key ? tokens.find((t) => t.category === 'color' && t.tailwind === key) : undefined;
}

// ─── Loading ────────────────────────────────────────────────────────────────

export interface LoadOptions {
  /** Use the on-disk extraction cache. Default true. */
  cache?: boolean;
  logger?: Logger;
  /** Previous TypeScript program, reused for incremental rebuilds. */
  oldProgram?: ts.Program | undefined;
}

interface ResolvedFiles {
  components: string[];
  tokens: { file: string; prefix?: string | undefined }[];
  docs: string[];
}

/**
 * Absolute paths matching `patterns` under the root. `node_modules` is skipped
 * even when `exclude` replaces the defaults, except by patterns that name it
 * (tokens published as a package).
 */
async function find(config: ResolvedConfig, patterns: string[]): Promise<string[]> {
  const options = { cwd: config.root, absolute: true, dot: false };
  const named = patterns.filter((p) => p.includes('node_modules'));
  const outside = patterns.filter((p) => !p.includes('node_modules') && p.startsWith('../'));
  const rest = patterns.filter((p) => !p.includes('node_modules') && !p.startsWith('../'));
  const found = await Promise.all([
    rest.length
      ? glob(rest, { ...options, ignore: unique(['**/node_modules/**', ...config.exclude]) })
      : [],
    named.length
      ? glob(named, {
          ...options,
          ignore: config.exclude.filter((e) => !e.includes('node_modules')),
        })
      : [],
    // A workspace package next to the root (`../../packages/ui/...`): `**/` ignore
    // patterns do not match paths that leave the cwd, so glob from the pattern's own
    // base, with the excludes that apply there.
    ...outside.map((pattern) => {
      const base = globBase(pattern);
      const prefix = `${base}/`;
      return glob(pattern.slice(prefix.length) || pattern, {
        ...options,
        cwd: path.resolve(config.root, base),
        ignore: unique([
          '**/node_modules/**',
          ...config.exclude.filter((e) => e.startsWith('**/')),
          ...config.exclude.filter((e) => e.startsWith(prefix)).map((e) => e.slice(prefix.length)),
        ]),
      });
    }),
  ]);
  return unique(found.flat()).sort();
}

/** The design system's own component files, as absolute paths. */
export function componentFiles(config: ResolvedConfig): Promise<string[]> {
  return find(config, config.components);
}

/** The token files a config finds, as absolute paths. */
export async function tokenFiles(config: ResolvedConfig): Promise<string[]> {
  return (await resolveFiles(config)).tokens.map((t) => t.file);
}

async function resolveFiles(config: ResolvedConfig): Promise<ResolvedFiles> {
  const components = await find(config, config.components);
  const docs = await find(config, config.docs);
  const tokens: ResolvedFiles['tokens'] = [];
  const seen = new Set<string>();
  for (const source of config.tokens) {
    for (const file of await find(config, [source.path])) {
      if (seen.has(file)) continue;
      seen.add(file);
      tokens.push({ file, prefix: source.prefix });
    }
  }
  return { components, tokens, docs };
}

/** Size and mtime of files, each read once per build. */
class FileStats {
  private readonly stats = new Map<string, Promise<string>>();

  constructor(private readonly root: string) {}

  of(files: readonly string[]): Promise<string[]> {
    return Promise.all(
      files.map((file) => {
        let stat = this.stats.get(file);
        if (!stat) {
          stat = fsp.stat(file).then(
            (s) => `${relativePath(this.root, file)}:${s.size}:${Math.round(s.mtimeMs)}`,
            () => `${file}:missing`,
          );
          this.stats.set(file, stat);
        }
        return stat;
      }),
    );
  }
}

/**
 * Everything that, when changed, invalidates the cached model: the tracked
 * files, `dependencies` (project files the components import and the tsconfig
 * chain, known after extraction), the lockfile and the config.
 */
async function cacheKey(
  config: ResolvedConfig,
  files: ResolvedFiles,
  dependencies: readonly string[],
  stats = new FileStats(config.root),
): Promise<string> {
  const extra = [
    'tsconfig.json',
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lock',
  ]
    .map((f) => path.join(config.root, f))
    .filter((f) => fs.existsSync(f));
  const all = unique([
    ...files.components,
    ...files.tokens.map((t) => t.file),
    ...files.docs,
    ...extra,
    ...dependencies,
  ]);
  const { rules: _rules, overrides: _overrides, ...relevant } = config;
  return createHash('sha256')
    .update(JSON.stringify({ version: VERSION, config: relevant, stats: await stats.of(all) }))
    .digest('hex');
}

function cacheFile(root: string): string {
  const nodeModules = path.join(root, 'node_modules');
  if (fs.existsSync(nodeModules)) {
    return path.join(nodeModules, '.cache', 'onsystem', 'model.json');
  }
  const id = createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), 'onsystem', `${id}.json`);
}

export interface BuildResult {
  model: DesignSystemModel;
  program?: ts.Program | undefined;
  /** Fingerprint of every input file; unchanged fingerprint means nothing to rebuild. */
  key?: string;
  /** Project files the model depends on beyond the tracked ones; pass them to `fingerprint`. */
  dependencies?: string[];
}

/**
 * Fingerprint of the files a config tracks (paths, sizes, mtimes), plus the
 * `dependencies` of a previous build, without extracting anything.
 */
export async function fingerprint(
  config: ResolvedConfig,
  dependencies: readonly string[] = [],
): Promise<string> {
  return cacheKey(config, await resolveFiles(config), dependencies);
}

export async function buildModel(
  config: ResolvedConfig,
  options: LoadOptions = {},
): Promise<BuildResult> {
  const logger = options.logger ?? silentLogger;
  const started = performance.now();
  const files = await resolveFiles(config);
  const useCache = options.cache !== false;
  const cachePath = cacheFile(config.root);

  let cached: { key?: string; dependencies?: string[]; model?: DesignSystemModel } | undefined;
  if (useCache && !options.oldProgram) {
    try {
      cached = JSON.parse(await fsp.readFile(cachePath, 'utf8')) as typeof cached;
    } catch {
      // No cache yet, or unreadable: extract.
    }
  }
  const known = Array.isArray(cached?.dependencies)
    ? cached.dependencies
    : options.oldProgram
      ? projectFiles(options.oldProgram)
      : [];
  // Stat every input known up front before extracting, so a file saved
  // during the build still changes the next fingerprint.
  const stats = new FileStats(config.root);
  const before = await cacheKey(config, files, known, stats);
  if (cached?.model?.version === 1 && cached.key === before && Array.isArray(cached.dependencies)) {
    cached.model.stats.fromCache = true;
    cached.model.stats.durationMs = Math.round(performance.now() - started);
    return { model: cached.model, key: before, dependencies: cached.dependencies };
  }

  const extracted = extractComponents({
    root: config.root,
    files: files.components,
    tsconfig: config.tsconfig,
    importPath: config.importPath,
    imports: config.imports,
    oldProgram: options.oldProgram,
  });
  const docs: ParsedDoc[] = [];
  const warnings = [...extracted.warnings];
  for (const file of files.docs) {
    try {
      docs.push(parseDoc(await fsp.readFile(file, 'utf8'), relativePath(config.root, file)));
    } catch (error) {
      warnings.push(`${relativePath(config.root, file)}: ${(error as Error).message}`);
    }
  }
  warnings.push(...attachDocs(extracted.components, docs));
  const tokens = await loadTokens(config.root, files.tokens);
  warnings.push(...tokens.warnings);
  // Published libraries the project uses (MUI), from their type declarations, after the
  // project's own components, and the tokens of the theme it gives them.
  const libraries = await loadLibraries(config);
  warnings.push(...libraries.warnings);
  tokens.tokens.push(...libraries.tokens);
  // Tailwind v3 maps color classes in its config rather than in `@theme`.
  const tailwind = config.tailwindConfig
    ? readTailwindColors(config.tailwindConfig, moduleResolver(config.root))
    : undefined;
  if (tailwind) applyTailwindColors(tokens.tokens, tailwind.colors);

  if (!files.components.length && !libraries.components.length) {
    warnings.push(
      `No component files matched ${config.components.join(', ')} under ${config.root}`,
    );
  }
  if (!files.tokens.length && !libraries.tokens.length) {
    warnings.push('No token files found; token rules are disabled.');
  }

  const model: DesignSystemModel = {
    version: 1,
    root: config.root,
    components: [...extracted.components, ...libraries.components],
    tokens: tokens.tokens,
    propSets: { ...extracted.propSets, ...libraries.propSets },
    exports: unique([...extracted.exports, ...libraries.exports]).sort(),
    warnings,
    sources: files.components.map((file) => relativePath(config.root, file)),
    stats: {
      files: {
        components: files.components.length,
        tokens: files.tokens.length,
        docs: files.docs.length,
      },
      durationMs: Math.round(performance.now() - started),
      fromCache: false,
    },
  };

  const dependencies = unique([
    ...extracted.dependencies,
    ...(tailwind?.files ?? []),
    ...libraries.dependencies,
  ]);
  const key = await cacheKey(config, files, dependencies, stats);
  if (useCache) {
    try {
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(cachePath, JSON.stringify({ key, dependencies, model }));
    } catch (error) {
      logger.warn(`could not write cache ${cachePath}: ${(error as Error).message}`);
    }
  }
  return { model, program: extracted.program, key, dependencies };
}

export async function loadDesignSystem(
  config: ResolvedConfig,
  options: LoadOptions = {},
): Promise<DesignSystem> {
  const { model } = await buildModel(config, options);
  return new DesignSystem(model, config);
}

// ─── Host: lazy load, reload on change ──────────────────────────────────────

/**
 * Owns the current DesignSystem. Loads lazily, rebuilds when watched files
 * change (reusing the previous TypeScript program), and never serves a
 * half-built model: callers get the in-flight build when one is running.
 */
export interface HostOptions extends LoadOptions {
  /** Builds the model; replaceable in tests. Defaults to `buildModel`. */
  build?: typeof buildModel;
  /**
   * Re-reads the config when its file changes while watching. Defaults to
   * loading the same config file; pass your own to keep overrides such as CLI flags.
   */
  loadConfig?: () => Promise<ResolvedConfig>;
}

/** Files zero-config detection reads in the root. */
const DETECTION_FILES = ['components.json', 'package.json'];

export class DesignSystemHost {
  private current?: Promise<DesignSystem>;
  private program?: ts.Program | undefined;
  private key?: string | undefined;
  private dependencies: string[] = [];
  /** Bumped by every build; only the latest may update the state above. */
  private generation = 0;
  private configChanged = false;
  private watchers: fs.FSWatcher[] = [];
  /** Recursively watched directories, and the config files watched through their directory. */
  private watchedRoots: string[] = [];
  private readonly watchedDirs = new Set<string>();
  private readonly watchedFiles = new Set<string>();
  private timer?: NodeJS.Timeout;
  private readonly listeners = new Set<(ds: DesignSystem) => void>();

  constructor(
    private config: ResolvedConfig,
    private readonly options: HostOptions = {},
  ) {}

  get(): Promise<DesignSystem> {
    this.current ??= this.build(false);
    return this.current;
  }

  reload(): Promise<DesignSystem> {
    const next = this.build(true);
    // Keep serving the previous model if the rebuild fails.
    const previous = this.current;
    this.current = next.catch(async (error: unknown) => {
      (this.options.logger ?? silentLogger).error(`reload failed: ${(error as Error).message}`);
      if (previous) return previous;
      throw error;
    });
    return this.current;
  }

  onChange(listener: (ds: DesignSystem) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Watches the component, token and docs locations, the config and the tsconfig chain. */
  watch(): void {
    if (this.watchers.length) return;
    const { root } = this.config;
    const dirs = new Set<string>();
    for (const pattern of [
      ...this.config.components,
      ...this.config.docs,
      ...this.config.tokens.map((t) => t.path),
    ]) {
      const base = path.resolve(root, globBase(pattern));
      // Outside the root is fine (a workspace package); an ancestor would watch the whole repository.
      const ancestor = base !== root && isInside(base, root);
      if (!ancestor && fs.existsSync(base)) dirs.add(base);
    }
    // Skip dirs nested inside another watched dir.
    this.watchedRoots = [...dirs].filter((d) => ![...dirs].some((o) => o !== d && isInside(o, d)));
    for (const dir of this.watchedRoots) {
      this.watchDirectory(dir, true, (file) => {
        if (file && /node_modules|\.git[\\/]/.test(file)) return;
        this.changed(file ? path.join(dir, file) : path.join(dir, '.'));
      });
    }
    this.watchConfigFiles();
  }

  /**
   * Watches the config file, the tsconfig and the tsconfigs it extends through
   * their directories: editors save by renaming a new file over the old one,
   * which ends a watch on the file. Called again after each build, so a new
   * `extends` target is picked up.
   */
  private watchConfigFiles(): void {
    const { root, configFile, tsconfig } = this.config;
    const files = [
      configFile,
      // Zero-config detection reads these; a change re-runs it.
      ...DETECTION_FILES.map((f) => path.join(root, f)),
      path.resolve(root, tsconfig ?? 'tsconfig.json'),
      // Installed bases (`@tsconfig/next`) change with the lockfile, which the fingerprint covers.
      ...readProjectConfig(root, tsconfig).configFiles.filter(isProjectFile),
    ]
      .filter((f): f is string => Boolean(f))
      .map((f) => path.resolve(f));
    for (const file of files) this.watchedFiles.add(file);
    for (const dir of unique(files.map((f) => path.dirname(f)))) {
      if (this.watchedDirs.has(dir) || this.watchedRoots.some((r) => isInside(r, dir))) continue;
      if (!fs.existsSync(dir)) continue;
      this.watchedDirs.add(dir);
      this.watchDirectory(dir, false, (file) => {
        const full = file ? path.join(dir, file) : undefined;
        if (full === undefined || this.watchedFiles.has(full)) this.changed(full);
      });
    }
  }

  private changed(file: string | undefined): void {
    // Without component globs in the config, the design system was detected from
    // components.json, package.json and tsconfig paths: re-read the config so detection runs again.
    const { root, configFile, detected } = this.config;
    if (
      file === undefined ||
      file === configFile ||
      (path.dirname(file) === root && DETECTION_FILES.includes(path.basename(file))) ||
      (detected !== undefined && this.watchedFiles.has(file))
    ) {
      this.configChanged = true;
    }
    this.schedule();
  }

  close(): void {
    clearTimeout(this.timer);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.watchedRoots = [];
    this.watchedDirs.clear();
    this.watchedFiles.clear();
  }

  private watchDirectory(
    dir: string,
    recursive: boolean,
    onChange: (file: string | null) => void,
  ): void {
    try {
      // Non-persistent: the process lives as long as stdin, not as long as the watchers.
      const watcher = fs.watch(dir, { recursive, persistent: false }, (_event, file) => {
        onChange(file);
      });
      watcher.on('error', () => undefined);
      this.watchers.push(watcher);
    } catch {
      // Recursive watch unsupported here; changes need a restart.
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.configChanged) {
        this.configChanged = false;
        void this.reloadConfig();
        return;
      }
      // Watched directories can hold unrelated files (a token file in app/ puts
      // every page under watch), so only rebuild when a tracked file changed.
      fingerprint(this.config, this.dependencies)
        .then(
          (key) => (key === this.key ? undefined : this.reload()),
          () => this.reload(),
        )
        .catch(() => undefined);
    }, 150);
  }

  /** Re-reads the config, re-watches what it points at and rebuilds. */
  private async reloadConfig(): Promise<void> {
    const { root, configFile } = this.config;
    const load = this.options.loadConfig ?? (() => loadConfig({ root, config: configFile }));
    try {
      this.config = await load();
    } catch (error) {
      (this.options.logger ?? silentLogger).error(
        `config reload failed: ${(error as Error).message}`,
      );
      return;
    }
    if (this.watchers.length) {
      this.close();
      this.watch();
    }
    await this.reload().catch(() => undefined);
  }

  private async build(incremental: boolean): Promise<DesignSystem> {
    const generation = ++this.generation;
    const config = this.config;
    const logger = this.options.logger ?? silentLogger;
    const build = this.options.build ?? buildModel;
    const { model, program, key, dependencies } = await build(config, {
      ...this.options,
      oldProgram: incremental ? this.program : undefined,
    });
    const ds = new DesignSystem(model, config);
    // A newer build started meanwhile: its result is the current one.
    if (generation !== this.generation) return ds;
    if (program) this.program = program;
    this.key = key;
    this.dependencies = dependencies ?? [];
    if (this.watchers.length) this.watchConfigFiles();
    const { stats } = model;
    logger.info(
      `${incremental ? 'reloaded' : 'loaded'} ${model.components.length} components, ${model.tokens.length} tokens` +
        ` from ${relativePath(process.cwd(), config.root) || '.'} in ${stats.durationMs}ms${stats.fromCache ? ' (cache)' : ''}`,
    );
    for (const warning of model.warnings) logger.warn(warning);
    if (incremental) for (const listener of this.listeners) listener(ds);
    return ds;
  }
}
