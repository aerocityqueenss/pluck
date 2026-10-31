# Pluck in a container: Node 24, Chrome, ffmpeg, nothing else.
# Build:  docker build -f deploy/Dockerfile -t pluck .
# Run:    docker run --rm -p 7777:7777 -e PLUCK_PASSWORD=change-me pluck
#
# Chrome is the reason this image is Debian-sized rather than Alpine-sized: it needs the
# real glibc build, and Pluck launches it as a child process, not through a browser library.
FROM node:24-bookworm-slim

# Chrome's shared-library dependencies, plus ffmpeg for HLS/DASH remuxing.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg ffmpeg \
      fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
      libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 \
      libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
    && curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

ENV PLUCK_CHROME=/usr/bin/google-chrome-stable \
    PLUCK_NO_SANDBOX=1 \
    HOST=0.0.0.0 \
    PORT=7777 \
    PLUCK_MAX_SESSIONS=1 \
    PLUCK_SESSION_SECONDS=300

WORKDIR /app
COPY package.json README.md ./
COPY server ./server
COPY public ./public
COPY deploy ./deploy

# Chrome profiles and in-flight downloads live here; mount it if you want them to survive.
VOLUME ["/tmp"]

EXPOSE 7777
CMD ["bash", "deploy/run-container.sh"]
