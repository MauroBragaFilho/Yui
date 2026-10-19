# 🧠 Yui como assistente pessoal: o Core

Este documento descreve a arquitetura que transformou a Yui de bot de Discord em **assistente pessoal**, mantendo o Discord como interface oficial: decisões, princípios, permissões, memória, Agent, personalidade e modelo de ameaças. É a referência de arquitetura do **Yui Core**.

> **Resumo:** uma única Yui, com um único Core (`src/core`). Discord, API e apps são só interfaces. A **autorização é decidida pelo backend**, nunca pelo modelo de IA. Tudo que é pessoal fica no PC do dono.

---

## 📂 Sumário

1. [Princípios](#-1-princípios)
2. [Decisões de projeto](#-2-decisões-de-projeto)
3. [Arquitetura](#-3-arquitetura)
4. [Permissões](#-4-permissões)
5. [Memória](#-5-memória)
6. [Agent e ferramentas](#-6-agent-e-ferramentas)
7. [IA: AI Manager e Gateway](#-7-ia-ai-manager-e-gateway)
8. [Personalidade por contexto](#-8-personalidade-por-contexto)
9. [Entrada, API e painel](#-9-entrada-api-e-painel)
10. [Modelo de ameaças](#-10-modelo-de-ameaças)
11. [Fases e estado atual](#-11-fases-e-estado-atual)
12. [Pendências](#-pendências)

---

## 🎯 1. Princípios

1. **Uma única Yui**, com um único Core, para Discord, API e apps.
2. O Discord continua sendo uma interface oficial; apps são clientes opcionais.
3. A **autorização é decidida pelo backend** (ID do usuário + canal + configuração), nunca pelo LLM nem pelo texto da mensagem.
4. Memória dos usuários do Discord é **temporária** (30 dias sem interação); a do dono é **permanente**, em banco **separado**.
5. Ferramentas têm nível de acesso e **são negadas por padrão**; o computador é **somente leitura** por padrão.
6. Texto vindo de web, arquivos, mensagens de terceiros ou resultados de ferramentas é **dado**, nunca instrução.
7. O modelo de IA é **intercambiável** (nuvem hoje, local no futuro).
8. Evolução incremental: **a Yui pública nunca parou de funcionar** durante a construção do Core.

---

## ✅ 2. Decisões de projeto

| Tema | Decisão |
|------|---------|
| Número de Cores | **Um único**, rodando no **PC do dono** (a VPS foi desligada do bot) |
| Memória sensível no Discord | Só em **DM** e **canais privados** configurados; em canal público o dono usa a memória de usuário comum |
| IA | **Nuvem permitida** por enquanto (hardware ainda limitado para IA local); local é plano futuro |
| Ferramentas do PC | Com proteções: allowlist, confirmação, auditoria e **somente leitura** |
| Entrada nos apps | Usuário e senha **ou** chave de uso único enviada por DM; sessões temporárias |
| Hospedagem | PC com Windows; Tailscale para acesso externo |

---

## 🏗️ 3. Arquitetura

```
                          ┌──────────────────────────────────┐
  Discord (DM, canais) ─► │         DISCORD ADAPTER          │
                          └────────────────┬─────────────────┘
                                           │
                                           ▼
  App (web/Android) ─► Yui API ─►  ┌──────────────────┐     ┌──────────────┐
  (login, chat, painel)            │    YUI CORE      │────►│ Yui Gateway  │──► provedores de IA
                                   │ permissões       │     │ (failover)   │
                                   │ memória          │     └──────────────┘
                                   │ persona          │
                                   │ Agent + ferramentas
                                   └──────────────────┘
```

**Regra de dependência:** adaptadores dependem do Core; o Core nunca depende de um adaptador.

Fluxo de uma mensagem:

```
Mensagem (plataforma + userId + canal)
   ↓
buildContext()  →  papel + tipo de canal + escopo de memória + persona      (backend)
   ↓
Busca na memória do ESCOPO permitido  →  bloco "dados, não instruções"
   ↓
Prompt (personalidade + memória + mensagem)  →  IA (LM Studio → Gateway → ...)
   ↓
Se pedir uma ferramenta → validação + checkToolAccess() + [confirmação] → executa → audita
   ↓
Resposta
```

### Estrutura de código

```
src/core/
├── index.js            ponto único de entrada do Core
├── permissions.js      papéis, tipo de canal, escopo de memória, política e acesso das ferramentas
├── persona.js          personalidade por contexto (pessoal / assistente / Discord público)
├── audit.js            auditoria append-only (logs/core-audit.jsonl)
├── discordAdapter.js   ponte Discord → Core (contexto, bloco de memória, captura)
├── memory/             schemas.js e store.js (remember, recall, forget, purge, administração)
├── context/            contextStore.js: contexto das conversas por horas (opcional, desligado por padrão)
├── ai/manager.js       AI Manager: backends plugáveis (legacy-chain, openai-compatible, gateway)
├── agent/              agent.js (laço de decisão) e tools.js (registro, allowlists, ponte MCP)
├── dev/                Código (o que era do Jarvis): projetos, arquivos, comandos, laço do agente, execuções com aprovação
└── api/                server.js (rotas), auth.js (login, sessões, chave por DM), admin.js (painel)
src/gateway/            Yui Gateway (servidor de IA): providers, router, server
apps/yui-app/           App Android e web
```

---

## 🔐 4. Permissões

| Papel | Quem | Pode |
|-------|------|------|
| `OWNER` | `YUI_OWNER_ID` / `OWNER_ID` / `OWNER_IDS` | Tudo autorizado: memória pessoal, ferramentas do PC (em DM/canal privado), painel |
| `TRUSTED` | `YUI_TRUSTED_IDS` | Ferramentas específicas e memória limitada |
| `MEMBER` | qualquer outro usuário | Comandos públicos e memória temporária |
| `GUEST` | sem identificação | Acesso mínimo |
| `BLOCKED` | banidos (sistema de bans existente) | Nada, inclusive memória |

**Escopo de memória** (decidido pelo backend):

| Papel | DM | Canal privado | Canal público |
|-------|----|---------------|---------------|
| OWNER | pessoal | pessoal | pública (como usuário comum) |
| demais | pública | pública | pública |

Canais privados são listados em `YUI_PRIVATE_CHANNEL_IDS`. Quem decide é o dono, não a IA.

---

## 🧠 5. Memória

A memória é **estruturada**, não um histórico colado no prompt. Cada registro tem tipo (`fact`, `preference`, `project`, `decision`, `summary`, `note`), conteúdo, tags, origem, importância (1 a 5) e datas.

| Banco | Conteúdo | Retenção |
|-------|----------|----------|
| `database/memory-personal.db` | Memória do dono | Permanente |
| `database/memory-discord.db` | Memória dos demais usuários | `MEMORY_RETENTION_DAYS` (30) após a última interação; renovada a cada interação |

- **Captura determinística** (sem chamar a IA, para não gastar cota): frases como "lembra que…", "meu nome é…", "eu gosto de…", **só da fala do usuário** (nunca da resposta da IA nem de ferramentas). Regras específicas vêm antes da genérica, e gravar o mesmo texto de novo só renova a lembrança.
- **Busca:** tokeniza a pergunta (sem acentos nem stopwords), procura só no banco do escopo permitido e ordena por termos × 3 + importância + recência; injeta no prompt só os 8 melhores. O `sql.js` não tem FTS5, então é busca por termos (embeddings são evolução futura).
- **Para o usuário:** `/yui-memoria` (`ver`, `lembrar`, `esquecer`, `apagar-tudo`), sempre efêmero e respeitando o escopo.
- **Para o dono (administração):** `/yui-criador memorias` e **Admin → Memória** no app mostram **só metadados** (quem, quantas, última interação, expiração, tamanho e origem) e permitem apagar; **o conteúdo nunca é exibido** e a memória pessoal do dono fica fora do alcance.
- **Garantias:** o escopo vem de `ctx.memoryScope` (não existe parâmetro para escolher outro banco); usuário bloqueado não lê nem grava; todo acesso à memória pessoal é auditado.

### 🕒 Contexto das conversas por horas

A memória acima guarda **fatos** sobre a pessoa. O **contexto por horas** (`src/core/context/contextStore.js`) guarda as **últimas falas** de uma conversa, para a Yui continuar um assunto. É um recurso à parte, **desligado por padrão** (`YUI_CONTEXT_ENABLED=false`): desligado, nada é lido nem gravado, nenhum banco é aberto e vale o buffer antigo (por canal, só em RAM, 300 caracteres por fala).

| Tema | Como funciona |
|------|---------------|
| Escopo | `YUI_CONTEXT_SCOPE=owner` (padrão): só o dono. `all`: todos, o que exige antes o aviso nos Termos de Uso (o texto do TOS ainda não foi atualizado) |
| Chave do fio | DM: `dm:<userId>`. Servidor, canal ou thread: `ch:<canal>:u:<userId>`. **Um fio por pessoa** em cada canal; ninguém lê o fio do outro |
| Retenção | **Por idade de cada fala**: 6 h por padrão (`YUI_CONTEXT_TTL_HOURS`, 1 a 48). Limpeza horária. Limites: 20 falas e 6000 caracteres (`YUI_CONTEXT_MAX_TURNS`, `YUI_CONTEXT_MAX_CHARS`). Fala do usuário até 1200 caracteres; resposta até 1500, sem o rodapé do modelo |
| Bancos | `database/memory-context.db` (público) e `database/memory-context-personal.db` (dono em DM ou canal privado), **separados** como a memória. Ambos são cobertos por `database/memory-*.db` no `.gitignore`. Se o arquivo corromper, o módulo cai para RAM e guarda o arquivo ruim de lado (`.corrupt-*`) |
| Uso | O fio vai só no campo de histórico da chamada, nunca colado no prompt. O contexto **pessoal** só sai em chamada marcada `sensitive` |
| Grava | Só a fala do próprio autor e a resposta **depois de entregue**. Erro da IA grava o par (fala e "erro da ia"). Não grava resposta que usou busca na web nem JSON de ferramenta; ferramentas gravam uma frase curta fixa e downloads, uma linha sem título externo |
| Fora do contexto | Mensagens espontâneas, `/chat_resumo`, voz e rádio não leem nem gravam |
| Apagar | `/yui-memoria apagar-tudo` apaga os fios da pessoa (DM, canais, público e pessoal), até com a memória desligada ou para usuário bloqueado; a auditoria registra só contagens. O `historico.txt` não é apagado |

---

## 🤖 6. Agent e ferramentas

A Yui pode **executar tarefas autorizadas**. `runAgent(ctx, mensagem)` (`src/core/agent/agent.js`):

1. O LLM só vê as ferramentas que **aquele contexto** pode usar; se não houver nenhuma, é conversa normal.
2. Responde um JSON: `{"tool","args"}` ou `{"reply"}`. Resposta fora do formato é tratada como **texto**, nunca como ação.
3. O backend valida nome e argumentos (tipos, tamanho, enum, argumentos desconhecidos) e **reverifica a permissão**.
4. **Uma ferramenta por turno**; o resultado não volta ao LLM, o que corta cadeias de *prompt injection*.
5. Ferramentas com `confirm` ficam **pendentes**: só executam com confirmação do **mesmo usuário**, **uma vez**, em até **2 minutos**, com a permissão revalidada.
6. Tudo é auditado.

### 🔒 Modo somente leitura (ligado por padrão)

A Yui **não pode apagar, gravar nem mover arquivos, nem executar programas**, e isso é imposto pelo backend:

- Cada ferramenta declara o que faz: `read` (consulta), `open` (abre pasta da allowlist), `execute` (inicia programas) ou `write` (altera arquivos). **Quem não declara é tratado como `write`**.
- Com `YUI_READ_ONLY` ligado (só o valor `false` desliga), o backend **nega `execute` e `write` para qualquer papel, inclusive o dono**. O LLM nem vê essas ferramentas, e a confirmação pendente é revalidada.
- Ferramentas **MCP** começam como `write`; só passam se listadas em `YUI_MCP_READ_ONLY`.
- **Vigia no código:** `tests/test-readonly.js` reprova o build se `tools.js` passar a usar qualquer API que apague, grave, mova ou execute comandos livres (`unlink`, `rm`, `writeFile`, `rename`, `exec`, `shell: true`...).

| Ferramenta | Acesso | No modo somente leitura |
|------------|--------|-------------------------|
| `system.info` | read | ✅ SO, CPU, RAM, uptime |
| `files.search` | read | ✅ busca **por nome** nas pastas autorizadas (`YUI_FILE_ROOTS`) |
| `projects.open` | open | ✅ abre um projeto da allowlist (`YUI_PROJECTS`) no editor |
| `apps.open` | execute | 🚫 bloqueada (inicia programas) |
| `commands.list` | read | ✅ lista os comandos cadastrados (`YUI_COMMANDS`) |
| `commands.run` | execute | 🚫 bloqueada; roda um comando cadastrado **pelo nome**, sem shell, com confirmação |

**Skills** (`skills/`): receitas em texto do dono que a Yui segue quando o pedido combina; só dono em DM/canal privado, sem ferramentas. Veja [Comandos e skills](COMANDOS_E_SKILLS.md).

As ferramentas do PC só existem com `YUI_TOOLS_PC_ENABLED=true`. Não há shell livre. Configuração em [YUI_API.md](YUI_API.md#-agent-e-ferramentas-do-pc).

### MCP

O Agent aceita ferramentas MCP, sempre como OWNER + canal privado + confirmação, e só as listadas em `YUI_MCP_ALLOW`. **O transporte MCP (stdio/HTTP) ainda não está implementado**: existe a ponte de permissões (`registerMcpTools`), falta o cliente.

### 💻 Código: o Jarvis dentro da Yui

O Projeto Jarvis queria ser um assistente pessoal controlado pelo PC. Em vez de manter uma segunda assistente, as boas partes dele (laço de agente com ferramentas, edição por `SEARCH/REPLACE`, modos de trabalho, busca no código) foram **portadas para o Core** (`src/core/dev`), com os bugs e furos de segurança corrigidos (análise em `D:\Projetos\Projeto Jarvis\Yui Desktop\docs\ANALISE_JARVIS.md`). A interface é a **aba Código do mesmo app**; a **Yui Desktop** é só a janela dele no computador. Guia: [Código](CODIGO.md).

Diferenças deliberadas em relação ao Agent do chat (seção acima), porque ler e editar código exige vários passos:

| | Agent do chat | Código |
|---|---------------|--------|
| Passos por pedido | Uma ferramenta | Até `YUI_DEV_MAX_STEPS` (12) |
| Resultado volta ao modelo | Não | **Sim**, marcado como **dado** (nunca como ordem) |
| Onde atua | Ferramentas da allowlist | Só **projetos da lista**, sem sair da pasta, sem arquivos sensíveis |
| Gravar / rodar comando | Exige confirmação (e `YUI_READ_ONLY=false`) | Exige **aprovação a cada ação, no computador** (e `YUI_READ_ONLY=false`) |
| Quem usa | OWNER em DM/canal privado | **Só o dono**, pelo app |
| IA | Cadeia da Yui | LM Studio e Gateway, sempre `sensitive` (nunca provedor anônimo) |

Mantém o princípio 5: **somente leitura por padrão**, imposto no backend.

---

## 🧩 7. IA: AI Manager e Gateway

O **AI Manager** (`src/core/ai/manager.js`) expõe `chat()` e delega a um backend (`AI_BACKEND`):

| Backend | O que é |
|---------|---------|
| `legacy-chain` (padrão) | A cadeia do `llmHandler.js`: **LM Studio → Yui Gateway** → Hugging Face → Groq → Gemini → Cloudflare → Pollinations → Horde |
| `gateway` | O Yui Gateway em processo |
| `openai-compatible` | Qualquer endpoint `/chat/completions` (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`): LM Studio, llama.cpp, OmniRoute, OpenRouter... |

- **Yui Gateway:** servidor de IA próprio com failover, rodízio de chaves e descanso progressivo. Veja [GATEWAY.md](GATEWAY.md).
- **Privacidade da nuvem:** como a nuvem é permitida, o contexto pessoal pode ir ao provedor; por isso só os N resultados relevantes são enviados, **conversas sensíveis nunca vão a provedores anônimos**, e `AI_PRIVATE_LOCAL_ONLY=true` faz o Manager **recusar** contexto pessoal em backend que não seja local. `AI_BASE_LOCAL=true` só deve ser marcado se o modelo realmente roda na sua máquina: **um gateway local que encaminha para a nuvem não é local**.
- **OmniRoute** (de terceiros) continua possível como `openai-compatible`; usa ~540 MB de RAM, serve para a Yui pública e não para contexto pessoal.
- **Pesquisa na web e dado não confiável:** o resultado da busca e o texto das páginas entram no prompt como **dado**, cercados por uma marca de "dados externos não confiáveis" que a página não consegue forjar, e naquela chamada a IA fica **sem ferramentas** (uma página não consegue disparar download, imagem ou busca). Conversa **sensível** (DM de qualquer pessoa, canal privado do dono ou app) **não pesquisa por padrão** (`YUI_PRIVATE_SEARCH=off`: a Yui responde "Não pesquiso na web numa conversa privada.") e nunca usa provedor anônimo. Com `owner` (só o dono) ou `all` (qualquer pessoa) ela pesquisa, mas só em pedido **explícito**, com a consulta feita **só do texto literal da mensagem** (nunca histórico, memória ou contexto pessoal), sem dado pessoal nem palavra proibida, com a síntese marcada como sensível e sem o texto da consulta no log; o histórico e o contexto por horas guardam só uma linha neutra, nunca o resultado. Cada pessoa tem 5 pesquisas por hora (`YUI_SEARCH_USER_PER_HOUR`, o dono também conta), o servidor inteiro tem 20 por hora (`YUI_SEARCH_GLOBAL_PER_HOUR`) e Brave e Tavily têm teto mensal de 900 (contador em `secrets/search-budget.json`). Provedor bloqueado ou sem cota descansa (1, 2, 4... até 30 min; cota esgotada, 1 h) e a cadeia segue para o próximo. A chave "texto-modelo" (menos de 10 caracteres, como `opcional`) é ignorada e o painel de integrações mostra isso. Detalhes em [Comandos e skills](COMANDOS_E_SKILLS.md#-4-busca-na-web).
- **Agente de pesquisa (a Yui nunca mais "só promete pesquisar"):** o laço consulta, buscadores, leitura de até 2 páginas e síntese é do **código** (`src/handlers/researchAgent.js` e `searchIntent.js`), não do modelo. Todo pedido termina em resposta com fontes, resumo com links (sem IA) ou mensagem com o motivo, dentro de um prazo de 60 s. É o mesmo agente em todas as entradas: menção, nome da Yui ou resposta a ela, DM, `/yui`, `+yui perguntar` e o **app/API** (`/v1/chat` e `/v1/agent`, pelo AI Manager em `src/core/ai/manager.js`; no app e na DM de qualquer pessoa a pesquisa vale o `YUI_PRIVATE_SEARCH`, porque ambos são conversa privada para a pesquisa). Quatro "portas" ligam o agente: **A** (pré-rota, desligada por padrão: pedido explícito e estrito pesquisa sem a primeira chamada ao modelo), **B** (o modelo chama `search_web`), **C** (a resposta só promete pesquisar: vira pesquisa, cotação, recusa honesta ou pergunta do assunto) e **D** (guarda final: promessa que sobrou nunca é entregue nem guardada no histórico). Por voz a Yui recusa com honestidade, e a conversa espontânea nunca pesquisa. O texto da web é dado: a síntese roda sem ferramentas, busca, histórico nem memória, os links da resposta são colocados pelo código e menções e domínios soltos são neutralizados. Variáveis `YUI_RESEARCH_*` e `YUI_PRIVATE_SEARCH` em [Variáveis de ambiente](ENVIRONMENT.md#-agente-de-pesquisa).

---

## 🎭 8. Personalidade por contexto

Uma Yui, com tom diferente conforme **quem fala e onde** (`src/core/persona.js`, decidido pelo backend):

| Contexto | Perfil |
|----------|--------|
| Dono em **DM, canal privado ou no app** | **Pessoal:** assistente calorosa, direta, concisa e honesta. Chama você pelo nome (`YUI_OWNER_NAME`), admite que é uma IA, sabe a data e a hora de Brasília, dá **uma** recomendação clara, não termina com perguntas genéricas e não usa gírias |
| Outros usuários da **API** | **Assistente neutra:** sem o nome do dono e sem dados pessoais |
| **Discord público** (qualquer usuário, e o dono em canal público) | **Pública:** texto em `persona/yui-publica.md` (gamer da turma, humor leve, curte jogos em geral e só fala de GTA quando o assunto é GTA) |

Regras do perfil pessoal: nunca inventar fatos ou ações; só dizer que fez algo no computador se uma ferramenta confirmou; perguntar **uma** coisa curta quando for ambíguo; recusar o perigoso oferecendo uma alternativa segura; usar lembranças só quando relevantes. **Ninguém é chamado de "assistente" ou "IA" por conta própria**: a Yui não se apresenta assim em nenhum perfil e só admite ser uma IA, em uma frase, se perguntarem a sério. A personalidade pública é um arquivo (`YUI_PERSONA_PUBLIC_FILE`, relido ao ser alterado) e foi enxugada para gastar poucos tokens; o contexto de GTA (dados do dia, conhecimento) só entra nas perguntas sobre GTA. Para personalizar o perfil pessoal, aponte `YUI_PERSONA_PERSONAL_FILE` para um arquivo seu (`{nome}` vira o nome do dono; só vale para o dono).

---

## 🔑 9. Entrada, API e painel

Detalhes e rotas em [YUI_API.md](YUI_API.md). Em resumo:

- **Entrada nos apps:** usuário e senha (hash scrypt) **ou** chave de uso único (5 min) enviada por **DM no Discord**; resulta em uma **sessão temporária**. O app não pede endereço do servidor: ele é configuração do build.
- **Proteções do login:** comparação em tempo constante, erro genérico, atraso nas falhas, bloqueio após 5 erros em 15 min, pedidos de chave limitados a 3 por 10 min.
- **Painel de administração** (aba **Admin**, só o dono): visão geral, **integrações** (o que está ligado ou falta configurar), servidores (AutoMod, **canais** e **seguidos** de YouTube/Twitch, editáveis), **rádio**, banimentos (não permite banir o dono), memória (só metadados), **IA** (chaves, provedores próprios como o OmniRoute, ordem na fila, teste), auditoria, **logs** (segredos mascarados), ferramentas, **mensagem no meu Discord** e reinício. A Yui também **avisa o dono por DM** quando algo dá errado (veja [Operação](OPERACAO.md)).
- **O que o painel nunca controla:** o modo somente leitura, a senha e os tokens de acesso. Só mudam no `.env`. As **chaves de IA** podem ser adicionadas pelo painel (só entram, nunca voltam; `YUI_PANEL_AI_EDIT=false` trava).

---

## 🛡️ 10. Modelo de ameaças

| Ameaça | Mitigação |
|--------|-----------|
| Usuário pede a memória do dono por prompt | Escopo decidido por `buildContext`; banco pessoal inacessível fora de OWNER + DM/privado |
| Dono "imitado" por nome ou apelido | Identidade só pelo User ID da plataforma |
| Vazamento em canal público | Em canal público o dono usa memória pública e a persona original |
| Prompt injection (web, arquivo, mensagem, resultado de ferramenta) | Conteúdo externo é dado; uma ferramenta por turno; resultado não volta ao LLM; ferramentas sensíveis exigem OWNER + canal privado + confirmação |
| Texto da web (busca ou página) dando ordens à Yui | O texto entra cercado por uma marca de "dados externos não confiáveis" que a página não consegue forjar, e naquela chamada a IA fica sem ferramentas |
| Anexo de texto (`.txt`, `.md`, `.log`) com instruções escondidas | Só `.txt`, `.md` e `.log` do CDN do Discord (host conferido antes de baixar, sem redirecionamento), até 3 arquivos, 100 KB e 12000 caracteres; o conteúdo entra cercado como dado não confiável, a IA fica **sem ferramentas** naquela chamada (o arquivo não consegue acionar banimento, download etc.), o texto do arquivo não vai ao `historico.txt`, ao alerta de conteúdo suspeito nem a provedores anônimos, e a busca e o AutoMod por palavras olham só a fala digitada |
| Página com HTML hostil travando a Yui | Os blocos `<script>` e `<style>` são tirados e o resto do HTML é cortado (300000 caracteres e 20000 tags); a análise roda numa worker thread com prazo de 1,5 s (estourou, a worker é encerrada e a página é ignorada). Uma fila de até 10 páginas espera a worker; o excedente vira "sem conteúdo" na hora |
| Leitura de páginas alcançando a rede interna (SSRF) | Só `http`/`https`; IP privado, local, CGNAT (Tailscale) e reservado são bloqueados no DNS, na conexão e em cada redirecionamento (máximo 3); corpo lido com limite de bytes |
| Pergunta privada saindo para buscadores | Conversa sensível não pesquisa por padrão (`YUI_PRIVATE_SEARCH=off`). Liberada, só pesquisa em pedido explícito, com a consulta feita só do texto literal da mensagem, filtro de dados pessoais e de palavras proibidas, síntese sem provedor anônimo e log sem a consulta. Limite por pessoa (5 por hora), teto global (20 por hora) e teto mensal por provedor. **Risco aceito ao usar `all`:** o pedido de qualquer pessoa sai para buscadores de terceiros e os Termos de Uso não foram atualizados |
| A IA promete pesquisar e não pesquisa ("Vou pesquisar isso!") | Guarda de promessa e guarda final (`YUI_RESEARCH_GUARD`): vira pesquisa de verdade, recusa honesta ou um aviso, e a promessa nunca é entregue nem guardada no histórico |
| Link de download com injeção de comando | O link é parseado e reconstruído a partir do ID; `yt-dlp`, `spotdl` e `deemix` rodam por `execFile` com lista de argumentos, sem shell, com tempo, tamanho e duração limitados e uma pasta temporária por pedido |
| ARL do Deezer ou chaves vazando para processos filhos e logs | O ARL vai por variável de ambiente (nunca na linha de comando nem no log); o ambiente do filho não leva variáveis com TOKEN, KEY, SECRET, PASSWORD, COOKIE ou PRIVATE; o usuário só vê mensagens curtas |
| `/chat_resumo` tratando mensagens de terceiros como ordem | O log do canal entra como registro de terceiros (dado), sem ferramentas, sem memória e sem gravar no `historico.txt` |
| Execução ou alteração arbitrária no PC | Somente leitura imposto no backend; allowlists; sem shell livre; vigia de código nos testes; auditoria |
| Código: instrução escondida em arquivo, página ou saída de comando | Tudo isso entra marcado como dado; comandos perigosos negados sempre; gravar e rodar comando exigem aprovação a cada vez; a política é do backend, não do modelo |
| Código: aprovar de longe (celular, sessão roubada) | Aprovação e cadastro de projetos só valem se o pedido vier **do próprio PC** (pedido por proxy/Tailscale conta como remoto e fica somente leitura) |
| Código: ler segredos ou sair do projeto | `.env`, chaves e certificados nunca lidos; `path.relative` + `realpath`; projeto não pode ser a raiz do disco, a pasta pessoal nem `.ssh`/`.aws`; conteúdo vai só para IA marcada `sensitive` |
| Força bruta no login | Hash scrypt, bloqueio global, atraso, erro genérico, sessões que expiram |
| Encher a DM do dono com chaves | Máximo de 3 pedidos por 10 min; a chave nunca volta na API |
| Painel comprometido | Não altera somente leitura, senha nem chaves; não bane o dono; ações auditadas |
| Roubo de token ou sessão | Token por dispositivo; sessões de 12 h revogáveis; API só em `127.0.0.1` + Tailscale; sem Funnel |
| Dados pessoais no GitHub | `database/memory-*.db` e auditoria no `.gitignore`; revisar `git status` antes do push |
| Dados de terceiros retidos | 30 dias, exclusão pelo próprio usuário, aviso no TOS. O contexto por horas é desligado por padrão, só do dono, com prazo por idade da fala e apagável por `/yui-memoria apagar-tudo`; o `historico.txt` ainda não tem política de retenção (veja as pendências) |
| Provedor de IA vê contexto pessoal | Só o relevante; nunca a anônimos; `AI_PRIVATE_LOCAL_ONLY` quando houver IA local |
| PC desligado | Core único: a Yui fica offline (decisão aceita) |

---

## 🗺️ 11. Fases e estado atual

| Fase | Entrega | Estado |
|------|---------|--------|
| 1 | Separar o Core do Discord | ✅ `src/core` independente, `discordAdapter.js` faz a ponte |
| 2 | Usuários e permissões | ✅ |
| 3 | Memória temporária por usuário | ✅ |
| 4 | Memória permanente do dono | ✅ |
| 5 | Integração com o Discord + `/yui-memoria` | ✅ |
| 6 | Yui API + AI Manager | ✅ |
| 7 | Agent, ferramentas e ponte MCP | ✅ (transporte MCP pendente) |
| 8 | App Android e web | ✅ `apps/yui-app` (chat com confirmação, memória, status, painel) |
| 9 | Tailscale e acesso remoto | ✅ API publicada em HTTPS só na tailnet |
| + | Somente leitura, persona, login e chave por DM, painel, Gateway de IA, Core único no PC | ✅ |
| 10 | Código (Jarvis dentro da Yui) + Yui Desktop | ✅ aba Código, `/v1/dev/*`, janela Electron. Testado com IA simulada e na tela; o uso com modelo real depende do seu LM Studio/Gateway |

**Em produção no PC:** bot do Discord, memória, API (`:3939`), app web (`:8081`) e Gateway (`:20130`), com reinício automático. Veja [Operação](OPERACAO.md).

**Testes:** mais de 2.900 verificações automáticas, todas offline: as do Core (Core 21, API 12, Agent 21, somente leitura 15, painel 58, Gateway 42, persona 17, menções 17, configuração 5, avisos 24, pesquisa 56, Código 61, Weekly e app 23), as das correções de outubro de 2026 (downloads 150, Deezer 67, spotdl 105, leitura segura de páginas 24, segurança da IA 53, respostas longas 89, contexto por horas 63, voz 68, motor do YouTube 18, fala TTS 974 e integração das pendências 35 de 36, com uma asserção velha sobre o prazo do deemix), as dos limites de textos grandes (embeds 63, limite de anexo 20, entradas 44, leitura de páginas 42, respostas longas 50, anexos de texto 66, painéis 64, publicações 57, banco 14, HTTP 413 21, ajuste de áudio 37, fila e IA 69 e interações 56) e as do agente de pesquisa (detectores 55, agente 70, fila 77, entradas fora da fila 72, textos de ferramentas 44 e sobras da rodada final 40). Lista e comandos em [README_TESTES.md](../../README_TESTES.md).

---

## ❓ Pendências

1. **Streaming** (SSE) na API e no app: hoje a resposta aparece inteira ao final.
2. **Transporte MCP** (stdio/HTTP) e o primeiro servidor (Whisper).
3. **App em aparelho físico**, APK assinado, notificações e voz. A casca de desktop já existe (**Yui Desktop**, Electron, mostra o mesmo app); faltam aprovações nativas do Windows nela.
4. **Backup cifrado** de `memory-personal.db`.
5. **TOS:** incluir texto sobre a retenção de 30 dias e como apagar a memória e, antes de ligar o contexto por horas para todos (`YUI_CONTEXT_SCOPE=all`), sobre as falas guardadas por algumas horas. O texto legal (`tosHandler.js`) é decisão do dono e não foi alterado.
6. **Papéis TRUSTED/GUEST:** existem, mas só ganham função quando houver ferramentas que os justifiquem.
7. **Embeddings** para a busca de memória (quando houver IA local).
8. **VPS da AWS:** encerrar a instância e apagar o `.env` dela ([Operação](OPERACAO.md#-8-a-vps-da-aws)).
9. **Dados no repositório:** `database/*.db` (exceto os de memória) são versionados; avaliar tirá-los do Git. O mesmo vale para `apps/yui-app/logs/` (incluindo o `core-audit.jsonl` do app), que já foi para o GitHub: o `.gitignore` agora ignora a pasta, mas quem já está rastreado só sai com `git rm --cached` (decisão e comando do dono).
10. **Ferramentas de escrita:** se um dia forem necessárias (ex.: organizar arquivos), o caminho é uma ferramenta `write` com lista de pastas, confirmação obrigatória e `YUI_READ_ONLY=false` como decisão explícita.
11. ✅ **Fala (TTS) na call: feito.** O módulo `src/services/tts/` (voz do Windows) está ligado ao `voiceHandler`, ao `llmHandler` e à inicialização (`src/discord/client.js`) e tem 974 verificações offline. Para usar: reinicie a Yui e ligue **🔊 Resposta por Voz (TTS)** no servidor (vem desligado); passo a passo no [guia de TTS](TTS.md). O teste numa call real continua na pendência 16. Piper e Edge (nuvem) ficaram para depois. Veja também [Variáveis de ambiente](ENVIRONMENT.md#-fala-da-yui-na-call-tts-local).
12. **Contexto por horas:** falta o teste real (ligar `YUI_CONTEXT_ENABLED=true`, reiniciar, conversar na DM, conferir `database/memory-context-personal.db` e testar `/yui-memoria apagar-tudo`) e ligar a limpeza ao sair de um servidor (`forgetGuildContext`) e ao banir um usuário: as funções existem, mas nenhum evento as chama ainda. O histórico em RAM por usuário da API (`core/api/server.js`) é outro mecanismo e fica fora do contexto por horas.
13. **`historico.txt`:** o registro de uso do bot continua gravando o restante das conversas e não tem política de retenção; nenhum comando o apaga. A decisão do prazo é do dono.
14. **Recados de membros para o dono:** decisão de privacidade pendente; não implementado.
15. **Downloads:** `/baixar_video` e a ferramenta `download_video` da IA apagam só o arquivo (a pasta vazia do pedido é varrida pela faxina periódica); links de álbum, playlist e artista do Spotify são recusados porque não há como limitar o `spotdl` a uma faixa de forma comprovadamente segura; o `spotdl` já está instalado no ambiente `.venv-spotdl` e, como o `deemix`, é conferido na inicialização (linhas `[MediaTools] Spotdl` e `[MediaTools] Deemix` no log); só o `deemix` aparece no painel de integrações.
16. **Testes no Discord real:** respostas longas divididas (ordem das partes em canal público, DM e `/yui` privado, e o anexo `.md`), plano B do Deezer, MP3 acima de 10 MB sendo recomprimido, leitura de anexo `.txt`/`.md`/`.log`, o download real de uma faixa do Spotify pelo `spotdl`, `/entrar-call` com Opus, o aviso de playlist nos downloads e a fala da Yui na call (checklist em [Operação](OPERACAO.md#-11-checklist-da-fala-tts)) só foram verificados com dublês.
17. **Pesquisa na web, uso real:** o agente de pesquisa foi testado só com dublês (sem buscador, sem IA e sem Discord de verdade). Falta reiniciar a Yui, acompanhar as linhas `[Pesquisa]` do log por alguns dias (com `YUI_RESEARCH_GUARD=observe`, se quiser só olhar), pedir uma pesquisa por menção, `/yui`, DM e pelo app, e só então ligar `YUI_RESEARCH_PRE_ROUTE=true`. Se `YUI_PRIVATE_SEARCH=all` ficar ligado, falta decidir se os Termos de Uso devem citar que o pedido de pesquisa sai para buscadores de terceiros (o `tosHandler.js` não foi alterado; veja o [aviso de privacidade](ENVIRONMENT.md#-privacidade-da-pesquisa-em-conversa-privada)).
