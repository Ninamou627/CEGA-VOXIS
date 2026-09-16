/**
 * Screen Wake Lock : garde l'écran allumé pendant l'écoute. iOS suspend l'audio web
 * à l'écran verrouillé ; ceci est la parade principale. Safari iOS 16.4+ en onglet.
 */
let sentinel: WakeLockSentinel | undefined;

export async function requestWakeLock(): Promise<boolean> {
  if (!("wakeLock" in navigator)) return false;
  try {
    sentinel = await navigator.wakeLock.request("screen");
    sentinel.addEventListener("release", () => {
      sentinel = undefined;
    });
    return true;
  } catch {
    return false;
  }
}

export function releaseWakeLock(): void {
  void sentinel?.release();
  sentinel = undefined;
}

/** Le verrou est libéré par le système quand l'onglet passe en arrière-plan : on le redemande au retour. */
export function keepWakeLockAlive(onChange?: (held: boolean) => void): () => void {
  const handler = async () => {
    if (document.visibilityState === "visible" && !sentinel) onChange?.(await requestWakeLock());
  };
  document.addEventListener("visibilitychange", handler);
  return () => document.removeEventListener("visibilitychange", handler);
}
