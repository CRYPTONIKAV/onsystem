import { bench, docs, readme, ruleCatalog, tools } from '@/lib/data';
import { DOCS_PAGES } from '@/lib/docs';
import {
  NPM,
  NPX,
  PLUGIN_COMMANDS,
  REGISTRY,
  REPO,
  repoLink,
  resolveDocHref,
  SITE_URL,
} from '@/lib/site';

/** Links in docs Markdown on `page`, made absolute: site pages where they exist, GitHub otherwise. */
function absolute(markdown: string, page: string): string {
  return markdown.replace(/\]\(([^)]+)\)/g, (_, href: string) => {
    const target = resolveDocHref(href);
    if (target.startsWith('#')) return `](${SITE_URL}${page}${target})`;
    return `](${target.startsWith('/') ? `${SITE_URL}${target}` : target})`;
  });
}

const summary =
  'Keeps coding agents on your design system: it knows your real components, props, variants and tokens, catches the moment an agent invents one and has it fix it, and the same check gates your PRs. Local, zero config, works alongside @shadcn/lint. It reads React components, props, cva variants and tokens from source with the TypeScript compiler. In Claude Code, a hook checks each file right after it is written and hands the errors back with their fixes; other agents run check_ui over MCP; the CI check gates pull requests. Static analysis: no model calls, no API key.';

/** llms.txt (https://llmstxt.org): what this is, how to install it, and where everything is. */
export function llmsTxt(): string {
  const [model] = bench.models;
  const lines = [
    '# onsystem',
    '',
    `> ${summary}`,
    '',
    `Version ${tools.version}, MIT. React (.tsx/.jsx), shadcn/ui or any design system, Tailwind v3 or v4, Node.js ${readme.engines.node.replace('>=', '')}+.`,
    '',
    'Install:',
    '',
    `- Claude Code (hook, MCP server and skill): \`${PLUGIN_COMMANDS.split('\n').join('` then `')}\``,
    '- CI: `npx onsystem check . --format github --require-design-system`, with `--update-baseline` once to accept existing findings',
    '- Required check on pull requests: the GitHub Action `uses: dgesteves/onsystem@v0`, which annotates the lines a pull request changed',
    `- Any MCP client, over stdio: \`${NPX}\``,
    '',
    model
      ? `Benchmark: Claude Code built the same ten components for vercel/ai-chatbot with and without the plugin. ${bench.models.map((m) => `${m.name}: ${String(m.base.clean)}/${String(m.base.runs)} → ${String(m.plugin.clean)}/${String(m.plugin.runs)} clean, ${String(m.base.errors)} → ${String(m.plugin.errors)} errors`).join('; ')}.`
      : '',
    '',
    '## Docs',
    '',
    ...DOCS_PAGES.map((page) => `- [${page.title}](${SITE_URL}${page.href}): ${page.description}`),
    `- [Rules](${SITE_URL}/rules): every rule with what it catches, why it matters, an example and its fix`,
    `- [Playground](${SITE_URL}/playground): run check_ui on code in the browser, against a demo design system`,
    '',
    '## Tools',
    '',
    ...tools.tools.map((tool) => `- \`${tool.name}\`: ${tool.description}`),
    '',
    '## Rules',
    '',
    ...ruleCatalog.rules.map(
      (rule) =>
        `- [\`${rule.id}\`](${SITE_URL}/rules#${rule.id}) (${rule.severity}): ${rule.description}`,
    ),
    '',
    '## Optional',
    '',
    `- [All the docs in one file](${SITE_URL}/llms-full.txt)`,
    `- [README](${REPO}#readme)`,
    `- [Benchmark method and per-run results](${repoLink('bench/agents', 'tree')})`,
    `- [npm](${NPM})`,
    `- [MCP Registry](${REGISTRY})`,
    `- [Changelog](${repoLink('CHANGELOG.md')})`,
  ];
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/** Every docs page and the rules, as one Markdown file. */
export function llmsFullTxt(): string {
  const sections: [title: string, page: string, body: string][] = [
    ['Quickstart', '/docs', docs.quickstart],
    ['Claude Code plugin', '/docs/plugin', docs.plugin],
    ['CI and baselines', '/docs/ci', docs.ci],
    ['Make it a required check on agent pull requests', '/docs/required-check', docs.requiredCheck],
    ['Set up your agent', '/docs/clients', docs.clients],
    ['Configuration', '/docs/configuration', docs.configuration],
    ['Design tokens', '/docs/tokens', docs.tokens],
    ['ESLint plugin', '/docs/eslint', docs.eslint],
    [
      'Rules',
      '/rules',
      [
        ...ruleCatalog.rules.map(
          (rule) =>
            `### ${rule.id} (${rule.severity} by default)\n\n${rule.description}\n\nCatches: ${rule.catches}\n\nSuggests: ${rule.suggests}\n\nWhy it matters: ${rule.why}\n\nExample:\n\n\`\`\`tsx\n${rule.bad.trimEnd()}\n\`\`\`\n\n${rule.findings.map((f) => `- ${String(f.line)}:${String(f.column)} ${f.severity}: ${f.message}`).join('\n')}\n\nFixed:\n\n\`\`\`tsx\n${rule.good.trimEnd()}\n\`\`\``,
        ),
        `### How fixes are chosen\n\n${ruleCatalog.details}`,
        `### Suppressing findings\n\n${ruleCatalog.suppression}`,
      ].join('\n\n'),
    ],
    ['Tools', '/docs/tools', docs.tools],
    ['Troubleshooting', '/docs/troubleshooting', docs.troubleshooting],
    ['How it works', '/docs/how-it-works', docs.howItWorks],
    ['Migrating from @dgesteves/design-system-mcp', '/docs/migrating', docs.migrating],
  ];
  // Each page's own `##` sections become `###` under its `##` title; code blocks stay as they are.
  const nest = (body: string) => {
    let fenced = false;
    return body
      .split('\n')
      .map((line) => {
        if (/^\s*```/.test(line)) fenced = !fenced;
        return !fenced && /^#{2,5} /.test(line) ? `#${line}` : line;
      })
      .join('\n');
  };
  return `# onsystem\n\n> ${summary}\n\n${sections
    .map(([title, page, body]) => `## ${title}\n\n${absolute(nest(body), page)}`)
    .join('\n\n')}\n`;
}
