import { describe, expect, it, vi } from 'vitest';
import { getDefaultConfig } from '../../generator/config/defaultConfig';
import { generateManifest } from '../../generator/generateManifest';
import * as configHash from '../../helpers/configHash';

describe('manifest generation', () => {
  it('computes one configuration hash for the complete generation', () => {
    const config = getDefaultConfig();
    config.opacity = 0.7;
    const expectedHash = configHash.getFileConfigHash(config);
    const spy = vi.spyOn(configHash, 'getFileConfigHash');
    try {
      const manifest = generateManifest(config);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(manifest.iconDefinitions?.typescript.iconPath).toContain(
        expectedHash
      );
      expect(manifest.iconDefinitions?.folder.iconPath).toContain(expectedHash);
    } finally {
      spy.mockRestore();
    }
  });
});
