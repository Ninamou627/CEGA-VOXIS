import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("..", import.meta.url));

/** En dev, /lecturer et /dashboard servent leurs pages (comme le serveur en production). */
const prettyUrls: PluginOption = {
  name: "salle-pretty-urls",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const url = req.url ?? "";
      if (/^\/(lecturer|dashboard)(\?|$)/.test(url)) req.url = url.replace(/^\/(lecturer|dashboard)/, "/$1.html");
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
    // Trois pages distinctes : pas de repli SPA vers index.html pour les adresses inconnues.
    appType: "mpa" as const,
    server: {
      host: true,
      port: 5173,
      fs: { allow: [repo] },
      proxy: {
        "/api": { target: "http://localhost:8787", changeOrigin: true },
        "/ws": { target: "ws://localhost:8787", ws: true },
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: `${root}index.html`,
          lecturer: `${root}lecturer.html`,
          dashboard: `${root}dashboard.html`,
        },
      },
    },
  };
});
