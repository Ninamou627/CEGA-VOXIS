/**
 * CEGA Voxis pour Windows (D18) : une fenêtre sur la plateforme en ligne, rien de plus.
 *
 * Cette coquille ne contient aucune interface ni aucune logique métier. Elle charge les
 * pages servies par le serveur — les mêmes que dans un navigateur — si bien qu'un
 * déploiement met l'application à jour sans réinstallation. Elle n'apporte que ce qu'un
 * navigateur ne sait pas faire : ouvrir le micro sans redemander l'autorisation à chaque
 * lancement, verrouiller la navigation sur le domaine de la salle, retrouver sa fenêtre, et
 * attendre poliment que la salle revienne.
 *
 *   VOXIS_URL=https://localhost:8787 npm run dev -w desktop   (serveur de développement)
 */
import { app, BrowserWindow, globalShortcut, Menu, net, session, shell } from "electron";
import { autoUpdater } from "electron-updater";
import path from "node:path";
import { loadWindowState, trackWindowState } from "./window-state";

const DEV = !app.isPackaged;

/**
 * L'adresse de la plateforme. Hors empaquetage, on vise le serveur de développement : un
 * `npm run dev -w desktop` qui ouvrirait la production afficherait l'écran d'attente tant
 * qu'elle n'est pas déployée, ce qui ne veut rien dire quand on développe. `VOXIS_URL`
 * l'emporte toujours — pour viser la production depuis une version non empaquetée, par
 * exemple.
 */
const DEFAULT_SERVER = DEV ? "https://localhost:8787" : "https://institutcega.fr";
const SERVER = (process.env.VOXIS_URL ?? DEFAULT_SERVER).replace(/\/$/, "");
const ORIGIN = new URL(SERVER).origin;

/** Les deux postes que l'application de bureau sert (l'apprenant reste sur le Web). */
const PAGES = {
  lecturer: { path: "/lecturer", label: "Poste formateur" },
  dashboard: { path: "/dashboard", label: "Administration" },
} as const;

const OFFLINE_PAGE = path.join(__dirname, "..", "static", "offline.html");

/** La page à rouvrir quand la salle revient : celle que l'on visait, pas toujours l'accueil. */
let target = `${SERVER}${PAGES.lecturer.path}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// ---- autorisations -------------------------------------------------------------------
/**
 * Accordées d'office, et à notre domaine seulement. Le micro est la raison d'être de ce
 * poste : le redemander à chaque lancement n'apporterait aucune sécurité, puisque la
 * navigation est verrouillée sur la salle. Tout le reste est refusé.
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
  // identifiants des périphériques sont visibles — donc si la liste du formateur est utilisable.
  s.setPermissionCheckHandler((_contents, permission, origin) => {
    const ok = isOurs(origin) && GRANTED.has(permission);
    if (DEV) console.log(`[voxis] vérification : ${permission} depuis ${origin} → ${ok ? "accordée" : "refusée"}`);
    return ok;
  });

  // Un appareil précis est choisi dans la page (MicSelect) ; ici on se contente d'accepter.
  s.setDevicePermissionHandler(({ origin }) => origin === ORIGIN);
}

// ---- la salle répond-elle ? ----------------------------------------------------------
/** Passe par la pile réseau de Chromium, donc par notre exception de certificat en dev. */
async function serverReachable(): Promise<boolean> {
  try {
    // Un paramètre qui change évite qu'un cache réponde à notre place.
    const res = await net.fetch(`${SERVER}/api/health?t=${Date.now()}`);
    return res.ok;
  } catch {
    return false;
  }
}

/** La fenêtre affiche-t-elle l'écran d'attente ? (le seul contenu local de l'application) */
const onOfflineScreen = (win: BrowserWindow) => win.webContents.getURL().startsWith("file://");

let watching = false;

/**
 * Montre l'écran d'attente et guette le retour de la salle. La cadence se calme peu à peu :
 * une coupure de quelques secondes se rattrape vite, une panne longue n'interroge pas le
 * réseau sans arrêt. Dès que le serveur répond, on rouvre la page visée.
 */
async function showOfflineAndWait(win: BrowserWindow): Promise<void> {
  await win.loadFile(OFFLINE_PAGE, { hash: encodeURIComponent(target) }).catch(() => {});
  if (watching) return;
  watching = true;
  try {
    for (let wait = 2000; ; wait = Math.min(Math.round(wait * 1.4), 15_000)) {
      await sleep(wait);
      // Fenêtre fermée, ou le formateur a déjà réussi à revenir par le bouton : on s'arrête.
      if (win.isDestroyed() || !onOfflineScreen(win)) return;
      if (await serverReachable()) {
        console.log("[voxis] la salle répond de nouveau");
        void win.loadURL(target);
        return;
      }
    }
  } finally {
    watching = false;
  }
}

// ---- la fenêtre ----------------------------------------------------------------------
function createWindow(): BrowserWindow {
  const stateFile = path.join(app.getPath("userData"), "window-state.json");
  const state = loadWindowState(stateFile, { width: 1280, height: 820, maximized: false });

  const win = new BrowserWindow({
    ...state,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0f131c",
    title: "CEGA Voxis",
    // La fenêtre n'apparaît qu'une fois prête : pas de rectangle blanc au lancement.
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  trackWindowState(win, stateFile);

  // Un lien vers l'extérieur s'ouvre dans le vrai navigateur ; un lien de la salle
  // (le tableau de bord en a, en target="_blank") reste dans cette fenêtre.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url)) go(win, url);
    else void shell.openExternal(url);
    return { action: "deny" };
  });

  // La coquille ne va nulle part ailleurs que sur la salle — y compris par redirection.
  const keepInside = (event: { preventDefault(): void }, url: string) => {
    if (isOurs(url) || url.startsWith("file://")) return;
    event.preventDefault();
    void shell.openExternal(url);
  };
  win.webContents.on("will-navigate", keepInside);
  win.webContents.on("will-redirect", keepInside);

  win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    // -3 = chargement interrompu par une navigation volontaire : ce n'est pas une panne.
    if (!isMainFrame || code === -3) return;
    console.error(`[voxis] chargement impossible (${code} ${description}) : ${url}`);
    void showOfflineAndWait(win);
  });

  // Un rendu qui meurt en pleine séance : on rouvre la page plutôt que de laisser un vide.
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error(`[voxis] le rendu s'est arrêté : ${details.reason}`);
    if (details.reason !== "clean-exit" && !win.isDestroyed()) go(win, target);
  });

  win.on("unresponsive", () => console.warn("[voxis] la page ne répond plus"));

  go(win, target);
  return win;
}

/** Ouvre une page de la salle et retient laquelle, pour y revenir après une coupure. */
function go(win: BrowserWindow, url: string) {
  target = url;
  void win.loadURL(url);
}

// ---- raccourcis globaux --------------------------------------------------------------
/**
 * Couper le micro sans revenir à la fenêtre : un formateur qui tousse, répond à quelqu'un
 * dans la salle ou cherche un document ne doit pas chercher un bouton. C'est précisément ce
 * qu'un navigateur ne sait pas faire.
 */
const SHORTCUTS: Record<string, string> = { "CommandOrControl+Shift+M": "toggle-mute" };

function registerShortcuts(win: BrowserWindow) {
  for (const [combo, name] of Object.entries(SHORTCUTS)) {
    const ok = globalShortcut.register(combo, () => {
      if (!win.isDestroyed()) win.webContents.send("voxis:shortcut", name);
    });
    // Une autre application peut déjà détenir la combinaison : on le dit, sans échouer.
    if (!ok) console.warn(`[voxis] raccourci « ${combo} » indisponible, déjà pris par une autre application`);
  }
}

function buildMenu(win: BrowserWindow) {
  const open = (p: string) => () => go(win, `${SERVER}${p}`);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "CEGA Voxis",
        submenu: [
          { label: PAGES.lecturer.label, accelerator: "CmdOrCtrl+1", click: open(PAGES.lecturer.path) },
          { label: PAGES.dashboard.label, accelerator: "CmdOrCtrl+2", click: open(PAGES.dashboard.path) },
          { type: "separator" },
          { label: "Recharger", accelerator: "CmdOrCtrl+R", click: () => (onOfflineScreen(win) ? go(win, target) : win.webContents.reload()) },
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

// ---- mises à jour de la coquille -----------------------------------------------------
/**
 * Les interfaces se mettent à jour par le serveur : elles sont chargées en ligne. Seule la
 * coquille elle-même a besoin d'un installeur, et cela n'arrive que rarement.
 *
 * Elle se télécharge en fond et **ne s'installe qu'à la fermeture** : jamais de redémarrage
 * imposé au milieu d'une formation. Sans certificat de signature, la vérification de
 * signature est désactivée — c'est alors HTTPS qui garantit seul l'intégrité du
 * téléchargement, d'où un flux servi par notre propre domaine et rien d'autre (voir D18).
 */
const UPDATE_EVERY_MS = 6 * 3_600_000;

function watchForUpdates() {
  if (DEV) return; // rien à mettre à jour depuis les sources
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => console.log(`[voxis] version ${info.version} disponible, téléchargement en fond`));
  autoUpdater.on("update-downloaded", (info) => console.log(`[voxis] version ${info.version} prête, elle s'installera à la fermeture`));
  // Serveur injoignable, flux absent : ce n'est pas une raison d'ennuyer le formateur.
  autoUpdater.on("error", (err) => console.warn(`[voxis] mise à jour impossible : ${err.message}`));

  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_EVERY_MS).unref();
}

// ---- cycle de vie --------------------------------------------------------------------
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

  // Rien d'embarqué ne doit charger de contenu : pas de <webview> dans nos pages.
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
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
    const win = createWindow();
    buildMenu(win);
    registerShortcuts(win);
    watchForUpdates();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) buildMenu(createWindow());
    });
  });

  // Les raccourcis globaux sont détenus par le système : on les rend en partant.
  app.on("will-quit", () => globalShortcut.unregisterAll());

  app.on("window-all-closed", () => app.quit());
}
