import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ExtensionContext, workspace } from 'vscode';
import {
  applyConfigToIcons,
  clearCloneFolder,
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
vi.mock('../../core', async (importOriginal) => {
  const core = await importOriginal<typeof import('../../core')>();
  return {
    ...core,
    applyConfigToIcons: vi.fn(),
    renameIconFiles: vi.fn(),
    clearCloneFolder: vi.fn(),
    customClonesIcons: vi.fn(async (manifest) => manifest),
    writeToFile: vi.fn(),
  };
});

describe('workspace filename association refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentConfig).mockReturnValue(getDefaultConfig());
    vi.mocked(workspace.findFiles).mockResolvedValue([]);
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
    vi.mocked(workspace.findFiles).mockResolvedValue([
      { path: '/workspace/nested/Dockerfile.my-workspace' } as Awaited<
        ReturnType<typeof workspace.findFiles>
      >[number],
    ]);
    await detectConfigChanges(undefined, context, true);
    expect(workspace.findFiles).toHaveBeenCalledWith('**/*', null);
    expect(applyConfigToIcons).not.toHaveBeenCalled();
    expect(renameIconFiles).not.toHaveBeenCalled();
    expect(clearCloneFolder).not.toHaveBeenCalled();
    expect(writtenManifest().fileNames['dockerfile.my-workspace']).toBe(
      'docker'
    );

    vi.mocked(workspace.findFiles).mockResolvedValue([]);
    await detectConfigChanges(undefined, context, true);
    expect(
      writtenManifest().fileNames['dockerfile.my-workspace']
    ).toBeUndefined();
  });

  it('does not scan or rewrite unchanged settings with only extension associations', async () => {
    getCurrentConfig().files.associations = { '*.ts': 'typescript' };
    await detectConfigChanges(undefined, createContext(), true);
    expect(workspace.findFiles).not.toHaveBeenCalled();
    expect(writeToFile).not.toHaveBeenCalled();
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
