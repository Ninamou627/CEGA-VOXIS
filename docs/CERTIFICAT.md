# Certificat TLS de la salle

Pourquoi c'est bloquant : le micro des téléphones (`getUserMedia`, pour les questions)
exige un contexte sécurisé, et une page HTTPS ne peut ouvrir qu'un WebSocket WSS. Sur
une adresse de LAN, qui n'est pas `localhost`, cela veut dire un **vrai certificat**.
Installer une autorité maison sur trente téléphones n'est pas praticable.

La solution : un nom de domaine réservé au projet, **`institutcega.fr`**, dont
l'enregistrement A public pointe vers l'IP **privée** du PC de salle, et un certificat
Let's Encrypt obtenu par challenge **DNS-01** (jamais HTTP-01 : le serveur n'est pas
joignable depuis Internet). Let's Encrypt ne certifie jamais une IP privée ; il certifie
un nom. Le certificat reste donc valable quand le PC change de réseau, et **hors ligne**,
pendant 90 jours. Les téléphones ouvrent `https://institutcega.fr` : port 443, pas de
numéro dans l'adresse.

Le DNS de `institutcega.fr` est chez **Hostinger**. Avec un jeton de leur API, tout se tient
seul : le serveur fait suivre le nom à l'IP du PC et renouvelle le certificat
(`server/src/domain.ts`).

## Mise en place (une fois)

1. **Jeton API Hostinger** : [hPanel → Profil → API](https://hpanel.hostinger.com/profile/api)
   → générer un jeton. Dans `.env` :

   ```
   HOSTINGER_API_TOKEN=…
   ```

   Ce jeton donne la main sur tout le compte Hostinger : il reste dans `.env` (ignoré par
   git), sur le PC de salle seulement.

2. **Répétition**, sur l'environnement de test de Let's Encrypt (rien n'est enregistré) :

   ```bash
   npm run cert:domain -- institutcega.fr --staging
   ```

3. **Le vrai certificat** :

   ```bash
   npm run cert:domain -- institutcega.fr
   ```

   Le script pointe `institutcega.fr` vers l'IP du PC (à la place de la page de parking
   Hostinger), pose le TXT `_acme-challenge`, attend qu'il soit visible sur les serveurs
   DNS de Hostinger, obtient le certificat dans `certs/`, retire le TXT, et affiche les
   lignes à mettre dans `.env` :

   ```
   PORT=443
   PUBLIC_URL=https://institutcega.fr
   TLS_CERT=certs/institutcega.fr.pem
   TLS_KEY=certs/institutcega.fr-key.pem
   ```

4. **Redémarrer le serveur** (`npm run dev` redémarre aussi Vite, qui lit le port dans
   `.env`), puis depuis un téléphone sur le Wi-Fi de la salle :
   `https://institutcega.fr/api/health` — cadenas normal, aucun avertissement. Ensuite la
   page apprenant, puis *Maintenir pour poser une question* : le navigateur doit demander
   l'accès au micro.

**Port 443 sous Windows** : aucun droit administrateur n'est nécessaire. Le pare-feu doit
laisser entrer Node : la règle « Node.js JavaScript Runtime », créée au premier lancement,
vaut pour tous les ports, mais seulement pour le profil réseau accepté ce jour-là (Public
ou Privé). Un logiciel qui occupe déjà le 443 (IIS, partage de VM de VMware) empêche le
serveur de démarrer : le journal le dit (`EADDRINUSE`).

## Ensuite, rien à faire

- **Le PC change de réseau** : au démarrage, puis chaque minute, le serveur compare l'IP
  du PC à l'enregistrement A et le corrige (TTL de 2 min). Il retire aussi tout
  enregistrement AAAA du nom : un téléphone en IPv6 le préférerait à l'IP du PC. Juste
  après un changement, les caches DNS peuvent mettre quelques minutes à suivre : le
  tableau de bord le dit.
- **Le certificat** se renouvelle seul 30 jours avant l'échéance et se recharge sans
  redémarrer. S'il reste moins de 14 jours, le tableau de bord passe au rouge :
  `npm run cert:domain` montre l'erreur.
- **Un seul PC porte le jeton.** Deux serveurs avec le même nom et le même jeton se
  disputeraient l'enregistrement A. Pour un second PC, un sous-domaine
  (`npm run cert:domain -- dev.institutcega.fr`).

Le tableau de bord (checklist *Certificat et adresse de la salle*) signale tout ce qui
empêcherait un téléphone d'entrer : certificat qui ne couvre pas le nom ou qui expire,
nom qui pointe ailleurs que sur le PC, nom que le DNS du réseau ne résout pas.

## Sans jeton API

Même commande : `npm run cert:domain -- institutcega.fr`. Le script affiche
l'enregistrement TXT à créer dans hPanel (*Domaines → institutcega.fr → DNS / Serveurs de
noms*), attend qu'il soit visible, puis obtient le certificat. L'enregistrement A
(`@` → IP du PC) se crée et se corrige aussi à la main, à chaque changement de réseau,
et le renouvellement est à refaire avant l'échéance (tous les 60 jours, 5 minutes).

## Pannes

**« ne se résout pas sur ce réseau » — la protection contre le DNS rebinding.** Certains
routeurs et pare-feu (Fritz!Box, OpenWrt/dnsmasq, pfSense, quelques box opérateur, DNS
filtrants d'entreprise) refusent une réponse DNS publique qui contient une IP privée.
Symptôme : le téléphone « ne trouve pas le site ». Parade : ajouter `institutcega.fr` à la
liste blanche (Fritz!Box → *Réseau domestique → Paramètres réseau → Exceptions DNS
rebind*), ou faire résoudre le nom par le DNS local de la borne. Test rapide depuis le PC :
`nslookup institutcega.fr` doit répondre l'IP du PC.

**Réseau de salle sans Internet.** Le certificat reste valable hors ligne, mais les
téléphones doivent résoudre le nom : il faut alors une entrée DNS locale sur la borne
(`institutcega.fr` → IP du PC).

## En développement, sans domaine

```bash
npm run cert:dev
```

Certificat auto-signé pour les IP actuelles du PC : le téléphone affiche un avertissement,
on l'accepte, et le micro fonctionne. À refaire à chaque changement de réseau (le tableau
de bord le signale). Suffisant pour développer, inutilisable en salle.
