/** The docs pages, in reading order. Titles double as sidebar labels. */
export const DOCS_PAGES = [
  {
    href: '/docs',
    title: 'Quickstart',
    description:
      'See what it found in your app, hold your agent to the design system, and gate your pull requests with the same check.',
  },
  {
    href: '/docs/plugin',
    title: 'Claude Code plugin',
    description:
      'The hook that checks every UI file right after Claude writes it and hands errors back to fix, the MCP server and a skill: what each does, what it runs and what it touches.',
  },
  {
    href: '/docs/ci',
    title: 'CI and baselines',
    description:
      'Gate pull requests with the same check, as annotations, and adopt it in a codebase that already has findings.',
  },
  {
    href: '/docs/required-check',
    title: 'Make it a required check on agent pull requests',
    description:
      'The GitHub Action that annotates the lines a pull request changed, making it a required check, and what to know for pull requests from Copilot, Codex and Claude.',
  },
  {
    href: '/docs/clients',
    title: 'Set up your agent',
    description:
      'MCP configs for Cursor, VS Code, Claude Desktop, Codex CLI, GitHub Copilot CLI, Windsurf, JetBrains IDEs, Zed, Gemini CLI, Grok Build and Claude Code without the plugin.',
  },
  {
    href: '/docs/configuration',
    title: 'Configuration',
    description:
      'How the design system is found with zero config, and the config file for other layouts.',
  },
  {
    href: '/docs/tokens',
    title: 'Design tokens',
    description:
      'Tokens from stylesheets, DTCG 2025.10 files and a DESIGN.md, and onsystem export to write them as DTCG or DESIGN.md.',
  },
  {
    href: '/docs/eslint',
    title: 'ESLint plugin',
    description:
      'The same rules in ESLint 9 and 10, checked against each file’s design system, and how to run them alongside @shadcn/lint.',
  },
  {
    href: '/docs/tools',
    title: 'Tools',
    description: 'The five MCP tools, the resources and the prompt, with real responses.',
  },
  {
    href: '/docs/troubleshooting',
    title: 'Troubleshooting',
    description:
      'When inspect finds nothing, a monorepo root that misses a project, components with 0 props, and min-release-age policies that block npx.',
  },
  {
    href: '/docs/how-it-works',
    title: 'How it works',
    description:
      'How the design system is read and checked, results on real codebases, how it compares, design decisions and limits.',
  },
  {
    href: '/docs/faq',
    title: 'FAQ',
    description: 'Privacy, @shadcn/lint and Storybook, other frameworks, and false positives.',
  },
  {
    href: '/docs/migrating',
    title: 'Migrating from design-system-mcp',
    description:
      'What moved when @dgesteves/design-system-mcp became onsystem: the package, command, config and baseline files, plugin, MCP key and registry name.',
  },
] as const;

export type DocsHref = (typeof DOCS_PAGES)[number]['href'];

export function docsPage(href: DocsHref) {
  const index = DOCS_PAGES.findIndex((p) => p.href === href);
  return {
    page: DOCS_PAGES[index] ?? DOCS_PAGES[0],
    previous: index > 0 ? DOCS_PAGES[index - 1] : undefined,
    next: DOCS_PAGES[index + 1],
  };
}
