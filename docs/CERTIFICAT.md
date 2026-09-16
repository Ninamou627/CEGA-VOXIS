# Certificat TLS sur l'IP du LAN

Pourquoi c'est bloquant : le micro des téléphones (`getUserMedia`, pour les questions)
exige un contexte sécurisé, et une page HTTPS ne peut ouvrir qu'un WebSocket WSS. Sur
une adresse de LAN, qui n'est pas `localhost`, cela veut dire un **vrai certificat**.
Installer une autorité maison sur trente téléphones n'est pas praticable.

La solution : un domaine que nous possédons, un enregistrement A public qui pointe vers
l'IP **privée** du PC de salle, un certificat Let's Encrypt obtenu par challenge
**DNS-01** (jamais HTTP-01 : le serveur n'est pas joignable depuis Internet). Le
certificat est ensuite valide **hors ligne**, dans la salle, pendant 90 jours.

## 1. IP fixe pour le PC de salle

Sur la borne Wi-Fi / le routeur de salle, réservez une IP pour l'adresse MAC de la carte
Ethernet du PC — par exemple `192.168.50.10`. Notez-la : elle va dans le DNS.

## 2. Enregistrement DNS

Dans la zone du domaine (OVH, Gandi, Cloudflare, Infomaniak…) :

```
salle.mondomaine.fr.   A   192.168.50.10
```

Oui, un DNS public peut pointer vers une IP privée. C'est légal et courant.

**Piège n° 1 — la « protection contre le DNS rebinding ».** Certains routeurs (Fritz!Box,
OpenWrt/dnsmasq, pfSense, quelques box opérateur) refusent de transmettre une réponse
DNS publique contenant une IP privée. Symptôme : le téléphone « ne trouve pas le site ».
Parade : ajouter le domaine à la liste blanche du routeur (Fritz!Box → *Réseau
domestique → Paramètres réseau → Exceptions DNS rebind*), ou faire résoudre le nom par
le DNS local de la borne.

## 3. Obtenir le certificat (DNS-01, validation manuelle)

La méthode qui marche avec n'importe quel hébergeur DNS, sans API :

```bash
certbot certonly --manual --preferred-challenges dns -d salle.mondomaine.fr
```

Certbot affiche une valeur à mettre dans un enregistrement TXT :

```
_acme-challenge.salle.mondomaine.fr.   TXT   "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Créez-le, attendez la propagation (vérifiez avec `nslookup -type=TXT _acme-challenge.salle.mondomaine.fr`),
puis validez dans certbot. Les fichiers arrivent dans :

```
/etc/letsencrypt/live/salle.mondomaine.fr/fullchain.pem
/etc/letsencrypt/live/salle.mondomaine.fr/privkey.pem
```

Sous Windows, [win-acme](https://www.win-acme.com/) (`wacs.exe`, validation « manuelle DNS »)
fait la même chose ; ou `acme.sh` dans Git Bash.

**Renouvellement.** 90 jours. En manuel, refaire l'opération (5 min). Pour l'automatiser,
`acme.sh` ou le plugin certbot de votre hébergeur DNS (`certbot-dns-ovh`,
`certbot-dns-cloudflare`, …) qui pose le TXT tout seul.

## 4. Configurer le serveur

Dans `.env` :

```
TLS_CERT=/etc/letsencrypt/live/salle.mondomaine.fr/fullchain.pem
TLS_KEY=/etc/letsencrypt/live/salle.mondomaine.fr/privkey.pem
PUBLIC_URL=https://salle.mondomaine.fr:8787
```

Le serveur passe en HTTPS + WSS automatiquement, et le QR code du tableau de bord
encode `PUBLIC_URL`. Pour un port 443 sans le `:8787` dans l'URL : `PORT=443` (droits
administrateur requis sous Linux, ou `setcap 'cap_net_bind_service=+ep' $(which node)`).

## 5. Vérifier

Depuis un téléphone sur le Wi-Fi de salle, ouvrir `https://salle.mondomaine.fr:8787/api/health` :
le cadenas doit être vert, sans avertissement. Ensuite la page apprenant, puis
*Maintenir pour poser une question* — le navigateur doit demander l'accès au micro.

Le tableau de bord affiche un bandeau rouge tant que le serveur est en HTTP.

## En développement, sans domaine

```bash
VITE_HTTPS=1 npm run dev:client
```

Vite génère un certificat auto-signé : le téléphone affiche un avertissement, on
l'accepte, et le micro fonctionne. Suffisant pour développer, inutilisable en salle.
