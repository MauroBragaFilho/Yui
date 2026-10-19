# 🧪 Testes da Yui

Os testes são scripts Node que terminam com código diferente de zero se algo falhar. A maioria roda **offline**, sem Discord, sem chaves e sem tocar nos seus dados (bancos e auditoria temporários).

## 🎯 Comandos

```bash
npm run test:core         # permissões, memória e contexto do Core
npm run test:core-api     # rotas da API, autenticação por token, limites
npm run test:core-agent   # Agent: ferramentas, confirmação, negações
npm run test:readonly     # modo somente leitura
npm run test:mentions     # menções reais (@usuário) nas respostas
npm run test:persona      # personalidade por contexto
npm run test:panel        # login por senha, chave por DM, sessões, painel admin
npm run test:search       # busca na web (cadeia de provedores, otimizador da consulta, teto global), system.info, comandos e skills
npm run test:dev          # Código (as funções do Jarvis): projetos, arquivos, comandos, aprovação, rotas /v1/dev
npm run test:alerts       # avisos automáticos por DM
npm run test:gateway      # Yui Gateway: failover, cooldown, streaming, servidor HTTP
npm run test:config       # rodízio de chaves e modelos Gemini
npm run test:gtao         # sistemas diários e semanais do GTA Online
npm run test:newswire     # Newswire (Puppeteer; acessa a internet)
npm run test:weekly-reddit    # parser/validação/cache do evento semanal
npm run test:weekly-browser   # feed do Reddit via Chrome (offline; LIVE=1 consulta o Reddit)
npm run test:weekly-gtaforums # fonte alternativa do evento semanal
npm run test:gtacars      # base de veículos GTACars
npm run test:ask-gtacars  # contexto técnico de veículos no /yui
npm run test:social       # avisos de YouTube/Twitch
npm run test:media        # downloads: validação de links, playlist, argumentos do yt-dlp, limites, pasta por pedido
npm run test:deezer       # Deezer/deemix: ARL fora da linha de comando, erros, plano B pelo YouTube, rádio
npm run test:safefetch    # leitura segura de páginas: bloqueio de IP interno, DNS, redirecionamento, limite de bytes
npm run test:llmsafety    # segurança da IA: dado não confiável, conversa sensível, /chat_resumo, ferramentas
npm run test:longreply    # respostas longas: divisor de mensagens, anexo, corte por tokens, ordem de envio
npm run test:context      # contexto por horas: retenção, escopo, bancos separados, apagar-tudo (leva ~45 s)
npm run test:voicerobust  # voz e rádio: ouvintes que não derrubam o bot, Opus, disjuntor, yt-dlp automático
npm run test:youtubeengine # motor do YouTube: gasto de cota, falhas isoladas, pausa por cota diária
npm run test:tts-text     # TTS: normalização do texto para fala e divisão em frases
npm run test:tts-audio    # TTS: conversão de áudio, provedor SAPI (processo falso e, no Windows, a voz real)
npm run test:tts-engine   # TTS: política (quem pode falar) e motor de provedores
npm run test:tts-edge     # TTS: voz neural da nuvem (escape do texto, limites, falhas, porta de privacidade; sem rede)
npm run test:tts-azure    # TTS: Azure Speech (SSML, chave só no cabeçalho, limites, falhas; sem rede)
npm run test:tts-output   # TTS: saída de áudio na call, fila, interrupção e anti-eco
npm run test:tts-pipeline # TTS: ponta a ponta com provedor falso
npm run test:tts-integration # TTS: ligação ao bot (voz, inicialização, rádio, painel de ferramentas), sem Discord
npm run test:tts-ia       # TTS: lado da IA (ferramentas barradas por voz, persona de voz, fila real, chave do STT; leva ~40 s)
npm run test:tts-e2e      # TTS ponta a ponta com a voz real do Windows e o receptor de voz real do Discord (rápido: ~2 min; -- --full: ~15 min)
npm run test:tts          # TTS: as 7 suítes acima em sequência (cerca de 1 minuto)
npm run test:pendencias   # integração das correções de outubro: /baixar_video, plano B do Deezer na música, rádio, deemix, auditoria dos testes
npm run test:spotdl       # spotdl (Spotify): argumentos fixos, ambiente mínimo, classificação de falhas, porteiro, disjuntor, pasta por pedido
npm run test:binaries-spotdl # item "spotdl" da checagem de ferramentas na inicialização (binaries.js), sem rodar o spotdl
npm run test:embedlimits  # limites de embed do Discord (título, campos, soma de 6000), sem partir emoji
npm run test:uploadlimit  # limite de anexo: 10 MB, 50 e 100 MB por nível de boost, folga de 5%
npm run test:inputlimits  # orçamento do prompt do /chat_resumo, erro de tamanho e leitor de linhas do stream do LM Studio
npm run test:searchlimits # leitura de páginas: HTML hostil numa worker com prazo, menções limitadas, regex segura (leva ~20 s)
npm run test:longreplylimits # respostas longas: plano B de envio, aviso do que faltou, texto vazio, cerca de código, contexto cortado
npm run test:dbatomic     # gravação atômica dos bancos (.db), inclusive com processos mortos no meio da gravação
npm run test:http413      # API e Gateway: corpo grande responde 413 em vez de ECONNRESET
npm run test:textinputs   # entradas de texto: anexos .txt/.md/.log, limite do /yui, texto livre do prefixo, trava por pessoa (leva ~25 s)
npm run test:embedpanels  # painéis e listas (seguindo, fila do rádio, ferramentas MCP, ajuda, memória) dentro dos limites do Discord
npm run test:embedpublish # publicações (notícias, diário, semanal), banimentos e consultas: um item ruim não derruba o lote
npm run test:audiofit     # MP3 acima do limite de anexo: recompressão, tags de origem, Modo Rádio intacto
npm run test:llmlimits    # fila da IA, prazo, erro de tamanho, stream, cortes sem partir emoji (leva ~25 s)
npm run test:interactionlimits # /chat_resumo, downloads (limite de anexo, origem não citada), comentário da IA sem menções
npm run test:searchintent # agente de pesquisa, parte pura: promessa, pedido explícito, pré-rota estrita, plano de recuperação, guarda final, sem ReDoS
npm run test:research     # agente de pesquisa: laço, limites, resposta final garantida, texto hostil, modo privado, contrato com o providers.js
npm run test:researchqueue # agente de pesquisa na fila real do llmHandler (axios/fetch falsos): promessa vira pesquisa, voz, privado, guarda final (leva ~2 min)
npm run test:researchentries # agente de pesquisa fora da fila: /yui, +yui e app/API (/v1/chat e /v1/agent), com os mesmos limites
npm run test:llmprompts   # textos de ferramentas e prompts de pesquisa, JSON de ferramenta por chaves balanceadas, portão da pesquisa privada
npm run test:leftoversfinal # sobras da rodada final: menção em massa no rádio, prompt de imagem fora do log, aviso "Salvo em disco", nota de anexo
npm run test:researchfixes # correções da revisão do agente de pesquisa, parte pura: promessa no fim da resposta, links com @, filtro de dados e palavras, /yui sem busca repetida, entrega com orçamento
npm run test:researchfixesqueue # correções da revisão do agente de pesquisa na fila real: chatter, voz, DM de qualquer pessoa, JSON cru, chamada escrita como texto, fila sem consumidor paralelo
npm run test:modlist      # lista de mods: detector (40 mensagens), parser, correspondência de nomes, par loader+versão, complementos, links, texto hostil, limites, prazo, 429, API fora do ar, privado e trava (Modrinth falso com respostas reais, sem rede)
npm run test:lists        # listas pessoais por conversa natural: JSON por usuário em database/listas, interpretação de pedidos em português, privacidade entre pessoas, limites
npm run test:docssync     # coerência entre package.json, .env_example, docs e código (variáveis, padrões, links, textos desatualizados)
npm run tts:amostra       # gera WAVs de amostra da voz para você ouvir (não é teste; use -- --fake para só testar o script)

node tests/test-weekly-embed-ptbr.js       # embed semanal (página 1 e detalhes)
node tests/test-weekly-combined-embed.js   # composição de todas as páginas
```

**App:** em `apps/yui-app`, `npm test` roda a lógica do app (23 testes, incluindo a aba Código) e `npx tsc --noEmit` confere os tipos.

**Yui Desktop** (janela do computador, em `D:\Projetos\Projeto Jarvis\Yui Desktop`): `npm test` (14) e `npm run smoke` (abre a janela de verdade contra uma Yui falsa; nunca toca a Yui real).

## 📊 O que cada suíte cobre

| Suíte | Verificações | Cobre |
|-------|:-----------:|-------|
| `test:core` | 21 | Papéis, escopos de memória, expiração, deduplicação, contexto |
| `test:core-api` | 12 | Rotas, 401/403, limites de requisição, CORS |
| `test:core-agent` | 21 | Uma ferramenta por turno, confirmação de 2 min, negação |
| `test:readonly` | 15 | Bloqueio de apagar/gravar/executar por padrão |
| `test:mentions` | 17 | Conversão de `@nome` em menção real, sem `@everyone`; mensagens do rádio só notificam quem pediu |
| `test:persona` | 17 | Personalidade pessoal × pública, regras de resposta longa |
| `test:panel` | 58 | Senha scrypt, bloqueio, chave por DM, sessões, rotas `/v1/admin/*` (integrações, edição de canais/seguidos, chaves e provedores de IA sem vazar chaves, rádio e logs com segredos mascarados) |
| `test:search` | 56 | Cadeia Brave/Tavily/SearXNG/DuckDuckGo/Bing, cota esgotada, bloqueio leve e descanso, limite por pessoa, conversa sensível sem busca, gate de palavras, `system.info` tolerante, `commands.run` sem shell e com confirmação, skills (só dono, sem ferramentas), otimizador da consulta (sem ferramentas nem histórico, dado pessoal e palavras proibidas barrados antes do buscador), contexto da web reaproveitado entre provedores, teto global por hora e motivo distinto para cada tipo de falha |
| `test:dev` | 61 | Código: workspace sem escapar da pasta, `SEARCH/REPLACE`, política de comandos, laço do agente, projetos, histórico, execução com aprovação (somente leitura, negar, expirar, cancelar, remoto), rotas `/v1/dev/*` e `403` para membros |
| `test:alerts` | 24 | Avisos ao dono: intervalo, teto por hora, máscara de segredos, desligar, chave pela causa-raiz, origem no código da Yui |
| `test:gateway` | 42 | Rodízio de chaves, descanso, erros 401/402/404/429, streaming, privacidade |
| `test:config` | 5 | Chaves Gemini/Stability e modelos aposentados |
| `test:media` | 150 | Tabela de links (YouTube, Instagram, TikTok, Spotify), links recusados, 18 tentativas de injeção de comando, fuzz de caracteres perigosos, argumentos do yt-dlp, limites, pasta por pedido, handlers e `/baixar_musica` com `execFile` falso, teto de downloads simultâneos, limite de anexo, origem do MP3 fora dos textos entregues e nomes de reserva neutros (`musica.mp3`) |
| `test:deezer` | 67 | Classificação de erros, mensagens sem citar a origem, ARL fora de argv/logs, processo filho real com scripts falsos (acentos, login, timeout, módulo ausente), script Python com pacotes falsos, plano B do YouTube, provedores da rádio |
| `test:safefetch` | 24 | Parse do HTML numa worker com prazo, bloqueio de 127.0.0.1, redes privadas, CGNAT, link-local e IPv6, DNS falso, rebinding, redirecionamento, limite de bytes, charset e compressão |
| `test:llmsafety` | 53 | Dado não confiável cercado e não forjável, ferramentas desligadas com contexto da web, conversa sensível, `/chat_resumo` como registro de terceiros, texto de anexo fora do `historico.txt` e dos provedores anônimos, `processQueue` e `generateResponse` reais com dublês, pesquisa pelo agente (linha de progresso no lugar do embed, chave mestra `YUI_RESEARCH_ENABLED`) |
| `test:longreply` | 89 | Divisor (caso dos 74 itens, tokens indivisíveis, propriedade com 150 sementes), envio sequencial, efêmero, falhas e prazo, corte por tokens nos provedores, nova tentativa da edição final (5xx, 404, edição pendurada), plano B com mensagem nova e limpeza do «Processando...», aviso quando as partes 2+ falham |
| `test:context` | 63 | Retenção por idade da fala, usuários isolados, limites, desligado por padrão, escopo dono, reinício e arquivo corrompido, `apagar-tudo`, fila real do `llmHandler` |
| `test:voicerobust` | 68 | Ouvinte de `speaking.start` que nunca propaga exceção, backoff e desligar após falhas, `error` em streams/conexão/player, Opus, disjuntor do rádio, atualização do yt-dlp |
| `test:youtubeengine` | 18 | Detalhes só do que precisa e em lote, falha de um item não perde os outros, pausa com `quotaExceeded` |
| `test:tts-text` | 437 | Markdown, emoji, menções, números por extenso, léxico, divisão em frases, entradas patológicas |
| `test:tts-audio` | 66 | WAV/PCM 48 kHz, provedor falso, SAPI com processo falso, contrato com o `@discordjs/voice` real (a voz real do Windows só é testada se houver uma voz pt-BR) |
| `test:tts-engine` | 151 | Política (quem pode falar, limites, conteúdo proibido, eco) e motor de provedores |
| `test:tts-edge` | 12 | Voz neural da nuvem: escape do SSML, prosódia validada, limites e teto diário, falhas sem vazar texto, abort, e a nuvem só com a chave ligada e texto não sensível |
| `test:tts-azure` | 9 | Azure Speech: validação de região/voz/estilo, SSML escapado, chave só no cabeçalho e nunca em erro, erros por código, teto mensal, abort e lista de vozes |
| `test:tts-output` | 84 | Fila por servidor, interrupção (barge-in), anti-eco, DAVE, `AudioPlayer` real |
| `test:tts-pipeline` | 107 | Texto da IA até o player com provedor falso, sem vazar texto nos logs |
| `test:tts-integration` | 61 | `voice_tts` desligado por padrão e invisível à IA, `initTts` no caminho real de boot, comandos de voz ("Yui, para", "repita depois de mim", sair da call), limite de pedidos, mensagem de entrada, dependências do TTS que falham fechado, anti-eco e barge-in na captura, linha do `/yui-status`, rádio que nunca fala |
| `test:tts-ia` | 68 | `voice_tts` no painel e na lista de ferramentas, guarda de servidor do painel, persona de voz (ordem no prompt, texto de reserva, caminho restrito), fila real com IA e TTS falsos, ferramenta barrada em 8 formatos de resposta, chave do STT fora da URL |
| `test:tts-e2e` | 14 cenários | Voz Maria real do Windows, receptor de voz real do `@discordjs/voice`, `voiceHandler`, fila da IA, `llmHandler` e `AudioPlayer` reais (só o gateway do Discord, a rede, a IA e a transcrição são falsos); confere o texto no chat, os pacotes de áudio, os logs sem texto de ninguém e o isolamento. Modo rápido (13 cenários e a auditoria final); `--full` roda os 48 cenários e a auditoria. Se o PC não tiver a voz pt-BR, ele se pula |
| `test:pendencias` | 36 | `/baixar_video` (playlist, limpeza, vídeo grande), música com aviso neutro do plano B do Deezer, rádio e faxinas, caminhos do deemix, checagem do deemix na inicialização e no painel, auditoria dos testes antigos isolada |
| `test:spotdl` | 105 | Argumentos fixos e lista de flags permitidas, ambiente mínimo (sem segredos, home isolado), `SPOTDL_PATH` e `.venv-spotdl`, classificação das falhas pelo texto, porteiro, disjuntor, encerramento dos filhos, pasta do pedido, tamanho máximo, handler com `execFile` falso e um `spotdl.exe --version` real (só se existir, em pasta temporária) |
| `test:binaries-spotdl` | 11 | Item `spotdl` da checagem opcional da inicialização: achado em `SPOTDL_PATH`, no `.venv-spotdl` e no `PATH`, ausente (`FALTANDO`), pasta no lugar do arquivo, convivência com o deemix, `spotdlOk` no retorno de `validateMediaTools` |
| `test:embedlimits` | 63 | Cortes que não partem emoji, título/descrição/campos/soma de 6000 do embed, `attachment://`, cor e URL inválidas |
| `test:uploadlimit` | 20 | 10 MB por padrão, 50 e 100 MB por nível, `YUI_UPLOAD_LIMIT_MB`, fator 0,95, rótulos em MB e minutos que cabem |
| `test:inputlimits` | 44 | Log do `/chat_resumo` dentro do orçamento (mantém as mensagens mais novas), `isTooLargeError` seguro com streams reais, leitor de linhas SSE cortado em qualquer ponto |
| `test:searchlimits` | 42 | HTML hostil (10 páginas) em menos de 2 s sem travar o laço de eventos, script e style grandes tirados antes do corte (o artigo sobrevive), fila de parse (10 esperando), worker que não sobe, menções limitadas (25 nomes, 10 buscas, 3 s), regex linear, otimizador com a pergunta cortada |
| `test:longreplylimits` | 50 | Plano B do envio (5xx, 10008, 10062), anexo que falha entrega as primeiras partes e avisa o que faltou, `parts` no modo anexo, texto só de espaço, cerca com info string enorme, contexto cortado com marcador, linhas de progresso da pesquisa (no máximo 3 edições, 1,2 s entre elas, sem URL nem menção), progresso junto com falha da edição final e classificação dos erros de envio |
| `test:dbatomic` | 14 | Gravação em temporário e rename, falha antes do rename sem tocar o `.db`, `EPERM` passageiro, plano B, limpeza de sobras, 6 processos mortos em instantes aleatórios com `integrity_check` |
| `test:http413` | 21 | API (64 KB) e Gateway (2 MB): 413 com e sem `Content-Length`, keep-alive, `Connection: close`, HTTP/1.0, cliente que desiste no meio |
| `test:textinputs` | 66 | Anexos `.txt`/`.md`/`.log` (host do CDN, sem redirecionamento, cerco de dado não confiável, sem ferramentas, recusa de fila antes do download, resposta fixa a cada 30 s), limite do `/yui`, texto livre do `+yui perguntar`, uma resposta por pessoa, prefixo de comando e ban, adaptador do prefixo (conversa sensível do dono, `+yui musica` sem erro interno), teto de 9000 do contexto |
| `test:embedpanels` | 64 | Lista de seguindo em várias mensagens, janela da fila do rádio, painel MCP e ajuda com mais de 25 itens, memória sem cortar linha, painel de configuração, ecos de busca, menções do rádio limitadas a quem pediu |
| `test:embedpublish` | 57 | Notícias, diário e semanal com item ruim, versão mínima, 3ª falha seguida do semanal, motivo de ban, lista de bans, ecos de entrada, `os` do Steam |
| `test:audiofit` | 37 | Recompressão a 192, 128 e 96 kbps, prazo e semáforo do ffmpeg, Modo Rádio intacto, `YUI_AUDIO_REENCODE=false`, tags de URL, comentário, sinopse e ID do vídeo tiradas, mensagens sem citar a origem |
| `test:llmlimits` | 69 | Fila (30 no total, 2 por pessoa, voz e rádio fora da conta, comandos de barra simultâneos, conversa espontânea sem aviso, aviso a cada 30 s), prazo da cadeia sem pular o primeiro provedor de nuvem, erro de tamanho sem alerta falso (LM Studio desligado, chave em cooldown e corpo do erro em stream incluídos), stream do LM Studio, provedores anônimos fora de pedido grande e de pedido com anexo, texto de anexo sem ferramentas e fora do `historico.txt`, regex linear em resposta de uma palavra só, comentário da IA que começa com emoji, falha de envio de arquivo explicada, cortes sem partir emoji, pesquisa que não mostra o embed «Executando Ação» |
| `test:interactionlimits` | 56 | `/chat_resumo` com aviso de corte (e sem IA quando não há texto), limite de anexo nos downloads, comentário da IA sem menções, textos de música sem origem, título e motivo cortados |
| `test:searchintent` | 55 | Agente de pesquisa, parte pura: promessa de pesquisa (115 frases do fixture detectadas, 0 falsos positivos em 111 frases comuns e nas respostas reais do `historico.txt`), pedido explícito, pré-rota estrita (29 de 30 pedidos, 0 de 34 conversas comuns, 0 de 17 pedidos de outra ferramenta, 0 de 4 de música e jogo), plano de recuperação e guarda final, e tempo (nenhum detector passa de 50 ms com «yui, » repetido 200 vezes) |
| `test:research` | 70 | Agente de pesquisa: passos, páginas e prazo; resposta final garantida (síntese, nova tentativa estrita, resumo sem IA, motivo de cada falha); limpeza do texto da web (links, domínios soltos, menções, comando de mensagem); dado pessoal e palavra proibida barrados antes do buscador; modo privado; teto global; contrato com o `providers.js` real |
| `test:researchqueue` | 77 | O `llmHandler` real com axios e fetch falsos: promessa que vira pesquisa (o caso real de 14/10), pedido explícito, voz, `search_web` sem argumentos, chamada escrita como texto, ferramenta desligada no servidor, pesquisa privada nos três modos, guarda final, contadores da fila, `YUI_RESEARCH_ENABLED=false` e `YUI_RESEARCH_GUARD=observe` |
| `test:researchentries` | 78 | O mesmo agente fora da fila: `/yui`, `+yui` e app/API (`/v1/chat` e `/v1/agent`), adaptador do `+yui`, privado, uma pesquisa por pessoa e no máximo 2 ao mesmo tempo, entrega parcial, histórico neutro e auditoria sem texto |
| `test:llmprompts` | 44 | Textos de `generate_reply` e `search_web` no `mcp_tools.json`, prompts de pesquisa, JSON de ferramenta por chaves balanceadas, apelidos e argumentos de `search_web`, matriz do portão da pesquisa privada (240 combinações) |
| `test:leftoversfinal` | 40 | Sobras da rodada final: menção em massa no Modo Rádio, prompt de imagem fora do log, aviso «Salvo em disco» do painel, nota neutra de anexo sem «NÃO leu» |
| `test:researchfixes` | 31 | Correções da revisão do agente de pesquisa (parte pura): promessa que fecha uma resposta com conteúdo (só ela sai), promessas informais, voz, JSON de ferramenta cru, link com `@` que virava menção, histórico sem texto da web, filtro de dados e palavras contra os disfarces comuns (800+ frases normais continuam livres), consulta privada reduzida ao pedido, `/yui` sem busca repetida, entrega de texto curto com orçamento |
| `test:researchfixesqueue` | 26 | As mesmas correções no `llmHandler` real: conversa espontânea que chama `search_web`, voz com ferramentas liberadas, DM de qualquer pessoa como privada, JSON cru, chamada escrita como texto com objeto JSON, busca automática do `/yui` com interruptor e `onMeta`, raciocínio fora do log, fila sem consumidor paralelo |
| `test:modlist` | 54 | Lista de mods (Minecraft): detector com 40 mensagens e um corpus de 500+ trechos de texto de verdade, leitura da lista real do dono (71 nomes), correspondência de nomes (erro de digitação, nome colado, falsos conhecidos), escolha do par loader+versão, versão real por mod e "Important Complements" com respostas REAIS do Modrinth, links só de host fixo, texto hostil, limites, prazo com relógio falso, 429, API fora do ar, privado nos três modos de `YUI_PRIVATE_SEARCH`, trava por pessoa e a fila real (menção, DM, `/yui`, `+yui`). Sem rede |
| `test:lists` | 17 | Listas pessoais ("anota na lista X: ...", "mostra", "tira o item 3", "em JSON"): armazenamento por usuário, gravação atômica, limites, pedidos em português, conversa comum não é capturada, entrada hostil |
| `test:docssync` | 14 | `package.json` e scripts, variáveis novas no `.env_example` (comentadas) e no ENVIRONMENT.md, padrões iguais aos do código, links internos dos docs, textos desatualizados que não podem voltar |
| `test:weekly-browser` | 9 | Feed Atom → markdown, fallback de cookies |
| embed semanal | 53 + 23 + 33 | Páginas, limites do Discord, tradução |

## 📝 Observações

- **Sem rede e sem bancos reais:** as suítes novas rodam em pasta temporária (`DATABASE_DIR`), com `execFile`, rede, DNS, Discord e relógio substituídos por dublês. Nenhuma chama o yt-dlp, o deemix, o Deezer, o YouTube ou um buscador de verdade, e nenhuma cria `secrets/search-budget.json`. A única execução real do `spotdl` é o `spotdl.exe --version` do `test:spotdl` (só se o `.venv-spotdl` existir, com ambiente mínimo e HOME falso numa pasta temporária; sem rede e sem baixar nada). Pode rodar com a Yui no ar.
- **Agente de pesquisa:** as sete suítes dele (`test:searchintent`, `test:research`, `test:researchqueue`, `test:researchentries`, `test:llmprompts`, `test:researchfixes` e `test:researchfixesqueue`) rodam sem rede, sem Discord e sem buscador de verdade (axios, fetch, provedores e IA são dublês). As de fila e de entradas definem as variáveis `YUI_RESEARCH_*` e `YUI_PRIVATE_SEARCH` sozinhas, então não dependem do seu `.env` (que pode ter `YUI_RESEARCH_ENABLED=false` ou `YUI_PRIVATE_SEARCH=all`). Pode rodar com a Yui no ar.
- **Testes de tempo:** o fuzz de ReDoS do `test:searchintent` (Q38, nenhuma chamada acima de 300 ms) e a worker do `test:searchlimits` falham se o PC estiver sobrecarregado, por exemplo com várias suítes pesadas ao mesmo tempo (o primeiro chegou a passar de 4 minutos). Rode-os sozinhos.
- **`test:pendencias`:** 35 dos 36 passam. O que falha (`checkOptionalPythonTools`, "o boot não espera mais de 12 s pelo Python") é uma asserção velha: `src/utils/binaries.js` passou a esperar 30 s pelo `--check` do deemix de propósito, porque o 1º import do Python depois de um boot do Windows demora mais de 12 s. Falta ajustar o teste, não o código.
- **`test:readonly`:** os 15 testes passam e o processo termina com código 0. (Antes terminava com uma asserção do libuv, "UV_HANDLE_CLOSING", código 127; o encerramento do teste foi corrigido.)
- **Auditoria:** os testes do Core, da API, do Agent, do modo somente leitura e da busca antes gravavam eventos falsos em `logs/core-audit.jsonl`; agora todos apontam `YUI_AUDIT_FILE` para um arquivo temporário e esse log real não é mais alterado.
- **TTS:** `test:tts-audio` usa a voz real do Windows só se houver uma voz pt-BR instalada (senão marca como ignorado), e só sintetiza na memória, sem tocar som; as demais suítes de TTS não falam nada. Nenhuma delas usa o Discord de verdade: a fala numa call real ainda precisa do [checklist da Operação](docs/content_pt/OPERACAO.md#-11-checklist-da-fala-tts).
- **`tests/test-binaries.js`:** é um roteiro de diagnóstico (mostra onde estão o yt-dlp, o ffmpeg e o Opus), não uma suíte com asserções, e pode baixar ferramentas que faltem. Rode só quando quiser conferir o ambiente.

## 🔍 Testes dos motores do GTA Online

- **GTAO Engine** (`test:gtao`): Van de Armas, Traficantes, Colecionáveis, Desafios Contra o Relógio e evento semanal.
- **Newswire** (`test:newswire`): coleta, tradução PT-BR, detecção de artigos novos, SQLite e uso de RAM do Puppeteer.

Mais em [GTA Online](docs/content_pt/GTA_ONLINE.md).

## 🛠️ Servidor de desenvolvimento

Para testar a API e o app **sem o bot e sem tocar nos dados reais**:

```bash
npm run dev:api -- --fake              # IA simulada, banco e auditoria temporários
npm run dev:api -- --fake --panel      # + login por senha e painel simulados
```

## 🚀 Fluxo recomendado

1. `npm install` e `npm run deploy:commands`.
2. Rode as suítes relacionadas ao que você mudou (`test:core`, `test:panel`, `test:gateway`...).
3. Antes de enviar ao GitHub, rode todas e confira `git status` (não versionar `.env`, chaves `*.pem`, bancos de memória nem logs).

## 📅 Agendamento automático (referência)

| Tarefa | Horário |
|--------|---------|
| Reset diário | 06:00 UTC |
| Limpeza da memória expirada | 05:30 UTC |
| Evento semanal (Reddit) | a cada `GTA_WEEKLY_INTERVAL_MINUTES` |
| Newswire | só com `NEWSWIRE_ENABLED=true` |

Scripts auxiliares (`scripts/*.sh|.bat`) listam e implantam comandos e rodam os testes dos motores.
