# Testa a DECISAO do supervisor (funcoes puras de scripts/supervisor-yui.ps1). Windows PowerShell. Execucao: npm run test:supervisor
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\supervisor-yui.ps1')

$script:ok = 0
function Check($cond, $msg) { if (-not $cond) { Write-Host "FALHOU: $msg"; exit 1 }; $script:ok++ }
function Estado($fail = 0, $since = $null, $restarts = @()) { @{ failCount = $fail; discordDownSince = $since; restarts = @($restarts) } }
function Obs($age = 1000, $health = $true, $discord = $null, $task = 'Running', $updater = $false) { @{ updaterRunning = $updater; procAgeSec = $age; taskState = $task; healthOk = $health; discordOnline = $discord } }
$agora = Get-Date '2026-11-11 15:00:00'

# atualizador em andamento: nao mexe em nada
$d = Decidir-Supervisor (Obs -updater $true -health $false) (Estado 2) $agora
Check ($d.acao -eq 'esperar' -and $d.estado.failCount -eq 2) 'atualizador: espera e nao conta falha'

# sem processo
$d = Decidir-Supervisor (Obs -age $null -task 'Ready') (Estado) $agora
Check ($d.acao -eq 'iniciar') 'sem processo e tarefa parada: inicia pela tarefa'
$d = Decidir-Supervisor (Obs -age $null -task 'Running') (Estado 0) $agora
Check ($d.acao -eq 'esperar' -and $d.estado.failCount -eq 1) 'sem processo mas tarefa rodando: espera o laco (1)'
$d = Decidir-Supervisor (Obs -age $null -task 'Running') (Estado 2) $agora
Check ($d.acao -eq 'religar') 'sem processo ha varias rodadas: religa'

# carencia depois de subir
$d = Decidir-Supervisor (Obs -age 100 -health $false) (Estado 2 $agora.AddMinutes(-3).ToString('o')) $agora
Check ($d.acao -eq 'esperar' -and $d.estado.failCount -eq 0 -and $null -eq $d.estado.discordDownSince) 'recem-subida: espera e zera contadores'

# API sem resposta: 3 falhas seguidas
$e = Estado
$d = Decidir-Supervisor (Obs -health $false) $e $agora;           Check ($d.acao -eq 'esperar' -and $d.estado.failCount -eq 1) 'falha 1'
$d = Decidir-Supervisor (Obs -health $false) $d.estado $agora;    Check ($d.acao -eq 'esperar' -and $d.estado.failCount -eq 2) 'falha 2'
$d = Decidir-Supervisor (Obs -health $false) $d.estado $agora;    Check ($d.acao -eq 'religar' -and $d.motivo -match '3 vezes') 'falha 3: religa'
# uma resposta boa no meio zera a contagem
$d = Decidir-Supervisor (Obs -health $false) (Estado 2) $agora
$d = Decidir-Supervisor (Obs -health $true) $d.estado $agora
Check ($d.acao -eq 'nada' -and $d.estado.failCount -eq 0) 'resposta boa zera as falhas'

# Discord fora: so religa depois de 10 min
$d = Decidir-Supervisor (Obs -discord $false) (Estado) $agora
Check ($d.acao -eq 'esperar' -and $d.estado.discordDownSince) 'Discord fora: marca o inicio'
$since = $agora.AddMinutes(-5).ToString('o')
$d = Decidir-Supervisor (Obs -discord $false) (Estado 0 $since) $agora
Check ($d.acao -eq 'esperar') 'Discord fora ha 5 min: ainda espera'
$since = $agora.AddMinutes(-11).ToString('o')
$d = Decidir-Supervisor (Obs -discord $false) (Estado 0 $since) $agora
Check ($d.acao -eq 'religar' -and $d.motivo -match 'Discord') 'Discord fora ha 11 min: religa'
$d = Decidir-Supervisor (Obs -discord $true) (Estado 0 $since) $agora
Check ($d.acao -eq 'nada' -and $null -eq $d.estado.discordDownSince) 'Discord voltou: limpa'
$d = Decidir-Supervisor (Obs -discord $null) (Estado) $agora
Check ($d.acao -eq 'nada') 'API antiga sem campo discord: nada a fazer'

# tudo certo
$d = Decidir-Supervisor (Obs -discord $true) (Estado) $agora
Check ($d.acao -eq 'nada') 'tudo certo'

# limite de religadas por hora
$tres = @($agora.AddMinutes(-10).ToString('o'), $agora.AddMinutes(-30).ToString('o'), $agora.AddMinutes(-50).ToString('o'))
$d = Aplicar-Limite (Decidir-Supervisor (Obs -health $false) (Estado 2 $null $tres) $agora) $agora
Check ($d.acao -eq 'esperar' -and $d.limite -and $d.motivo -match 'limite') '3 religadas na ultima hora: nao religa de novo'
$velhas = @($agora.AddMinutes(-90).ToString('o'), $agora.AddMinutes(-120).ToString('o'), $agora.AddMinutes(-200).ToString('o'))
$d = Aplicar-Limite (Decidir-Supervisor (Obs -health $false) (Estado 2 $null $velhas) $agora) $agora
Check ($d.acao -eq 'religar' -and @($d.estado.restarts).Count -eq 0) 'religadas antigas (mais de 1 h) nao contam'
$d = Aplicar-Limite (Decidir-Supervisor (Obs -discord $true) (Estado) $agora) $agora
Check ($d.acao -eq 'nada') 'limite nao interfere quando nao ha o que fazer'

Write-Host "OK: supervisor ($script:ok verificacoes)"
