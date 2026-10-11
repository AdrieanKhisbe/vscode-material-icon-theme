'use strict';

import {
  type ConfigurationChangeEvent,
  type ExtensionContext,
  env,
  workspace,
} from 'vscode';
import { initTranslations, logger } from '../../core';
import { disableLogObserver, observeLogs } from '../logging/logger';
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
      const next = pending.then(() =>
        detectConfigChanges(event, context, refreshFileNames)
      );
      pending = next.catch((error) => logger.error(error));
      return next;
    };

    context.subscriptions.push(
      watchFileAssociations(() => update(undefined, true))
    );

    // Workspace filenames may differ even when the stored configuration matches.
    await update(undefined, true);

    // Observe changes in the config
    context.subscriptions.push(
      workspace.onDidChangeConfiguration(async (event) => await update(event))
    );

    logger.info('Extension activated!');
  } catch (error) {
    logger.error(error);
  }
};

/** This method is called when the extension is deactivated */
export const deactivate = () => {
  disableLogObserver();
};
