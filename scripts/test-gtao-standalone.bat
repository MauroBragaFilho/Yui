@echo off
chcp 65001 >nul
echo ============================================
echo   GTAO ENGINE - TESTE ISOLADO
echo ============================================
echo.
echo Testando sistemas diarios:
echo   - Gun Van (Van de Armas)
echo   - Street Dealers (Traficantes)
echo   - Collectibles (Colecionaveis)
echo   - Time Trials (Contra Relogio)
echo.
echo Testando sistema semanal:
echo   - Weekly Events (Bonus, Descontos, Podio)
echo.
echo ----------------------------------------------
node tests/test-gtao.js
echo.
if errorlevel 1 (
    echo [ERRO] Falha no teste do GTAO Engine!
) else (
    echo [SUCESSO] GTAO Engine testado com sucesso!
)
echo.
echo ============================================
echo   TESTE GTAO ENGINE CONCLUIDO!
echo ============================================
pause
