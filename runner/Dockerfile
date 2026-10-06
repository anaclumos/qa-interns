FROM node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      e2fsprogs \
      ffmpeg \
      procps \
      ripgrep \
      libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 \
      libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0t64 libpangocairo-1.0-0 \
      libpango-1.0-0 libatk1.0-0t64 libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 \
      libxrender1 libasound2t64 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 \
      libnss3-tools libnspr4 libatk-bridge2.0-0t64 libdrm2 libxkbcommon0 \
      libatspi2.0-0t64 libcups2t64 libxshmfence1 libgbm1 \
      fonts-noto-cjk fonts-noto-color-emoji fonts-freefont-ttf fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund \
      agent-browser@0.38.1 \
      @agentclientprotocol/claude-agent-acp@0.81.2 \
      @agentclientprotocol/codex-acp@1.13.1 \
 && npm cache clean --force

RUN HOME=/opt/agent-browser agent-browser install \
 && ln -s /opt/agent-browser/.agent-browser/browsers/chrome-*/chrome /usr/local/bin/chrome \
 && chrome --version

RUN curl -fsSLo /tmp/cursor-agent.tar.gz https://downloads.cursor.com/lab/2026.09.26-dd393fe/linux/x64/agent-cli-package.tar.gz \
 && echo "8085fd120f5c71f4eae7fea26a043718e5644e3071e4fab3220a0e58c51f9593  /tmp/cursor-agent.tar.gz" | sha256sum -c \
 && mkdir /opt/cursor-agent \
 && tar -xzf /tmp/cursor-agent.tar.gz --no-same-owner --strip-components=1 -C /opt/cursor-agent \
 && rm /tmp/cursor-agent.tar.gz \
 && ln -s /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent

RUN curl -fsSLo /usr/local/bin/grok https://x.ai/cli/grok-1.0.41-linux-x86_64 \
 && echo "9ce03ed23e16ea01072b4496263d6213a27899e1e3e107f008d36edf82e70407  /usr/local/bin/grok" | sha256sum -c \
 && chmod 0755 /usr/local/bin/grok \
 && mkdir /etc/grok \
 && printf '%s\n' 'allowed_mcp_servers = []' '[managed_mcps]' 'enabled = false' 'gateway_tools_enabled = false' '[features]' 'telemetry = false' '[telemetry]' 'trace_upload = false' > /etc/grok/requirements.toml

RUN curl -fsSLo /tmp/opencode.tar.gz https://github.com/anomalyco/opencode/releases/download/v1.18.34/opencode-linux-x64-baseline.tar.gz \
 && echo "24b0d458d21ef548b2752166303defcf7f4945b049fb4876ab78dfaf86d81b27  /tmp/opencode.tar.gz" | sha256sum -c \
 && tar -xzf /tmp/opencode.tar.gz --no-same-owner -C /usr/local/bin opencode \
 && rm /tmp/opencode.tar.gz

ARG QA_UID
ARG QA_GID
RUN if [ -z "$QA_UID" ] || [ -z "$QA_GID" ] || [ "$QA_UID" -eq 0 ] || [ "$QA_GID" -eq 0 ]; then echo "QA_UID and QA_GID must be set to a uid and gid other than 0 (root). Build the runner image with qa-interns doctor, or pass --build-arg QA_UID=<uid> --build-arg QA_GID=<gid>." >&2; exit 1; fi
RUN userdel --remove node \
 && groupadd --non-unique --gid "$QA_GID" qa \
 && useradd --non-unique --uid "$QA_UID" --gid qa --create-home --home-dir /home/qa --shell /bin/bash qa \
 && mkdir -p /qa/out \
 && chown qa:qa /qa/out

COPY proxy.mjs relay.mjs /opt/qa-interns/

ENV AGENT_BROWSER_DOWNLOAD_PATH=/qa/out/downloads \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chrome \
    AGENT_BROWSER_NO_AUTO_DIALOG=1 \
    AGENT_BROWSER_PROXY=direct:// \
    AGENT_BROWSER_SCREENSHOT_DIR=/qa/out/screenshots

USER qa
WORKDIR /qa/out
CMD ["sleep", "infinity"]
