/** Contrat de l'authentification entre le serveur et les quatre interfaces (D17). */
import { z } from "zod";

export const AccountRoleSchema = z.enum(["admin", "lecturer"]);
export type AccountRole = z.infer<typeof AccountRoleSchema>;

export interface AccountView {
  id: string;
  username: string;
  role: AccountRole;
}

/** GET /api/auth/me — qui est connecté, et ce que l'interface doit demander. */
export interface MeResponse {
  account: AccountView | null;
}

export const LoginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

/** Un mot de passe court est le maillon faible de tout le reste. */
export const PasswordSchema = z.string().min(10).max(200);

export const CreateAccountSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9._-]+$/, "lettres, chiffres, point, tiret ou souligné"),
  password: PasswordSchema,
  role: AccountRoleSchema,
});

/** GET|POST /api/admin/code — le code de séance et l'adresse à mettre dans le QR. */
export interface RoomCodeResponse {
  code: string;
  expiresAt: string;
  /** Adresse complète, code compris : c'est elle qu'encode le QR code. */
  joinUrl: string;
}

/** GET /api/admin/code : `null` tant qu'aucune séance n'est ouverte — ce n'est pas une erreur. */
export interface CurrentCodeResponse {
  current: RoomCodeResponse | null;
}

export const RotateCodeSchema = z.object({
  /** Durée de validité, en heures. */
  hours: z.number().int().min(1).max(72).optional(),
});
