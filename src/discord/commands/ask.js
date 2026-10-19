import { SlashCommandBuilder } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { config } from '../../config/index.js';
import { gtaoRepository } from '../../database/repositories/gtaoRepo.js';
import { getKnowledgeContext } from '../../utils/knowledgeBase.js';
import { generateResponse, runResearchFor, isToolDisabled, stripThinking, isSystemReply } from '../../handlers/llmHandler.js';
import { contextFromDiscord } from '../../core/discordAdapter.js';
import { isOwnerId } from '../../core/permissions.js';
import { buildWebContextPrompt } from '../../handlers/llmSafety.js';
// Pesquisa na web: o /yui e o +yui usam o MESMO agente da fila (Porta A: pré-rota; Portas C e D: promessa vazia e guarda final).
import { routeExplicitResearch, reviewResearchReply } from '../../core/ai/manager.js';
// Lista de mods (Minecraft): o CÓDIGO procura cada nome no Modrinth (a IA não inventa link). Fora da fila, como o resto do /yui.
import { routeModList } from '../../handlers/modListResolver.js';
import { routeLists } from '../../handlers/listAssistant.js';
import { SAFE_ALLOWED_MENTIONS } from '../mentions.js';
import { sendLongReply, parseMaxParts, formatDeliveryLog, createProgressReporter } from '../longReply.js';
import {
  resolveContextTarget,
  initContextStore,
  runWithContext,
  recordContextExchange,
  isErrorReply,
  isUnsafeForContext,
  ERROR_MARKER,
} from '../../core/context/contextStore.js';
import { logger } from '../../utils/logger.js';
import { searchVehicles } from '../../utils/vehicleData.js';
import { searchWeapons } from '../../utils/weaponData.js';
import {
  searchVehicles as searchGtaCarsVehicles,
  updateVehicles as updateGtaCarsVehicles,
} from '../../services/gta/vehicles/gtacars/service.js';
import { normalizeName } from '../../services/gta/vehicles/gtacars/parser.js';

/**
 * Filtra candidatos do GTACars exigindo correspondência REAL com o termo.
 *
 * O searchVehicles do GTACars ordena por score e aceita score mínimo de 0.25 —
 * o que deixa passar falsos positivos por prefixo curto (ex.: "velocidade"
 * casa por prefixo com "v" de "V-65 Molotok", e "qual" está DENTRO de
 * "Shitzu Squalo"). Aqui exigimos cobertura por TOKENS do nome oficial:
 * cada token do termo precisa casar com o COMEÇO de um token do nome
 * (ou ser igual a ele). Isso mantém "10F" → Obey 10F e "sultan rs" →
 * Karin Sultan RS, mas descarta ruído lexical.
 */
function isRelevantMatch(vehicle, term) {
  const normTerm = normalizeName(term);
  if (!normTerm) return false;

  // Campos do GTACars (normalizedName) ou do dump DurtyFree (name bruto).
  const rawName = vehicle.normalizedName || vehicle.name || '';
  const name = normalizeName(rawName);
  if (!name) return false;

  // Casamento por identificador (id/slug) ou nome curto exato (GTACars).
  if (vehicle.id === normTerm || vehicle.slug === normTerm) return true;
  const short = normalizeName(vehicle.shortName);
  if (short === normTerm) return true;

  // Cobertura total: cada token do termo (2+ letras) tem que casar com o
  // começo de um token do nome oficial (ou ser idêntico a ele).
  const termTokens = normTerm.split(' ').filter((t) => t.length >= 2);
  if (termTokens.length === 0) return false;

  const nameTokens = name.split(' ');
  return termTokens.every((tk) =>
    nameTokens.some((tok) => tok === tk || tok.startsWith(tk))
  );
}

const MAX_QUESTION_WORDS = 40;

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
export function buildVehicleWeaponContext(pergunta) {
  const parts = [];

  // Só as primeiras 40 palavras entram na busca: cada termo custa uma varredura nos dumps de veículos e armas
  // (cerca de 0,17 ms) e uma pergunta de 6000 caracteres travava o laço de eventos por mais de 1 s.
  const words = String(pergunta ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, MAX_QUESTION_WORDS);

  const bigrams = [];
  for (let i = 0; i < words.length - 1; i++) {
    bigrams.push(`${words[i]} ${words[i + 1]}`);
  }

  // Bigramas primeiro: nomes de veículos/armas costumam ter mais de uma
  // palavra (ex: "banshee 900r", "carbine rifle"), então tentamos casar
  // frases de 2 palavras antes de cair para termos isolados.
  // Termo repetido não acrescenta nada (os resultados já são deduplicados por nome): só custaria outra varredura.
  const candidates = [...new Set([...bigrams, ...words])];
  const seenVehicles = new Set();
  const seenWeapons = new Set();
  const vehicleResults = [];
  const weaponResults = [];

  for (const term of candidates) {
    if (vehicleResults.length < 3) {
      // Fonte primária: GTACars (busca fuzzy por nome/id/fabricante).
      // Fonte secundária: dump DurtyFree (fallback para itens ausentes no
      // GTACars, ex.: alguns veículos especiais).
      const primary = searchGtaCarsVehicles(term, 5)
        .filter((v) => isRelevantMatch(v, term))
        .slice(0, 3);
      const used =
        primary.length > 0
          ? primary
          : searchVehicles(term, 5).filter((v) => isRelevantMatch(v, term)).slice(0, 3);
      for (const v of used) {
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
        if (v.source === 'gtacars') {
          // Fonte GTACars: já traz topSpeed em km/h, preço, tração, DLC e link.
          const preco = v.price ? `R$${v.price.toLocaleString('pt-BR')} (GTA$)` : 'N/A';
          return (
            `- ${v.name} (classe: ${v.class || 'N/A'}, fabricante: ${v.manufacturer || 'Desconhecido'}, tipo: ${v.type || 'N/A'})` +
            ` | Vel. máx: ${v.topSpeed ?? 'N/A'} km/h | Assentos: ${v.seats ?? 'N/A'} | Tração: ${v.drivetrain || 'N/A'}` +
            ` | Preço: ${preco} | DLC: ${v.dlc || 'N/A'} | Link: ${v.url}`
          );
        }
        // Fonte DurtyFree (fallback): topSpeed bruto do handling × 1.32.
        // Fórmula oficial confirmada na GTAMods Wiki (handling.meta).
        const kmh = v.maxSpeed ? (v.maxSpeed * 1.32).toFixed(0) : 'N/A';
        return (
          `- ${v.displayNamePT} (classe: ${v.class || 'N/A'}, fabricante: ${v.manufacturer || 'Desconhecido'}, tipo: ${v.type || 'N/A'})` +
          ` | Vel. máx: ${kmh} km/h | Aceleração: ${v.acceleration ?? 'N/A'} | Tração: ${v.maxTraction ?? 'N/A'} | Frenagem: ${v.maxBraking ?? 'N/A'} | Assentos: ${v.seats ?? 'N/A'}`
        );
      })
      .join('\n');
    parts.push(
      `DADOS TÉCNICOS DE VEÍCULOS ENCONTRADOS (fonte: GTACars, com fallback para dump oficial do jogo — valores brutos do handling onde aplicável):\n${txt}\n` +
        `(Nota: a velocidade em km/h vem do próprio GTACars quando disponível; itens vindos do dump são calculados a partir do valor bruto de handling do jogo (MaxSpeed × 1.32, fórmula documentada pela comunidade de modding), é o valor teórico máximo em pista plana e pode divergir levemente do que aparece no HUD do jogo em condições reais de estrada/tração.)`
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

// Assuntos de GTA Online: só nesses casos injetamos os dados do jogo e o conhecimento
// de GTA no prompt (em conversa sobre outros jogos eles só gastariam tokens e puxariam o tema).
const GTA_TOPIC =
  /\b(gta\w*|rockstar|los santos|golpes?|cayo|perico|van de armas|gun van|traficantes?|comerciantes?|naufr[aá]gio|colecion[aá]veis|contra o rel[oó]gio|time trials?|bandito|junk energy|semanal|nightclub|bunker|acid lab|p[oó]dio|reset)\b/i;

export function isGtaTopic(pergunta) {
  return GTA_TOPIC.test(pergunta || '');
}

/**
 * Monta SÓ o contexto extra da pergunta. A personalidade já é aplicada pelo llmHandler
 * (persona/yui-publica.md); repeti-la aqui duplicaria os tokens. AI_SYSTEM_PROMPT, se
 * definido no .env, entra como texto extra no início.
 */
export function buildSystemPrompt(pergunta) {
  const sections = [];
  if (config.ai.systemPrompt) sections.push(config.ai.systemPrompt);

  const vehicleWeaponData = buildVehicleWeaponContext(pergunta);
  const gta = isGtaTopic(pergunta) || Boolean(vehicleWeaponData);

  if (gta) {
    const gtaData = buildGtaDataContext();
    if (gtaData) {
      sections.push(
        `Dados REAIS e atuais do GTA Online (use para Van de Armas, Comerciantes, Contra o Relógio, bônus da semana etc.; não invente localização diferente):\n${gtaData}`
      );
    }
  }

  if (vehicleWeaponData) {
    sections.push(
      `Dados técnicos de veículos/armas (GTACars e dump do jogo). Não invente números que não estejam aqui; se parecer estranho ou faltar, avise que é aproximado:\n${vehicleWeaponData}`
    );
  }

  const knowledge = getKnowledgeContext(config.ai.knowledgeDir, { gta });
  if (knowledge.content) {
    sections.push(
      `Base de conhecimento do administrador (priorize quando for relevante):\n${knowledge.content}`
    );
  }

  return sections.join('\n\n');
}

/**
 * Conversa sensível = a mesma regra do chat por menção: o dono em DM ou em canal privado
 * (escopo de memória "personal"). Nela a Yui não usa provedores anônimos e só pesquisa na web se o
 * YUI_PRIVATE_SEARCH liberar (e, então, só em pedido explícito e com as proteções do modo privado).
 * Na dúvida (erro ao montar o contexto), trata como sensível.
 */
export function isSensitiveInteraction(interaction) {
  try {
    const ctx = contextFromDiscord({
      userId: interaction?.user?.id,
      guildId: interaction?.guildId ?? null,
      channelId: interaction?.channelId ?? null,
    });
    return ctx.memoryScope === 'personal';
  } catch {
    return true;
  }
}

/**
 * Conversa PRIVADA para a PESQUISA na web: a sensível (dono em DM ou canal privado) e também a DM de QUALQUER pessoa (decisão do dono: "DM e app para todos, com as
 * proteções"). Aqui o YUI_PRIVATE_SEARCH decide se pesquisa e valem as proteções do modo privado (pedido explícito, consulta literal, síntese sem provedor anônimo,
 * nada gravado). Só a pesquisa usa isto: a cadeia de provedores e a memória seguem o isSensitiveInteraction. Na dúvida, privada.
 */
export function isPrivateResearchInteraction(interaction) {
  try {
    return isSensitiveInteraction(interaction) || !interaction?.guildId;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Limites da pergunta e uma resposta por vez por pessoa (TG-10, TG-13, TG-14, D2)
// ---------------------------------------------------------------------------------------------

const DEFAULT_ASK_MAX_CHARS = 4000;
const ASK_STALE_MS = 10 * 60 * 1000; // um registro "em andamento" mais velho que isto é tratado como esquecido
const NOTICE_EVERY_MS = 30 * 1000; // no prefixo, o aviso de recusa sai no máximo 1 vez a cada 30 s por pessoa

/** Máximo de caracteres da pergunta: YUI_ASK_MAX_CHARS (padrão 4000, faixa 100 a 20000). */
export function askMaxChars(env = process.env) {
  const n = Number.parseInt(String(env?.YUI_ASK_MAX_CHARS ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ASK_MAX_CHARS;
  return Math.min(Math.max(n, 100), 20000);
}

/**
 * Valida a pergunta ANTES de qualquer trabalho. Vazia ou grande demais é recusada com uma frase que diz o que fazer
 * (texto grande: mandar como mensagem normal mencionando a Yui, com um anexo .txt ou .md, que ela lê).
 */
export function checkAskText(pergunta, { max = askMaxChars(), prefix = config.discord.prefix, viaPrefix = false } = {}) {
  const text = String(pergunta ?? '');
  if (!text.trim()) {
    const message = viaPrefix
      ? `Faltou a pergunta. Use \`${prefix} perguntar <sua pergunta>\`.`
      : 'Escreva a sua pergunta no campo "mensagem".';
    return { ok: false, reason: 'empty', size: 0, max, message };
  }
  const size = Array.from(text).length;
  if (size > max) {
    return {
      ok: false,
      reason: 'too-long',
      size,
      max,
      message: `Texto grande demais (${size} caracteres). O máximo aqui é ${max}. Mande o texto como uma mensagem normal me mencionando e anexe um arquivo .txt ou .md, que eu leio.`,
    };
  }
  return { ok: true, reason: '', size, max, message: '' };
}

const activeAsks = new Map(); // quem pergunta -> { at, token }
const lastNotice = new Map(); // quem pergunta -> instante do último aviso de recusa (só no prefixo)
let askToken = 0;

/** Identifica quem pergunta: o /yui traz `user`; o adaptador do prefixo (+yui perguntar) traz `authorId`. */
export function askerKey(interaction) {
  const id = interaction?.user?.id ?? interaction?.authorId ?? null;
  return id ? String(id) : null;
}

/**
 * Reserva a vaga de "uma resposta por vez" da pessoa. Devolve o recibo (para liberar) ou null se ela já tem um /yui
 * em andamento. Sem identificar quem pergunta não há como limitar: segue sem vaga.
 */
export function tryAcquireAsk(key, now = Date.now()) {
  if (!key) return { token: 0 };
  const current = activeAsks.get(key);
  if (current && now - current.at < ASK_STALE_MS) return null;
  const slot = { at: now, token: ++askToken };
  activeAsks.set(key, slot);
  return slot;
}

/** Libera a vaga (só se ainda for a mesma reserva: uma vaga esquecida e reassumida não é solta por engano). */
export function releaseAsk(key, slot) {
  if (!key || !slot) return;
  if (activeAsks.get(key)?.token === slot.token) activeAsks.delete(key);
}

function shouldNotice(key, now = Date.now()) {
  if (!key) return true;
  const last = lastNotice.get(key);
  if (last !== undefined && now - last < NOTICE_EVERY_MS) return false;
  lastNotice.set(key, now);
  if (lastNotice.size > 500) {
    for (const [k, t] of lastNotice) if (now - t >= NOTICE_EVERY_MS) lastNotice.delete(k);
  }
  return true;
}

/**
 * Responde a recusa antes do deferReply: efêmera no /yui (só quem pediu vê) e sem menções. No prefixo a resposta é uma
 * mensagem normal, então o aviso é limitado a 1 por 30 s por pessoa (o resto só vai para o log).
 */
async function refuseAsk(interaction, content, { asker, always }) {
  if (!always && !shouldNotice(asker)) return null;
  try {
    return await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
  } catch (err) {
    logger.warn(`[Ask] Não consegui avisar a recusa: ${String(err?.message ?? err).slice(0, 120)}`);
    return null;
  }
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

    // O prefixo (+yui perguntar) passa por um adaptador de mensagem, sem isChatInputCommand: lá a recusa é uma mensagem normal.
    const isSlash = typeof interaction.isChatInputCommand === 'function';
    const asker = askerKey(interaction);

    // Antes do deferReply e de qualquer trabalho: pergunta vazia ou grande demais é recusada com a orientação (D2).
    const check = checkAskText(pergunta, { viaPrefix: !isSlash });
    if (!check.ok) {
      logger.info(`[Ask] Pergunta recusada (${check.reason}${check.size ? `, ${check.size} caracteres` : ''}).`);
      return refuseAsk(interaction, check.message, { asker, always: isSlash });
    }

    // Uma resposta por vez por pessoa: o /yui não passa pela fila da IA e cada pedido gasta CPU e cota de provedor.
    const slot = tryAcquireAsk(asker);
    if (!slot) {
      logger.info('[Ask] Pedido recusado: a pessoa já tem um /yui em andamento.');
      return refuseAsk(interaction, 'Espere a resposta anterior terminar antes de mandar outra pergunta.', { asker, always: isSlash });
    }

    try {
      await interaction.deferReply({ ephemeral });
    } catch (deferError) {
      releaseAsk(asker, slot);
      throw deferError;
    }

    let progress = null; // progresso da pesquisa na mensagem "Processando..." (createProgressReporter)
    try {
      const startedAt = Date.now();
      let meta = {};
      const ctx = buildSystemPrompt(pergunta);
      // Contexto por horas (desligado por padrão; ver src/core/context/contextStore.js): o /yui lê o fio de QUEM pergunta e,
      // numa resposta pública entregue e sem busca na web, grava a troca. A resposta privada (efêmera) só lê.
      let contextTarget = null;
      try {
        const target = resolveContextTarget({
          userId: interaction.user?.id,
          channelId: interaction.channelId,
          guildId: interaction.guildId,
          personal: isSensitiveInteraction(interaction),
          record: !ephemeral,
          userText: pergunta,
        });
        if (target.active) {
          await initContextStore();
          contextTarget = target;
        }
      } catch (contextError) {
        logger.warn(`[Ask] Contexto por horas indisponível, seguindo sem ele: ${String(contextError?.message ?? contextError).slice(0, 100)}`);
      }
      // Pesquisa na web (agente de pesquisa, o MESMO da fila): quem pergunta (SÓ a fala dela, nunca `ctx`), onde e se a conversa é privada.
      // O /yui nunca tem ferramentas, e a busca automática do generateResponse não roda em conversa privada: por isso, só aí, um pedido
      // EXPLÍCITO sem promessa também é pesquisado pelo código (searchIfExplicit). O progresso reaproveita a mensagem "Processando...".
      const sensitive = isSensitiveInteraction(interaction);
      const privateChat = isPrivateResearchInteraction(interaction); // a sensível + a DM de qualquer pessoa: só para a PESQUISA
      progress = createProgressReporter((text) => interaction.editReply({ content: text, allowedMentions: { parse: [] } }), { logger });
      const entry = {
        text: pergunta, sensitive: privateChat, isOwner: isOwnerId(interaction.user?.id), userId: interaction.user?.id ?? null,
        guildId: interaction.guildId ?? null, channelId: interaction.channelId ?? null, searchIfExplicit: privateChat, progress: progress.show,
      };
      const deps = { llm: { runResearchFor, isToolDisabled } };

      let resposta;
      let researchHandled = false; // o agente respondeu: a troca não vai ao contexto por horas (resultado derivado da web)
      // Porta M (lista de mods): 5+ linhas de nomes + "mods" + pedido de link/download/lista => o código resolve no Modrinth, sem consultar o modelo.
      // YUI_MODLIST_ENABLED=false desliga; conversa normal devolve { handled: false } na hora (mesmo contrato da Porta A, researched: true).
      // Porta L (listas pessoais: "anota na lista X: ...", "mostra a lista X"): o código executa; a lista é dado pessoal e não vai ao contexto.
      const listRouted = await routeLists(entry);
      const modRouted = listRouted.handled ? listRouted : await routeModList(entry, deps);
      // Porta A (só com YUI_RESEARCH_PRE_ROUTE=true): pedido explícito e estrito pesquisa por código, sem consultar o modelo.
      const routed = modRouted.handled ? modRouted : await routeExplicitResearch(entry, deps);
      if (routed.handled) {
        resposta = routed.text;
        researchHandled = routed.researched === true;
      } else {
        resposta = await runWithContext(contextTarget, () => generateResponse(
          (ctx ? `${ctx}\n\nPergunta do usuário: ${pergunta}` : pergunta),
          interaction.channelId,
          {
            guildId: interaction.guildId,
            // A busca automática (otimizador antigo) não roda em conversa privada (a pesquisa privada é do agente: pedido explícito, consulta literal).
            allowSearch: !privateChat,
            // O gatilho de busca olha SÓ a pergunta (o prompt também carrega a base de conhecimento, que tem
            // palavras como "search" e abria a busca em toda pergunta).
            searchPrompt: pergunta,
            // O /yui só devolve texto: nunca executa ferramenta. Sem tools a resposta não vira JSON cru e um
            // texto da web com instruções não tem ferramenta para acionar (o generateResponse também as desliga
            // quando a busca foi usada).
            disableTools: true,
            userId: interaction.user?.id,
            sensitive: isSensitiveInteraction(interaction),
            onMeta: (m) => { meta = m; },
          }
        ));
        // Portas C e D: se o modelo só PROMETEU pesquisar ("Vou pesquisar isso!") isso vira pesquisa de verdade, recusa honesta ou a resposta final;
        // o que ainda for só promessa nunca chega à pessoa. Resposta com a busca automática já feita (meta.usedSearch) não pesquisa de novo.
        const reviewed = await reviewResearchReply({
          ...entry, reply: resposta, usedSearch: meta.usedSearch === true,
          // a busca automática JÁ foi tentada e falhou: o agente não pesquisa de novo (3 buscas num pedido), só diz o motivo; JSON de ferramenta cru nunca é resposta
          searchFailure: meta.searchFailure || '', searchRetryAfterMs: meta.searchRetryAfterMs || 0, rejectToolJson: true,
          // a busca automática trouxe a web, mas a síntese só prometeu: nova resposta COM a mesma web (os links já achados não se perdem)
          regenerateWithWeb: async (retryPrompt) => {
            if (!meta.webContext) return '';
            const again = await runWithContext(contextTarget, () => generateResponse(
              buildWebContextPrompt({ context: meta.webContext, userPrompt: ctx ? `${ctx}\n\n${retryPrompt}` : retryPrompt }),
              interaction.channelId,
              { guildId: interaction.guildId, allowSearch: false, disableTools: true, userId: interaction.user?.id, sensitive }
            ));
            const clean = stripThinking(String(again ?? '')).trim();
            return clean && !isSystemReply(clean) ? clean : '';
          },
          regenerate: async (retryPrompt) => {
            const again = await runWithContext(contextTarget, () => generateResponse(
              (ctx ? `${ctx}\n\n${retryPrompt}` : retryPrompt),
              interaction.channelId,
              { guildId: interaction.guildId, allowSearch: false, disableTools: true, userId: interaction.user?.id, sensitive }
            ));
            const clean = stripThinking(String(again ?? '')).trim();
            return clean && !isSystemReply(clean) ? clean : '';
          },
        }, deps);
        resposta = reviewed.text;
        researchHandled = reviewed.researched === true;
      }
      // Nenhuma edição de progresso pode sobrescrever a resposta final.
      await progress.settle();

      // Nada de corte seco em 1900: o divisor entrega a resposta INTEIRA (várias mensagens ou, se for enorme,
      // uma introdução + o texto completo em anexo). Resposta efêmera ("Privado") nunca vai para o canal.
      // Nada de @everyone/@here/cargos: texto vindo da web pode levar o modelo a escrevê-los.
      const delivery = await sendLongReply({
        kind: 'slash',
        interaction,
        text: resposta,
        allowedMentions: SAFE_ALLOWED_MENTIONS,
        maxParts: parseMaxParts(),
        logger,
      });
      logger.info(formatDeliveryLog({
        chars: String(resposta ?? '').length,
        parts: delivery.parts,
        sentParts: delivery.sentParts,
        mode: delivery.mode,
        ok: delivery.ok,
        channelKind: interaction.guildId ? 'servidor' : 'DM',
        durationMs: Date.now() - startedAt,
        deliveryMs: delivery.durationMs,
        provider: meta.provider,
        model: meta.model,
        finishReason: meta.finishReason,
        continuations: meta.continuations ?? 0,
        partial: delivery.partial === true,
        retried: delivery.retried ?? 0,
      }));
      // Só depois da entrega confirmada. Resposta com busca na web (a automática ou a do agente de pesquisa) ou com marcador de ferramenta não vai para o contexto.
      if (contextTarget?.record && delivery.ok && meta.usedSearch !== true && !researchHandled && !/^-# .*🔎/m.test(String(resposta ?? '')) && !isUnsafeForContext(resposta)) {
        recordContextExchange(contextTarget, { userText: pergunta, assistantText: isErrorReply(resposta) ? ERROR_MARKER : String(resposta ?? '') });
      }
      // Entrega PARCIAL (as partes 2+ não saíram, mas a parte 1 já avisa disso): não é erro. Lançar aqui trocaria a parte 1 (e o aviso) por "❌ Não consigo te responder".
      if (!delivery.ok && !delivery.partial) throw new Error('entrega da resposta falhou');
      return delivery.message;
    } catch (error) {
      progress?.close();
      // Detalhe técnico só no log; o usuário recebe uma frase curta.
      logger.error(`[Ask] Falha ao responder o /yui: ${String(error?.message ?? error).slice(0, 200)}`);
      try {
        return await interaction.editReply({
          content: '❌ Não consigo te responder agora. Tente de novo em instantes.',
          allowedMentions: SAFE_ALLOWED_MENTIONS,
        });
      } catch (replyError) {
        logger.error(`[Ask] Também não consegui avisar o erro: ${String(replyError?.message ?? replyError).slice(0, 120)}`);
        return null;
      }
    } finally {
      releaseAsk(asker, slot);
    }
  },
};
