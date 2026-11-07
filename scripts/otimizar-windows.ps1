# Tira o "lixo" do Windows 10 para o notebook servidor (Yui / Minecraft).
# Por padrao e SIMULACAO: so mostra o que faria. Para aplicar de verdade:
#   powershell -ExecutionPolicy Bypass -File .\otimizar-windows.ps1 -Aplicar
# NAO mexe em: Windows Update, Defender, Firewall, UAC, Loja, Edge, Chrome, SSH, PowerToys.
# Cria um ponto de restauracao antes de aplicar e grava log em C:\Tools\otimizar-windows.log
param([switch]$Aplicar)

$ErrorActionPreference = 'Continue'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Rode como Administrador.' -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force 'C:\Tools' | Out-Null
Start-Transcript -Path 'C:\Tools\otimizar-windows.log' -Append | Out-Null

$modo = if ($Aplicar) { 'APLICANDO' } else { 'SIMULACAO (nada sera alterado)' }
Write-Host "==== $modo ====" -ForegroundColor Cyan
$o = Get-CimInstance Win32_OperatingSystem
Write-Host ("RAM livre antes: {0} MB de {1} MB" -f [int]($o.FreePhysicalMemory/1KB), [int]($o.TotalVisibleMemorySize/1KB))

function Fazer($descricao, [scriptblock]$acao) {
    if ($Aplicar) {
        try { & $acao; Write-Host "[ok] $descricao" -ForegroundColor Green }
        catch { Write-Host "[falhou] $descricao : $($_.Exception.Message)" -ForegroundColor Yellow }
    } else { Write-Host "[simulacao] $descricao" }
}

function Reg($caminho, $nome, $valor) {
    if (-not (Test-Path $caminho)) { New-Item -Path $caminho -Force | Out-Null }
    New-ItemProperty -Path $caminho -Name $nome -Value $valor -PropertyType DWord -Force | Out-Null
}

if ($Aplicar) {
    try {
        Enable-ComputerRestore -Drive 'C:\' -ErrorAction Stop
        Checkpoint-Computer -Description 'Antes de otimizar-windows' -RestorePointType MODIFY_SETTINGS -ErrorAction Stop
        Write-Host '[ok] Ponto de restauracao criado.' -ForegroundColor Green
    } catch { Write-Host "[aviso] Sem ponto de restauracao: $($_.Exception.Message)" -ForegroundColor Yellow }
}

Write-Host "`n-- IA / Copilot / pesquisa na web --" -ForegroundColor Cyan
Fazer 'Desativar o Windows Copilot (politica)' {
    Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsCopilot' 'TurnOffWindowsCopilot' 1 }
Fazer 'Remover o app Copilot, se existir' {
    Get-AppxPackage -AllUsers '*Copilot*' | Remove-AppxPackage -AllUsers -ErrorAction SilentlyContinue }
Fazer 'Desativar Cortana e pesquisa na web no menu Iniciar' {
    $p = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search'
    Reg $p 'AllowCortana' 0; Reg $p 'DisableWebSearch' 1; Reg $p 'ConnectedSearchUseWeb' 0 }
Fazer 'Desativar Widgets / Noticias e interesses' {
    Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Feeds' 'EnableFeeds' 0 }

Write-Host "`n-- Sugestoes, anuncios e telemetria --" -ForegroundColor Cyan
Fazer 'Desativar apps/sugestoes automaticas (consumer features, spotlight)' {
    $p = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent'
    Reg $p 'DisableWindowsConsumerFeatures' 1; Reg $p 'DisableSoftLanding' 1; Reg $p 'DisableWindowsSpotlightFeatures' 1 }
Fazer 'Desativar ID de publicidade' {
    Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AdvertisingInfo' 'DisabledByGroupPolicy' 1 }
Fazer 'Telemetria no minimo (o Windows Home/Pro trata 0 como basico)' {
    Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection' 'AllowTelemetry' 0 }
Fazer 'Desativar apps em segundo plano' {
    Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy' 'LetAppsRunInBackground' 2 }
Fazer 'Desativar Game DVR / barra de jogos' {
    Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\GameDVR' 'AllowGameDVR' 0 }
Fazer 'Delivery Optimization so por HTTP (nao envia atualizacoes a outros PCs)' {
    Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\DeliveryOptimization' 'DODownloadMode' 0 }
Fazer 'Desativar sincronizacao do OneDrive' {
    Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OneDrive' 'DisableFileSyncNGSC' 1 }
Fazer 'Nao reiniciar sozinho com alguem logado apos atualizar' {
    Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' 'NoAutoRebootWithLoggedOnUsers' 1 }

Write-Host "`n-- Servicos desnecessarios --" -ForegroundColor Cyan
$servicos = @{
    'DiagTrack'        = 'Telemetria (Experiencias do Usuario Conectado)'
    'dmwappushservice' = 'Push de telemetria WAP'
    'SysMain'          = 'Superfetch (so atrapalha em HD)'
    'WSearch'          = 'Indexacao de pesquisa (so atrapalha em HD)'
    'MapsBroker'       = 'Mapas offline'
    'RetailDemo'       = 'Modo demonstracao de loja'
    'XblAuthManager'   = 'Xbox Live: autenticacao'
    'XblGameSave'      = 'Xbox Live: jogos salvos'
    'XboxNetApiSvc'    = 'Xbox Live: rede'
    'XboxGipSvc'       = 'Acessorios Xbox'
}
foreach ($s in $servicos.Keys) {
    if (Get-Service $s -ErrorAction SilentlyContinue) {
        Fazer "Desativar servico $s ($($servicos[$s]))" {
            Stop-Service $s -Force -ErrorAction SilentlyContinue
            Set-Service $s -StartupType Disabled
        }
    }
}

Write-Host "`n-- Tarefas agendadas de telemetria --" -ForegroundColor Cyan
$tarefas = @(
    '\Microsoft\Windows\Application Experience\Microsoft Compatibility Appraiser',
    '\Microsoft\Windows\Application Experience\ProgramDataUpdater',
    '\Microsoft\Windows\Customer Experience Improvement Program\Consolidator',
    '\Microsoft\Windows\Customer Experience Improvement Program\UsbCeip',
    '\Microsoft\Windows\DiskDiagnostic\Microsoft-Windows-DiskDiagnosticDataCollector',
    '\Microsoft\Windows\Windows Error Reporting\QueueReporting'
)
foreach ($t in $tarefas) {
    $nome = Split-Path $t -Leaf; $caminho = (Split-Path $t -Parent) + '\'
    if (Get-ScheduledTask -TaskPath $caminho -TaskName $nome -ErrorAction SilentlyContinue) {
        Fazer "Desativar tarefa $nome" { Disable-ScheduledTask -TaskPath $caminho -TaskName $nome | Out-Null }
    }
}

Write-Host "`n-- Aplicativos que vem com o Windows --" -ForegroundColor Cyan
$apps = @('*BingNews*','*BingWeather*','*BingFinance*','*BingSports*','*GetHelp*','*Getstarted*',
    '*MicrosoftOfficeHub*','*SolitaireCollection*','*MixedReality.Portal*','*Microsoft.People*',
    '*SkypeApp*','*WindowsFeedbackHub*','*WindowsMaps*','*XboxApp*','*Xbox.TV*','*XboxGameOverlay*',
    '*XboxGamingOverlay*','*XboxIdentityProvider*','*XboxSpeechToTextOverlay*','*YourPhone*',
    '*ZuneMusic*','*ZuneVideo*','*549981C3F5F10*','*Clipchamp*','*MicrosoftTeams*','*Todos*',
    '*CandyCrush*','*Disney*','*Spotify*','*TikTok*','*Facebook*','*Instagram*','*Twitter*','*Netflix*','*AmazonPrime*')
foreach ($a in $apps) {
    $pk = Get-AppxPackage -AllUsers $a -ErrorAction SilentlyContinue
    foreach ($p in $pk) {
        Fazer "Remover app $($p.Name)" { Remove-AppxPackage -Package $p.PackageFullName -AllUsers -ErrorAction Stop }
    }
}

Write-Host "`n-- Navegadores e Defender mais leves --" -ForegroundColor Cyan
Fazer 'Edge: sem pre-carregamento nem execucao em segundo plano' {
    $p = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'
    Reg $p 'StartupBoostEnabled' 0; Reg $p 'BackgroundModeEnabled' 0 }
Fazer 'Defender: varredura usa no maximo 20% da CPU e so quando ocioso (protecao continua ligada)' {
    Set-MpPreference -ScanAvgCPULoadFactor 20 -DisableCatchupFullScan $true -DisableCatchupQuickScan $true }
Fazer 'Desativar relatorio de erros do Windows' {
    Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Error Reporting' 'Disabled' 1 }

Write-Host "`n-- Energia e inicializacao --" -ForegroundColor Cyan
Fazer 'Plano de energia: Alto desempenho' { powercfg /setactive SCHEME_MIN | Out-Null }
Fazer 'Desligar hibernacao (libera disco) e inicializacao rapida (boot limpo, tarefas da Yui sobem certo)' {
    powercfg /hibernate off | Out-Null
    Reg 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' 'HiberbootEnabled' 0 }
Fazer 'Desativar dicas, sugestoes e notificacoes de boas-vindas' {
    $p = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager'
    foreach ($n in 'SubscribedContent-338389Enabled','SubscribedContent-310093Enabled','SubscribedContent-338388Enabled',
        'SoftLandingEnabled','SystemPaneSuggestionsEnabled','OemPreInstalledAppsEnabled','PreInstalledAppsEnabled') { Reg $p $n 0 } }
Fazer 'Remover itens de inicializacao do OneDrive e do Edge' {
    $r = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    foreach ($n in 'OneDrive','MicrosoftEdgeAutoLaunch*') {
        Get-Item $r -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Property |
            Where-Object { $_ -like $n } | ForEach-Object { Remove-ItemProperty -Path $r -Name $_ -ErrorAction SilentlyContinue } } }

Write-Host "`n-- Mais servicos desnecessarios --" -ForegroundColor Cyan
$extras = @{
    'Fax'        = 'Fax'
    'WerSvc'     = 'Relatorio de erros'
    'lfsvc'      = 'Localizacao geografica'
    'icssvc'     = 'Hotspot movel'
    'WpcMonSvc'  = 'Controle dos pais'
    'SEMgrSvc'   = 'Pagamentos NFC'
    'WalletService' = 'Carteira'
    'PhoneSvc'   = 'Telefone'
    'WMPNetworkSvc' = 'Compartilhamento do Media Player'
}
foreach ($s in $extras.Keys) {
    if (Get-Service $s -ErrorAction SilentlyContinue) {
        Fazer "Desativar servico $s ($($extras[$s]))" {
            Stop-Service $s -Force -ErrorAction SilentlyContinue
            Set-Service $s -StartupType Disabled
        }
    }
}

Write-Host "`n-- Visual leve (usuario atual) --" -ForegroundColor Cyan
Fazer 'Efeitos visuais para melhor desempenho' {
    Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\VisualEffects' 'VisualFXSetting' 2 }
Fazer 'Desligar transparencia' {
    Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' 'EnableTransparency' 0 }

Write-Host ''
$o = Get-CimInstance Win32_OperatingSystem
Write-Host ("RAM livre agora: {0} MB de {1} MB" -f [int]($o.FreePhysicalMemory/1KB), [int]($o.TotalVisibleMemorySize/1KB))
if ($Aplicar) { Write-Host 'Pronto. Reinicie o notebook para aplicar tudo. Log: C:\Tools\otimizar-windows.log' -ForegroundColor Green }
else { Write-Host 'Simulacao concluida. Se estiver tudo certo, rode de novo com -Aplicar.' -ForegroundColor Cyan }
Stop-Transcript | Out-Null
