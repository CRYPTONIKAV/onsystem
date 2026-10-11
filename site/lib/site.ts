import { readme, tools } from '@/lib/data';

export const SITE_URL = 'https://onsystem.vercel.app';
export const REPO = 'https://github.com/dgesteves/onsystem';
export const NPM = 'https://www.npmjs.com/package/onsystem';
export const REGISTRY =
  'https://registry.modelcontextprotocol.io/?q=io.github.dgesteves%2Fonsystem';
export const AUTHOR = { name: 'Diogo Esteves', url: 'https://github.com/dgesteves' };

export const VERSION = tools.version;
export const NPX = 'npx -y onsystem';
export const PLUGIN_COMMANDS = readme.install.plugin;
export const CURSOR_INSTALL = readme.install.cursor;
export const VSCODE_INSTALL = readme.install.vscode;

/** A file or folder in the repository on GitHub. */
export function repoLink(file: string, kind: 'blob' | 'tree' = 'blob'): string {
  return `${REPO}/${kind}/main/${file}`;
}

export const MORE = [
  {
    name: 'ondocs',
    url: 'https://ondocs.vercel.app',
    description: 'Makes your docs answerable by people and agents, from one static index.',
  },
  {
    name: 'signoff-ui',
    url: 'https://signoff-ui.vercel.app',
    description: 'Review what your agent changed and approve what it may do.',
  },
];

/** A rule's entry in the catalog. */
export function ruleHref(id: string): string {
  return `/rules#${id}`;
}

/** The docs/*.md files and the page each one is rendered on. */
export const DOCS_FILES: Record<string, string> = {
  'quickstart.md': '/docs',
  'plugin.md': '/docs/plugin',
  'ci.md': '/docs/ci',
  'required-check.md': '/docs/required-check',
  'clients.md': '/docs/clients',
  'configuration.md': '/docs/configuration',
  'tokens.md': '/docs/tokens',
  'eslint.md': '/docs/eslint',
  'tools.md': '/docs/tools',
  'troubleshooting.md': '/docs/troubleshooting',
  'how-it-works.md': '/docs/how-it-works',
  'migrating.md': '/docs/migrating',
  'rules.md': '/rules',
};

/** Named sections and the page each one is on, for links from the site's own pages. */
const SECTIONS: Record<string, string> = {
  quickstart: '/docs',
  setup: '/docs/clients',
  'cursor-and-vs-code': '/docs/clients#cursor-and-vs-code',
  'other-clients': '/docs/clients#other-clients',
  'claude-code-plugin': '/docs/plugin',
  tools: '/docs/tools',
  rules: '/rules',
  'suppressing-findings': '/rules#suppressing-findings',
  configuration: '/docs/configuration',
  'zero-config': '/docs/configuration#zero-config',
  'config-file': '/docs/configuration#config-file',
  ci: '/docs/ci',
  'adopting-it-in-an-existing-codebase': '/docs/ci#adopting-it-in-an-existing-codebase',
  troubleshooting: '/docs/troubleshooting',
  'how-it-works': '/docs/how-it-works',
  limits: '/docs/how-it-works#limits',
};

/** The page a named section is on. */
export function docsHref(section: string): string {
  const href = SECTIONS[section];
  if (!href) throw new Error(`No page for the section "${section}"`);
  return href;
}

/**
 * Where a link in the docs Markdown points from the site: another docs file (`ci.md#…`) to its
 * page, the site's own absolute URLs to paths, a file in the repository (`../schema.json`) to
 * GitHub, and an anchor to the section on this page.
 */
export function resolveDocHref(href: string): string {
  if (href.startsWith(SITE_URL)) return href.slice(SITE_URL.length) || '/';
  if (/^https?:\/\//.test(href) || href.startsWith('/') || href.startsWith('#')) return href;
  const doc = /^(?:\.\/)?([\w-]+\.md)(#[\w-]*)?$/.exec(href);
  const page = doc?.[1] ? DOCS_FILES[doc[1]] : undefined;
  if (page) return `${page}${doc?.[2] ?? ''}`;
  const file = href.replace(/^(?:\.\.?\/)+/, '');
  return repoLink(file, /\.[a-z]+$/i.test(file) ? 'blob' : 'tree');
}
