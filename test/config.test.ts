import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  ConfigError,
  configJsonSchema,
  DEFAULT_COMPONENTS,
  loadConfig,
  nodeRunsTypeScript,
  rulesFor,
} from '../src/config.js';
import { matchesGlob } from '../src/util/paths.js';
import { ACME_ROOT, DEMO_ROOT, fixture, load } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-config-'));
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('finds the config file in the root and resolves rule settings', async () => {
    const config = await loadConfig({ root: ACME_ROOT });
    expect(config.configFile).toBe(path.join(ACME_ROOT, 'onsystem.config.json'));
    expect(config.tokens).toEqual([{ path: 'tokens/*.tokens.json', prefix: 'acme' }]);
    expect(config.rules['no-hardcoded-spacing']).toEqual({ severity: 'error', options: {} });
    expect(config.rules['no-hardcoded-radius']).toEqual({
      severity: 'warn',
      options: { allow: ['9999px'] },
    });
    expect(config.rules['no-unknown-prop'].severity).toBe('error');
  });

  it('uses the config file directory as the root when given --config', async () => {
    const config = await loadConfig({
      cwd: '/',
      config: path.join(DEMO_ROOT, 'onsystem.config.json'),
    });
    expect(config.root).toBe(DEMO_ROOT);
  });

  it('falls back to shadcn-friendly defaults without a config', async () => {
    const config = await loadConfig({ cwd: tmp });
    expect(config.root).toBe(tmp);
    expect(config.configFile).toBeUndefined();
    expect(config.components).toEqual(DEFAULT_COMPONENTS);
    expect(config.tokens.map((t) => t.path)).toContain('app/globals.css');
  });

  it('lets CLI flags override the file', async () => {
    const config = await loadConfig({
      root: ACME_ROOT,
      components: ['src/**/*.tsx'],
      tokens: ['tokens/acme.tokens.json'],
    });
    expect(config.components).toEqual(['src/**/*.tsx']);
    expect(config.tokens).toEqual([{ path: 'tokens/acme.tokens.json' }]);
  });

  it('still reads a config under its name from before the rename, and says how to rename it', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'legacy-'));
    fs.writeFileSync(
      path.join(dir, 'design-system-mcp.config.json'),
      '{ "components": ["ui/**/*.tsx"] }',
    );
    const legacy = await loadConfig({ root: dir });
    expect(legacy.configFile).toBe(path.join(dir, 'design-system-mcp.config.json'));
    expect(legacy.components).toEqual(['ui/**/*.tsx']);
    expect(legacy.deprecations).toEqual([
      "design-system-mcp.config.json is the config's name from before design-system-mcp became onsystem. Rename it to onsystem.config.json (git mv design-system-mcp.config.json onsystem.config.json); the old name still works for now.",
    ]);

    // With both, the new name wins and the old file is called out.
    fs.writeFileSync(path.join(dir, 'onsystem.config.json'), '{ "components": ["src/**/*.tsx"] }');
    const both = await loadConfig({ root: dir });
    expect(both.configFile).toBe(path.join(dir, 'onsystem.config.json'));
    expect(both.components).toEqual(['src/**/*.tsx']);
    expect(both.deprecations).toEqual([
      'design-system-mcp.config.json is ignored: onsystem.config.json is read instead. Delete design-system-mcp.config.json.',
    ]);

    // Named outright, a file is read as it is, with nothing to say.
    const named = await loadConfig({ cwd: dir, config: 'design-system-mcp.config.json' });
    expect(named.components).toEqual(['ui/**/*.tsx']);
    expect(named.deprecations).toBeUndefined();
    expect((await loadConfig({ root: ACME_ROOT })).deprecations).toBeUndefined();
  });

  it('points a code config that imports the old package name at onsystem', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'legacy-import-'));
    fs.writeFileSync(
      path.join(dir, 'onsystem.config.mjs'),
      "import { defineConfig } from '@dgesteves/design-system-mcp';\nexport default defineConfig({});\n",
    );
    await expect(loadConfig({ root: dir })).rejects.toThrow(
      "The package is now onsystem: import { defineConfig } from 'onsystem'.",
    );
  });

  it('loads TypeScript configs', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'ts-'));
    fs.writeFileSync(
      path.join(dir, 'onsystem.config.ts'),
      `const config: { components: string[] } = { components: ["ui/**/*.tsx"] };\nexport default config;\n`,
    );
    expect((await loadConfig({ root: dir })).components).toEqual(['ui/**/*.tsx']);
  });

  it('knows which Node.js versions run a TypeScript config', () => {
    // The package runs on Node.js 20.19; only a .ts config needs type stripping.
    for (const [version, runs] of [
      ['20.19.0', false],
      ['v20.20.1', false],
      ['22.17.1', false],
      ['22.18.0', true],
      ['23.5.0', false],
      ['23.6.0', true],
      ['24.0.0', true],
    ] as const) {
      expect([version, nodeRunsTypeScript(version)]).toEqual([version, runs]);
    }
  });

  it('rejects invalid configs with a readable message', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'bad-'));
    fs.writeFileSync(
      path.join(dir, 'onsystem.config.json'),
      JSON.stringify({ components: 3, rules: { 'no-such-rule': 'error' } }),
    );
    const error = await loadConfig({ root: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/components/);
    await expect(loadConfig({ config: path.join(dir, 'missing.json') })).rejects.toThrow(
      /not found/,
    );
  });

  it('reads `libraries`: every supported library when omitted, none with false, or those listed', async () => {
    // A project that depends on MUI (not installed here: the setting is what is tested).
    const project = (config?: unknown) => {
      const dir = fs.mkdtempSync(path.join(tmp, 'libraries-'));
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ dependencies: { '@mui/material': '^9.4.0' } }),
      );
      if (config !== undefined) {
        fs.writeFileSync(path.join(dir, 'onsystem.config.json'), JSON.stringify(config));
      }
      return dir;
    };
    const mui = [{ package: '@mui/material', dir: undefined, version: undefined }];

    const omitted = await loadConfig({ root: project() });
    expect(omitted).toMatchObject({ libraries: mui, librariesOff: [] });
    expect(omitted.libraryIds).toBeUndefined();
    expect(await loadConfig({ root: project({ libraries: false }) })).toMatchObject({
      libraryIds: false,
      libraries: [],
      librariesOff: mui,
    });
    expect(await loadConfig({ root: project({ libraries: ['mui'] }) })).toMatchObject({
      libraryIds: ['mui'],
      libraries: mui,
      librariesOff: [],
    });
    expect(await loadConfig({ root: project({ libraries: [] }) })).toMatchObject({
      libraries: [],
      librariesOff: mui,
    });

    await expect(loadConfig({ root: project({ libraries: ['chakra'] }) })).rejects.toThrow(
      'Unknown library "chakra". Expected one of: mui.',
    );
    await expect(loadConfig({ root: project({ libraries: ['MUI'] }) })).rejects.toThrow(
      'Unknown library "MUI". Did you mean "mui"?',
    );
    for (const value of [true, 'mui']) {
      await expect(loadConfig({ root: project({ libraries: value }) })).rejects.toThrow(
        '"libraries" is false, to read no library, or a list of the ones to read: ["mui"].',
      );
    }
  });

  it('names unknown keys, rules and severities, with the closest valid one', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'typo-'));
    fs.writeFileSync(
      path.join(dir, 'onsystem.config.json'),
      JSON.stringify({
        component: ['ui/**/*.tsx'],
        rules: {
          'no-hardcoded-colors': 'error',
          'no-hardcoded-spacing': 'warning',
          'no-unknown-prop': ['warn', { alow: ['tone'] }],
        },
      }),
    );
    const message = await loadConfig({ root: dir }).catch((e: unknown) => (e as Error).message);
    expect(message).toContain('Unknown config key "component". Did you mean "components"?');
    expect(message).toContain(
      'Unknown rule "no-hardcoded-colors". Did you mean "no-hardcoded-color"?',
    );
    expect(message).toContain(
      'Invalid severity "warning": use "off", "warn" or "error" (did you mean "warn"?).',
    );
    expect(message).toContain('Unknown rule option "alow". Did you mean "allow"?');
  });

  it('applies overrides to the files they match, in order, and validates them', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'overrides-'));
    const write = (config: unknown) => {
      fs.writeFileSync(path.join(dir, 'onsystem.config.json'), JSON.stringify(config));
    };
    write({
      rules: { 'no-hardcoded-spacing': 'error' },
      overrides: [
        { files: ['app/legacy/**', 'generated/*.tsx'], rules: { 'no-hardcoded-color': 'off' } },
        {
          files: 'app/legacy/old.tsx',
          rules: { 'no-hardcoded-spacing': ['warn', { allow: ['13px'] }] },
        },
      ],
    });
    const config = await loadConfig({ root: dir });
    const severity = (file: string) => [
      rulesFor(config, file)['no-hardcoded-color'].severity,
      rulesFor(config, file)['no-hardcoded-spacing'],
    ];
    expect(severity('app/page.tsx')).toEqual(['error', { severity: 'error', options: {} }]);
    expect(severity('app/legacy/card/image.tsx')).toEqual([
      'off',
      { severity: 'error', options: {} },
    ]);
    expect(severity('./generated/welcome.tsx')[0]).toBe('off');
    expect(severity('generated/nested/welcome.tsx')[0]).toBe('error');
    expect(severity('app/legacy/old.tsx')).toEqual([
      'off',
      { severity: 'warn', options: { allow: ['13px'] } },
    ]);

    write({ overrides: [{ file: ['app/legacy/**'], rules: { 'no-hardcoded-colour': 'off' } }] });
    const message = await loadConfig({ root: dir }).catch((e: unknown) => (e as Error).message);
    expect(message).toContain('Unknown override key "file". Did you mean "files"?');
    expect(message).toContain(
      'Unknown rule "no-hardcoded-colour". Did you mean "no-hardcoded-color"?',
    );
  });

  it('matches globs without the disk, for code not saved yet', () => {
    const cases: [string, string, boolean][] = [
      ['app/og/route.tsx', 'app/og/**', true],
      ['app/og', 'app/og/**', false],
      ['app/page.tsx', '**/*.tsx', true],
      ['page.tsx', '**/*.tsx', true],
      ['app/page.jsx', 'app/*.{tsx,jsx}', true],
      ['app/nested/page.tsx', 'app/*.tsx', false],
      ['app/(marketing)/page.tsx', 'app/\\(marketing\\)/*.tsx', true],
      ['src/a1.tsx', 'src/a[0-9].tsx', true],
      ['src/ab.tsx', 'src/a[!b].tsx', false],
      ['emails/x.email.tsx', '**/*.email.{tsx,jsx}', true],
      ['app/x.tsx', 'app/?.tsx', true],
    ];
    for (const [file, glob, expected] of cases) {
      expect([file, glob, matchesGlob(file, glob)]).toEqual([file, glob, expected]);
    }
  });

  it('rejects a missing root and token files named outright, but not globs', async () => {
    await expect(loadConfig({ root: path.join(tmp, 'nope') })).rejects.toThrow(
      `Project root not found: ${path.join(tmp, 'nope')}`,
    );
    await expect(loadConfig({ root: ACME_ROOT, tokens: ['styles/missing.css'] })).rejects.toThrow(
      `Token file not found: ${path.join(ACME_ROOT, 'styles/missing.css')} (from --tokens)`,
    );
    expect((await loadConfig({ root: ACME_ROOT, tokens: ['styles/*.css'] })).tokens).toEqual([
      { path: 'styles/*.css' },
    ]);
  });

  it('reads Windows-style paths, keeping glob escapes in slash-separated patterns', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'win-'));
    fs.writeFileSync(path.join(dir, 'tsconfig.app.json'), '{}');
    fs.mkdirSync(path.join(dir, 'app'));
    fs.writeFileSync(path.join(dir, 'app/globals.css'), '');
    fs.writeFileSync(
      path.join(dir, 'onsystem.config.json'),
      JSON.stringify({
        tsconfig: '.\\tsconfig.app.json',
        components: 'components\\ui\\**\\*.tsx',
        tokens: ['app\\globals.css', { path: 'tokens\\*.tokens.json', prefix: 'acme' }],
        docs: ['docs\\**\\*.md'],
        exclude: ['**\\*.stories.tsx', 'app/\\(marketing\\)/**'],
      }),
    );
    expect(await loadConfig({ root: dir, docs: ['guides\\*.mdx'] })).toMatchObject({
      tsconfig: './tsconfig.app.json',
      components: ['components/ui/**/*.tsx'],
      tokens: [{ path: 'app/globals.css' }, { path: 'tokens/*.tokens.json', prefix: 'acme' }],
      docs: ['guides/*.mdx'],
      exclude: ['**/*.stories.tsx', 'app/\\(marketing\\)/**'],
    });
  });

  it('rejects a tsconfig that does not exist instead of ignoring it', async () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'tsconfig-'));
    fs.writeFileSync(
      path.join(dir, 'onsystem.config.json'),
      JSON.stringify({ tsconfig: 'tsconfig.app.json' }),
    );
    const error = await loadConfig({ root: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toContain(
      `tsconfig not found: ${path.join(dir, 'tsconfig.app.json')}`,
    );
  });

  it('resolves path aliases through a Windows-style tsconfig path', async () => {
    const root = fixture({
      'onsystem.config.json': JSON.stringify({
        tsconfig: '.\\tsconfig.app.json',
        components: 'components\\ui\\*.tsx',
        tokens: [],
      }),
      'tsconfig.app.json': JSON.stringify({
        compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./*'] } },
      }),
      'components/ui/button.tsx': `export function Button(props: { variant?: "default" | "ghost" }) {
  return <button data-variant={props.variant} />
}`,
    });
    const ds = await load(root);
    expect(ds.getComponent('Button')?.importPath).toBe('@/components/ui/button');
    const { diagnostics } = ds.check(
      `import { Button } from "@/components/ui/button"\n<Button variant="danger" />`,
    );
    expect(diagnostics.map((d) => d.ruleId)).toEqual(['no-unknown-variant']);
  });

  it('exports a JSON Schema for editors', () => {
    const schema = configJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['components', 'tokens', 'docs', 'rules', 'importPath']),
    );
    expect(schema.properties.libraries).toMatchObject({
      anyOf: [
        { type: 'boolean', const: false },
        { type: 'array', items: { type: 'string', enum: ['mui'] } },
      ],
    });
    // The schema.json the package ships is the one the build writes from it.
    const shipped = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '../schema.json'), 'utf8'),
    ) as { properties: Record<string, unknown> };
    expect(shipped.properties).toEqual(schema.properties);
  });
});
