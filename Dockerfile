# Multi-stage production Dockerfile for WASHROOM Hostel Laundry Management
FROM node:24-alpine AS builder

WORKDIR /app

# Enable corepack and install pnpm
RUN npm install -g pnpm@12

# Copy monorepo manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY artifacts/api-server/package.json ./artifacts/api-server/
COPY artifacts/hostel-laundry/package.json ./artifacts/hostel-laundry/
COPY artifacts/mockup-sandbox/package.json ./artifacts/mockup-sandbox/
COPY lib/api-client-react/package.json ./lib/api-client-react/
COPY lib/api-spec/package.json ./lib/api-spec/
COPY lib/api-zod/package.json ./lib/api-zod/
COPY lib/db/package.json ./lib/db/
COPY scripts/package.json ./scripts/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy all source files
COPY . .

# Approve builds & compile all libs, API server and frontend SPA
RUN pnpm approve-builds --all && pnpm run build

# Runner stage
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# Install pnpm for running db push migrations if needed
RUN npm install -g pnpm@12

# Copy built artifacts and runtime dependencies
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=builder /app/artifacts/hostel-laundry/dist ./artifacts/hostel-laundry/dist
COPY --from=builder /app/lib/db ./lib/db

EXPOSE 5000

# Start unified API server which also serves the frontend SPA
CMD ["node", "artifacts/api-server/dist/index.mjs"]
