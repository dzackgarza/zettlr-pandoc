'use strict'

// Bundles one visual-capture entry point with the production renderer
// webpack config (vue-loader, ts-loader, aliases) — every scene that mounts
// a real .vue single-file component needs this loader chain. The entry
// file, output bundle filename, and output directory are positional
// arguments so this one script serves every such scene instead of a
// per-scene copy.
//
// Usage: node visual-build.cjs <entry.ts> <bundle-filename.js> <output-dir>

const path = require('path')
const webpack = require('webpack')
const rendererConfig = require('../webpack.renderer.config')

const [entryArg, bundleFilename, outputDirectoryArg] = process.argv.slice(2)
if (entryArg === undefined || bundleFilename === undefined || outputDirectoryArg === undefined) {
  throw new Error('Usage: visual-build.cjs <entry> <bundle-filename> <output-dir>')
}

const outputDirectory = path.resolve(outputDirectoryArg)

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
  entry: path.resolve(entryArg),
  output: {
    path: outputDirectory,
    filename: bundleFilename,
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
