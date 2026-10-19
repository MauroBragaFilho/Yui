# 🌐 Yui API

Interface HTTP do **Yui Core** para o app (Android e web) e para integrações. Código em `src/core/api/` (`server.js` rotas, `auth.js` login, `admin.js` painel). Visão geral da arquitetura: [Assistente pessoal](ASSISTENTE_PESSOAL.md).

---

## 📂 Sumário

1. [Segurança](#-1-segurança)
2. [Configuração](#-2-configuração)
3. [Como entrar](#-3-como-entrar)
4. [Rotas](#-4-rotas)
5. [Painel de administração](#-5-painel-de-administração)
6. [Agent e ferramentas do PC](#-agent-e-ferramentas-do-pc)
7. [Acesso remoto (Tailscale)](#-7-acesso-remoto-tailscale)

---

## 🔒 1. Segurança

- **Desligada por padrão** (`YUI_API_ENABLED=false`).
- Escuta em **`127.0.0.1`**. O acesso de outros aparelhos é **só pelo Tailscale**; nunca abra a porta na internet nem no *security group* da AWS.
- Toda rota, exceto `/v1/health`, `/v1/auth/*` e a pré-verificação CORS, exige `Authorization: Bearer <token ou sessão>`.
- O token/sessão só identifica **quem é o usuário**. O **papel** (OWNER, MEMBER...) e o **escopo de memória** são decididos pelo backend a partir do `userId`; o cliente não escolhe nenhum dos dois.
- Tokens fixos têm **16+ caracteres**, são guardados como hash SHA-256 e comparados em tempo constante.
- **CORS** só para origens listadas em `YUI_API_CORS_ORIGINS` (nunca `*`); não substitui a autenticação.
- Corpo máximo de 64 KB (acima disso a API responde `413`), mensagem máxima de 4000 caracteres.
- **Limites por usuário:** 30 requisições/min nas rotas de IA (`/v1/chat`, `/v1/agent`, `/v1/agent/confirm` e o início de uma execução em `/v1/dev/projects/:id/runs`) e 240/min no resto.
- Cada cliente da API é uma conversa 1:1 privada, como uma DM: o dono usa a **memória pessoal** e a **personalidade pessoal**.
- Ações sensíveis ficam em `logs/core-audit.jsonl` (só metadados, nunca senhas nem o conteúdo das memórias).

---

## ⚙️ 2. Configuração

No `.env`:

```env
YUI_API_ENABLED=true
YUI_API_HOST=127.0.0.1
YUI_API_PORT=3939

# Origens web autorizadas (CORS), separadas por vírgula. Vazio = CORS desligado.
# Só é necessário para a versão WEB do app quando servida em outra origem.
YUI_API_CORS_ORIGINS=http://localhost:8081

# Tokens fixos (opcional, para scripts): token=ID_do_Discord, separados por vírgula.
YUI_API_TOKENS=SEU_TOKEN_LONGO=ID_DISCORD_DO_DONO

# Validade da sessão de login (horas, padrão 12)
YUI_PANEL_SESSION_HOURS=12
```

- A API sobe se houver **ao menos uma forma de entrar**: `YUI_API_TOKENS`, o login por senha (`YUI_PANEL_USER` + senha) ou a chave por DM (que depende de a Yui estar conectada ao Discord).
- **Um token por dispositivo** (`tokenCelular=ID,tokenNotebook=ID`): cada aparelho pode ser revogado sozinho removendo o par e reiniciando a Yui.
- Gerar um token: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Para testar sem o bot e sem tocar nos seus dados: `npm run dev:api -- --fake` (IA simulada, banco temporário). Com `--panel` liga também o login por senha e um painel **simulado**.

---

## 🔑 3. Como entrar

O app **não pede endereço nem token**. O endereço do servidor é configuração do build (veja o [README do app](../../apps/yui-app/README.md)), e há três formas de se autenticar:

| Forma | Para quê | Resultado |
|-------|----------|-----------|
| **Usuário e senha** | Uso diário no app | Sessão temporária |
| **Chave de uso único por DM** | Entrar sem senha, usando o seu Discord | Sessão temporária |
| **Token fixo** (`YUI_API_TOKENS`) | Scripts e integrações | O próprio token |

O app guarda só a **sessão** (12 h por padrão), nunca a senha nem a chave. Uma sessão expirada ou revogada devolve `401` e o app volta para a tela de entrada.

### 3.1 Usuário e senha

```env
YUI_PANEL_USER=seu_usuario
YUI_PANEL_PASSWORD_HASH=scrypt$...      # recomendado: gere com  npm run panel:password
# alternativa (menos segura): YUI_PANEL_PASSWORD=uma-senha-com-10-ou-mais-caracteres
```

- `npm run panel:password` pede a senha **sem mostrá-la** e imprime as linhas prontas (hash scrypt com salt). Se `HASH` e `PASSWORD` existirem, vale o hash.
- Senha em texto exige 10+ caracteres; configuração incompleta **não ativa** o login e o motivo vai para o log.
- O login vale para o **dono** (`YUI_OWNER_ID`/`OWNER_ID`, ou `YUI_PANEL_USER_ID`).
- **Proteções:** usuário e senha são sempre conferidos em tempo constante, o erro é genérico ("Usuário ou senha inválidos"), há atraso nas falhas e, após **5 erros em 15 min, o login é bloqueado por 15 min** (global, porque atrás do Tailscale Serve toda requisição chega de `127.0.0.1`).

### 3.2 Chave de uso único por DM

No app: **Chave pelo Discord → Enviar chave para o meu Discord**. A Yui manda uma **mensagem privada** (fora de qualquer servidor) para o dono com uma chave no formato `ABCDE-FGHJK`, que você digita no app.

- **Uso único**, válida por **5 minutos**; pedir outra invalida a anterior; **5 erros** a invalidam.
- A chave **nunca** aparece na resposta da API: só chega pelo Discord.
- **Pedidos limitados** a 3 por 10 min (ninguém consegue encher a sua DM) e **5 chaves erradas em 15 min bloqueiam** a verificação por 15 min.
- Se o Discord recusar a DM (por exemplo, você bloqueou DMs de membros do servidor), a chave é descartada e o app mostra o erro.
- Só funciona com a Yui conectada ao Discord, e a DM só vai para o dono.

---

## 📡 4. Rotas

| Método | Rota | Corpo | Resposta |
|--------|------|-------|----------|
| GET | `/v1/health` | — | `{ ok, memory, readOnly, backends[] }` (sem token) |
| GET | `/v1/auth/status` | — | `{ passwordLogin, discordKey }` (sem token) |
| POST | `/v1/auth/login` | `{ user, password }` | `{ token, expiresAt, userId }` |
| POST | `/v1/auth/discord/request` | — | `{ ok, expiresInSeconds }` (a chave vai **por DM**) |
| POST | `/v1/auth/discord/verify` | `{ code }` | `{ token, expiresAt, userId }` |
| POST | `/v1/auth/logout` | — | `{ ok, revoked }` |
| GET | `/v1/me` | — | `{ userId, role, memoryScope, auth }` (`auth`: `token` ou `session`) |
| POST | `/v1/chat` | `{ message }` | `{ reply, memoryScope }` |
| POST | `/v1/agent` | `{ message }` | `{ type, reply, tool?, pendingId? }` |
| POST | `/v1/agent/confirm` | `{ id, approve }` | `{ type, reply }` |
| GET | `/v1/memory` | — | `{ scope, memories[] }` |
| POST | `/v1/memory` | `{ content, type?, tags? }` | `201 { ok, scope }` |
| DELETE | `/v1/memory/:id` | — | `{ ok }` |
| DELETE | `/v1/memory` | — | `{ removed }` (apaga **toda** a memória do próprio usuário) |
| GET/POST/DELETE | `/v1/admin/*` | — | Painel (só o dono; seção 5) |
| GET/POST/DELETE | `/v1/dev/*` | — | Código (só o dono; [veja abaixo](#-código-rotas-do-módulo)) |

**Códigos:** `400` entrada inválida · `401` sem/errado token, senha ou chave · `403` sem permissão · `404` rota · `413` corpo grande · `429` limite ou bloqueio (com `Retry-After`) · `502` falha ao enviar a DM · `503` recurso indisponível.

`type` da resposta do Agent: `reply` (conversa), `tool_result` (ferramenta executada), `needs_confirmation` (guarde o `pendingId` e chame `/v1/agent/confirm`), `denied` (negado pelo backend).

```bash
curl -s http://127.0.0.1:3939/v1/chat \
  -H "Authorization: Bearer $YUI_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"lembra que meu projeto principal é o BDS"}'
```

---

## 🛠️ 5. Painel de administração

Rotas `/v1/admin/*`, usadas pela aba **Admin** do app (que só aparece para o dono). **Todas** exigem o papel OWNER no backend (membros recebem `403`) e as ações são auditadas.

| Rota | O que faz |
|------|-----------|
| `GET /v1/admin/overview` | Discord online, servidores, tempo ligada, RAM, bloqueios e proteções ligadas |
| `GET /v1/admin/guilds` · `POST /v1/admin/guilds/:id/automod` | Servidores com AutoMod e TOS; altera o modo (`off`, `trigger`, `mcp`, `both`) |
| `GET /v1/admin/guilds/:id` | Detalhes do servidor: canais de notícias/diário/semanal, canais de YouTube e Twitch seguidos e ferramentas da IA ativas |
| `GET /v1/admin/integrations` | Estado de cada integração (Discord, IA, imagens, busca, voz, GTA, YouTube/Twitch...): ativa, desligada ou falta configurar. **Nunca devolve chaves**, só quantidades e o que falta |
| `GET /v1/admin/bans` · `POST /v1/admin/bans` · `DELETE /v1/admin/bans/:tipo/:id` | Banimentos de usuário, servidor e canal. **Não permite banir o dono** |
| `GET /v1/admin/memory/users` · `GET/DELETE /v1/admin/memory/users/:id` · `DELETE .../:id/:memoriaId` | Usuários com memória e **só metadados** (nunca o conteúdo); apagar uma lembrança ou tudo de um usuário |
| `GET /v1/admin/gateway` · `POST /v1/admin/gateway/reset` | Saúde dos provedores do [Gateway de IA](GATEWAY.md) (sem chaves) e zerar os descansos |
| `GET /v1/admin/audit?limit=` | Últimos eventos da auditoria |
| `GET /v1/admin/tools` | Ferramentas do Agent, o acesso de cada uma e se estão liberadas (somente leitura) |
| `POST /v1/admin/restart` | Reinicia a Yui (exige `{"confirm": true}`; o supervisor a religa em ~15 s) |

**O que o painel NÃO controla, de propósito:** o modo somente leitura, o login e a senha e os tokens de acesso. Isso só muda no `.env`, para um painel comprometido não conseguir se desbloquear nem trocar as próprias credenciais de entrada.

### Mensagem no Discord do dono

`POST /v1/admin/discord/dm` `{ message? }`: a Yui manda uma **mensagem privada** para o dono (sem texto, manda um teste). Até 1.500 caracteres, **5 por 10 minutos**; só o dono; a auditoria guarda só o tamanho. Responde `502` se o Discord recusar a DM e `503` se a Yui não estiver conectada. No app: **Admin → Geral → Mensagem no meu Discord**. Mande o corpo em UTF-8 (o app já faz isso).

### Rádio e logs

| Rota | O que faz |
|------|-----------|
| `GET /v1/admin/radio` | Sessões do Modo Rádio: servidor, call, estado, faixa atual e próxima, fila, aleatório/repetir e modo de voz |
| `POST /v1/admin/radio/:guildId` `{ action }` | `pause`, `resume`, `stop` (para a música e limpa a fila) ou `leave` (tira a Yui da call). Pular faixa e escolher música ficam no menu do rádio no Discord |
| `GET /v1/admin/logs?kind=&date=&level=&q=&limit=` | Últimas linhas dos logs, mais recentes primeiro. `kind`: `app` ou `error`; `date`: AAAA-MM-DD; `level`: `error`, `warn`, `info`, `debug`; `q`: busca no texto; até 500 linhas |

Os logs são **somente leitura** e só dos arquivos `app-AAAA-MM-DD.log` e `error-AAAA-MM-DD.log` da pasta de logs (nenhum caminho vem do cliente). Antes de sair do servidor, o texto passa por um filtro que **mascara segredos**: o valor de qualquer variável sensível do ambiente (nome com KEY, TOKEN, SECRET, PASSWORD, HASH, ARL ou COOKIE) e formatos conhecidos de chave (Google, Groq, Hugging Face, OpenAI/OpenRouter, token de bot do Discord, `Bearer ...`, `?key=...`). Stack traces ficam juntos da entrada que os gerou.

### Editar canais e seguidos

| Rota | O que faz |
|------|-----------|
| `PUT /v1/admin/guilds/:id/channels` `{ type: "noticias", "diario" ou "semanal", channelId: ID ou null }` | Define (ou limpa) o canal de publicação. Só canais de **texto** do próprio servidor |
| `POST /v1/admin/guilds/:id/youtube` `{ channel, discordChannelId, roleId?, videos?, shorts?, lives? }` | Passa a seguir um canal do YouTube (aceita @handle, ID UC... ou URL) |
| `DELETE /v1/admin/guilds/:id/youtube/:ytId/:discordChannelId` | Para de seguir |
| `POST /v1/admin/guilds/:id/twitch` `{ streamer, discordChannelId, roleId? }` | Passa a seguir um streamer (aceita login ou URL) |
| `DELETE /v1/admin/guilds/:id/twitch/:login/:discordChannelId` | Para de seguir |

Mesmas regras dos comandos `/yui-seguir-*` do Discord; tudo é auditado.

### Provedores de IA: chaves e provedores próprios

Em **Admin → IA** o dono pode colar chaves, ligar/desligar provedores, testar a conexão e cadastrar **provedores próprios** compatíveis com OpenAI (por exemplo o **OmniRoute**, endereço `http://127.0.0.1:20128/v1`).

| Rota | O que faz |
|------|-----------|
| `GET /v1/admin/ai` | Provedores, quantas chaves vêm do `.env` e as do painel (**só os 4 últimos caracteres**), próprios, modelos prontos e se a edição está liberada |
| `POST /v1/admin/ai/keys` `{ provider, key }` · `DELETE /v1/admin/ai/keys/:provider/:índice` | Adiciona/remove chave do painel (as do `.env` só se mudam no arquivo) |
| `PUT /v1/admin/ai/cloudflare` `{ accountId }` | ID da conta da Cloudflare |
| `POST /v1/admin/ai/providers/:id` `{ enabled }` | Liga/desliga um provedor no Gateway |
| `POST /v1/admin/ai/custom` · `POST /v1/admin/ai/custom/:id/keys` · `DELETE /v1/admin/ai/custom/:id` | Provedor próprio: `{ id, label, baseUrl, models, key?, first?, anonymous? }` |
| `POST /v1/admin/ai/custom/:id/options` `{ first?, anonymous?, models? }` | `first: true` coloca o provedor **logo após o LM Studio** (prioridade 5, antes de Groq e Gemini); `anonymous: true` impede que receba **conversas pessoais**; `models` troca a lista de modelos |
| `POST /v1/admin/ai/test/:id` | Faz uma pergunta mínima ao provedor e devolve `{ ok, ms, error? }` |

Como funciona e o que protege:

- As chaves ficam em `secrets/ai-providers.json` (fora do Git; troque o caminho com `YUI_AI_SETTINGS_FILE`) e **valem na hora**, sem reiniciar. O `.env` nunca é reescrito: a Yui junta o que está no `.env` com o que veio do painel.
- As chaves **só entram**: nenhuma resposta, log ou auditoria as devolve. Chave aceita: 10 a 512 caracteres visíveis, sem espaço nem vírgula.
- **Endereço de provedor próprio:** `https://` em qualquer lugar; `http://` só para a sua máquina ou rede (localhost, 192.168.x, 10.x, Tailscale). Sem usuário/senha no endereço.
- `YUI_PANEL_AI_EDIT=false` no `.env` trava toda edição de IA pelo painel (a consulta e o teste continuam).
- Conversas pessoais nunca vão a provedores marcados como anônimos (sem chave).

---

## 💻 Código: rotas do módulo

Rotas `/v1/dev/*`, usadas pela aba **Código** do app (as funções do Jarvis dentro da Yui). Exigem o papel **OWNER** (membros recebem `403`) e `YUI_DEV_ENABLED=true` (senão `503`, exceto `GET /v1/dev/status`, que diz se está ligado). Guia de uso e segurança: [Código](CODIGO.md).

| Rota | O que faz |
|------|-----------|
| `GET /v1/dev/status` | `{ enabled, coreReadOnly, local, canWrite, approval, projects[], modes[] }`. `local` diz se **este pedido** veio do próprio computador da Yui; `canWrite` só é `true` com `YUI_READ_ONLY=false` **e** pedido local |
| `POST /v1/dev/projects` `{ name, path }` · `DELETE /v1/dev/projects/:id` | Cadastra/remove um projeto (**só do computador da Yui**; os de `YUI_PROJECTS` não se removem). Recusa a raiz do disco, a pasta pessoal, pastas do sistema e `.ssh`/`.aws`/`.gnupg`/`.kube` |
| `GET /v1/dev/projects/:id/tree?path=` | Itens de uma pasta do projeto (sem ocultos, `node_modules`, `.git` nem arquivos sensíveis) |
| `GET /v1/dev/projects/:id/file?path=` | Texto de um arquivo (até 2 MB; `.env`, chaves e similares são negados) |
| `GET /v1/dev/projects/:id/history` · `DELETE /v1/dev/projects/:id/history` | Conversa guardada do projeto (só texto) / apaga |
| `POST /v1/dev/projects/:id/runs` `{ message, mode?, activeFile? }` | Começa uma execução em segundo plano: `{ runId, approval }` (`approval`: `ask`, `auto` ou `readonly`). `409` se já houver outra; `400` mensagem vazia ou acima de 8.000 caracteres |
| `GET /v1/dev/runs/:runId/events?after=N` | Eventos novos (`seq > N`): `{ status, last, approval, events[] }`. Tipos: `step`, `thought`, `tool` (`waiting`/`running`/`ok`/`denied`/`error`), `approval`, `approval_done`, `final`, `done` |
| `POST /v1/dev/runs/:runId/approvals/:approvalId` `{ approve }` | Aprova ou nega (**só do computador da Yui**; `403` caso contrário). Sem resposta em 5 min conta como "não" |
| `POST /v1/dev/runs/:runId/cancel` | Cancela a execução |

O app faz a consulta dos eventos a cada ~0,7 s até chegar o `done`. Uma execução termina de qualquer forma (a Yui responde, falha ou é cancelada) e some da memória 30 minutos depois. Tudo é auditado (`dev.run.start`, `dev.tool`, `dev.approval`, `dev.project.add/remove`), sem o conteúdo dos arquivos nem das mensagens.

---

## 🧰 Agent e ferramentas do PC

`POST /v1/agent` deixa a Yui **executar** ações autorizadas. O fluxo e as garantias estão em [Assistente pessoal](ASSISTENTE_PESSOAL.md#-6-agent-e-ferramentas).

As ferramentas do PC só existem com `YUI_TOOLS_PC_ENABLED=true`, no computador em que o Core roda como assistente pessoal:

```env
YUI_TOOLS_PC_ENABLED=true
# Allowlists: NOME=CAMINHO, separados por "|" (barras normais funcionam no Windows)
YUI_PROJECTS=BDS=D:/Projetos/BDS|LAC=D:/Projetos/LAC|Yui=D:/Projetos/Yui
YUI_APPS=                              # programas que podem ser abertos (bloqueado no somente leitura)
YUI_FILE_ROOTS=D:/Projetos             # pastas onde a busca por nome é permitida
YUI_EDITOR_COMMAND=C:/Users/voce/AppData/Local/Programs/Microsoft VS Code/Code.exe
YUI_MCP_ALLOW=                         # "servidor.ferramenta,..." permitidas via MCP
YUI_MCP_READ_ONLY=                     # dentre as de cima, as que você sabe que SÓ LEEM
YUI_READ_ONLY=true                     # padrão: sem apagar/gravar/mover e sem executar programas
```

| Ferramenta | O que faz | Proteção |
|------------|-----------|----------|
| `system.info` | SO, CPU, RAM, uptime | OWNER, DM/canal privado |
| `projects.open` | Abre projeto da allowlist | OWNER, DM/canal privado; o caminho vem do `.env`, nunca do pedido |
| `apps.open` | Abre programa da allowlist | OWNER, DM/canal privado, **exige confirmação**; **bloqueada no somente leitura** (executa programas) |
| `files.search` | Busca por **nome** nas pastas autorizadas | Somente leitura; sem caminhos no pedido; ignora `node_modules` e `.git` |
| `commands.list` / `commands.run` | Lista / roda um comando de `YUI_COMMANDS` pelo **nome** | `run`: OWNER, DM/canal privado, **confirmação**, sem shell, **bloqueada no somente leitura**. Detalhes: [Comandos e skills](COMANDOS_E_SKILLS.md) |

Não existe ferramenta de shell livre.

---

## 🔗 7. Acesso remoto (Tailscale)

O Tailscale cria uma rede privada entre os seus dispositivos. A API continua escutando só em `127.0.0.1`; o **`tailscale serve`** a publica em **HTTPS dentro da sua tailnet**:

```powershell
tailscale serve --bg --https=3939 http://127.0.0.1:3939
# resultado: https://<seu-pc>.<sua-tailnet>.ts.net:3939   (somente tailnet)
tailscale serve status
tailscale serve --https=3939 off      # desfaz
```

- **Não use `tailscale funnel`**: ele abre para a internet.
- No celular: instale o app **Tailscale**, entre na mesma conta e mantenha-o conectado; o PC precisa estar ligado.
- Para o app Android, gere o build com `EXPO_PUBLIC_YUI_SERVER_URL=https://<seu-pc>.<sua-tailnet>.ts.net:3939`.
- Use as **ACLs** do Tailscale para limitar quais dispositivos alcançam a porta.
- Se você já usa o `tailscale serve` para outro serviço (por exemplo, na porta 443), a API na `3939` convive sem alterá-lo.
