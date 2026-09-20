/**
 * Colonne de droite : les questions des apprenants. Elles arrivent transcrites,
 * traduites et jouées dans le casque (D8) ; ici on les relit, on les réécoute et
 * on les archive. Pas de file à modérer : la parole va au premier qui la prend.
 */
import { ago, mmss } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import type { QuestionItem } from "../types";

export interface QuestionsProps {
  questions: QuestionItem[];
  /** Un apprenant est en train d'enregistrer sa question. */
  asking: boolean;
  now: number;
  onReplay: (q: QuestionItem) => void;
  onArchive: (q: QuestionItem) => void;
}

export function Questions(p: QuestionsProps) {
  const open = p.questions.filter((q) => !q.archived).slice().reverse();
  return (
    <div className="lg:col-span-3 flex flex-col gap-4">
      <div className="bg-surface-container-lowest border border-outline-variant/25 rounded-2xl p-4 shadow-lg flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-secondary/15 flex items-center justify-center text-secondary shrink-0">
            <Icon name="contact_support" className="text-[19px]" />
          </div>
          <div className="flex flex-col min-w-0">
            <h2 className="font-headline-sm text-xs font-bold text-on-surface uppercase tracking-wider">Interventions apprenants</h2>
            <span className="font-metric-mono-sm text-[11px] text-secondary font-semibold truncate">
              {open.length === 0 ? "Aucune question en attente" : `${open.length} question${open.length > 1 ? "s" : ""} à traiter`}
            </span>
          </div>
        </div>
        <span
          className={`flex items-center gap-1.5 text-[10px] font-label-badge font-bold uppercase px-2 py-1 rounded-full border shrink-0 ${
            p.asking ? "text-tertiary bg-tertiary/10 border-tertiary/30" : "text-on-surface-variant bg-surface-container-low border-outline-variant/30"
          }`}
          title={p.asking ? "Un apprenant enregistre sa question" : "Les apprenants peuvent prendre la parole"}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${p.asking ? "bg-tertiary animate-pulse" : "bg-secondary"}`}></span>
          {p.asking ? "Un apprenant parle" : "Parole libre"}
        </span>
      </div>

      <div className="flex flex-col gap-3.5 max-h-[720px] overflow-y-auto pr-0.5">
        {open.length === 0 && (
          <div className="bg-surface-container-low border border-outline-variant/20 rounded-2xl p-5 text-center flex flex-col items-center gap-2">
            <Icon name="front_hand" className="text-[28px] text-on-surface-variant" />
            <span className="text-xs text-on-surface-variant">
              Les questions des apprenants arrivent ici, traduites, et dans votre casque au moment où elles sont posées.
            </span>
          </div>
        )}
        {open.map((q, i) => {
          const fresh = i === 0 && p.now - q.at < 60_000;
          return (
            <div
              key={q.n}
              className={`bg-surface-container-lowest border rounded-2xl p-4 shadow-xl flex flex-col gap-3 relative transition-all ${
                fresh ? "border-2 border-primary/40 hover:border-primary" : "border-outline-variant/25"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-10 h-10 rounded-full shrink-0 border border-primary/40 shadow-sm bg-surface-container-high flex items-center justify-center text-[18px]" aria-hidden="true">
                    {LANGS[q.srcLang].flag}
                  </div>
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className="font-headline-sm text-xs font-bold text-on-surface">Apprenant {q.who.slice(-4).toUpperCase()}</span>
                      <span className="font-metric-mono-sm text-[10px] text-outline font-semibold">#{q.n}</span>
                    </div>
                    <span className="font-metric-mono-sm text-[11px] text-secondary font-medium">Push-to-talk • {ago(q.at, p.now)}</span>
                  </div>
                </div>
                {fresh && <span className="font-label-badge text-[10px] text-primary bg-primary/15 px-2 py-0.5 rounded-full font-extrabold uppercase tracking-wide">Nouvelle</span>}
              </div>

              <div className="bg-surface-container-low p-2.5 rounded-xl border border-outline-variant/20 flex flex-col gap-1">
                <span className="text-[10px] font-label-badge text-on-surface-variant uppercase">Énoncé original ({LANGS[q.srcLang].label})</span>
                <p className={`font-body-md text-xs italic leading-relaxed ${q.srcText ? "text-on-surface-variant" : "text-error"}`}>
                  {q.srcText ? `« ${q.srcText} »` : "Rien n'a été compris : l'apprenant a été invité à parler plus près du téléphone."}
                </p>
              </div>

              {q.text && (
                <div className="bg-surface-container-high p-3 rounded-xl border border-primary/30 flex flex-col gap-1">
                  <span className="text-[10px] font-label-badge text-primary uppercase font-bold flex items-center gap-1">
                    <Icon name="translate" className="text-[13px]" />
                    Traduction immédiate formateur ({LANGS[q.lang].label})
                  </span>
                  <p className="font-headline-sm text-xs font-bold text-on-surface leading-snug">“{q.text}”</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  disabled={!q.audio}
                  onClick={() => p.onReplay(q)}
                  title="Rejouer la question dans le casque"
                  className="flex items-center justify-center gap-1 bg-surface-container hover:bg-surface-container-high text-on-surface py-2 px-2 rounded-xl text-xs font-medium border border-outline-variant/20 transition-all active:scale-95 cursor-pointer disabled:opacity-40 disabled:cursor-default"
                >
                  <Icon name="play_arrow" className="text-[16px]" />
                  <span>Réécouter{q.audio ? ` (${mmss(q.audio.durMs)})` : ""}</span>
                </button>
                <button
                  type="button"
                  onClick={() => p.onArchive(q)}
                  className="flex items-center justify-center gap-1 bg-surface-container hover:bg-surface-container-high text-outline hover:text-on-surface py-2 px-2 rounded-xl text-xs font-medium border border-outline-variant/20 transition-all active:scale-95 cursor-pointer"
                >
                  <Icon name="archive" className="text-[16px]" />
                  <span>Archiver</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
