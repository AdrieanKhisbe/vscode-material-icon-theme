import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspace } from 'vscode';
import { getDefaultConfig } from '../../core';
import { getCurrentConfig } from '../shared/config';
import { watchFileAssociations } from './fileAssociationWatcher';

const callbacks = vi.hoisted(() => ({
  create: () => {},
  delete: () => {},
  folders: () => {},
}));
const dispose = vi.hoisted(() => vi.fn());

vi.mock('vscode', () => ({
  workspace: {
    createFileSystemWatcher: vi.fn(() => ({
      dispose,
      onDidCreate: (callback: () => void) => {
        callbacks.create = callback;
        return { dispose };
      },
      onDidDelete: (callback: () => void) => {
        callbacks.delete = callback;
        return { dispose };
      },
    })),
    onDidChangeWorkspaceFolders: (callback: () => void) => {
      callbacks.folders = callback;
      return { dispose };
    },
  },
}));
vi.mock('../shared/config', () => ({ getCurrentConfig: vi.fn() }));

describe('filename association watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const config = getDefaultConfig();
    config.files.associations = { 'Dockerfile*': 'docker' };
    vi.mocked(getCurrentConfig).mockReturnValue(config);
  });

  afterEach(() => vi.useRealTimers());

  it('debounces creation, deletion and workspace folder changes', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    expect(workspace.createFileSystemWatcher).toHaveBeenCalledWith(
      '**/*',
      false,
      true,
      false
    );
    callbacks.create();
    callbacks.delete();
    callbacks.folders();
    await vi.advanceTimersByTimeAsync(199);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('does not refresh for extension associations or after globs are removed', async () => {
    const config = getCurrentConfig();
    config.files.associations = { '*.ts': 'typescript', '**.json': 'json' };
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    callbacks.create();
    callbacks.delete();
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it('cancels pending refreshes and disposes subscriptions', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    callbacks.create();
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(4);
  });
});
