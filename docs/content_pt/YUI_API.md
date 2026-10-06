# 🌐 Yui API e Acesso Remoto (Tailscale)

Interface HTTP do Yui Core para apps (mobile/desktop) e integrações. Código em `src/core/api/server.js`. Visão geral do projeto: [ASSISTENTE_PESSOAL.md](ASSISTENTE_PESSOAL.md).

---

## 🔒 Segurança

- **Desligada por padrão** (`YUI_API_ENABLED=false`).
- Escuta em **`127.0.0.1`**. Para acesso remoto use o **IP do Tailscale** do PC em `YUI_API_HOST`. **Nunca** abra a porta na internet nem no *security group* da AWS.
- Toda rota, exceto `/v1/health`, exige `Authorization: Bearer <token>`.
- O token só identifica **quem é o usuário**. O **papel** (OWNER, MEMBER…) e o **escopo de memória** são decididos pelo backend a partir do `userId`; o cliente não escolhe nenhum dos dois.
- Tokens têm **16+ caracteres** e são comparados em tempo constante (hash SHA-256).
- **CORS** só para origens listadas em `YUI_API_CORS_ORIGINS` (nunca `*`); a pré-verificação `OPTIONS` é respondida sem token, mas o CORS não substitui a autenticação.
- Corpo máx. 64 KB, mensagem máx. 4000 caracteres, limite de 30 requisições/min por usuário.
- Cada cliente da API é uma conversa 1:1 privada, equivalente a uma DM: o dono usa a **memória pessoal**.
- Tudo que é sensível é registrado em `logs/core-audit.jsonl` (só metadados).

## ⚙️ Configuração (`.env`)

```env
YUI_API_ENABLED=true
YUI_API_HOST=127.0.0.1          # no PC com Tailscale: o IP 100.x.x.x do PC
YUI_API_PORT=3939

# token=userId, separados por vírgula. Gere tokens longos e aleatórios.
# O userId do dono (YUI_OWNER_ID / OWNER_ID) recebe o papel OWNER.
YUI_API_TOKENS=SEU_TOKEN_LONGO_AQUI=ID_DISCORD_DO_DONO

# Origens web autorizadas (CORS), separadas por vírgula. Vazio = CORS desligado.
# Só é necessário para a versão WEB do app; o app Android não usa CORS.
YUI_API_CORS_ORIGINS=http://localhost:8081
```

**Um token por dispositivo:** coloque vários pares separados por vírgula (`tokenCelular=ID,tokenNotebook=ID`). Assim cada aparelho pode ser revogado sozinho (remova o par e reinicie a Yui).

Gerar um token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 📡 Rotas

| Método | Rota | Corpo | Resposta |
|--------|------|-------|----------|
| GET | `/v1/health` | — | `{ ok, memory, readOnly, backends[] }` (sem token) |
| GET | `/v1/me` | — | `{ userId, role, memoryScope }` |
| POST | `/v1/chat` | `{ "message": "..." }` | `{ reply, memoryScope }` |
| POST | `/v1/agent` | `{ "message": "..." }` | `{ type, reply, tool?, pendingId? }` |
| POST | `/v1/agent/confirm` | `{ "id": "...", "approve": true }` | `{ type, reply }` |
| GET | `/v1/memory` | — | `{ scope, memories[] }` |
| POST | `/v1/memory` | `{ "content": "...", "type?": "note", "tags?": [] }` | `201 { ok, scope }` |
| DELETE | `/v1/memory/:id` | — | `{ ok }` |
| DELETE | `/v1/memory` | — | `{ removed }` (apaga **toda** a memória do próprio usuário) |

Códigos: `400` entrada inválida · `401` sem/errado token · `403` bloqueado · `404` rota · `413` corpo grande · `429` limite · `503` memória desativada.

`type` da resposta do agent: `reply` (conversa), `tool_result` (ferramenta executada), `needs_confirmation` (guarde o `pendingId` e chame `/v1/agent/confirm`), `denied` (negado pelo backend).

### Exemplo

```bash
curl -s http://127.0.0.1:3939/v1/chat \
  -H "Authorization: Bearer $YUI_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"lembra que meu projeto principal é o BDS"}'
```

---

## 🧰 Agent e ferramentas do PC

`POST /v1/agent` deixa a Yui **executar** ações autorizadas. O fluxo e as garantias estão em [ASSISTENTE_PESSOAL.md](ASSISTENTE_PESSOAL.md#-6-agent--camada-jarvis-e-ferramentas).

As ferramentas do PC só existem no computador em que o Core roda **como assistente pessoal**, com `YUI_TOOLS_PC_ENABLED=true` (deixe **desligado** na VPS):

```env
YUI_TOOLS_PC_ENABLED=true
# Allowlists: NOME=CAMINHO, separados por "|"
YUI_PROJECTS=BDS=C:\Dev\BDS|LAC=D:\Projetos\LAC|Yui=D:\Projetos\Yui
YUI_APPS=chrome=C:\Program Files\Google\Chrome\Application\chrome.exe
YUI_FILE_ROOTS=D:\Projetos|D:\Documentos
YUI_EDITOR_COMMAND=code          # opcional; sem isso abre no Explorer
YUI_MCP_ALLOW=                   # "servidor.ferramenta,..." permitidas via MCP
YUI_MCP_READ_ONLY=               # dentre as de cima, as que você sabe que SÓ LEEM
YUI_READ_ONLY=true               # padrão: sem apagar/gravar/mover e sem executar programas
```

| Ferramenta | O que faz | Proteção |
|------------|-----------|----------|
| `system.info` | SO, CPU, RAM, uptime | OWNER, DM/canal privado |
| `projects.open` | Abre projeto da allowlist | OWNER, DM/canal privado; caminho vem do `.env` |
| `apps.open` | Abre programa da allowlist | OWNER, DM/canal privado, **exige confirmação**; **bloqueada no modo somente leitura** (executa programas) |
| `files.search` | Busca por **nome** nas pastas autorizadas | Somente leitura; sem caminhos no pedido; ignora `node_modules`/`.git` |

**Modo somente leitura (padrão):** o backend nega qualquer ferramenta que execute programas (`execute`) ou altere arquivos (`write`), para qualquer papel. Só `YUI_READ_ONLY=false` libera, e ferramentas MCP só passam se listadas em `YUI_MCP_READ_ONLY`. Detalhes em [ASSISTENTE_PESSOAL.md](ASSISTENTE_PESSOAL.md#-modo-somente-leitura-ligado-por-padrão).

Não existe ferramenta de shell livre. Ela só será considerada com sandbox e confirmação obrigatória.

---

## 🔗 Tailscale (Fase 9)

O Tailscale cria uma rede privada entre seus dispositivos; a API nunca fica exposta à internet.

**Situação:** o PC (`mnbf-neon`, IP `100.126.122.60`) tem o Tailscale rodando e a API já está publicada em `https://mnbf-neon.<tailnet>.ts.net:3939` (`tailscale serve`, **somente tailnet**; o serve do OmniRoute na porta 443 não foi alterado). Para desfazer: `tailscale serve --https=3939 off`. Os dois Androids da conta apareciam *offline* (há 13 e 23 dias). A VPS **não** tem Tailscale.

Passos para usar o celular:

1. No celular, abra o app **Tailscale** e entre na mesma conta (ele volta a ficar *online*).
2. No PC, `.env`:
   ```env
   YUI_API_ENABLED=true
   YUI_API_HOST=100.126.122.60
   YUI_API_PORT=3939
   YUI_API_TOKENS=<token-longo>=<seu-id-do-discord>
   ```
3. Permita a porta 3939 no Firewall do Windows **somente para a interface do Tailscale** (rede `100.64.0.0/10`).
4. Teste do celular: `http://100.126.122.60:3939/v1/health`.
5. Opcional: ative o **MagicDNS** e o **HTTPS** do Tailscale (`tailscale serve`) para ter `https://mnbf-neon.<tailnet>.ts.net` com TLS, sem expor nada na internet.
6. Para o **celular**, publique a API em **HTTPS** só na tailnet: `tailscale serve --bg --https=3939 http://127.0.0.1:3939` (resultado: `https://<pc>.<tailnet>.ts.net:3939`). Não use `tailscale funnel`.
7. Use as **ACLs** do Tailscale para limitar quais dispositivos alcançam a porta 3939.

Se a Yui pública continuar na VPS, ela e o Core do PC são **processos independentes** hoje. A unificação (um Core só) acontece quando o bot do Discord for migrado para o PC (ver pendências).
