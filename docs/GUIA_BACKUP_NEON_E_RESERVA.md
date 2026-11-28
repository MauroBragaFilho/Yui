# Guia: backup no Neon e reserva fria da Yui

## O que e

1. **Backup no Neon.** Todo dia as 05:30 o notebook gera um backup **cifrado** da memoria da Yui e envia para um repositorio privado do GitHub (`Yui-backup`, guarda 30 versoes). O Neon passa a baixar uma copia disso todo dia, numa pasta dele (`D:\YuiBackup\offsite`). Assim existem tres copias: notebook, GitHub e Neon. O Neon **nao guarda a chave de cifra**: sem ela, os arquivos sao ilegiveis.
2. **Reserva fria.** Uma instalacao da Yui **parada** no Neon (`D:\YuiReserva`). Se o notebook morrer, voce a liga a mao, em uns 5 minutos, com o ultimo backup. Ela **nunca liga sozinha**: dois bots com o mesmo token do Discord nao podem rodar juntos.

Scripts (pasta `scripts` da Yui):

| Script | Para que serve |
|---|---|
| `neon-backup-puxar.ps1` | baixa o backup do GitHub e confere o basico (roda sozinho todo dia) |
| `neon-instalar-tarefa-backup.ps1` | cria/remove a tarefa agendada `YuiBackupNeon` |
| `neon-reserva-fria.ps1` | `-Preparar`, `-Ativar`, `-Desativar`, `-Status` |
| `neon-comum.ps1` | funcoes usadas pelos outros (nao se roda) |

## O que o Neon precisa ter

- Git for Windows (comando `git` funcionando) e acesso ao repositorio `Yui-backup`: uma chave SSH de **leitura** (deploy key, so leitura basta) ou o ssh do seu usuario ja autorizado no GitHub.
- Node.js (mesma versao do notebook, 22 ou mais) para a reserva.
- Tailscale instalado e conectado (o mesmo da rede do notebook).

## Instalar o backup diario (uma vez)

No PowerShell do Neon, dentro da pasta `scripts` da Yui (pode ser uma copia do repositorio em qualquer lugar):

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\neon-instalar-tarefa-backup.ps1 -Agora
```

Opcoes: `-Hora 12:00` (padrao), `-Destino D:\YuiBackup\offsite`, `-ChaveSsh C:\caminho\da\deploy_key`. Rodar de novo apenas atualiza a tarefa. Para tirar: `... -Remover` (os backups ja baixados ficam).

A tarefa roda como voce, so com o PC ocioso, com ou sem tomada, em prioridade baixa. Se o PC estava desligado na hora, roda assim que ligar e ficar ocioso. Sem internet ou com o GitHub fora, so anota no log e tenta no dia seguinte.

**Onde ver se esta funcionando:** `D:\YuiBackup\puxar.log`. Uma linha por execucao:

```
2026-11-28 12:05:10 commit=ab12cd3 resultado=OK: ultimo=backup-2026-11-28T08-30-00-123Z idade=3.6h arquivos=7 manifesto=v2 (selo conferido) lotes=30 commits=31
```

- `OK` = tudo certo. `ALERTA` = o ultimo backup tem mais de 36 h (o notebook parou de enviar: avise o Braga). `ERRO-INTEGRIDADE` = nenhum backup completo. `SEM-ATUALIZACAO` = sem rede/GitHub agora, vale a copia anterior.
- **O que e conferido:** o manifesto de cada lote existe e o "selo" SHA-256 dele bate (prova que o backup terminou e nao esta truncado) e ha arquivos cifrados ao lado. **O que nao e conferido aqui:** o conteudo de dentro, porque os hashes de cada banco ficam dentro do manifesto cifrado. Essa conferencia completa acontece no notebook (`node scripts/backup-offsite.mjs --verify`) e tambem na hora de ativar a reserva (a restauracao decifra e confere cada arquivo).
- O historico do git e mantido inteiro (os 30 backups).

## Preparar a reserva (uma vez, e de vez em quando para atualizar)

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\neon-reserva-fria.ps1 -Preparar
```

Baixa o codigo da Yui do GitHub (`main`), instala as dependencias (`npm ci`) em `D:\YuiReserva`. **Nao** copia `.env`, **nao** copia chave, **nao** inicia nada. Rode de novo uma vez por mes (ou depois de mudancas grandes na Yui) para a reserva nao ficar defasada. Ele se recusa a rodar se a reserva estiver ligada.

Ver como estao as coisas: `.\neon-reserva-fria.ps1 -Status -NotebookUrl https://SEU-NOTEBOOK.ts.net:3939`.

## Guardar fora do Neon (importante)

Para a emergencia voce precisa ter a mao, **fora do Neon** (pendrive, gerenciador de senhas, celular):

1. O arquivo da **chave de cifra** do backup (`C:\Tools\backup\backup.key` no notebook).
2. Uma copia do **`.env`** de producao (`C:\Yui\.env` no notebook).
3. O endereco do notebook no Tailscale (`https://...ts.net:3939`).

Sao segredos: nunca no GitHub, nunca na pasta do Neon sincronizada com nuvem. Se o notebook morreu e voce nao tem essas duas coisas guardadas, **nao ha como restaurar** (por isso guarde agora).

## EMERGENCIA: ativar a reserva, passo a passo

Use **so** se o notebook morreu (nao liga, queimou, sem internet por muito tempo) e a Yui precisa voltar.

1. **Tente o simples antes:** o notebook so travou? Religue-o pelo botao, ou pelo SSH/Tailscale. A reserva e o ultimo recurso.
2. Conecte o Tailscale no Neon. Deixe o pendrive com a chave e o `.env` plugado (ou baixe do gerenciador de senhas para uma pasta temporaria).
3. Abra o PowerShell no Neon, na pasta `scripts`, e rode (ajuste os caminhos):

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\neon-reserva-fria.ps1 -Ativar `
  -ArquivoChave E:\backup.key -ArquivoEnv E:\env-yui.txt -NotebookUrl https://SEU-NOTEBOOK.ts.net:3939
```

4. Digite exatamente `ATIVAR RESERVA` quando pedir.
5. O script **verifica sozinho** se o notebook esta fora e **recusa** se ele responder pela porta 3939 (ou se o Tailscale daqui estiver desconectado, ou se o notebook aparecer ligado no Tailscale sem a Yui responder: nesse caso tente religar a Yui dele pelo SSH; se ele esta travado de vez, repita com `-ForcarNotebookLigado`). Isso protege contra dois bots ao mesmo tempo.
6. Depois ele: acha o ultimo backup completo, restaura (decifra e confere cada arquivo com a chave, que so e usada naquele momento e nao fica guardada), coloca os bancos em `D:\YuiReserva\database` e `src\data`, copia o `.env`, inicia `node src/supervisor.js` e espera a Yui responder.
7. Confira no Discord se a Yui ficou online. Logs em `D:\YuiBackup\reserva.log` e `D:\YuiReserva\logs\supervisor.log`.
8. Retire o pendrive e **apague a copia temporaria** da chave se tiver baixado. O `.env` fica dentro de `D:\YuiReserva` (e um segredo: nao copie para outro lugar).

**Tempo:** a parte do script leva cerca de 1 a 2 minutos (conferencia do Tailscale ~10 s, restauracao de ~40 MB mediu menos de 1 s no teste, e o resto e a Yui subir ate responder a saude, ate 3 min de espera maxima). Contando achar a chave e o `.env`, a meta de ~5 minutos e realista. Estimativa: nao foi medido num incidente real, so as partes isoladas (a restauracao).

Diferencas da reserva: o IP e outro, entao qualquer coisa que dependa do endereco do notebook (painel pelo Tailscale, app do celular apontando para o notebook) nao acha a reserva sozinha. Caminhos de disco do `.env` (como `C:\...`) podem nao existir no Neon: o script lista os **nomes** das variaveis com caminho de disco para voce conferir. A reserva **nao** roda o atualizador automatico nem a tarefa de backup do notebook (o proprio backup diario so existe no notebook).

## Voltar ao notebook depois

1. **Pare a reserva primeiro:** `.\neon-reserva-fria.ps1 -Desativar` (cria o arquivo `logs\supervisor.parar`; o supervisor encerra o bot e o cerebro direito; nada e morto a forca). Espere ele dizer "a reserva parou".
2. **Leve os dados novos de volta.** Enquanto a reserva rodou, a memoria da Yui mudou em `D:\YuiReserva\database` (arquivos `.db`) e `D:\YuiReserva\src\data` (`bans.json`, `accepted_servers.json`, `server_settings.json`, `server_tools.json`). Se o notebook foi consertado **com os discos intactos**, copie esses arquivos da reserva por cima dos do notebook (`C:\Yui\database` e `C:\Yui\src\data`) **com a Yui do notebook parada**. Se o notebook foi **reinstalado/trocado**, instale a Yui nele normalmente e copie esses mesmos arquivos para as mesmas pastas, depois restaure a chave de cifra em `C:\Tools\backup\backup.key` e o `.env`.
   - Sempre copie os `.db` junto de quaisquer `-wal`/`-shm` ao lado, ou, mais simples, pare a reserva (passo 1) antes: parar limpo ja descarrega tudo nos `.db`.
   - Faca uma copia dos arquivos do notebook antes de sobrescrever.
3. Religue a Yui do notebook (tarefa `YuiBot`) e confira que ela esta online. **So entao** a reserva pode ser considerada de volta ao repouso. Nunca deixe as duas ligadas.
4. Rode `-Preparar` de novo mais para frente para atualizar o codigo da reserva. Se quiser, apague `D:\YuiReserva\.env` e os `.db` da reserva para ela voltar a ficar "fria" sem dados.

## Riscos e cuidados

- **Dois bots ao mesmo tempo** (maior risco): o script recusa se o notebook responde, mas se o notebook estiver ligado, com a internet dele caida, so a Tailscale pode dizer. Por isso a regra de so ativar com o notebook confirmadamente fora e a flag `-ForcarNotebookLigado` existir so para o caso consciente.
- **Perda de dados recentes:** a reserva sobe com o ultimo backup (ate ~1 dia de diferenca). Conversas e memorias do dia podem faltar.
- **Chave perdida = backup inutil.** Guarde a chave fora do notebook e fora do Neon. O Neon propositalmente nao a guarda.
- **O `.env` na reserva e um segredo** (tokens). Fica so em `D:\YuiReserva`; apague depois de desativar se quiser.
- **Reserva defasada:** se ninguem rodar `-Preparar`, o codigo da reserva envelhece. A conferencia de `-Status` mostra a data.
- **Neon fora de casa/desligado:** a tarefa tolera; mas se ele ficar semanas desligado, a copia local fica velha (o log mostra `ALERTA`).
- **Privacidade:** o repositorio e privado e so tem arquivos cifrados. Mesmo assim, nao compartilhe a pasta `D:\YuiBackup`.
