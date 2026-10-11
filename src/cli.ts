import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';

import type { Transport } from '@modelcontextprotocol/server';
import { escapePath, glob, type GlobOptions } from 'tinyglobby';

import {
  applyBaseline,
  BASELINE_FILE,
  countBaseline,
  LEGACY_BASELINE_FILE,
  readBaseline,
  updateBaseline,
  writeBaseline,
} from './baseline.js';
import {
  ConfigError,
  DEFAULT_TEST_EXCLUDE,
  DEFAULT_TEST_FOLDERS,
  rulesFor,
  type LoadConfigOptions,
  type ResolvedConfig,
} from './config.js';
import { componentFiles, loadDesignSystem, type DesignSystem } from './design-system.js';
import { explainProject, librariesLeftOut } from './explain.js';
import { init } from './init.js';
import { libraryAdapter, type LibrarySource } from './libraries/index.js';
import { formatDiagnostics, uncheckedNotice, type OutputFormat } from './lint/index.js';
import { serveStdio } from './server/stdio.js';
import type { CheckResult, DesignSystemModel, Diagnostic } from './types.js';
import { stderrLogger, silentLogger } from './util/log.js';
import { isInside, matchesGlob, relativePath, toPosix } from './util/paths.js';
import { plural, unique } from './util/strings.js';
import { NAME, VERSION } from './version.js';
import { loadTarget, type Project, type Workspace } from './workspace.js';
import { detectProject, type DetectionStep } from './detect.js';

const DOCS = 'https://onsystem.vercel.app/docs';

const HELP = `${NAME} ${VERSION}

Keeps coding agents on your React design system: checks UI code against your
real components, props, variants and tokens in a Claude Code hook, in CI with
check, and over MCP for any agent.

Usage
  onsystem [serve] [options]     Start the MCP server on stdio (default)
  onsystem check <paths...>      Lint files, folders or globs with the check_ui rules
                                 (for CI)
  onsystem inspect               Print what was extracted from the project
  onsystem init                  Write onsystem.config.json from what was found, run a
                                 dry-run check and offer a baseline
  onsystem help                  Show this help

At a monorepo root with no design system of its own, every command works per
project: each file is checked against the design system of the nearest folder
with a config, components.json or package.json, and inspect lists every project.

Options
  --root <dir>            Project root (default: the config file's directory, or cwd)
  --config <file>         Config file (default: onsystem.config.{json,ts,mjs,js})
  --components <glob>     Component sources, repeatable (default: found through
                          components.json or a workspace package, else
                          components/ui/**/*.{tsx,jsx} and src/components/ui/...)
  --tokens <file>         Token file (DTCG .json or CSS), repeatable
  --docs <glob>           Component docs (Markdown/MDX), repeatable
  --no-cache              Ignore the on-disk extraction cache
  --no-watch              serve: do not reload when files change
  --format <format>       check: pretty | json | github | sarif (default: pretty)
  --max-warnings <n>      check: exit 1 when there are more than n warnings
  --update-baseline       check: record the current findings as accepted, and exit 0
  --baseline <file>       check: baseline file (default: ${BASELINE_FILE} in the root,
                          used whenever it exists)
  --ignore-baseline       check: report every finding, baseline or not
  --include-design-system
                          check: also lint the design system's own component
                          files, which are skipped by default
  --include-tests         check: also lint tests and stories (*.test.tsx,
                          *.spec.tsx, *.stories.tsx) in folders and globs
  --quiet-without-design-system
                          check: print nothing and exit 0 when the project has no
                          design-system components and no config (tokens alone
                          are not a design system), for hooks installed across
                          many projects
  --require-design-system
                          check: exit 2 when no components or no color tokens
                          are found, so CI cannot pass by checking nothing
  --explain               inspect: every candidate zero config looked at and why
                          it was taken or not, the resolved config, unresolved
                          tokens, and components whose props did not resolve
  -y, --yes               init: write without asking, and record the baseline
  --force                 init: replace an existing config file
  -h, --help              Show this help
  -v, --version           Show the version

Examples
  npx -y ${NAME} inspect --explain
  npx -y ${NAME} init
  npx -y ${NAME} check . --format github --require-design-system
  npx -y ${NAME} check . --update-baseline   # adopt in an existing codebase

Docs: ${DOCS}
`;

export interface Io {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  color: boolean;
  /** Asks a question in the terminal (`init`); undefined when there is none to ask in. */
  prompt?: ((question: string) => Promise<string>) | undefined;
  /** Environment variables (GITHUB_WORKSPACE); the process's by default. */
  env?: Record<string, string | undefined> | undefined;
  /** Whether stdin is a terminal rather than an MCP client's pipe. */
  stdinIsTTY?: boolean | undefined;
  /** The transport `serve` uses instead of stdio, for tests. */
  transport?: Transport | undefined;
}

const defaultIo: Io = {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  color: process.stdout.isTTY && !process.env.NO_COLOR,
  prompt: process.stdin.isTTY && process.stdout.isTTY ? askInTerminal : undefined,
  stdinIsTTY: process.stdin.isTTY,
};

/** One question on the terminal, answered with a line. */
async function askInTerminal(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Runs the CLI. Resolves to an exit code; `serve` resolves once the server is listening. */
export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        root: { type: 'string' },
        config: { type: 'string' },
        components: { type: 'string', multiple: true },
        tokens: { type: 'string', multiple: true },
        docs: { type: 'string', multiple: true },
        cache: { type: 'boolean', default: true },
        watch: { type: 'boolean', default: true },
        format: { type: 'string', default: 'pretty' },
        'max-warnings': { type: 'string' },
        baseline: { type: 'string' },
        'update-baseline': { type: 'boolean', default: false },
        'ignore-baseline': { type: 'boolean', default: false },
        'quiet-without-design-system': { type: 'boolean', default: false },
        'include-design-system': { type: 'boolean' },
        'include-tests': { type: 'boolean', default: false },
        'require-design-system': { type: 'boolean', default: false },
        explain: { type: 'boolean', default: false },
        yes: { type: 'boolean', short: 'y', default: false },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\nRun ${NAME} --help for usage.`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(HELP);
    return 0;
  }
  if (values.version) {
    io.stdout(VERSION);
    return 0;
  }

  const [command = 'serve', ...rest] = positionals;
  if (command === 'help') {
    io.stdout(HELP);
    return 0;
  }
  // `--root ${workspaceFolder}` from a client that does not expand variables
  // would make a folder of that name the project.
  let root = values.root;
  if (root !== undefined && /\$\{[^}]*\}/.test(root)) {
    io.stderr(
      `--root "${root}" holds a variable the client did not expand; using the working directory instead${command === 'serve' ? ", or the client's roots when it holds no project" : ''}.`,
    );
    root = undefined;
  }
  const configOptions = {
    cwd: io.cwd,
    root,
    config: values.config,
    components: values.components,
    tokens: values.tokens,
    docs: values.docs,
    includeDesignSystem: values['include-design-system'],
  };

  try {
    switch (command) {
      case 'serve':
        // `npx onsystem` typed in a terminal waits on stdin for an agent that never comes: say so.
        // An MCP client's stdin is a pipe, and stdout belongs to the protocol.
        if (io.stdinIsTTY) {
          io.stderr(
            `${NAME} is an MCP server: it is waiting for an agent on stdin. Add it to your agent (${DOCS}/clients), or run \`npx -y ${NAME} inspect\` or \`npx -y ${NAME} check .\` here. Ctrl+C quits.`,
          );
        }
        await serveStdio({
          ...configOptions,
          cache: values.cache,
          watch: values.watch,
          logger: stderrLogger,
          ...(io.transport ? { transport: io.transport } : {}),
        });
        return 0;
      case 'check':
        return await check(rest, configOptions, values, io);
      case 'inspect':
        return await inspect(configOptions, values, io);
      case 'init':
        return await init(
          configOptions,
          { yes: values.yes, force: values.force, cache: values.cache },
          io,
          async (args, checkIo) => {
            const out: string[] = [];
            const err: string[] = [];
            const code = await main(args, {
              cwd: checkIo.cwd,
              color: false,
              stdout: (t) => out.push(t),
              stderr: (t) => err.push(t),
            });
            return { code, stdout: out.join('\n'), stderr: err.join('\n') };
          },
        );
      default:
        io.stderr(`Unknown command "${command}". Run ${NAME} --help for usage.`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      io.stderr(error.message);
      return 2;
    }
    throw error;
  }
}

interface CheckValues {
  cache: boolean;
  format: string;
  'max-warnings'?: string | undefined;
  baseline?: string | undefined;
  'update-baseline': boolean;
  'ignore-baseline': boolean;
  'quiet-without-design-system': boolean;
  'require-design-system': boolean;
  'include-tests': boolean;
}

/** The files a run checks, and what to say about the rest. */
interface Selection {
  files: string[];
  /** The design system each file is checked against. */
  designSystemOf: (file: string) => DesignSystem;
  /** The folder baseline keys are relative to, where the default baseline lives. */
  root: string;
  notes: string[];
  /** Rules that could not run, said once after the findings. */
  notices: string[];
  /** Design-system files left out, for the hint when nothing is left. */
  skipped: number;
  testsLeftOut: number;
}

async function check(
  patterns: string[],
  configOptions: LoadConfigOptions,
  values: CheckValues,
  io: Io,
): Promise<number> {
  if (values['quiet-without-design-system'] && values['require-design-system']) {
    io.stderr('check: pass --quiet-without-design-system or --require-design-system, not both');
    return 2;
  }
  if (!patterns.length) {
    io.stderr(`check: pass files, folders or globs, e.g. ${NAME} check .`);
    return 2;
  }
  const format = values.format as OutputFormat;
  if (!['pretty', 'json', 'github', 'sarif'].includes(format)) {
    io.stderr(`check: unknown --format "${values.format}" (pretty, json, github, sarif)`);
    return 2;
  }
  const maxWarnings =
    values['max-warnings'] === undefined ? undefined : Number(values['max-warnings']);
  if (maxWarnings !== undefined && !Number.isInteger(maxWarnings)) {
    io.stderr('check: --max-warnings expects an integer');
    return 2;
  }

  const target = await loadTarget(configOptions);
  warnDeprecated(target.config.deprecations, format, io);
  const selection = target.workspace
    ? await selectInWorkspace(target.workspace, patterns, values, format, io)
    : await selectInProject(target.config, patterns, values, format, io);
  if (typeof selection === 'number') return selection;
  const { files, notes } = selection;
  if (!files.length) {
    if (format === 'pretty') {
      const hints = [
        selection.skipped
          ? `Pass --include-design-system to check ${selection.skipped === 1 ? 'it' : 'them'}.`
          : '',
        selection.testsLeftOut ? 'Pass --include-tests to check tests and stories.' : '',
      ].filter(Boolean);
      io.stdout(`Nothing to check: ${notes.join('; ')}. ${hints.join(' ')}`.trimEnd());
    } else printNoResults(format, io);
    return 0;
  }

  const update = values['update-baseline'];
  const baselineFile = values.baseline
    ? path.resolve(io.cwd, values.baseline)
    : defaultBaseline(
        selection.root,
        values['ignore-baseline']
          ? undefined
          : (text) => {
              warnDeprecated([text], format, io);
            },
      );
  // Read before an update too: a baseline mangled by a merge conflict must not be overwritten silently.
  const baseline = values['ignore-baseline'] ? undefined : readBaseline(baselineFile);
  if (values.baseline && !update && !values['ignore-baseline'] && !baseline) {
    io.stderr(`check: baseline not found: ${displayPath(io.cwd, baselineFile)}`);
    return 2;
  }
  // Entries of rules that are off for a file (in `rules` or an override) are kept, not reported as fixed.
  const disabledFor = (file: string) => {
    const ds = selection.designSystemOf(file);
    return new Set(
      Object.entries(rulesFor(ds.config, relativePath(ds.root, file)))
        .filter(([, rule]) => rule.severity === 'off')
        .map(([id]) => id),
    );
  };
  const disabledByKey = new Map<string, Set<string>>();
  // Keys are relative to the real root, with the on-disk spelling of each path and
  // NFC names, so `APP/`, a linked root or a decomposed `café.tsx` find the same entry.
  const realRoot = fs.realpathSync.native(selection.root);
  const baselineKey = (file: string) =>
    relativePath(realRoot, fs.realpathSync.native(file)).normalize('NFC');

  const results: CheckResult[] = [];
  const checked = new Map<string, Diagnostic[]>();
  let baselined = 0;
  let fixed = 0;
  for (const file of files) {
    const code = await fsp.readFile(file, 'utf8');
    const ds = selection.designSystemOf(file);
    let result = ds.check(code, relativePath(ds.root, file));
    const key = baselineKey(file);
    const disabled = disabledFor(file);
    disabledByKey.set(key, disabled);
    if (update) checked.set(key, result.diagnostics);
    if (baseline && !update) {
      const match = applyBaseline(baseline, key, result, disabled);
      result = { ...match.result, baselined: match.baselined };
      baselined += match.baselined;
      fixed += match.fixed;
    }
    results.push({ ...result, file: relativePath(io.cwd, file) });
  }
  const elsewhere = results.filter((r) => r.skipped).length;
  if (elsewhere) {
    notes.push(`${plural(elsewhere, 'image or email file')} not checked`);
  }

  // Components the model leaves out were not checked: say so once, not in every file.
  const unchecked = uncheckedNotice(results);

  if (update) {
    const next = updateBaseline(
      baseline,
      checked,
      realRoot,
      (key) => disabledByKey.get(key) ?? new Set(),
    );
    writeBaseline(baselineFile, next);
    const counts = countBaseline(next);
    io.stdout(
      `Baseline: ${count(counts.findings, 'finding')} in ${count(counts.files, 'file')} → ${displayPath(io.cwd, baselineFile)}`,
    );
    for (const text of selection.notices) io.stderr(text);
    if (unchecked) io.stderr(unchecked);
    return 0;
  }

  const output = formatDiagnostics(
    format === 'json' ? results : results.filter((r) => !r.skipped),
    format,
    {
      color: io.color,
      uri:
        format === 'sarif' || format === 'github'
          ? repositoryPath(io.cwd, io.env ?? process.env)
          : undefined,
      baselined: baseline ? baselined : undefined,
      notes,
      fixedHint: fixed
        ? `${count(fixed, 'baseline finding')} no longer ${fixed === 1 ? 'occurs' : 'occur'}: run \`check ${patterns.map(shellQuote).join(' ')} --update-baseline\` to drop ${fixed === 1 ? 'it' : 'them'}.`
        : undefined,
    },
  );
  if (output) io.stdout(output);
  for (const text of [...selection.notices, unchecked]) {
    if (!text) continue;
    if (format === 'pretty') io.stdout(text);
    else if (format === 'github') io.stdout(`::warning title=${NAME}::${text}`);
    else io.stderr(text);
  }

  const errors = results.reduce((n, r) => n + r.errorCount, 0);
  const warnings = results.reduce((n, r) => n + r.warningCount, 0);
  if (errors > 0) return 1;
  if (maxWarnings !== undefined && warnings > maxWarnings) {
    if (format === 'pretty') io.stderr(`Too many warnings (${warnings}, max ${maxWarnings}).`);
    return 1;
  }
  return 0;
}

/** What `json` and `sarif` print when there is nothing to report on: `[]`, or a log without results. */
function printNoResults(format: OutputFormat, io: Io): void {
  if (format === 'json') io.stdout('[]');
  else if (format === 'sarif') io.stdout(formatDiagnostics([], 'sarif'));
}

/**
 * Maps a path relative to the working directory to one relative to the repository root, which
 * GitHub resolves workflow command annotations (`--format github`) and code scanning locations
 * (`--format sarif`) against, so `check` run from `apps/web` still reports
 * `apps/web/app/page.tsx`. The root is GITHUB_WORKSPACE or the git top-level, whichever is the
 * innermost folder holding the file: the git top-level outside Actions, GITHUB_WORKSPACE where
 * git is missing or refuses the checkout, and the repository checked out in a folder of the
 * workspace (`actions/checkout` with `path:`). A file under neither keeps its path relative to
 * the working directory.
 */
function repositoryPath(cwd: string, env: NonNullable<Io['env']>): (file: string) => string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  const top = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  const roots = [top, env.GITHUB_WORKSPACE ?? '']
    .filter(Boolean)
    .map((dir) => realPath(path.resolve(cwd, dir)))
    // The innermost first: where both hold the file, one is inside the other.
    .sort((a, b) => b.length - a.length);
  if (!roots.length) return toPosix;
  return (file) => {
    const absolute = realPath(path.resolve(cwd, file));
    const root = roots.find((dir) => isInside(dir, absolute));
    return root ? relativePath(root, absolute) : toPosix(file);
  };
}

/** Splits the patterns into files named outright and globs (a folder: every TSX/JSX file under it). */
function expandPatterns(patterns: string[], cwd: string): { named: string[]; globs: string[] } {
  // An existing path is taken literally, so `app/(marketing)` and `[slug]` are not
  // glob syntax. A directory means every TSX/JSX file under it.
  const named: string[] = [];
  const globs: string[] = [];
  for (const pattern of patterns) {
    const stat = fs.statSync(path.resolve(cwd, pattern), { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) {
      named.push(path.resolve(cwd, pattern));
      continue;
    }
    const literal = stat ? escapePath(toPosix(path.join(pattern, '.'))) : toPosix(pattern);
    globs.push(!stat ? literal : literal === '.' ? '**/*.{tsx,jsx}' : `${literal}/**/*.{tsx,jsx}`);
  }
  return { named, globs };
}

/** One project: the root's config and design system for every file. */
async function selectInProject(
  config: ResolvedConfig,
  patterns: string[],
  values: CheckValues,
  format: OutputFormat,
  io: Io,
): Promise<Selection | number> {
  const ds = await loadDesignSystem(config, { cache: values.cache, logger: silentLogger });
  // A file named outright is always checked; folders and globs leave out what the
  // config excludes (tests and stories by default) and what git ignores.
  const { named, globs } = expandPatterns(patterns, io.cwd);
  const options = { cwd: io.cwd, absolute: true, expandDirectories: false };
  const all = globs.length
    ? await findFiles(globs, { ...options, ignore: ['**/node_modules/**'] })
    : [];
  const excludes = config.exclude
    .filter((e) => !(values['include-tests'] && isTestPattern(e)))
    .map((e) => excludeFromCwd(e, config.root, io.cwd))
    .filter((e): e is string => e !== undefined);
  const kept = globs.length
    ? await findFiles(globs, { ...options, ignore: unique(['**/node_modules/**', ...excludes]) })
    : [];
  const ignored = gitIgnored(io.cwd, kept);
  const keptSet = new Set(kept);
  const leftOut = all.filter((file) => !keptSet.has(file));
  const left = {
    tests: leftOut.filter((file) => TEST_FILE.test(file)).length,
    excluded: leftOut.filter((file) => !TEST_FILE.test(file)).length,
    gitignored: ignored.size,
  };
  let files = unique([...named, ...kept.filter((file) => !ignored.has(file))]).sort();
  if (!files.length && !all.length) {
    io.stderr(`check: no files match ${patterns.join(' ')}`);
    return 2;
  }

  // A hook installed for every project should not lint React apps that have no
  // design system. Tokens alone are not one: Tailwind's default scale, or the three
  // stray custom properties of an app styled with CSS-in-JS (twenty), would block an
  // agent on rules that have nothing to compare against.
  if (values['quiet-without-design-system'] && !config.configFile && !ds.components.length) {
    printNoResults(format, io);
    return 0;
  }

  // A run that found no components or no color tokens passes without having
  // checked them: say so, and fail in CI when asked to, unless the components come from a
  // published library (MUI), whose colors may be in Sass: then it only says so.
  const notice = ds.notice();
  if (notice && values['require-design-system'] && !ds.hasDesignSystem()) {
    io.stderr(`check --require-design-system: ${notice}`);
    return 2;
  }

  // The design system's own files implement the scale and the primitives the
  // rules enforce (shadcn/ui's `p-[3px]`), so `check .` leaves them alone.
  let skipped = 0;
  if (!config.includeDesignSystem) {
    const own = new Set((await componentFiles(config)).map(realPath));
    const rest = files.filter((file) => !own.has(realPath(file)));
    skipped = files.length - rest.length;
    files = rest;
  }
  return {
    files,
    designSystemOf: () => ds,
    root: ds.root,
    notes: scopeNotes(skipped, left),
    notices: notice ? [notice] : [],
    skipped,
    testsLeftOut: left.tests,
  };
}

/**
 * A workspace root: each file is checked by the design system of its own project, the
 * nearest folder with a config, a components.json or a package.json, with that project's
 * config, exactly as `check` from that folder (and the Claude Code hook) would check it.
 */
async function selectInWorkspace(
  workspace: Workspace,
  patterns: string[],
  values: CheckValues,
  format: OutputFormat,
  io: Io,
): Promise<Selection | number> {
  const { named, globs } = expandPatterns(patterns, io.cwd);
  const all = globs.length
    ? await findFiles(globs, {
        cwd: io.cwd,
        absolute: true,
        expandDirectories: false,
        ignore: ['**/node_modules/**'],
      })
    : [];
  const projectOf = new Map<string, Project>();
  for (const file of unique([...named, ...all])) {
    projectOf.set(file, await workspace.projectFor(file));
  }
  const project = (file: string): Project => {
    const found = projectOf.get(file);
    if (!found) throw new Error(`No project for ${file}`);
    return found;
  };
  const designSystems = new Map<string, Promise<DesignSystem>>();
  const load = (p: Project) => {
    let ds = designSystems.get(p.root);
    if (!ds) {
      ds = loadDesignSystem(p.config, { cache: values.cache, logger: silentLogger });
      designSystems.set(p.root, ds);
    }
    return ds;
  };

  // Each project's `exclude` applies to its own files, relative to its folder.
  const leftOut = all.filter((file) => {
    const { root, config } = project(file);
    const relative = relativePath(root, file);
    return config.exclude.some(
      (e) => !(values['include-tests'] && isTestPattern(e)) && matchesGlob(relative, e),
    );
  });
  const leftOutSet = new Set(leftOut);
  const kept = all.filter((file) => !leftOutSet.has(file));
  const ignored = gitIgnored(io.cwd, kept);
  const left = {
    tests: leftOut.filter((file) => TEST_FILE.test(file)).length,
    excluded: leftOut.filter((file) => !TEST_FILE.test(file)).length,
    gitignored: ignored.size,
  };
  let files = unique([...named, ...kept.filter((file) => !ignored.has(file))]).sort();
  if (!files.length && !all.length) {
    io.stderr(`check: no files match ${patterns.join(' ')}`);
    return 2;
  }

  const loaded = new Map<string, DesignSystem>();
  for (const p of unique(files.map(project))) loaded.set(p.root, await load(p));
  const designSystemOf = (file: string): DesignSystem => {
    const ds = loaded.get(project(file).root);
    if (!ds) throw new Error(`No design system loaded for ${file}`);
    return ds;
  };

  // The hook's rule, per project: no config and no components, nothing to say.
  if (values['quiet-without-design-system']) {
    files = files.filter(
      (file) =>
        Boolean(project(file).config.configFile) || designSystemOf(file).components.length > 0,
    );
    if (!files.length) {
      printNoResults(format, io);
      return 0;
    }
  }

  // At a root, the gate is that some project has components and color tokens to check against,
  // or components from a published library (MUI).
  if (values['require-design-system']) {
    let complete = false;
    for (const p of workspace.projects) {
      if ((await load(p)).hasDesignSystem()) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      const packages = workspace.projects.length + workspace.others.length;
      io.stderr(
        `check --require-design-system: no workspace package has a design system with components and color tokens (${plural(packages, 'package')} looked at). See ${DOCS}/troubleshooting`,
      );
      return 2;
    }
  }

  // A project's design-system files implement its scale and primitives. Only a file's own
  // project counts: a package's files are checked as `check` in its folder checks them,
  // even when an app uses them as its design system.
  const own = new Map<string, Set<string>>();
  for (const p of unique(files.map(project))) {
    if (p.config.includeDesignSystem) continue;
    own.set(p.root, new Set((await componentFiles(p.config)).map(realPath)));
  }
  const rest = files.filter((file) => !own.get(project(file).root)?.has(realPath(file)));
  const skipped = files.length - rest.length;
  files = rest;

  // What could not run, once per kind of gap, naming the projects.
  const gaps = new Map<string, { ds: DesignSystem; dirs: string[] }>();
  for (const p of unique(files.map(project))) {
    const ds = loaded.get(p.root);
    const notice = ds?.notice();
    if (!ds || !notice) continue;
    const gap = gaps.get(notice) ?? { ds, dirs: [] };
    gap.dirs.push(p.dir);
    gaps.set(notice, gap);
  }
  const notices = [...gaps.values()].map(({ ds, dirs }) => ds.notice(listOf(dirs)) ?? '');
  const used = unique(files.map((file) => project(file).root)).length;
  return {
    files,
    designSystemOf,
    root: workspace.root,
    notes: [...(used > 1 ? [plural(used, 'project')] : []), ...scopeNotes(skipped, left)],
    notices: notices.filter(Boolean),
    skipped,
    testsLeftOut: left.tests,
  };
}

/** `apps/web`, `apps/web and packages/ui`, `a, b, c and 4 more`. */
function listOf(items: readonly string[], max = 3): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length <= max) return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

async function inspect(
  configOptions: LoadConfigOptions,
  values: { cache: boolean; format: string; explain: boolean },
  io: Io,
): Promise<number> {
  const target = await loadTarget(configOptions);
  const { config } = target;
  warnDeprecated(config.deprecations, 'pretty', io);
  if (target.workspace) return inspectWorkspace(target.workspace, values, io);
  const ds = await loadDesignSystem(config, { cache: values.cache, logger: silentLogger });
  const { model } = ds;
  if (values.format === 'json') {
    io.stdout(JSON.stringify(model, null, 2));
    return 0;
  }
  const lines: string[] = [
    `root     ${model.root}`,
    `config   ${config.configFile ? displayPath(io.cwd, config.configFile) : '(defaults)'}`,
    ...(config.detected ? [`detected ${config.detected}`] : []),
    ...describeLibraries(config, model, io.cwd).map((line) => `library  ${line}`),
    `files    ${plural(model.stats.files.components, 'component file')}, ${plural(model.stats.files.tokens, 'token file')}, ${plural(model.stats.files.docs, 'doc')}`,
    `time     ${model.stats.durationMs}ms${model.stats.fromCache ? ' (cache)' : ''}`,
    '',
    `Components (${ds.roots().length} + ${ds.components.length - ds.roots().length} parts)`,
  ];
  for (const c of ds.roots()) {
    const variants = c.variants.map((v) => `${v.name}[${v.values.length}]`).join(' ');
    const meta = [
      c.element ? `<${c.element}>` : '',
      plural(c.props.length, 'prop'),
      variants,
      c.subcomponents.length ? plural(c.subcomponents.length, 'part') : '',
      c.docs ? 'docs' : '',
      plural(c.examples.length, 'example'),
    ].filter(Boolean);
    lines.push(`  ${c.name.padEnd(18)} ${meta.join(' · ')}`);
  }
  lines.push('', `Tokens (${model.tokens.length})`);
  for (const [category, n] of tokenCounts(model)) lines.push(`  ${category.padEnd(18)} ${n}`);
  if (model.warnings.length) {
    lines.push('', 'Warnings');
    for (const warning of model.warnings) lines.push(`  ${warning}`);
  }
  if (values.explain) lines.push('', ...explainProject(ds, io.cwd));
  io.stdout(lines.join('\n'));
  return 0;
}

/**
 * `MUI (@mui/material 9.4.0): 149 components from its type declarations`, per library the
 * project depends on, including those the config's `libraries` leaves out.
 */
function describeLibraries(
  config: ResolvedConfig,
  model: DesignSystemModel,
  cwd: string,
): string[] {
  const name = (library: LibrarySource) =>
    `${libraryAdapter(library.package)?.title ?? library.package} (${library.package}${library.version ? ` ${library.version}` : ''})`;
  return [
    ...(config.libraries ?? []).map((library) => {
      if (!library.dir) return `${name(library)}: a dependency, but not installed`;
      const count = model.components.filter((c) => c.library === library.package).length;
      return `${name(library)}: ${plural(count, 'component')} from its type declarations`;
    }),
    ...(config.librariesOff ?? []).map(
      (library) => `${name(library)}: ${librariesLeftOut(config, cwd)}`,
    ),
  ];
}

function tokenCounts(model: DesignSystemModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of model.tokens) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  return counts;
}

/** Every project of a workspace root, with what was found in each, and the packages without one. */
async function inspectWorkspace(
  workspace: Workspace,
  values: { cache: boolean; format: string; explain: boolean },
  io: Io,
): Promise<number> {
  const loaded = [];
  for (const project of workspace.projects) {
    loaded.push({
      project,
      ds: await loadDesignSystem(project.config, { cache: values.cache, logger: silentLogger }),
    });
  }
  if (values.format === 'json') {
    io.stdout(
      JSON.stringify(
        {
          root: workspace.root,
          workspace: workspace.source,
          projects: loaded.map(({ project, ds }) => ({
            dir: project.dir,
            ...(project.name ? { name: project.name } : {}),
            ...(project.config.configFile
              ? { config: relativePath(workspace.root, project.config.configFile) }
              : {}),
            ...(project.config.detected ? { detected: project.config.detected } : {}),
            model: ds.model,
          })),
          others: workspace.others,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const packages = workspace.projects.length + workspace.others.length;
  const lines: string[] = [
    `root      ${workspace.root}`,
    `workspace ${plural(packages, 'package')} (${workspace.source}), ${plural(workspace.projects.length, 'project')} with a design system`,
    `config    ${workspace.configFile ? displayPath(io.cwd, workspace.configFile) : '(defaults)'}`,
  ];
  for (const { project, ds } of loaded) {
    const { model } = ds;
    const roots = ds.roots();
    const tokens = [...tokenCounts(model)].map(([category, n]) => `${category} ${n}`);
    const own =
      project.config.configFile && project.config.configFile !== workspace.configFile
        ? displayPath(workspace.root, project.config.configFile)
        : undefined;
    lines.push(
      '',
      `${project.dir}${project.name ? ` (${project.name})` : ''}`,
      ...(own ? [`  config     ${own}`] : []),
      ...(project.config.detected ? [`  detected   ${project.config.detected}`] : []),
      ...describeLibraries(project.config, model, io.cwd).map((line) => `  library    ${line}`),
      `  files      ${plural(model.stats.files.components, 'component file')}, ${plural(model.stats.files.tokens, 'token file')}, ${plural(model.stats.files.docs, 'doc')}`,
      `  components ${roots.length} + ${ds.components.length - roots.length} parts${roots.length ? `: ${listNames(roots.map((c) => c.name))}` : ''}`,
      `  tokens     ${tokens.length ? tokens.join(', ') : 'none'}`,
      ...(model.warnings.length
        ? [`  warnings   ${model.warnings.length}: ${model.warnings[0] ?? ''}`]
        : []),
    );
  }
  if (!loaded.length) {
    lines.push(
      '',
      `No workspace package has a design system that zero config finds. See ${DOCS}/troubleshooting`,
    );
  }
  if (workspace.others.length) {
    lines.push(
      '',
      `Without a design system (${workspace.others.length}): ${listNames(workspace.others)}`,
    );
  }
  lines.push(
    '',
    `Each file is checked by its project's design system. For one project's components, tokens and warnings: ${NAME} inspect --root <folder>`,
  );
  if (values.explain) lines.push('', ...explainWorkspace(workspace, loaded, io.cwd));
  io.stdout(lines.join('\n'));
  return 0;
}

/** Why the root is read as a monorepo, then each project's explanation. */
function explainWorkspace(
  workspace: Workspace,
  loaded: { project: Project; ds: DesignSystem }[],
  cwd: string,
): string[] {
  const { rootConfig } = workspace;
  const steps: DetectionStep[] = [];
  detectProject(rootConfig.root, rootConfig.tsconfig, steps);
  const lines = [
    `Why this is read as a monorepo root: it declares workspace packages (${workspace.source}), no config there sets components, and zero config finds no design system in the root itself:`,
    ...steps.map((s) => `  ${(s.accepted ? 'found' : 'no').padEnd(6)} ${s.candidate}: ${s.reason}`),
    `  no     ${rootConfig.components.join(', ')}: no file matches`,
  ];
  for (const { project, ds } of loaded) {
    lines.push(
      '',
      `${project.dir}${project.name ? ` (${project.name})` : ''}`,
      ...explainProject(ds, cwd, '  '),
    );
  }
  return lines;
}

/** `A, B, C` up to a dozen names, then `and 40 more`. */
function listNames(names: readonly string[], max = 12): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

/**
 * Says once what a file's old name means: on stderr, or as a workflow warning with
 * `--format github` so it shows on the run. Never on stdout otherwise, which JSON output owns.
 */
function warnDeprecated(messages: string[] | undefined, format: string, io: Io): void {
  for (const text of messages ?? []) {
    if (format === 'github') io.stdout(`::warning title=${NAME}::${text}`);
    else io.stderr(text);
  }
}

/**
 * The baseline in the root: `onsystem.baseline.json`, or one still under its name from
 * before the rename, which is read (and updated) where it is, with a notice to rename it.
 */
function defaultBaseline(root: string, warn: ((text: string) => void) | undefined): string {
  const current = path.join(root, BASELINE_FILE);
  const legacy = path.join(root, LEGACY_BASELINE_FILE);
  if (!fs.existsSync(legacy)) return current;
  if (fs.existsSync(current)) {
    warn?.(
      `${LEGACY_BASELINE_FILE} is ignored: ${BASELINE_FILE} is read instead. Delete ${LEGACY_BASELINE_FILE}.`,
    );
    return current;
  }
  warn?.(
    `${LEGACY_BASELINE_FILE} is the baseline's name from before design-system-mcp became onsystem. Rename it to ${BASELINE_FILE} (git mv ${LEGACY_BASELINE_FILE} ${BASELINE_FILE}); the old name still works for now.`,
  );
  return legacy;
}

/** Tests and stories, which `check` leaves out of folders and globs unless asked. */
const TEST_FILE = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$|[\\/]__(?:tests|stories|mocks)__[\\/]/;

/** The default patterns `--include-tests` lifts. */
function isTestPattern(pattern: string): boolean {
  return pattern === DEFAULT_TEST_EXCLUDE || pattern === DEFAULT_TEST_FOLDERS;
}

/** What a run left out, for the summary line: `5 design-system files skipped`. */
function scopeNotes(
  skipped: number,
  left: { tests: number; excluded: number; gitignored: number },
): string[] {
  return [
    skipped ? `${plural(skipped, 'design-system file')} skipped` : '',
    left.tests
      ? `${left.tests.toLocaleString('en-US')} ${left.tests === 1 ? 'test or story' : 'tests and stories'} left out`
      : '',
    left.excluded ? `${plural(left.excluded, 'excluded file')} left out` : '',
    left.gitignored ? `${plural(left.gitignored, 'file')} git ignores left out` : '',
  ].filter(Boolean);
}

/**
 * A config `exclude` pattern, relative to the root, as a pattern relative to the
 * working directory the globs run from; undefined when it only covers files
 * outside that directory. `**\/` patterns hold anywhere.
 */
function excludeFromCwd(pattern: string, root: string, cwd: string): string | undefined {
  if (pattern.startsWith('**/')) return pattern;
  const fromRoot = toPosix(path.relative(root, cwd));
  if (!fromRoot) return pattern;
  if (fromRoot.startsWith('..')) return toPosix(path.join(path.relative(cwd, root), pattern));
  return pattern.startsWith(`${fromRoot}/`) ? pattern.slice(fromRoot.length + 1) : undefined;
}

/**
 * Files a glob matches, as Node spells absolute paths (with backslashes on Windows, where
 * tinyglobby gives forward slashes), so they compare equal to `path.resolve` and git's.
 */
async function findFiles(globs: string[], options: GlobOptions): Promise<string[]> {
  return (await glob(globs, options)).map((file) => path.resolve(file));
}

/**
 * The files git ignores, through `git check-ignore`: nested .gitignore files,
 * `.git/info/exclude` and tracked-file exceptions, exactly as git reads them.
 * Outside a repository, or without git, nothing is ignored.
 */
function gitIgnored(cwd: string, files: readonly string[]): Set<string> {
  if (!files.length) return new Set();
  const result = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
    cwd,
    input: files.join('\0'),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  // 0: some are ignored, 1: none are, anything else: not a repository or no git.
  if (result.status !== 0 || typeof result.stdout !== 'string') return new Set();
  return new Set(
    result.stdout
      .split('\0')
      .filter(Boolean)
      .map((file) => path.resolve(cwd, file)),
  );
}

/** `1,307 findings`. */
function count(n: number, word: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? word : `${word}s`}`;
}

/** Quotes a pattern for the hint when the shell would expand or split it. */
function shellQuote(pattern: string): string {
  return /^[\w./@-]+$/.test(pattern) ? pattern : `"${pattern.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** The file's real path, so a linked root or a differently spelled path matches. */
function realPath(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

/** Relative to cwd when the file is below it, absolute otherwise. */
function displayPath(cwd: string, file: string): string {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
}
