FROM inbox-zero-jev-base:local
LABEL org.opencontainers.image.revision="1781107fd7d0e1e714d239175fdb8663264e4d2b"
LABEL org.opencontainers.image.source="https://github.com/hrq-chiuchi/inbox-zero"
USER root
WORKDIR /opt/inbox-zero-cli
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && test -d node_modules/ai-sdk-provider-codex-cli \
 && test -x node_modules/.bin/codex \
 && ln -s /opt/inbox-zero-cli/node_modules/ai-sdk-provider-codex-cli \
          /app/apps/web/node_modules/ai-sdk-provider-codex-cli \
 && ln -s /opt/inbox-zero-cli/node_modules/.bin/codex /usr/local/bin/codex \
 && /usr/local/bin/codex --version
WORKDIR /app
