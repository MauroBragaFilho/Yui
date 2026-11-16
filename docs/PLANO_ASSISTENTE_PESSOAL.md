# Plano: Yui como assistente pessoal (16/11/2026)

Junta o relatório da Liz (16/11), a `ESPECIFICACAO_MOTOR_POLITICAS_FASE1.md`, o `ROADMAP_EVOLUCAO.md` e a **análise do notebook por SSH feita em 16/11/2026** (somente leitura). Nada começa sem aprovação; nada é commitado por mim.

## 1. Estado real do notebook (Windows 10, 4 GB, 192.168.15.12)

| Item | Achado |
|---|---|
| Sistema | Windows 10 Home 19045 (**não é Linux**; o relatório da Liz estava errado nisso). Ligado desde 06/11, RAM livre ~1,3 GB, disco C: 421 GB livres |
| Tarefas | `YuiBot`, `YuiWebApp` rodando; `YuiAtualizar` (diária 04:00), `YuiBackup` (05:30) e `YuiWatchdog` (2 min) com último resultado 0 |
| Versão instalada | `f2f5b5a` = último commit do `main`; já tem `src/core/dev`, `src/search` e `skills.js` |
| API | `/v1/health` ok, Discord online, `readOnly: true`, escuta `0.0.0.0:3939` com firewall só `LocalSubnet` |
| `.env` | `YUI_READ_ONLY=true`, `YUI_DEV_ENABLED=true`, `YUI_TOOLS_PC_ENABLED=true`, busca `tavily,brave,duckduckgo,bing` (só há chave Tavily), `YUI_COMMANDS` e `skills/` ainda não usados |
| Tailscale | Instalado e conectado (`notebook-yui`), mas **sem `tailscale serve`**: fora de casa o app não alcança a API |
| Auditoria | `verifyAudit()` ok (3074 linhas; só 367 encadeadas, as antigas são anteriores ao encadeamento) |
| Erros de hoje | Só o Reddit 403 (conhecido) e um `EBUSY` das 00:01, anterior ao `f2f5b5a` que o corrige |

**Divergência a decidir:** `MEMORY_RETENTION_DAYS=0` em produção significa que a memória de **todos** os usuários do Discord **nunca expira**. A decisão documentada era 30 dias para os demais.

## 2. Ordem de trabalho (tarefas pequenas, cada uma com testes)

| # | Tarefa | Origem | Muda comportamento? |
|---|---|---|---|
| 1 ✅ | `.env_example` com placeholder; README/docs (DM de qualquer pessoa, Windows); GitHub Actions com a suíte offline (o atualizador instala o `main` sem testar) | Liz, R20 | Não |
| 2 ✅ | `src/core/security/permissionMatrix.js` e `policyEngine.js` em **modo observação** (só registra decisão na auditoria) + `tests/test-security-policy.js` | Fase 1, passo 1 | Não |
| 3 ✅ | `terminalSanitizer.js`: sem shell, lista de executáveis, bloqueio de `cmd /c`, `-enc`, `python -c`, `node -e`, `&&`, `\|`; remover `shell: true` de `dev/terminal.js` (npm via `node npm-cli.js`) | R03 | Sim (mais restrito) |
| 4 ✅ | Canal de aprovação crítica separado (loopback dedicado `127.0.0.1:3940` + segredo efêmero, 0600) e `ApprovalManager` (ticket de uso único, `paramsHash`, expiração) no lugar do `isLocalRequest` | R02 | Sim |
| 5 | Migrar Código, `commands.run`, `apps.open` e ações de admin para o motor; depois ligar o modo que **impõe** | Fase 1, passo 4 | Sim |
| 6 | Fase 0 restante: `git rm --cached` dos dados de runtime (R07); `verifyAudit` periódico com alerta; `tailscale serve` + regra de firewall para o app fora de casa; backup: confirmar restauração | R04/R07/R08 | Não / infra |
| 7 | Depois: migração gradual do `llmHandler.js` para o Agent único; Yui Desktop em `apps/desktop`; memória v2; aprovações nativas | Fases 2–4 | — |

Regras: nenhum teste destrutivo na Yui real; mudanças no notebook só por push no `main` (o `YuiAtualizar` aplica) ou com a sua autorização explícita; `YUI_READ_ONLY` continua `true` até o motor da tarefa 5 estar em vigor.

## 3. Decisões do dono (respondidas em 16/11/2026)

1. **Executáveis do terminal:** `git`, `node`, `npm`, `npx`, `pytest`, `python` (sem `-c`), `tsc`, `eslint`.
2. **Aprovação no PC:** começa por uma CLI local (`yui-aprovar`) via loopback com segredo efêmero; a janela da Yui Desktop vem depois.
3. **Expiração dos tickets:** 60 s (crítico) e 120 s (simples).
4. **Dados no Git:** autorizado `git rm --cached` **só do índice** (os arquivos ficam no disco). Reescrever o histórico NÃO foi autorizado.
5. **`MEMORY_RETENTION_DAYS=0`:** é intencional (memória de todos permanente); a documentação já descreve `0` = permanente.
6. **Acesso fora de casa (`tailscale serve`):** não por enquanto; o app segue só na rede local.
