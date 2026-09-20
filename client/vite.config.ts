import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("..", import.meta.url));

/** Lit le .env de la racine pour parler au serveur avec le bon schéma et le bon port. */
function serverTarget(): string {
  if (process.env.VITE_API_TARGET) return process.env.VITE_API_TARGET;
  const envPath = `${repo}.env`;
  const env: Record<string, string> = {};
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
      if (m) env[m[1]] = m[2];
    }
  }
  const tls = Boolean(env.TLS_CERT && env.TLS_KEY);
  return `${tls ? "https" : "http"}://localhost:${env.PORT || 8787}`;
}
const apiTarget = serverTarget();

/** En dev, /lecturer, /dashboard et /screen servent leurs pages (comme le serveur en production). */
const prettyUrls: PluginOption = {
  name: "salle-pretty-urls",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const url = req.url ?? "";
      if (/^\/(lecturer|dashboard|screen)(\?|$)/.test(url)) req.url = url.replace(/^\/(lecturer|dashboard|screen)/, "/$1.html");
      next();
    });
  },
};

export default defineConfig(async () => {
  const plugins: PluginOption[] = [react(), prettyUrls];
  // VITE_HTTPS=1 : certificat auto-signé pour tester le micro depuis un téléphone
  // en développement (getUserMedia exige un contexte sécurisé hors localhost).
  if (process.env.VITE_HTTPS === "1") {
    const { default: basicSsl } = await import("@vitejs/plugin-basic-ssl");
    plugins.push(basicSsl());
  }
  return {
    plugins,
    // Quatre pages distinctes : pas de repli SPA vers index.html pour les adresses inconnues.
    appType: "mpa" as const,
    server: {
      host: true,
      port: 5173,
      fs: { allow: [repo] },
      // VITE_API_TARGET=https://localhost:8787 quand le serveur tourne en TLS (certificat de dev).
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true, secure: false },
        "/ws": { target: apiTarget.replace(/^http/, "ws"), ws: true, secure: false },
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: `${root}index.html`,
          lecturer: `${root}lecturer.html`,
          dashboard: `${root}dashboard.html`,
          screen: `${root}screen.html`,
        },
      },
    },
  };
});
