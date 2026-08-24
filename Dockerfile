# ffmpeg 9 is the hard requirement: the concat demuxer's -recursion_depth
# option does not exist before it, and without that option a chained playlist
# is hard-capped at 10 clips. No mainstream stable distro ships it yet —
# Debian 13 has 7.1.5, Debian sid and Alpine edge have 8.1.2 — so the base
# image is chosen for its ffmpeg, and pinning it here is exactly why this
# runs in a container rather than against host packages.
FROM archlinux:base

RUN pacman -Syu --noconfirm \
      ffmpeg \
      nodejs \
      npm \
      libva-utils \
      # Every VAAPI driver, not just Intel's. Which one is correct depends on
      # the host GPU, and an image that ships only iHD fails on AMD with
      # "unsupported drm device by media driver: amdg".
      intel-media-driver \
      libva-intel-driver \
      libva-mesa-driver \
      mesa \
    && pacman -Scc --noconfirm \
    && rm -rf /var/cache/pacman/pkg/*

# LIBVA_DRIVER_NAME is deliberately NOT set. libva probes the DRM device and
# picks the right driver on its own; forcing a value is how an image ends up
# working on one vendor's hardware and silently failing on another. Override
# it in compose only if autodetection picks wrong (e.g. iHD vs i965 on older
# Intel parts).

WORKDIR /app

# The UI is built here rather than committed, so a checkout never carries
# stale bundles. Its toolchain is dev-only and does not ship in the runtime.
COPY web/package*.json ./web/
RUN cd web && npm install --no-audit --no-fund

COPY web ./web
RUN cd web && npm run build && rm -rf node_modules .svelte-kit

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Cache and runtime state live on a volume; see docker-compose.yml.
ENV JELLYSTREAMERR_CONFIG=/config/config.json

EXPOSE 8099
CMD ["node", "src/index.js"]
