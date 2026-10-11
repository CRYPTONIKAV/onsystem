// Generates the data the site renders, from the library itself, the demo design system in
// examples/shadcn-demo, the benchmark results in bench/agents and the README, so what the
// site shows is what the tool does at this commit. `pnpm build` and `pnpm dev` run it first.
// It needs the library built: `pnpm --dir .. build`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let lib;
try {
  lib = await import('onsystem');
} catch (error) {
  console.error(
    `Could not load onsystem (${error.message}).\nBuild the library first: pnpm --dir .. build`,
  );
  process.exit(1);
}
const { applyFixes, buildModel, DesignSystem, loadConfig, RULES, VERSION } = lib;

const site = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(site, '..');
const demoRoot = path.join(repo, 'examples/shadcn-demo');
const OUT = path.join(site, 'generated');
fs.mkdirSync(OUT, { recursive: true });

function write(name, data) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`generated/${name} ${(fs.statSync(file).size / 1024).toFixed(1)}kB`);
}

/** 1-based line and column → 0-based offset. */
function offsetOf(text, line, column) {
  let offset = 0;
  for (let i = 1; i < line; i++) offset = text.indexOf('\n', offset) + 1;
  return offset + column - 1;
}

// ─── The demo design system ────────────────────────────────────────────────

const config = await loadConfig({ root: demoRoot });
const { model } = await buildModel(config, { cache: false });
const ds = new DesignSystem(model, config);
assert.ok(ds.roots().length >= 5, 'the demo design system should have its components');

// ─── The loop: draft, check_ui, fix, clean ──────────────────────────────────

const demoFile = 'app/settings/danger-zone.tsx';
// The file starts with a comment explaining the demo; on the site the agent writes the file.
const draft = fs
  .readFileSync(path.join(demoRoot, demoFile), 'utf8')
  .replace(/^(?:\/\/[^\n]*\n)+/, '');
const result = ds.check(draft, demoFile);
assert.ok(result.errorCount > 0, 'the demo draft should have errors');

// What the agent writes after reading the findings: the mechanical fixes, plus the three
// it has to decide itself (a Badge variant, moving the inline style to classes, the import).
const fixed = applyFixes(draft, result.diagnostics)
  .replace('tone="warning"', 'variant="destructive"')
  .replace(
    ' style={{ color: "var(--muted-foreground)", marginTop: 6 }}',
    ' className="mt-1.5 text-muted-foreground"',
  )
  .replace(
    'import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"',
    'import {\n  Card,\n  CardContent,\n  CardDescription,\n  CardHeader,\n  CardTitle,\n} from "@/components/ui/card"',
  );
const after = ds.check(fixed, demoFile);
assert.equal(
  after.diagnostics.length,
  0,
  `the corrected demo should be clean, got ${JSON.stringify(after.diagnostics, null, 2)}`,
);

/** The short "found → fix" form the transcript shows for each finding. */
function shortForm(d) {
  let found = d.source;
  let fix = d.suggestion ?? '';
  if (d.ruleId === 'icon-button-accessible-name') found = '<Button size="icon">';
  else if (d.ruleId === 'prefer-design-system-component') found = `<${d.source}>`;
  else if (d.ruleId === 'no-unknown-component') found = `<${d.source}>`;
  else if (d.ruleId === 'no-unknown-prop') found = `${d.source}=`;
  else if (d.ruleId === 'no-unknown-variant') found = `variant=${d.source}`;
  else if (d.ruleId === 'no-hardcoded-spacing' && /^-?\d+$/.test(d.source))
    found = `marginTop: ${d.source}`;
  else if (d.source.startsWith('#')) found = `color: "${d.source}"`;
  if (d.ruleId === 'no-unknown-prop') fix = `${fix}=`;
  return { found, fix };
}

const findings = result.diagnostics.map((d) => ({
  ruleId: d.ruleId,
  severity: d.severity,
  message: d.message,
  line: d.line,
  column: d.column,
  start: offsetOf(draft, d.line, d.column),
  end: offsetOf(draft, d.endLine, d.endColumn),
  source: d.source,
  suggestion: d.suggestion ?? null,
  fixable: Boolean(d.fix?.length),
  ...shortForm(d),
}));

/**
 * Spans of `next` that are new relative to `prev`, from a longest-common-subsequence diff of
 * word tokens. Class names, tags and quoted values count as words, so a changed class lights
 * up on its own rather than the whole attribute.
 */
function changedSpans(prev, next) {
  const words = (text) =>
    [...text.matchAll(/"?[\w\-.#[\]:%@][\w\-.#[\]:%/@]*"?|[^\s\w]/g)].map((m) => ({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    }));
  const a = words(prev);
  const b = words(next);
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i].text === b[j].text
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const changed = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i].text === b[j].text) {
      i++;
      j++;
    } else if (i < a.length && table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      changed.push(b[j]);
      j++;
    }
  }
  const spans = [];
  for (const word of changed) {
    const last = spans.at(-1);
    // Join neighbours on the same line separated only by spaces or `=`.
    if (last && /^[ \t=]*$/.test(next.slice(last.end, word.start))) last.end = word.end;
    else spans.push({ start: word.start, end: word.end });
  }
  return (
    spans
      // A lone comma or bracket is noise next to the real change.
      .filter((s) => /\w/.test(next.slice(s.start, s.end)))
      // A quote that belongs to an unchanged neighbour (`"rounded-sm` in `"rounded-sm bg-muted px-3"`).
      .map((s) => {
        const text = next.slice(s.start, s.end);
        if ((text.match(/"/g) ?? []).length !== 1) return s;
        return text.startsWith('"')
          ? { ...s, start: s.start + 1 }
          : text.endsWith('"')
            ? { ...s, end: s.end - 1 }
            : s;
      })
  );
}

/** Median wall time of `run`, in milliseconds. */
function median(run, times = 200) {
  const samples = [];
  for (let i = 0; i < times; i++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((x, y) => x - y);
  return samples[Math.floor(times / 2)];
}
const checkMs = median(() => ds.check(draft, demoFile));

write('demo.json', {
  prompt: 'Add a danger-zone card to the workspace settings page',
  file: demoFile,
  draft,
  fixed,
  findings,
  errorCount: result.errorCount,
  warningCount: result.warningCount,
  changes: changedSpans(draft, fixed),
  checkMs: Math.round(checkMs * 100) / 100,
});

// ─── The playground: the model to check against, and the drafts ────────────

// The route handler builds a DesignSystem from this JSON and never touches the filesystem.
// Paths from this machine are left out: the model only needs paths relative to the root.
const PLAYGROUND_FILE = 'app/playground.tsx';
const { root: _root, configFile: _configFile, tailwindConfig: _tailwind, ...portable } = config;
const playgroundConfig = { ...portable, root: '/demo' };
const playgroundModel = {
  ...model,
  root: '/demo',
  warnings: [],
  stats: { ...model.stats, durationMs: 0 },
};
const portableDs = new DesignSystem(
  JSON.parse(JSON.stringify(playgroundModel)),
  JSON.parse(JSON.stringify(playgroundConfig)),
);
// The JSON round trip must not change a single finding.
assert.deepEqual(
  portableDs.check(draft, demoFile).diagnostics,
  result.diagnostics,
  'the serialised model should check exactly like the loaded one',
);
write('playground-model.json', {
  file: PLAYGROUND_FILE,
  model: playgroundModel,
  config: playgroundConfig,
});

const { deleteDialog, snippet } = await import('./presets.mjs');
const demoSource = (file) =>
  fs.readFileSync(path.join(demoRoot, file), 'utf8').replace(/^(?:\/\/[^\n]*\n)+/, '');
const presets = [
  {
    id: 'danger-zone',
    label: 'Agent draft',
    file: 'danger-zone.tsx',
    description: 'The settings card from the demo above: one problem per rule.',
    code: draft,
  },
  {
    id: 'delete-dialog',
    label: 'Dialog',
    file: 'delete-dialog.tsx',
    description: 'A confirmation dialog with props, parts and values from other libraries.',
    code: deleteDialog,
  },
  {
    id: 'snippet',
    label: 'Snippet',
    file: 'snippet.tsx',
    description: 'A fragment with no imports, the way agents often check code before saving it.',
    code: snippet,
  },
  {
    id: 'members',
    label: 'Clean',
    file: 'members.tsx',
    description: 'UI written against the design system: nothing to report.',
    code: demoSource('app/settings/members.tsx'),
  },
].map((preset) => ({ ...preset, result: portableDs.check(preset.code, PLAYGROUND_FILE) }));
for (const preset of presets) {
  const { errorCount, warningCount, diagnostics } = preset.result;
  const clean = preset.id === 'members';
  assert.ok(
    clean
      ? diagnostics.length === 0
      : errorCount > 0 && !diagnostics.some((d) => d.ruleId === 'syntax'),
    `preset ${preset.id}: unexpected result ${JSON.stringify(diagnostics.map((d) => d.ruleId))}`,
  );
  console.log(`  preset ${preset.id}: ${errorCount} errors, ${warningCount} warnings`);
}
write('playground.json', { file: PLAYGROUND_FILE, presets });

// ─── What the agent sees: the real MCP server over stdio ────────────────────

const pkg = JSON.parse(
  fs.readFileSync(fileURLToPath(import.meta.resolve('onsystem/package.json')), 'utf8'),
);
const cli = path.join(
  path.dirname(fileURLToPath(import.meta.resolve('onsystem/package.json'))),
  pkg.bin.onsystem,
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, '--root', demoRoot, '--no-watch', '--no-cache'],
  stderr: 'pipe',
});
const client = new Client({ name: 'onsystem-site', version: VERSION });
await client.connect(transport);
const text = (r) => r.content.find((c) => c.type === 'text')?.text ?? '';
const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
const { resourceTemplates } = await client.listResourceTemplates();
const { resources } = await client.listResources();
const samples = [];
for (const [name, args] of [
  ['search_components', { query: 'confirm a destructive action', limit: 3 }],
  ['get_component', { name: 'Badge' }],
  ['get_tokens', { category: 'color', query: 'destructive' }],
  [
    'check_ui',
    { code: '<Button variant="primary" className="bg-blue-600 px-[18px]">Save</Button>' },
  ],
]) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, `${name} failed: ${text(response)}`);
  samples.push({ tool: name, args, output: text(response) });
}
await client.close();

write('tools.json', {
  version: VERSION,
  tools: tools.map((t) => ({ name: t.name, title: t.title ?? t.name, description: t.description })),
  prompts: prompts.map((p) => ({ name: p.name, title: p.title, description: p.description })),
  resources: [
    ...resources.filter((r) => !r.uri.startsWith('ds://components/')).map((r) => r.uri),
    ...resourceTemplates.map((r) => r.uriTemplate),
  ],
  samples,
});

// ─── The demo design system, as the agent sees it ───────────────────────────

write('design-system.json', {
  components: ds.roots().map((c) => ({
    name: c.name,
    description: c.description ?? null,
    element: c.element ?? null,
    variants: Object.fromEntries(c.variants.map((v) => [v.name, v.values])),
    parts: c.subcomponents,
  })),
  tokens: Object.fromEntries(
    ['color', 'spacing', 'radius', 'typography', 'shadow', 'other'].map((category) => [
      category,
      ds.tokens.filter((t) => t.category === category).length,
    ]),
  ),
});

// ─── The benchmark ──────────────────────────────────────────────────────────

const bench = path.join(repo, 'bench/agents');
const tasks = JSON.parse(fs.readFileSync(path.join(bench, 'tasks.json'), 'utf8'));
const MODEL_NAMES = { 'haiku-4-5': 'Claude Haiku 4.5', 'opus-5': 'Claude Opus 5' };
const models = fs
  .readdirSync(path.join(bench, 'results'))
  .filter((dir) => fs.statSync(path.join(bench, 'results', dir)).isDirectory())
  .sort()
  .map((dir) => {
    const runs = fs
      .readdirSync(path.join(bench, 'results', dir))
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(bench, 'results', dir, f), 'utf8')));
    const summary = (condition) => {
      const list = runs.filter((r) => r.condition === condition);
      assert.equal(list.length, tasks.length, `${dir}/${condition} should have a run per task`);
      const sum = (key) => list.reduce((total, r) => total + r[key], 0);
      return {
        runs: list.length,
        clean: list.filter((r) => r.errors === 0).length,
        errors: sum('errors'),
        warnings: sum('warnings'),
        cost: Math.round(sum('cost') * 100) / 100,
        seconds: Math.round(sum('seconds') / list.length),
        turns: Math.round((sum('turns') / list.length) * 10) / 10,
        toolCalls: Math.round((sum('mcpCalls') / list.length) * 10) / 10,
        hookBlocks: sum('hookBlocks'),
      };
    };
    const base = summary('base');
    const plugin = summary('plugin');
    return {
      id: dir,
      name: MODEL_NAMES[dir] ?? dir,
      base,
      plugin,
      costDelta: Math.round(((plugin.cost - base.cost) / base.cost) * 100),
      tasks: tasks.map((task) => {
        const of = (condition) => {
          const run = runs.find((r) => r.task === task.id && r.condition === condition);
          return { errors: run.errors, byRule: run.byRule };
        };
        return { id: task.id, base: of('base'), plugin: of('plugin') };
      }),
    };
  });
write('bench.json', {
  project: 'vercel/ai-chatbot',
  tasks: tasks.map((t) => ({ id: t.id, file: t.file, prompt: t.prompt })),
  models,
});

// ─── The corpus: how often the rules are wrong ──────────────────────────────

// The numbers `pnpm corpus` prints, from the files it writes: the hand labels in the random
// sample that the snapshot says are still reported, and the findings per run and rule.
const corpusDir = path.join(repo, 'corpus');
const readCorpus = (file) => JSON.parse(fs.readFileSync(path.join(corpusDir, file), 'utf8'));
const corpusSnapshot = readCorpus('snapshot.json');
// As labelKey in scripts/corpus-lib.ts: a label tied to a suggestion is keyed with it.
const labelKey = (label) =>
  label.suggestion === undefined
    ? label.fingerprint
    : `${label.fingerprint}@${label.suggestion ?? 'none'}`;
const sample = readCorpus('labels.json').filter(
  (label) => label.sample === 'random' && corpusSnapshot.labels[labelKey(label)] === true,
);
const corpusRepos = readCorpus('repos.json').repos;
// A run with a config of its own checks the same files as another run: not counted twice.
const rechecks = new Set(
  corpusRepos.flatMap((repo) => repo.runs.filter((run) => run.config).map((run) => run.name)),
);
let corpusFindings = 0;
let corpusCovered = 0;
let corpusWeighted = 0;
// A run from a monorepo root counts only the findings it adds to the runs from its projects.
for (const [run, { rules, added }] of Object.entries(corpusSnapshot.runs)) {
  for (const [rule, counts] of Object.entries(added ?? rules)) {
    const n = counts.errors + counts.warnings;
    if (!rechecks.has(run)) corpusFindings += n;
    const stratum = sample.filter((label) => label.run === run && label.rule === rule);
    if (!stratum.length) continue;
    corpusCovered += n;
    corpusWeighted +=
      (n * stratum.filter((label) => label.verdict === 'FP').length) / stratum.length;
  }
}
assert.ok(sample.length > 0 && corpusCovered > 0, 'the corpus should have a labelled sample');
// The baseline example: midday's dashboard, as the corpus checks it (`check src`).
const midday = corpusSnapshot.runs['midday-dashboard'];
assert.ok(midday?.flagged !== undefined, 'the corpus snapshot should have midday-dashboard');
write('corpus.json', {
  repos: corpusRepos.length,
  runs: Object.keys(corpusSnapshot.runs).length,
  /** Distinct findings: a root run counts what it adds, a run with a config not at all. */
  findings: corpusFindings,
  sample: sample.length,
  truePositives: sample.filter((label) => label.verdict === 'TP').length,
  falsePositives: sample.filter((label) => label.verdict === 'FP').length,
  debatable: sample.filter((label) => label.verdict === 'D').length,
  /** False positives as a share of all findings, weighted by each run's and rule's share. */
  weightedRate: corpusWeighted / corpusCovered,
  baseline: {
    findings: Object.values(midday.rules).reduce((n, c) => n + c.errors + c.warnings, 0),
    flagged: midday.flagged,
    files: midday.files,
  },
});

// ─── From the docs and the README ───────────────────────────────────────────

// The docs pages live in docs/*.md, readable on GitHub and rendered here; the README keeps the
// install links. Links between docs files (`ci.md#…`) are mapped to site pages when rendered.
const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
/** A docs/ file without its `# title`: the site's page has its own. */
function doc(name) {
  const text = fs.readFileSync(path.join(repo, 'docs', name), 'utf8');
  assert.ok(/^# .+\n/.test(text), `docs/${name} should start with a # title`);
  return text.replace(/^# .*\n+/, '').trim();
}

/**
 * The body of a `## heading` section of `markdown`, up to the next heading of the same or a
 * higher level. Lines inside code fences are not headings (`# Baseline: …` in a shell block).
 */
function section(markdown, heading, where) {
  const lines = markdown.split('\n');
  const level = heading.match(/^#+/)[0].length;
  const start = lines.indexOf(heading);
  assert.ok(start !== -1, `section "${heading}" not found in ${where}`);
  let fenced = false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fenced = !fenced;
    const depth = fenced ? 0 : (/^(#+) /.exec(lines[i])?.[1].length ?? 0);
    if (depth && depth <= level) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

/** Rows of the first Markdown table in `markdown`, as arrays of cell Markdown. */
function table(markdown) {
  const lines = markdown.split('\n').filter((l) => l.startsWith('|'));
  const cells = (line) =>
    line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
  const [header, , ...rows] = lines;
  assert.ok(header && rows.length, 'expected a Markdown table');
  return { header: cells(header), rows: rows.map(cells) };
}

/** The target of the link with this text: a README badge (`[![alt](…)](…)`) or a plain link. */
function linkTo(markdown, text, where) {
  const match =
    new RegExp(`\\[!\\[${text}\\]\\([^)]*\\)\\]\\(([^)]+)\\)`).exec(markdown) ??
    new RegExp(`\\[${text}\\]\\(([^)]+)\\)`).exec(markdown);
  assert.ok(match, `link "${text}" not found in ${where}`);
  return match[1];
}

/** The first fenced code block in `markdown`. */
function codeBlock(markdown) {
  const match = /```\w*\n([\s\S]*?)\n```/.exec(markdown);
  assert.ok(match, 'expected a code block');
  return match[1];
}

const docs = {
  quickstart: doc('quickstart.md'),
  plugin: doc('plugin.md'),
  ci: doc('ci.md'),
  requiredCheck: doc('required-check.md'),
  clients: doc('clients.md'),
  configuration: doc('configuration.md'),
  tokens: doc('tokens.md'),
  eslint: doc('eslint.md'),
  rules: doc('rules.md'),
  tools: doc('tools.md'),
  troubleshooting: doc('troubleshooting.md'),
  howItWorks: doc('how-it-works.md'),
  migrating: doc('migrating.md'),
};

// The one-click installs: the README's badges, and the same links in the setup guide.
const install = {
  cursor: linkTo(readme, 'Install in Cursor', 'README.md'),
  vscode: linkTo(readme, 'Install in VS Code', 'README.md'),
  plugin: codeBlock(docs.plugin),
};
for (const [text, href] of [
  ['Install in Cursor', install.cursor],
  ['Install in VS Code', install.vscode],
]) {
  assert.equal(
    linkTo(docs.clients, text, 'docs/clients.md'),
    href,
    `${text}: README and docs differ`,
  );
}
assert.ok(readme.includes(install.plugin), 'the README should show the plugin install commands');

const realCodebases = section(docs.howItWorks, '## On real codebases', 'docs/how-it-works.md');
write('readme.json', {
  install,
  realCodebases: {
    intro: realCodebases.split('\n\n')[0],
    ...table(realCodebases),
  },
  engines: JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).engines,
});

// ─── The rules catalog ──────────────────────────────────────────────────────

const { ruleDocs } = await import('./rule-docs.mjs');
const ruleTable = table(docs.rules);
const EXAMPLE_FILE = 'app/example.tsx';
const rules = RULES.map((rule) => {
  const docs = ruleDocs[rule.id];
  assert.ok(docs, `scripts/rule-docs.mjs has no entry for ${rule.id}`);
  const row = ruleTable.rows.find((r) => r[0] === `\`${rule.id}\``);
  assert.ok(row, `the docs/rules.md table has no row for ${rule.id}`);
  const before = ds.check(docs.bad, EXAMPLE_FILE);
  const own = before.diagnostics.filter((d) => d.ruleId === rule.id);
  assert.ok(own.length > 0, `the ${rule.id} example should trip it`);
  assert.equal(
    own.length,
    before.diagnostics.length,
    `the ${rule.id} example should trip only that rule: ${JSON.stringify(before.diagnostics.map((d) => d.ruleId))}`,
  );
  const good = docs.good ?? applyFixes(docs.bad, own);
  const after = ds.check(good, EXAMPLE_FILE);
  assert.equal(
    after.diagnostics.length,
    0,
    `the fixed ${rule.id} example should be clean: ${JSON.stringify(after.diagnostics)}`,
  );
  return {
    id: rule.id,
    description: rule.description,
    severity: config.rules[rule.id].severity,
    catches: row[2],
    suggests: row[3],
    why: docs.why,
    allow: docs.allow ?? null,
    bad: docs.bad,
    good,
    fixedBy: docs.good ? 'hand' : 'rule',
    changes: changedSpans(docs.bad, good),
    findings: own.map((d) => ({
      severity: d.severity,
      message: d.message,
      line: d.line,
      column: d.column,
      start: offsetOf(docs.bad, d.line, d.column),
      end: offsetOf(docs.bad, d.endLine, d.endColumn),
      suggestion: d.suggestion ?? null,
      fixable: Boolean(d.fix?.length),
    })),
  };
});
write('rules.json', {
  version: VERSION,
  rules,
  // How colors, spacing and radius fixes are chosen, and how to suppress a finding.
  details: section(docs.rules, '## How fixes are chosen', 'docs/rules.md'),
  suppression: section(docs.rules, '## Suppressing findings', 'docs/rules.md'),
});

// ─── Docs ───────────────────────────────────────────────────────────────────

const skill = fs
  .readFileSync(path.join(repo, 'plugins/onsystem/skills/onsystem/SKILL.md'), 'utf8')
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .trim();
write('docs.json', {
  ...docs,
  // The FAQ and the landing page link to it; the rules page shows the rules.
  limits: section(docs.howItWorks, '## Limits', 'docs/how-it-works.md'),
  skill,
});
