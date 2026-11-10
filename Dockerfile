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

# Pre-create the data dir owned by the runtime user so a fresh named volume
# inherits that ownership.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

VOLUME ["/app/data"]
CMD ["node", "src/index.js"]
