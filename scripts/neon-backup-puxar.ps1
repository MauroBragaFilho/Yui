# Puxa o backup CIFRADO da Yui (repositorio privado do GitHub) para o PC "Neon" e confere o basico. Roda pela tarefa YuiBackupNeon.
# - So git + conferencia do selo do manifesto (SEM a chave). A chave de cifra NAO fica neste PC.
# - Tolerante: PC desligado na hora, sem rede ou GitHub fora do ar = uma linha no log e sai com sucesso (tenta de novo no proximo dia).
# - Guarda o historico inteiro do git (os 30 backups). Nunca apaga nada alem do que o git atualiza.
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File neon-backup-puxar.ps1 [-Destino D:\YuiBackup\offsite] [-ChaveSsh C:\caminho\deploy_key]
param(
    [string]$Destino = 'D:\YuiBackup\offsite',
    [string]$RepoUrl = 'git@github.com:MauroBragaFilho/Yui-backup.git',
    [string]$ChaveSsh = '',          # chave de acesso (deploy key, so leitura basta); vazio = usa o ssh/agente do usuario
    [string]$Log = 'D:\YuiBackup\puxar.log',
    [int]$AlertaHoras = 36           # backup mais novo que isto = ok; mais velho = ALERTA no log
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'neon-comum.ps1')

function Terminar([string]$resultado, [int]$codigo, [string]$commit = '-') {
    Escrever-LinhaLog $Log ("commit={0} resultado={1}" -f $commit, $resultado)
    exit $codigo
}

# Uma execucao por vez.
$mutex = New-Object System.Threading.Mutex($false, 'Global\YuiBackupNeonPuxar')
if (-not $mutex.WaitOne(0)) { Terminar 'JA-RODANDO: outra execucao em andamento, nada feito' 0 }

try {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { Terminar 'ERRO: git nao encontrado no PATH (instale o Git for Windows)' 1 }
    if ($ChaveSsh) {
        if (-not (Test-Path $ChaveSsh)) { Terminar "ERRO: chave ssh nao encontrada ($ChaveSsh)" 1 }
        $env:GIT_SSH_COMMAND = ('ssh -i "{0}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes' -f $ChaveSsh)
    } else {
        $env:GIT_SSH_COMMAND = 'ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes'
    }
    $env:GIT_TERMINAL_PROMPT = '0'

    function Rodar-Git([string[]]$argumentos, [string]$dir) {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $git.Source
        $psi.Arguments = ($argumentos | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
        if ($dir) { $psi.WorkingDirectory = $dir }
        $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = $p.StandardOutput.ReadToEnd(); $err = $p.StandardError.ReadToEnd()
        if (-not $p.WaitForExit(240000)) { try { $p.Kill() } catch { } ; return @{ Codigo = 124; Saida = 'tempo esgotado' } }   # so o git que ESTE script abriu
        return @{ Codigo = $p.ExitCode; Saida = ($out + $err).Trim() }
    }

    $emFalha = $null
    if (-not (Test-Path (Join-Path $Destino '.git'))) {
        $pai = Split-Path -Parent $Destino
        if (-not (Test-Path $pai)) { New-Item -ItemType Directory -Force $pai | Out-Null }
        $r = Rodar-Git @('clone', $RepoUrl, $Destino) $pai
        if ($r.Codigo -ne 0) { $emFalha = $r.Saida }
    } else {
        $r = Rodar-Git @('fetch', '--prune', 'origin', 'main') $Destino
        if ($r.Codigo -eq 0) {
            # copia espelho: nunca tem alteracao local; reset deixa igual ao remoto
            $r2 = Rodar-Git @('reset', '--hard', 'origin/main') $Destino
            if ($r2.Codigo -ne 0) { $emFalha = $r2.Saida }
        } else { $emFalha = $r.Saida }
    }
    if ($emFalha) {
        $resumo = ($emFalha -split "`n" | Select-Object -Last 2) -join ' '
        if ($resumo.Length -gt 180) { $resumo = $resumo.Substring(0, 180) }
        # Sem rede/GitHub fora = tolerado (exit 0). A copia anterior continua valendo.
        Terminar ("SEM-ATUALIZACAO: nao consegui falar com o GitHub agora ({0}); a copia anterior continua" -f $resumo) 0
    }

    $commit = (Rodar-Git @('rev-parse', '--short', 'HEAD') $Destino).Saida
    $total = (Rodar-Git @('rev-list', '--count', 'HEAD') $Destino).Saida

    $lotes = @(Get-BackupsDoRepositorio -PastaBackups (Join-Path $Destino 'backups'))
    $completos = @($lotes | Where-Object { $_.Completo })
    if ($completos.Count -eq 0) { Terminar 'ERRO-INTEGRIDADE: nenhum backup completo (manifesto integro) no repositorio' 1 $commit }
    $ultimo = $completos[0]
    $idadeH = if ($ultimo.QuandoUtc) { [math]::Round(((Get-Date).ToUniversalTime() - $ultimo.QuandoUtc).TotalHours, 1) } else { -1 }
    $extra = ''
    if (($lotes.Count - $completos.Count) -gt 0) { $extra = ' incompletos=' + ($lotes.Count - $completos.Count) }
    if ($idadeH -gt $AlertaHoras) {
        Terminar ("ALERTA: ultimo backup completo {0} tem {1} h (mais de {2} h; o notebook parou de enviar?) lotes={3} commits={4}{5}" -f $ultimo.Nome, $idadeH, $AlertaHoras, $completos.Count, $total, $extra) 0 $commit
    }
    Terminar ("OK: ultimo={0} idade={1}h arquivos={2} manifesto=v{3} ({4}) lotes={5} commits={6}{7}" -f $ultimo.Nome, $idadeH, $ultimo.Arquivos, $ultimo.Versao, $ultimo.Motivo, $completos.Count, $total, $extra) 0 $commit
} finally {
    try { $mutex.ReleaseMutex() } catch { }
}
