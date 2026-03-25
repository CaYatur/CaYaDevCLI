// Copyright (c) 2026 CaYaDev - https://cayadev.com - Licensed under the MIT License.

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { Resvg } from "@resvg/resvg-js";
import { build } from "esbuild";
import pngToIco from "png-to-ico";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

const rootDir = process.cwd();
const outDir = path.join(rootDir, "dist-exe");
const bundlePath = path.join(outDir, "cayadev.bundle.cjs");
const seaConfigPath = path.join(outDir, "sea-config.json");
const blobPath = path.join(outDir, "cayadev.blob");
const defaultExePath = path.join(outDir, "CaYaDevCLI.exe");
const iconSvgPath = path.join(rootDir, "CYEditorLogo2.svg");
const iconIcoPath = path.join(outDir, "CaYaDevCLI.ico");
const postjectCliPath = require.resolve("postject/dist/cli.js");
const nodeBinaryPath = process.execPath;
const nodeMajor = process.versions.node.split(".")[0];

if (process.platform !== "win32") {
  throw new Error("build-exe currently targets Windows only and must be run on Windows.");
}

await fs.mkdir(outDir, { recursive: true });
await fs.rm(bundlePath, { force: true });
await fs.rm(seaConfigPath, { force: true });
await fs.rm(blobPath, { force: true });
await fs.rm(iconIcoPath, { force: true });
console.log("step: build icon");
await buildWindowsIcon(iconSvgPath, iconIcoPath);
const exePath = await resolveWritableExePath(defaultExePath);
console.log(`step: bundle app -> ${path.basename(bundlePath)}`);

await build({
  entryPoints: [path.join(rootDir, "src", "index.js")],
  outfile: bundlePath,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: `node${nodeMajor}`,
  legalComments: "none"
});

console.log("step: create SEA blob");
await fs.writeFile(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    },
    null,
    2
  ),
  "utf8"
);

await runLogged(nodeBinaryPath, ["--experimental-sea-config", seaConfigPath], rootDir);
console.log("step: copy node binary");
await fs.copyFile(nodeBinaryPath, exePath);

console.log("step: inject SEA blob");
await runLogged(
  nodeBinaryPath,
  [
    postjectCliPath,
    exePath,
    "NODE_SEA_BLOB",
    blobPath,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--overwrite"
  ],
  rootDir
);

console.log("step: apply icon and version resources");
await applyWindowsResources(exePath, iconIcoPath);

console.log("step: cleanup temp files");
await fs.rm(bundlePath, { force: true });
await fs.rm(blobPath, { force: true });
await fs.rm(seaConfigPath, { force: true });

console.log(`Single-file executable ready: ${exePath}`);

async function runLogged(command, args, cwd) {
  try {
    const result = await run(command, args, {
      cwd,
      windowsHide: true
    });

    if (result.stdout?.trim()) {
      console.log(result.stdout.trim());
    }

    if (result.stderr?.trim()) {
      console.log(result.stderr.trim());
    }
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout).trim() : "";
    const stderr = error.stderr ? String(error.stderr).trim() : "";

    if (stdout) {
      console.log(stdout);
    }

    if (stderr) {
      console.log(stderr);
    }

    throw error;
  }
}

async function buildWindowsIcon(svgPath, icoPath) {
  const svg = await fs.readFile(svgPath, "utf8");
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = sizes.map((size) => {
    const resvg = new Resvg(svg, {
      fitTo: {
        mode: "width",
        value: size
      }
    });

    return resvg.render().asPng();
  });

  const icoBuffer = await pngToIco(pngBuffers);
  await fs.writeFile(icoPath, icoBuffer);
}

async function resolveWritableExePath(targetPath) {
  try {
    await fs.rm(targetPath, { force: true });
    return targetPath;
  } catch (error) {
    if (error?.code !== "EPERM") {
      throw error;
    }

    const fallbackPath = path.join(
      path.dirname(targetPath),
      `CaYaDevCLI-${createTimestampSuffix()}.exe`
    );

    console.log(`warning: ${path.basename(targetPath)} is locked. Writing the new build to ${path.basename(fallbackPath)} instead.`);
    return fallbackPath;
  }
}

function createTimestampSuffix() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function applyWindowsResources(exePath, icoPath) {
  const exeBuffer = await fs.readFile(exePath);
  const iconBuffer = await fs.readFile(icoPath);
  const exe = NtExecutable.from(exeBuffer, { ignoreCert: true });
  const resources = NtExecutableResource.from(exe);
  const iconFile = Data.IconFile.from(iconBuffer);
  const existingIconGroups = Resource.IconGroupEntry.fromEntries(resources.entries);
  const iconGroupId = existingIconGroups[0]?.id ?? 101;
  const iconLang = existingIconGroups[0]?.lang ?? 1033;

  Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    iconGroupId,
    iconLang,
    iconFile.icons.map((item) => item.data)
  );

  resources.outputResource(exe);
  await fs.writeFile(exePath, Buffer.from(exe.generate()));
}
