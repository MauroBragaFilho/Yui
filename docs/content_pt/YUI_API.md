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
- Toda rota, exceto `/v1/health`, `/v1/identidade` (quando a prova de identidade está ligada), `/v1/auth/status`, `/v1/auth/login`, `/v1/auth/discord/*` e a pré-verificação CORS, exige `Authorization: Bearer <token ou sessão>` (o `/v1/auth/logout` também exige).
- O token/sessão só identifica **quem é o usuário**. O **papel** (OWNER, MEMBER...) e o **escopo de memória** são decididos pelo backend a partir do `userId`; o cliente não escolhe nenhum dos dois.
- Tokens fixos têm **16+ caracteres**, são guardados como hash SHA-256 e comparados em tempo constante.
- **CORS** só para origens listadas em `YUI_API_CORS_ORIGINS` (nunca `*`); não substitui a autenticação.
- Corpo máximo de 64 KB (acima disso a API responde `413`), mensagem máxima de 4000 caracteres.
- **Limites por usuário:** 30 requisições/min nas rotas de IA (`/v1/chat`, `/v1/agent` e `/v1/agent/confirm`) e 240/min no resto.
- Cada cliente da API é uma conversa 1:1 privada, como uma DM: o dono usa a **memória pessoal** e a **personalidade pessoal**.
- Ações sensíveis ficam em `logs/core-audit.jsonl` (só metadados, nunca senhas nem o conteúdo das memórias).
- **Prova de identidade (opcional):** com o arquivo da chave privada Ed25519 do servidor (`YUI_API_IDENTIDADE_ARQUIVO`), a rota pública `GET /v1/identidade` assina um desafio do app, que só então envia senha e token (veja [Prova de identidade do servidor](#prova-de-identidade-do-servidor)). A chave privada fica só no servidor, num arquivo restrito ao seu usuário, e nunca vai para log, resposta nem repositório.

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

- A API só sobe com `YUI_API_TOKENS` **ou** o login por senha (`YUI_PANEL_USER` + senha) configurado; sem nenhum dos dois ela não inicia e o motivo vai para o log. A chave por DM sozinha não basta: ela só funciona com a API já no ar e a Yui conectada ao Discord.
- Em produção (desde 03/11/2026) a API roda no **notebook servidor** da Yui, em `127.0.0.1:3939`.
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
| GET | `/v1/identidade?nonce=<hex>` | — | `{ ok, assinatura }` (sem token; **só com a prova de identidade ligada**, senão `404`; veja [Prova de identidade do servidor](#prova-de-identidade-do-servidor)) |
| GET | `/v1/auth/status` | — | `{ passwordLogin, discordKey }` (sem token) |
| POST | `/v1/auth/login` | `{ user, password }` | `{ token, expiresAt, userId }` |
| POST | `/v1/auth/discord/request` | — | `{ ok, expiresInSeconds }` (a chave vai **por DM**) |
| POST | `/v1/auth/discord/verify` | `{ code }` | `{ token, expiresAt, userId }` |
| POST | `/v1/auth/logout` | — | `{ ok, revoked }` |
| GET | `/v1/me` | — | `{ userId, role, memoryScope, auth }` (`auth`: `token` ou `session`) |
| POST | `/v1/chat` | `{ message }` | `{ reply, memoryScope, imagem?, limiteImagem? }` |
| POST | `/v1/agent` | `{ message }` | `{ type, reply, tool?, pendingId?, imagem?, limiteImagem? }` |
| POST | `/v1/agent/confirm` | `{ id, approve }` | `{ type, reply, imagem?, limiteImagem? }` |
| GET | `/v1/imagem/:codigo` | — | A imagem gerada pelo chat (sem token: o código do link é a credencial; vence em 10 min; senão `404`). Veja [Imagem no Chat do app](#imagem-no-chat-do-app) |
| GET | `/v1/memory` | — | `{ scope, memories[] }` |
| POST | `/v1/memory` | `{ content, type?, tags? }` | `201 { ok, scope }` |
| DELETE | `/v1/memory/:id` | — | `{ ok }` |
| DELETE | `/v1/memory` | — | `{ removed }` (apaga **toda** a memória do próprio usuário) |
| GET/POST/DELETE | `/v1/admin/*` | — | Painel (só o dono; seção 5) |

**Códigos:** `400` entrada inválida · `401` sem/errado token, senha ou chave · `403` sem permissão · `404` rota · `413` corpo grande · `429` limite ou bloqueio (com `Retry-After`) · `502` falha ao enviar a DM · `503` recurso indisponível.

**Perfil de IA no chat do app (etapa 10, só com o cérebro separado):** `POST /v1/chat` e `POST /v1/agent` escolhem o perfil de IA com o **mesmo seletor determinístico** do Discord (`src/cerebro/seletorPerfil.js`, entregue pelo cérebro à API): a conversa do dono (memória pessoal = privada) vai pelo perfil `privado` **só se** ele estiver declarado e a rota verificada (senão responde `200` com a mensagem curta de rota privada fechada e nada é enviado a nenhum provedor); a de um membro vai pelo perfil geral (`conversa`, com a escalada para `raciocinio` por código, plano ou contexto longo). **Sem nenhum perfil configurado a chamada de IA é idêntica à de antes** (nenhum campo novo). O processo único não passa perfil.

`type` da resposta do Agent: `reply` (conversa), `tool_result` (ferramenta executada), `needs_confirmation` (guarde o `pendingId` e chame `/v1/agent/confirm`), `denied` (negado pelo backend).

### Imagem no Chat do app

Com `YUI_APP_IMAGEM=true` (padrão desligada; também no painel, vale na hora), "gera uma imagem de...", "desenha..." viram imagem pelo código (a mesma Porta I do Discord) e o agente ganha a ferramenta `imagem.gerar`. Valem a política (papel membro ou acima; a ação `chat.generate_image` da matriz, que `POLICY_CHAT_AUTONOMY` aperta), o mesmo filtro de conteúdo impróprio e o mesmo `YUI_IMAGE_PER_HOUR` do Discord, um limite só por pessoa somando Discord e app (o dono não tem limite; com o cérebro separado, o bot conta os dois pelo canal, método `imagem.cota`), e a `generate_image` precisa estar ligada no padrão global (no app não há servidor: vale o mesmo da DM). Quem gera é o processo do bot; com o cérebro separado o pedido vai pelo canal e a imagem volta por um arquivo temporário de nome aleatório, apagado logo depois de lido.

- `imagem: { url, alt, expiresInSec }`: `url` é um caminho relativo `/v1/imagem/<código>` (some ao endereço do servidor). O código é a credencial, vale 10 minutos (o mesmo prazo do link dos arquivos) e aponta para os bytes guardados na memória do processo (no máximo 20 imagens). A resposta nunca traz caminho de arquivo do servidor. `alt` é o texto alternativo (o assunto pedido).
- `limiteImagem: { minutos }`: o limite por hora barrou o pedido; o `reply` diz quando tentar de novo.
- A auditoria registra `api.imagem` com a via (`prerota` ou `ferramenta`), o resultado e o tamanho do pedido, nunca o texto.

```bash
curl -s http://127.0.0.1:3939/v1/chat \
  -H "Authorization: Bearer $YUI_TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"lembra que meu projeto principal é o BDS"}'
```

### Prova de identidade do servidor

O app aceita uma lista de endereços (rede local e Tailscale) e escolhe o primeiro que responde `GET /v1/health`. Isso prova que **alguém** responde, não **quem**: em outra rede, uma máquina com o mesmo IP privado responderia `{"ok":true}` e receberia a senha e o token. A prova de identidade fecha essa porta com uma assinatura:

1. No servidor, gere a identidade uma vez: `node scripts/gerar-identidade-yui.mjs`. O script cria um par de chaves **Ed25519** (`node:crypto`, sem pacote), grava a chave **privada** em `secrets/identidade-yui.key` (ou no caminho de `YUI_API_IDENTIDADE_ARQUIVO`) com permissão restrita ao seu usuário, **nunca sobrescreve** um arquivo existente sem `--forcar` e imprime **só a chave pública** (base64, 32 bytes). `--publica` mostra de novo a pública de uma identidade que já existe. Reinicie a Yui para a rota ligar.
2. No build do app, coloque a chave **pública** em `EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY` (é pública: pode estar no APK; a privada nunca sai do servidor). Veja o README do app.

`GET /v1/identidade?nonce=<hexadecimal de 32 a 64 caracteres>` (sem token) devolve `{ "ok": true, "assinatura": "<base64>" }`: a assinatura Ed25519 do texto `yui-identidade-v1|` + o nonce, que o app gera aleatório e novo a cada verificação. Com o arquivo da chave ausente a rota responde `404`; nonce inválido (ausente, repetido, fora do tamanho ou não hexadecimal) `400`; outro método `405`; mais de 30 pedidos por minuto da mesma origem, `429` com `Retry-After`. O app só envia senha, token ou qualquer pedido autenticado depois de conferir a assinatura com a chave pública do build, **também para o endereço "lembrado"** e de novo a cada nova escolha, queda de rede ou a cada 60 s de uso. Servidor sem assinatura válida (404, atraso, assinatura de outra chave ou de outro nonce, qualquer bit trocado) é rejeitado como se não respondesse; se nenhum endereço passar, o app mostra "Não consegui confirmar que este servidor é a sua Yui." e não envia nada. Sem a chave no build, o app se comporta como antes (e a versão web não usa a prova).

**O que a prova não faz:** ela garante que o endereço é o servidor da Yui, mas **não cifra** o tráfego (com `http://` na rede local, o token ainda passa em texto claro pelo Wi-Fi) e não impede quem consiga **retransmitir** em tempo real o desafio ao servidor verdadeiro (um intermediário ativo na mesma rede). O caminho do Tailscale já é cifrado; para a rede local, o que fecha essas duas pontas é HTTPS com certificado fixado, que não está implementado.

---

## 🛠️ 5. Painel de administração

Rotas `/v1/admin/*`, usadas pela aba **Admin** do app (que só aparece para o dono). **Todas** exigem o papel OWNER no backend (membros recebem `403`) e as ações são auditadas.

| Rota | O que faz |
|------|-----------|
| `GET /v1/admin/overview` | Discord online, servidores, tempo ligada, RAM do processo, bloqueios e proteções ligadas. Também devolve a **saúde do computador** (`host`: RAM e disco livres), a **atividade recente** (`activity`: os últimos 8 eventos da auditoria, só `ts`, `event`, `role` e `platform`, nunca os detalhes), a **retenção da memória** (`retention`: dono permanente, demais usuários em N dias) o `ownerName` (`YUI_OWNER_NAME`, opcional), as **respostas da IA por hora** das últimas 24 h (`interactions`: contador gravado em `database/interaction-stats.json`, sobrevive a reinício e atualização, sem texto nem usuário) os **limites mostrados na tela** (`limits`: mensagens ao Discord pedidas pelo painel por janela e por quantos minutos vale um link de arquivo, para a tela não repetir números fixos) e os **problemas** das últimas 24 h (`problems`: só quantos logins recusados, ferramentas com erro ou negadas e avisos não entregues) |
| `GET /v1/admin/guilds` · `POST /v1/admin/guilds/:id/automod` | Servidores com AutoMod e TOS; altera o modo (`off`, `trigger`, `mcp`, `both`) |
| `GET /v1/admin/guilds/:id` | Detalhes do servidor: canais de notícias/diário/semanal, canais de YouTube e Twitch seguidos e ferramentas da IA ativas |
| `GET /v1/admin/integrations` | Estado de cada integração (Discord, IA, imagens, busca, voz, GTA, YouTube/Twitch...): ativa, desligada ou falta configurar. **Nunca devolve chaves**, só quantidades e o que falta |
| `GET /v1/admin/bans` · `POST /v1/admin/bans` · `DELETE /v1/admin/bans/:tipo/:id` | Banimentos de usuário, servidor e canal. **Não permite banir o dono** |
| `GET /v1/admin/memory/users` | Lista os usuários com memória, **só metadados** (sem conteúdo); devolve também `permanent` (`MEMORY_RETENTION_DAYS=0`) |
| `GET /v1/admin/memory/users/:id` · `DELETE /v1/admin/memory/users/:id` · `DELETE .../:id/:memoriaId` | `GET` devolve o **conteúdo** das lembranças do usuário (até 100), só para o dono (Admin → Memória); outros papéis recebem `403`. Cada leitura é auditada como `memory.admin.content` (alvo e quantidade, **sem o texto**). Os `DELETE` apagam uma lembrança ou tudo do usuário |
| `GET /v1/admin/diagnostico` | **Diagnóstico** para o app (etapa 8; só o dono, só leitura, sem cache): o estado geral (`ok`, `atencao` ou `problema`) com os motivos, o cérebro e a conexão com o bot, a IA (o provedor que responderia agora e o tipo do último erro de cada um), os limites de tokens por provedor (Discord e app), as cotas de busca (por hora, por mês e se a cota por hora está sendo gravada em disco), os avisos de configuração, os erros das últimas 24 h por módulo e os bancos. **Só números, booleanos, identificadores curtos e palavras fixas**: nunca texto de conversa, pesquisa privada, ids, segredos, caminhos nem o texto de um erro. Membro recebe `403` Desde a etapa 9 também traz `perfisDeIa` (os perfis de IA, os contadores, as últimas chamadas com o combo, o provedor que respondeu, a estratégia, o fallback, o limite de tokens, a latência e o resultado, e o estado da rota privada: `desligada`, `incompleta`, `nao-verificada`, `validada`, `nao-validada` ou `bloqueada`) e `motorAgente` (o motor pedido e o ativo; o Mastra não está implementado). |
| `GET /v1/admin/gateway` · `POST /v1/admin/gateway/reset` | Saúde dos provedores do [Gateway de IA](GATEWAY.md) (sem chaves) e zerar os descansos |
| `/v1/admin/bds/*` · `GET /v1/bds/get/:codigo` | **Arquivos do BDS Server** (só o dono; precisa de `YUI_BDS_URL`): a Yui repassa ao BDS Server por dentro do notebook. `GET status`, `audit`, `roots`, `list?caminho=`, `search?q=`, `recent`, `usage`, `trash`; `POST mkdir`, `rename`, `delete` e `purge` (estes dois exigem `confirmar: true`), `restore`; `PUT upload?caminho=` (corpo em fluxo, sem o limite de 64 KB, arquivo grande passa direto); `POST link` devolve um **link curto de 10 min** (`/v1/bds/get/<código>`, com Range) para o navegador abrir vídeo, áudio, foto e PDF sem cabeçalho de login: o código do link é a credencial, serve para UM caminho e só o dono o gera. Erros do BDS voltam com a mesma mensagem e status; BDS fora do ar dá `504`, sem `YUI_BDS_URL` dá `503`. A auditoria da Yui registra `admin.bds.*` sem o caminho dos arquivos |
| `GET /v1/admin/monitores` · `DELETE /v1/admin/monitores/:id` | **Monitores de busca** (etapa 16, só o dono; só existem com o cérebro separado e `YUI_MONITORES=true`, veja [Monitores](MONITORES.md)). `GET` lista em palavras fixas: `id`, `consulta` (curta, no máximo 60 caracteres; `null` nos encerrados, que não guardam o assunto), `estado` (`ativo`, `pausado` ou `encerrado`), `proximaChecagem` (`null` fora do estado `ativo`), `ate`, `avisos` e, só quando há um aviso em andamento, `entrega` (`pendente`, `enviando` ou `incerto`) e `fim` (`vencido` ou `cancelado`); traz também `resumo` (só contadores: passadas, buscas, avisos, passadas adiadas por cota ou por porta de saída fechada). Nunca devolve texto de resultado nem a assinatura. Com a chave desligada: `{ "ligado": false, "monitores": [] }`. `DELETE` cancela o monitor (`{ "ok": true }`; `404` se não existe, já está encerrado ou a chave está desligada). Membro recebe `403`. A auditoria guarda `admin.monitor.remove` sem a consulta |
| `GET /v1/admin/live` · `GET /v1/admin/google` · `GET /v1/admin/planos` · `GET /v1/admin/avisos` | **Só leitura, só o dono** (lacunas do painel, entrega B; membro recebe `403`). Lidas no processo que serve a API (o cérebro, com os dois processos). Cada resposta é montada com uma lista fechada de campos (`src/core/api/leiturasDoPainel.js`). `live`: `ligado`, `disponivel`, `estado` (`desligado`, `ociosa`, `procurando`, `ouvindo`, `encerrada` ou `interrompida`), `live` (`videoId` e título curto, só enquanto está numa live), `desde`, `mensagens` (lidas, respondidas e espontâneas desta live), `cota` do dia (usado, limite, reserva, restante, nível) e `ultimoErro` (código fixo e hora); **nunca** o texto do chat nem quem escreveu. `google`: `ligado`, `conectado`, `escopos` em nome curto (`agenda`, `tarefas`, `gmail`, `outro`; `null` = não informado), `autorizadoEm` e `venceEm` (7 dias depois, a regra do modo Testando; sem a data no arquivo, `validade: "nao-informado"`), `ultimaRenovacaoEm`, `ultimoErro` (`rede`, `erro` ou `precisa-autorizar`), `renovacaoFalhou`, `precisaAutorizar` e `motivoDeAutorizar` (`recusada`, `sem-arquivo` ou `arquivo-invalido`); **nunca** token, `client_id`, `client_secret`, código ou corpo de resposta. `planos`: os últimos 20 (id, versão, prefixo de 16 do hash, estado, datas, aprovação `dono` ou `automatica`, motivo do encerramento e, dos passos, só a ferramenta e o estado; **nunca** argumentos nem resultados). `avisos`: o `modo` do filtro, a `fila` durável e o que o modo observar registrou em cada processo (`observados`; com os dois processos, o do bot vem pelo canal e aparece como `indisponivel` se o bot estiver fora), de cada aviso só o assunto (chave fixa ou nome da família, senão `null`), a classe, o motivo e até quando; **nunca** o texto do aviso. As Integrações ganham o grupo **Contas da Yui** (Google e YouTube Live) com o mesmo cuidado |
| `POST /v1/admin/planos/:id/decisao` · `POST /v1/admin/live/entrar` · `POST /v1/admin/live/sair` | **Ações só do dono** (lacunas do painel, entrega E; membro recebe `403`; no `routeGuard` como `admin.plan_decide` e `admin.live_control`). Rodam no processo que serve a API (o cérebro, com os dois processos), sem pedido ao bot. **Decisão:** corpo `{ versao, hash, aprovar }` (o `id`, a `versao` e o prefixo de 16 do `hash` que o `GET /v1/admin/planos` mostra); chama a **mesma** decisão dos botões da DM, com as mesmas regras (plano do dono, mesma versão e hash, aguardando, dentro dos 30 minutos; a primeira decisão vale). Responde `{ ok, final, texto }` com a frase do serviço, **nunca** argumentos nem resultados; só existe com `YUI_PLANOS_PAINEL=true` (desligada: `404`); limite de 20 por minuto (`429`). A auditoria é a da decisão: `plan.approved` / `plan.rejected` com `origem: "painel"`. O `GET /v1/admin/planos` ganha `painel` (os botões valem). **Live:** `entrar` recebe `{ endereco, horas? }` (horas inteiras de 1 a 99) e monta o **mesmo** comando da conversa (`entra na live <link> por N horas`), passando pelo mesmo serviço (validação do link, ritmo pela duração, autorização do canal da Yui e cota); `sair` é o mesmo `sai da live`. Respondem `{ ok, texto }` com a frase do serviço; `YUI_YOUTUBE_LIVE` desligada: `404`; link fora do formato: `400`; entrar tem limite de 10 por minuto, sair não tem. A auditoria (`admin.live.enter` / `admin.live.leave`) leva só a origem, as horas e se valeu, nunca o link |
| `POST /v1/admin/google/autorizar/inicio` · `POST /v1/admin/google/autorizar/retorno` | **Reautorizar o Google pelo painel** (lacunas do painel, entrega F, item 14; só o dono, membro recebe `403`; no `routeGuard` como `admin.google_reauth`, que grava credencial: com `YUI_READ_ONLY=true` em `enforce`, é negada). Só existe com `YUI_GOOGLE_REAUTORIZAR_PAINEL=true` (desligada: `404`) e roda no processo que serve a API (o cérebro, com os dois processos), sem pedido ao bot. **Início** (sem corpo): só com um arquivo de autorização que já existe (senão `{ ok: false, codigo: "sem-arquivo" \| "arquivo-invalido", texto }`: a primeira vez é pelo script); responde `{ ok: true, link, expiraEm, gmailFicaNoScript }`, o link de consentimento com retorno fixo em `http://127.0.0.1:47615` e só Agenda e Tarefas, somente leitura (**nunca o Gmail**); a sessão (PKCE com o verificador só na memória do servidor) vale 10 minutos, é uma por vez e só de quem a iniciou; 5 inícios por hora (`429`). **Retorno:** corpo `{ endereco }`, o endereço inteiro da página `127.0.0.1:47615/?...` que não abriu; a sessão é apagada na **primeira tentativa**, certa ou errada; confere protocolo, host, porta, caminho, o `state` (tempo constante) e a validade, troca o código e grava o arquivo (atômico, permissão restrita). Responde `{ ok: true, codigo: "autorizado", venceEm, escopos, faltam, gmailFicaNoScript }` ou `{ ok: false, codigo, texto }` com um código fixo (`sem-sessao`, `sessao-vencida`, `endereco-invalido`, `state-diferente`, `negado`, `sem-codigo`, `sem-arquivo`, `arquivo-invalido`, `arquivo-mudou`, `rede`, `troca-recusada`, `sem-refresh`, `sem-escopo`, `gravacao-falhou`, `erro`). **Nunca** token, `client_secret`, código, verificador ou corpo de resposta do Google. A auditoria: `google.reauth.start`, `google.reauth.ok` e `google.reauth.fail` (com a etapa e o código). O `GET /v1/admin/google` ganha `reautorizarPeloPainel` (o botão vale) |
| `GET /v1/admin/gta` · `GET /v1/admin/listas` · `GET /v1/admin/skills` · `GET /v1/admin/continuidade` · `DELETE /v1/admin/continuidade/:id` | **Só o dono** (lacunas do painel, entrega D; membro recebe `403`), com lista fechada de campos (`src/core/api/leiturasDoPainel.js`). `gta` (só leitura): o último reset diário (Van de Armas com local e até 5 armas, comerciantes, naufrágio, baús, desafios), o último semanal **válido** (título, fonte `reddit`/`gtabase`/`newswire`, período, bônus, descontos, pódio, prêmio, se tem análise e o link de fonte conhecida), a última notícia do Newswire (título, categoria, data, link), **onde cada um saiu** (servidor e canal, com nome quando o bot conhece) e quantos servidores têm canal de cada tipo, e o estado das fontes (`semanal` e `newswire` como estão rodando e `aoReiniciar` quando o cofre diz outra coisa; Reddit `ligado`, `desligado` ou `em-espera` com a hora da próxima tentativa; o Reddit desligado nunca aparece como erro); `erros` só com as palavras `diario`, `semanal`, `noticia` e `canais`. É lido **no bot** (os bancos do GTA são dele): com o cérebro separado o cérebro pede por `panel.admin` e limpa de novo a resposta (bot fora: `503`); **nunca** o texto do post ou do artigo, a análise da IA, a miniatura nem o id da mensagem. `listas` (só leitura): as listas pessoais **do dono da sessão** (o arquivo é escolhido pelo id da sessão, nunca por parâmetro), com nome, itens e feito; `situacao` `ok`, `ausente` ou `ilegivel` (o arquivo estragado não é mexido). `skills` (só leitura): o catálogo instalado (nome, descrição curta, origem `yui`/`dono`/`extra`, licença, `permitida` por `YUI_SKILLS_PERMITIDAS`, o que foi ignorado) e as pastas que não carregaram (nome seguro e motivo em palavra fixa); **nunca** caminho, corpo nem metadados. `continuidade`: os projetos e as decisões da memória pessoal do dono (número, tipo `projeto` ou `decisao`, texto e datas; `memoria: false` com a memória desligada); `DELETE /:id` com `{ "confirm": true }` apaga **um** projeto ou decisão (`400` sem a confirmação, `404` para outro tipo de lembrança ou item de outra pessoa, `503` com a memória desligada; no `routeGuard` como `memory.forget_item`; a auditoria guarda `admin.continuidade.remove` só com o tipo, nunca o texto). Listas, skills e continuidade são lidas no processo da API (o cérebro, com os dois processos) |
| `POST /v1/admin/gta/republicar` | **Republicar o GTA** (lacunas do painel, entrega E, item 9 v2; só o dono, membro recebe `403`; no `routeGuard` como `admin.gta_republish`). Corpo `{ tipo: "diario" \| "semanal" \| "noticia", guildId, confirm: true }`: publica de novo o diário, o semanal válido ou a notícia **mais recentes** no servidor pedido, **sempre no canal daquele tipo configurado nele** (nunca um canal escolhido no pedido), pelas **mesmas** funções de publicação do agendador (o semanal sai do que já está salvo, com a análise da IA guardada: sem coletar de novo nem chamar a IA). O `GET /v1/admin/gta` traz `alvos` (por tipo, os servidores com o canal configurado). Responde `{ ok, tipo, guildId, canalId }`; sem a confirmação ou corpo fora do formato: `400`; Yui fora do servidor ou nada salvo daquele tipo: `404`; servidor sem o canal do tipo (ou a notícia é o próprio evento semanal, que sai pelo semanal): `409`; o Discord recusou: `502`. **Uma republicação do mesmo tipo no mesmo servidor a cada 10 minutos** (`429`; o que não chegou a publicar não conta). Roda no bot (com o cérebro separado, o cérebro pede por `panel.admin`). A auditoria `admin.gta.republicar` guarda só o tipo, o servidor e se saiu |
| `GET /v1/admin/reminders` · `POST` · `DELETE /:id` · `POST /:id/snooze` · `GET /v1/admin/morning` · `POST /v1/admin/morning/send` | **Lembretes e resumo do dia** (só o dono). `POST` recebe `{ text, when }` (`when` em português: `"amanhã às 9h"`, `"em 2 horas"`, `"todo dia às 8h"`) ou `{ text, at }` (ISO); a lista volta com `whenText` e `repeatText` prontos. `snooze` recebe `{ minutes }` ou `{ when }`. `GET morning` devolve o texto do relatório matinal de agora (sem enviar) e `POST morning/send` o manda por DM (`503` se o Discord não está pronto). Erros: `400` com a mensagem ("Diga quando…", "Essa data já passou."), `404` se o número não existe. A auditoria guarda `admin.reminder.*` e `admin.morning.send` sem o texto dos lembretes |
| `GET /v1/admin/audit?limit=` | Últimos eventos da auditoria |
| `GET /v1/admin/tools` | Ferramentas do Agent, o acesso de cada uma e se estão liberadas (somente leitura) |
| `POST /v1/admin/restart` | Reinicia a Yui. Só o dono, só com `{"confirm": true}` (booleano); a auditoria é `admin.restart`. **Processo único:** o processo sai e a tarefa o religa em ~15 s (`escopo: "processo-unico"`). **Com o cérebro separado (dois processos, etapa 10):** o cérebro (que serve a API) pede ao **supervisor** o reinício controlado dos DOIS, o bot e o cérebro (`escopo: "cerebro-e-bot"`): o supervisor para o bot, depois o cérebro (pedido limpo), sobe o cérebro e, quando ele avisa "pronto", o bot; não conta como queda. O app fica sem resposta até o cérebro voltar e o bot sai do Discord nesse intervalo. Se o supervisor não aceita (o cérebro foi aberto à mão, sem supervisor: `503`; já há um reinício em curso: `409`; sem resposta: `504`), **nada reinicia**, a resposta diz o motivo e a auditoria registra `admin.restart.recusado` |
| `POST /v1/admin/ia/rota-privada/verificar` | **Pede a nova verificação da rota privada de IA** (o perfil `privado`; veja [Perfis de IA](PERFIS_IA.md)). Só o dono e só com `{"confirm": true}` (booleano): membro recebe `403` e, sem a confirmação, `400`. **Só pede, nunca desbloqueia direto:** a Yui faz uma **sonda** (uma chamada pequena, com uma frase fixa e nenhum conteúdo privado, pela mesma rota e chave do perfil) e só uma sonda **válida** (o cabeçalho `X-OmniRoute-Decision` nomeia um provedor da lista permitida) libera a rota; uma sonda que falha deixa a rota como estava (bloqueada continua bloqueada). **Limite de repetição:** 3 pedidos a cada 10 minutos; depois disso responde `429` sem fazer sonda. Responde `{ ok, estado, motivo, liberada, sondaEnviada, mensagem }`, **só com palavras fixas**: `estado` é `desligada`, `incompleta`, `nao-verificada`, `validada`, `nao-validada` ou `bloqueada`, e `motivo` é uma palavra fixa ou `null`; nunca traz chave, cabeçalho, nome do combo, endereço nem conteúdo. Sem o perfil privado configurado devolve `desligada` e não envia nada a ninguém. A auditoria registra `admin.ia.rota_privada.verificar` (e `admin.ia.rota_privada.recusado` quando o limite barra), só com o estado e o motivo. Com o cérebro separado, quem responde é o cérebro (o dono das chamadas de IA) |

**Configuração e chaves (`GET /v1/admin/config` · `PUT /v1/admin/config/:chave` · `DELETE /v1/admin/config/:chave`):** a lista fechada do cofre (`src/core/painelConfig.js`), só o dono; o segredo só entra. Cada ajuste tem uma **versão** que só cresce (`versao` no `GET`; gravar e tirar sobem a versão, e tirar não zera). O `PUT` (`{ valor, confirm?, versao? }`) e o `DELETE` (`{ confirm?, versao? }`) aceitam a versão que a tela viu. Se outra tela (o painel do Discord ou outra aba) gravou no meio, a resposta é `409` e **nada é sobrescrito**; versão que não é um inteiro dá `400`; sem versão, grava sem conferir (pedidos antigos). O painel do Discord e o formulário "Modelos & Pensamento" do painel master levam a versão nos botões. É a correção C5 do parecer da Liz ([correções](../PLANO_LACUNAS_PAINEL_CORRECOES.md)).

**Planos pelo painel: o resumo seguro (correção C1):**
- No `GET /v1/admin/planos`, cada passo traz `resumo`, montado pelo servidor a partir do passo guardado (o mesmo que será executado). Os campos são:
  - `acao`: a frase do código, com os valores de lista fechada (período, pasta, parte do computador);
  - `servico`;
  - `acesso`: `leitura`;
  - `saida`: `internet`, `google`, `rede-local` ou `nao`;
  - `textoLivre`: só o campo e o número de caracteres do que a pessoa escreveu (o nome buscado, a consulta, o nome da lista), nunca o texto;
  - `soPelaDm`.
- O plano traz `aprovarSoPelaDm` quando algum passo manda texto da pessoa para fora (a pesquisa na web) ou não pode ser resumido. Nesse caso:
  - o `POST /v1/admin/planos/:id/decisao` com `aprovar: true` responde `409` ("aprove pela DM"), e o plano segue aguardando;
  - recusar pelo painel continua valendo;
  - a DM, onde o texto aparece, aprova normalmente.
- O hash, a versão e a validade continuam conferidos como antes.

**Chave de confirmação pela DM (correção C2):**
- **Onde vale:** aprovar um plano e começar a reautorização do Google pelo painel. Recusar um plano não pede chave.
- **Pedir:** `POST /v1/admin/confirmacao/pedir`, com `{ acao: "plano.aprovar", plano: { id, versao, hash } }` ou `{ acao: "google.reautorizar" }`. Só o dono; no `routeGuard` como `admin.discord_dm`.
- **A chave:** 6 dígitos, mandados **só pela DM** do dono. A resposta traz só `{ ok, acao, expiraEmSegundos }`.
- **Validade e escopo:** vale 5 minutos e uma vez, presa à sessão do painel que pediu (o resumo do Bearer), à ação e ao alvo. Pedir outra para o mesmo alvo invalida a anterior, e sair do painel leva as chaves da sessão.
- **Usar:** a ação manda `confirmacao` no corpo. As respostas:
  - sem chave: `428`;
  - inválida, vencida, de outra ação, de outro alvo ou de outra sessão: `422`, com uma frase só, que não diz o que estava errado;
  - 5 erros em 15 minutos: `429`, e o dono é avisado;
  - 10 pedidos em 15 minutos: `429` nos pedidos;
  - a DM que não saiu: `502`, e a chave dela não vale.
- **Auditoria:** `admin.confirmacao.pedida`, `usada`, `recusada` e `falhou`, só com a ação e o código, nunca a chave.
- **O que ela é:** usa o mesmo Discord do dono. É uma confirmação presa à operação, não um segundo fator independente.

**Ações negadas e pedidos repetidos (correção C6):**
- Toda tentativa **negada** de uma rota do painel que muda algo (as do `routeGuard`) vira a linha `admin.negado` na auditoria, só com a ação da matriz e o código HTTP: nunca a mensagem, o corpo nem os argumentos. Para não encher a auditoria, sai **no máximo uma linha por pessoa, ação e código por minuto**. As outras iguais nesse minuto só são contadas, e a contagem sai na próxima linha (`repetidas`).
- As ações que **não são idempotentes** têm um freio contra o clique duplo: o mesmo pedido do dono (mesma ação, mesmos argumentos), enquanto o primeiro roda ou até 5 s depois que ele deu certo, responde `429` "Muitos pedidos iguais seguidos..." e nada é feito de novo. Valem para criar e adiar lembrete, mandar o resumo do dia, reiniciar, testar um provedor de IA e tocar no rádio.
- Um pedido que **falhou** não segura o próximo.
- O freio não vale para:
  - pular faixa;
  - iniciar o rádio, que já recusa o segundo início;
  - seguir canal, banir e cadastrar chave ou provedor, que já recusam a duplicata;
  - sair da live, que funciona sempre.
- A lista é conferida em `npm run test:painelescritas`.

**O que o painel NÃO controla, de propósito:** o modo somente leitura, o login e a senha e os tokens de acesso. Isso só muda no `.env`, para um painel comprometido não conseguir se desbloquear nem trocar as próprias credenciais de entrada.

### Mensagem no Discord do dono

`POST /v1/admin/discord/dm` `{ message? }`: a Yui manda uma **mensagem privada** para o dono (sem texto, manda um teste). Até 1.500 caracteres, **5 por 10 minutos**; só o dono; a auditoria guarda só o tamanho. Responde `502` se o Discord recusar a DM e `503` se a Yui não estiver conectada. No app: **Admin → Geral → Mensagem no meu Discord**. Mande o corpo em UTF-8 (o app já faz isso).

### Rádio e logs

| Rota | O que faz |
|------|-----------|
| `GET /v1/admin/radio` | Sessões do Modo Rádio: servidor, call, estado, faixa atual e próxima, fila (`queueLength` e `upcoming`: as próximas até 10, **só título e duração**), aleatório/repetir e modo de voz |
| `GET /v1/admin/radio/:guildId/canais` | Os canais para iniciar o rádio (só leitura, só o dono; Yui fora do servidor: `404`): `voz` (id, nome, `pessoas` na call, `pode` entrar e falar, `motivo` `sem-permissao` ou `cheio`; o palco fica de fora) e `texto` (canais de texto e de anúncios, `pode` escrever com embeds). Só canais **deste** servidor |
| `POST /v1/admin/radio/:guildId` `{ action }` | `pause`, `resume`, `stop` (para a música e limpa a fila), `leave` (tira a Yui da call) e, desde a entrega E das lacunas do painel (item 10): `start` com `{ voiceChannelId, textChannelId }` liga o rádio **sem ninguém na call** (os dois canais têm de ser deste servidor e estar liberados em `canais`; senão `400` ou `409`; a Yui espera alguém entrar por até 10 minutos antes de sair do canal vazio); `skip` pula (`resultado` `tocando` com a `faixa` ou `fim-da-fila`); `play` com `{ query }` (gênero, música ou link, 2 a 200 caracteres) busca pelo mesmo `resolveInput` do rádio e responde `tocando`, `na-fila` (com a `faixa` ou `adicionadas` da playlist), `nao-encontrado` ou `escolher` com as `opcoes` (título, artista e duração); `choose` com `{ opcao }` escolhe pelo **número** (as faixas ficam guardadas no servidor por 5 minutos; vencida ou já usada: `409`). Sem sessão: `404`. A resposta nunca traz link, capa nem quem pediu; a auditoria `admin.radio` guarda só a ação e o servidor, **nunca a busca**. Mesma rota de sempre no `routeGuard` (`radio.play_control`); com o cérebro separado vai ao bot por `panel.admin` |
| `GET /v1/admin/logs?kind=&date=&level=&q=&limit=` | Últimas linhas dos logs, mais recentes primeiro. `kind`: `app` ou `error`; `date`: AAAA-MM-DD; `level`: `error`, `warn`, `info`, `debug`; `q`: busca no texto; até 500 linhas |

Os logs são **somente leitura** e só dos arquivos `app-AAAA-MM-DD.log` e `error-AAAA-MM-DD.log` da pasta de logs (nenhum caminho vem do cliente). Antes de sair do servidor, o texto passa por um filtro que **mascara segredos**: o valor de qualquer variável sensível do ambiente (nome com KEY, TOKEN, SECRET, PASSWORD, HASH, ARL ou COOKIE) e formatos conhecidos de chave (Google, Groq, Hugging Face, OpenAI/OpenRouter, token de bot do Discord, `Bearer ...`, `?key=...`). Stack traces ficam juntos da entrada que os gerou.

### Editar canais e seguidos

| Rota | O que faz |
|------|-----------|
| `PUT /v1/admin/guilds/:id/channels` `{ type: "noticias", "diario" ou "semanal", channelId: ID ou null }` | Define (ou limpa) o canal de publicação. Só canais de **texto** do próprio servidor |
| `POST /v1/admin/guilds/:id/youtube` `{ channel, discordChannelId, roleId?, videos?, shorts?, lives?, liveMode? }` | Passa a seguir um canal do YouTube (aceita @handle, ID UC... ou URL). `liveMode`: `auto` (padrão), `new` ou `edit` |
| `PUT /v1/admin/guilds/:id/youtube/:ytId/:discordChannelId` `{ liveMode: "auto" \| "new" \| "edit" }` | Muda como os avisos de live saem naquela inscrição (o detalhe do servidor devolve `liveMode` de cada canal seguido) |
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
| `bds.buscar` / `bds.listar` / `bds.recentes` / `bds.status` | Biblioteca de arquivos do **BDS Server** (filmes, séries, importações): busca por nome, lista uma pasta de uma lista fixa, últimos arquivos e espaço livre | OWNER, DM/canal privado, somente leitura (só `GET` na API do BDS Server). Existem só com `YUI_BDS_URL`, **mesmo sem** `YUI_TOOLS_PC_ENABLED` |
| `imagem.gerar` | Gera uma imagem nova a partir do texto (a mesma geração do `generate_image` do Discord) | Membro ou acima, com o limite por hora (o dono sem limite) e o filtro de conteúdo; só **aparece** com `YUI_APP_IMAGEM=true`. Vale no somente leitura (não mexe no computador). Veja [Imagem no Chat do app](#imagem-no-chat-do-app) |

Não existe ferramenta de shell livre. As ferramentas são registradas quando a API sobe; as do PC exigem `YUI_TOOLS_PC_ENABLED=true`, as da biblioteca `YUI_BDS_URL` e a da imagem só aparece com `YUI_APP_IMAGEM=true` (variáveis em [Variáveis de ambiente](ENVIRONMENT.md#-7-yui-core-agent-e-ferramentas-do-pc)). A ponte `registerMcpTools` (`src/core/agent/tools.js`) não tem chamador fora dos testes: o transporte MCP do Agent ainda não existe (veja [Assistente pessoal](ASSISTENTE_PESSOAL.md)).

A aba **Código** (as rotas `/v1/dev/*`, que liam e editavam projetos) saiu do app em 11/11/2026 e os restos dela saíram do servidor em 27/11/2026: as rotas, o módulo e as variáveis exclusivas (`YUI_DEV_APPROVAL`, `YUI_DEV_MAX_STEPS`, `YUI_DEV_PROJECTS_FILE`). Um pedido a `/v1/dev/*` hoje recebe `404`.

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
- No celular: instale o app **Tailscale**, entre na mesma conta e mantenha-o conectado; o computador onde a Yui roda (hoje, o notebook servidor) precisa estar ligado.
- Para o app Android, gere o build com `EXPO_PUBLIC_YUI_SERVER_URL=https://<seu-pc>.<sua-tailnet>.ts.net:3939`.
- Use as **ACLs** do Tailscale para limitar quais dispositivos alcançam a porta.
- Se você já usa o `tailscale serve` para outro serviço (por exemplo, na porta 443), a API na `3939` convive sem alterá-lo.
