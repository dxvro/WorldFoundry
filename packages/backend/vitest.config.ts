import { defineConfig } from 'vitest/config';

// The tests use fakes for Java, GitHub, Modrinth, ports and the process spawner, so no test waits on real
// external work. The 5 s default only fails on a stalled shared CI runner (trivial Windows tests were seen taking
// 5 to 40 times longer in one run: a PATCH round trip took 7 s, the same file 1.2 s in a normal run).
// A generous limit costs nothing when everything is fast and keeps such stalls from failing the build.
export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
