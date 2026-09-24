/**
 * Marque CEGA Voxis. Vectoriel et embarqué : rien à charger depuis Internet en salle.
 * À remplacer par le logo définitif quand il sera fourni (même hauteur : 32 px).
 */
import { APP_NAME } from "./brand";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label={APP_NAME}>
      <rect width="32" height="32" rx="8" fill="#2563eb" />
      <rect x="6.5" y="12" width="3" height="8" rx="1.5" fill="#dbe1ff" />
      <rect x="12" y="8" width="3" height="16" rx="1.5" fill="#ffffff" />
      <rect x="17.5" y="5" width="3" height="22" rx="1.5" fill="#4edea3" />
      <rect x="23" y="11" width="3" height="10" rx="1.5" fill="#dbe1ff" />
    </svg>
  );
}
