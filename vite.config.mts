import { resolve } from "node:path";
import { defineConfig, normalizePath } from "vite";

export default defineConfig({
  root: "src",
  publicDir: "../public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: normalizePath(resolve(import.meta.dirname, "src/index.html")),
      output: {
        entryFileNames: "index-[hash].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
    modulePreload: false,
  },
  resolve: {
    alias: {
      "@": normalizePath(resolve(import.meta.dirname, "src")),
      "@lib": normalizePath(resolve(import.meta.dirname, "lib")),
    },
  },
  optimizeDeps: {
    exclude: ["babylon-mmd", "@babylonjs/core"],
  },
  server: {
    host: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "cross-origin",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  },
  worker: {
    format: "es",
  },
});
