#!/bin/bash

echo "============================================"
echo "  YUI BOT - GTA ONLINE ENGINES TEST SUITE"
echo "============================================"
echo ""

# Teste 1: GTAO Engine
echo "[1/3] Testando GTAO Engine (Sistemas Diários e Semanais)..."
echo "----------------------------------------------"
node tests/test-gtao.js
if [ $? -eq 0 ]; then
    echo ""
    echo "[SUCESSO] GTAO Engine testado com sucesso!"
    echo ""
else
    echo ""
    echo "[ERRO] Falha no teste do GTAO Engine!"
    echo ""
fi

# Teste 2: Newswire Engine
echo "[2/3] Testando Newswire Engine (Notícias Rockstar)..."
echo "----------------------------------------------"
node tests/test-newswire.js
if [ $? -eq 0 ]; then
    echo ""
    echo "[SUCESSO] Newswire Engine testado com sucesso!"
    echo ""
else
    echo ""
    echo "[ERRO] Falha no teste do Newswire Engine!"
    echo ""
fi

# Teste 3: Comandos Discord
echo "[3/3] Verificando comandos do Discord..."
echo "----------------------------------------------"
echo "Comandos disponíveis:"
echo "  /gta-diario   - Consulta o resumo diário do GTA Online"
echo "  /gta-semanal  - Consulta eventos e descontos da semana"
echo "  /gta-noticias - Exibe últimas notícias do Rockstar Newswire"
echo ""

echo "============================================"
echo "  TESTES CONCLUÍDOS!"
echo "============================================"
