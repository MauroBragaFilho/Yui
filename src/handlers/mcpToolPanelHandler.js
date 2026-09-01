import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import config from '../config.js';
import { getDisabledTools, getAllMcpTools, setServerToolEnabled, resetServerTools } from './llmHandler.js';

const TOOL_DESCRIPTIONS = {
    'search_and_download_music': '**Propósito:** Permite que a Yui pesquise no catálogo do Deezer e faça o download de arquivos de áudio de alta qualidade (.mp3).\n\n**Como Usar:** Peça por nome da música ou artista (ex: *"yui baixa welcome to the jungle"*). Se a busca for ambígua, o bot apresentará 5 opções no chat para escolha.\n\n**Gatilhos Típicos:** *"baixa a música X"*, *"download de Y"*, *"pesquise a música Z"*, *"quero a opção 1"*.\n\n**Saída:** Arquivo de áudio `.mp3` enviado diretamente na conversa.',
    'download_audio': '**Propósito:** Extrai e faz o download exclusivo da faixa de áudio (.mp3) de vídeos compartilhados via link.\n\n**Plataformas Suportadas:** YouTube, Instagram Reels e TikTok.\n\n**Como Usar:** Envie a URL de um vídeo e peça para baixar o áudio ou mp3.\n\n**Gatilhos Típicos:** *"baixa o áudio desse link"*, *"quero o mp3 desse vídeo"*, *"extrai o som desse reel"*.\n\n**Saída:** Arquivo de áudio `.mp3` formatado.',
    'download_video': '**Propósito:** Baixa o arquivo de vídeo completo em alta resolução (.mp4) a partir de links de redes sociais.\n\n**Plataformas Suportadas:** YouTube Shorts, Instagram Reels e TikTok (vídeos longos do YouTube não são suportados).\n\n**Como Usar:** Envie o link do vídeo e peça o download do arquivo de vídeo.\n\n**Gatilhos Típicos:** *"baixa esse vídeo"*, *"salva esse reels"*, *"download do tiktok"*, *"baixa esse shorts"*.\n\n**Saída:** Arquivo de vídeo `.mp4`.',
    'search_game': '**Propósito:** Localiza e fornece links de download (magnet/torrent) para jogos de computador (PC).\n\n**Como Usar:** Peça um jogo de PC por nome (ex: *"me arruma o torrent de Elden Ring"* ou *"download do GTA V"*).\n\n**Fontes:** FitGirl Repacks, DODI Repacks e indexadores confiáveis.\n\n**Gatilhos Típicos:** *"crack do jogo X"*, *"torrent de Y"*, *"download do jogo Z"*.\n\n**Saída:** Links magnet e arquivos `.torrent` formatados.',
    'search_web': '**Propósito:** Permite que a Yui realize pesquisas em tempo real na internet para responder a fatos recentes, notícias e curiosidades.\n\n**Como Usar:** Faça perguntas abertas sobre assuntos atuais ou eventos específicos (ex: *"quem ganhou a corrida de ontem?"*, *"notícias sobre o filme X"*).\n\n**Mecanismos:** Brave Search, DuckDuckGo e Bing.\n\n**Saída:** Resposta sintetizada rica com citações informativas.',
    'show_bot_menu': '**Propósito:** Exibe o painel gráfico interativo do bot com botões de ajuda, changelog de novidades, regras e suporte.\n\n**Como Usar:** Peça para abrir o menu visual do bot.\n\n**Gatilhos Típicos:** *"abrir menu de ajuda"*, *"mostrar painel de comandos"*, *"menu visual do bot"*.\n\n**Saída:** Embed com menus suspensos e botões de navegação.',
    'generate_image': '**Propósito:** Gera ilustrações e artes digitais exclusivas a partir de descrições em texto usando a IA SDXL Flash.\n\n**Como Usar:** Descreva em detalhes o que deseja ver na imagem (ex: *"gera uma imagem de um dragão neon voando sobre uma cidade futurista"*).\n\n**Filtros de Segurança:** Controle automático rígido contra conteúdos sensíveis ou inadequados.\n\n**Saída:** Imagem HD `.png` anexada no chat.',
    'check_steam': '**Propósito:** Consulta a loja da Steam para verificar preços oficiais em R$, promoções ativas, sinopse, notas e requisitos de jogos.\n\n**Como Usar:** Pergunto o preço ou se um jogo está em promoção na loja oficial da Steam.\n\n**Gatilhos Típicos:** *"quanto custa X na steam?"*, *"Y tá em promoção?"*, *"ficha do jogo Z na loja"*.\n\n**Saída:** Card informativo formatado com preços e links.',
    'convert_currency': '**Propósito:** Converte valores monetários entre moedas internacionais (Dólar, Euro, Real) e criptomoedas (Bitcoin, Ethereum, Solana) com cotação ao vivo.\n\n**Como Usar:** Pergunto a conversão de um valor ou a cotação de uma moeda (ex: *"quanto é 50 dólares em reais?"*, *"cotação do Bitcoin"*).\n\n**Mecanismos:** API financeira de câmbio em tempo real.\n\n**Saída:** Valor convertido e estatísticas de variação.',
    'join_voice_call': '**Propósito:** Conecta a Yui ao seu canal de voz para escutar, interagir e responder como assistente ouvinte.\n\n**Como Usar:** Esteja conectado em um canal de voz no servidor e peça para ela entrar.\n\n**Gatilhos Típicos:** *"entra na call"*, *"vem pro voice"*, *"conecta no canal de voz"*.\n\n**Saída:** Conexão no canal de áudio do Discord.',
    'radio_voice_stt': '**Propósito:** Ativa a escuta e transcrição contínua de fala por inteligência artificial (Speech-to-Text) durante o Modo Rádio.\n\n**Como Usar:** Quando ativado, a Yui entende comandos de música pronunciados diretamente por voz pelos membros na call.\n\n**Economia:** Pode ser desativado por administradores para reduzir o consumo de processamento no servidor.\n\n**Saída:** Processamento contínuo de áudio no Modo Rádio.',
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

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTimestamp();

    if (currentTool) {
        const isDis = disabled.includes(currentTool.function.name);
        const label = currentTool.function.name === 'join_voice_call' ? '🎙️ Assistente de Voz (Call)' : currentTool.meta.label;
        const fullDesc = TOOL_DESCRIPTIONS[currentTool.function.name] || currentTool.meta.description || currentTool.function.description || 'Sem descrição detalhada.';

        embed.setTitle(`🔧 ${label}`)
             .setDescription(`**Identificador Técnico:** \`${currentTool.function.name}\`\n**Status no Servidor:** ${isDis ? '🔴 **DESATIVADA**' : '🟢 **ATIVADA**'}\n\n**📄 Descrição Detalhada:**\n${fullDesc}`)
             .setFooter({ text: 'Use os botões para alterar o status ou "Voltar à Lista" para ver todas as ferramentas' });
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

        const activeCount = allTools.length - disabled.length;
        embed.setTitle('🔧 Central de Controle de Ferramentas MCP')
             .setDescription(`Gerencie o que a **Yui** tem permissão de usar neste servidor.\n\n**Resumo de Status:** ${activeCount} ativas / ${disabled.length} desativadas`)
             .addFields(
                 { name: `🟢 Ferramentas Ativas (${activeTools.length})`, value: activeTools.length > 0 ? activeTools.join('\n') : '*Nenhuma ferramenta ativa*', inline: false },
                 { name: `🔴 Ferramentas Desativadas (${disabledTools.length})`, value: disabledTools.length > 0 ? disabledTools.join('\n') : '*Nenhuma ferramenta desativada*', inline: false }
             )
             .setFooter({ text: '💡 Selecione uma ferramenta no menu abaixo para inspecionar detalhes ou alterar o status' });
    }

    const selectOptions = allTools.map(t => {
        const isDis = disabled.includes(t.function.name);
        const label = t.function.name === 'join_voice_call' ? '🎙️ Assistente de Voz (Call)' : t.meta.label;
        return {
            label: label.substring(0, 95),
            description: (t.meta.description || t.function.description || 'Ferramenta MCP').substring(0, 95),
            value: t.function.name,
            emoji: isDis ? '❌' : '✅',
            default: selectedToolName === t.function.name
        };
    });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`srvmcp_select_${guildId}`)
        .setPlaceholder('💡 Selecione uma ferramenta para ver detalhes')
        .addOptions(selectOptions);

    const rows = [new ActionRowBuilder().addComponents(selectMenu)];

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
        const guildId = customId.replace('srvmcp_select_', '');
        const selectedToolName = interaction.values[0];
        return sendMcpToolsManager(interaction, guildId, selectedToolName, true);
    }

    if (customId.startsWith('srvmcp_toggle_')) {
        const parts = customId.split('_');
        const guildId = parts[2];
        const stateStr = parts[parts.length - 1];
        const toolName = parts.slice(3, parts.length - 1).join('_');
        const enabled = stateStr === 'on';

        setServerToolEnabled(guildId, toolName, enabled);
        return sendMcpToolsManager(interaction, guildId, toolName, true);
    }

    if (customId.startsWith('srvmcp_reset_')) {
        const guildId = customId.replace('srvmcp_reset_', '');
        resetServerTools(guildId);
        return sendMcpToolsManager(interaction, guildId, null, true);
    }

    if (customId.startsWith('srvmcp_back_')) {
        const guildId = customId.replace('srvmcp_back_', '');
        return sendMcpToolsManager(interaction, guildId, null, true);
    }
}

export { sendMcpToolsManager, handleMcpToolInteraction };
export default {
    sendMcpToolsManager,
    handleMcpToolInteraction
};
