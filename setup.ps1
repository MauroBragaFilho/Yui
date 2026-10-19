
$ErrorActionPreference = "SilentlyContinue"

function Write-Header($text) {
    Write-Host "`n==== $text ====" -ForegroundColor Cyan
}

Write-Header "Verificando Node.js"
$nodeVersion = node -v
if ($LASTEXITCODE -ne 0) {
    Write-Host "[-] Node.js não encontrado." -ForegroundColor Red
    $choice = Read-Host "Deseja tentar instalar o Node.js via winget agora? (s/n)"
    if ($choice -eq 's') {
        winget install OpenJS.NodeJS.LTS
        Write-Host "[!] Por favor, reinicie este script após a conclusão da instalação do Node." -ForegroundColor Yellow
        exit
    }
} else {
    Write-Host "[+] Node.js detectado: $nodeVersion" -ForegroundColor Green
}

Write-Header "Instalando Dependências do Projeto (npm install)"
npm install
if ($LASTEXITCODE -eq 0) {
    Write-Host "[+] Dependências instaladas com sucesso." -ForegroundColor Green
} else {
    Write-Host "[-] Erro ao executar npm install." -ForegroundColor Red
}

Write-Header "Verificando yt-dlp"
yt-dlp --version
if ($LASTEXITCODE -ne 0) {
    Write-Host "[-] yt-dlp não encontrado." -ForegroundColor Red
    $choice = Read-Host "Deseja instalar o yt-dlp via winget? (s/n)"
    if ($choice -eq 's') {
        winget install yt-dlp.yt-dlp
    }
} else {
    Write-Host "[+] yt-dlp detectado." -ForegroundColor Green
}

Write-Header "Verificando ffmpeg"
ffmpeg -version
if ($LASTEXITCODE -ne 0) {
    Write-Host "[-] ffmpeg não encontrado." -ForegroundColor Red
    $choice = Read-Host "Deseja instalar o ffmpeg via winget? (s/n)"
    if ($choice -eq 's') {
        winget install Gyan.FFmpeg
    }
} else {
    Write-Host "[+] ffmpeg detectado." -ForegroundColor Green
}

$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }

Write-Header "Verificando o codificador Opus (voz e Modo Rádio)"
# Só informa; quem instala é o npm install (o package.json traz o opusscript e o @noble/ciphers).
$opusScript = Join-Path $root "node_modules\opusscript"
$opusNative = Join-Path $root "node_modules\@discordjs\opus"
if ((Test-Path $opusScript) -or (Test-Path $opusNative)) {
    Write-Host "[+] Codificador Opus encontrado em node_modules." -ForegroundColor Green
} else {
    Write-Host "[!] Codificador Opus NÃO encontrado. Sem ele a Yui recusa entrar em calls e o Modo Rádio." -ForegroundColor Yellow
    Write-Host "    Rode 'npm install' (o opusscript vem no package.json) e reinicie a Yui." -ForegroundColor Yellow
}
if (Test-Path (Join-Path $root "node_modules\@noble\ciphers")) {
    Write-Host "[+] @noble/ciphers (criptografia de voz) encontrado." -ForegroundColor Green
} else {
    Write-Host "[!] @noble/ciphers não encontrado. Rode 'npm install'." -ForegroundColor Yellow
}

Write-Header "Deezer (opcional): ambiente Python do deemix"
# Passo OPCIONAL: cria .venv-deemix com o Python 3.12 e instala as versões fixas de requirements-deemix.txt.
# Nunca sobrescreve um ambiente que já existe e nunca altera o .env.
$venvDir = Join-Path $root ".venv-deemix"
$venvPython = Join-Path $venvDir "Scripts\python.exe"
$reqFile = Join-Path $root "requirements-deemix.txt"
if (Test-Path $venvPython) {
    Write-Host "[+] O ambiente .venv-deemix já existe; nada será alterado." -ForegroundColor Green
    Write-Host "    No .env: PYTHON_PATH=$venvPython" -ForegroundColor Gray
} elseif (-not (Test-Path $reqFile)) {
    Write-Host "[!] requirements-deemix.txt não encontrado; passo ignorado." -ForegroundColor Yellow
} else {
    Write-Host "O Deezer em alta qualidade usa o deemix, que roda num ambiente Python próprio (testado com Python 3.12)."
    Write-Host "Sem ele, as músicas continuam vindo do YouTube."
    $choice = Read-Host "Deseja criar o ambiente .venv-deemix agora? (s/n)"
    if ($choice -eq 's') {
        $py312 = $false
        if (Get-Command py) {
            py -3.12 --version
            if ($LASTEXITCODE -eq 0) { $py312 = $true }
        }
        if (-not $py312) {
            Write-Host "[-] Python 3.12 não encontrado (comando 'py -3.12')." -ForegroundColor Red
            Write-Host "    Instale-o (https://www.python.org/downloads/ ou 'winget install Python.Python.3.12') e rode este script de novo." -ForegroundColor Yellow
        } else {
            py -3.12 -m venv $venvDir
            if (Test-Path $venvPython) {
                & $venvPython -m pip install -r $reqFile
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "[+] Ambiente do deemix criado em $venvDir" -ForegroundColor Green
                    # Verificação local, sem rede: mostra as versões instaladas.
                    & $venvPython (Join-Path $root "src\services\download_deezer.py") --check
                    Write-Host "    Acrescente ao .env (e informe o seu DEEZER_ARL):" -ForegroundColor Gray
                    Write-Host "    PYTHON_PATH=$venvPython" -ForegroundColor Gray
                } else {
                    Write-Host "[-] Erro ao instalar o requirements-deemix.txt." -ForegroundColor Red
                }
            } else {
                Write-Host "[-] Não foi possível criar o ambiente em $venvDir" -ForegroundColor Red
            }
        }
    } else {
        Write-Host "Passo ignorado."
    }
}

Write-Header "Voz do Windows em pt-BR (opcional, para a Yui falar na call)"
try {
    Add-Type -AssemblyName System.Speech
    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $vozes = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'pt-BR' } | ForEach-Object { $_.VoiceInfo.Name })
    $synth.Dispose()
    if ($vozes.Count -gt 0) {
        Write-Host "[+] Voz(es) pt-BR instalada(s): $($vozes -join ', ')" -ForegroundColor Green
    } else {
        Write-Host "[!] Nenhuma voz pt-BR instalada. Em Configurações > Hora e idioma > Fala, adicione o Português (Brasil)." -ForegroundColor Yellow
    }
} catch {
    Write-Host "[!] Não foi possível listar as vozes do Windows." -ForegroundColor Yellow
}

Write-Header "Resumo do Sistema"
Write-Host "Node: " -NoNewline; node -v
Write-Host "npm:  " -NoNewline; npm -v
Write-Host "yt-dlp: Detectado"
Write-Host "ffmpeg: Detectado"

Write-Host "`n[✅] Configuração concluída! Se algum comando ainda falhar, reinicie o terminal." -ForegroundColor Cyan
pause
