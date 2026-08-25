@echo off
chcp 65001 >nul
echo ============================================
echo   YUI BOT - DEPLOY DE COMANDOS
echo ============================================
echo.
echo Implantando comandos Slash no Discord...
echo.
npm run deploy:commands
echo.
if errorlevel 1 (
    echo [ERRO] Falha ao implantar os comandos!
) else (
    echo [SUCESSO] Comandos implantados com sucesso!
)
echo.
pause
