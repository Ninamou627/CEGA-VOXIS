/**
 * Les sous-titres projetés : le dernier segment traduit en grand, les deux
 * précédents au-dessus, plus petits et plus pâles ; en option la phrase source et
 * l'hypothèse en cours. Tailles en fraction de la largeur d'écran, multipliées par
 * l'échelle choisie (--cap), pour lire depuis le fond de la salle.
 */
import type { Lang } from "../../../../shared/protocol";
import type { Line } from "../types";

export interface CaptionsProps {
  lines: Line[];
  lang: Lang;
  showSource: boolean;
  partial: string;
}

export function Captions({ lines, lang, showSource, partial }: CaptionsProps) {
  const translated = lines.filter((l) => l.tgt[lang]);
  const latest = translated[translated.length - 1];
  const older = translated.slice(-3, -1);
  return (
    <div className="absolute inset-x-0 bottom-[9vh] px-[6vw] flex flex-col items-center gap-[1.6vh] text-center">
      {older.map((l, i) => (
        <p
          key={l.seq}
          className="max-w-[86vw] text-on-surface-variant leading-snug text-balance transition-opacity"
          style={{ fontSize: "calc(var(--cap) * clamp(20px, 2.6vw, 46px))", opacity: i === older.length - 1 ? 0.7 : 0.45 }}
        >
          {l.tgt[lang]}
        </p>
      ))}
      {latest && (
        <p key={latest.seq} className="rise-in max-w-[88vw] text-on-surface font-medium leading-snug text-balance" style={{ fontSize: "calc(var(--cap) * clamp(28px, 4.2vw, 76px))" }}>
          {latest.tgt[lang]}
        </p>
      )}
      {showSource && latest?.src && (
        <p key={`src-${latest.seq}`} className="rise-in max-w-[86vw] text-primary/85 italic leading-snug text-balance" style={{ fontSize: "calc(var(--cap) * clamp(16px, 2vw, 36px))" }}>
          {latest.src}
        </p>
      )}
      {showSource && partial && (
        <p className="max-w-[86vw] text-on-surface-variant/70 italic leading-snug" style={{ fontSize: "calc(var(--cap) * clamp(14px, 1.6vw, 30px))" }}>
          {partial}
        </p>
      )}
    </div>
  );
}
