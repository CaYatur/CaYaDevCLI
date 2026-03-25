#!/usr/bin/env node
// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

import { startCli } from "./core/cli.js";

startCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
