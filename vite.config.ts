import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages base path — repo is served at kevinday.github.io/tts-phone-bridge/
// so every asset URL must be prefixed with this. If we ever move to a custom
// domain or a user-root Pages site, change this to "/".
const BASE = "/tts-phone-bridge/";

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon.svg"],
      manifest: {
        name: "TTS Phone Bridge",
        short_name: "TTS Bridge",
        description:
          "Type-to-speak bridge for phone calls — voice-clone TTS routed to the phone's mic input.",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: BASE,
        scope: BASE,
        icons: [
          {
            src: "icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Never cache ElevenLabs API responses or the WebSocket handshake —
        // we always want fresh voices and a live socket.
        navigateFallbackDenylist: [/^\/api\//, /elevenlabs\.io/],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\.elevenlabs\.io\/.*/,
            handler: "NetworkOnly",
          },
        ],
        // Precache the SPA shell.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
      },
      devOptions: {
        enabled: false, // PWA disabled in dev to avoid stale SW during iteration
      },
    }),
  ],
});
