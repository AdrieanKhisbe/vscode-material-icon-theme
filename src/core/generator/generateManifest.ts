import { getFileConfigHash } from '../helpers/configHash';
import { fileIcons } from '../icons/fileIcons';
import { folderIcons } from '../icons/folderIcons';
import { languageIcons } from '../icons/languageIcons';
import type { Config, IconAssociations } from '../models/icons/config';
import {
  createEmptyManifest,
  type Manifest,
  type ManifestConfig,
} from '../models/manifest';
import { padWithDefaultConfig } from './config/defaultConfig';
import { loadFileIconDefinitions } from './fileGenerator';
import {
  createFolderAssociationResolver,
  type FolderNames,
  isFolderNameGlob,
  withFolderAssociations,
} from './folderAssociations';
import { loadFolderIconDefinitions } from './folderGenerator';
import { loadLanguageIconDefinitions } from './languageGenerator';

/**
 * Generate the manifest that will be written as JSON file.
 * @param config - Theme configuration.
 * @param fileNames - Additional basenames to match against filename globs.
 * @param folders - Additional regular and root folder basenames.
 */
export const generateManifest = (
  config?: ManifestConfig,
  fileNames: readonly string[] = [],
  folders: FolderNames = {}
): Manifest => buildManifest(config, fileNames, undefined, folders);

/** Build the cached base with associations already resolved by the caller. */
export const generateManifestWithFileAssociations = (
  config: Config,
  associations: IconAssociations
): Manifest => buildManifest(config, [], associations);

const buildManifest = (
  config?: ManifestConfig,
  fileNames: readonly string[] = [],
  associations?: IconAssociations,
  folders: FolderNames = {}
): Manifest => {
  const refinedConfig = padWithDefaultConfig(config);
  const manifest = createEmptyManifest();
  const fileConfigHash = getFileConfigHash(refinedConfig);
  loadLanguageIconDefinitions(
    languageIcons,
    refinedConfig,
    manifest,
    fileConfigHash
  );
  loadFileIconDefinitions(
    fileIcons,
    refinedConfig,
    manifest,
    fileNames,
    associations,
    fileConfigHash
  );
  loadFolderIconDefinitions(
    folderIcons,
    refinedConfig,
    manifest,
    fileConfigHash
  );

  const resolveFolders = (
    values: IconAssociations,
    known: () => string[],
    names: readonly string[]
  ) => {
    if (!Object.keys(values).some(isFolderNameGlob)) return {};
    const resolver = createFolderAssociationResolver(values, known());
    return { ...resolver.staticAssociations, ...resolver.resolve(names) };
  };
  return withFolderAssociations(
    manifest,
    refinedConfig,
    resolveFolders(
      refinedConfig.folders.associations,
      () => Object.keys(manifest.folderNames ?? {}),
      folders.folderNames ?? []
    ),
    resolveFolders(
      refinedConfig.rootFolders.associations,
      () => Object.keys(manifest.rootFolderNames ?? {}),
      folders.rootFolderNames ?? []
    )
  );
};
