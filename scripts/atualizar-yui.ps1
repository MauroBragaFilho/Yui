# Atualiza a Yui a partir do GitHub (repositorio publico). Roda 1x por dia pela tarefa YuiAtualizar.
# - Compara o commit mais novo do GitHub com o instalado (arquivo C:\Yui\.versao-instalada).
# - Se mudou: baixa o zip, faz backup do codigo atual, copia por cima SEM tocar em .env, bancos,
#   segredos, logs, node_modules, ambientes Python nem arquivos de dados que a Yui altera sozinha.
# - Reinstala dependencias se o package-lock mudou, reinicia a tarefa YuiBot e confere se subiu.
#   Se nao subir, volta o codigo anterior automaticamente.
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

function YuiRodando([int]$minSegundos) {
    $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src.index.js' } | Select-Object -First 1
    if (-not $p) { return $false }
    return ((Get-Date) - $p.CreationDate).TotalSeconds -ge $minSegundos
}

function Reiniciar-Yui {
    Stop-ScheduledTask -TaskName YuiBot -ErrorAction SilentlyContinue
    # espera o node antigo morrer E a tarefa sair de "Running": com a tarefa ainda Running o Start e ignorado (MultipleInstances=IgnoreNew)
    # e a Yui so voltava no reinicio automatico, 1 minuto depois (foi o que fez o update de 11/11 ser desfeito sem motivo).
    for ($i = 0; $i -lt 20 -and ((Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src.index.js' }) -or (Get-ScheduledTask -TaskName YuiBot).State -eq 'Running'); $i++) { Start-Sleep 2 }
    Start-ScheduledTask -TaskName YuiBot
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

# Leva o painel web versionado (apps\yui-app\painel-web) do codigo novo para C:\Yui\apps\yui-app\dist, com troca atomica e a versao anterior
# guardada em dist-antigo. So roda DEPOIS de a Yui nova ter subido, e NUNCA lanca erro: o painel nao pode derrubar a atualizacao da Yui.
# Devolve o texto para o log.
function Atualizar-Painel([string]$novo, [string]$destino) {
    $app = Join-Path $destino 'apps\yui-app'
    $tmp = Join-Path $app 'dist-novo'
    try {
        $origem = Join-Path $novo 'apps\yui-app\painel-web'
        if (-not (Test-Path "$origem\index.html")) { return 'painel: o codigo novo nao traz apps\yui-app\painel-web; nada a fazer' }
        if (-not (Test-Path $app)) { return 'painel: nao existe apps\yui-app aqui; nada a fazer' }
        $fonteNova = Get-Content "$origem\.fonte" -ErrorAction SilentlyContinue | Select-Object -First 1
        $fonteAtual = if (Test-Path "$app\dist\.fonte") { Get-Content "$app\dist\.fonte" | Select-Object -First 1 } else { '' }
        if ($fonteNova -and $fonteNova -eq $fonteAtual) { return 'painel: ja esta na versao do codigo novo' }
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
        return 'painel: atualizado (a versao anterior ficou em apps\yui-app\dist-antigo)'
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

try {
    $hdr = @{ 'User-Agent' = 'yui-atualizador'; 'Accept' = 'application/vnd.github+json' }
    $remoto = (Invoke-RestMethod "https://api.github.com/repos/$Repo/commits/$Branch" -Headers $hdr -TimeoutSec 30).sha
    $arqVersao = Join-Path $Destino '.versao-instalada'
    $local = if (Test-Path $arqVersao) { (Get-Content $arqVersao -Raw).Trim() } else { '' }

    if ($remoto -eq $local -and -not $Forcar) { Log "Sem novidades (versao $($remoto.Substring(0,7)))."; return }
    Log "Atualizando de '$(if($local){$local.Substring(0,7)}else{'desconhecida'})' para $($remoto.Substring(0,7))..."

    $tmp = Join-Path $env:TEMP 'yui-update'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory $tmp | Out-Null
    Invoke-WebRequest "https://github.com/$Repo/archive/$remoto.zip" -OutFile "$tmp\yui.zip" -UseBasicParsing -TimeoutSec 600
    Expand-Archive "$tmp\yui.zip" "$tmp\x" -Force
    $novo = (Get-ChildItem "$tmp\x" -Directory | Select-Object -First 1).FullName
    if (-not (Test-Path "$novo\package.json")) { throw 'zip baixado nao parece ser a Yui (sem package.json)' }

    # Teste de subida do codigo novo antes de tocar na Yui. Se o package-lock mudou, as dependencias novas ainda nao estao em node_modules
    # (o npm install roda depois), entao nesse caso o teste e pulado e a conferencia fica por conta do rollback.
    $lockNovo = if (Test-Path "$novo\package-lock.json") { (Get-FileHash "$novo\package-lock.json").Hash } else { '' }
    $lockAtual = if (Test-Path "$Destino\package-lock.json") { (Get-FileHash "$Destino\package-lock.json").Hash } else { '' }
    if ($lockNovo -eq $lockAtual) {
        Log 'Testando a subida do codigo novo antes de aplicar...'
        $motivo = Testar-Subida $novo (Join-Path $Destino 'node_modules')
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
        try { npm install --no-audit --no-fund 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "npm install saiu com codigo $LASTEXITCODE" } } finally { Pop-Location }
    }

    Reiniciar-Yui
    Log 'Yui reiniciada; aguardando ate 4 min para ela ficar de pe...'
    if (Esperar-Yui 60 240) {
        Set-Content $arqVersao $remoto -Encoding ascii
        Log "OK: Yui rodando na versao $($remoto.Substring(0,7))."
        Log (Atualizar-Painel $novo $Destino)
    } else {
        Log 'ERRO: a Yui nao ficou de pe. Voltando a versao anterior...'
        robocopy "$bk\src" "$Destino\src" /E /NFL /NDL /NJH /NJS /NP | Out-Null
        foreach ($f in 'package.json', 'package-lock.json') { if (Test-Path "$bk\$f") { Copy-Item "$bk\$f" $Destino -Force } }
        if ($lockAntes -ne $lockDepois) {
            Push-Location $Destino; try { npm install --no-audit --no-fund 2>&1 | Out-Null } finally { Pop-Location }
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
    if (Test-Path (Join-Path $env:TEMP 'yui-update')) { Remove-Item (Join-Path $env:TEMP 'yui-update') -Recurse -Force -ErrorAction SilentlyContinue }
}
