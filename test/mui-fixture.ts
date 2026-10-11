/**
 * A few of `@mui/material`'s type declarations, trimmed from version 9.4.0 (MIT licensed), with
 * the shapes onsystem reads: `OverridableComponent` (a generic signature over `component` next
 * to the default one), `OverridableStringUnion` values an app can extend by module
 * augmentation, Button's extra signature for `href`, TextField's generic `variant`, a Tooltip
 * whose `title` labels its child, styled slots exported next to their component, a React
 * context and a function. Written into a test project's `node_modules`, so tests need neither
 * the package nor the network; `test/mui.test.ts` says how it was checked against the real one.
 */
const types = `import * as React from 'react';

export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
export type Overwrite<T, U> = DistributiveOmit<T, keyof U> & U;
type GenerateStringUnion<T> = Extract<{ [Key in keyof T]: true extends T[Key] ? Key : never }[keyof T], string>;
export type OverridableStringUnion<T extends string, U = {}> = GenerateStringUnion<Overwrite<Record<T, true>, U>>;

export interface OverridableTypeMap {
  props: {};
  defaultComponent: React.ElementType;
}
export type BaseProps<M extends OverridableTypeMap> = M['props'] & { className?: string | undefined; style?: React.CSSProperties | undefined; sx?: object | undefined };
export type OverrideProps<M extends OverridableTypeMap, C extends React.ElementType> = BaseProps<M> & DistributiveOmit<React.ComponentPropsWithRef<C>, keyof BaseProps<M>>;
export type DefaultComponentProps<M extends OverridableTypeMap> = BaseProps<M> & DistributiveOmit<React.ComponentPropsWithRef<M['defaultComponent']>, keyof BaseProps<M>>;

/** A component whose root component can be controlled via a \`component\` prop. */
export interface OverridableComponent<M extends OverridableTypeMap> {
  <RootComponent extends React.ElementType>(props: {
    /** The component used for the root node. Either a string to use a HTML element or a component. */
    component: RootComponent;
  } & OverrideProps<M, RootComponent>): React.JSX.Element | null;
  (props: DefaultComponentProps<M>): React.JSX.Element | null;
}
`;

const button = `import * as React from 'react';
import { OverridableComponent, OverridableStringUnion, OverrideProps } from '../types.js';

export interface ButtonPropsVariantOverrides {}
export interface ButtonPropsColorOverrides {}
export interface ButtonPropsSizeOverrides {}

export interface ButtonOwnProps {
  /** The content of the component. */
  children?: React.ReactNode;
  /**
   * The color of the component.
   * @default 'primary'
   */
  color?: OverridableStringUnion<'inherit' | 'primary' | 'secondary' | 'success' | 'error' | 'info' | 'warning', ButtonPropsColorOverrides> | undefined;
  /** If \`true\`, the component is disabled. */
  disabled?: boolean | undefined;
  /** The URL to link to when the button is clicked. */
  href?: string | undefined;
  /**
   * The size of the component.
   * @default 'medium'
   */
  size?: OverridableStringUnion<'small' | 'medium' | 'large', ButtonPropsSizeOverrides> | undefined;
  /**
   * The variant to use.
   * @default 'text'
   */
  variant?: OverridableStringUnion<'text' | 'outlined' | 'contained', ButtonPropsVariantOverrides> | undefined;
}

export interface ButtonTypeMap {
  props: ButtonOwnProps;
  defaultComponent: 'button';
}

/**
 *
 * Demos:
 *
 * - [Button Group](https://mui.com/material-ui/react-button-group/)
 * - [Button](https://mui.com/material-ui/react-button/)
 *
 * API:
 *
 * - [Button API](https://mui.com/material-ui/api/button/)
 */
declare const Button: ((props: { href: string } & OverrideProps<ButtonTypeMap, 'a'>) => React.JSX.Element) & OverridableComponent<ButtonTypeMap>;
export default Button;
`;

const iconButton = `import * as React from 'react';
import { OverridableComponent, OverridableStringUnion } from '../types.js';

export interface IconButtonPropsSizeOverrides {}

export interface IconButtonTypeMap {
  props: {
    children?: React.ReactNode;
    /** @default 'medium' */
    size?: OverridableStringUnion<'small' | 'medium' | 'large', IconButtonPropsSizeOverrides> | undefined;
  };
  defaultComponent: 'button';
}

/**
 * Refer to the [Icons](https://mui.com/material-ui/icons/) section of the documentation.
 *
 * Demos:
 *
 * - [Button](https://mui.com/material-ui/react-button/)
 *
 * API:
 *
 * - [IconButton API](https://mui.com/material-ui/api/icon-button/)
 */
declare const IconButton: OverridableComponent<IconButtonTypeMap>;
export default IconButton;
`;

const chip = `import * as React from 'react';
import { OverridableComponent, OverridableStringUnion } from '../types.js';

export interface ChipPropsVariantOverrides {}
export interface ChipPropsColorOverrides {}

export interface ChipTypeMap {
  props: {
    /**
     * The color of the component.
     * @default 'default'
     */
    color?: OverridableStringUnion<'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning', ChipPropsColorOverrides> | undefined;
    /** The content of the component. */
    label?: React.ReactNode;
    /**
     * The variant to use.
     * @default 'filled'
     */
    variant?: OverridableStringUnion<'filled' | 'outlined', ChipPropsVariantOverrides> | undefined;
  };
  defaultComponent: 'div';
}

declare const Chip: OverridableComponent<ChipTypeMap>;
export default Chip;
`;

const textField = `import * as React from 'react';

export type TextFieldVariants = 'outlined' | 'standard' | 'filled';

export interface BaseTextFieldProps extends Omit<React.ComponentPropsWithRef<'div'>, 'onChange'> {
  /** The label content. */
  label?: React.ReactNode;
  /** Callback fired when the value is changed. */
  onChange?: React.ChangeEventHandler<HTMLInputElement> | undefined;
  /** The value of the \`input\` element. */
  value?: unknown;
}

/**
 * The \`TextField\` is a convenience wrapper for the most common cases (80%).
 *
 * Demos:
 *
 * - [Text Field](https://mui.com/material-ui/react-text-field/)
 *
 * API:
 *
 * - [TextField API](https://mui.com/material-ui/api/text-field/)
 */
declare function TextField<Variant extends TextFieldVariants = 'outlined'>(props: {
  /**
   * The variant to use.
   * @default 'outlined'
   */
  variant?: Variant;
} & BaseTextFieldProps): React.JSX.Element;
export default TextField;
`;

const tooltip = `import * as React from 'react';

export interface TooltipProps extends Omit<React.ComponentPropsWithRef<'div'>, 'title' | 'children'> {
  /** Tooltip reference element. */
  children: React.ReactElement;
  /**
   * Set to \`true\` if the \`title\` acts as an accessible description.
   * By default the \`title\` acts as an accessible label for the child.
   * @default false
   */
  describeChild?: boolean | undefined;
  /** Tooltip title. Zero-length titles string, undefined, null and false are never displayed. */
  title: React.ReactNode;
}

declare function Tooltip(props: TooltipProps): React.JSX.Element;
export default Tooltip;
`;

const slider = `import * as React from 'react';

export interface SliderProps extends Omit<React.ComponentPropsWithRef<'span'>, 'defaultValue' | 'onChange'> {
  /** The default value. */
  defaultValue?: number | number[] | undefined;
  /** @default 'horizontal' */
  orientation?: 'horizontal' | 'vertical' | undefined;
}

export declare const SliderRoot: React.FC<{ ownerState: object }>;
export declare const SliderThumb: React.FC<{ ownerState: object }>;
declare const Slider: (props: SliderProps) => React.JSX.Element;
export default Slider;
`;

const link = `import * as React from 'react';
import { OverridableComponent } from '../types.js';

export interface LinkTypeMap {
  props: {
    children?: React.ReactNode;
    /** @default 'always' */
    underline?: 'none' | 'hover' | 'always' | undefined;
  };
  defaultComponent: 'a';
}

declare const Link: OverridableComponent<LinkTypeMap>;
export default Link;
`;

const context = `import * as React from 'react';

declare const ButtonGroupContext: React.Context<{ size?: string | undefined }>;
export default ButtonGroupContext;
`;

const folder = (name: string) =>
  `export { default } from './${name}.js';\nexport * from './${name}.js';\n`;

/** The package's files, by path relative to `node_modules/@mui/material`. */
export const MUI_MATERIAL: Record<string, string> = {
  'package.json': JSON.stringify({
    name: '@mui/material',
    version: '9.4.0',
    types: './index.d.ts',
  }),
  'types.d.ts': types,
  'Button/Button.d.ts': button,
  'Button/index.d.ts': folder('Button'),
  'IconButton/IconButton.d.ts': iconButton,
  'IconButton/index.d.ts': folder('IconButton'),
  'Chip/Chip.d.ts': chip,
  'Chip/index.d.ts': folder('Chip'),
  'TextField/TextField.d.ts': textField,
  'TextField/index.d.ts': folder('TextField'),
  'Tooltip/Tooltip.d.ts': tooltip,
  'Tooltip/index.d.ts': folder('Tooltip'),
  'Slider/Slider.d.ts': slider,
  'Slider/index.d.ts': folder('Slider'),
  'Link/Link.d.ts': link,
  'Link/index.d.ts': folder('Link'),
  'ButtonGroup/ButtonGroupContext.d.ts': context,
  'styles/index.d.ts':
    'export declare function createTheme(options?: object, ...args: object[]): object;\n',
  'index.d.ts': [
    "export * from './styles/index.js';",
    ...['Button', 'IconButton', 'Chip', 'TextField', 'Tooltip', 'Slider', 'Link'].flatMap(
      (name) => [
        `export { default as ${name} } from './${name}/index.js';`,
        `export * from './${name}/index.js';`,
      ],
    ),
    "export { default as ButtonGroupContext } from './ButtonGroup/ButtonGroupContext.js';",
    '',
  ].join('\n'),
};

/** `MUI_MATERIAL` placed in a project's `node_modules`, to pass to `fixture`. */
export function muiPackage(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(MUI_MATERIAL).map(([file, text]) => [
      `node_modules/@mui/material/${file}`,
      text,
    ]),
  );
}
