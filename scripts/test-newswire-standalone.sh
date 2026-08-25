#!/bin/bash
# Script standalone para testar apenas o Newswire Engine

echo "============================================"
echo "  NEWSWIRE ENGINE - TESTE ISOLADO"
echo "============================================"
echo ""
echo "Testando scraping do Rockstar Newswire:"
echo "  - Extração de artigos recentes"
echo "  - Tradução automática PT-BR"
echo "  - Detecção de artigos inéditos"
echo "  - Salvamento no banco de dados"
echo ""
echo "----------------------------------------------"
node tests/test-newswire.js
echo ""
echo "============================================"
echo "  TESTE NEWSWIRE ENGINE CONCLUÍDO!"
echo "============================================"
