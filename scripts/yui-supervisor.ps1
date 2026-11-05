<#
.SYNOPSIS
    Supervisor, Watchdog e Gerenciador de Inicialização da Yui no Windows.
.DESCRIPTION
    Monitora a saúde da Yui via endpoint local http://127.0.0.1:3939/v1/health.
    Reinicia a Yui de forma controlada caso caia ou pare de responder.
    Verifica e recria a publicação segura via Tailscale Serve (HTTPS somente na Tailnet).
    Rotaciona arquivos de log da pasta logs/.

    REGRAS DE SEGURANÇA:
    - Escuta estritamente restrita a 127.0.0.1 (Tailscale publica apenas na Tailnet).
    - Proibido uso de tailscale funnel.
    - NUNCA encerra processos por varredura cega de PID. Encerra EXCLUSIVAMENTE o processo
      iniciado por esta própria instância ou identificado pelo arquivo de PID controlado.
.PARAMETER DryRun
    Simula todas as ações sem iniciar nem matar processos e sem alterar configurações do sistema.
.PARAMETER CheckIntervalSec
    Intervalo em segundos entre as verificações de saúde (padrão: 15).
.PARAMETER HealthTimeoutSec
    Tempo limite de resposta do endpoint /v1/health antes de considerar falha (padrão: 5).
.PARAMETER FailThreshold
    Número de falhas consecutivas antes de reiniciar a Yui (padrão: 3).
.PARAMETER EnsureTailscale
    Se verdadeiro, verifica e reconecta o tailscale serve na porta 3939 (padrão: $true).
.PARAMETER RotateLogs
    Se verdadeiro, rotaciona logs antigos acima de limite prévio (padrão: $true).
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [int]$CheckIntervalSec = 15,
    [int]$HealthTimeoutSec = 5,
    [int]$FailThreshold = 3,
    [switch]$EnsureTailscale = $true,
    [switch]$RotateLogs = $true,
    [string]$WorkingDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $WorkingDir) {
    $WorkingDir = (Get-Item $PSScriptRoot).Parent.FullName
} else {
    $WorkingDir = (Resolve-Path $WorkingDir).Path
}
$PidFile = Join-Path $WorkingDir "logs\yui-supervisor.pid"
$HealthUrl = "http://127.0.0.1:3939/v1/health"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $formatted = "[$ts] [$Level] [Supervisor] $Message"
    Write-Host $formatted
}

function Test-HealthEndpoint {
    param([string]$Url, [int]$TimeoutSec)
    try {
        $req = [System.Net.WebRequest]::Create($Url)
        $req.Timeout = $TimeoutSec * 1000
        $req.Method = "GET"
        $resp = $req.GetResponse()
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reader.Close()
        $resp.Close()

        if ($body -match '"ok":\s*true') {
            return $true
        }
        return $false
    } catch {
        return $false
    }
}

function Invoke-TailscaleServeCheck {
    param([switch]$IsDryRun)
    Write-Log "Verificando status do Tailscale Serve..."
    if ($IsDryRun) {
        Write-Log "[DryRun] Executaria: tailscale serve status e validaria https://*:3939 -> 127.0.0.1:3939 (sem funnel)."
        return
    }

    try {
        $status = & tailscale serve status 2>&1
        $statusStr = "$status"
        if ($statusStr -notmatch "3939") {
            Write-Log "Tailscale serve inativo ou não configurado na porta 3939. Recriando publicação segura na tailnet..." "WARN"
            & tailscale serve --bg --https=3939 http://127.0.0.1:3939
            Write-Log "Tailscale serve recriado com sucesso para a porta 3939 (apenas Tailnet)."
        } else {
            Write-Log "Tailscale serve ativo e correto na porta 3939."
        }
    } catch {
        Write-Log "Aviso: tailscale CLI não disponível ou falhou ao consultar: $_" "WARN"
    }
}

function Rotate-LogFiles {
    param([string]$LogsDir, [int]$MaxLogSizeBytes = 10485760, [switch]$IsDryRun)
    if (-not (Test-Path $LogsDir)) { return }
    Get-ChildItem -Path $LogsDir -Filter "*.log" | ForEach-Object {
        if ($_.Length -gt $MaxLogSizeBytes) {
            $archivedName = "$($_.FullName).$((Get-Date -Format 'yyyyMMdd-HHmmss')).bak"
            Write-Log "Rotacionando log grande: $($_.Name) ($([math]::Round($_.Length/1MB, 2)) MB) -> $(Split-Path $archivedName -Leaf)"
            if (-not $IsDryRun) {
                Move-Item -Path $_.FullName -Destination $archivedName -Force
            } else {
                Write-Log "[DryRun] Move-Item $($_.FullName) -> $archivedName"
            }
        }
    }
}

function Start-YuiProcess {
    param([string]$AppDir, [switch]$IsDryRun)
    if ($IsDryRun) {
        Write-Log "[DryRun] Simulação: iniciaria processo node src/index.js dentro de $AppDir"
        return $null
    }

    Write-Log "Iniciando processo da Yui..."
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "node.exe"
    $psi.Arguments = "src/index.js"
    $psi.WorkingDirectory = $AppDir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError = $false

    $proc = [System.Diagnostics.Process]::Start($psi)
    Set-Content -Path $PidFile -Value $proc.Id -Force
    Write-Log "Yui iniciada com PID $($proc.Id). PID salvo em $PidFile."
    return $proc
}

function Stop-ControlledProcess {
    param([System.Diagnostics.Process]$Proc, [switch]$IsDryRun)
    if ($IsDryRun) {
        Write-Log "[DryRun] Simulação: encerraria processo controlado."
        return
    }

    if ($Proc -and -not $Proc.HasExited) {
        Write-Log "Encerrando processo controlado da Yui (PID $($Proc.Id))..."
        try {
            $Proc.Kill()
            $Proc.WaitForExit(5000)
        } catch {
            Write-Log "Erro ao encerrar processo: $_" "WARN"
        }
    }
    if (Test-Path $PidFile) {
        Remove-Item -Path $PidFile -Force -ErrorAction SilentlyContinue
    }
}

# --- Execução Principal do Supervisor ---

Write-Log "=== Yui Windows Watchdog & Supervisor ==="
Write-Log "Diretório de trabalho: $WorkingDir"
Write-Log "Modo DryRun: $([bool]$DryRun)"

if ($RotateLogs) {
    Rotate-LogFiles -LogsDir (Join-Path $WorkingDir "logs") -IsDryRun:$DryRun
}

if ($EnsureTailscale) {
    Invoke-TailscaleServeCheck -IsDryRun:$DryRun
}

if ($DryRun) {
    Write-Log "[DryRun] Testando verificação de health em $HealthUrl..."
    $healthy = Test-HealthEndpoint -Url $HealthUrl -TimeoutSec $HealthTimeoutSec
    Write-Log "[DryRun] Endpoint /v1/health respondendo ok? $healthy"
    Write-Log "[DryRun] Simulação concluída com sucesso. Nenhuma alteração realizada."
    exit 0
}

# Inicia a Yui e entra no laço de monitoramento
$currentProc = Start-YuiProcess -AppDir $WorkingDir -IsDryRun:$DryRun
$consecutiveFailures = 0

try {
    while ($true) {
        Start-Sleep -Seconds $CheckIntervalSec

        # 1. Checa se o processo morreu
        if ($currentProc -and $currentProc.HasExited) {
            Write-Log "Processo da Yui (PID $($currentProc.Id)) encerrou com código $($currentProc.ExitCode). Reiniciando..." "WARN"
            $currentProc = Start-YuiProcess -AppDir $WorkingDir -IsDryRun:$DryRun
            $consecutiveFailures = 0
            continue
        }

        # 2. Checa o /v1/health
        $isHealthy = Test-HealthEndpoint -Url $HealthUrl -TimeoutSec $HealthTimeoutSec
        if ($isHealthy) {
            if ($consecutiveFailures -gt 0) {
                Write-Log "Recuperação detectada: /v1/health respondeu com sucesso."
            }
            $consecutiveFailures = 0
        } else {
            $consecutiveFailures++
            Write-Log "Aviso: falha na checagem de saúde ($consecutiveFailures/$FailThreshold) em $HealthUrl" "WARN"

            if ($consecutiveFailures -ge $FailThreshold) {
                Write-Log "Limite de falhas consecutivas atingido ($consecutiveFailures). Reiniciando Yui..." "ERROR"
                Stop-ControlledProcess -Proc $currentProc -IsDryRun:$DryRun
                Start-Sleep -Seconds 2
                $currentProc = Start-YuiProcess -AppDir $WorkingDir -IsDryRun:$DryRun
                $consecutiveFailures = 0

                if ($EnsureTailscale) {
                    Invoke-TailscaleServeCheck -IsDryRun:$DryRun
                }
            }
        }
    }
} finally {
    Write-Log "Supervisor interrompido. Limpando processo controlado..."
    Stop-ControlledProcess -Proc $currentProc -IsDryRun:$DryRun
}
