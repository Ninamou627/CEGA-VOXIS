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
import type { RoomCodeResponse } from "../../../shared/auth";
import type { ClientSettings, FloorState, Lang, ServerEvent, StatsPayload } from "../../../shared/protocol";
import type { Settings } from "../../../shared/settings";
import { logout, whoami, type AccountView } from "../lib/auth";
import { SalleSocket, type ConnState } from "../lib/ws";
import { APP_NAME } from "../ui/brand";
import { Login } from "../ui/Login";
import { REPORT_LABEL } from "../ui/reports";
import { AdminApi } from "./api";
import { diffKeys, rebase } from "./draft";
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
import { mergeReports } from "./views/Reports";
import { ReportToasts, ReportsSheet } from "./views/ReportsSheet";

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
  /** Compte connecté (D17) : undefined = on ne sait pas encore, null = il faut se connecter. */
  const [account, setAccount] = useState<AccountView | null | undefined>();
  const [loginNotice, setLoginNotice] = useState<string>();
  const api = useMemo(() => new AdminApi(), []);
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
  /** Les signalements des apprenants arrivent à l'administration : une liste, et une annonce à l'arrivée. */
  const [reportsOpen, setReportsOpen] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; report: RecentReport }[]>([]);
  const [now, setNow] = useState(Date.now());

  const clockOffset = useRef(0);
  const seq = useRef(0);
  const lastListeners = useRef<number>(undefined);
  const lastLecturer = useRef<boolean>(undefined);
  const overviewTimer = useRef<number>(undefined);
  /** Dernières stats reçues, pour les rappels du WebSocket (créés une seule fois). */
  const statsRef = useRef<StatsPayload>(undefined);
  const scrolledFor = useRef<string>(undefined);
  const toastSeq = useRef(0);

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
  // L'inspecteur et la liste des signalements se ferment quand on change de page.
  useEffect(() => {
    setInspect(undefined);
    setReportsOpen(false);
  }, [route]);
  useEffect(() => {
    const page = PAGES.find((p) => p.route === route) ?? PAGES[0];
    document.title = `${page.title} · ${APP_NAME}`;
  }, [route]);

  // Qui est connecté ? Le cookie répond sans rien demander (D17).
  useEffect(() => {
    void whoami()
      .then(setAccount)
      .catch(() => setAccount(null));
  }, []);

  // ---- code de séance (D17) -------------------------------------------------------------
  // Sans code ouvert, aucun apprenant ne peut entrer : la page Séance le dit et le propose.
  const [code, setCode] = useState<RoomCodeResponse>();
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    if (!account) return;
    void api.code().then(setCode).catch(adminFailed);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- adminFailed est stable
  }, [api, account]);

  const rotateCode = () => {
    setRotating(true);
    void api
      .rotateCode()
      .then((c) => {
        setCode(c);
        log("salle", `nouveau code de séance : ${c.code}`);
      })
      .catch(adminFailed)
      .finally(() => setRotating(false));
  };

  // ---- API d'administration -----------------------------------------------------------
  // Une session expirée ou refusée ramène à l'écran de connexion, pas à un bandeau rouge.
  const adminFailed = (e: unknown) => {
    const msg = (e as Error).message;
    if (/connexion requise|réservé à l'administration/.test(msg)) {
      setLoginNotice(msg === "connexion requise" ? "Votre session a expiré." : msg);
      setAccount(null);
      return;
    }
    setAdminError(msg);
  };

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
    // Rien tant que personne n'est connecté : inutile de se faire refuser par l'API.
    if (!account) return;
    void loadConf();
    void loadOverview();
    const id = setInterval(() => void loadOverview(), OVERVIEW_EVERY_MS);
    return () => {
      clearInterval(id);
      clearTimeout(overviewTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadConf/loadOverview sont stables
  }, [api, account]);

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
    if (!account) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    const s = new SalleSocket(
      { t: "join", role: "dashboard" },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleEvent est stable ici
  }, [account]);

  function handleEvent(e: ServerEvent) {
    switch (e.t) {
      case "hello":
        clockOffset.current = e.tServer - Date.now();
        setHello(e);
        setFloor(e.floor);
        setRoom(e.settings);
        setWsError(undefined);
        log("liaison", "connecté à la salle");
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
      case "report": {
        const report: RecentReport = { at: e.at, who: e.who, kind: e.kind, lang: e.lang, seq: e.seq, srcText: e.srcText, text: e.text, e2eMs: e.e2eMs };
        setReports((prev) => [...prev, report].slice(-100));
        const id = ++toastSeq.current;
        setToasts((prev) => [...prev, { id, report }].slice(-3));
        window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 8000);
        log("signalement", `${REPORT_LABEL[e.kind].label}${e.srcText ? ` — « ${e.srcText} »` : ""}`);
        refreshOverviewSoon();
        break;
      }
      case "degraded":
        log("degrade", e.mode === "none" ? `retour au nominal — ${e.reason}` : `${DEGRADED[e.mode] ?? e.mode} — ${e.reason}`);
        break;
      case "error":
        // Session expirée : retour à l'écran de connexion plutôt qu'une page qui ne dit rien.
        if (e.code === "unauthorized") {
          setLoginNotice("Votre session a expiré. Reconnectez-vous.");
          setAccount(null);
          return;
        }
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

  const banners = (
    <>
      {adminError && conn === "open" && (
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
  const closeReports = useCallback(() => setReportsOpen(false), []);
  const openReports = () => {
    setToasts([]);
    setReportsOpen(true);
  };
  const actions = cosmos ? (
    <>
      <Action tone="halo" icon="insights" onClick={() => setInspect(firstInspect())} title="Ouvrir l'inspecteur d'un étage">
        Inspecteur
      </Action>
      <Action tone="solid" icon="flag" onClick={() => setReportsOpen(true)} title="Les signalements des apprenants arrivent ici">
        Signalements
        {reportsToday > 0 && <span className="ml-0.5 min-w-[1.25rem] px-1.5 rounded-full bg-white/20 text-[11px] leading-5 text-center">{reportsToday}</span>}
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

  // Tant qu'on ne sait pas : rien, pour ne pas faire clignoter l'écran de connexion.
  if (account === undefined) return <div className="min-h-dvh bg-surface" />;
  if (account === null) return <Login surface="Administration" notice={loginNotice} onDone={setAccount} />;

  return (
    <Shell
      route={route}
      conn={conn}
      uptimeS={stats?.uptimeS ?? health?.uptimeS}
      alerts={{ crit: alerts.filter((a) => a.severity === "crit").length, warn: alerts.filter((a) => a.severity === "warn").length }}
      reports={reportsToday}
      configDirty={dirty.size > 0}
      account={account}
      onLogout={() => void logout().then(() => setAccount(null))}
      joinUrl={info?.joinUrl}
      actions={actions}
      cosmos={cosmos}
    >
      {banners}
      {route === "" && <Overview sig={sig} nodes={nodes} speaking={speaking} alerts={alerts} inspected={inspect} onInspect={setInspect} />}
      {route === "supervision" && (
        <Supervision
          sig={sig}
          nodes={nodes}
          speaking={speaking}
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
      {reportsOpen && (
        <ReportsSheet
          reports={mergeReports(reports, overview?.reports)}
          today={overview?.today.reports ?? {}}
          all={overview?.all.reports ?? {}}
          now={now}
          voiceName={voiceName}
          onClose={closeReports}
        />
      )}
      {!reportsOpen && toasts.length > 0 && <ReportToasts items={toasts} onOpen={openReports} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />}
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
      {route === "seance" && (
        <Session
          sig={sig}
          infoError={infoError}
          floor={floor}
          questions={questions}
          journal={journal}
          onClearJournal={() => setJournal([])}
          code={code}
          onRotateCode={rotateCode}
          rotatingCode={rotating}
        />
      )}
    </Shell>
  );
}

