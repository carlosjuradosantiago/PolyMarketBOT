import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/// <reference types="vitest" />

export default defineConfig(async ({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    clearScreen: false,
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
    },
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
        // Claude proxy moved to Supabase Edge Function (no timeout limits)
        // Frontend calls SUPABASE_URL/functions/v1/claude-proxy directly
        "/api/wallet": {
          // In dev, wallet endpoint is handled by the Vite proxy to a local handler
          // For now, return empty — wallet info is optional
          bypass: (_req, res) => {
            const pk = env.WALLET_PRIVATE_KEY || env.VITE_PRIVATE_KEY;
            if (!pk) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ address: "", balance: null, isValid: false }));
              return;
            }
            // Let it fall through to the actual /api/wallet serverless in dev
            return undefined;
          },
        },
        // Supabase — no proxy needed, direct from browser
      },
    },
  };
});
