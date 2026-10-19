# ✨ Funcionalidades, IA e Processamento de Mídia

A Yui não é apenas um wrapper de chat. Ela é um ecossistema de processamento as síncrono que combina LLMs, difusão de imagens e extração de metadados.

---

## 📂 Sumário

1. [🧠 1. Inteligência Artificial: O Ciclo de Vida do Prompt](#-1-inteligência-artificial-o-ciclo-de-vida-do-prompt)
2. [🎨 2. Geração de Imagens (Hierarquia de Provedores)](#-2-geração-de-imagens-hierarquia-de-provedores)
3. [🎵 3. Processamento de Mídia (Áudio, Vídeo e Compressão)](#-3-processamento-de-mídia-áudio-vídeo-e-compressão)
4. [🎙️ 4. Assistente de Voz & Protocolo DAVE (Calls do Discord)](#-4-assistente-de-voz--protocolo-dave-calls-do-discord)
5. [💾 5. Memória por usuário e contexto por horas](#-5-memória-por-usuário)
6. [💡 Dicas de Uso Avançado](#-dicas-de-uso-avançado)

---

## 🧠 1. Inteligência Artificial: O Ciclo de Vida do Prompt

A Yui processa todas as mensagens de IA através de uma **Fila Global (`processingQueue`)**. A fila comporta 30 pedidos esperando e 2 por pessoa (`YUI_QUEUE_MAX`, `YUI_QUEUE_MAX_PER_USER`); o excedente é recusado com um aviso curto.

### Fluxo de Resposta:

1.  **Captura de Contexto:** A Yui lê as últimas 5 a 10 mensagens do canal (Short-term memory) para garantir coerência. A mensagem respondida e a última do mesmo autor mantêm até 4000 caracteres; as demais, 500 (quando há corte, o texto diz quantos caracteres tinha o original). O bloco de contexto inteiro fica em até 9000 caracteres, descartando as mensagens mais antigas primeiro. Opcionalmente, o [contexto por horas](#-5-memória-por-usuário) lembra as últimas falas de cada pessoa por algumas horas.
2.  **Identificação de Gatilhos:** O bot responde se:
    - For mencionado (`@Yui`).
    - O texto conter a palavra "Yui".
    - Houver uma resposta direta (reply) à mensagem dela.
3.  **Processamento Multimodal:** Se houver uma imagem anexa, ela é enviada junto ao prompt para análise Vision (sujeito à capacidade do modelo configurado). (Ainda não implementado) **Anexos de texto são lidos:** arquivos `.txt`, `.md` e `.log` anexados a uma mensagem que menciona a Yui (até 3 arquivos, 100 KB cada, 12000 caracteres no total, só do CDN do Discord) entram no pedido cercados como **dado não confiável**: instruções escritas dentro do arquivo não são obedecidas. Naquela chamada a IA fica **sem ferramentas** (nada que esteja no arquivo consegue acionar banimento, download, entrada em call etc.), o texto do arquivo não é gravado no `historico.txt` nem enviado a provedores anônimos (Pollinations, Horde), e quem manda anexo e texto na mesma mensagem pode ter de pedir a ferramenta em outra mensagem. É o caminho para textos grandes (o `/yui` aceita até 4000 caracteres). Detalhes em [Variáveis de ambiente](ENVIRONMENT.md#-2-ia-cadeia-de-provedores).
4.  **Parsing de Ferramentas:** A saída da IA é passada por um parser JSON que detecta se ela "decidiu" usar uma ferramenta (Busca Web, Imagem, Música).
5.  **Escolha do provedor:** LM Studio/local → [Yui Gateway](GATEWAY.md) → Gemini → Groq → Hugging Face → Cloudflare, passando ao próximo em caso de erro ou limite. Em conversa sensível (dono em DM, canal privado ou app), provedores anônimos (Pollinations, Horde e Hugging Face sem token) ficam fora da cadeia e nunca recebem a memória.
6.  **Entrega da resposta:** o Discord aceita 2000 caracteres por mensagem. Uma resposta maior é **dividida em várias mensagens**, enviadas uma por vez e na ordem, com o rodapé do modelo só na última. Acima de 4 partes (`YUI_REPLY_MAX_PARTS`) ou 20000 caracteres, vão uma introdução e o texto completo em **anexo `.md`** (`YUI_REPLY_ATTACH_EXT=txt` volta ao `.txt`). Quem é citado no arquivo e não aparece na introdução vai na linha **"Citados no arquivo"**, porque menção dentro de anexo não notifica. Sem a permissão "Anexar arquivos" no canal, a Yui entrega as primeiras partes e avisa quantos caracteres faltaram. Se o provedor corta a resposta no limite de tokens, a Yui pede a continuação ao mesmo provedor (até 2 vezes) e, se ainda ficar incompleta, avisa que foi cortada. Resposta de voz ou de rádio acima de 2000 caracteres é encurtada, não dividida.

### 🔎 Pesquisa na web

Quando alguém pede uma pesquisa ("pesquise o preço do PS5", "dá uma olhada se já saiu o patch") ou a IA anuncia que vai pesquisar, a Yui pesquisa em cadeia (Brave, Tavily, SearXNG, DuckDuckGo, Bing), lê até 2 páginas e responde com o que achou. Quem conduz tudo é o **agente de pesquisa**, um código que não depende de a IA lembrar de chamar a ferramenta, por isso o pedido **sempre termina em uma resposta**:

- **Promessa vira pesquisa.** Antes, a IA às vezes respondia só "Vou pesquisar isso!" e a conversa parava. Agora uma resposta que só promete pesquisar, sem pesquisa nenhuma, é trocada por: a pesquisa de verdade (com o assunto do seu pedido ou da própria promessa); a conversão de moeda, se era uma cotação; a pergunta "Pesquisar o quê?", se não há assunto; uma recusa honesta (voz, conversa privada, ferramenta desligada); ou, em último caso, "Desculpe, tive um erro ao fechar essa resposta. Pode perguntar de novo?", que não é guardado como se fosse uma resposta da Yui. É a guarda de promessa (`YUI_RESEARCH_GUARD`).
- **Resposta final garantida.** Nunca fica em silêncio nem preso em "Processando...". O resultado é a resposta escrita pela IA com as fontes, ou um **resumo com os 3 melhores links** (título e link, sem trecho da página) se a IA não conseguir responder ou o prazo acabar, ou uma **mensagem com o motivo**: nada encontrado, limite de pesquisas, buscadores em descanso ou sem cota, tempo esgotado, dado pessoal na consulta.
- **Fontes e progresso.** A resposta traz a linha **📎 Fontes** (nome do site e link, sem prévia) e o rodapé `🔎 Search · N fontes · Ns`. Os links são colocados pelo código, só com endereços que vieram do buscador, nunca escritos pela IA. Enquanto trabalha, o "Processando..." ganha no máximo 3 linhas ("Pesquisando: «…»", "Tentando de outro jeito", "Lendo 2 páginas", "Escrevendo a resposta"); o embed "Executando Ação" deixou de aparecer na pesquisa.

Pontos de segurança e de custo:

- **Conversa privada** (a DM de qualquer pessoa, o dono em canal privado e o app): **não pesquisa por padrão**, porque a consulta sairia para terceiros. Só `YUI_PRIVATE_SEARCH=owner` ou `all` abre, e então só em pedido explícito, com a consulta feita só do texto da mensagem (sem histórico nem memória), sem dado pessoal, sem provedor anônimo e sem o texto da consulta no log. Detalhes e o aviso sobre os Termos de Uso em [Variáveis de ambiente](ENVIRONMENT.md#-agente-de-pesquisa).
- **Texto da web é dado, não ordem**: entra no prompt cercado por uma marca de "dados externos não confiáveis" e, naquela chamada, a IA fica sem ferramentas. Páginas só são lidas por `http`/`https`, nunca de endereços internos da sua rede, com limite de tamanho e de redirecionamentos, e o HTML é analisado numa worker thread com prazo (`YUI_SEARCH_PARSE_TIMEOUT_MS`, 1,5 s), então uma página hostil não trava a Yui.
- **Limites**: 5 pesquisas por pessoa por hora (o dono também conta, e cada passo da busca gasta uma), teto de 20 por hora somando todo mundo (`YUI_SEARCH_GLOBAL_PER_HOUR`), teto mensal de 900 por provedor com cota gratuita (Brave e Tavily; cada tentativa de provedor conta) e prazo de 12 segundos por busca e de **60 segundos no total**. Até 2 passos de busca (o 2º só se o 1º não achou nada) e 2 páginas lidas. Uma pesquisa por pessoa de cada vez; na fila do Discord uma por vez, e no `/yui`, no `+yui` e no app no máximo 2 ao mesmo tempo. Provedor bloqueado ou sem cota descansa e a cadeia segue para o próximo.
- **Por onde pesquisa:** menção, nome da Yui ou resposta a ela em servidor; DM; `/yui` e `+yui perguntar`; e o app (rotas `/v1/chat` e `/v1/agent`), todos com o mesmo agente e os mesmos limites. A DM de qualquer pessoa, os canais privados do dono e o app são conversa privada para a pesquisa e dependem do `YUI_PRIVATE_SEARCH` (o resto da DM de um membro, como memória e provedores, segue como numa conversa de servidor). No app, pedido sobre arquivos, pastas, projetos ou programas do seu computador ("pesquise o arquivo X") é das ferramentas locais e nunca vai à web.
- **O que NÃO pesquisa:** por voz (a Yui responde "Por voz eu não pesquiso na web. Pede no chat de texto."), no Modo Rádio, no `/chat_resumo`, em conversa espontânea sem ter sido chamada (nem gasta a cota de ninguém), em conversa privada com `YUI_PRIVATE_SEARCH=off` ("Não pesquiso na web numa conversa privada."), com a ferramenta `search_web` desligada no servidor ("A pesquisa na web está desativada neste servidor."), com dado pessoal ou palavra proibida na consulta (a Yui pede para reescrever) e em pedido negado ("não pesquise"), pergunta de capacidade ("você consegue pesquisar?") ou "como pesquisar...". A pesquisa automática sem verbo (só porque a pergunta fala de dado atual) está desligada nas menções e na DM; o `/yui` mantém a busca automática antiga.
- **Pré-rota (desligada por padrão):** com `YUI_RESEARCH_PRE_ROUTE=true`, o pedido explícito e estrito pesquisa direto, sem esperar a primeira resposta da IA. Veja "Como ligar aos poucos" em [Variáveis de ambiente](ENVIRONMENT.md#-agente-de-pesquisa).
- Configuração em [Variáveis de ambiente](ENVIRONMENT.md#-pesquisa-na-web) e [Comandos e skills](COMANDOS_E_SKILLS.md#-4-busca-na-web).

### 🧩 Lista de mods (Minecraft)

Mandou 5 ou mais linhas de nomes de mods (na menção, na DM, no `/yui` ou no `+yui perguntar`) pedindo os links ou o download? O **código**, e não a IA, procura cada nome na API pública do Modrinth, descobre em qual **loader e versão do Minecraft** os mods achados existem juntos (por exemplo Forge 1.20.1) e devolve a lista numerada com o link do mod e o da versão certa. Se um mod precisa de outro para funcionar, a dependência obrigatória aparece à frente dele entre parênteses: **(Important Complements: ...)**. Erro de digitação sai com "achei como X, confira"; o que não existe no Modrinth ganha um link de busca (Modrinth e CurseForge) marcado como busca, nunca um link inventado. Para fixar a combinação, escreva na mensagem `Forge 1.20.1` ou `fabric 1.21`. Listas longas saem em várias mensagens ou em anexo `.md`. Variáveis e limites em [Lista de mods](ENVIRONMENT.md#-lista-de-mods-minecraft).

---

## 🎨 2. Geração de Imagens (Hierarquia de Provedores)

A Yui possui um motor de fallback agressivo para garantir que o usuário receba sua arte, mesmo que as APIs principais falhem.

**Ordem de Execução:**

1.  **Stability AI (Ultra/Core):** Se houver uma `STABILITY_API_KEY`. Qualidade fotorealista.
2.  **Gradio/SDXL-Flash:** Fallback gratuito de alta velocidade.
3.  **HuggingFace (FLUX.1):** Modelos SOTA rodando em endpoints de inferência.
4.  **Stable Horde:** Rede descentralizada de GPUs (uso sob demanda).
5.  **Pollinations:** O fallback definitivo para 100% de disponibilidade.

---

## 🎵 3. Processamento de Mídia (Áudio, Vídeo e Compressão)

Implementamos um sistema completo de download e manipulação de mídia via `youtubeAudioHandler.js`.

- **Suporte Multplataforma:** O bot suporta download de áudio e vídeo de plataformas populares, como YouTube (geral para áudio, apenas Shorts para vídeo), Instagram Reels e TikTok (incluindo subdomínios como `vt.tiktok.com`).
- **Download Inteligente de Áudio:** Extração apenas do melhor stream de áudio (`bestaudio`) via `yt-dlp` e conversão dinâmica com `ffmpeg` para MP3.
- **Links validados (sem injeção de comando):** o link é parseado, o host é conferido numa lista de plataformas permitidas e a URL é reconstruída a partir do ID do vídeo; só ela chega ao `yt-dlp`, que roda sem shell, com tempo limite e janela oculta. Mensagens de erro ao usuário são curtas; o detalhe vai para o log.
- **Playlist:** link com vídeo e playlist baixa **só o vídeo**; playlist pura (ou perfil/coleção do TikTok) baixa **só o primeiro item**; a Yui avisa numa linha discreta. No Spotify só vale link de faixa, baixada pelo `spotdl` (ambiente `.venv-spotdl`; veja [Variáveis de ambiente](ENVIRONMENT.md#-spotify-ambiente-python-do-spotdl)).
- **Limites:** duração máxima de 20 min (`YUI_DL_MAX_MINUTES`), 200 MB (`YUI_DL_MAX_FILESIZE_MB`) e 5 min por execução (`YUI_DL_TIMEOUT_SECONDS`); ao vivo é recusado. O Modo Rádio e o Spotify não têm o limite de duração.
- **Pasta própria por pedido:** cada download grava numa subpasta única (`temp_audio`, `temp_videos`, `temp_spotify`), apagada depois do envio; uma faxina periódica remove as esquecidas.
- **Motor de Música Deezer HQ (100% Deezer):** Módulo dedicado (`deezerMusicService.js` / `deezerMusicHandler.js`) para buscar e baixar áudios de estúdio em altíssima qualidade (HQ MP3 / 320kbps) via `deemix`. Possui algoritmo de fidelidade por palavras-chave e exibe um menu interativo de seleção de 5 opções quando a busca for ambígua. Só faixas (ID ou link `deezer.com/track`) são aceitas. Se o `deemix` falhar, a Yui baixa do YouTube e **avisa só que a qualidade pode ser menor** (sem dizer de onde veio o arquivo). Todos os arquivos MP3 são temporários e removidos do disco imediatamente após o envio. O `deemix` roda num ambiente Python próprio (veja [Primeiros passos](GET_STARTED.md)).
- **Download de Vídeo com Metadados:** Ao baixar vídeos, a Yui pode extrair o uploader original e a descrição para exibição rica no chat, configurável via parâmetro.
- **Compressão Inteligente:** Se o arquivo de vídeo ultrapassar o limite de upload do servidor (detectado dinamicamente: 10MB para padrão, 50MB para Boost Nível 2 e 100MB para Boost Nível 3, já com 5% de folga; `YUI_UPLOAD_LIMIT_MB` muda a base), o usuário recebe a opção de iniciar a compressão.
- **Fila Global & Proteção da Host:** O processo de compressão FFMPEG roda em uma fila global (apenas uma compressão simultânea) para preservar os recursos do computador onde a Yui roda. Há um monitor de RAM ativo: se o uso de memória passar de 95%, a compressão é cancelada imediatamente para evitar travamento do servidor.
- **Limitação de Uso:** Há uma limitação estrita de 1 download/processo ativo por usuário ao mesmo tempo e um teto de 3 downloads simultâneos no total (`YUI_DL_MAX_CONCURRENT`; o dono não é barrado), para evitar sobrecarga.
- **MP3 maior que o limite de anexo é recomprimido:** o servidor aceita 10 MB por anexo. Um MP3 acima disso é recomprimido com o ffmpeg a 192, 128 e 96 kbps, nessa ordem, até caber (cerca de 6 min 55 s a 192 kbps e 13 min a 96 kbps). Nunca no Modo Rádio, que toca o arquivo local e não o envia. `YUI_AUDIO_REENCODE=false` desliga: o arquivo grande vira só um aviso de que passou do limite.
- **A origem do MP3 não aparece:** nada que o usuário recebe na entrega diz se o arquivo veio do Deezer, do YouTube ou do Spotify, e as tags de URL e de comentário do MP3 são tiradas (título, artista e álbum ficam). A origem fica só nos logs.
- **Cleanup Automático:** Todos os arquivos temporários são deletados após o envio. Vídeos grandes que aguardam compressão expiram após 6 horas.

---

## 🎙️ 4. Assistente de Voz & Protocolo DAVE (Calls do Discord)

O ecossistema de voz da Yui permite que ela participe de chamadas de voz e atenda comandos dos usuários em tempo real.

- **Conexão Nativa com Protocolo DAVE (E2EE)**: Utiliza a versão mais recente do `@discordjs/voice` com suporte nativo ao protocolo de criptografia ponta a ponta do Discord (DAVE protocol version 1).
- **Filtro de Energia Corporal de Áudio (PCM RMS)**: Analisa a energia do sinal PCM do fluxo de áudio recebido. Áudios com RMS < 250 ou de membros mutados são descartados automaticamente para evitar uso desnecessário de cotas das APIs de STT.
- **Dicionário STT & Matcher Fonético de 75+ Variações**: Incorpora injeção de prompt no Whisper ("Yui") aliado a um sistema de expressões regulares que identifica 75+ grafias e fonemas derivados de sotaques ou ruídos (ex: "Ricardo", "Hicari", "Icari", "Ficari", "Vicari", "Ih cari").
- **Ferramenta Unificada MCP (Assistente de Voz)**: O controle de chamada (`join_voice_call` e `leave_voice_call`) é integrado e gerenciado como um único item unificado no comando `/yui-ferramentas`.
- **Desconexão por Inatividade**: Quando todos os usuários humanos deixam o canal de voz, a Yui se desconecta automaticamente preservando conexões do servidor.
- **Robustez**: o ouvinte de fala nunca derruba o bot. A falha de uma pessoa é registrada uma vez e ela fica 60 s em espera; após 5 falhas seguidas a escuta da sessão desliga com aviso no canal (`/entrar-call` religa). Erros de stream, conexão e player têm tratamento próprio. O Modo Rádio para sozinho, com aviso, se o ambiente de áudio estiver quebrado (2 falhas seguidas) ou se 5 faixas seguidas não tocarem.
- **Opus obrigatório**: sem o codificador Opus, entrar na call e o Modo Rádio são recusados com um aviso claro e o dono recebe uma DM. A checagem aparece no log da inicialização.
- **Fala da Yui na call (TTS local)**: o módulo `src/services/tts/` usa a voz do Windows (SAPI) em pt-BR, sem rede e sem custo. Ele normaliza o texto para fala (números, siglas, Markdown, links), fala no máximo 3 frases curtas (o resto fica no chat, com frases fixas como "O resto está no chat"), tem fila e limites por pessoa, servidor e total, para de falar quando alguém fala por cima (barge-in) e descarta o áudio captado em volta da própria fala (anti-eco). **Nunca fala** conversa privada ou sensível, dados pessoais, palavras bloqueadas, JSON de ferramenta, frases que alguém mandou repetir, nem com o Modo Rádio ligado; por voz a Yui só conversa (sem ferramentas, a menos que `YUI_VOICE_TOOLS=true`). As regras de estilo da resposta falada ficam em `persona/yui-voz.md`. Variáveis em [Variáveis de ambiente](ENVIRONMENT.md#-fala-da-yui-na-call-tts-local); passo a passo em [TTS](TTS.md).
  - **Como funciona na prática:** é um interruptor **por servidor, desligado por padrão** (**🔊 Resposta por Voz (TTS)** em `/yui-ferramentas`, além do **🎙️ Assistente de Voz (Call)**). Quem chama a Yui por voz ("Yui, ..." logo no começo da frase) recebe a resposta **primeiro em texto no chat e depois falada**. Quem fez o pedido pode falar por cima para interrompê-la, e "Yui, para" também funciona quando não se sobrepõe à voz dela. Por voz a Yui só conversa: ferramentas (baixar, buscar, gerar imagem) são descartadas e viram "Isso eu faço só pelo chat."; "Yui, sai da call" é um comando fixo que continua valendo. O pedido de voz usa só contexto público (sem memória pessoal, sem histórico de texto, sem gravar nada) e a transcrição não vai ao `historico.txt`. Antes de gastar a IA há limites de 1 pedido a cada 6 s por pessoa e fila curta por servidor.
  - **Estado:** ligada ao bot (iniciada junto com o login em `src/discord/client.js`; o serviço antigo `ttsService`, do Gemini, foi removido) e coberta por 974 verificações automáticas offline (`npm run test:tts`). **Falta o primeiro teste numa call real**, com o checklist da [Operação](OPERACAO.md#-11-checklist-da-fala-tts). Piper (voz neural local) e Edge (nuvem) ficaram para depois.

---

## 💾 5. Memória por usuário

A Yui lembra de preferências, nome e anotações de cada pessoa, em bancos **separados** por escopo:

- **Pública (Discord):** guarda por **30 dias sem interação** (`MEMORY_RETENTION_DAYS`) e é limpa todo dia às 05:30 UTC. Entra no contexto como "o que você sabe sobre este usuário".
- **Pessoal (dono):** permanente, usada só em DM e canais privados, nunca em canais públicos.
- **Captura automática:** frases como "me chama de X" ou "lembra que eu gosto de Y" são salvas sem duplicar.
- **Controle do usuário:** `/yui-memoria` (ver, lembrar, esquecer, apagar tudo). O dono administra pelo `/yui-criador memorias` ou pelo app, **sem ver o conteúdo**.

### Contexto das conversas por horas (opcional)

Além da memória (fatos sobre você), a Yui pode lembrar **as últimas falas da conversa** por algumas horas, para continuar um assunto sem você repetir tudo. O recurso é **desligado por padrão** (`YUI_CONTEXT_ENABLED=false`); desligado, nada é lido nem gravado e o banco nem é aberto.

- **Escopo:** por padrão só o dono (`YUI_CONTEXT_SCOPE=owner`); `all` liga para todos (faça só depois de avisar nos Termos de Uso).
- **Um fio por pessoa em cada canal:** em DM, um fio por pessoa; em servidor, um fio por pessoa e canal. Ninguém lê o fio do outro.
- **Prazo por idade de cada fala:** 6 horas por padrão (1 a 48 em `YUI_CONTEXT_TTL_HOURS`), no máximo 20 falas e 6000 caracteres (`YUI_CONTEXT_MAX_TURNS`, `YUI_CONTEXT_MAX_CHARS`). Uma limpeza horária apaga o que venceu.
- **Bancos separados:** `database/memory-context.db` (público) e `database/memory-context-personal.db` (dono em DM ou canal privado). Ambos ficam fora do Git (`database/memory-*.db`).
- **O que grava:** só a fala do próprio autor e a resposta entregue. Não guarda respostas com busca na web nem JSON de ferramenta, e ferramentas gravam só uma frase curta fixa. Falas espontâneas, `/chat_resumo`, voz e rádio não leem nem gravam.
- **Apagar:** `/yui-memoria apagar-tudo` apaga os fios da pessoa, em todos os canais. O `historico.txt` (registro de uso do bot) não é apagado por esse comando.

## 🧭 6. Yui Gateway (servidor de IA)

Entre o LM Studio e os provedores de nuvem há um roteador próprio: tenta Groq, Gemini, Hugging Face, OpenRouter, Cloudflare, Together e Pollinations com **failover**, **rodízio de chaves** e **descanso progressivo** de provedores com erro. Conversas sensíveis nunca vão a provedores anônimos. Também pode ser usado por outros apps como um servidor compatível com OpenAI em `127.0.0.1:20130`. Veja [Gateway](GATEWAY.md).

## 🧑‍💼 7. Assistente pessoal, API e app

Para o dono, a Yui também é uma assistente: personalidade própria em DM/canais privados, **Agent** com ferramentas do PC (em **modo somente leitura**: não apaga, grava, move nem executa programas), **API** local e **app** (Android e web) com chat, memória e painel de administração, protegidos por senha ou chave de uso único enviada por DM. Veja [Assistente pessoal](ASSISTENTE_PESSOAL.md) e [Yui API](YUI_API.md).

## 🎮 8. GTA Online

Reset diário, evento semanal do Reddit (lido por um navegador real, traduzido e com embed paginado), notícias da Rockstar e dados técnicos de veículos/armas injetados no `/yui`. Veja [GTA Online](GTA_ONLINE.md).

## 🏷️ 9. Menções reais

Quando a Yui cita alguém (por exemplo `@usuario`), a menção é resolvida para uma menção de verdade no Discord, limitada a membros do servidor e **sem** `@everyone`/`@here`.

---

## 💡 Dicas de Uso Avançado

- 💡 **Resumo de Chat (`/chat_resumo`):** A IA lê as últimas N mensagens (até 20000 caracteres no total; se for preciso cortar, o resumo abre avisando quantas entraram) e cria um mapeamento semântico de quem falou o que e sobre quais tópicos. Excelente para gerenciar canais movimentados.
- 💡 **Trace.moe Integration:** A função `/anime_origem` permite que você encontre animes apenas enviando um frame. Ela retorna o título, episódio e o timestamp aproximado.
- 💡 **Busca de Jogos e Preços da Steam:** A Yui não apenas busca links Magnéticos em bases de dados, mas também pode consultar nativamente a **Steam**! Basta perguntar naturalmente como "O Elden Ring está em promoção na Steam?" e ela retornará dados atualizados, preços e sinopse, além de fazer um comentário divertido.
- 💡 **Conversor de Moedas e Cripto:** Converta qualquer valor entre moedas reais (BRL, USD, EUR) ou cripto (BTC, ETH) apenas perguntando "quanto tá o bitcoin hoje?". Ela usa APIs financeiras com cache local de expiração diária e fallback automático.
- 💡 **Visão Computacional e Edição:** A Yui possui regras claras avisando que ela não realiza edições de imagens existentes e não possui visão computacional nativa em tempo real.

---

> [!TIP]
> Para ver a lista completa de comandos e explicações detalhadas, veja o [Guia de Comandos](./COMMANDS.md).

---

[🏠 Voltar ao Menu Principal](../README.md)
