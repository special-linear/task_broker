import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: "src/web",
  base: "/admin/",
  build: { outDir: "../../dist/web", emptyOutDir: true, target: "es2022" },
  resolve: { alias: { "@shared": resolve(import.meta.dirname, "src/shared") } },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/admin-api": "http://127.0.0.1:8787",
      "/api": "http://127.0.0.1:8787",
    },
  },
});
