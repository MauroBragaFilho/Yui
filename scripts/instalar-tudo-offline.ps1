# Instala a Yui e tudo que ela precisa SEM internet, a partir do pendrive.
# Rode pelo INSTALAR-TUDO.bat (ele pede permissao de Administrador).
# Pode rodar de novo sem problema: o que ja esta instalado e pulado.
param(
    [string]$Destino = 'C:\Yui',
    [string]$PublicKey = '',
    [string]$PastaMinecraft = 'C:\Minecraft',
    [int]$MinecraftRamMB = 1024,
    [switch]$MinecraftAutoIniciar
)

$ErrorActionPreference = 'Stop'
$raiz = $PSScriptRoot
$inst = Join-Path $raiz 'instaladores'
$erros = New-Object System.Collections.Generic.List[string]

function Titulo($t) { Write-Host "`n==== $t ====" -ForegroundColor Cyan }
function Ok($t)     { Write-Host "[+] $t" -ForegroundColor Green }
function Aviso($t)  { Write-Host "[!] $t" -ForegroundColor Yellow }

function Atualizar-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Passo($nome, [scriptblock]$acao) {
    Titulo $nome
    try { & $acao } catch {
        $erros.Add("${nome}: $($_.Exception.Message)")
        Write-Host "[-] FALHOU: $($_.Exception.Message)" -ForegroundColor Red
    }
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host 'Rode pelo INSTALAR-TUDO.bat ou abra o PowerShell como Administrador.' -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $raiz 'Yui\package.json'))) {
    Write-Host "Pasta 'Yui' nao encontrada ao lado deste script ($raiz)." -ForegroundColor Red
    exit 1
}

function Instalar-Msi($arquivo) {
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$arquivo`" /qn /norestart" -Wait -PassThru
    if ($p.ExitCode -notin 0, 3010) { throw "msiexec saiu com codigo $($p.ExitCode)" }
}

Passo 'Visual C++ Redistributable' {
    $p = Start-Process (Join-Path $inst 'vc_redist.x64.exe') -ArgumentList '/install /quiet /norestart' -Wait -PassThru
    if ($p.ExitCode -notin 0, 1638, 3010) { throw "codigo $($p.ExitCode)" }
    Ok 'VC++ pronto.'
}

Passo 'Node.js 24' {
    Atualizar-Path
    if (Get-Command node -ErrorAction SilentlyContinue) { Ok "Ja instalado: $(node -v)" }
    else { Instalar-Msi (Join-Path $inst 'node-v24.14.0-x64.msi'); Atualizar-Path; Ok "Node $(node -v)" }
}

Passo 'Python 3.12' {
    $py = 'C:\Program Files\Python312\python.exe'
    if (Test-Path $py) { Ok 'Ja instalado.' }
    else {
        $p = Start-Process (Join-Path $inst 'python-3.12.10-amd64.exe') `
            -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1 Include_launcher=1 Include_test=0' -Wait -PassThru
        if ($p.ExitCode -notin 0, 3010) { throw "codigo $($p.ExitCode)" }
        Ok 'Python 3.12 instalado.'
    }
}

Passo 'Google Chrome (usado pelo scraper do Reddit)' {
    if (Test-Path 'C:\Program Files\Google\Chrome\Application\chrome.exe') { Ok 'Ja instalado.' }
    else { Instalar-Msi (Join-Path $inst 'googlechromestandaloneenterprise64.msi'); Ok 'Chrome instalado.' }
}

Passo 'ffmpeg e yt-dlp' {
    $bin = 'C:\Tools\bin'
    New-Item -ItemType Directory -Force $bin | Out-Null
    Copy-Item (Join-Path $raiz 'ferramentas\*') $bin -Force
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    if (($machine -split ';') -notcontains $bin) {
        [Environment]::SetEnvironmentVariable('Path', "$machine;$bin", 'Machine')
    }
    Atualizar-Path
    Ok "Copiados para $bin e adicionados ao PATH."
}

Passo "Copiando a Yui para $Destino" {
    New-Item -ItemType Directory -Force $Destino | Out-Null
    $env1 = Join-Path $Destino '.env'
    if (Test-Path $env1) {
        Copy-Item $env1 "$env1.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Aviso 'Ja existia um .env: foi guardada uma copia .bak antes de sobrescrever.'
    }
    robocopy (Join-Path $raiz 'Yui') $Destino /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy falhou (codigo $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
    Ok 'Arquivos copiados.'
}

Passo 'Ambientes Python (Deezer e Spotify), offline' {
    $py = 'C:\Program Files\Python312\python.exe'
    if (-not (Test-Path $py)) { throw 'Python 3.12 nao encontrado.' }

    $dDeemix = Join-Path $Destino '.venv-deemix'
    if (-not (Test-Path "$dDeemix\Scripts\python.exe")) {
        & $py -m venv $dDeemix
        & "$dDeemix\Scripts\python.exe" -m pip install -q --no-index --find-links (Join-Path $raiz 'wheels-deemix') `
            -r (Join-Path $Destino 'requirements-deemix.txt')
        if ($LASTEXITCODE -ne 0) { throw 'pip (deemix) falhou' }
        Ok '.venv-deemix criado.'
    } else { Ok '.venv-deemix ja existe.' }

    $dSpot = Join-Path $Destino '.venv-spotdl'
    if (-not (Test-Path "$dSpot\Scripts\python.exe")) {
        & $py -m venv $dSpot
        & "$dSpot\Scripts\python.exe" -m pip install -q --no-index --find-links (Join-Path $raiz 'wheels-spotdl') `
            -c (Join-Path $Destino 'requirements-spotdl.lock.txt') -r (Join-Path $Destino 'requirements-spotdl.txt')
        if ($LASTEXITCODE -ne 0) { throw 'pip (spotdl) falhou' }
        Ok '.venv-spotdl criado.'
    } else { Ok '.venv-spotdl ja existe.' }
}

Passo 'Ajustando o .env para este computador' {
    $f = Join-Path $Destino '.env'
    if (-not (Test-Path $f)) { Aviso '.env nao encontrado; configure depois.'; return }
    $novo = ($Destino -replace '\\', '/') + '/.venv-deemix/Scripts/python.exe'
    $txt = [IO.File]::ReadAllText($f)
    $txt2 = [regex]::Replace($txt, '(?m)^PYTHON_PATH=.*$', "PYTHON_PATH=$novo")
    if ($txt2 -ne $txt) { [IO.File]::WriteAllText($f, $txt2, (New-Object Text.UTF8Encoding $false)) }
    Ok "PYTHON_PATH=$novo"
    $locais = Select-String -Path $f -Pattern '^(YUI_PROJECTS|YUI_FILE_ROOTS|YUI_EDITOR_COMMAND)=' | ForEach-Object { $_.Matches[0].Groups[1].Value }
    if ($locais) {
        Aviso "O .env ainda tem caminhos do PC antigo ($($locais -join ', ')). So afetam as ferramentas de arquivos/projetos do agent; ajuste se for usar."
    }
}

Passo 'SSH (acesso remoto)' {
    $args2 = @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $raiz 'instalar-ssh.ps1'))
    if ($PublicKey) { $args2 += @('-PublicKey', $PublicKey) }
    & powershell.exe -NoProfile @args2
    if ($LASTEXITCODE -ne 0) { throw "instalar-ssh.ps1 saiu com codigo $LASTEXITCODE" }
}

function Registrar-Tarefa($nome, $pasta, $comando, [int]$atrasoSeg) {
    # Roda como SYSTEM na inicializacao (nao precisa de login); o loop do comando reinicia se cair.
    $acao = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $pasta `
        -Argument "-NoProfile -WindowStyle Hidden -Command `"$comando`""
    $gatilho = New-ScheduledTaskTrigger -AtStartup
    $gatilho.Delay = "PT${atrasoSeg}S"   # espera o Wi-Fi conectar
    $princ = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $conf = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
        -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $nome -Action $acao -Trigger $gatilho -Principal $princ -Settings $conf -Force | Out-Null
}

Passo 'Iniciar a Yui e o app web sozinhos quando o notebook ligar' {
    Atualizar-Path
    $nodeExe = (Get-Command node).Source
    Registrar-Tarefa 'YuiBot' $Destino `
        "Set-Location '$Destino'; while (`$true) { & '$nodeExe' src/index.js; Start-Sleep -Seconds 15 }" 45
    Ok 'Tarefa YuiBot criada: inicia 45 s depois de ligar o notebook (sem precisar fazer login).'
    $web = Join-Path $Destino 'apps\yui-app'
    if (Test-Path (Join-Path $web 'dist\index.html')) {
        Registrar-Tarefa 'YuiWebApp' $web `
            "Set-Location '$web'; while (`$true) { & '$nodeExe' scripts/serve-web.mjs; Start-Sleep -Seconds 15 }" 50
        Ok 'Tarefa YuiWebApp criada: app web em http://localhost:8081 (so neste notebook).'
    } else { Aviso 'App web (apps\yui-app\dist) nao encontrado; tarefa YuiWebApp nao criada.' }
    Aviso 'Nada foi iniciado agora; comecam no proximo boot. Para testar ja: Start-ScheduledTask YuiBot'
}

Passo 'Minecraft (servidor Paper): Java e arquivos' {
    $jre = Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Filter java.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($jre) { Ok 'Java ja instalado.' }
    else {
        $msiJava = Join-Path $inst 'temurin-25-jre-x64.msi'
        $p = Start-Process msiexec.exe -ArgumentList "/i `"$msiJava`" ADDLOCAL=FeatureMain,FeatureEnvironment,FeatureJavaHome /qn /norestart" -Wait -PassThru
        if ($p.ExitCode -notin 0, 3010) { throw "Java: msiexec saiu com codigo $($p.ExitCode)" }
        Ok 'Java 25 (Temurin) instalado.'
    }
    New-Item -ItemType Directory -Force $PastaMinecraft | Out-Null
    robocopy (Join-Path $raiz 'minecraft') $PastaMinecraft /E /XO /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy falhou (codigo $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
    $props = Join-Path $PastaMinecraft 'server.properties'
    if (-not (Test-Path $props)) {
        # valores leves para 4 GB de RAM; o servidor completa o resto na primeira execucao
        Set-Content $props -Encoding ascii -Value @('view-distance=6', 'simulation-distance=4', 'motd=Servidor da Yui')
    }
    # Firewall: so a rede local. Para amigos de fora, e preciso liberar/redirecionar a porta 25565 no roteador.
    if (-not (Get-NetFirewallRule -Name 'Minecraft-25565' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -Name 'Minecraft-25565' -DisplayName 'Minecraft (25565)' -Direction Inbound -Protocol TCP `
            -LocalPort 25565 -Action Allow -Profile Any -RemoteAddress LocalSubnet | Out-Null
    }
    Ok "Minecraft em $PastaMinecraft (Paper 26.2). Inicie com iniciar-minecraft.bat."
    Aviso 'O EULA NAO foi aceito por voce: na primeira execucao o servidor pede para editar eula.txt.'
    if ($MinecraftAutoIniciar) {
        $javaExe = (Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Filter java.exe -Recurse | Select-Object -First 1).FullName
        Registrar-Tarefa 'MinecraftServer' $PastaMinecraft `
            "Set-Location '$PastaMinecraft'; & '$javaExe' -Xms${MinecraftRamMB}M -Xmx${MinecraftRamMB}M -XX:+UseG1GC -jar paper.jar --nogui" 90
        Ok 'Tarefa MinecraftServer criada (so funciona depois de aceitar o eula.txt).'
    }
}

Passo 'Verificacao final' {
    Atualizar-Path
    Write-Host ('node    : ' + (node -v))
    Write-Host ('npm     : ' + (npm -v))
    Write-Host ('ffmpeg  : ' + ((ffmpeg -version | Select-Object -First 1)))
    Write-Host ('yt-dlp  : ' + (yt-dlp --version))
    Write-Host ('spotdl  : ' + (& "$Destino\.venv-spotdl\Scripts\spotdl.exe" --version))
    Push-Location $Destino
    try {
        $r = node --input-type=module -e "await import('discord.js'); await import('@discordjs/voice'); console.log('discord.js e voz carregam')"
        Write-Host $r
        if ($LASTEXITCODE -ne 0) { throw 'node_modules incompleto: rode npm install quando tiver internet.' }
    } finally { Pop-Location }
}

Write-Host ''
if ($erros.Count) {
    Write-Host 'Terminou COM PROBLEMAS:' -ForegroundColor Red
    $erros | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
} else {
    Write-Host 'Tudo instalado.' -ForegroundColor Green
    Write-Host "Para iniciar a Yui: abra $Destino e execute Yui.bat" -ForegroundColor Cyan
}
Write-Host 'Reinicie o notebook uma vez antes de usar (garante PATH e servicos).'
