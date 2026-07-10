import { defineConfig } from "vite";

export default defineConfig({
  // Cloudflare's build tooling injects into this array; it must exist even if empty.
  plugins: [],
  // Relative base so the built app works when hosted in a subpath (e.g. GitHub Pages).
  base: "./",
  server: {
    host: true, // expose on LAN so you can open it on your phone during dev
  },
  build: {
    target: "es2021",
  },
});
