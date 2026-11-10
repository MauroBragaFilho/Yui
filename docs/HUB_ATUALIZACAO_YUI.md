Texto para acrescentar na memória do projeto "Yui" no Braga AI Hub (seção Documentação ou Histórico de alterações).

2026-11-06 — Produção e memória da Yui
- A Yui passou a rodar no notebook secundário (ASUS X450LD, Windows 10, 4 GB de RAM, HD), IP 192.168.15.6, acesso por SSH com chave. No Neon as tarefas YuiBot e YuiWebApp estão desativadas: nunca ligar as duas Yuis com o mesmo token do Discord.
- No notebook, tarefas do Windows (conta SYSTEM, iniciam sozinhas no boot): YuiBot (src/index.js, reinicia se cair), YuiWebApp (http://localhost:8081, só local), NgrokMinecraft (aguarda ngrok.exe e token) e MinecraftFabric (Fabric 1.21.1 com e4mc). ModpackServer e MinecraftServer (Paper) são manuais.
- Scripts novos em scripts/: instalar-tudo-offline.ps1 (instalação sem internet a partir do pendrive), instalar-ssh.ps1 (SSH, com correções para Windows em português), otimizar-windows.ps1 (simulação por padrão; só altera com -Aplicar) e modpack/.
- Memória e resumo por conversa (src/handlers/chatIntents.js, teste npm run test:chatintents): "o que você sabe de mim?", "esquece a lembrança #3", "apaga tudo" (pede confirmação em 2 minutos) e "yui resume as últimas N mensagens" (5 a 100, 1 por minuto). Em canal público a lista de lembranças não é mostrada, só a contagem.
- Atualização automática (pendente de instalação no notebook): scripts/atualizar-yui.ps1 verifica o GitHub 1 vez por dia (04:00), atualiza sem tocar em .env, bancos, segredos e logs, e volta a versão anterior se a Yui não subir.
- Limite conhecido: o modpack Dungeon Heroes (238 mods) não sobe com 4 GB de RAM.

2026-11-10 — Reconexão do Discord, biblioteca por conversa e documentação
- Alerta "Erro grave na Yui: Opening handshake has timed out" (madrugada de 10/11): o Wi-Fi do notebook ficou fora de ~23h41 a ~00h20 e um defeito da biblioteca @discordjs/ws (o destroy da reconexão solta o tratador de erro de uma conexão ainda em andamento) virou exceção não capturada. A Yui reconectou sozinha. Corrigido em src/discord/gatewayGuard.js (a conexão antiga ganha um tratador que só registra no log) e em src/core/alerts.js (essa falha de rede não vira mais DM de "Erro grave"). Teste: npm run test:discordreconnect, que reproduz o defeito com a biblioteca real.
- Biblioteca por conversa (Porta B): "yui procura Matrix na biblioteca", "o que eu tenho de filmes?". O código consulta o BDS Server só para leitura, só para o dono e só no privado; desligada sem YUI_BDS_URL. Teste: npm run test:library.
- Notebook hoje: IP 192.168.15.12 (DHCP, muda), tarefas YuiBot, YuiWebApp, YuiAtualizar (atualização diária pelo GitHub, já instalada), OmniRoute (porta 20128) e BDSServer (porta 80), todas como SYSTEM.
- Documentação revisada inteira contra o código: produção no notebook (não mais no PC), atualizador automático, avisos, testes novos.
- Correção do registro de 06/11: a memória e o resumo do chat por conversa (Portas N e R, src/handlers/chatIntents.js) estão prontos e testados, mas ainda NÃO foram ligados ao fluxo da conversa (nenhum arquivo de src/ chama o módulo). Por enquanto essas frases não funcionam; continuam valendo o /chat_resumo e a administração da memória pelo /yui-criador memorias.
