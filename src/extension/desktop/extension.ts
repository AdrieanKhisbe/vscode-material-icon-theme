'use strict';

import {
  type ConfigurationChangeEvent,
  type ExtensionContext,
  env,
  workspace,
} from 'vscode';
import { extensionName, initTranslations, logger } from '../../core';
import { disableLogObserver, observeLogs } from '../logging/logger';
import { getCurrentConfig } from '../shared/config';
import { detectConfigChanges } from '../tools/changeDetection';
import { watchFileAssociations } from '../tools/fileAssociationWatcher';
import { registered } from '../tools/registered';

/**
 * This method is called when the extension is activated.
 * It initializes the core functionality of the extension.
 */
export const activate = async (context: ExtensionContext) => {
  try {
    observeLogs();

    await initTranslations(env.language);

    // Subscribe to the extension commands
    context.subscriptions.push(...registered);

    // Serialize manifest updates so filesystem and configuration events cannot
    // overwrite a newer manifest with an older result.
    let pending = Promise.resolve();
    const update = (
      event?: ConfigurationChangeEvent,
      refreshFileNames = false
    ) => {
      const next = pending.then(async () => {
        if (event?.affectsConfiguration(extensionName) === false) return;
        const config = getCurrentConfig();
        const names = await fileAssociations.getNames(
          config.files.associations,
          config.folders.theme === 'none' ? {} : config.folders.associations,
          config.folders.theme === 'none' ? {} : config.rootFolders.associations
        );
        await detectConfigChanges(
          event,
          context,
          names.fileNames,
          refreshFileNames,
          config,
          names
        );
      });
      pending = next.catch((error) => logger.error(error));
      return next;
    };

    const fileAssociations = watchFileAssociations(() =>
      update(undefined, true)
    );
    context.subscriptions.push(fileAssociations);

    // Observe changes in the config
    context.subscriptions.push(
      workspace.onDidChangeConfiguration(async (event) => await update(event))
    );

    // Workspace filenames may differ even when the stored configuration matches.
    await update(undefined, true);

    logger.info('Extension activated!');
  } catch (error) {
    logger.error(error);
  }
};

/** This method is called when the extension is deactivated */
export const deactivate = () => {
  disableLogObserver();
};
