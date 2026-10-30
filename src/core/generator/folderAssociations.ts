import type { Config, IconAssociations } from '../models/icons/config';
import type { Manifest } from '../models/manifest';
import { compileGlob, createNameAssociationResolver } from './fileAssociations';
import { createManifestMappingWriter } from './shared/manifestMappings';

/**
 * Extend the folder names with additional patterns.
 *
 * @param folderNames - The folder names to be extended.
 * @returns The extended folder names.
 */
export const extendFolderNames = (folderNames: string[]) => {
  const names: string[] = [];
  const patterns: [string, string][] = [
    ['', ''],
    ['.', ''],
    ['_', ''],
    ['-', ''],
    ['__', '__'],
  ];
  folderNames.forEach((name) => {
    patterns.forEach((style) => {
      names.push(`${style[0]}${name}${style[1]}`);
    });
  });
  return names;
};

/** Additional basenames; discovery belongs to the caller, not the generator. */
export type FolderNames = {
  folderNames?: readonly string[];
  rootFolderNames?: readonly string[];
};

export const isFolderNameGlob = (pattern: string): boolean =>
  pattern.includes('*') && !pattern.includes('/');

export const createFolderNameGlobMatcher = (patterns: readonly string[]) => {
  const matchers = patterns.filter(isFolderNameGlob).map(compileGlob);
  return (name: string) => matchers.some((matcher) => matcher.test(name));
};

export const createFolderAssociationResolver = (
  associations: IconAssociations,
  knownNames: readonly string[] = []
) => {
  // Exact settings retain their historical prefixed aliases; glob matches do not.
  const expanded = Object.fromEntries(
    Object.entries(associations).flatMap(([name, icon]) =>
      name.includes('*')
        ? name.includes('/')
          ? []
          : [[name, icon]]
        : extendFolderNames([name]).map((alias) => [alias, icon])
    )
  );
  return createNameAssociationResolver(expanded, knownNames);
};

/** Copy only changed mappings; definitions are prepared once in the base. */
export const withFolderAssociations = (
  base: Manifest,
  config: Config,
  associations: IconAssociations,
  rootAssociations: IconAssociations = {}
): Manifest => {
  if (config.folders.theme === 'none') return base;
  const manifest = { ...base };
  const copyMapping = createManifestMappingWriter(base, manifest);
  for (const [values, key, expandedKey] of [
    [associations, 'folderNames', 'folderNamesExpanded'],
    [rootAssociations, 'rootFolderNames', 'rootFolderNamesExpanded'],
  ] as const) {
    for (const name of Object.keys(values)) {
      const icon = values[name]
        ? `folder-${values[name].toLowerCase()}`
        : 'folder';
      for (const [mapping, value] of [
        [key, icon],
        [expandedKey, `${icon}-open`],
      ] as const) {
        if (manifest[mapping]?.[name] !== value)
          copyMapping(mapping)[name] = value;
        for (const theme of ['light', 'highContrast'] as const) {
          if (manifest[theme]?.[mapping]?.[name] !== undefined)
            delete copyMapping(mapping, theme)[name];
        }
      }
    }
  }
  return manifest;
};
