# Evidência da validação do enforce (ambiente isolado)

Gerado por `npm run validar:enforce` em 2026-11-17T13:10:45.574Z. Resultado: **39/39** verificações.

Ambiente: API real em 127.0.0.1 (porta livre), canal local de aprovação real, banco/auditoria/segredo em pasta temporária, IA falsa e ferramenta falsa no lugar de `commands.run` (nada é executado). Sem rede, sem chaves, sem produção.

| ID | Verificação | Resultado |
|---|---|---|
| A1 | POST /v1/admin/bans pelo dono no PC -> 403 da política | PASSOU |
| A2 | DELETE /v1/admin/memory/users/222 pelo dono no PC -> 403 da política | PASSOU |
| A3 | POST /v1/admin/restart pelo dono no PC -> 403 da política | PASSOU |
| A4 | POST /v1/admin/bds/delete pelo dono no PC -> 403 da política | PASSOU |
| A5 | POST /v1/admin/ai/keys pelo dono no PC -> 403 da política | PASSOU |
| A6 | Discord: dono tenta banir (/yui-criador banir) em DM -> bloqueado | PASSOU |
| A7 | Discord: botão de ban remoto vindo do webhook -> bloqueado | PASSOU |
| A8 | Prefixo: membro comum não configura canais com "+yui configurar" | PASSOU |
| A9 | Jobs: manutenção (yt-dlp e dados) pulada em somente leitura | PASSOU |
| A10 | Jobs: publicar, lembrar e limpar seguem funcionando em somente leitura | PASSOU |
| A11 | Membro comum chamando rotas de administração -> 403 da política | PASSOU |
| A12 | App remoto (Android/Tailscale) em ação crítica (trocar chaves de IA, apagar de vez no BDS) -> 403 "só no computador" | PASSOU |
| A13 | Agent: commands.run vindo de origem remota -> negado | PASSOU |
| A14 | Discord: membro comum não configura servidor, não segue canais, não mexe na IA | PASSOU |
| A15 | Discord: administrador do servidor continua configurando o próprio servidor (sem regressão) | PASSOU |
| A16 | Módulo Código: secrets/, .git/ e git --output recusados | PASSOU |
| A17 | Adivinhação de token: 20 Bearer inválidos travam a origem (429), mesmo com o token certo depois | PASSOU |
| B1 | Agent (origem LOCAL_PC): commands.run vira pedido de aprovação e NÃO executa | PASSOU |
| B2 | Confirmar no chat sem aprovar no PC: continua pendente, nada executa | PASSOU |
| B3 | Tentativa de aprovar por origem REMOTA (o que o app Android faria) é recusada | PASSOU |
| B4 | Canal local recusa: sem segredo (401), segredo errado (401), cabeçalho de proxy (403), navegador/Origin (403) | PASSOU |
| B5 | Aprovação no PC (canal local com segredo) muda o ticket para APROVADO | PASSOU |
| B6 | Depois de aprovado, a confirmação no chat executa UMA vez | PASSOU |
| B7 | Reuso (replay) do mesmo ticket é negado e nada executa de novo | PASSOU |
| B8 | Aprovar de novo um ticket já usado é recusado (409) | PASSOU |
| B9 | Ticket com parâmetros adulterados: o hash não confere e nada executa | PASSOU |
| B10 | Ticket crítico expira em 60 s: depois disso não pode ser aprovado | PASSOU |
| B11 | Rejeitar pelo chat cancela o ticket (nenhum pedido pendente sobra) | PASSOU |
| B12 | Auditoria registra o ciclo (criado, aprovado, executado) e a cadeia de hash está íntegra | PASSOU (63 eventos, cadeia íntegra) |
| C:GET /v1/health | mesmo status em observe e em enforce (somente leitura ligado) | PASSOU (status 200) |
| C:GET /v1/me | mesmo status em observe e em enforce (somente leitura ligado) | PASSOU (status 200) |
| C:GET /v1/admin/overview | mesmo status em observe e em enforce (somente leitura ligado) | PASSOU (status 200) |
| C:GET /v1/admin/bans | mesmo status em observe e em enforce (somente leitura ligado) | PASSOU (status 200) |
| C:GET /v1/memory | mesmo status em observe e em enforce (somente leitura ligado) | PASSOU (status 200) |
| C:POST /v1/chat | mesmo status em observe e em enforce (somente leitura ligado) | PASSOU (status 200) |
| C:memória | dono apaga a própria memória em enforce + somente leitura (permitido pela matriz) | PASSOU |
| D1 | enforce bloqueia; trocando YUI_POLICY_MODE=observe a MESMA requisição deixa de ser bloqueada pelo motor | PASSOU |
| D2 | Jobs: em observe a manutenção volta a rodar | PASSOU |
| D3 | Agent: em observe o comportamento antigo (confirmação simples, sem ticket) volta | PASSOU |
