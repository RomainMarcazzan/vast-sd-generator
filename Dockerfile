FROM node:22-alpine AS base

# --------------------
# Dependencies (prod only)
# --------------------
FROM base AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# --------------------
# Build
# --------------------
FROM base AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts ./
COPY tsconfig.json ./
COPY src ./src

# Prisma generate needs DATABASE_URL but does not connect
ARG DATABASE_URL="postgresql://dummy:dummy@dummy:5432/dummy"
ENV DATABASE_URL=$DATABASE_URL

RUN npx prisma generate
RUN npm run build

# --------------------
# Production
# --------------------
FROM base AS production
WORKDIR /app

RUN apk add --no-cache curl

# Prod dependencies
COPY --from=dependencies /app/node_modules ./node_modules

# Compiled app
COPY --from=build /app/dist ./dist

# Runtime config
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]

