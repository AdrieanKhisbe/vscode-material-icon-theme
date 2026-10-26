import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileType,
  type Uri,
  type WorkspaceFolder,
  type WorkspaceFoldersChangeEvent,
  workspace,
} from 'vscode';
import { watchFileAssociations } from './fileAssociationWatcher';

const callbacks = vi.hoisted(() => ({
  workspaceFolders: [] as WorkspaceFolder[],
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
    get workspaceFolders() {
      return callbacks.workspaceFolders;
    },
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
    callbacks.workspaceFolders = folders(['/root'], []).added.slice();
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

  it('reuses snapshots until matching names or patterns change', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/root/Dockerfile.first'),
      uri('/root/config.json'),
    ]);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    const first = await watcher.getFileNames(associations);
    expect(await watcher.getFileNames(associations)).toBe(first);

    callbacks.create(uri('/other/DOCKERFILE.FIRST'));
    callbacks.create(uri('/root/unrelated.txt'));
    await settle();
    expect(await watcher.getFileNames(associations)).toBe(first);

    callbacks.create(uri('/root/Dockerfile.second'));
    await vi.advanceTimersByTimeAsync(210);
    expect(refresh).toHaveBeenCalledTimes(1);
    const second = await watcher.getFileNames(associations);
    expect(second).toEqual(['dockerfile.first', 'dockerfile.second']);
    expect(second).not.toBe(first);
    expect(first).toEqual(['dockerfile.first']);
    expect(await watcher.getFileNames(associations)).toBe(second);

    expect(await watcher.getFileNames({ '*config*': 'settings' })).toEqual([
      'config.json',
    ]);
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

  it('coalesces nested directory scans even when the child event arrives first', async () => {
    const watcher = watchFileAssociations(vi.fn().mockResolvedValue(undefined));
    await watcher.getFileNames(associations);
    vi.mocked(workspace.fs.stat).mockResolvedValue({
      type: FileType.Directory,
      size: 0,
      ctime: 0,
      mtime: 0,
    });
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/root/parent/Dockerfile.one'),
      uri('/root/parent/child/Dockerfile.two'),
    ]);
    callbacks.create(uri('/root/parent/child'));
    callbacks.create(uri('/root/parent'));
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.one',
      'dockerfile.two',
    ]);
    expect(workspace.findFiles).toHaveBeenCalledTimes(2);
    expect(vi.mocked(workspace.findFiles).mock.calls[1][0]).toMatchObject({
      baseUri: { path: '/root/parent' },
    });
    watcher.dispose();
  });

  it('rescans recreated directories across deletion boundaries', async () => {
    const watcher = watchFileAssociations(vi.fn().mockResolvedValue(undefined));
    await watcher.getFileNames(associations);
    vi.mocked(workspace.fs.stat).mockResolvedValue({
      type: FileType.Directory,
      size: 0,
      ctime: 0,
      mtime: 0,
    });
    vi.mocked(workspace.findFiles)
      .mockResolvedValueOnce([uri('/root/parent/Dockerfile.before')])
      .mockResolvedValueOnce([uri('/root/parent/Dockerfile.after')]);
    callbacks.create(uri('/root/parent'));
    callbacks.delete(uri('/root/parent'));
    callbacks.create(uri('/root/parent'));
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.after',
    ]);
    expect(workspace.findFiles).toHaveBeenCalledTimes(3);
    watcher.dispose();
  });

  it('coalesces nested workspace additions and falls back to children after a failed parent scan', async () => {
    const watcher = watchFileAssociations(vi.fn().mockResolvedValue(undefined));
    await watcher.getFileNames(associations);
    vi.mocked(workspace.findFiles)
      .mockRejectedValueOnce(new Error('parent unavailable'))
      .mockResolvedValueOnce([uri('/root/parent/child/Dockerfile.child')]);
    callbacks.folders(folders(['/root/parent/child', '/root/parent'], []));
    expect(await watcher.getFileNames(associations)).toEqual([
      'dockerfile.child',
    ]);
    expect(workspace.findFiles).toHaveBeenCalledTimes(3);
    watcher.dispose();
  });
  it('shares one file scan with folder discovery and reuses both snapshots', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/root/project-api/src/file.ts'),
      uri('/root/project-web/file.ts'),
    ]);
    const watcher = watchFileAssociations(vi.fn());
    const rules = { 'project-*': 'src' };
    const names = await watcher.getNames({ '*file*': 'text' }, rules);
    expect(names).toEqual({
      fileNames: ['file.ts'],
      folderNames: ['project-api', 'project-web'],
      rootFolderNames: [],
    });
    const next = await watcher.getNames({ '*file*': 'text' }, rules);
    expect(next.fileNames).toBe(names.fileNames);
    expect(next.folderNames).toBe(names.folderNames);
    expect((await watcher.getNames({}, { 's*': 'src' })).folderNames).toEqual([
      'src',
    ]);
    expect(workspace.findFiles).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('enables folder matching from an existing file index without rescanning', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/root/project-api/file.ts'),
    ]);
    const watcher = watchFileAssociations(vi.fn());
    await watcher.getNames({ '*file*': 'text' });
    expect(
      (await watcher.getNames({ '*file*': 'text' }, { 'project-*': 'src' }))
        .folderNames
    ).toEqual(['project-api']);
    expect(workspace.findFiles).toHaveBeenCalledTimes(1);
    expect(workspace.createFileSystemWatcher).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('discovers newly created empty folders and retains them after their last file is deleted', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    const rules = { 'project-*': 'src' };
    expect((await watcher.getNames({}, rules)).folderNames).toEqual([]);
    vi.mocked(workspace.fs.stat).mockResolvedValueOnce({
      type: FileType.Directory,
      size: 0,
      ctime: 0,
      mtime: 0,
    });
    callbacks.create(uri('/root/project-empty'));
    await vi.advanceTimersByTimeAsync(210);
    expect((await watcher.getNames({}, rules)).folderNames).toEqual([
      'project-empty',
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    callbacks.create(uri('/root/project-empty/file.ts'));
    await settle();
    callbacks.delete(uri('/root/project-empty/file.ts'));
    await vi.advanceTimersByTimeAsync(210);
    expect((await watcher.getNames({}, rules)).folderNames).toEqual([
      'project-empty',
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    callbacks.delete(uri('/root/project-empty'));
    await vi.advanceTimersByTimeAsync(210);
    expect((await watcher.getNames({}, rules)).folderNames).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it('retains duplicate folder names until their last directory is removed', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/root/one/project-api/file.ts'),
      uri('/root/two/PROJECT-API/file.ts'),
    ]);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    const rules = { 'project-*': 'src' };
    await watcher.getNames({}, rules);
    callbacks.delete(uri('/root/one'));
    await vi.advanceTimersByTimeAsync(210);
    expect((await watcher.getNames({}, rules)).folderNames).toEqual([
      'project-api',
    ]);
    expect(refresh).not.toHaveBeenCalled();
    callbacks.delete(uri('/root/two'));
    await vi.advanceTimersByTimeAsync(210);
    expect((await watcher.getNames({}, rules)).folderNames).toEqual([]);
    expect(refresh).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('updates folder renames even when filenames stay the same', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValueOnce([
      uri('/root/project-old/file.ts'),
    ]);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    const rules = { 'project-*': 'src' };
    await watcher.getNames({ '*file*': 'text' }, rules);
    vi.mocked(workspace.fs.stat).mockResolvedValueOnce({
      type: FileType.Directory,
      size: 0,
      ctime: 0,
      mtime: 0,
    });
    vi.mocked(workspace.findFiles).mockResolvedValueOnce([
      uri('/root/project-new/file.ts'),
    ]);
    callbacks.delete(uri('/root/project-old'));
    callbacks.create(uri('/root/project-new'));
    await vi.advanceTimersByTimeAsync(210);
    expect(await watcher.getNames({ '*file*': 'text' }, rules)).toEqual({
      fileNames: ['file.ts'],
      folderNames: ['project-new'],
      rootFolderNames: [],
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    watcher.dispose();
  });

  it('matches root basenames independently of display aliases without scans or file watchers', async () => {
    callbacks.workspaceFolders = [
      { uri: uri('/project-root'), name: 'unrelated-alias', index: 0 },
    ];
    const refresh = vi.fn().mockResolvedValue(undefined);
    const watcher = watchFileAssociations(refresh);
    const rules = { 'project-*': 'app' };
    expect(await watcher.getNames({}, {}, rules)).toEqual({
      fileNames: [],
      folderNames: [],
      rootFolderNames: ['project-root'],
    });
    callbacks.workspaceFolders = folders(['/project-second'], []).added.slice();
    callbacks.folders(folders(['/project-second'], ['/project-root']));
    await vi.advanceTimersByTimeAsync(210);
    expect((await watcher.getNames({}, {}, rules)).rootFolderNames).toEqual([
      'project-second',
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(workspace.findFiles).not.toHaveBeenCalled();
    expect(workspace.fs.stat).not.toHaveBeenCalled();
    expect(workspace.createFileSystemWatcher).not.toHaveBeenCalled();
    watcher.dispose();
  });

  it('does not lose explicitly created empty child folders when parent scans are coalesced', async () => {
    const watcher = watchFileAssociations(vi.fn());
    const rules = { 'project-*': 'src' };
    await watcher.getNames({}, rules);
    vi.mocked(workspace.fs.stat).mockResolvedValue({
      type: FileType.Directory,
      size: 0,
      ctime: 0,
      mtime: 0,
    });
    callbacks.create(uri('/root/parent'));
    callbacks.create(uri('/root/parent/project-empty'));
    await settle();
    expect((await watcher.getNames({}, rules)).folderNames).toEqual([
      'project-empty',
    ]);
    expect(workspace.findFiles).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it('clears the recursive index when only root patterns remain and rescans when re-enabled', async () => {
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/root/project-api/file.ts'),
    ]);
    const watcher = watchFileAssociations(vi.fn());
    const rules = { 'project-*': 'src' };
    await watcher.getNames({}, rules);
    expect(
      (await watcher.getNames({}, {}, { '*': 'app' })).folderNames
    ).toEqual([]);
    vi.mocked(workspace.findFiles).mockResolvedValue([]);
    expect((await watcher.getNames({}, rules)).folderNames).toEqual([]);
    expect(workspace.findFiles).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });
  it('keeps workspace roots outside the regular-folder namespace', async () => {
    callbacks.workspaceFolders = folders(['/project-root'], []).added.slice();
    vi.mocked(workspace.findFiles).mockResolvedValue([
      uri('/project-root/project-child/file.ts'),
    ]);
    const watcher = watchFileAssociations(vi.fn());
    expect(
      await watcher.getNames({}, { 'project-*': 'src' }, { 'project-*': 'app' })
    ).toEqual({
      fileNames: [],
      folderNames: ['project-child'],
      rootFolderNames: ['project-root'],
    });
    watcher.dispose();
  });

  it('does not scan for unsupported folder path globs', async () => {
    const watcher = watchFileAssociations(vi.fn());
    expect(
      await watcher.getNames({}, { 'parent/*': 'src' }, { 'parent/*': 'app' })
    ).toEqual({
      fileNames: [],
      folderNames: [],
      rootFolderNames: [],
    });
    expect(workspace.findFiles).not.toHaveBeenCalled();
    expect(workspace.createFileSystemWatcher).not.toHaveBeenCalled();
    watcher.dispose();
  });
});
