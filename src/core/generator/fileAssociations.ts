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

/** Expand filename globs into the exact names required by VS Code. */
export const resolveFileAssociations = (
  associations: IconAssociations = {},
  fileNames: readonly string[] = []
): IconAssociations => {
  const resolved: IconAssociations = {};
  const names = new Set(fileNames.map((name) => name.toLowerCase()));

  for (const [pattern, icon] of Object.entries(associations)) {
    if (!isFileNameGlob(pattern)) continue;

    const matcher = compileGlob(pattern);
    for (const name of names) {
      if (matcher.test(name)) resolved[name] = icon;
    }
  }

  // Explicit filenames take priority over globs regardless of settings order.
  for (const [pattern, icon] of Object.entries(associations)) {
    if (!isFileNameGlob(pattern)) resolved[pattern.toLowerCase()] = icon;
  }

  return resolved;
};
