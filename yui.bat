:: (linha em branco proposital acima para absorver o BOM UTF-8)
@echo off
chcp 65001 > nul
title Yui - Painel de Controle

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
echo     Yui - Painel de Controle
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
echo [0] Sair
echo [1] Iniciar Yui (Producao/Desenvolvimento)
echo [2] Testar Coleta do Newswire Engine (Puppeteer isolado)
echo [3] Testar Coleta do GTAO Engine (Sistemas Diarios/Semanais)
echo [4] Registrar / Atualizar Slash Commands no Discord
echo [5] Conectar a Maquina SSH

echo.
set "opt="
set /p "opt=Digite a opcao desejada [0-5]: "
echo %RESET%

if "%opt%"=="1" (
    cls
    call :START_YUI
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
if "%opt%"=="5" (
    echo.
    echo %CYAN%[INFO] Conectando a maquina SSH...%RESET%
    ssh -i "%USERPROFILE%\.ssh\Yui.pem" ubuntu@ec2-52-67-29-69.sa-east-1.compute.amazonaws.com
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

:: ===================================================================
::  Iniciar a Yui (opcao 1): sobe o app web junto e NAO duplica o bot
:: ===================================================================
:START_YUI
set "WEB_STARTED="
set "WEB_PIDFILE=%TEMP%\yui-web.pid"
if exist "%WEB_PIDFILE%" del "%WEB_PIDFILE%" > nul 2>&1

:: 1) App web (http://localhost:8081): garante que esteja no ar (teste por conexao TCP real).
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8081); $c.Close(); exit 0 } catch { exit 1 }"
if not errorlevel 1 goto WEB_OK
if not exist "apps\yui-app\node_modules\" goto WEB_SKIP
if exist "apps\yui-app\dist\index.html" goto WEB_START
echo [INFO] Gerando o app web pela primeira vez, pode levar alguns minutos...
pushd apps\yui-app
call npm run web:build
popd
:WEB_START
if not exist "apps\yui-app\dist\index.html" goto WEB_SKIP
powershell -NoProfile -Command "$p = Start-Process node -ArgumentList 'apps\yui-app\scripts\serve-web.mjs' -WindowStyle Minimized -PassThru; Set-Content -Path $env:TEMP\yui-web.pid -Value $p.Id"
set "WEB_STARTED=1"
echo [OK] App web iniciado: http://localhost:8081
goto WEB_DONE
:WEB_OK
echo [OK] App web ja esta no ar: http://localhost:8081
goto WEB_DONE
:WEB_SKIP
echo [AVISO] App web indisponivel. Rode "npm install" e "npm run web:build" em apps\yui-app.
:WEB_DONE
echo.

:: 2) Nao duplica o bot: se a Yui ja esta rodando (ex.: tarefa YuiBot), nao inicia outra.
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src.index.js' }) { exit 1 } else { exit 0 }"
if errorlevel 1 goto YUI_ALREADY

echo %RED%
echo ===================================================
echo     Yui esta rodando... ^(Ctrl+C para encerrar^)
echo ===================================================
echo.
node src/index.js

:: 3) Ao encerrar a Yui, fecha o app web SO se ele foi iniciado por esta janela (pelo PID guardado).
if defined WEB_STARTED powershell -NoProfile -Command "if (Test-Path $env:TEMP\yui-web.pid) { Stop-Process -Id ([int](Get-Content $env:TEMP\yui-web.pid)) -Force -ErrorAction SilentlyContinue; Remove-Item $env:TEMP\yui-web.pid -ErrorAction SilentlyContinue }"
echo %RESET%
pause
exit /b 0

:YUI_ALREADY
echo %RED%[AVISO] A Yui ja esta rodando em segundo plano ^(tarefa YuiBot^).
echo        Iniciar outra instancia duplicaria as respostas no Discord.
echo        Para reiniciar: Stop-ScheduledTask YuiBot; Start-ScheduledTask YuiBot%RESET%
echo.
echo App web: http://localhost:8081
pause
exit /b 0
