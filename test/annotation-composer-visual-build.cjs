'use strict'

// Bundles annotation-composer-visual-entry.ts with the production renderer
// webpack config (vue-loader, ts-loader, aliases) — the AnnotationCreateDialog
// component needs the production loader chain. Used by the
// capture-selection-composer recipe (plan section 10, scene
// 01-selection-composer). Modeled on reference-rename-preview-build.cjs.

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
  entry: path.resolve(__dirname, 'annotation-composer-visual-entry.ts'),
  output: {
    path: outputDirectory,
    filename: 'annotation-composer-visual-bundle.js',
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
