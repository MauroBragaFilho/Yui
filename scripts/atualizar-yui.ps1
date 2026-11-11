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
