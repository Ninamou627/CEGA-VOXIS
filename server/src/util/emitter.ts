/** Émetteur d'événements typé, minimal. Les handlers qui lèvent ne cassent pas l'émission. */
export class TypedEmitter<E extends Record<string, unknown>> {
  private handlers = new Map<keyof E, Set<(payload: never) => void>>();

  on<K extends keyof E>(event: K, fn: (payload: E[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(fn as (payload: never) => void);
    return () => set!.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        (fn as (p: E[K]) => void)(payload);
      } catch (err) {
        console.error(`[emitter] handler ${String(event)} a levé :`, err);
      }
    }
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
