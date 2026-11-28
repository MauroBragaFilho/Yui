# Cria (ou recria) a tarefa agendada YuiBackupNeon, que roda neon-backup-puxar.ps1 todo dia. Idempotente. -Remover apaga a tarefa.
# Roda como o usuario atual, so quando o PC esta ocioso (5 min sem uso), com ou sem tomada, prioridade baixa,
# e se o PC estava desligado/ocupado na hora, roda assim que der (StartWhenAvailable).
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File neon-instalar-tarefa-backup.ps1 [-Hora 12:00] [-Destino D:\YuiBackup\offsite] [-ChaveSsh ...] [-Agora]
#      powershell -NoProfile -ExecutionPolicy Bypass -File neon-instalar-tarefa-backup.ps1 -Remover
param(
    [switch]$Remover,
    [switch]$Agora,                      # alem de agendar, roda uma vez agora
    [string]$Hora = '12:00',             # o backup do notebook sai as 05:30; ao meio-dia o PC costuma estar ligado
    [string]$Destino = 'D:\YuiBackup\offsite',
    [string]$ChaveSsh = '',
    [string]$Log = 'D:\YuiBackup\puxar.log'
)
$ErrorActionPreference = 'Stop'
$Nome = 'YuiBackupNeon'

if ($Remover) {
    if (Get-ScheduledTask -TaskName $Nome -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Nome -Confirm:$false
        Write-Host "Tarefa $Nome removida. (Os backups ja baixados em $Destino continuam la.)"
    } else { Write-Host "A tarefa $Nome nao existe; nada a remover." }
    return
}

if ($Hora -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw "Hora invalida '$Hora' (use HH:mm, ex.: 12:00)." }
$script = Join-Path $PSScriptRoot 'neon-backup-puxar.ps1'
if (-not (Test-Path $script)) { throw "Nao achei $script" }

$argumentos = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Destino "{1}" -Log "{2}"' -f $script, $Destino, $Log
if ($ChaveSsh) { $argumentos += (' -ChaveSsh "{0}"' -f $ChaveSsh) }
$acao = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argumentos
$gatilho = New-ScheduledTaskTrigger -Daily -At $Hora
$config = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RunOnlyIfNetworkAvailable -RunOnlyIfIdle -IdleDuration (New-TimeSpan -Minutes 5) -IdleWaitTimeout (New-TimeSpan -Hours 6) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$config.Priority = 8   # baixa (7 e o normal das tarefas; 8 fica abaixo)
$usuario = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $Nome -Action $acao -Trigger $gatilho -Settings $config -Principal $principal `
    -Description 'Baixa o backup cifrado da Yui (GitHub privado) para este PC. Ver docs/GUIA_BACKUP_NEON_E_RESERVA.md' -Force | Out-Null
Write-Host "Tarefa $Nome criada/atualizada: todo dia as $Hora, usuario $usuario, so ocioso, prioridade baixa."
Write-Host "Destino: $Destino | Log: $Log"
if ($Agora) {
    Start-ScheduledTask -TaskName $Nome
    Write-Host 'Iniciada agora (veja o resultado no log em alguns segundos).'
}
