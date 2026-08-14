# CareerRat — agentic job-search workspace
# Zero runtime dependencies; node:24-slim is sufficient for all core CLIs.
#
# NOTE: playwright (used by capture scripts) is a devDependency and is NOT
# installed in this image. If you need capture scripts, run them outside the
# container or build a separate image with:
#   RUN npm ci --include=dev && npx playwright install --with-deps chromium

FROM node:24-slim

LABEL org.opencontainers.image.title="careerrat" \
      org.opencontainers.image.description="Agentic job-search workspace" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy the whole repo context (see .dockerignore for exclusions).
# No `npm install` is needed — all core CLIs are pure Node.js ESM with no
# third-party runtime dependencies.
COPY . .

# Default command: show the help screen.
ENTRYPOINT ["node", "bin/careerrat.mjs"]
CMD ["help"]
