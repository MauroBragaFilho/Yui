#!/bin/bash
# Script para implantar comandos Slash no Discord

echo "============================================"
echo "  YUI BOT - DEPLOY DE COMANDOS"
echo "============================================"
echo ""
echo "Implantando comandos Slash no Discord..."
echo ""
npm run deploy:commands
echo ""
if [ $? -eq 0 ]; then
    echo "[SUCESSO] Comandos implantados com sucesso!"
else
    echo "[ERRO] Falha ao implantar os comandos!"
fi
echo ""
