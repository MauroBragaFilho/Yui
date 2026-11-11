# Testa a funcao Atualizar-Painel do atualizador (troca atomica do painel web). Windows PowerShell. Execucao: npm run test:atualizarpainel
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\scripts\atualizar-yui.ps1'), [ref]$null, [ref]$null)
$fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Atualizar-Painel' }, $true)[0]
if (-not $fn) { Write-Host 'FALHOU: funcao Atualizar-Painel nao encontrada'; exit 1 }
Invoke-Expression $fn.Extent.Text

$script:ok = 0
function Check($cond, $msg) { if (-not $cond) { Write-Host "FALHOU: $msg"; exit 1 }; $script:ok++ }
function Painel($dir, $fonte, $conteudo) {
    New-Item -ItemType Directory -Force "$dir\_expo\static\js\web" | Out-Null
    Set-Content "$dir\index.html" '<html><script src="/_expo/static/js/web/index-abc.js" defer></script></html>' -Encoding ascii
    Set-Content "$dir\_expo\static\js\web\index-abc.js" $conteudo -Encoding ascii
    if ($fonte) { Set-Content "$dir\.fonte" $fonte -Encoding ascii }
}

$raiz = Join-Path ([IO.Path]::GetTempPath()) ('yui-painel-teste-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $raiz | Out-Null
try {
    $novo = "$raiz\novo"; $dest = "$raiz\dest"
    Painel "$novo\apps\yui-app\painel-web" 'fonte-B' 'PAINEL-NOVO'
    Painel "$dest\apps\yui-app\dist" 'fonte-A' 'PAINEL-ANTIGO'

    # 1) atualiza, guarda o anterior
    $r = Atualizar-Painel $novo $dest
    Check ($r -match 'atualizado') "1: $r"
    Check ((Get-Content "$dest\apps\yui-app\dist\_expo\static\js\web\index-abc.js" -Raw) -match 'PAINEL-NOVO') '1: dist agora e o novo'
    Check ((Get-Content "$dest\apps\yui-app\dist-antigo\_expo\static\js\web\index-abc.js" -Raw) -match 'PAINEL-ANTIGO') '1: o anterior ficou em dist-antigo'
    Check (-not (Test-Path "$dest\apps\yui-app\dist-novo")) '1: sem sobra de dist-novo'
    Check ((Get-Content "$dest\apps\yui-app\dist\.fonte" | Select-Object -First 1) -eq 'fonte-B') '1: carimbo copiado'

    # 2) mesmo carimbo: nao mexe
    $r = Atualizar-Painel $novo $dest
    Check ($r -match 'ja esta') "2: $r"

    # 3) outra versao: o dist-antigo vira a anterior (so guarda 1 geracao)
    Painel "$novo\apps\yui-app\painel-web" 'fonte-C' 'PAINEL-C'
    $r = Atualizar-Painel $novo $dest
    Check ($r -match 'atualizado') "3: $r"
    Check ((Get-Content "$dest\apps\yui-app\dist-antigo\_expo\static\js\web\index-abc.js" -Raw) -match 'PAINEL-NOVO') '3: dist-antigo e a versao B'

    # 4) o codigo novo nao traz painel: nada a fazer, painel intacto
    $novo2 = "$raiz\novo2"; New-Item -ItemType Directory "$novo2\apps\yui-app" | Out-Null
    $r = Atualizar-Painel $novo2 $dest
    Check ($r -match 'nada a fazer') "4: $r"
    Check ((Get-Content "$dest\apps\yui-app\dist\_expo\static\js\web\index-abc.js" -Raw) -match 'PAINEL-C') '4: painel intacto'

    # 5) copia quebrada (bundle citado nao existe): AVISO, painel anterior intacto, sem sobra
    $novo3 = "$raiz\novo3"
    Painel "$novo3\apps\yui-app\painel-web" 'fonte-D' 'PAINEL-D'
    Remove-Item "$novo3\apps\yui-app\painel-web\_expo\static\js\web\index-abc.js"
    $r = Atualizar-Painel $novo3 $dest
    Check ($r -match '^AVISO') "5: $r"
    Check ((Get-Content "$dest\apps\yui-app\dist\_expo\static\js\web\index-abc.js" -Raw) -match 'PAINEL-C') '5: painel anterior intacto'
    Check (-not (Test-Path "$dest\apps\yui-app\dist-novo")) '5: sem sobra de dist-novo'

    # 6) destino sem apps\yui-app: nada a fazer, sem erro
    $dest2 = "$raiz\dest2"; New-Item -ItemType Directory $dest2 | Out-Null
    $r = Atualizar-Painel $novo $dest2
    Check ($r -match 'nada a fazer') "6: $r"

    # 7) primeira vez (sem dist): instala
    $dest3 = "$raiz\dest3"; New-Item -ItemType Directory "$dest3\apps\yui-app" | Out-Null
    $r = Atualizar-Painel $novo $dest3
    Check ($r -match 'atualizado' -and (Test-Path "$dest3\apps\yui-app\dist\index.html")) "7: $r"
} finally {
    Remove-Item $raiz -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "OK: atualizar-painel ($script:ok verificacoes)"
