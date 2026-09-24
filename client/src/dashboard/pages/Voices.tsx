/**
 * Gestion des voix : la voix par défaut de chaque langue, les voix de la salle avec leur
 * naturalité perçue (signalements des apprenants, voix par voix), l'ajout d'une voix du
 * compte ElevenLabs et le secours Azure.
 *
 * Deux écoutes, deux coûts : l'échantillon ElevenLabs (`preview_url`) est gratuit ;
 * l'« essai en situation » synthétise la phrase d'essai dans la langue de la voix et
 * décompte une centaine de caractères du compte. Le bouton le dit.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogVoice, OverviewResponse, SettingsResponse } from "../../../../shared/admin";
import type { Lang } from "../../../../shared/protocol";
import type { Settings, VoiceEntry } from "../../../../shared/settings";
import { num, rate } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { LANGS } from "../../ui/langs";
import type { AdminApi } from "../api";
import { Action, Chip, Empty, Meter, Section, Segmented, Sheet, type Tone } from "../ui";

export interface VoicesProps {
  api: AdminApi;
  conf?: SettingsResponse;
  overview?: OverviewResponse;
  onSettings: (s: Settings) => void;
  adding: boolean;
  setAdding: (b: boolean) => void;
}

const CATEGORY: Record<string, string> = { premade: "prédéfinie", cloned: "clonée", generated: "générée", professional: "professionnelle", famous: "célèbre", high_quality: "haute qualité" };
const GROUP_TITLE: Record<Lang, string> = { fr: "Voix françaises", en: "Voix anglaises", es: "Voix espagnoles", pt: "Voix portugaises", ar: "Voix arabes" };
/** « la voix française », « aucune voix anglaise ». */
const ADJ: Record<Lang, string> = { fr: "française", en: "anglaise", es: "espagnole", pt: "portugaise", ar: "arabe" };

/** Une écoute à la fois ; la synthèse d'essai arrive en Blob, l'échantillon en URL. */
function usePlayer() {
  const audio = useRef<HTMLAudioElement | undefined>(undefined);
  const url = useRef<string | undefined>(undefined);
  const [playing, setPlaying] = useState<string>();
  const [loading, setLoading] = useState<string>();

  const release = () => {
    audio.current?.pause();
    if (url.current?.startsWith("blob:")) URL.revokeObjectURL(url.current);
    url.current = undefined;
  };
  const stop = () => {
    release();
    setPlaying(undefined);
  };
  const play = async (key: string, src: string | (() => Promise<Blob>)) => {
    if (playing === key) return stop();
    stop();
    let u: string;
    if (typeof src === "string") u = src;
    else {
      setLoading(key);
      try {
        u = URL.createObjectURL(await src());
      } finally {
        setLoading(undefined);
      }
    }
    const a = new Audio(u);
    audio.current = a;
    url.current = u;
    a.onended = () => {
      if (audio.current === a) stop();
    };
    setPlaying(key);
    await a.play().catch(() => stop());
  };
  useEffect(() => release, []);
  return { playing, loading, play, stop };
}

/** Les étiquettes d'ElevenLabs sont en anglais : on traduit les plus courantes, on garde les autres. */
const GENDER: Record<string, string> = { female: "femme", male: "homme", neutral: "neutre", non_binary: "non binaire" };
const AGE: Record<string, string> = { young: "jeune", middle_aged: "âge moyen", "middle aged": "âge moyen", old: "senior" };
const ACCENT: Record<string, string> = {
  american: "américain",
  british: "britannique",
  australian: "australien",
  african: "africain",
  irish: "irlandais",
  indian: "indien",
  french: "français",
  parisian: "parisien",
  canadian: "canadien",
  standard: "standard",
};
const USE: Record<string, string> = {
  informative_educational: "pédagogique",
  conversational: "conversation",
  narrative_story: "narration",
  narration: "narration",
  social_media: "réseaux sociaux",
  advertisement: "publicité",
  characters_animation: "personnages",
  entertainment_tv: "divertissement",
  news: "actualités",
};
const tr = (map: Record<string, string>, x?: string) => (x ? (map[x.toLowerCase()] ?? x.replace(/_/g, " ")) : undefined);

function describeVoice(v: { gender?: string; age?: string; accent?: string }): string {
  return [tr(GENDER, v.gender), tr(AGE, v.age), tr(ACCENT, v.accent)].filter(Boolean).join(" · ");
}

function naturalTone(x: number | null): Tone {
  return x == null ? "idle" : x >= 0.97 ? "ok" : x >= 0.92 ? "warn" : "crit";
}

export function Voices({ api, conf, overview, onSettings, adding, setAdding }: VoicesProps) {
  const player = usePlayer();
  const [catalog, setCatalog] = useState<CatalogVoice[]>();
  const [catalogError, setCatalogError] = useState<string>();
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirm, setConfirm] = useState<string>();

  const opts = conf?.options;
  const settings = conf?.settings;
  const langs = useMemo<Lang[]>(() => (opts ? [...new Set<Lang>([...opts.targetLangs, opts.srcLang])] : []), [opts]);

  async function loadCatalog(refresh = false) {
    if (!opts?.voicesEnabled) return;
    setCatalogBusy(true);
    try {
      setCatalog((await api.catalog(refresh)).voices);
      setCatalogError(undefined);
    } catch (e) {
      setCatalogError((e as Error).message);
    } finally {
      setCatalogBusy(false);
    }
  }
  useEffect(() => {
    void loadCatalog();
  }, [opts?.voicesEnabled]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(undefined), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  if (!conf || !settings || !opts) return <Empty icon="hourglass_top">Lecture des réglages…</Empty>;

  const nameOf = (id: string | undefined): string | undefined => (id ? (settings.voices.find((v) => v.id === id)?.name ?? catalog?.find((v) => v.id === id)?.name) : undefined);
  const stats = (id: string) => overview?.voices[id];

  async function run<T>(key: string, fn: () => Promise<T>, done?: (r: T) => string | undefined) {
    setBusy(key);
    setError(undefined);
    try {
      const r = await fn();
      const msg = done?.(r);
      if (msg) setNotice(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  /** `id` vide : la langue revient à la voix du .env. */
  const setDefault = (lang: Lang, id: string) => {
    const defaults = { ...settings.voice.defaults };
    if (id) defaults[lang] = id;
    else delete defaults[lang];
    return run(
      `default-${lang}`,
      () => api.save({ ...settings, voice: { ...settings.voice, defaults } }),
      (r) => {
        onSettings(r.settings);
        return id ? `${nameOf(id) ?? "Voix"} est la voix ${ADJ[lang]} par défaut — dès le prochain segment.` : `La voix ${ADJ[lang]} revient à celle du .env — dès le prochain segment.`;
      },
    );
  };

  const remove = (v: VoiceEntry) =>
    run(
      `remove-${v.id}-${v.lang}`,
      () => api.removeVoice(v.id, v.lang),
      (r) => {
        onSettings(r.settings);
        setConfirm(undefined);
        return `${v.name} retirée des voix ${LANGS[v.lang].short}.`;
      },
    );

  const add = (id: string, lang: Lang) =>
    run(
      `add-${id}-${lang}`,
      () => api.addVoice(id, lang),
      (r) => {
        onSettings(r.settings);
        return `${r.settings.voices.find((x) => x.id === id && x.lang === lang)?.name ?? "Voix"} ajoutée aux voix ${LANGS[lang].short}.`;
      },
    );

  /** Le choix « voix du .env » : son identifiant s'il y en a un, sinon la voix principale. */
  const envOption = (lang: Lang) => {
    const envId = conf.defaults.voice.defaults[lang];
    if (envId && settings.voices.some((v) => v.id === envId && v.lang === lang)) return null;
    return <option value={envId ?? ""}>{envId ? `${nameOf(envId) ?? "Voix"} · voix du .env` : "Voix principale du .env"}</option>;
  };

  const trial = (id: string, lang: Lang) => player.play(`trial-${id}-${lang}`, () => api.preview(id, lang)).catch((e: Error) => setError(e.message));

  const playButtons = (id: string, lang: Lang, previewUrl?: string) => (
    <span className="inline-flex items-center">
      {previewUrl && (
        <Action
          icon={player.playing === `sample-${id}` ? "stop_circle" : "play_circle"}
          title={player.playing === `sample-${id}` ? "Arrêter" : "Échantillon ElevenLabs (gratuit)"}
          onClick={() => void player.play(`sample-${id}`, previewUrl)}
        />
      )}
      {opts.voicesEnabled && (
        <Action
          icon={player.playing === `trial-${id}-${lang}` ? "stop_circle" : "record_voice_over"}
          busy={player.loading === `trial-${id}-${lang}`}
          title={player.playing === `trial-${id}-${lang}` ? "Arrêter" : `Essai en situation : la phrase d'essai en ${LANGS[lang].nameFr}, à la vitesse réglée (≈ 100 caractères décomptés du compte ElevenLabs)`}
          onClick={() => void trial(id, lang)}
        />
      )}
    </span>
  );

  return (
    <>
      {(error || notice) && (
        <div className={`sticky top-0 z-20 -mx-6 lg:-mx-10 px-6 lg:px-10 py-2.5 text-[13px] flex items-center gap-2 border-b ${error ? "bg-error/10 border-error/25 text-error" : "bg-secondary/10 border-secondary/25 text-secondary"}`} role={error ? "alert" : "status"}>
          <Icon name={error ? "error" : "check_circle"} fill className="text-[18px]" />
          <span className="flex-1 text-on-surface">{error ?? notice}</span>
          {error && <Action icon="close" title="Fermer" onClick={() => setError(undefined)} />}
        </div>
      )}

      {!opts.voicesEnabled ? (
        <div className="pt-8">
          <Empty icon="key_off">
            ElevenLabs n'est pas configuré : ajoutez <span className="font-metric-mono-sm text-on-surface">ELEVENLABS_API_KEY</span> au .env puis relancez le serveur pour choisir, écouter et ajouter des voix.
          </Empty>
        </div>
      ) : (
        !opts.elevenlabsInUse && (
          <div className="pt-8">
            <Empty icon="info">
              La voix de séance est actuellement <span className="font-metric-mono-sm text-on-surface">{opts.tts}</span>. Les voix choisies ici serviront dès que <span className="font-metric-mono-sm text-on-surface">TTS_PROVIDER=elevenlabs</span> ; en attendant, vous pouvez déjà les écouter et les préparer.
            </Empty>
          </div>
        )
      )}

      <Section title="Voix par défaut" hint="La voix que chaque langue entend en séance. Un changement s'applique dès le segment suivant, sans couper la séance.">
        <ul className="divide-y divide-outline-variant/15 -mt-3">
          {langs.map((lang) => {
            const id = settings.voice.defaults[lang];
            const envId = conf.defaults.voice.defaults[lang];
            // Sans voix choisie, c'est celle du .env qui parle : on l'écoute et on la mesure.
            const effective = id || envId;
            const choices = settings.voices.filter((v) => v.lang === lang);
            const current = choices.find((v) => v.id === effective);
            const st = effective ? stats(effective) : undefined;
            const role = lang === opts.srcLang && !opts.targetLangs.includes(lang) ? "questions des apprenants, dites au formateur" : "voix entendue par les apprenants";
            return (
              <li key={lang} className="grid grid-cols-1 md:grid-cols-[14rem_minmax(0,1fr)_auto] items-center gap-x-8 gap-y-3 py-4">
                <div>
                  <div className="text-sm font-semibold text-on-surface">
                    {LANGS[lang].flag} {LANGS[lang].label}
                  </div>
                  <div className="text-xs text-on-surface-variant mt-0.5">{role}</div>
                </div>
                <div className="flex flex-wrap items-center gap-3 min-w-0">
                  <select
                    value={effective ?? ""}
                    disabled={!choices.length || busy === `default-${lang}`}
                    onChange={(e) => void setDefault(lang, e.target.value)}
                    className="min-w-[14rem] max-w-full bg-surface-container-low border border-outline-variant/40 rounded-lg px-3 py-2 text-[13px] text-on-surface focus:outline-none focus:border-primary/70 disabled:opacity-60"
                  >
                    {envOption(lang)}
                    {id && !current && id !== envId && <option value={id}>{`${nameOf(id) ?? "Voix inconnue"} · ${id.slice(0, 8)}…`}</option>}
                    {choices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                        {describeVoice(v) ? ` — ${describeVoice(v)}` : ""}
                      </option>
                    ))}
                  </select>
                  {effective && playButtons(effective, lang, current?.previewUrl ?? catalog?.find((v) => v.id === effective)?.previewUrl)}
                  {!choices.length && (
                    <span className="text-xs text-on-surface-variant">
                      {!id ? "pas de voix dédiée : la voix principale répond aussi dans cette langue" : id === envId ? "voix du .env — ajoutez des voix pour choisir" : "ajoutez une voix pour choisir"}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 md:justify-end">
                  {st?.natural != null ? (
                    <>
                      <Meter value={st.natural} tone={naturalTone(st.natural)} className="w-20" />
                      <span className="font-metric-mono-sm text-sm font-semibold text-on-surface w-14 text-right">{rate(st.natural)}</span>
                    </>
                  ) : (
                    <span className="text-xs text-outline">pas encore entendue</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      {langs.map((lang) => {
        const list = settings.voices.filter((v) => v.lang === lang).sort((a, b) => (stats(b.id)?.natural ?? -1) - (stats(a.id)?.natural ?? -1));
        return (
          <Section
            key={lang}
            title={`${GROUP_TITLE[lang]}${list.length ? ` · ${list.length}` : ""}`}
            hint={lang === langs[0] ? "Naturalité : part des segments dits par la voix sans signalement « voix peu naturelle » des apprenants." : undefined}
            right={
              opts.voicesEnabled && (
                <Action icon="add" onClick={() => setAdding(true)}>
                  Ajouter
                </Action>
              )
            }
          >
            {list.length === 0 ? (
              <Empty icon="voice_selection">
                Aucune voix {ADJ[lang]} ajoutée.
                {settings.voice.defaults[lang] ? " La salle utilise la voix définie dans le .env." : ""}
              </Empty>
            ) : (
              <ul className="divide-y divide-outline-variant/15 -mt-3">
                {list.map((v) => {
                  const st = stats(v.id);
                  const isDefault = settings.voice.defaults[lang] === v.id;
                  const k = `${v.id}-${v.lang}`;
                  return (
                    <li key={k} className="rise-in grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_15rem_auto] items-center gap-x-8 gap-y-3 py-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[15px] font-semibold text-on-surface">{v.name}</span>
                          {isDefault && (
                            <Chip tone="primary">
                              <Icon name="star" fill className="text-[11px]" />
                              par défaut
                            </Chip>
                          )}
                        </div>
                        <div className="text-xs text-on-surface-variant mt-0.5 truncate">
                          {[describeVoice(v), v.description].filter(Boolean).join(" — ") || <span className="font-metric-mono-sm">{v.id}</span>}
                        </div>
                      </div>
                      <div>
                        {st?.natural != null ? (
                          <>
                            <div className="flex items-center gap-3">
                              <Meter value={st.natural} tone={naturalTone(st.natural)} className="flex-1" />
                              <span className="font-metric-mono-sm text-sm font-semibold text-on-surface w-14 text-right">{rate(st.natural)}</span>
                            </div>
                            <div className="text-[11px] text-outline mt-1">
                              {num(st.spoken)} segments · {st.unnatural} signalé{st.unnatural > 1 ? "s" : ""}
                            </div>
                          </>
                        ) : (
                          <span className="text-xs text-outline">pas encore entendue en séance</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 lg:justify-end">
                        {playButtons(v.id, lang, v.previewUrl)}
                        {!isDefault && (
                          <Action icon="star" busy={busy === `default-${lang}`} onClick={() => void setDefault(lang, v.id)}>
                            Par défaut
                          </Action>
                        )}
                        {confirm === k ? (
                          <>
                            <Action tone="danger" icon="delete" busy={busy === `remove-${k}`} onClick={() => void remove(v)}>
                              Retirer
                            </Action>
                            <Action onClick={() => setConfirm(undefined)}>Garder</Action>
                          </>
                        ) : (
                          <Action icon="delete" title={isDefault ? "Retirer (la langue revient à la voix du .env)" : "Retirer"} onClick={() => setConfirm(k)} />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        );
      })}

      <Section title="Voix de secours" hint="Si ElevenLabs échoue pendant la séance, la salle bascule sur le secours pendant une minute, puis réessaie.">
        {opts.azure ? (
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-12">
            {(["fr", "en"] as const).map((l) => (
              <div key={l} className="flex items-baseline justify-between gap-4 py-2.5 border-b border-outline-variant/15">
                <dt className="text-[13px] text-on-surface-variant">
                  {LANGS[l].flag} Azure · {LANGS[l].label}
                </dt>
                <dd className="font-metric-mono-sm text-[13px] text-on-surface">{opts.azure![l]}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <Empty icon="warning">Pas de voix de secours : sans ElevenLabs, les apprenants n'auraient que le texte. Ajoutez AZURE_SPEECH_KEY au .env pour en avoir une.</Empty>
        )}
      </Section>

      {adding && (
        <AddVoice
          langs={langs}
          settings={settings}
          catalog={catalog}
          catalogError={catalogError}
          catalogBusy={catalogBusy}
          onRefresh={() => void loadCatalog(true)}
          onAdd={(id, lang) => add(id, lang)}
          busy={busy}
          player={player}
          onClose={() => {
            player.stop();
            setAdding(false);
          }}
        />
      )}
    </>
  );
}

function AddVoice({
  langs,
  settings,
  catalog,
  catalogError,
  catalogBusy,
  onRefresh,
  onAdd,
  busy,
  player,
  onClose,
}: {
  langs: Lang[];
  settings: Settings;
  catalog?: CatalogVoice[];
  catalogError?: string;
  catalogBusy: boolean;
  onRefresh: () => void;
  onAdd: (id: string, lang: Lang) => Promise<void>;
  busy?: string;
  player: ReturnType<typeof usePlayer>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"account" | "id">("account");
  const [query, setQuery] = useState("");
  const [lang, setLang] = useState<Lang | "all">("all");
  const [manualId, setManualId] = useState("");
  const [manualLang, setManualLang] = useState<Lang>(langs[0] ?? "fr");

  const has = (id: string, l: Lang) => settings.voices.some((v) => v.id === id && v.lang === l);
  const q = query.trim().toLowerCase();
  const list = (catalog ?? []).filter(
    (v) =>
      (lang === "all" || v.languages.includes(lang)) &&
      (!q || [v.name, v.description, v.accent, v.gender, v.useCase, v.category].some((x) => x?.toLowerCase().includes(q))),
  );

  return (
    <Sheet
      title="Ajouter une voix"
      subtitle="Choisissez une voix de votre compte ElevenLabs, ou collez son identifiant. Une voix de la bibliothèque publique doit d'abord être ajoutée à « My Voices »."
      onClose={onClose}
    >
      <div className="px-6 pt-4 pb-3 flex flex-col gap-3 border-b border-outline-variant/20 sticky top-0 bg-surface-container-lowest z-10">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "account", label: "Mes voix ElevenLabs" },
            { value: "id", label: "Par identifiant" },
          ]}
        />
        {tab === "account" && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex-1 min-w-[12rem] flex items-center gap-2 bg-surface-container-low border border-outline-variant/40 rounded-lg px-3 focus-within:border-primary/70">
              <Icon name="search" className="text-[18px] text-outline" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Nom, accent, style…"
                className="flex-1 bg-transparent py-2 text-[13px] text-on-surface placeholder:text-outline focus:outline-none"
                autoFocus
              />
            </label>
            <Segmented size="sm" value={lang} onChange={setLang} options={[{ value: "all" as const, label: "Toutes" }, ...langs.map((l) => ({ value: l, label: LANGS[l].short }))]} />
            <Action icon="refresh" busy={catalogBusy} title="Relire la liste du compte" onClick={onRefresh} />
          </div>
        )}
      </div>

      {tab === "account" ? (
        <div className="px-6 pb-6">
          {catalogError && (
            <div className="pt-4">
              <Empty icon="cloud_off">{catalogError}</Empty>
            </div>
          )}
          {!catalog && !catalogError && (
            <div className="pt-4">
              <Empty icon="hourglass_top">Lecture des voix du compte…</Empty>
            </div>
          )}
          {catalog && list.length === 0 && (
            <div className="pt-4">
              <Empty icon="search_off">Aucune voix ne correspond.</Empty>
            </div>
          )}
          <ul className="divide-y divide-outline-variant/15">
            {list.map((v) => (
              <li key={v.id} className="py-4 flex flex-col gap-2">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-on-surface">{v.name}</span>
                      {v.category && <Chip>{CATEGORY[v.category] ?? v.category}</Chip>}
                    </div>
                    <div className="text-xs text-on-surface-variant mt-0.5">{[describeVoice(v), tr(USE, v.useCase)].filter(Boolean).join(" · ")}</div>
                    {v.description && <div className="text-xs text-outline mt-0.5 line-clamp-2">{v.description}</div>}
                    {v.languages.length > 0 && (
                      <div className="text-[11px] font-metric-mono-sm text-outline mt-1">
                        {v.languages
                          .slice(0, 8)
                          .map((l) => (l in LANGS ? `${LANGS[l as Lang].flag} ${LANGS[l as Lang].short}` : l.toUpperCase()))
                          .join("  ")}
                        {v.languages.length > 8 ? `  +${v.languages.length - 8}` : ""}
                      </div>
                    )}
                  </div>
                  {v.previewUrl && (
                    <Action
                      icon={player.playing === `sample-${v.id}` ? "stop_circle" : "play_circle"}
                      title={player.playing === `sample-${v.id}` ? "Arrêter" : "Échantillon ElevenLabs (gratuit)"}
                      onClick={() => void player.play(`sample-${v.id}`, v.previewUrl!)}
                    />
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {langs.map((l) =>
                    has(v.id, l) ? (
                      <span key={l} className="inline-flex items-center gap-1 px-2 py-1 text-xs text-secondary">
                        <Icon name="check" className="text-[15px]" />
                        {LANGS[l].short} ajoutée
                      </span>
                    ) : (
                      <Action key={l} tone="outline" icon="add" busy={busy === `add-${v.id}-${l}`} onClick={() => void onAdd(v.id, l)}>
                        {LANGS[l].flag} {LANGS[l].short}
                      </Action>
                    ),
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="px-6 py-6 flex flex-col gap-5">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-on-surface">Identifiant de la voix</span>
            <span className="text-[13px] text-on-surface-variant">Dans ElevenLabs : Voices → la voix → « Copy voice ID ». Le serveur vérifie qu'elle est bien dans votre compte.</span>
            <input
              value={manualId}
              onChange={(e) => setManualId(e.target.value.trim())}
              placeholder="ex. 21m00Tcm4TlvDq8ikWAM"
              spellCheck={false}
              className="mt-1 bg-surface-container-low border border-outline-variant/40 rounded-lg px-3 py-2 font-metric-mono-sm text-[13px] text-on-surface placeholder:text-outline focus:outline-none focus:border-primary/70"
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold text-on-surface">Langue</span>
            <Segmented value={manualLang} onChange={setManualLang} options={langs.map((l) => ({ value: l, label: `${LANGS[l].flag} ${LANGS[l].label}` }))} />
          </div>
          <div>
            <Action tone="primary" icon="add" disabled={manualId.length < 8 || has(manualId, manualLang)} busy={busy === `add-${manualId}-${manualLang}`} onClick={() => void onAdd(manualId, manualLang)}>
              {has(manualId, manualLang) ? "Déjà ajoutée" : "Vérifier et ajouter"}
            </Action>
          </div>
        </div>
      )}
    </Sheet>
  );
}
