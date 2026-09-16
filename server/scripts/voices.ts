/**
 * Liste les voix ElevenLabs du compte, pour choisir ELEVENLABS_VOICE_ID.
 *
 *   npm run voices              # toutes, voix « premade » d'abord
 *   npm run voices -- fr        # filtre sur nom / langue / accent / catégorie
 *
 * Plan gratuit : seules les voix « premade » (intégrées) sont utilisables par l'API.
 * Les voix ajoutées depuis la Voice Library renvoient 402 tant que le compte n'est
 * pas au moins en plan Starter.
 */
import { loadConfig } from "../src/config";

const cfg = loadConfig();
if (!cfg.ELEVENLABS_API_KEY) {
  console.error("ELEVENLABS_API_KEY manquant dans .env");
  process.exit(1);
}
const filter = (process.argv[2] ?? "").toLowerCase();

const res = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", { headers: { "xi-api-key": cfg.ELEVENLABS_API_KEY } });
if (!res.ok) {
  console.error(`ElevenLabs ${res.status} : ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const { voices } = (await res.json()) as {
  voices: { voice_id: string; name: string; category?: string; labels?: Record<string, string> }[];
};

const rows = voices
  .map((v) => ({
    id: v.voice_id,
    name: v.name,
    cat: v.category ?? "",
    lang: v.labels?.language ?? "",
    accent: v.labels?.accent ?? "",
    tags: [v.labels?.gender, v.labels?.age, v.labels?.use_case ?? v.labels?.description].filter(Boolean).join(", "),
  }))
  .filter((r) => !filter || `${r.name} ${r.lang} ${r.accent} ${r.cat} ${r.tags}`.toLowerCase().includes(filter))
  .sort((a, b) => Number(b.cat === "premade") - Number(a.cat === "premade") || a.name.localeCompare(b.name));

if (!rows.length) {
  console.log("Aucune voix ne correspond.");
  process.exit(0);
}
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  const free = r.cat === "premade" ? "gratuit " : "payant* ";
  console.log(`${r.id}  ${free} ${r.name.padEnd(w)}  ${r.lang.padEnd(4)} ${r.accent.padEnd(12)} ${r.tags}`);
}
console.log(`\n${rows.length} voix. Copiez l'identifiant (première colonne) dans ELEVENLABS_VOICE_ID, puis redémarrez le serveur.`);
console.log("* voix de la Voice Library : plan Starter ou supérieur requis pour l'API.");
