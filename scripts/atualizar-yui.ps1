# Atualiza a Yui a partir do GitHub (repositorio publico). Roda 1x por dia pela tarefa YuiAtualizar.
# - Compara o commit mais novo do GitHub com o instalado (arquivo C:\Yui\.versao-instalada).
# - Se mudou: baixa o zip, faz backup do codigo atual, copia por cima SEM tocar em .env, bancos,
#   segredos, logs, node_modules, ambientes Python nem arquivos de dados que a Yui altera sozinha.
# - Reinstala dependencias se o package-lock mudou, reinicia a tarefa YuiBot e confere se subiu.
#   Se nao subir, volta o codigo anterior automaticamente.
# - Modo DOIS PROCESSOS (etapa 4: YUI_CEREBRO_EXTERNO=true no .env de C:\Yui): a tarefa YuiBot roda o supervisor
#   (node src/supervisor.js), que sobe o cerebro e depois o bot. O teste de subida testa as DUAS entradas (o cerebro sozinho
#   responde a saude e o bot conecta nele), o reinicio pede antes a parada limpa ao supervisor (arquivo logs\supervisor.parar)
#   e a conferencia exige os dois processos de pe. Sem a chave, tudo exatamente como antes. Nada e encerrado por PID achado em
#   varredura: so os processos que este script abriu (pelo objeto do processo) ou a tarefa inteira (Stop-ScheduledTask).
# Uso manual: powershell -ExecutionPolicy Bypass -File atualizar-yui.ps1 [-Forcar]
param(
    [switch]$Forcar,
    [string]$Repo = 'MauroBragaFilho/Yui',
    [string]$Branch = 'main',
    [string]$Destino = 'C:\Yui'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$log = 'C:\Tools\atualizar-yui.log'
$backups = 'C:\Yui-backup'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

function Log($m) {
    $l = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Add-Content -Path $log -Value $l -Encoding ascii
    Write-Host $l
}

# Roda o npm e decide so pelo codigo de saida. O npm escreve "npm notice" e avisos no stderr; no Windows PowerShell 5.1, com
# $ErrorActionPreference = 'Stop' (como este script), cada linha do stderr de um programa nativo vira um erro fatal e a atualizacao
# parava depois de copiar o codigo, sem reiniciar. Por isso o stderr vai para o stdout DENTRO do cmd (2>&1) e o 'Stop' fica
# desligado so aqui. Devolve o codigo de saida do npm.
function Rodar-Npm([string]$argumentos) {
    $ErrorActionPreference = 'Continue'
    cmd /c "npm $argumentos 2>&1" | Out-Null
    $codigo = $LASTEXITCODE
    $global:LASTEXITCODE = 0
    return $codigo
}

# Modo dois processos (etapa 4): a chave YUI_CEREBRO_EXTERNO=true no .env da Yui. Linhas comentadas e outras variaveis nao contam.
function Modo-Separado([string]$raiz) {
    $envFile = Join-Path $raiz '.env'
    if (-not (Test-Path $envFile)) { return $false }
    foreach ($linha in (Get-Content $envFile -Encoding UTF8)) {
        if ($linha -match '^\s*YUI_CEREBRO_EXTERNO\s*=\s*["'']?true["'']?\s*(#.*)?$') { return $true }
    }
    return $false
}

# Processos da Yui, so para SABER se existem (nunca para encerrar): no modo dois, o supervisor, o cerebro e o bot.
function Processos-Yui([string]$padrao = 'src.index.js') {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $padrao })
}

function YuiRodando([int]$minSegundos) {
    if ($script:Dois) {
        # Os dois de pe ha pelo menos `minSegundos`: o cerebro e o bot (um bot que cai no login e religado pelo supervisor e nunca chega la).
        $c = Processos-Yui 'src.cerebro.js' | Select-Object -First 1
        $b = Processos-Yui 'src.index.js' | Select-Object -First 1
        if (-not $c -or -not $b) { return $false }
        foreach ($p in @($c, $b)) { if (((Get-Date) - $p.CreationDate).TotalSeconds -lt $minSegundos) { return $false } }
        return $true
    }
    $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src.index.js' } | Select-Object -First 1
    if (-not $p) { return $false }
    return ((Get-Date) - $p.CreationDate).TotalSeconds -ge $minSegundos
}

function Reiniciar-Yui {
    $padrao = 'src.index.js'
    if ($script:Dois) {
        # Pedido limpo ao supervisor: ele desliga o bot e depois o cerebro (soltando as travas de dono) e sai. Sem isso o Stop da
        # tarefa derruba os dois a forca e o proximo cerebro espera ~75 s as travas vencerem.
        $padrao = 'src.(supervisor|cerebro|index).js'
        $parar = Join-Path $Destino 'logs\supervisor.parar'
        New-Item -ItemType Directory -Force (Split-Path $parar) | Out-Null
        Set-Content $parar (Get-Date -Format 'o') -Encoding ascii
        for ($i = 0; $i -lt 30 -and (Processos-Yui $padrao).Count -gt 0; $i++) { Start-Sleep 2 }
    }
    Stop-ScheduledTask -TaskName YuiBot -ErrorAction SilentlyContinue
    # espera o node antigo morrer E a tarefa sair de "Running": com a tarefa ainda Running o Start e ignorado (MultipleInstances=IgnoreNew)
    # e a Yui so voltava no reinicio automatico, 1 minuto depois (foi o que fez o update de 11/11 ser desfeito sem motivo).
    for ($i = 0; $i -lt 20 -and ((Processos-Yui $padrao).Count -gt 0 -or (Get-ScheduledTask -TaskName YuiBot).State -eq 'Running'); $i++) { Start-Sleep 2 }
    if ($script:Dois) { Remove-Item (Join-Path $Destino 'logs\supervisor.parar') -Force -ErrorAction SilentlyContinue }
    Start-ScheduledTask -TaskName YuiBot
}

# Apaga uma pasta temporaria do atualizador SEM seguir a juncao node_modules que o teste de subida cria (ela aponta para o
# node_modules de verdade): a juncao sai primeiro, com `rmdir` (que so remove o link), e so depois a pasta.
function Remover-Temporario([string]$dir) {
    $ErrorActionPreference = 'Continue'
    if (-not (Test-Path $dir)) { return }
    Get-ChildItem $dir -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } |
        Sort-Object { $_.FullName.Length } -Descending |
        ForEach-Object { cmd /c "rmdir `"$($_.FullName)`" >nul 2>nul" }
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
}

# Espera a Yui ficar de pe: no notebook (HD, 4 GB) o primeiro carregamento depois de trocar o codigo leva mais de 30 s.
# Passou quando o processo vive ha pelo menos `minSegundos`; um erro de inicializacao reinicia o processo a cada ~15 s e nunca chega la.
# Teste de subida ANTES de mexer em C:\Yui: sobe o codigo novo numa pasta temporaria, sem token real e sem portas, e confere que ele chega ate
# o login do Discord sem erro de importacao/sintaxe. Pega o tipo de defeito que derrubou o update de 11/11 (arquivo novo que nao chegava).
# Devolve $null se passou, ou o motivo se falhou.
function Testar-Subida([string]$pasta, [string]$modulos) {
    $nodeExe = 'C:\Program Files\nodejs\node.exe'
    if (-not (Test-Path $nodeExe)) { return $null }   # sem node no caminho padrao: nao ha como testar, segue como antes
    if (-not (Test-Path "$pasta\node_modules")) { cmd /c mklink /J "$pasta\node_modules" $modulos | Out-Null }
    $out = Join-Path $pasta 'preflight-saida.txt'; $err = Join-Path $pasta 'preflight-erro.txt'
    $antes = @{}
    foreach ($k in 'DISCORD_TOKEN', 'YUI_API_ENABLED', 'YUI_GATEWAY_ENABLED', 'GTA_WEEKLY_ENABLED') { $antes[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }
    $env:DISCORD_TOKEN = 'token-falso-de-teste'; $env:YUI_API_ENABLED = 'false'; $env:YUI_GATEWAY_ENABLED = 'false'; $env:GTA_WEEKLY_ENABLED = 'false'
    $p = $null
    try {
        $p = Start-Process $nodeExe -ArgumentList 'src/index.js' -WorkingDirectory $pasta -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
        $fim = (Get-Date).AddSeconds(150)
        while (-not $p.HasExited -and (Get-Date) -lt $fim) { Start-Sleep 3 }
        if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }   # o processo que NOS abrimos (guardado em $p), nunca um achado por varredura
    } finally {
        foreach ($k in $antes.Keys) { [Environment]::SetEnvironmentVariable($k, $antes[$k], 'Process') }
    }
    $saida = if (Test-Path $out) { Get-Content $out -Raw -Encoding UTF8 } else { '' }
    $erro = if (Test-Path $err) { Get-Content $err -Raw -Encoding UTF8 } else { '' }
    if ($erro -match 'ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError|Cannot find (module|package)|ERR_PACKAGE_PATH_NOT_EXPORTED') {
        return ('erro ao carregar o codigo novo: ' + (($erro -split "`n" | Where-Object { $_ -match 'Error' } | Select-Object -First 1) -replace '\s+', ' ').Trim())
    }
    if ($saida -notmatch 'Inicializando Yui') { return 'o codigo novo nem chegou a iniciar (sem "Inicializando Yui" na saida)' }
    if ($saida -notmatch 'Falha ao logar no Discord|DISCORD_TOKEN') { return 'o codigo novo nao chegou ate o login do Discord em 150 s' }
    return $null
}

function Porta-Livre {
    $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
    $l.Start(); $porta = $l.LocalEndpoint.Port; $l.Stop()
    return $porta
}

# Teste de subida do modo DOIS PROCESSOS (etapa 4), ANTES de mexer em C:\Yui, na pasta temporaria do codigo novo:
#  1. os modulos do supervisor carregam (node src/supervisor.js e o que a tarefa roda);
#  2. o CEREBRO sozinho sobe e responde /v1/health (porta livre aleatoria, so em 127.0.0.1);
#  3. o BOT (YUI_CEREBRO_EXTERNO=true, token falso) conecta no canal desse cerebro e chega ate o login do Discord.
# Tudo isolado da producao: bancos numa pasta vazia do teste (nunca os de C:\Yui\database nem as travas deles), segredo do canal
# na pasta do teste, porta do canal aleatoria, API e Gateway de producao intocados, sem .env (a pasta temporaria nao tem). Ao fim,
# o cerebro de teste e encerrado PELO OBJETO DO PROCESSO que este script abriu. Devolve $null se passou, ou o motivo.
function Testar-Subida-Dois([string]$pasta, [string]$modulos, [string]$nodeExe = 'C:\Program Files\nodejs\node.exe', [int]$prazoBotSeg = 150) {
    $ErrorActionPreference = 'Continue'   # avisos do node no stderr nao podem virar erro fatal no PowerShell 5.1
    if (-not (Test-Path $nodeExe)) { return $null }   # sem node no caminho padrao: nao ha como testar, segue como antes
    foreach ($f in 'src\supervisor.js', 'src\cerebro.js', 'src\index.js') {
        if (-not (Test-Path (Join-Path $pasta $f))) { return "o codigo novo nao tem $f (necessario com YUI_CEREBRO_EXTERNO=true)" }
    }
    if (-not (Test-Path "$pasta\node_modules")) { cmd /c mklink /J "$pasta\node_modules" $modulos | Out-Null }
    $teste = Join-Path $pasta 'preflight-dois'
    New-Item -ItemType Directory -Force "$teste\database", "$teste\secrets" | Out-Null
    $outC = Join-Path $teste 'cerebro-saida.txt'; $errC = Join-Path $teste 'cerebro-erro.txt'
    $outB = Join-Path $teste 'bot-saida.txt'; $errB = Join-Path $teste 'bot-erro.txt'
    $porta = Porta-Livre
    $vars = @{
        DISCORD_TOKEN = 'token-falso-de-teste'; YUI_API_ENABLED = 'true'; YUI_API_HOST = '127.0.0.1'; YUI_API_PORT = "$porta"
        YUI_API_TOKENS = ('preflight-' + [guid]::NewGuid().ToString('N') + '=100000000000000001'); YUI_GATEWAY_ENABLED = 'false'
        GTA_WEEKLY_ENABLED = 'false'; DATABASE_DIR = "$teste\database"; YUI_CHANNEL_SECRET_FILE = "$teste\secrets\channel-secret.json"
        YUI_CHANNEL_PORT = '0'; YUI_ALERTS = 'false'; YUI_MORNING_REPORT = 'false'; YUI_HEALTH_REPORT = 'false'
        YUI_CEREBRO_EXTERNO = $null; YUI_DB_OWNER_ROLE = $null
    }
    $antes = @{}
    foreach ($k in $vars.Keys) { $antes[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }
    $pc = $null; $pb = $null
    try {
        foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $vars[$k], 'Process') }

        # 1) os modulos do supervisor carregam (na pasta do codigo NOVO: os caminhos relativos do -e saem da pasta atual)
        Push-Location $pasta
        try {
            $chk = & $nodeExe --input-type=module -e "await import('./src/operacao/supervisor.js'); await import('./src/operacao/filho.js'); await import('./src/database/ownerLock.js'); await import('./src/database/owners.js');" 2>&1
            $codigoChk = $LASTEXITCODE
            $null = & $nodeExe --check 'src/supervisor.js' 2>&1
            $codigoSup = $LASTEXITCODE
        } finally { Pop-Location }
        $global:LASTEXITCODE = 0
        if ($codigoChk -ne 0) {
            # cada linha do stderr do node vem como texto (sem a moldura de erro do PowerShell)
            $linha = @($chk | ForEach-Object { $_.ToString() }) | Where-Object { $_ -match 'Error' -and $_ -notmatch 'NativeCommandError|FullyQualifiedErrorId|CategoryInfo' } | Select-Object -First 1
            return ('o supervisor do codigo novo nao carrega: ' + ([string]$linha -replace '\s+', ' ').Trim())
        }
        $global:LASTEXITCODE = 0
        if ($codigoSup -ne 0) { return 'src\supervisor.js do codigo novo tem erro de sintaxe' }

        # 2) o cerebro sozinho responde a saude
        $pc = Start-Process $nodeExe -ArgumentList 'src/cerebro.js' -WorkingDirectory $pasta -RedirectStandardOutput $outC -RedirectStandardError $errC -PassThru -WindowStyle Hidden
        $saude = $null
        $fim = (Get-Date).AddSeconds(120)
        while (-not $pc.HasExited -and (Get-Date) -lt $fim) {
            try { $saude = Invoke-RestMethod "http://127.0.0.1:$porta/v1/health" -TimeoutSec 5 } catch { $saude = $null }
            if ($saude -and $saude.ok) { break }
            Start-Sleep 2
        }
        $erroC = if (Test-Path $errC) { Get-Content $errC -Raw -Encoding UTF8 } else { '' }
        if ($erroC -match 'ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError|Cannot find (module|package)|ERR_PACKAGE_PATH_NOT_EXPORTED') {
            return ('erro ao carregar o cerebro novo: ' + (($erroC -split "`n" | Where-Object { $_ -match 'Error' } | Select-Object -First 1) -replace '\s+', ' ').Trim())
        }
        if (-not ($saude -and $saude.ok)) { return "o cerebro novo nao respondeu a saude em 120 s$(if ($pc.HasExited) { " (saiu com codigo $($pc.ExitCode))" })" }
        if ($null -ne $saude.discord.online) { return 'o /v1/health do cerebro novo nao tem o formato esperado (discord.online deveria ser null)' }

        # 3) o bot conecta no cerebro e chega ate o login
        [Environment]::SetEnvironmentVariable('YUI_CEREBRO_EXTERNO', 'true', 'Process')
        $pb = Start-Process $nodeExe -ArgumentList 'src/index.js' -WorkingDirectory $pasta -RedirectStandardOutput $outB -RedirectStandardError $errB -PassThru -WindowStyle Hidden
        $fim = (Get-Date).AddSeconds($prazoBotSeg)
        while (-not $pb.HasExited -and (Get-Date) -lt $fim) { Start-Sleep 3 }
        if (-not $pb.HasExited) { $pb.Kill(); $null = $pb.WaitForExit(10000) }   # o processo que NOS abrimos (objeto $pb), nunca um achado por varredura
        $saidaB = if (Test-Path $outB) { Get-Content $outB -Raw -Encoding UTF8 } else { '' }
        $erroB = if (Test-Path $errB) { Get-Content $errB -Raw -Encoding UTF8 } else { '' }
        if ($erroB -match 'ERR_MODULE_NOT_FOUND|SyntaxError|ReferenceError|Cannot find (module|package)|ERR_PACKAGE_PATH_NOT_EXPORTED') {
            return ('erro ao carregar o bot novo: ' + (($erroB -split "`n" | Where-Object { $_ -match 'Error' } | Select-Object -First 1) -replace '\s+', ' ').Trim())
        }
        if ($saidaB -notmatch 'Inicializando Yui') { return 'o bot novo nem chegou a iniciar (sem "Inicializando Yui" na saida)' }
        if ($saidaB -notmatch 'Conectado ao c.rebro pelo canal local') { return 'o bot novo nao conectou no canal do cerebro novo' }
        if ($saidaB -notmatch 'Falha ao logar no Discord|DISCORD_TOKEN') { return "o bot novo nao chegou ate o login do Discord em $prazoBotSeg s" }
        return $null
    } finally {
        if ($pc -and -not $pc.HasExited) { try { $pc.Kill(); $null = $pc.WaitForExit(10000) } catch { } }   # o cerebro de TESTE, pelo objeto que este script abriu
        if ($pb -and -not $pb.HasExited) { try { $pb.Kill(); $null = $pb.WaitForExit(10000) } catch { } }
        foreach ($k in $antes.Keys) { [Environment]::SetEnvironmentVariable($k, $antes[$k], 'Process') }
    }
}

# Leva o painel web versionado (apps\yui-app\painel-web) do codigo novo para C:\Yui\apps\yui-app\dist, com troca atomica e a versao anterior
# guardada em dist-antigo. Tambem leva o servidor do painel (apps\yui-app\scripts\serve-web.mjs) e, se ele mudou, reinicia a tarefa do painel
# (`aoMudarServidor`, injetavel para teste). So roda DEPOIS de a Yui nova ter subido, e NUNCA lanca erro: o painel nao pode derrubar a
# atualizacao da Yui. Devolve o texto para o log.
function Atualizar-Painel([string]$novo, [string]$destino, [scriptblock]$aoMudarServidor = { Stop-ScheduledTask -TaskName YuiWebApp -ErrorAction SilentlyContinue; Start-Sleep 3; Start-ScheduledTask -TaskName YuiWebApp }) {
    $app = Join-Path $destino 'apps\yui-app'
    $tmp = Join-Path $app 'dist-novo'
    try {
        $origem = Join-Path $novo 'apps\yui-app\painel-web'
        if (-not (Test-Path "$origem\index.html")) { return 'painel: o codigo novo nao traz apps\yui-app\painel-web; nada a fazer' }
        if (-not (Test-Path $app)) { return 'painel: nao existe apps\yui-app aqui; nada a fazer' }
        $partes = @()

        # 1) o painel compilado
        $fonteNova = Get-Content "$origem\.fonte" -ErrorAction SilentlyContinue | Select-Object -First 1
        $fonteAtual = if (Test-Path "$app\dist\.fonte") { Get-Content "$app\dist\.fonte" | Select-Object -First 1 } else { '' }
        if ($fonteNova -and $fonteNova -eq $fonteAtual) {
            $partes += 'painel: ja esta na versao do codigo novo'
        } else {
            if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
            robocopy $origem $tmp /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "robocopy do painel falhou (codigo $LASTEXITCODE)" }
            $global:LASTEXITCODE = 0
            if (-not (Test-Path "$tmp\index.html")) { throw 'a copia do painel nao tem index.html' }
            $html = Get-Content "$tmp\index.html" -Raw
            if ($html -match 'src="(/_expo/static/js/web/[^"]+\.js)"') {
                $bundle = Join-Path $tmp ($Matches[1].TrimStart('/').Replace('/', '\'))
                if (-not (Test-Path $bundle)) { throw 'o bundle citado no index.html nao esta na copia' }
            }
            if (Test-Path "$app\dist-antigo") { Remove-Item "$app\dist-antigo" -Recurse -Force }
            if (Test-Path "$app\dist") { Rename-Item "$app\dist" 'dist-antigo' }
            Rename-Item $tmp 'dist'
            $partes += 'painel: atualizado (a versao anterior ficou em apps\yui-app\dist-antigo)'
        }

        # 2) o servidor do painel (compara o texto sem o CR, porque a copia feita a mao pode ter CRLF e o zip do GitHub tem LF)
        $srvNovo = Join-Path $novo 'apps\yui-app\scripts\serve-web.mjs'
        $srvAtual = Join-Path $app 'scripts\serve-web.mjs'
        if (Test-Path $srvNovo) {
            $txtNovo = (Get-Content $srvNovo -Raw) -replace "`r", ''
            $txtAtual = if (Test-Path $srvAtual) { (Get-Content $srvAtual -Raw) -replace "`r", '' } else { '' }
            if ($txtNovo -ne $txtAtual) {
                New-Item -ItemType Directory -Force (Split-Path $srvAtual) | Out-Null
                Copy-Item $srvNovo $srvAtual -Force
                try { & $aoMudarServidor; $partes += 'servidor do painel: atualizado e reiniciado' } catch { $partes += "AVISO: servidor do painel copiado, mas nao reiniciei ($($_.Exception.Message))" }
            }
        }
        return ($partes -join '; ')
    } catch {
        $erro = $_.Exception.Message
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
        if (-not (Test-Path "$app\dist") -and (Test-Path "$app\dist-antigo")) { Rename-Item "$app\dist-antigo" 'dist' -ErrorAction SilentlyContinue }
        return "AVISO: painel NAO atualizado ($erro); segue o painel anterior"
    }
}

function Esperar-Yui([int]$minSegundos, [int]$maxSegundos) {
    $fim = (Get-Date).AddSeconds($maxSegundos)
    while ((Get-Date) -lt $fim) {
        if (YuiRodando $minSegundos) { return $true }
        Start-Sleep 5
    }
    return $false
}

$mutex = New-Object Threading.Mutex($false, 'Global\YuiAtualizar')
if (-not $mutex.WaitOne(0)) { Log 'Ja existe uma atualizacao em andamento.'; exit 0 }
$script:Dois = Modo-Separado $Destino

try {
    $hdr = @{ 'User-Agent' = 'yui-atualizador'; 'Accept' = 'application/vnd.github+json' }
    $remoto = (Invoke-RestMethod "https://api.github.com/repos/$Repo/commits/$Branch" -Headers $hdr -TimeoutSec 30).sha
    $arqVersao = Join-Path $Destino '.versao-instalada'
    $local = if (Test-Path $arqVersao) { (Get-Content $arqVersao -Raw).Trim() } else { '' }

    if ($remoto -eq $local -and -not $Forcar) { Log "Sem novidades (versao $($remoto.Substring(0,7)))."; return }
    Log "Atualizando de '$(if($local){$local.Substring(0,7)}else{'desconhecida'})' para $($remoto.Substring(0,7))..."

    $tmp = Join-Path $env:TEMP 'yui-update'
    if (Test-Path $tmp) { Remover-Temporario $tmp }
    New-Item -ItemType Directory $tmp | Out-Null
    Invoke-WebRequest "https://github.com/$Repo/archive/$remoto.zip" -OutFile "$tmp\yui.zip" -UseBasicParsing -TimeoutSec 600
    Expand-Archive "$tmp\yui.zip" "$tmp\x" -Force
    $novo = (Get-ChildItem "$tmp\x" -Directory | Select-Object -First 1).FullName
    if (-not (Test-Path "$novo\package.json")) { throw 'zip baixado nao parece ser a Yui (sem package.json)' }

    # Supply chain: o package-lock novo so pode apontar para o registro oficial do npm, com hash de integridade forte (sem git, http, arquivo local nem hash fraco).
    # O verificador usado e o JA INSTALADO (da versao anterior, que e confiavel); so na primeira vez, quando ele ainda nao existe, usa o do codigo novo.
    $nodeLock = 'C:\Program Files\nodejs\node.exe'
    if ((Test-Path $nodeLock) -and (Test-Path "$novo\package-lock.json")) {
        $verificador = if (Test-Path "$Destino\scripts\verificar-lock.mjs") { "$Destino\scripts\verificar-lock.mjs" } else { "$novo\scripts\verificar-lock.mjs" }
        $saidaLock = & $nodeLock $verificador "$novo\package-lock.json" "$Destino\package-lock.json"
        $codigoLock = $LASTEXITCODE
        $global:LASTEXITCODE = 0
        foreach ($l in $saidaLock) { Log "package-lock: $l" }
        if ($codigoLock -ne 0) {
            Log "ERRO: o package-lock novo foi recusado (codigo $codigoLock). Nada foi alterado em $Destino; tenta de novo amanha."
            return
        }
    }

    # Teste de subida do codigo novo antes de tocar na Yui. Se o package-lock mudou, as dependencias novas ainda nao estao em node_modules
    # (o npm install roda depois), entao nesse caso o teste e pulado e a conferencia fica por conta do rollback.
    $lockNovo = if (Test-Path "$novo\package-lock.json") { (Get-FileHash "$novo\package-lock.json").Hash } else { '' }
    $lockAtual = if (Test-Path "$Destino\package-lock.json") { (Get-FileHash "$Destino\package-lock.json").Hash } else { '' }
    if ($lockNovo -eq $lockAtual) {
        if ($script:Dois) {
            Log 'Testando a subida do codigo novo antes de aplicar (modo dois processos: o cerebro sozinho e o bot conectando nele)...'
            $motivo = Testar-Subida-Dois $novo (Join-Path $Destino 'node_modules')
        } else {
            Log 'Testando a subida do codigo novo antes de aplicar...'
            $motivo = Testar-Subida $novo (Join-Path $Destino 'node_modules')
        }
        if ($motivo) {
            Log "ERRO: o teste de subida falhou ($motivo). Nada foi alterado em $Destino; tenta de novo amanha."
            return
        }
        Log 'Teste de subida: OK.'
    } else {
        Log 'package-lock mudou: teste de subida pulado (dependencias novas).'
    }

    # backup do codigo atual (so o que muda de versao para versao)
    $bk = Join-Path $backups ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $(if ($local) { $local.Substring(0, 7) } else { 'anterior' }))
    New-Item -ItemType Directory -Force $bk | Out-Null
    robocopy "$Destino\src" "$bk\src" /E /NFL /NDL /NJH /NJS /NP | Out-Null
    foreach ($f in 'package.json', 'package-lock.json') { if (Test-Path "$Destino\$f") { Copy-Item "$Destino\$f" $bk } }
    Get-ChildItem $backups -Directory | Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Recurse -Force
    $lockAntes = if (Test-Path "$Destino\package-lock.json") { (Get-FileHash "$Destino\package-lock.json").Hash } else { '' }

    # copia por cima (sem apagar nada) e sem tocar em dados da maquina
    # As pastas excluidas sao as da RAIZ (caminho completo). Excluir so pelo nome pulava tambem src\database (codigo da Yui) e a
    # Yui nova caia com ERR_MODULE_NOT_FOUND ao importar arquivo novo dessa pasta (update de 11/11).
    $xd = 'database', 'logs', 'secrets', 'node_modules', '.venv-deemix', '.venv-spotdl', '.git', 'apps' | ForEach-Object { Join-Path $novo $_ }
    robocopy $novo $Destino /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP `
        /XD $xd `
        /XF .env Yui.pem bans.json vehicles.json tunables-decrypted.json cache.json reddit-cookies-cache.json *.db | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy falhou (codigo $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0

    $lockDepois = (Get-FileHash "$Destino\package-lock.json").Hash
    if ($lockAntes -ne $lockDepois) {
        Log 'package-lock mudou: instalando dependencias (npm install)...'
        $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
        Push-Location $Destino
        try { $codigoNpm = Rodar-Npm 'install --no-audit --no-fund'; if ($codigoNpm -ne 0) { throw "npm install saiu com codigo $codigoNpm" } } finally { Pop-Location }
    }

    Reiniciar-Yui
    Log "Yui reiniciada$(if ($script:Dois) { ' (dois processos: cerebro e bot)' }); aguardando ate 4 min para ela ficar de pe..." 
    if (Esperar-Yui 60 240) {
        Set-Content $arqVersao $remoto -Encoding ascii
        Log "OK: Yui rodando na versao $($remoto.Substring(0,7))."
        Log (Atualizar-Painel $novo $Destino)
    } else {
        Log 'ERRO: a Yui nao ficou de pe. Voltando a versao anterior...'
        robocopy "$bk\src" "$Destino\src" /E /NFL /NDL /NJH /NJS /NP | Out-Null
        foreach ($f in 'package.json', 'package-lock.json') { if (Test-Path "$bk\$f") { Copy-Item "$bk\$f" $Destino -Force } }
        if ($lockAntes -ne $lockDepois) {
            Push-Location $Destino; try { $null = Rodar-Npm 'install --no-audit --no-fund' } finally { Pop-Location }
        }
        $global:LASTEXITCODE = 0
        Reiniciar-Yui
        Log 'Rollback concluido. A versao nova NAO foi marcada como instalada (tenta de novo amanha).'
    }
} catch {
    Log "FALHA: $($_.Exception.Message)"
    exit 1
} finally {
    $mutex.ReleaseMutex()
    if (Test-Path (Join-Path $env:TEMP 'yui-update')) { Remover-Temporario (Join-Path $env:TEMP 'yui-update') }
}
