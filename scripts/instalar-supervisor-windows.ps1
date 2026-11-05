<#
.SYNOPSIS
    Instala ou Desinstala a Tarefa Agendada do Windows para o Supervisor da Yui.
.DESCRIPTION
    Cria a tarefa agendada "YuiSupervisor" no Agendador de Tarefas do Windows para
    iniciar automaticamente no logon do usuário com reinício automático e watchdog ativo.
.PARAMETER DryRun
    Simula os comandos sem registrar nem alterar tarefas agendadas no sistema.
.PARAMETER Uninstall
    Remove a tarefa agendada em vez de criá-la.
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Uninstall,
    [string]$TaskName = "YuiSupervisor",
    [string]$WorkingDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $WorkingDir) {
    $WorkingDir = (Get-Item $PSScriptRoot).Parent.FullName
} else {
    $WorkingDir = (Resolve-Path $WorkingDir).Path
}
$SupervisorScript = Join-Path $WorkingDir "scripts\yui-supervisor.ps1"

Write-Host "=== Gerenciador de Tarefa Agendada: Yui Supervisor ==="
Write-Host "Nome da tarefa: $TaskName"
Write-Host "Diretório da Yui: $WorkingDir"
Write-Host "Modo DryRun: $([bool]$DryRun)"

if ($Uninstall) {
    Write-Host "Solicitada desinstalação da tarefa $TaskName..."
    if ($DryRun) {
        Write-Host "[DryRun] Executaria: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
        exit 0
    }

    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Tarefa $TaskName desregistrada com sucesso."
    } else {
        Write-Host "Tarefa $TaskName não estava registrada."
    }
    exit 0
}

# Instalação / Registro
$psExe = (Get-Process -Id $PID).Path
if (-not $psExe) { $psExe = "powershell.exe" }

$actionArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$SupervisorScript`""

Write-Host "Configuração da ação:"
Write-Host "  Executável: $psExe"
Write-Host "  Argumentos: $actionArgs"
Write-Host "  Trigger: No logon do usuário ($env:USERNAME)"

if ($DryRun) {
    Write-Host "[DryRun] Simulação: criaria ação, trigger e registraria com Register-ScheduledTask."
    Write-Host "[DryRun] Comando simulado:"
    Write-Host "  `$Action = New-ScheduledTaskAction -Execute '$psExe' -Argument '$actionArgs' -WorkingDirectory '$WorkingDir'"
    Write-Host "  `$Trigger = New-ScheduledTaskTrigger -AtLogOn -User '$env:USERNAME'"
    Write-Host "  Register-ScheduledTask -TaskName '$TaskName' -Action `$Action -Trigger `$Trigger -Description 'Yui Watchdog Supervisor'"
    exit 0
}

$Action = New-ScheduledTaskAction -Execute $psExe -Argument $actionArgs -WorkingDirectory $WorkingDir
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Yui Watchdog & Auto-Start Supervisor" -Force

Write-Host "Tarefa $TaskName registrada com sucesso no Agendador de Tarefas do Windows!"
Write-Host "Para verificar o status: Get-ScheduledTask -TaskName $TaskName"
Write-Host "Para iniciar imediatamente: Start-ScheduledTask -TaskName $TaskName"
