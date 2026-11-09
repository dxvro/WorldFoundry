import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, REPO_ROOT, loadConfig } from '../src/config/env.js';

describe('loadConfig', () => {
  it('applies defaults relative to the repo root', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ host: '0.0.0.0', port: 3000, logLevel: 'info' });
    expect(config.dataDir).toBe(path.join(REPO_ROOT, 'data'));
    expect(config.serversDir).toBe(path.join(REPO_ROOT, 'servers'));
  });

  it('rejects invalid values with a readable message', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});
