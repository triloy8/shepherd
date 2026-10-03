import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist", emptyOutDir: true, sourcemap: false,
    // The host's font-src 'self' policy excludes Vite's data-URI font inlining.
    assetsInlineLimit: (path) => /\.(?:woff2?|ttf|otf)$/i.test(path) ? false : undefined,
  },
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8788" },
  },
});
