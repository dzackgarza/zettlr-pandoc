import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [vue()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The page loads once from 127.0.0.1; Vue, CodeMirror and Viewer.js in one
    // chunk cost no network round trips, so splitting them gains nothing.
    chunkSizeWarningLimit: 1024,
  },
});
