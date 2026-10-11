// Real-world regression corpus: public repositories pinned by commit, checked with the built CLI
// and compared with corpus/snapshot.json and the hand-labelled findings in corpus/labels.json.
//
//   node scripts/corpus.mjs                  fetch what is missing, check every run, compare
//   node scripts/corpus.mjs --update         the same, then record the new counts in the snapshot
//   node scripts/corpus.mjs fetch            only fetch
//   node scripts/corpus.mjs sample <run>     print unlabelled findings with their code, to label
//   node scripts/corpus.mjs eslint           lint the files each run checks through the ESLint
//                                            plugin, and compare its findings with check's
//
// It fails when the counts differ from the snapshot (pass --update to accept them, as with Jest
// snapshots), when a finding labelled TP is no longer reported, when one labelled FP comes
// back after a fix, or when a run from a monorepo root (`sameAs`) reports other files or
// findings for a project than the run from that project's folder. It ends with the
// false-positive rate of the labelled sample.
//
// The repositories are untrusted. They are fetched shallow and sparse (source, styles,
// manifests and docs only), never installed or built, and nothing in them runs: a run whose
// folder holds an onsystem config written in code (under its current name or the old
// design-system-mcp one) is refused, since loading it would execute it. An app whose design
// system is a published library (MUI) gets that library from npm, as its `install` in
// corpus/repos.json pins it (the library, its peers and React's types at exact versions),
// installed with --ignore-scripts into a cached folder beside the checkouts and linked as the
// app folder's node_modules; the repository's own package.json and lockfile are not used.
// Run `pnpm build` first.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  changeTable,
  compare,
  falsePositiveRate,
  findings,
  installs,
  invalidLabels,
  labelKey,
  outside,
  percent,
  random,
  rootDifferences,
  ruleCounts,
} from './corpus-lib.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CORPUS = path.join(ROOT, 'corpus');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const SNAPSHOT = path.join(CORPUS, 'snapshot.json');
const LABELS = path.join(CORPUS, 'labels.json');

/** What the CLI reads: sources, styles, manifests and docs. Images, fonts and binaries stay out. */
const EXTENSIONS = [
  'tsx',
  'ts',
  'jsx',
  'js',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'json',
  'css',
  'md',
  'mdx',
];
const MANIFESTS = [
  'package.json',
  'tsconfig*.json',
  'jsconfig*.json',
  'components.json',
  '.gitignore',
];
const CODE_CONFIGS = ['onsystem', 'design-system-mcp'].flatMap((name) =>
  ['ts', 'mts', 'js', 'mjs'].map((ext) => `${name}.config.${ext}`),
);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    update: { type: 'boolean', default: false },
    only: { type: 'string', multiple: true },
    dir: { type: 'string' },
    'per-rule': { type: 'string', default: '2' },
    seed: { type: 'string', default: '1' },
    rule: { type: 'string' },
    file: { type: 'string' },
    line: { type: 'string' },
    all: { type: 'boolean', default: false },
  },
});
const [command = 'check', ...args] = positionals;
const dir = path.resolve(
  values.dir ?? process.env.CORPUS_DIR ?? path.join(os.tmpdir(), 'onsystem-corpus'),
);

const corpus = readJson(path.join(CORPUS, 'repos.json'));
const runs = corpus.repos.flatMap((repo) => repo.runs.map((run) => ({ ...run, repo })));
const wanted = values.only?.length
  ? runs.filter((run) => values.only.includes(run.name) || values.only.includes(run.repo.name))
  : runs;
if (values.only?.length && !wanted.length)
  fail(`No run or repository named ${values.only.join(', ')}.`);

try {
  if (command === 'fetch') {
    fetchAll(wanted);
  } else if (command === 'check') {
    fetchAll(wanted);
    process.exitCode = check(wanted);
  } else if (command === 'eslint') {
    fetchAll(wanted);
    process.exitCode = await eslintParity(wanted);
  } else if (command === 'sample') {
    const run = runs.find((r) => r.name === args[0]);
    if (!run) fail(`sample: pass a run, one of ${runs.map((r) => r.name).join(', ')}.`);
    fetchAll([run]);
    sample(run);
  } else {
    fail(`Unknown command "${command}": check (default), fetch, eslint or sample <run>.`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

// ─── Fetching ─────────────────────────────────────────────────────────────────

function fetchAll(selected) {
  assertIsolated(dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const repo of new Set(selected.map((run) => run.repo))) {
    const target = path.join(dir, repo.name);
    const patterns = sparsePatterns(repo);
    const stamp = path.join(target, '.git', 'onsystem-corpus.json');
    const want = JSON.stringify({ url: repo.url, sha: repo.sha, patterns });
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) continue;
    // A checkout cached before the rename, under the stamp's old name: still current.
    const oldStamp = path.join(target, '.git', 'design-system-mcp-corpus.json');
    if (fs.existsSync(oldStamp) && fs.readFileSync(oldStamp, 'utf8') === want) {
      fs.writeFileSync(stamp, want);
      continue;
    }
    const started = performance.now();
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    git(target, ['init', '--quiet']);
    git(target, ['remote', 'add', 'origin', repo.url]);
    git(target, ['sparse-checkout', 'set', '--no-cone', '--stdin'], `${patterns.join('\n')}\n`);
    git(target, [
      'fetch',
      '--quiet',
      '--depth=1',
      '--filter=blob:none',
      '--no-tags',
      'origin',
      repo.sha,
    ]);
    git(target, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    fs.writeFileSync(stamp, want);
    console.error(`fetched ${repo.name}@${repo.sha.slice(0, 7)} in ${seconds(started)}`);
  }
  installAll(selected);
}

/**
 * The npm packages a repository's `install` pins (a component library's type declarations, its
 * peers and React's types), installed with --ignore-scripts into `.installs` beside the
 * checkouts, reused while the pins stay the same, and linked as the folder's node_modules.
 */
function installAll(selected) {
  for (const repo of new Set(selected.map((run) => run.repo))) {
    for (const install of installs(repo, dir)) {
      const stamp = path.join(install.dir, 'onsystem-install.json');
      const want = JSON.stringify({ manifest: install.manifest, args: install.args });
      const current =
        fs.existsSync(stamp) &&
        fs.readFileSync(stamp, 'utf8') === want &&
        fs.existsSync(path.join(install.dir, 'node_modules'));
      if (!current) {
        const started = performance.now();
        fs.rmSync(install.dir, { recursive: true, force: true });
        fs.mkdirSync(install.dir, { recursive: true });
        fs.writeFileSync(
          path.join(install.dir, 'package.json'),
          `${JSON.stringify(install.manifest, null, 2)}\n`,
        );
        const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', install.args, {
          cwd: install.dir,
          encoding: 'utf8',
          shell: process.platform === 'win32',
        });
        if (npm.status !== 0) {
          throw new Error(
            `npm ${install.args.join(' ')} failed in ${install.dir}:\n${npm.stderr || npm.error?.message || ''}`,
          );
        }
        fs.writeFileSync(stamp, want);
        const pins = Object.entries(install.manifest.dependencies)
          .map(([name, version]) => `${name}@${version}`)
          .join(', ');
        const where = install.folder === '.' ? repo.name : `${repo.name}/${install.folder}`;
        console.error(`installed ${pins} for ${where} in ${seconds(started)}`);
      }
      linkInstall(install);
    }
  }
}

/** The folder's node_modules in the checkout, pointing at what was installed for it. */
function linkInstall({ dir: installed, link }) {
  const target = path.join(installed, 'node_modules');
  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch {
    stat = undefined;
  }
  if (stat?.isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(target)) return;
  if (stat && !stat.isSymbolicLink()) {
    throw new Error(`${link} is in the checkout: the installed packages cannot be linked there.`);
  }
  if (stat) fs.unlinkSync(link);
  fs.symlinkSync(target, link, 'junction');
}

/** Root files, every manifest, and the source of the folders the runs need (or the whole tree). */
function sparsePatterns(repo) {
  const patterns = ['/*', '!/*/', ...MANIFESTS.map((name) => `/**/${name}`)];
  for (const folder of repo.paths ?? ['']) {
    const base = folder ? `/${folder.replace(/^\/+|\/+$/g, '')}` : '';
    for (const ext of EXTENSIONS) patterns.push(`${base}/**/*.${ext}`);
  }
  // Environment files never matter to the checks; keep them off disk.
  return [...patterns, '!/**/.env*'];
}

function git(cwd, gitArgs, input) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...gitArgs], {
    cwd,
    input,
    encoding: 'utf8',
    // Large files stored in LFS stay pointers: nothing here reads them.
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.status !== 0) {
    throw new Error(`git ${gitArgs.join(' ')} failed in ${cwd}:\n${result.stderr}`);
  }
  return result.stdout;
}

/**
 * The CLI looks upwards for node_modules and workspace roots, so a checkout inside a project
 * would pick up that project's packages and change the results.
 */
function assertIsolated(folder) {
  for (let current = path.dirname(folder); ; current = path.dirname(current)) {
    for (const name of ['package.json', 'pnpm-workspace.yaml', 'node_modules', 'tsconfig.json']) {
      if (fs.existsSync(path.join(current, name))) {
        throw new Error(
          `${folder} is inside ${current}, which has ${name}: the checks would read it. Pass --dir (or set CORPUS_DIR) to a folder outside any project.`,
        );
      }
    }
    if (current === path.dirname(current)) return;
  }
}

// ─── Checking ─────────────────────────────────────────────────────────────────

function check(selected) {
  if (!fs.existsSync(CLI))
    throw new Error(`${path.relative(ROOT, CLI)} is missing: run pnpm build first.`);
  const labels = readJson(LABELS);
  const problems = invalidLabels(labels);
  if (problems.length) throw new Error(`corpus/labels.json:\n  ${problems.join('\n  ')}`);
  const snapshot = fs.existsSync(SNAPSHOT) ? readJson(SNAPSHOT) : { runs: {}, labels: {} };

  const current = {};
  const found = [];
  const byRun = {};
  for (const run of selected) {
    const started = performance.now();
    const { inspect, results } = runOne(run);
    const runFindings = findings(run.name, results);
    found.push(...runFindings);
    byRun[run.name] = { files: results.map((r) => r.file), findings: runFindings };
    current[run.name] = {
      inspect,
      files: results.length,
      flagged: new Set(runFindings.map((f) => f.file)).size,
      rules: ruleCounts(runFindings),
      ...(run.sameAs ? { added: ruleCounts(outside(runFindings, Object.keys(run.sameAs))) } : {}),
    };
    const errors = runFindings.filter((f) => f.severity === 'error').length;
    console.log(
      `${run.name.padEnd(22)} ${String(results.length).padStart(5)} files  ${String(runFindings.length).padStart(5)} findings (${errors} errors, ${runFindings.filter((f) => f.fixable).length} fixable)  ${seconds(started)}`,
    );
  }

  const result = compare(snapshot, current, found, labels);
  const lines = [''];
  if (result.changes.length || result.changedRuns.length) {
    if (result.changes.length)
      lines.push(
        'Counts that differ from corpus/snapshot.json:',
        '',
        changeTable(result.changes),
        '',
      );
    for (const run of result.changedRuns) {
      const before = snapshot.runs[run];
      lines.push(
        before
          ? `${run}: inspect, or files checked or flagged, changed: ${JSON.stringify({ checked: before.files, flagged: before.flagged, ...before.inspect })} → ${JSON.stringify({ checked: current[run].files, flagged: current[run].flagged, ...current[run].inspect })}`
          : `${run}: new run`,
      );
    }
    if (result.changedRuns.length) lines.push('');
  } else {
    lines.push('Counts match corpus/snapshot.json.', '');
  }
  for (const { label, present } of result.labelChanges) {
    lines.push(
      `${present ? 'Back' : 'Gone'}: ${label.verdict} ${label.run} ${label.file}:${label.line} [${label.rule}] "${label.source}"`,
    );
  }
  if (result.labelChanges.length) lines.push('');

  // A run from a monorepo root must report each project's files as the run from its folder does.
  const rootFailures = [];
  for (const run of selected.filter((r) => r.sameAs)) {
    for (const [folder, other] of Object.entries(run.sameAs)) {
      if (!byRun[other]) {
        lines.push(`${run.name}: ${folder} not compared, since ${other} did not run.`);
        continue;
      }
      const differences = rootDifferences(byRun[run.name], folder, byRun[other]);
      if (differences.length) {
        rootFailures.push(
          `${run.name} differs from ${other} in ${folder}:\n    ${differences.slice(0, 10).join('\n    ')}${differences.length > 10 ? `\n    …and ${differences.length - 10} more` : ''}`,
        );
      } else {
        const { files, findings: same } = byRun[other];
        lines.push(
          `${run.name}: ${folder} reports what ${other} does, file for file (${files.length} files, ${same.length} findings).`,
        );
      }
    }
  }
  if (selected.some((r) => r.sameAs)) lines.push('');

  // A root run's findings in those folders are the other runs' findings again: the rate
  // counts only what it adds (`added`).
  const rate = falsePositiveRate(result.present, current);
  const tally = (p) => `${p.tp} TP, ${p.fp} FP, ${p.d} debatable`;
  const relevant = labels.filter((l) => l.run in current);
  lines.push(
    `Labelled sample: ${relevant.length} findings labelled, ${result.present.size} still reported.`,
    `  Random sample still reported: ${tally(rate.sample)}. False-positive rate ${percent(rate.sample.rate)} (errors only: ${percent(rate.sampleErrors.rate)}).`,
    `  Weighted by run and rule over all findings: ${percent(rate.estimate)} of findings are false positives (errors only: ${percent(rate.estimateErrors)}), from labels covering ${percent(rate.coverage)} of them.`,
    `  Audit picks still reported: ${tally(rate.audit)}.`,
    '  Random sample by rule:',
    ...rate.byRule.map(
      ({ rule, precision }) =>
        `    ${rule.padEnd(32)} ${tally(precision)}: ${percent(precision.rate)}`,
    ),
  );
  console.log(lines.join('\n'));

  if (result.labelFailures.length || rootFailures.length) {
    console.error(
      `\n${[...result.labelFailures, ...rootFailures].map((f) => `✗ ${f}`).join('\n')}`,
    );
    return 1;
  }
  const changed = result.changes.length > 0 || result.changedRuns.length > 0;
  if (values.update) {
    const merged = { ...snapshot.runs, ...current };
    const presence = { ...snapshot.labels };
    for (const label of relevant) presence[labelKey(label)] = result.present.has(label);
    // In the order of corpus/repos.json; runs and labels that no longer exist leave the snapshot.
    const next = {
      $comment:
        'Written by `node scripts/corpus.mjs --update`. Counts per run and rule; `labels` records which labelled findings were reported.',
      version: readJson(path.join(ROOT, 'package.json')).version,
      runs: Object.fromEntries(
        runs.filter((r) => merged[r.name]).map((r) => [r.name, merged[r.name]]),
      ),
      labels: Object.fromEntries(
        labels.map((l) => [labelKey(l), presence[labelKey(l)]]).filter(([, v]) => v !== undefined),
      ),
    };
    writeJson(SNAPSHOT, next);
    console.log(`\nWrote ${path.relative(ROOT, SNAPSHOT)}.`);
    return 0;
  }
  if (changed) {
    console.error(
      '\n✗ The counts differ from corpus/snapshot.json. If the change is intended, run `node scripts/corpus.mjs --update` and commit the snapshot.',
    );
    return 1;
  }
  const missing =
    selected.length === runs.length
      ? Object.keys(snapshot.runs).filter((name) => !current[name])
      : [];
  if (missing.length) {
    console.error(
      `\n✗ The snapshot has runs that no longer exist: ${missing.join(', ')}. Run with --update.`,
    );
    return 1;
  }
  return 0;
}

// ─── Through ESLint ───────────────────────────────────────────────────────────

/**
 * Each run again through the ESLint plugin (dist/eslint.js, `onsystem/eslint`): the files
 * `check` reported on, linted from the run's folder with the recommended config and
 * typescript-eslint's parser, must get the same findings, rule for rule and position for
 * position. The repository's own ESLint config is not read.
 */
async function eslintParity(selected) {
  const pluginFile = path.join(ROOT, 'dist', 'eslint.js');
  if (!fs.existsSync(pluginFile))
    throw new Error(`${path.relative(ROOT, pluginFile)} is missing: run pnpm build first.`);
  const { ESLint } = await import('eslint');
  const { default: tseslint } = await import('typescript-eslint');
  const { default: onsystem } = await import(pathToFileURL(pluginFile).href);
  // Findings that are not rules of the plugin: ESLint's parser reports syntax errors itself.
  const notInEslint = new Set(['syntax', 'suppression']);
  const failures = [];
  for (const run of selected) {
    const started = performance.now();
    const { results } = runOne(run);
    const cwd = path.join(dir, run.repo.name, run.cwd);
    const files = results.filter((r) => !r.skipped).map((r) => r.file);
    const key = (file, line, column, rule) => `${file}:${line}:${column} ${rule}`;
    const want = results.flatMap((r) =>
      r.diagnostics
        .filter((d) => !notInEslint.has(d.ruleId))
        .map((d) => key(r.file, d.line, d.column, d.ruleId)),
    );
    const eslint = new ESLint({
      cwd,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
        },
        {
          ...onsystem.configs.recommended,
          // `--include-tests` checks tests and stories, which the recommended config ignores.
          ...((run.args ?? []).includes('--include-tests') ? { ignores: [] } : {}),
          ...(run.config
            ? { settings: { onsystem: { root: '.', config: path.join(CORPUS, run.config) } } }
            : {}),
        },
      ],
    });
    const linted = await eslint.lintFiles(files);
    const got = [];
    const unparsed = [];
    for (const result of linted) {
      const file = path.relative(cwd, result.filePath).split(path.sep).join('/');
      for (const message of result.messages) {
        if (message.fatal) unparsed.push(`${file}: ${message.message}`);
        else if (message.ruleId?.startsWith('onsystem/'))
          got.push(
            key(file, message.line, message.column, message.ruleId.slice('onsystem/'.length)),
          );
      }
    }
    const missing = without(want, got);
    const extra = without(got, want);
    const same = !missing.length && !extra.length && !unparsed.length;
    console.log(
      `${run.name.padEnd(22)} ${String(files.length).padStart(5)} files  ${String(got.length).padStart(5)} findings  ${same ? 'same as check' : 'DIFFERENT'}  ${seconds(started)}`,
    );
    if (same) continue;
    const list = (title, items) =>
      items.length
        ? [
            `  ${title} (${items.length}):`,
            ...items.slice(0, 10).map((i) => `    ${i}`),
            ...(items.length > 10 ? [`    …and ${items.length - 10} more`] : []),
          ]
        : [];
    failures.push(
      [
        `${run.name}:`,
        ...list('reported by check, not by ESLint', missing),
        ...list('reported by ESLint, not by check', extra),
        ...list('not parsed by ESLint', unparsed),
      ].join('\n'),
    );
  }
  if (failures.length) {
    console.error(`\n${failures.map((f) => `✗ ${f}`).join('\n')}`);
    return 1;
  }
  console.log(`\nThe ESLint plugin reports what check reports in ${selected.length} runs.`);
  return 0;
}

/** The items of `a` that `b` does not account for, counting repeats. */
function without(a, b) {
  const left = new Map();
  for (const item of b) left.set(item, (left.get(item) ?? 0) + 1);
  return a.filter((item) => {
    const n = left.get(item) ?? 0;
    if (n) left.set(item, n - 1);
    return !n;
  });
}

/** `inspect` and `check --format json` with the built CLI, from the run's folder. */
function runOne(run) {
  const cwd = path.join(dir, run.repo.name, run.cwd);
  for (const name of CODE_CONFIGS) {
    if (fs.existsSync(path.join(cwd, name))) {
      throw new Error(
        `${run.name}: ${name} would run the repository's code. Give the run a JSON config in corpus/configs.`,
      );
    }
  }
  const config = run.config ? ['--root', '.', '--config', path.join(CORPUS, run.config)] : [];
  const inspect = cli(['inspect', '--no-cache', ...config], cwd);
  if (inspect.status !== 0)
    throw new Error(`${run.name}: inspect exited ${inspect.status}\n${inspect.stderr}`);
  const checked = cli(
    ['check', ...run.check, ...(run.args ?? []), '--format', 'json', '--no-cache', ...config],
    cwd,
  );
  if (checked.status !== 0 && checked.status !== 1) {
    throw new Error(`${run.name}: check exited ${checked.status}\n${checked.stderr}`);
  }
  const results = JSON.parse(checked.stdout);
  fs.mkdirSync(path.join(dir, '.results'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.results', `${run.name}.json`), checked.stdout);
  return { inspect: summarizeInspect(inspect.stdout), results };
}

function cli(cliArgs, cwd) {
  return spawnSync(process.execPath, [CLI, ...cliArgs], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

/** What `inspect` found, without the machine-specific root and timing. */
function summarizeInspect(text) {
  const lines = text.split('\n');
  // At a monorepo root: every project with what was found in it.
  if (lines.some((l) => l.startsWith('workspace '))) return summarizeWorkspace(lines);
  const field = (key) =>
    lines
      .find((l) => l.startsWith(`${key} `))
      ?.slice(key.length)
      .trim();
  const components = /^Components \((\d+) \+ (\d+) parts\)$/m.exec(text);
  const tokens = {};
  const at = lines.findIndex((l) => /^Tokens \(\d+\)$/.test(l));
  for (const line of at === -1 ? [] : lines.slice(at + 1)) {
    const match = /^ {2}(\S+)\s+(\d+)$/.exec(line);
    if (!match) break;
    tokens[match[1]] = Number(match[2]);
  }
  const warnings = lines.indexOf('Warnings');
  return {
    detected: field('detected') ?? null,
    files: field('files') ?? null,
    components: components ? Number(components[1]) : 0,
    parts: components ? Number(components[2]) : 0,
    tokens,
    warnings:
      warnings === -1 ? 0 : lines.slice(warnings + 1).filter((l) => l.startsWith('  ')).length,
  };
}

/** `inspect` at a monorepo root: the workspace line, and per project its counts. */
function summarizeWorkspace(lines) {
  const projects = {};
  let current;
  for (const line of lines) {
    // A project's folder, then its package name: `apps/web (@acme/web)`.
    const header = /^([^\s(]+)(?: \(.+\))?$/.exec(line);
    if (header && !/^(?:root|workspace|config)$/.test(header[1])) {
      current = projects[header[1]] = {
        detected: null,
        files: null,
        components: 0,
        parts: 0,
        tokens: {},
        warnings: 0,
      };
      continue;
    }
    const field = /^ {2}(\w+)\s+(.*)$/.exec(line);
    if (!current || !field) {
      if (!line.startsWith('  ')) current = undefined;
      continue;
    }
    const [, key, value] = field;
    if (key === 'detected') current.detected = value;
    else if (key === 'files') current.files = value;
    else if (key === 'components') {
      const counts = /^(\d+) \+ (\d+) parts/.exec(value);
      current.components = counts ? Number(counts[1]) : 0;
      current.parts = counts ? Number(counts[2]) : 0;
    } else if (key === 'tokens') {
      for (const pair of value === 'none' ? [] : value.split(', ')) {
        const [category, n] = pair.split(' ');
        current.tokens[category] = Number(n);
      }
    } else if (key === 'warnings') current.warnings = Number(/^\d+/.exec(value)?.[0] ?? 0);
  }
  const workspace = lines.find((l) => l.startsWith('workspace '))?.slice('workspace '.length);
  const others = /^Without a design system \((\d+)\)/m.exec(lines.join('\n'));
  return { workspace: workspace?.trim() ?? null, projects, others: others ? Number(others[1]) : 0 };
}

// ─── Sampling findings to label ───────────────────────────────────────────────

function sample(run) {
  const cached = path.join(dir, '.results', `${run.name}.json`);
  const fresh = fs.existsSync(cached) && fs.statSync(cached).mtimeMs > fs.statSync(CLI).mtimeMs;
  const results = fresh ? readJson(cached) : runOne(run).results;
  const labelled = new Set(readJson(LABELS).map((l) => l.fingerprint));
  let pool = findings(run.name, results).filter((f) => !labelled.has(f.fingerprint));
  // A root run's findings in its projects' folders are labelled through those runs.
  if (run.sameAs) pool = outside(pool, Object.keys(run.sameAs));
  if (values.rule) pool = pool.filter((f) => f.rule === values.rule);
  if (values.file) pool = pool.filter((f) => f.file.includes(values.file));
  if (values.line) pool = pool.filter((f) => f.line === Number(values.line));
  let picked = pool;
  if (!values.all && !values.file && !values.line) {
    const next = random(Number(values.seed));
    const perRule = Number(values['per-rule']);
    picked = [];
    for (const rule of [...new Set(pool.map((f) => f.rule))].sort()) {
      const of = pool.filter((f) => f.rule === rule);
      for (let i = 0; i < perRule && of.length; i++)
        picked.push(...of.splice(Math.floor(next() * of.length), 1));
    }
  }
  const root = path.join(dir, run.repo.name, run.cwd);
  for (const f of picked) {
    let code = [];
    try {
      code = fs.readFileSync(path.join(root, f.file), 'utf8').split('\n');
    } catch {
      // Shown without context.
    }
    console.log(`\n── ${f.file}:${f.line} [${f.rule}] ${f.severity}${f.fixable ? ' fixable' : ''}`);
    console.log(`   ${f.message}`);
    if (f.suggestion) console.log(`   suggestion: ${f.suggestion}`);
    for (let n = Math.max(1, f.line - 3); n <= Math.min(code.length, f.line + 3); n++) {
      console.log(
        `   ${n === f.line ? '>' : ' '}${String(n).padStart(5)}| ${code[n - 1]?.slice(0, 200)}`,
      );
    }
    const {
      message: _message,
      severity: _severity,
      fixable: _fixable,
      suggestion: _suggestion,
      ...fields
    } = f;
    console.log(`   ${JSON.stringify({ ...fields, verdict: '?', reason: '', sample: 'random' })}`);
  }
  console.error(`\n${picked.length} of ${pool.length} unlabelled findings in ${run.name}.`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** JSON the way Prettier would write it, so `pnpm format:check` stays green. */
function writeJson(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const prettier = path.join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'prettier.cmd' : 'prettier',
  );
  fs.writeFileSync(file, text);
  if (fs.existsSync(prettier))
    spawnSync(prettier, ['--write', file], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
}

function seconds(started) {
  return `${((performance.now() - started) / 1000).toFixed(1)}s`;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
