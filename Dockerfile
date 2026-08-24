# ⚠️ DEPRECATED — not used by production.
# Railway builds this project with NIXPACKS and starts it with
# `npm run start:all` (see railway.json). This Dockerfile is unverified and
# predates the removal of the storefront and queue worker; see docker-compose.yml.
# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

# --- deps ---
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install

# --- build ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# --- runtime ---
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
EXPOSE 3000
CMD ["npm", "run", "start"]
