# Testa o atualizador no modo DOIS PROCESSOS (etapa 4): Modo-Separado, Testar-Subida-Dois (o cerebro sozinho responde a saude e o
# bot conecta nele), o Testar-Subida de sempre (processo unico, sem mudanca) e Remover-Temporario (nunca segue a juncao).
# Windows PowerShell. Execucao: npm run test:atualizador
#
# Isolamento: as funcoes sao lidas do scripts/atualizar-yui.ps1 pela arvore de sintaxe (o script em si NAO roda: nada de tarefa,
# mutex, GitHub ou C:\Yui). O codigo vai para uma pasta temporaria (sem .env), com node_modules por juncao; token falso; bancos,
# segredo e portas so do teste. Os processos sao abertos e encerrados pelas proprias funcoes, pelo objeto do processo.
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts\atualizar-yui.ps1'), [ref]$null, [ref]$null)
foreach ($nome in 'Modo-Separado', 'Porta-Livre', 'Testar-Subida', 'Testar-Subida-Dois', 'Remover-Temporario') {
    $fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $nome }, $true)[0]
    if (-not $fn) { Write-Host "FALHOU: funcao $nome nao encontrada"; exit 1 }
    Invoke-Expression $fn.Extent.Text
}

$script:ok = 0
function Check($cond, $msg) { if (-not $cond) { Write-Host "FALHOU: $msg"; throw "FALHOU: $msg" }; $script:ok++ }
$node = (Get-Command node).Source
$t0 = Get-Date

$raiz = Join-Path ([IO.Path]::GetTempPath()) ('yui-atualizador-teste-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $raiz | Out-Null
# O atualizador roda com a pasta atual em qualquer lugar (como SYSTEM, em geral C:\Windows\System32): o teste NAO pode depender
# de rodar na pasta do repositorio.
$pastaAntes = Get-Location
Set-Location $raiz

# Bloqueio de integracao externa (etapa 8, revisao da Liz). Os processos do node que as funcoes do atualizador abrem (o cerebro e o bot de teste)
# herdam NODE_OPTIONS=--import=tests\helpers\bloqueioExterno.mjs e NODE_ENV=test: rede fora do loopback (o login no Discord com o token falso, que
# ANTES chegava de verdade ao Discord), DNS, UDP, programas e workers falham e ficam REGISTRADOS. Cada caso confere o registro e FALHA ALTO se
# houver qualquer tentativa alem das esperadas (o login no Discord, bloqueado antes de sair, e a busca dos binarios de midia no PATH). Excecoes:
# so as que este teste precisa, e o registro guarda qual teste abriu cada uma: o icacls e o whoami do Windows, que o canal usa para restringir a
# permissao do arquivo do segredo (nao usam rede). As tarefas de manutencao (downloads de dados e dos binarios) ficam desligadas (enforce + somente
# leitura), como no test:separacao.
$bloqueioDir = Join-Path $raiz 'bloqueio'
New-Item -ItemType Directory $bloqueioDir | Out-Null
$ponte = Join-Path $repo 'tests\helpers\bloqueioParaPowerShell.mjs'
$arqExcecoes = Join-Path $bloqueioDir 'excecoes.json'
$utf8 = New-Object System.Text.UTF8Encoding $false
[IO.File]::WriteAllText($arqExcecoes, (ConvertTo-Json -InputObject @{
    'programa:icacls' = 'o canal cerebro-bot restringe a permissao do arquivo do segredo (src/core/channel/secret.js; sem rede)'
    'programa:whoami' = 'o canal descobre o usuario atual para a permissao do arquivo do segredo (sem rede)'
}), $utf8)
$env:NODE_ENV = 'test'
$criado = (& $node $ponte criar $bloqueioDir 'test:atualizador' $arqExcecoes) -join ''
$env:NODE_ENV = $null
if ($criado -notmatch 'variaveis') { Write-Host "FALHOU: nao consegui criar o bloqueio: $criado"; exit 1 }
$script:varsBloqueio = ($criado | ConvertFrom-Json).variaveis
function Ligar-Bloqueio {
    foreach ($p in $script:varsBloqueio.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value, 'Process') }
    [Environment]::SetEnvironmentVariable('YUI_POLICY_MODE', 'enforce', 'Process'); [Environment]::SetEnvironmentVariable('YUI_READ_ONLY', 'true', 'Process')
}
function Desligar-Bloqueio {
    foreach ($p in $script:varsBloqueio.PSObject.Properties) { [Environment]::SetEnvironmentVariable($p.Name, $null, 'Process') }
    foreach ($k in 'YUI_POLICY_MODE', 'YUI_READ_ONLY') { [Environment]::SetEnvironmentVariable($k, $null, 'Process') }
}
# Confere as tentativas bloqueadas desde a ultima conferencia: so as ESPERADAS podem aparecer (e as nao opcionais tem de aparecer).
function Conferir-Bloqueio([string]$onde, $esperados) {
    $arq = Join-Path $bloqueioDir 'esperados.json'
    [IO.File]::WriteAllText($arq, $(if ($esperados) { ConvertTo-Json -InputObject @($esperados) } else { '[]' }), $utf8)
    $env:NODE_ENV = 'test'
    try { $saida = (& $node $ponte conferir $bloqueioDir $arq $onde) -join "`n"; $codigo = $LASTEXITCODE } finally { $env:NODE_ENV = $null }
    if ($codigo -ne 0) { Write-Host $saida; throw "FALHOU (bloqueio de integracao externa): $saida" }
    Write-Host "  bloqueio ($onde): $saida"
    $script:ok++
}
$loginDiscord = @(
    @{ tipo = 'rede'; alvo = 'discord(app)?\.(com|gg)'; motivo = 'o login no Discord com o token falso, bloqueado antes de sair' },
    @{ tipo = 'processo'; alvo = '^execFile where$'; motivo = 'a busca dos binarios de midia no PATH, bloqueada'; opcional = $true }
)
function Copiar-Codigo([string]$destino) {
    Push-Location $repo
    try { $arquivos = git ls-files -co --exclude-standard -- src persona knowledge package.json } finally { Pop-Location }
    foreach ($rel in $arquivos) {
        $de = Join-Path $repo $rel
        if (-not (Test-Path $de -PathType Leaf)) { continue }
        $para = Join-Path $destino $rel
        New-Item -ItemType Directory -Force (Split-Path $para) | Out-Null
        Copy-Item $de $para
    }
}
function Tirar-Juncao([string]$pasta) { if (Test-Path "$pasta\node_modules") { cmd /c "rmdir `"$pasta\node_modules`" >nul 2>nul" } }

try {
    # 0) o comando da tarefa YuiBot nos dois modos (scripts/tarefa-dois-processos.ps1; o script em si nao roda aqui)
    $astT = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repo 'scripts\tarefa-dois-processos.ps1'), [ref]$null, [ref]$null)
    Invoke-Expression ($astT.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Comando-Tarefa' }, $true)[0].Extent.Text)
    $cDois = Comando-Tarefa 'dois' 'C:\Program Files\nodejs\node.exe' 'C:\Yui'
    $cUnico = Comando-Tarefa 'unico' 'C:\Program Files\nodejs\node.exe' 'C:\Yui'
    Check ($cDois -eq "Set-Location 'C:\Yui'; while (`$true) { & 'C:\Program Files\nodejs\node.exe' src/supervisor.js; Start-Sleep -Seconds 15 }") "tarefa no modo dois: $cDois"
    Check ($cUnico -eq "Set-Location 'C:\Yui'; while (`$true) { & 'C:\Program Files\nodejs\node.exe' src/index.js; Start-Sleep -Seconds 15 }") "tarefa no modo unico = o laco do instalador: $cUnico"
    $instalador = Get-Content (Join-Path $repo 'scripts\instalar-tudo-offline.ps1') -Raw
    Check ($instalador -match [regex]::Escape("while (```$true) { & '`$nodeExe' src/index.js; Start-Sleep -Seconds 15 }")) 'o modo unico e o mesmo laco que o instalador registra'

    # 1) a chave no .env de C:\Yui (aqui, uma pasta de teste)
    $envDir = Join-Path $raiz 'yui'
    New-Item -ItemType Directory $envDir | Out-Null
    Check (-not (Modo-Separado $envDir)) 'sem .env: processo unico'
    Set-Content "$envDir\.env" "# YUI_CEREBRO_EXTERNO=true`nYUI_CEREBRO_EXTERNO=false" -Encoding UTF8
    Check (-not (Modo-Separado $envDir)) 'comentada ou false: processo unico'
    Set-Content "$envDir\.env" "YUI_CEREBRO_EXTERNO=true  # cerebro separado" -Encoding UTF8
    Check (Modo-Separado $envDir) 'YUI_CEREBRO_EXTERNO=true: dois processos'

    # 2) Remover-Temporario nunca apaga o que esta do outro lado da juncao
    $alvo = Join-Path $raiz 'precioso'
    New-Item -ItemType Directory $alvo | Out-Null
    Set-Content "$alvo\nao-apagar.txt" 'ok' -Encoding ascii
    $tmp = Join-Path $raiz 'yui-update'
    New-Item -ItemType Directory "$tmp\x\Yui-abc\src" -Force | Out-Null
    cmd /c mklink /J "$tmp\x\Yui-abc\node_modules" $alvo | Out-Null
    Remover-Temporario $tmp
    Check (-not (Test-Path $tmp)) 'a pasta temporaria saiu'
    Check (Test-Path "$alvo\nao-apagar.txt") 'o alvo da juncao ficou intacto'

    # 3) codigo sem o supervisor: recusado sem abrir processo nenhum
    $semSup = Join-Path $raiz 'sem-supervisor'
    New-Item -ItemType Directory "$semSup\src" -Force | Out-Null
    Set-Content "$semSup\src\cerebro.js" '' -Encoding ascii
    Set-Content "$semSup\src\index.js" '' -Encoding ascii
    $r = Testar-Subida-Dois $semSup (Join-Path $repo 'node_modules') $node
    Check ($r -match 'nao tem src\\supervisor.js') "sem supervisor: $r"

    # 4) o codigo de verdade: o cerebro sozinho responde a saude e o bot conecta nele
    $novo = Join-Path $raiz 'novo'
    Copiar-Codigo $novo
    Check (-not (Test-Path "$novo\.env")) 'a copia nao pode ter .env'
    $t = Get-Date
    Ligar-Bloqueio
    try { $r = Testar-Subida-Dois $novo (Join-Path $repo 'node_modules') $node } finally { Desligar-Bloqueio }
    Check ($null -eq $r) "Testar-Subida-Dois no codigo de verdade: $r"
    Conferir-Bloqueio 'Testar-Subida-Dois' $loginDiscord
    $seg = [int]((Get-Date) - $t).TotalSeconds
    $saidaB = Get-Content "$novo\preflight-dois\bot-saida.txt" -Raw -Encoding UTF8
    $saidaC = Get-Content "$novo\preflight-dois\cerebro-saida.txt" -Raw -Encoding UTF8
    Check ($saidaC -match 'YuiCerebro pronto') 'o cerebro de teste ficou pronto'
    Check ($saidaB -match 'Conectado ao c.rebro pelo canal local') 'o bot de teste conectou no cerebro de teste'
    Check ($saidaB -match 'Falha ao logar no Discord') 'o bot de teste chegou ate o login (token falso)'
    Check (Test-Path "$novo\preflight-dois\database\memory-personal.db") 'os bancos do teste ficam na pasta do teste'
    Write-Host "  Testar-Subida-Dois: OK em $seg s"

    # 5) o teste de sempre (processo unico) continua passando no mesmo codigo
    $t = Get-Date
    Ligar-Bloqueio
    try { $r = Testar-Subida $novo (Join-Path $repo 'node_modules') } finally { Desligar-Bloqueio }
    Check ($null -eq $r) "Testar-Subida (processo unico): $r"
    Conferir-Bloqueio 'Testar-Subida (processo unico)' $loginDiscord
    Write-Host "  Testar-Subida (processo unico): OK em $([int]((Get-Date) - $t).TotalSeconds) s"

    # 6) cerebro quebrado (erro de sintaxe num modulo dele): recusado com o motivo
    $quebrado = Join-Path $raiz 'quebrado'
    Copiar-Codigo $quebrado
    Add-Content "$quebrado\src\cerebro\metodos.js" "`nexport const quebrado = ;" -Encoding ascii
    Ligar-Bloqueio
    try { $r = Testar-Subida-Dois $quebrado (Join-Path $repo 'node_modules') $node } finally { Desligar-Bloqueio }
    Check ($r -match 'cerebro novo') "cerebro quebrado: $r"
    Conferir-Bloqueio 'cerebro quebrado' $null
    Write-Host "  cerebro quebrado recusado: $r"

    # 7) supervisor quebrado (modulo dele com erro): recusado antes de abrir qualquer processo
    $supQuebrado = Join-Path $raiz 'supervisor-quebrado'
    Copiar-Codigo $supQuebrado
    Add-Content "$supQuebrado\src\operacao\supervisor.js" "`nexport const quebrado = ;" -Encoding ascii
    Ligar-Bloqueio
    try { $r = Testar-Subida-Dois $supQuebrado (Join-Path $repo 'node_modules') $node } finally { Desligar-Bloqueio }
    Conferir-Bloqueio 'supervisor quebrado' $null
    Check ($r -match 'supervisor do codigo novo nao carrega: .*SyntaxError') "supervisor quebrado (com o erro do node no motivo): $r"
    Check (-not (Test-Path "$supQuebrado\preflight-dois\cerebro-saida.txt")) 'supervisor quebrado: nenhum processo foi aberto'
    Write-Host "  supervisor quebrado recusado: $r"
    # o registro das excecoes: qual teste abriu cada uma e quantas vezes foi usada
    Write-Host "  bloqueio de integracao externa: so as tentativas esperadas (o login no Discord e a busca dos binarios); excecoes declaradas: $((& $node $ponte resumo $bloqueioDir $arqExcecoes) -join ' ')"
} finally {
    Desligar-Bloqueio
    Set-Location $pastaAntes
    foreach ($p in (Join-Path $raiz 'novo'), (Join-Path $raiz 'quebrado'), (Join-Path $raiz 'sem-supervisor'), (Join-Path $raiz 'supervisor-quebrado')) { Tirar-Juncao $p }
    $sobrou = Get-ChildItem $raiz -Recurse -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
    if ($sobrou) { Write-Host "AVISO: juncao nao removida em $raiz; apague a mao." } else { Remove-Item $raiz -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Host "OK: atualizador dois processos ($script:ok verificacoes, $([int]((Get-Date) - $t0).TotalSeconds) s)"
