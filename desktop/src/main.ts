/**
 * CEGA Voxis pour Windows (D18) : une fenêtre sur la plateforme en ligne, rien de plus.
 *
 * Cette coquille ne contient aucune interface ni aucune logique métier. Elle charge les
 * pages servies par le serveur — les mêmes que dans un navigateur — si bien qu'un
 * déploiement met l'application à jour sans réinstallation. Elle n'apporte que ce qu'un
 * navigateur ne sait pas faire : ouvrir le micro sans redemander l'autorisation à chaque
 * lancement, verrouiller la navigation sur le domaine de la salle, et donner une vraie
 * fenêtre au poste formateur.
 *
 *   VOXIS_URL=https://localhost:8787 npm run dev -w desktop   (serveur de développement)
 */
import { app, BrowserWindow, Menu, session, shell } from "electron";

/** L'adresse de la plateforme. Le développement la remplace par le serveur local. */
const SERVER = (process.env.VOXIS_URL ?? "https://institutcega.fr").replace(/\/$/, "");
const ORIGIN = new URL(SERVER).origin;
const DEV = !app.isPackaged;

/** Les deux postes que l'application de bureau sert (l'apprenant reste sur le Web). */
const PAGES = {
  lecturer: { path: "/lecturer", label: "Poste formateur" },
  dashboard: { path: "/dashboard", label: "Administration" },
} as const;

/**
 * Est-ce une adresse de la salle ? On compare des origines analysées, jamais des chaînes :
 * Chromium présente l'origine avec une barre finale (`https://…:8787/`) au contrôle des
 * permissions, et une comparaison littérale y échoue. Conséquence observée : la permission
 * micro se lisait « refusée », ce qui masque les noms *et* les identifiants des
 * périphériques — la liste de choix du micro du formateur se retrouvait vide.
 */
function isOurs(url: string): boolean {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Autorisations accordées d'office, et à notre domaine seulement. Le micro est la raison
 * d'être de ce poste : le redemander à chaque lancement n'apporterait aucune sécurité,
 * puisque la navigation est verrouillée sur la salle. Tout le reste est refusé.
 */
const GRANTED = new Set(["media", "speaker-selection", "clipboard-sanitized-write", "notifications", "fullscreen"]);

function configurePermissions() {
  const s = session.defaultSession;

  s.setPermissionRequestHandler((contents, permission, callback) => {
    const allowed = isOurs(contents.getURL()) && GRANTED.has(permission);
    if (!allowed) console.warn(`[voxis] autorisation refusée : ${permission} pour ${contents.getURL()}`);
    callback(allowed);
  });

  // Chromium interroge aussi ce point d'entrée, et c'est lui qui décide si les noms et les
  // identifiants des périphériques sont visibles — donc si la liste du formateur est
  // utilisable. L'origine y arrive parfois avec une barre finale : on compare des URL.
  s.setPermissionCheckHandler((_contents, permission, origin) => {
    const ok = isOurs(origin) && GRANTED.has(permission);
    if (DEV) console.log(`[voxis] vérification : ${permission} depuis ${origin} → ${ok ? "accordée" : "refusée"}`);
    return ok;
  });

  // Un appareil précis est choisi dans la page (MicSelect) ; ici on se contente d'accepter.
  s.setDevicePermissionHandler(({ origin }) => origin === ORIGIN);
}

/** Écran d'attente quand le serveur ne répond pas — jamais une fenêtre blanche. */
function offlinePage(reason: string): string {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0f131c; color:#e3e6ee;
         font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:30rem; padding:2rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .75rem; }
  p { margin:0 0 1.5rem; color:#9aa3b8; }
  code { color:#7dd3a0; }
  button { font:inherit; font-weight:600; padding:.7rem 1.4rem; border:0; border-radius:.75rem;
           background:#2f9e68; color:#fff; cursor:pointer; }
</style></head><body><main>
  <h1>Serveur de salle injoignable</h1>
  <p>${reason}<br><code>${ORIGIN}</code></p>
  <button onclick="location.href='${SERVER}${PAGES.lecturer.path}'">Réessayer</button>
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0f131c",
    autoHideMenuBar: false,
    title: "CEGA Voxis",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Un lien vers l'extérieur s'ouvre dans le vrai navigateur ; un lien de la salle
  // (le tableau de bord en a, en target="_blank") reste dans cette fenêtre.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) void win.loadURL(url);
    else void shell.openExternal(url);
    return { action: "deny" };
  });

  // La coquille ne va nulle part ailleurs que sur la salle.
  win.webContents.on("will-navigate", (event, url) => {
    if (isOurs(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });

  win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    // -3 = chargement interrompu par une navigation volontaire : ce n'est pas une panne.
    if (!isMainFrame || code === -3) return;
    console.error(`[voxis] chargement impossible (${code} ${description}) : ${url}`);
    void win.loadURL(offlinePage("La connexion n'a pas abouti. Vérifiez votre accès à Internet, puis réessayez."));
  });

  void win.loadURL(`${SERVER}${PAGES.lecturer.path}`);
  return win;
}

function buildMenu(win: BrowserWindow) {
  const go = (path: string) => () => void win.loadURL(`${SERVER}${path}`);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "CEGA Voxis",
        submenu: [
          { label: PAGES.lecturer.label, accelerator: "CmdOrCtrl+1", click: go(PAGES.lecturer.path) },
          { label: PAGES.dashboard.label, accelerator: "CmdOrCtrl+2", click: go(PAGES.dashboard.path) },
          { type: "separator" },
          { label: "Recharger", accelerator: "CmdOrCtrl+R", click: () => win.webContents.reload() },
          { type: "separator" },
          { role: "quit", label: "Quitter" },
        ],
      },
      {
        label: "Affichage",
        submenu: [
          { role: "resetZoom", label: "Taille normale" },
          { role: "zoomIn", label: "Agrandir" },
          { role: "zoomOut", label: "Réduire" },
          { type: "separator" },
          { role: "togglefullscreen", label: "Plein écran" },
          ...(DEV ? [{ role: "toggleDevTools" as const, label: "Outils de développement" }] : []),
        ],
      },
    ]),
  );
}

// Une seule instance : deux fenêtres ouvriraient deux fois le micro du formateur.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // En développement, le serveur local porte un certificat auto-signé : on l'accepte,
  // pour lui seul. En production, aucune exception — le certificat doit être valide.
  app.on("certificate-error", (event, _contents, url, _error, _cert, callback) => {
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();
    const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (DEV && local) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  void app.whenReady().then(() => {
    configurePermissions();
    buildMenu(createWindow());

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) buildMenu(createWindow());
    });
  });

  app.on("window-all-closed", () => app.quit());
}
