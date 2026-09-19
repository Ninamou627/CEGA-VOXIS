/**
 * Navigation du bas. Les vues sont des onglets d'une même page : le lecteur audio
 * et le WebSocket vivent dans App et continuent pendant qu'on change de vue.
 */
import { Icon } from "../ui/Icon";

export type View = "listen" | "transcript" | "questions" | "channels";

export const TABS: { id: View; icon: string; label: string }[] = [
  { id: "listen", icon: "headphones", label: "Listen" },
  { id: "transcript", icon: "subtitles", label: "Transcript" },
  { id: "questions", icon: "live_help", label: "Ask Q&A" },
  { id: "channels", icon: "tune", label: "Channels" },
];

export function BottomNav({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-50 pb-safe bg-surface-container-low/85 backdrop-blur-xl shadow-[0_-1px_12px_rgba(0,0,0,0.5)]">
      <div className="flex justify-around items-center h-20 px-gutter-mobile">
        {TABS.map((t) => {
          const active = t.id === view;
          return (
            <button
              key={t.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onChange(t.id)}
              className={`flex flex-col items-center justify-center gap-1 min-w-[56px] min-h-[44px] transition-colors ${
                active ? "text-primary font-headline-sm" : "text-on-surface-variant hover:text-on-surface"
              }`}
            >
              <Icon name={t.icon} className="text-[24px]" />
              <span className="font-body-sm text-body-sm">{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
