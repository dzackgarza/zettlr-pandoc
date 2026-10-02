import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The standalone page; standalone/server.ts builds it with this config.
export default defineConfig({
  root: path.join(import.meta.dirname, "standalone"),
  plugins: [vue()],
  resolve: {
    // The repository's patch to @tikz-editor/lang-tikz
    // (patches/@tikz-editor%2Flang-tikz@0.5.1.patch) points its imports at the
    // CommonJS builds, which Zettlr's webpack bundle uses. This ES module build
    // must load the same ES module copies as every other import, or CodeMirror
    // sees two instances of @codemirror/state.
    alias: [
      {
        find: /^.*\/@codemirror\/language\/dist\/index\.cjs$/u,
        replacement: "@codemirror/language",
      },
      { find: /^.*\/@lezer\/highlight\/dist\/index\.cjs$/u, replacement: "@lezer/highlight" },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The page loads once from 127.0.0.1; Vue, CodeMirror and Viewer.js in one
    // chunk cost no network round trips, so splitting them gains nothing.
    chunkSizeWarningLimit: 1024,
  },
});
