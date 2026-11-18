<#
.SYNOPSIS
    Troca a acao da tarefa YuiBot entre o processo unico (o laco de hoje) e o supervisor dos dois processos (etapa 4).
.DESCRIPTION
    NAO rode na producao sem o OK do Braga. Por padrao so SIMULA: mostra a acao atual e a nova. Com -Aplicar:
      1. guarda o XML atual da tarefa em C:\Tools\supervisor\YuiBot-<data>.xml (para voltar a mao, se precisar);
      2. troca SO a acao (conta SYSTEM, gatilho no boot e configuracoes continuam as mesmas):
         - dois:  while ($true) { node src/supervisor.js; Start-Sleep 15 }   (o supervisor sobe o cerebro e depois o bot)
         - unico: while ($true) { node src/index.js; Start-Sleep 15 }        (exatamente o laco do instalar-tudo-offline.ps1)
    A chave YUI_CEREBRO_EXTERNO no .env tem de combinar com o modo (o script avisa se nao combinar). Mesmo com a chave
    desligada, o src/supervisor.js roda o modo unico (igual ao laco), entao a volta e: desligar a chave e reiniciar.
    Nao inicia nem para nada: depois de aplicar, reinicie pela tarefa (Stop-ScheduledTask / Start-ScheduledTask).
.PARAMETER Modo
    'dois' (padrao) ou 'unico'.
.PARAMETER Aplicar
    Sem isto, so simula.
#>
[CmdletBinding()]
param(
    [ValidateSet('dois', 'unico')][string]$Modo = 'dois',
    [switch]$Aplicar,
    [string]$Destino = 'C:\Yui',
    [string]$TaskName = 'YuiBot',
    [string]$Backup = 'C:\Tools\supervisor'
)

# O comando do laco da tarefa (funcao pura, testada em tests/test-atualizador-dois.ps1).
function Comando-Tarefa([string]$modo, [string]$nodeExe, [string]$destino) {
    $entrada = if ($modo -eq 'dois') { 'src/supervisor.js' } else { 'src/index.js' }
    return "Set-Location '$destino'; while (`$true) { & '$nodeExe' $entrada; Start-Sleep -Seconds 15 }"
}

if ($MyInvocation.InvocationName -eq '.') { return }   # carregado por um teste: so a funcao

$ErrorActionPreference = 'Stop'
$nodeExe = (Get-Command node).Source
$cmd = Comando-Tarefa $Modo $nodeExe $Destino
$argumento = "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
$tarefa = Get-ScheduledTask -TaskName $TaskName
Write-Host "Tarefa $TaskName (estado $($tarefa.State))"
Write-Host "  acao atual: $($tarefa.Actions[0].Execute) $($tarefa.Actions[0].Arguments)"
Write-Host "  acao nova:  powershell.exe $argumento"

$chave = $false
$envFile = Join-Path $Destino '.env'
if (Test-Path $envFile) { $chave = [bool](Select-String -Path $envFile -Pattern '^\s*YUI_CEREBRO_EXTERNO\s*=\s*["'']?true["'']?\s*(#.*)?$' -Quiet) }
if ($Modo -eq 'dois' -and -not $chave) { Write-Host "AVISO: o .env de $Destino nao tem YUI_CEREBRO_EXTERNO=true: o supervisor vai rodar o modo unico ate a chave ser ligada." }
if ($Modo -eq 'unico' -and $chave) { Write-Host "AVISO: o .env de $Destino ainda tem YUI_CEREBRO_EXTERNO=true: com src/index.js sozinho so o bot sobe (sem o cerebro). Desligue a chave." }

if (-not $Aplicar) { Write-Host 'SIMULACAO: nada mudou (use -Aplicar, so com o OK do Braga).'; return }

New-Item -ItemType Directory -Force $Backup | Out-Null
$xml = Join-Path $Backup ("$TaskName-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
Export-ScheduledTask -TaskName $TaskName | Set-Content $xml -Encoding Unicode
$acao = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $Destino -Argument $argumento
Set-ScheduledTask -TaskName $TaskName -Action $acao | Out-Null
Write-Host "OK: a tarefa $TaskName agora roda o modo $Modo (copia da anterior em $xml)."
Write-Host "Para valer: Stop-ScheduledTask $TaskName; (espere os processos node da Yui sairem); Start-ScheduledTask $TaskName"
