# Déployer CEGA Voxis sur un serveur

Depuis D17, le serveur vit sur Internet : c'est lui qui rend possibles les auditeurs à
distance, la salle d'hôtel dont on ne maîtrise pas le Wi-Fi, et l'application Windows.

Trois conteneurs sur une seule machine : le serveur de salle, sa base PostgreSQL, et Caddy
qui termine le TLS devant eux. Tout est décrit dans `docker-compose.prod.yml` — rien n'est
propre à un hébergeur, le même fichier tournerait ailleurs, ou chez un client.

## 1. La machine

Un VPS en Europe suffit largement. Mesuré sur le serveur de développement au repos :
**92 Mo de mémoire, 1 % de processeur**. Même en séance, avec trente téléphones, on reste
loin de 2 Go.

Chez Hetzner, un **CPX11** (2 vCPU, 2 Go, 40 Go NVMe) à ~5,50 €/mois convient, plus ~0,55 €
pour l'adresse IPv4. Localisations européennes : Falkenstein, Nuremberg, Helsinki. Prenez
**Ubuntu LTS**.

Le trafic n'est pas un sujet : trente auditeurs à 64 kbit/s font environ 6 Go par journée
de formation, soit ~120 Go pour vingt jours — loin du téraoctet inclus.

## 2. Préparer le serveur

Connectez-vous en SSH par clé (jamais par mot de passe), puis :

```bash
# Mises à jour de sécurité appliquées toutes seules
sudo apt update && sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades

# Pare-feu : SSH, HTTP, HTTPS, rien d'autre
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable

# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # se déconnecter puis se reconnecter
```

La base de données n'est jamais exposée : elle n'écoute que sur le réseau interne des
conteneurs (`expose`, pas `ports`).

## 3. Le nom de domaine

Dans hPanel, DNS de `institutcega.fr` :

```
@   A      <IP publique du serveur>
@   AAAA   <IPv6 du serveur>        (Hetzner en fournit une ; facultatif)
```

Vérifiez avant de continuer — Caddy échouera à obtenir le certificat si le nom ne pointe
pas encore vers la machine :

```bash
dig +short institutcega.fr
```

> `server/src/domain.ts`, `npm run cert:domain` et `HOSTINGER_API_TOKEN` ne servent plus ici :
> ils existaient pour faire suivre un nom à l'**IP privée** d'un PC de salle, par challenge
> DNS-01. Un serveur hébergé a une IP publique fixe, et Caddy obtient le certificat par
> HTTP-01, tout seul. Ce code reste la réponse pour la boîte de salle de l'Horizon 2.

## 4. Installer

```bash
git clone <dépôt> voxis && cd voxis
```

Créez le `.env` à côté de `docker-compose.prod.yml`. Il n'est jamais dans git :

```
DOMAIN=institutcega.fr
POSTGRES_PASSWORD=<une longue chaîne au hasard>

SESSION_ID=FORMATION-01
SRC_LANG=en
TARGET_LANGS=fr

ADMIN_USER=admin
# Vide : le serveur tire un mot de passe au hasard et l'affiche une fois dans son journal.
ADMIN_PASSWORD=

STT_PROVIDER=assemblyai
MT_PROVIDER=anthropic
TTS_PROVIDER=elevenlabs
ASSEMBLYAI_API_KEY=…
ANTHROPIC_API_KEY=…
ELEVENLABS_API_KEY=…
ELEVENLABS_VOICE_ID=…
```

Puis :

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f app
```

Au premier démarrage, le journal affiche le mot de passe du compte d'administration —
**une seule fois**. Notez-le.

## 5. Vérifier

```bash
curl -s https://institutcega.fr/api/health | head -c 200
```

Cadenas normal, sans avertissement. Puis, dans un navigateur : `/dashboard`, connexion,
page **Séance**, **Ouvrir une séance**. Le QR code mène à la page apprenant.

Depuis un téléphone en données mobiles — pas en Wi-Fi, pour être sûr de passer par
Internet : scannez, choisissez une langue, écoutez. Le micro doit être proposé quand vous
maintenez le bouton de question.

## 6. Publier l'application Windows

L'installeur et son flux de mise à jour vivent dans `data/telechargements`, à l'intérieur du
volume déjà sauvegardé. Depuis la machine de développement :

```bash
npm run dist -w desktop     # produit desktop/release/
scp desktop/release/CEGA_VOXIS_Setup_*.exe \
    desktop/release/CEGA_VOXIS_Setup_*.exe.blockmap \
    desktop/release/latest.yml \
    <serveur>:voxis/data/telechargements/
```

La page `https://institutcega.fr/telecharger` s'actualise toute seule : elle lit la version,
la taille et l'empreinte SHA-256 du dernier fichier déposé. Les postes déjà installés voient
la nouvelle version au lancement suivant, ou dans les 6 h.

## 7. Mettre à jour le serveur

```bash
git pull && docker compose -f docker-compose.prod.yml up -d --build
```

Quelques secondes de coupure : les migrations de base s'appliquent au démarrage, et les
participants se reconnectent tout seuls. **Jamais pendant une séance.**

## 8. Sauvegarder

Deux choses à garder : la base (comptes, codes) et le volume `data` (réglages, compteurs de
long terme, `metrics.jsonl` — la mémoire longue du projet).

```bash
# Base de données
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U voxis voxis | gzip > "voxis-$(date +%F).sql.gz"

# Fichiers persistants
docker run --rm -v voxis_data:/data -v "$PWD":/sortie alpine \
  tar czf "/sortie/data-$(date +%F).tar.gz" -C /data .
```

À mettre dans une tâche `cron` quotidienne, et à copier ailleurs que sur le serveur.

## Pannes

**Caddy n'obtient pas le certificat.** Le nom ne pointe pas encore vers la machine, ou le
port 80 est fermé (le challenge HTTP-01 en a besoin). `docker compose -f
docker-compose.prod.yml logs caddy` le dit.

**Le serveur redémarre en boucle.** Presque toujours la base : `logs app` affiche
« base de données injoignable ou migration en échec ».

**Le tableau de bord annonce « HTTP ».** `TRUST_PROXY` doit valoir `true` et `PUBLIC_URL`
commencer par `https://` : c'est ainsi que le serveur sait que Caddy termine le TLS devant
lui, alors qu'il parle HTTP en interne.

## En développement, rien ne change

`npm run db:up` puis `npm run dev`, comme avant. Le `docker-compose.yml` de la racine ne
lance que PostgreSQL ; celui de production, `docker-compose.prod.yml`, lance tout.
