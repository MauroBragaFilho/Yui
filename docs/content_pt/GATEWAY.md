# 🧭 Yui Gateway — servidor de IA próprio

Um servidor de IA **compatível com a API OpenAI**, no estilo do OmniRoute, que roda dentro da própria Yui. Ele recebe um pedido e tenta vários provedores gratuitos ou baratos em ordem, **trocando sozinho** para o próximo quando um falha. Código em `src/gateway/`.

Ele tem **dois usos**, com o mesmo roteador:

1. **Dentro da Yui** (sempre que houver provedor configurado): a cadeia de IA chama o gateway **logo depois do LM Studio**, sem HTTP e sem chave.
2. **Como servidor HTTP** (`YUI_GATEWAY_ENABLED=true`): qualquer app (o seu `omniroute_client.py`, scripts, ferramentas de IA) usa `http://127.0.0.1:20130/v1` como se fosse a OpenAI.

```
Pergunta → LM Studio (local) ─falhou→ YUI GATEWAY ─falhou→ HF → Groq → Gemini → ... (cadeia antiga)
                                        │
                     Groq → Gemini → Hugging Face → OpenRouter → Cloudflare → Together → Pollinations
                     (por prioridade; cada um com failover, rodízio de chaves e descanso)
```

---

## ⚙️ Provedores

Entram **somente os que têm chave válida no `.env`** (chaves com menos de 10 caracteres são tratadas como "não configuradas"). O Pollinations é grátis e sem chave.

| Provedor | Variáveis | Modelos padrão |
|----------|-----------|----------------|
| **Groq** | `GROQ_API_KEY` (várias: `a,b`) | `openai/gpt-oss-120b`, `openai/gpt-oss-20b` |
| **Google Gemini** | `GEMINI_API_KEY` ou `GEMINI_API_KEYS` | `gemini-flash-lite-latest`, `gemini-flash-latest` |
| **Hugging Face** | `HF_TOKEN` | `HF_MODEL` (padrão `Qwen/Qwen2.5-72B-Instruct`) |
| **OpenRouter** | `OPENROUTER_API_KEY`, `OPENROUTER_MODELS` | `meta-llama/llama-3.3-70b-instruct:free` |
| **Cloudflare** | `CLOUDFLARE_API_TOKEN` **e** `CLOUDFLARE_ACCOUNT_ID` | `@cf/meta/llama-3.1-8b-instruct-fast` |
| **Together** | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo-Free` |
| **Pollinations** | nenhuma (grátis, **anônimo**) | `openai` |

> ⚠️ **Gemini:** o Google aposentou o `gemini-2.5-flash` e o `gemini-2.5-flash-lite` para contas novas (erro 404). Se o `.env` ainda tiver esses nomes, a Yui usa o apelido atual (`…-latest`) e avisa no log. Corrija `GEMINI_MODEL` e `GEMINI_MODEL_FALLBACK` no `.env`.

Ajustes opcionais:

```env
YUI_GATEWAY_DISABLE=pollinations,together        # desliga provedores
YUI_GATEWAY_PRIORITY=gemini,groq                 # ordem de preferência (os demais vêm depois)
YUI_GATEWAY_COMBOS={"rapido":["groq/openai/gpt-oss-20b","gemini/gemini-flash-lite-latest"]}
YUI_GATEWAY_CUSTOM=[{"id":"meu","baseUrl":"https://x.com/v1","apiKeyEnv":"MEU_KEY","models":["m1"],"priority":15}]
YUI_GATEWAY_IN_CHAIN=true                        # false tira o gateway da cadeia da Yui
```

Em `YUI_GATEWAY_CUSTOM` a chave **nunca** vai no JSON: só o nome da variável (`apiKeyEnv`) que a contém.

---

## 🧠 Como ele decide

**Escolha do modelo** (campo `model` do pedido):

| Valor | O que faz |
|-------|-----------|
| `auto` (ou vazio) | Todos os provedores, na ordem de prioridade |
| `smart` / `fast` | Só modelos "inteligentes" ou "rápidos" (cai em `auto` se não houver) |
| `nome-de-combo` | A lista que você definiu em `YUI_GATEWAY_COMBOS` |
| `provedor` | Só os modelos daquele provedor (ex.: `gemini`) |
| `provedor/modelo` | Exatamente aquele (aceita até modelos fora da lista, ex.: `groq/llama-3.3-70b-versatile`). **Não** cai em outro provedor |

**Failover e descanso** (disjuntor):

| O que aconteceu | O que o gateway faz |
|-----------------|---------------------|
| Erro de rede, tempo esgotado (25 s), 5xx | Passa para o próximo; o **provedor inteiro descansa** 30 s, depois 1 min, 2 min... até 15 min; um sucesso zera |
| 429 (limite) | Tenta **outra chave do mesmo provedor**; a chave limitada descansa (respeita `Retry-After`, padrão 60 s) |
| 401/403 (chave inválida) | A chave descansa 10 min |
| 402 (sem créditos) | O provedor inteiro descansa 30 min |
| 404 (modelo inexistente) | Só aquele modelo descansa 30 min |
| Resposta vazia (ex.: poucos tokens) | Tenta outro modelo; só esse modelo descansa 15 s |
| 400/422 (erro do pedido) | **Não** pune o provedor; se todos recusarem, devolve o 400 |

Limites por pedido: até **4 tentativas** e **60 s** no total. Se todos estiverem descansando, responde **503** dizendo em quantos segundos tentar de novo.

**Privacidade:** conversas **sensíveis** (contexto pessoal: você em DM, canal privado ou no app) **nunca** vão para provedores marcados como anônimos (Pollinations). Os demais provedores recebem o texto, como sempre aconteceu na cadeia atual; para dados realmente privados o caminho é IA local. O gateway **não registra** prompts nem respostas, e mensagens de erro passam por um filtro que esconde chaves.

---

## 🌐 Servidor HTTP (compatível com OpenAI)

Ligue no `.env` e reinicie a Yui:

```env
YUI_GATEWAY_ENABLED=true
YUI_GATEWAY_KEYS=uma-chave-longa-com-16-ou-mais-caracteres      # várias: "a,b"
# opcionais:
YUI_GATEWAY_HOST=127.0.0.1
YUI_GATEWAY_PORT=20130
```

Sem `YUI_GATEWAY_KEYS` o servidor **não sobe** (nunca fica aberto). Gere uma chave com `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

| Rota | Função |
|------|--------|
| `GET /health` | Público; só diz que está no ar |
| `GET /v1/models` | `auto`, `smart`, `fast`, seus combos e todos os `provedor/modelo` |
| `POST /v1/chat/completions` | Chat, com ou sem `"stream": true` (SSE). Devolve `x_gateway` com o provedor que respondeu |
| `GET /v1/gateway/status` | Saúde de cada provedor e modelo, descansos e contadores (nunca as chaves) |

```bash
curl http://127.0.0.1:20130/v1/chat/completions \
  -H "Authorization: Bearer $YUI_GATEWAY_KEY" -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Oi!"}]}'
```

Em qualquer biblioteca OpenAI, use `base_url = http://127.0.0.1:20130/v1` e a sua chave. **Streaming:** o failover acontece **antes do primeiro byte**; se o provedor cair no meio do texto, o cliente recebe um aviso e a conexão encerra (não dá para trocar de provedor no meio de uma resposta).

Segurança: escuta só em `127.0.0.1`; chave obrigatória em tudo (comparação em tempo constante); corpo máximo de 2 MB (acima disso responde `413`); 120 requisições/min por chave. Para acessar de outro aparelho, use o Tailscale (`tailscale serve`) e nunca abra a porta na internet.

---

## 🛠️ Painel

Na aba **Admin → IA** do app você vê cada provedor e modelo (disponível ou descansando, acertos, falhas e o último erro) e pode **zerar os descansos** depois de resolver um problema de chave ou crédito. Rotas: `GET /v1/admin/gateway` e `POST /v1/admin/gateway/reset` (só o dono).

A mesma aba também **configura** os provedores: colar chaves, ligar/desligar, testar e cadastrar provedores próprios, como o **OmniRoute** (modelo pronto: `http://127.0.0.1:20128/v1`, modelo `free-stack`). As chaves ficam em `secrets/ai-providers.json` e valem na hora. Para o OmniRoute (ou qualquer roteador próprio) há duas opções importantes: **"Colocar logo após o LM Studio"** (vai para o começo da fila do Gateway) e **"Sem conversas pessoais"** (ligado por padrão no modelo do OmniRoute, porque ele repassa para serviços de terceiros e suas conversas privadas só devem ir a provedores com conta sua). Dica: se o combo `free-stack` estiver instável, use `auto/best-fast` e `auto/best-chat`, que costumam responder em segundos. Detalhes e proteções em [Yui API](YUI_API.md#provedores-de-ia-chaves-e-provedores-próprios).

## 🧪 Testes

```bash
npm run test:gateway     # 42 testes: provedores, roteamento, failover, chaves, streaming e servidor
```

Os testes usam provedores falsos (inclusive um servidor HTTP de verdade) e **não chamam nenhum provedor real**.

## Limitações atuais

- As estatísticas ficam em memória e zeram ao reiniciar a Yui.
- Não há controle de custo/cota por provedor, só reação a erros (429/402).
- O AI Horde não está incluído (protocolo próprio) e continua apenas na cadeia antiga.
- Chamadas de ferramentas (`tools`) são repassadas ao provedor, mas a Yui continua usando o formato em texto da cadeia atual.
