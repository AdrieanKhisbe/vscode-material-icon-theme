import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCustomCloneManifest } from '../../generator/clones/clonesGenerator';
import { cloneIcon } from '../../generator/clones/utils/cloning';
import { getDefaultConfig } from '../../generator/config/defaultConfig';
import { generateManifest } from '../../generator/generateManifest';
import { merge } from '../../helpers/object';
import { writeToFile } from '../../helpers/writeFile';

vi.mock('../../generator/clones/utils/cloning', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../generator/clones/utils/cloning')
  >()),
  cloneIcon: vi.fn(async () => '<svg/>'),
}));
vi.mock('../../helpers/writeFile', () => ({ writeToFile: vi.fn() }));

describe('cached clone overlays', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeToFile).mockReset();
  });

  it('does not cache base mappings when a clone has a missing base icon', async () => {
    const config = getDefaultConfig();
    config.files.associations = { 'Dockerfile*': 'docker' };
    config.folders.associations = { 'project-*': 'src' };
    config.rootFolders.associations = { 'project-*': 'app' };
    config.files.customClones = [
      {
        name: 'missing-clone',
        base: 'does-not-exist',
        color: '#ffffff',
        fileNames: ['custom'],
      },
    ];
    const initial = generateManifest(config, ['Dockerfile.custom'], {
      folderNames: ['project-api'],
      rootFolderNames: ['project-root'],
    });
    const overlay = await generateCustomCloneManifest(initial, config);
    expect(overlay).toEqual({});
    expect(cloneIcon).not.toHaveBeenCalled();
    expect(writeToFile).not.toHaveBeenCalled();
    const updated = merge(generateManifest(config), overlay);
    expect(updated.fileNames?.['dockerfile.custom']).toBeUndefined();
    expect(updated.folderNames?.['project-api']).toBeUndefined();
    expect(updated.rootFolderNames?.['project-root']).toBeUndefined();
  });

  it('does not cache base mappings when writing a clone fails', async () => {
    const config = getDefaultConfig();
    config.files.associations = { 'Dockerfile*': 'docker' };
    config.files.customClones = [
      {
        name: 'custom-docker',
        base: 'docker',
        color: '#ffffff',
        fileNames: ['custom'],
      },
    ];
    vi.mocked(writeToFile).mockRejectedValueOnce(new Error('write failed'));
    const initial = generateManifest(config, ['Dockerfile.custom']);
    const overlay = await generateCustomCloneManifest(initial, config);
    expect(writeToFile).toHaveBeenCalledTimes(1);
    expect(overlay.fileNames).toEqual({});
    expect(overlay.iconDefinitions).toEqual({});
    const updated = merge(generateManifest(config), overlay);
    expect(updated.fileNames?.['dockerfile.custom']).toBeUndefined();
  });

  it('retains completed clone variants when a later variant fails to write', async () => {
    const config = getDefaultConfig();
    config.files.customClones = [
      {
        name: 'custom-docker',
        base: 'docker',
        color: '#ffffff',
        lightColor: '#000000',
        fileNames: ['custom'],
      },
    ];
    vi.mocked(writeToFile)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('light write failed'));
    const overlay = await generateCustomCloneManifest(
      generateManifest(config),
      config
    );
    expect(overlay.fileNames?.custom).toBe('custom-docker');
    expect(overlay.iconDefinitions?.['custom-docker']).toBeDefined();
    expect(overlay.light?.fileNames?.custom).toBeUndefined();
    expect(Object.keys(overlay.fileNames ?? {})).toEqual(['custom']);
  });
});
