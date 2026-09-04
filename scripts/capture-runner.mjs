#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const nodeModules = path.join(root, "node_modules");
const esbuild = path.join(nodeModules, ".bin", "esbuild");
const electron = path.join(nodeModules, ".bin", "electron");

const captures = {
  "pandoc-divs": {
    entry: "test/editor-pandoc-div-visual-entry.ts",
    bundle: "pandoc-div-visual-bundle.js",
    driver: "test/editor-pandoc-div-visual-capture.cjs",
  },
  "widget-indent": {
    entry: "test/editor-widget-indent-visual-entry.ts",
    bundle: "widget-indent-visual-bundle.js",
    driver: "test/editor-widget-indent-visual-capture.cjs",
    loader: ".svg=dataurl",
  },
  tikz: {
    build: "test/editor-tikz-visual-build.cjs",
    driver: "test/editor-tikz-visual-capture.cjs",
  },
  "pandoc-help": {
    build: "test/pandoc-quick-help-visual-build.cjs",
    driver: "test/pandoc-quick-help-visual-capture.cjs",
  },
  "reference-search": {
    build: "test/reference-search-overlay-build.cjs",
    driver: "test/reference-search-overlay-probe.cjs",
    electronArgs: ["--ozone-platform=x11", "--disable-gpu"],
  },
  "reference-chips": {
    entry: "test/editor-reference-chips-visual-entry.ts",
    bundle: "reference-chips-visual-bundle.js",
    driver: "test/editor-reference-chips-visual-capture.cjs",
  },
  "reference-completion": {
    entry: "test/reference-completion-visual-entry.ts",
    bundle: "reference-completion-visual-bundle.js",
    driver: "test/reference-completion-visual-capture.cjs",
    electronArgs: ["--ozone-platform=x11", "--disable-gpu"],
  },
  "reference-hover": {
    entry: "test/reference-hover-visual-entry.ts",
    bundle: "reference-hover-visual-bundle.js",
    driver: "test/reference-hover-visual-capture.cjs",
  },
  "reference-navigation": {
    entry: "test/reference-navigation-entry.ts",
    bundle: "reference-navigation-bundle.js",
    driver: "test/reference-navigation-probe.cjs",
    esbuildArgs: ["--define:process.platform='\"linux\"'"],
    electronArgs: ["--ozone-platform=x11", "--disable-gpu"],
  },
  "navigation-controls": {
    build: "test/reference-navigation-controls-build.cjs",
    driver: "test/reference-navigation-controls-capture.cjs",
    electronArgs: ["--ozone-platform=x11", "--disable-gpu"],
  },
  "rename-preview": {
    build: "test/reference-rename-preview-build.cjs",
    driver: "test/reference-rename-preview-probe.cjs",
    electronArgs: ["--ozone-platform=x11", "--disable-gpu"],
  },
  "review-diff": {
    entry: "test/editor-review-diff-visual-entry.ts",
    bundle: "review-diff-visual-bundle.js",
    driver: "test/editor-review-diff-visual-capture.cjs",
    electronArgs: ["--ozone-platform=x11", "--disable-gpu"],
  },
  "annotations-panel": {
    build: "test/annotations-sidebar-visual-build.cjs",
    driver: "test/annotations-sidebar-visual-capture.cjs",
    electronArgs: ["--ozone-platform=x11", "--disable-gpu"],
  },
  "readme-demos": {
    entry: "test/readme-demo-entry.ts",
    bundle: "readme-demo-bundle.js",
    driver: "test/readme-demo-capture.cjs",
    electronArgs: ["--ozone-platform=x11", "--disable-gpu"],
  },
};

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const [name, output] = process.argv.slice(2);
const capture = captures[name];
if (capture === undefined || output === undefined) {
  throw new Error(`Usage: capture-runner.mjs <capture-name> <output-directory>`);
}

run("python3", [path.join(root, "scripts", "assert-dev-server-stopped.py")]);
mkdirSync(output, { recursive: true });

if (capture.build !== undefined) {
  run(process.execPath, [path.join(root, capture.build), output]);
} else {
  const args = [
    path.join(root, capture.entry),
    "--bundle",
    "--platform=browser",
    "--format=iife",
    "--tsconfig=" + path.join(root, "tsconfig.json"),
    ...(capture.loader === undefined ? [] : [`--loader:${capture.loader}`]),
    ...(capture.esbuildArgs ?? []),
    `--outfile=${path.join(output, capture.bundle)}`,
  ];
  run(esbuild, args);
}

run("xvfb-run", [
  "-a",
  electron,
  ...(capture.electronArgs ?? []),
  "--no-sandbox",
  path.join(root, capture.driver),
  output,
]);
