import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import fs from 'fs.js';
import path from 'path.js';

const COMMAND_DETAILS = {
    'ia_chat': {
        name: '/ia_chat',
        category: '🧠 Inteligência Artificial',
        permission: '👥 Todos os Usuários',
        description: 'Inicia uma conversa ou faz uma pergunta direta ao cérebro de IA da Yui.',
        syntax: '/ia_chat prompt:<texto> [visibilidade:Publico|Privado]',
        options: [
            { name: 'prompt', desc: 'Pergunta, dúvida, instrução ou conversa desejada.', required: true },
            { name: 'visibilidade', desc: 'Publico (todos veem no chat) ou Privado (apenas você vê).', required: false }
        ],
        examples: [
            '/ia_chat prompt: Me explique como funciona a fotossíntese de forma simples',
            '/ia_chat prompt: Qual a diferença entre Docker e Máquina Virtual? visibilidade:Privado'
        ]
    },
    'config_servidor': {
        name: '/config_servidor',
        category: '⚙️ Administração de Servidor',
        permission: '🛡️ Administrador do Servidor (Gerenciar Servidor)',
        description: 'Abre o Painel Gráfico de Administração do Servidor para configurar comportamento, espontâneo, updates, menções e ferramentas MCP.',
        syntax: '/config_servidor',
        options: [],
        examples: [
            '/config_servidor'
        ]
    },
    'ia_ferramentas': {
        name: '/ia_ferramentas',
        category: '⚙️ Administração de Servidor',
        permission: '🛡️ Administrador do Servidor (Gerenciar Servidor)',
        description: 'Permite consultar a lista de ferramentas MCP do servidor, ativá-las/desativá-las ou restaurar o padrão de fábrica.',
        syntax: '/ia_ferramentas acao:<list|toggle|reset> [ferramenta:<nome>] [estado:<on|off>]',
        options: [
            { name: 'acao', desc: 'list (ver status), toggle (alternar) ou reset (restaurar padrão).', required: true },
            { name: 'ferramenta', desc: 'Nome da ferramenta a ser alterada (com autocomplete).', required: false },
            { name: 'estado', desc: 'on (Ativar) ou off (Desativar).', required: false }
        ],
        examples: [
            '/ia_ferramentas acao:list',
            '/ia_ferramentas acao:toggle ferramenta:generate_image estado:off'
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
    'config_criador': {
        name: '/config_criador',
        category: '👑 Painel do Criador',
        permission: '👑 Criador do Bot (Exclusivo)',
        description: 'Central de Controle Master para gerenciar modelos LLM, bans globais, AutoMod, MCPs e runtime do bot.',
        syntax: '/config_criador [subcomando]',
        options: [
            { name: 'subcomando', desc: 'painel, modelo, banir, desbanir, bans_lista, automod, ferramenta, bot_config.', required: false }
        ],
        examples: [
            '/config_criador painel'
        ]
    },
    'ia_config': {
        name: '/ia_config',
        category: '👑 Painel do Criador',
        permission: '👑 Criador do Bot (Exclusivo)',
        description: 'Ajusta parâmetros de baixo nível da IA como Timeout, Temperatura e limite de Max Tokens.',
        syntax: '/ia_config provider:<provedor> setting:<opcao> value:<numero>',
        options: [
            { name: 'provider', desc: 'Provedor de IA a ser configurado.', required: true },
            { name: 'setting', desc: 'Timeout, Temperatura ou Max Tokens.', required: true },
            { name: 'value', desc: 'Novo valor numérico.', required: true }
        ],
        examples: [
            '/ia_config provider:gemini setting:Temperatura value:0.7'
        ]
    },
    'entrar-call': {
        name: '/entrar-call',
        category: '🎙️ Voz & Calls',
        permission: '👥 Todos os Usuários',
        description: 'Faz a Yui entrar no seu canal de voz atual para interagir, responder a gatilhos de voz e atuar como assistente falante.',
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
    'ia_imagem': {
        name: '/ia_imagem',
        category: '🎨 Arte & Criatividade',
        permission: '👥 Todos os Usuários',
        description: 'Gera artes e ilustrações digitais exclusivas em HD usando o modelo SDXL Flash.',
        syntax: '/ia_imagem prompt:<descricao> [negative_prompt:<bloqueios>] [width:<largura>] [height:<altura>]',
        options: [
            { name: 'prompt', desc: 'Descrição detalhada da imagem a ser criada.', required: true },
            { name: 'negative_prompt', desc: 'O que NÃO deve aparecer na imagem.', required: false },
            { name: 'width', desc: 'Largura em pixels (padrão: 1024).', required: false },
            { name: 'height', desc: 'Altura em pixels (padrão: 1024).', required: false }
        ],
        examples: [
            '/ia_imagem prompt: Um gato astronauta flutuando no espaço com nebulosas coloridas ao fundo'
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
        description: 'Extrai e faz o download de áudio (.mp3) a partir de links do YouTube, Instagram Reels ou TikTok.',
        syntax: '/baixar_musica url:<link>',
        options: [
            { name: 'url', desc: 'URL do vídeo do YouTube, Instagram ou TikTok.', required: true }
        ],
        examples: [
            '/baixar_musica url:https://www.youtube.com/watch?v=...'
        ]
    },
    'baixar_musica_deezer': {
        name: '/baixar_musica_deezer',
        category: '🎵 Multimídia & Downloads',
        permission: '👥 Todos os Usuários',
        description: 'Pesquisa e baixa músicas em alta qualidade de áudio (MP3 HQ) diretamente do Deezer por nome ou artista.',
        syntax: '/baixar_musica_deezer busca:<nome_ou_artista>',
        options: [
            { name: 'busca', desc: 'Nome da música ou artista.', required: true }
        ],
        examples: [
            '/baixar_musica_deezer busca:Welcome To The Jungle Guns N Roses'
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
        { label: '✨ Criador & Apoie o Projeto', description: 'Redes sociais de yGuilhermy e apoio via LivePix', value: 'sobre', default: currentActive === 'sobre' }
    ];

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('help_category_select')
            .setPlaceholder('💡 Escolha uma seção do menu de ajuda')
            .addOptions(menuOptions)
    );
}

function buildHelpHomePayload() {
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('✨ Central de Ajuda — Yui AI')
        .setDescription('Bem-vindo(a) ao hub de ajuda oficial da **Yui**!\n\nEu sou uma Agente Autônoma multifuncional para o Discord, equipada com inteligência artificial generativa, assistente de voz em chamadas, download de multimídia, busca de jogos torrent, cotações em tempo real e moderação de segurança.\n\n📖 **[Guia Completo de Comandos](https://github.com/yGuilhermy/Yui/blob/main/docs/content_pt/COMMANDS.md)**')
        .addFields(
            { name: '🤖 Comandos & Inspeção', value: 'Explore a lista completa de comandos e selecione qualquer um no menu para ver sua sintaxe e exemplos.', inline: true },
            { name: '⚙️ Configuração do Servidor', value: 'Administradores podem usar `/config_servidor` ou `/ia_ferramentas` para ajustar os recursos.', inline: true },
            { name: '💖 Apoie o Projeto', value: 'Conheça as redes do criador e ajude a manter o bot no ar via **LivePix**!', inline: false }
        )
        .setFooter({ text: 'Use o menu suspenso abaixo para navegar pelas seções • by yGuilhermy' })
        .setTimestamp();

    const linkButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('🚀 GitHub').setURL('https://github.com/yGuilhermy/Yui').setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('🌐 Redes Sociais').setURL('https://bio.site/yGuilhermy').setStyle(ButtonStyle.Link),
        new ButtonBuilder().setLabel('💖 Apoiar no LivePix').setURL('https://livepix.gg/yguilhermy').setStyle(ButtonStyle.Link)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('home'), linkButtons] };
}

function buildHelpCommandListPayload() {
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('🤖 Lista Geral de Comandos')
        .setDescription('Confira abaixo a lista completa de comandos da Yui. Selecione qualquer comando no menu abaixo para abrir sua **inspeção técnica detalhada** com exemplos e opções!\n\n📖 **[Documentação Online](https://github.com/yGuilhermy/Yui/blob/main/docs/content_pt/COMMANDS.md)**')
        .addFields(
            {
                name: '🧠 Inteligência Artificial & Chat',
                value: '• `/ia_chat` — Converse diretamente com a IA da Yui (Suporta visibilidade Privada).'
            },
            {
                name: '⚙️ Administração de Servidor (Server Admin)',
                value: '• `/config_servidor` — Painel interativo de configuração do servidor.\n• `/ia_ferramentas` — Gerencia e inspeciona as ferramentas MCP do servidor.\n• `/aceitar_tos` — Exibe e aceita os Termos de Serviço no servidor.'
            },
            {
                name: '🎙️ Voz & Assistente de Call',
                value: '• `/entrar-call` — Conecta a Yui ao seu canal de voz para voz por IA.\n• `/sair-call` — Desconecta a Yui do canal de voz.\n• `/modo-radio` — Inicia o sistema de rádio de música no canal de voz.'
            },
            {
                name: '🎨 Arte, Multimídia & Downloads',
                value: '• `/ia_imagem` — Gera ilustrações digitais em alta definição (SDXL).\n• `/anime_origem` — Identifica anime, episódio e minuto por print.\n• `/baixar_musica` — Converte vídeos do YouTube/Reels/TikTok em MP3.\n• `/baixar_musica_deezer` — Busca e baixa MP3 HQ diretamente do Deezer.'
            },
            {
                name: '🎮 Games, Loja & Utilidades',
                value: '• `/buscar_jogo` — Procura torrents/magnets de jogos de PC.\n• `/steam_jogo` — Preços, promoções e detalhes na loja oficial da Steam.\n• `/converter_moeda` — Cotação de moedas e criptomoedas em tempo real.\n• `/chat_resumo` — Resumo inteligente das últimas mensagens do canal.'
            },
            {
                name: '👑 Painel do Criador',
                value: '• `/config_criador` — Central de Controle Master para o dono do bot.\n• `/ia_config` — Ajusta parâmetros técnicos de baixo nível da IA.'
            }
        )
        .setFooter({ text: '💡 Selecione um comando no menu suspenso abaixo para ver a análise aprofundada' });

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
            .setPlaceholder('🔍 Selecione um comando para inspecionar em detalhes')
            .addOptions(commandOptions)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('commands_list'), cmdSelectMenu] };
}

function buildHelpCommandDetailPayload(commandId) {
    const cmd = COMMAND_DETAILS[commandId];
    if (!cmd) return buildHelpCommandListPayload();

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle(`🔍 Inspeção Técnica: ${cmd.name}`)
        .setDescription(`**Categoria:** ${cmd.category}\n**Permissão Mínima:** ${cmd.permission}\n\n**📄 Descrição:**\n${cmd.description}\n\n**💻 Sintaxe do Comando:**\n\`\`\`bash\n${cmd.syntax}\n\`\`\``)
        .setTimestamp();

    if (cmd.options && cmd.options.length > 0) {
        const optText = cmd.options.map(o => `• \`${o.name}\` (${o.required ? 'Obrigatório' : 'Opcional'}): ${o.desc}`).join('\n');
        embed.addFields({ name: '🛠️ Parâmetros & Opções', value: optText, inline: false });
    } else {
        embed.addFields({ name: '🛠️ Parâmetros & Opções', value: '*Este comando não exige parâmetros adicionais.*', inline: false });
    }

    if (cmd.examples && cmd.examples.length > 0) {
        const exText = cmd.examples.map(e => `\`\`\`bash\n${e}\n\`\`\``).join('\n');
        embed.addFields({ name: '💡 Exemplos Práticos de Uso', value: exText, inline: false });
    }

    embed.setFooter({ text: 'Yui Command Inspector • Use os botões para navegar' });

    const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('help_btn_cmd_list').setLabel('⬅️ Voltar à Lista de Comandos').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('help_btn_home').setLabel('🏠 Início').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [getMainCategorySelectMenu('commands_list'), btnRow] };
}

function buildHelpRulesPayload(pageIndex = 0) {
    import { getTosPages } from './tosHandler.js';
    const pages = getTosPages();
    const safeIndex = Math.max(0, Math.min(pageIndex, pages.length - 1));
    const currentPage = pages[safeIndex];

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle(currentPage.title)
        .setDescription(currentPage.content)
        .setFooter({ text: `Página ${safeIndex + 1} de ${pages.length} • Diretrizes & TOS Yui • by yGuilhermy` })
        .setTimestamp();

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
                value: 'Criado com dedicação por **yGuilhermy** (<@593372065730396160>).\nO projeto é **100% Código Aberto (Open Source)**!'
            },
            {
                name: '🌐 Redes Sociais do Criador & Hub Central',
                value: 'Acesse o agregador oficial de redes sociais para conferir conteúdos, vídeos, atualizações e projetos:\n👉 **[Redes Sociais do Criador](https://bio.site/yGuilhermy)**'
            },
            {
                name: '💖 Apoie a Yui pelo LivePix!',
                value: 'Manter a infraestrutura de IA, servidores de voz e modelos generativos rodando 24/7 exige custos consideráveis. Se você gosta do projeto e quer ajudar na manutenção, envie um apoio via Pix!\n\n🎁 **[Apoiar no LivePix](https://livepix.gg/yguilhermy)**\n*Qualquer contribuição ajuda imensamente a manter a Yui sempre online e rápida!*'
            }
        )
        .setFooter({ text: 'Yui Project • Desenvolvido por yGuilhermy' })
        .setTimestamp();

    const linkButtons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('🌐 Redes Sociais do Criador').setURL('https://bio.site/yGuilhermy').setStyle(ButtonStyle.Link).setEmoji('🔗'),
        new ButtonBuilder().setLabel('💖 Apoiar no LivePix').setURL('https://livepix.gg/yguilhermy').setStyle(ButtonStyle.Link).setEmoji('🎁'),
        new ButtonBuilder().setLabel('🚀 GitHub Open Source').setURL('https://github.com/yGuilhermy/Yui').setStyle(ButtonStyle.Link).setEmoji('⭐')
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

export default {
    buildHelpHomePayload,
    buildHelpCommandListPayload,
    buildHelpCommandDetailPayload,
    buildHelpRulesPayload,
    buildHelpCreatorPayload,
    handleHelpInteraction
};
