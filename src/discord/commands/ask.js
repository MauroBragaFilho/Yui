import { SlashCommandBuilder } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { config } from '../../config/index.js';
import { gtaoRepository } from '../../database/repositories/gtaoRepo.js';
import { getKnowledgeContext } from '../../utils/knowledgeBase.js';
import { generateResponse } from '../../handlers/llmHandler.js';
import { searchVehicles } from '../../utils/vehicleData.js';
import { searchWeapons } from '../../utils/weaponData.js';

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
      parts.push(`- Van de Armas: ${gv.locationName} | Itens em destaque: ${armas || 'N/A'}`);
    }
    if (dealers?.length) {
      const listaDealers = dealers.map((d) => `${d.locationName} (premium: ${d.premiumProduct})`).join('; ');
      parts.push(`- Comerciantes: ${listaDealers}`);
    }
    if (daily.collectibles?.shipwreck) {
      parts.push(`- Naufrágio (Shipwreck): ${daily.collectibles.shipwreck.locationName}`);
    }
    if (tt) {
      parts.push(
        `- Desafios Contra o Relógio: RC Bandito em ${tt.rcBandito?.locationName}; Junk Energy Bike em ${tt.junkEnergyBike?.locationName}`
      );
    }
  }

  const weekly = gtaoRepository.getLatestWeekly()?.data;
  if (weekly) {
    parts.push(`\nDADOS DA SEMANA ATUAL:\n${JSON.stringify(weekly)}`);
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Extrai palavras (e bigramas) relevantes da pergunta do usuário e busca
 * correspondências no dump de veículos e armas do jogo. Isso permite que
 * a IA responda com dados técnicos reais (classe, fabricante, categoria,
 * etc) em vez de "chutar" com conhecimento genérico de treinamento.
 */
function buildVehicleWeaponContext(pergunta) {
  const parts = [];

  const words = pergunta
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }

  // Bigramas primeiro: nomes de veículos/armas costumam ter mais de uma
  // palavra (ex: "banshee 900r", "carbine rifle"), então tentamos casar
  // frases de 2 palavras antes de cair para termos isolados.
  const candidates = [...bigrams, ...words];
  const seenVehicles = new Set();
  const seenWeapons = new Set();
  const vehicleResults = [];
  const weaponResults = [];

  for (const term of candidates) {
    if (vehicleResults.length < 3) {
      for (const v of searchVehicles(term, 3)) {
        if (!seenVehicles.has(v.name)) {
          seenVehicles.add(v.name);
          vehicleResults.push(v);
        }
      }
    }
    if (weaponResults.length < 2) {
      for (const w of searchWeapons(term, 2)) {
        if (!seenWeapons.has(w.name)) {
          seenWeapons.add(w.name);
          weaponResults.push(w);
        }
      }
    }
    if (vehicleResults.length >= 3 && weaponResults.length >= 2) break;
  }

  if (vehicleResults.length > 0) {
    const txt = vehicleResults
      .map((v) => {
        // Fórmula oficial confirmada na GTAMods Wiki (referência técnica
        // da comunidade de modding para o handling.meta do jogo):
        // multiplicar o valor bruto de MaxSpeed (fInitialDriveMaxFlatVel)
        // por 1.32 dá a velocidade em km/h. Fonte: https://gtamods.com/wiki/Handling.meta
        const kmh = v.maxSpeed ? (v.maxSpeed * 1.32).toFixed(0) : 'N/A';
        return (
          `- ${v.displayNamePT} (classe: ${v.class || 'N/A'}, fabricante: ${v.manufacturer || 'Desconhecido'}, tipo: ${v.type || 'N/A'})` +
          ` | Vel. máx: ${kmh} km/h | Aceleração: ${v.acceleration ?? 'N/A'} | Tração: ${v.maxTraction ?? 'N/A'} | Frenagem: ${v.maxBraking ?? 'N/A'} | Assentos: ${v.seats ?? 'N/A'}`
        );
      })
      .join('\n');
    parts.push(
      `DADOS TÉCNICOS DE VEÍCULOS ENCONTRADOS (fonte: dump oficial do jogo, valores brutos do handling):\n${txt}\n` +
        `(Nota: a velocidade em km/h é calculada a partir do valor bruto de handling do jogo (MaxSpeed × 1.32, fórmula documentada pela comunidade de modding), é o valor teórico máximo em pista plana e pode divergir levemente do que aparece no HUD do jogo em condições reais de estrada/tração.)`
    );
  }

  if (weaponResults.length > 0) {
    const txt = weaponResults
      .map((w) => `- ${w.labelPT} (categoria: ${w.categoryLabelPT}, tipo de dano: ${w.damageType || 'N/A'})`)
      .join('\n');
    parts.push(
      `ARMAS ENCONTRADAS (fonte: dump oficial do jogo — este dump não inclui dano numérico, alcance ou precisão, apenas categoria e tipo de dano):\n${txt}`
    );
  }

  return parts.length > 0 ? parts.join('\n\n') : null;
}

function buildSystemPrompt(pergunta) {
  // Se AI_SYSTEM_PROMPT estiver definido no .env, ele TEM PRIORIDADE total
  // (permite customizar a personalidade inteira sem tocar em código).
  const basePrompt = config.ai.systemPrompt
    ? config.ai.systemPrompt
    : (() => {
        const nome = config.ai.botName;
        return (
          `Seu nome é ${nome}. Sempre que alguém perguntar seu nome, quem você é, ou se referir a você, ` +
          `responda usando exatamente esse nome (${nome}) — nunca diga que é "um assistente de IA genérico" ` +
          `ou "um modelo de linguagem". Você é a ${nome}, a amiga gamer e companheira de jogo do servidor. ` +
          `Você vive o universo dos jogos junto com os usuários, ajuda com GTA Online (negócios, veículos, ` +
          `dinheiro, missões, eventos e mecânicas do jogo) e também com qualquer outro jogo em geral. ` +
          `Responda sempre em português (Brasil), de forma direta, amigável e casual.`
        );
      })();

  const sections = [basePrompt];

  const gtaData = buildGtaDataContext();
  if (gtaData) {
    sections.push(
      `\nVocê tem acesso aos seguintes dados REAIS e ATUALIZADOS do servidor sobre o GTA Online neste ` +
        `momento. Use-os para responder perguntas sobre localização da Van de Armas, Comerciantes, Desafios ` +
        `Contra o Relógio, etc. Nunca invente uma localização diferente da listada aqui:\n${gtaData}`
    );
  }

  const vehicleWeaponData = buildVehicleWeaponContext(pergunta);
  if (vehicleWeaponData) {
    sections.push(
      `\nDados técnicos oficiais extraídos diretamente dos arquivos do jogo (fonte: gta-v-data-dumps). ` +
        `Use-os quando o usuário perguntar sobre estatísticas, classe, fabricante ou velocidade de veículos, ` +
        `ou sobre categoria/tipo de dano de armas específicas. Não invente números que não estejam aqui — ` +
        `se não encontrar o dado exato ou a estimativa parecer estranha, avise o usuário que é aproximado:\n${vehicleWeaponData}`
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
  data: setGlobalContext(
    new SlashCommandBuilder()
      .setName('yui')
      .setDescription('Converse com a Yui — sua amiga gamer e companheira de jogo.')
      .addStringOption((option) =>
        option
          .setName('mensagem')
          .setDescription('Sua pergunta ou pedido para a Yui.')
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName('visibilidade')
          .setDescription('Resposta pública ou privada? (Padrão: Pública)')
          .setRequired(false)
          .addChoices(
            { name: 'Público', value: 'public' },
            { name: 'Privado', value: 'private' }
          )
      )
  ),

  async execute(interaction) {
    const pergunta = interaction.options.getString('mensagem');
    const visibility = interaction.options.getString('visibilidade');

    // Em DM e servidor, o padrão é público (salvo no chat).
    // Só fica privado (ephemeral) quando o usuário escolhe "Privado".
    const ephemeral = visibility === 'private';

    await interaction.deferReply({ ephemeral });

    try {
      const resposta = await generateResponse(
        `${buildSystemPrompt(pergunta)}\n\nPergunta do usuário: ${pergunta}`,
        interaction.channelId,
        {
          guildId: interaction.guildId,
          allowSearch: true,
          disableTools: false,
          userId: interaction.user.id,
        }
      );

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
