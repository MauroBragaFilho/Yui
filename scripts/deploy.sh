#!/bin/bash
# Script de provisionamento e deploy para Oracle Cloud (Ubuntu 24.04 LTS)

set -e

echo "=== [1/6] Atualizando pacotes do sistema ==="
sudo apt update && sudo apt upgrade -y

echo "=== [2/6] Instalando dependências do Chromium para o Puppeteer ==="
sudo apt install -y \
  ca-certificates \
  fonts-liberation \
  libasound2t64 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libc6 \
  libcairo2 \
  libcups2t64 \
  libdbus-1-3 \
  libexpat1 \
  libfontconfig1 \
  libgbm1 \
  libgcc1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libpangocairo-1.0-0 \
  libstdc++6 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxcursor1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxi6 \
  libxrandr2 \
  libxrender1 \
  libxss1 \
  libxtst6 \
  xdg-utils

echo "=== [3/6] Criando usuário dedicado sem root: yui-bot ==="
if ! id "yui-bot" &>/dev/null; then
    sudo useradd -r -s /bin/false -d /opt/yui yui-bot
fi

echo "=== [4/6] Configurando diretórios de aplicação ==="
sudo mkdir -p /opt/yui/data
sudo mkdir -p /opt/yui/logs
sudo mkdir -p /opt/yui/backups

echo "=== [5/6] Instalando serviço systemd ==="
sudo cp scripts/yui.service /etc/systemd/system/
sudo chown -R yui-bot:yui-bot /opt/yui
sudo systemctl daemon-reload
sudo systemctl enable yui

echo "=== [6/6] Pronto! Para iniciar o serviço execute: ==="
echo "sudo systemctl start yui"
echo "sudo journalctl -u yui -f"
