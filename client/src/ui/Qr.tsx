/** QR code sur un fond blanc (lisible par tous les téléphones, quel que soit le thème). */
import QRCode from "qrcode";
import { useEffect, useRef } from "react";

export function Qr({ value, size, className = "" }: { value: string; size: number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    void QRCode.toCanvas(el, value, { width: size, margin: 1, color: { dark: "#0a0e16", light: "#ffffff" } }).then(() => {
      // La bibliothèque fige la taille CSS au pixel près ; ici c'est le conteneur qui décide.
      el.style.width = "100%";
      el.style.height = "auto";
    });
  }, [value, size]);
  return (
    <div className={`bg-white rounded-xl p-[4%] shadow-lg inline-flex ${className}`}>
      <canvas ref={canvas} width={size} height={size} className="block max-w-full h-auto" aria-label={`QR code : ${value}`} role="img" />
    </div>
  );
}
