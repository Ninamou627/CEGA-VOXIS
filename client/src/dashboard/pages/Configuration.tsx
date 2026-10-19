/**
 * Configuration globale : traduction, parole et voix. Chaque réglage dit ce qu'il fait,
 * et quand il s'applique — au segment suivant, ou au prochain démarrage du micro pour
 * ceux que le moteur de reconnaissance ne lit qu'à l'ouverture de son flux.
 *
 * Les modifications restent en brouillon (on peut changer de page sans les perdre)
 * jusqu'à « Enregistrer » ; seuls les champs touchés partent au serveur.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { ClaudeModel, SaveResponse, SettingsResponse } from "../../../../shared/admin";
import type { Lang } from "../../../../shared/protocol";
import type { Settings } from "../../../../shared/settings";
import { pct } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import { describe } from "../draft";
import { Action, Chip, Empty, Field, Section, Segmented, Slider, Stepper, TextArea } from "../ui";

export interface ConfigurationProps {
  conf?: SettingsResponse;
  /** Brouillon en cours, sinon les réglages du serveur. */
  value?: Settings;
  /** Clés « section.champ » modifiées et non enregistrées. */
  dirty: Set<string>;
  micDb: number | null;
  onChange: (next: Settings) => void;
  onSave: () => Promise<SaveResponse>;
  onDiscard: () => void;
  onReset: () => Promise<SaveResponse>;
}

const EFFORT = [
  { value: "low" as const, label: "Rapide", title: "La latence prime : réflexion minimale" },
  { value: "medium" as const, label: "Équilibré", title: "Un peu plus de réflexion, un peu plus de latence" },
  { value: "high" as const, label: "Approfondi", title: "Réflexion poussée : à réserver aux contenus très techniques" },
];

const ENDPOINTING = [
  { value: "min_latency" as const, label: "Rapide", title: "Coupe tôt : moins de latence, plus de phrases coupées" },
  { value: "balanced" as const, label: "Équilibrée", title: "Réglage recommandé" },
  { value: "max_accuracy" as const, label: "Précise", title: "Attend d'être sûr : phrases entières, un peu plus de latence" },
];

const QUICK_START = [
  { value: "on" as const, label: "Au premier blanc", title: "Après ~3 mots, au premier blanc entre deux mots : la salle entend plus tôt" },
  { value: "off" as const, label: "À la première pause", title: "Après ~4 mots, à la première pause d'un quart de seconde : morceau plus long" },
];

const dec = (x: number, digits = 1) => x.toFixed(digits).replace(".", ",");
const db = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x)} dB`;

function countGlossary(text: string): number {
  return text.split(/[\n;]/).filter((l) => {
    const i = l.indexOf("=");
    return i > 0 && l.slice(0, i).trim() && l.slice(i + 1).trim();
  }).length;
}

function countTerms(text: string): number {
  return text
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean).length;
}

/** Une ligne de choix de modèle : nom, ce qu'il accepte, pourquoi le prendre. */
function ModelRow({ m, on, onPick }: { m: ClaudeModel; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={`w-full text-left flex items-start gap-3 py-3 border-b border-outline-variant/15 last:border-b-0 transition-colors ${on ? "" : "hover:bg-surface-container-low/60"}`}
    >
      <Icon name={on ? "radio_button_checked" : "radio_button_unchecked"} className={`text-[20px] mt-px shrink-0 ${on ? "text-primary" : "text-outline"}`} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className={`text-sm ${on ? "font-semibold text-on-surface" : "text-on-surface"}`}>{m.label}</span>
          {m.effort && <Chip>effort</Chip>}
          {m.temperature && <Chip>température</Chip>}
          {m.fallbacks && <Chip title="Si le modèle est surchargé, l'API bascule d'elle-même sur un modèle de repli">repli serveur</Chip>}
        </span>
        <span className="block text-xs text-on-surface-variant mt-0.5 leading-relaxed">{m.note}</span>
      </span>
    </button>
  );
}

function Sub({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 w-full">
      <span className="text-xs font-medium text-on-surface-variant">{label}</span>
      {children}
    </div>
  );
}

function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" | "crit" }) {
  return (
    <p className={`text-xs leading-relaxed flex items-start gap-1.5 ${tone === "crit" ? "text-error" : tone === "warn" ? "text-tertiary" : "text-on-surface-variant"}`}>
      <Icon name={tone === "muted" ? "info" : "warning"} className="text-[14px] mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function Configuration({ conf, value, dirty, micDb, onChange, onSave, onDiscard, onReset }: ConfigurationProps) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [result, setResult] = useState<SaveResponse>();
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(undefined), 10_000);
    return () => clearTimeout(t);
  }, [result]);
  useEffect(() => {
    if (dirty.size) setSaveError(undefined);
  }, [dirty.size]);

  if (!conf || !value) return <Empty icon="hourglass_top">Lecture des réglages…</Empty>;

  const s = value;
  const o = conf.options;
  const t = s.translation;
  const sp = s.speech;
  const v = s.voice;
  const set = <K extends "translation" | "speech" | "voice">(section: K, patch: Partial<Settings[K]>) => onChange({ ...s, [section]: { ...s[section], ...patch } });
  const changed = (k: string) => dirty.has(k);

  const model: ClaudeModel = o.models.find((m) => m.id === t.model) ?? { id: t.model, label: t.model, effort: true, temperature: false, fallbacks: true, note: "Modèle défini à l'installation." };
  const models = o.models.some((m) => m.id === t.model) ? o.models : [...o.models, model];
  const usesClaude = t.primary === "anthropic" || t.secondary === "anthropic";
  const engine = (id: string) => o.mtEngines.find((e) => e.id === id);
  const unavailable = o.mtEngines.filter((e) => !e.available);
  const segmentationOk = sp.minWords <= sp.clauseWords && sp.clauseWords < sp.maxWords;
  const langs: Lang[] = [...new Set<Lang>([...o.targetLangs, o.srcLang])];
  const glossaryN = countGlossary(t.glossary);
  const termsN = countTerms(sp.keyterms);

  async function save() {
    setSaving(true);
    setSaveError(undefined);
    try {
      setResult(await onSave());
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setResetting(true);
    setSaveError(undefined);
    try {
      setResult(await onReset());
      setConfirmReset(false);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setResetting(false);
    }
  }

  return (
    <>
      {result && (
        <div role="status" className="sticky top-0 z-20 -mx-6 lg:-mx-10 px-6 lg:px-10 py-3 flex items-start gap-3 text-[13px] border-b bg-secondary/10 border-secondary/25 text-secondary">
          <Icon name="check_circle" fill className="text-[19px] shrink-0 mt-px" />
          <div className="flex-1 min-w-0 text-on-surface leading-relaxed">
            {result.changed.length === 0 ? (
              "Rien à enregistrer : les réglages étaient déjà ceux-là."
            ) : (
              <>
                <span className="font-semibold">Enregistré.</span>
                {result.live.length > 0 && <> Appliqué tout de suite : {describe(result.live)}.</>}
                {result.nextMic.length > 0 && <span className="text-tertiary"> Au prochain démarrage du micro : {describe(result.nextMic)}.</span>}
              </>
            )}
          </div>
          <Action icon="close" title="Fermer" onClick={() => setResult(undefined)} />
        </div>
      )}

      {/* ---------------------------------------------------------------- Traduction */}
      <Section id="traduction" title="Traduction" hint="Le moteur qui traduit chaque segment, son secours, et ce qu'il sait de la formation.">
        <div>
          <Field label="Moteur principal" help="Traduit chaque segment figé par la reconnaissance." applies="live" changed={changed("translation.primary")}>
            <Segmented
              value={t.primary}
              onChange={(x) => set("translation", { primary: x, secondary: t.secondary === x ? "none" : t.secondary })}
              options={o.mtEngines.map((e) => ({ value: e.id, label: e.label, disabled: !e.available, title: e.reason }))}
            />
            {t.primary === "mock" && <Note tone="warn">Le simulateur ne traduit pas : il sert aux essais sans clé.</Note>}
            {unavailable.length > 0 && <Note>{unavailable.map((e) => `${e.label} indisponible : ${e.reason ?? "non configuré"}`).join(" · ")}.</Note>}
          </Field>

          <Field
            label="Moteur secondaire"
            help="Prend le relais si le principal échoue ou dépasse le délai maximal ; le principal est réessayé une minute plus tard."
            applies="live"
            changed={changed("translation.secondary")}
          >
            <Segmented
              value={t.secondary}
              onChange={(x) => set("translation", { secondary: x })}
              options={[
                { value: "none" as const, label: "Aucun" },
                ...o.mtEngines.filter((e) => e.id !== t.primary).map((e) => ({ value: e.id, label: e.label, disabled: !e.available, title: e.reason })),
              ]}
            />
            {t.secondary === "none" && <Note>Sans secours, un échec de traduction affiche le texte du formateur tel quel.</Note>}
          </Field>

          {usesClaude && (
            <Field label="Modèle Claude" help="Chaque modèle se règle différemment : l'API refuse la température sur Opus et Sonnet 5, et l'effort sur Haiku." applies="live" changed={changed("translation.model")}>
              <div role="radiogroup" className="w-full max-w-xl">
                {models.map((m) => (
                  <ModelRow key={m.id} m={m} on={m.id === t.model} onPick={() => set("translation", { model: m.id })} />
                ))}
              </div>
            </Field>
          )}

          <Field
            label="Paramètres IA"
            help="L'effort règle la profondeur de réflexion ; la température, la part de variation d'une traduction à l'autre (0 = toujours la même)."
            applies="live"
            changed={changed("translation.effort") || changed("translation.temperature")}
          >
            {usesClaude ? (
              <>
                <Sub label="Effort">
                  <Segmented value={t.effort} onChange={(x) => set("translation", { effort: x })} options={EFFORT} disabled={!model.effort} />
                  {!model.effort && <Note>{model.label} ne se règle pas par l'effort.</Note>}
                </Sub>
                <Sub label="Température">
                  <Slider value={t.temperature} min={0} max={1} step={0.05} onChange={(x) => set("translation", { temperature: x })} format={(x) => dec(x, 2)} ends={["constante", "variée"]} disabled={!model.temperature} />
                  {!model.temperature && <Note>Refusée par {model.label} : l'API renverrait une erreur. Parmi les modèles proposés, seul Claude Haiku 4.5 l'accepte.</Note>}
                </Sub>
              </>
            ) : (
              <Note>Ces réglages concernent les modèles Claude ; {engine(t.primary)?.label ?? t.primary} n'en a pas d'équivalent.</Note>
            )}
          </Field>

          <Field label="Délai maximal" help="Au-delà, l'appel est abandonné : le moteur secondaire prend le relais, ou le texte source s'affiche." applies="live" changed={changed("translation.timeoutMs")}>
            <Slider value={t.timeoutMs} min={2000} max={15000} step={500} onChange={(x) => set("translation", { timeoutMs: x })} format={(x) => `${dec(x / 1000)} s`} ends={["2 s", "15 s"]} />
          </Field>

          <Field
            label="Continuité"
            help="Segments précédents fournis au traducteur pour garder le fil : pronoms, termes déjà choisis. Un peu plus de contexte, un peu plus de latence."
            applies="live"
            changed={changed("translation.contextSegments")}
          >
            <Stepper value={t.contextSegments} min={0} max={6} onChange={(x) => set("translation", { contextSegments: x })} unit="seg." label="Segments de contexte" />
          </Field>

          <Field label="Contexte linguistique" help="Le sujet, le public, le registre attendu. Le traducteur le lit avant chaque segment." applies="live" changed={changed("translation.domain")}>
            <TextArea
              value={t.domain}
              onChange={(x) => set("translation", { domain: x })}
              max={1500}
              rows={3}
              placeholder="Ex. : formation de trois jours sur la cybersécurité industrielle, pour des techniciens de maintenance. Registre professionnel, vouvoiement."
            />
          </Field>

          <Field label="Glossaire" help="Une paire par ligne : le terme du formateur = le rendu imposé. Pour les noms de produits, les sigles, le vocabulaire maison." applies="live" changed={changed("translation.glossary")}>
            <TextArea
              value={t.glossary}
              onChange={(x) => set("translation", { glossary: x })}
              max={4000}
              rows={5}
              mono
              placeholder={"firewall = pare-feu\nrollout = déploiement"}
              footer={`${glossaryN} terme${glossaryN > 1 ? "s" : ""} reconnu${glossaryN > 1 ? "s" : ""}`}
            />
          </Field>
        </div>
      </Section>

      {/* ------------------------------------------------------------------- Parole */}
      <Section id="parole" title="Parole" hint="Ce que le serveur reçoit du micro du formateur, et comment le flux est découpé en segments à traduire.">
        <div>
          <Field label="Sensibilité du micro" help="Gain appliqué au micro du formateur avant l'envoi, après le réglage automatique du navigateur." applies="live" changed={changed("speech.inputGainDb")}>
            <Slider value={sp.inputGainDb} min={-12} max={12} step={1} onChange={(x) => set("speech", { inputGainDb: x })} format={db} ends={["plus faible", "plus fort"]} />
          </Field>

          <Field
            label="Seuil de parole"
            help="Au-dessus de ce niveau, le serveur considère qu'il reçoit de la parole : il sert à la supervision et à l'alerte de silence."
            applies="live"
            changed={changed("speech.speechThresholdDb")}
          >
            <Slider
              value={sp.speechThresholdDb}
              min={-60}
              max={-20}
              step={1}
              onChange={(x) => set("speech", { speechThresholdDb: x })}
              format={db}
              marker={micDb != null ? { value: micDb, label: `reçu : ${db(micDb)}` } : undefined}
            />
            {micDb == null && <Note>Le niveau reçu s'affiche ici quand le formateur a démarré son micro.</Note>}
          </Field>

          <Field label="Détection de silence" help="Formateur en ligne, micro ouvert, et plus de parole depuis ce délai : une alerte le signale ici et chez le formateur." applies="live" changed={changed("speech.silenceAlertS")}>
            <Slider value={sp.silenceAlertS} min={5} max={120} step={5} onChange={(x) => set("speech", { silenceAlertS: x })} format={(x) => `${x} s`} ends={["5 s", "2 min"]} />
          </Field>

          <Field
            label="Fin de phrase"
            help="Quand le moteur de reconnaissance considère qu'une phrase est terminée. Plus tôt : moins de latence, mais plus de phrases coupées."
            applies="next-mic"
            changed={changed("speech.endpointing")}
          >
            <Segmented value={sp.endpointing} onChange={(x) => set("speech", { endpointing: x })} options={ENDPOINTING} disabled={!o.sttTunable} />
            {!o.sttTunable && <Note>Réglage d'AssemblyAI ; le moteur actuel ({o.stt}) ne l'utilise pas.</Note>}
          </Field>

          <Field
            label="Segmentation"
            help="Comment le flux est découpé en segments à traduire. Plus court : plus réactif. Plus long : traduction plus juste, décalage plus grand."
            applies="live"
            changed={["speech.minWords", "speech.clauseWords", "speech.maxWords", "speech.segmentTimeoutMs"].some(changed)}
          >
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              <Sub label="Minimum">
                <Stepper value={sp.minWords} min={1} max={10} onChange={(x) => set("speech", { minWords: x })} unit="mots" label="Segment minimal" />
              </Sub>
              <Sub label="Coupe à la proposition">
                <Stepper value={sp.clauseWords} min={4} max={30} onChange={(x) => set("speech", { clauseWords: x })} unit="mots" label="Coupe à la proposition" />
              </Sub>
              <Sub label="Maximum">
                <Stepper value={sp.maxWords} min={8} max={40} onChange={(x) => set("speech", { maxWords: x })} unit="mots" label="Segment maximal" />
              </Sub>
            </div>
            {!segmentationOk && <Note tone="crit">Il faut minimum ≤ coupe à la proposition &lt; maximum.</Note>}
            <Sub label="Délai de coupe — au-delà, le segment en cours part même inachevé">
              <Slider value={sp.segmentTimeoutMs} min={800} max={6000} step={100} onChange={(x) => set("speech", { segmentTimeoutMs: x })} format={(x) => `${dec(x / 1000)} s`} />
            </Sub>
          </Field>

          <Field
            label="Premier morceau d'une prise de parole"
            help="Quand le formateur se met à parler, la salle n'entend rien tant que ce morceau n'est pas dit. Au premier blanc : il part plus tôt, mais plus court."
            applies="live"
            changed={changed("speech.quickStart")}
          >
            <Segmented value={sp.quickStart ? "on" : "off"} onChange={(x) => set("speech", { quickStart: x === "on" })} options={QUICK_START} />
          </Field>

          <Field
            label="Vocabulaire de la formation"
            help="Termes que la reconnaissance doit savoir entendre, séparés par des virgules : noms propres, sigles, jargon."
            applies="next-mic"
            changed={changed("speech.keyterms")}
          >
            <TextArea
              value={sp.keyterms}
              onChange={(x) => set("speech", { keyterms: x })}
              max={4000}
              rows={3}
              disabled={!o.sttTunable}
              placeholder="SCADA, automate Siemens S7, IEC 62443"
              footer={`${termsN} terme${termsN > 1 ? "s" : ""}${termsN > 100 ? " — seuls les 100 premiers sont transmis" : ""}`}
            />
            {!o.sttTunable && <Note>Réglage d'AssemblyAI ; le moteur actuel ({o.stt}) ne l'utilise pas.</Note>}
          </Field>

          <Field label="Description de la séance" help="Quelques phrases, en anglais, qui décrivent la séance au moteur de reconnaissance." applies="next-mic" changed={changed("speech.prompt")}>
            <TextArea
              value={sp.prompt}
              onChange={(x) => set("speech", { prompt: x })}
              max={1500}
              rows={3}
              disabled={!o.sttPrompt}
              placeholder="A three-day training on industrial cybersecurity for maintenance technicians."
            />
            {!o.sttPrompt && <Note>Lue seulement par AssemblyAI U3.5 Pro ; le moteur actuel ({o.stt}) ne l'utilise pas. Le vocabulaire, lui, est transmis.</Note>}
          </Field>
        </div>
      </Section>

      {/* --------------------------------------------------------------------- Voix */}
      <Section id="voix" title="Voix" hint="Ce que les apprenants entendent. La voix de chaque langue se choisit parmi les voix ajoutées sur la page Voix.">
        <div>
          <Field
            label="Voix par défaut"
            help={
              <>
                Une voix par langue.{" "}
                <a href="#/voix" className="text-primary hover:underline underline-offset-4">
                  Ajouter ou écouter des voix
                </a>
              </>
            }
            applies="live"
            changed={changed("voice.defaults")}
          >
            <div className="flex flex-col gap-3 w-full max-w-md">
              {langs.map((l) => {
                const id = v.defaults[l];
                const envId = conf.defaults.voice.defaults[l];
                const choices = s.voices.filter((x) => x.lang === l);
                const listed = (x?: string) => Boolean(x) && choices.some((c) => c.id === x);
                return (
                  <label key={l} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 text-[13px] text-on-surface">
                      {LANGS[l].flag} {LANGS[l].label}
                    </span>
                    <select
                      value={id ?? envId ?? ""}
                      disabled={!choices.length}
                      onChange={(e) => {
                        // Choix vide : la langue revient à sa voix d'origine (jamais un identifiant vide).
                        const next = { ...v.defaults };
                        if (e.target.value) next[l] = e.target.value;
                        else delete next[l];
                        set("voice", { defaults: next });
                      }}
                      className="flex-1 min-w-0 bg-surface-container-low border border-outline-variant/40 rounded-lg px-3 py-2 text-[13px] text-on-surface focus:outline-none focus:border-primary/70 disabled:opacity-60"
                    >
                      {!listed(envId) && <option value={envId ?? ""}>{envId ? "Voix d'origine" : "Voix principale"}</option>}
                      {id && id !== envId && !listed(id) && <option value={id}>{`Voix ${id.slice(0, 8)}…`}</option>}
                      {choices.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          </Field>

          <Field label="Vitesse" help="Vitesse de base de la voix. Le rattrapage automatique de la dérive s'y ajoute, jusqu'à ×1,2." applies="live" changed={changed("voice.speed")}>
            <Slider value={v.speed} min={0.8} max={1.2} step={0.05} onChange={(x) => set("voice", { speed: x })} format={(x) => `×${dec(x, 2)}`} ends={["posée", "rapide"]} />
          </Field>

          <Field
            label="Ton"
            help="Expressif et varié, ou posé et régulier. Pour de l'interprétation, plutôt posé : l'attention reste sur le contenu."
            applies="live"
            changed={changed("voice.stability")}
          >
            <Slider value={v.stability} min={0} max={1} step={0.05} onChange={(x) => set("voice", { stability: x })} format={(x) => pct(x, 0)} ends={["expressif", "posé"]} />
            {!o.elevenlabsInUse && <Note>Réglage d'ElevenLabs ; la voix actuelle ({o.tts}) ne l'utilise pas.</Note>}
          </Field>

          <Field label="Style" help="Accentue le caractère propre de la voix. 0 = neutre, le plus sûr pour de l'interprétation ; au-delà, un peu plus de latence." applies="live" changed={changed("voice.style")}>
            <Slider value={v.style} min={0} max={1} step={0.05} onChange={(x) => set("voice", { style: x })} format={(x) => pct(x, 0)} ends={["neutre", "appuyé"]} />
            {!o.elevenlabsInUse && <Note>Réglage d'ElevenLabs ; la voix actuelle ({o.tts}) ne l'utilise pas.</Note>}
          </Field>

          <Field label="Volume" help="Volume de départ sur les téléphones des apprenants ; chacun peut ensuite régler le sien." applies="live" changed={changed("voice.listenerVolume")}>
            <Slider value={v.listenerVolume} min={0} max={100} step={5} onChange={(x) => set("voice", { listenerVolume: x })} format={(x) => `${x} %`} ends={["muet", "maximum"]} />
          </Field>
        </div>
      </Section>

      <Section title="Valeurs d'origine" hint="Reprendre les réglages d'installation du serveur de salle. Les voix ajoutées restent dans la liste.">
        {confirmReset ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] text-on-surface">Tous les réglages de cette page reviendront à leur valeur d'origine, tout de suite.</span>
            <Action tone="danger" icon="restart_alt" busy={resetting} onClick={() => void reset()}>
              Confirmer
            </Action>
            <Action onClick={() => setConfirmReset(false)}>Annuler</Action>
          </div>
        ) : (
          <Action tone="outline" icon="restart_alt" onClick={() => setConfirmReset(true)}>
            Revenir aux valeurs d'origine
          </Action>
        )}
      </Section>

      {(dirty.size > 0 || saveError) && (
        <div className="sticky bottom-0 z-20 -mx-6 lg:-mx-10 px-6 lg:px-10 py-3 bg-surface/95 backdrop-blur border-t border-outline-variant/30 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex-1 min-w-0 text-[13px]">
            {saveError ? (
              <span className="text-error flex items-start gap-2">
                <Icon name="error" fill className="text-[18px] shrink-0" />
                {saveError}
              </span>
            ) : (
              <span className="flex items-center gap-2 text-on-surface">
                <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
                <span className="truncate">
                  {dirty.size} modification{dirty.size > 1 ? "s" : ""} non enregistrée{dirty.size > 1 ? "s" : ""} : <span className="text-on-surface-variant">{describe([...dirty])}</span>
                </span>
              </span>
            )}
          </div>
          <Action onClick={onDiscard} disabled={saving || !dirty.size}>
            Annuler
          </Action>
          <Action tone="primary" icon="save" busy={saving} disabled={!segmentationOk || !dirty.size} onClick={() => void save()}>
            Enregistrer
          </Action>
        </div>
      )}
    </>
  );
}
