/** Les questions posées pendant la séance, telles que le formateur les a entendues. */
import { ago } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import type { QuestionEntry } from "../types";
import { Card } from "./Card";

export function Questions({ questions, asking, now }: { questions: QuestionEntry[]; asking: boolean; now: number }) {
  const list = questions.slice().reverse();
  return (
    <Card
      icon="contact_support"
      title="Questions"
      right={
        <span
          key={asking ? "asking" : "free"}
          className={`pop flex items-center gap-1.5 text-[10px] font-label-badge font-bold uppercase px-2 py-1 rounded-full border ${
            asking ? "text-tertiary bg-tertiary/10 border-tertiary/30" : "text-on-surface-variant bg-surface-container-low border-outline-variant/30"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${asking ? "bg-tertiary animate-pulse" : "bg-secondary"}`}></span>
          {asking ? "Un apprenant parle" : `${questions.length} posée${questions.length > 1 ? "s" : ""}`}
        </span>
      }
    >
      <div className="flex flex-col gap-2 max-h-[420px] overflow-y-auto pr-0.5">
        {list.length === 0 && <p className="text-xs text-on-surface-variant">Aucune question encore. Elles apparaissent ici avec leur traduction dès qu'un apprenant parle.</p>}
        {list.map((q) => (
          <div key={q.n} className="rise-in bg-surface-container-low border border-outline-variant/20 rounded-xl p-2.5 flex flex-col gap-1">
            <div className="flex items-center gap-2 text-[10px] font-metric-mono-sm text-outline">
              <span>{LANGS[q.srcLang].flag}</span>
              <span>Apprenant {q.who.slice(-4).toUpperCase()}</span>
              <span>#{q.n}</span>
              <span className="flex items-center gap-0.5" title={q.mode === "text" ? "Question écrite" : "Question parlée"}>
                <Icon name={q.mode === "text" ? "keyboard" : "mic"} className="text-[12px]" />
              </span>
              <span className="ml-auto">{ago(q.at, now)}</span>
              <span className={`flex items-center gap-0.5 ${q.delivered ? "text-secondary" : "text-error"}`} title={q.delivered ? "Jouée dans le casque du formateur" : "Aucun formateur connecté pour l'entendre"}>
                <Icon name={q.delivered ? "headphones" : "headset_off"} className="text-[12px]" />
              </span>
            </div>
            {q.srcText ? (
              <>
                <p className="text-xs text-on-surface-variant italic leading-relaxed">« {q.srcText} »</p>
                <p className="text-xs text-on-surface font-semibold leading-snug">“{q.text}”</p>
              </>
            ) : (
              <p className="text-xs text-error">Rien n'a été compris (question trop courte ou trop loin du micro).</p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
