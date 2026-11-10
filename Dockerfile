FROM node:22.23.4-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:22.23.4-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations

VOLUME ["/app/data"]
CMD ["node", "src/index.js"]
