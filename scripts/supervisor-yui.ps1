<#
.SYNOPSIS
    Supervisor da Yui no notebook: religa a Yui quando ela está de pé mas TRAVADA. Roda a cada 2 minutos (tarefa YuiSupervisor, SYSTEM).
.DESCRIPTION
    O laço da tarefa YuiBot já religa o node quando o processo MORRE. Este script cobre o outro caso: processo vivo, mas
    sem responder (API muda) ou com o Discord fora por muito tempo.

    REGRAS DE SEGURANCA (a razao de existir deste script no lugar do yui-supervisor.ps1 antigo):
    - Religa SOMENTE pela tarefa do agendador: Stop-ScheduledTask YuiBot, espera o node sair e Start-ScheduledTask YuiBot.
      Nunca encerra processo por PID achado em varredura e nunca inicia um segundo node por fora da tarefa.
    - Se o node antigo NAO sair depois do Stop, NAO inicia outro: registra o erro e para (nada de duas Yuis com o mesmo token).
    - Nao faz nada enquanto o atualizador (mutex Global\YuiAtualizar) esta rodando, nem nos 5 minutos depois de a Yui subir.
    - No maximo 3 religadas por hora; passou disso, so registra (evita laco de reinicios).

    Estado em C:\Tools\supervisor\estado.json e log em C:\Tools\supervisor\supervisor.log (linhas "RELIGADA: motivo" alimentam o
    relatorio diario de saude).
.PARAMETER DryRun
    Mostra a decisao sem religar nada.
.PARAMETER SemApi
    A API da Yui esta desligada (YUI_API_ENABLED=false): so confere se o processo existe.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SemApi,
    [string]$HealthUrl = 'http://127.0.0.1:3939/v1/health',
    [string]$Dir = 'C:\Tools\supervisor',
    [string]$TaskName = 'YuiBot'
)

# ---------------- Decisao (funcao pura, testada em tests/test-supervisor.ps1) ----------------
$Cfg = @{ GraceSec = 300; FailLimit = 3; DiscordDownMin = 10; MaxRestartsPerHour = 3 }

function Decidir-Supervisor($obs, $estado, [datetime]$agora, $cfg = $Cfg) {
    $novo = @{ failCount = [int]$estado.failCount; discordDownSince = $estado.discordDownSince; restarts = @($estado.restarts | Where-Object { $_ }) }
    $res = { param($acao, $motivo) @{ acao = $acao; motivo = $motivo; estado = $novo } }

    if ($obs.updaterRunning) { return (& $res 'esperar' 'atualizador em andamento') }

    # Sem processo da Yui: o laco da tarefa YuiBot a relanca em ~15 s. So age se a tarefa nem esta rodando, ou se segue assim por muito tempo.
    if ($null -eq $obs.procAgeSec) {
        $novo.discordDownSince = $null
        if ($obs.taskState -ne 'Running') { return (& $res 'iniciar' 'a tarefa YuiBot nao esta rodando e nao ha processo da Yui') }
        $novo.failCount++
        if ($novo.failCount -ge $cfg.FailLimit) { return (& $res 'religar' 'a tarefa esta rodando mas nao ha processo da Yui ha varios minutos') }
        return (& $res 'esperar' 'sem processo da Yui; aguardando o laco da tarefa')
    }

    if ($obs.procAgeSec -lt $cfg.GraceSec) {
        $novo.failCount = 0; $novo.discordDownSince = $null
        return (& $res 'esperar' 'Yui subiu ha menos de 5 min')
    }

    if (-not $obs.healthOk) {
        $novo.failCount++
        if ($novo.failCount -ge $cfg.FailLimit) { return (& $res 'religar' "a API nao respondeu $($novo.failCount) vezes seguidas") }
        return (& $res 'esperar' "API sem resposta ($($novo.failCount) de $($cfg.FailLimit))")
    }

    $novo.failCount = 0
    if ($obs.discordOnline -eq $false) {
        if (-not $novo.discordDownSince) { $novo.discordDownSince = $agora.ToString('o') }
        $minutos = ($agora - [datetime]::Parse($novo.discordDownSince)).TotalMinutes
        if ($minutos -ge $cfg.DiscordDownMin) { return (& $res 'religar' "o Discord esta fora ha $([int]$minutos) min") }
        return (& $res 'esperar' "Discord fora ha $([int]$minutos) min (limite $($cfg.DiscordDownMin))")
    }
    $novo.discordDownSince = $null
    return (& $res 'nada' 'tudo certo')
}

# Aplica o limite de religadas por hora sobre uma decisao de religar/iniciar.
function Aplicar-Limite($dec, [datetime]$agora, $cfg = $Cfg) {
    if ($dec.acao -notin 'religar', 'iniciar') { return $dec }
    $recentes = @($dec.estado.restarts | Where-Object { $_ -and ($agora - [datetime]::Parse($_)).TotalMinutes -lt 60 })
    $dec.estado.restarts = $recentes
    if ($recentes.Count -ge $cfg.MaxRestartsPerHour) {
        return @{ acao = 'esperar'; motivo = "limite de $($cfg.MaxRestartsPerHour) religadas por hora atingido (queria: $($dec.motivo))"; estado = $dec.estado; limite = $true }
    }
    return $dec
}

# ---------------- Execucao ----------------
if ($MyInvocation.InvocationName -eq '.') { return }   # carregado por um teste: so as funcoes

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Dir | Out-Null
$logFile = Join-Path $Dir 'supervisor.log'
$stateFile = Join-Path $Dir 'estado.json'

function Log($m) {
    $l = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
    Add-Content -Path $logFile -Value $l -Encoding ascii
    Write-Host $l
}
function Yui-Processo {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src.index.js' } | Select-Object -First 1
}

try {
    $estado = @{ failCount = 0; discordDownSince = $null; restarts = @() }
    if (Test-Path $stateFile) {
        $j = Get-Content $stateFile -Raw | ConvertFrom-Json
        $estado = @{ failCount = [int]$j.failCount; discordDownSince = $j.discordDownSince; restarts = @($j.restarts | Where-Object { $_ }) }
    }

    $mutex = $null
    $updater = [Threading.Mutex]::TryOpenExisting('Global\YuiAtualizar', [ref]$mutex)
    if ($mutex) { $mutex.Dispose() }

    $p = Yui-Processo
    $obs = @{
        updaterRunning = [bool]$updater
        procAgeSec = if ($p) { [int]((Get-Date) - $p.CreationDate).TotalSeconds } else { $null }
        taskState = [string](Get-ScheduledTask -TaskName $TaskName).State
        healthOk = $true
        discordOnline = $null
    }
    if ($p -and -not $SemApi) {
        $obs.healthOk = $false
        $txt = & curl.exe -s -m 8 $HealthUrl 2>$null
        if ($LASTEXITCODE -eq 0 -and $txt) {
            try {
                $h = $txt | ConvertFrom-Json
                if ($h.ok) { $obs.healthOk = $true }
                if ($h.PSObject.Properties.Name -contains 'discord' -and $null -ne $h.discord.online) { $obs.discordOnline = [bool]$h.discord.online }
            } catch { }
        }
    }

    $agora = Get-Date
    $dec = Aplicar-Limite (Decidir-Supervisor $obs $estado $agora) $agora

    if ($dec.acao -in 'religar', 'iniciar') {
        if ($DryRun) { Log "SIMULACAO: $($dec.acao): $($dec.motivo)"; return }
        if ($dec.acao -eq 'religar') {
            Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
            for ($i = 0; $i -lt 20 -and ((Yui-Processo) -or (Get-ScheduledTask -TaskName $TaskName).State -eq 'Running'); $i++) { Start-Sleep 2 }
            if (Yui-Processo) {
                Log 'ERRO: o node da Yui nao saiu depois do Stop; NAO vou iniciar outro (evita duas Yuis com o mesmo token). Veja o notebook.'
                $dec.estado.restarts = @($dec.estado.restarts) + (Get-Date -Format 'o')   # conta como tentativa, para o limite por hora valer
                $estado = $dec.estado
                ($estado | ConvertTo-Json -Depth 4) | Set-Content $stateFile -Encoding ascii
                return
            }
        }
        Start-ScheduledTask -TaskName $TaskName
        Log "RELIGADA: $($dec.motivo)"
        $dec.estado.restarts = @($dec.estado.restarts) + (Get-Date -Format 'o')
        $dec.estado.failCount = 0; $dec.estado.discordDownSince = $null
    } elseif ($dec.acao -eq 'esperar' -and $dec.limite) {
        Log "AVISO: $($dec.motivo)"
    } elseif ($dec.acao -eq 'esperar' -and $dec.estado.failCount -gt 0) {
        Log "ATENCAO: $($dec.motivo)"
    }

    ($dec.estado | ConvertTo-Json -Depth 4) | Set-Content $stateFile -Encoding ascii

    # log curto: mantem as ultimas 500 linhas
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 200KB) {
        Get-Content $logFile -Tail 500 | Set-Content $logFile -Encoding ascii
    }
} catch {
    Log "FALHA do supervisor: $($_.Exception.Message)"
    exit 1
}
