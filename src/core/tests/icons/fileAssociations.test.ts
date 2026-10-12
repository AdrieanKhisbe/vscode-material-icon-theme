import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../../generator/config/defaultConfig';
import {
  isFileNameGlob,
  resolveFileAssociations,
} from '../../generator/fileAssociations';
import {
  loadFileIconDefinitions,
  withFileAssociations,
} from '../../generator/fileGenerator';
import { generateManifest } from '../../generator/generateManifest';
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
