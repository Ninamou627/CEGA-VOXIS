/** Mises en forme communes aux interfaces (français, virgule décimale). */

/** 3725 → « 01:02:05 ». */
export function hms(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** 8400 → « 0:08 » (durée d'un son). */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 1400 → « 1,4 s » ; 760 → « 760 ms ». */
export function delay(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

/** Écart depuis `at` en mots : « à l'instant », « il y a 45 s », « il y a 3 min ». */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `il y a ${m} min` : `il y a ${Math.floor(m / 60)} h`;
}

/** Heure locale « 10:42:14 » d'un horodatage serveur, corrigé du décalage d'horloge. */
export function clock(tServer: number, clockOffset: number): string {
  return new Date(tServer - clockOffset).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** 1 902 000 ms → « 31 h 42 min » ; 720 000 → « 12 min » ; 45 000 → « 45 s ». */
export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

/** 0,998 → « 99,8 % ». */
export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits).replace(".", ",")} %`;
}

/** 1234 → « 1 234 ». */
export function num(n: number): string {
  return n.toLocaleString("fr-FR");
}

/** Horodatage → « 16 sept. ». */
export function shortDate(t: number): string {
  return new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

/** 870 → « 0,87 s » : latence au centième, comme on la lit sur un tableau de bord. */
export function secs(ms: number): string {
  return `${(ms / 1000).toFixed(2).replace(".", ",")} s`;
}

/** 1 902 000 ms → [["31", "h"], ["42", "min"]] : chiffres et unités, pour les grands nombres. */
export function spanParts(ms: number): [string, string][] {
  const s = Math.round(ms / 1000);
  if (s < 60) return [[String(s), "s"]];
  const m = Math.floor(s / 60);
  if (m < 60) return [[String(m), "min"]];
  return [
    [String(Math.floor(m / 60)), "h"],
    [String(m % 60).padStart(2, "0"), "min"],
  ];
}

/**
 * Taux entier (« 94 % »), sauf quand l'arrondi afficherait 100 % alors qu'il y a eu des
 * échecs : on garde alors une décimale (« 99,6 % »). Un 100 % doit être un vrai 100 %.
 */
export function rate(x: number): string {
  if (x < 1 && Math.round(x * 100) >= 100) return pct(Math.min(x, 0.999), 1);
  return pct(x, 0);
}
