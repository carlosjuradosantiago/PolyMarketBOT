import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
    proxy: {
      "/api/gamma": {
        target: "https://gamma-api.polymarket.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gamma/, ""),
        secure: true,
      },
      "/api/clob": {
        target: "https://clob.polymarket.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/clob/, ""),
        secure: true,
      },
      "/api/data": {
        target: "https://data-api.polymarket.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/data/, ""),
        secure: true,
      },
      "/api/claude": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/claude/, ""),
        secure: true,
      },
      // Supabase — no proxy needed, direct from browser
      // Polygon RPC removed — wallet.ts calls CORS-friendly RPCs directly
    },
  },
}));
