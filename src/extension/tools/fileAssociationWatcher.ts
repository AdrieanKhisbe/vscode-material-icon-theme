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
  type IconAssociations,
  isFileNameGlob,
  logger,
} from '../../core';
import { FilePathIndex } from './filePathIndex';
import { deepEqual } from './utils/deepEqual';

export type FileAssociationWatcher = Disposable & {
  getFileNames: (associations: IconAssociations) => Promise<readonly string[]>;
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
  const paths = new FilePathIndex();
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

  const scheduleRefresh = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      // A rename or create/delete burst may leave the same filename set.
      if (!deepEqual(delivered, [...matches].sort())) {
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
    const files = await workspace.findFiles(
      new RelativePattern(uri, '**/*'),
      null
    );
    files.forEach(addFile);
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
      if (disposed || !initialized) return;
      const before = revision;
      const stats = await readCreatedPaths(batch);
      // Reads overlap, but mutations retain event order, including directory
      // deletions and renames. Duplicate creates share a single stat request.
      for (const event of batch) {
        if (disposed) return;
        try {
          if (event.type === 'delete') removePath(event.uri);
          else if (event.type === 'create') {
            const stat = stats.get(event.uri.toString());
            if (!stat) continue;
            if (stat.type & FileType.Directory) await scanFolder(event.uri);
            else if (stat.type & FileType.File) addFile(event.uri);
          } else {
            event.removed.forEach(removePath);
            for (const uri of event.added) await scanFolder(uri);
          }
        } catch (error) {
          logger.error(error);
        }
      }
      if (revision !== before) scheduleRefresh();
    });
  };

  const collectEvent = (event: IndexEvent) => {
    if (disposed) return;
    events.push(event);
    // Do not keep postponing processing during a continuous event stream.
    batchTimer ??= setTimeout(flushEvents, eventBatchDelay);
  };

  const startWatching = () => {
    const watcher = workspace.createFileSystemWatcher(
      '**/*',
      false,
      true,
      false
    );
    subscriptions = [
      watcher,
      watcher.onDidCreate((uri) => {
        collectEvent({ type: 'create', uri });
      }),
      watcher.onDidDelete((uri) => {
        collectEvent({ type: 'delete', uri });
      }),
      workspace.onDidChangeWorkspaceFolders((event) => {
        collectEvent({
          type: 'folders',
          added: event.added.map((folder) => folder.uri),
          removed: event.removed.map((folder) => folder.uri),
        });
      }),
    ];
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
    initialized = false;
    revision = 0;
  };

  return {
    getFileNames: (associations) => {
      // A configuration change or explicit snapshot must include queued events.
      flushEvents();
      return enqueue(async () => {
        if (disposed) return [];
        const nextPatterns = Object.keys(associations)
          .filter(isFileNameGlob)
          .sort();
        if (nextPatterns.length === 0) {
          stopWatching();
          patterns = [];
          delivered = [];
          return delivered;
        }

        if (!deepEqual(patterns, nextPatterns)) {
          patterns = nextPatterns;
          matcher = createFileNameGlobMatcher(patterns);
          matches.clear();
          for (const name of counts.keys()) {
            if (matcher(name)) matches.add(name);
          }
        }

        if (!initialized) {
          if (subscriptions.length === 0) startWatching();
          const files = await workspace.findFiles('**/*', null);
          if (disposed) return [];
          paths.clear();
          counts.clear();
          matches.clear();
          files.forEach(addFile);
          initialized = true;
        }

        delivered = [...matches].sort();
        return delivered;
      });
    },
    dispose: () => {
      disposed = true;
      stopWatching();
    },
  };
};
