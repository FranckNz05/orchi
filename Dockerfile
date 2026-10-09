# Image de production Afripaie.
#
# Deux etages : le premier compile, le second n'embarque que le resultat et les
# dependances de production. L'image finale ne contient ni TypeScript, ni
# Vitest, ni les sources — ce qui reduit la surface autant que la taille.

# --- Etage 1 : compilation ---------------------------------------------------
FROM node:22-slim AS build

WORKDIR /app

# `prisma generate` a besoin d'OpenSSL pour choisir son moteur binaire. Sans
# lui, la generation reussit mais produit un client qui echoue au demarrage.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Les dependances sont copiees seules d'abord : tant que package-lock.json ne
# change pas, cette couche est reutilisee et l'installation n'est pas rejouee.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Le provider Prisma est une chaine litterale dans le schema, il ne peut pas
# etre lu depuis l'environnement. On l'aligne sur DATABASE_URL avant de
# generer — voir scripts/set-db-provider.mjs.
ARG DATABASE_URL=postgresql://build/placeholder
ENV DATABASE_URL=$DATABASE_URL
RUN node scripts/set-db-provider.mjs \
    && npx prisma generate \
    && npm run build

# --- Etage 2 : execution -----------------------------------------------------
FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Le schema et les migrations servent au demarrage (`prisma db push`), le client
# genere est repris tel quel plutot que regenere.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# `GET /docs` sert INTEGRATION.md en Markdown aux clients d'API. Sans ce
# repertoire dans l'image, la route repond 404 — ce que l'exclusion initiale du
# .dockerignore avait provoque.
COPY --from=build /app/docs ./docs
COPY --from=build /app/scripts/set-db-provider.mjs ./scripts/set-db-provider.mjs

# Le conteneur ne tourne pas en root. Une faille applicative ne doit pas donner
# les pleins pouvoirs sur le systeme de fichiers de l'image.
USER node

EXPOSE 3000

# Pas de HEALTHCHECK ici : c'est docker-compose qui le definit, au plus pres de
# la topologie reelle.
CMD ["node", "dist/src/index.js"]
