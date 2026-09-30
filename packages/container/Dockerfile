FROM node:22-alpine

ARG PI_CODING_AGENT_VERSION=0.87.1
ARG PI_MCP_ADAPTER_VERSION=2.8.0
# dev: kit is mounted / installed at runtime via PI_KIT_PATH
# release: kit is baked into the image from git at build time
ARG BUILD_MODE=dev
ARG PI_KIT_REPO
ARG PI_KIT_REF=main

RUN apk add --no-cache \
    bash \
    ca-certificates \
    coreutils \
    curl \
    fd \
    findutils \
    gawk \
    git \
    grep \
    jq \
    openssh-client \
    py3-pip \
    python3 \
    ripgrep \
    sed \
    tini \
    tmux \
    util-linux \
    yq \
  && update-ca-certificates \
  && npm install -g --ignore-scripts \
      "@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}" \
  && addgroup -S piagent \
  && adduser -S -D -h /home/piagent -s /bin/bash -G piagent piagent \
  && mkdir -p \
      /workspace \
      /opt/pi-agent \
      /opt/pi-system \
      /srv/data/pi-system \
  && chown -R piagent:piagent \
      /workspace \
      /opt/pi-system \
      /srv/data/pi-system

WORKDIR /workspace

COPY --chown=piagent:piagent mcp-servers/ /opt/pi-agent/mcp-servers/
COPY --chown=piagent:piagent overlays/     /opt/pi-agent/overlays/
COPY --chown=piagent:piagent engagement/   /opt/pi-agent/engagement/
COPY scripts/entrypoint.sh  /usr/local/bin/pi-entrypoint
COPY scripts/pi-agent        /usr/local/bin/pi-agent
COPY scripts/pi-agent-idle   /usr/local/bin/pi-agent-idle
COPY scripts/healthcheck.py  /opt/pi-agent/healthcheck.py

RUN chmod +x /usr/local/bin/pi-entrypoint \
              /usr/local/bin/pi-agent \
              /usr/local/bin/pi-agent-idle \
  && cd /opt/pi-agent/mcp-servers/governance \
  && npm install --omit=dev --ignore-scripts \
  && cd /opt/pi-agent/mcp-servers/memory-mcp \
  && npm install --omit=dev --ignore-scripts

USER piagent

# Release mode: bake the kit into the image so no runtime mount is needed.
# Dev mode: kit is installed at container start via PI_KIT_PATH (no-op here).
RUN if [ "$BUILD_MODE" = "release" ]; then \
      test -n "$PI_KIT_REPO" || (echo "PI_KIT_REPO is required for release builds" && exit 1); \
      git clone --depth 1 --branch "$PI_KIT_REF" "$PI_KIT_REPO" /opt/pi-system && \
      cd /opt/pi-system/packages/container/mcp-servers/memory-mcp && npm install --omit=dev --ignore-scripts && \
      pi install /opt/pi-system && \
      pi list | grep -q "pi-system" || (echo "Kit install verification failed" && exit 1); \
    fi

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/pi-entrypoint"]
CMD ["/usr/local/bin/pi-agent-idle"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD python3 /opt/pi-agent/healthcheck.py --check
