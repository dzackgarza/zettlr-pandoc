"use strict";

// Bundles the navigation-controls capture entry with the production
// renderer webpack config (the entry mounts real .vue single-file
// components and the Clarity icon loader with its .svg imports). Mirrors
// pandoc-quick-help-visual-build.cjs.

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
    entry: path.resolve(__dirname, "reference-navigation-controls-entry.ts"),
    output: {
      path: outputDirectory,
      filename: "reference-navigation-controls-bundle.js",
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
