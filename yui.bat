@echo off
chcp 65001 > nul
title Yui - GTA Online Updates - Painel de Controle

:: Habilita processamento ANSI/VT no console atual (Windows 10/11)
:: e obtem o caractere ESC real de forma confiavel via PowerShell.
for /F %%E in ('powershell -NoProfile -Command "[char]27"') do set "ESC=%%E"

:: %ESC%[2J%ESC%[H limpa a tela; os codigos de cor abaixo pintam TODO o texto
:: escrito depois deles (nao apenas a linha atual).
set "CYAN=%ESC%[96m"
set "RED=%ESC%[91m"
set "RESET=%ESC%[0m"

:MENU
cls
echo %CYAN%
echo ===================================================
echo     Yui - GTA Online Updates - Painel de Controle
echo ===================================================
echo.

:: Verificar se existe node_modules
if not exist "node_modules\" (
    echo [INFO] node_modules nao encontrado. Instalando dependencias...
    npm install
    if errorlevel 1 (
        echo %RED%[ERRO] Falha ao instalar dependencias do npm.%RESET%
        pause
        exit /b 1
    )
)

:: Verificar se o .env existe
if not exist ".env" (
    if exist ".env.example" (
        echo [AVISO] Arquivo .env nao encontrado. Criando a partir de .env.example...
        copy .env.example .env > nul
        echo [AVISO] Por favor, configure o arquivo .env com o seu DISCORD_TOKEN antes de iniciar.
        echo.
    )
)

echo Escolha uma opcao:
echo [1] Iniciar Yui (Producao/Desenvolvimento)
echo [2] Testar Coleta do Newswire Engine (Puppeteer isolado)
echo [3] Testar Coleta do GTAO Engine (Sistemas Diarios/Semanais)
echo [4] Registrar / Atualizar Slash Commands no Discord
echo [0] Sair
echo.
set "opt="
set /p "opt=Digite a opcao desejada [0-4]: "
echo %RESET%

if "%opt%"=="1" (
    cls
    echo %RED%
    echo ===================================================
    echo     Yui esta rodando... ^(Ctrl+C para encerrar^)
    echo ===================================================
    echo.
    node index.js
    echo %RESET%
    pause
    goto MENU
)
if "%opt%"=="2" (
    echo.
    echo %CYAN%[INFO] Executando teste isolado do Newswire Engine...%RESET%
    node tests/test-newswire.js
    pause
    goto MENU
)
if "%opt%"=="3" (
    echo.
    echo %CYAN%[INFO] Executando teste isolado do GTAO Engine...%RESET%
    node tests/test-gtao.js
    pause
    goto MENU
)
if "%opt%"=="4" (
    echo.
    echo %CYAN%[INFO] Registrando Slash Commands no Discord...%RESET%
    node src/discord/deployCommands.js
    pause
    goto MENU
)
if "%opt%"=="0" (
    echo %RESET%Encerrando...
    exit /b 0
)

echo %RED%Opcao invalida! Tente novamente.%RESET%
echo.
goto MENU
