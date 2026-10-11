import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { parseColor } from '../src/tokens/color.js';
import {
  parseCssTokens,
  parseDesignMd,
  parseDtcgTokens,
  toDesignMd,
  toDtcg,
  TokenIndex,
} from '../src/tokens/index.js';
import { TOKEN_CATEGORIES, type CheckResult, type Token } from '../src/types.js';
import { DEMO_ROOT, fixture } from './helpers.js';

async function run(args: string[], cwd = DEMO_ROOT) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { cwd, color: false, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  const code = await main(args, io);
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

const demoCss = fs.readFileSync(path.join(DEMO_ROOT, 'app/globals.css'), 'utf8');
const demo = parseCssTokens(demoCss, 'app/globals.css').tokens;

type Tree = Record<string, Record<string, Record<string, unknown>>>;

describe('export --format dtcg', () => {
  const { text, count, warnings } = toDtcg(demo);
  const json = JSON.parse(text) as Tree;

  it('groups tokens by category, with 2025.10 color objects and { value, unit } sizes', () => {
    expect(warnings).toEqual([]);
    expect(count).toBe(demo.length);
    expect(Object.keys(json)).toEqual(['color', 'spacing', 'radius', 'typography']);
    expect(json.color?.destructive).toEqual({
      $type: 'color',
      $value: { colorSpace: 'oklch', components: [0.577, 0.245, 27.325] },
      $description: 'Errors and irreversible actions.',
      $extensions: {
        'com.github.dgesteves.onsystem': {
          cssVar: '--destructive',
          tailwind: '--color-destructive',
          modes: { dark: { colorSpace: 'oklch', components: [0.704, 0.191, 22.216] } },
        },
      },
    });
    expect(json.color?.border?.$extensions).toMatchObject({
      'com.github.dgesteves.onsystem': {
        modes: { dark: { colorSpace: 'oklch', components: [1, 0, 0], alpha: 0.1 } },
      },
    });
    // `--radius` is `rounded-lg`; `rounded-sm` is `calc(var(--radius) - 4px)`, so 6px.
    expect(json.radius?.lg).toMatchObject({
      $type: 'dimension',
      $value: { value: 0.625, unit: 'rem' },
    });
    expect(json.radius?.sm).toEqual({
      $type: 'dimension',
      $value: { value: 6, unit: 'px' },
      $extensions: { 'com.github.dgesteves.onsystem': { tailwind: '--radius-sm' } },
    });
    // Tailwind's spacing unit is the spacing group's own value.
    expect(json.spacing?.$root).toMatchObject({
      $value: { value: 0.25, unit: 'rem' },
      $extensions: {
        'com.github.dgesteves.onsystem': { cssVar: '--spacing', tailwind: '--spacing' },
      },
    });
    expect(json.typography?.['font-sans']).toMatchObject({
      $type: 'fontFamily',
      $value: 'var(--font-geist-sans)',
    });
  });

  it('keeps aliases as references, writes sRGB hex and leaves what DTCG cannot type as strings', () => {
    const { tokens } = parseCssTokens(
      `:root {
  --background: #ffffff;
  --card: var(--background);
  --brand: rgb(59 130 246);
  --ink: var(--color-neutral-800);
  --overlay: color-mix(in oklch, black 40%, transparent);
  --shadow-card: 0 1px 2px 0 rgb(0 0 0 / 0.05), inset 0 0 0 1px #e5e5e5;
  --leading-tight: 1.25;
  --font-weight-bold: 700;
}`,
      'a.css',
    );
    expect(tokens.find((t) => t.name === 'card')?.aliasOf).toBe('background');
    // A Tailwind palette color is no token of the project.
    expect(tokens.find((t) => t.name === 'ink')?.aliasOf).toBeUndefined();
    const out = JSON.parse(toDtcg(tokens).text) as Tree;
    expect(out.color?.card).toMatchObject({ $type: 'color', $value: '{color.background}' });
    expect(out.color?.brand?.$value).toEqual({
      colorSpace: 'srgb',
      components: [0.231373, 0.509804, 0.964706],
      hex: '#3b82f6',
    });
    expect(out.other?.overlay).toEqual({
      $value: 'color-mix(in oklch, black 40%, transparent)',
      $extensions: { 'com.github.dgesteves.onsystem': { cssVar: '--overlay' } },
    });
    expect(out.shadow?.card).toMatchObject({
      $type: 'shadow',
      $value: [
        {
          color: { colorSpace: 'srgb', components: [0, 0, 0], alpha: 0.05 },
          offsetX: { value: 0, unit: 'px' },
          offsetY: { value: 1, unit: 'px' },
          blur: { value: 2, unit: 'px' },
          spread: { value: 0, unit: 'px' },
        },
        {
          color: { colorSpace: 'srgb', components: [0.898039, 0.898039, 0.898039], hex: '#e5e5e5' },
          offsetX: { value: 0, unit: 'px' },
          offsetY: { value: 0, unit: 'px' },
          blur: { value: 0, unit: 'px' },
          spread: { value: 1, unit: 'px' },
          inset: true,
        },
      ],
    });

    const back = parseDtcgTokens(toDtcg(tokens).text, 'tokens.json');
    expect(back.warnings).toEqual([]);
    expect(back.tokens.find((t) => t.name === 'color.card')).toMatchObject({
      value: '#ffffff',
      aliasOf: 'color.background',
      cssVar: '--card',
    });
    expect(back.tokens.find((t) => t.name === 'shadow.card')?.value).toBe(
      '0px 1px 2px 0px rgb(0 0 0 / 0.05), inset 0px 0px 0px 1px #e5e5e5',
    );
  });

  it('reads back as the same tokens: values, modes, custom properties and Tailwind classes', () => {
    const back = parseDtcgTokens(text, 'design.tokens.json');
    expect(back.warnings).toEqual([]);
    expect(back.tokens).toHaveLength(demo.length);
    const index = new TokenIndex(demo);
    const again = new TokenIndex(back.tokens);
    // The file is grouped by category; within one, tokens keep their order.
    const ordered = TOKEN_CATEGORIES.flatMap((c) => demo.filter((t) => t.category === c));
    ordered.forEach((token, i) => {
      const read = back.tokens[i] as Token;
      expect(read.category, token.name).toBe(token.category);
      expect(read.cssVar, token.name).toBe(token.cssVar);
      expect(read.tailwind, token.name).toBe(token.tailwind);
      expect(read.usage, token.name).toEqual(token.usage);
      expect(Object.keys(read.modes ?? {}), token.name).toEqual(Object.keys(token.modes ?? {}));
      if (token.category === 'color') {
        const [a, b] = [parseColor(token.value), parseColor(read.value)];
        expect(a && b && Math.abs(a.l - b.l) + Math.abs(a.c - b.c), token.name).toBeLessThan(1e-6);
      } else {
        expect(again.toPx(read.value), token.name).toBe(index.toPx(token.value));
      }
    });
  });

  it('gives the shadcn demo the same findings from the exported file as from globals.css', async () => {
    // A copy of the demo whose config reads the exported file instead of the stylesheet.
    const files: Record<string, string> = {};
    for (const file of ['tsconfig.json', 'package.json', 'lib/utils.ts']) {
      files[file] = fs.readFileSync(path.join(DEMO_ROOT, file), 'utf8');
    }
    for (const dir of ['components/ui', 'app/settings']) {
      for (const name of fs.readdirSync(path.join(DEMO_ROOT, dir))) {
        files[`${dir}/${name}`] = fs.readFileSync(path.join(DEMO_ROOT, dir, name), 'utf8');
      }
    }
    files['onsystem.config.json'] = JSON.stringify({
      components: ['components/ui/**/*.tsx'],
      tokens: ['design.tokens.json'],
    });
    const root = fixture(files, { nodeModules: true });

    const exported = await run([
      'export',
      '--format',
      'dtcg',
      '--out',
      path.join(root, 'design.tokens.json'),
      '--no-cache',
    ]);
    expect(exported).toMatchObject({ code: 0, stderr: '' });
    expect(exported.stdout).toMatch(
      /^Wrote 31 tokens to .*design\.tokens\.json \(DTCG 2025\.10\)$/,
    );

    const findings = async (cwd: string) => {
      const { stdout } = await run(['check', 'app', '--format', 'json', '--no-cache'], cwd);
      return (JSON.parse(stdout) as CheckResult[]).flatMap((r) => r.diagnostics);
    };
    const fromCss = await findings(DEMO_ROOT);
    const fromDtcg = await findings(root);
    expect(fromCss.length).toBeGreaterThan(0);
    // A DTCG token is named by its path: `color.destructive` is the stylesheet's `destructive`.
    const named = fromDtcg.filter((d) => /\bcolor\.[\w-]+/.test(d.message));
    expect(named.length).toBeGreaterThan(0);
    expect(
      fromDtcg.map((d) => ({ ...d, message: d.message.replace(/\bcolor\.([\w-]+)/g, '$1') })),
    ).toEqual(fromCss);
  });
});

describe('export --format design-md', () => {
  const { text, warnings } = toDesignMd(demo, { name: 'shadcn-demo' });

  it('writes front matter in the DESIGN.md schema, then a table per category', () => {
    expect(warnings).toEqual([]);
    const [, yaml = '', body = ''] = text.split(/^---$/m);
    expect(yaml).toContain(
      'version: alpha\nname: shadcn-demo\ncolors:\n  background: oklch(1 0 0)\n',
    );
    expect(yaml).toContain('rounded:\n  sm: 6px\n  md: 8px\n  lg: 0.625rem\n');
    expect(yaml).toContain('spacing:\n  base: 0.25rem\n');
    // `var(--font-geist-sans)` is no font name: the table has it, the front matter does not.
    expect(yaml).not.toContain('typography');
    expect(body.match(/^## .*/gm)).toEqual([
      '## Colors',
      '## Typography',
      '## Layout',
      '## Shapes',
    ]);
    const colors = body.slice(body.indexOf('## Colors'), body.indexOf('## Typography')).trim();
    const lines = colors.split('\n');
    // A heading, one sentence, then the table.
    expect(lines[2]).toBe('Use these colors instead of hex, rgb() or Tailwind palette values.');
    expect(lines[4]).toBe('| Token | Value | Dark | Use | Description |');
    expect(lines).toContain(
      '| `destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | `bg-destructive`, `var(--destructive)` | Errors and irreversible actions. |',
    );
    expect(body).toContain('| `sm` | `calc(var(--radius) - 4px)` | `rounded-sm` |');
  });

  it('reads back as a DESIGN.md token source with the same values', () => {
    const back = parseDesignMd(text, 'DESIGN.md');
    expect(back.warnings).toEqual([]);
    expect(back.tokens.find((t) => t.name === 'colors.destructive')).toMatchObject({
      category: 'color',
      value: 'oklch(0.577 0.245 27.325)',
    });
    expect(back.tokens.find((t) => t.name === 'rounded.sm')).toMatchObject({
      category: 'radius',
      value: '6px',
    });
    expect(back.tokens.filter((t) => t.category === 'color')).toHaveLength(
      demo.filter((t) => t.category === 'color').length,
    );
  });

  it('keeps aliases as references and writes typography levels', () => {
    const { tokens } = parseDtcgTokens(
      JSON.stringify({
        color: {
          $type: 'color',
          ink: { $value: '#1a1c1e' },
          text: { $value: '{color.ink}' },
        },
        font: {
          body: { $type: 'fontFamily', $value: ['Inter', 'sans-serif'] },
          h1: {
            $type: 'typography',
            $value: {
              fontFamily: 'Public Sans',
              fontSize: { value: 48, unit: 'px' },
              fontWeight: 600,
              lineHeight: 1.1,
            },
          },
        },
      }),
      'tokens.json',
    );
    const md = toDesignMd(tokens, { name: 'Heritage' }).text;
    expect(md).toContain('colors:\n  ink: "#1a1c1e"\n  text: "{colors.ink}"\n');
    expect(md).toContain(
      'typography:\n  body:\n    fontFamily: Inter, sans-serif\n  h1:\n    fontFamily: Public Sans\n    fontSize: 48px\n    fontWeight: 600\n    lineHeight: 1.1\n',
    );
    const back = parseDesignMd(md, 'DESIGN.md').tokens;
    expect(back.find((t) => t.name === 'colors.text')).toMatchObject({
      value: '#1a1c1e',
      aliasOf: 'colors.ink',
    });
  });
});

describe('onsystem export', () => {
  it('prints the export on stdout', async () => {
    const { code, stdout } = await run(['export', '--format', 'design-md', '--no-cache']);
    expect(code).toBe(0);
    expect(stdout.split('\n').slice(0, 3)).toEqual(['---', 'version: alpha', 'name: shadcn-demo']);
    const dtcg = await run(['export', '--format', 'dtcg', '--no-cache']);
    expect(Object.keys(JSON.parse(dtcg.stdout) as object)).toEqual([
      'color',
      'spacing',
      'radius',
      'typography',
    ]);
  });

  it('asks for a format, and says when there are no tokens to export', async () => {
    expect(await run(['export'])).toMatchObject({
      code: 2,
      stderr: 'export: pass --format dtcg or --format design-md',
    });
    expect(await run(['export', '--format', 'json'])).toMatchObject({
      code: 2,
      stderr: 'export: pass --format dtcg or --format design-md (not "json")',
    });
    const root = fixture({ 'package.json': '{"name":"empty"}' });
    const empty = await run(['export', '--format', 'dtcg', '--no-cache'], root);
    expect(empty.code).toBe(2);
    expect(empty.stderr).toMatch(/^export: no design tokens found in /);
  });

  it('lists export in --help', async () => {
    const { stdout } = await run(['--help']);
    expect(stdout).toContain('onsystem export --format dtcg|design-md');
    expect(stdout).toContain('--out <file>');
  });
});
