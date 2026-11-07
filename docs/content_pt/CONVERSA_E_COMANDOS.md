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

Legenda: ✅ por conversa · 🔶 parcial · ❌ só por comando · 🔒 exige confirmação/política quando for feito

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
| Listas pessoais | ✅ | Porta L ("anota na lista X: ...") |
| Lista de mods | ✅ | Porta M (Modrinth) |
| Lembrar algo (`/yui-memoria lembrar`) | 🔶 | captura "lembra que...", "meu nome é...", "eu gosto de..." |
| Ver/esquecer/apagar a própria memória (`/yui-memoria`) | ✅ | **Porta N**: "o que você sabe de mim?", "esquece a lembrança #3", "esquece que eu gosto de X", "apaga tudo que sabe de mim" 🔒 (pede "sim, apagar tudo" em até 2 min). Em canal público só mostra a contagem; o conteúdo aparece na DM. Teste: `npm run test:chatintents` |
| Resumo do chat (`/chat_resumo`) | ✅ | **Porta R**: "yui resume as últimas 50 mensagens", "faz um resumo da conversa" (5 a 100, padrão 20; 1 por minuto por pessoa, dono sem limite) |
| Reset/novidades do GTA Online (`/gta-diario`, `/gta-semanal`, `/gta-newswire`, `status`) | ❌ | só responde de memória do contexto de GTA; falta chamar o publicador sob demanda |
| Seguir/parar/listar canais do YouTube e da Twitch | ❌ | 🔒 exige `ManageGuild` e confirmação |
| Modo rádio / baixar a música atual (`/modo-radio`, `/baixar_musica_atual`) | ❌ | |
| Banir/desbanir, AutoMod (`/banir`, `/desbanir`, `/automod`) | 🔶 | existe `ia_automod`; banir/desbanir por pedido ❌ 🔒 |
| Configurar servidor, ferramentas, IA, criador (`/yui-servidor`, `/yui-ferramentas`, `/yui-config_ia`, `/yui-criador`, `/setup`) | ❌ | 🔒 só dono/administrador, com confirmação |
| Origem de imagem/anime (`/anime_origem`) | ❌ por desenho | a Yui não vê imagens enviadas |
| Aceitar os Termos (`/aceitar_tos`) | ❌ por desenho | exceção da regra 6 |

## Ordem sugerida para fechar o que falta

1. **Somente leitura e baixo risco:** memória (ver/esquecer), resumo do chat, GTA sob demanda, modo rádio.
2. **Com permissão:** seguir/parar/listar canais, banir/desbanir. Depende do motor de política da Fase 1 do roadmap (`ROADMAP_EVOLUCAO.md`) para confirmar e auditar.
3. **Administração:** configuração do servidor, ferramentas, IA. Só dono, sempre com confirmação e auditoria.

Cada item entra com a rota de conversa, o teste offline e a linha correspondente atualizada nesta tabela.
