# Plano de ativação e rollback do `enforce` (Fase 1)

Estado atual: produção (notebook) em `YUI_POLICY_MODE=observe` (padrão) e `YUI_READ_ONLY=true`. **Nada deste plano foi aplicado.** A ativação só acontece com a autorização expressa do dono, depois das evidências abaixo.

## 1. O que muda para o dono quando o `enforce` for ligado

Com `YUI_READ_ONLY=true` (como está hoje), o motor nega o que grava, apaga, bane ou altera o computador, **mesmo para o dono, no painel e no Discord**:

| Deixa de funcionar | Como continuar fazendo |
|---|---|
| Banir/desbanir (painel, `/yui-criador banir`, botões `adm_remoteban_*` e `banlist_unban_*`) | Desligar o somente leitura por um período (`YUI_READ_ONLY=false`) ou editar `bans.json` à mão |
| Apagar memória de outro usuário, reiniciar a Yui pelo painel, enviar/renomear/apagar/purgar no BDS, trocar chaves e provedores de IA | Idem |
| Painel global do bot (`/yui-criador bot_config`, `cfgpanel_toggle_*`) | Idem |
| Manutenção automática: atualização do yt-dlp e dos dados (tunables, veículos, armas) | Atualizar à mão no notebook, ou `YUI_READ_ONLY=false` |
| `commands.run` e escrita do módulo Código | Já eram bloqueados em somente leitura |

Continuam funcionando em `enforce` + somente leitura: conversa, buscas, lembretes e relatórios, publicações (Newswire, Reset Diário, Weekly, YouTube, Twitch), limpezas, downloads de música/vídeo, geração de imagem, a própria memória do usuário, configuração de servidor por administrador, leituras do painel.

Com `YUI_READ_ONLY=false` e `enforce`: o app remoto (Android/Tailscale) não faz ação crítica (trocar chaves de IA, purgar do BDS): isso só vale no computador da Yui; membros comuns não acessam rotas de administração; `commands.run` e escrita do Código exigem ticket aprovado no PC (`node scripts/yui-aprovar.mjs`, vale 60 s).

## 2. Pré-condições (todas devem estar verdes antes de pedir a autorização)

1. `npm run test:ci` verde em `observe` (comportamento atual preservado).
2. `npm run validar:enforce` verde (39 verificações em ambiente isolado; evidência em `docs/EVIDENCIA_ENFORCE.md`).
3. CI inteira com `YUI_POLICY_MODE=enforce`: só falham os testes que assumem `observe` e cada falha tem explicação registrada na seção 4 de `docs/AUDITORIA_FASE1.md`.
4. Observação em produção por alguns dias: revisar na auditoria os eventos `policy.evaluate` com `diverges` preenchido (`motor mais restritivo` mostra o que o `enforce` passaria a negar). Cada divergência é aceita ou corrigida (matriz ou código).

## 3. Ativação (somente com autorização expressa do dono)

No notebook, por SSH (chave `notebook_yui`), sempre com cópia do `.env` antes:

1. `Copy-Item C:\Yui\.env C:\Yui\.env.bak-enforce`
2. Acrescentar/alterar a linha `YUI_POLICY_MODE=enforce` em `C:\Yui\.env` (não mexer em `YUI_READ_ONLY`, a menos que o dono peça).
3. Reiniciar só pela tarefa agendada: `Stop-ScheduledTask YuiBot; Start-ScheduledTask YuiBot` (nunca encerrar processo por PID).
4. Conferir: `GET /v1/health` ok e Discord online; log sem erro de inicialização; `node scripts/yui-aprovar.mjs lista` responde.
5. Teste de fumaça (um de cada, sem efeitos destrutivos): uma conversa; `/yui-status`; no painel, uma leitura; uma tentativa de ação bloqueada (ex.: reiniciar pelo painel) deve devolver 403 com `policy`.
6. Observar 24 h: auditoria (`policy.route_blocked`, `policy.interaction_blocked`, `policy.job_skipped`) e logs; qualquer bloqueio inesperado de uso legítimo é motivo de rollback imediato.

## 4. Rollback (leva menos de 2 minutos, sem deploy)

1. `Copy-Item C:\Yui\.env.bak-enforce C:\Yui\.env -Force` (ou trocar a linha para `YUI_POLICY_MODE=observe`, ou apagá-la).
2. `Stop-ScheduledTask YuiBot; Start-ScheduledTask YuiBot`.
3. Conferir `GET /v1/health` e que a ação antes bloqueada voltou a funcionar.

O rollback também está provado no ambiente isolado (`validar:enforce`, verificações D1 a D3): trocar o modo desfaz os bloqueios na mesma execução.

Rollback de código (se o problema for no código e não na configuração): `git revert <commit>` e push no `main` (o atualizador aplica às 04:00, ou `Start-ScheduledTask YuiAtualizar` para aplicar na hora).

## 5. O que este plano NÃO cobre (pendências da Fase 1)

Tarefas do Windows (`YuiAtualizar`, `YuiBackup`, watchdog), download inicial de binários, `updateGtaCarsVehicles`, alertas/DMs automáticos, restrição do `baseUrl` de IA personalizado, checksum dos binários e commit fixo no atualizador. Ver `docs/AUDITORIA_FASE1.md`, seções 7b e 8.
