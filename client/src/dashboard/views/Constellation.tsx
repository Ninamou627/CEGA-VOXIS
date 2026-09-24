/**
 * La chaîne de la salle en constellation : microphone → audio → reconnaissance →
 * traduction (l'orbe central) → synthèse vocale. Les anneaux tournent ; un étage s'élève
 * et lance une onde quand un événement réel s'y produit ; les paquets circulent sur les
 * liaisons quand la parole passe vraiment. Un clic sur un étage ouvre son inspecteur.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { Icon } from "../../ui/Icon";
import { useReducedMotion } from "../motion";
import type { NodeView } from "../nodes";
import { onPulse } from "../pulse";
import type { StageId } from "../signals";
import { Dot, TONE_PILL, TONE_TEXT, type Tone } from "../ui";
import { Synapse, type LinkState } from "./synapse";

export interface ConstellationProps {
  nodes: NodeView[];
  /** Le micro reçoit de la parole : le flux avance du micro jusqu'à la reconnaissance. */
  speaking: boolean;
  /** Niveau du micro (dBFS), pour les barres de l'orbe du microphone. */
  micDb: number | null;
  /** Montre le moteur de chaque étage (page Supervision). */
  detailed?: boolean;
  paused?: boolean;
  inspected?: StageId;
  onInspect: (id: StageId) => void;
}

function linkState(a: Tone, b: Tone): LinkState {
  if (a === "crit" || b === "crit") return "crit";
  if (a === "warn" || b === "warn") return "warn";
  if (a === "idle" || b === "idle") return "idle";
  return "ok";
}

/** Centre d'un élément dans le repère de `box`, sans ses transformations : un étage qui s'élève ne tord pas ses liaisons. */
function centerIn(el: HTMLElement, box: HTMLElement): { x: number; y: number } {
  let x = el.offsetWidth / 2;
  let y = el.offsetHeight / 2;
  let cur: HTMLElement | null = el;
  while (cur && cur !== box) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

/** Pastilles qui tournent avec l'anneau ; leur texte reste droit (voir .cz-orbit-* dans theme.css). */
function Orbit({ items, dir, angles }: { items: { text: string; title: string }[]; dir: "cw" | "ccw"; angles?: number[] }) {
  const ref = useRef<HTMLSpanElement>(null);
  // Anneau et pastilles sur la même horloge : une pastille arrivée en route garde son texte droit.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.closest(".cz-paused")) return;
    for (const a of el.getAnimations({ subtree: true })) a.startTime = 0;
  }, [items.length]);
  return (
    <span ref={ref} className={`absolute inset-0 pointer-events-none ${dir === "cw" ? "cz-orbit-cw" : "cz-orbit-ccw"}`}>
      {items.map((it, k) => {
        const a = ((angles?.[k] ?? -90 + (k * 360) / items.length) * Math.PI) / 180;
        return (
          <span key={k} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${50 + 50 * Math.cos(a)}%`, top: `${50 + 50 * Math.sin(a)}%` }}>
            <span title={it.title} className="cz-token block px-1.5 py-0.5 rounded font-metric-mono-sm text-[8px] leading-none text-on-surface whitespace-nowrap">
              {it.text}
            </span>
          </span>
        );
      })}
    </span>
  );
}

export function Constellation({ nodes, speaking, micDb, detailed, paused = false, inspected, onInspect }: ConstellationProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const engine = useRef<Synapse | null>(null);
  const nodeEls = useRef(new Map<StageId, HTMLButtonElement>());
  const ringEls = useRef(new Map<StageId, HTMLElement>());
  const rippleEls = useRef(new Map<StageId, HTMLElement>());
  const micBars = useRef<HTMLElement[]>([]);
  const voiceBars = useRef<HTMLElement[]>([]);
  const voiceUntil = useRef(0);
  const timers = useRef(new Map<StageId, number>());
  const reduced = useReducedMotion();

  // Ce que lisent les rappels (observateurs, battements, barres) sans être recréés.
  const live = useRef({ nodes, speaking, micDb, still: paused || reduced });
  live.current = { nodes, speaking, micDb, still: paused || reduced };

  /** Replace les liaisons sur les orbes et leur donne l'état des deux étages qu'elles relient. */
  function relayout() {
    const syn = engine.current;
    const el = box.current;
    if (!syn || !el) return;
    const ns = live.current.nodes;
    const centers = ns.map((n) => {
      const ring = ringEls.current.get(n.stage.id);
      return ring ? centerIn(ring, el) : { x: 0, y: 0 };
    });
    syn.layout(
      centers,
      ns.slice(0, -1).map((n, i) => linkState(n.stage.tone, ns[i + 1].stage.tone)),
    );
  }

  // Le ciel : créé une fois ; il suit la taille, la visibilité de la page et le thème.
  useEffect(() => {
    const el = box.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const syn = new Synapse(cv);
    engine.current = syn;
    syn.readColors(el);
    let inView = true;
    const visible = () => syn.setVisible(inView && document.visibilityState === "visible");
    const ro = new ResizeObserver(() => {
      syn.resize(el.clientWidth, el.clientHeight);
      relayout();
    });
    ro.observe(el);
    const io = new IntersectionObserver(([e]) => {
      inView = e.isIntersecting;
      visible();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", visible);
    // Bascule clair / sombre : les couleurs du ciel sont relues une fois la classe posée.
    const mo = new MutationObserver(() => requestAnimationFrame(() => syn.readColors(el)));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const pending = timers.current;
    return () => {
      ro.disconnect();
      io.disconnect();
      mo.disconnect();
      document.removeEventListener("visibilitychange", visible);
      for (const t of pending.values()) clearTimeout(t);
      syn.destroy();
      engine.current = null;
    };
  }, []);

  useLayoutEffect(relayout);

  useEffect(() => {
    engine.current?.setStreams(nodes.slice(0, -1).map((_, i) => speaking && i < 2));
  }, [speaking, nodes.length]);

  useEffect(() => {
    engine.current?.setPaused(paused);
  }, [paused]);

  useEffect(() => {
    engine.current?.setStill(reduced);
  }, [reduced]);

  // Les battements de la salle : l'étage s'élève, lance son onde, envoie ses paquets au suivant.
  useEffect(
    () =>
      onPulse((stage, kind) => {
        const el = nodeEls.current.get(stage);
        if (el) {
          el.dataset.active = "";
          clearTimeout(timers.current.get(stage));
          timers.current.set(
            stage,
            window.setTimeout(() => delete el.dataset.active, kind === "partial" ? 900 : 1400),
          );
        }
        if (kind === "partial" || live.current.still) return;
        const ripple = rippleEls.current.get(stage);
        if (ripple) {
          ripple.classList.remove("cz-go");
          void ripple.offsetWidth; // relance l'animation
          ripple.classList.add("cz-go");
        }
        const i = live.current.nodes.findIndex((n) => n.stage.id === stage);
        if (kind === "commit" || kind === "segment") engine.current?.burst(i, 4);
        if (kind === "voice") voiceUntil.current = performance.now() + 2600;
      }),
    [],
  );

  // Les barres des orbes : le vrai niveau du micro, la voix pendant qu'elle est produite.
  useEffect(() => {
    const draw = () => {
      const { speaking: on, micDb: db, still } = live.current;
      const level = db == null ? 0 : Math.max(0, Math.min(1, (db + 60) / 50));
      micBars.current.forEach((b, k) => {
        const h = on && !still ? 3 + level * 13 * (0.45 + Math.random() * 0.55) : 3 + level * 5 * (0.6 + 0.2 * (k % 3));
        b.style.height = `${h.toFixed(1)}px`;
      });
      const voice = !still && performance.now() < voiceUntil.current;
      voiceBars.current.forEach((b, k) => {
        b.style.height = `${voice ? 4 + Math.random() * 12 : 3 + (k % 2)}px`;
      });
    };
    draw();
    const id = window.setInterval(draw, 140);
    return () => clearInterval(id);
  }, []);

  return (
    <div ref={box} className={`relative ${paused ? "cz-paused" : ""}`}>
      <canvas ref={canvas} aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none" />
      <ol className="relative grid grid-cols-2 md:grid-cols-5 gap-x-2 gap-y-12 items-center justify-items-center py-8 md:py-12">
        {nodes.map((n, i) => {
          const s = n.stage;
          const ring = n.core ? "w-32 h-32 xl:w-44 xl:h-44" : "w-28 h-28 xl:w-36 xl:h-36";
          const orb = n.core ? "w-24 h-24 xl:w-28 xl:h-28" : "w-20 h-20 xl:w-24 xl:h-24";
          const bars = n.bars === "mic" ? micBars : voiceBars;
          return (
            <li key={s.id} className={`w-full flex justify-center ${i === nodes.length - 1 ? "col-span-2 md:col-span-1" : ""}`}>
              <button
                ref={(el) => {
                  if (el) nodeEls.current.set(s.id, el);
                  else nodeEls.current.delete(s.id);
                }}
                type="button"
                data-tone={s.tone}
                data-live={speaking && (s.id === "mic" || s.id === "audio") ? "" : undefined}
                aria-expanded={inspected === s.id}
                aria-controls={inspected === s.id ? "inspecteur" : undefined}
                aria-label={`${s.label} : ${s.status}${s.metric ? ` (${s.metric})` : ""}. Ouvrir l'inspecteur de l'étage.`}
                onClick={() => onInspect(s.id)}
                className="cz-node group relative flex flex-col items-center w-full max-w-[230px] pt-2 focus:outline-none"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-6 z-30 flex items-center gap-1 px-2 py-0.5 rounded-md border border-primary/40 bg-surface-container-high/90 text-[10px] font-metric-mono-sm text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Icon name="search" className="text-[12px]" />
                  Cliquer pour inspecter
                </span>

                <span
                  ref={(el) => {
                    if (el) ringEls.current.set(s.id, el);
                    else ringEls.current.delete(s.id);
                  }}
                  aria-hidden="true"
                  className={`relative ${ring} flex items-center justify-center`}
                >
                  <span
                    ref={(el) => {
                      if (el) rippleEls.current.set(s.id, el);
                      else rippleEls.current.delete(s.id);
                    }}
                    className="cz-ripple absolute inset-0 rounded-full"
                  />
                  <span className={`cz-ring cz-ring-a absolute inset-0 rounded-full border border-dashed ${n.core ? "cz-spin-fast" : "cz-spin"}`} />
                  <span className={`cz-ring cz-ring-b absolute inset-2 rounded-full border ${n.core ? "border-dashed" : ""} cz-spin-back`} />
                  {n.core && <span className="cz-ring cz-ring-c absolute inset-5 rounded-full border cz-spin" />}
                  {n.orbit && n.orbit.length > 0 && <Orbit items={n.orbit} dir={n.core ? "ccw" : "cw"} />}
                  {n.satellites && n.satellites.length > 0 && <Orbit items={n.satellites} dir="cw" angles={[-40, 140, 40]} />}

                  <span className={`${n.core ? "cz-orb cz-orb-core" : "cz-orb"} relative ${orb} rounded-full flex flex-col items-center justify-center gap-1 px-1.5`}>
                    <span className="cz-icon w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-transform group-hover:scale-110">
                      <Icon name={s.icon} fill={s.tone === "ok"} className="text-[17px]" />
                    </span>
                    {n.bars && (
                      <span className="flex items-end gap-[2px] h-4">
                        {Array.from({ length: n.bars === "mic" ? 5 : 4 }, (_, k) => (
                          <span
                            key={k}
                            ref={(el) => {
                              if (el) bars.current[k] = el;
                            }}
                            className="cz-bar w-0.5 rounded-full"
                            style={{ height: 3 }}
                          />
                        ))}
                      </span>
                    )}
                    {n.lines?.map((l, k) => (
                      <span
                        key={k}
                        className={`max-w-full truncate font-metric-mono-sm leading-none ${
                          k === 0 ? (n.core ? "text-[10px] font-bold tracking-wide text-on-surface" : "text-[9px] text-on-surface-variant") : "text-[9px] text-secondary"
                        }`}
                      >
                        {l}
                      </span>
                    ))}
                  </span>

                  {n.badge && (
                    <span
                      title={n.badge.title}
                      className={`cz-badge absolute -top-1 right-0 px-1.5 py-0.5 rounded-full font-metric-mono-sm text-[9px] leading-none shadow ${n.badge.tone && n.badge.tone !== "ok" ? TONE_TEXT[n.badge.tone] : "text-on-surface"}`}
                    >
                      {n.badge.text}
                    </span>
                  )}
                  <span className="cz-inspected absolute -bottom-2 inset-x-0 mx-auto w-max px-1.5 py-px rounded-full bg-primary text-on-primary text-[8px] font-bold uppercase font-metric-mono-sm shadow-md">
                    Inspecté
                  </span>
                </span>

                <span className="mt-4 flex flex-col items-center gap-1 max-w-full px-1 text-center">
                  <span className="flex items-center gap-1.5">
                    <Dot tone={s.tone} live={s.tone === "ok"} />
                    <span className="text-[11px] xl:text-xs font-bold tracking-wider uppercase font-metric-mono-sm text-on-surface leading-tight">
                      {String(i + 1).padStart(2, "0")}. {s.label}
                    </span>
                  </span>
                  {detailed && s.engine && (
                    <span className="text-[10px] font-metric-mono-sm text-on-surface-variant max-w-full truncate" title={s.engine}>
                      {s.engine}
                    </span>
                  )}
                  <span key={s.status} className={`pop cz-pill px-2.5 py-0.5 rounded-full border text-[10px] font-metric-mono-sm ${TONE_PILL[s.tone]}`}>
                    {s.status}
                  </span>
                  {s.metric && <span className="font-metric-mono-sm text-[10px] text-on-surface-variant">{s.metric}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
