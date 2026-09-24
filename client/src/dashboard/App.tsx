/**
 * Administration de la salle : vue d'ensemble, supervision en temps réel, qualité, voix,
 * configuration globale et séance. Une page par sujet derrière un menu latéral, et pas de
 * cartes (voir ui.tsx).
 *
 * Sources : le WebSocket (texte, stats toutes les 2 s, questions, signalements, réglages
 * poussés), /api/health relevé toutes les 5 s, /api/session pour le QR, et l'API
 * d'administration (/api/admin/*, jeton de session) pour les compteurs de long terme,
 * les réglages et les voix.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OverviewResponse, RecentReport, SaveResponse, SettingsResponse } from "../../../shared/admin";
import type { ClientSettings, FloorState, Lang, ServerEvent, StatsPayload } from "../../../shared/protocol";
import type { Settings } from "../../../shared/settings";
import { SalleSocket, type ConnState } from "../lib/ws";
import { REPORT_LABEL } from "../ui/reports";
import { AdminApi } from "./api";
import { diffKeys, rebase } from "./draft";
import { useMotionPause } from "./motion";
import { lastWord, nodeViews } from "./nodes";
import { Configuration } from "./pages/Configuration";
import { Overview } from "./pages/Overview";
import { Quality } from "./pages/Quality";
import { Session } from "./pages/Session";
import { Supervision } from "./pages/Supervision";
import { Voices } from "./pages/Voices";
import { pulse } from "./pulse";
import { PAGES, Shell, type Route } from "./Shell";
import { computeAlerts, stageStates, type Signals, type StageId } from "./signals";
import type { EventKind, Health, JournalEntry, Line, QuestionEntry, Sample, SessionInfo } from "./types";
import { Action, Banner } from "./ui";
import { Inspector } from "./views/Inspector";

type Hello = Extract<ServerEvent, { t: "hello" }>;

/** Dix minutes de stats à 2 s d'intervalle. */
const HISTORY = 300;
const HEALTH_EVERY_MS = 5000;
const OVERVIEW_EVERY_MS = 10_000;

const DEGRADED: Record<string, string> = {
  "text-only": "texte seul — voix indisponible",
  "backup-mt": "traduction de secours",
  "backup-tts": "voix de secours",
  "stt-lost": "reconnaissance perdue",
  s2s: "chemin de secours S2S",
};

/** « #/configuration/parole » → la page et, s'il y en a une, la section où descendre. */
function readHash(): { route: Route; anchor?: string } {
  const [r = "", anchor] = location.hash.replace(/^#\/?/, "").split("/");
  return { route: (PAGES.some((p) => p.route === r) ? r : "") as Route, anchor: anchor || undefined };
}

/** Pages au design « constellation ». */
const COSMOS: Route[] = ["", "supervision"];

export function App() {
  const [token] = useState(() => new URLSearchParams(location.search).get("token") ?? "");
  const api = useMemo(() => new AdminApi(token), [token]);
  const [{ route, anchor }, setHash] = useState(readHash);

  const [conn, setConn] = useState<ConnState>("connecting");
  const [hello, setHello] = useState<Hello>();
  const [room, setRoom] = useState<ClientSettings>();
  const [info, setInfo] = useState<SessionInfo>();
  const [infoError, setInfoError] = useState<string>();
  const [health, setHealth] = useState<Health>();
  const [stats, setStats] = useState<StatsPayload>();
  const [history, setHistory] = useState<Sample[]>([]);
  const [floor, setFloor] = useState<FloorState>({ state: "lecturer" });
  const [partial, setPartial] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [questions, setQuestions] = useState<QuestionEntry[]>([]);
  const [reports, setReports] = useState<RecentReport[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [overview, setOverview] = useState<OverviewResponse>();
  const [conf, setConf] = useState<SettingsResponse>();
  const [draft, setDraft] = useState<{ base: Settings; value: Settings }>();
  const [adminError, setAdminError] = useState<string>();
  const [wsError, setWsError] = useState<{ code: string; msg: string }>();
  const [adding, setAdding] = useState(false);
  const [inspect, setInspect] = useState<StageId>();
  const [motionPaused, toggleMotion] = useMotionPause();
  const [now, setNow] = useState(Date.now());

  const clockOffset = useRef(0);
  const seq = useRef(0);
  const lastListeners = useRef<number>(undefined);
  const lastLecturer = useRef<boolean>(undefined);
  const overviewTimer = useRef<number>(undefined);
  /** Dernières stats reçues, pour les rappels du WebSocket (créés une seule fois). */
  const statsRef = useRef<StatsPayload>(undefined);
  const scrolledFor = useRef<string>(undefined);

  function log(kind: EventKind, text: string) {
    setJournal((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === kind && last.text === text) return [...prev.slice(0, -1), { ...last, at: Date.now(), count: (last.count ?? 1) + 1 }];
      return [...prev, { n: ++seq.current, at: Date.now(), kind, text }].slice(-300);
    });
  }

  // ---- routage par ancre : #/qualite, #/voix, #/configuration/parole… -----------------
  useEffect(() => {
    const on = () => {
      const next = readHash();
      setHash(next);
      if (!next.anchor) window.scrollTo({ top: 0 });
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  // Une section demandée (#/configuration/parole) : on y descend dès qu'elle est affichée.
  useEffect(() => {
    if (!anchor || scrolledFor.current === location.hash) return;
    const el = document.getElementById(anchor);
    if (!el) return;
    scrolledFor.current = location.hash;
    el.scrollIntoView({ block: "start" });
  });
  // L'inspecteur appartient à la page qui l'a ouvert.
  useEffect(() => setInspect(undefined), [route]);
  useEffect(() => {
    const page = PAGES.find((p) => p.route === route) ?? PAGES[0];
    document.title = `${page.title} · VOXIS`;
  }, [route]);

  // ---- API d'administration -----------------------------------------------------------
  const adminFailed = (e: unknown) => setAdminError((e as Error).message);

  /** Nouveaux réglages du serveur : le brouillon en cours est reposé dessus, sans rien perdre. */
  function applyServerSettings(next: Settings) {
    setConf((c) => (c ? { ...c, settings: next } : c));
    setDraft((d) => {
      if (!d) return d;
      const value = rebase(d.base, d.value, next);
      return diffKeys(value, next).length ? { base: next, value } : undefined;
    });
  }

  async function loadConf() {
    try {
      const r = await api.settings();
      setConf(r);
      setDraft((d) => {
        if (!d) return d;
        const value = rebase(d.base, d.value, r.settings);
        return diffKeys(value, r.settings).length ? { base: r.settings, value } : undefined;
      });
      setAdminError(undefined);
    } catch (e) {
      adminFailed(e);
    }
  }

  async function loadOverview() {
    try {
      setOverview(await api.overview());
      setAdminError(undefined);
    } catch (e) {
      adminFailed(e);
    }
  }

  /** Après un signalement : les compteurs sont relus une fois l'averse passée. */
  function refreshOverviewSoon() {
    clearTimeout(overviewTimer.current);
    overviewTimer.current = window.setTimeout(() => void loadOverview(), 1500);
  }

  useEffect(() => {
    void loadConf();
    void loadOverview();
    const id = setInterval(() => void loadOverview(), OVERVIEW_EVERY_MS);
    return () => {
      clearInterval(id);
      clearTimeout(overviewTimer.current);
    };
  }, [api]);

  // ---- /api/session : le QR et les adresses ; on réessaie tant que le serveur ne répond pas.
  useEffect(() => {
    let stop = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const r = await fetch("/api/session");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const i = (await r.json()) as SessionInfo;
        if (stop) return;
        setInfo(i);
        setInfoError(undefined);
      } catch (e) {
        if (stop) return;
        setInfoError(`Serveur de salle injoignable (${(e as Error).message}). Est-il lancé, et sur le bon schéma HTTP/HTTPS ?`);
        timer = window.setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  // ---- /api/health : santé du processus et présence du formateur.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch("/api/health");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const h = (await r.json()) as Health;
        if (stop) return;
        setHealth(h);
        if (lastLecturer.current !== undefined && lastLecturer.current !== h.lecturer) log("salle", h.lecturer ? "formateur connecté, micro ouvert" : "formateur déconnecté");
        lastLecturer.current = h.lecturer;
      } catch {
        if (!stop) setHealth(undefined);
      }
    };
    void poll();
    const id = setInterval(poll, HEALTH_EVERY_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  // ---- WebSocket de salle -------------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    const s = new SalleSocket(
      { t: "join", role: "dashboard", token },
      {
        onState: (st) => {
          setConn(st);
          if (st === "reconnecting") log("liaison", "liaison perdue, reconnexion…");
        },
        onAudio: () => {},
        onEvent: handleEvent,
      },
    );
    s.connect();
    return () => {
      clearInterval(id);
      s.close();
    };
  }, [token]);

  function handleEvent(e: ServerEvent) {
    switch (e.t) {
      case "hello":
        clockOffset.current = e.tServer - Date.now();
        setHello(e);
        setFloor(e.floor);
        setRoom(e.settings);
        setWsError(undefined);
        log("liaison", `connecté à la salle ${e.sessionId}`);
        break;
      case "settings":
        setRoom(e.settings);
        void loadConf();
        log("reglages", "réglages enregistrés depuis l'administration");
        break;
      case "src.partial":
        setPartial(e.text);
        pulse("stt", "partial");
        break;
      case "src.commit":
        setPartial("");
        upsert(e.seq, { src: e.text, tOrigin: e.tOrigin, reason: e.reason });
        pulse("stt", "commit");
        break;
      case "tr.segment": {
        upsert(e.seq, { tgt: e.text });
        pulse("mt", "segment");
        // La voix est produite un temps de synthèse plus tard : le temps médian mesuré par le serveur.
        const tts = statsRef.current?.stages.ttsP50 ?? 500;
        window.setTimeout(() => pulse("tts", "voice"), Math.min(3000, Math.max(150, tts)));
        break;
      }
      case "stats":
        statsRef.current = e.stats;
        setStats(e.stats);
        setHistory((prev) =>
          [
            ...prev,
            {
              t: Date.now(),
              e2eP50: e.stats.e2eP50,
              e2eP95: e.stats.e2eP95,
              queueMaxMs: e.stats.queueMaxMs,
              listeners: e.stats.listeners,
              micDb: e.stats.micDb,
              commitP50: e.stats.stages.commitP50,
              mtP50: e.stats.stages.mtP50,
              ttsP50: e.stats.stages.ttsP50,
            },
          ].slice(-HISTORY),
        );
        if (lastListeners.current !== undefined && lastListeners.current !== e.stats.listeners) {
          const d = e.stats.listeners - lastListeners.current;
          log("salle", `${e.stats.listeners} apprenant${e.stats.listeners > 1 ? "s" : ""} à l'écoute (${d > 0 ? "+" : ""}${d})`);
        }
        lastListeners.current = e.stats.listeners;
        break;
      case "floor":
        setFloor(e.floor);
        log("parole", e.floor.state === "question" ? `un apprenant prend la parole (${e.floor.who.slice(-4).toUpperCase()})` : "parole rendue au formateur");
        break;
      case "question":
        setQuestions((prev) => [...prev, { n: prev.length + 1, at: Date.now(), who: e.who, srcLang: e.srcLang, srcText: e.srcText, lang: e.lang, text: e.text, delivered: e.delivered, mode: e.mode }].slice(-50));
        log("question", e.srcText ? `${e.mode === "text" ? "écrite" : "parlée"} : « ${e.srcText} » → « ${e.text} »${e.delivered ? "" : " — formateur absent"}` : "question incomprise (vide)");
        break;
      case "report":
        setReports((prev) => [...prev, { at: e.at, who: e.who, kind: e.kind, lang: e.lang, seq: e.seq, srcText: e.srcText, text: e.text, e2eMs: e.e2eMs }].slice(-100));
        log("signalement", `${REPORT_LABEL[e.kind].label}${e.srcText ? ` — « ${e.srcText} »` : ""}`);
        refreshOverviewSoon();
        break;
      case "degraded":
        log("degrade", e.mode === "none" ? `retour au nominal — ${e.reason}` : `${DEGRADED[e.mode] ?? e.mode} — ${e.reason}`);
        break;
      case "error":
        setWsError({ code: e.code, msg: e.msg });
        log("erreur", e.msg);
        break;
    }
  }

  function upsert(n: number, patch: Partial<Line>) {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.seq === n);
      const next = i >= 0 ? prev.map((l, j) => (j === i ? { ...l, ...patch } : l)) : [...prev, { seq: n, ...patch }];
      return next.slice(-60);
    });
  }

  // ---- brouillon de configuration -------------------------------------------------------
  const dirty = useMemo(() => new Set(draft && conf ? diffKeys(draft.value, conf.settings) : []), [draft, conf]);

  function changeDraft(value: Settings) {
    if (!conf) return;
    setDraft((d) => ({ base: d?.base ?? conf.settings, value }));
  }

  async function saveDraft(): Promise<SaveResponse> {
    if (!conf) throw new Error("réglages pas encore chargés");
    const next = draft ? rebase(draft.base, draft.value, conf.settings) : conf.settings;
    const res = await api.save(next);
    setConf((c) => (c ? { ...c, settings: res.settings } : c));
    setDraft(undefined);
    return res;
  }

  async function resetSettings(): Promise<SaveResponse> {
    const res = await api.reset();
    setConf((c) => (c ? { ...c, settings: res.settings } : c));
    setDraft(undefined);
    return res;
  }

  // Quitter la page avec des réglages non enregistrés : le navigateur demande confirmation.
  useEffect(() => {
    if (!dirty.size) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty.size]);

  // ---- ce qu'on en déduit -------------------------------------------------------------
  const sig: Signals = { conn, now, stats, health, info, room, overview, reports };
  const stages = stageStates(sig);
  const alerts = computeAlerts(sig);
  const threshold = room?.speechThresholdDb ?? -35;
  const speaking = Boolean(health?.lecturer) && !stats?.pipeline.muted && stats?.micDb != null && stats.micDb > threshold;
  const nodes = nodeViews(sig, stages, conf, lastWord(partial || lines[lines.length - 1]?.src));
  const cosmos = COSMOS.includes(route);
  /** L'inspecteur s'ouvre sur l'étage le plus en difficulté, sinon sur la traduction. */
  const firstInspect = (): StageId => stages.find((x) => x.tone === "crit")?.id ?? stages.find((x) => x.tone === "warn")?.id ?? "mt";
  const srcLang: Lang = hello?.srcLang ?? info?.srcLang ?? "en";
  const tgtLang: Lang = hello?.langs[0] ?? info?.langs[0] ?? "fr";
  const reportsToday = overview ? Object.values(overview.today.reports).reduce((a, b) => a + (b ?? 0), 0) : reports.length;
  const voiceName = (id: string) => conf?.settings.voices.find((v) => v.id === id)?.name;

  const unauthorized = !token || adminError === "jeton de session invalide" || wsError?.code === "unauthorized";
  const banners = (
    <>
      {unauthorized && (
        <Banner tone="crit" icon="key_off">
          {token ? "Jeton de session refusé." : "Lien incomplet : il manque le jeton de session."} Ouvrez l'administration avec l'adresse complète{" "}
          <span className="font-metric-mono-sm">/dashboard?token=…</span> — le jeton est la valeur de <span className="font-metric-mono-sm">SESSION_TOKEN</span> dans le .env du serveur.
        </Banner>
      )}
      {!unauthorized && adminError && conn === "open" && (
        <Banner tone="warn" icon="cloud_off" action={<Action icon="refresh" title="Réessayer" onClick={() => void (loadConf(), loadOverview())} />}>
          API d'administration indisponible : {adminError}
        </Banner>
      )}
      {wsError && wsError.code !== "unauthorized" && (
        <Banner tone="warn" icon="error" action={<Action icon="close" title="Fermer" onClick={() => setWsError(undefined)} />}>
          {wsError.msg}
        </Banner>
      )}
    </>
  );

  const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const closeInspector = useCallback(() => setInspect(undefined), []);
  const actions = cosmos ? (
    <>
      <Action tone="halo" icon="insights" onClick={() => setInspect(firstInspect())} title="Ouvrir l'inspecteur d'un étage">
        Inspecteur
      </Action>
      <Action tone="solid" icon={motionPaused ? "play_arrow" : "pause"} onClick={toggleMotion} title="N'arrête que l'animation : la traduction continue">
        {motionPaused ? "Reprendre l'animation" : "Pause animation"}
      </Action>
    </>
  ) : route === "voix" ? (
      <Action tone="primary" icon="add" onClick={() => setAdding(true)} disabled={!conf?.options.voicesEnabled} title={conf && !conf.options.voicesEnabled ? "ElevenLabs n'est pas configuré" : undefined}>
        Ajouter une voix
      </Action>
    ) : route === "configuration" ? (
      <>
        <Action icon="translate" onClick={() => scrollTo("traduction")}>
          Traduction
        </Action>
        <Action icon="mic" onClick={() => scrollTo("parole")}>
          Parole
        </Action>
        <Action icon="record_voice_over" onClick={() => scrollTo("voix")}>
          Voix
        </Action>
      </>
    ) : route === "seance" ? (
      <Action icon="cast" href="/screen" external>
        Écran de salle
      </Action>
    ) : undefined;

  return (
    <Shell
      route={route}
      conn={conn}
      session={hello?.sessionId ?? info?.sessionId}
      uptimeS={stats?.uptimeS ?? health?.uptimeS}
      alerts={{ crit: alerts.filter((a) => a.severity === "crit").length, warn: alerts.filter((a) => a.severity === "warn").length }}
      reports={reportsToday}
      configDirty={dirty.size > 0}
      token={token}
      joinUrl={info?.joinUrl}
      actions={actions}
      cosmos={cosmos}
    >
      {banners}
      {route === "" && <Overview sig={sig} nodes={nodes} speaking={speaking} alerts={alerts} paused={motionPaused} inspected={inspect} onInspect={setInspect} />}
      {route === "supervision" && (
        <Supervision
          sig={sig}
          nodes={nodes}
          speaking={speaking}
          paused={motionPaused}
          inspected={inspect}
          onInspect={setInspect}
          alerts={alerts}
          history={history}
          lines={lines}
          partial={partial}
          srcLang={srcLang}
          tgtLang={tgtLang}
          clockOffset={clockOffset.current}
        />
      )}
      {cosmos && inspect && (
        <Inspector
          stage={inspect}
          nodes={nodes}
          sig={sig}
          conf={conf}
          history={history}
          lines={lines}
          alerts={alerts}
          clockOffset={clockOffset.current}
          onSelect={setInspect}
          onClose={closeInspector}
        />
      )}
      {route === "qualite" && <Quality sig={sig} voiceName={voiceName} />}
      {route === "voix" && <Voices api={api} conf={conf} overview={overview} onSettings={applyServerSettings} adding={adding} setAdding={setAdding} />}
      {route === "configuration" && (
        <Configuration
          conf={conf}
          value={draft?.value ?? conf?.settings}
          dirty={dirty}
          micDb={stats?.micDb ?? null}
          onChange={changeDraft}
          onSave={saveDraft}
          onDiscard={() => setDraft(undefined)}
          onReset={resetSettings}
        />
      )}
      {route === "seance" && <Session sig={sig} infoError={infoError} floor={floor} questions={questions} journal={journal} onClearJournal={() => setJournal([])} />}
    </Shell>
  );
}

