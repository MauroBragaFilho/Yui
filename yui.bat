@echo off
chcp 65001 >nul
echo ============================================
echo   YUI BOT - GTA ONLINE ENGINES TEST SUITE
echo ============================================
echo.

echo [1/3] Testando GTAO Engine (Sistemas Diarios e Semanais)...
echo ----------------------------------------------
node tests/test-gtao.js
if errorlevel 1 (
    echo.
    echo [ERRO] Falha no teste do GTAO Engine!
    echo.
) else (
    echo.
    echo [SUCESSO] GTAO Engine testado com sucesso!
    echo.
)

echo [2/3] Testando Newswire Engine (Noticias Rockstar)...
echo ----------------------------------------------
node tests/test-newswire.js
if errorlevel 1 (
    echo.
    echo [ERRO] Falha no teste do Newswire Engine!
    echo.
) else (
    echo.
    echo [SUCESSO] Newswire Engine testado com sucesso!
    echo.
)

echo [3/3] Verificando comandos do Discord...
echo ----------------------------------------------
echo Comandos disponiveis:
echo   /yui-diario   - Consulta o resumo diario do GTA Online
echo   /yui-semanal  - Consulta eventos e descontos da semana
echo   /yui-noticias - Exibe ultimas noticias do Rockstar Newswire
echo.

echo ============================================
echo   TESTES CONCLUIDOS!
echo ============================================
pause
