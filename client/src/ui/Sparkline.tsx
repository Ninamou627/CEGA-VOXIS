/**
 * Courbe minuscule d'une série récente (SVG inline, sans bibliothèque). Les points
 * manquants (null) coupent le trait ; `warn` trace la ligne de seuil. Le tracé est
 * étiré à la largeur du conteneur, l'épaisseur du trait ne l'est pas.
 */
export interface SparklineProps {
  values: (number | null)[];
  /** Plafond de l'échelle ; sinon le max de la série (au moins `warn`). */
  max?: number;
  warn?: number;
  tone?: "secondary" | "tertiary" | "error" | "primary";
  className?: string;
}

const STROKE = { secondary: "stroke-secondary", tertiary: "stroke-tertiary", error: "stroke-error", primary: "stroke-primary" };

export function Sparkline({ values, max, warn, tone = "secondary", className = "" }: SparklineProps) {
  const W = 100;
  const H = 28;
  const known = values.filter((v): v is number => v != null);
  const top = Math.max(max ?? 0, warn ?? 0, ...known, 1);
  const x = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * W : W);
  const y = (v: number) => H - 2 - (Math.min(v, top) / top) * (H - 4);
  // Un sous-trait par tronçon continu.
  const runs: string[] = [];
  let run: string[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (run.length > 1) runs.push(run.join(" "));
      run = [];
    } else run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (run.length > 1) runs.push(run.join(" "));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`w-full ${className}`} aria-hidden="true">
      {warn != null && <line x1="0" x2={W} y1={y(warn)} y2={y(warn)} className="stroke-outline-variant" strokeWidth="0.6" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />}
      {runs.map((pts, i) => (
        <polyline key={i} points={pts} className={STROKE[tone]} fill="none" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}
