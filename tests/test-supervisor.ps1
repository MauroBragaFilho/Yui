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

# ---------------- Modo dois processos (etapa 4) ----------------
# a chave no .env (linhas comentadas, outro valor e comentario no fim da linha)
$tmpRaiz = Join-Path ([IO.Path]::GetTempPath()) ('yui-watchdog-teste-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $tmpRaiz | Out-Null
try {
    Check (-not (Modo-Separado $tmpRaiz)) 'sem .env: processo unico'
    Set-Content "$tmpRaiz\.env" "DISCORD_TOKEN=x`n# YUI_CEREBRO_EXTERNO=true`nYUI_CEREBRO_EXTERNO=false" -Encoding UTF8
    Check (-not (Modo-Separado $tmpRaiz)) 'comentada ou false: processo unico'
    Set-Content "$tmpRaiz\.env" "DISCORD_TOKEN=x`nYUI_CEREBRO_EXTERNO=true" -Encoding UTF8
    Check (Modo-Separado $tmpRaiz) 'YUI_CEREBRO_EXTERNO=true: dois processos'
    Set-Content "$tmpRaiz\.env" "  YUI_CEREBRO_EXTERNO = `"true`"  # liga o cerebro separado" -Encoding UTF8
    Check (Modo-Separado $tmpRaiz) 'com aspas, espacos e comentario no fim'
    Set-Content "$tmpRaiz\.env" "YUI_CEREBRO_EXTERNO_X=true" -Encoding UTF8
    Check (-not (Modo-Separado $tmpRaiz)) 'outra variavel com o mesmo comeco nao conta'
} finally { Remove-Item $tmpRaiz -Recurse -Force -ErrorAction SilentlyContinue }

function ObsDois($idade = 20, $estadoNode = 'rodando', $task = 'Running', $updater = $false) { @{ updaterRunning = $updater; taskState = $task; supervisorIdadeSec = $idade; supervisorEstado = $estadoNode } }
$d = Decidir-Supervisor-Dois (ObsDois -updater $true -idade $null) (Estado 2) $agora
Check ($d.acao -eq 'esperar' -and $d.estado.failCount -eq 2) 'dois: atualizador em andamento, nao mexe'
$d = Decidir-Supervisor-Dois (ObsDois -task 'Ready') (Estado 1) $agora
Check ($d.acao -eq 'iniciar') 'dois: tarefa parada: inicia pela tarefa'
$d = Decidir-Supervisor-Dois (ObsDois) (Estado 2) $agora
Check ($d.acao -eq 'nada' -and $d.estado.failCount -eq 0) 'dois: supervisor dando sinal: nada a fazer e zera as falhas'
$d = Decidir-Supervisor-Dois (ObsDois -idade 600) (Estado) $agora;       Check ($d.acao -eq 'esperar' -and $d.estado.failCount -eq 1) 'dois: sem sinal 1'
$d = Decidir-Supervisor-Dois (ObsDois -idade 600) $d.estado $agora;      Check ($d.acao -eq 'esperar' -and $d.estado.failCount -eq 2) 'dois: sem sinal 2'
$d = Decidir-Supervisor-Dois (ObsDois -idade 600) $d.estado $agora;      Check ($d.acao -eq 'religar' -and $d.motivo -match 'nao da sinal') 'dois: sem sinal 3: religa'
$d = Decidir-Supervisor-Dois (ObsDois -idade $null -estadoNode $null) (Estado 2) $agora
Check ($d.acao -eq 'religar' -and $d.motivo -match 'sem arquivo de estado') 'dois: sem arquivo de estado por 3 rodadas: religa'
$d = Decidir-Supervisor-Dois (ObsDois -estadoNode 'parado') (Estado 2) $agora
Check ($d.acao -eq 'religar' -and $d.motivo -match 'parado') 'dois: supervisor parado com a tarefa rodando: religa'
$d = Aplicar-Limite (Decidir-Supervisor-Dois (ObsDois -idade 600) (Estado 2 $null $tres) $agora) $agora
Check ($d.acao -eq 'esperar' -and $d.limite) 'dois: o limite de 3 religadas por hora tambem vale'

# o script do watchdog nunca encerra processo por PID (so detecta) e so religa pela tarefa
$codigo = (Get-Content (Join-Path $PSScriptRoot '..\scripts\supervisor-yui.ps1') -Raw) -split "`n" | Where-Object { $_ -notmatch '^\s*#' }
Check (-not ($codigo -match 'Stop-Process|taskkill|\.Kill\(')) 'o watchdog nao encerra processo por PID'

Write-Host "OK: supervisor ($script:ok verificacoes)"
