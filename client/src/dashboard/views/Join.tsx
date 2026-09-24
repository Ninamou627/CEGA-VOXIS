/**
 * Rejoindre la salle : le QR code à projeter, l'adresse, les adresses de repli,
 * les langues diffusées et l'état HTTPS (sans lui, pas de questions au micro).
 */
import { useState } from "react";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import { Qr } from "../../ui/Qr";
import type { SessionInfo } from "../types";
import { Action, Chip, Empty } from "../ui";

export function Join({ info, error }: { info?: SessionInfo; error?: string }) {
  const [copied, setCopied] = useState(false);
  if (!info) return <Empty icon={error ? "cloud_off" : "hourglass_top"}>{error ?? "Lecture de l'adresse de la salle…"}</Empty>;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info.joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* presse-papiers refusé (HTTP) : l'adresse reste sélectionnable à la main */
    }
  };

  return (
    <div className="flex flex-col sm:flex-row gap-8 items-start">
      <Qr value={info.joinUrl} size={176} className="w-44 shrink-0" />
      <div className="min-w-0 flex-1 flex flex-col gap-4">
        <div>
          <div className="text-[11px] font-label-badge font-bold uppercase tracking-wider text-on-surface-variant">Adresse des apprenants</div>
          <div className="flex items-center gap-2 mt-1.5">
            <span className="font-metric-mono-sm text-[15px] text-on-surface break-all select-all">{info.joinUrl}</span>
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
