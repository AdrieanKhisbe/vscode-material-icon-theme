import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../generator/config/defaultConfig';
import * as associationTools from '../../generator/fileAssociations';
import {
  createFileAssociationResolver,
  isFileNameGlob,
  resolveFileAssociations,
} from '../../generator/fileAssociations';
import {
  loadFileIconDefinitions,
  withFileAssociations,
} from '../../generator/fileGenerator';
import {
  generateManifest,
  generateManifestWithFileAssociations,
} from '../../generator/generateManifest';
import { fileIcons } from '../../icons/fileIcons';
import type { IconAssociations } from '../../models/icons/config';
import { createEmptyManifest } from '../../models/manifest';

describe('filename glob associations', () => {
  it('preserves extension associations and classifies embedded stars as filename globs', () => {
    expect(isFileNameGlob('*.ts')).toBe(false);
    expect(isFileNameGlob('**.sample.ts')).toBe(false);
    expect(isFileNameGlob('*.config*.json')).toBe(true);
    expect(isFileNameGlob('Dockerfile*')).toBe(true);
    expect(isFileNameGlob('*')).toBe(true);
    expect(
      resolveFileAssociations({ '*.ts': 'typescript', '**.json': 'json' })
    ).toEqual({ '*.ts': 'typescript', '**.json': 'json' });
  });

  it('matches complete filenames with zero or more characters, ignoring case', () => {
    expect(
      resolveFileAssociations(
        {
          'Dockerfile*': 'docker',
          '*config*.json': 'settings',
          'test-*.ts': 'test-ts',
        },
        [
          'Dockerfile',
          'DOCKERFILE.dev',
          'my.config.local.json',
          'test-.ts',
          'test-unit.ts',
          'test-unit.tsx',
          'notDockerfile',
          'src/Dockerfile',
        ]
      )
    ).toEqual({
      dockerfile: 'docker',
      'dockerfile.dev': 'docker',
      'my.config.local.json': 'settings',
      'test-.ts': 'test-ts',
      'test-unit.ts': 'test-ts',
    });
  });

  it('treats regex and other glob operators as literal characters', () => {
    expect(
      resolveFileAssociations({ 'file[1]+(test)?.*': 'text' }, [
        'file[1]+(test)?.txt',
        'file1test.txt',
        'file[1]+(test)?Xtxt',
      ])
    ).toEqual({ 'file[1]+(test)?.txt': 'text' });
  });

  it('gives exact names priority and uses the last matching glob', () => {
    expect(
      resolveFileAssociations(
        { 'Dockerfile.dev': 'text', '*': 'file', 'Dockerfile*': 'docker' },
        ['Dockerfile.dev', 'Dockerfile.prod', 'unknown']
      )
    ).toEqual({
      'dockerfile.dev': 'text',
      'dockerfile.prod': 'docker',
      unknown: 'file',
    });
  });

  it('overrides known filenames and clears stale theme variants', () => {
    const config = getDefaultConfig();
    config.files.associations = { 'Dockerfile*': 'docker' };
    const manifest = loadFileIconDefinitions(
      {
        defaultIcon: { name: 'file' },
        icons: [
          {
            name: 'text',
            fileNames: ['dockerfile'],
            light: true,
            highContrast: true,
          },
        ],
      },
      config,
      createEmptyManifest(),
      ['Dockerfile.dev', 'unrelated.txt']
    );
    expect(manifest.fileNames).toEqual({
      dockerfile: 'docker',
      'dockerfile.dev': 'docker',
    });
    expect(manifest.light?.fileNames).toEqual({});
    expect(manifest.highContrast?.fileNames).toEqual({});
    expect(manifest.iconDefinitions?.docker).toEqual({
      iconPath: './../icons/docker.svg',
    });
    expect(manifest.fileExtensions).toEqual({});
  });

  it('supports embedded stars through the public generator without breaking extension overrides', () => {
    const manifest = generateManifest(
      {
        files: {
          associations: {
            '*.config*.json': 'settings',
            '*.sample.ts': 'angular',
            '**.md': 'text',
          },
        },
      },
      ['my.config.local.json']
    );
    expect(manifest.fileNames?.['my.config.local.json']).toBe('settings');
    expect(manifest.fileExtensions?.['sample.ts']).toBe('angular');
    expect(manifest.fileExtensions?.md).toBe('text');
    expect(manifest.fileNames?.['readme.md']).toBeUndefined();
    expect(
      Object.keys(manifest.fileNames ?? {}).some((name) => name.includes('*'))
    ).toBe(false);
  });

  it('removes expanded filenames when the workspace changes', () => {
    const config = { files: { associations: { 'Dockerfile*': 'docker' } } };
    expect(
      generateManifest(config, ['Dockerfile.my-workspace']).fileNames?.[
        'dockerfile.my-workspace'
      ]
    ).toBe('docker');
    expect(
      generateManifest(config, []).fileNames?.['dockerfile.my-workspace']
    ).toBeUndefined();
  });

  it('reuses static matches and returns only additional workspace associations', () => {
    const config = {
      'Dockerfile*': 'docker',
      '*config*.json': 'settings',
      'Dockerfile.exact': 'text',
      '*.ts': 'typescript',
    };
    const resolver = createFileAssociationResolver(config, [
      'Dockerfile',
      'my.config.json',
    ]);
    expect(resolver.staticAssociations).toEqual({
      dockerfile: 'docker',
      'my.config.json': 'settings',
      'dockerfile.exact': 'text',
      '*.ts': 'typescript',
    });
    const before = structuredClone(resolver.staticAssociations);
    expect(
      resolver.resolve([
        'Dockerfile',
        'Dockerfile.exact',
        'DOCKERFILE.NEW',
        'Dockerfile.new',
        'other.config.json',
      ])
    ).toEqual({ 'dockerfile.new': 'docker', 'other.config.json': 'settings' });
    expect(resolver.resolve([])).toEqual({});
    expect(resolver.staticAssociations).toEqual(before);
  });

  it('tests patterns only for newly encountered names and evicts removed choices', () => {
    const resolver = createFileAssociationResolver({
      'Dockerfile*': 'docker',
      '*config*': 'settings',
    });
    const spy = vi.spyOn(RegExp.prototype, 'test');
    try {
      resolver.resolve(['Dockerfile.one']);
      const first = spy.mock.calls.length;
      spy.mockClear();
      resolver.resolve(['DOCKERFILE.ONE', 'Dockerfile.two']);
      const added = spy.mock.calls.length;
      spy.mockClear();
      resolver.resolve(['Dockerfile.two']);
      const retained = spy.mock.calls.length;
      spy.mockClear();
      resolver.resolve(['Dockerfile.one', 'Dockerfile.two']);
      const readded = spy.mock.calls.length;
      expect(first).toBe(2);
      expect(added).toBe(2);
      expect(retained).toBe(0);
      expect(readded).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('copies only changed mappings and definitions without mutating the base', () => {
    const config = getDefaultConfig();
    const base = generateManifest(config);
    const original = structuredClone(base);
    const manifest = withFileAssociations(base, config, {
      'new.name': 'typescript',
    });
    expect(manifest.fileNames).not.toBe(base.fileNames);
    expect(manifest.fileExtensions).toBe(base.fileExtensions);
    expect(manifest.iconDefinitions).toBe(base.iconDefinitions);
    expect(manifest.light).toBe(base.light);
    expect(manifest.highContrast).toBe(base.highContrast);
    const unknown = withFileAssociations(base, config, {
      'new.name': 'brand-new-icon',
    });
    expect(unknown.iconDefinitions).not.toBe(base.iconDefinitions);
    expect(unknown.iconDefinitions?.['brand-new-icon']).toEqual({
      iconPath: './../icons/brand-new-icon.svg',
    });
    expect(base).toEqual(original);
  });

  it('copies theme overrides independently when clearing stale variants', () => {
    const config = getDefaultConfig();
    const base = createEmptyManifest();
    base.fileNames!['same.name'] = 'text';
    base.light!.fileNames!['same.name'] = 'text_light';
    base.highContrast!.fileNames!['same.name'] = 'text_highContrast';
    base.iconDefinitions!.text = { iconPath: './../icons/text.svg' };
    const manifest = withFileAssociations(base, config, {
      'same.name': 'text',
    });
    expect(manifest.fileNames).toBe(base.fileNames);
    expect(manifest.light?.fileNames?.['same.name']).toBeUndefined();
    expect(manifest.highContrast?.fileNames?.['same.name']).toBeUndefined();
    expect(manifest.light?.fileExtensions).toBe(base.light?.fileExtensions);
    expect(base.light?.fileNames?.['same.name']).toBe('text_light');
    expect(base.highContrast?.fileNames?.['same.name']).toBe(
      'text_highContrast'
    );
  });

  it('passes resolved associations into base generation without resolving them again', () => {
    const config = getDefaultConfig();
    config.files.associations = { 'Dockerfile*': 'docker', '**.md': 'text' };
    const knownNames = fileIcons.icons
      .filter(
        (icon) =>
          !icon.enabledFor ||
          icon.enabledFor.some((pack) => pack === config.activeIconPack)
      )
      .flatMap((icon) => icon.fileNames ?? []);
    const resolver = createFileAssociationResolver(
      config.files.associations,
      knownNames
    );
    const spy = vi.spyOn(associationTools, 'resolveFileAssociations');
    try {
      const base = generateManifestWithFileAssociations(
        config,
        resolver.staticAssociations
      );
      expect(spy).not.toHaveBeenCalled();
      const manifest = withFileAssociations(
        base,
        config,
        resolver.resolve(['Dockerfile.custom'])
      );
      expect(spy).not.toHaveBeenCalled();
      expect(manifest).toEqual(generateManifest(config, ['Dockerfile.custom']));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it.each<IconAssociations>([
    {
      'Dockerfile*': 'docker',
      '*config*.json': 'settings',
      'Dockerfile.exact': 'text',
    },
    { '*': 'text', '*.ts': 'typescript', '**.md': 'markdown' },
    { 'new-*': './custom-icon', '*.config*.json': 'settings' },
  ])(
    'updates a cached base exactly like a full generation: %j',
    (associations) => {
      const config = getDefaultConfig();
      config.files.associations = associations;
      const base = generateManifest(config);
      const original = structuredClone(base);
      const knownNames = fileIcons.icons
        .filter(
          (icon) =>
            !icon.enabledFor ||
            icon.enabledFor.some((pack) => pack === config.activeIconPack)
        )
        .flatMap((icon) => icon.fileNames ?? []);
      for (const names of [
        [
          'Dockerfile.custom',
          'Dockerfile.exact',
          'my.config.local.json',
          'new-icon',
          'other.ts',
        ],
        ['new-other', 'unrelated.md'],
        [],
      ]) {
        const manifest = withFileAssociations(
          base,
          config,
          resolveFileAssociations(associations, [...knownNames, ...names])
        );
        expect(manifest).toEqual(generateManifest(config, names));
        expect(manifest.folderNames).toBe(base.folderNames);
        expect(manifest.languageIds).toBe(base.languageIds);
        expect(base).toEqual(original);
      }
    }
  );
});
