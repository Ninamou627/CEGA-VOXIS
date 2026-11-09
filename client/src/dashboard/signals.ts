/**
 * Ce que l'administration déduit des signaux bruts : l'état de chaque étage de la chaîne
 * (micro → audio → reconnaissance → traduction → voix) et les alertes en cours. Une seule
 * source pour la vue d'ensemble, la supervision et le compteur d'alertes du menu.
 */
import type { OverviewResponse, RecentReport, Stage } from "../../../shared/admin";
import type { ClientSettings, StatsPayload } from "../../../shared/protocol";
import type { ConnState } from "../lib/ws";
import { delay, span } from "../ui/format";
import { REPORT_LABEL } from "../ui/reports";
import type { Health, SessionInfo } from "./types";
import type { Tone } from "./ui";

export interface Signals {
  conn: ConnState;
  now: number;
  stats?: StatsPayload;
  health?: Health;
  info?: SessionInfo;
  /** Réglages poussés par le serveur (seuil de parole, alerte de silence). */
  room?: ClientSettings;
  overview?: OverviewResponse;
  /** Signalements reçus en direct depuis l'ouverture de la page. */
  reports: RecentReport[];
}

export type StageId = "mic" | "audio" | "stt" | "mt" | "tts";

export interface StageState {
  id: StageId;
  label: string;
  icon: string;
  tone: Tone;
  status: string;
  /** Mesure courte sous l'état : niveau, latence médiane… */
  metric: string;
  engine?: string;
  /** Dernier incident de l'étage, s'il y en a un récent. */
  incident?: string;
}

/** Une erreur d'étage compte pendant deux minutes. */
const RECENT_ERROR_MS = 120_000;

function recentError(sig: Signals, stage: Stage) {
  const e = sig.overview?.lastErrors[stage];
  return e && sig.now - e.at < RECENT_ERROR_MS ? e : undefined;
}

export function stageStates(sig: Signals): StageState[] {
  const h = sig.health;
  const st = sig.stats;
  const pl = st?.pipeline ?? h?.pipeline;
  const lecturer = Boolean(h?.lecturer);
  const threshold = sig.room?.speechThresholdDb ?? -35;
  const silenceAlert = sig.room?.silenceAlertS ?? 20;
  const db = st?.micDb ?? null;
  const lastFrame = h?.audio.lastFrameAgoMs ?? null;
  const degraded = pl?.degraded ?? "none";
  const sg = st?.stages;

  const mic: StageState = !lecturer
    ? { id: "mic", label: "Microphone", icon: "mic", tone: "idle", status: "Hors ligne", metric: "formateur absent" }
    : pl?.muted
      ? { id: "mic", label: "Microphone", icon: "mic_off", tone: "warn", status: "Coupé", metric: "sourdine du formateur" }
      : lastFrame != null && lastFrame > 3000
        ? { id: "mic", label: "Microphone", icon: "mic_off", tone: "crit", status: "Muet", metric: `plus de son depuis ${delay(lastFrame)}` }
        : { id: "mic", label: "Microphone", icon: "mic", tone: "ok", status: "Connecté", metric: `${(h?.audio.received ?? 0).toLocaleString("fr-FR")} trames` };

  const audio: StageState =
    !lecturer || db == null
      ? { id: "audio", label: "Audio", icon: "graphic_eq", tone: "idle", status: lecturer ? "En attente" : "—", metric: "aucun signal" }
      : db > -3
        ? { id: "audio", label: "Audio", icon: "graphic_eq", tone: "crit", status: "Saturé", metric: `${db} dB` }
        : db > threshold
          ? { id: "audio", label: "Audio", icon: "graphic_eq", tone: "ok", status: "Bon", metric: `${db} dB` }
          : (st?.micSilentS ?? 0) >= silenceAlert
            ? { id: "audio", label: "Audio", icon: "graphic_eq", tone: "warn", status: "Silence", metric: `${db} dB depuis ${span((st?.micSilentS ?? 0) * 1000)}` }
            : { id: "audio", label: "Audio", icon: "graphic_eq", tone: "ok", status: "Pause", metric: `${db} dB` };

  const sttErr = recentError(sig, "stt");
  const stt: StageState =
    degraded === "stt-lost"
      ? { id: "stt", label: "Reconnaissance vocale", icon: "hearing", tone: "crit", status: "Interrompue", metric: "reconnexion en cours" }
      : lecturer && h && !h.audio.sttOpen
        ? { id: "stt", label: "Reconnaissance vocale", icon: "hearing", tone: "crit", status: "Fermée", metric: "flux non établi" }
        : !lecturer
          ? { id: "stt", label: "Reconnaissance vocale", icon: "hearing", tone: "idle", status: "En veille", metric: "attend le micro" }
          : sttErr
            ? { id: "stt", label: "Reconnaissance vocale", icon: "hearing", tone: "warn", status: "Instable", metric: sg?.endCommitP50 != null ? `p50 ${delay(sg.endCommitP50)}` : "—" }
            : { id: "stt", label: "Reconnaissance vocale", icon: "hearing", tone: "ok", status: "Opérationnelle", metric: sg?.endCommitP50 != null ? `p50 ${delay(sg.endCommitP50)}` : "à l'écoute" };
  stt.engine = pl?.stt;
  stt.incident = sttErr?.msg;

  // « Texte seul » vient de la traduction ou de la voix : l'erreur la plus récente dit laquelle.
  const mtErr = recentError(sig, "mt");
  const ttsErr = recentError(sig, "tts");
  const textOnlyFromMt = degraded === "text-only" && (mtErr?.at ?? 0) > (ttsErr?.at ?? 0);
  const mt: StageState =
    textOnlyFromMt
      ? { id: "mt", label: "Moteur de traduction", icon: "translate", tone: "crit", status: "En panne", metric: "texte source affiché" }
      : degraded === "backup-mt"
        ? { id: "mt", label: "Moteur de traduction", icon: "translate", tone: "warn", status: "Secours", metric: sg?.mtP50 != null ? `p50 ${delay(sg.mtP50)}` : "—" }
        : mtErr
          ? { id: "mt", label: "Moteur de traduction", icon: "translate", tone: "warn", status: "Instable", metric: sg?.mtP50 != null ? `p50 ${delay(sg.mtP50)}` : "—" }
          : { id: "mt", label: "Moteur de traduction", icon: "translate", tone: lecturer ? "ok" : "idle", status: lecturer ? "Opérationnel" : "En veille", metric: sg?.mtP50 != null ? `p50 ${delay(sg.mtP50)}` : "—" };
  mt.engine = pl?.mt;
  mt.incident = mtErr?.msg;

  const tts: StageState =
    degraded === "text-only" && !textOnlyFromMt
      ? { id: "tts", label: "Synthèse vocale", icon: "record_voice_over", tone: "crit", status: "En panne", metric: "texte seul" }
      : degraded === "backup-tts"
        ? { id: "tts", label: "Synthèse vocale", icon: "record_voice_over", tone: "warn", status: "Secours", metric: sg?.ttsP50 != null ? `p50 ${delay(sg.ttsP50)}` : "—" }
        : ttsErr
          ? { id: "tts", label: "Synthèse vocale", icon: "record_voice_over", tone: "warn", status: "Instable", metric: sg?.ttsP50 != null ? `p50 ${delay(sg.ttsP50)}` : "—" }
          : {
              id: "tts",
              label: "Synthèse vocale",
              icon: "record_voice_over",
              tone: lecturer ? "ok" : "idle",
              status: lecturer ? "Opérationnelle" : "En veille",
              metric: sg?.ttsP50 != null ? `p50 ${delay(sg.ttsP50)} · ×${(pl?.speed ?? 1).toFixed(2).replace(".", ",")}` : "—",
            };
  tts.engine = pl?.tts;
  tts.incident = ttsErr?.msg;

  return [mic, audio, stt, mt, tts];
}

export type Severity = "crit" | "warn" | "info";

export interface Alert {
  id: string;
  severity: Severity;
  title: string;
  detail?: string;
  /** Page de l'administration où agir. */
  to?: string;
  /** Étage de la chaîne concerné, s'il y en a un (inspecteur de la constellation). */
  stage?: StageId;
}

const STAGE_NAME: Record<Stage, string> = { stt: "Reconnaissance", mt: "Traduction", tts: "Synthèse vocale" };
/** Les signalements des apprenants, rattachés à l'étage qu'ils mettent en cause. */
const REPORT_STAGE: Partial<Record<string, StageId>> = { transcription: "stt", translation: "mt", voice: "tts" };

export function computeAlerts(sig: Signals): Alert[] {
  const out: Alert[] = [];
  const h = sig.health;
  const st = sig.stats;
  const pl = st?.pipeline ?? h?.pipeline;
  const lecturer = Boolean(h?.lecturer);

  if (sig.conn !== "open") out.push({ id: "conn", severity: "crit", title: "Liaison perdue avec le serveur de salle", detail: "Les chiffres de cette page ne sont plus à jour ; reconnexion automatique en cours." });
  if (sig.info?.certWarning) out.push({ id: "cert", severity: "crit", title: "Adresse de la salle refusée aux téléphones", detail: sig.info.certWarning, to: "seance" });
  else if (sig.info && !sig.info.tls) out.push({ id: "http", severity: "warn", title: "Salle en HTTP : pas de micro sur les téléphones", detail: "Les questions parlées exigent HTTPS. Voir docs/CERTIFICAT.md.", to: "seance" });

  const mocks = pl ? [pl.stt, pl.mt, pl.tts].filter((n) => n.includes("mock")) : [];
  if (mocks.length) out.push({ id: "mock", severity: "warn", title: "Fournisseur simulé en service", detail: `${mocks.join(" · ")} — la salle n'entend pas une vraie traduction.`, to: "configuration" });

  if (lecturer && (h?.audio.lastFrameAgoMs ?? 0) > 3000 && !pl?.muted) {
    out.push({ id: "frames", severity: "crit", title: "Le micro du formateur n'envoie plus de son", detail: `Dernière trame reçue il y a ${delay(h!.audio.lastFrameAgoMs!)}. Onglet formateur fermé ou en veille ?`, to: "supervision", stage: "mic" });
  }
  if (lecturer && h && !h.audio.sttOpen && pl?.degraded !== "stt-lost") out.push({ id: "stt-closed", severity: "crit", title: "Reconnaissance vocale fermée", detail: "Le formateur est en ligne mais le flux de reconnaissance n'est pas ouvert.", to: "supervision", stage: "stt" });

  const threshold = sig.room?.speechThresholdDb ?? -35;
  const silence = sig.room?.silenceAlertS ?? 20;
  if (lecturer && !pl?.muted && st?.micDb != null && st.micDb < threshold && (st.micSilentS ?? 0) >= silence) {
    out.push({ id: "silence", severity: "warn", title: `Silence au micro depuis ${span((st.micSilentS ?? 0) * 1000)}`, detail: `${st.micDb} dB reçus, seuil de parole à ${threshold} dB : mauvais micro ou niveau trop bas ?`, to: "configuration", stage: "audio" });
  }

  // « Texte seul » vient de la traduction ou de la voix : l'erreur la plus récente dit laquelle.
  const mtErr = sig.overview?.lastErrors.mt;
  const ttsErr = sig.overview?.lastErrors.tts;
  switch (pl?.degraded) {
    case "text-only":
      out.push({ id: "degraded", severity: "crit", title: "Voix indisponible : les apprenants n'ont que le texte", to: "supervision", stage: (mtErr?.at ?? 0) > (ttsErr?.at ?? 0) ? "mt" : "tts" });
      break;
    case "stt-lost":
      out.push({ id: "degraded", severity: "crit", title: "Reconnaissance vocale interrompue", detail: "Reconnexion automatique en cours.", to: "supervision", stage: "stt" });
      break;
    case "backup-mt":
      out.push({ id: "degraded", severity: "warn", title: "Traduction de secours en service", detail: "Le moteur principal a échoué ; il est réessayé dans une minute.", to: "supervision", stage: "mt" });
      break;
    case "backup-tts":
      out.push({ id: "degraded", severity: "warn", title: "Voix de secours en service", detail: "La voix principale a échoué ; elle est réessayée dans une minute.", to: "supervision", stage: "tts" });
      break;
  }

  // Plusieurs étages en échec ensemble : la cause commune est la connexion du poste, pas des
  // pannes indépendantes chez trois fournisseurs (séance du 19/10/2026 : aucun incident chez eux).
  const failing = (["stt", "mt", "tts"] as const).filter((stage) => recentError(sig, stage));
  if (failing.length >= 2) {
    const names = failing.map((stage) => STAGE_NAME[stage].toLowerCase());
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}` : names[0];
    out.push({
      id: "network",
      severity: "crit",
      title: "Réseau du poste instable",
      detail: `${list[0].toUpperCase()}${list.slice(1)} échouent en même temps : la cause commune est la connexion de ce PC. Passez en filaire ou sur un autre réseau.`,
      to: "supervision",
    });
  }
  const backlog = h?.audio.sttBacklogMs ?? 0;
  if (lecturer && backlog > 1000)
    out.push({
      id: "uplink",
      severity: backlog > 3000 ? "crit" : "warn",
      title: `La voix du formateur part avec ${delay(backlog)} de retard`,
      detail: "La connexion montante du PC ne suit pas : la reconnaissance reçoit la parole en retard.",
      to: "supervision",
      stage: "stt",
    });
  const sttLag = st?.stages.sttLagP50 ?? null;
  if (sttLag != null && sttLag > 3000)
    out.push({
      id: "stt-lag",
      severity: "warn",
      title: `Le texte reconnu arrive ${delay(sttLag)} après la parole`,
      detail: "Médiane de la dernière minute ; d'habitude autour d'une seconde. Réseau du poste ou du fournisseur de reconnaissance.",
      to: "supervision",
      stage: "stt",
    });

  const end = st?.endP50 ?? null;
  if (end != null && end > 1000)
    out.push({ id: "e2e", severity: end > 2000 ? "crit" : "warn", title: `Latence élevée : ${delay(end)}`, detail: "De la fin de la phrase à la voix, médiane sur la dernière minute ; la cible est 1 s.", to: "supervision" });
  const q = st?.queueMaxMs ?? null;
  if (q != null && q > 5000) out.push({ id: "drift", severity: "warn", title: `Dérive : un téléphone a ${delay(q)} de retard en file`, detail: "Rien n'est sauté : le retard se résorbe pendant les pauses de l'orateur, ou l'apprenant revient au direct.", to: "supervision", stage: "tts" });

  for (const stage of ["stt", "mt", "tts"] as const) {
    const e = sig.overview?.lastErrors[stage];
    if (e && sig.now - e.at < RECENT_ERROR_MS) out.push({ id: `err-${stage}`, severity: "warn", title: `Erreurs récentes — ${STAGE_NAME[stage]} (${e.count})`, detail: e.msg, to: "supervision", stage });
  }

  // Plusieurs apprenants qui signalent la même chose en cinq minutes : ce n'est plus un avis isolé.
  const counts = new Map<string, number>();
  for (const r of sig.reports) if (sig.now - r.at < 300_000) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
  for (const [kind, n] of counts) {
    if (n >= 2) out.push({ id: `reports-${kind}`, severity: "warn", title: `${n} signalements « ${REPORT_LABEL[kind as keyof typeof REPORT_LABEL].label} » en 5 min`, to: "qualite", stage: REPORT_STAGE[kind] });
  }

  if (h && h.process.loopLagMaxMs > 100) out.push({ id: "lag", severity: "warn", title: `Serveur surchargé : ${h.process.loopLagMaxMs} ms de retard de boucle`, to: "supervision" });
  if (lecturer && st && st.listeners === 0) out.push({ id: "empty", severity: "info", title: "Le formateur parle, personne n'écoute", detail: "Aucun téléphone connecté à la salle.", to: "seance" });

  const rank: Record<Severity, number> = { crit: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
