# Testa a funcao Atualizar-Painel do atualizador (troca atomica do painel web e do servidor do painel). Windows PowerShell.
# Execucao: npm run test:atualizarpainel
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\scripts\atualizar-yui.ps1'), [ref]$null, [ref]$null)
$fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Atualizar-Painel' }, $true)[0]
if (-not $fn) { Write-Host 'FALHOU: funcao Atualizar-Painel nao encontrada'; exit 1 }
Invoke-Expression $fn.Extent.Text

$script:ok = 0
$script:reinicios = 0
$nop = { $script:reinicios++ }   # no lugar de Stop/Start-ScheduledTask: o teste NUNCA mexe nas tarefas de verdade
function Check($cond, $msg) { if (-not $cond) { Write-Host "FALHOU: $msg"; exit 1 }; $script:ok++ }
function Painel($dir, $fonte, $conteudo) {
    New-Item -ItemType Directory -Force "$dir\_expo\static\js\web" | Out-Null
    Set-Content "$dir\index.html" '<html><script src="/_expo/static/js/web/index-abc.js" defer></script></html>' -Encoding ascii
    Set-Content "$dir\_expo\static\js\web\index-abc.js" $conteudo -Encoding ascii
    if ($fonte) { Set-Content "$dir\.fonte" $fonte -Encoding ascii }
}
function Bundle($dest) { Get-Content "$dest\apps\yui-app\dist\_expo\static\js\web\index-abc.js" -Raw }

$raiz = Join-Path ([IO.Path]::GetTempPath()) ('yui-painel-teste-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $raiz | Out-Null
try {
    $novo = "$raiz\novo"; $dest = "$raiz\dest"
    Painel "$novo\apps\yui-app\painel-web" 'fonte-B' 'PAINEL-NOVO'
    Painel "$dest\apps\yui-app\dist" 'fonte-A' 'PAINEL-ANTIGO'

    # 1) atualiza, guarda o anterior
    $r = Atualizar-Painel $novo $dest $nop
    Check ($r -match 'atualizado') "1: $r"
    Check ((Bundle $dest) -match 'PAINEL-NOVO') '1: dist agora e o novo'
    Check ((Get-Content "$dest\apps\yui-app\dist-antigo\_expo\static\js\web\index-abc.js" -Raw) -match 'PAINEL-ANTIGO') '1: o anterior ficou em dist-antigo'
    Check (-not (Test-Path "$dest\apps\yui-app\dist-novo")) '1: sem sobra de dist-novo'
    Check ((Get-Content "$dest\apps\yui-app\dist\.fonte" | Select-Object -First 1) -eq 'fonte-B') '1: carimbo copiado'

    # 2) mesmo carimbo: nao mexe
    $r = Atualizar-Painel $novo $dest $nop
    Check ($r -match 'ja esta') "2: $r"

    # 3) outra versao: o dist-antigo vira a anterior (so guarda 1 geracao)
    Painel "$novo\apps\yui-app\painel-web" 'fonte-C' 'PAINEL-C'
    $r = Atualizar-Painel $novo $dest $nop
    Check ($r -match 'atualizado') "3: $r"
    Check ((Get-Content "$dest\apps\yui-app\dist-antigo\_expo\static\js\web\index-abc.js" -Raw) -match 'PAINEL-NOVO') '3: dist-antigo e a versao B'

    # 4) o codigo novo nao traz painel: nada a fazer, painel intacto
    $novo2 = "$raiz\novo2"; New-Item -ItemType Directory "$novo2\apps\yui-app" | Out-Null
    $r = Atualizar-Painel $novo2 $dest $nop
    Check ($r -match 'nada a fazer') "4: $r"
    Check ((Bundle $dest) -match 'PAINEL-C') '4: painel intacto'

    # 5) copia quebrada (bundle citado nao existe): AVISO, painel anterior intacto, sem sobra
    $novo3 = "$raiz\novo3"
    Painel "$novo3\apps\yui-app\painel-web" 'fonte-D' 'PAINEL-D'
    Remove-Item "$novo3\apps\yui-app\painel-web\_expo\static\js\web\index-abc.js"
    $r = Atualizar-Painel $novo3 $dest $nop
    Check ($r -match '^AVISO') "5: $r"
    Check ((Bundle $dest) -match 'PAINEL-C') '5: painel anterior intacto'
    Check (-not (Test-Path "$dest\apps\yui-app\dist-novo")) '5: sem sobra de dist-novo'

    # 6) destino sem apps\yui-app: nada a fazer, sem erro
    $dest2 = "$raiz\dest2"; New-Item -ItemType Directory $dest2 | Out-Null
    $r = Atualizar-Painel $novo $dest2 $nop
    Check ($r -match 'nada a fazer') "6: $r"

    # 7) primeira vez (sem dist): instala
    $dest3 = "$raiz\dest3"; New-Item -ItemType Directory "$dest3\apps\yui-app" | Out-Null
    $r = Atualizar-Painel $novo $dest3 $nop
    Check ($r -match 'atualizado' -and (Test-Path "$dest3\apps\yui-app\dist\index.html")) "7: $r"

    # 8) servidor do painel (serve-web.mjs): copia e reinicia SO quando o texto mudou (CRLF x LF nao conta)
    $s1 = "$raiz\n8"; $d8 = "$raiz\d8"
    Painel "$s1\apps\yui-app\painel-web" 'fonte-S' 'PAINEL-S'
    Painel "$d8\apps\yui-app\dist" 'fonte-S' 'PAINEL-S'
    New-Item -ItemType Directory -Force "$s1\apps\yui-app\scripts", "$d8\apps\yui-app\scripts" | Out-Null
    $srvNovo = "$s1\apps\yui-app\scripts\serve-web.mjs"; $srvAtual = "$d8\apps\yui-app\scripts\serve-web.mjs"
    Set-Content $srvNovo "linha1`nlinha2`n" -Encoding ascii -NoNewline
    Set-Content $srvAtual "linha1`r`nlinha2`r`n" -Encoding ascii -NoNewline   # mesmo texto, mas com CRLF (copia feita a mao)
    $antes = $script:reinicios
    $r = Atualizar-Painel $s1 $d8 $nop
    Check ($script:reinicios -eq $antes) "8a: texto igual (so muda CRLF) nao reinicia: $r"
    Check ($r -notmatch 'servidor do painel') "8a: sem mencao ao servidor: $r"

    Set-Content $srvNovo "linha1`nlinha2 MUDOU`n" -Encoding ascii -NoNewline
    $r = Atualizar-Painel $s1 $d8 $nop
    Check ($r -match 'servidor do painel: atualizado e reiniciado') "8b: $r"
    Check ($script:reinicios -eq $antes + 1) '8b: reiniciou exatamente uma vez'
    Check ((Get-Content $srvAtual -Raw) -match 'MUDOU') '8b: copiou o novo'

    # 8c) reinicio que falha: avisa, mas nao derruba nada
    Set-Content $srvNovo "outra versao`n" -Encoding ascii -NoNewline
    $r = Atualizar-Painel $s1 $d8 { throw 'tarefa inexistente' }
    Check ($r -match 'AVISO: servidor do painel copiado, mas nao reiniciei') "8c: $r"

    # 8d) primeira instalacao do servidor (sem o arquivo no destino): copia e reinicia
    Remove-Item $srvAtual
    $antes = $script:reinicios
    $r = Atualizar-Painel $s1 $d8 $nop
    Check ((Test-Path $srvAtual) -and $r -match 'servidor do painel' -and $script:reinicios -eq $antes + 1) "8d: $r"
} finally {
    Remove-Item $raiz -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "OK: atualizar-painel ($script:ok verificacoes)"
