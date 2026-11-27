# Levantamento: lacunas do painel web (26/11/2026)

Material bruto para o plano das lacunas (pedido do Braga em 26/11). Só leitura do código; nada foi alterado. O plano em ordem de importância ainda será escrito a partir daqui.

## Lacunas (inventário)

1. Painel Runtime da IA só no Discord (`src/handlers/configPanelHandler.js`): modelos, temperatura, timeout, max_tokens, prompt do sistema, prefixo, mostrar modelo.
2. GTA: sem tela do que saiu (Van de Armas, semanal, Newswire), consulta ou republicar; `GTA_WEEKLY_ENABLED`/`NEWSWIRE_ENABLED` só no .env.
3. Monitores: API pronta (`GET/DELETE /v1/admin/monitores`), o `client.ts` não chama.
4. Google: sem estado da autorização nem item em Integrações.
5. Fase 3: sem tela de planos (aprovar/histórico) nem da fila de avisos adiados.
6. YouTube Live: sem cartão de estado, entrar/sair, cota.
7. Rádio: falta iniciar, pular, fila, gênero.
8. Imagem, downloads, buscar jogo sem tela; o Chat do app não gera imagem.
9. Listas pessoais, skills instaladas, continuidade: não aparecem.
10. Chaves só no .env: `GTA_WEEKLY_ENABLED`, `NEWSWIRE_ENABLED`, `YUI_RESEARCH_ENABLED`, `YUI_MEMORY_ENABLED`, `YUI_LISTS_ENABLED`, `YUI_REMINDERS_ENABLED`, `YUI_VISION`, `YUI_AUTOMOD_AI_BAN`, `REQUIRE_TOS`, `YUI_HEALTH_REPORT`.

Já coberto (não refazer): Servidores (canais, YouTube/Twitch, AutoMod, ferramentas, Termos, persona/falas, menções), Bans, Memória, aba IA, Configuração e chaves (~80 ajustes), Lembretes/relatório, Arquivos (BDS), Rádio básico, Logs/Auditoria/Integrações/Status.

## Detalhes técnicos

### Cofre (`src/core/painelConfig.js`)
- Item nasce de `bool`/`inteiro`/`opcao`/`texto`/`segredo` (:31-35). Campos: `chave, rotulo, grupo, descricao, tipo, reinicio, padrao`, `min/max`, `opcoes`, `max/formato/validar`, `secreto`, `confirmar: [...]`, `soNaSubida`. Novo ajuste = uma linha + teste + doc (:40).
- `reinicio:false` só se todo consumidor nos dois processos lê a cada uso (:15). Recarga: cérebro aplica (:347) e emite `painel.settingsChanged` (`src/cerebro/painel.js:171`); bot recebe em `src/discord/canalCerebro.js:310` → `applyPanelSettingsChange` (:318) → `recarregarAoVivo` (:313), só itens `reinicio:false`. `soNaSubida` não muda nem no cérebro (:301).
- `confirmar` exige `confirm:true` para gravar o valor ou remover (`exigeConfirmacao`, :332). Segredo nunca sai (só os 4 últimos, :382).
- Leitura das 10 chaves: `GTA_WEEKLY_ENABLED` (`src/config/index.js:60`), `NEWSWIRE_ENABLED` (:28), `REQUIRE_TOS` (:85) na SUBIDA (reinicio:true); `YUI_LISTS_ENABLED` (`listAssistant.js:200`), `YUI_REMINDERS_ENABLED` (`reminders/assistant.js:396`), `YUI_VISION` (`vision.js:34`), `YUI_AUTOMOD_AI_BAN` (`llmHandler.js:955`), `YUI_HEALTH_REPORT` (`healthReport.js:290`), `YUI_MEMORY_ENABLED` (`discordAdapter.js:21`) a cada uso; `YUI_RESEARCH_ENABLED` não confirmado. Nenhuma tem motivo documentado para ficar fora.
- Sugestões: `YUI_AUTOMOD_AI_BAN` com `confirmar:['auto']`; desligar `YUI_MEMORY_ENABLED`/`REQUIRE_TOS` com confirmação; `reinicio:false` só depois de conferir os consumidores.

### Por servidor
- Ferramentas: `src/data/server_tools.json` `{guildId:{enabled[],disabled[]}}` (`llmHandler.js:181-245`), padrão em `meta.defaultDisabled` de `src/data/mcp_tools.json`. Persona/falas: `src/data/channel_settings.json` (`llmHandler.js:433`). Menções/atualizações: `src/data/server_settings.json` (:493). Canais GTA: banco do bot (`admin.js:197`; `publisher.js:92,127`).
- Ponte: `src/discord/painelServidor.js`; com cérebro separado cada ação em `PANEL_ACTIONS` (`src/cerebro/painel.js:19-45`). Rotas `server.js:313-328` e 338-349; rota nova de escrita entra em `ROUTES` de `src/core/security/routeGuard.js:13-62`.
- Reaproveitável: já alternáveis `generate_image`, `search_web`, `gta_online`, `download_*`, `search_game`, `check_steam`, `convert_currency`, lembretes, voz. Porém `/yui-imagem` não chama `isToolDisabled` (`interactionCreate.js:824-832`) e a Porta G não confere `gta_online` (`llmHandler.js:2831`); Porta I (:2885) e pesquisa (`manager.js:357`) respeitam. Publicação GTA é por canal. Monitores são só do dono (DM).

### Painel Runtime (`configPanelHandler.js`, roda no bot)
- 40 páginas (`CONFIG_PAGES` :16+): 20 "runtime" (showModel, showModelThinking, errorRetries, temperatura/timeout/max_tokens/top_p de local/gemini/pollinations/hf/horde) só em memória (`llmHandler.js:383`, 4679-4716), somem ao reiniciar; 20 "json" (prefix, botName, appealChannelId, requireTos, saveHistory, keepMusicEmbed, defaultAutoMod, automodMode, sendEnvironmentInfo, modelos/URLs Gemini/HF/local/Groq/Horde, systemPrompt) gravadas em `src/config/config.json` (:798-812), mas NÃO lidas ao subir (:523-525); o .env vence (`envConfigMap` :506-521). Sem rota de API. Uso pelo cérebro: não confirmado.

### Rotas existentes x faltando
- Existem e o app não usa: `GET /v1/admin/monitores` (`{ligado, monitores:[{id, consulta≤60|null, estado, proximaChecagem, ate, avisos, entrega?, fim?}], resumo?}`, `admin.js:459-464`), `DELETE /v1/admin/monitores/:id` (:466, já no routeGuard, só com cérebro separado), `POST /v1/admin/ia/rota-privada/verificar` (`server.js:416`).
- Não existem: Google (há `estado()` em `src/integrations/google/google.js:193`), Planos (`src/core/planos/store.js:9`), Avisos (`src/core/avisos/fila.js:29`), YouTube Live (`live/servico.js:174` `estado()`; só pré-rota `preRotas.js:50-56`), GTA (`getLatestDaily` `dailyRepo.js:12`, `getLatestValidWeekly` `weeklyRepo.js:20`, `publicationRepo.getPublished`), Skills (`carregarCatalogo` `carregador.js:218`, `textoDaLista` `catalogo.js:127`), Listas, Continuidade.

### Rádio
- Hoje só `pause|resume|stop|leave` com sessão existente (`radioAdmin.js:7`; `admin.js:926-939`), já em `PANEL_ACTIONS`/routeGuard (`radio.play_control`).
- Iniciar: `startRadioMode(member, textChannel, client)` (`radioManager.js:93`) exige membro na call → variante com `voiceChannelId`+`textChannelId` (`createSession`, `radioDatabase.js:76`). Pular: `nextTrack` + `playTrack` (`radioMCPHandler.js:151-159`; `radioAudioPlayer.js:395`). Gênero/música: `resolveInput(query, guildId)` (`radioMCPHandler.js:48-60`), ambíguo pede escolha. Mudar em `RADIO_ACTIONS` e `defaultRadioDeps`.

### Imagem no Chat do app
- `/v1/agent` (`server.js:659`) → pré-rota + pesquisa → `runAgent` com o registro de `src/core/agent/tools.js` (só `bds.*` e PC). `generate_image` só no Discord (`mcp_tools.json`). Resposta só texto `{type, reply, tool, pendingId}` (`agent.js:103,179`).
- Precisa: `registerTool` de imagem com política e `YUI_IMAGE_PER_HOUR`; pré-rota em `preRotas.js` (princípio 9); campo de imagem na resposta (link curto do BDS, `server.js:266-271`); exibir no `ChatScreen`; routeGuard e matriz de permissões. `generateImage` (`src/handlers/imageHandler.js:307`) não depende do Discord (grava em `src/data/temp_images`); rodar no cérebro: não confirmado.

### O que o painel nunca controla
- `ASSISTENTE_PESSOAL.md:265`: somente leitura, senha e tokens só no .env; chaves de IA entram e nunca voltam; `YUI_PANEL_AI_EDIT=false` trava.
- `painelConfig.js:7-9`: token do Discord, senha/sessão do painel, dono, políticas de segurança, rota privada, Gmail, retenção da memória, caminhos de arquivo e comandos. `YUI_PAINEL_CONFIG_EDIT=false` trava toda edição.
- `ASSISTENTE_PESSOAL.md:292`: o painel não bane o dono; toda ação auditada. Rota privada: o painel só pede verificação (`server.js:415`). Termos: aceite explícito com `confirm` e `emNomeDeTerceiros`; revogar não tira o bot do servidor (`painelServidor.js:47`).
