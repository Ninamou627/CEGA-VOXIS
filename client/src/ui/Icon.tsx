/**
 * Icône Material Symbols (police variable auto-hébergée, style Outlined).
 * `fill` active l'axe FILL de la police — l'équivalent de `'FILL' 1` dans la maquette.
 */
import type { CSSProperties } from "react";

interface Props {
  name: string;
  fill?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Icon({ name, fill, className = "", style }: Props) {
  const s: CSSProperties = fill ? { ...style, fontVariationSettings: "'FILL' 1" } : style ?? {};
  return (
    <span aria-hidden="true" className={`material-symbols-outlined ${className}`} style={s}>
      {name}
    </span>
  );
}
