Texto para acrescentar na memória do projeto "Yui" no Braga AI Hub (seção Documentação ou Histórico de alterações).

2026-11-06 — Produção e memória da Yui
- A Yui passou a rodar no notebook secundário (ASUS X450LD, Windows 10, 4 GB de RAM, HD), IP 192.168.15.6, acesso por SSH com chave. No Neon as tarefas YuiBot e YuiWebApp estão desativadas: nunca ligar as duas Yuis com o mesmo token do Discord.
- No notebook, tarefas do Windows (conta SYSTEM, iniciam sozinhas no boot): YuiBot (src/index.js, reinicia se cair), YuiWebApp (http://localhost:8081, só local), NgrokMinecraft (aguarda ngrok.exe e token) e MinecraftFabric (Fabric 1.21.1 com e4mc). ModpackServer e MinecraftServer (Paper) são manuais.
- Scripts novos em scripts/: instalar-tudo-offline.ps1 (instalação sem internet a partir do pendrive), instalar-ssh.ps1 (SSH, com correções para Windows em português), otimizar-windows.ps1 (simulação por padrão; só altera com -Aplicar) e modpack/.
- Memória e resumo por conversa (src/handlers/chatIntents.js, teste npm run test:chatintents): "o que você sabe de mim?", "esquece a lembrança #3", "apaga tudo" (pede confirmação em 2 minutos) e "yui resume as últimas N mensagens" (5 a 100, 1 por minuto). Em canal público a lista de lembranças não é mostrada, só a contagem.
- Atualização automática (pendente de instalação no notebook): scripts/atualizar-yui.ps1 verifica o GitHub 1 vez por dia (04:00), atualiza sem tocar em .env, bancos, segredos e logs, e volta a versão anterior se a Yui não subir.
- Limite conhecido: o modpack Dungeon Heroes (238 mods) não sobe com 4 GB de RAM.
