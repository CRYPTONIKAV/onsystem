import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_COMPONENTS, loadConfig } from '../src/config.js';
import { DesignSystemHost } from '../src/design-system.js';
import { detectProject, isDesignSystemName, pnpmPackages } from '../src/detect.js';
import { buildEntries, exportedFiles, sourceTarget } from '../src/package-source.js';
import { fixture, load, TSCONFIG } from './helpers.js';

const BUTTON = `import * as React from "react"
export function Button(props: { variant?: "default" | "outline"; children?: React.ReactNode }) { return <button>{props.children}</button> }
`;
const CARD = `export function Card(props: { children?: unknown }) { return <div /> }
export function CardHeader(props: { children?: unknown }) { return <div /> }
`;
const INPUT = `export function Input(props: { value?: string }) { return <input /> }
`;
const ICONS = `export const Icons = { Add: () => <svg />, Close: () => <svg /> }
`;
const THEME = `@import "tailwindcss";
:root { --primary: oklch(0.2 0 0); }
@theme inline { --color-primary: var(--primary); }
`;

const json = (value: unknown) => JSON.stringify(value, null, 2);

describe('detectProject: components.json', () => {
  it('follows a custom ui alias through tsconfig paths and reads tailwind.css', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'components.json': json({
        tailwind: { css: 'styles/app.css' },
        aliases: { components: '@/components', ui: '@/registry/new-york/ui' },
      }),
      'registry/new-york/ui/button.tsx': BUTTON,
      'styles/app.css': THEME,
    });
    const config = await loadConfig({ root });
    expect(config.detected).toBe(
      'components.json (ui: @/registry/new-york/ui → registry/new-york/ui)',
    );
    expect(config.components).toEqual(['registry/new-york/ui/**/*.{tsx,jsx}']);
    // The stylesheet replaces the guesses; DTCG files are still read, and a DESIGN.md without either.
    expect(config.tokens).toEqual([
      { path: 'styles/app.css' },
      { path: '**/*.tokens.json' },
      { path: 'DESIGN.md', fallback: true },
    ]);

    const ds = await load(root);
    expect(ds.getComponent('Button')?.importPath).toBe('@/registry/new-york/ui/button');
    expect(ds.tokens.map((t) => t.name)).toContain('primary');
  });

  it('defaults ui to the components alias plus /ui and escapes glob syntax in folders', () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'components.json': json({ aliases: { components: '@/app/(shared)/components' } }),
      'app/(shared)/components/ui/button.tsx': BUTTON,
    });
    expect(detectProject(root)?.components).toEqual([
      'app/\\(shared\\)/components/ui/**/*.{tsx,jsx}',
    ]);
  });

  it('finds the ui package of a shadcn monorepo through the workspace and its exports', async () => {
    const workspace = fixture({
      'pnpm-workspace.yaml': `packages:\n  - "apps/*"   # apps\n  - 'packages/*'\n`,
      'packages/ui/package.json': json({
        name: '@workspace/ui',
        exports: {
          './globals.css': './src/styles/globals.css',
          './components/*': './src/components/*.tsx',
          './lib/*': './src/lib/*.ts',
        },
      }),
      'packages/ui/src/components/button.tsx': BUTTON,
      'packages/ui/src/components/button.stories.tsx': `export const Primary = () => <button />\n`,
      'packages/ui/src/components/button.test.tsx': `export function TestThing() { return <div /> }\n`,
      'packages/ui/src/components/node_modules/x/index.tsx': `export function FromNodeModules() { return <div /> }\n`,
      'packages/ui/src/components/form/input.tsx': INPUT,
      'packages/ui/src/styles/globals.css': THEME,
      'apps/web/package.json': json({
        name: 'web',
        dependencies: { '@workspace/ui': 'workspace:*' },
      }),
      'apps/web/tsconfig.json': TSCONFIG,
      'apps/web/components.json': json({
        tailwind: { css: '../../packages/ui/src/styles/globals.css' },
        aliases: { components: '@/components', ui: '@workspace/ui/components' },
      }),
    });
    const root = path.join(workspace, 'apps/web');
    const config = await loadConfig({ root });
    expect(config.detected).toBe(
      'components.json (ui: @workspace/ui/components → ../../packages/ui/src/components)',
    );
    expect(config.tokens[0]).toEqual({ path: '../../packages/ui/src/styles/globals.css' });

    const ds = await load(root);
    // The default excludes apply outside the root too.
    expect(ds.components.map((c) => c.name).sort()).toEqual(['Button', 'Input']);
    expect(ds.getComponent('Button')?.importPath).toBe('@workspace/ui/components/button');
    // `*` in an export spans folders.
    expect(ds.getComponent('Input')?.importPath).toBe('@workspace/ui/components/form/input');
    expect(
      ds
        .check(
          `import { Button } from "@workspace/ui/components/button"\n<Button variant="danger" />`,
          'app/page.tsx',
        )
        .diagnostics.map((d) => d.ruleId),
    ).toEqual(['no-unknown-variant']);
  });
});

describe('detectProject: design-system packages', () => {
  const uiPackage = {
    'packages/ui/package.json': json({
      name: '@acme/ui',
      exports: {
        './button': './src/components/button.tsx',
        './card': { types: './src/components/card.d.ts', default: './src/components/card.tsx' },
        './icons': './src/components/icons.tsx',
        './input': './src/components/input.tsx',
        './globals.css': './src/globals.css',
        './cn': './src/utils/cn.ts',
      },
    }),
    'packages/ui/tsconfig.json': TSCONFIG,
    'packages/ui/src/components/button.tsx': BUTTON,
    'packages/ui/src/components/card.tsx': CARD,
    'packages/ui/src/components/icons.tsx': ICONS,
    'packages/ui/src/components/input.tsx': INPUT,
    'packages/ui/src/globals.css': THEME,
    'packages/ui/src/utils/cn.ts': 'export const cn = (...c: string[]) => c.join(" ")\n',
  };

  it('reads a package whose exports point at components, run from inside it', async () => {
    const workspace = fixture(uiPackage);
    const root = path.join(workspace, 'packages/ui');
    const config = await loadConfig({ root });
    expect(config.detected).toBe('package.json exports of @acme/ui');
    expect(config.components).toEqual([
      'src/components/button.tsx',
      'src/components/card.tsx',
      'src/components/icons.tsx',
      'src/components/input.tsx',
    ]);
    expect(config.tokens[0]).toEqual({ path: 'src/globals.css' });
    expect((await load(root)).getComponent('CardHeader')?.importPath).toBe('@acme/ui/card');
  });

  it('finds a workspace dependency named like a UI package, without components.json', async () => {
    const workspace = fixture({
      ...uiPackage,
      'package.json': json({ name: 'acme', private: true, workspaces: ['apps/*', 'packages/*'] }),
      'packages/emails/package.json': json({
        name: '@acme/emails',
        exports: { './a': './a.tsx', './b': './b.tsx', './c': './c.tsx' },
      }),
      'apps/dashboard/package.json': json({
        name: 'dashboard',
        // npm and Yarn classic link workspace packages by plain version ranges.
        dependencies: { '@acme/ui': '*', '@acme/emails': '*', react: '^19' },
      }),
      'apps/dashboard/tsconfig.json': TSCONFIG,
    });
    const root = path.join(workspace, 'apps/dashboard');
    const config = await loadConfig({ root });
    // `@acme/emails` exports components too, but is not named like a design system.
    expect(config.detected).toBe('workspace package @acme/ui');

    const ds = await load(root);
    expect(ds.getComponent('Button')?.importPath).toBe('@acme/ui/button');
    const code = `import { Button } from "@acme/ui/button"
import { Icons } from "@acme/ui/icons"
import { Stack } from "@acme/ui/stack"
export default () => <><button>Save</button><Button aria-label="Add"><Icons.Add /></Button><Stack /></>`;
    const diagnostics = ds.check(code, 'app/page.tsx').diagnostics;
    expect(diagnostics.map((d) => [d.ruleId, d.source])).toEqual([
      ['prefer-design-system-component', 'button'],
      ['no-unknown-component', 'Stack'],
    ]);
    expect(diagnostics[0]?.message).toContain('import { Button } from "@acme/ui/button"');
  });

  it("keeps an app's own components next to the workspace package's", async () => {
    const workspace = fixture({
      ...uiPackage,
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
      'apps/web/package.json': json({ name: 'web', dependencies: { '@acme/ui': 'workspace:*' } }),
      'apps/web/tsconfig.json': TSCONFIG,
      'apps/web/components/ui/sheet.tsx': `export function Sheet(props: { children?: unknown }) { return <div /> }\n`,
    });
    const ds = await load(path.join(workspace, 'apps/web'));
    expect(ds.getComponent('Sheet')?.importPath).toBe('@/components/ui/sheet');
    expect(ds.getComponent('Button')?.importPath).toBe('@acme/ui/button');
  });

  it('imports from the package name when a workspace package has its own components.json', async () => {
    const workspace = fixture({
      'pnpm-workspace.yaml': 'packages: [apps/*, packages/*]\n',
      'packages/ui/package.json': json({ name: '@acme/ui', exports: { '.': './src/index.ts' } }),
      'packages/ui/tsconfig.json': TSCONFIG,
      'packages/ui/components.json': json({ aliases: { ui: '@/components/ui' } }),
      'packages/ui/components/ui/button.tsx': BUTTON,
      'packages/ui/src/index.ts': 'export * from "../components/ui/button"\n',
      'apps/web/package.json': json({ name: 'web', dependencies: { '@acme/ui': 'workspace:*' } }),
    });
    const root = path.join(workspace, 'apps/web');
    expect((await loadConfig({ root })).detected).toBe(
      'workspace package @acme/ui (components.json ui: @/components/ui → ../../packages/ui/components/ui)',
    );
    expect((await load(root)).getComponent('Button')?.importPath).toBe('@acme/ui');
  });

  it('handles * inside a file name, unbuilt stylesheets, and globs that match nothing', async () => {
    const root = fixture({
      'package.json': json({
        name: '@acme/ui',
        exports: { './*': './src/ui-*.tsx', './styles.css': './dist/styles.css' },
      }),
      'src/ui-button.tsx': BUTTON,
      'src/globals.css': THEME,
    });
    const config = await loadConfig({ root });
    expect(config.components).toEqual(['src/ui-*.tsx']);
    // dist/styles.css is not built: fall back to the source stylesheet.
    expect(config.tokens[0]).toEqual({ path: 'src/globals.css' });
    expect((await load(root)).getComponent('Button')?.importPath).toBe('@acme/ui/button');

    // components.json pointing at an empty folder: keep the defaults.
    const empty = fixture({
      'tsconfig.json': TSCONFIG,
      'components.json': json({ aliases: { ui: '@/ui' } }),
      'ui/.gitkeep': '',
      'components/ui/button.tsx': BUTTON,
    });
    const fallback = await loadConfig({ root: empty });
    expect(fallback.detected).toBeUndefined();
    expect((await load(empty)).getComponent('Button')).toBeDefined();
  });

  it('reads tsconfig paths declared in an extended config, relative to that config', async () => {
    const workspace = fixture({
      'tsconfig.base.json': json({
        compilerOptions: { jsx: 'react-jsx', paths: { '@ui/*': ['./libs/ui/src/*'] } },
      }),
      'libs/ui/src/components/button.tsx': BUTTON,
      'apps/web/tsconfig.json': json({ extends: '../../tsconfig.base.json' }),
      'apps/web/components.json': json({ aliases: { ui: '@ui/components' } }),
    });
    const root = path.join(workspace, 'apps/web');
    expect((await loadConfig({ root })).components).toEqual([
      '../../libs/ui/src/components/**/*.{tsx,jsx}',
    ]);
    expect((await load(root)).getComponent('Button')?.importPath).toBe('@ui/components/button');
  });

  it('finds docs next to detected components', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'components.json': json({ aliases: { ui: '@/registry/ui' } }),
      'registry/ui/button.tsx': BUTTON,
      'registry/ui/button.md': '# Button\n\nThe primary action.\n',
    });
    expect((await load(root)).getComponent('Button')?.docs?.file).toBe('registry/ui/button.md');
  });

  it('re-runs detection when components.json changes while watching', async () => {
    const root = fixture({
      'tsconfig.json': TSCONFIG,
      'components.json': json({ aliases: { ui: '@/one' } }),
      'one/button.tsx': BUTTON,
      'two/card.tsx': CARD,
    });
    const host = new DesignSystemHost(await loadConfig({ root }), { cache: false });
    expect((await host.get()).getComponent('Button')).toBeDefined();
    const changed = new Promise<boolean>((resolve) => {
      host.onChange((ds) => {
        if (ds.getComponent('Card')) resolve(true);
      });
    });
    host.watch();
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(root, 'components.json'), json({ aliases: { ui: '@/two' } }));
    await expect(changed).resolves.toBe(true);
    host.close();
  }, 15_000);

  it('watches a workspace package outside the root', async () => {
    const workspace = fixture({
      ...uiPackage,
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
      'packages/ui/package.json': json({
        name: '@acme/ui',
        exports: { './*': './src/components/*.tsx' },
      }),
      'apps/web/package.json': json({ name: 'web', dependencies: { '@acme/ui': 'workspace:*' } }),
    });
    const host = new DesignSystemHost(
      await loadConfig({ root: path.join(workspace, 'apps/web') }),
      { cache: false },
    );
    await host.get();
    const changed = new Promise<boolean>((resolve) => {
      host.onChange((ds) => {
        if (ds.getComponent('Chip')) resolve(true);
      });
    });
    host.watch();
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(
      path.join(workspace, 'packages/ui/src/components/chip.tsx'),
      'export function Chip() { return <span /> }\n',
    );
    await expect(changed).resolves.toBe(true);
    host.close();
  }, 15_000);

  it('follows node_modules links to workspace sources, but not to installed packages', () => {
    const workspace = fixture({
      ...uiPackage,
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'apps/web/package.json': json({
        name: 'web',
        dependencies: { '@acme/ui': 'workspace:*', '@vendor/ui': 'workspace:*' },
      }),
      'apps/web/node_modules/@vendor/ui/package.json': json({
        name: '@vendor/ui',
        exports: { './a': './a.tsx', './b': './b.tsx', './c': './c.tsx' },
      }),
    });
    const root = path.join(workspace, 'apps/web');
    // Not in the workspace globs: reachable only through the link.
    fs.mkdirSync(path.join(root, 'node_modules/@acme'), { recursive: true });
    fs.symlinkSync(path.join(workspace, 'packages/ui'), path.join(root, 'node_modules/@acme/ui'));
    const detection = detectProject(root);
    expect(detection?.source).toBe('workspace package @acme/ui');
    expect(detection?.components).toContain('../../packages/ui/src/components/button.tsx');
  });

  it('ignores packages with one or two component exports, and explicit component globs', async () => {
    const root = fixture({
      'package.json': json({ name: 'widget', exports: { '.': './src/widget.tsx' } }),
      'src/widget.tsx': BUTTON,
    });
    expect(detectProject(root)).toBeUndefined();

    const workspace = fixture({
      ...uiPackage,
      'packages/ui/onsystem.config.json': json({
        components: ['src/components/button.tsx'],
      }),
    });
    const config = await loadConfig({ root: path.join(workspace, 'packages/ui') });
    expect(config.detected).toBeUndefined();
    expect(config.components).toEqual(['src/components/button.tsx']);
  });
});

describe('detectProject: packages imported by path', () => {
  // Documenso's layout: `@acme/ui` has no `exports` (`main` is an empty
  // index), and the app imports `@acme/ui/primitives/button` and the like.
  const workspace = () =>
    fixture({
      'package.json': json({ name: 'acme', private: true, workspaces: ['apps/*', 'packages/*'] }),
      'packages/ui/package.json': json({ name: '@acme/ui', main: './index.ts' }),
      'packages/ui/index.ts': 'export {};\n',
      'packages/ui/primitives/button.tsx': BUTTON,
      'packages/ui/primitives/input.tsx': INPUT,
      'packages/ui/primitives/dialog/index.tsx': 'export * from "./dialog";\n',
      'packages/ui/primitives/dialog/dialog.tsx': `export function Dialog(props: { open?: boolean }) { return <div /> }\n`,
      'packages/ui/styles/theme.css': THEME,
      'packages/ui/lib/utils.ts': 'export const cn = (...c: string[]) => c.join(" ");\n',
      'apps/web/package.json': json({ name: 'web', dependencies: { '@acme/ui': '*' } }),
      'apps/web/tsconfig.json': TSCONFIG,
      'apps/web/app/root.tsx': `import "@acme/ui/styles/theme.css"
import { cn } from "@acme/ui/lib/utils"
import { Button } from "@acme/ui/primitives/button"
import { Dialog } from '@acme/ui/primitives/dialog'
export default () => <Dialog><Button className={cn("x")}>Go</Button></Dialog>
`,
    });

  it('takes the components and the theme the app imports, with the specifiers it uses', async () => {
    const root = path.join(workspace(), 'apps/web');
    const config = await loadConfig({ root });
    expect(config.detected).toBe('workspace package @acme/ui, imported by path');
    expect(config.components).toEqual([
      ...DEFAULT_COMPONENTS,
      '../../packages/ui/primitives/button.tsx',
      '../../packages/ui/primitives/dialog/**/*.{tsx,jsx}',
    ]);
    expect(config.tokens[0]).toEqual({ path: '../../packages/ui/styles/theme.css' });

    const ds = await load(root);
    // Input is in the package, but the app does not import it.
    expect(ds.roots().map((c) => [c.name, c.importPath])).toEqual([
      ['Button', '@acme/ui/primitives/button'],
      ['Dialog', '@acme/ui/primitives/dialog'],
    ]);
    const code = `import { Button } from "@acme/ui/primitives/button"
export default () => <><Button variant="danger">Delete</Button><button>Cancel</button></>`;
    const diagnostics = ds.check(code, 'app/page.tsx').diagnostics;
    expect(diagnostics.map((d) => [d.ruleId, d.source])).toEqual([
      ['no-unknown-variant', '"danger"'],
      ['prefer-design-system-component', 'button'],
    ]);
    expect(diagnostics[1]?.message).toContain(
      'import { Button } from "@acme/ui/primitives/button"',
    );
    expect(ds.tokenIndex.has('color')).toBe(true);
  });

  it('reads an importPath pattern from the config', async () => {
    const root = path.join(workspace(), 'apps/web');
    fs.writeFileSync(
      path.join(root, 'onsystem.config.json'),
      json({
        components: ['../../packages/ui/primitives/**/*.tsx'],
        importPath: '@acme/ui/{path}',
      }),
    );
    const ds = await load(root);
    expect(ds.roots().map((c) => [c.name, c.importPath])).toEqual([
      ['Button', '@acme/ui/primitives/button'],
      ['Dialog', '@acme/ui/primitives/dialog/dialog'],
      ['Input', '@acme/ui/primitives/input'],
    ]);
    expect(ds.lint.isDesignSystemImport('@acme/ui/primitives/input')).toBe(true);
    expect(ds.lint.isDesignSystemImport('@acme/icons')).toBe(false);
  });
});

/** A component wrapping React Aria, the way its Tailwind starter writes one per file. */
const racComponent = (name: string, from = 'react-aria-components') => `'use client';
import { ${name} as RAC${name}, type ${name}Props } from "${from}"
export function ${name}(props: ${name}Props) { return <RAC${name} {...props} /> }
`;

const RAC_PACKAGE = json({
  name: 'react-aria-tailwind-starter',
  private: true,
  dependencies: { 'react-aria-components': '^1.14.0', 'tailwind-variants': '^0.3.1' },
});

describe('detectProject: a flat folder of components', () => {
  it("finds a src/ of components that wrap a primitives library, as React Aria's starter has it", async () => {
    const root = fixture({
      'package.json': RAC_PACKAGE,
      // The starter's tsconfig: no path alias, so components are imported by relative path.
      'tsconfig.json': json({
        compilerOptions: { jsx: 'react', moduleResolution: 'bundler', strict: true },
        include: ['src', 'stories'],
      }),
      'src/Button.tsx': racComponent('Button', 'react-aria-components/Button'),
      'src/Checkbox.tsx': racComponent('Checkbox'),
      'src/Dialog.tsx': racComponent('Dialog'),
      'src/Select.tsx': racComponent('Select'),
      'src/Switch.tsx': racComponent('Switch'),
      'src/TextField.tsx': racComponent('TextField'),
      'src/utils.ts': `export const focusRing = "outline-2"\n`,
      'src/index.css': THEME,
      'stories/Button.stories.tsx': `export default { title: "Button" }\n`,
    });
    const config = await loadConfig({ root });
    expect(config.detected).toBe('src/ (6 components wrapping react-aria-components)');
    expect(config.components).toEqual(['src/*.{tsx,jsx}']);
    expect(config.tokens.map((t) => t.path)).toContain('src/index.css');
    const ds = await load(root);
    expect(
      ds
        .roots()
        .map((c) => c.name)
        .sort(),
    ).toEqual(['Button', 'Checkbox', 'Dialog', 'Select', 'Switch', 'TextField']);
    expect(ds.getComponent('Button')?.importPath).toBe('./src/Button');
  });

  it('leaves an app alone when src/ holds its pages and features', () => {
    const page = (name: string) => `import { useNavigate } from "react-router"
import { Card } from "./components/Card"
export function ${name}() { const navigate = useNavigate(); return <Card onClick={() => navigate("/")}>${name}</Card> }
`;
    const app = {
      'package.json': json({
        name: 'acme-app',
        dependencies: {
          react: '^19.0.0',
          'react-router': '^7.0.0',
          '@radix-ui/react-dialog': '^1.1.0',
        },
      }),
      'tsconfig.json': TSCONFIG,
      'src/Dashboard.tsx': page('Dashboard'),
      'src/Settings.tsx': page('Settings'),
      'src/Profile.tsx': page('Profile'),
      'src/Billing.tsx': page('Billing'),
      'src/Team.tsx': page('Team'),
      'src/components/Card.tsx': racComponent('Card', '@radix-ui/react-dialog'),
    };
    // Pages and features import the app's own components, not primitives.
    expect(detectProject(fixture(app))).toBeUndefined();
    // Nor does an app whose src/ also has an entry or a routes folder, whatever else is there.
    const components = Object.fromEntries(
      ['Button', 'Checkbox', 'Dialog', 'Select', 'Switch'].map((name) => [
        `src/${name}.tsx`,
        racComponent(name),
      ]),
    );
    const withRac = { ...app, 'package.json': RAC_PACKAGE, ...components };
    expect(detectProject(fixture({ ...withRac, 'src/main.tsx': 'export {}\n' }))).toBeUndefined();
    expect(detectProject(fixture({ ...withRac, 'src/App.tsx': 'export {}\n' }))).toBeUndefined();
    expect(
      detectProject(fixture({ ...withRac, 'src/routes/index.tsx': 'export {}\n' })),
    ).toBeUndefined();
  });

  it('needs a primitives dependency, five components, and four in five wrapping it', () => {
    const files = (count: number, wrapping: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, i) => {
          const name = `Widget${String(i)}`;
          return [
            `src/${name}.tsx`,
            i < wrapping ? racComponent(name) : `export function ${name}() { return <div /> }\n`,
          ];
        }),
      );
    const project = (extra: Record<string, string>, pkg = RAC_PACKAGE) =>
      fixture({ 'package.json': pkg, 'tsconfig.json': TSCONFIG, ...extra });
    expect(detectProject(project(files(5, 4)))?.source).toBe(
      'src/ (5 components wrapping react-aria-components)',
    );
    expect(detectProject(project(files(4, 4)))).toBeUndefined();
    expect(detectProject(project(files(6, 4)))).toBeUndefined();
    expect(detectProject(project(files(5, 5), json({ name: 'no-primitives' })))).toBeUndefined();
  });
});

describe('workspace helpers', () => {
  it('reads block and flow package lists from pnpm-workspace.yaml', () => {
    expect(
      pnpmPackages(`packages:\n  - "apps/*"   # apps\n  - 'packages/*'\ncatalog:\n  react: ^19\n`),
    ).toEqual(['apps/*', 'packages/*']);
    expect(pnpmPackages('packages: [apps/*, "packages/*"]\n')).toEqual(['apps/*', 'packages/*']);
    expect(
      pnpmPackages(
        'packages: # all of them\n# a comment\n- apps/*\n  # another\n- tools/*\nonlyBuiltDependencies: []\n',
      ),
    ).toEqual(['apps/*', 'tools/*']);
    expect(pnpmPackages('catalog:\n  react: ^19\n')).toEqual([]);
  });

  it('recognises design-system package names', () => {
    for (const name of [
      '@acme/ui',
      '@repo/ui',
      '@acme/ui-kit',
      '@acme/uikit',
      '@acme/design-system',
      'acme-ui',
      '@acme/primitives',
      '@acme/components',
    ]) {
      expect([name, isDesignSystemName(name)]).toEqual([name, true]);
    }
    for (const name of ['@acme/email-components', '@acme/utils', 'react', '@acme/build', 'tui']) {
      expect([name, isDesignSystemName(name)]).toEqual([name, false]);
    }
  });
});

describe('package sources behind dist/ and barrels', () => {
  const tsup = `import { defineConfig } from "tsup";
export default defineConfig({ entry: { index: "src/index.tsx", "icons/index": "src/icons/index.tsx" }, dts: true });
`;
  // Dub's @dub/ui: exports point at dist/, built by tsup from src/, through barrels.
  const dub = {
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
    'packages/ui/package.json': json({
      name: '@dub/ui',
      main: './dist/index.js',
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.mjs' },
        './icons': { types: './dist/icons/index.d.ts', import: './dist/icons/index.mjs' },
      },
    }),
    'packages/ui/tsup.config.ts': tsup,
    'packages/ui/src/index.tsx': `export * from "./button";\nexport * from "./card";\nexport { Input } from "./input";\nexport * from "./icons";\n`,
    'packages/ui/src/button.tsx': BUTTON,
    'packages/ui/src/card.tsx': CARD,
    'packages/ui/src/input.tsx': INPUT,
    'packages/ui/src/internal.tsx': `export function NotExported() { return <div /> }\n`,
    'packages/ui/src/icons/index.tsx': `export * from "./trash";\n`,
    'packages/ui/src/icons/trash.tsx': `export function Trash() { return <svg /> }\n`,
    'apps/web/package.json': json({ name: 'web', dependencies: { '@dub/ui': 'workspace:*' } }),
    'apps/web/app/page.tsx': `import { Button } from "@dub/ui";\nexport default () => <Button />;\n`,
  };

  it('reads a build config entry without running it', () => {
    const root = fixture({
      'tsup.config.ts': tsup,
      'vite.config.ts': `export default { build: { lib: { entry: resolve(__dirname, "src/main.ts") } } }`,
    });
    expect(buildEntries(root)).toEqual({
      byOutput: new Map([
        ['index', 'src/index.tsx'],
        ['icons/index', 'src/icons/index.tsx'],
      ]),
      single: undefined,
      from: 'tsup.config.ts',
    });
    const vite = fixture({
      'vite.config.mts': `import { fileURLToPath } from "node:url";
export default { build: { lib: { entry: fileURLToPath(new URL("./src/main.ts", import.meta.url)) } } }`,
      'src/main.ts': 'export {}',
    });
    expect(buildEntries(vite).single).toBe('src/main.ts');
    expect(sourceTarget(vite, '.', './dist/my-lib.js', buildEntries(vite))).toBe('src/main.ts');
    // Without an entry: the same path under src/, and `.` from src/index.
    const plain = fixture({ 'src/index.ts': '', 'src/icons/index.tsx': '' });
    expect(sourceTarget(plain, './icons', './dist/icons/index.mjs', { byOutput: new Map() })).toBe(
      'src/icons/index.tsx',
    );
    expect(sourceTarget(plain, '.', './build/main.cjs', { byOutput: new Map() })).toBe(
      'src/index.ts',
    );
    expect(
      sourceTarget(plain, './missing', './dist/missing.js', { byOutput: new Map() }),
    ).toBeUndefined();
    expect(sourceTarget(plain, '.', './src/index.ts', { byOutput: new Map() })).toBe(
      'src/index.ts',
    );
  });

  it('follows barrels to the files they re-export, inside the package only', () => {
    const root = fixture({
      'pkg/index.ts': `export * from "./a";\nexport { B } from "./b";\nimport { C } from "./c";\nexport { C };\nexport * from "../outside";\nexport type { T } from "./types";\n`,
      'pkg/a.tsx': 'export const A = () => null;',
      'pkg/b.tsx': 'export const B = () => null;',
      'pkg/c/index.ts': 'export * from "./c";',
      'pkg/c/c.tsx': 'export const C = () => null;',
      'pkg/types.ts': 'export type T = string;',
      'outside.tsx': 'export const O = () => null;',
    });
    const files = exportedFiles(path.join(root, 'pkg/index.ts'), path.join(root, 'pkg'));
    expect(files.map((f) => path.relative(root, f)).sort()).toEqual(
      [path.join('pkg', 'a.tsx'), path.join('pkg', 'b.tsx'), path.join('pkg', 'c', 'c.tsx')].sort(),
    );
  });

  it("finds Dub's @dub/ui through dist/ → src/ and its barrels, imported by the package name", async () => {
    const root = fixture(dub);
    const config = await loadConfig({ root: path.join(root, 'apps/web') });
    expect(config.detected).toBe('workspace package @dub/ui');
    const ds = await load(path.join(root, 'apps/web'));
    expect(ds.roots().map((c) => [c.name, c.importPath])).toEqual([
      ['Button', '@dub/ui'],
      ['Card', '@dub/ui'],
      ['Trash', '@dub/ui'],
      ['Input', '@dub/ui'],
    ]);
    // A file the package does not export is no part of it.
    expect(ds.getComponent('NotExported')).toBeUndefined();
    // The package itself, from its folder.
    expect((await loadConfig({ root: path.join(root, 'packages/ui') })).detected).toBe(
      'package.json exports of @dub/ui',
    );
  });

  it("follows per-component index.ts barrels, as @calcom/ui's exports are", async () => {
    const root = fixture({
      'package.json': json({
        name: '@calcom/ui',
        exports: {
          './components/button': './components/button/index.ts',
          './components/card': './components/card/index.ts',
          './components/input': './components/input/index.ts',
        },
      }),
      'components/button/index.ts': `export { Button } from "./Button";\nexport { SplitButton } from "./SplitButton";\n`,
      'components/button/Button.tsx': BUTTON,
      'components/button/SplitButton.tsx': `export function SplitButton() { return <div /> }\n`,
      'components/card/index.ts': `export * from "./Card";\n`,
      'components/card/Card.tsx': CARD,
      'components/input/index.ts': `export { Input } from "./Input";\n`,
      'components/input/Input.tsx': INPUT,
    });
    const ds = await load(root);
    expect(ds.roots().map((c) => [c.name, c.importPath])).toEqual([
      ['Button', '@calcom/ui/components/button'],
      ['SplitButton', '@calcom/ui/components/button'],
      ['Card', '@calcom/ui/components/card'],
      ['Input', '@calcom/ui/components/input'],
    ]);
  });

  it('does not take a package of .ts modules behind a barrel for a design system', () => {
    const root = fixture({
      'package.json': json({
        name: '@acme/db',
        exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      }),
      'src/index.ts': `export * from "./client";\nexport * from "./schema";\nexport * from "./queries";\n`,
      'src/client.ts': 'export const db = {};',
      'src/schema.ts': 'export const users = {};',
      'src/queries.ts': 'export const getUser = () => null;',
    });
    expect(detectProject(root)).toBeUndefined();
  });
});

describe('detectProject: several design systems', () => {
  // cal.com's apps/web: components.json points at @coss/ui, and it depends on @calcom/ui too.
  const calcom = {
    'package.json': json({ name: 'root', workspaces: ['apps/*', 'packages/*'] }),
    'packages/coss-ui/package.json': json({
      name: '@coss/ui',
      exports: { './components/*': './src/components/*.tsx' },
    }),
    'packages/coss-ui/src/components/button.tsx': `export function Button(props: { variant?: "default" | "ghost" }) { return <button /> }\n`,
    'packages/coss-ui/src/components/separator.tsx': `export function Separator() { return <hr /> }\n`,
    'packages/ui/package.json': json({
      name: '@calcom/ui',
      exports: {
        './components/button': './components/button/index.ts',
        './components/divider': './components/divider/index.ts',
        './components/badge': './components/badge/index.ts',
      },
    }),
    'packages/ui/components/button/index.ts': 'export { Button } from "./Button";\n',
    'packages/ui/components/button/Button.tsx': `export function Button(props: { variant?: "icon" | "button"; children?: unknown }) { return <button /> }\n`,
    'packages/ui/components/divider/index.ts': 'export { Divider } from "./Divider";\n',
    'packages/ui/components/divider/Divider.tsx': `export function Divider() { return <hr /> }\n`,
    'packages/ui/components/badge/index.ts': 'export { Badge } from "./Badge";\n',
    'packages/ui/components/badge/Badge.tsx': `export function Badge() { return <span /> }\n`,
    'apps/web/package.json': json({
      name: 'web',
      dependencies: { '@calcom/ui': 'workspace:*', '@coss/ui': 'workspace:*' },
    }),
    'apps/web/components.json': json({ aliases: { ui: '@coss/ui/components' } }),
    'apps/web/a.tsx': `import { Button } from "@calcom/ui/components/button";\nimport { Badge } from "@calcom/ui/components/badge";\nexport const A = () => <Button variant="icon"><Badge /></Button>;\n`,
    'apps/web/b.tsx': `import { Button } from "@coss/ui/components/button";\nexport const B = () => <Button variant="ghost" />;\n`,
  };

  it('adds workspace design-system packages to components.json, the most imported first', async () => {
    const root = fixture(calcom);
    const web = path.join(root, 'apps/web');
    const config = await loadConfig({ root: web });
    expect(config.detected).toBe(
      'primary: workspace package @calcom/ui (2 imports); also: components.json (ui: @coss/ui/components → ../../packages/coss-ui/src/components) (1 import)',
    );
    expect(config.designSystems?.map((d) => [d.source, d.imports])).toEqual([
      ['workspace package @calcom/ui', 2],
      ['components.json (ui: @coss/ui/components → ../../packages/coss-ui/src/components)', 1],
    ]);
    const ds = await load(web);
    // Both are checked, each import against its own Button.
    const variants = (code: string) =>
      ds
        .check(code, 'c.tsx')
        .diagnostics.filter((d) => d.ruleId === 'no-unknown-variant')
        .map((d) => d.message);
    expect(
      variants(`import { Button } from "@calcom/ui/components/button"\n<Button variant="icon" />`),
    ).toEqual([]);
    expect(
      variants(`import { Button } from "@coss/ui/components/button"\n<Button variant="icon" />`),
    ).toEqual(['"icon" is not a valid variant for <Button>. Allowed: default, ghost.']);
    // The primary's components win a shared name and are the ones suggested.
    expect(ds.getComponent('Button')?.importPath).toBe('@calcom/ui/components/button');
    const [hr] = ds.check('<hr />', 'c.tsx').diagnostics;
    expect(hr?.suggestion).toBe('<Divider>');
  });
});
