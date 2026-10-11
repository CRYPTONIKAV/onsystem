import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { loadDesignSystem, type DesignSystem } from '../src/design-system.js';
import { renderComponent, renderComponentList } from '../src/server/render.js';
import type { ComponentInfo } from '../src/types.js';
import { loadTarget } from '../src/workspace.js';
import { fixture } from './helpers.js';
import { muiPackage } from './mui-fixture.js';

// MUI, read from its type declarations. The project gets a trimmed copy of @mui/material 9.4.0's
// declarations (test/mui-fixture.ts) and React's types from the demo. The same reading was
// checked against the real packages, 9.4.0, 7.1.1, 7.0.1, 5.15.14 and 5.15.0, installed beside
// public apps: the counts and findings are in the pull request that added it.

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    jsx: 'react-jsx',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    skipLibCheck: true,
    paths: { '@/*': ['./*'] },
  },
  include: ['src', 'components'],
});

/** An app on MUI: its package.json, tsconfig and the package in node_modules, plus `files`. */
function muiApp(files: Record<string, string> = {}): string {
  return fixture(
    {
      'package.json': JSON.stringify({
        name: 'mui-app',
        dependencies: { '@mui/material': '^9.4.0', react: '^19.0.0' },
      }),
      'tsconfig.json': TSCONFIG,
      ...muiPackage(),
      ...files,
    },
    { nodeModules: true },
  );
}

async function load(root: string): Promise<DesignSystem> {
  return loadDesignSystem(await loadConfig({ root }), { cache: false });
}

function component(ds: DesignSystem, name: string): ComponentInfo {
  const found = ds.model.components.find((c) => c.name === name && c.library);
  if (!found) throw new Error(`no ${name} from the library`);
  return found;
}

async function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { cwd, color: false, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  const code = await main(args, io);
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

type Results = {
  file: string;
  diagnostics: { ruleId: string; message: string; line: number }[];
}[];

async function check(root: string, file: string): Promise<{ ruleId: string; message: string }[]> {
  const { stdout } = await run(['check', file, '--format', 'json', '--no-cache'], root);
  return (JSON.parse(stdout) as Results).flatMap((r) =>
    r.diagnostics.map(({ ruleId, message }) => ({ ruleId, message })),
  );
}

/** The theme file: a module augmentation, a theme written out, and what it adds. */
const THEME = `import { createTheme } from '@mui/material/styles';
import { brand } from './colors';

declare module '@mui/material/Chip' {
  interface ChipPropsColorOverrides {
    neutral: true;
  }
}

export const theme = createTheme({
  colorSchemes: {
    light: { palette: { primary: { main: brand[600] }, background: { paper: '#ffffff' }, divider: '#e5e7eb' } },
    dark: { palette: { primary: { main: brand[400] } } },
  },
  shape: { borderRadius: 6 },
  spacing: 4,
  components: {
    MuiChip: { variants: [{ props: { variant: 'dashed' }, style: { borderStyle: 'dashed' } }] },
  },
});

// A color group the app adds to its palette, as JavaScript apps do without types.
export const extra = { teal: { light: '#5eead4', main: '#0d9488', dark: '#115e59' } };
`;

describe('MUI, read from its type declarations', () => {
  it('lists its components with props and variants in inspect', async () => {
    const root = muiApp();
    const { code, stdout } = await run(['inspect', '--no-cache'], root);
    expect(code).toBe(0);
    expect(stdout).toContain(
      'library  MUI (@mui/material 9.4.0): 9 components from its type declarations',
    );
    expect(stdout).toContain('Components (7 + 2 parts)');
    expect(stdout).toMatch(
      /^ {2}Button +<button> · \d+ props · color\[7\] size\[3\] variant\[3\]/m,
    );
    expect(stdout).toMatch(/^ {2}TextField +.*variant\[3\]/m);
    expect(stdout).not.toContain('No component files matched');
  });

  it('reads props, their values, the element and the module that default-exports it', async () => {
    const ds = await load(muiApp());
    const button = component(ds, 'Button');
    expect(button).toMatchObject({
      importPath: '@mui/material',
      library: '@mui/material',
      element: 'button',
      polymorphic: 'component',
      defaultImport: '@mui/material/Button',
      source: { file: 'node_modules/@mui/material/Button/Button.d.ts' },
      description: 'Demos: Button Group, Button.\n\nAPI: https://mui.com/material-ui/api/button/',
    });
    // Values in the order the declaration writes them, not the checker's.
    expect(button.props.find((p) => p.name === 'size')).toMatchObject({
      kind: 'variant',
      values: ['small', 'medium', 'large'],
      type: '"small" | "medium" | "large"',
      default: "'medium'",
    });
    expect(button.variants.map((v) => [v.name, v.values, v.default])).toEqual([
      [
        'color',
        ['inherit', 'primary', 'secondary', 'success', 'error', 'info', 'warning'],
        'primary',
      ],
      ['size', ['small', 'medium', 'large'], 'medium'],
      ['variant', ['text', 'outlined', 'contained'], 'text'],
    ]);
    // `component` is documented, though the props it brings are not known.
    expect(button.props.find((p) => p.name === 'component')).toMatchObject({
      type: 'React.ElementType',
    });
    // The `href` signature's anchor attributes count: `target` is accepted.
    const accepted = button.inherits.flatMap((i) => ds.model.propSets[i.set] ?? []);
    expect(accepted).toEqual(expect.arrayContaining(['target', 'onClick', 'aria-label']));
    // TextField's variant is a type parameter: its constraint gives the values.
    expect(component(ds, 'TextField').props.find((p) => p.name === 'variant')?.values).toEqual([
      'outlined',
      'standard',
      'filled',
    ]);
    // Slots exported next to their component are its parts; a context and a function are not
    // components.
    expect(component(ds, 'Slider').subcomponents).toEqual(['SliderRoot', 'SliderThumb']);
    expect(component(ds, 'SliderThumb').parent).toBe('Slider');
    const names = ds.model.components.map((c) => c.name);
    expect(names).not.toContain('ButtonGroupContext');
    expect(names).not.toContain('createTheme');
    expect(ds.model.exports).toEqual(expect.arrayContaining(['ButtonGroupContext', 'createTheme']));
    expect(component(ds, 'Tooltip').labelsChild).toEqual({
      prop: 'title',
      unless: 'describeChild',
    });
  });

  it('checks code that uses it: invented values, props and components', async () => {
    const root = muiApp({
      'src/theme.ts': THEME,
      'src/colors.ts': "export const brand = { 400: '#7c3aed', 600: '#5b21b6' };\n",
      'src/page.tsx': `import Button from '@mui/material/Button';
import MuiButton from '@mui/material/Button';
import { Chip, Buttonn, TextField, Link } from '@mui/material';
import NextLink from 'next/link';

export default function Page() {
  return (
    <>
      <Button variant="danger">Delete</Button>
      <MuiButton tone="loud">Save</MuiButton>
      <Chip color="purple" label="New" />
      <Buttonn>Typo</Buttonn>
      <Button component={NextLink} href="/" prefetch>Home</Button>
      <Button href="/docs" target="_blank">Docs</Button>
      <Chip color="neutral" variant="dashed" label="Augmented and themed" />
      <Button color="teal">Added by the palette</Button>
      <TextField variant="filled" label="Name" />
      <Link underline="hover" href="/">Home</Link>
    </>
  );
}
`,
    });
    expect(await check(root, 'src/page.tsx')).toEqual([
      {
        ruleId: 'no-unknown-variant',
        message:
          '"danger" is not a valid variant for <Button>. Allowed: text, outlined, contained.',
      },
      {
        ruleId: 'no-unknown-prop',
        message:
          '<MuiButton> has no prop "tone". Did you mean "variant" ("text" | "outlined" | "contained")?',
      },
      {
        ruleId: 'no-unknown-variant',
        message:
          '"purple" is not a valid color for <Chip>. Allowed: default, primary, secondary, error, info, success, warning, neutral, teal.',
      },
      {
        ruleId: 'no-unknown-component',
        message:
          '"Buttonn" is not a design-system component (imported from "@mui/material"). Did you mean <Button>?',
      },
    ]);
  });

  it('counts a Tooltip title as its child’s accessible name, as MUI does', async () => {
    const root = muiApp({
      'src/toolbar.tsx': `import { IconButton, Tooltip } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';

export function Toolbar() {
  return (
    <>
      <Tooltip title="Delete"><IconButton><DeleteIcon /></IconButton></Tooltip>
      <Tooltip title={label}>{open && <IconButton><DeleteIcon /></IconButton>}</Tooltip>
      <IconButton><DeleteIcon /></IconButton>
      <Tooltip title={<b>Delete</b>}><IconButton><DeleteIcon /></IconButton></Tooltip>
      <Tooltip title="Delete" describeChild><IconButton><DeleteIcon /></IconButton></Tooltip>
    </>
  );
}
`,
    });
    const found = await check(root, 'src/toolbar.tsx');
    expect(found.map((f) => f.ruleId)).toEqual([
      'icon-button-accessible-name',
      'icon-button-accessible-name',
      'icon-button-accessible-name',
    ]);
  });

  it('lets the project’s own components win a name it shares with MUI', async () => {
    const root = muiApp({
      'components/ui/button.tsx': `import { cva, type VariantProps } from "class-variance-authority";
const buttonVariants = cva("px-3", {
  variants: { variant: { default: "bg-black", destructive: "bg-red-600" } },
  defaultVariants: { variant: "default" },
});
export function Button(props: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button {...props} />;
}
`,
      'src/page.tsx': `import { Button as MuiButton } from '@mui/material';
import { Button } from '@/components/ui/button';

export default function Page() {
  return (
    <>
      <MuiButton variant="contained">MUI</MuiButton>
      <Button variant="contained">Ours</Button>
      <button>Native</button>
    </>
  );
}
`,
    });
    const ds = await load(root);
    // The tools offer the project's Button, and MUI's other components.
    const buttons = ds.roots().filter((c) => c.name === 'Button');
    expect(buttons.map((c) => c.library)).toEqual([undefined]);
    expect(ds.getComponent('Button')?.library).toBeUndefined();
    expect(ds.roots().some((c) => c.name === 'Chip' && c.library)).toBe(true);
    const list = renderComponentList(ds);
    expect(list).toContain('From @mui/material (import { Name } from "@mui/material"):');
    expect(list.split('\n').filter((line) => line.startsWith('Button '))).toHaveLength(1);
    // Each import is checked against its own Button; the native element suggests the project's.
    expect(await check(root, 'src/page.tsx')).toEqual([
      {
        ruleId: 'no-unknown-variant',
        message:
          '"contained" is not a valid variant for <Button>. Allowed: default, destructive. Did you mean "default"?',
      },
      {
        ruleId: 'prefer-design-system-component',
        message:
          'Native <button> where the design system has <Button>. Use <Button> (import { Button } from "@/components/ui/button").',
      },
    ]);
  });

  it('reads tokens from the theme the app writes out, and the values it adds', async () => {
    const root = muiApp({
      'src/theme.ts': THEME,
      'src/colors.ts': "export const brand = { 400: '#7c3aed', 600: '#5b21b6' };\n",
      // A test's theme is not the app's.
      'src/theme.test.ts':
        "import { createTheme } from '@mui/material/styles';\nexport const t = createTheme({ palette: { error: { main: '#000000' } } });\n",
      'src/card.tsx':
        "export const Card = () => <div style={{ color: '#5b21b6', padding: 13 }}>Hi</div>;\n",
    });
    const ds = await load(root);
    expect(ds.tokens.map((t) => [t.name, t.category, t.value, t.modes])).toEqual([
      ['primary.main', 'color', '#5b21b6', { dark: '#7c3aed' }],
      ['background.paper', 'color', '#ffffff', undefined],
      ['divider', 'color', '#e5e7eb', undefined],
      ['spacing', 'spacing', '4px', undefined],
      ['shape.borderRadius', 'radius', '6px', undefined],
    ]);
    expect(ds.getTokens({ query: 'primary' })[0]?.usage).toEqual([
      'color="primary"',
      "sx={{ color: 'primary.main' }}",
      'theme.palette.primary.main',
    ]);
    // The spacing unit and radius are listed, not used as Tailwind scales by the length rules.
    expect(ds.tokenIndex.has('spacing')).toBe(false);
    expect(ds.tokenIndex.has('radius')).toBe(false);
    expect(ds.tokenIndex.has('color')).toBe(true);
    expect(await check(root, 'src/card.tsx')).toEqual([
      {
        ruleId: 'no-hardcoded-color',
        message:
          'Hardcoded color `#5b21b6` in style.color. Matches token primary.main (exact match) → `color="primary"` or `sx={{ color: \'primary.main\' }}` or `theme.palette.primary.main`.',
      },
    ]);
    const chip = renderComponent(ds, component(ds, 'Chip'));
    expect(chip).toContain(
      'color: default | primary | secondary | error | info | success | warning | neutral | teal (default "default")',
    );
    expect(chip).toContain('variant: filled | outlined | dashed (default "filled")');
  });

  it('says so when it is a dependency but is not installed', async () => {
    const root = fixture({
      'package.json': JSON.stringify({ name: 'app', dependencies: { '@mui/material': '^9.4.0' } }),
      'src/page.tsx': 'export default () => <p>Hi</p>;\n',
    });
    const { stdout } = await run(['inspect', '--no-cache'], root);
    expect(stdout).toContain('library  MUI (@mui/material): a dependency, but not installed');
    expect(stdout).toContain(
      'MUI (@mui/material) is a dependency but is not installed, so its components are not known: install the dependencies.',
    );
  });

  it('makes a workspace package that only uses MUI a project of the monorepo root', async () => {
    const root = fixture(
      {
        'package.json': JSON.stringify({ name: 'acme', private: true }),
        'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
        'apps/web/package.json': JSON.stringify({
          name: '@acme/web',
          dependencies: { '@mui/material': '^9.4.0' },
        }),
        'apps/web/src/page.tsx':
          'import { Button } from \'@mui/material\';\nexport default () => <Button variant="danger">Go</Button>;\n',
        'apps/docs/package.json': JSON.stringify({ name: '@acme/docs' }),
        ...muiPackage(),
      },
      { nodeModules: true },
    );
    const { workspace } = await loadTarget({ cwd: root });
    expect(workspace?.projects.map((p) => p.dir)).toEqual(['apps/web']);
    expect(workspace?.others).toEqual(['apps/docs']);
    const { stdout } = await run(
      ['check', path.join('apps', 'web', 'src', 'page.tsx'), '--format', 'json', '--no-cache'],
      root,
    );
    expect((JSON.parse(stdout) as Results)[0]?.diagnostics.map((d) => d.ruleId)).toEqual([
      'no-unknown-variant',
    ]);
  });
});
