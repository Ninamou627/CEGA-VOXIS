/**
 * Pipeline et serveur : les trois moteurs et leur état (nominal, secours, dégradé),
 * puis la santé du processus relevée sur /api/health — ce que le test de tenue sur
 * plusieurs heures regarde (mémoire, retard de boucle, trames audio).
 */
import type { StatsPayload } from "../../../../shared/protocol";
import { delay } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import type { Health, SessionInfo } from "../types";
import { Card } from "./Card";

const DEGRADED: Record<string, string> = {
  none: "nominal",
  "text-only": "texte seul — voix indisponible",
  "backup-mt": "traduction de secours",
  "backup-tts": "voix de secours",
  "stt-lost": "reconnaissance perdue",
  s2s: "chemin de secours S2S",
};

function Row({ label, value, tone = "" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 bg-surface-container-low rounded-lg px-2.5 py-1.5 border border-outline-variant/20 text-xs">
      <span className="text-on-surface-variant font-medium shrink-0">{label}</span>
      <span className={`font-metric-mono-sm text-[11px] truncate ${tone || "text-on-surface"}`} title={value}>
        {value}
      </span>
    </div>
  );
}

export function Pipeline({ stats, health, info }: { stats?: StatsPayload; health?: Health; info?: SessionInfo }) {
  const pl = stats?.pipeline ?? health?.pipeline;
  const degraded = pl ? pl.degraded !== "none" : false;
  const backup = pl?.degraded.startsWith("backup-");
  const names = { stt: pl?.stt ?? info?.providers.stt, mt: pl?.mt ?? info?.providers.mt, tts: pl?.tts ?? info?.providers.tts };
  const pr = health?.process;
  const au = health?.audio;
  return (
    <Card
      icon="memory"
      title="Pipeline et serveur"
      tone="primary"
      right={
        <span
          key={pl?.degraded ?? "wait"}
          className={`pop flex items-center gap-1 text-[10px] font-label-badge font-bold px-2 py-0.5 rounded-full border ${
            !pl ? "text-outline bg-surface-container-low border-outline-variant/30" : degraded ? (backup ? "text-tertiary bg-tertiary/10 border-tertiary/30" : "text-error bg-error/10 border-error/30") : "text-secondary bg-secondary/10 border-secondary/20"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${!pl ? "bg-outline" : degraded ? (backup ? "bg-tertiary" : "bg-error") : "bg-secondary"}`}></span>
          {!pl ? "EN ATTENTE" : degraded ? (backup ? "SECOURS" : "DÉGRADÉ") : "NOMINAL"}
        </span>
      }
    >
      <div className="flex flex-col gap-1.5">
        <Row label="Reconnaissance" value={names.stt ?? "—"} tone={pl?.degraded === "stt-lost" ? "text-error" : ""} />
        <Row label="Traduction" value={names.mt ?? "—"} tone={pl?.degraded === "backup-mt" ? "text-tertiary" : ""} />
        <Row label="Voix" value={names.tts ?? "—"} tone={pl?.degraded === "backup-tts" ? "text-tertiary" : pl?.degraded === "text-only" ? "text-error" : ""} />
      </div>
      {pl && degraded && <div className="text-[11px] text-on-surface-variant">Mode : {DEGRADED[pl.degraded] ?? pl.degraded}</div>}
      <div className="grid grid-cols-2 gap-1.5 text-xs">
        <Row label="Muet" value={pl ? (pl.muted ? "oui" : "non") : "—"} tone={pl?.muted ? "text-tertiary" : ""} />
        <Row label="Vitesse voix" value={pl ? `×${pl.speed.toFixed(2).replace(".", ",")}` : "—"} tone={pl && pl.speed > 1 ? "text-tertiary" : ""} />
      </div>

      <div className="flex items-center gap-1.5 pt-1 text-[10px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant">
        <Icon name="dns" className="text-[14px]" />
        Serveur de salle
        <span className="ml-auto font-metric-mono-sm normal-case tracking-normal font-medium">{health ? `relevé /api/health` : "en attente"}</span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Row label="CPU" value={pr?.cpuPercent != null ? `${pr.cpuPercent} %` : "—"} tone={pr?.cpuPercent != null && pr.cpuPercent > 60 ? "text-tertiary" : ""} />
        <Row label="Mémoire" value={pr ? `${pr.rssMb} Mo` : "—"} tone={pr && pr.rssMb > 600 ? "text-tertiary" : ""} />
        <Row label="Retard boucle" value={pr ? `${pr.loopLagMaxMs} ms` : "—"} tone={pr && pr.loopLagMaxMs > 100 ? "text-error" : pr && pr.loopLagMaxMs > 30 ? "text-tertiary" : ""} />
        <Row label="Tas JS" value={pr ? `${pr.heapMb} Mo` : "—"} />
        <Row label="Trames micro" value={au ? `${au.received.toLocaleString("fr-FR")}` : "—"} />
        <Row label="Dernière trame" value={au?.lastFrameAgoMs != null ? `il y a ${delay(au.lastFrameAgoMs)}` : "—"} tone={au?.lastFrameAgoMs != null && au.lastFrameAgoMs > 3000 && health?.lecturer ? "text-error" : ""} />
        <Row label="Flux STT" value={au ? (au.sttOpen ? "ouvert" : "fermé") : "—"} tone={au && health?.lecturer && !au.sttOpen ? "text-error" : ""} />
        <Row label="Audio reçu" value={au ? `${(au.bytes / 1048576).toFixed(1).replace(".", ",")} Mo` : "—"} />
      </div>
    </Card>
  );
}
