/**
 * Rejoindre la salle : le QR code à projeter, l'adresse, les adresses de repli,
 * les langues diffusées et l'état HTTPS (sans lui, pas de questions au micro).
 */
import QRCode from "qrcode";
import { useEffect, useRef } from "react";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import type { SessionInfo } from "../types";
import { Card } from "./Card";

export function Join({ info, error }: { info?: SessionInfo; error?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (info && canvas.current) void QRCode.toCanvas(canvas.current, info.joinUrl, { width: 208, margin: 1, color: { dark: "#0a0e16", light: "#ffffff" } });
  }, [info?.joinUrl]);

  return (
    <Card
      icon="qr_code_2"
      title="Rejoindre la salle"
      tone="primary"
      right={
        info && (
          <span className={`flex items-center gap-1 text-[10px] font-label-badge font-bold px-2 py-0.5 rounded-full border ${info.tls ? "text-secondary bg-secondary/10 border-secondary/20" : "text-error bg-error/10 border-error/30"}`}>
            <Icon name={info.tls ? "lock" : "lock_open"} className="text-[12px]" />
            {info.tls ? "HTTPS" : "HTTP"}
          </span>
        )
      }
    >
      {error && <div className="bg-error-container text-on-error-container border border-error/30 rounded-xl px-3 py-2 text-xs">{error}</div>}
      <div className="flex flex-col items-center gap-3">
        <div className="bg-white rounded-xl p-2 shadow-md">
          <canvas ref={canvas} className={info ? "" : "opacity-0"} width={208} height={208} />
        </div>
        <div className="font-metric-mono-sm text-[11px] text-on-surface text-center break-all select-all">{info?.joinUrl ?? "…"}</div>
      </div>
      {info && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-label-badge text-on-surface-variant uppercase">Langues</span>
          <span className="px-1.5 py-0.5 rounded bg-surface-container-highest font-metric-mono-sm text-[11px] text-on-surface-variant" title="Langue du formateur">
            {LANGS[info.srcLang].flag} {LANGS[info.srcLang].short}
          </span>
          <Icon name="arrow_forward" className="text-[14px] text-primary" />
          {info.langs.map((l) => (
            <span key={l} className="px-1.5 py-0.5 rounded bg-primary-container font-metric-mono-sm text-[11px] text-on-primary-container">
              {LANGS[l].flag} {LANGS[l].short}
            </span>
          ))}
        </div>
      )}
      {info && !info.tls && (
        <div className="bg-error-container text-on-error-container border border-error/30 rounded-xl px-3 py-2 text-xs">
          HTTP : les questions (micro des téléphones) ne fonctionneront pas. Voir docs/CERTIFICAT.md.
        </div>
      )}
      {info?.joinUrls && info.joinUrls.length > 1 && (
        <details className="text-[11px] text-on-surface-variant">
          <summary className="cursor-pointer">Autres adresses ({info.joinUrls.length - 1}) — si le téléphone ne joint pas celle du QR</summary>
          <div className="flex flex-col gap-1 pt-2">
            {info.joinUrls.slice(1).map((j) => (
              <div key={j.url} className={`font-metric-mono-sm break-all ${j.virtual ? "opacity-60" : ""}`}>
                {j.url} <span className="text-outline">({j.iface}{j.virtual ? ", virtuelle" : ""})</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}
