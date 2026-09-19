/** Vue pas encore dessinée : on le dit, et l'écoute continue derrière. */
import { Icon } from "../../ui/Icon";

export function Soon({ icon, title }: { icon: string; title: string }) {
  return (
    <div className="flex flex-col w-full px-gutter-mobile gap-space-md">
      <div className="flex flex-col items-center justify-center gap-space-sm bg-surface-container-low rounded-xl p-space-xl text-center shadow-lg">
        <div className="w-14 h-14 rounded-full bg-surface-container-high flex items-center justify-center text-primary">
          <Icon name={icon} className="text-[28px]" />
        </div>
        <span className="font-headline-sm text-headline-sm text-on-surface">{title}</span>
        <span className="font-body-sm text-body-sm text-on-surface-variant">Cette vue arrive bientôt. L'écoute continue en arrière-plan.</span>
      </div>
    </div>
  );
}
