const axios = require('axios');
const { EmbedBuilder } = require('discord.js');
const { generateResponse } = require('./llmHandler');
async function getAnimeSource(imageUrl) {
    try {
        const response = await axios.get(`https://api.trace.moe/search?anilistInfo&url=${encodeURIComponent(imageUrl)}`);
        if (!response.data || !response.data.result || response.data.result.length === 0) {
            return [];
        }
        return response.data.result.slice(0, 3).map(match => ({
            filename: match.filename,
            episode: match.episode,
            similarity: match.similarity,
            videoUrl: match.video,
            image: match.image,
            anilist: match.anilist
        }));
    } catch (error) {
        console.error('Erro na API trace.moe:', error);
        throw new Error('Falha ao consultar trace.moe');
    }
}
function formatTime(seconds) {
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec.toString().padStart(2, '0')}`;
}
async function fetchAnilistMetadata(anilistId) {
    const query = `
    query ($id: Int) {
        Media (id: $id, type: ANIME) {
            description(asHtml: false)
            genres
            averageScore
            studios(isMain: true) {
                nodes {
                    name
                }
            }
        }
    }
    `;
    try {
        const response = await axios.post('https://graphql.anilist.co', {
            query: query,
            variables: { id: anilistId }
        });
        return response.data.data.Media;
    } catch (error) {
        console.error('Erro ao buscar metadata do Anilist:', error.message);
        return null;
    }
}
async function handleSauceCommand(interaction) {
    await interaction.deferReply();
    const imageUrl = interaction.options.getAttachment('imagem')?.url || interaction.options.getString('url');
    console.log(`[LOG] Slash: /sauce | Usuário: ${interaction.user.tag} (${interaction.user.id}) | Local: {${interaction.guild?.name || 'DM'} - ${interaction.guildId || 'N/A'}} | Imagem/URL: ${imageUrl}`);
    if (!imageUrl) {
        return interaction.editReply('Você precisa me mandar uma imagem ou um link para eu descobrir o anime!');
    }
    try {
        const results = await getAnimeSource(imageUrl);
        if (!results || results.length === 0) {
            return interaction.editReply('Não encontrei nada parecido com essa imagem.');
        }
        const topMatch = results[0];
        const isLowConfidence = topMatch.similarity < 0.85;
        if (isLowConfidence) {
            const candidates = results.map(r => r.anilist.title.romaji || r.anilist.title.english || r.anilist.title.native || "Desconhecido");
            const uniqueCandidates = [...new Set(candidates)];
            const prompt = `
[CONTEXTO]
O usuário mandou um screenshot de anime, mas a busca retornou baixa precisão (< 85%).
Possíveis candidatos: ${uniqueCandidates.join(', ')}.
[SUA MISSÃO]
Aja como a Yui (Otaku/Gamer).
- Diga que está difícil de ver ("tá meio pixelado", "não tenho certeza").
- Cite que pode ser um dos animes da lista retornado pela API.
- Escolha um deles (aleatoriamente ou o que você "preferir") e faça um comentário pessoal/engraçado sobre ele ("torça para ser X porque Y").
- Não dê notas, apenas comente a dúvida.
- Resposta curta e direta.
`;
            let llmResponse = `Hmm, não tenho certeza. Pode ser **${uniqueCandidates[0]}** ou algum outro da lista...`;
            try { llmResponse = await generateResponse(prompt, interaction.channelId, { allowSearch: false, disableTools: true, skipLocal: true }); } catch (ignored) { }
            let msg = `${llmResponse}\n\n**Resultados Imprecisos (Possíveis Matches):**\n`;
            results.forEach(r => {
                const name = r.anilist.title.romaji || r.anilist.title.english;
                msg += `- **${name}** (~${(r.similarity * 100).toFixed(1)}%)\n`;
            });
            return interaction.editReply({ content: msg });
        }
        const animeData = topMatch;
        const animeName = animeData.anilist.title.romaji || animeData.anilist.title.english || animeData.anilist.title.native;
        const episode = animeData.episode ? `Episódio ${animeData.episode}` : 'Filme/OVA';
        const isHentai = animeData.anilist.isAdult;
        const extraInfo = await fetchAnilistMetadata(animeData.anilist.id);
        const studio = extraInfo?.studios?.nodes?.[0]?.name || "Desconhecido";
        const genres = extraInfo?.genres?.join(', ') || "N/A";
        const score = extraInfo?.averageScore ? `${extraInfo.averageScore}/100` : "Sem nota";
        let description = extraInfo?.description ? extraInfo.description.replace(/<[^>]*>?/gm, '') : "Sem descrição";
        if (description.length > 300) description = description.substring(0, 300) + '...';
        const embed = new EmbedBuilder()
            .setColor(isHentai ? 0xE11D48 : 0x3B82F6)
            .setTitle(`🎬 ${animeName}`)
            .setDescription(description)
            .setImage(animeData.image)
            .addFields(
                { name: '📺 Episódio', value: `${episode}`, inline: true },
                { name: '🏢 Estúdio', value: `${studio}`, inline: true },
                { name: '⭐ Nota', value: `${score}`, inline: true },
                { name: '🎭 Gêneros', value: `${genres}`, inline: false },
                { name: '🔞 Classificação', value: isHentai ? 'NSFW (+18)' : 'Seguro', inline: true },
                { name: '🎯 Precisão', value: `${(animeData.similarity * 100).toFixed(1)}%`, inline: true }
            )
            .setFooter({ text: 'Sauce encontrado via trace.moe • Yui • by yGuilhermy' })
            .setTimestamp();
        if (animeData.videoUrl) {
            embed.setDescription(`${description}\n\n🎥 **[Ver Cena Original](${animeData.videoUrl})**`);
        }
        await interaction.editReply({
            content: '> 🔎 **Encontrei!** Analisando detalhes...',
            embeds: [embed]
        });
        const prompt = `
[CONTEXTO]
O usuário enviou um screenshot e é do anime: "${animeName}".
Episódio: ${episode}.
Gêneros: ${genres}.
Estúdio: ${studio}.
Nota Anilist: ${score}.
Sinopse: ${description}.
Classificação +18: ${isHentai ? 'SIM' : 'NÃO'}.
[SUA MISSÃO]
Aja como a Yui (Analista de Animes).
Faça um comentário TÉCNICO e DIRETO sobre a obra.
- Evite gírias excessivas ou "papo fofo". Vá direto ao ponto.
- Avalie se vale a pena assistir baseando-se no estúdio e nota.
- Dê uma opinião curta e honesta.
- Finalize com uma "Nota Pessoal" (0/10).
MÁXIMO 2 LINHAS + A NOTA.
`;
        try {
            console.log('[SAUCE] Iniciando geração de comentário background...');
            const llmTask = generateResponse(prompt, interaction.channelId, { allowSearch: false, disableTools: true, skipLocal: true });
            const timeoutTask = new Promise((resolve) => setTimeout(() => resolve(null), 60000));
            const comment = await Promise.race([llmTask, timeoutTask]);
            if (comment && typeof comment === 'string') {
                const currentDesc = embed.data.description || "";
                embed.setDescription(`${currentDesc}\n\n**🗣️ Comentário da Yui:**\n${comment}`);
                await interaction.editReply({
                    content: null,
                    embeds: [embed]
                });
            } else {
                await interaction.editReply({
                    content: null,
                    embeds: [embed]
                });
            }
        } catch (err) {
            console.error("Erro no Sauce Background:", err.message);
            await interaction.editReply({ content: null, embeds: [embed] });
        }
    } catch (error) {
        console.error('Erro no handleSauceCommand:', error);
        await interaction.editReply('Tive um erro interno ao processar sua imagem.');
    }
}
module.exports = { handleSauceCommand };