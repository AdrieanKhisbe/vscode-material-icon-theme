import type { IconAssociations } from '../models/icons/config';
import { wildcardPattern } from './constants';

/** Extension associations can be represented directly in the icon manifest. */
export const isFileNameGlob = (pattern: string): boolean =>
  pattern.includes('*') && !wildcardPattern.test(pattern);

const compileGlob = (pattern: string): RegExp => {
  // Only '*' is special; all other characters are literal filename characters.
  const expression = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${expression}$`, 'i');
};

/** Compile once so filesystem events only need to test their filename. */
export const createFileNameGlobMatcher = (
  patterns: readonly string[]
): ((name: string) => boolean) => {
  const matchers = patterns.filter(isFileNameGlob).map(compileGlob);
  return (name) => matchers.some((matcher) => matcher.test(name));
};

export type FileAssociationResolver = {
  readonly staticAssociations: IconAssociations;
  resolve: (fileNames: readonly string[]) => IconAssociations;
};

/** Compile patterns and resolve fixed names once per configuration. */
export const createFileAssociationResolver = (
  associations: IconAssociations = {},
  knownFileNames: readonly string[] = []
): FileAssociationResolver => {
  const rules = Object.entries(associations)
    .filter(([pattern]) => isFileNameGlob(pattern))
    .map(([pattern, icon]) => ({ matcher: compileGlob(pattern), icon }));
  const explicit = Object.fromEntries(
    Object.entries(associations)
      .filter(([pattern]) => !isFileNameGlob(pattern))
      .map(([pattern, icon]) => [pattern.toLowerCase(), icon])
  );
  const match = (fileNames: readonly string[]): IconAssociations => {
    const resolved: IconAssociations = {};
    const names = new Set(fileNames.map((name) => name.toLowerCase()));
    for (const { matcher, icon } of rules) {
      for (const name of names) {
        if (matcher.test(name)) resolved[name] = icon;
      }
    }
    return resolved;
  };

  // Exact filenames and extension associations are already in the fixed base.
  const staticAssociations = { ...match(knownFileNames), ...explicit };
  // Cache only the latest snapshot, rather than accumulating historical names.
  const choices = new Map<string, string | null>();
  return {
    staticAssociations,
    resolve: (fileNames) => {
      const names = new Set(fileNames.map((name) => name.toLowerCase()));
      for (const name of choices.keys()) {
        if (!names.has(name)) choices.delete(name);
      }
      const resolved: IconAssociations = {};
      for (const name of names) {
        let icon = choices.get(name);
        if (icon === undefined) {
          icon = null;
          if (!Object.hasOwn(explicit, name)) {
            // The last matching rule wins; stop as soon as it is found.
            for (let index = rules.length - 1; index >= 0; index--) {
              const rule = rules[index];
              if (rule.matcher.test(name)) {
                if (staticAssociations[name] !== rule.icon) icon = rule.icon;
                break;
              }
            }
          }
          choices.set(name, icon);
        }
        if (icon !== null) resolved[name] = icon;
      }
      return resolved;
    },
  };
};

/** Expand filename globs into the exact names required by VS Code. */
export const resolveFileAssociations = (
  associations: IconAssociations = {},
  fileNames: readonly string[] = []
): IconAssociations =>
  createFileAssociationResolver(associations, fileNames).staticAssociations;
