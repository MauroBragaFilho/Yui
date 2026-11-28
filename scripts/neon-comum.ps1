# Funcoes comuns dos scripts do Neon (backup puxado e reserva fria). So ASCII (PowerShell 5.1 le arquivo sem BOM como ANSI).
# Este arquivo so DEFINE funcoes; nao faz nada ao ser carregado (os testes o carregam para conferir as decisoes).

$script:NomePastaBackupRe = '^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$'

function Escrever-LinhaLog {
    param([string]$Arquivo, [string]$Mensagem)
    $linha = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Mensagem
    Write-Host $linha
    if ($Arquivo) {
        try {
            $pasta = Split-Path -Parent $Arquivo
            if ($pasta -and -not (Test-Path $pasta)) { New-Item -ItemType Directory -Force $pasta | Out-Null }
            Add-Content -Path $Arquivo -Value $linha -Encoding Ascii
        } catch { }
    }
}

# Confere, SEM a chave, o selo do manifesto v2 do backup (backup.js: "YUI_MANIFEST_V2\n" + SHA-256 hex + "\n" + conteudo cifrado).
# Devolve @{ Ok; Versao; Motivo }. Backup antigo (v1, sem selo) so tem a forma conferida (nao da para provar integridade sem a chave).
function Test-ManifestoSelo {
    param([byte[]]$Bytes)
    $magico = [System.Text.Encoding]::ASCII.GetBytes("YUI_MANIFEST_V2`n")
    if ($null -eq $Bytes -or $Bytes.Length -eq 0) { return @{ Ok = $false; Versao = 0; Motivo = 'manifesto vazio' } }
    $ehV2 = $Bytes.Length -ge $magico.Length
    if ($ehV2) { for ($i = 0; $i -lt $magico.Length; $i++) { if ($Bytes[$i] -ne $magico[$i]) { $ehV2 = $false; break } } }
    if (-not $ehV2) {
        if ($Bytes.Length -gt 60) { return @{ Ok = $true; Versao = 1; Motivo = 'manifesto antigo (v1), sem selo para conferir' } }
        return @{ Ok = $false; Versao = 0; Motivo = 'manifesto ilegivel (formato desconhecido ou truncado)' }
    }
    $fimHash = $magico.Length + 64
    if ($Bytes.Length -le $fimHash -or $Bytes[$fimHash] -ne 10) { return @{ Ok = $false; Versao = 2; Motivo = 'cabecalho do manifesto ilegivel' } }
    $declarado = [System.Text.Encoding]::ASCII.GetString($Bytes, $magico.Length, 64)
    if ($declarado -notmatch '^[0-9a-f]{64}$') { return @{ Ok = $false; Versao = 2; Motivo = 'selo do manifesto malformado' } }
    $resto = New-Object byte[] ($Bytes.Length - $fimHash - 1)
    [Array]::Copy($Bytes, $fimHash + 1, $resto, 0, $resto.Length)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $real = ([BitConverter]::ToString($sha.ComputeHash($resto)) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($real -ne $declarado) { return @{ Ok = $false; Versao = 2; Motivo = 'o selo SHA-256 do manifesto nao confere (corrompido ou truncado)' } }
    return @{ Ok = $true; Versao = 2; Motivo = 'selo conferido' }
}

# Lista os lotes backup-<data> da pasta backups, do MAIS NOVO para o mais antigo, dizendo se o manifesto esta integro.
function Get-BackupsDoRepositorio {
    param([string]$PastaBackups)
    $saida = @()
    if (-not (Test-Path $PastaBackups)) { return $saida }
    $pastas = Get-ChildItem -Path $PastaBackups -Directory | Where-Object { $_.Name -match $script:NomePastaBackupRe } | Sort-Object Name -Descending
    foreach ($p in $pastas) {
        $manifesto = Join-Path $p.FullName 'manifest.json.enc'
        $r = @{ Ok = $false; Versao = 0; Motivo = 'sem manifesto (o backup nao chegou ao fim)' }
        if (Test-Path $manifesto) { $r = Test-ManifestoSelo -Bytes ([System.IO.File]::ReadAllBytes($manifesto)) }
        $qtd = @(Get-ChildItem -Path $p.FullName -Filter '*.enc' -File | Where-Object { $_.Name -ne 'manifest.json.enc' }).Count
        if ($r.Ok -and $qtd -eq 0) { $r = @{ Ok = $false; Versao = $r.Versao; Motivo = 'manifesto sem nenhum arquivo cifrado ao lado' } }
        $quando = $null
        if ($p.Name -match '^backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$') {
            $quando = New-Object DateTime ([int]$Matches[1]), ([int]$Matches[2]), ([int]$Matches[3]), ([int]$Matches[4]), ([int]$Matches[5]), ([int]$Matches[6]), ([int]$Matches[7]), ([DateTimeKind]::Utc)
        }
        $saida += [pscustomobject]@{ Nome = $p.Name; Caminho = $p.FullName; Completo = [bool]$r.Ok; Motivo = $r.Motivo; Versao = $r.Versao; Arquivos = $qtd; QuandoUtc = $quando }
    }
    return $saida
}

# A DECISAO de ativar a reserva (so pura logica, testavel). Entradas:
#   NotebookRespondeu : 'sim' | 'nao' | 'desconhecido'   (o /v1/health do notebook, pelo Tailscale)
#   TailscaleLocalOk  : $true se o Tailscale do Neon esta conectado (sem isso "nao responde" nao prova nada)
#   NotebookNaRede    : 'sim' | 'nao' | 'desconhecido'   (o Tailscale mostra o notebook ligado?)
#   Forcar            : o dono afirma que o notebook esta travado/inutilizavel mesmo ligado
# Devolve @{ Permitir; Motivo }. So permite com o notebook CONFIRMADAMENTE fora.
function Resolve-DecisaoAtivar {
    param(
        [ValidateSet('sim', 'nao', 'desconhecido')][string]$NotebookRespondeu,
        [bool]$TailscaleLocalOk,
        [ValidateSet('sim', 'nao', 'desconhecido')][string]$NotebookNaRede = 'desconhecido',
        [bool]$Forcar = $false
    )
    if ($NotebookRespondeu -eq 'sim') {
        return @{ Permitir = $false; Motivo = 'O notebook RESPONDE (a Yui dele esta no ar). Dois bots com o mesmo token nao podem rodar juntos. Nada foi feito.' }
    }
    if (-not $TailscaleLocalOk) {
        return @{ Permitir = $false; Motivo = 'O Tailscale deste PC nao esta conectado: nao da para saber se o notebook esta fora. Conecte o Tailscale e tente de novo.' }
    }
    if ($NotebookRespondeu -eq 'desconhecido') {
        return @{ Permitir = $false; Motivo = 'Nao foi possivel checar o notebook (endereco nao informado ou teste inconclusivo). Informe -NotebookUrl.' }
    }
    if ($NotebookNaRede -eq 'sim' -and -not $Forcar) {
        return @{ Permitir = $false; Motivo = 'O notebook esta LIGADO na rede Tailscale, so a Yui nao responde. Tente religar a Yui pelo SSH antes. Se ele esta travado de vez, repita com -ForcarNotebookLigado.' }
    }
    if ($NotebookNaRede -eq 'desconhecido' -and -not $Forcar) {
        return @{ Permitir = $false; Motivo = 'Nao consegui confirmar pelo Tailscale que o notebook esta desligado/fora. Confira com "tailscale status"; se tiver certeza, repita com -ForcarNotebookLigado.' }
    }
    return @{ Permitir = $true; Motivo = 'Notebook confirmadamente fora do ar.' }
}

function Get-TailscaleExe {
    $c = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @("$env:ProgramFiles\Tailscale\tailscale.exe", "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe")) { if (Test-Path $p) { return $p } }
    return $null
}

# @{ LocalOk = bool; Peer = 'sim'|'nao'|'desconhecido' } para o computador de nome $NomeNotebook (HostName ou comeco do nome MagicDNS).
function Get-EstadoTailscale {
    param([string]$NomeNotebook)
    $r = @{ LocalOk = $false; Peer = 'desconhecido' }
    $exe = Get-TailscaleExe
    if (-not $exe) { return $r }
    try {
        $json = & $exe status --json 2>$null | Out-String | ConvertFrom-Json
        $r.LocalOk = ($json.BackendState -eq 'Running')
        if ($r.LocalOk -and $NomeNotebook) {
            $alvo = $NomeNotebook.ToLowerInvariant()
            foreach ($prop in $json.Peer.PSObject.Properties) {
                $p = $prop.Value
                $dns = ([string]$p.DNSName).ToLowerInvariant()
                if (([string]$p.HostName).ToLowerInvariant() -eq $alvo -or $dns.StartsWith($alvo + '.')) {
                    $r.Peer = if ($p.Online) { 'sim' } else { 'nao' }
                    break
                }
            }
        }
    } catch { }
    return $r
}

# 'sim' se QUALQUER resposta HTTP voltou do endereco (ate um erro 500 prova que tem alguem vivo); 'nao' se nada respondeu em 2 tentativas.
function Test-RespondeSaude {
    param([string]$Url, [int]$TimeoutSec = 8)
    if (-not $Url) { return 'desconhecido' }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    for ($i = 0; $i -lt 2; $i++) {
        try {
            Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec | Out-Null
            return 'sim'
        } catch {
            if ($_.Exception.Response) { return 'sim' }
        }
    }
    return 'nao'
}
