FROM node:22-bookworm AS builder

ARG QDRANT_MCP_BRANCH

WORKDIR /src

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        python3 \
        make \
        g++

RUN git -c advice.detachedHead=false clone --depth 1 \
    --branch "${QDRANT_MCP_BRANCH}" \
    https://github.com/pnearing/qdrant-mcp-server.git \
    /src/qdrant-mcp-server

WORKDIR /src/qdrant-mcp-server 

RUN npm ci

# Run the test suite before producing the runtime image.
RUN npm test -- --run

RUN npm run build

# Remove development-only packages after compiling.
RUN npm prune --omit=dev --ignore-scripts


FROM node:22-bookworm-slim AS runtime


WORKDIR /app

# Git is needed at runtime for the Git-history indexing features.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /src/qdrant-mcp-server/build ./build
COPY --from=builder /src/qdrant-mcp-server/node_modules ./node_modules
COPY --from=builder /src/qdrant-mcp-server/package.json ./package.json

EXPOSE 3000

CMD ["node", "build/index.js"]
