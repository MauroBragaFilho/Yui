# 💬 Conversa e comandos: toda função também pelo chat

**Princípio permanente (decisão do dono, 2026-11-05):** toda função da Yui deve poder ser acionada **também pela conversa**, não só por comando de barra (`/`) ou prefixo (`+yui`). Os comandos são atalhos. A pessoa diz "yui, gera uma imagem" e a Yui faz.

Está registrado como princípio 9 em [Assistente pessoal](ASSISTENTE_PESSOAL.md#-1-princípios). Este documento é o **quadro de estado**: o que já funciona por conversa e o que falta.

## Regras para qualquer função acionada por conversa

1. **O código decide a rota.** Uma *pré-rota* estrita reconhece o pedido (como a Porta I da imagem) e chama a função direto. Depender só de o modelo lembrar de chamar a ferramenta falha de vez em quando; o modelo continua valendo como segunda via.
2. **Mesmas verificações do comando.** Papel, permissão do Discord (`ManageGuild`/`ManageChannels` etc.), filtro de conteúdo, limites por hora, ferramenta desligada no servidor (`/yui-ferramentas`) e política de autonomia.
3. **Função sensível ou irreversível pede confirmação pelo chat** e só vale para quem tem a permissão: banir, configurar servidor, seguir ou parar canais, gravar ou executar no PC. Nunca por texto de terceiros, anexo, página da web, voz ou rádio.
4. **Estrito de propósito.** A pré-rota não dispara em pergunta ("você consegue gerar imagem?"), negação, texto colado, link, voz ou conversa espontânea. Na dúvida, segue para o modelo.
5. **Toda função nova nasce com a rota de conversa e o teste dela**, offline.
6. **Exceção por segurança:** o aceite dos Termos de Uso (`/aceitar_tos`) continua explícito por comando/botão, porque consentimento não pode ser inferido de uma frase solta.

## Estado atual (leitura do código em 2026-11-05; nada aqui foi verificado em um Discord real)

Revisado de novo contra o código em 2026-11-10 (Porta B, nomes dos comandos); em 2026-11-10 as Portas N e R foram ligadas ao `llmHandler`. Lembrete: "pela conversa" vale em servidor (menção, nome da Yui ou resposta a ela) e na DM **do dono**; a DM de qualquer outra pessoa é ignorada em silêncio (essas pessoas usam os comandos).

Legenda: ✅ por conversa · 🔶 parcial · ⚠️ módulo pronto e testado, ainda não ligado ao fluxo da conversa · ❌ só por comando · 🔒 exige confirmação/política quando for feito

| Função (comando) | Pela conversa | Observação |
|---|---|---|
| Gerar imagem (`/yui-imagem`) | ✅ | **Porta I** (código) + ferramenta `generate_image`; pedido vago ("yui gera uma imagem") escolhe um assunto criativo; limite `YUI_IMAGE_PER_HOUR`. Teste: `npm run test:imageintent` |
| Pesquisar na web (`/yui`, `+yui perguntar`) | ✅ | Agente de pesquisa (Portas A a D); pré-rota com `YUI_RESEARCH_PRE_ROUTE` |
| Buscar jogo/torrent (`/buscar_jogo`) | ✅ | ferramenta `search_game` |
| Baixar vídeo por link (`/baixar_video`) | ✅ | ferramenta `download_video` |
| Baixar áudio por link / música por nome (`/baixar_musica`) | ✅ | `download_audio`, `search_and_download_music` |
| Preço na Steam (`/steam_jogo`) | ✅ | `check_steam` |
| Converter moeda (`/converter_moeda`) | ✅ | `convert_currency` |
| Menu de ajuda (`/ajuda`) | ✅ | `show_bot_menu` |
| Entrar/sair da call (`/entrar-call`, `/sair-call`) | ✅ | `join_voice_call`, `leave_voice_call` |
| Baixar a música do seu status (`/baixar_musica_atual`) | ✅ | ferramenta `get_current_music` ("yui, baixa a música do meu status"); por conversa vale só a música de quem pediu |
| Info de jogo e "meu PC roda?" (sem comando de barra) | ✅ | ferramentas `check_game_info` (RAWG + HowLongToBeat) e `check_pc_compatibility` |
| Listas pessoais | ✅ | Porta L ("anota na lista X: ...") |
| Lembretes e resumo do dia (só o dono) | ✅ | **Porta T** ("me lembra amanhã às 9h de pagar a conta", "meus lembretes", "cancela o lembrete 2", "adia o lembrete 2 por 30 minutos", "resumo do dia"); o aviso sai por DM no minuto certo |
| Lista de mods | ✅ | Porta M (Modrinth) |
| Biblioteca de arquivos (BDS Server; sem comando de barra) | ✅ | **Porta B** (só dono, **só leitura**; em canal público ela avisa e não mostra nada, o conteúdo só sai em DM/canal privado): "yui procura Matrix na biblioteca", "o que eu tenho de filmes?", "o que chegou de novo na biblioteca?", "quanto espaço tem no servidor de arquivos?". Exige `YUI_BDS_URL`; só dispara citando a biblioteca/servidor de arquivos ou uma pasta sua ("meus filmes", "o que eu tenho de séries"). Ferramentas `bds.buscar/listar/recentes/status`. Teste: `npm run test:library` |
| Lembrar algo (`/yui-memoria lembrar`) | 🔶 | captura "lembra que...", "meu nome é...", "eu gosto de..." |
| Ver/esquecer/apagar a própria memória (`/yui-memoria`) | ✅ | **Porta N** (`src/handlers/chatIntents.js`, chamada pelo `llmHandler` logo depois da Porta B; `/yui-memoria` continua valendo): "o que você sabe de mim?", "esquece a lembrança #3", "esquece que eu gosto de X", "apaga tudo que sabe de mim" 🔒 (pede "sim, apagar tudo" em até 2 min). Em canal público só mostra a contagem; o conteúdo aparece na DM. Teste: `npm run test:chatintents` |
| Resumo do chat (`/chat_resumo`) | ✅ | **Porta R** (mesmo módulo, ligado ao `llmHandler`; `/chat_resumo` continua valendo): "yui resume as últimas 50 mensagens", "faz um resumo da conversa" (5 a 100, padrão 20; 1 por minuto por pessoa, dono sem limite) |
| Reset/novidades do GTA Online (`/gta-diario`, `/gta-semanal`, `/gta-noticias`) e estado da Yui (`/yui-status`) | ❌ | só responde de memória do contexto de GTA; falta chamar o publicador sob demanda. A detecção do GTA por conversa (`detectGtaIntent`, "Porta G" no `chatIntents.js`) existe e tem teste, mas também não está ligada |
| Seguir/parar/listar canais do YouTube e da Twitch (`/yui-seguir-youtube`, `/yui-seguir-twitch`, `/yui-parar-seguir`, `/yui-listar-seguindo`) | ❌ | 🔒 os comandos exigem *Administrador* (permissão padrão no Discord); por conversa, exigiria confirmação |
| Modo rádio (`/modo-radio`) | ❌ | dentro do rádio já há controle por voz e botões; a detecção de pedidos de rádio pelo chat (`detectRadioIntent` no `chatIntents.js`) existe e tem teste, mas não está ligada |
| Banir/desbanir, AutoMod (`/yui-criador banir`, `desbanir`, `bans_lista`, `automod`) | 🔶 | existe `ia_automod` (a IA bane sozinha em AutoMod `mcp`/`both`); banir/desbanir por pedido ❌ 🔒 |
| Configurar servidor, ferramentas, IA, criador (`/yui-servidor`, `/yui-ferramentas`, `/yui-config_ia`, `/yui-criador`, `/yui-configurar`) | ❌ | 🔒 só dono/administrador, com confirmação |
| Origem de imagem/anime (`/anime_origem`) | ❌ por desenho | a Yui não vê imagens enviadas |
| Aceitar os Termos (`/aceitar_tos`) | ❌ por desenho | exceção da regra 6 |

## Ordem sugerida para fechar o que falta

1. **Somente leitura e baixo risco:** ligar ao fluxo da conversa o que já está pronto em `chatIntents.js` (memória: ver/esquecer/apagar; resumo do chat; detecção de GTA e de rádio) e completar GTA sob demanda e modo rádio.
2. **Com permissão:** seguir/parar/listar canais, banir/desbanir. Depende do motor de política da Fase 1 do roadmap (`ROADMAP_EVOLUCAO.md`) para confirmar e auditar.
3. **Administração:** configuração do servidor, ferramentas, IA. Só dono, sempre com confirmação e auditoria.

Cada item entra com a rota de conversa, o teste offline e a linha correspondente atualizada nesta tabela.
