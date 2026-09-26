/**
 * Checklist d'avant-séance (ROADMAP, horizon 1). Les points vérifiables le sont en
 * direct depuis le serveur ; les autres se cochent à la main et restent cochés pour
 * la session (mémoire de l'appareil).
 */
import { useEffect, useState } from "react";
import type { StatsPayload } from "../../../../shared/protocol";
import { Icon } from "../../ui/Icon";
import type { Health, SessionInfo } from "../types";
import { Meter } from "../ui";

export interface ChecklistProps {
  info?: SessionInfo;
  health?: Health;
  stats?: StatsPayload;
  serverReachable: boolean;
  /** Seuil de parole réglé dans la configuration (dBFS). */
  threshold: number;
}

type State = "ok" | "warn" | "fail" | "wait";
interface Auto {
  id: string;
  label: string;
  state: State;
  detail?: string;
}

const MANUAL = [
  { id: "wifi", label: "Borne Wi-Fi dédiée en place (5 GHz, sans portail captif)" },
  { id: "usb", label: "Micro HF branché sur l'interface USB du PC" },
  { id: "headset", label: "Casque fermé sur le formateur" },
  { id: "qr", label: "QR code projeté ou affiché à l'entrée" },
  { id: "check", label: "« npm run check » passé ce matin" },
];

const ICON: Record<State, { name: string; cls: string }> = {
  ok: { name: "check_circle", cls: "text-secondary" },
  warn: { name: "error", cls: "text-tertiary" },
  fail: { name: "cancel", cls: "text-error" },
  wait: { name: "radio_button_unchecked", cls: "text-outline" },
};

export function Checklist(p: ChecklistProps) {
  const key = `salle.checklist.${p.info?.sessionId ?? "default"}`;
  const [done, setDone] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      setDone(JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, boolean>);
    } catch {
      setDone({});
    }
  }, [key]);
  function toggle(id: string) {
    const next = { ...done, [id]: !done[id] };
    setDone(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* mémoire indisponible : la coche tient pour la page */
    }
  }

  const providers = p.info?.providers;
  const mock = providers ? Object.values(providers).some((n) => n.startsWith("mock")) : false;
  const mic = p.stats?.micDb ?? null;
  const auto: Auto[] = [
    { id: "server", label: "Serveur de salle joignable", state: p.serverReachable ? "ok" : "fail", detail: p.serverReachable ? undefined : "vérifier qu'il tourne, et sur le bon schéma HTTP/HTTPS" },
    { id: "tls", label: "HTTPS actif (questions au micro)", state: !p.info ? "wait" : p.info.tls ? "ok" : "fail", detail: p.info && !p.info.tls ? "les téléphones n'auront pas de micro" : undefined },
    { id: "cert", label: "Certificat et adresse de la salle", state: !p.info ? "wait" : p.info.certWarning ? "fail" : "ok", detail: p.info?.certWarning ?? undefined },
    { id: "providers", label: "Fournisseurs réels (pas de simulateur)", state: !providers ? "wait" : mock ? "warn" : "ok", detail: mock ? `${providers!.stt} · ${providers!.mt} · ${providers!.tts}` : undefined },
    { id: "lecturer", label: "Formateur connecté, micro ouvert", state: !p.health ? "wait" : p.health.lecturer ? "ok" : "fail" },
    {
      id: "stt",
      label: "Reconnaissance vocale ouverte",
      state: !p.health ? "wait" : p.health.audio.sttOpen ? "ok" : p.health.lecturer ? "warn" : "wait",
      detail: p.health && p.health.lecturer && !p.health.audio.sttOpen ? "le flux de reconnaissance n'est pas établi" : undefined,
    },
    {
      id: "mic",
      label: "Parole reçue par le serveur",
      state: mic == null ? "wait" : mic > p.threshold ? "ok" : mic > p.threshold - 15 ? "warn" : "fail",
      detail: mic == null ? "en attente du micro" : mic > p.threshold ? `${mic} dB` : `${mic} dB — mauvais micro ou niveau trop bas ?`,
    },
    { id: "listeners", label: "Au moins un téléphone à l'écoute", state: !p.stats ? "wait" : p.stats.listeners > 0 ? "ok" : "warn", detail: p.stats ? `${p.stats.listeners} connecté${p.stats.listeners > 1 ? "s" : ""}` : undefined },
  ];
  const okCount = auto.filter((a) => a.state === "ok").length + MANUAL.filter((m) => done[m.id]).length;
  const total = auto.length + MANUAL.length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-4">
        <Meter value={okCount / total} tone={okCount === total ? "ok" : "warn"} className="w-48" />
        <span className="font-metric-mono-sm text-[13px] text-on-surface">
          {okCount} / {total}
        </span>
        <span className="text-[13px] text-on-surface-variant">{okCount === total ? "tout est prêt" : "points prêts"}</span>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-12 gap-y-6">
        <div>
          <div className="text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant mb-1">Vérifié en direct</div>
          <ul className="divide-y divide-outline-variant/15">
            {auto.map((a) => (
              <li key={a.id} className="flex items-start gap-3 py-2.5 text-[13px]">
                <Icon name={ICON[a.state].name} fill={a.state === "ok"} className={`text-[18px] mt-px shrink-0 ${ICON[a.state].cls}`} />
                <div className="flex flex-col min-w-0">
                  <span className={a.state === "fail" ? "text-error" : "text-on-surface"}>{a.label}</span>
                  {a.detail && <span className="text-xs text-on-surface-variant break-words">{a.detail}</span>}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant mb-1">À cocher sur place</div>
          <ul className="divide-y divide-outline-variant/15">
            {MANUAL.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => toggle(m.id)} className="w-full flex items-start gap-3 py-2.5 text-[13px] text-left hover:text-on-surface transition-colors">
                  <Icon name={done[m.id] ? "check_box" : "check_box_outline_blank"} className={`text-[18px] mt-px shrink-0 ${done[m.id] ? "text-secondary" : "text-outline"}`} />
                  <span className={done[m.id] ? "text-on-surface-variant line-through" : "text-on-surface"}>{m.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
