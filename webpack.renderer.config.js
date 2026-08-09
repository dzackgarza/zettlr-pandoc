const rules = require('./webpack.rules')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const path = require('path')

const { VueLoaderPlugin } = require('vue-loader')
const { DefinePlugin } = require('webpack')

const plugins = [
  // Apply webpack rules to the corresponding language blocks in .vue files
  new VueLoaderPlugin(),
  new CopyWebpackPlugin({
    patterns: [{
      from: 'node_modules/@mathjax/mathjax-newcm-font/chtml/woff2',
      to: 'mathjax'
    }, {
      from: 'node_modules/@mathjax/mathjax-mhchem-font-extension/chtml/woff2',
      to: 'mathjax'
    }]
  }),

  // Set a few Vue 3 options; see: http://link.vuejs.org/feature-flags
  new DefinePlugin({
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false, // New in Vue 3.4
    // Quote from the docs: "Note that because the plugin does a direct text
    // replacement, the value given to it must include actual quotes inside of
    // the string itself. Typically, this is done either with alternate quotes,
    // such as '"production"', or by using JSON.stringify('production')."
    __GIT_COMMIT_HASH__: JSON.stringify(process.env.GIT_COMMIT_HASH),
    __BUILD_DATE__: JSON.stringify((new Date()).toISOString()),
    __UPDATES_DISABLED__: JSON.stringify(process.env.ZETTLR_DISABLE_UPDATE_CHECK !== undefined ? '1' : '0')
  })
]

rules.push({
  test: /\.less$/,
  use: [{
    loader: 'style-loader' // Create style nodes from JS strings
  }, {
    loader: 'css-loader' // Translate CSS into JS string
  }, {
    loader: 'less-loader' // Compile Less to CSS
  }]
})

module.exports = {
  module: { rules },
  // Persist compilation across builds: an unchanged module is a cache hit,
  // so a rebuild after a small edit pays for the edit, not the whole tree.
  cache: { type: 'filesystem', buildDependencies: { config: [__filename] } },
  // The following line of code serves two purposes: While we're in develop
  // (NODE_ENV = develop), emit source maps so we have an easy time finding the
  // origin of bugs or performance bottlenecks. But since source maps are a
  // whopping 60MB large at the time of writing (July 2021), we disable these
  // in production (i.e. when we ship to users). NOTE, however, that these env-
  // variables must be set, which we're doing using cross-env in package.json.
  devtool: (process.env.NODE_ENV === 'production') ? false : 'source-map',
  plugins,
  resolve: {
    extensions: [
      '.js', '.ts', '.jsx', '.tsx',
      '.css', '.less', '.vue'
    ],
    alias: {
      source: [path.resolve(__dirname, 'source')],
      '@common': [path.resolve(__dirname, 'source/common')],
      '@providers': [path.resolve(__dirname, 'source/app/service-providers')],
      '@dts': [path.resolve(__dirname, 'source/types')],
      // fzf publishes `"type": "module"` yet routes require() to a UMD file,
      // which webpack then parses as an ESM file with zero exports. Since
      // ts-loader emits CommonJS (tsconfig `module`), `import { Fzf }` becomes
      // exactly such a require. Point the bare specifier straight at the ES
      // build (the package's exports map blocks deep imports, an alias does
      // not) so webpack's interop serves the real named exports.
      fzf: path.resolve(__dirname, 'node_modules/fzf/dist/fzf.es.js')
    },
    fallback: {
      // Don't polyfill these modules
      path: false,
      fs: false
    }
  }
}
