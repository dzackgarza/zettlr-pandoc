'use strict'

// Bundles editor-tikz-visual-entry.ts with the production renderer webpack
// config (vue-loader for TikzLightbox.vue, ts-loader, aliases), following
// reference-search-overlay-build.cjs. Used by the `just capture-tikz` recipe.

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
  entry: path.resolve(__dirname, 'editor-tikz-visual-entry.ts'),
  output: {
    path: outputDirectory,
    filename: 'tikz-visual-bundle.js',
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
