import { type Disposable, workspace } from 'vscode';
import { isFileNameGlob, logger } from '../../core';
import { getCurrentConfig } from '../shared/config';

/** Keep expanded filename associations up to date as workspace files change. */
export const watchFileAssociations = (
  refresh: () => Promise<void>
): Disposable => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (
      !Object.keys(getCurrentConfig().files.associations).some(isFileNameGlob)
    )
      return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh().catch((error) => logger.error(error));
    }, 200);
  };

  // Renames are reported as a deletion and a creation. Content changes do not
  // affect filename associations, so there is no need to observe them.
  const watcher = workspace.createFileSystemWatcher('**/*', false, true, false);
  const subscriptions = [
    watcher,
    watcher.onDidCreate(scheduleRefresh),
    watcher.onDidDelete(scheduleRefresh),
    workspace.onDidChangeWorkspaceFolders(scheduleRefresh),
  ];

  return {
    dispose: () => {
      clearTimeout(timer);
      subscriptions.forEach((subscription) => subscription.dispose());
    },
  };
};
