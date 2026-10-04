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
      fonts-noto-cjk fonts-noto-color-emoji fonts-freefont-ttf \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund \
      agent-browser@0.38.1 \
      @automatalabs/pi-acp@0.9.4 \
 && npm cache clean --force

RUN HOME=/opt/agent-browser agent-browser install \
 && ln -s /opt/agent-browser/.agent-browser/browsers/chrome-*/chrome /usr/local/bin/chrome \
 && chrome --version

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
    AGENT_BROWSER_PROXY=direct:// \
    AGENT_BROWSER_SCREENSHOT_DIR=/qa/out/screenshots

USER qa
WORKDIR /qa/out
CMD ["sleep", "infinity"]
