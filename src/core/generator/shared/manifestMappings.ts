import type { Manifest } from '../../models/manifest';

type ManifestMapping =
  | 'fileNames'
  | 'fileExtensions'
  | 'folderNames'
  | 'folderNamesExpanded'
  | 'rootFolderNames'
  | 'rootFolderNamesExpanded';

/** Lazily detach mappings and theme sections from an immutable cached base. */
export const createManifestMappingWriter =
  (base: Manifest, manifest: Manifest) =>
  (key: ManifestMapping, theme?: 'light' | 'highContrast') => {
    if (theme && manifest[theme] === base[theme])
      manifest[theme] = { ...base[theme] };
    const target = theme ? manifest[theme]! : manifest;
    const source = theme ? base[theme] : base;
    if (target[key] === source?.[key]) target[key] = { ...source?.[key] };
    return target[key]!;
  };
