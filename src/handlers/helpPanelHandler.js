import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

// Convite para o dono de OUTRO servidor adicionar a Yui (o Discord exige Gerenciar Servidor para autorizar).
const INVITE_PERMISSIONS = '3525696'; // ver canais, enviar, embeds, anexos, histórico, reações, emojis externos, conectar e falar
function inviteUrl() {
    const id = String(process.env.DISCORD_CLIENT_ID || '').trim();
    return /^\d{15,25}$/.test(id) ? `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}` : null;
}
function inviteButtons() {
    const url = inviteUrl();
    return url ? [new ButtonBuilder().setLabel('➕ Adicionar ao seu servidor').setURL(url).setStyle(ButtonStyle.Link)] : [];
}
import { getTosPages } from './tosHandler.js';
import { makeEmbed, chunkLines, clampOptions, clampText } from '../discord/embedLimits.js';
import fs from 'node:fs';
import path from 'node:path';

const COMMAND_DETAILS = {
    'yui': {
        name: '/yui',
        category: '🧠 Inteligência Artificial',
        permission: '👥 Todos os Usuários',
        description: 'Converse com a Yui — IA especialista em GTA Online. Suporta DMs e User Install.',
        syntax: '/yui mensagem:<texto> [visibilidade:Publico|Privado]',
        options: [
            { name: 'mensagem', desc: 'Sua pergunta ou pedido para a Yui.', required: true },
            { name: 'visibilidade', desc: 'Publico (todos veem no chat) ou Privado (apenas você vê).', required: false }
        ],
        examples: [
            '/yui mensagem: Qual a classe do Truffled Adder?',
            '/yui mensagem: Me explica como funciona a Van de Armas? visibilidade:Privado'
        ]
    },
    'ajuda': {
        name: '/ajuda',
        category: '🤖 Central de Ajuda',
        permission: '👥 Todos os Usuários',
        description: 'Abre a Central de Ajuda interativa com visão geral, lista completa de comandos inspecionáveis e regras de segurança.',
        syntax: '/ajuda',
        options: [],
        examples: [
            '/ajuda'
        ]
    },
    'gta-diario': {
        name: '/gta-diario',
        category: '🚗 GTA Online',
        permission: '👥 Todos os Usuários',
        description: 'Exibe o resumo diário atual do GTA Online: Van de Armas, Comerciantes, Naufrágio e Desafios Contra o Relógio.',
        syntax: '/gta-diario',
        options: [],
        examples: [
            '/gta-diario'
        ]
    },
    'gta-semanal': {
        name: '/gta-semanal',
        category: '🚗 GTA Online',
        permission: '👥 Todos os Usuários',
        description: 'Exibe os eventos, bônus, descontos e a análise da IA sobre a semana atual do GTA Online (páginas navegáveis).',
        syntax: '/gta-semanal',
        options: [],
        examples: [
            '/gta-semanal'
        ]
    },
    'gta-noticias': {
        name: '/gta-noticias',
        category: '🚗 GTA Online',
        permission: '👥 Todos os Usuários',
        description: 'Exibe as últimas notícias publicadas pelo Rockstar Newswire.',
        syntax: '/gta-noticias [quantidade:<1-5>]',
        options: [
            { name: 'quantidade', desc: 'Quantas notícias exibir (padrão: 2).', required: false }
        ],
        examples: [
            '/gta-noticias',
            '/gta-noticias quantidade:5'
        ]
    },
    'yui-status': {
        name: '/yui-status',
        category: '🤖 Sobre a Yui',
        permission: '👥 Todos os Usuários',
        description: 'Exibe a telemetria, consumo de memória, provedores de IA e saúde operacional do bot.',
        syntax: '/yui-status',
        options: [],
        examples: [
            '/yui-status'
        ]
    },
    'yui-configurar': {
        name: '/yui-configurar',
        category: '⚙️ Administração de Servidor',
        permission: '🛡️ Administrador do Servidor (Administrator)',
        description: 'Configura os canais de transmissão da Yui (notícias, resets diários e atualizações semanais) neste servidor.',
        syntax: '/yui-configurar [noticias:#canal] [diario:#canal] [semanal:#canal]',
        options: [
            { name: 'noticias', desc: 'Canal para publicar as notícias do Newswire.', required: false },
            { name: 'diario', desc: 'Canal para publicar os resets diários.', required: false },
            { name: 'semanal', desc: 'Canal para publicar as atualizações semanais.', required: false }
        ],
        examples: [
            '/yui-configurar noticias:#noticias diario:#diario semanal:#semanal'
        ]
    },

    'yui-servidor': {
        name: '/yui-servidor',
        category: '⚙️ Administração de Servidor',
        permission: '🛡️ Administrador do Servidor (Gerenciar Servidor)',
        description: 'Abre o Painel Gráfico de Administração do Servidor para configurar comportamento, espontâneo, updates, menções e ferramentas MCP.',
        syntax: '/yui-servidor',
        options: [],
        examples: [
            '/yui-servidor'
        ]
    },
    'yui-ferramentas': {
        name: '/yui-ferramentas',
        category: '⚙️ Administração de Servidor',
        permission: '🛡️ Administrador do Servidor (Gerenciar Servidor)',
        description: 'Permite consultar a lista de ferramentas MCP do servidor, ativá-las/desativá-las ou restaurar o padrão de fábrica.',
        syntax: '/yui-ferramentas acao:<list|toggle|reset> [ferramenta:<nome>] [estado:<on|off>]',
        options: [
            { name: 'acao', desc: 'list (ver status), toggle (alternar) ou reset (restaurar padrão).', required: true },
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
        category: '⚙️ Administração de Servidor',
        permission: '🛡️ Administrador do Servidor (Gerenciar Servidor)',
        description: 'Exibe os Termos de Serviço da Yui e registra o aceite do servidor para desbloquear a utilização de todos os comandos.',
        syntax: '/aceitar_tos',
        options: [],
        examples: [
            '/aceitar_tos'
        ]
    },
    'yui-criador': {
        name: '/yui-criador',
        category: '👑 Painel do Criador',
        permission: '👑 Criador do Bot (Exclusivo)',
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
        category: '👑 Painel do Criador',
        permission: '👑 Criador do Bot (Exclusivo)',
        description: 'Ajusta parâmetros de baixo nível da IA como Timeout, Temperatura e limite de Max Tokens.',
        syntax: '/yui-config_ia provider:<provedor> setting:<opcao> value:<numero>',
        options: [
            { name: 'provider', desc: 'Provedor de IA a ser configurado.', required: true },
            { name: 'setting', desc: 'Timeout, Temperatura ou Max Tokens.', required: true },
            { name: 'value', desc: 'Novo valor numérico.', required: true }
        ],
        examples: [
            '/yui-config_ia provider:gemini setting:Temperatura value:0.7'
        ]
    },
    'entrar-call': {
        name: '/entrar-call',
        category: '🎙️ Voz & Calls',
        permission: '👥 Todos os Usuários',
        description: 'Faz a Yui entrar no seu canal de voz atual para interagir, responder a gatilhos de voz e atuar como assistente falante. Por padrão ela responde só no chat de texto; para responder falando na call, um admin liga a ferramenta **Resposta por Voz (TTS)** em `/yui-ferramentas` (vem desligada).',
        syntax: '/entrar-call',
        options: [],
        examples: [
            '/entrar-call'
        ]
    },
    'sair-call': {
        name: '/sair-call',
        category: '🎙️ Voz & Calls',
        permission: '👥 Todos os Usuários',
        description: 'Desconecta a Yui do canal de voz atual em que ela está conectada.',
        syntax: '/sair-call',
        options: [],
        examples: [
            '/sair-call'
        ]
    },
    'modo-radio': {
        name: '/modo-radio',
        category: '🎙️ Voz & Calls',
        permission: '👥 Todos os Usuários',
        description: 'Inicia o Modo Rádio de música no canal de voz com controles interativos por voz e botões.',
        syntax: '/modo-radio',
        options: [],
        examples: [
            '/modo-radio'
        ]
    },
    'yui-imagem': {
        name: '/yui-imagem',
        category: '🎨 Arte & Criatividade',
        permission: '👥 Todos os Usuários',
        description: 'Gera artes e ilustrações digitais exclusivas em HD usando o modelo SDXL Flash.',
        syntax: '/yui-imagem prompt:<descricao> [negative_prompt:<bloqueios>] [width:<largura>] [height:<altura>]',
        options: [
            { name: 'prompt', desc: 'Descrição detalhada da imagem a ser criada.', required: true },
            { name: 'negative_prompt', desc: 'O que NÃO deve aparecer na imagem.', required: false },
            { name: 'width', desc: 'Largura em pixels (padrão: 1024).', required: false },
            { name: 'height', desc: 'Altura em pixels (padrão: 1024).', required: false }
        ],
        examples: [
            '/yui-imagem prompt: Um gato astronauta flutuando no espaço com nebulosas coloridas ao fundo'
        ]
    },
    'anime_origem': {
        name: '/anime_origem',
        category: '🎨 Arte & Criatividade',
        permission: '👥 Todos os Usuários',
        description: 'Identifica o anime, episódio e o minuto exato a partir da imagem/print enviada.',
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
        category: '🎵 Multimídia & Downloads',
        permission: '👥 Todos os Usuários',
        description: 'Central de downloads de música em MP3: baixa por link (YouTube, Spotify, Instagram ou TikTok) ou busca por nome/artista no Deezer. Link com playlist baixa só o vídeo (playlist pura, só o 1º item); no Spotify, só links de faixa.',
        syntax: '/baixar_musica url:<link> | busca:<nome_ou_artista>',
        options: [
            { name: 'url', desc: 'Link do YouTube, Spotify (só faixa), Instagram ou TikTok. Se o link tiver uma playlist, baixa só o vídeo (ou só o 1º item).', required: false },
            { name: 'busca', desc: 'Nome da música ou artista (busca no Deezer).', required: false }
        ],
        examples: [
            '/baixar_musica url:https://www.youtube.com/watch?v=...',
            '/baixar_musica url:https://open.spotify.com/track/...',
            '/baixar_musica busca:Welcome To The Jungle Guns N Roses'
        ]
    },
    'baixar_video': {
        name: '/baixar_video',
        category: '🎵 Multimídia & Downloads',
        permission: '👥 Todos os Usuários',
        description: 'Baixa vídeos e envia em MP4 no chat, com compressão automática (FFMPEG) se exceder o limite de upload do servidor.',
        syntax: '/baixar_video url:<link> [descricao:<true|false>]',
        options: [
            { name: 'url', desc: 'Link do vídeo (YouTube Shorts, Instagram Reels, TikTok). Se o link tiver uma playlist, baixa só o vídeo (ou só o 1º item).', required: true },
            { name: 'descricao', desc: 'Exibir autor e descrição do vídeo original (padrão: false).', required: false }
        ],
        examples: [
            '/baixar_video url:https://www.youtube.com/shorts/... descricao:true'
        ]
    },
    'baixar_musica_atual': {
        name: '/baixar_musica_atual',
        category: '🎵 Multimídia & Downloads',
        permission: '👥 Todos os Usuários',
        description: 'Baixa em MP3 a música que você (ou outro usuário) está ouvindo no momento (Spotify, YouTube Music ou Metrolist).',
        syntax: '/baixar_musica_atual [usuario:<usuário>]',
        options: [
            { name: 'usuario', desc: 'Usuário para checar a música (menção ou ID, com autocomplete).', required: false }
        ],
        examples: [
            '/baixar_musica_atual',
            '/baixar_musica_atual usuario:@Mauro'
        ]
    },

    'converter_moeda': {
        name: '/converter_moeda',
        category: '💱 Utilidades',
        permission: '👥 Todos os Usuários',
        description: 'Realiza conversões monetárias entre moedas reais (USD, EUR, BRL) e criptomoedas (BTC, ETH) com cotação em tempo real.',
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
        category: '💱 Utilidades',
        permission: '👥 Todos os Usuários',
        description: 'Lê as últimas mensagens do canal e gera um resumo inteligente dos tópicos conversados.',
        syntax: '/chat_resumo [quantidade:<mensagens>]',
        options: [
            { name: 'quantidade', desc: 'Número de mensagens para analisar (10 a 100).', required: false }
        ],
        examples: [
            '/chat_resumo quantidade:50'
        ]
    },
    'buscar_jogo': {
        name: '/buscar_jogo',
        category: '🎮 Games & Loja',
        permission: '👥 Todos os Usuários',
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
        category: '🎮 Games & Loja',
        permission: '👥 Todos os Usuários',
        description: 'Consulta a loja da Steam e exibe preços oficiais em R$, descontos, notas Metacritic e sinopse.',
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
        { label: '🏠 Visão Geral & Início', description: 'Apresentação principal da Yui e novidades', value: 'home', default: currentActive === 'home' },
        { label: '🤖 Lista Geral de Comandos', description: 'Todos os comandos com menu de inspeção detalhado', value: 'commands_list', default: currentActive === 'commands_list' },
        { label: '⚖️ Regras, Segurança & AutoMod', description: 'Diretrizes de uso e moderação automática por IA', value: 'regras', default: currentActive === 'regras' },
        //{ label: '✨ Criador & Apoie o Projeto', description: 'Redes sociais de oBraga e apoio via LivePix', value: 'sobre', default: currentActive === 'sobre' }
    ];

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('help_category_select')
            .setPlaceholder('💡 Escolha uma seção do menu de ajuda')
            .addOptions(menuOptions)
    );
}

// Menu de comandos (TG-17): um menu aceita 25 opções e a mensagem tem 5 linhas (1 do menu de seções + até 4 menus de comandos).
// Hoje são 24 comandos: documentar mais um ou dois não pode derrubar o painel, então passando de 25 o menu se divide por categoria.
const COMMAND_MENU_SIZE = 25;
const MAX_COMMAND_MENUS = 4;

/** Reparte os comandos em menus de até 25 opções. Até 25 comandos: um menu só, na ordem do dicionário. */
function groupCommandOptions(details) {
    const entries = Object.entries(details || {}).map(([key, item]) => ({
        category: item.category || 'Outros',
        option: { label: item.name, description: item.description, value: key }
    }));
    if (entries.length <= COMMAND_MENU_SIZE) {
        return entries.length ? [{ options: entries.map(e => e.option), categories: [] }] : [];
    }
    const byCategory = new Map();
    for (const e of entries) {
        if (!byCategory.has(e.category)) byCategory.set(e.category, []);
        byCategory.get(e.category).push(e.option);
    }
    const groups = [];
    let current = null;
    for (const [category, options] of byCategory) {
        // A categoria inteira vai para o mesmo menu quando cabe; se for maior que um menu, continua no seguinte.
        if (!current || (current.options.length > 0 && current.options.length + options.length > COMMAND_MENU_SIZE)) {
            current = { options: [], categories: [] };
            groups.push(current);
        }
        current.categories.push(category);
        for (const option of options) {
            if (current.options.length >= COMMAND_MENU_SIZE) {
                current = { options: [], categories: [category] };
                groups.push(current);
            }
            current.options.push(option);
        }
    }
    return groups.slice(0, MAX_COMMAND_MENUS);
}

/** Linhas de menu para inspecionar comandos: help_command_select (o de sempre) e help_command_select_2, _3... se passar de 25. */
function buildCommandMenus(details = COMMAND_DETAILS) {
    const groups = groupCommandOptions(details);
    return groups.map((group, i) => new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(i === 0 ? 'help_command_select' : `help_command_select_${i + 1}`)
            .setPlaceholder(groups.length > 1
                ? clampText(`🔍 Comandos (${i + 1}/${groups.length}): ${group.categories.join(' · ')}`, 150)
                : '🔍 Selecione um comando para inspecionar em detalhes')
            .addOptions(clampOptions(group.options, { max: COMMAND_MENU_SIZE }))
    ));
}

function buildHelpHomePayload() {
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('✨ Central de Ajuda — Yui AI')
        .setDescription('Bem-vindo(a) ao hub de ajuda oficial da **Yui**!\n\nEu sou uma Agente Autônoma multifuncional para o Discord, equipada com inteligência artificial generativa, assistente de voz em chamadas, download de multimídia, busca de jogos torrent, cotações em tempo real e moderação de segurança.\n\n📖 **[Guia Completo de Comandos](https://github.com/MauroBragaFilho/Yui/blob/main/docs/content_pt/COMMANDS.md)**')
        .addFields(
            { name: '🤖 Comandos & Inspeção', value: 'Explore a lista completa de comandos e selecione qualquer um no menu para ver sua sintaxe e exemplos.', inline: true },
            { name: '⚙️ Configuração do Servidor', value: 'Administradores podem usar `/yui-servidor` ou `/yui-ferramentas` para ajustar os recursos.', inline: true },
            { name: '💖 Apoie o Projeto', value: 'Conheça as redes do criador e ajude a manter o bot no ar via **LivePix**!', inline: false }
        )
        .setFooter({ text: 'Use o menu suspenso abaixo para navegar pelas seções • by oBraga' })
        .setTimestamp();

    const linkButtons = new ActionRowBuilder().addComponents(
        ...inviteButtons(),
        new ButtonBuilder().setLabel('🚀 GitHub').setURL('https://github.com/MauroBragaFilho/Yui').setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('🌐 Redes Sociais').setURL('https://bio.site/oBraga').setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('💖 Apoiar no LivePix').setURL('https://livepix.gg/obragafilho').setStyle(ButtonStyle.Link)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('home'), linkButtons] };
}

function buildHelpCommandListPayload() {
    const embed = makeEmbed({
        color: 0x7C3AED,
        title: '🤖 Lista Geral de Comandos',
        description: 'Confira abaixo a lista completa de comandos da Yui. Selecione qualquer comando no menu abaixo para abrir sua **inspeção técnica detalhada** com exemplos e opções!\n\n📖 **[Documentação Online](https://github.com/MauroBragaFilho/Yui/blob/main/docs/content_pt/COMMANDS.md)**',
        fields: [
            {
                name: '🧠 Inteligência Artificial & Chat',
                value: '• `/yui` — Converse com a Yui sobre GTA Online (Suporta DMs, User Install e visibilidade Privada).'
            },
            {
                name: '⚙️ Administração de Servidor (Server Admin)',
                value: '• `/yui-servidor` — Painel interativo de configuração do servidor.\n• `/yui-ferramentas` — Gerencia e inspeciona as ferramentas MCP do servidor.\n• `/aceitar_tos` — Exibe e aceita os Termos de Serviço no servidor.'
            },
            {
                name: '🎙️ Voz & Assistente de Call',
                value: '• `/entrar-call` — Conecta a Yui ao seu canal de voz para voz por IA.\n• `/sair-call` — Desconecta a Yui do canal de voz.\n• `/modo-radio` — Inicia o sistema de rádio de música no canal de voz.'
            },
            {
                name: '🎨 Arte, Multimídia & Downloads',
                value: '• `/yui-imagem` — Gera ilustrações digitais em alta definição (SDXL).\n• `/anime_origem` — Identifica anime, episódio e minuto por print.\n• `/baixar_musica` — Central de MP3: YouTube, Spotify, Deezer, Instagram e TikTok.\n• `/baixar_video` — Baixa vídeos em MP4.'
            },
            {
                name: '🎮 Games, Loja & Utilidades',
                value: '• `/buscar_jogo` — Procura torrents/magnets de jogos de PC.\n• `/steam_jogo` — Preços, promoções e detalhes na loja oficial da Steam.\n• `/converter_moeda` — Cotação de moedas e criptomoedas em tempo real.\n• `/chat_resumo` — Resumo inteligente das últimas mensagens do canal.'
            },
            {
                name: '👑 Painel do Criador',
                value: '• `/yui-criador` — Central de Controle Master para o dono do bot.\n• `/yui-config_ia` — Ajusta parâmetros técnicos de baixo nível da IA.'
            }
        ],
        footer: '💡 Selecione um comando no menu suspenso abaixo para ver a análise aprofundada'
    });

    return { embeds: [embed], components: [getMainCategorySelectMenu('commands_list'), ...buildCommandMenus()] };
}

function buildHelpCommandDetailPayload(commandId) {
    const cmd = Object.hasOwn(COMMAND_DETAILS, commandId) ? COMMAND_DETAILS[commandId] : null;
    if (!cmd) return buildHelpCommandListPayload();

    // Campos de 1024: opções e exemplos de um comando com muita coisa documentada viram vários campos em vez de derrubar o painel.
    const fields = [];
    if (cmd.options && cmd.options.length > 0) {
        const optLines = cmd.options.map(o => `• \`${o.name}\` (${o.required ? 'Obrigatório' : 'Opcional'}): ${o.desc}`);
        chunkLines(optLines, 1000).forEach((value, i) => fields.push({ name: i === 0 ? '🛠️ Parâmetros & Opções' : '🛠️ Parâmetros & Opções (cont.)', value, inline: false }));
    } else {
        fields.push({ name: '🛠️ Parâmetros & Opções', value: '*Este comando não exige parâmetros adicionais.*', inline: false });
    }

    if (cmd.examples && cmd.examples.length > 0) {
        const exLines = cmd.examples.map(e => `\`\`\`bash\n${clampText(e, 200)}\n\`\`\``);
        chunkLines(exLines, 1000).forEach((value, i) => fields.push({ name: i === 0 ? '💡 Exemplos Práticos de Uso' : '💡 Exemplos Práticos de Uso (cont.)', value, inline: false }));
    }

    const embed = makeEmbed({
        color: 0x7C3AED,
        title: `🔍 Inspeção Técnica: ${cmd.name}`,
        description: `**Categoria:** ${cmd.category}\n**Permissão Mínima:** ${cmd.permission}\n\n**📄 Descrição:**\n${clampText(cmd.description, 2000)}\n\n**💻 Sintaxe do Comando:**\n\`\`\`bash\n${clampText(cmd.syntax, 400)}\n\`\`\``,
        fields,
        footer: 'Yui Command Inspector • Use os botões para navegar',
        timestamp: true
    });

    const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('help_btn_cmd_list').setLabel('⬅️ Voltar à Lista de Comandos').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('help_btn_home').setLabel('🏠 Início').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('commands_list'), btnRow] };
}

function buildHelpRulesPayload(pageIndex = 0) {
    const pages = getTosPages();
    const safeIndex = Math.max(0, Math.min(pageIndex, pages.length - 1));
    const currentPage = pages[safeIndex];

    const embed = makeEmbed({
        color: 0x7C3AED,
        title: currentPage.title,
        description: currentPage.content,
        footer: `Página ${safeIndex + 1} de ${pages.length} • Diretrizes & TOS Yui • by oBraga`,
        timestamp: true
    });

    const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`help_rules_page_${safeIndex - 1}`)
            .setLabel('⬅️ Anterior')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safeIndex === 0),
        new ButtonBuilder()
            .setCustomId('help_btn_home')
            .setLabel('🏠 Início')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(`help_rules_page_${safeIndex + 1}`)
            .setLabel('➡️ Próximo')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safeIndex === pages.length - 1)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('regras'), btnRow] };
}

function buildHelpCreatorPayload() {
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('✨ Criador, Redes Sociais & Apoio ao Projeto')
        .setDescription('Conheça mais sobre o desenvolvedor da **Yui**, acompanhe as redes sociais oficiais ou apoie o projeto para manter o bot no ar!')
        .addFields(
            {
                name: '👨‍💻 Desenvolvedor & Autor',
                value: 'Criado com dedicação por **oBraga** (<@369618206970609675>).\nO projeto é **100% Código Aberto (Open Source)**!'
            },
            {
                name: '🌐 Redes Sociais do Criador & Hub Central',
                value: 'Acesse o agregador oficial de redes sociais para conferir conteúdos, vídeos, atualizações e projetos:\n👉 **[Redes Sociais do Criador](https://bio.site/oBraga)**'
            },
            {
                name: '💖 Apoie a Yui pelo LivePix!',
                value: 'Manter a infraestrutura de IA, servidores de voz e modelos generativos rodando 24/7 exige custos consideráveis. Se você gosta do projeto e quer ajudar na manutenção, envie um apoio via Pix!\n\n🎁 **[Apoiar no LivePix](https://livepix.gg/obragafilho)**\n*Qualquer contribuição ajuda imensamente a manter a Yui sempre online e rápida!*'
            }
        )
        .setFooter({ text: 'Yui Project • Desenvolvido por oBraga' })
        .setTimestamp();

    const linkButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('🌐 Redes Sociais do Criador').setURL('https://bio.site/oBraga').setStyle(ButtonStyle.Link).setEmoji('🔗'),
        new ButtonBuilder().setLabel('💖 Apoiar no LivePix').setURL('https://livepix.gg/obragafilho').setStyle(ButtonStyle.Link).setEmoji('🎁'),
        new ButtonBuilder().setLabel('🚀 GitHub Open Source').setURL('https://github.com/MauroBragaFilho/Yui').setStyle(ButtonStyle.Link).setEmoji('⭐')
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

    // help_command_select é o 1º menu; com mais de 25 comandos os seguintes são help_command_select_2, _3...
    if (customId === 'help_command_select' || customId.startsWith('help_command_select_')) {
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
    buildHelpRulesPayload, buildHelpCreatorPayload, handleHelpInteraction,
    buildCommandMenus
};

export default {
    buildHelpHomePayload,
    buildHelpCommandListPayload,
    buildHelpCommandDetailPayload,
    buildHelpRulesPayload,
    buildHelpCreatorPayload,
    handleHelpInteraction
};
