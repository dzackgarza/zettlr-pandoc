"use strict";

// Bundles reference-error-surface-entry.ts with the production renderer
// webpack config (ts-loader, aliases), exactly like
// reference-create-label-build.cjs — the entry resolves the production
// error boundary through a webpack context and mounts a real CodeMirror
// editor. Used by test/reference-error-surface.spec.ts.

const path = require("path");
const webpack = require("webpack");
const rendererConfig = require("../webpack.renderer.config");

const outputDirectory = path.resolve(process.argv[process.argv.length - 1]);

webpack(
  {
    ...rendererConfig,
    module: {
      ...rendererConfig.module,
      rules: rendererConfig.module.rules.filter((rule) => {
        return rule.use?.loader !== "@vercel/webpack-asset-relocator-loader";
      }),
    },
    mode: "development",
    devtool: false,
    entry: path.resolve(__dirname, "reference-error-surface-entry.ts"),
    output: {
      path: outputDirectory,
      filename: "reference-error-surface-bundle.js",
    },
  },
  (error, stats) => {
    if (error !== null) {
      console.error(error);
      process.exitCode = 1;
      return;
    }

    const output = stats?.toString({ colors: false, chunks: false, modules: false }) ?? "";
    if (stats?.hasErrors() === true) {
      console.error(output);
      process.exitCode = 1;
      return;
    }

    console.log(output);
  },
);
