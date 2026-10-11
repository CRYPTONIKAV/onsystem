import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  allowJs: true,
  esModuleInterop: true,
  resolveJsonModule: true,
};

export interface ProjectConfig {
  options: ts.CompilerOptions;
  /** Directory `paths` are resolved against. */
  pathsBase: string;
  paths: Record<string, string[]>;
  configFile?: string;
  /** The tsconfig and the configs it extends. */
  configFiles: string[];
  /** The files the tsconfig includes, absolute; empty without one. */
  fileNames: string[];
}

/**
 * Reads the project's tsconfig (only from inside the root: walking further up
 * would pick up unrelated configs, e.g. this repository's own when extracting
 * test fixtures).
 */
export function readProjectConfig(root: string, tsconfig?: string): ProjectConfig {
  const configFile = tsconfig ? path.resolve(root, tsconfig) : path.join(root, 'tsconfig.json');
  if (!fs.existsSync(configFile)) {
    return {
      options: { ...DEFAULT_OPTIONS },
      pathsBase: root,
      paths: {},
      configFiles: [],
      fileNames: [],
    };
  }
  const configFiles = [configFile];
  const read = ts.readConfigFile(configFile, (file) => ts.sys.readFile(file));
  if (read.error) {
    return {
      options: { ...DEFAULT_OPTIONS },
      pathsBase: root,
      paths: {},
      configFile,
      configFiles,
      fileNames: [],
    };
  }
  // Every file read while parsing is a config it extends.
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: (file) => ts.sys.fileExists(file),
    readDirectory: (dir, extensions, excludes, includes, depth) =>
      ts.sys.readDirectory(dir, extensions, excludes, includes, depth),
    readFile: (file) => {
      configFiles.push(file);
      return ts.sys.readFile(file);
    },
  };
  const parsed = ts.parseJsonConfigFileContent(read.config, host, path.dirname(configFile));
  const options: ts.CompilerOptions = { ...DEFAULT_OPTIONS, ...parsed.options };
  // Extraction only needs the checker. Keep it fast and permissive.
  options.noEmit = true;
  options.skipLibCheck = true;
  options.allowJs = true;
  options.jsx ??= ts.JsxEmit.ReactJSX;
  delete options.composite;
  delete options.incremental;
  delete options.tsBuildInfoFile;
  return {
    options,
    // `paths` resolve against baseUrl, else against the directory of the tsconfig that
    // declares them, which TypeScript records as `pathsBasePath` when it is an extended one.
    pathsBase:
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- TypeScript 5 projects still set baseUrl.
      options.baseUrl ??
      (typeof options.pathsBasePath === 'string'
        ? options.pathsBasePath
        : path.dirname(configFile)),
    paths: options.paths ?? {},
    configFile,
    configFiles,
    fileNames: parsed.fileNames,
  };
}

export function createProgram(
  files: string[],
  config: ProjectConfig,
  oldProgram?: ts.Program,
): ts.Program {
  return ts.createProgram({
    rootNames: files,
    options: config.options,
    ...(oldProgram ? { oldProgram } : {}),
  });
}

/** Files of a program outside `node_modules` and TypeScript's libs: the project code it read. */
export function projectFiles(program: ts.Program): string[] {
  return program
    .getSourceFiles()
    .filter((file) => !program.isSourceFileDefaultLibrary(file))
    .map((file) => file.fileName)
    .filter(isProjectFile);
}

/** Installed packages are covered by the lockfile; everything else is the project's. */
export function isProjectFile(file: string): boolean {
  return !/[\\/]node_modules[\\/]/.test(file);
}
