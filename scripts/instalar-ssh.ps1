# Instala e configura o OpenSSH Server no Windows 10 (1809 ou superior).
# Uso (PowerShell como Administrador):
#   powershell -ExecutionPolicy Bypass -File .\instalar-ssh.ps1
#   powershell -ExecutionPolicy Bypass -File .\instalar-ssh.ps1 -PublicKey "ssh-ed25519 AAAA... usuario@pc"
#   ... -PublicKey "..." -DesativarSenha   (so aceita chave; use depois de testar a chave)
param(
    [string]$PublicKey = '',
    [switch]$DesativarSenha
)

$ErrorActionPreference = 'Stop'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host 'Abra o PowerShell como Administrador e rode de novo.' -ForegroundColor Red
    exit 1
}

if ($DesativarSenha -and -not $PublicKey) {
    Write-Host '-DesativarSenha exige -PublicKey (senao voce ficaria sem acesso).' -ForegroundColor Red
    exit 1
}

# 1. Instala o servidor. Sem internet: usa o OpenSSH-Win64.msi que estiver
#    junto do script ou em ..\instaladores. Com internet: Windows Update.
$msi = @("$PSScriptRoot\OpenSSH-Win64.msi", "$PSScriptRoot\instaladores\OpenSSH-Win64.msi") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (Get-Service sshd -ErrorAction SilentlyContinue) {
    Write-Host 'OpenSSH Server ja instalado.'
} elseif ($msi) {
    Write-Host "Instalando OpenSSH Server pelo MSI offline ($msi)..."
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
    if ($p.ExitCode -notin 0, 3010) { throw "msiexec falhou (codigo $($p.ExitCode))." }
} else {
    $cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
    Write-Host 'Instalando OpenSSH Server pelo Windows Update (pode demorar alguns minutos)...'
    Add-WindowsCapability -Online -Name $cap.Name | Out-Null
}

# 2. Servico: inicia sozinho com o Windows
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
# ssh-agent nao e necessario para receber conexoes

# 3. Firewall: so aceita conexoes da propria rede local.
#    Garante uma regra na porta 22 e restringe TODAS as regras de entrada da 22.
$regra = 'OpenSSH-Server-In-TCP'
if (-not (Get-NetFirewallRule -Name $regra -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name $regra -DisplayName 'OpenSSH Server (22)' -Enabled True `
        -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
Get-NetFirewallRule -Direction Inbound -Action Allow -ErrorAction SilentlyContinue |
    Where-Object { ($_ | Get-NetFirewallPortFilter).LocalPort -contains '22' } |
    ForEach-Object { Set-NetFirewallRule -Name $_.Name -Profile Any -RemoteAddress LocalSubnet }

# 4. Shell padrao: PowerShell
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell `
    -Value 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -PropertyType String -Force | Out-Null

# 5. Chave publica (opcional). Para usuario administrador o arquivo e este:
$cfg = 'C:\ProgramData\ssh\sshd_config'
if ($PublicKey) {
    $authFile = 'C:\ProgramData\ssh\administrators_authorized_keys'
    if (-not (Test-Path $authFile)) { New-Item -ItemType File -Path $authFile -Force | Out-Null }
    if (-not (Select-String -Path $authFile -SimpleMatch -Pattern $PublicKey -Quiet)) {
        Add-Content -Path $authFile -Value $PublicKey -Encoding ascii
    }
    # permissoes exigidas pelo sshd: so SYSTEM e Administradores
    icacls.exe $authFile /inheritance:r /grant 'SYSTEM:(F)' /grant 'BUILTIN\Administrators:(F)' | Out-Null
    Write-Host 'Chave publica instalada.'
}

if ($DesativarSenha) {
    $txt = Get-Content $cfg -Raw
    if ($txt -match '(?m)^\s*#?\s*PasswordAuthentication\s+\w+') {
        $txt = $txt -replace '(?m)^\s*#?\s*PasswordAuthentication\s+\w+', 'PasswordAuthentication no'
    } else {
        $txt += "`r`nPasswordAuthentication no`r`n"
    }
    Set-Content -Path $cfg -Value $txt -Encoding ascii
    Restart-Service sshd
    Write-Host 'Login por senha desativado.'
}

# 6. Evita suspender (o notebook precisa ficar acordado para o SSH responder)
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT

# 7. Resumo
$ips = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' } |
    Select-Object -ExpandProperty IPAddress
Write-Host ''
Write-Host "sshd: $((Get-Service sshd).Status)" -ForegroundColor Green
Write-Host "Usuario: $env:USERNAME   Computador: $env:COMPUTERNAME"
Write-Host 'Conecte de outro PC da mesma rede com:'
foreach ($ip in $ips) { Write-Host "  ssh $env:USERNAME@$ip" -ForegroundColor Cyan }
Write-Host ''
Write-Host 'Dica: reserve esse IP no roteador (DHCP fixo) para ele nao mudar.'
