import assert from "node:assert/strict";

import { buildRuntimeConfig } from "../src/core/config.js";

function run(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

run("runtime config defaults to advanced mode and extra_high thinking", () => {
  const config = buildRuntimeConfig([], process.cwd(), {});

  assert.equal(config.modeName, "advanced");
  assert.equal(config.reasoningName, "extra_high");
});

run("invalid stored mode and thinking fall back to advanced and extra_high", () => {
  const config = buildRuntimeConfig([], process.cwd(), {
    modeName: "broken",
    reasoningName: "broken"
  });

  assert.equal(config.modeName, "advanced");
  assert.equal(config.reasoningName, "extra_high");
});
