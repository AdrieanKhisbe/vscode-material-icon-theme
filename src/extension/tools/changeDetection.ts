import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigurationChangeEvent, ExtensionContext } from 'vscode';
import {
  applyConfigToIcons,
  type Config,
  clearCloneFolder,
  createFileAssociationResolver,
  createFolderAssociationResolver,
  extensionName,
  type FolderNames,
  fileIcons,
  generateCustomCloneManifest,
  generateManifestWithFileAssociations,
  hasCustomClones,
  type IconAssociations,
  isFileNameGlob,
  isFolderNameGlob,
  logger,
  type Manifest,
  manifestName,
  merge,
  padWithDefaultConfig,
  renameIconFiles,
  resolvePath,
  withFileAssociations,
  withFolderAssociations,
  writeToFile,
} from '../../core';
import { getCurrentConfig } from '../shared/config';
import { deepEqual } from './utils/deepEqual';

const applied = new WeakMap<
  ExtensionContext,
  {
    config: Config;
    associations: IconAssociations;
    folderAssociations: IconAssociations;
    rootAssociations: IconAssociations;
    folderResolver?: ReturnType<typeof createFolderAssociationResolver>;
    rootResolver?: ReturnType<typeof createFolderAssociationResolver>;
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
  refreshFileNames = false,
  currentConfig?: Config,
  folderNames: FolderNames = {}
) => {
  // if the changed config is not related to the extension
  if (event?.affectsConfiguration(extensionName) === false) return;

  const previous = applied.get(context);
  const oldConfig = previous?.config ?? getConfigFromStorage(context);
  const config = currentConfig ?? getCurrentConfig();
  // Rule order is significant when more than one glob matches a filename.
  const associationsChanged = !deepEqual(
    Object.entries(config.files.associations),
    Object.entries(oldConfig.files.associations)
  );
  const foldersChanged = !deepEqual(
    Object.entries(config.folders.associations),
    Object.entries(oldConfig.folders.associations)
  );
  const rootsChanged = !deepEqual(
    Object.entries(config.rootFolders.associations),
    Object.entries(oldConfig.rootFolders.associations)
  );
  const configChanged =
    associationsChanged ||
    foldersChanged ||
    rootsChanged ||
    !deepEqual(config, oldConfig);
  const hasFileNameGlobs = Object.keys(config.files.associations).some(
    isFileNameGlob
  );
  const clonesMissing =
    hasCustomClones(config) && !existsSync(resolvePath('./../icons/clones'));
  const resolver =
    associationsChanged ||
    config.activeIconPack !== oldConfig.activeIconPack ||
    !previous
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
  const hasFolderGlobs =
    config.folders.theme !== 'none' &&
    [config.folders.associations, config.rootFolders.associations].some(
      (values) => Object.keys(values).some(isFolderNameGlob)
    );
  let base = !configChanged ? previous?.base : undefined;
  const getBase = () =>
    (base ??= generateManifestWithFileAssociations(
      config,
      resolver.staticAssociations
    ));
  const folderRulesChanged =
    config.activeIconPack !== oldConfig.activeIconPack ||
    config.folders.theme !== oldConfig.folders.theme;
  const folderResolver = !hasFolderGlobs
    ? undefined
    : !previous?.folderResolver || foldersChanged || folderRulesChanged
      ? createFolderAssociationResolver(
          config.folders.associations,
          Object.keys(getBase().folderNames ?? {})
        )
      : previous.folderResolver;
  const rootResolver = !hasFolderGlobs
    ? undefined
    : !previous?.rootResolver || rootsChanged || folderRulesChanged
      ? createFolderAssociationResolver(
          config.rootFolders.associations,
          Object.keys(getBase().rootFolderNames ?? {})
        )
      : previous.rootResolver;
  const folderAssociations =
    folderResolver?.resolve(folderNames.folderNames ?? []) ?? {};
  const rootAssociations =
    rootResolver?.resolve(folderNames.rootFolderNames ?? []) ?? {};

  if (
    !configChanged &&
    !clonesMissing &&
    previous &&
    deepEqual(previous.associations, associations) &&
    deepEqual(previous.folderAssociations, folderAssociations) &&
    deepEqual(previous.rootAssociations, rootAssociations)
  )
    return;

  // if the configuration has not changed
  if (
    !(refreshFileNames && (hasFileNameGlobs || hasFolderGlobs)) &&
    !configChanged
  ) {
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

  let manifest = withFileAssociations(getBase(), config, associations);
  if (hasFolderGlobs)
    manifest = withFolderAssociations(
      manifest,
      config,
      folderAssociations,
      rootAssociations
    );

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

  if (configChanged) {
    logger.debug(
      'Applied configuration: ' + JSON.stringify(config, undefined, 2)
    );
    await syncConfigWithStorage(config, context);
  }
  applied.set(context, {
    config:
      configChanged || !previous ? structuredClone(config) : previous.config,
    associations,
    folderAssociations,
    rootAssociations,
    folderResolver,
    rootResolver,
    clones,
    base: getBase(),
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
