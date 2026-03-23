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
        start_url: "/",
        display: "standalone",
        background_color: "#111315",
        theme_color: "#111315",
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

