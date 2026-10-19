# 🧩 Comandos, skills e busca na web

Três coisas que a Yui faz no chat do app e no Discord (DM e canais privados do dono): **ver o estado do computador**, **rodar comandos que você cadastrou** e **seguir skills (receitas) que você escreveu**. Mais a configuração da **busca na web**.

---

## 🖥️ 1. Estado do computador (`system.info`)

"Como está o uso do sistema?" mostra SO, **CPU** (modelo e uso agora), **RAM**, **disco** e tempo ligado. Leitura apenas; funciona mesmo no modo somente leitura. O modelo pode pedir só uma parte (`cpu`, `memory`, `disk`, `uptime`); parâmetros inventados por ele são ignorados em vez de virar erro (era o "argumento desconhecido: cpu").

Precisa de `YUI_TOOLS_PC_ENABLED=true`. Os discos listados são o da pasta da Yui e os de `YUI_FILE_ROOTS`.

---

## ⌨️ 2. Comandos cadastrados (`commands.run`)

Não existe terminal livre. Você cadastra **nome = executável + argumentos fixos** no `.env`, e a Yui só executa pelo **nome**:

```env
YUI_COMMANDS=status-yui=git -C "D:/Projetos/Yui" status -s|limpar-dns=ipconfig /flushdns|backup=powershell.exe -File "D:/Scripts/backup.ps1"
```

- Separador `|`; aspas duplas agrupam argumentos com espaço. **Sem shell**: `;`, `&&`, `|` dentro do comando viram texto, não comandos.
- O pedido não aceita argumentos: o modelo só escolhe o nome. Para `npm`/`.cmd` use um `.ps1`/`.bat` chamado por `powershell.exe -File` ou `cmd.exe /c`.
- **Pede confirmação** a cada execução (botões do app, 2 minutos) e **só vale com `YUI_READ_ONLY=false`**. No modo somente leitura a ferramenta nem aparece.
- Tempo limite de 25 s, saída cortada em ~3.500 caracteres e o ambiente **sem as suas chaves** (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`...).
- `commands.list` mostra o que está cadastrado (leitura).
- Fica na auditoria (nome da ferramenta, nunca a saída).

Para programar no seu projeto, com mais liberdade e aprovação por ação, use a aba [Código](CODIGO.md).

---

## 🧠 3. Skills

Skill é uma **receita em texto** que você escreve para a Yui seguir quando o pedido combina: "resumo do dia", "revisar texto", "plano de treino".

```
skills/
├── resumo-do-dia/SKILL.md
└── treino.md
```

```markdown
---
name: resumo-do-dia
description: Monta um resumo curto das pendências e prioridades do dia
---
Responda em no máximo 3 tópicos curtos. Comece pelo mais urgente.
Se faltar informação, pergunte uma coisa só.
```

- A pasta é `skills/` na raiz da Yui (mude com `YUI_SKILLS_DIR`). Nome: letras minúsculas, números e hífen. Arquivo de até 20 KB. É **relida a cada uso**: editar vale na hora, sem reiniciar.
- A Yui vê só **nome + descrição** e, se o pedido combina, segue a skill numa segunda resposta.
- **Só o dono**, em **DM ou canal privado**. Membros e canais públicos não veem skills.
- **Uma skill é só texto**: não ganha ferramentas, não executa nada e roda numa conversa sem ferramentas. O que a Yui pode fazer continua decidido pelo backend.
- Skills são instruções **suas**: não coloque ali texto de terceiros.

---

## 🔎 4. Busca na web

A Yui tenta os provedores em cadeia e usa o primeiro que responder:

| # | Provedor | Precisa de | Observação |
|---|----------|------------|------------|
| 1 | **Brave** | `BRAVE_API_KEY` | API oficial, plano gratuito mensal |
| 2 | **Tavily** | `TAVILY_API_KEY` | API feita para IA, plano gratuito mensal |
| 3 | **SearXNG** | `SEARXNG_URL` | Servidor seu (Docker), sem chave e sem limite; ative `json` em `search.formats` |
| 4 | **DuckDuckGo** | nada | Página pública; pode limitar |
| 5 | **Bing** | nada | Leitura da página (scraping), **só último recurso**: quebra se o layout mudar |

```env
BRAVE_API_KEY=...
TAVILY_API_KEY=...
SEARXNG_URL=http://127.0.0.1:8080
# Ordem e conjunto (opcional; padrão: brave,tavily,searxng,duckduckgo,bing). Recomendado:
YUI_SEARCH_PROVIDERS=tavily,brave,duckduckgo,bing
```

- Provedor sem chave/endereço é pulado. **Chave com menos de 10 caracteres é ignorada** (por exemplo o texto-modelo `opcional`): deixe a linha comentada ou vazia enquanto não tiver a chave.
- **Descanso dos provedores:** bloqueio leve (HTTP 202, página de desafio/anti-robô, DuckDuckGo sem resultados nem marcação de busca) descansa 1, 2, 4... até 30 minutos; cota esgotada (402, 432, 433, 429 de cota) descansa 1 hora; 401/403 descansam 30 minutos; timeout, erro de rede e 5xx descansam de 30 s até 5 minutos. `Retry-After` do provedor é respeitado. Uma página de busca legítima sem resultados não faz o provedor descansar.
- **Limites:** `YUI_SEARCH_USER_PER_HOUR` (padrão 5 pesquisas por pessoa por hora), `YUI_SEARCH_MONTHLY_CAP_TAVILY` e `YUI_SEARCH_MONTHLY_CAP_BRAVE` (padrão 900 por mês cada, contador em `secrets/search-budget.json`, que o Git ignora) e `YUI_SEARCH_DEADLINE_MS` (padrão 12 s para a pesquisa inteira). `YUI_SEARCH_CACHE_TTL_MIN` guarda resultados repetidos por N minutos (padrão `0`, desligado; nunca guarda os da Brave, que os termos proíbem).
- **Privacidade:** conversa privada ou sensível (o dono em DM ou canal privado, a DM de qualquer pessoa e o app) **não pesquisa por padrão** (a consulta sairia para terceiros); só o `YUI_PRIVATE_SEARCH` (`off`, `owner` ou `all`) libera, com proteções próprias: veja "Agente de pesquisa" em [Variáveis de ambiente](ENVIRONMENT.md). O log registra só o provedor, o status, o tempo e a quantidade de resultados, nunca o texto da pergunta.
- Depois da busca, a Yui lê o conteúdo das 3 melhores páginas, só por `http`/`https` e nunca de endereços internos, com limite de tamanho. O resultado entra na conversa como dado **não confiável**, cercado por uma marca, e a IA fica sem ferramentas naquela chamada; nunca vira ordem.
- **Admin → Integrações** mostra quais estão configurados (e quais foram ignorados por chave curta). Cotas gratuitas mudam: confira no site de cada serviço.

---

## 🩺 Problemas comuns

| Sintoma | O que fazer |
|---------|-------------|
| "Pedido inválido para system.info" | Corrigido: argumentos extras são ignorados. Atualize e reinicie |
| Comando não aparece / "Não posso fazer isso aqui" | `YUI_READ_ONLY=true` bloqueia comandos; ou falta cadastrar em `YUI_COMMANDS` |
| "executável não encontrado" | Use o caminho completo do programa ou um `.ps1` |
| Skill não é usada | Confira o arquivo (nome válido, `description` clara, até 20 KB) e que está em DM/canal privado |
| Busca sem resultado | Veja o log: `[Search] provider=... status=... falhou` mostra cada provedor e `[Search] sem resultados (...)` lista os motivos (cota, bloqueio, limite por pessoa, prazo) |
