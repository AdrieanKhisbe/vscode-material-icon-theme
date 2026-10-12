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
import { loadFolderIconDefinitions } from './folderGenerator';
import { loadLanguageIconDefinitions } from './languageGenerator';

/**
 * Generate the manifest that will be written as JSON file.
 * @param config - Theme configuration.
 * @param fileNames - Additional basenames to match against filename globs.
 */
export const generateManifest = (
  config?: ManifestConfig,
  fileNames: readonly string[] = []
): Manifest => buildManifest(config, fileNames);

/** Build the cached base with associations already resolved by the caller. */
export const generateManifestWithFileAssociations = (
  config: Config,
  associations: IconAssociations
): Manifest => buildManifest(config, [], associations);

const buildManifest = (
  config?: ManifestConfig,
  fileNames: readonly string[] = [],
  associations?: IconAssociations
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

  return manifest;
};
