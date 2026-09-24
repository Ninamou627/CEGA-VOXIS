/**
 * Séance : rejoindre la salle (QR, adresses), vérifier avant de commencer, suivre les
 * questions des apprenants et le journal de ce qui s'est passé.
 */
import type { FloorState } from "../../../../shared/protocol";
import type { Signals } from "../signals";
import type { JournalEntry, QuestionEntry } from "../types";
import { Chip, Section } from "../ui";
import { Checklist } from "../views/Checklist";
import { Join } from "../views/Join";
import { Journal } from "../views/Journal";
import { Questions } from "../views/Questions";

export interface SessionProps {
  sig: Signals;
  infoError?: string;
  floor: FloorState;
  questions: QuestionEntry[];
  journal: JournalEntry[];
  onClearJournal: () => void;
}

export function Session({ sig, infoError, floor, questions, journal, onClearJournal }: SessionProps) {
  return (
    <>
      <Section title="Rejoindre la salle" hint="À projeter ou à afficher à l'entrée : les apprenants scannent le QR code, choisissent leur langue et écoutent.">
        <Join info={sig.info} error={infoError} />
      </Section>

      <Section title="Avant la séance" hint="Ce qui se vérifie tout seul l'est en direct ; le reste se coche à la main et reste coché sur cet appareil.">
        <Checklist info={sig.info} health={sig.health} stats={sig.stats} serverReachable={Boolean(sig.info || sig.health)} threshold={sig.room?.speechThresholdDb ?? -35} />
      </Section>

      <Section
        title={questions.length ? `Questions · ${questions.length}` : "Questions"}
        hint="Parlées au micro du téléphone ou écrites : le formateur les entend dans sa langue, ou les lit sur son poste."
        right={
          <span key={floor.state} className="pop">
            {floor.state === "question" ? <Chip tone="warn">Un apprenant parle</Chip> : <Chip tone="ok">Parole au formateur</Chip>}
          </span>
        }
      >
        <Questions questions={questions} now={sig.now} />
      </Section>

      <Section title="Journal de séance" hint="Depuis l'ouverture de cette page. La mémoire longue de la séance est dans le fichier JSONL du serveur.">
        <Journal entries={journal} onClear={onClearJournal} />
      </Section>
    </>
  );
}
