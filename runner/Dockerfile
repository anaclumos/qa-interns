FROM node:24-trixie-slim

RUN --mount=type=tmpfs,target=/usr/share/doc \
    packages="ca-certificates curl ffmpeg procps ripgrep \
      libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 \
      libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0t64 libpangocairo-1.0-0 \
      libpango-1.0-0 libatk1.0-0t64 libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 \
      libxrender1 libasound2t64 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 \
      libnss3-tools libnspr4 libatk-bridge2.0-0t64 libdrm2 libxkbcommon0 \
      libatspi2.0-0t64 libcups2t64 libxshmfence1 libgbm1 \
      fonts-noto-cjk fonts-noto-color-emoji fonts-freefont-ttf fonts-liberation" \
 && if [ "$(dpkg --print-architecture)" = arm64 ]; then packages="$packages chromium"; fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends --download-only $packages \
 && for deb in /var/cache/apt/archives/*.deb; do \
      dpkg-deb --fsys-tarfile "$deb" | tar -t | while read -r path; do \
        case "$path" in */) mkdir -p "/$path";; esac; \
      done; \
    done \
 && apt-get install -y --no-install-recommends $packages \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund agent-browser@0.38.1 \
 && npm cache clean --force

RUN case "$(dpkg --print-architecture)" in \
      amd64) HOME=/opt/agent-browser agent-browser install \
        && ln -s /opt/agent-browser/.agent-browser/browsers/chrome-*/chrome /usr/local/bin/chrome ;; \
      arm64) printf '#!/bin/sh\nexec /usr/lib/chromium/chromium "$@" --window-size=1280,664\n' > /usr/local/bin/chrome \
        && chmod +x /usr/local/bin/chrome \
        && ln -s /etc/opt/chrome_for_testing/policies /etc/chromium/policies ;; \
    esac \
 && chrome --version

COPY package.json package-lock.json /opt/pi-acp/
RUN npm ci --prefix /opt/pi-acp --omit=dev --ignore-scripts --no-audit --no-fund \
 && ln -s /opt/pi-acp/node_modules/.bin/pi-acp /usr/local/bin/pi-acp \
 && npm cache clean --force

RUN userdel node \
 && groupadd --gid 1000 qa \
 && useradd --uid 1000 --gid qa --create-home --home-dir /home/qa --shell /bin/bash qa \
 && mkdir -p /qa/out \
 && chown qa:qa /qa/out

COPY proxy.mjs relay.mjs agent-browser /opt/qa-interns/
RUN ln -sf /opt/qa-interns/agent-browser /usr/local/bin/agent-browser

ENV AGENT_BROWSER_ARGS=--disable-component-extensions-with-background-pages \
    AGENT_BROWSER_DOWNLOAD_PATH=/qa/out/downloads \
    AGENT_BROWSER_EXECUTABLE_PATH=/usr/local/bin/chrome \
    AGENT_BROWSER_NO_AUTO_DIALOG=1 \
    AGENT_BROWSER_PROXY=direct:// \
    AGENT_BROWSER_SCREENSHOT_DIR=/qa/out/screenshots

USER qa
WORKDIR /qa/out
CMD ["sleep", "infinity"]
