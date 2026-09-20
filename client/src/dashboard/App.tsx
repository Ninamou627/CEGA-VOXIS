/**
 * Tableau de bord de salle : la vue de l'exploitant. QR code de connexion, latence
 * bout-en-bout, profondeur de file (dérive), état des fournisseurs et du serveur,
 * checklist d'avant-séance, flux des segments, questions, journal.
 *
 * Deux sources : le WebSocket (texte et stats toutes les 2 s) et /api/health
 * relevé toutes les 5 s pour la santé du processus.
 */
import { useEffect, useRef, useState } from "react";
import type { FloorState, Lang, ServerEvent, StatsPayload } from "../../../shared/protocol";
import { SalleSocket, type ConnState } from "../lib/ws";
import { Header } from "./Header";
import type { EventKind, Health, JournalEntry, Line, QuestionEntry, Sample, SessionInfo } from "./types";
import { Checklist } from "./views/Checklist";
import { Join } from "./views/Join";
import { Journal } from "./views/Journal";
import { Kpis } from "./views/Kpis";
import { Pipeline } from "./views/Pipeline";
import { Questions } from "./views/Questions";
import { Segments } from "./views/Segments";

type Hello = Extract<ServerEvent, { t: "hello" }>;

/** Dix minutes de stats à 2 s d'intervalle. */
const HISTORY = 300;
const HEALTH_EVERY_MS = 5000;

export function App() {
  const params = new URLSearchParams(location.search);
  const [token] = useState(params.get("token") ?? "");
  const [conn, setConn] = useState<ConnState>("closed");
  const [hello, setHello] = useState<Hello>();
  const [info, setInfo] = useState<SessionInfo>();
  const [infoError, setInfoError] = useState<string>();
  const [health, setHealth] = useState<Health>();
  const [stats, setStats] = useState<StatsPayload>();
  const [history, setHistory] = useState<Sample[]>([]);
  const [floor, setFloor] = useState<FloorState>({ state: "lecturer" });
  const [partial, setPartial] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [questions, setQuestions] = useState<QuestionEntry[]>([]);
  const [journal, setJournal] = useState<JournalEntry[]>([]);
  const [err, setErr] = useState<string>();
  const [now, setNow] = useState(Date.now());

  const clockOffset = useRef(0);
  const seq = useRef(0);
  const lastListeners = useRef<number>(undefined);
  const lastLecturer = useRef<boolean>(undefined);

  function log(kind: EventKind, text: string) {
    setJournal((prev) => [...prev, { n: ++seq.current, at: Date.now(), kind, text }].slice(-200));
  }

  // /api/session : le QR et les adresses ; on réessaie tant que le serveur ne répond pas.
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

  // /api/health : santé du processus et présence du formateur.
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
        log("liaison", `connecté à la salle ${e.sessionId}`);
        break;
      case "src.partial":
        setPartial(e.text);
        break;
      case "src.commit":
        setPartial("");
        upsert(e.seq, { src: e.text, tOrigin: e.tOrigin, reason: e.reason });
        break;
      case "tr.segment":
        upsert(e.seq, { tgt: e.text });
        break;
      case "stats":
        setStats(e.stats);
        setHistory((prev) => [...prev, { t: Date.now(), e2eP50: e.stats.e2eP50, e2eP95: e.stats.e2eP95, queueMaxMs: e.stats.queueMaxMs, listeners: e.stats.listeners }].slice(-HISTORY));
        if (lastListeners.current !== undefined && lastListeners.current !== e.stats.listeners) {
          log("salle", `${e.stats.listeners} auditeur${e.stats.listeners > 1 ? "s" : ""} (${e.stats.listeners > lastListeners.current ? "+" : ""}${e.stats.listeners - lastListeners.current})`);
        }
        lastListeners.current = e.stats.listeners;
        break;
      case "floor":
        setFloor(e.floor);
        log("parole", e.floor.state === "question" ? `un apprenant prend la parole (${e.floor.who.slice(-4).toUpperCase()})` : "parole rendue au formateur");
        break;
      case "question":
        setQuestions((prev) => [...prev, { n: prev.length + 1, at: Date.now(), who: e.who, srcLang: e.srcLang, srcText: e.srcText, lang: e.lang, text: e.text, delivered: e.delivered }].slice(-50));
        log("question", e.srcText ? `« ${e.srcText} » → « ${e.text} »${e.delivered ? "" : " — formateur absent"}` : "question incomprise (vide)");
        break;
      case "degraded":
        log("degrade", e.mode === "none" ? `retour au nominal — ${e.reason}` : `${e.mode} — ${e.reason}`);
        break;
      case "error":
        setErr(e.msg);
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

  const srcLang: Lang = hello?.srcLang ?? info?.srcLang ?? "en";
  const tgtLang: Lang = hello?.langs[0] ?? info?.langs[0] ?? "fr";
  const degraded = stats?.pipeline.degraded && stats.pipeline.degraded !== "none" ? stats.pipeline.degraded : undefined;
  const lecturerUrl = `/lecturer${token ? `?token=${encodeURIComponent(token)}` : ""}`;

  return (
    <>
      <Header
        conn={conn}
        session={hello?.sessionId ?? info?.sessionId}
        uptimeS={stats?.uptimeS ?? health?.uptimeS}
        lecturer={health?.lecturer}
        listeners={stats?.listeners ?? health?.listeners ?? 0}
        byLang={stats?.byLang}
        lecturerUrl={lecturerUrl}
        joinUrl={info?.joinUrl}
      />
      <main className="flex-1 w-full max-w-[1780px] mx-auto p-4 md:p-6 lg:p-7 flex flex-col gap-5">
        {(err || degraded || info?.certWarning) && (
          <div className="flex flex-col gap-2">
            {err && (
              <div className="bg-error-container text-on-error-container border border-error/30 rounded-xl px-4 py-3 text-sm flex items-start justify-between gap-3" role="alert">
                <span>{err}</span>
                <button type="button" onClick={() => setErr(undefined)} className="text-on-error-container/80 hover:text-on-error-container text-xs font-bold shrink-0">
                  fermer
                </button>
              </div>
            )}
            {degraded && (
              <div className="bg-error-container text-on-error-container border border-error/30 rounded-xl px-4 py-3 text-sm" role="alert">
                Mode dégradé : {degraded}. Le formateur en est informé ; les apprenants seulement si la voix manque.
              </div>
            )}
            {info?.certWarning && (
              <div className="bg-tertiary-container text-on-tertiary-container border border-tertiary/30 rounded-xl px-4 py-3 text-sm" role="alert">
                {info.certWarning}
              </div>
            )}
          </div>
        )}

        <Kpis stats={stats} history={history} />

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 w-full items-start">
          <div className="lg:col-span-3 flex flex-col gap-4">
            <Join info={info} error={infoError} />
            <Checklist info={info} health={health} stats={stats} serverReachable={!!info || !!health} />
          </div>
          <div className="lg:col-span-6 flex flex-col gap-4">
            <Segments lines={lines} partial={partial} srcLang={srcLang} tgtLang={tgtLang} clockOffset={clockOffset.current} />
          </div>
          <div className="lg:col-span-3 flex flex-col gap-4">
            <Pipeline stats={stats} health={health} info={info} />
            <Questions questions={questions} asking={floor.state === "question"} now={now} />
          </div>
        </div>

        <Journal entries={journal} onClear={() => setJournal([])} />
      </main>
    </>
  );
}
