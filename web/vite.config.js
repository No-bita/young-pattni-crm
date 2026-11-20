import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8787" } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: ["chrome107", "edge107", "firefox104", "safari16.0"],
  },
});
