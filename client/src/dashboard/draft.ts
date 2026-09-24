/**
 * Brouillon de la configuration. On peut modifier des réglages, aller ailleurs dans
 * l'administration (changer la voix par défaut depuis la page Voix, par exemple), puis
 * revenir enregistrer : seuls les champs réellement touchés dans le brouillon partent,
 * posés sur les réglages les plus récents du serveur. Personne n'écrase le travail d'un autre.
 */
import type { Settings } from "../../../shared/settings";

const SECTIONS = ["translation", "speech", "voice"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Clés « section.champ » qui diffèrent entre deux réglages. */
export function diffKeys(a: Settings, b: Settings): string[] {
  const out: string[] = [];
  for (const s of SECTIONS) {
    const x = a[s] as Record<string, unknown>;
    const y = b[s] as Record<string, unknown>;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (!same(x[k], y[k])) out.push(`${s}.${k}`);
  }
  if (!same(a.voices, b.voices)) out.push("voices");
  return out;
}

/** Les changements du brouillon (depuis `base`) appliqués sur `latest`. */
export function rebase(base: Settings, draft: Settings, latest: Settings): Settings {
  const out = structuredClone(latest);
  for (const s of SECTIONS) {
    const b = base[s] as Record<string, unknown>;
    const d = draft[s] as Record<string, unknown>;
    const o = out[s] as Record<string, unknown>;
    for (const k of Object.keys(d)) {
      if (same(d[k], b[k])) continue;
      if (s === "voice" && k === "defaults") {
        // Voix par défaut : langue par langue, pour ne pas défaire un choix fait sur la page Voix.
        const bd = b[k] as Record<string, string | undefined>;
        const dd = d[k] as Record<string, string | undefined>;
        const od = { ...(o[k] as Record<string, string | undefined>) };
        for (const l of new Set([...Object.keys(bd), ...Object.keys(dd)])) {
          if (bd[l] === dd[l]) continue;
          if (dd[l] === undefined) delete od[l];
          else od[l] = dd[l];
        }
        o[k] = od;
      } else o[k] = d[k];
    }
  }
  return out;
}

/** Les réglages en mots, pour dire ce qui vient d'être appliqué. */
export const KEY_LABEL: Record<string, string> = {
  "translation.primary": "moteur principal",
  "translation.secondary": "moteur de secours",
  "translation.model": "modèle",
  "translation.effort": "effort",
  "translation.temperature": "température",
  "translation.timeoutMs": "délai maximal",
  "translation.contextSegments": "continuité",
  "translation.domain": "contexte linguistique",
  "translation.glossary": "glossaire",
  "speech.inputGainDb": "gain du micro",
  "speech.speechThresholdDb": "seuil de parole",
  "speech.silenceAlertS": "alerte de silence",
  "speech.endpointing": "fin de phrase",
  "speech.minWords": "segment minimal",
  "speech.clauseWords": "coupe à la proposition",
  "speech.maxWords": "segment maximal",
  "speech.segmentTimeoutMs": "délai de coupe",
  "speech.keyterms": "vocabulaire",
  "speech.prompt": "description de séance",
  "voice.defaults": "voix par défaut",
  "voice.speed": "vitesse",
  "voice.stability": "ton",
  "voice.style": "style",
  "voice.listenerVolume": "volume d'écoute",
  voices: "voix de la salle",
};

export function describe(keys: string[]): string {
  return keys.map((k) => KEY_LABEL[k] ?? k).join(", ");
}
