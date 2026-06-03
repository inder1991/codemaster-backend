import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // mirror pytest-randomly: randomize order to surface ordering deps
    sequence: { shuffle: true },
    // test roots: shared (test/), gates (scripts/), libraries (libs/), app code (apps/).
    // Colocated *.parity.test.ts / *.test.ts are picked up everywhere except vendor/ + tools/.
    include: ["{test,scripts,libs,apps}/**/*.test.ts"],
    passWithNoTests: true,
  },
});
