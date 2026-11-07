# Abre um tunel TCP do ngrok para o servidor Minecraft (porta 25565) e grava o endereco publico.
# Precisa de C:\Tools\ngrok\ngrok.exe e do token em C:\Tools\ngrok\authtoken.txt (so o texto do token).
# Fica em loop: espera os dois existirem, abre o tunel e reabre se cair. Roda como tarefa agendada no boot.
$dir = 'C:\Tools\ngrok'
$tokenFile = Join-Path $dir 'authtoken.txt'
$saida = 'C:\Modpack\endereco-ngrok.txt'
$porta = 25565

while ($true) {
    $token = if (Test-Path $tokenFile) { (Get-Content $tokenFile -Raw).Trim() } else { '' }
    if (-not $token -or $token -like 'COLE*' -or -not (Test-Path (Join-Path $dir 'ngrok.exe'))) {
        Start-Sleep -Seconds 60
        continue
    }
    $p = Start-Process (Join-Path $dir 'ngrok.exe') -ArgumentList "tcp $porta --authtoken $token --log=stdout --log-level=warn" `
        -WindowStyle Hidden -PassThru
    # espera o agente local (porta 4040) informar o endereco publico
    for ($i = 0; $i -lt 30 -and -not $p.HasExited; $i++) {
        Start-Sleep -Seconds 2
        try {
            $t = (Invoke-RestMethod http://127.0.0.1:4040/api/tunnels -TimeoutSec 3).tunnels | Select-Object -First 1
            if ($t.public_url) {
                ($t.public_url -replace '^tcp://', '') | Set-Content $saida -Encoding ascii
                break
            }
        } catch { }
    }
    $p.WaitForExit()
    Remove-Item $saida -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 15
}
