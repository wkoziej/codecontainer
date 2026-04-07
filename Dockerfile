# Code Container
# Generic Dockerfile for running coding tools in isolated project environments

FROM ubuntu:24.04

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Set timezone to Warsaw, Poland
ENV TZ=Europe/Warsaw
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Install ca-certificates and add any custom CA certs from ~/.code-container/certs/
RUN apt-get update && apt-get install -y ca-certificates
COPY certs/ /usr/local/share/ca-certificates/custom/
RUN update-ca-certificates

# Install system dependencies and common build tools
RUN apt-get install -y \
    build-essential \
    git \
    curl \
    wget \
    unzip \
    libssl-dev \
    zlib1g-dev \
    libffi-dev \
    vim \
    tree \
    tmux \
    zsh

# Install NVM (Node Version Manager) and Node.js
ENV NVM_DIR=/root/.nvm
ENV NODE_VERSION=22
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install ${NODE_VERSION} \
    && nvm use ${NODE_VERSION} \
    && nvm alias default ${NODE_VERSION} \
    && ln -sf "$NVM_DIR/versions/node/$(nvm current)/bin/"* /usr/local/bin/

RUN apt-get update \
    && apt-get install -y \
        python3 \
        python3-dev \
        python3-venv \
        python3-pip

# Create python symlink pointing to python3
RUN ln -sf /usr/bin/python3 /usr/bin/python

# Install uv (fast Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# Agent installation flags (set via --build-arg)
ARG INSTALL_CLAUDE=1
ARG INSTALL_OPENCODE=1
ARG INSTALL_CODEX=1
ARG INSTALL_GEMINI=1
ARG INSTALL_BROWSER_TOOLS=1

# Install Claude Code globally via official installer
RUN if [ "$INSTALL_CLAUDE" = "1" ]; then \
      curl -fsSL https://claude.ai/install.sh | bash; \
    fi
ENV PATH="/root/.local/bin:${PATH}"

# Install Opencode
RUN if [ "$INSTALL_OPENCODE" = "1" ]; then \
      npm install -g opencode-ai; \
    fi

# Install OpenAI Codex CLI
RUN if [ "$INSTALL_CODEX" = "1" ]; then \
      npm install -g @openai/codex; \
    fi

# Install Gemini CLI
RUN if [ "$INSTALL_GEMINI" = "1" ]; then \
      npm install -g @google/gemini-cli; \
    fi

# Install browser automation tools for agent-driven E2E checks
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN if [ "$INSTALL_BROWSER_TOOLS" = "1" ]; then \
      npm install -g @playwright/test agent-browser; \
      . "$NVM_DIR/nvm.sh" && ln -sf "$NVM_DIR/versions/node/$(nvm current)/bin/"* /usr/local/bin/; \
      ARCH=$(dpkg --print-architecture); \
      if [ "$ARCH" = "arm64" ]; then \
        apt-get update && apt-get install -y chromium-browser || apt-get install -y chromium; \
        npx playwright install-deps chromium; \
        CHROMIUM_PATH=$(which chromium-browser 2>/dev/null || which chromium 2>/dev/null); \
        echo "export CHROME_PATH=$CHROMIUM_PATH" >> /etc/environment; \
        echo "export CHROME_PATH=$CHROMIUM_PATH" >> /root/.bashrc; \
        echo "export CHROME_PATH=$CHROMIUM_PATH" >> /root/.zshrc; \
      else \
        npx playwright install --with-deps chromium; \
      fi; \
      agent-browser install || true; \
    fi

# Set working directory to root home
WORKDIR /root

# Configure bash prompt to show container name
RUN echo 'PS1="\[\033[01;32m\][code-container]\[\033[00m\] \[\033[01;34m\]\w\[\033[00m\]\$ "' >> /root/.bashrc

# Ensure PATH includes tool directories (Apple Container doesn't inherit ENV from Dockerfile)
RUN echo 'export PATH="/root/.local/bin:$PATH"' >> /root/.bashrc

# Source NVM in bashrc for interactive shells
RUN echo 'export NVM_DIR="$HOME/.nvm"' >> /root/.bashrc \
    && echo '[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"' >> /root/.bashrc \
    && echo '[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"' >> /root/.bashrc

# Configure zsh with same environment (Claude Code uses zsh as its shell)
RUN echo 'export PATH="/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' >> /root/.zshrc \
    && echo 'export NVM_DIR="$HOME/.nvm"' >> /root/.zshrc \
    && echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"' >> /root/.zshrc \
    && echo 'PROMPT="%F{green}[code-container]%f %F{blue}%~%f$ "' >> /root/.zshrc

# System-wide PATH so all shells (bash, zsh, sh) find installed tools
RUN echo 'PATH="/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' > /etc/environment

# Install user-defined extra apt packages as the final build layer
COPY extra_packages.apt /tmp/extra_packages.apt
RUN if [ -s /tmp/extra_packages.apt ]; then \
      grep -v '^\s*#' /tmp/extra_packages.apt | grep -v '^\s*$' > /tmp/extra_packages.filtered; \
      if [ -s /tmp/extra_packages.filtered ]; then \
        apt-get update && xargs -r -a /tmp/extra_packages.filtered apt-get install -y; \
      fi; \
    fi

# Entrypoint scripts for SSH setup and git safe.directory on every start
COPY scripts/fix-ssh.sh /usr/local/bin/fix-ssh.sh
COPY scripts/codecontainer-entrypoint.sh /usr/local/bin/codecontainer-entrypoint.sh
RUN chmod +x /usr/local/bin/fix-ssh.sh /usr/local/bin/codecontainer-entrypoint.sh

ENTRYPOINT ["codecontainer-entrypoint.sh"]
CMD ["/bin/bash"]
