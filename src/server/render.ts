import type { Catalog, CatalogEntry, CatalogToken } from '../catalog.js';
import type { DesignSystem } from '../design-system.js';
import type { SearchHit } from '../search/index.js';
import { formatPx } from '../tokens/units.js';
import type { CheckResult, ComponentInfo, Diagnostic, PropInfo, Token } from '../types.js';
import { plural, truncate } from '../util/strings.js';

/**
 * Tool results are read by models, so they are rendered as compact Markdown:
 * fewer tokens than JSON, and the same information. The JSON is still sent
 * as structured content.
 */

function firstSentence(text: string | undefined, max = 140): string {
  if (!text) return '';
  // A sentence ends at . ! or ? followed by an uppercase letter or the end ("e.g. a menu" does not).
  const sentence = /^[\s\S]*?[.!?](?=\s+[A-Z`"(]|\s*$)/.exec(text.trim())?.[0] ?? text.trim();
  return truncate(sentence.replace(/\s+/g, ' '), max);
}

export function importStatement(component: ComponentInfo): string {
  const binding = component.exportName.split('.')[0] ?? component.name;
  return `import { ${binding} } from "${component.importPath}"`;
}

function variantSummary(component: ComponentInfo): string[] {
  return component.variants.map(
    (v) => `${v.name}: ${v.values.join(' | ')}${v.default ? ` (default ${v.default})` : ''}`,
  );
}

/** `project`: the folder of a workspace root's project the list is for. */
export function renderComponentList(ds: DesignSystem, project?: string): string {
  const roots = ds.roots();
  if (!roots.length) {
    return `No components found${project ? ` in ${project}` : ''}. Check the "components" globs in the config (root: ${ds.root}).`;
  }
  const parts = ds.components.length - roots.length;
  const lines = [
    `${plural(roots.length, 'component')}${parts ? ` (+${plural(parts, 'part')})` : ''}${project ? ` in ${project}` : ''}. Call get_component before using one.`,
    '',
  ];
  const own = roots.filter((c) => !c.library);
  for (const component of own) lines.push(...listItem(component));
  // A library's components, imported alike: the import is said once.
  for (const library of new Set(roots.flatMap((c) => (c.library ? [c.library] : [])))) {
    if (own.length) lines.push('');
    lines.push(`From ${library} (import { Name } from "${library}"):`, '');
    for (const component of roots.filter((c) => c.library === library)) {
      lines.push(...listItem(component, '', false));
    }
  }
  return lines.join('\n');
}

function listItem(component: ComponentInfo, note = '', withImport = true): string[] {
  const element = component.element ? ` <${component.element}>` : '';
  const lines = [
    `${component.name}${element}${note} — ${firstSentence(component.description) || 'No description.'}`,
  ];
  for (const variant of variantSummary(component)) lines.push(`  ${variant}`);
  if (component.subcomponents.length) lines.push(`  parts: ${component.subcomponents.join(', ')}`);
  if (withImport) lines.push(`  ${importStatement(component)}`);
  return lines;
}

/** `apps/web`, `apps/web and packages/ui`, `a, b, c and 4 more`. */
function listOf(items: readonly string[], max = 3): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length <= max) return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

const PICK_PROJECT =
  'This is a monorepo root: pass `path`, the file you are editing, to get_component, get_tokens and check_ui so they answer for its project.';

/** Every project's components at a workspace root, grouped by the package they come from. */
export function renderCatalogList(catalog: Catalog): string {
  const roots = catalog.roots();
  if (!roots.length) {
    return `No components found in any project of this monorepo (root: ${catalog.root}). Run \`onsystem inspect\` there to see what was looked at.`;
  }
  const byPackage = new Map<string, CatalogEntry[]>();
  for (const entry of roots)
    byPackage.set(entry.package, [...(byPackage.get(entry.package) ?? []), entry]);
  const parts = catalog.entries.length - roots.length;
  const lines = [
    `${plural(roots.length, 'component')}${parts ? ` (+${plural(parts, 'part')})` : ''} from ${plural(byPackage.size, 'package')}, used by ${plural(catalog.projects.length, 'project')}. ${PICK_PROJECT}`,
  ];
  for (const [pkg, entries] of byPackage) {
    const projects = [...new Set(entries.flatMap((e) => e.projects))];
    lines.push('', `## ${pkg} (used by ${listOf(projects)})`);
    for (const entry of entries) {
      const others = entry.ambiguous
        ? catalog.roots().filter((e) => e !== entry && e.component.name === entry.component.name)
        : [];
      const note = others.length
        ? ` (also in ${[...new Set(others.map((e) => e.package))].join(', ')})`
        : '';
      lines.push(...listItem(entry.component, note));
    }
  }
  return lines.join('\n');
}

/** Several components under one name at a workspace root, and how to pick one. */
export function renderAmbiguous(name: string, entries: readonly CatalogEntry[]): string {
  const lines = [`"${name}" is the name of ${entries.length} components in this monorepo:`];
  for (const entry of entries) {
    lines.push(
      `- ${entry.package}: ${entry.component.source.file}, used by ${listOf(entry.projects)} (${importStatement(entry.component)})`,
    );
  }
  const dirs = [...new Set(entries.flatMap((e) => e.projects))];
  lines.push(
    '',
    `Pass \`path\`: the file you are editing, or its project folder (${dirs.join(', ')}), to get the one that project uses.`,
  );
  return lines.join('\n');
}

/** Inherited attributes worth naming, per element; the rest are summarised. */
const NOTABLE_INHERITED: Record<string, string[]> = {
  button: ['onClick', 'type', 'disabled', 'form'],
  input: [
    'type',
    'value',
    'defaultValue',
    'onChange',
    'placeholder',
    'disabled',
    'name',
    'required',
  ],
  textarea: ['value', 'defaultValue', 'onChange', 'placeholder', 'disabled', 'name', 'rows'],
  select: ['value', 'defaultValue', 'onChange', 'disabled', 'name'],
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  label: ['htmlFor'],
  default: ['onClick', 'id', 'role', 'children'],
};

/** What callers of a React Aria component most often need, from its inherited props. */
const REACT_ARIA_NOTABLE = [
  'onPress',
  'onChange',
  'onAction',
  'onSelectionChange',
  'onOpenChange',
  'value',
  'defaultValue',
  'isDisabled',
  'isRequired',
  'isInvalid',
  'isReadOnly',
  'autoFocus',
];

function renderProp(prop: PropInfo): string {
  const optional = prop.required ? '' : '?';
  const fallback = prop.default !== undefined ? ` = ${prop.default}` : '';
  const deprecated = prop.deprecated
    ? ` DEPRECATED${prop.deprecated === true ? '' : `: ${prop.deprecated}`}.`
    : '';
  const description = prop.description ? ` — ${prop.description.replace(/\s*\n\s*/g, ' ')}` : '';
  return `- ${prop.name}${optional}: ${prop.type}${fallback}${description}${deprecated}`;
}

/** `origin`: at a workspace root, the package the component comes from and who uses it. */
export function renderComponent(
  ds: DesignSystem,
  component: ComponentInfo,
  origin?: Pick<CatalogEntry, 'package' | 'projects'>,
): string {
  const lines: string[] = [`# ${component.name}`];
  if (component.deprecated) {
    lines.push(`DEPRECATED${component.deprecated === true ? '' : `: ${component.deprecated}`}`);
  }
  if (component.description) lines.push(component.description);
  lines.push('', importStatement(component));
  const facts = [
    component.element ? `Renders <${component.element}>` : undefined,
    component.parent ? `Part of ${component.parent}` : undefined,
    component.aliases.length ? `Also available as ${component.aliases.join(', ')}` : undefined,
    `${component.source.file}:${component.source.line}`,
    component.docs ? `docs: ${component.docs.file}` : undefined,
  ].filter(Boolean);
  lines.push(facts.join(' · '));
  if (origin) lines.push(`From ${origin.package}, used by ${listOf(origin.projects)}.`);

  lines.push('', '## Props');
  if (!component.props.length && !component.inherits.length) lines.push('No props.');
  for (const prop of component.props) lines.push(renderProp(prop));
  for (const inherited of component.inherits) {
    const names = ds.model.propSets[inherited.set] ?? [];
    // React Aria's event props mark its components, whatever they render.
    const wanted = names.some((n) => n === 'onPress' || n === 'onFocusChange')
      ? REACT_ARIA_NOTABLE
      : (NOTABLE_INHERITED[component.element ?? ''] ?? NOTABLE_INHERITED.default ?? []);
    const notable = wanted.filter((n) => names.includes(n) && !inherited.deprecated?.includes(n));
    lines.push(
      `- …plus ${inherited.count} props from ${inherited.from}` +
        (notable.length ? ` (${notable.join(', ')}, aria-*, data-*, …)` : ''),
    );
  }
  if (component.openProps) {
    lines.push('- Part of the props type could not be resolved; extra props may be accepted.');
  }

  if (component.variants.length) {
    lines.push('', '## Variants');
    for (const variant of component.variants) {
      // A library's variants are a prop's values, with no classes to show: one line.
      if (!Object.values(variant.classes).some(Boolean)) {
        lines.push(
          `${variant.name}: ${variant.values.join(' | ')}${variant.default ? ` (default "${variant.default}")` : ''}`,
        );
        continue;
      }
      lines.push(`${variant.name}${variant.default ? ` (default "${variant.default}")` : ''}`);
      const width = Math.max(...variant.values.map((v) => v.length));
      for (const value of variant.values) {
        lines.push(`  ${value.padEnd(width)}  ${variant.classes[value] ?? ''}`.trimEnd());
      }
    }
    for (const compound of component.compoundVariants) {
      const when = Object.entries(compound.when)
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
        .join(' & ');
      lines.push(`  when ${when}: ${compound.classes}`);
    }
  }

  if (component.subcomponents.length) {
    lines.push('', '## Parts');
    for (const name of component.subcomponents) {
      const part = ds.getComponent(name);
      lines.push(`- ${name}${part?.description ? ` — ${firstSentence(part.description)}` : ''}`);
    }
  }

  const tokens = ds.relatedTokens(component);
  if (tokens.length) {
    lines.push('', '## Design tokens used');
    lines.push(tokens.map((t) => `${t.name} (${t.usage[0] ?? t.value})`).join(', '));
  }

  if (component.docs?.sections.length) {
    lines.push('', `## Docs (${component.docs.file})`);
    for (const section of component.docs.sections) {
      if (/^examples?$/i.test(section.heading) && !section.body) continue;
      lines.push(`### ${section.heading}`);
      if (section.body) lines.push(section.body);
    }
  }

  if (component.examples.length) {
    lines.push('', '## Examples');
    for (const example of component.examples) {
      if (example.title) lines.push(`### ${example.title}`);
      lines.push(`\`\`\`${example.lang}`, example.code, '```');
    }
  }
  return lines.join('\n');
}

export function renderSearch(query: string, hits: SearchHit[]): string {
  if (!hits.length) {
    return `No components match "${query}". Try other words, or list_components to browse.`;
  }
  const lines = [`Components for "${query}", best first:`, ''];
  hits.forEach((hit, i) => {
    const c = hit.component;
    const parent = c.parent ? ` (part of ${c.parent})` : '';
    lines.push(
      `${i + 1}. ${c.name}${parent} — ${firstSentence(c.description) || 'No description.'}`,
    );
    lines.push(
      `   score ${hit.score} · matched: ${hit.matched.join(', ')} · ${importStatement(c)}`,
    );
  });
  lines.push('', 'Call get_component for props, variants and examples.');
  return lines.join('\n');
}

/** Search hits at a workspace root, each with the package it comes from. */
export function renderCatalogSearch(
  query: string,
  hits: readonly (SearchHit & { entry: CatalogEntry })[],
): string {
  if (!hits.length) {
    return `No components match "${query}" in any project. Try other words, or list_components to browse.`;
  }
  const lines = [`Components for "${query}" across the monorepo's projects, best first:`, ''];
  hits.forEach((hit, i) => {
    const c = hit.component;
    const parent = c.parent ? ` (part of ${c.parent})` : '';
    lines.push(
      `${i + 1}. ${c.name}${parent} from ${hit.entry.package} — ${firstSentence(c.description) || 'No description.'}`,
    );
    lines.push(
      `   score ${hit.score} · matched: ${hit.matched.join(', ')} · used by ${listOf(hit.entry.projects)} · ${importStatement(c)}`,
    );
  });
  lines.push('', `Call get_component for props, variants and examples. ${PICK_PROJECT}`);
  return lines.join('\n');
}

/** Tokens at a workspace root, grouped by category, each with the package that defines it. */
export function renderCatalogTokens(
  catalog: Catalog,
  tokens: readonly CatalogToken[],
  filter: { category?: string | undefined; query?: string | undefined } = {},
): string {
  if (!catalog.tokens.length) {
    return `No design tokens found in any project of this monorepo (root: ${catalog.root}). Set "tokens" in a project's config: https://onsystem.vercel.app/docs/configuration`;
  }
  if (!tokens.length) {
    const what = [filter.category, filter.query && `"${filter.query}"`].filter(Boolean).join(' ');
    return `No tokens match${what ? ` ${what}` : ''} in any project; call get_tokens without filters to see them.`;
  }
  const groups = new Map<string, CatalogToken[]>();
  for (const t of tokens)
    groups.set(t.token.category, [...(groups.get(t.token.category) ?? []), t]);
  const lines: string[] = [PICK_PROJECT, ''];
  for (const [category, list] of groups) {
    lines.push(`## ${category} (${list.length})`);
    for (const { token, package: pkg } of list) {
      const usage = token.usage.length ? ` → ${token.usage.join(', ')}` : '';
      lines.push(`- ${token.name}: ${token.value}${usage} (${pkg})`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function renderTokens(
  ds: DesignSystem,
  tokens: Token[],
  filter: { category?: string | undefined; query?: string | undefined } = {},
): string {
  if (!ds.tokens.length) {
    return `No design tokens found in this project (root: ${ds.root}): no stylesheet or *.tokens.json defines any. Set "tokens" in the config: https://onsystem.vercel.app/docs/configuration`;
  }
  if (!tokens.length) {
    const counts = new Map<string, number>();
    for (const token of ds.tokens)
      counts.set(token.category, (counts.get(token.category) ?? 0) + 1);
    const categories = [...counts].map(([category, n]) => `${category} (${n})`).join(', ');
    const what = [filter.category, filter.query && `"${filter.query}"`].filter(Boolean).join(' ');
    return `No tokens match${what ? ` ${what}` : ''}. The design system has ${categories}; call get_tokens without filters to see them.`;
  }
  const groups = new Map<string, Token[]>();
  for (const token of tokens)
    groups.set(token.category, [...(groups.get(token.category) ?? []), token]);
  const lines: string[] = [];
  for (const [category, list] of groups) {
    lines.push(`## ${category} (${list.length})`);
    for (const token of list) {
      const px =
        token.category === 'spacing' || token.category === 'radius'
          ? ds.tokenIndex.toPx(token.value)
          : undefined;
      const value =
        px !== undefined && !/^-?[\d.]+px$/.test(token.value)
          ? `${token.value} = ${formatPx(px)}`
          : token.value;
      const modes = token.modes
        ? ` (${Object.entries(token.modes)
            .map(([mode, v]) => `${mode}: ${v}`)
            .join(', ')})`
        : '';
      const usage = token.usage.length ? ` → ${token.usage.join(', ')}` : '';
      const description = token.description ? ` — ${token.description}` : '';
      const deprecated = token.deprecated ? ' DEPRECATED' : '';
      lines.push(`- ${token.name}: ${value}${modes}${usage}${description}${deprecated}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** Diagnostics an agent sees at once: errors first, in source order, then warnings. */
export interface CappedCheck {
  shown: Diagnostic[];
  omitted: number;
  /** Every finding per rule, shown or not. */
  byRule: Record<string, { errors: number; warnings: number }>;
}

export function capDiagnostics(result: CheckResult, limit: number): CappedCheck {
  const ordered = [
    ...result.diagnostics.filter((d) => d.severity === 'error'),
    ...result.diagnostics.filter((d) => d.severity !== 'error'),
  ];
  const byRule: CappedCheck['byRule'] = {};
  for (const d of result.diagnostics) {
    const counts = (byRule[d.ruleId] ??= { errors: 0, warnings: 0 });
    if (d.severity === 'error') counts.errors++;
    else counts.warnings++;
  }
  const shown = ordered.slice(0, limit);
  return { shown, omitted: ordered.length - shown.length, byRule };
}

export function renderCheck(
  result: CheckResult,
  capped = capDiagnostics(result, Infinity),
): string {
  if (result.skipped) return `${result.file}: not checked. ${result.skipped}`;
  if (!result.diagnostics.length) {
    return `${result.file}: no design-system problems found.`;
  }
  const lines = [
    `${result.file}: ${plural(result.errorCount, 'error')}, ${plural(result.warningCount, 'warning')}`,
    '',
  ];
  for (const d of capped.shown) {
    lines.push(`${d.line}:${d.column} ${d.severity} [${d.ruleId}] ${d.message}`);
  }
  if (capped.omitted) {
    const rules = Object.entries(capped.byRule)
      .sort(([, a], [, b]) => b.errors + b.warnings - (a.errors + a.warnings))
      .map(([rule, c]) => `${rule} ${(c.errors + c.warnings).toLocaleString('en-US')}`)
      .join(', ');
    lines.push(
      '',
      `Showing ${capped.shown.length} of ${result.diagnostics.length.toLocaleString('en-US')} (errors first). By rule: ${rules}.`,
      `${capped.omitted.toLocaleString('en-US')} more not shown: fix these, then run check_ui again, or pass a higher \`limit\`.`,
    );
  }
  lines.push(
    '',
    result.errorCount
      ? 'Fix every error, then run check_ui again.'
      : 'Only warnings: fix them if the design system has an equivalent.',
  );
  return lines.join('\n');
}
