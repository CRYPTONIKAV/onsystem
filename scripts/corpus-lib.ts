// The comparison behind scripts/corpus.mjs: fingerprints, per-rule counts, the snapshot diff,
// label checks and the false-positive rate. Pure functions, so test/corpus.test.ts covers them.
import { createHash } from 'node:crypto';
import path from 'node:path';

export interface CheckDiagnostic {
  ruleId: string;
  severity: 'error' | 'warning';
  message: string;
  line: number;
  source: string;
  suggestion?: string;
  fix?: unknown[];
}

export interface CheckFileResult {
  file: string;
  diagnostics: CheckDiagnostic[];
}

/** One finding, keyed by what does not move when unrelated code changes: no line, no message. */
export interface Finding {
  fingerprint: string;
  run: string;
  file: string;
  line: number;
  rule: string;
  source: string;
  /** 1-based, among the findings of this rule with this source text in this file. */
  occurrence: number;
  severity: 'error' | 'warning';
  suggestion: string | null;
  fixable: boolean;
  message: string;
}

export type Verdict = 'TP' | 'FP' | 'D';

export interface Label {
  fingerprint: string;
  run: string;
  file: string;
  /** Where it was when labelled; informational. */
  line: number;
  rule: string;
  source: string;
  occurrence: number;
  /** When set, the label applies only while this is the suggestion (`null`: no suggestion). */
  suggestion?: string | null;
  verdict: Verdict;
  reason: string;
  /** `audit`: picked by hand as suspicious. `random`: drawn at random, so it estimates the rate. */
  sample: 'audit' | 'random';
}

export interface RuleCounts {
  errors: number;
  warnings: number;
  fixes: number;
}

export interface RunSnapshot {
  inspect: Record<string, unknown>;
  files: number;
  /** Files with at least one finding: what a baseline of the run would hold. */
  flagged?: number;
  rules: Record<string, RuleCounts>;
  /**
   * A run from a monorepo root: its findings outside the folders other runs check from
   * inside (`sameAs`), which it reports again. The false-positive rate counts only these.
   */
  added?: Record<string, RuleCounts>;
}

export interface Snapshot {
  runs: Record<string, RunSnapshot>;
  /** Whether each label matched a finding at the last update, by `labelKey`. */
  labels: Record<string, boolean>;
}

export function fingerprint(
  run: string,
  file: string,
  rule: string,
  source: string,
  occurrence: number,
): string {
  return createHash('sha256')
    .update([run, file, rule, source, String(occurrence)].join('\0'))
    .digest('hex')
    .slice(0, 12);
}

export function findings(run: string, results: CheckFileResult[]): Finding[] {
  const out: Finding[] = [];
  for (const result of results) {
    const seen = new Map<string, number>();
    for (const d of result.diagnostics) {
      const key = `${d.ruleId}\0${d.source}`;
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);
      out.push({
        fingerprint: fingerprint(run, result.file, d.ruleId, d.source, occurrence),
        run,
        file: result.file,
        line: d.line,
        rule: d.ruleId,
        source: d.source,
        occurrence,
        severity: d.severity,
        suggestion: d.suggestion ?? null,
        fixable: Boolean(d.fix?.length),
        message: d.message,
      });
    }
  }
  return out;
}

/** Errors, warnings and fixable findings per rule, rules sorted by id. */
export function ruleCounts(found: readonly Finding[]): Record<string, RuleCounts> {
  const rules = new Map<string, RuleCounts>();
  for (const f of found) {
    const counts = rules.get(f.rule) ?? { errors: 0, warnings: 0, fixes: 0 };
    if (f.severity === 'error') counts.errors++;
    else counts.warnings++;
    if (f.fixable) counts.fixes++;
    rules.set(f.rule, counts);
  }
  return Object.fromEntries([...rules].sort(([a], [b]) => a.localeCompare(b)));
}

export function labelKey(label: Pick<Label, 'fingerprint' | 'suggestion'>): string {
  return label.suggestion === undefined
    ? label.fingerprint
    : `${label.fingerprint}@${label.suggestion ?? 'none'}`;
}

export function matches(label: Label, finding: Finding): boolean {
  return (
    label.fingerprint === finding.fingerprint &&
    (label.suggestion === undefined || label.suggestion === finding.suggestion)
  );
}

/** Problems with the label file itself: a fingerprint that does not match its fields, duplicates. */
export function invalidLabels(labels: readonly Label[]): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const label of labels) {
    const expected = fingerprint(label.run, label.file, label.rule, label.source, label.occurrence);
    if (expected !== label.fingerprint) {
      problems.push(
        `${label.fingerprint}: the fingerprint of ${label.run} ${label.file} ${label.rule} "${label.source}" #${label.occurrence} is ${expected}`,
      );
    }
    if (!['TP', 'FP', 'D'].includes(label.verdict)) {
      problems.push(`${label.fingerprint}: verdict must be TP, FP or D`);
    }
    const key = labelKey(label);
    if (keys.has(key)) problems.push(`${key}: labelled twice`);
    keys.add(key);
  }
  return problems;
}

export interface CountChange {
  run: string;
  rule: string;
  before: RuleCounts | undefined;
  after: RuleCounts | undefined;
}

export interface Comparison {
  /** Rule counts that differ from the snapshot. */
  changes: CountChange[];
  /** Runs whose inspect summary, or number of checked or flagged files, differs. */
  changedRuns: string[];
  /** Failures no `--update` accepts: a TP that went away, an FP that came back, a stale label. */
  labelFailures: string[];
  /** Labelled findings that went away or came back, as expected or not. */
  labelChanges: { label: Label; present: boolean }[];
  present: Map<Label, Finding>;
}

/** Compares a run of the corpus with the snapshot, for the runs in `current`. */
export function compare(
  snapshot: Snapshot,
  current: Record<string, RunSnapshot>,
  found: readonly Finding[],
  labels: readonly Label[],
): Comparison {
  const changes: CountChange[] = [];
  const changedRuns: string[] = [];
  for (const [run, now] of Object.entries(current)) {
    const before = snapshot.runs[run];
    if (
      !before ||
      before.files !== now.files ||
      before.flagged !== now.flagged ||
      JSON.stringify(before.inspect) !== JSON.stringify(now.inspect) ||
      JSON.stringify(before.added) !== JSON.stringify(now.added)
    ) {
      changedRuns.push(run);
    }
    const rules = new Set([...Object.keys(before?.rules ?? {}), ...Object.keys(now.rules)]);
    for (const rule of [...rules].sort()) {
      const a = before?.rules[rule];
      const b = now.rules[rule];
      if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ run, rule, before: a, after: b });
    }
  }

  const byFingerprint = new Map<string, Finding[]>();
  for (const f of found)
    byFingerprint.set(f.fingerprint, [...(byFingerprint.get(f.fingerprint) ?? []), f]);
  const present = new Map<Label, Finding>();
  const labelFailures: string[] = [];
  const labelChanges: Comparison['labelChanges'] = [];
  for (const label of labels) {
    if (!(label.run in current)) continue;
    const finding = byFingerprint.get(label.fingerprint)?.find((f) => matches(label, f));
    if (finding) present.set(label, finding);
    // A label that has just been narrowed to a suggestion was recorded under its fingerprint.
    const was = snapshot.labels[labelKey(label)] ?? snapshot.labels[label.fingerprint];
    const is = finding !== undefined;
    const where = `${label.run} ${label.file}:${label.line} [${label.rule}] "${label.source}"`;
    if (was === undefined && !is) {
      labelFailures.push(`New label matches no finding: ${where} (${labelKey(label)})`);
    } else if (was !== undefined && was !== is) {
      labelChanges.push({ label, present: is });
      if (label.verdict === 'TP' && !is) {
        labelFailures.push(
          `A true positive is no longer reported: ${where}. ${label.reason} Relabel or remove it in corpus/labels.json if that is intended.`,
        );
      } else if (label.verdict === 'FP' && is) {
        labelFailures.push(`A fixed false positive is back: ${where}. ${label.reason}`);
      }
    }
  }
  return { changes, changedRuns, labelFailures, labelChanges, present };
}

export interface Precision {
  tp: number;
  fp: number;
  d: number;
  /** FP / all labelled findings still reported, or undefined with none. */
  rate: number | undefined;
}

function tally(labels: Iterable<Label>): Precision {
  const out: Precision = { tp: 0, fp: 0, d: 0, rate: undefined };
  for (const label of labels) {
    if (label.verdict === 'TP') out.tp++;
    else if (label.verdict === 'FP') out.fp++;
    else out.d++;
  }
  const total = out.tp + out.fp + out.d;
  out.rate = total ? out.fp / total : undefined;
  return out;
}

export interface FalsePositiveRate {
  /** Random labels still reported, all severities and errors only. */
  sample: Precision;
  sampleErrors: Precision;
  /** Audit labels still reported (picked as suspicious, so not an estimate). */
  audit: Precision;
  /**
   * The random sample's FP rate per run and rule, weighted by how many findings each has now:
   * an estimate for all findings in the corpus. `coverage` is the share of findings in a run
   * and rule with at least one random label still reported.
   */
  estimate: number | undefined;
  coverage: number;
  estimateErrors: number | undefined;
  coverageErrors: number;
  /** The random sample per rule. */
  byRule: { rule: string; precision: Precision }[];
}

export function falsePositiveRate(
  present: ReadonlyMap<Label, Finding>,
  current: Record<string, RunSnapshot>,
): FalsePositiveRate {
  const random = [...present].filter(([label]) => label.sample === 'random');
  const weighted = (errorsOnly: boolean) => {
    const strata = new Map<string, Label[]>();
    for (const [label, finding] of random) {
      if (errorsOnly && finding.severity !== 'error') continue;
      const key = `${label.run}\0${label.rule}`;
      strata.set(key, [...(strata.get(key) ?? []), label]);
    }
    let total = 0;
    let covered = 0;
    let fp = 0;
    for (const [run, snapshot] of Object.entries(current)) {
      for (const [rule, counts] of Object.entries(snapshot.added ?? snapshot.rules)) {
        const n = counts.errors + (errorsOnly ? 0 : counts.warnings);
        total += n;
        const labelled = strata.get(`${run}\0${rule}`);
        if (!labelled?.length) continue;
        covered += n;
        fp += (n * labelled.filter((l) => l.verdict === 'FP').length) / labelled.length;
      }
    }
    return { rate: covered ? fp / covered : undefined, coverage: total ? covered / total : 0 };
  };
  const all = weighted(false);
  const errors = weighted(true);
  return {
    sample: tally(random.map(([label]) => label)),
    sampleErrors: tally(random.filter(([, f]) => f.severity === 'error').map(([label]) => label)),
    audit: tally([...present.keys()].filter((label) => label.sample === 'audit')),
    estimate: all.rate,
    coverage: all.coverage,
    estimateErrors: errors.rate,
    coverageErrors: errors.coverage,
    byRule: [...new Set(random.map(([label]) => label.rule))].sort().map((rule) => ({
      rule,
      precision: tally(random.filter(([label]) => label.rule === rule).map(([label]) => label)),
    })),
  };
}

/** A finding as a root run and a run from the project's own folder both report it. */
function sameness(f: Finding, file: string): string {
  return JSON.stringify([file, f.rule, f.severity, f.line, f.source, f.message, f.suggestion]);
}

/**
 * Where a run from a workspace root differs from a run from one of its projects, for the
 * files under `folder`: root mode routes each file to its own project, so both must report
 * the same files and findings. Lines name each difference; none means they agree.
 */
export function rootDifferences(
  root: { files: readonly string[]; findings: readonly Finding[] },
  folder: string,
  project: { files: readonly string[]; findings: readonly Finding[] },
): string[] {
  const prefix = `${folder.replace(/\/+$/, '')}/`;
  const differences: string[] = [];
  const rootFiles = new Set(root.files.filter((f) => f.startsWith(prefix)));
  const projectFiles = new Set(project.files.map((f) => `${prefix}${f}`));
  for (const file of [...projectFiles].filter((f) => !rootFiles.has(f)).sort()) {
    differences.push(`${file}: checked from ${folder}, not from the root`);
  }
  for (const file of [...rootFiles].filter((f) => !projectFiles.has(f)).sort()) {
    differences.push(`${file}: checked from the root, not from ${folder}`);
  }
  const fromRoot = root.findings
    .filter((f) => f.file.startsWith(prefix))
    .map((f) => sameness(f, f.file));
  const fromProject = project.findings.map((f) => sameness(f, `${prefix}${f.file}`));
  const count = (list: string[]) => {
    const counts = new Map<string, number>();
    for (const key of list) counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  };
  const a = count(fromRoot);
  const b = count(fromProject);
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const n = a.get(key) ?? 0;
    const m = b.get(key) ?? 0;
    if (n === m) continue;
    const [file, rule, , line, source] = JSON.parse(key) as [
      string,
      string,
      string,
      number,
      string,
    ];
    differences.push(
      `${file}:${line} [${rule}] "${source}": ${n} from the root, ${m} from ${folder}`,
    );
  }
  return differences;
}

/** Findings outside the given folders: what a root run adds to the runs from its projects. */
export function outside(found: readonly Finding[], folders: readonly string[]): Finding[] {
  const prefixes = folders.map((f) => `${f.replace(/\/+$/, '')}/`);
  return found.filter((f) => !prefixes.some((prefix) => f.file.startsWith(prefix)));
}

export function percent(rate: number | undefined): string {
  return rate === undefined ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}

/** A Markdown table of count changes, for pull request descriptions. */
export function changeTable(changes: readonly CountChange[]): string {
  const cell = (c: RuleCounts | undefined) =>
    c ? `${c.errors + c.warnings} (${c.fixes} fixable)` : '0';
  const lines = ['| Run | Rule | Before | After |', '| --- | --- | ---: | ---: |'];
  for (const { run, rule, before, after } of changes) {
    lines.push(`| ${run} | ${rule} | ${cell(before)} | ${cell(after)} |`);
  }
  return lines.join('\n');
}

/** A small seeded generator (mulberry32), so `sample` draws the same findings for the same seed. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A repository's `install` in corpus/repos.json: for each folder of the checkout, the npm
 * packages the CLI needs to read the app as the app's own editor does (a component library's
 * type declarations, its peers and React's types), each at an exact version, and the date that
 * pins what they depend on: npm takes the newest versions published by then.
 */
export interface InstallSpec {
  before: string;
  /** Folder of the checkout (`.` for its root) → package → exact version. */
  folders: Record<string, Record<string, string>>;
}

export interface Install {
  folder: string;
  /** Where the packages are installed: beside the checkouts, never in one. */
  dir: string;
  /** The folder's node_modules in the checkout, a link to `dir`'s. */
  link: string;
  /** The package.json written into `dir`: the repository's own is not used. */
  manifest: { private: true; dependencies: Record<string, string> };
  /** npm's arguments: no package's install scripts run. */
  args: string[];
}

/** `5.15.0`, `7.0.0-beta.13`: one version, not a range or a tag. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** What `corpus.mjs fetch` installs for `repo`, under the corpus folder `corpus`. */
export function installs(
  repo: { name: string; install?: InstallSpec | undefined },
  corpus: string,
): Install[] {
  if (!repo.install) return [];
  const { before, folders } = repo.install;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    throw new Error(
      `${repo.name}: install.before must be a date (2026-08-13), not ${JSON.stringify(before)}.`,
    );
  }
  return Object.entries(folders).map(([folder, packages]) => {
    const parts = folder.split('/').filter((part) => part && part !== '.');
    if (parts.includes('..') || path.isAbsolute(folder)) {
      throw new Error(`${repo.name}: install folder ${folder} is not inside the checkout.`);
    }
    for (const [name, version] of Object.entries(packages)) {
      if (!EXACT_VERSION.test(version)) {
        throw new Error(
          `${repo.name}: install ${name}@${version} in ${folder}: pin an exact version.`,
        );
      }
    }
    return {
      folder,
      dir: path.join(corpus, '.installs', repo.name, ...(parts.length ? parts : ['.root'])),
      link: path.join(corpus, repo.name, ...parts, 'node_modules'),
      manifest: { private: true, dependencies: packages },
      args: [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--update-notifier=false',
        '--loglevel=error',
        `--before=${before}`,
      ],
    };
  });
}
