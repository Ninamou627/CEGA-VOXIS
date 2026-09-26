/**
 * Rejoindre la salle : le QR code à projeter, l'adresse, les adresses de repli,
 * les langues diffusées et l'état HTTPS (sans lui, pas de questions au micro).
 */
import { useState } from "react";
import type { RoomCodeResponse } from "../../../../shared/auth";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import { Qr } from "../../ui/Qr";
import type { SessionInfo } from "../types";
import { Action, Chip, Empty } from "../ui";

export interface JoinViewProps {
  info?: SessionInfo;
  error?: string;
  /** Code de séance (D17) : sans lui, aucun apprenant ne peut entrer. */
  code?: RoomCodeResponse;
  onRotate: () => void;
  rotating?: boolean;
}

export function Join({ info, error, code, onRotate, rotating }: JoinViewProps) {
  const [copied, setCopied] = useState(false);
  if (!info) return <Empty icon={error ? "cloud_off" : "hourglass_top"}>{error ?? "Lecture de l'adresse de la salle…"}</Empty>;

  // L'adresse utile est celle qui porte le code : c'est elle qu'on affiche et qu'on encode.
  const url = code?.joinUrl ?? info.joinUrl;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* presse-papiers refusé (HTTP) : l'adresse reste sélectionnable à la main */
    }
  };

  if (!code) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Empty icon="key_off">Aucun code de séance : les apprenants ne peuvent pas entrer. Ouvrez-en un avant de commencer.</Empty>
        <button
          type="button"
          onClick={onRotate}
          disabled={rotating}
          className="flex items-center gap-2 py-2.5 px-4 rounded-xl bg-secondary text-on-secondary hover:bg-secondary-fixed font-headline-sm text-sm font-bold shadow-md transition-all active:scale-[0.98] disabled:opacity-50"
        >
          <Icon name="key" fill className="text-[18px]" />
          {rotating ? "Ouverture…" : "Ouvrir une séance"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col sm:flex-row gap-8 items-start">
      <Qr value={url} size={176} className="w-44 shrink-0" />
      <div className="min-w-0 flex-1 flex flex-col gap-4">
        <div>
          <div className="text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant">Code de séance</div>
          <div className="flex items-center gap-3 mt-1.5">
            <span className="font-metric-mono-sm text-2xl tracking-[0.25em] text-on-surface select-all">{code.code}</span>
            <Action icon="autorenew" onClick={onRotate} title="Nouveau code — l'ancien QR ne vaudra plus rien" />
          </div>
          <div className="text-[12px] text-on-surface-variant mt-1">
            Valable jusqu'à{" "}
            {new Date(code.expiresAt).toLocaleString("fr-FR", { weekday: "long", hour: "2-digit", minute: "2-digit" })}. À dicter si un téléphone ne scanne pas.
          </div>
        </div>

        <div>
          <div className="text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant">Adresse des apprenants</div>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="font-metric-mono-sm text-[15px] text-on-surface break-all select-all">{url}</span>
            <Action icon={copied ? "check" : "content_copy"} onClick={copy} title={copied ? "Copiée" : "Copier l'adresse"} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px]">
          <span className="flex items-center gap-2 text-on-surface-variant">
            Langues
            <span className="text-on-surface font-medium" title="Langue du formateur">
              {LANGS[info.srcLang].flag} {LANGS[info.srcLang].short}
            </span>
            <Icon name="arrow_forward" className="text-[14px] text-primary" />
            {info.langs.map((l) => (
              <span key={l} className="text-on-surface font-medium">
                {LANGS[l].flag} {LANGS[l].short}
              </span>
            ))}
          </span>
          <span className="flex items-center gap-1.5">
            <Chip tone={info.tls ? "ok" : "crit"}>
              <Icon name={info.tls ? "lock" : "lock_open"} className="text-[12px]" />
              {info.tls ? "HTTPS" : "HTTP"}
            </Chip>
            <span className="text-on-surface-variant">{info.tls ? "micro des téléphones disponible" : "pas de questions parlées sur les téléphones"}</span>
          </span>
        </div>

        {info.certWarning && (
          <p className="text-[13px] text-error leading-relaxed flex items-start gap-2">
            <Icon name="gpp_bad" className="text-[17px] shrink-0 mt-px" />
            {info.certWarning}
          </p>
        )}

        {info.joinUrls && info.joinUrls.length > 1 && (
          <details className="text-[13px] text-on-surface-variant group">
            <summary className="cursor-pointer select-none hover:text-on-surface">
              {info.joinUrls.length - 1} autre{info.joinUrls.length > 2 ? "s" : ""} adresse{info.joinUrls.length > 2 ? "s" : ""} — si un téléphone ne joint pas celle du QR
            </summary>
            <ul className="mt-2 divide-y divide-outline-variant/15">
              {info.joinUrls.slice(1).map((j) => (
                <li key={j.url} className={`py-1.5 flex flex-wrap gap-x-3 ${j.virtual ? "opacity-60" : ""}`}>
                  <span className="font-metric-mono-sm text-on-surface break-all select-all">{j.url}</span>
                  <span className="text-outline">
                    {j.iface}
                    {j.virtual ? " · virtuelle" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
