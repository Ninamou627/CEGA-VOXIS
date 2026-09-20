/**
 * Checklist d'avant-séance (ROADMAP, horizon 1). Les points vérifiables le sont en
 * direct depuis le serveur ; les autres se cochent à la main et restent cochés pour
 * la session (mémoire de l'appareil).
 */
import { useEffect, useState } from "react";
import type { StatsPayload } from "../../../../shared/protocol";
import { Icon } from "../../ui/Icon";
import type { Health, SessionInfo } from "../types";
import { Card } from "./Card";

export interface ChecklistProps {
  info?: SessionInfo;
  health?: Health;
  stats?: StatsPayload;
  serverReachable: boolean;
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
  { id: "check", label: "`npm run check` passé ce matin" },
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
    { id: "cert", label: "Certificat valable pour l'IP du PC", state: !p.info ? "wait" : p.info.certWarning ? "fail" : "ok", detail: p.info?.certWarning ?? undefined },
    { id: "providers", label: "Fournisseurs réels (pas de simulateur)", state: !providers ? "wait" : mock ? "warn" : "ok", detail: mock ? `${providers!.stt} · ${providers!.mt} · ${providers!.tts}` : undefined },
    { id: "lecturer", label: "Formateur connecté, micro ouvert", state: !p.health ? "wait" : p.health.lecturer ? "ok" : "fail" },
    { id: "stt", label: "Reconnaissance vocale ouverte", state: !p.health ? "wait" : p.health.audio.sttOpen ? "ok" : p.health.lecturer ? "warn" : "wait", detail: p.health && p.health.lecturer && !p.health.audio.sttOpen ? "le flux STT n'est pas établi" : undefined },
    { id: "mic", label: "Parole reçue par le serveur", state: mic == null ? "wait" : mic > -35 ? "ok" : mic > -50 ? "warn" : "fail", detail: mic == null ? "en attente du micro" : mic > -35 ? `${mic} dB` : `${mic} dB — mauvais micro ou niveau trop bas ?` },
    { id: "listeners", label: "Au moins un téléphone à l'écoute", state: !p.stats ? "wait" : p.stats.listeners > 0 ? "ok" : "warn", detail: p.stats ? `${p.stats.listeners} connecté${p.stats.listeners > 1 ? "s" : ""}` : undefined },
  ];
  const okCount = auto.filter((a) => a.state === "ok").length + MANUAL.filter((m) => done[m.id]).length;
  const total = auto.length + MANUAL.length;

  return (
    <Card
      icon="checklist"
      title="Avant la séance"
      tone="tertiary"
      right={
        <span className={`font-metric-mono-sm text-[11px] font-bold px-2 py-0.5 rounded-full border ${okCount === total ? "text-secondary bg-secondary/10 border-secondary/20" : "text-on-surface-variant bg-surface-container-low border-outline-variant/30"}`}>
          {okCount}/{total}
        </span>
      }
    >
      <ul className="flex flex-col gap-1">
        {auto.map((a) => (
          <li key={a.id} className="flex items-start gap-2 text-xs">
            <Icon name={ICON[a.state].name} fill={a.state === "ok"} className={`text-[16px] mt-px shrink-0 ${ICON[a.state].cls}`} />
            <div className="flex flex-col min-w-0">
              <span className={a.state === "fail" ? "text-error" : "text-on-surface"}>{a.label}</span>
              {a.detail && <span className="text-[11px] text-on-surface-variant break-words">{a.detail}</span>}
            </div>
          </li>
        ))}
      </ul>
      <div className="h-px bg-outline-variant/20" />
      <ul className="flex flex-col gap-1">
        {MANUAL.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => toggle(m.id)} className="w-full flex items-start gap-2 text-xs text-left rounded-lg hover:bg-surface-container-low px-1 -mx-1 py-0.5 transition-colors">
              <Icon name={done[m.id] ? "check_box" : "check_box_outline_blank"} className={`text-[16px] mt-px shrink-0 ${done[m.id] ? "text-secondary" : "text-outline"}`} />
              <span className={done[m.id] ? "text-on-surface-variant line-through" : "text-on-surface"}>{m.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
