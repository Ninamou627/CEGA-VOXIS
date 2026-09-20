/** Carte du tableau de bord : en-tête à icône et titre, contenu libre. */
import type { ReactNode } from "react";
import { Icon } from "../../ui/Icon";

export function Card({ icon, title, right, children, className = "", tone = "secondary" }: { icon: string; title: string; right?: ReactNode; children: ReactNode; className?: string; tone?: "secondary" | "primary" | "tertiary" }) {
  const box = { secondary: "bg-secondary/15 text-secondary", primary: "bg-primary/10 text-primary", tertiary: "bg-tertiary/15 text-tertiary" }[tone];
  return (
    <section className={`bg-surface-container-lowest border border-outline-variant/25 rounded-2xl p-4 shadow-lg flex flex-col gap-3 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${box}`}>
            <Icon name={icon} className="text-[17px]" />
          </div>
          <h2 className="font-headline-sm text-xs font-bold uppercase tracking-wider text-on-surface truncate">{title}</h2>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}
