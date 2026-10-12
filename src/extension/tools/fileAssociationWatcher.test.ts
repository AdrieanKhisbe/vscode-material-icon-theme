import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileType,
  type Uri,
  type WorkspaceFoldersChangeEvent,
  workspace,
} from 'vscode';
import { watchFileAssociations } from './fileAssociationWatcher';

const callbacks = vi.hoisted(() => ({
  create: (_uri: Uri) => {},
  delete: (_uri: Uri) => {},
  folders: (_event: WorkspaceFoldersChangeEvent) => {},
}));
const dispose = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => ({
  // biome-ignore lint/style/useNamingConvention: Match the VS Code API export.
  FileType: {
    // biome-ignore lint/style/useNamingConvention: Match the VS Code enum.
    File: 1,
    // biome-ignore lint/style/useNamingConvention: Match the VS Code enum.
    Directory: 2,
  },
  // biome-ignore lint/style/useNamingConvention: Match the VS Code API export.
  RelativePattern: class {
    constructor(
      public baseUri: Uri,
      public pattern: string
    ) {}
  },
  workspace: {
    findFiles: vi.fn(),
    fs: { stat: vi.fn() },
    createFileSystemWatcher: vi.fn(() => ({
      dispose,
      onDidCreate: (callback: (uri: Uri) => void) => {
        callbacks.create = callback;
        return { dispose };
      },
      onDidDelete: (callback: (uri: Uri) => void) => {
        callbacks.delete = callback;
        return { dispose };
      },
    })),
    onDidChangeWorkspaceFolders: (
      callback: (event: WorkspaceFoldersChangeEvent) => void
    ) => {
      callbacks.folders = callback;
      return { dispose };
    },
  },
}));

const uri = (path: string) =>
  ({ path, toString: () => `file://${path}` }) as Uri;
const associations = { 'Dockerfile*': 'docker' };
const settle = () => vi.advanceTimersByTimeAsync(10);
const folders = (
  added: string[],
  removed: string[]
): WorkspaceFoldersChangeEvent => ({
  added: added.map((path, index) => ({ uri: uri(path), name: path, index })),
  removed: removed.map((path, index) => ({
    uri: uri(path),
    name: path,
    index,
  })),
});

describe('incremental filename association watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(workspace.findFiles).mockResolvedValue([]);
    vi.mocked(workspace.fs.stat).mockResolvedValue({
      type: FileType.File,
      size: 0,
      ctime: 0,
      mtime: 0,
    });
  });
  afterEach(() => vi.useRealTimers());

  it('does not scan or create watchers without filename globs', async () => {
    const watcher = watchFileAssociations(vi.fn());
    expect(
      await watcher.getFileNames({ '*.ts': 'typescript', '**.json': 'json' })
    ).toEqual([]);
    expect(workspace.findFiles).not.toHaveBeenCalled();
    expect(workspace.createFileSystemWatcher).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it('scans once and reuses the index when patterns change', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/root/Dockerfile.custom'),
      uri('/root/config.json'),
    ]);
    const watcher = watchFileAssociations(vi.fn());
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.custom',
    ]);
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.custom',
    ]);
    expect(await watcher.getFileNames({ '*config*': 'settings' })).toEqual([
      'config.json',
    ]);
    expect(workspace.findFiles).toHaveBeenCalledTimes(1);
    expect(workspace.findFiles).toHaveBeenCalledWith('**/*', null);
    watcher.dispose();
  });

  it('updates matching files incrementally and ignores unrelated changes', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    await watcher.getFileNames(associations);
    callbacks.create(uri('/root/unrelated.txt'));
    await settle();
    callbacks.delete(uri('/root/unrelated.txt'));
    await vi.advanceTimersByTimeAsync(210);
    expect(refresh).not.toHaveBeenCalled();
    callbacks.create(uri('/root/Dockerfile.custom'));
    callbacks.create(uri('/root/Dockerfile.custom'));
    await vi.advanceTimersByTimeAsync(209);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.custom',
    ]);
    expect(workspace.findFiles).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('retains an association until the last case-insensitive duplicate is deleted', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/one/Dockerfile.custom'),
      uri('/two/DOCKERFILE.CUSTOM'),
    ]);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    await watcher.getFileNames(associations);
    callbacks.delete(uri('/one/Dockerfile.custom'));
    await vi.advanceTimersByTimeAsync(210);
    expect(refresh).not.toHaveBeenCalled();
    callbacks.delete(uri('/two/DOCKERFILE.CUSTOM'));
    await vi.advanceTimersByTimeAsync(210);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await watcher.getFileNames(associations)).toEqual([]);
    expect(workspace.findFiles).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('does not refresh after moves or create/delete bursts leave the same names', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/one/Dockerfile.custom'),
    ]);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    await watcher.getFileNames(associations);
    callbacks.delete(uri('/one/Dockerfile.custom'));
    callbacks.create(uri('/two/Dockerfile.custom'));
    callbacks.create(uri('/two/Dockerfile.temporary'));
    callbacks.delete(uri('/two/Dockerfile.temporary'));
    await vi.advanceTimersByTimeAsync(210);
    expect(refresh).not.toHaveBeenCalled();
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.custom',
    ]);
    watcher.dispose();
  });

  it('removes directory descendants without rescanning or touching adjacent directories', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/root/sub/Dockerfile.one'),
      uri('/root/sub/nested/Dockerfile.two'),
      uri('/root/submarine/Dockerfile.three'),
    ]);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    await watcher.getFileNames(associations);
    callbacks.delete(uri('/root/sub'));
    await vi.advanceTimersByTimeAsync(210);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.three',
    ]);
    expect(workspace.findFiles).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('scans only a newly created directory and does not associate the directory itself', async () => {
    const watcher = watchFileAssociations(vi.fn().mockResolvedValue(undefined));
    await watcher.getFileNames(associations);
    vi.mocked(workspace.fs.stat).mockResolvedValue({
      type: FileType.Directory,
      size: 0,
      ctime: 0,
      mtime: 0,
    });
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/root/Dockerfile.directory/Dockerfile.child'),
    ]);
    callbacks.create(uri('/root/Dockerfile.directory'));
    await settle();
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.child',
    ]);
    const pattern = vi.mocked(workspace.findFiles).mock.calls.at(-1)![0];
    expect(pattern).toMatchObject({
      baseUri: { path: '/root/Dockerfile.directory' },
      pattern: '**/*',
    });
    watcher.dispose();
  });

  it('scans added workspace folders and removes departed folders from the index', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/one/Dockerfile.one'),
    ]);
    const watcher = watchFileAssociations(vi.fn().mockResolvedValue(undefined));
    await watcher.getFileNames(associations);
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/two/Dockerfile.two'),
    ]);
    callbacks.folders(folders(['/two'], ['/one']));
    await settle();
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.two',
    ]);
    expect(vi.mocked(workspace.findFiles).mock.calls.at(-1)![0]).toMatchObject({
      baseUri: { path: '/two' },
      pattern: '**/*',
    });
    watcher.dispose();
  });

  it('disposes watchers when globs are removed and initializes afresh when re-enabled', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    await watcher.getFileNames(associations);
    callbacks.create(uri('/root/Dockerfile.custom'));
    await settle();
    expect(await watcher.getFileNames({})).toEqual([]);
    await vi.advanceTimersByTimeAsync(210);
    expect(refresh).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(4);
    await watcher.getFileNames(associations);
    expect(workspace.findFiles).toHaveBeenCalledTimes(2);
    expect(workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it('applies events arriving during the initial scan after the scan completes', async () => {
    let finish!: (files: Uri[]) => void;
    vi.mocked(workspace.findFiles).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    const initial = watcher.getFileNames(associations);
    await settle();
    callbacks.create(uri('/root/Dockerfile.new'));
    finish([]);
    await initial;
    await vi.advanceTimersByTimeAsync(210);
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.new',
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(workspace.findFiles).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('cancels pending refreshes when disposed', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    await watcher.getFileNames(associations);
    callbacks.create(uri('/root/Dockerfile.custom'));
    await settle();
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(210);
    expect(refresh).not.toHaveBeenCalled();
    expect(await watcher.getFileNames(associations)).toEqual([]);
  });

  it('handles large unrelated bursts without rescanning or requesting regeneration', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValue(
      Array.from({ length: 10000 }, (_, index) =>
        uri(`/root/file-${index}.txt`)
      )
    );
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    await watcher.getFileNames(associations);
    for (let index = 0; index < 1000; index++) {
      callbacks.create(uri(`/root/new-${index}.txt`));
    }
    await vi.advanceTimersByTimeAsync(210);
    expect(workspace.findFiles).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(await watcher.getFileNames({ 'new-*': 'text' })).toHaveLength(1000);
    expect(workspace.findFiles).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('retries failed initial scans without duplicating subscriptions', async () => {
    const watcher = watchFileAssociations(vi.fn().mockResolvedValue(undefined));
    vi.mocked(workspace.findFiles).mockRejectedValueOnce(
      new Error('scan failed')
    );
    await expect(watcher.getFileNames(associations)).rejects.toThrow(
      'scan failed'
    );
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/root/Dockerfile.custom'),
    ]);
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.custom',
    ]);
    expect(workspace.createFileSystemWatcher).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('deduplicates creation events and bounds concurrent stat requests', async () => {
    let active = 0;
    let maximum = 0;
    vi.mocked(workspace.fs.stat).mockImplementation(async () => {
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { type: FileType.File, size: 0, ctime: 0, mtime: 0 };
    });
    const watcher = watchFileAssociations(vi.fn().mockResolvedValue(undefined));
    await watcher.getFileNames(associations);
    for (let index = 0; index < 64; index++) {
      callbacks.create(uri(`/root/Dockerfile.${index}`));
      callbacks.create(uri(`/root/Dockerfile.${index}`));
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(maximum).toBe(16);
    expect(workspace.fs.stat).toHaveBeenCalledTimes(64);
    expect(await watcher.getFileNames(associations)).toHaveLength(64);
    watcher.dispose();
  });

  it('preserves mutation order when stat results complete out of order', async () => {
    vi.mocked(workspace.fs.stat).mockImplementation(async (file) => {
      await new Promise((resolve) =>
        setTimeout(resolve, file.path.endsWith('before') ? 20 : 1)
      );
      return { type: FileType.File, size: 0, ctime: 0, mtime: 0 };
    });
    const watcher = watchFileAssociations(vi.fn().mockResolvedValue(undefined));
    await watcher.getFileNames(associations);
    callbacks.create(uri('/root/sub/Dockerfile.before'));
    callbacks.delete(uri('/root/sub'));
    callbacks.create(uri('/root/sub/Dockerfile.after'));
    await vi.advanceTimersByTimeAsync(100);
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.after',
    ]);
    watcher.dispose();
  });

  it('stops starting metadata requests when disposed during a batch', async () => {
    vi.mocked(workspace.fs.stat).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { type: FileType.File, size: 0, ctime: 0, mtime: 0 };
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    await watcher.getFileNames(associations);
    for (let index = 0; index < 64; index++)
      callbacks.create(uri(`/root/Dockerfile.${index}`));
    await vi.advanceTimersByTimeAsync(10);
    expect(workspace.fs.stat).toHaveBeenCalledTimes(16);
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(300);
    expect(workspace.fs.stat).toHaveBeenCalledTimes(16);
    expect(refresh).not.toHaveBeenCalled();
    expect(await watcher.getFileNames(associations)).toEqual([]);
  });
});
