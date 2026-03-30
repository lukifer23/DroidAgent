import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "DroidAgent",
        short_name: "DroidAgent",
        description: "Mobile-first control for OpenClaw on your Mac",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait-primary",
        background_color: "#111315",
        theme_color: "#111315",
        id: "/",
        icons: [
          {
            src: "/icon.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "any maskable"
          }
        ]
      }
    })
  ],
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@tanstack/react-router")) {
              return "router-vendor";
            }
            if (id.includes("@tanstack/react-query")) {
              return "query-vendor";
            }
            if (
              id.includes("/react-dom/") ||
              id.includes("/react/")
            ) {
              return "react-vendor";
            }
          }

          if (
            id.includes("/src/app-context.tsx") ||
            id.includes("/src/app-data.ts") ||
            id.includes("/src/app-layout.tsx") ||
            id.includes("/src/hooks/use-websocket.ts") ||
            id.includes("/src/hooks/use-viewport-measure.ts") ||
            id.includes("/src/lib/api.ts") ||
            id.includes("/src/lib/client-performance.ts") ||
            id.includes("/src/lib/formatters.ts") ||
            id.includes("/src/lib/operator-readiness.ts")
          ) {
            return "app-shell";
          }

          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4318",
      "/ws": {
        target: "ws://127.0.0.1:4318",
        ws: true
      }
    }
  }
});
