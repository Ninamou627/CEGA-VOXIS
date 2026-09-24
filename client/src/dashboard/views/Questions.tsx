/** Les questions posées pendant la séance, telles que le formateur les a entendues ou lues. */
import { ago } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import type { QuestionEntry } from "../types";
import { Empty } from "../ui";

export function Questions({ questions, now }: { questions: QuestionEntry[]; now: number }) {
  const list = questions.slice().reverse();
  if (!list.length) return <Empty icon="contact_support">Aucune question encore. Elles apparaissent ici avec leur traduction dès qu'un apprenant parle ou écrit.</Empty>;
  return (
    <ul className="divide-y divide-outline-variant/15 max-h-[480px] overflow-y-auto -mt-3">
      {list.map((q) => (
        <li key={q.n} className="rise-in grid grid-cols-1 md:grid-cols-[9rem_minmax(0,1fr)] gap-x-6 gap-y-1 py-3.5">
          <div className="flex md:flex-col gap-x-3 gap-y-1 text-xs text-on-surface-variant">
            <span className="flex items-center gap-1.5 text-on-surface font-medium">
              <Icon name={q.mode === "text" ? "keyboard" : "mic"} className="text-[15px] text-primary" />
              {q.mode === "text" ? "Écrite" : "Parlée"}
              <span className="font-metric-mono-sm text-outline font-normal">#{q.n}</span>
            </span>
            <span>
              {LANGS[q.srcLang].flag} Apprenant {q.who.slice(-4).toUpperCase()}
            </span>
            <span className="font-metric-mono-sm text-outline">{ago(q.at, now)}</span>
          </div>
          <div className="min-w-0">
            {q.srcText ? (
              <>
                <p className="text-sm text-on-surface font-medium leading-snug">“{q.text}”</p>
                <p className="text-[13px] text-on-surface-variant italic leading-relaxed mt-1">« {q.srcText} »</p>
              </>
            ) : (
              <p className="text-[13px] text-error">Rien n'a été compris (question trop courte ou trop loin du micro).</p>
            )}
            <p className={`flex items-center gap-1 mt-1.5 text-xs ${q.delivered ? "text-secondary" : "text-error"}`}>
              <Icon name={q.delivered ? "headphones" : "headset_off"} className="text-[14px]" />
              {q.delivered ? (q.mode === "text" ? "affichée au formateur" : "jouée dans le casque du formateur") : "aucun formateur connecté pour la recevoir"}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
