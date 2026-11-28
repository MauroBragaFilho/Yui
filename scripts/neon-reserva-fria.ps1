# RESERVA FRIA da Yui no PC "Neon": uma instalacao PARADA que sobe em poucos minutos se o notebook morrer. Acionada so a mao.
#   -Preparar   instala/atualiza o codigo (GitHub main) + npm ci. SEM .env, SEM chave, NAO inicia nada. Pode rodar de tempos em tempos.
#   -Ativar     EMERGENCIA: confere que o notebook NAO responde, restaura o ultimo backup, copia o .env e inicia o supervisor.
#   -Desativar  para a reserva pelo arquivo logs\supervisor.parar (nunca por PID).
#   -Status     mostra o estado (reserva, backup baixado, notebook).
# Exemplos:
#   .\neon-reserva-fria.ps1 -Preparar
#   .\neon-reserva-fria.ps1 -Ativar -ArquivoChave E:\pendrive\backup.key -ArquivoEnv E:\pendrive\env-yui.txt -NotebookUrl https://NOME.ts.net:3939
#   .\neon-reserva-fria.ps1 -Desativar
# A chave de cifra e o .env sao informados NA HORA (caminhos), nunca guardados por este script. So ASCII neste arquivo.
param(
    [switch]$Preparar,
    [switch]$Ativar,
    [switch]$Desativar,
    [switch]$Status,
    [string]$Reserva = 'D:\YuiReserva',                 # onde fica a Yui de reserva
    [string]$BackupRepo = 'D:\YuiBackup\offsite',       # onde o neon-backup-puxar.ps1 guarda os backups cifrados
    [string]$ArquivoChave = '',                         # (Ativar) arquivo com a chave de cifra do backup
    [string]$ArquivoEnv = '',                           # (Ativar) copia do .env de producao
    [string]$NotebookUrl = $env:YUI_NOTEBOOK_URL,       # ex.: https://notebook-yui.xxxx.ts.net:3939 (so o endereco; a saude e /v1/health)
    [string]$NotebookNome = 'notebook-yui',             # nome do notebook no Tailscale (tailscale status)
    [switch]$ForcarNotebookLigado,                      # (Ativar) notebook ligado no Tailscale mas travado de vez; NUNCA vale se ele responder
    [string]$Repo = 'MauroBragaFilho/Yui',
    [string]$Branch = 'main',
    [string]$Log = 'D:\YuiBackup\reserva.log',
    [int]$EsperaSubidaSeg = 180
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'neon-comum.ps1')
function Log([string]$m) { Escrever-LinhaLog $Log $m }

$modos = @($Preparar, $Ativar, $Desativar, $Status) | Where-Object { $_ }
if (@($modos).Count -ne 1) {
    Write-Host 'Use exatamente um modo: -Preparar, -Ativar, -Desativar ou -Status. (Veja o cabecalho do script ou docs\GUIA_BACKUP_NEON_E_RESERVA.md)'
    exit 2
}

$saudeLocal = 'http://127.0.0.1:3939/v1/health'
$arquivoParar = Join-Path $Reserva 'logs\supervisor.parar'

function Reserva-Rodando { return ((Test-RespondeSaude -Url $saudeLocal -TimeoutSec 3) -eq 'sim') }

function Achar-Node {
    $n = Get-Command node -ErrorAction SilentlyContinue
    if (-not $n) { throw 'Node.js nao encontrado no PATH. Instale o Node 22+ (o mesmo do notebook) e tente de novo.' }
    return $n.Source
}

# ---------------------------------------------------------------- Preparar
if ($Preparar) {
    if (Reserva-Rodando) { Log 'PREPARAR recusado: ha uma Yui respondendo em 127.0.0.1:3939. Use -Desativar antes.'; exit 1 }
    $node = Achar-Node
    $tmp = Join-Path $env:TEMP ('yui-reserva-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $zip = Join-Path $tmp 'yui.zip'
        Log "PREPARAR: baixando https://github.com/$Repo ($Branch)"
        Invoke-WebRequest -Uri "https://github.com/$Repo/archive/refs/heads/$Branch.zip" -OutFile $zip -UseBasicParsing
        Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force
        $origem = (Get-ChildItem (Join-Path $tmp 'x') -Directory | Select-Object -First 1).FullName
        if (-not (Test-Path (Join-Path $origem 'package.json'))) { throw 'o zip baixado nao parece ser a Yui (sem package.json)' }

        New-Item -ItemType Directory -Force $Reserva | Out-Null
        $lockAntigo = $null
        $lockNovo = (Get-FileHash (Join-Path $origem 'package-lock.json') -Algorithm SHA256).Hash
        $arqLock = Join-Path $Reserva '.lock-instalado'
        if (Test-Path $arqLock) { $lockAntigo = (Get-Content $arqLock -Raw).Trim() }

        # Copia o codigo por cima, SEM tocar em .env, bancos, logs, segredos, node_modules e nos 4 arquivos de dados que a Yui altera sozinha.
        $rc = & robocopy $origem $Reserva /E /XD node_modules database logs secrets .git .claude /XF .env '.env.*' bans.json accepted_servers.json server_settings.json server_tools.json /NFL /NDL /NJH /NJS /NP
        if ($LASTEXITCODE -ge 8) { throw "robocopy falhou (codigo $LASTEXITCODE)" }

        if ($lockAntigo -ne $lockNovo -or -not (Test-Path (Join-Path $Reserva 'node_modules'))) {
            Log 'PREPARAR: instalando dependencias (npm ci), pode levar alguns minutos'
            Push-Location $Reserva
            try {
                & npm ci --no-audit --no-fund
                if ($LASTEXITCODE -ne 0) { throw "npm ci falhou (codigo $LASTEXITCODE)" }
            } finally { Pop-Location }
            Set-Content -Path $arqLock -Value $lockNovo -Encoding Ascii
        } else { Log 'PREPARAR: dependencias iguais as instaladas; npm ci dispensado' }
        Set-Content -Path (Join-Path $Reserva '.versao-reserva') -Value ("{0} {1}@{2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm'), $Repo, $Branch) -Encoding Ascii
        Log "PREPARAR OK: reserva pronta em $Reserva (sem .env, parada). Node: $node"
    } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    exit 0
}

# ---------------------------------------------------------------- Status
if ($Status) {
    Write-Host "=== Reserva fria da Yui ==="
    $versao = Join-Path $Reserva '.versao-reserva'
    Write-Host ("Codigo da reserva : " + $(if (Test-Path $versao) { (Get-Content $versao -Raw).Trim() + "  ($Reserva)" } else { "NAO preparado (rode -Preparar)" }))
    Write-Host ("node_modules      : " + $(if (Test-Path (Join-Path $Reserva 'node_modules')) { 'ok' } else { 'ausente' }))
    Write-Host (".env na reserva   : " + $(if (Test-Path (Join-Path $Reserva '.env')) { 'presente (reserva foi ativada alguma vez)' } else { 'ausente (normal: parada)' }))
    $lotes = @(Get-BackupsDoRepositorio -PastaBackups (Join-Path $BackupRepo 'backups'))
    $ok = @($lotes | Where-Object { $_.Completo })
    if ($ok.Count -gt 0) {
        $u = $ok[0]
        $h = if ($u.QuandoUtc) { [math]::Round(((Get-Date).ToUniversalTime() - $u.QuandoUtc).TotalHours, 1) } else { '?' }
        Write-Host "Backup baixado    : $($u.Nome) (${h} h atras, $($ok.Count) lotes completos)"
    } else { Write-Host "Backup baixado    : NENHUM em $BackupRepo (rode neon-backup-puxar.ps1)" }
    Write-Host ("Reserva rodando   : " + $(if (Reserva-Rodando) { 'SIM (127.0.0.1:3939 responde)' } else { 'nao' }))
    $ts = Get-EstadoTailscale -NomeNotebook $NotebookNome
    Write-Host ("Tailscale local   : " + $(if ($ts.LocalOk) { 'conectado' } else { 'NAO conectado' }))
    Write-Host ("Notebook no Tailscale : " + $ts.Peer)
    if ($NotebookUrl) { Write-Host ("Yui do notebook responde : " + (Test-RespondeSaude -Url ($NotebookUrl.TrimEnd('/') + '/v1/health'))) }
    else { Write-Host 'Yui do notebook responde : (informe -NotebookUrl para testar)' }
    exit 0
}

# ---------------------------------------------------------------- Desativar
if ($Desativar) {
    if (-not (Test-Path $Reserva)) { Log 'DESATIVAR: a pasta da reserva nao existe.'; exit 1 }
    if (-not (Reserva-Rodando)) { Log 'DESATIVAR: a reserva ja esta parada (nada responde em 127.0.0.1:3939).'; exit 0 }
    New-Item -ItemType Directory -Force (Join-Path $Reserva 'logs') | Out-Null
    Set-Content -Path $arquivoParar -Value ('parar ' + (Get-Date -Format o)) -Encoding Ascii
    Log 'DESATIVAR: pedido de parada limpa criado (logs\supervisor.parar); aguardando o supervisor encerrar o bot e o cerebro'
    $fim = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $fim) {
        Start-Sleep -Seconds 3
        if (-not (Reserva-Rodando)) { Log 'DESATIVAR OK: a reserva parou.'; exit 0 }
    }
    Log 'DESATIVAR: ainda responde apos 90 s. Nada foi encerrado a forca. Veja logs\supervisor.log na reserva e tente de novo.'
    exit 1
}

# ---------------------------------------------------------------- Ativar
$cron = [System.Diagnostics.Stopwatch]::StartNew()
$etapas = New-Object System.Collections.ArrayList
function Marca([string]$nome) { [void]$etapas.Add(("{0}: {1:n0}s" -f $nome, $cron.Elapsed.TotalSeconds)); Log ("  [{0:n0}s] {1}" -f $cron.Elapsed.TotalSeconds, $nome) }

Write-Host ''
Write-Host '*** ATIVAR A RESERVA FRIA DA YUI ***' -ForegroundColor Yellow
Write-Host 'Isto liga um SEGUNDO bot com o token do Discord de producao. So faca se o notebook estiver realmente fora.'
$resposta = Read-Host 'Para continuar digite exatamente: ATIVAR RESERVA'
if ($resposta -cne 'ATIVAR RESERVA') { Log 'ATIVAR cancelado (confirmacao nao digitada).'; exit 1 }
Log 'ATIVAR: inicio'

# 1) O notebook NAO pode responder.
$ts = Get-EstadoTailscale -NomeNotebook $NotebookNome
$resp = Test-RespondeSaude -Url $(if ($NotebookUrl) { $NotebookUrl.TrimEnd('/') + '/v1/health' } else { '' })
$dec = Resolve-DecisaoAtivar -NotebookRespondeu $resp -TailscaleLocalOk $ts.LocalOk -NotebookNaRede $ts.Peer -Forcar ([bool]$ForcarNotebookLigado)
Log ("ATIVAR: notebook responde=$resp tailscaleLocal=$($ts.LocalOk) notebookNaRede=$($ts.Peer) -> permitir=$($dec.Permitir)")
if (-not $dec.Permitir) { Log ('ATIVAR RECUSADO: ' + $dec.Motivo); Write-Host $dec.Motivo -ForegroundColor Red; exit 1 }
Marca 'notebook confirmado fora'

# 2) Pre-requisitos.
if (Reserva-Rodando) { Log 'ATIVAR RECUSADO: a reserva ja esta rodando (127.0.0.1:3939 responde).'; exit 1 }
$node = Achar-Node
if (-not (Test-Path (Join-Path $Reserva 'src\supervisor.js')) -or -not (Test-Path (Join-Path $Reserva 'node_modules'))) { Log 'ATIVAR RECUSADO: reserva nao preparada (rode -Preparar antes).'; exit 1 }
if (-not $ArquivoChave -or -not (Test-Path $ArquivoChave)) { Log 'ATIVAR RECUSADO: informe -ArquivoChave com o arquivo da chave de cifra.'; exit 1 }
if (-not $ArquivoEnv -or -not (Test-Path $ArquivoEnv)) { Log 'ATIVAR RECUSADO: informe -ArquivoEnv com a copia do .env de producao.'; exit 1 }
$lotes = @(Get-BackupsDoRepositorio -PastaBackups (Join-Path $BackupRepo 'backups') | Where-Object { $_.Completo })
if ($lotes.Count -eq 0) { Log "ATIVAR RECUSADO: nenhum backup completo em $BackupRepo."; exit 1 }
$lote = $lotes[0]
Log "ATIVAR: usando o backup $($lote.Nome)"

# 3) Restaura o backup (decifra, confere hashes) numa pasta temporaria e coloca cada arquivo no lugar.
$tmp = Join-Path $Reserva '.restauracao-tmp'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
$env:YUI_BACKUP_KEY_FILE = (Resolve-Path $ArquivoChave).Path   # so no ambiente DESTE processo e do filho; nada gravado
Push-Location $Reserva
try {
    & $node (Join-Path $Reserva 'scripts\restore-memory.mjs') --from $lote.Caminho --to $tmp
    if ($LASTEXITCODE -ne 0) { throw "restauracao falhou (codigo $LASTEXITCODE): chave errada ou backup danificado" }
} catch {
    Log ('ATIVAR ERRO: ' + $_.Exception.Message)
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    exit 1
} finally {
    Pop-Location
    Remove-Item Env:\YUI_BACKUP_KEY_FILE -ErrorAction SilentlyContinue
}
Marca 'backup restaurado e conferido'

$dbDir = Join-Path $Reserva 'database'
$dataDir = Join-Path $Reserva 'src\data'
New-Item -ItemType Directory -Force $dbDir, $dataDir | Out-Null
$guarda = Join-Path $dbDir ('anterior-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($f in Get-ChildItem $tmp -File) {
    $destinoDir = if ($f.Extension -eq '.db') { $dbDir } else { $dataDir }
    $alvo = Join-Path $destinoDir $f.Name
    if (Test-Path $alvo) {
        New-Item -ItemType Directory -Force $guarda | Out-Null
        Move-Item $alvo (Join-Path $guarda $f.Name) -Force
        foreach ($suf in '-wal', '-shm', '-journal') { if (Test-Path ($alvo + $suf)) { Move-Item ($alvo + $suf) (Join-Path $guarda ($f.Name + $suf)) -Force } }
    }
    Move-Item $f.FullName $alvo -Force
}
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue   # os bancos decifrados nao ficam soltos
Marca 'bancos no lugar'

# 4) .env (copia, nao guardada pelo script alem da propria reserva). Avisa so os NOMES das variaveis com caminho de disco.
Copy-Item $ArquivoEnv (Join-Path $Reserva '.env') -Force
$caminhos = @()
foreach ($l in (Get-Content (Join-Path $Reserva '.env') -Encoding UTF8)) {
    if ($l -match '^\s*([A-Za-z0-9_]+)\s*=\s*["'']?[A-Za-z]:[\\/]') { $caminhos += $Matches[1] }
}
if ($caminhos.Count -gt 0) { Log ('ATENCAO: estas variaveis do .env apontam para caminhos de disco do notebook, confira se existem aqui: ' + ($caminhos -join ', ')) }
Marca '.env copiado'

# 5) Sobe o supervisor (o mesmo comando da producao) e espera a saude local.
Remove-Item $arquivoParar -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $Reserva 'logs') | Out-Null
$null = Start-Process -FilePath $node -ArgumentList 'src/supervisor.js' -WorkingDirectory $Reserva -WindowStyle Minimized `
    -RedirectStandardOutput (Join-Path $Reserva 'logs\reserva-saida.log') -RedirectStandardError (Join-Path $Reserva 'logs\reserva-erro.log') -PassThru
Log 'ATIVAR: supervisor iniciado; esperando a saude em 127.0.0.1:3939'
$fim = (Get-Date).AddSeconds($EsperaSubidaSeg)
$subiu = $false
while ((Get-Date) -lt $fim) {
    Start-Sleep -Seconds 3
    if (Reserva-Rodando) { $subiu = $true; break }
}
if (-not $subiu) {
    Log "ATIVAR: a reserva NAO respondeu em $EsperaSubidaSeg s. Veja $Reserva\logs\supervisor.log e reserva-erro.log. Nada foi encerrado a forca (use -Desativar)."
    exit 1
}
Marca 'Yui respondendo'
$cron.Stop()
Log ('ATIVAR OK: reserva no ar em {0:n0} s. Etapas: {1}. Confira no Discord se a Yui esta online.' -f $cron.Elapsed.TotalSeconds, ($etapas -join ' | '))
Write-Host 'Lembre: quando o notebook voltar, use -Desativar ANTES de religar a Yui dele (veja o guia).' -ForegroundColor Yellow
exit 0
