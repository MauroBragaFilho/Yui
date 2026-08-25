@echo off
chcp 65001 >nul
echo ============================================
echo   NEWSWIRE ENGINE - TESTE ISOLADO
echo ============================================
echo.
echo Testando scraping do Rockstar Newswire:
echo   - Extracao de artigos recentes
echo   - Traducao automatica PT-BR
echo   - Deteccao de artigos ineditos
echo   - Salvamento no banco de dados
echo.
echo ----------------------------------------------
node tests/test-newswire.js
echo.
if errorlevel 1 (
    echo [ERRO] Falha no teste do Newswire Engine!
) else (
    echo [SUCESSO] Newswire Engine testado com sucesso!
)
echo.
echo ============================================
echo   TESTE NEWSWIRE ENGINE CONCLUIDO!
echo ============================================
pause
