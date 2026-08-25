import { SlashCommandBuilder } from 'discord.js';
import { aiClient } from '../../utils/aiClient.js';
import { config } from '../../config/index.js';
import { gtaoRepository } from '../../database/repositories/gtaoRepo.js';
import { getKnowledgeContext } from '../../utils/knowledgeBase.js';

function buildGtaDataContext() {
  const parts = [];

  const daily = gtaoRepository.getLatestDaily()?.data;
  if (daily) {
    const gv = daily.gunVan;
    const dealers = daily.streetDealers?.dealers;
    const tt = daily.timeTrials;

    parts.push(`DADOS DE HOJE (${daily.date || 'data desconhecida'}):`);
    if (gv) {
      const armas = (gv.weapons || []).map((w) => w.name).join(', ');
      parts.push(`- Gun Van: ${gv.locationName} | Itens em destaque: ${armas || 'N/A'}`);
    }
    if (dealers?.length) {
      const listaDealers = dealers.map((d) => `${d.locationName} (premium: ${d.premiumProduct})`).join('; ');
      parts.push(`- Street Dealers: ${listaDealers}`);
    }
    if (daily.collectibles?.shipwreck) {
      parts.push(`- Naufrágio (Shipwreck): ${daily.collectibles.shipwreck.locationName}`);
    }
    if (tt) {
      parts.push(
        `- Time Trials: RC Bandito em ${tt.rcBandito?.locationName}; Junk Energy Bike em ${tt.junkEnergyBike?.locationName}`
      );
    }
  }

  const weekly = gtaoRepository.getLatestWeekly()?.data;
  if (weekly) {
    parts.push(`\nDADOS DA SEMANA ATUAL:\n${JSON.stringify(weekly)}`);
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

function buildSystemPrompt() {
  // Se AI_SYSTEM_PROMPT estiver definido no .env, ele TEM PRIORIDADE total
  // (permite customizar a personalidade inteira sem tocar em código).
  const basePrompt = config.ai.systemPrompt
    ? config.ai.systemPrompt
    : (() => {
        const nome = config.ai.botName;
        return (
          `Seu nome é ${nome}. Sempre que alguém perguntar seu nome, quem você é, ou se referir a você, ` +
          `responda usando exatamente esse nome (${nome}) — nunca diga que é "um assistente de IA genérico" ` +
          `ou "um modelo de linguagem". Você é a ${nome}, uma assistente especialista em GTA Online. ` +
          `Responda sempre em português (Brasil), de forma direta e amigável, sobre negócios, veículos, ` +
          `dinheiro, missões, eventos e mecânicas do jogo.`
        );
      })();

  const sections = [basePrompt];

  const gtaData = buildGtaDataContext();
  if (gtaData) {
    sections.push(
      `\nVocê tem acesso aos seguintes dados REAIS e ATUALIZADOS do servidor sobre o GTA Online neste ` +
        `momento. Use-os para responder perguntas sobre localização da Gun Van, Dealers, Time Trials, etc. ` +
        `Nunca invente uma localização diferente da listada aqui:\n${gtaData}`
    );
  }

  const knowledge = getKnowledgeContext(config.ai.knowledgeDir);
  if (knowledge.content) {
    sections.push(
      `\nVocê também tem acesso à seguinte base de conhecimento adicional (dicas, builds, estratégias, ` +
        `buffs/debuffs, etc, fornecida pelo administrador do servidor). Priorize essas informações quando ` +
        `forem relevantes para a pergunta:\n${knowledge.content}`
    );
  }

  sections.push(
    `\nSe não tiver certeza sobre algo muito específico ou recente que não esteja nos dados acima, avise ` +
      `o usuário em vez de inventar informação.`
  );

  return sections.join('\n');
}

export const askCommand = {
  data: new SlashCommandBuilder()
    .setName('yui-perguntar')
    .setDescription('Converse com a Yui sobre GTA Online.')
    .addStringOption((option) =>
      option
        .setName('mensagem')
        .setDescription('O que você quer perguntar ou discutir sobre o GTA Online')
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!aiClient.isConfigured()) {
      return interaction.reply({
        content:
          '🤖 A integração ainda não foi configurada.',
        ephemeral: true,
      });
    }

    await interaction.deferReply();

    const pergunta = interaction.options.getString('mensagem');

    try {
      const resposta = await aiClient.chatCompletion([
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: pergunta },
      ]);

      // Discord limita mensagens a 2000 caracteres.
      const truncated = resposta.length > 1900 ? `${resposta.slice(0, 1900)}...` : resposta;
      return interaction.editReply({ content: truncated });
    } catch (error) {
      return interaction.editReply({
        content: `❌ Não consigo te responder agora: ${error.message}`,
      });
    }
  },
};
