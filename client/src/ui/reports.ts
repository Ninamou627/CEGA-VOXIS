/** Les cinq causes que l'apprenant peut signaler, mises en mots pour le formateur. */
import type { ReportKind } from "../../../shared/protocol";

export const REPORT_LABEL: Record<ReportKind, { emoji: string; label: string; icon: string }> = {
  transcription: { emoji: "📝", label: "Mauvaise transcription", icon: "edit_note" },
  translation: { emoji: "🌐", label: "Mauvaise traduction", icon: "translate" },
  slow: { emoji: "🐌", label: "Traduction trop lente", icon: "hourglass_top" },
  voice: { emoji: "🔊", label: "Voix peu naturelle", icon: "record_voice_over" },
  audio: { emoji: "🎤", label: "Mauvais audio", icon: "mic_off" },
};
