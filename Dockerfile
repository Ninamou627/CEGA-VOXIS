# Image de production de CEGA Voxis (D17). Un seul processus : le serveur de salle sert
# l'API, le WebSocket et les quatre pages compilées. Caddy termine le TLS devant lui.
#
#   docker compose -f docker-compose.prod.yml up -d --build

# ---- compilation du client -----------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Les manifestes d'abord : cette couche ne change que si les dépendances changent.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY . .
RUN npm run build

# ---- exécution -----------------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev && npm cache clean --force

COPY shared/ shared/
COPY server/src/ server/src/
COPY --from=build /app/client/dist/ client/dist/

# Ce qui doit survivre à une mise à jour : réglages, compteurs de long terme, journal des
# mesures. Un volume est monté ici (docker-compose.prod.yml).
RUN mkdir -p data && chown -R node:node data
USER node

EXPOSE 8787
# Le serveur ne porte pas le certificat en production : Caddy s'en charge devant lui.
CMD ["node", "--import", "tsx", "server/src/index.ts"]
