/**
 * The MathJax of an HTML export (`export-math.ts`): the component that the
 * exported file loads and the files that the component loads while it
 * typesets. `webpack.main.config.js` copies them to
 * `.webpack/main/assets/mathjax`, which the package keeps outside `app.asar`
 * (`forge.config.js`); a spec and the export harness copy them to a folder of
 * their own with `copyExportMathJax`.
 *
 * The folder has the layout that MathJax expects around a component, so an
 * exported file names two places and nothing else: the component, and the
 * folder of the font packages (`fonts`). MathJax finds its TeX extensions
 * in `input/tex/extensions` and its speech files in `sre` beside the
 * component, and each font package under its package name in `fonts`.
 */
const { cp } = require("fs/promises");
const path = require("path");

const EXPORT_MATHJAX_FILES = [
  { from: "node_modules/@mathjax/src/bundle/tex-chtml.js", to: "tex-chtml.js" },
  { from: "node_modules/@mathjax/src/bundle/input/tex/extensions", to: "input/tex/extensions" },
  { from: "node_modules/@mathjax/src/bundle/sre", to: "sre" },
  {
    from: "node_modules/@mathjax/mathjax-newcm-font/chtml",
    to: "fonts/mathjax-newcm-font/chtml",
  },
  {
    from: "node_modules/@mathjax/mathjax-mhchem-font-extension",
    to: "fonts/mathjax-mhchem-font-extension",
  },
];

/**
 * Copies the MathJax of an HTML export from the dependencies of the
 * repository into `directory`.
 *
 * @param {string} directory
 * @returns {Promise<void>}
 */
async function copyExportMathJax(directory) {
  const repository = path.join(__dirname, "..");
  for (const { from, to } of EXPORT_MATHJAX_FILES) {
    await cp(path.join(repository, from), path.join(directory, to), { recursive: true });
  }
}

module.exports = { EXPORT_MATHJAX_FILES, copyExportMathJax };
