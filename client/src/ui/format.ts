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
