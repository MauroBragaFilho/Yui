# 🛠️ Operação no dia a dia

Como a Yui roda hoje, como reiniciá-la, onde ficam os logs e os dados e o que fazer quando algo dá errado. Para instalar pela primeira vez, veja [Primeiros passos](GET_STARTED.md).

---

## 📂 Sumário

1. [Como a Yui roda](#-1-como-a-yui-roda)
2. [Portas e serviços](#-2-portas-e-serviços)
3. [Iniciar, parar e reiniciar](#-3-iniciar-parar-e-reiniciar)
4. [O `Yui.bat`](#-4-o-yuibat)
5. [Logs e auditoria](#-5-logs-e-auditoria)
6. [Dados e backups](#-6-dados-e-backups)
7. [Atualizar o código](#-7-atualizar-o-código)
8. [A VPS da AWS](#-8-a-vps-da-aws)
9. [Problemas comuns](#-9-problemas-comuns)
10. [Checklist de segurança](#-10-checklist-de-segurança)
11. [Checklist da fala (TTS)](#-11-checklist-da-fala-tts)

---

## 🖥️ 1. Como a Yui roda

A Yui roda **no PC do dono**, não em servidor. Duas tarefas do **Agendador de Tarefas do Windows** (usuário atual, sem administrador) a mantêm no ar:

| Tarefa | O que executa | Quando |
|--------|---------------|--------|
| `YuiBot` | `node src/index.js` (bot do Discord + Core + API + Gateway) | No logon do Windows |
| `YuiWebApp` | `node apps/yui-app/scripts/serve-web.mjs` (app web em `:8081`) | No logon do Windows |

Cada tarefa roda dentro de um **supervisor**: um laço que religa o processo **15 segundos depois de qualquer saída**, seja erro, queda ou fechamento do console. Assim a Yui volta sozinha, e não depende de reiniciar o Windows para se recuperar.

Consequências práticas:

- A Yui **só responde com o PC ligado, com internet e com o seu usuário logado** (a tarefa inicia no logon). Se o PC dormir ou desligar, ela fica offline para todos os servidores.
- Para não perder disponibilidade, evite deixar o PC entrar em suspensão (Configurações → Energia).

---

## 🔌 2. Portas e serviços

Tudo escuta apenas em **`127.0.0.1`** (acessível só pelo próprio PC):

| Porta | Serviço | Ativação |
|-------|---------|----------|
| `3939` | **Yui API** | `YUI_API_ENABLED=true` |
| `8081` | **App web** (arquivos do `apps/yui-app/dist`) | tarefa `YuiWebApp` |
| `20130` | **Yui Gateway** (servidor de IA, compatível com OpenAI) | `YUI_GATEWAY_ENABLED=true` + `YUI_GATEWAY_KEYS` |

Acesso de outros aparelhos, **somente pela sua rede privada do Tailscale**:

```powershell
tailscale serve --bg --https=3939 http://127.0.0.1:3939     # publica a API em https://<pc>.<tailnet>.ts.net:3939
tailscale serve status                                     # confere o que está publicado
tailscale serve --https=3939 off                           # desfaz
```

Para abrir o **app no celular**, publique também o app web (só na sua tailnet) e libere a origem na API:

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:8081     # app em https://<pc>.<tailnet>.ts.net:8443
```

```env
YUI_API_CORS_ORIGINS=http://localhost:8081,http://127.0.0.1:8081,https://<pc>.<tailnet>.ts.net:8443
```

No próprio PC, abra `http://localhost:8081`. O app usa o mesmo endereço em que a página foi aberta, na porta `3939`: abrir pelo **IP da rede local** (ex.: `192.168.x.x:8081`) não funciona, porque a API só escuta em `127.0.0.1`.

Nunca use `tailscale funnel` (ele abre para a internet).

---

## ▶️ 3. Iniciar, parar e reiniciar

No PowerShell:

```powershell
Get-ScheduledTask -TaskName YuiBot,YuiWebApp                 # estado (Running / Ready)

# Reiniciar a Yui (carrega mudanças do .env ou do código)
Stop-ScheduledTask -TaskName YuiBot
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'src.index.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName YuiBot
```

> O `Stop-ScheduledTask` encerra o supervisor, mas o processo do Node pode ficar vivo; por isso o segundo comando. Espere cerca de 30 segundos para a Yui logar no Discord e subir a API.

Pelo app, o dono também pode usar **Admin → Geral → Reiniciar a Yui** (a saída é limpa e o supervisor a religa em ~15 s).

Para **desligar de vez**: `Stop-ScheduledTask` + `Unregister-ScheduledTask -TaskName YuiBot -Confirm:$false` (e o mesmo para `YuiWebApp`).

Recriar as tarefas (por exemplo, em outro PC) é só registrar uma tarefa por usuário, com gatilho "ao fazer logon", que execute `powershell -WindowStyle Hidden` rodando `while ($true) { node src/index.js; Start-Sleep 15 }` na pasta do projeto.

---

## 🪟 4. O `Yui.bat`

Menu para uso manual (fica fora do Git: `*.bat` está no `.gitignore`):

| Opção | Função |
|-------|--------|
| `1` | **Iniciar a Yui** em uma janela: sobe o app web junto (se não estiver no ar) e **não duplica o bot** |
| `2` / `3` | Testes isolados do Newswire e do GTAO Engine |
| `4` | Registrar/atualizar os slash commands |
| `5` | Conectar na VPS por SSH |

**Importante:** como a tarefa `YuiBot` já mantém a Yui no ar, a opção `1` detecta a instância existente e avisa em vez de iniciar outra. Duas instâncias com o mesmo token do Discord responderiam **em dobro**. Para rodar em janela (para ver o console), pare a tarefa antes.

---

## 📜 5. Logs e auditoria

| Arquivo | Conteúdo |
|---------|----------|
| `logs/app-AAAA-MM-DD.log` | Log da aplicação (inicialização, agendador, API, Gateway) |
| `logs/error-AAAA-MM-DD.log` | Só os erros |
| `logs/core-audit.jsonl` | **Auditoria** do Core: logins, chaves por DM, ações do painel, ferramentas, leituras de memória pessoal (só metadados, nunca conteúdo nem senhas) |

O que procurar quando investigar:

```powershell
Select-String -Path logs\app-*.log -Pattern '\[error\]|\[warn\]' | Select -Last 20
Get-Content logs\core-audit.jsonl -Tail 30
Select-String -Path logs\app-*.log -Pattern '\[Pesquisa\]' | Select -Last 20   # agente de pesquisa: só metadados, nunca a pergunta
```

O agente de pesquisa escreve uma linha `[Pesquisa] tipo=... passos=... buscas=... paginas=... fontes=... ms=... provedor=... motivo=... privado=...` por pedido (nunca o texto da pergunta, da consulta ou da página) e linhas `[Pesquisa] guarda: acao=... motivo=...` quando troca uma promessa. Com `YUI_RESEARCH_GUARD=observe` elas viram `guarda (observe)` e `guarda final (observe)` e nada é trocado.

O painel mostra a auditoria em **Admin → Auditoria** e os logs da aplicação em **Admin → Logs** (com filtros por nível, texto e dia, e segredos mascarados). O caminho do arquivo pode ser trocado com `YUI_AUDIT_FILE`.

---

## 💾 6. Dados e backups

| Onde | O que guarda | Observação |
|------|--------------|------------|
| `.env` | Tokens, chaves, senhas | **Nunca** vai para o Git |
| `database/*.db` | Servidores configurados, publicações, resets, inscrições YouTube/Twitch, notícias | SQLite via `sql.js`, gravado a cada alteração de forma atômica (arquivo temporário na mesma pasta e depois rename: um processo morto no meio não deixa o `.db` ilegível). Sobras `*.db.<pid>.tmp` com mais de 5 minutos são apagadas na subida |
| `database/memory-personal.db` | Memória permanente do dono | **Privado**, ignorado pelo Git |
| `database/memory-discord.db` | Memória temporária dos usuários | **Privado**, ignorado pelo Git |
| `database/memory-context.db`, `database/memory-context-personal.db` | Contexto das conversas por horas (só existem com `YUI_CONTEXT_ENABLED=true`) | **Privado**, ignorados pelo Git (`database/memory-*.db`); as falas vencem sozinhas (6 h por padrão) |
| `secrets/search-budget.json` | Contador mensal de pesquisas da Brave e da Tavily | `secrets/` é ignorado pelo Git; apagar zera o contador |
| `src/data/*.json` | Configuração dos servidores (`server_settings`), TOS aceitos, banimentos (`bans.json`), ferramentas por servidor, rádio | Estado de runtime |
| `src/data/temp_audio`, `temp_videos`, `temp_spotify` | Uma subpasta por download, apagada depois do envio | Temporário e ignorado pelo Git; pode apagar o que sobrar com a Yui parada |
| `.venv-deemix/` | Ambiente Python do `deemix` (Deezer) | Ignorado pelo Git; recrie com `requirements-deemix.txt` (veja [Primeiros passos](GET_STARTED.md)) |
| `.venv-spotdl/` | Ambiente Python do `spotdl` (Spotify) | Ignorado pelo Git; recrie com `requirements-spotdl.txt` e o lock `requirements-spotdl.lock.txt` (veja [Primeiros passos](GET_STARTED.md#-spotify-opcional-ambiente-python-do-spotdl)) |

**Backup recomendado** (copie para um disco externo ou nuvem pessoal, com a Yui parada ou não):

```powershell
$dest = "D:\Backups\Yui-$(Get-Date -Format yyyyMMdd)"
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Copy-Item .env, database, src\data -Destination $dest -Recurse -Force
```

> ⚠️ Os bancos `core.db`, `gta-diario.db` etc. são **versionados** no Git (apenas os de memória são ignorados). Antes de um `git push`, confira com `git status` que nada sensível está indo junto, e prefira não versionar dados de runtime.

---

## ⬆️ 7. Atualizar o código

```powershell
git pull
npm install                         # se package.json mudou (inclui o Opus: opusscript e @noble/ciphers)
.venv-deemix\Scripts\python.exe -m pip install -r requirements-deemix.txt   # só se requirements-deemix.txt mudou
.venv-spotdl\Scripts\python.exe -m pip install --only-binary=:all: -c requirements-spotdl.lock.txt -r requirements-spotdl.txt   # só se os requirements do spotdl mudaram
cd apps\yui-app; npm install; npm run web:build; cd ..\..   # só se o app mudou
# reiniciar a Yui (seção 3)
```

Se os slash commands mudaram, a Yui os registra sozinha na inicialização (globais podem levar até 1 hora para aparecerem; defina `DISCORD_GUILD_ID` para testes instantâneos em um servidor).

**Depois de reiniciar,** confira no log (`logs/app-*.log`) as linhas `[MediaTools]`: `yt-dlp`, `ffmpeg`, `Opus: OK`, criptografia de voz, DAVE, `Deemix` e `Spotdl` (`OK` ou `FALTANDO`; a falta de um deles não impede a Yui de subir). Se aparecer `Opus: AUSENTE`, rode `npm install` e reinicie; enquanto isso a Yui recusa `/entrar-call` e o Modo Rádio. Confira também as linhas `[TTS]`: `[TTS] Provedor "sapi": disponível` e `[TTS] Pronto: provedores=sapi, ...` (a fala por voz; veja o [guia de TTS](TTS.md)). `[TTS] Desligado: ...` explica o motivo e, nesse caso, a Yui segue só em texto.

**yt-dlp sozinho:** a Yui atualiza o `yt-dlp` em segundo plano, uma vez 30 segundos depois de iniciar e uma vez por dia a partir das 4h (`YTDLP_UPDATE_HOUR`). Falha de atualização vira só um aviso no log. `YTDLP_AUTO_UPDATE=false` desliga. Isso cobre só o `yt-dlp` da Yui: o `yt-dlp` que vem dentro do `.venv-spotdl` é independente e se atualiza à mão (`.venv-spotdl\Scripts\python.exe -m pip install -U "yt-dlp[default]"`; se algo quebrar, reinstale com o lock).

**Testes antes de reiniciar:** as suítes `test:*` rodam offline e com bancos temporários (veja [README_TESTES.md](../../README_TESTES.md)); não precisam parar a Yui.

---

## ☁️ 8. A VPS da AWS

O bot **foi retirado da VPS** e roda só no PC. O processo `yui` do PM2 na VPS está **parado** (`pm2 stop yui` + `pm2 save`, para não voltar no boot), mas a instância continua ligada e custando, e ainda guarda um `.env` com tokens.

- **Nunca rode os dois ao mesmo tempo:** o mesmo token em duas máquinas faz a Yui responder em dobro.
- Para desativar de vez: apague o `.env` da VPS e encerre a instância no console da AWS.
- Para voltar temporariamente: pare as tarefas do PC e rode `pm2 start yui` na VPS.
- A VPS é uma `t3.micro` (1 GB de RAM, 6,7 GB de disco): pequena demais para Minecraft Java ou para o OmniRoute.
- O acesso SSH exige que o *security group* libere a porta 22 para o seu IP atual (o IP residencial muda).

---

### Avisos automáticos

A Yui manda uma **mensagem privada** para o dono no Discord quando algo dá errado, sem você precisar olhar o painel:

| Aviso | Quando |
|-------|--------|
| 🚨 Todos os provedores de IA falharam | Nenhuma IA conseguiu responder (com o último erro) |
| ⚠️ Provedor parou de responder | Um provedor ficou em descanso longo (sem crédito, chave inválida, modelo removido) |
| 🚨 Erro grave / erro inesperado | Exceção não tratada ou promessa rejeitada no processo. A DM começa por `Origem na Yui: src/arquivo:linha` (o primeiro ponto do código da Yui na pilha) e a mesma causa gera **uma DM só**, seja exceção ou promessa rejeitada |
| ⚠️ Voz e rádio sem codificador Opus | Na inicialização, se o Opus não for encontrado (repete no máximo a cada 12 horas) |
| ⚠️ Falha no evento semanal, YouTube, Twitch ou limpeza de memória | Tarefas agendadas que falharam |
| 🚨 Login do painel / chaves por DM bloqueados | Várias tentativas erradas seguidas (possível invasão) |
| ℹ️ Estou no ar | A Yui iniciou (ou reiniciou). Reconexões do Discord, que são normais, ficam só no log |

Para não encher a sua caixa: cada tipo de aviso só se repete depois de 30 minutos (`YUI_ALERTS_COOLDOWN_MINUTES`) e há um teto de 10 por hora. O texto passa pelo filtro que mascara chaves e senhas. Desligue tudo com `YUI_ALERTS=false`. Se o Discord estiver fora do ar, o aviso naturalmente não chega; os logs continuam em **Admin → Logs**.

## 🩺 9. Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---------|----------------|-------------|
| Yui offline no Discord | PC dormiu/desligado, ou ninguém logado | Ligue/entre no Windows; confira `Get-ScheduledTask YuiBot` |
| Responde **em dobro** | Duas instâncias com o mesmo token (VPS ligada, ou `Yui.bat` aberto com a tarefa) | Pare a outra instância |
| App: "Não foi possível conectar ao servidor" | Yui parada ou ainda iniciando (leva ~30 s), página aberta por um endereço não liberado (IP da rede local, ou origem fora de `YUI_API_CORS_ORIGINS`), celular sem Tailscale conectado, ou build apontando para outra porta | Confira a porta `3939` (`/v1/health`); gere o app de novo com `npm run web:build` e force a atualização do navegador (Ctrl+F5) |
| App: "Servidor não configurado neste app" | Build Android sem `EXPO_PUBLIC_YUI_SERVER_URL` | Gere o app com a variável (veja o [README do app](../../apps/yui-app/README.md)) |
| Chave por DM não chega | O Discord bloqueou DMs da Yui, ou ela está offline | Libere DMs de membros do servidor, ou entre por usuário e senha |
| Login bloqueado ("Muitas tentativas") | 5 erros seguidos | Espere 15 minutos; reiniciar a Yui também zera |
| `EADDRINUSE` / porta em uso | Outra instância ou serviço na mesma porta | Encerre o processo que usa a porta (`netstat -ano`) |
| Gemini com erro 404 | Modelo aposentado no `.env` | Use `gemini-flash-lite-latest` / `gemini-flash-latest` |
| Hugging Face com erro 402 | Créditos esgotados | Esperado; o Gateway deixa o provedor descansando 30 min |
| `[Weekly] ... Could not find Chrome` | Navegador não encontrado | Instale o Chrome/Edge ou defina `REDDIT_BROWSER_PATH` |
| `falha ao persistir banco em disco` | Arquivo bloqueado por outro programa (antivírus, backup) | Pontual; os bancos continuam íntegros, confira com `PRAGMA integrity_check` |
| Slash command novo não aparece | Registro global demora | Aguarde até 1 hora, ou use `DISCORD_GUILD_ID` |
| "A voz e o Modo Rádio estão indisponíveis... codificador Opus" | `opusscript` não instalado (log: `[MediaTools] Opus: AUSENTE`) | `npm install` e reinicie a Yui |
| A Yui responde na call só em texto (não fala) | O interruptor **🔊 Resposta por Voz (TTS)** vem desligado em cada servidor, ou uma regra de fala barrou (rádio ligado, limite, dado pessoal...) | Veja os [problemas comuns do guia de TTS](TTS.md#-9-problemas-comuns) e a linha `[TTS] Sem fala: ... motivo=...` no log |
| Yui parou de ouvir a call ("escuta desligada") | 5 falhas seguidas na captura de voz de uma sessão | Veja o log (`[VOICE]`); `/entrar-call` de novo religa a escuta |
| Rádio parou sozinha com aviso no canal | Ambiente de áudio quebrado (Opus ou ffmpeg) ou 5 faixas seguidas sem tocar | Confira Opus/ffmpeg nos logs de inicialização e reinicie o Modo Rádio |
| Música veio com o aviso "a qualidade desta faixa pode ser menor que a original" | O `deemix` falhou (ARL vencido, Python sem os pacotes, tempo esgotado); a Yui usa o plano B. O aviso não diz a fonte; ela fica no log | Confira `DEEZER_ARL` e `PYTHON_PATH`, e a linha `deemix` do log (`pip install -r requirements-deemix.txt` no ambiente) |
| Faixa do Spotify não baixa | `spotdl` ausente (log: `[MediaTools] Spotdl: FALTANDO`; o `yt-dlp` não baixa áudio do Spotify), relógio do PC errado, pasta com nome começando em `.` ou terminando em `.`, `*` ou `$` no caminho de `src/data/temp_spotify`, ou o Spotify/a rede bloqueou (depois de 3 falhas seguidas os pedidos são recusados por 5 minutos) | Veja as linhas `[SpotifyHandler]` do log; sincronize a hora do Windows; instale o ambiente ([Primeiros passos](GET_STARTED.md#-spotify-opcional-ambiente-python-do-spotdl)); para ver o motivo, `YUI_SPOTDL_LOG_LEVEL=DEBUG` e reinicie |
| "O arquivo ficou maior que o limite de envio do Discord" | MP3 acima de 10 MB (`YUI_UPLOAD_LIMIT_MB`) que nem recomprimido a 96 kbps coube (faixa com mais de uns 13 minutos), ou `YUI_AUDIO_REENCODE=false` | Peça uma faixa mais curta. Se o servidor tem Boost, o limite dele é maior (50 ou 100 MB) |
| "Há muitos downloads acontecendo ao mesmo tempo" | Teto global de `YUI_DL_MAX_CONCURRENT` (3) downloads simultâneos atingido | Esperado; tente de novo em instantes ou aumente o teto (`0` desliga) |
| "Você já tem pedidos na fila, ou a fila está cheia" | `YUI_QUEUE_MAX_PER_USER` (2) ou `YUI_QUEUE_MAX` (30) atingido | Esperado; espere a resposta. Nas menções o aviso de recusa sai no máximo 1 vez a cada 30 s por pessoa |
| A Yui diz que não leu o anexo | Anexo que não é `.txt`, `.md` ou `.log`, maior que `YUI_ATTACH_TEXT_MAX_KB` (100 KB), binário, vazio, ou a leitura de anexos está desligada | Mande o texto em `.txt`/`.md`/`.log` menor ou cole na conversa; `YUI_READ_TEXT_ATTACHMENTS` liga e desliga |
| Pergunta do `/yui` recusada ("Texto grande demais") | Mais de `YUI_ASK_MAX_CHARS` (4000) caracteres | Mande o texto como mensagem normal mencionando a Yui, com um anexo `.txt` ou `.md` |
| "Esse conteúdo é longo demais para baixar" | Passou de `YUI_DL_MAX_MINUTES` (20) ou é transmissão ao vivo | Aumente o limite no `.env` (`0` desliga) ou use outro link |
| "O download demorou demais" | Passou de `YUI_DL_TIMEOUT_SECONDS` (300 s) | Tente um conteúdo menor ou aumente o tempo |
| Pesquisa na web não acontece | Conversa privada com `YUI_PRIVATE_SEARCH=off` (a Yui diz "Não pesquiso na web numa conversa privada."), voz, ferramenta `search_web` desligada no servidor ("A pesquisa na web está desativada neste servidor."), limite de 5 pesquisas por hora por pessoa ("Você já fez várias pesquisas na última hora..."), teto global de 20 por hora ("A pesquisa na web atingiu o limite desta hora (somando todo mundo)..."), ou todos os provedores descansando/sem cota ("Os buscadores estão com limite ou em descanso...") | Veja as linhas `[Pesquisa]` e `[Search]` do log e **Admin → Integrações**; ajuste `YUI_SEARCH_USER_PER_HOUR`, `YUI_SEARCH_GLOBAL_PER_HOUR`, `YUI_PRIVATE_SEARCH` ou as chaves. Cada pedido de pesquisa termina em resposta, resumo com links ou um destes motivos |
| Pedido de pesquisa na conversa privada recusado ("Tem dado pessoal ou segredo aí..." ou "Não consigo pesquisar isso...") | A mensagem tem e-mail, CPF, telefone, cartão, senha, token, IP, agência/conta, número de 9 ou mais dígitos, token de 32 ou mais caracteres, ou uma palavra proibida do AutoMod; vale para a consulta de qualquer pessoa | Esperado: peça para a pessoa reescrever sem isso. Nada saiu para o buscador |
| Na conversa privada a Yui explica que só pesquisa em pedido explícito | `YUI_PRIVATE_SEARCH` liberou a conversa privada, mas o pedido não foi explícito (promessa do modelo, pergunta solta ou assunto em outra mensagem) | Esperado: pedir assim, "pesquise o preço do PS5" (assunto na mesma mensagem) |
| A resposta de pesquisa veio como "resumo automático (sem IA)" com 1 a 3 links | A IA não respondeu a tempo, devolveu vazio, JSON ou outra promessa, ou o prazo de 60 s (`YUI_RESEARCH_DEADLINE_MS`) acabou | Esperado, e melhor que silêncio. Se acontecer sempre, veja a cadeia de provedores de IA em **Admin → IA** |
| "Desculpe, tive um erro ao fechar essa resposta. Pode perguntar de novo?" | A IA respondeu só com uma promessa ("Vou pesquisar isso!") e a guarda final a trocou. A promessa não é guardada no histórico | Pergunte de novo. Para ver quantas vezes acontece, use `YUI_RESEARCH_GUARD=observe` e procure `[Pesquisa] guarda` no log |
| Resposta longa veio como arquivo `.md` | Passou de 4 mensagens (`YUI_REPLY_MAX_PARTS`) ou de 20000 caracteres | Esperado; aumente o limite de partes se preferir mensagens, ou `YUI_REPLY_ATTACH_EXT=txt` para o texto cru |
| Resposta longa terminou com "Faltaram N caracteres" | O canal não deixa a Yui anexar arquivos (falta a permissão "Anexar arquivos"), então só as primeiras partes foram entregues | Dê a permissão à Yui no canal |

Painel de saúde: **Admin → Geral** (Discord, RAM, bloqueios) e **Admin → IA** (provedores de IA).

---

## ✅ 10. Checklist de segurança

- [ ] `.env` fora do Git e com backup em local seguro.
- [ ] Tokens do app **por dispositivo**; senha do painel como **hash** (`npm run panel:password`).
- [ ] API, app web e gateway **somente em `127.0.0.1`**; acesso externo só por `tailscale serve`, sem `funnel`.
- [ ] `YUI_READ_ONLY` ligado (padrão) e `YUI_APPS` vazio, a menos que você precise.
- [ ] Revisar `git status` antes de cada `push`; não versionar `.env`, `*.pem`, bancos de memória nem logs.
- [ ] VPS antiga sem o `.env` ou encerrada.
- [ ] Backup periódico de `database/` e `src/data/`.
- [ ] `DEEZER_ARL` e chaves de busca só no `.env` (nunca em comando, chat ou log); chaves opcionais comentadas, sem texto-modelo.
- [ ] `YUI_CONTEXT_SCOPE=all` só depois de avisar nos Termos de Uso; `YUI_TTS_CLOUD` e `YUI_VOICE_TOOLS` mantidos em `false`, a menos que você precise.
- [ ] `YUI_PRIVATE_SEARCH` em `off` (padrão) ou `owner`. Em `all`, o pedido de pesquisa de qualquer pessoa em conversa privada (a DM de qualquer pessoa no Discord e o app/API de qualquer papel) sai para buscadores de terceiros (Tavily, Brave, DuckDuckGo, Bing); os Termos de Uso (`tosHandler.js`) não citam isso, então avalie antes. Em qualquer modo o log guarda só metadados da pesquisa.
- [ ] `apps/yui-app/logs/` fora do Git (`git rm --cached -r apps/yui-app/logs`, por sua conta, se ainda estiver rastreado).
- [ ] **🔊 Resposta por Voz (TTS)** ligado só nos servidores que você escolheu (todos na call ouvem a Yui, e o áudio da call vai a serviços de transcrição na nuvem). Veja o [guia de TTS](TTS.md#-8-privacidade).

---

## 🔊 11. Checklist da fala (TTS)

A fala da Yui na call passou em todos os testes automáticos, mas **nunca foi testada numa call de verdade**. Faça o primeiro teste num servidor seu, com a Yui no ar, e peça só coisas inofensivas (nada de "apagar" ou "formatar", e não peça para ela repetir frases suas). O guia completo está em [TTS](TTS.md).

**Antes (uma vez):**

- [ ] `npm run test:tts` passou (cerca de 1 minuto, offline; pode rodar com a Yui no ar).
- [ ] A voz do Windows está instalada ([passo 2 do guia](TTS.md#-2-conferir-a-voz-do-windows)) e você ouviu `npm run tts:amostra`.
- [ ] Reiniciou a Yui ([seção 3](#-3-iniciar-parar-e-reiniciar)) e o log tem `[TTS] Provedor "sapi": disponível` e `[TTS] Pronto: provedores=sapi, ...`.
- [ ] No servidor de teste, ligou **🎙️ Assistente de Voz (Call)** e **🔊 Resposta por Voz (TTS)** em `/yui-ferramentas` e conferiu com *Listar Status das Tools*.

**Na call** (anote o que não bater; as linhas `[TTS]` e `[VOICE]` ficam em `logs/app-*.log`):

- [ ] `/entrar-call`: a Yui entra e avisa no chat como falar com ela. No log: `[VOICE] Conectada e pronta`.
- [ ] *"Yui, qual a capital da Austrália?"*: o texto aparece no chat e ela **fala**. Todos na call a ouvem desde a primeira fala (criptografia DAVE), com volume e clareza razoáveis. Confira a pronúncia de "Yui".
- [ ] Tempo de resposta: leia `ms_primeiro_som` na linha `[TTS] Fala:` do log. A meta é chegar ao primeiro som em até uns 8 segundos no caso comum.
- [ ] Falar por cima dela (quem fez o pedido): ela para. Repita o pedido depois.
- [ ] *"Yui, para"* dito **sem** ela estar falando: a IA não é chamada e o log mostra `Pedido de parada por voz`. (Dito por outra pessoa em cima da voz da Yui ele não é entendido: é a limitação aceita do [guia](TTS.md#-4-como-usar-na-call).)
- [ ] Eco, com **fone** e com **alto-falante**: ela não responde a si mesma nem se corta sozinha. Se se cortar, use `YUI_TTS_BARGE_IN=false`.
- [ ] Duas ou mais pessoas na call: só quem pediu a interrompe falando por cima; um bot de música na call é ignorado.
- [ ] Pedido de quem **não está na call** ou está banido: ela não fala (log `motivo=user-not-in-call` ou `banned`).
- [ ] Desligar **🔊 Resposta por Voz (TTS)** no meio de uma resposta de várias frases: a fala é cortada na hora (não termina nem a frase atual) e a fila de fala do servidor é descartada; o texto no chat continua.
- [ ] Pedir uma ferramenta por voz (por exemplo, *"Yui, baixa uma música"*): a resposta é *"Isso eu faço só pelo chat."* e nada é baixado.
- [ ] Modo Rádio ligado: ela não fala e a música segue intacta. Ligar o rádio no meio de uma fala corta a fala.
- [ ] `/sair-call` no meio de uma fala corta a fala; mover a Yui de canal ou derrubar a conexão não deixa a fala presa; canal sem permissão de *Falar* aparece no log como `motivo=no-speak-permission`.
- [ ] Recursos: o processo da voz (um `powershell.exe`, uns 130 a 150 MB) some sozinho depois de 10 minutos sem falar e ao reiniciar a Yui. Com um jogo aberto, a Yui no ar não deve pesar de forma perceptível.

Se algo der errado, desligue com `YUI_TTS_ENABLED=false` e reinicie: tudo volta a ser só texto. Depois do teste, atualize a pendência 16 em [Assistente pessoal](ASSISTENTE_PESSOAL.md#-pendências).
