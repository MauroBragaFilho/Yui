@echo off
chcp 65001 >nul
echo ============================================
echo   YUI BOT - COMANDOS DISCORD
echo ============================================
echo.
echo Comandos Slash disponiveis:
echo.
echo   /yui-diario
echo     Descricao: Consulta sob demanda o resumo diario atual do GTA Online
echo     (Gun Van, Dealers, Collectibles, Time Trials)
echo.
echo   /yui-semanal
echo     Descricao: Consulta sob demanda os eventos e descontos da semana atual
echo     (Bônus, Descontos, Veiculo do Podio)
echo.
echo   /yui-noticias [quantidade]
echo     Descricao: Exibe as ultimas noticias publicadas no Rockstar Newswire
echo     Parametro opcional: quantidade (1-5, padrao: 2)
echo.
echo ============================================
echo   Para implantar os comandos no Discord:
echo   npm run deploy:commands
echo ============================================
pause
