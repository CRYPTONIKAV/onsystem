import { describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { parseDesignMd } from '../src/tokens/index.js';
import type { CheckResult } from '../src/types.js';
import { fixture, load } from './helpers.js';

// The shape of Google's DESIGN.md format (https://github.com/google-labs-code/design.md).
const DESIGN_MD = `---
version: alpha
name: Heritage
colors:
  primary: "#1A1C1E"
  tertiary: "#B8422E"
  neutral: "#F7F5F2"
  on-tertiary: "{colors.neutral}"
typography:
  h1:
    fontFamily: Public Sans
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.1
rounded:
  sm: 4px
  full: 9999px
spacing:
  sm: 8px
  md: 16px
  columns: 12
components:
  button-primary:
    backgroundColor: "{colors.tertiary}"
---

## Overview

Architectural Minimalism meets Journalistic Gravitas.

## Colors

- **Primary (#1A1C1E):** Deep ink for headlines and core text.
`;

async function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { cwd, color: false, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  const code = await main(args, io);
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('DESIGN.md front matter tokens', () => {
  it('reads colors, typography, rounded and spacing, named by their path', () => {
    const { tokens, warnings } = parseDesignMd(DESIGN_MD, 'DESIGN.md');
    expect(warnings).toEqual([]);
    expect(tokens.map((t) => [t.name, t.category, t.value, t.source.line])).toEqual([
      ['colors.primary', 'color', '#1A1C1E', 5],
      ['colors.tertiary', 'color', '#B8422E', 6],
      ['colors.neutral', 'color', '#F7F5F2', 7],
      ['colors.on-tertiary', 'color', '#F7F5F2', 8],
      [
        'typography.h1',
        'typography',
        'fontFamily: Public Sans; fontSize: 48px; fontWeight: 600; lineHeight: 1.1',
        10,
      ],
      ['rounded.sm', 'radius', '4px', 16],
      ['rounded.full', 'radius', '9999px', 17],
      ['spacing.sm', 'spacing', '8px', 19],
      ['spacing.md', 'spacing', '16px', 20],
      // A column count is no length.
      ['spacing.columns', 'other', '12', 21],
    ]);
    expect(tokens.find((t) => t.name === 'colors.on-tertiary')?.aliasOf).toBe('colors.neutral');
    // Code reads these through whatever it was written with: no class or custom property is assumed.
    expect(tokens.every((t) => t.cssVar === undefined && t.tailwind === undefined)).toBe(true);
  });

  it('says what is wrong with a file it cannot read', () => {
    expect(parseDesignMd('# Design\n\nNo tokens here.', 'DESIGN.md').warnings).toEqual([
      'DESIGN.md: no YAML front matter (between --- lines at the top)',
    ]);
    expect(parseDesignMd('---\ncolors: [oops\n---\n', 'DESIGN.md').warnings[0]).toMatch(
      /^DESIGN\.md: invalid YAML front matter \(/,
    );
    const unquoted = parseDesignMd(
      '---\ncolors:\n  primary: #1A1C1E\n  ink: "{colors.missing}"\n---\n',
      'DESIGN.md',
    );
    expect(unquoted.warnings).toEqual([
      'DESIGN.md: colors.primary has no value (a # starts a YAML comment: quote hex colors)',
      'DESIGN.md: unresolved reference {colors.missing}',
    ]);
  });
});

describe('DESIGN.md as a token source', () => {
  const COMPONENT =
    'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }';

  it('is read in zero config when no other token file exists', async () => {
    const root = fixture({ 'components/ui/button.tsx': COMPONENT, 'DESIGN.md': DESIGN_MD });
    const ds = await load(root);
    expect(ds.tokens.map((t) => t.name)).toContain('colors.primary');
    expect(ds.model.stats.files.tokens).toBe(1);
  });

  it('is not read in zero config next to a stylesheet or DTCG file', async () => {
    const stylesheet = fixture({
      'components/ui/button.tsx': COMPONENT,
      'app/globals.css': ':root { --primary: #000; }',
      'DESIGN.md': DESIGN_MD,
    });
    expect((await load(stylesheet)).tokens.map((t) => t.name)).toEqual(['primary']);
    const dtcg = fixture({
      'components/ui/button.tsx': COMPONENT,
      'brand.tokens.json': '{"ink":{"$type":"color","$value":"#000"}}',
      'DESIGN.md': DESIGN_MD,
    });
    expect((await load(dtcg)).tokens.map((t) => t.name)).toEqual(['ink']);
  });

  it('is read when the config names it, next to other token files', async () => {
    const root = fixture({
      'components/ui/button.tsx': COMPONENT,
      'app/globals.css': ':root { --primary: #000; }',
      'DESIGN.md': DESIGN_MD,
      'onsystem.config.json': JSON.stringify({ tokens: ['app/globals.css', 'DESIGN.md'] }),
    });
    const names = (await load(root)).tokens.map((t) => t.name);
    expect(names).toContain('primary');
    expect(names).toContain('colors.primary');
  });

  it('names the matching token, and offers no fix code could not use', async () => {
    const root = fixture({
      'components/ui/button.tsx': COMPONENT,
      'DESIGN.md': DESIGN_MD,
      'app/page.tsx': `import { Button } from '@/components/ui/button';
export default function Page() {
  return <div className="bg-[#1a1c1e] p-[8px] m-[10px]" style={{ color: '#f7f5f2' }}><Button>Go</Button></div>;
}`,
    });
    const { stdout } = await run(['check', 'app', '--format', 'json', '--no-cache'], root);
    const diagnostics = (JSON.parse(stdout) as CheckResult[]).flatMap((r) => r.diagnostics);
    expect(diagnostics.map((d) => [d.ruleId, d.message, d.suggestion])).toEqual([
      [
        'no-hardcoded-color',
        'Hardcoded color `bg-[#1a1c1e]`. Matches token colors.primary (exact match).',
        undefined,
      ],
      // `p-[8px]` is spacing.sm, and nothing names it better; 10px is off the scale.
      [
        'no-hardcoded-spacing',
        'Hardcoded spacing `m-[10px]` (10px) is off the scale. Nearest: `m-[8px]` (8px).',
        'm-[8px]',
      ],
      // No component uses a DESIGN.md color through a class, so none is scoped by usage.
      [
        'no-hardcoded-color',
        'Hardcoded color `#f7f5f2` in style.color. Matches token colors.neutral (exact match, same value as colors.on-tertiary).',
        undefined,
      ],
    ]);
  });
});
