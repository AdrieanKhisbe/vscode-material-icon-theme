import { describe, expect, it, vi } from 'vitest';
import {
  createFolderAssociationResolver,
  generateManifest,
  getDefaultConfig,
  withFolderAssociations,
} from '../../index';

describe('folder wildcard associations', () => {
  it('matches case-insensitive basenames in both independent namespaces', () => {
    const manifest = generateManifest(
      {
        folders: { associations: { 'project-*': 'src' } },
        rootFolders: { associations: { 'project-*': 'app' } },
      },
      [],
      {
        folderNames: ['PROJECT-api', 'project-', '.project-api'],
        rootFolderNames: ['Project-api'],
      }
    );
    expect(manifest.folderNames?.['project-api']).toBe('folder-src');
    expect(manifest.folderNames?.['project-']).toBe('folder-src');
    expect(manifest.folderNamesExpanded?.['project-api']).toBe(
      'folder-src-open'
    );
    expect(manifest.rootFolderNames?.['project-api']).toBe('folder-app');
    expect(manifest.rootFolderNamesExpanded?.['project-api']).toBe(
      'folder-app-open'
    );
    expect(manifest.folderNames?.['.project-api']).toBeUndefined();
    expect(manifest.folderNames?.['project-*']).toBeUndefined();
    expect(manifest.iconDefinitions?.['folder-src']).toBeDefined();
    expect(manifest.iconDefinitions?.['folder-src-open']).toBeDefined();
  });

  it('honors exact names and their legacy aliases before globs, then the last matching glob', () => {
    const manifest = generateManifest(
      {
        folders: {
          associations: {
            'project-special': 'app',
            '*': 'test',
            'project-*': 'src',
          },
        },
      },
      [],
      {
        folderNames: [
          'project-special',
          '.project-special',
          'project-other',
          'other',
        ],
      }
    );
    expect(manifest.folderNames?.['project-special']).toBe('folder-app');
    expect(manifest.folderNames?.['.project-special']).toBe('folder-app');
    expect(manifest.folderNames?.['project-other']).toBe('folder-src');
    expect(manifest.folderNames?.other).toBe('folder-test');
  });

  it('matches built-in names without a workspace snapshot', () => {
    const manifest = generateManifest({
      folders: { associations: { 's*c': 'test' } },
    });
    expect(manifest.folderNames?.src).toBe('folder-test');
    expect(manifest.folderNamesExpanded?.src).toBe('folder-test-open');
  });

  it('treats extension-shaped folder patterns as ordinary wildcards', () => {
    const manifest = generateManifest(
      {
        folders: {
          associations: {
            '*.cache': 'src',
            '**.bak': 'test',
          },
        },
      },
      [],
      { folderNames: ['project.cache', 'project.bak'] }
    );
    expect(manifest.folderNames?.['project.cache']).toBe('folder-src');
    expect(manifest.folderNames?.['project.bak']).toBe('folder-test');
  });

  it('treats other glob operators literally and preserves exact parent-scoped mappings', () => {
    const manifest = generateManifest(
      {
        folders: {
          associations: {
            'a[bc]*': 'src',
            'parent/*': 'app',
            'parent/exact': 'test',
          },
        },
      },
      [],
      { folderNames: ['a[bc]-one', 'ab-one', 'parent/child'] }
    );
    expect(manifest.folderNames?.['a[bc]-one']).toBe('folder-src');
    expect(manifest.folderNames?.['ab-one']).toBeUndefined();
    expect(manifest.folderNames?.['parent/child']).toBeUndefined();
    expect(manifest.folderNames?.['parent/exact']).toBe('folder-test');
  });

  it('preserves classic and disabled folder themes, including empty icon targets', () => {
    const manifest = generateManifest(
      { folders: { theme: 'classic', associations: { 'project-*': '' } } },
      [],
      { folderNames: ['project-api'] }
    );
    expect(manifest.folderNames?.['project-api']).toBe('folder');
    expect(manifest.folderNamesExpanded?.['project-api']).toBe('folder-open');
    const disabled = generateManifest(
      {
        folders: { theme: 'none', associations: { '*': 'src' } },
        rootFolders: { associations: { '*': 'app' } },
      },
      [],
      { folderNames: ['project-api'], rootFolderNames: ['project-root'] }
    );
    expect(disabled.folderNames).toEqual({});
    expect(disabled.rootFolderNames).toEqual({});
  });

  it('retests only new names and evicts removed choices, including non-matches', () => {
    const resolver = createFolderAssociationResolver({ 'project-*': 'src' });
    const test = vi.spyOn(RegExp.prototype, 'test');
    try {
      expect(resolver.resolve(['project-api', 'unrelated'])).toEqual({
        'project-api': 'src',
      });
      expect(test).toHaveBeenCalledTimes(2);
      resolver.resolve(['PROJECT-api', 'unrelated', 'project-web']);
      expect(test).toHaveBeenCalledTimes(3);
      resolver.resolve(['project-web']);
      resolver.resolve(['project-api', 'project-web']);
      expect(test).toHaveBeenCalledTimes(4);
    } finally {
      test.mockRestore();
    }
  });

  it('copies only changed mappings and removes stale theme variants without mutating the base', () => {
    const config = getDefaultConfig();
    const base = generateManifest(config);
    base.light!.folderNames = { 'project-api': 'old-light' };
    base.light!.folderNamesExpanded = { 'project-api': 'old-light-open' };
    base.highContrast!.rootFolderNames = { 'project-root': 'old-hc' };
    base.highContrast!.rootFolderNamesExpanded = {
      'project-root': 'old-hc-open',
    };
    const before = structuredClone(base);
    const updated = withFolderAssociations(
      base,
      config,
      { 'project-api': 'src' },
      { 'project-root': 'app' }
    );
    expect(base).toEqual(before);
    expect(updated.fileNames).toBe(base.fileNames);
    expect(updated.languageIds).toBe(base.languageIds);
    expect(updated.iconDefinitions).toBe(base.iconDefinitions);
    expect(updated.folderNames).not.toBe(base.folderNames);
    expect(updated.light?.folderNames?.['project-api']).toBeUndefined();
    expect(updated.light?.folderNamesExpanded?.['project-api']).toBeUndefined();
    expect(
      updated.highContrast?.rootFolderNames?.['project-root']
    ).toBeUndefined();
    expect(
      updated.highContrast?.rootFolderNamesExpanded?.['project-root']
    ).toBeUndefined();
    expect(withFolderAssociations(base, config, {}).folderNames).toBe(
      base.folderNames
    );
  });
});
