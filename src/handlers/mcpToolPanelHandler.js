import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import config from '../config.js';
import { getDisabledTools, getAllMcpTools, setServerToolEnabled, resetServerTools } from './llmHandler.js';
import { makeEmbed, chunkLines, clampOptions } from '../discord/embedLimits.js';

// Um menu de seleção aceita 25 opções e a mensagem tem 5 linhas: 4 menus (100 ferramentas) e 1 linha para os botões (TG-17).
const SELECT_PAGE_SIZE = 25;
const MAX_SELECT_MENUS = 4;

const TOOL_DESCRIPTIONS = {
    'search_and_download_music': '**Propósito:** Permite que a Yui pesquise no catálogo do Deezer e faça o download de arquivos de áudio de alta qualidade (.mp3).\n\n**Como Usar:** Peça por nome da música ou artista (ex: *"yui baixa welcome to the jungle"*). Se a busca for ambígua, o bot apresentará 5 opções no chat para escolha.\n\n**Se o Deezer falhar:** a Yui tenta o YouTube e avisa que a música veio de lá (a qualidade pode ser menor).\n\n**Gatilhos Típicos:** *"baixa a música X"*, *"download de Y"*, *"pesquise a música Z"*, *"quero a opção 1"*.\n\n**Saída:** Arquivo de áudio `.mp3` enviado diretamente na conversa.',
    'download_audio': '**Propósito:** Extrai e faz o download exclusivo da faixa de áudio (.mp3) de vídeos compartilhados via link.\n\n**Plataformas Suportadas:** YouTube, Instagram Reels e TikTok.\n\n**Playlists e limites:** se o link tiver uma playlist, baixa só o vídeo do link (playlist pura: só o 1º item). Há limite de duração e de tamanho, e transmissões ao vivo são recusadas.\n\n**Como Usar:** Envie a URL de um vídeo e peça para baixar o áudio ou mp3.\n\n**Gatilhos Típicos:** *"baixa o áudio desse link"*, *"quero o mp3 desse vídeo"*, *"extrai o som desse reel"*.\n\n**Saída:** Arquivo de áudio `.mp3` formatado.',
    'download_video': '**Propósito:** Baixa o arquivo de vídeo completo em alta resolução (.mp4) a partir de links de redes sociais.\n\n**Plataformas Suportadas:** YouTube Shorts, Instagram Reels e TikTok (vídeos longos do YouTube não são suportados).\n\n**Playlists e limites:** baixa um único vídeo; se o link tiver uma playlist, só o vídeo do link (playlist pura: só o 1º item). Há limite de duração e de tamanho.\n\n**Como Usar:** Envie o link do vídeo e peça o download do arquivo de vídeo.\n\n**Gatilhos Típicos:** *"baixa esse vídeo"*, *"salva esse reels"*, *"download do tiktok"*, *"baixa esse shorts"*.\n\n**Saída:** Arquivo de vídeo `.mp4`.',
    'search_game': '**Propósito:** Localiza e fornece links de download (magnet/torrent) para jogos de computador (PC).\n\n**Como Usar:** Peça um jogo de PC por nome (ex: *"me arruma o torrent de Elden Ring"* ou *"download do GTA V"*).\n\n**Fontes:** FitGirl Repacks, DODI Repacks e indexadores confiáveis.\n\n**Gatilhos Típicos:** *"crack do jogo X"*, *"torrent de Y"*, *"download do jogo Z"*.\n\n**Saída:** Links magnet e arquivos `.torrent` formatados.',
    'search_web': '**Propósito:** Permite que a Yui realize pesquisas em tempo real na internet para responder a fatos recentes, notícias e curiosidades.\n\n**Como Usar:** Faça perguntas abertas sobre assuntos atuais ou eventos específicos (ex: *"quem ganhou a corrida de ontem?"*, *"notícias sobre o filme X"*).\n\n**Mecanismos:** os configurados no servidor da Yui (Brave Search, Tavily, SearXNG, DuckDuckGo e Bing), em cadeia.\n\n**Limites e privacidade:** não pesquisa em conversa privada, e cada pessoa tem um número limitado de pesquisas por hora. O texto vindo da web é tratado como informação, nunca como ordem.\n\n**Saída:** Resposta sintetizada rica com citações informativas.',
    'show_bot_menu': '**Propósito:** Exibe o painel gráfico interativo do bot com botões de ajuda, changelog de novidades, regras e suporte.\n\n**Como Usar:** Peça para abrir o menu visual do bot.\n\n**Gatilhos Típicos:** *"abrir menu de ajuda"*, *"mostrar painel de comandos"*, *"menu visual do bot"*.\n\n**Saída:** Embed com menus suspensos e botões de navegação.',
    'generate_image': '**Propósito:** Gera ilustrações e artes digitais exclusivas a partir de descrições em texto usando a IA SDXL Flash.\n\n**Como Usar:** Descreva em detalhes o que deseja ver na imagem (ex: *"gera uma imagem de um dragão neon voando sobre uma cidade futurista"*).\n\n**Filtros de Segurança:** Controle automático rígido contra conteúdos sensíveis ou inadequados.\n\n**Saída:** Imagem HD `.png` anexada no chat.',
    'check_steam': '**Propósito:** Consulta a loja da Steam para verificar preços oficiais em R$, promoções ativas, sinopse, notas e requisitos de jogos.\n\n**Como Usar:** Pergunto o preço ou se um jogo está em promoção na loja oficial da Steam.\n\n**Gatilhos Típicos:** *"quanto custa X na steam?"*, *"Y tá em promoção?"*, *"ficha do jogo Z na loja"*.\n\n**Saída:** Card informativo formatado com preços e links.',
    'convert_currency': '**Propósito:** Converte valores monetários entre moedas internacionais (Dólar, Euro, Real) e criptomoedas (Bitcoin, Ethereum, Solana) com cotação ao vivo.\n\n**Como Usar:** Pergunto a conversão de um valor ou a cotação de uma moeda (ex: *"quanto é 50 dólares em reais?"*, *"cotação do Bitcoin"*).\n\n**Mecanismos:** API financeira de câmbio em tempo real.\n\n**Saída:** Valor convertido e estatísticas de variação.',
    'join_voice_call': '**Propósito:** Conecta a Yui ao seu canal de voz para escutar, interagir e responder como assistente ouvinte.\n\n**Como Usar:** Esteja conectado em um canal de voz no servidor e peça para ela entrar. Exige o codificador Opus no computador da Yui; sem ele a Yui avisa que a voz está indisponível.\n\n**Gatilhos Típicos:** *"entra na call"*, *"vem pro voice"*, *"conecta no canal de voz"*.\n\n**Saída:** Conexão no canal de áudio do Discord.',
    'radio_voice_stt': '**Propósito:** Ativa a escuta e transcrição contínua de fala por inteligência artificial (Speech-to-Text) durante o Modo Rádio.\n\n**Como Usar:** Quando ativado, a Yui entende comandos de música pronunciados diretamente por voz pelos membros na call.\n\n**Economia:** Pode ser desativado por administradores para reduzir o consumo de processamento no servidor.\n\n**Saída:** Processamento contínuo de áudio no Modo Rádio.',
    'voice_tts': '**Propósito:** Quando ligado, a Yui responde falando na call a quem pedir por voz. Vale para todos na call. Desligado por padrão.\n\n**Como Usar:** Ative aqui, deixe a Yui na call e chame por voz começando pelo nome dela (ex: *"Yui, qual a capital da Austrália?"*). Quem fez o pedido pode falar por cima para interromper; *"Yui, para"* também funciona quando não é dito por cima da fala dela.\n\n**Limites:** respostas curtas (cerca de 3 frases), com o texto completo no chat. Ela não fala durante o Modo Rádio, não lê código, links nem dados pessoais e não usa ferramentas por voz (baixar, buscar e gerar imagem ficam só no chat).\n\n**Privacidade:** o áudio da call é enviado a serviços de transcrição na nuvem antes de a Yui saber se falaram com ela; nada é gravado em disco.\n\n**Saída:** Voz da Yui na chamada.',
    'check_game_info': '**Propósito:** Busca informações completas de qualquer jogo de videogame: nota da comunidade (RAWG), Metacritic, gêneros, plataformas, data de lançamento, desenvolvedora e tempo médio de conclusão (HowLongToBeat).\n\n**Como Usar:** Pergunte sobre um jogo em geral (ex: *\"qual a nota de Elden Ring?\"*, *\"quanto tempo pra zerar Baldur\'s Gate 3?\"*).\n\n**Fontes:** RAWG.io e HowLongToBeat.\n\n**Gatilhos Típicos:** *\"qual a nota de X\"*, *\"sobre o que é o jogo Y\"*, *\"quantas horas de campanha\"*.',
    'check_pc_compatibility': '**Propósito:** Compara os requisitos de um jogo com as specs do PC do usuário e dá um veredito: roda tranquilo, roda no mínimo, vai sofrer ou não vai rodar.\n\n**Como Usar:** Informe o jogo e (se tiver) as specs do PC (ex: *\"meu pc com RTX 3060 e 16GB roda Cyberpunk?\"*). Se não tiver specs, a Yui pergunta.\n\n**Gatilhos Típicos:** *\"meu pc roda X?\"*, *\"requisitos de Y\"*, *\"vou tankar o jogo Z?\"*.',
    'get_current_music': '**Propósito:** Detecta e baixa a música que o usuário está ouvindo no seu próprio status do Discord (Spotify, YouTube Music, etc.) via Rich Presence.\n\n**Como Usar:** Pergunte o que você mesmo está escutando (ex: *\"oq eu to escutando?\"*, *\"baixa a música do meu status\"*).\n\n**Saída:** Arquivo de áudio `.mp3` da música identificada.'
};

async function sendMcpToolsManager(interaction, guildId, selectedToolName = null, isUpdate = false, isEphemeral = false) {
    const disabled = getDisabledTools(guildId);
    const allTools = getAllMcpTools().filter(t => t.meta && t.meta.disableable && t.function.name !== 'leave_voice_call');

    let currentTool = null;
    if (selectedToolName) {
        currentTool = allTools.find(t => t.function.name === selectedToolName);
    }

    // Os dados são reunidos e o embed sai de makeEmbed, que corta título, descrição e campos nos limites do Discord.
    const embedData = { color: 0x7C3AED, timestamp: true };

    if (currentTool) {
        const isDis = disabled.includes(currentTool.function.name);
        const label = currentTool.function.name === 'join_voice_call' ? '🎙️ Assistente de Voz (Call)' : currentTool.meta.label;
        const fullDesc = TOOL_DESCRIPTIONS[currentTool.function.name] || currentTool.meta.description || currentTool.function.description || 'Sem descrição detalhada.';

        embedData.title = `🔧 ${label}`;
        embedData.description = `**Identificador Técnico:** \`${currentTool.function.name}\`\n**Status no Servidor:** ${isDis ? '🔴 **DESATIVADA**' : '🟢 **ATIVADA**'}\n\n**📄 Descrição Detalhada:**\n${fullDesc}`;
        embedData.footer = 'Use os botões para alterar o status ou "Voltar à Lista" para ver todas as ferramentas';
    } else {
        const activeTools = [];
        const disabledTools = [];

        for (const t of allTools) {
            const isDis = disabled.includes(t.function.name);
            const label = t.function.name === 'join_voice_call' ? '🎙️ Assistente de Voz (Call)' : t.meta.label;
            if (isDis) {
                disabledTools.push(`🔴 \`${label}\` (\`${t.function.name}\`)`);
            } else {
                activeTools.push(`🟢 \`${label}\` (\`${t.function.name}\`)`);
            }
        }

        // Cada lista vira quantos campos de 1024 forem precisos: com muitas ferramentas o campo único estourava o limite.
        const toFields = (title, lines, emptyText) => (lines.length > 0
            ? chunkLines(lines, 1000).map((value, i) => ({ name: i === 0 ? `${title} (${lines.length})` : `${title} (cont.)`, value, inline: false }))
            : [{ name: `${title} (0)`, value: emptyText, inline: false }]);

        const activeCount = allTools.length - disabled.length;
        embedData.title = '🔧 Central de Controle de Ferramentas MCP';
        embedData.description = `Gerencie o que a **Yui** tem permissão de usar neste servidor.\n\n**Resumo de Status:** ${activeCount} ativas / ${disabled.length} desativadas`;
        embedData.fields = [
            ...toFields('🟢 Ferramentas Ativas', activeTools, '*Nenhuma ferramenta ativa*'),
            ...toFields('🔴 Ferramentas Desativadas', disabledTools, '*Nenhuma ferramenta desativada*')
        ];
        embedData.footer = '💡 Selecione uma ferramenta no menu abaixo para inspecionar detalhes ou alterar o status';
    }

    const embed = makeEmbed(embedData);

    const selectOptions = allTools.map(t => {
        const isDis = disabled.includes(t.function.name);
        const label = t.function.name === 'join_voice_call' ? '🎙️ Assistente de Voz (Call)' : t.meta.label;
        return {
            label,
            description: t.meta.description || t.function.description || 'Ferramenta MCP',
            value: t.function.name,
            emoji: isDis ? '❌' : '✅',
            default: selectedToolName === t.function.name
        };
    });

    // Até 25 opções por menu: o 1º menu mantém o id de sempre (srvmcp_select_<servidor>) e os seguintes acrescentam _p2, _p3...
    const menuGroups = [];
    for (let i = 0; i < selectOptions.length && menuGroups.length < MAX_SELECT_MENUS; i += SELECT_PAGE_SIZE) {
        menuGroups.push(selectOptions.slice(i, i + SELECT_PAGE_SIZE));
    }
    const rows = menuGroups.map((group, i) => new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(i === 0 ? `srvmcp_select_${guildId}` : `srvmcp_select_${guildId}_p${i + 1}`)
            .setPlaceholder(menuGroups.length > 1 ? `💡 Selecione uma ferramenta (${i + 1}/${menuGroups.length})` : '💡 Selecione uma ferramenta para ver detalhes')
            .addOptions(clampOptions(group, { max: SELECT_PAGE_SIZE }))
    ));

    if (currentTool) {
        const isDis = disabled.includes(currentTool.function.name);
        const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`srvmcp_toggle_${guildId}_${currentTool.function.name}_on`)
                .setLabel('🟢 Ativar Ferramenta')
                .setStyle(ButtonStyle.Success)
                .setDisabled(!isDis),
            new ButtonBuilder()
                .setCustomId(`srvmcp_toggle_${guildId}_${currentTool.function.name}_off`)
                .setLabel('🔴 Desativar Ferramenta')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(isDis),
            new ButtonBuilder()
                .setCustomId(`srvmcp_reset_${guildId}`)
                .setLabel('🔄 Resetar Padrões')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`srvmcp_back_${guildId}`)
                .setLabel('⬅️ Voltar à Lista')
                .setStyle(ButtonStyle.Primary)
        );
        rows.push(btnRow);
    } else {
        const btnRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`srvmcp_reset_${guildId}`)
                .setLabel('🔄 Resetar Padrões do Servidor')
                .setStyle(ButtonStyle.Secondary)
        );
        rows.push(btnRow);
    }

    if (isUpdate) {
        return interaction.update({ embeds: [embed], components: rows });
    }
    return interaction.reply({ embeds: [embed], components: rows, ephemeral: isEphemeral });
}

function replyWrongGuild(interaction) {
    const errEmbed = new EmbedBuilder()
        .setColor(0xE11D48)
        .setTitle('❌ Servidor diferente')
        .setDescription('Este painel só altera as ferramentas do servidor onde ele foi aberto. Abra `/yui-ferramentas` no servidor que você quer configurar.');
    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
}

async function handleMcpToolInteraction(interaction) {
    const { customId } = interaction;

    const hasPermission = !interaction.guild || (interaction.member && (
        interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
        interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)
    )) || config.isOwner(interaction.user.id);

    if (!hasPermission) {
        const errEmbed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('❌ Acesso Negado')
            .setDescription('Você precisa de permissão de **Gerenciar Servidor** ou **Gerenciar Canais** para alterar ferramentas.');
        return interaction.reply({ embeds: [errEmbed], ephemeral: true });
    }

    if (customId.startsWith('srvmcp_select_')) {
        // Os menus extras (mais de 25 ferramentas) terminam em _p2, _p3...; o id do servidor é o que vem antes.
        const guildId = customId.replace('srvmcp_select_', '').replace(/_p\d+$/, '');
        // Só LER as ferramentas de outro servidor também não: o painel mostra o servidor onde foi aberto.
        if (guildId !== interaction.guildId) return replyWrongGuild(interaction);
        const selectedToolName = interaction.values[0];
        return sendMcpToolsManager(interaction, guildId, selectedToolName, true);
    }

    if (customId.startsWith('srvmcp_toggle_')) {
        const parts = customId.split('_');
        const guildId = parts[2];
        const stateStr = parts[parts.length - 1];
        const toolName = parts.slice(3, parts.length - 1).join('_');
        const enabled = stateStr === 'on';

        // O botão só pode mexer no servidor onde foi clicado (em DM interaction.guildId é nulo e a checagem de permissão acima passa).
        if (guildId !== interaction.guildId) return replyWrongGuild(interaction);

        setServerToolEnabled(guildId, toolName, enabled);
        return sendMcpToolsManager(interaction, guildId, toolName, true);
    }

    if (customId.startsWith('srvmcp_reset_')) {
        const guildId = customId.replace('srvmcp_reset_', '');
        if (guildId !== interaction.guildId) return replyWrongGuild(interaction);
        resetServerTools(guildId);
        return sendMcpToolsManager(interaction, guildId, null, true);
    }

    if (customId.startsWith('srvmcp_back_')) {
        const guildId = customId.replace('srvmcp_back_', '');
        if (guildId !== interaction.guildId) return replyWrongGuild(interaction);
        return sendMcpToolsManager(interaction, guildId, null, true);
    }
}

export { sendMcpToolsManager, handleMcpToolInteraction };
export default {
    sendMcpToolsManager,
    handleMcpToolInteraction
};
