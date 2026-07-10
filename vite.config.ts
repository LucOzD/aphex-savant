import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built app works when hosted in a subpath (e.g. GitHub Pages).
  base: "./",
  server: {
    host: true, // expose on LAN so you can open it on your phone during dev
  },
  build: {
    target: "es2021",
  },
});
