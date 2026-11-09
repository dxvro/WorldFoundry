import { describe, expect, it } from 'vitest';
import { defaultRam, isRamTight, ramBounds, validateRam, withMax, withMin } from './ram';
import { buildRequest, firstInvalidStep, nextFreePort, parsePort, validateAll, validateStep, type WizardContext, type WizardDraft } from './wizard';
import { estimateRequiredJava, javaFit } from './java';

const draft = (overrides: Partial<WizardDraft> = {}): WizardDraft => ({
  name: 'Survival',
  loader: 'fabric',
  mcVersion: '1.21.1',
  loaderVersion: '0.16.0',
  port: '25565',
  minRamMb: 1024,
  maxRamMb: 2048,
  eulaAccepted: false,
  ...overrides,
});

const context = (overrides: Partial<WizardContext> = {}): WizardContext => ({ totalMemoryMb: 16384, servers: [], loaderNeedsVersion: true, ...overrides });

describe('RAM bounds', () => {
  it('never offers more than the machine has', () => {
    const bounds = ramBounds(8000);
    expect(bounds.max).toBeLessThanOrEqual(8000);
    expect(bounds.max % bounds.step).toBe(0);
    expect(bounds.min).toBe(256);
  });

  it('defaults to 1 GB to 2 GB and shrinks on small machines', () => {
    expect(defaultRam(16384)).toEqual({ minRamMb: 1024, maxRamMb: 2048 });
    expect(defaultRam(1536)).toEqual({ minRamMb: 1024, maxRamMb: 1536 });
    expect(defaultRam(512)).toEqual({ minRamMb: 512, maxRamMb: 512 });
  });

  it('keeps min <= max when either handle moves past the other', () => {
    const bounds = ramBounds(16384);
    expect(withMin({ minRamMb: 1024, maxRamMb: 2048 }, 4096, bounds)).toEqual({ minRamMb: 4096, maxRamMb: 4096 });
    expect(withMax({ minRamMb: 1024, maxRamMb: 2048 }, 512, bounds)).toEqual({ minRamMb: 512, maxRamMb: 512 });
  });

  it('clamps to the bounds and snaps to the step', () => {
    const bounds = ramBounds(4096);
    expect(withMax({ minRamMb: 256, maxRamMb: 1024 }, 999_999, bounds).maxRamMb).toBe(4096);
    expect(withMin({ minRamMb: 1024, maxRamMb: 2048 }, 10, bounds).minRamMb).toBe(256);
    expect(withMax({ minRamMb: 256, maxRamMb: 1024 }, 1000, bounds).maxRamMb).toBe(1024);
  });

  it('validates against the real total', () => {
    expect(validateRam({ minRamMb: 1024, maxRamMb: 2048 }, 4096)).toEqual({});
    expect(validateRam({ minRamMb: 3000, maxRamMb: 2048 }, 4096).minRamMb).toContain('must not be greater');
    expect(validateRam({ minRamMb: 1024, maxRamMb: 8192 }, 4096).maxRamMb).toContain('4096');
    expect(validateRam({ minRamMb: 100, maxRamMb: 2048 }, 4096).minRamMb).toContain('256');
  });

  it('flags a maximum above three quarters of the machine', () => {
    expect(isRamTight({ minRamMb: 1024, maxRamMb: 13000 }, 16384)).toBe(true);
    expect(isRamTight({ minRamMb: 1024, maxRamMb: 8192 }, 16384)).toBe(false);
  });
});

describe('wizard validation', () => {
  it('accepts a complete draft', () => {
    expect(validateAll(draft(), context())).toEqual({});
    expect(firstInvalidStep(draft(), context())).toBeNull();
  });

  it('requires a name of 1 to 60 characters and a loader', () => {
    expect(validateStep('basics', draft({ name: '   ' }), context()).name).toBeDefined();
    expect(validateStep('basics', draft({ name: 'x'.repeat(61) }), context()).name).toContain('60');
    expect(validateStep('basics', draft({ loader: null }), context()).loader).toBeDefined();
    expect(validateStep('basics', draft({ name: 'x'.repeat(60) }), context())).toEqual({});
  });

  it('requires versions, but no loader version for vanilla', () => {
    expect(validateStep('version', draft({ mcVersion: '' }), context()).mcVersion).toBeDefined();
    expect(validateStep('version', draft({ loaderVersion: '' }), context()).loaderVersion).toBeDefined();
    expect(validateStep('version', draft({ loader: 'vanilla', loaderVersion: '' }), context({ loaderNeedsVersion: false }))).toEqual({});
  });

  it('checks the port range and clashes with existing servers', () => {
    for (const port of ['', '0', '65536', 'abc', '25.5', '-1']) {
      expect(validateStep('resources', draft({ port }), context()).port, port).toBeDefined();
    }
    expect(validateStep('resources', draft({ port: '65535' }), context()).port).toBeUndefined();
    const clash = validateStep('resources', draft({ port: '25565' }), context({ servers: [{ name: 'Alt', port: 25565 }] }));
    expect(clash.port).toContain('Alt');
  });

  it('applies the RAM bounds of the machine in the resources step', () => {
    const errors = validateStep('resources', draft({ maxRamMb: 32768 }), context({ totalMemoryMb: 8192 }));
    expect(errors.maxRamMb).toBeDefined();
  });

  it('points at the first step that is invalid', () => {
    expect(firstInvalidStep(draft({ port: 'x', name: '' }), context())).toBe('basics');
    expect(firstInvalidStep(draft({ port: 'x' }), context())).toBe('resources');
  });

  it('builds the request with trimmed text and without an empty loader version', () => {
    expect(buildRequest(draft({ name: '  Survival  ', loaderVersion: '', eulaAccepted: true }))).toEqual({
      name: 'Survival',
      loader: 'fabric',
      mcVersion: '1.21.1',
      port: 25565,
      minRamMb: 1024,
      maxRamMb: 2048,
      eulaAccepted: true,
    });
    expect(() => buildRequest(draft({ loader: null }))).toThrow();
  });

  it('starts with the EULA unticked in a fresh draft and sends false when not ticked', () => {
    expect(buildRequest(draft()).eulaAccepted).toBe(false);
  });
});

describe('ports', () => {
  it('suggests the next free port like the backend does', () => {
    expect(nextFreePort([])).toBe(25565);
    expect(nextFreePort([{ port: 25565 }, { port: 25566 }, { port: 30000 }])).toBe(25567);
    expect(parsePort(' 80 ')).toBe(80);
    expect(parsePort('99999')).toBeNull();
  });
});

describe('Java hints', () => {
  it('estimates the required Java major from the Minecraft version', () => {
    expect(estimateRequiredJava('1.21.1')).toBe(21);
    expect(estimateRequiredJava('1.20.4')).toBe(17);
    expect(estimateRequiredJava('1.17.1')).toBe(16);
    expect(estimateRequiredJava('1.12.2')).toBe(8);
    expect(estimateRequiredJava('26.1')).toBe(25);
    expect(estimateRequiredJava('abc')).toBeNull();
  });

  it('checks a runtime against the server like the backend does', () => {
    const modern = { requiredJavaMajor: 21, loader: 'fabric' as const, mcVersion: '1.21.1' };
    expect(javaFit({ major: 21 }, modern).fits).toBe(true);
    expect(javaFit({ major: 25 }, modern).fits).toBe(true);
    expect(javaFit({ major: 17 }, modern).fits).toBe(false);
    const oldForge = { requiredJavaMajor: 8, loader: 'forge' as const, mcVersion: '1.12.2' };
    expect(javaFit({ major: 8 }, oldForge).fits).toBe(true);
    expect(javaFit({ major: 17 }, oldForge).fits).toBe(false);
  });
});
