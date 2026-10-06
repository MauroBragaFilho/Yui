# 🧠 Yui — Evolução para Assistente Pessoal

Este documento descreve a evolução da Yui de **bot de Discord** para **assistente pessoal**, mantendo o Discord como interface oficial. É o documento de referência da arquitetura: decisões, princípios, modelo de segurança e fases de desenvolvimento.

> **Status:** Fases 1–8 entregues: Core, memória, integração com o Discord, AI Manager, Yui API, Agent com ferramentas e o **app** (Android + web) em [`apps/yui-app`](../../apps/yui-app/README.md). A Yui já roda só no PC. Falta ligar o Agent ao Discord, o transporte MCP e a casca de desktop; a Fase 9 está documentada em [YUI_API.md](YUI_API.md). Veja [Estado atual](#-estado-atual).

---

## 📂 Sumário

1. [Visão geral](#-1-visão-geral)
2. [Decisões de projeto](#-2-decisões-de-projeto)
3. [Arquitetura](#-3-arquitetura)
4. [Permissões](#-4-permissões)
5. [Memória](#-5-memória)
6. [Agent / camada JARVIS e ferramentas](#-6-agent--camada-jarvis-e-ferramentas)
7. [IA: nuvem hoje, local no futuro](#-7-ia-nuvem-hoje-local-no-futuro)
8. [Modelo de ameaças](#-8-modelo-de-ameaças)
9. [API, apps e acesso remoto](#-9-api-apps-e-acesso-remoto)
10. [Fases de desenvolvimento](#-10-fases-de-desenvolvimento)
11. [Estado atual](#-estado-atual)
12. [Configuração](#-configuração-env)
13. [Pendências e questões em aberto](#-pendências-e-questões-em-aberto)

---

## 🎯 1. Visão geral

Existe **uma única Yui**, com um único **Yui Core** responsável por: personalidade, memória, contexto, gerenciamento de IA, ferramentas, permissões, automações, MCP e gerenciamento de usuários.

Discord, aplicativo mobile e aplicativo desktop são apenas **interfaces** para esse mesmo núcleo. Uma conversa iniciada no Discord pode continuar no app, e uma tarefa iniciada no app pode ser consultada no Discord.

### Princípios

1. Uma única Yui, um único Core.
2. O Discord continua sendo uma interface oficial.
3. Apps mobile/desktop são opcionais e são só clientes.
4. A **autorização é decidida pelo backend**, nunca pelo LLM.
5. Memória dos usuários do Discord é temporária; a do proprietário é permanente.
6. Memória pessoal e pública são isoladas (bancos separados).
7. Ferramentas têm níveis de autorização e **são negadas por padrão**.
8. O modelo de IA é intercambiável (nuvem agora, local depois).
9. MCP continua suportado.
10. Evolução incremental: **a Yui atual nunca deve parar de funcionar**.

---

## ✅ 2. Decisões de projeto

| # | Tema | Decisão |
|---|------|---------|
| 1 | Número de Cores | **Um único Core**, rodando no PC do proprietário (normalmente ligado). |
| 2 | Yui pública x pessoal | Mesmo Core; muda apenas papel, permissões e escopo de memória. |
| 3 | Memória sensível no Discord | Só em **DM** e **canais privados** configurados. Em canais públicos, o dono é tratado com a memória de usuário comum. |
| 4 | IA | **Nuvem permitida** por enquanto (hardware ainda limitado para IA local). IA local é plano futuro, via AI Manager. |
| 5 | Ferramentas do PC | Funcionarão com sistemas de proteção (allowlist, confirmação, auditoria). |
| 6 | Hospedagem | Hoje a Yui roda em uma VPS AWS (acesso SSH está indisponível — ver [Pendências](#-pendências-e-questões-em-aberto)). A tendência é migrar para o PC. |

---

## 🏗️ 3. Arquitetura

```
                       ┌─────────────────────┐
                       │      YUI CORE       │
                       │  Permissões         │
                       │  Memória            │
                       │  Contexto           │
                       │  AI Manager         │
                       │  Agent / JARVIS     │
                       │  Ferramentas + MCP  │
                       └──────────┬──────────┘
                                  │
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
           Discord Adapter    Mobile App      Desktop App
                 │                │                │
                 └────────────────┴────────────────┘
                              Yui API
```

Regra de dependência: **adaptadores dependem do Core; o Core nunca depende de um adaptador.**

Fluxo de uma mensagem:

```
Mensagem (plataforma + userId + canal)
   ↓
buildContext()  →  papel + tipo de canal + escopo de memória   (backend)
   ↓
Recall da memória do ESCOPO permitido
   ↓
Prompt (personalidade + memória + mensagem)  →  LLM
   ↓
Se o LLM pedir uma ferramenta → checkToolAccess()  (backend) → executa → audita
   ↓
Resposta
```

### Estrutura de código

```
src/core/
├── index.js            # ponto único de entrada do Core
├── permissions.js      # papéis, tipo de canal, escopo de memória, política de ferramentas
├── audit.js            # auditoria append-only (logs/core-audit.jsonl)
├── discordAdapter.js   # ponte Discord → Core (contexto, bloco de memória, captura)
├── memory/
│   ├── schemas.js      # esquemas SQL
│   └── store.js        # remember / recall / forget / purge
├── ai/manager.js       # AI Manager: backends plugáveis
├── agent/
│   ├── agent.js        # loop do Agent (decide → valida → permite → confirma → executa)
│   └── tools.js        # registro de ferramentas, allowlists, ponte MCP
└── api/server.js       # Yui API (HTTP)
```

Bancos (em `database/`, via o `initDatabase` já existente):

| Banco | Conteúdo | Retenção |
|-------|----------|----------|
| `memory-personal.db` | memória do proprietário | permanente |
| `memory-discord.db`  | memória dos demais usuários | 30 dias após a última interação |

> ⚠️ Estes arquivos contêm dados privados e estão no `.gitignore` (`database/memory-*.db`). Os demais `.db` do projeto continuam versionados como antes.

---

## 🔐 4. Permissões

Papéis (do mais alto ao mais baixo):

| Papel | Quem | Pode |
|-------|------|------|
| `OWNER` | ID em `YUI_OWNER_ID` / `OWNER_ID` / `OWNER_IDS` | Tudo autorizado; memória pessoal; ferramentas do PC (em DM/canal privado) |
| `TRUSTED` | IDs em `YUI_TRUSTED_IDS` | Ferramentas específicas e memória limitada |
| `MEMBER` | qualquer outro usuário | Comandos públicos e memória temporária |
| `GUEST` | sem identificação | Acesso mínimo |
| `BLOCKED` | usuários banidos (sistema de bans existente) | Nada, inclusive memória |

### Escopo de memória (decidido pelo backend)

| Papel | DM | Canal privado | Canal público |
|-------|----|---------------|---------------|
| OWNER | pessoal | pessoal | **pública (como usuário comum)** |
| demais | pública | pública | pública |

Canais privados são listados em `YUI_PRIVATE_CHANNEL_IDS`. Quem decide isso é o dono, não a IA.

### Ferramentas

- Cada ferramenta é registrada com `registerToolPolicy(nome, { minRole, privateOnly, confirm })`.
- **Sem política registrada = negada** (default deny).
- A partir de `TRUSTED`, `privateOnly` é `true` por padrão (não roda em canal público).
- `confirm: true` exige confirmação explícita do usuário antes de executar.

---

## 🧠 5. Memória

A memória é **estruturada**, não um histórico colado no prompt.

Cada registro tem: `tipo` (`fact`, `preference`, `project`, `decision`, `summary`, `note`), `conteúdo`, `tags`, `origem`, `importância (1–5)` e datas.

### Memória temporária (usuários do Discord)

```
Usuário interage → memória atualizada → last_seen = agora
→ expires_at = agora + 30 dias (renovado a cada interação)
→ 30 dias sem interação → expira (purgeExpired())
```

- O usuário pode **ver e apagar** a própria memória (`listMemories`, `forget`, `forgetAll`).
- **Administração (somente o dono):** `/yui-criador memorias` com as ações *listar* usuários com memória, *ver* os metadados de um usuário, *apagar* uma lembrança e *apagar tudo* de um usuário. Mostra **só metadados** (quem, quantas, última interação, expiração, tamanho e origem) e **nunca o conteúdo**; a memória pessoal do dono fica fora do alcance. A checagem de dono é feita no comando e repetida no backend (`adminListUsers` etc.), e toda ação é auditada. Para inspeção direta, use `sqlite3 -readonly database/memory-discord.db`. Os comandos de usuário (ex.: `/yui-memoria`) serão criados na integração com o Discord e devem ser citados no TOS.

### Memória permanente (proprietário)

Preferências, projetos, decisões e informações que o dono pedir para guardar. Nunca expira e fica em banco separado.

### Busca (recall)

1. Tokeniza a pergunta (sem acentos, sem stopwords).
2. Busca nos campos de conteúdo/tags **apenas no banco do escopo permitido**.
3. Ordena por: acertos de termos × 3 + importância + recência.
4. Injeta no prompt só os N resultados (padrão 8).

> O `sql.js` não possui FTS5; por isso a busca é por termos. Embeddings (gerados por um modelo local ou de nuvem) são uma evolução futura, sem mudar a API.

### Garantias

- O escopo vem de `ctx.memoryScope`; **não existe parâmetro** para o chamador ou LLM escolher outro banco.
- Usuário bloqueado: leitura e escrita lançam erro.
- Todo acesso à memória pessoal gera um evento em `logs/core-audit.jsonl` (somente metadados, nunca o conteúdo).

---

## 🤖 6. Agent / camada JARVIS e ferramentas

A Yui deixa de só responder e passa a **executar tarefas autorizadas**:

```
Mensagem → LLM interpreta intenção → Agent escolhe ferramenta
        → Permission Layer verifica → ferramenta executa → Yui informa
```

Ferramentas planejadas:

```
PC         abrir/fechar programas, consultar hardware, executar ações pré-definidas
ARQUIVOS   pesquisar, copiar, mover, organizar (somente pastas autorizadas)
MÍDIA      yt-dlp, FFmpeg, Whisper
PROJETOS   BDS, LAC, Yui
IA         LM Studio, modelos locais, MCP
INTERNET   pesquisa, APIs autorizadas
```

### Proteções para ferramentas do PC

- **Allowlist de ações**, não "executar qualquer comando": ex. `abrir_projeto("BDS")` resolve o caminho em uma tabela configurada.
- **Pastas autorizadas** para operações de arquivo (path traversal bloqueado).
- **Confirmação** para ações destrutivas (apagar, mover em massa, fechar processos).
- **Auditoria** de toda execução.
- **Anti prompt-injection:** texto vindo de web, arquivos, mensagens de terceiros ou saída de ferramentas é *dado*, nunca instrução. Uma ação sensível só roda se o pedido veio do usuário OWNER no canal certo.
- Execução de comando livre (shell) fica **desativada** até existir sandbox e confirmação obrigatória.

### 🔒 Modo somente leitura (ligado por padrão)

A Yui **não pode apagar, gravar nem mover arquivos, nem executar programas**. Isso é imposto pelo backend, não pelo modelo:

- Cada ferramenta declara o que faz: **`read`** (consulta), **`open`** (abre uma pasta da allowlist), **`execute`** (inicia programas) ou **`write`** (altera arquivos).
- Quem **não declara** é tratado como `write` (o mais restritivo): ferramenta nova nunca escapa por esquecimento.
- Com `YUI_READ_ONLY` ligado (padrão; só o valor `false` desliga), o backend **nega `execute` e `write` para qualquer papel, inclusive o dono**, antes de rodar qualquer coisa. O LLM nem vê essas ferramentas no prompt, e a confirmação de uma ação pendente é revalidada.
- Ferramentas **MCP** começam como `write` (efeito desconhecido). Só passam se você as declarar de leitura em `YUI_MCP_READ_ONLY`.
- **Vigia no código:** `tests/test-readonly.js` reprova o build se `src/core/agent/tools.js` passar a usar qualquer API que apague, grave, mova ou execute comandos livres (`unlink`, `rm`, `writeFile`, `rename`, `exec`, `shell: true`...). As únicas chamadas de arquivo permitidas ali são `existsSync` e `readdirSync`.

| Ferramenta | Acesso | No modo somente leitura |
|------------|--------|-------------------------|
| `system.info` | read | ✅ permitida |
| `files.search` | read | ✅ permitida |
| `projects.open` | open | ✅ permitida (só abre a pasta no editor) |
| `apps.open` | execute | 🚫 bloqueada |

### Implementação (Fase 7)

`runAgent(ctx, mensagem)` em `src/core/agent/agent.js`:

1. O LLM só vê as ferramentas que **aquele contexto** pode usar; se não houver nenhuma, é conversa normal.
2. O LLM responde um JSON: `{"tool","args"}` ou `{"reply"}`. Resposta fora do formato é tratada como **texto**, nunca como ação.
3. O backend valida nome e argumentos (tipos, tamanho, enum, argumentos desconhecidos) e **reverifica a permissão**.
4. **Uma ferramenta por turno**; o resultado não volta ao LLM, o que corta cadeias de *prompt injection*.
5. Ferramentas com `confirm` ficam **pendentes**: só executam com confirmação do **mesmo usuário**, **uma vez**, em até **2 minutos**, com a permissão revalidada.
6. Tudo é auditado. Referência das ferramentas e do `.env`: [YUI_API.md](YUI_API.md#-agent-e-ferramentas-do-pc).

### MCP

O Agent consome ferramentas internas **e** MCP (ex.: Whisper + LM Studio). Ferramentas MCP também passam pela Permission Layer. A ponte (`registerMcpTools`) já existe: só entram as listadas em `YUI_MCP_ALLOW`, sempre como OWNER + canal privado + confirmação. **O transporte MCP (stdio/HTTP) ainda não foi implementado** e exige adicionar o SDK do MCP.

---

## 🧩 7. IA: nuvem hoje, local no futuro

O **AI Manager** (`src/core/ai/manager.js`) expõe `chat()` e delega a um *backend* plugável (`registerBackend`, `AI_BACKEND`):

| Backend | O que é |
|---------|---------|
| `legacy-chain` (padrão) | A cadeia atual do `llmHandler.js` (LM Studio → HF → Groq → Gemini → Cloudflare…) |
| `openai-compatible` | Qualquer endpoint `/chat/completions`: LM Studio, llama.cpp, OmniRoute, OpenRouter… (`AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`) |

Como a nuvem é permitida agora, o contexto de memória pessoal pode ir ao provedor. Mitigações: só os N resultados relevantes são enviados, e `AI_PRIVATE_LOCAL_ONLY=true` faz o Manager **recusar** contexto pessoal em backend que não seja local (`AI_BASE_LOCAL=true` só deve ser marcado se o modelo realmente roda na sua máquina — um gateway local que encaminha para a nuvem **não** é local).

### OmniRoute (gateway de IA gratuito)

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) é um gateway OpenAI-compatível (porta `20128`) que agrega dezenas de provedores, muitos com camada gratuita, com *failover* automático. Encaixa no backend `openai-compatible`.

- **Não é “gratuito sem configuração”.** O OmniRoute não tem modelos próprios: ele roteia para provedores que você conecta (chaves/OAuth). Existem pools sem autenticação, mas de qualidade e disponibilidade instáveis.
- **Não cabe na VPS atual.** Usa ~540 MB de RAM em repouso; a VPS tem 908 MB e o bot já ocupa ~200 MB.
- **Onde instalar:** no **PC**, junto com o Core, escutando em `127.0.0.1`.
- **Privacidade:** o gateway centraliza chaves e prompts e envia o conteúdo a provedores gratuitos de terceiros. Serve para a **Yui pública**; **não** use para contexto pessoal (mantenha `AI_PRIVATE_LOCAL_ONLY=true` assim que houver IA local).
- **Cuidados:** definir `INITIAL_PASSWORD` (o padrão do painel é `CHANGEME`), ativar `REQUIRE_API_KEY=true`, não expor a porta, e lembrar que usar contas/planos gratuitos via proxy pode violar os termos de alguns provedores.

Configuração no `.env` do PC:

```env
AI_BACKEND=openai-compatible
AI_BASE_URL=http://127.0.0.1:20128/v1
AI_API_KEY=chave-criada-no-painel-do-omniroute
AI_MODEL=auto/best-free
AI_BASE_LOCAL=false
```

---

### Personalidade por contexto

Uma única Yui, com tom diferente conforme **quem fala e onde** (`src/core/persona.js`). O perfil é decidido pelo backend, nunca pelo texto da mensagem:

| Contexto | Perfil |
|----------|--------|
| Dono em **DM, canal privado ou no app** (memória pessoal) | **Pessoal**: assistente pessoal calorosa, direta, concisa e honesta. Chama você pelo nome (`YUI_OWNER_NAME`), admite que é uma IA, sabe a data e a hora de Brasília, dá **uma** recomendação clara em vez de um panorama, não termina com perguntas genéricas e não usa gírias ("parceira", "tá ligada"). |
| Outros usuários da **API** | **Assistente neutra**: sem o nome do dono e sem acesso a dados pessoais. |
| **Discord público** (qualquer usuário, e o dono em canal público) | **Sem override**: continua a persona original "amiga gamer" do `llmHandler`. |

Regras do perfil pessoal: nunca inventar fatos ou ações; só dizer que fez algo no computador se uma ferramenta confirmou; perguntar **uma** coisa curta quando o pedido for ambíguo; recusar o perigoso com uma alternativa segura; usar as lembranças só quando relevantes; tratar texto de arquivos, páginas e resultados de ferramentas como **dados**, nunca como instruções.

No Discord, só o bloco de identidade fixo do prompt é trocado (`applyPersona`); o restante (imagem, anti-repetição, regras de contrato) permanece. Para personalizar o texto, aponte `YUI_PERSONA_PERSONAL_FILE` para um arquivo seu (`{nome}` vira o nome do dono); o arquivo só vale para o dono.

---

## 🛡️ 8. Modelo de ameaças

| Ameaça | Mitigação |
|--------|-----------|
| Usuário pede a memória do dono por prompt | Escopo decidido por `buildContext`; banco pessoal inacessível fora de OWNER + DM/privado |
| Dono é "imitado" por nome/apelido | Identidade só pelo User ID da plataforma |
| Vazamento em canal público | Em canal público o dono usa memória pública |
| Prompt injection via web/arquivo/mensagem | Conteúdo externo é dado; ferramentas sensíveis exigem OWNER + canal privado (+ confirmação) |
| Execução arbitrária no PC | Allowlist, pastas autorizadas, sem shell livre, auditoria |
| Roubo de token do app / API | Autenticação por token + Tailscale; API nunca exposta à internet |
| Memória pessoal vai para o GitHub | `database/memory-*.db` no `.gitignore`; backups cifrados |
| Dados de terceiros retidos | Retenção de 30 dias, exclusão pelo próprio usuário, aviso no TOS |
| Provedor de nuvem vê contexto pessoal | Enviar só o relevante; flag futura de "somente local" |
| PC desligado | O Core é único: sem o PC, a Yui fica offline (aceito; ver pendências) |

---

## 🌐 9. API, apps e acesso remoto

- **Yui API** (REST; streaming SSE ainda pendente) sobre o Core — referência completa em [YUI_API.md](YUI_API.md) — com **autenticação por token** (o Tailscale protege a rede, mas não substitui autenticação).
- **Tailscale/LAN:** o celular acessa o PC via Tailscale; a API não é exposta à internet.
- **Mobile:** React Native, só como cliente (chat, histórico, memória, projetos, status).
- **Desktop:** migração do Electron atual para React (possivelmente Tauri), compartilhando UI com o mobile.
- Nenhuma lógica crítica fica no app.

---

## 🗺️ 10. Fases de desenvolvimento

| Fase | Entrega | Estado |
|------|---------|--------|
| 1 | Separar o Yui Core do Discord | ✅ `src/core` independente; `discordAdapter.js` faz a ponte |
| 2 | Usuários e permissões | ✅ base pronta (`permissions.js`) |
| 3 | Memória temporária por usuário | ✅ base pronta (`memory/store.js`) |
| 4 | Memória permanente do proprietário | ✅ base pronta |
| 5 | Integrar o Core ao Discord (DM/privados) + comandos de memória | ✅ entregue (flag `YUI_MEMORY_ENABLED`) |
| 6 | API da Yui + AI Manager | ✅ entregue (`src/core/api`, `src/core/ai`); desligada por padrão |
| 7 | Agent/JARVIS + ferramentas + MCP | ✅ entregue (`src/core/agent`); transporte MCP pendente |
| 8 | App React Native (Android) e web/desktop | ✅ `apps/yui-app` (Expo): chat com confirmação de ações, memória e status; testado contra a API real e no navegador (desktop e viewport de celular). Falta rodar no aparelho físico e a casca Tauri/Electron |
| 9 | Tailscale e acesso remoto | ✅ API publicada em HTTPS **só na tailnet** (`tailscale serve`, porta 3939), com um token por dispositivo. Falta testar no celular (os Androids estavam offline) |

> A ordem foi ajustada em relação ao rascunho original: integrar com o Discord (5) vem antes da API (6), porque é onde a memória passa a ter uso real e valida o Core com tráfego verdadeiro.

### Fase 5 — o que foi integrado

- `src/core/discordAdapter.js`: `contextFromDiscord`, `buildMemoryBlock` e `captureFromUserText`.
- `llmHandler.js` (`processQueue`/`generateResponse`): monta o contexto, injeta o bloco de memória no *system prompt* e captura fatos da fala do usuário após responder. O bloco é rotulado como **dados, não instruções**.
- Captura **determinística** (sem chamada extra ao LLM, para não gastar cota): frases como “lembra que…”, “meu nome é…”, “eu gosto de…”. Só a fala do usuário é considerada, nunca a resposta da IA nem saída de ferramentas.
- Comando `/yui-memoria` (`ver`, `lembrar`, `esquecer`, `apagar-tudo`), sempre efêmero e sempre respeitando o escopo (pessoal só em DM/canal privado).
- `index.js`: `initMemory()` no bootstrap. `scheduler.js`: limpeza diária às 05:30 UTC.
- Com `YUI_MEMORY_ENABLED=false` (padrão) nada é gravado nem injetado.

---

## 📍 Estado atual

Testes (`npm run test:core`, `test:core-api`, `test:core-agent`): **46 verificações**, todas passando localmente e na VPS.

- **Core:** papéis, escopo de memória, política de ferramentas com *default deny*, memória pessoal/pública isoladas, auditoria.
- **Discord:** `/yui-memoria` e memória no prompt, ativos na VPS (`YUI_MEMORY_ENABLED=true`).
- **AI Manager + Yui API + Agent:** implementados, testados e **ativos no PC** (API em `127.0.0.1:3939`, publicada na tailnet por HTTPS). Ferramentas do PC ligadas com allowlists de projetos (BDS, LAC, Yui, Jarvis), busca de arquivos em `D:/Projetos` e abertura no VS Code. Em qualquer outra máquina elas continuam desligadas (`YUI_TOOLS_PC_ENABLED`).
- O chat real pela API foi validado na VPS com a cadeia de IA existente, em processo isolado e banco temporário.

---

## ⚙️ Configuração (`.env`)

```env
# Dono (o OWNER_ID/OWNER_IDS já existentes também são reconhecidos)
YUI_OWNER_ID=SEU_ID_DO_DISCORD

# Liga/desliga o sistema de memória (padrão: false)
YUI_MEMORY_ENABLED=true

# Retenção da memória dos usuários comuns, em dias
MEMORY_RETENTION_DAYS=30

# Canais privados onde a memória pessoal do dono pode ser usada (separados por vírgula)
YUI_PRIVATE_CHANNEL_IDS=

# Usuários com papel TRUSTED (separados por vírgula)
YUI_TRUSTED_IDS=

# IA (ver seção 7)
AI_BACKEND=legacy-chain        # ou openai-compatible
AI_PRIVATE_LOCAL_ONLY=false

# API e ferramentas do PC: ver YUI_API.md
YUI_API_ENABLED=false
YUI_TOOLS_PC_ENABLED=false
```

---

## ❓ Pendências e questões em aberto

1. **Acesso à VPS AWS.** O `Yui.bat` usa `ssh -i %USERPROFILE%\.ssh\Yui.pem ubuntu@ec2-…sa-east-1.compute.amazonaws.com`. A conexão falha hoje; é preciso diagnosticar (IP/DNS do EC2 pode ter mudado, *security group*, instância parada, rede local). Enquanto o Core for único no PC, definir o destino da VPS: desligar, ou manter só como espelho.
2. **Bot fora do ar com o PC desligado.** Aceito pela decisão de Core único; avaliar um aviso de status no Discord.
3. **Backups cifrados** de `memory-personal.db`.
4. **TOS:** incluir texto sobre retenção de 30 dias e como apagar a memória.
5. **Papéis TRUSTED/GUEST:** existem na camada de permissão, mas só ganham função quando houver ferramentas que os justifiquem.
6. **Embeddings** para a busca de memória (quando houver backend local).
7. **Streaming** (SSE) na API.
8. **Somente leitura:** hoje não existe nenhuma ferramenta de escrita. Se um dia for preciso (ex.: organizar arquivos), o caminho é uma ferramenta `write` com lista de pastas, confirmação obrigatória e `YUI_READ_ONLY=false` como decisão explícita.
8. **Transporte MCP** (stdio/HTTP) e o primeiro servidor (Whisper).
9. **App:** streaming (SSE), markdown nas mensagens, notificações, voz (Whisper), APK assinado, casca de desktop (Tauri exige Rust; Electron já é usado no Jarvis) e teste em aparelho físico (os Androids da tailnet estavam offline).
10. **Mover o bot do Discord para o PC** (Core único) e desligar a VPS ou mantê-la só como espelho.
11. **Arquivos sensíveis no repositório:** `Yui.pem` está no `.gitignore`, mas `database/*.db` (core etc.) é versionado e o `.env` contém tokens; revisar o que vai para o GitHub.
