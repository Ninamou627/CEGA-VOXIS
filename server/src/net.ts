/**
 * Adresses IP du PC de salle, les vraies d'abord.
 *
 * Un PC de développement porte souvent des interfaces virtuelles (WSL, Hyper-V,
 * Docker, partage de connexion) qu'un téléphone ne peut pas joindre. On les classe
 * après les interfaces physiques, et on écarte le lien local (169.254.x).
 */
import os from "node:os";

export interface LanIp {
  address: string;
  iface: string;
  virtual: boolean;
}

const VIRTUAL = /vethernet|wsl|hyper-v|virtualbox|vmware|docker|vmnet|npcap|loopback|tailscale|zerotier|hamachi/i;

export function lanIps(): LanIp[] {
  const out: LanIp[] = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal || i.address.startsWith("169.254.")) continue;
      // Le nom de l'interface est le critère ; les plages d'adresses ne le sont pas (un
      // Wi-Fi d'entreprise est souvent en 172.16.x). Seule exception sûre : 192.168.137.x,
      // le partage de connexion Windows.
      const virtual = VIRTUAL.test(iface) || i.address.startsWith("192.168.137.");
      out.push({ address: i.address, iface, virtual });
    }
  }
  return out.sort((a, b) => Number(a.virtual) - Number(b.virtual));
}

/** La meilleure adresse pour un téléphone de la salle, ou undefined. */
export function lanIp(): string | undefined {
  return lanIps()[0]?.address;
}
