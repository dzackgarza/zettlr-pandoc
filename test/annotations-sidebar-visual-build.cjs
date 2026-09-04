'use strict'

// Bundles annotations-sidebar-visual-entry.ts with the production renderer
// webpack config (vue-loader for AnnotationsTab.vue and its subcomponents,
// ts-loader, aliases), following editor-tikz-visual-build.cjs. Used by the
// `just capture-annotations-panel` recipe.

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
  entry: path.resolve(__dirname, 'annotations-sidebar-visual-entry.ts'),
  output: {
    path: outputDirectory,
    filename: 'annotations-sidebar-visual-bundle.js',
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
