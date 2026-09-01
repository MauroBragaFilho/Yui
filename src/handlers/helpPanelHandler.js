import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getTosPages } from './tosHandler.js';
import fs from 'node:fs';
import path from 'node:path';

const COMMAND_DETAILS = {
    'yui': {
        name: '/yui',
        category: 'ðŸ§  InteligÃªncia Artificial',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Converse com a Yui â€” IA especialista em GTA Online. Suporta DMs e User Install.',
        syntax: '/yui mensagem:<texto> [visibilidade:Publico|Privado]',
        options: [
            { name: 'mensagem', desc: 'Sua pergunta ou pedido para a Yui.', required: true },
            { name: 'visibilidade', desc: 'Publico (todos veem no chat) ou Privado (apenas vocÃª vÃª).', required: false }
        ],
        examples: [
            '/yui mensagem: Qual a classe do Truffled Adder?',
            '/yui mensagem: Me explica como funciona a Van de Armas? visibilidade:Privado'
        ]
    },
    'ajuda': {
        name: '/ajuda',
        category: 'ðŸ¤– Central de Ajuda',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Abre a Central de Ajuda interativa com visÃ£o geral, lista completa de comandos inspecionÃ¡veis e regras de seguranÃ§a.',
        syntax: '/ajuda',
        options: [],
        examples: [
            '/ajuda'
        ]
    },
    'gta-diario': {
        name: '/gta-diario',
        category: 'ðŸš— GTA Online',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Exibe o resumo diÃ¡rio atual do GTA Online: Van de Armas, Comerciantes, NaufrÃ¡gio e Desafios Contra o RelÃ³gio.',
        syntax: '/gta-diario',
        options: [],
        examples: [
            '/gta-diario'
        ]
    },
    'gta-semanal': {
        name: '/gta-semanal',
        category: 'ðŸš— GTA Online',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Exibe os eventos, bÃ´nus, descontos e a anÃ¡lise da IA sobre a semana atual do GTA Online (pÃ¡ginas navegÃ¡veis).',
        syntax: '/gta-semanal',
        options: [],
        examples: [
            '/gta-semanal'
        ]
    },
    'gta-noticias': {
        name: '/gta-noticias',
        category: 'ðŸš— GTA Online',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Exibe as Ãºltimas notÃ­cias publicadas pelo Rockstar Newswire.',
        syntax: '/gta-noticias [quantidade:<1-5>]',
        options: [
            { name: 'quantidade', desc: 'Quantas notÃ­cias exibir (padrÃ£o: 2).', required: false }
        ],
        examples: [
            '/gta-noticias',
            '/gta-noticias quantidade:5'
        ]
    },
    'yui-status': {
        name: '/yui-status',
        category: 'ðŸ¤– Sobre a Yui',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Exibe a telemetria, consumo de memÃ³ria, provedores de IA e saÃºde operacional do bot.',
        syntax: '/yui-status',
        options: [],
        examples: [
            '/yui-status'
        ]
    },
    'yui-configurar': {
        name: '/yui-configurar',
        category: 'âš™ï¸ AdministraÃ§Ã£o de Servidor',
        permission: 'ðŸ›¡ï¸ Administrador do Servidor (Administrator)',
        description: 'Configura os canais de transmissÃ£o da Yui (notÃ­cias, resets diÃ¡rios e atualizaÃ§Ãµes semanais) neste servidor.',
        syntax: '/yui-configurar [noticias:#canal] [diario:#canal] [semanal:#canal]',
        options: [
            { name: 'noticias', desc: 'Canal para publicar as notÃ­cias do Newswire.', required: false },
            { name: 'diario', desc: 'Canal para publicar os resets diÃ¡rios.', required: false },
            { name: 'semanal', desc: 'Canal para publicar as atualizaÃ§Ãµes semanais.', required: false }
        ],
        examples: [
            '/yui-configurar noticias:#noticias diario:#diario semanal:#semanal'
        ]
    },

    'yui-servidor': {
        name: '/yui-servidor',
        category: 'âš™ï¸ AdministraÃ§Ã£o de Servidor',
        permission: 'ðŸ›¡ï¸ Administrador do Servidor (Gerenciar Servidor)',
        description: 'Abre o Painel GrÃ¡fico de AdministraÃ§Ã£o do Servidor para configurar comportamento, espontÃ¢neo, updates, menÃ§Ãµes e ferramentas MCP.',
        syntax: '/yui-servidor',
        options: [],
        examples: [
            '/yui-servidor'
        ]
    },
    'yui-ferramentas': {
        name: '/yui-ferramentas',
        category: 'âš™ï¸ AdministraÃ§Ã£o de Servidor',
        permission: 'ðŸ›¡ï¸ Administrador do Servidor (Gerenciar Servidor)',
        description: 'Permite consultar a lista de ferramentas MCP do servidor, ativÃ¡-las/desativÃ¡-las ou restaurar o padrÃ£o de fÃ¡brica.',
        syntax: '/yui-ferramentas acao:<list|toggle|reset> [ferramenta:<nome>] [estado:<on|off>]',
        options: [
            { name: 'acao', desc: 'list (ver status), toggle (alternar) ou reset (restaurar padrÃ£o).', required: true },
            { name: 'ferramenta', desc: 'Nome da ferramenta a ser alterada (com autocomplete).', required: false },
            { name: 'estado', desc: 'on (Ativar) ou off (Desativar).', required: false }
        ],
        examples: [
            '/yui-ferramentas acao:list',
            '/yui-ferramentas acao:toggle ferramenta:generate_image estado:off'
        ]
    },
    'aceitar_tos': {
        name: '/aceitar_tos',
        category: 'âš™ï¸ AdministraÃ§Ã£o de Servidor',
        permission: 'ðŸ›¡ï¸ Administrador do Servidor (Gerenciar Servidor)',
        description: 'Exibe os Termos de ServiÃ§o da Yui e registra o aceite do servidor para desbloquear a utilizaÃ§Ã£o de todos os comandos.',
        syntax: '/aceitar_tos',
        options: [],
        examples: [
            '/aceitar_tos'
        ]
    },
    'yui-criador': {
        name: '/yui-criador',
        category: 'ðŸ‘‘ Painel do Criador',
        permission: 'ðŸ‘‘ Criador do Bot (Exclusivo)',
        description: 'Central de Controle Master para gerenciar modelos LLM, bans globais, AutoMod, MCPs e runtime do bot.',
        syntax: '/yui-criador [subcomando]',
        options: [
            { name: 'subcomando', desc: 'painel, modelo, banir, desbanir, bans_lista, automod, ferramenta, bot_config.', required: false }
        ],
        examples: [
            '/yui-criador painel'
        ]
    },
    'yui-config_ia': {
        name: '/yui-config_ia',
        category: 'ðŸ‘‘ Painel do Criador',
        permission: 'ðŸ‘‘ Criador do Bot (Exclusivo)',
        description: 'Ajusta parÃ¢metros de baixo nÃ­vel da IA como Timeout, Temperatura e limite de Max Tokens.',
        syntax: '/yui-config_ia provider:<provedor> setting:<opcao> value:<numero>',
        options: [
            { name: 'provider', desc: 'Provedor de IA a ser configurado.', required: true },
            { name: 'setting', desc: 'Timeout, Temperatura ou Max Tokens.', required: true },
            { name: 'value', desc: 'Novo valor numÃ©rico.', required: true }
        ],
        examples: [
            '/yui-config_ia provider:gemini setting:Temperatura value:0.7'
        ]
    },
    'entrar-call': {
        name: '/entrar-call',
        category: 'ðŸŽ™ï¸ Voz & Calls',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Faz a Yui entrar no seu canal de voz atual para interagir, responder a gatilhos de voz e atuar como assistente falante.',
        syntax: '/entrar-call',
        options: [],
        examples: [
            '/entrar-call'
        ]
    },
    'sair-call': {
        name: '/sair-call',
        category: 'ðŸŽ™ï¸ Voz & Calls',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Desconecta a Yui do canal de voz atual em que ela estÃ¡ conectada.',
        syntax: '/sair-call',
        options: [],
        examples: [
            '/sair-call'
        ]
    },
    'modo-radio': {
        name: '/modo-radio',
        category: 'ðŸŽ™ï¸ Voz & Calls',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Inicia o Modo RÃ¡dio de mÃºsica no canal de voz com controles interativos por voz e botÃµes.',
        syntax: '/modo-radio',
        options: [],
        examples: [
            '/modo-radio'
        ]
    },
    'yui-imagem': {
        name: '/yui-imagem',
        category: 'ðŸŽ¨ Arte & Criatividade',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Gera artes e ilustraÃ§Ãµes digitais exclusivas em HD usando o modelo SDXL Flash.',
        syntax: '/yui-imagem prompt:<descricao> [negative_prompt:<bloqueios>] [width:<largura>] [height:<altura>]',
        options: [
            { name: 'prompt', desc: 'DescriÃ§Ã£o detalhada da imagem a ser criada.', required: true },
            { name: 'negative_prompt', desc: 'O que NÃƒO deve aparecer na imagem.', required: false },
            { name: 'width', desc: 'Largura em pixels (padrÃ£o: 1024).', required: false },
            { name: 'height', desc: 'Altura em pixels (padrÃ£o: 1024).', required: false }
        ],
        examples: [
            '/yui-imagem prompt: Um gato astronauta flutuando no espaÃ§o com nebulosas coloridas ao fundo'
        ]
    },
    'anime_origem': {
        name: '/anime_origem',
        category: 'ðŸŽ¨ Arte & Criatividade',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Identifica o anime, episÃ³dio e o minuto exato a partir da imagem/print enviada.',
        syntax: '/anime_origem imagem:<arquivo>',
        options: [
            { name: 'imagem', desc: 'Print ou imagem da cena do anime.', required: true }
        ],
        examples: [
            '/anime_origem imagem:[print.jpg]'
        ]
    },
    'baixar_musica': {
        name: '/baixar_musica',
        category: 'ðŸŽµ MultimÃ­dia & Downloads',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Central de downloads de mÃºsica em MP3: baixa por link (YouTube, Spotify, Instagram ou TikTok) ou busca por nome/artista no Deezer.',
        syntax: '/baixar_musica url:<link> | busca:<nome_ou_artista>',
        options: [
            { name: 'url', desc: 'Link do YouTube, Spotify, Instagram ou TikTok.', required: false },
            { name: 'busca', desc: 'Nome da mÃºsica ou artista (busca no Deezer).', required: false }
        ],
        examples: [
            '/baixar_musica url:https://www.youtube.com/watch?v=...',
            '/baixar_musica url:https://open.spotify.com/track/...',
            '/baixar_musica busca:Welcome To The Jungle Guns N Roses'
        ]
    },
    'baixar_video': {
        name: '/baixar_video',
        category: 'ðŸŽµ MultimÃ­dia & Downloads',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Baixa vÃ­deos e envia em MP4 no chat, com compressÃ£o automÃ¡tica (FFMPEG) se exceder o limite de upload do servidor.',
        syntax: '/baixar_video url:<link> [descricao:<true|false>]',
        options: [
            { name: 'url', desc: 'Link do vÃ­deo (YouTube Shorts, Instagram Reels, TikTok).', required: true },
            { name: 'descricao', desc: 'Exibir autor e descriÃ§Ã£o do vÃ­deo original (padrÃ£o: false).', required: false }
        ],
        examples: [
            '/baixar_video url:https://www.youtube.com/shorts/... descricao:true'
        ]
    },
    'baixar_musica_atual': {
        name: '/baixar_musica_atual',
        category: 'ðŸŽµ MultimÃ­dia & Downloads',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Baixa em MP3 a mÃºsica que vocÃª (ou outro usuÃ¡rio) estÃ¡ ouvindo no momento (Spotify, YouTube Music ou Metrolist).',
        syntax: '/baixar_musica_atual [usuario:<usuÃ¡rio>]',
        options: [
            { name: 'usuario', desc: 'UsuÃ¡rio para checar a mÃºsica (menÃ§Ã£o ou ID, com autocomplete).', required: false }
        ],
        examples: [
            '/baixar_musica_atual',
            '/baixar_musica_atual usuario:@Mauro'
        ]
    },

    'converter_moeda': {
        name: '/converter_moeda',
        category: 'ðŸ’± Utilidades',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Realiza conversÃµes monetÃ¡rias entre moedas reais (USD, EUR, BRL) e criptomoedas (BTC, ETH) com cotaÃ§Ã£o em tempo real.',
        syntax: '/converter_moeda valor:<quantia> de:<moeda_origem> para:<moeda_destino>',
        options: [
            { name: 'valor', desc: 'Quantidade a converter.', required: true },
            { name: 'de', desc: 'Moeda de origem (ex: USD, EUR, BTC).', required: true },
            { name: 'para', desc: 'Moeda de destino (ex: BRL, EUR).', required: true }
        ],
        examples: [
            '/converter_moeda valor:100 de:USD para:BRL'
        ]
    },
    'chat_resumo': {
        name: '/chat_resumo',
        category: 'ðŸ’± Utilidades',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'LÃª as Ãºltimas mensagens do canal e gera um resumo inteligente dos tÃ³picos conversados.',
        syntax: '/chat_resumo [quantidade:<mensagens>]',
        options: [
            { name: 'quantidade', desc: 'NÃºmero de mensagens para analisar (10 a 100).', required: false }
        ],
        examples: [
            '/chat_resumo quantidade:50'
        ]
    },
    'buscar_jogo': {
        name: '/buscar_jogo',
        category: 'ðŸŽ® Games & Loja',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Busca links de download (magnet/torrent) de jogos de PC nos acervos FitGirl e DODI Repacks.',
        syntax: '/buscar_jogo jogo:<nome_do_jogo>',
        options: [
            { name: 'jogo', desc: 'Nome do jogo de computador.', required: true }
        ],
        examples: [
            '/buscar_jogo jogo:Elden Ring'
        ]
    },
    'steam_jogo': {
        name: '/steam_jogo',
        category: 'ðŸŽ® Games & Loja',
        permission: 'ðŸ‘¥ Todos os UsuÃ¡rios',
        description: 'Consulta a loja da Steam e exibe preÃ§os oficiais em R$, descontos, notas Metacritic e sinopse.',
        syntax: '/steam_jogo jogo:<nome_do_jogo>',
        options: [
            { name: 'jogo', desc: 'Nome do jogo na Steam.', required: true }
        ],
        examples: [
            '/steam_jogo jogo:Cyberpunk 2077'
        ]
    }
};

function getMainCategorySelectMenu(currentActive = 'home') {
    const menuOptions = [
        { label: 'ðŸ  VisÃ£o Geral & InÃ­cio', description: 'ApresentaÃ§Ã£o principal da Yui e novidades', value: 'home', default: currentActive === 'home' },
        { label: 'ðŸ¤– Lista Geral de Comandos', description: 'Todos os comandos com menu de inspeÃ§Ã£o detalhado', value: 'commands_list', default: currentActive === 'commands_list' },
        { label: 'âš–ï¸ Regras, SeguranÃ§a & AutoMod', description: 'Diretrizes de uso e moderaÃ§Ã£o automÃ¡tica por IA', value: 'regras', default: currentActive === 'regras' },
        //{ label: 'âœ¨ Criador & Apoie o Projeto', description: 'Redes sociais de oBraga e apoio via LivePix', value: 'sobre', default: currentActive === 'sobre' }
    ];

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('help_category_select')
            .setPlaceholder('ðŸ’¡ Escolha uma seÃ§Ã£o do menu de ajuda')
            .addOptions(menuOptions)
    );
}

function buildHelpHomePayload() {
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('âœ¨ Central de Ajuda â€” Yui AI')
        .setDescription('Bem-vindo(a) ao hub de ajuda oficial da **Yui**!\n\nEu sou uma Agente AutÃ´noma multifuncional para o Discord, equipada com inteligÃªncia artificial generativa, assistente de voz em chamadas, download de multimÃ­dia, busca de jogos torrent, cotaÃ§Ãµes em tempo real e moderaÃ§Ã£o de seguranÃ§a.\n\nðŸ“– **[Guia Completo de Comandos](https://github.com/MauroBragaFilho/Yui/blob/main/docs/content_pt/COMMANDS.md)**')
        .addFields(
            { name: 'ðŸ¤– Comandos & InspeÃ§Ã£o', value: 'Explore a lista completa de comandos e selecione qualquer um no menu para ver sua sintaxe e exemplos.', inline: true },
            { name: 'âš™ï¸ ConfiguraÃ§Ã£o do Servidor', value: 'Administradores podem usar `/yui-servidor` ou `/yui-ferramentas` para ajustar os recursos.', inline: true },
            { name: 'ðŸ’– Apoie o Projeto', value: 'ConheÃ§a as redes do criador e ajude a manter o bot no ar via **LivePix**!', inline: false }
        )
        .setFooter({ text: 'Use o menu suspenso abaixo para navegar pelas seÃ§Ãµes â€¢ by oBraga' })
        .setTimestamp();

    const linkButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('ðŸš€ GitHub').setURL('https://github.com/MauroBragaFilho/Yui').setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('ðŸŒ Redes Sociais').setURL('https://bio.site/oBraga').setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('ðŸ’– Apoiar no LivePix').setURL('https://livepix.gg/obragafilho').setStyle(ButtonStyle.Link)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('home'), linkButtons] };
}

function buildHelpCommandListPayload() {
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('ðŸ¤– Lista Geral de Comandos')
        .setDescription('Confira abaixo a lista completa de comandos da Yui. Selecione qualquer comando no menu abaixo para abrir sua **inspeÃ§Ã£o tÃ©cnica detalhada** com exemplos e opÃ§Ãµes!\n\nðŸ“– **[DocumentaÃ§Ã£o Online](https://github.com/MauroBragaFilho/Yui/blob/main/docs/content_pt/COMMANDS.md)**')
        .addFields(
            {
                name: 'ðŸ§  InteligÃªncia Artificial & Chat',
                value: 'â€¢ `/yui` â€” Converse com a Yui sobre GTA Online (Suporta DMs, User Install e visibilidade Privada).'
            },
            {
                name: 'âš™ï¸ AdministraÃ§Ã£o de Servidor (Server Admin)',
                value: 'â€¢ `/yui-servidor` â€” Painel interativo de configuraÃ§Ã£o do servidor.\nâ€¢ `/yui-ferramentas` â€” Gerencia e inspeciona as ferramentas MCP do servidor.\nâ€¢ `/aceitar_tos` â€” Exibe e aceita os Termos de ServiÃ§o no servidor.'
            },
            {
                name: 'ðŸŽ™ï¸ Voz & Assistente de Call',
                value: 'â€¢ `/entrar-call` â€” Conecta a Yui ao seu canal de voz para voz por IA.\nâ€¢ `/sair-call` â€” Desconecta a Yui do canal de voz.\nâ€¢ `/modo-radio` â€” Inicia o sistema de rÃ¡dio de mÃºsica no canal de voz.'
            },
            {
                name: 'ðŸŽ¨ Arte, MultimÃ­dia & Downloads',
                value: 'â€¢ `/yui-imagem` â€” Gera ilustraÃ§Ãµes digitais em alta definiÃ§Ã£o (SDXL).\nâ€¢ `/anime_origem` â€” Identifica anime, episÃ³dio e minuto por print.\nâ€¢ `/baixar_musica` â€” Central de MP3: YouTube, Spotify, Deezer, Instagram e TikTok.\nâ€¢ `/baixar_video` â€” Baixa vÃ­deos em MP4.'
            },
            {
                name: 'ðŸŽ® Games, Loja & Utilidades',
                value: 'â€¢ `/buscar_jogo` â€” Procura torrents/magnets de jogos de PC.\nâ€¢ `/steam_jogo` â€” PreÃ§os, promoÃ§Ãµes e detalhes na loja oficial da Steam.\nâ€¢ `/converter_moeda` â€” CotaÃ§Ã£o de moedas e criptomoedas em tempo real.\nâ€¢ `/chat_resumo` â€” Resumo inteligente das Ãºltimas mensagens do canal.'
            },
            {
                name: 'ðŸ‘‘ Painel do Criador',
                value: 'â€¢ `/yui-criador` â€” Central de Controle Master para o dono do bot.\nâ€¢ `/yui-config_ia` â€” Ajusta parÃ¢metros tÃ©cnicos de baixo nÃ­vel da IA.'
            }
        )
        .setFooter({ text: 'ðŸ’¡ Selecione um comando no menu suspenso abaixo para ver a anÃ¡lise aprofundada' });

    const commandOptions = Object.keys(COMMAND_DETAILS).map(key => {
        const item = COMMAND_DETAILS[key];
        return {
            label: item.name,
            description: item.description.substring(0, 95),
            value: key
        };
    });

    const cmdSelectMenu = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('help_command_select')
            .setPlaceholder('ðŸ” Selecione um comando para inspecionar em detalhes')
            .addOptions(commandOptions)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('commands_list'), cmdSelectMenu] };
}

function buildHelpCommandDetailPayload(commandId) {
    const cmd = COMMAND_DETAILS[commandId];
    if (!cmd) return buildHelpCommandListPayload();

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle(`ðŸ” InspeÃ§Ã£o TÃ©cnica: ${cmd.name}`)
        .setDescription(`**Categoria:** ${cmd.category}\n**PermissÃ£o MÃ­nima:** ${cmd.permission}\n\n**ðŸ“„ DescriÃ§Ã£o:**\n${cmd.description}\n\n**ðŸ’» Sintaxe do Comando:**\n\`\`\`bash\n${cmd.syntax}\n\`\`\``)
        .setTimestamp();

    if (cmd.options && cmd.options.length > 0) {
        const optText = cmd.options.map(o => `â€¢ \`${o.name}\` (${o.required ? 'ObrigatÃ³rio' : 'Opcional'}): ${o.desc}`).join('\n');
        embed.addFields({ name: 'ðŸ› ï¸ ParÃ¢metros & OpÃ§Ãµes', value: optText, inline: false });
    } else {
        embed.addFields({ name: 'ðŸ› ï¸ ParÃ¢metros & OpÃ§Ãµes', value: '*Este comando nÃ£o exige parÃ¢metros adicionais.*', inline: false });
    }

    if (cmd.examples && cmd.examples.length > 0) {
        const exText = cmd.examples.map(e => `\`\`\`bash\n${e}\n\`\`\``).join('\n');
        embed.addFields({ name: 'ðŸ’¡ Exemplos PrÃ¡ticos de Uso', value: exText, inline: false });
    }

    embed.setFooter({ text: 'Yui Command Inspector â€¢ Use os botÃµes para navegar' });

    const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('help_btn_cmd_list').setLabel('â¬…ï¸ Voltar Ã  Lista de Comandos').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('help_btn_home').setLabel('ðŸ  InÃ­cio').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('commands_list'), btnRow] };
}

function buildHelpRulesPayload(pageIndex = 0) {
    const pages = getTosPages();
    const safeIndex = Math.max(0, Math.min(pageIndex, pages.length - 1));
    const currentPage = pages[safeIndex];

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle(currentPage.title)
        .setDescription(currentPage.content)
        .setFooter({ text: `PÃ¡gina ${safeIndex + 1} de ${pages.length} â€¢ Diretrizes & TOS Yui â€¢ by oBraga` })
        .setTimestamp();

    const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`help_rules_page_${safeIndex - 1}`)
            .setLabel('â¬…ï¸ Anterior')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safeIndex === 0),
        new ButtonBuilder()
            .setCustomId('help_btn_home')
            .setLabel('ðŸ  InÃ­cio')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`help_rules_page_${safeIndex + 1}`)
            .setLabel('âž¡ï¸ PrÃ³ximo')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safeIndex === pages.length - 1)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('regras'), btnRow] };
}

function buildHelpCreatorPayload() {
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('âœ¨ Criador, Redes Sociais & Apoio ao Projeto')
        .setDescription('ConheÃ§a mais sobre o desenvolvedor da **Yui**, acompanhe as redes sociais oficiais ou apoie o projeto para manter o bot no ar!')
        .addFields(
            {
                name: 'ðŸ‘¨â€ðŸ’» Desenvolvedor & Autor',
                value: 'Criado com dedicaÃ§Ã£o por **oBraga** (<@369618206970609675>).\nO projeto Ã© **100% CÃ³digo Aberto (Open Source)**!'
            },
            {
                name: 'ðŸŒ Redes Sociais do Criador & Hub Central',
                value: 'Acesse o agregador oficial de redes sociais para conferir conteÃºdos, vÃ­deos, atualizaÃ§Ãµes e projetos:\nðŸ‘‰ **[Redes Sociais do Criador](https://bio.site/oBraga)**'
            },
            {
                name: 'ðŸ’– Apoie a Yui pelo LivePix!',
                value: 'Manter a infraestrutura de IA, servidores de voz e modelos generativos rodando 24/7 exige custos considerÃ¡veis. Se vocÃª gosta do projeto e quer ajudar na manutenÃ§Ã£o, envie um apoio via Pix!\n\nðŸŽ **[Apoiar no LivePix](https://livepix.gg/obragafilho)**\n*Qualquer contribuiÃ§Ã£o ajuda imensamente a manter a Yui sempre online e rÃ¡pida!*'
            }
        )
        .setFooter({ text: 'Yui Project â€¢ Desenvolvido por oBraga' })
        .setTimestamp();

    const linkButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('ðŸŒ Redes Sociais do Criador').setURL('https://bio.site/oBraga').setStyle(ButtonStyle.Link).setEmoji('ðŸ”—'),
        new ButtonBuilder().setLabel('ðŸ’– Apoiar no LivePix').setURL('https://livepix.gg/obragafilho').setStyle(ButtonStyle.Link).setEmoji('ðŸŽ'),
        new ButtonBuilder().setLabel('ðŸš€ GitHub Open Source').setURL('https://github.com/MauroBragaFilho/Yui').setStyle(ButtonStyle.Link).setEmoji('â­')
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('sobre'), linkButtons] };
}

async function handleHelpInteraction(interaction) {
    const { customId } = interaction;

    if (customId === 'help_category_select') {
        const selected = interaction.values[0];
        let payload;
        if (selected === 'home') payload = buildHelpHomePayload();
        else if (selected === 'commands_list') payload = buildHelpCommandListPayload();
        else if (selected === 'regras') payload = buildHelpRulesPayload();
        else if (selected === 'sobre') payload = buildHelpCreatorPayload();
        else payload = buildHelpHomePayload();

        return await interaction.update(payload);
    }

    if (customId === 'help_command_select') {
        const commandId = interaction.values[0];
        const payload = buildHelpCommandDetailPayload(commandId);
        return await interaction.update(payload);
    }

    if (customId.startsWith('help_rules_page_')) {
        const pageIndex = parseInt(customId.replace('help_rules_page_', ''));
        const payload = buildHelpRulesPayload(pageIndex);
        return await interaction.update(payload);
    }

    if (customId === 'help_btn_cmd_list') {
        const payload = buildHelpCommandListPayload();
        return await interaction.update(payload);
    }

    if (customId === 'help_btn_home' || customId === 'help_back') {
        const payload = buildHelpHomePayload();
        return await interaction.update(payload);
    }
}

export {
    buildHelpHomePayload, buildHelpCommandListPayload, buildHelpCommandDetailPayload,
    buildHelpRulesPayload, buildHelpCreatorPayload, handleHelpInteraction
};

export default {
    buildHelpHomePayload,
    buildHelpCommandListPayload,
    buildHelpCommandDetailPayload,
    buildHelpRulesPayload,
    buildHelpCreatorPayload,
    handleHelpInteraction
};
