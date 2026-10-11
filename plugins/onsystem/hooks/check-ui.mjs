#!/usr/bin/env node
// Claude Code PostToolUse hook: after Claude writes or edits a .tsx/.jsx file,
// run `onsystem check` on it and hand the findings back.
//
// - Errors: exit 2 with the findings on stderr, which Claude Code shows to
//   Claude so it fixes them before moving on. For an Edit, only findings on
//   the lines it changed are listed; older ones are counted, not pushed.
// - Warnings only: exit 0 with `additionalContext`, a non-blocking note.
// - Clean file, other files, or a project without design-system components
//   (tokens alone are not one): exit 0 silently.
// - The CLI cannot run (npx fails, a min-release-age policy, offline, a private
//   registry, a broken config): exit 0 with a one-time notice, once per session
//   and project, on stderr and as a `systemMessage` the user sees. It never
//   blocks the edit, and Claude is not asked to fix it.
//
// The CLI is the project's own install when there is one, else npx, pinned to
// this plugin's release. Both run through Node directly, never a shell, so paths
// are passed as they are. It reads the project's files and writes nothing but a
// marker in the system temp folder for the one-time notice; the only network
// access is npx fetching the package from the npm registry.
// ONSYSTEM_BIN points at another CLI script, for tests. DESIGN_SYSTEM_MCP_BIN,
// its name before the rename, still works, with a one-time notice.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const PACKAGE = 'onsystem';
// The exact release this plugin runs; scripts/sync-versions.mjs sets it with each release.
const VERSION = '0.5.1';
const UI_FILE = /\.[jt]sx$/i;
const MAX_FINDINGS = 30;
// Where the CLI looks for the design system: the nearest of these marks the project. `check`
// from a monorepo root finds each file's project the same way (src/workspace.ts).
const PROJECT_FILES = [
  'onsystem.config.json',
  'onsystem.config.ts',
  'onsystem.config.mts',
  'onsystem.config.js',
  'onsystem.config.mjs',
  // The names from before the rename, which the CLI still reads.
  'design-system-mcp.config.json',
  'design-system-mcp.config.ts',
  'design-system-mcp.config.mts',
  'design-system-mcp.config.js',
  'design-system-mcp.config.mjs',
  'components.json',
  'package.json',
  // An Nx project without a package.json of its own.
  'project.json',
];
const BIN = process.env.ONSYSTEM_BIN || process.env.DESIGN_SYSTEM_MCP_BIN || undefined;

const input = await readInput();
const filePath = input?.tool_input?.file_path;
if (typeof filePath !== 'string' || !UI_FILE.test(filePath)) process.exit(0);

const sessionDir =
  typeof input.cwd === 'string' && input.cwd
    ? input.cwd
    : (process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const file = path.resolve(sessionDir, filePath);
const root = projectRoot(path.dirname(file)) ?? sessionDir;
// Forward slashes, as the CLI prints paths, on Windows too.
const name = path.relative(root, file).split(path.sep).join('/') || file;
if (!process.env.ONSYSTEM_BIN && process.env.DESIGN_SYSTEM_MCP_BIN) {
  // On stderr, the debug log, and only when the hook passes: a blocked edit's stderr is Claude's.
  const text = 'DESIGN_SYSTEM_MCP_BIN is the name ONSYSTEM_BIN had before the rename: rename it.';
  process.on('exit', (code) => {
    if (code === 0) once('env-notice', text, () => fs.writeSync(2, `${text}\n`));
  });
}
const cli = resolveCli(root);
if (!cli) cannotRun('npx was not found next to this Node.js.');

const run = spawnSync(
  cli[0],
  [...cli.slice(1), 'check', file, '--format', 'json', '--quiet-without-design-system'],
  {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 55_000,
    windowsHide: true,
  },
);
// 0: clean or warnings, 1: errors. Anything else (a config error, npx unable to
// fetch the package) is not Claude's to fix: tell the user once, and move on.
if (run.error || (run.status !== 0 && run.status !== 1)) cannotRun(failure(run));

let results;
try {
  results = JSON.parse(run.stdout);
} catch {
  // npx exits 1 too when it cannot install the package, with npm's error on stderr.
  cannotRun(failure(run));
}
if (!Array.isArray(results)) process.exit(0);
const diagnostics = results.flatMap((r) => (Array.isArray(r?.diagnostics) ? r.diagnostics : []));
if (!diagnostics.length) process.exit(0);

// An Edit is held to the lines it touched; a Write wrote the whole file.
const touched = touchedLines(input);
const inScope = touched
  ? diagnostics.filter((d) => touched.some(([from, to]) => d.line >= from && d.line <= to))
  : diagnostics;
const elsewhere = diagnostics.length - inScope.length;
if (!inScope.length) process.exit(0);

// Errors first, so a long list of warnings never hides one.
const ordered = [
  ...inScope.filter((d) => d.severity === 'error'),
  ...inScope.filter((d) => d.severity !== 'error'),
];
const errors = ordered.filter((d) => d.severity === 'error').length;
const shown = ordered.slice(0, MAX_FINDINGS).map(describe);
if (ordered.length > shown.length) {
  shown.push(
    `…and ${ordered.length - shown.length} more. Run check_ui on the file to see them all.`,
  );
}
const note = elsewhere
  ? `\n(${elsewhere} other ${elsewhere === 1 ? 'finding' : 'findings'} elsewhere in the file predate this edit; leave them unless asked.)`
  : '';

if (errors) {
  process.stderr.write(
    `${name}: this change breaks the project's design system (onsystem check). ` +
      'Fix these errors before moving on; get_component and get_tokens list the valid props, variants and tokens.\n\n' +
      `${shown.join('\n')}${note}\n`,
  );
  process.exit(2);
}
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `onsystem check: warnings in ${name}. Prefer the suggested scale values and tokens.\n${shown.join('\n')}${note}`,
    },
  }),
);
process.exit(0);

/**
 * Says once per session and project that edits are not being checked, and why,
 * on stderr (the debug log) and as a `systemMessage` the user sees. Never blocks.
 */
function cannotRun(reason) {
  const usesNpx = !BIN && !installedCli(root);
  const advice = /config|tsconfig|Token file/i.test(reason)
    ? 'Fix the config, or run `onsystem inspect` to see the problem.'
    : usesNpx
      ? `Install it in the project to run it without npx: npm install --save-dev ${PACKAGE}`
      : `Run \`onsystem check ${name}\` to see why.`;
  const text = `onsystem could not check ${name}, so edits are not being checked against the design system: ${reason} ${advice}`;
  once('hook-notice', text, () => {
    process.stderr.write(`${text}\n`);
    process.stdout.write(JSON.stringify({ systemMessage: text }));
  });
  process.exit(0);
}

/** Runs `say` once per session and project (per day without a session), through a marker file. */
function once(kind, text, say) {
  const day = new Date().toISOString().slice(0, 10);
  const key = createHash('sha256')
    .update(`${input.session_id ?? day}\0${root}`)
    .digest('hex')
    .slice(0, 16);
  const marker = path.join(os.tmpdir(), 'onsystem', `${kind}-${key}`);
  if (fs.existsSync(marker)) return;
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${text}\n`);
  } catch {
    // Without a marker the notice may repeat; it still never blocks.
  }
  say();
}

/** Why the CLI did not run, in a sentence, without anything that could hold a credential. */
function failure(result) {
  if (result.error?.code === 'ENOENT') return 'npx was not found.';
  if (result.error?.code === 'ETIMEDOUT' || result.signal)
    return 'it did not finish within 55 seconds.';
  const stderr = String(result.stderr ?? '');
  if (/ENOVERSIONS|No versions available/i.test(stderr)) {
    return `npm found no version of ${PACKAGE}@${VERSION} it may install (ENOVERSIONS), as with a min-release-age policy.`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|network/i.test(stderr)) {
    return 'npm could not reach the registry (offline?).';
  }
  if (/E401|E403|ENEEDAUTH|E404|404 Not Found/.test(stderr)) {
    return 'the npm registry refused the package (a private registry?).';
  }
  const line = stderr
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return `it exited with code ${result.status}.`;
  // URLs can carry credentials (`https://user:token@registry`); keep only what is safe to show.
  const safe = line.replace(/\/\/[^/\s@]+@/g, '//').replace(/(_authToken|token)=\S+/gi, '$1=…');
  return `${safe.length > 200 ? `${safe.slice(0, 199)}…` : safe}${/[.!?]$/.test(safe) ? '' : '.'}`;
}

function describe(d) {
  return `${d.line}:${d.column} ${d.severity} [${d.ruleId}] ${d.message}`;
}

/** The nearest folder at or above `dir` with a design-system config, components.json, package.json or project.json. */
function projectRoot(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (PROJECT_FILES.some((f) => fs.existsSync(path.join(current, f)))) return current;
    if (current === path.dirname(current)) return undefined;
  }
}

/** [node, script, ...args] for the CLI: an override, the project's install, or npx. */
function resolveCli(dir) {
  if (BIN) return [process.execPath, BIN];
  const installed = installedCli(dir);
  if (installed) return [process.execPath, installed];
  // npm's own npx script, run with this Node: no shell, so no quoting or .cmd issues on Windows.
  const nodeDir = path.dirname(process.execPath);
  const npx = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ].find((f) => fs.existsSync(f));
  if (npx) return [process.execPath, npx, '--yes', `${PACKAGE}@${VERSION}`];
  return process.platform === 'win32' ? undefined : ['npx', '--yes', `${PACKAGE}@${VERSION}`];
}

/** The CLI script of the project's own install, if it has one. */
function installedCli(dir) {
  try {
    const manifest = createRequire(path.join(dir, 'package.json')).resolve(
      `${PACKAGE}/package.json`,
    );
    const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const script = typeof bin === 'string' ? bin : bin?.[PACKAGE];
    return script ? path.resolve(path.dirname(manifest), script) : undefined;
  } catch {
    // Not installed in the project: npx runs it.
    return undefined;
  }
}

/** 1-based line ranges an Edit's new text occupies now, or undefined to check the whole file. */
function touchedLines(payload) {
  if (payload.tool_name !== 'Edit') return undefined;
  const replacement = payload.tool_input?.new_string;
  if (typeof replacement !== 'string' || !replacement.trim()) return undefined;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const ranges = [];
  for (let at = text.indexOf(replacement); at !== -1; at = text.indexOf(replacement, at + 1)) {
    const from = text.slice(0, at).split('\n').length;
    ranges.push([from, from + replacement.split('\n').length - 1]);
  }
  return ranges.length ? ranges : undefined;
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}
