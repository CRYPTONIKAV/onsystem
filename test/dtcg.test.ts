import { describe, expect, it } from 'vitest';

import { parseDtcgTokens } from '../src/tokens/index.js';
import type { Token } from '../src/types.js';

const byName = (tokens: Token[], name: string): Token => {
  const token = tokens.find((t) => t.name === name);
  if (!token) throw new Error(`missing token ${name} in ${tokens.map((t) => t.name).join(', ')}`);
  return token;
};

const srgb = (hex: string) => ({
  colorSpace: 'srgb',
  components: [0, 0, 0],
  hex,
});

// The examples are the DTCG 2025.10 format module's own (https://www.designtokens.org/tr/2025.10/format/).
describe('DTCG 2025.10 root tokens', () => {
  it('reads a $root token as the group’s own value, named and referenced by its path', () => {
    const json = {
      color: {
        accent: {
          $root: { $type: 'color', $value: srgb('#dd0000') },
          light: { $type: 'color', $value: srgb('#ff2222') },
          dark: { $type: 'color', $value: srgb('#aa0000') },
        },
        link: { $value: '{color.accent.$root}' },
      },
    };
    const { tokens, warnings } = parseDtcgTokens(JSON.stringify(json, null, 2), 'tokens.json');
    expect(warnings).toEqual([]);
    expect(tokens.map((t) => t.name)).toEqual([
      'color.accent.$root',
      'color.accent.light',
      'color.accent.dark',
      'color.link',
    ]);
    expect(byName(tokens, 'color.accent.$root')).toMatchObject({
      category: 'color',
      value: '#dd0000',
      cssVar: '--color-accent',
      source: { file: 'tokens.json', line: 4 },
    });
    expect(byName(tokens, 'color.link')).toMatchObject({
      value: '#dd0000',
      aliasOf: 'color.accent.$root',
    });
  });

  it('takes the group’s $type for its root token, and a pointer to it', () => {
    const json = {
      spacing: {
        $type: 'dimension',
        $root: { $value: { value: 16, unit: 'px' } },
        small: { $value: { value: 8, unit: 'px' } },
      },
      gap: { $ref: '#/spacing/$root' },
    };
    const { tokens } = parseDtcgTokens(JSON.stringify(json), 'tokens.json', { prefix: 'ds' });
    expect(byName(tokens, 'spacing.$root')).toMatchObject({
      category: 'spacing',
      value: '16px',
      cssVar: '--ds-spacing',
    });
    expect(byName(tokens, 'gap')).toMatchObject({ value: '16px', aliasOf: 'spacing.$root' });
  });
});

describe('DTCG 2025.10 group extension', () => {
  it('inherits the tokens and $type of the group it $extends, its own tokens winning', () => {
    const text = JSON.stringify(
      {
        button: {
          $type: 'color',
          background: { $value: srgb('#0066cc') },
          text: { $value: srgb('#ffffff') },
        },
        'button-primary': {
          $extends: '{button}',
          background: { $value: srgb('#cc0066') },
        },
      },
      null,
      2,
    );
    const { tokens, warnings } = parseDtcgTokens(text, 'tokens.json');
    expect(warnings).toEqual([]);
    expect(tokens.map((t) => [t.name, t.category, t.value])).toEqual([
      ['button.background', 'color', '#0066cc'],
      ['button.text', 'color', '#ffffff'],
      ['button-primary.background', 'color', '#cc0066'],
      ['button-primary.text', 'color', '#ffffff'],
    ]);
    expect(byName(tokens, 'button-primary.text').cssVar).toBe('--button-primary-text');
    // An inherited token is reported where it is written.
    expect(byName(tokens, 'button-primary.text').source.line).toBe(
      byName(tokens, 'button.text').source.line,
    );
  });

  it('merges nested groups and replaces a token whole', () => {
    const json = {
      input: {
        field: {
          width: { $type: 'dimension', $value: { value: 12, unit: 'rem' } },
          background: { $type: 'color', $value: srgb('#ffffff') },
        },
      },
      'input-amount': {
        $extends: '{input}',
        field: { width: { $value: '100px' } },
      },
    };
    const { tokens } = parseDtcgTokens(JSON.stringify(json), 'tokens.json');
    expect(byName(tokens, 'input-amount.field.width')).toMatchObject({ value: '100px' });
    expect(byName(tokens, 'input-amount.field.background')).toMatchObject({
      category: 'color',
      value: '#ffffff',
    });
  });

  it('extends a group with root tokens, and resolves aliases to inherited tokens', () => {
    const json = {
      color: {
        $type: 'color',
        brand: {
          $root: { $value: srgb('#0066cc') },
          strong: { $value: srgb('#3388dd') },
        },
        semantic: {
          $extends: '{color.brand}',
          success: { $root: { $value: srgb('#00cc66') } },
        },
        cta: { $value: '{color.semantic.strong}' },
      },
    };
    const { tokens, warnings } = parseDtcgTokens(JSON.stringify(json), 'tokens.json');
    expect(warnings).toEqual([]);
    expect(tokens.map((t) => t.name)).toEqual([
      'color.brand.$root',
      'color.brand.strong',
      'color.semantic.$root',
      'color.semantic.strong',
      'color.semantic.success.$root',
      'color.cta',
    ]);
    expect(byName(tokens, 'color.semantic.$root')).toMatchObject({
      value: '#0066cc',
      cssVar: '--color-semantic',
    });
    expect(byName(tokens, 'color.cta')).toMatchObject({ value: '#3388dd', category: 'color' });
  });

  it('treats a group $ref like $extends, and a $ref to a token as an alias', () => {
    const json = {
      base: { $type: 'color', $value: srgb('#0066cc') },
      alias: { $ref: '#/base' },
      button: { $type: 'color', background: { $value: srgb('#0066cc') } },
      'button-primary': { $ref: '#/button', focus: { $value: srgb('#ff3399') } },
    };
    const { tokens, warnings } = parseDtcgTokens(JSON.stringify(json), 'tokens.json');
    expect(warnings).toEqual([]);
    expect(byName(tokens, 'alias')).toMatchObject({
      category: 'color',
      value: '#0066cc',
      aliasOf: 'base',
    });
    expect(tokens.map((t) => t.name)).toContain('button-primary.background');
    expect(byName(tokens, 'button-primary.focus').category).toBe('color');
  });

  it('reports circular, unresolved and token targets, and keeps the rest', () => {
    const json = {
      button: {
        color: { $type: 'color', $value: srgb('#663399') },
        secondary: { $extends: '{button}' },
      },
      a: { $extends: '{b}', one: { $type: 'number', $value: 1 } },
      b: { $extends: '{a}', two: { $type: 'number', $value: 2 } },
      c: { $extends: '{missing}', three: { $type: 'number', $value: 3 } },
      d: { $extends: '{button.color}', four: { $type: 'number', $value: 4 } },
    };
    const { tokens, warnings } = parseDtcgTokens(JSON.stringify(json), 't.json');
    expect(warnings).toEqual([
      't.json: circular $extends {button}',
      't.json: circular $extends {a}',
      't.json: unresolved $extends {missing}',
      't.json: $extends {button.color} names a token, not a group',
    ]);
    // `a` takes on what `b` has before the cycle back to `a` was found; inherited tokens come first.
    expect(tokens.map((t) => t.name)).toEqual([
      'button.color',
      'a.two',
      'a.one',
      'b.two',
      'c.three',
      'd.four',
    ]);
  });
});

describe("onsystem's DTCG extension", () => {
  const extension = (own: Record<string, unknown>) => ({
    'com.github.dgesteves.onsystem': own,
  });

  it('reads the custom property, the Tailwind theme variable and modes', () => {
    const json = {
      color: {
        primary: {
          $type: 'color',
          $value: { colorSpace: 'oklch', components: [0.205, 0, 0] },
          $extensions: extension({
            cssVar: '--primary',
            tailwind: '--color-primary',
            modes: { dark: { colorSpace: 'oklch', components: [0.922, 0, 0] } },
          }),
        },
      },
      spacing: {
        $root: {
          $type: 'dimension',
          $value: { value: 0.25, unit: 'rem' },
          $extensions: extension({ cssVar: '--spacing', tailwind: '--spacing' }),
        },
      },
      radius: {
        md: {
          $type: 'dimension',
          $value: { value: 8, unit: 'px' },
          $extensions: extension({ tailwind: '--radius-md' }),
        },
      },
    };
    const { tokens } = parseDtcgTokens(JSON.stringify(json), 'tokens.json');
    expect(byName(tokens, 'color.primary')).toMatchObject({
      value: 'oklch(0.205 0 0)',
      modes: { dark: 'oklch(0.922 0 0)' },
      cssVar: '--primary',
      tailwind: 'primary',
      usage: ['bg-primary', 'text-primary', 'border-primary', 'var(--primary)'],
    });
    expect(byName(tokens, 'spacing.$root')).toMatchObject({
      category: 'spacing',
      cssVar: '--spacing',
      tailwind: '',
    });
    // An `@theme inline` variable has no custom property at runtime: the extension leaves it out.
    const md = byName(tokens, 'radius.md');
    expect(md).toMatchObject({ category: 'radius', tailwind: 'md', usage: ['rounded-md'] });
    expect(md.cssVar).toBeUndefined();
  });

  it('gives Tailwind v3 colors back as the bare HSL channels their custom property holds', () => {
    const json = {
      color: {
        border: {
          $type: 'color',
          $value: { colorSpace: 'hsl', components: [214.3, 31.8, 91.4] },
          $extensions: extension({
            cssVar: '--border',
            channels: 'hsl',
            modes: { dark: { colorSpace: 'hsl', components: [217.2, 32.6, 17.5] } },
          }),
        },
      },
    };
    const { tokens } = parseDtcgTokens(JSON.stringify(json), 'tokens.json');
    expect(byName(tokens, 'color.border')).toMatchObject({
      value: '214.3 31.8% 91.4%',
      modes: { dark: '217.2 32.6% 17.5%' },
      usage: ['hsl(var(--border))'],
    });
  });
});
