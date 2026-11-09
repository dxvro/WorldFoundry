import { describe, expect, it } from 'vitest';
import { installMajorFor, javaFit, preparingMajor } from './java';

describe('installMajorFor', () => {
  it('picks the lowest long-term release that satisfies the server, like the backend', () => {
    expect(installMajorFor(21, null)).toBe(21);
    expect(installMajorFor(16, null)).toBe(17);
    expect(installMajorFor(17, null)).toBe(17);
    expect(installMajorFor(9, null)).toBe(11);
    expect(installMajorFor(25, null)).toBe(25);
  });

  it('respects the upper bound of old Forge', () => {
    expect(installMajorFor(8, 8)).toBe(8);
  });

  it('uses the exact minimum beyond the last long-term release and gives up on impossible bounds', () => {
    expect(installMajorFor(27, null)).toBe(27);
    expect(installMajorFor(22, null)).toBe(25);
    expect(installMajorFor(17, 12)).toBeNull();
  });
});

describe('preparingMajor', () => {
  it('reads the runtime the server waits for from its status message', () => {
    expect(preparingMajor('Installing Java 21 ...')).toBe(21);
    expect(preparingMajor('Installing Java 8 (43 %) ...')).toBe(8);
    // the backend's current English wording, whatever its word order
    expect(preparingMajor('Installing Java 21 ...')).toBe(21);
    expect(preparingMajor('Java 17 is being installed ...')).toBe(17);
    expect(preparingMajor('The server is being prepared')).toBeNull();
    expect(preparingMajor('Preparing the server')).toBeNull();
    expect(preparingMajor(null)).toBeNull();
  });
});

describe('javaFit still follows the backend rule', () => {
  it('limits Forge up to 1.12.2 to Java 8', () => {
    expect(javaFit({ major: 21 }, { requiredJavaMajor: 8, loader: 'forge', mcVersion: '1.12.2' }).fits).toBe(false);
    expect(javaFit({ major: 8 }, { requiredJavaMajor: 8, loader: 'forge', mcVersion: '1.12.2' }).fits).toBe(true);
  });
});
