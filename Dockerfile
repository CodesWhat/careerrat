# CareerRat — agentic job-search workspace
#
# NOTE: playwright (used by capture scripts) is a devDependency and is NOT
# installed in this image. If you need capture scripts, run them outside the
# container or build a separate image with:
#   RUN npm ci --include=dev && npx playwright install --with-deps chromium

FROM node:24-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
#checkov:skip=CKV_DOCKER_2:This is a one-shot CLI image with no long-running service to probe.

LABEL org.opencontainers.image.title="careerrat" \
    org.opencontainers.image.description="Agentic job-search workspace" \
    org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Install only the root runtime dependencies. Desktop, website, docs, browser,
# and test dependencies belong to other distribution paths.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --workspaces=false \
    && npm cache clean --force \
    && chown -R node:node /app

# Copy the whole repo context (see .dockerignore for exclusions).
COPY --chown=node:node . .

USER node

# Default command: show the help screen.
ENTRYPOINT ["node", "bin/careerrat.mjs"]
CMD ["help"]