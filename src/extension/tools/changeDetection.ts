import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  type ConfigurationChangeEvent,
  type ExtensionContext,
  workspace,
} from 'vscode';
import {
  applyConfigToIcons,
  type Config,
  clearCloneFolder,
  customClonesIcons,
  extensionName,
  generateManifest,
  hasCustomClones,
  isFileNameGlob,
  logger,
  manifestName,
  merge,
  padWithDefaultConfig,
  renameIconFiles,
  resolvePath,
  writeToFile,
} from '../../core';
import { getCurrentConfig } from '../shared/config';
import { deepEqual } from './utils/deepEqual';

/** Compare the workspace and the user configurations with the current setup of the icons. */
export const detectConfigChanges = async (
  event: ConfigurationChangeEvent | undefined,
  context: ExtensionContext,
  refreshFileNames = false
) => {
  // if the changed config is not related to the extension
  if (event?.affectsConfiguration(extensionName) === false) return;

  const oldConfig = getConfigFromStorage(context);
  const config = getCurrentConfig();
  const configChanged = !deepEqual(config, oldConfig);
  const hasFileNameGlobs = Object.keys(config.files.associations).some(
    isFileNameGlob
  );

  // if the configuration has not changed
  if (!(refreshFileNames && hasFileNameGlobs) && !configChanged) {
    const isActivation = event === undefined;
    if (
      isActivation &&
      hasCustomClones(config) &&
      !existsSync(resolvePath('./../icons/clones'))
    ) {
      logger.info('Custom clones missing from disk, regenerating...');
    } else {
      return;
    }
  }

  if (configChanged) {
    await applyConfigToIcons(config, oldConfig);

    logger.info('Configuration changes detected and applied!');

    try {
      await renameIconFiles(config);
    } catch (error) {
      logger.error(error);
    }
  }

  const fileNames = hasFileNameGlobs
    ? (await workspace.findFiles('**/*', null)).map((uri) => basename(uri.path))
    : [];
  const manifest = generateManifest(config, fileNames);

  // A filename refresh must not delete and recreate clone files: those filesystem
  // events would trigger another refresh when developing the extension itself.
  if (configChanged) await clearCloneFolder(hasCustomClones(config));

  const manifestWithClones = merge(
    manifest,
    await customClonesIcons(manifest, config)
  );

  const iconJsonPath = join(resolvePath(manifestName));
  await writeToFile(
    iconJsonPath,
    JSON.stringify(manifestWithClones, undefined, 2),
    'utf-8'
  );

  logger.info('Updated the manifest file.');

  logger.debug(
    'Applied configuration: ' + JSON.stringify(config, undefined, 2)
  );

  syncConfigWithStorage(config, context);
};

const syncConfigWithStorage = (config: Config, context: ExtensionContext) => {
  context.globalState.update('config', {
    version: context.extension.packageJSON.version,
    config,
  });
};

const getConfigFromStorage = (context: ExtensionContext): Config => {
  const config = context.globalState.get<{ version: string; config: Config }>(
    'config'
  );
  if (context.extension.packageJSON.version === config?.version) {
    return padWithDefaultConfig(config?.config);
  } else {
    return padWithDefaultConfig();
  }
};
