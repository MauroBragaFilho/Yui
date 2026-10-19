# 🔑 Variáveis de ambiente (`.env`)

Referência de todas as variáveis que a Yui lê. O arquivo `.env` fica na raiz do projeto, **nunca vai para o Git** e é lido na inicialização (reinicie a Yui após mudar). Só `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` e `OWNER_ID` são obrigatórias; o resto liga recursos opcionais.

---

## 📂 Sumário

1. [Discord e governança](#-1-discord-e-governança)
2. [IA: cadeia de provedores](#-2-ia-cadeia-de-provedores)
3. [Imagens, busca e fala](#-3-imagens-busca-e-fala)
4. [Música e mídia](#-4-música-e-mídia)
5. [GTA Online, Reddit e avisos](#-5-gta-online-reddit-e-avisos)
6. [Yui Core: memória, API e painel](#-6-yui-core-memória-api-e-painel)
7. [Yui Core: Agent e ferramentas do PC](#-7-yui-core-agent-e-ferramentas-do-pc)
8. [Yui Gateway](#-8-yui-gateway)
9. [Yui Core: Código](#-9-yui-core-código)
10. [Chaves antigas ignoradas](#-10-chaves-antigas-ignoradas)

---

## 🌐 1. Discord e governança

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `DISCORD_TOKEN` | Token do bot ([Developer Portal](https://discord.com/developers/applications)) | **obrigatória** |
| `DISCORD_CLIENT_ID` | ID da aplicação | **obrigatória** |
| `DISCORD_GUILD_ID` | Se definido, registra os slash commands só nesse servidor (aparecem na hora, bom para testes) | global |
| `OWNER_ID` | ID do Discord do dono (o primeiro é o "dono primário") | — |
| `OWNER_IDS` | Lista de donos adicionais, separados por vírgula | — |
| `REQUIRE_TOS` | `true` exige que cada servidor aceite os termos antes de usar a Yui | `false` |
| `COMMAND_PREFIX` | Prefixo de comandos de texto | `+yui` |
| `DATABASE_DIR` | Pasta dos bancos SQLite | `database` |
| `LOG_LEVEL` | `debug`, `info`, `warn` ou `error` | `info` |
| `NODE_ENV` | Aparece no `/yui-status` | — |

> 💡 O dono pode ter mais de um ID; garanta que o **primeiro** em `OWNER_ID` seja o seu.

---

## 🤖 2. IA: cadeia de provedores

A Yui tenta os provedores em ordem: **LM Studio/local → Yui Gateway → Gemini → Groq → Hugging Face → Cloudflare**, passando ao próximo em caso de erro ou limite. Um provedor sem chave é pulado.

| Variável | Descrição |
|----------|-----------|
| `LOCAL_LLM_URL` | Endpoint do LM Studio/Ollama (ex.: `http://localhost:1234/v1/chat/completions`) |
| `LOCAL_LLM_MODEL` | Modelo local |
| `LM_STUDIO_API_KEY` | Chave do servidor local (se exigir) |
| `GEMINI_API_KEYS` / `GEMINI_API_KEY` | Uma ou várias chaves separadas por vírgula (rodízio). Ambos os nomes funcionam e são somados. [Google AI Studio](https://aistudio.google.com/app/apikey) |
| `GEMINI_MODEL` | Modelo principal (use `gemini-flash-lite-latest` ou `gemini-flash-latest`) |
| `GEMINI_MODEL_FALLBACK` | Modelo reserva |
| `GEMINI_URL` | URL compatível com OpenAI do Gemini |
| `GROQ_API_KEY`, `GROQ_API_URL`, `GROQ_MODEL` | Groq ([console](https://console.groq.com/keys)) |
| `HF_TOKEN`, `HF_API_URL`, `HF_MODEL` | Hugging Face ([tokens](https://huggingface.co/settings/tokens)) |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_MODEL` | Workers AI (precisa dos dois primeiros) |
| `TOGETHER_API_KEY` | Together AI |
| `AI_BOT_NAME` | Nome que a IA usa para si |
| `AI_SYSTEM_PROMPT` | Prompt de sistema padrão |
| `AI_KNOWLEDGE_DIR` | Pasta com a base de conhecimento (`.docs`/`knowledge`) |
| `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`, `AI_MAX_TOKENS` | Provedor compatível com OpenAI configurável do Core |
| `AI_BACKEND` | Backend do AI Manager: `legacy-chain` (padrão), `openai-compatible` ou `gateway` |
| `AI_BASE_LOCAL` | Endpoint local alternativo para conversas privadas |
| `AI_PRIVATE_LOCAL_ONLY` | `true` obriga conversas privadas a usar só o modelo local. **Vale só no app/API** (AI Manager, com memória pessoal em jogo). No Discord (o dono em DM ou em canal privado) a conversa segue a cadeia normal de provedores, só sem os anônimos (Pollinations e Horde): essa variável não fecha a nuvem lá |
| `YUI_REPLY_MAX_PARTS` | Máximo de mensagens por resposta longa (1 a 10; fora disso vale o padrão). Acima disso, a resposta vai em uma introdução mais o texto completo em anexo `.md`. Padrão `4` |
| `YUI_REPLY_ATTACH_EXT` | Extensão do anexo com a resposta completa: `md` (padrão; o Discord mostra a prévia já formatada, com título, negrito e código) ou `txt` (texto cru) |
| `YUI_REPLY_MAX_TOKENS` | Força o limite de tokens de saída de todos os provedores (64 a 8192; o Horde fica em até 512). Vazio = cada provedor usa o seu (o painel ainda ajusta depois) |
| `YUI_QUEUE_MAX` / `YUI_QUEUE_MAX_PER_USER` | Pedidos esperando na fila da IA: no total (1 a 1000) e por pessoa (1 a 100). Acima disso o pedido é recusado com um aviso curto (nas menções, no máximo 1 aviso a cada 30 s por pessoa). Voz e Modo Rádio têm limitador próprio e ficam fora. Padrão `30` / `2` |
| `YUI_AI_DEADLINE_SECONDS` | Prazo total da cadeia de provedores, em segundos (0,1 a 3600). Só vale **entre** um provedor e o próximo (nunca corta uma resposta em andamento) e nunca pula o primeiro provedor que não seja o local, para um LM Studio lento não fazer a nuvem ser ignorada. Padrão `240` |
| `YUI_HISTORY_MAX_CHANNELS` | Quantas conversas o histórico curto (só em RAM) guarda ao mesmo tempo (10 a 100000); passando disso as mais antigas saem. Padrão `500` |
| `YUI_ASK_MAX_CHARS` | Tamanho máximo da pergunta do `/yui` e do `+yui perguntar`, em caracteres (100 a 20000). Acima disso a Yui recusa e sugere mandar o texto como mensagem normal, mencionando-a, com um anexo `.txt` ou `.md`. Padrão `4000` |
| `YUI_SUMMARY_MAX_CHARS` / `YUI_SUMMARY_PER_MESSAGE` | `/chat_resumo`: teto do log enviado à IA (1000 a 200000 caracteres) e corte de cada mensagem (50 a 4000, início e fim). As mensagens mais novas têm prioridade e o resumo avisa quando houve corte. Padrão `20000` / `600` |
| `YUI_READ_TEXT_ATTACHMENTS` | `false`, `0` ou `off` desliga a leitura de anexos `.txt`, `.md` e `.log` (veja abaixo). Padrão ligado |
| `YUI_ATTACH_TEXT_MAX_KB` | Tamanho máximo de cada anexo de texto lido, em KB (1 a 1024). Padrão `100` |
| `YUI_ATTACH_TEXT_MAX_CHARS` | Caracteres lidos por mensagem, somando os arquivos (500 a 50000); passou disso, ficam o início e o fim. Padrão `12000` |

Modelos aposentados (por exemplo `gemini-2.0-*`, `gemini-1.5-*`) são trocados automaticamente pelos atuais.

> 💡 **Respostas longas:** o Discord aceita 2000 caracteres por mensagem. A Yui divide o texto em partes, preferindo cortar entre parágrafos, linhas ou frases (e evitando partir palavra, emoji, link ou bloco de código), manda uma por vez e põe o rodapé com o modelo só na última. Passando de `YUI_REPLY_MAX_PARTS` partes ou de 20000 caracteres, ela manda uma introdução e o texto inteiro em anexo (`resposta-yui.md`; com `YUI_REPLY_ATTACH_EXT=txt` vira `.txt`). Menção dentro de anexo não notifica ninguém, então quem é citado no arquivo e não aparece na introdução vai numa linha **"Citados no arquivo"** da mensagem. Se o canal não deixa anexar arquivos (falta a permissão "Anexar arquivos"), a Yui entrega as primeiras partes como mensagens e termina avisando quantos caracteres faltaram. Se o provedor corta a resposta no limite de tokens, a Yui pede a continuação ao mesmo provedor (no máximo 2 vezes) e, se ainda ficar incompleta, termina avisando que foi cortada.

> 📎 **Anexos de texto (`.txt`, `.md`, `.log`):** para um texto grande, mande uma **mensagem normal que mencione a Yui** com o arquivo anexado (os comandos de barra não leem anexo). As regras:
>
> - Só lê de `cdn.discordapp.com` e `media.discordapp.net` (o endereço é conferido **antes** de baixar), sem seguir redirecionamento e nunca de endereço interno. No máximo **3 arquivos** por mensagem, **100 KB** cada (`YUI_ATTACH_TEXT_MAX_KB`) e **12000 caracteres** no total (`YUI_ATTACH_TEXT_MAX_CHARS`); passou disso, ficam o início e o fim e o cabeçalho do trecho avisa o corte.
> - O conteúdo entra no pedido **cercado como dado não confiável** (a mesma marca do texto da web): instruções escritas dentro do arquivo não são obedecidas. A busca na web e o AutoMod por palavras olham só o que a pessoa digitou, nunca o conteúdo do arquivo.
> - Quando um arquivo é **lido**, aquela chamada roda **sem ferramentas** (a IA só responde com texto: nada do arquivo aciona banimento, download, entrada em call etc.), o texto do arquivo **não é gravado** no `historico.txt` nem entra no alerta de conteúdo suspeito, e o pedido **não vai a provedores anônimos** (Pollinations, Horde). Para pedir uma ferramenta, mande o pedido em outra mensagem, sem o arquivo.
> - Mensagem **só com anexo** que a Yui não pôde ler (ou mensagem vazia) recebe uma resposta fixa, no máximo **uma a cada 30 s por pessoa**. Com a fila cheia ou com a pessoa já no limite de pedidos, o anexo nem é baixado.
> - Arquivo grande demais, binário, vazio ou que falha ao baixar não é lido. A Yui avisa em uma frase o que não leu e não inventa o conteúdo; se a mensagem só tem o anexo e nada pôde ser lido, ela responde com uma frase fixa que explica o motivo.
> - `YUI_READ_TEXT_ATTACHMENTS=false` desliga a leitura.
>
> 🚦 **Fila de pedidos:** a IA responde um pedido por vez. Cada pessoa pode ter até `YUI_QUEUE_MAX_PER_USER` pedidos esperando e a fila comporta `YUI_QUEUE_MAX`; o excedente é recusado com um aviso curto. O `/yui` e o `+yui perguntar` também aceitam uma resposta por pessoa por vez.

---

## 🎨 3. Imagens, busca e fala

| Variável | Descrição |
|----------|-----------|
| `STABILITY_API_KEYS` / `STABILITY_API_KEY` | Chaves do Stability AI (rodízio; ambos os nomes valem). [Platform](https://platform.stability.ai/account/keys) |
| `HORDE_API_KEY`, `HORDE_IMAGE_API_KEY`, `HORDE_URL` | AI Horde (`0000000000` = anônimo). [Registro](https://aihorde.net/register) |
| `RAWG_API_KEY` | Informações de jogos |
| `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE`, `GEMINI_TTS_INSTRUCTIONS` | **Aposentadas:** o TTS agora é local e nenhum código as lê mais (o serviço `ttsService` do Gemini foi removido). Pode apagar do `.env`. A fala local está na tabela de TTS abaixo |
| `HF_STT_URL`, `OPENAI_STT_URL`, `OPENAI_STT_KEY`, `OPENAI_API_KEY`, `LOCAL_STT_URL`, `WHISPER_LOCAL_URL`, `WITAI_TOKEN` (ou `WIT_AI_KEY`) | Provedores de transcrição de voz (usam também `GROQ_API_KEY`, `GEMINI_API_KEY` e `HF_TOKEN`) |

### 🔎 Pesquisa na web

Os provedores são tentados em cadeia e o primeiro que responder vence. Provedor sem chave ou sem endereço é pulado. Detalhes de uso em [Comandos e skills](COMANDOS_E_SKILLS.md#-4-busca-na-web).

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `BRAVE_API_KEY` | [Brave Search API](https://api.search.brave.com/app/dashboard). Os termos da Brave proíbem guardar os resultados, então eles nunca vão para o cache | — |
| `TAVILY_API_KEY` | Tavily (plano gratuito mensal) | — |
| `SEARXNG_URL` | Servidor SearXNG próprio (sem chave); precisa começar com `http://` ou `https://` | — |
| `YUI_SEARCH_PROVIDERS` | Ordem e conjunto dos provedores. Recomendado: `tavily,brave,duckduckgo,bing` | `brave,tavily,searxng,duckduckgo,bing` |
| `YUI_SEARCH_USER_PER_HOUR` | Pesquisas por pessoa a cada hora (`0` = sem limite). O dono também conta | `5` |
| `YUI_SEARCH_GLOBAL_PER_HOUR` | Teto de pesquisas por hora **somando todo mundo** (o dono também conta; `0` = sem teto), numa janela deslizante de 1 hora que zera no reinício. É o freio contra abuso e contra gastar a cota mensal, e vale até quando o limite por pessoa é `0`. Esgotou, a pesquisa é recusada sem chamar nenhum buscador. **Risco conhecido:** como o dono também conta, poucas contas (por exemplo 4 pessoas com 5 pesquisas cada) esgotam o teto e a pesquisa fica indisponível para todos, inclusive o dono, por até 1 hora; uma pesquisa sem resultado custa 2 unidades. Ajuste este valor e o `YUI_SEARCH_USER_PER_HOUR` ao tamanho do seu servidor | `20` |
| `YUI_SEARCH_MONTHLY_CAP_TAVILY` / `YUI_SEARCH_MONTHLY_CAP_BRAVE` | Teto mensal de pesquisas por provedor com cota gratuita (`0` = sem teto). O contador sobrevive a reinícios | `900` cada |
| `YUI_SEARCH_BUDGET_FILE` | Onde fica o contador mensal | `secrets/search-budget.json` |
| `YUI_SEARCH_DEADLINE_MS` | Prazo total de uma pesquisa, em milissegundos (500 a 120000) | `12000` |
| `YUI_SEARCH_CACHE_TTL_MIN` | Guarda o resultado de pesquisas repetidas por N minutos (`0` = desligado) | `0` |
| `YUI_SEARCH_PARSE_TIMEOUT_MS` | Prazo para analisar o HTML de cada página lida, em milissegundos (20 a 30000). A análise roda numa worker thread: estourou o prazo, a worker é encerrada e a página vira "sem conteúdo" (vale o resumo da busca) | `1500` |
| `YUI_SEARCH_MAX_HTML_TAGS` | Aberturas de tag que entram na análise; o resto do HTML é descartado | `20000` |
| `YUI_SEARCH_MAX_HTML_CHARS` | Caracteres de HTML de cada página antes da análise (os blocos `<script>` e `<style>` são tirados ANTES de contar, então um script embutido gigante não apaga o artigo) | `300000` |

> ⚠️ **Não escreva texto-modelo na chave** (por exemplo `BRAVE_API_KEY=opcional`). Chave com menos de 10 caracteres é ignorada pela busca e o painel mostra "ignorada"; deixe a linha comentada ou vazia enquanto não tiver a chave.
>
> 🔒 **Conversa privada ou sensível não pesquisa na web por padrão** (a consulta sairia para terceiros); só o `YUI_PRIVATE_SEARCH` muda isso, com proteções próprias (veja [Agente de pesquisa](#-agente-de-pesquisa)). O texto que volta da web entra no prompt marcado como dado não confiável, cercado por uma marca de abertura e de fechamento, e na mesma chamada a IA fica sem ferramentas, para uma página não conseguir dar ordens à Yui. As páginas são lidas só por `http`/`https`, nunca de endereços internos (`localhost`, rede local, IP privado), com limite de tamanho e de redirecionamentos, e o HTML é analisado numa worker thread com prazo, para uma página hostil não travar a Yui.

### 🧠 Agente de pesquisa

Antes, a IA às vezes respondia só "Vou pesquisar isso!" e a conversa parava ali, porque ela escrevia a promessa em vez de chamar a ferramenta de busca. Agora o **código**, e não o modelo, cuida da pesquisa do começo ao fim, e todo pedido termina em uma **resposta com fontes**, em um **resumo com links** (sem IA) ou em uma **mensagem com o motivo**. O passo a passo está em [Recursos](FEATURES.md#-pesquisa-na-web); aqui ficam as variáveis, a privacidade e como ligar aos poucos. Todas são opcionais e valem os padrões do código; reinicie a Yui depois de editar o `.env`.

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `YUI_RESEARCH_ENABLED` | **Chave mestra.** `false` volta ao jeito antigo da ferramenta `search_web` (embed "Executando Ação" e uma resposta simples sobre os resultados) e desliga a pré-rota e a recuperação de promessa; só a guarda final (`YUI_RESEARCH_GUARD`) continua | `true` |
| `YUI_RESEARCH_GUARD` | Guarda de promessa. `on`: uma resposta que só promete pesquisar ("Vou pesquisar isso!"), sem pesquisa nenhuma, vira uma pesquisa de verdade, uma recusa honesta, a pergunta "Pesquisar o quê?" ou um pedido de desculpas; uma resposta com conteúdo que **fecha** com uma promessa de pesquisa ("...mas o preço muda. Vou pesquisar o valor atual e já te falo!") perde só essa frase. `observe`: só registra no log o que faria (ação e motivo), sem mudar a resposta. `off`: desliga | `on` |
| `YUI_RESEARCH_PRE_ROUTE` | `true`: pedido de pesquisa **explícito e estrito** ("pesquise o preço do PS5") é pesquisado pelo código, sem a primeira chamada ao modelo (vale na menção, na DM, no `/yui`, no `+yui perguntar` e no app). Fica desligado no primeiro reinício de propósito: veja "Como ligar aos poucos" abaixo | `false` |
| `YUI_PRIVATE_SEARCH` | Pesquisa em conversa **privada**: `off` nunca pesquisa, `owner` só o dono, `all` qualquer pessoa. Valor desconhecido vale `off`. **Leia o aviso de privacidade abaixo** | `off` |
| `YUI_RESEARCH_MAX_STEPS` | Passos de busca por pedido (1 a 3). O 2º só roda se o 1º não achou nada, com uma consulta nova só de palavras-chave | `2` |
| `YUI_RESEARCH_PAGES` | Páginas lidas depois da busca, de sites diferentes (0 a 3; `0` responde só com os resumos dos buscadores) | `2` |
| `YUI_RESEARCH_DEADLINE_MS` | Prazo total do agente, em milissegundos (20000 a 180000; abaixo de 20000 volta ao padrão). Estourou, sai um resumo com os links ou o motivo | `60000` |
| `YUI_RESEARCH_CHARGE_ALL` | `true`: cada passo de busca gasta 1 pesquisa do limite por pessoa e do teto global. `false`: só o 1º passo gasta | `true` |
| `YUI_RESEARCH_SOURCES` | Mostra a linha **📎 Fontes** (links) no fim da resposta | `true` |

Valem também as variáveis da tabela de pesquisa acima, em especial `YUI_SEARCH_USER_PER_HOUR` (5), `YUI_SEARCH_GLOBAL_PER_HOUR` (20), `YUI_SEARCH_DEADLINE_MS` (12 s por busca) e os tetos mensais. Valores booleanos aceitam `true`/`false`, `1`/`0`, `on`/`off`, `yes`/`no`, `sim`/`nao`; um valor que ela não reconhece volta ao padrão.

> ℹ️ O plano do agente previa `YUI_RESEARCH_PROMISE_RECOVERY` e `YUI_AI_CHAIN_DEADLINE_MS`. **Elas não existem**: o interruptor da recuperação de promessa é o `YUI_RESEARCH_GUARD`, e o prazo da cadeia de provedores é o `YUI_AI_DEADLINE_SECONDS` (seção 2). Escrever as duas no `.env` não muda nada.

**Por onde a Yui pesquisa.** Todas as entradas usam o mesmo agente e os mesmos limites: menção, nome da Yui ou resposta a ela no servidor, DM, `/yui`, `+yui perguntar` e o app/API (`/v1/chat` e `/v1/agent`). **Por voz ela não pesquisa** (a voz fica sem ferramentas, `YUI_VOICE_TOOLS=false`, o padrão): se a IA tentar chamar a pesquisa, a resposta é "Isso eu faço só pelo chat."; se só prometer pesquisar, vira "Por voz eu não pesquiso na web. Pede no chat de texto.". Mesmo com `YUI_VOICE_TOOLS=true` a pesquisa por voz é recusada com essa mesma frase (a fala de outras pessoas na call nunca vira consulta a buscador). O Modo Rádio, o `/chat_resumo` e a conversa espontânea (a Yui falando no canal sem ter sido chamada: a ferramenta nem é oferecida ao modelo, e nada gasta a cota de quem só falou) também nunca pesquisam.

**Conversa privada, o que é.** Para a **pesquisa**, "privada" é o dono em DM, o dono em canal listado em `YUI_PRIVATE_CHANNEL_IDS`, o **app/API** (sempre privado) e a **DM de qualquer pessoa** ("DM e app para todos, com as proteções"). Só a pesquisa trata a DM de um membro comum como privada: o resto (memória pública, cadeia de provedores, histórico) segue como numa conversa de servidor. Com `YUI_PRIVATE_SEARCH=off` ou `owner`, a DM de um membro não pesquisa; com `all`, pesquisa com as proteções abaixo.

#### 🔒 Privacidade da pesquisa em conversa privada

Com `YUI_PRIVATE_SEARCH=off` (padrão) a conversa privada **nunca** pesquisa e a Yui responde "Não pesquiso na web numa conversa privada.", porque a consulta sairia do seu PC para buscadores de terceiros. Com `owner` ou `all`, valem estas proteções, para qualquer pessoa:

- Só pesquisa em pedido **explícito** ("pesquise o preço do PS5"), com o assunto na mesma mensagem. Uma promessa do modelo ou uma pergunta solta não abre a pesquisa; a Yui responde como pedir.
- A consulta sai **só do texto literal da mensagem atual**: nunca do histórico, da memória, do contexto por horas nem de dados do servidor, e a consulta que o modelo sugerir é ignorada. A consulta é reduzida ao pedido: corta na primeira justificativa ("...porque estou juntando dinheiro para...") ou no fim da frase, com no máximo 120 caracteres.
- A mensagem inteira passa pelo filtro de dados pessoais (e-mail, CPF/CNPJ, cartão, telefone, número longo, IP, agência/conta, senha, token) e pelas palavras proibidas do AutoMod. O filtro normaliza o texto antes (letras e dígitos de largura total, caracteres invisíveis) e pega os disfarces mais comuns (CPF ou telefone com espaços, e-mail "por extenso", palavra proibida com letras separadas ou em "leet"). Se bater, a Yui pede para reescrever e **não pesquisa**. Atenção: um número de 9 ou mais dígitos, um IP ou um token de 32 ou mais caracteres, mesmo legítimos, também bloqueiam. É um filtro de padrões, não uma garantia: quem escrever o dado de um jeito inventado ainda passa.
- A resposta é montada por uma chamada **sensível**: nunca vai a provedor anônimo (Pollinations, Horde), sem histórico, sem memória e sem ferramentas.
- O log guarda só metadados (nunca o texto da consulta nem o host das páginas lidas). O histórico em RAM e o `historico.txt` guardam uma única linha neutra no lugar do resultado ("Pesquisei na web a pedido do usuário (conversa privada) e respondi."), e a troca não entra no contexto por horas. O pedido em si continua sendo gravado no `historico.txt` como qualquer mensagem.
- No app, `AI_PRIVATE_LOCAL_ONLY=true` com memória pessoal em jogo mantém a pesquisa fechada (o texto sairia para a nuvem).

> ⚠️ **Aviso de privacidade e Termos de Uso.** Em `all`, o texto do pedido de **qualquer pessoa** que use uma conversa privada da Yui (o app/API de qualquer papel, a DM de qualquer pessoa e o dono no Discord) pode sair para Tavily, Brave, DuckDuckGo ou Bing, e a retenção desse texto passa a ser regra deles. O texto dos Termos de Uso (`src/handlers/tosHandler.js`) **não foi alterado** e não cita isso: se for usar `all` com outras pessoas, avalie se os Termos precisam avisar. `owner` mantém tudo restrito ao dono.

#### 🚦 Como ligar aos poucos

1. **Primeiro reinício:** padrões do código. A guarda de promessa já fica em `on` e a pré-rota em `false`. Para só observar por alguns dias, use `YUI_RESEARCH_GUARD=observe` e procure no log as linhas `[Pesquisa] guarda (observe)` e `[Pesquisa] guarda final (observe)`: elas mostram o que a guarda trocaria, sem mudar nenhuma resposta.
2. **Depois de olhar os logs:** `YUI_RESEARCH_GUARD=on` e, se quiser que o pedido explícito nem espere a primeira resposta do modelo, `YUI_RESEARCH_PRE_ROUTE=true`. A regra da pré-rota é estrita de propósito (não pega "o que você acha de pesquisa de satisfação?", links, texto grande nem pedido de música ou de jogo).
3. **Voltar atrás:** `YUI_RESEARCH_ENABLED=false` e reinicie. As linhas `[Pesquisa]` do log trazem só tipo, passos, buscas, páginas, fontes, tempo, provedor e motivo, nunca a pergunta.

### 🧩 Lista de mods (Minecraft)

Quando alguém manda 5 ou mais linhas de nomes de mods e pede os links ("me manda o download desses mods"), o **código** procura cada nome na API pública do Modrinth (gratuita, sem chave), calcula em qual loader e versão do Minecraft os mods achados existem juntos e devolve a lista numerada com o link do mod e o da versão certa. As dependências obrigatórias que não estavam na lista aparecem à frente do mod entre parênteses, como **(Important Complements: ...)**. A IA não escreve link nenhum, e nome com erro de digitação sai com o aviso "achei como X, confira". Vale na menção, na DM, no `/yui` e no `+yui perguntar`; o app/API fica de fora.

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `YUI_MODLIST_ENABLED` | Chave mestra. `false` volta ao jeito antigo: a IA responde ao pedido sem consultar o Modrinth | `true` |
| `YUI_LISTS_ENABLED` | Listas pessoais por conversa natural (guardadas em `database/listas/<seu id>.json`, só você lê). `false` desliga | `true` |
| `YUI_MODLIST_MAX_ITEMS` | Máximo de nomes por pedido (5 a 300). Os que passarem ficam de fora e a resposta diz quantos | `120` |
| `YUI_MODLIST_DEADLINE_MS` | Prazo total do pedido, em milissegundos (20000 a 300000). Estourou: sai o que já foi achado e o resto vira link de busca | `120000` |
| `YUI_MODLIST_CONCURRENCY` | Pedidos simultâneos ao Modrinth, somando todos os trabalhos (1 a 5) | `3` |

> 🔒 Em **conversa privada** (a DM de qualquer pessoa e o dono em canal privado) a Yui só consulta o Modrinth se o `YUI_PRIVATE_SEARCH` liberar essa pessoa; senão ela diz que não consulta serviços externos e devolve links de busca prontos. A ferramenta `search_web` desligada no servidor também impede a consulta. Cada nome passa pelo filtro de dados pessoais e palavras proibidas antes de sair, e o log guarda só contagens, nunca os nomes.

Limites: uma lista por pessoa por vez e no máximo duas ao mesmo tempo (a terceira recebe um aviso para tentar de novo), ritmo de no máximo 240 pedidos por minuto ao Modrinth, resposta do Modrinth que pede espera (429) é respeitada e, se não passar, a lista sai parcial dizendo onde parou. Uma lista de 70 nomes leva cerca de 15 a 20 segundos e uns 180 pedidos. Mods que só existem no CurseForge ganham um link de busca marcado como busca (não é download). Para fixar a combinação, escreva na mensagem, por exemplo, `Forge 1.20.1` ou `fabric 1.21`.

### 🔊 Fala da Yui na call (TTS local)

Voz do Windows (SAPI): roda no seu PC, sem rede e sem custo; precisa de uma voz pt-BR instalada. O módulo fica em `src/services/tts/` e lê as variáveis abaixo na inicialização, por isso **reinicie a Yui depois de editar o `.env`** (números fora do intervalo são ajustados ao limite; valor inválido volta ao padrão). A Yui fala uma resposta curta e manda o resto no chat; ela só fala resposta a um pedido feito **por voz**, nunca em conversa privada ou sensível e nunca enquanto o Modo Rádio estiver ligado.

> ✅ **Estado:** ligado ao bot (iniciado em `src/discord/client.js`, junto com o login). Vale a partir do próximo reinício **e** só nos servidores onde um administrador ligou **🔊 Resposta por Voz (TTS)** (desligado por padrão) e **🎙️ Assistente de Voz (Call)**, em `/yui-ferramentas`. Passo a passo e problemas comuns em [TTS](TTS.md). Testado só offline: o primeiro teste numa call real ainda está pendente ([checklist](OPERACAO.md#-11-checklist-da-fala-tts)).

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `YUI_TTS_ENABLED` | `false` desliga a fala por completo (nenhum processo de voz sobe). Um valor escrito que ela não reconhece, como `falso`, também desliga | `true` |
| `YUI_TTS_PROVIDERS` | Provedores de voz, em ordem. Hoje só existe `sapi`; `piper` e `edge` ainda não existem e são ignorados com um aviso no log | `sapi` |
| `YUI_TTS_CLOUD` | `true` liga a voz neural da NUVEM (Microsoft Edge, bem mais natural e sem gastar CPU/GPU): o TEXTO falado sai do PC, só em respostas não sensíveis; se a nuvem falhar ou o teto diário acabar, a voz do Windows assume. `false` mantém tudo local | `false` |
| `YUI_TTS_PROVIDERS` com nuvem | Sem definir, a ordem é `edge,sapi` quando `YUI_TTS_CLOUD=true` e só `sapi` quando `false` | automático |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | Chave e região do recurso **Azure Speech** (oficial, mais vozes pt-BR e estilos; faixa gratuita de 500 mil caracteres/mês). Com `YUI_TTS_CLOUD=true` e a chave, a ordem vira `azure,edge,sapi`. A chave fica SÓ no `.env` (veja o passo a passo em [TTS](TTS.md)) | — |
| `YUI_TTS_AZURE_VOICE` / `YUI_TTS_AZURE_STYLE` | Voz (ex.: `pt-BR-ThalitaMultilingualNeural`) e estilo opcional (ex.: `cheerful`; nem toda voz tem) | `pt-BR-ThalitaMultilingualNeural` / vazio |
| `YUI_TTS_AZURE_RATE` / `YUI_TTS_AZURE_PITCH` | Velocidade e tom da voz do Azure | `+0%` / `+0Hz` |
| `YUI_TTS_AZURE_MAX_CHARS_PER_MONTH` | Teto mensal de caracteres enviados ao Azure (abaixo da faixa gratuita); passou disso, o Edge/Windows assumem | `450000` |
| `YUI_TTS_AZURE_TIMEOUT_MS` / `YUI_TTS_AZURE_COLD_TIMEOUT_MS` | Prazo da síntese no Azure e o da primeira, em ms | `8000` / `12000` |
| `YUI_TTS_EDGE_VOICE` | Voz neural: `pt-BR-FranciscaNeural` (calma e natural) ou `pt-BR-ThalitaNeural` (mais jovem) | `pt-BR-FranciscaNeural` |
| `YUI_TTS_EDGE_RATE` / `YUI_TTS_EDGE_PITCH` | Velocidade (ex.: `-4%`) e tom (ex.: `+3Hz`) da voz neural | `-4%` / `+0Hz` |
| `YUI_TTS_EDGE_MAX_CHARS_PER_DAY` | Teto diário de caracteres enviados à nuvem (1000 a 2000000); passou disso, a voz do Windows fala | `100000` |
| `YUI_TTS_EDGE_TIMEOUT_MS` / `YUI_TTS_EDGE_COLD_TIMEOUT_MS` | Prazo da síntese na nuvem (2000 a 30000) e o da primeira (3000 a 60000), em ms | `8000` / `12000` |
| `YUI_VOICE_TOOLS` | `true` libera ferramentas por voz (baixar, gerar imagem...; a pesquisa na web por voz é sempre recusada com o agente de pesquisa ligado); `false` deixa a voz só conversar: qualquer ferramenta pedida por voz é descartada e a resposta vira "Isso eu faço só pelo chat." (só "Yui, sai da call" continua valendo, e só com o Assistente de Voz ligado) | `false` |
| `YUI_TTS_SAPI_VOICE` | Nome (ou parte do nome) da voz SAPI; vazio usa a primeira voz pt-BR instalada | — |
| `YUI_TTS_SAPI_RATE` | Velocidade, de `-10` a `10` | `0` |
| `YUI_TTS_MAX_CHARS` / `YUI_TTS_MAX_SENTENCES` / `YUI_TTS_MAX_SENTENCE_CHARS` / `YUI_TTS_MAX_SECONDS` | Quanto ela fala por resposta: caracteres (60 a 600), frases (1 a 6), caracteres por frase (60 a 400) e segundos (5 a 60) | `220` / `3` / `160` / `25` |
| `YUI_TTS_STALE_SECONDS` | Resposta que demorou mais que isso para ficar pronta não é mais falada (5 a 300) | `30` |
| `YUI_TTS_USER_GAP_SECONDS` | Intervalo mínimo entre falas para a mesma pessoa (0 a 120) | `6` |
| `YUI_TTS_USER_PER_MIN` / `YUI_TTS_GUILD_PER_MIN` / `YUI_TTS_GLOBAL_PER_MIN` | Falas por minuto por pessoa (1 a 60), por servidor (1 a 120) e no total (1 a 240) | `5` / `8` / `12` |
| `YUI_TTS_GUILD_SECONDS_PER_10MIN` | Segundos de fala por servidor a cada 10 minutos (10 a 1200) | `120` |
| `YUI_TTS_QUEUE_MAX` | Falas na fila por servidor (1 a 10) | `3` |
| `YUI_TTS_BARGE_IN` / `YUI_TTS_BARGE_IN_MS` | A Yui para de falar quando alguém fala por cima por mais de N milissegundos (200 a 5000) | `true` / `800` |
| `YUI_TTS_ECHO_GUARD_MS` | Margem anti-eco em volta da fala da Yui em que o áudio captado é descartado antes de ser transcrito (0 a 10000) | `1500` |
| `YUI_TTS_IDLE_MINUTES` | Minutos sem falar até o processo da voz ser encerrado (1 a 240) | `10` |
| `YUI_TTS_SAPI_TIMEOUT_MS` / `YUI_TTS_SAPI_COLD_TIMEOUT_MS` | Prazo da síntese, em ms: normal (1000 a 30000) e a primeira depois da partida (3000 a 60000) | `4000` / `15000` |
| `YUI_PERSONA_VOICE_FILE` | Arquivo com as regras de estilo da resposta falada (curta, sem Markdown, sem ferramentas). Precisa ficar dentro da pasta `persona/` (ou de uma subpasta dela) e ser `.md` ou `.txt`, sem ser arquivo oculto: qualquer outro caminho (outra pasta, `..`, caminho absoluto) é ignorado e volta ao arquivo padrão, porque o conteúdo vai ao prompt de todo pedido de voz. É relido sozinho quando o arquivo muda, e um texto de reserva vale se ele faltar | `persona/yui-voz.md` |

Para ouvir as vozes antes de escolher, rode `npm run tts:amostra`: ele gera arquivos WAV com frases fixas numa pasta temporária (não toca no Discord, no `.env` nem em banco).

As listas editáveis de pronúncia (`lexicon.pt-BR.json`) e de palavras que ela não fala (`blocklist.pt-BR.json`) ficam em `src/services/tts/` e são lidas na inicialização; veja o [passo 7 do guia](TTS.md#-7-ajustar-a-pronúncia).

---

## 🎵 4. Música e mídia

| Variável | Descrição |
|----------|-----------|
| `DEEZER_ARL` (ou `DEEMIX_ARL`) | Cookie `arl` da sua conta Deezer, para downloads via `deemix`. **É um segredo**: só no `.env`, nunca em comando nem em log (a Yui o passa ao Python por variável de ambiente, nunca na linha de comando) |
| `PYTHON_PATH` | Caminho **completo** do `python.exe` do ambiente virtual do deemix (veja abaixo). Vazio: a Yui tenta `python` (Windows) ou `python3` (Linux) |
| `YUI_DEEZER_TIMEOUT_S` | Tempo máximo de cada download pelo Deezer, em segundos (10 a 900). Padrão `180` |
| `YUI_DEEMIX_CONFIG_DIR` | Pasta de configuração própria do deemix (opcional). Padrão: a do deemix em `%APPDATA%\deemix` |
| `YTDLP_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH` | Caminhos dos binários (a Yui os baixa/localiza sozinha se vazios) |
| `YTDLP_COOKIES_PATH` | Cookies para o yt-dlp (vídeos com restrição de idade/login) |
| `YTDLP_AUTO_UPDATE` | `false` desliga a atualização automática do yt-dlp. Padrão `true` |
| `YTDLP_UPDATE_HOUR` | Hora (0 a 23) a partir da qual a atualização diária roda. Padrão `4` |
| `YUI_DL_MAX_MINUTES` | Duração máxima de um download, em minutos (`0` = sem limite). Não vale para o Modo Rádio nem para o Spotify. Padrão `20` |
| `YUI_DL_MAX_FILESIZE_MB` | Tamanho máximo do arquivo, em MB (`0` = sem limite). Padrão `200` |
| `YUI_DL_TIMEOUT_SECONDS` | Tempo máximo de cada execução do yt-dlp ou do spotdl, em segundos (mínimo `30`). Padrão `300` |
| `YUI_DL_MAX_CONCURRENT` | Downloads ao mesmo tempo, somando todos os usuários (áudio e vídeo; `0` = sem teto, máximo `50`). O dono nunca é barrado pelo teto. Padrão `3` |
| `YUI_UPLOAD_LIMIT_MB` | Limite de anexo do Discord, em MB, para servidor sem boost nível 2 ou 3 e conversa privada. Padrão `10`. O nível 2 usa pelo menos 50 e o nível 3 pelo menos 100; a Yui usa 95% do valor como folga. Aceita decimal; fora de 1 a 100 é ajustado ao limite e valor inválido volta ao padrão |
| `YUI_AUDIO_REENCODE` | `false` desliga a recompressão do MP3 que passa do limite de anexo (aí o arquivo grande vira só um aviso de que passou do limite). Padrão ligado |
| `YUI_AUDIO_FIT_TIMEOUT_S` | Prazo de cada execução do ffmpeg na recompressão, em segundos (10 a 900; fora disso vale o padrão). No máximo 2 ao mesmo tempo. Padrão `120` |
| `SPOTDL_PATH` | Caminho do `spotdl.exe` (precisa ser um **arquivo**; pasta, `.cmd` e `.bat` não valem). Caminho relativo vale a partir da pasta onde a Yui roda. Vazio: o `.venv-spotdl` da raiz do projeto e, depois, o `PATH` |
| `YUI_SPOTDL_BITRATE` | Bitrate do MP3 do Spotify, de `64k` a `320k` (outro valor volta ao padrão). Padrão `192k` |
| `YUI_SPOTDL_LOG_LEVEL` | Detalhe do log do spotdl: `WARNING`, `INFO` ou `DEBUG` (use `DEBUG` só para investigar uma falha). Padrão `WARNING` |
| `YUI_SPOTDL_MAX_PARALLEL` | Quantos `spotdl` rodam ao mesmo tempo (1 a 4). Padrão `2` |

### 📥 Downloads: como funcionam e o que limita

- **Só links de plataformas conhecidas:** o link é validado, a URL é reconstruída a partir do identificador do vídeo e só ela chega ao yt-dlp. O texto digitado nunca vai para o terminal, e os programas rodam sem shell, com tempo limite.
- **Playlist:** link de vídeo que traz uma playlist (`watch?v=...&list=...`) baixa **só o vídeo**; playlist pura, perfil ou coleção baixa **só o primeiro item**. A Yui avisa numa linha discreta quando isso acontece.
- **Spotify:** só links de faixa (`open.spotify.com/track/...`). Álbum, playlist, artista e podcast são recusados. Depende do `spotdl`, que a Yui **não instala** (veja [Spotify: ambiente Python do spotdl](#-spotify-ambiente-python-do-spotdl)). Sem o `spotdl`, só o `yt-dlp` é tentado e ele não baixa áudio do Spotify, então o pedido falha com um aviso.
- **Deezer:** só faixa (ID ou `deezer.com/track/...`). Se o `deemix` falhar (inclusive por ARL inválido ou vencido), a Yui baixa a música do YouTube e **avisa só que a qualidade pode ser menor**. A mensagem não diz de onde veio o arquivo (a origem fica no log).
- **Limite de anexo e recompressão do MP3:** o servidor aceita **10 MB** por anexo (`YUI_UPLOAD_LIMIT_MB`). Um MP3 maior que isso é **recomprimido** com o ffmpeg a 192, 128 e 96 kbps, nessa ordem, até caber; nunca no Modo Rádio, que toca o arquivo local e não o envia. Com os 10 MB cabem cerca de 6 min 55 s a 192 kbps e 13 min a 96 kbps. Faixa que nem a 96 kbps cabe, ou qualquer arquivo grande com `YUI_AUDIO_REENCODE=false`, vira um aviso de que passou do limite. Antes de baixar, o áudio de YouTube, Instagram ou TikTok mais longo do que cabe a 96 kbps é recusado (vale o menor entre esse tempo e `YUI_DL_MAX_MINUTES`).
- **A origem do MP3 não aparece:** nada que o usuário recebe na entrega diz se o arquivo veio do Deezer, do YouTube ou do Spotify (não há campo "Fonte", rodapé nem aviso com o nome do serviço). As tags de URL e de comentário do MP3 também são tiradas; título, artista e álbum ficam. A origem vai só para os logs. A ajuda e as mensagens de erro continuam citando as plataformas aceitas como **link** (YouTube, Spotify, Instagram, TikTok). O rodapé "Powered by Deezer" do Modo Rádio não mudou.
- **Pastas temporárias:** cada pedido usa uma subpasta própria em `src/data/temp_audio`, `temp_videos` ou `temp_spotify`, apagada logo depois do envio. A cada 5 minutos uma faxina remove subpastas vazias antigas e as esquecidas há mais de 24 horas.

### 🐍 Deezer: ambiente Python do deemix

O `deemix` roda num ambiente virtual próprio, testado com **Python 3.12**. Na pasta do projeto:

```powershell
py -3.12 -m venv .venv-deemix
.venv-deemix\Scripts\python.exe -m pip install -r requirements-deemix.txt
```

Depois, no `.env`: `PYTHON_PATH=D:\Projetos\Yui\.venv-deemix\Scripts\python.exe` (o seu caminho) e `DEEZER_ARL=...`. As versões ficam fixas em `requirements-deemix.txt`. A pasta `.venv-deemix` está no `.gitignore`. O `setup.ps1` (via `setup.bat`) oferece criar esse ambiente de forma opcional.

### 🟢 Spotify: ambiente Python do spotdl

O `spotdl` (que baixa as faixas do Spotify) também roda num ambiente virtual próprio, testado com **Python 3.12** e `spotdl` 4.5.2. Na pasta do projeto:

```powershell
py -3.12 -m venv .venv-spotdl
.venv-spotdl\Scripts\python.exe -m pip install --only-binary=:all: -c requirements-spotdl.lock.txt -r requirements-spotdl.txt
```

O `requirements-spotdl.lock.txt` fixa as 63 versões testadas; sem o `-c requirements-spotdl.lock.txt` as dependências indiretas variam. A pasta `.venv-spotdl` está no `.gitignore`. A Yui acha o `spotdl` sozinha, nesta ordem: `SPOTDL_PATH` (se apontar para um arquivo que existe), `.venv-spotdl\Scripts\spotdl.exe` e o `PATH`. Na inicialização o log traz `[MediaTools] Spotdl: OK (...)` ou `[MediaTools] Spotdl: FALTANDO (...)`; a checagem só confere se o arquivo existe, sem rede e sem rodar o `spotdl`.

Como funciona e o que limita:

- **Isolamento:** cada pedido roda com uma pasta `_home` própria, **sem as chaves da Yui** (o `spotdl` não recebe token, ARL nem chave de IA), baixa **uma faixa** e a pasta inteira é apagada no fim.
- **Pasta temporária:** nenhum nome de pasta do caminho de `src/data/temp_spotify`, incluindo as pastas acima dela (a pasta do projeto, por exemplo), pode **começar com `.`** nem **terminar com `.`, `*` ou `$`**. O `spotdl` alteraria o nome e gravaria o arquivo em outra pasta; nesse caso o pedido falha cedo e o log diz o motivo.
- **Fallback:** só se o `spotdl` estiver **ausente** a Yui tenta o `yt-dlp` (que não baixa áudio do Spotify). Se o `spotdl` existe e falha, a resposta é a causa real e o `yt-dlp` não é tentado.
- **Limites:** `YUI_DL_MAX_MINUTES` **não vale** para o Spotify (o `spotdl` não tem filtro de duração); valem `YUI_DL_MAX_FILESIZE_MB`, `YUI_DL_TIMEOUT_SECONDS` e o limite de anexo (um MP3 acima de 10 MB é recomprimido).
- **Relógio do PC:** o acesso ao Spotify depende da hora do computador; com a hora errada o `spotdl` não consegue a sessão. Mantenha a hora do Windows sincronizada.
- **Versão da faixa:** o áudio é procurado em outro catálogo, então a faixa pode vir numa versão diferente da do Spotify (ao vivo, remix, outra masterização).
- **Proteções:** no máximo `YUI_SPOTDL_MAX_PARALLEL` rodam juntos e 3 esperam na fila (até 3 minutos); acima disso o pedido recebe um aviso de "ocupado". Depois de 3 falhas seguidas do lado do Spotify ou da rede, os pedidos são recusados por 5 minutos, sem iniciar processo.
- **Atualizar:** o auto-update da Yui cobre só o `yt-dlp` dela. Para atualizar o do ambiente do `spotdl`: `.venv-spotdl\Scripts\python.exe -m pip install -U "yt-dlp[default]"`. Se algo quebrar depois, reinstale com o lock acima.

### 🎙️ Voz e Modo Rádio: Opus e criptografia

A voz precisa de um codificador **Opus**. O `package.json` traz o `opusscript` (puro JavaScript, sem compilar) e o `@noble/ciphers` (criptografia de voz alternativa); rode `npm install` e reinicie a Yui depois de atualizar. Sem Opus, a primeira fala ou música gerava uma sequência de erros graves; agora a Yui checa na inicialização (linha `[MediaTools] Opus` no log), recusa `/entrar-call` e o Modo Rádio com um aviso claro e manda uma DM ao dono. O mesmo relatório informa se a criptografia de voz e o DAVE (E2EE do Discord) estão presentes.

---

## 🎮 5. GTA Online, Reddit e avisos

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `GTA_WEEKLY_ENABLED` | Liga a checagem do evento semanal | `true` |
| `GTA_WEEKLY_INTERVAL_MINUTES` | Intervalo da checagem | `30` |
| `REDDIT_FETCH_MODE` | `browser` (Chrome/Edge via Puppeteer, com fallback) ou `cookies` | `browser` |
| `REDDIT_BROWSER_PATH` | Caminho do Chrome/Edge (também vale `PUPPETEER_EXECUTABLE_PATH`) | detecta |
| `REDDIT_USER_AGENT` | Identificação no método de cookies | — |
| `NEWSWIRE_ENABLED` | Liga a checagem automática do Rockstar Newswire | `false` |
| `NEWSWIRE_INTERVAL_MINUTES` | Intervalo do Newswire | `30` |
| `YOUTUBE_API_KEY`, `YOUTUBE_INTERVAL_MINUTES` | Avisos de YouTube | — / `5` |
| `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_INTERVAL_MINUTES` | Avisos de Twitch | — / `2` |

> O Reddit responde `429` se for consultado demais. Evite testes ao vivo em sequência. Detalhes em [GTA Online](GTA_ONLINE.md).

---

## 🧠 6. Yui Core: memória, API e painel

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `YUI_MEMORY_ENABLED` | Liga a memória por usuário | `true` |
| `MEMORY_RETENTION_DAYS` | Dias sem interação até a memória pública expirar (a pessoal do dono é permanente) | `30` |
| `YUI_CONTEXT_ENABLED` | Liga o **contexto das conversas por horas** (a Yui lembra as últimas falas de cada pessoa em cada canal). Desligado, vale o buffer antigo (por canal, só em RAM) | `false` |
| `YUI_CONTEXT_SCOPE` | `owner` = só o dono; `all` = todos (faça só depois de avisar nos Termos de Uso) | `owner` |
| `YUI_CONTEXT_TTL_HOURS` | Quanto tempo cada fala fica guardada, em horas (1 a 48) | `6` |
| `YUI_CONTEXT_MAX_CHARS` | Limite de caracteres do fio enviado à IA (1000 a 30000) | `6000` |
| `YUI_CONTEXT_MAX_TURNS` | Limite de falas do fio, usuário mais IA (2 a 60; sempre par) | `20` |
| `YUI_OWNER_ID` | ID do dono no Core (se vazio, usa `OWNER_ID`) | — |
| `YUI_TRUSTED_IDS` | IDs de confiança, separados por vírgula | — |
| `YUI_PRIVATE_CHANNEL_IDS` | Canais tratados como privados (memória pessoal liberada para o dono) | — |
| `YUI_OWNER_NAME` | Nome pelo qual a Yui trata o dono no perfil pessoal | — |
| `YUI_PERSONA_PUBLIC_FILE` | Arquivo da personalidade do Discord público (padrão `persona/yui-publica.md`, relido ao ser alterado) | `persona/yui-publica.md` |
| `YUI_PERSONA_PERSONAL_FILE` | Arquivo de texto que substitui a personalidade pessoal (`{nome}` = nome do dono) | — |
| `YUI_READ_ONLY` | **Modo somente leitura**: bloqueia ferramentas que apagam, gravam, movem ou executam | `true` |
| `YUI_AUDIT_FILE` | Caminho do arquivo de auditoria | `logs/core-audit.jsonl` |
| `YUI_BANS_FILE` | Caminho do arquivo de banimentos. Existe para os testes não tocarem o arquivo real; na prática não precisa mudar | `src/data/bans.json` |
| `YUI_API_ENABLED` | Liga a Yui API | `false` |
| `YUI_API_HOST` / `YUI_API_PORT` | Endereço e porta (mantenha `127.0.0.1`) | `127.0.0.1` / `3939` |
| `YUI_API_TOKENS` | Tokens fixos `token=ID_do_Discord`, separados por vírgula (16+ caracteres) | — |
| `YUI_API_CORS_ORIGINS` | Origens web autorizadas (CORS), separadas por vírgula | vazio (desligado) |
| `YUI_PANEL_USER` | Usuário do login do app/painel | — |
| `YUI_PANEL_PASSWORD_HASH` | Hash scrypt da senha, gerado por `npm run panel:password` | — |
| `YUI_PANEL_PASSWORD` | Senha em texto (menos segura; mínimo 10 caracteres). O hash tem prioridade | — |
| `YUI_PANEL_USER_ID` | Dono a quem o login se aplica (se vazio, o dono) | — |
| `YUI_ALERTS` | `false` desliga os avisos automáticos por DM quando algo dá errado | `true` |
| `YUI_ALERTS_COOLDOWN_MINUTES` | Intervalo mínimo para repetir o mesmo aviso | `30` |
| `YUI_PANEL_AI_EDIT` | `false` trava a edição de chaves e provedores de IA pelo painel | `true` |
| `YUI_AI_SETTINGS_FILE` | Onde o painel guarda as chaves/provedores que você adicionou | `secrets/ai-providers.json` |
| `YUI_PANEL_SESSION_HOURS` | Validade da sessão de login | `12` |

Como entrar e as rotas: [Yui API](YUI_API.md).

---

## 🧰 7. Yui Core: Agent e ferramentas do PC

| Variável | Descrição |
|----------|-----------|
| `YUI_TOOLS_PC_ENABLED` | `true` registra as ferramentas do PC (`system.info`, `projects.open`, `apps.open`, `files.search`) |
| `YUI_PROJECTS` | Projetos que podem ser abertos: `NOME=CAMINHO`, separados por `\|` |
| `YUI_APPS` | Programas que podem ser abertos (bloqueado em somente leitura) |
| `YUI_COMMANDS` | Comandos que a Yui pode rodar pelo **nome**: `NOME=executável args`, separados por `\|`; sem shell, com confirmação, bloqueado em somente leitura. [Comandos e skills](COMANDOS_E_SKILLS.md) |
| `YUI_SKILLS_DIR` | Pasta das skills (receitas em texto do dono; padrão `skills/`) |
| `YUI_FILE_ROOTS` | Pastas onde a busca de arquivos por nome é permitida |
| `YUI_EDITOR_COMMAND` | Executável do editor usado ao abrir projetos |
| `YUI_MCP_ALLOW` | Ferramentas MCP liberadas ao Agent (`servidor.ferramenta,...`) |
| `YUI_MCP_READ_ONLY` | Dentre as liberadas, as que só leem (as demais ficam bloqueadas em somente leitura) |

---

## 🧭 8. Yui Gateway

| Variável | Descrição |
|----------|-----------|
| `YUI_GATEWAY_ENABLED` | Liga o servidor HTTP do Gateway (`127.0.0.1:20130`) |
| `YUI_GATEWAY_KEYS` | Chaves de acesso do servidor (16+ caracteres, separadas por vírgula) |
| `YUI_GATEWAY_HOST` / `YUI_GATEWAY_PORT` | Endereço e porta do servidor (padrão `127.0.0.1` / `20130`) |
| `YUI_GATEWAY_IN_CHAIN` | Padrão `true`: mantém o Gateway na cadeia interna de IA da Yui (logo após o LM Studio); `false` desliga |
| `YUI_GATEWAY_DISABLE` | Provedores a desligar |
| `YUI_GATEWAY_PRIORITY` | Ordem dos provedores |
| `YUI_GATEWAY_COMBOS` | Combos de modelos |
| `YUI_GATEWAY_CUSTOM` | Provedores personalizados compatíveis com OpenAI |

As chaves dos provedores do Gateway reaproveitam as acima (Groq, Gemini, Hugging Face, OpenRouter, Cloudflare, Together). Formatos e exemplos em [Gateway](GATEWAY.md).

---

## ⌨️ 9. Yui Core: Código

A aba **Código** do app (a Yui lendo e editando os seus projetos). Só o dono. Guia completo: [Código](CODIGO.md).

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `YUI_DEV_ENABLED` | Liga o módulo e as rotas `/v1/dev/*` (a aba **Código** aparece para o dono) | `false` |
| `YUI_DEV_APPROVAL` | `ask`: pergunta antes de gravar e de rodar comando. `auto`: grava sem perguntar (com backup); comandos ainda perguntam. Pelo celular ou com `YUI_READ_ONLY=true`, vale sempre "somente leitura" | `ask` |
| `YUI_DEV_MAX_STEPS` | Máximo de passos (ferramentas) por pergunta | `12` |
| `YUI_DEV_PROJECTS_FILE` | Onde ficam os projetos cadastrados pelo app | `secrets/dev-projects.json` |
| `YUI_PROJECTS` | Projetos fixos (`NOME=CAMINHO`, separados por `\|`); é a mesma lista da [seção 7](#-7-yui-core-agent-e-ferramentas-do-pc) | — |
| `YUI_READ_ONLY` | Com `true` (padrão) o módulo só lê e responde; `false` permite gravar/rodar comandos **com aprovação no computador** | `true` |

A IA usada é a da própria Yui (LM Studio e, depois, o [Gateway](GATEWAY.md)), sempre marcada como sensível: o código nunca vai a provedor anônimo. As conversas ficam em `database/dev-history/`, o índice de busca em `database/dev-index/` (ambos fora do Git; para mudar a pasta base, `DATABASE_DIR`).

---

## 🗑️ 10. Chaves antigas ignoradas

Se o seu `.env` tiver estas linhas, **nada no código as lê mais**; pode removê-las:

`PREFIX`, `BOT_NAME`, `SAVE_HISTORY`, `DEFAULT_AUTOMOD`, `AUTOMOD_MODE`, `LOG_WEBHOOK_URL`, `APPEAL_CHANNEL_ID`.

(O prefixo agora é `COMMAND_PREFIX`; o nome é `AI_BOT_NAME`; o AutoMod é configurado por servidor com os comandos de moderação.)

---

## 💡 Dicas

- **Rodízio de chaves:** várias chaves separadas por vírgula em Gemini/Stability evitam parar quando uma atinge o limite gratuito.
- **Economia:** use `LOCAL_LLM_URL` com LM Studio/Ollama para conversar sem gastar tokens.
- **Segredos:** nunca versione o `.env`; faça backup em local seguro (veja [Operação](OPERACAO.md#-6-dados-e-backups)).

[🏠 Voltar ao índice](../README.md)
