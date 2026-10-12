import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigurationChangeEvent, ExtensionContext } from 'vscode';
import {
  applyConfigToIcons,
  type Config,
  clearCloneFolder,
  createFileAssociationResolver,
  extensionName,
  fileIcons,
  generateCustomCloneManifest,
  generateManifestWithFileAssociations,
  hasCustomClones,
  type IconAssociations,
  isFileNameGlob,
  logger,
  type Manifest,
  manifestName,
  merge,
  padWithDefaultConfig,
  renameIconFiles,
  resolvePath,
  withFileAssociations,
  writeToFile,
} from '../../core';
import { getCurrentConfig } from '../shared/config';
import { deepEqual } from './utils/deepEqual';

const applied = new WeakMap<
  ExtensionContext,
  {
    config: Config;
    associations: IconAssociations;
    clones: Manifest;
    base: Manifest;
    resolver: ReturnType<typeof createFileAssociationResolver>;
  }
>();

/** Compare the workspace and the user configurations with the current setup of the icons. */
export const detectConfigChanges = async (
  event: ConfigurationChangeEvent | undefined,
  context: ExtensionContext,
  fileNames: readonly string[] = [],
  refreshFileNames = false
) => {
  // if the changed config is not related to the extension
  if (event?.affectsConfiguration(extensionName) === false) return;

  const previous = applied.get(context);
  const oldConfig = previous?.config ?? getConfigFromStorage(context);
  const config = getCurrentConfig();
  const configChanged = !deepEqual(config, oldConfig);
  const hasFileNameGlobs = Object.keys(config.files.associations).some(
    isFileNameGlob
  );
  const clonesMissing =
    hasCustomClones(config) && !existsSync(resolvePath('./../icons/clones'));
  const resolver =
    configChanged || !previous
      ? createFileAssociationResolver(
          config.files.associations,
          fileIcons.icons
            .filter(
              (icon) =>
                !icon.enabledFor ||
                icon.enabledFor.some((pack) => pack === config.activeIconPack)
            )
            .flatMap((icon) => icon.fileNames ?? [])
        )
      : previous.resolver;
  const associations = resolver.resolve(fileNames);

  if (
    !configChanged &&
    !clonesMissing &&
    previous &&
    deepEqual(previous.associations, associations)
  )
    return;

  // if the configuration has not changed
  if (!(refreshFileNames && hasFileNameGlobs) && !configChanged) {
    const isActivation = event === undefined;
    if (isActivation && clonesMissing) {
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

  const base =
    configChanged || !previous
      ? generateManifestWithFileAssociations(
          config,
          resolver.staticAssociations
        )
      : previous.base;
  const manifest = withFileAssociations(base, config, associations);

  // A filename refresh must not delete and recreate clone files: those filesystem
  // events would trigger another refresh when developing the extension itself.
  if (configChanged) await clearCloneFolder(hasCustomClones(config));

  const clones =
    configChanged || clonesMissing || !previous
      ? await generateCustomCloneManifest(manifest, config)
      : previous.clones;
  const manifestWithClones = merge(manifest, clones);

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

  await syncConfigWithStorage(config, context);
  applied.set(context, {
    config: structuredClone(config),
    associations,
    clones,
    base,
    resolver,
  });
};

const syncConfigWithStorage = (config: Config, context: ExtensionContext) => {
  return context.globalState.update('config', {
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
