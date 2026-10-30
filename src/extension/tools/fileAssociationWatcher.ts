import { posix } from 'node:path';
import {
  type Disposable,
  type FileStat,
  FileType,
  RelativePattern,
  type Uri,
  workspace,
} from 'vscode';
import {
  createFileNameGlobMatcher,
  createFolderNameGlobMatcher,
  type IconAssociations,
  isFileNameGlob,
  isFolderNameGlob,
  logger,
} from '../../core';
import { FilePathIndex } from './filePathIndex';
import { deepEqual } from './utils/deepEqual';

export type AssociationNames = {
  fileNames: readonly string[];
  folderNames: readonly string[];
  rootFolderNames: readonly string[];
};

export type FileAssociationWatcher = Disposable & {
  getFileNames: (associations: IconAssociations) => Promise<readonly string[]>;
  getNames: (
    files: IconAssociations,
    folders?: IconAssociations,
    roots?: IconAssociations
  ) => Promise<AssociationNames>;
};

type IndexEvent =
  | { type: 'create'; uri: Uri }
  | { type: 'delete'; uri: Uri }
  | { type: 'folders'; added: readonly Uri[]; removed: readonly Uri[] };

const statConcurrency = 16;
const eventBatchDelay = 10;

/** Index workspace filenames once, then apply filesystem changes incrementally. */
export const watchFileAssociations = (
  refresh: () => Promise<void>
): FileAssociationWatcher => {
  let trackFolders = false;
  let recursive = false;
  const folderPaths = new Map<string, string>();
  const folderCounts = new Map<string, number>();
  const folderMatches = new Set<string>();
  let folderPatterns: string[] = [];
  let rootPatterns: string[] = [];
  let folderMatcher = createFolderNameGlobMatcher([]);
  let rootMatcher = createFolderNameGlobMatcher([]);
  let folderRevision = 0;
  let folderSnapshotRevision = -1;
  let folderSnapshot: string[] = [];
  let deliveredFolders: readonly string[] = [];
  let deliveredRoots: readonly string[] = [];
  const rootKeys = () =>
    (workspace.workspaceFolders ?? []).map(({ uri }) =>
      uri.toString().replace(/\/$/, '')
    );
  let workspaceRoots = rootKeys();
  const directoryName = (key: string) => {
    const roots = workspaceRoots;
    if (
      roots.includes(key) ||
      !roots.some((root) => key.startsWith(`${root}/`))
    )
      return undefined;
    return decodeURIComponent(
      key.slice(key.lastIndexOf('/') + 1)
    ).toLowerCase();
  };
  const addDirectory = (key: string) => {
    if (!trackFolders) return;
    const name = directoryName(key);
    if (name === undefined || folderPaths.has(key)) return;
    folderPaths.set(key, name);
    const count = folderCounts.get(name) ?? 0;
    folderCounts.set(name, count + 1);
    if (count === 0 && folderMatcher(name)) {
      folderMatches.add(name);
      folderRevision++;
    }
  };
  const removeDirectory = (key: string) => {
    if (!trackFolders) return;
    // Removed workspace roots may already be absent from workspaceFolders.
    const name = folderPaths.get(key);
    if (name === undefined) return;
    folderPaths.delete(key);
    const count = folderCounts.get(name);
    if (count === undefined) return;
    if (count > 1) folderCounts.set(name, count - 1);
    else {
      folderCounts.delete(name);
      if (folderMatches.delete(name)) folderRevision++;
    }
  };
  const paths = new FilePathIndex(addDirectory, removeDirectory);
  const counts = new Map<string, number>();
  const matches = new Set<string>();
  let patterns: string[] = [];
  let matcher = createFileNameGlobMatcher(patterns);
  let delivered: string[] = [];
  let initialized = false;
  let disposed = false;
  let subscriptions: Disposable[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = Promise.resolve();
  let revision = 0;
  let snapshotRevision = -1;
  let snapshot: string[] = [];
  let events: IndexEvent[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | undefined;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pending.then(operation);
    pending = next.then(
      () => {},
      (error) => logger.error(error)
    );
    return next;
  };

  const getSnapshot = () => {
    if (snapshotRevision !== revision) {
      snapshot = [...matches].sort();
      snapshotRevision = revision;
    }
    return snapshot;
  };

  const getFolderSnapshot = () => {
    if (folderSnapshotRevision !== folderRevision) {
      folderSnapshot = [...folderMatches].sort();
      folderSnapshotRevision = folderRevision;
    }
    return folderSnapshot;
  };
  const getRootSnapshot = () =>
    rootPatterns.length === 0
      ? []
      : [
          ...new Set(
            (workspace.workspaceFolders ?? [])
              .map(({ uri }) =>
                (
                  posix.basename(uri.path.replace(/\/$/, '')) ||
                  uri.authority ||
                  ''
                ).toLowerCase()
              )
              .filter(rootMatcher)
          ),
        ].sort();

  const scheduleRefresh = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      // A rename or create/delete burst may leave the same filename set.
      if (
        !deepEqual(delivered, getSnapshot()) ||
        !deepEqual(deliveredFolders, getFolderSnapshot()) ||
        !deepEqual(deliveredRoots, getRootSnapshot())
      ) {
        void refresh().catch((error) => logger.error(error));
      }
    }, 200);
  };

  const addFile = (uri: Uri) => {
    if (disposed) return;
    const name = posix.basename(uri.path).toLowerCase();
    if (!paths.add(uri.toString(), name)) return;
    const count = counts.get(name) ?? 0;
    counts.set(name, count + 1);
    if (count === 0 && matcher(name)) {
      matches.add(name);
      revision++;
    }
  };

  const removeName = (name: string) => {
    const count = counts.get(name)! - 1;
    if (count > 0) {
      counts.set(name, count);
    } else {
      counts.delete(name);
      if (matches.delete(name)) revision++;
    }
  };

  const removePath = (uri: Uri) => {
    // Directory deletion may be reported without individual child events.
    paths.remove(uri.toString()).forEach(removeName);
  };

  const scanFolder = async (uri: Uri) => {
    if (trackFolders) paths.addDirectory(uri.toString());
    const files = await workspace.findFiles(
      new RelativePattern(uri, '**/*'),
      null
    );
    files.forEach(addFile);
  };

  const scanFolders = async (folders: ReadonlyMap<string, Uri>) => {
    const roots = new Set<string>();
    for (const [key, uri] of [...folders].sort(
      ([a], [b]) => a.length - b.length
    )) {
      let parent = key;
      let covered = false;
      while (parent.lastIndexOf('/') >= 0) {
        parent = parent.slice(0, parent.lastIndexOf('/'));
        if (roots.has(parent)) {
          covered = true;
          break;
        }
      }
      if (covered || disposed) continue;
      try {
        await scanFolder(uri);
        roots.add(key);
      } catch (error) {
        logger.error(error);
      }
    }
  };

  const readCreatedPaths = async (batch: readonly IndexEvent[]) => {
    const uris = [
      ...new Map(
        batch
          .filter((event) => event.type === 'create')
          .map((event) => [event.uri.toString(), event.uri])
      ).values(),
    ];
    const stats = new Map<string, FileStat | undefined>();
    let cursor = 0;
    const worker = async () => {
      while (!disposed && cursor < uris.length) {
        const uri = uris[cursor++];
        // The path may disappear before its creation event is handled.
        const stat = await workspace.fs.stat(uri).then(
          (value) => value,
          () => undefined
        );
        stats.set(uri.toString(), stat);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(statConcurrency, uris.length) }, worker)
    );
    return stats;
  };

  const flushEvents = () => {
    clearTimeout(batchTimer);
    batchTimer = undefined;
    if (events.length === 0) return;
    const batch = events;
    events = [];
    void enqueue(async () => {
      if (disposed || (recursive && !initialized)) return;
      const before = revision;
      const beforeFolders = folderRevision;
      if (batch.some((event) => event.type === 'folders'))
        workspaceRoots = rootKeys();
      const stats = await readCreatedPaths(batch);
      const folders = new Map<string, Uri>();
      const collectFolder = (uri: Uri) => {
        const key = uri.toString();
        if (trackFolders) paths.addDirectory(key);
        folders.set(key.endsWith('/') ? key.slice(0, -1) : key, uri);
      };
      const flushFolders = async () => {
        if (recursive) await scanFolders(folders);
        folders.clear();
      };
      // Reads overlap, but mutations retain event order, including directory
      // deletions and renames. Duplicate creates share a single stat request.
      for (const event of batch) {
        if (disposed) return;
        try {
          if (event.type === 'delete') {
            // A deletion separates scan groups so recreations are scanned anew.
            await flushFolders();
            removePath(event.uri);
          } else if (event.type === 'create') {
            const stat = stats.get(event.uri.toString());
            if (!stat) continue;
            if (stat.type & FileType.Directory) collectFolder(event.uri);
            else if (stat.type & FileType.File) addFile(event.uri);
          } else {
            if (event.removed.length > 0) await flushFolders();
            for (const uri of event.removed) {
              paths
                .removeWorkspaceFolder(uri.toString(), workspaceRoots)
                .forEach(removeName);
            }
            event.added.forEach(collectFolder);
          }
        } catch (error) {
          logger.error(error);
        }
      }
      await flushFolders();
      if (trackFolders && batch.some((event) => event.type === 'folders')) {
        // Root membership can change the namespace of an already indexed path.
        folderCounts.clear();
        folderPaths.clear();
        folderMatches.clear();
        folderRevision++;
        for (const key of paths.directoryKeys()) addDirectory(key);
      }
      if (
        revision !== before ||
        folderRevision !== beforeFolders ||
        batch.some((event) => event.type === 'folders')
      )
        scheduleRefresh();
    });
  };

  const collectEvent = (event: IndexEvent) => {
    if (disposed) return;
    events.push(event);
    // Do not keep postponing processing during a continuous event stream.
    batchTimer ??= setTimeout(flushEvents, eventBatchDelay);
  };

  const startWatching = () => {
    subscriptions.forEach((subscription) => subscription.dispose());
    subscriptions = [];
    if (recursive) {
      const watcher = workspace.createFileSystemWatcher(
        '**/*',
        false,
        true,
        false
      );
      subscriptions.push(
        watcher,
        watcher.onDidCreate((uri) => collectEvent({ type: 'create', uri })),
        watcher.onDidDelete((uri) => collectEvent({ type: 'delete', uri }))
      );
    }
    subscriptions.push(
      workspace.onDidChangeWorkspaceFolders((event) => {
        collectEvent({
          type: 'folders',
          added: event.added.map((folder) => folder.uri),
          removed: event.removed.map((folder) => folder.uri),
        });
      })
    );
  };

  const stopWatching = () => {
    clearTimeout(timer);
    clearTimeout(batchTimer);
    batchTimer = undefined;
    events = [];
    subscriptions.forEach((subscription) => subscription.dispose());
    subscriptions = [];
    paths.clear();
    counts.clear();
    matches.clear();
    trackFolders = false;
    recursive = false;
    paths.setTrackDirectories(false);
    folderCounts.clear();
    folderPaths.clear();
    folderMatches.clear();
    folderRevision++;
    initialized = false;
    revision = 0;
    snapshotRevision = -1;
    snapshot = [];
  };

  const getNames: FileAssociationWatcher['getNames'] = (
    associations,
    folderAssociations = {},
    rootAssociations = {}
  ) => {
    // A configuration change or explicit snapshot must include queued events.
    flushEvents();
    return enqueue(async () => {
      if (disposed)
        return { fileNames: [], folderNames: [], rootFolderNames: [] };
      workspaceRoots = rootKeys();
      const nextPatterns = Object.keys(associations)
        .filter(isFileNameGlob)
        .sort();
      const nextFolders = Object.keys(folderAssociations)
        .filter(isFolderNameGlob)
        .sort();
      const nextRoots = Object.keys(rootAssociations)
        .filter(isFolderNameGlob)
        .sort();
      const nextRecursive = nextPatterns.length > 0 || nextFolders.length > 0;
      if (!nextRecursive && nextRoots.length === 0) {
        stopWatching();
        patterns = [];
        folderPatterns = [];
        rootPatterns = [];
        delivered = [];
        deliveredFolders = [];
        deliveredRoots = [];
        return {
          fileNames: delivered,
          folderNames: deliveredFolders,
          rootFolderNames: deliveredRoots,
        };
      }
      if (!deepEqual(rootPatterns, nextRoots)) {
        rootPatterns = nextRoots;
        rootMatcher = createFolderNameGlobMatcher(rootPatterns);
      }
      if (recursive !== nextRecursive || subscriptions.length === 0) {
        recursive = nextRecursive;
        startWatching();
      }
      if (!deepEqual(patterns, nextPatterns)) {
        patterns = nextPatterns;
        matcher = createFileNameGlobMatcher(patterns);
        revision++;
        matches.clear();
        for (const name of counts.keys()) if (matcher(name)) matches.add(name);
      }
      if (!deepEqual(folderPatterns, nextFolders)) {
        folderPatterns = nextFolders;
        folderMatcher = createFolderNameGlobMatcher(folderPatterns);
        const wasTracking = trackFolders;
        trackFolders = folderPatterns.length > 0;
        paths.setTrackDirectories(trackFolders);
        if (trackFolders && !wasTracking) {
          folderCounts.clear();
          folderPaths.clear();
          for (const key of paths.directoryKeys()) addDirectory(key);
        }
        folderMatches.clear();
        folderRevision++;
        if (trackFolders) {
          for (const name of folderCounts.keys())
            if (folderMatcher(name)) folderMatches.add(name);
        } else {
          folderCounts.clear();
          folderPaths.clear();
        }
      }
      if (recursive && !initialized) {
        const files = await workspace.findFiles('**/*', null);
        if (disposed)
          return { fileNames: [], folderNames: [], rootFolderNames: [] };
        paths.clear();
        counts.clear();
        matches.clear();
        folderCounts.clear();
        folderPaths.clear();
        folderMatches.clear();
        revision++;
        folderRevision++;
        files.forEach(addFile);
        initialized = true;
      } else if (!recursive && initialized) {
        paths.clear();
        counts.clear();
        matches.clear();
        revision++;
        initialized = false;
      }
      delivered = getSnapshot();
      deliveredFolders = getFolderSnapshot();
      deliveredRoots = getRootSnapshot();
      return {
        fileNames: delivered,
        folderNames: deliveredFolders,
        rootFolderNames: deliveredRoots,
      };
    });
  };

  return {
    getNames,
    getFileNames: async (associations) =>
      (await getNames(associations)).fileNames,
    dispose: () => {
      disposed = true;
      stopWatching();
    },
  };
};
