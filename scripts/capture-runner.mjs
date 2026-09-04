#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const nodeModules = path.join(root, "node_modules");
const esbuild = path.join(nodeModules, ".bin", "esbuild");

const captures = {
  "pandoc-divs": {
    entry: "test/editor-pandoc-div-visual-entry.ts",
    bundle: "pandoc-div-visual-bundle.js",
    driver: "test/editor-pandoc-div-visual-capture.mjs",
  },
  "widget-indent": {
    entry: "test/editor-widget-indent-visual-entry.ts",
    bundle: "widget-indent-visual-bundle.js",
    driver: "test/editor-widget-indent-visual-capture.mjs",
    loader: ".svg=dataurl",
  },
  tikz: {
    build: "test/visual-build.cjs",
    entry: "test/editor-tikz-visual-entry.ts",
    bundle: "tikz-visual-bundle.js",
    driver: "test/editor-tikz-visual-capture.mjs",
  },
  "pandoc-help": {
    build: "test/visual-build.cjs",
    entry: "test/pandoc-quick-help-visual-entry.ts",
    bundle: "pandoc-quick-help-bundle.js",
    driver: "test/pandoc-quick-help-visual-capture.mjs",
  },
  "reference-search": {
    build: "test/visual-build.cjs",
    entry: "test/reference-search-overlay-entry.ts",
    bundle: "reference-search-overlay-bundle.js",
    driver: "test/reference-search-overlay-probe.mjs",
  },
  "reference-chips": {
    entry: "test/editor-reference-chips-visual-entry.ts",
    bundle: "reference-chips-visual-bundle.js",
    driver: "test/editor-reference-chips-visual-capture.mjs",
  },
  "reference-completion": {
    entry: "test/reference-completion-visual-entry.ts",
    bundle: "reference-completion-visual-bundle.js",
    driver: "test/reference-completion-visual-capture.mjs",
  },
  "reference-hover": {
    entry: "test/reference-hover-visual-entry.ts",
    bundle: "reference-hover-visual-bundle.js",
    driver: "test/reference-hover-visual-capture.mjs",
  },
  "reference-navigation": {
    entry: "test/reference-navigation-entry.ts",
    bundle: "reference-navigation-bundle.js",
    driver: "test/reference-navigation-probe.mjs",
    esbuildArgs: ["--define:process.platform='\"linux\"'"],
  },
  "navigation-controls": {
    build: "test/visual-build.cjs",
    entry: "test/reference-navigation-controls-entry.ts",
    bundle: "reference-navigation-controls-bundle.js",
    driver: "test/reference-navigation-controls-capture.mjs",
  },
  "rename-preview": {
    build: "test/visual-build.cjs",
    entry: "test/reference-rename-preview-entry.ts",
    bundle: "reference-rename-preview-bundle.js",
    driver: "test/reference-rename-preview-probe.mjs",
  },
  "selection-composer": {
    build: "test/visual-build.cjs",
    entry: "test/annotation-composer-visual-entry.ts",
    bundle: "annotation-composer-visual-bundle.js",
    driver: "test/annotation-composer-visual-capture.mjs",
  },
  "review-diff": {
    entry: "test/editor-review-diff-visual-entry.ts",
    bundle: "review-diff-visual-bundle.js",
    driver: "test/editor-review-diff-visual-capture.mjs",
  },
  "editor-annotations": {
    entry: "test/editor-annotations-visual-entry.ts",
    bundle: "editor-annotations-visual-bundle.js",
    driver: "test/editor-annotations-visual-capture.mjs",
  },
  "annotations-panel": {
    build: "test/visual-build.cjs",
    entry: "test/annotations-sidebar-visual-entry.ts",
    bundle: "annotations-sidebar-visual-bundle.js",
    driver: "test/annotations-sidebar-visual-capture.mjs",
  },
  "readme-demos": {
    entry: "test/readme-demo-entry.ts",
    bundle: "readme-demo-bundle.js",
    driver: "test/readme-demo-capture.mjs",
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
  run(process.execPath, [
    path.join(root, capture.build),
    path.join(root, capture.entry),
    capture.bundle,
    output,
  ]);
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

// Playwright launches Electron from inside the driver, so the driver itself
// is a plain node process — bun cannot complete Playwright's CDP attach to
// Electron. xvfb still supplies the display Electron needs on a headless box.
run("xvfb-run", ["-a", "node", path.join(root, capture.driver), output]);
