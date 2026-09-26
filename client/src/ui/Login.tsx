/**
 * Écran de connexion de l'administration et du poste formateur (D17). Le même dans le
 * navigateur et dans l'application de bureau : c'est la même page, servie par le serveur.
 */
import { useState } from "react";
import { login, type AccountView } from "../lib/auth";
import { APP_NAME } from "./brand";
import { Icon } from "./Icon";
import { Logo } from "./Logo";

export interface LoginProps {
  /** Ce qu'on ouvre : « Administration » ou « Poste formateur ». */
  surface: string;
  onDone: (account: AccountView) => void;
  /** Message du serveur quand une session a expiré ou a été refusée. */
  notice?: string;
}

export function Login({ surface, onDone, notice }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !username || !password) return;
    setBusy(true);
    setError(undefined);
    try {
      onDone(await login(username, password));
    } catch (err) {
      setError((err as Error).message);
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  const field = "w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface placeholder:text-outline focus:outline-none focus:border-secondary/60";

  return (
    <div className="min-h-dvh flex items-center justify-center p-4 bg-surface">
      <form onSubmit={submit} className="w-full max-w-sm flex flex-col gap-5">
        <div className="flex flex-col items-center gap-2 text-center">
          <Logo className="w-9 h-9" />
          <span className="font-label-badge text-xs uppercase tracking-widest text-primary font-bold">{surface}</span>
          <h1 className="font-headline-lg text-2xl font-bold text-on-surface tracking-tight">{APP_NAME}</h1>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant/25 rounded-2xl p-5 shadow-xl flex flex-col gap-4">
          {notice && (
            <p className="text-[13px] text-on-surface-variant leading-relaxed flex items-start gap-2">
              <Icon name="info" className="text-[17px] shrink-0 mt-px" />
              {notice}
            </p>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-on-surface-variant font-medium">Identifiant</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              // eslint-disable-next-line jsx-a11y/no-autofocus -- la page n'a que ce champ
              autoFocus
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-on-surface-variant font-medium">Mot de passe</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className={field}
            />
          </label>

          {error && (
            <p role="alert" className="text-[13px] text-error leading-relaxed flex items-start gap-2">
              <Icon name="gpp_bad" className="text-[17px] shrink-0 mt-px" />
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !username || !password}
            className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-secondary text-on-secondary hover:bg-secondary-fixed font-headline-sm text-sm font-bold shadow-md transition-all active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
          >
            <Icon name={busy ? "hourglass_empty" : "login"} fill className="text-[20px]" />
            <span>{busy ? "Connexion…" : "Se connecter"}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
