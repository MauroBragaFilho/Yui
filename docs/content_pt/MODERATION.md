# 🛡️ Sistema de Segurança, AutoMod e TOS

A Yui opera sob uma filosofia de "Sanidade como Serviço". Este documento explica o fluxo técnico de proteção da Yui, desde a entrada em novos servidores até o bloqueio global de usuários maliciosos.

---

## 📂 Sumário

1. [⚖️ 1. O Fluxo de Termos de Serviço (TOS)](#-1-o-fluxo-de-termos-de-serviço-tos)
2. [🛡️ 2. Hierarquia do AutoMod](#-2-hierarquia-do-automod-automated-blocking)
3. [🔨 3. Comandos de Administração Remota](#-3-comandos-de-administração-remota)
4. [💡 Dicas de Moderação e Segurança](#-dicas-de-moderação-e-segurança)

---

## ⚖️ 1. O Fluxo de Termos de Serviço (TOS)

Ao ser adicionada a uma guilda, se `REQUIRE_TOS` estiver ativo (o padrão; só `REQUIRE_TOS=false` desliga):
1.  **Bloqueio Total do Servidor:** Todos os comandos, chats e interações da Yui no servidor são completamente bloqueados (menos para o dono), respondendo com um aviso de necessidade de aceitação do TOS.
2.  **Aviso para Administrador:** A Yui envia um embed interativo no primeiro canal útil ou no canal que foi convidada, solicitando a confirmação do TOS por um administrador do servidor (executando `/aceitar_tos` ou clicando nos botões interativos; vale *Administrador*, *Gerenciar Servidor* ou *Gerenciar Canais*). Se os termos forem **recusados**, a Yui sai do servidor.
3.  **Webhook de Auditoria:** O Dono do bot recebe, pelo webhook de avisos, uma notificação de servidor novo (com alerta de "Nome Suspeito" se o nome do servidor tiver um termo proibido) e os botões `Confirmar (Ignorar)` e `Remover Bot do Servidor`.
    - *Isso permite que você monitore quem está usando sua instância de forma segura.*

## 🛡️ 2. Hierarquia do AutoMod (Automated Blocking)

O sistema de AutoMod analisa prompts e contextos em busca de padrões proibidos (RegEx, Listas Negras e Análise Cognitiva). Todo servidor novo entra no modo `both` (gatilhos e IA); o dono muda por servidor com `/yui-criador automod`. O dono (`OWNER_ID`/`OWNER_IDS`) nunca é alvo do AutoMod. A punição segue uma hierarquia de três níveis:

### 🏙️ Nível 1: Servidor (Guild Ban)
- **O que checa:** O nome do servidor onde o bot foi convidado.
- **Trigger:** Palavras de ódio, conteúdo explícito ou nomes reservados.
- **Ação:** Na entrada, o dono recebe no webhook o alerta de "Nome Suspeito" (com o botão para remover o bot). Quando alguém conversa com a Yui nesse servidor com o filtro de gatilhos ativo (`trigger` ou `both`), o servidor vai para a lista de banidos e a Yui deixa de responder nele. Ela só sai do servidor se o dono clicar em **Remover Bot do Servidor**.

### 📺 Nível 2: Canal (Channel Block)
- **O que checa:** O nome do canal (`#general`, etc).
- **Trigger:** Termos proibidos no nome do chat (ex: canais de vazamentos ou pirataria explícita).
- **Ação:** As funções de IA são silenciadas especificamente naquele canal.

### 👤 Nível 3: Usuário (User Ban)
O bloqueio do usuário pode ser ativado por dois métodos simultâneos:
1. **Filtro de Gatilhos Rápido (Keyword Trigger, modos `trigger` e `both`):** Bloqueio imediato caso o prompt contenha termos sensíveis ou proibidos (ex: crimes graves, termos explícitos). No `/chat_resumo`, o que outras pessoas escreveram no canal não bane quem pediu o resumo.
2. **Análise Cognitiva da IA (AI AutoMod MCP, modos `mcp` e `both`):** O modelo avalia a intenção do chat de forma autônoma. Se identificar abusos verbais, assédio, xingamentos à Yui ou tentativas persistentes de manipulação (jailbreak), a IA executará a ferramenta `ia_automod` de forma autônoma, aplicando o banimento global definitivo.
3. **Moderação em Canais de Voz (Voice AutoMod):** As interações recebidas por voz em chamadas (`/entrar-call`) são transcritas e passam pelo AutoMod, com uma diferença no **modo voz** (quando **🔊 Resposta por Voz (TTS)** está ligado no servidor): o filtro de gatilhos **só alerta o dono** (aviso no webhook, com os botões de banir ou ignorar) e **não bane sozinho**, porque a transcrição erra e um banimento global por uma palavra mal ouvida seria injusto (decisão provisória). Nesse modo a Yui também não usa ferramentas por voz (a menos que `YUI_VOICE_TOOLS=true`), então a ferramenta `ia_automod` não é executada. Com o 🔊 desligado (o padrão) a voz segue as regras de sempre e a frase transcrita pode banir. Em qualquer modo, usuários banidos são sumariamente ignorados e impedidos de acionar o bot por voz ou conectar a Yui em canais de voz.

---

## 🔨 3. Comandos de Administração Remota

Todo alerta de segurança enviado via Webhook possui botões de ação imediata. Isso é processado de forma assíncrona.

São subcomandos do `/yui-criador` (restrito ao dono), com equivalentes no painel do app (**Admin → Servidores / Banimentos**):

- `/yui-criador banir tipo:[user|guild|channel] id:[ID] motivo:[texto]` (o motivo é gravado e mostrado com no máximo 300 caracteres; o painel do app recusa banir o dono, mas este subcomando não faz essa checagem, então confira o ID)
- `/yui-criador desbanir tipo: id:`
- `/yui-criador bans_lista`
- `/yui-criador automod servidor_id:[ID] modo:[off|trigger|mcp|both]` - Permite que os administradores mudem dinamicamente o comportamento de segurança de cada servidor individualmente:
  - `off`: Desativa qualquer AutoMod.
  - `trigger`: Ativa apenas o Filtro de Gatilhos Rápido.
  - `mcp`: Ativa apenas a moderação cognitiva da IA.
  - `both`: Ativa ambos os mecanismos de segurança.

---

## 💡 Dicas de Moderação e Segurança

- 💡 **Script enable_automod.js:** este script **não está no repositório** (nem na raiz nem em `scripts/`), então `node enable_automod.js` não funciona. Para mudar o modo de um servidor use `/yui-criador automod` ou o painel do app; servidores novos já entram em `both`.
- 💡 **Privado (DM):** a Yui só conversa no privado com o dono. Mensagens de outras pessoas na DM são ignoradas em silêncio, sem resposta nem aviso (os comandos de barra continuam valendo na DM).
- 💡 **Apelação:** a variável `APPEAL_CHANNEL_ID` não é mais lida pelo código; combine a apelação diretamente com o dono.
- 💡 **Memória dos usuários:** o dono vê quem tem memória e quantas lembranças (nunca o conteúdo) e pode apagar lembranças ou tudo de um usuário por `/yui-criador memorias` ou pelo app (**Admin → Memória**). Cada usuário controla a sua com `/yui-memoria`.
- 💡 **Painel e auditoria:** as ações administrativas feitas pelo app (AutoMod, banimentos, apagar memória, reiniciar) exigem o papel de dono no backend e ficam em `logs/core-audit.jsonl`. Veja [Yui API](YUI_API.md#-5-painel-de-administração).
- 💡 **Remoção Silenciosa:** Se você clicar no botão `Remover Bot do Servidor` no webhook administrativo, a Yui sairá do servidor de destino sem emitir nenhum aviso, evitando atritos desnecessários.
- 💡 **Trigger Word:** O log de aviso agora exibe exatamente a **Palavra Chave** que ativou o AutoMod, facilitando o discernimento entre ataques reais e falsos positivos.

---
[🏠 Voltar ao Menu Principal](../README.md)
