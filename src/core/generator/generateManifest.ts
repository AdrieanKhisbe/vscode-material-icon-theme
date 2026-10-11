import { merge } from '../helpers/object';
import { fileIcons } from '../icons/fileIcons';
import { folderIcons } from '../icons/folderIcons';
import { languageIcons } from '../icons/languageIcons';
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
): Manifest => {
  const refinedConfig = padWithDefaultConfig(config);
  const manifest = createEmptyManifest();
  const languageIconDefinitions = loadLanguageIconDefinitions(
    languageIcons,
    refinedConfig,
    manifest
  );
  const fileIconDefinitions = loadFileIconDefinitions(
    fileIcons,
    refinedConfig,
    manifest,
    fileNames
  );
  const folderIconDefinitions = loadFolderIconDefinitions(
    folderIcons,
    refinedConfig,
    manifest
  );

  return merge<Manifest>(
    languageIconDefinitions,
    fileIconDefinitions,
    folderIconDefinitions
  );
};
