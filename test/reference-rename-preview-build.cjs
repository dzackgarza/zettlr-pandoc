'use strict'

// Bundles reference-rename-preview-entry.ts with the production renderer
// webpack config (vue-loader, ts-loader, aliases), exactly like
// reference-create-label-build.cjs — the Vue rename-preview dialog needs the
// production loader chain. Used by test/reference-rename-preview.spec.ts and
// the capture-rename-preview recipe.

const path = require('path')
const webpack = require('webpack')
const rendererConfig = require('../webpack.renderer.config')

const outputDirectory = path.resolve(process.argv[process.argv.length - 1])

webpack({
  ...rendererConfig,
  module: {
    ...rendererConfig.module,
    rules: rendererConfig.module.rules.filter(rule => {
      return rule.use?.loader !== '@vercel/webpack-asset-relocator-loader'
    }),
  },
  mode: 'development',
  devtool: false,
  entry: path.resolve(__dirname, 'reference-rename-preview-entry.ts'),
  output: {
    path: outputDirectory,
    filename: 'reference-rename-preview-bundle.js',
  },
}, (error, stats) => {
  if (error !== null) {
    console.error(error)
    process.exitCode = 1
    return
  }

  const output = stats?.toString({ colors: false, chunks: false, modules: false }) ?? ''
  if (stats?.hasErrors() === true) {
    console.error(output)
    process.exitCode = 1
    return
  }

  console.log(output)
})
