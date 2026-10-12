import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExtensionContext, workspace } from 'vscode';
import {
  applyConfigToIcons,
  clearCloneFolder,
  generateCustomCloneManifest,
  generateManifest,
  getDefaultConfig,
  renameIconFiles,
  writeToFile,
} from '../../core';
import { getCurrentConfig } from '../shared/config';
import { detectConfigChanges } from './changeDetection';

vi.mock('vscode', () => ({
  workspace: { findFiles: vi.fn() },
}));
vi.mock('../shared/config', () => ({ getCurrentConfig: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: vi.fn(() => true),
}));
vi.mock('../../core', async (importOriginal) => {
  const core = await importOriginal<typeof import('../../core')>();
  return {
    ...core,
    applyConfigToIcons: vi.fn(),
    renameIconFiles: vi.fn(),
    clearCloneFolder: vi.fn(),
    generateCustomCloneManifest: vi.fn(async () => ({})),
    generateManifest: vi.fn(core.generateManifest),
    writeToFile: vi.fn(),
  };
});

describe('workspace filename association refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentConfig).mockReturnValue(getDefaultConfig());
    vi.mocked(workspace.findFiles).mockResolvedValue([]);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(generateCustomCloneManifest).mockResolvedValue({});
  });

  const createContext = () => {
    const config = structuredClone(getCurrentConfig());
    return {
      extension: { packageJSON: { version: 'test' } },
      globalState: {
        get: () => ({ version: 'test', config }),
        update: vi.fn(),
      },
    } as unknown as ExtensionContext;
  };

  const writtenManifest = () =>
    JSON.parse(vi.mocked(writeToFile).mock.calls.at(-1)![1] as string);

  it('refreshes unchanged settings and removes deleted filename matches', async () => {
    getCurrentConfig().files.associations = { 'Dockerfile*': 'docker' };
    const context = createContext();
    await detectConfigChanges(
      undefined,
      context,
      ['Dockerfile.my-workspace'],
      true
    );
    expect(workspace.findFiles).not.toHaveBeenCalled();
    expect(applyConfigToIcons).not.toHaveBeenCalled();
    expect(renameIconFiles).not.toHaveBeenCalled();
    expect(clearCloneFolder).not.toHaveBeenCalled();
    expect(writtenManifest().fileNames['dockerfile.my-workspace']).toBe(
      'docker'
    );

    await detectConfigChanges(undefined, context, [], true);
    expect(generateManifest).toHaveBeenCalledTimes(1);
    expect(generateCustomCloneManifest).toHaveBeenCalledTimes(1);
    expect(
      writtenManifest().fileNames['dockerfile.my-workspace']
    ).toBeUndefined();
  });

  it('does not scan or rewrite unchanged settings with only extension associations', async () => {
    getCurrentConfig().files.associations = { '*.ts': 'typescript' };
    await detectConfigChanges(undefined, createContext(), [], true);
    expect(workspace.findFiles).not.toHaveBeenCalled();
    expect(writeToFile).not.toHaveBeenCalled();
  });

  it('skips generation when only duplicate, built-in, or exact filename matches change', async () => {
    getCurrentConfig().files.associations = {
      'Dockerfile*': 'text',
      'Dockerfile.exact': 'docker',
    };
    const context = createContext();
    await detectConfigChanges(undefined, context, ['Dockerfile.custom'], true);
    await detectConfigChanges(
      undefined,
      context,
      [
        'Dockerfile.custom',
        'DOCKERFILE.CUSTOM',
        'Dockerfile',
        'Dockerfile.exact',
      ],
      true
    );
    expect(generateManifest).toHaveBeenCalledTimes(1);
    expect(writeToFile).toHaveBeenCalledTimes(1);
  });

  it('reuses clone definitions without rewriting clone SVGs on filename refreshes', async () => {
    getCurrentConfig().files.associations = { 'Dockerfile*': 'docker' };
    getCurrentConfig().files.customClones = [
      {
        name: 'custom-docker',
        base: 'docker',
        color: '#ff0000',
        fileNames: ['Dockerfile.clone'],
      },
    ];
    vi.mocked(generateCustomCloneManifest).mockResolvedValue({
      fileNames: { 'dockerfile.clone': 'custom-docker' },
      iconDefinitions: {
        'custom-docker': { iconPath: './clones/custom-docker.svg' },
      },
    });
    const context = createContext();
    await detectConfigChanges(undefined, context, ['Dockerfile.one'], true);
    await detectConfigChanges(
      undefined,
      context,
      ['Dockerfile.one', 'Dockerfile.two'],
      true
    );
    expect(generateCustomCloneManifest).toHaveBeenCalledTimes(1);
    expect(clearCloneFolder).not.toHaveBeenCalled();
    expect(writtenManifest().fileNames['dockerfile.two']).toBe('docker');
    expect(writtenManifest().fileNames['dockerfile.clone']).toBe(
      'custom-docker'
    );
    expect(writtenManifest().iconDefinitions['custom-docker']).toEqual({
      iconPath: './clones/custom-docker.svg',
    });
  });

  it('retries a failed manifest write instead of treating it as applied', async () => {
    getCurrentConfig().files.associations = { 'Dockerfile*': 'docker' };
    const context = createContext();
    vi.mocked(writeToFile).mockRejectedValueOnce(new Error('write failed'));
    await expect(
      detectConfigChanges(undefined, context, ['Dockerfile.one'], true)
    ).rejects.toThrow('write failed');
    await detectConfigChanges(undefined, context, ['Dockerfile.one'], true);
    expect(writeToFile).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cached base when settings change', async () => {
    getCurrentConfig().files.associations = { 'Dockerfile*': 'docker' };
    const context = createContext();
    await detectConfigChanges(undefined, context, ['Dockerfile.custom'], true);
    getCurrentConfig().files.associations = { 'Dockerfile*': 'text' };
    await detectConfigChanges(undefined, context, ['Dockerfile.custom'], true);
    expect(generateManifest).toHaveBeenCalledTimes(2);
    expect(writtenManifest().fileNames['dockerfile.custom']).toBe('text');
  });

  it('restores normal filename mappings when a glob is removed', async () => {
    getCurrentConfig().files.associations = { 'Dockerfile*': 'text' };
    const context = createContext();
    getCurrentConfig().files.associations = {};
    await detectConfigChanges(undefined, context);
    expect(workspace.findFiles).not.toHaveBeenCalled();
    expect(writtenManifest().fileNames.dockerfile).toBe('docker');
    expect(
      writtenManifest().fileNames['dockerfile.my-workspace']
    ).toBeUndefined();
  });
});
