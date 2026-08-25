#!/bin/bash
# Script standalone para testar apenas o GTAO Engine

echo "============================================"
echo "  GTAO ENGINE - TESTE ISOLADO"
echo "============================================"
echo ""
echo "Testando sistemas diários:"
echo "  - Gun Van (Van de Armas)"
echo "  - Street Dealers (Traficantes)"
echo "  - Collectibles (Colecionáveis)"
echo "  - Time Trials (Contra Relógio)"
echo ""
echo "Testando sistema semanal:"
echo "  - Weekly Events (Bônus, Descontos, Pódio)"
echo ""
echo "----------------------------------------------"
node tests/test-gtao.js
echo ""
echo "============================================"
echo "  TESTE GTAO ENGINE CONCLUÍDO!"
echo "============================================"
