/**
 * Taille et position de la fenêtre, retrouvées au lancement suivant.
 *
 * Un formateur installe son poste une fois — écran, résolution, place de la fenêtre — et ne
 * doit pas le refaire chaque matin. Le point délicat est l'écran débranché : une fenêtre
 * enregistrée sur un second moniteur absent s'ouvrirait hors de vue.
 */
import { screen, type BrowserWindow } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

/** Enregistrement différé : déplacer une fenêtre déclenche des dizaines d'événements. */
const SAVE_AFTER_MS = 500;

export function loadWindowState(file: string, fallback: WindowState): WindowState {
  if (!existsSync(file)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<WindowState>;
    const state: WindowState = {
      width: Math.max(fallback.width / 2, Number(raw.width) || fallback.width),
      height: Math.max(fallback.height / 2, Number(raw.height) || fallback.height),
      x: Number.isFinite(raw.x) ? Number(raw.x) : undefined,
      y: Number.isFinite(raw.y) ? Number(raw.y) : undefined,
      maximized: Boolean(raw.maximized),
    };
    const visible = onVisibleScreen(state);
    if (process.env.VOXIS_DEBUG) console.log(`[voxis] état lu : ${JSON.stringify(state)} — écran présent : ${visible}`);
    return visible ? state : { ...state, x: undefined, y: undefined };
  } catch (err) {
    if (process.env.VOXIS_DEBUG) console.warn(`[voxis] état illisible : ${(err as Error).message}`);
    // Fichier illisible : on repart des valeurs par défaut, sans bruit.
    return fallback;
  }
}

/** La fenêtre retomberait-elle sur un écran présent ? Sinon on laisse le système la placer. */
function onVisibleScreen(state: WindowState): boolean {
  if (state.x === undefined || state.y === undefined) return true;
  return screen.getAllDisplays().some(({ workArea: w }) => {
    // Un coin suffit : une fenêtre à cheval sur deux écrans reste atteignable.
    const insideX = state.x! < w.x + w.width && state.x! + state.width > w.x;
    const insideY = state.y! < w.y + w.height && state.y! + state.height > w.y;
    return insideX && insideY;
  });
}

/** Suit la fenêtre et enregistre son état à chaque changement, puis à la fermeture. */
export function trackWindowState(win: BrowserWindow, file: string): void {
  let timer: NodeJS.Timeout | undefined;

  const save = () => {
    if (win.isDestroyed()) return;
    // La taille utile est celle de la fenêtre restaurée, pas celle d'un plein écran.
    const bounds = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    const state: WindowState = { ...bounds, maximized: win.isMaximized() };
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, file); // écriture atomique : pas de fichier tronqué si l'on ferme brutalement
    } catch {
      /* état de confort : son enregistrement ne doit jamais faire échouer l'application */
    }
  };

  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_AFTER_MS);
  };

  win.on("resize", later);
  win.on("move", later);
  win.on("maximize", later);
  win.on("unmaximize", later);
  win.on("close", () => {
    clearTimeout(timer);
    save();
  });
}
