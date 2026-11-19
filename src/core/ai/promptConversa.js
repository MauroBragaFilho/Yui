// Prompt de sistema da conversa do Discord (etapa 5, docs/ETAPA3_DONOS_E_CONTRATO.md §8): as partes PURAS que o bot (processo único,
// handlers/llmHandler.js generateResponse e buildToolsDefinition) e o cérebro (chat.turn, src/cerebro/conversa.js) montam do MESMO jeito.
//
// Por que aqui: com o cérebro separado (YUI_CEREBRO_EXTERNO=true) quem monta o prompt da conversa é o cérebro (persona, memória, histórico e a
// oferta de ferramentas são decisões dele); no processo único continua sendo o llmHandler. Os dois chamam estas funções, então o texto que
// chega ao modelo é o mesmo nos dois modos (persona única). UMA FONTE SÓ (etapa 6, pedido da Liz): o generateResponse do llmHandler não tem
// mais cópia nenhuma do texto; ele chama buildConversationSystemPrompt com os dados do Discord. Os textos foram MOVIDOS do llmHandler sem
// nenhuma mudança (conferido byte a byte pelo retrato do que o processo único manda ao provedor, em 19 situações, antes e depois; e
// tests/test-chat-turn-unidade.js compara o prompt do bot e o do cérebro para a mesma situação).
//
// O que vem do Discord (configuração do canal, que é do bot: prompt do servidor, persona e humor do canal, estado do rádio, ferramentas
// ligadas no servidor) chega como DADO de entrada. Nada aqui importa o bot nem o discord.js (tests/test-core-import-graph.js).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import legacyConfig from '../../config/index.js';
import { applyPersona, applyVoicePersona, publicPersonaText } from '../persona.js';
import { isOwnerId } from '../permissions.js';
import { NEVER_PROMISE_RULE, TOOLS_INTRO_LINE, TOOLS_SEARCH_DECISION, SEARCH_WEB_EXTRA_EXAMPLES } from './llmSafety.js';
import { readResearchConfig, privateSearchAllowed } from './researchAgent.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MCP_TOOLS_FILE = path.join(here, '../../data/mcp_tools.json');

// A regra "toda resposta é FINAL" do [REGRAS] sem citar nenhuma ferramenta: chamadas com as ferramentas fechadas (voz, /yui, a síntese da pesquisa, pesquisa desligada)
// não podem ter "search_web" no prompt de sistema (a IA entenderia que a oferece). Com a ferramenta disponível vale a NEVER_PROMISE_RULE completa, do llmSafety.
export const NEVER_PROMISE_RULE_NO_TOOLS = 'Toda resposta tem de ser FINAL: nunca diga que vai pesquisar, verificar ou voltar depois ("vou pesquisar", "um segundo", "já volto"), porque você não consegue mandar nada depois. Responda com o que sabe ou diga que não sabe.';

/** Resposta quando TODOS os provedores de IA falharam (o contexto por horas a reconhece como erro da IA: contextStore.isErrorReply). */
export const LIMITS_REACHED_TEXT = `⚡ **Limites de Processamento Atingidos:** Todos os nossos provedores de IA atingiram a cota temporária de tokens ou estão temporariamente indisponíveis. Tente interagir novamente daqui algumas horas! ✨`;

/**
 * Bloco [MODO RÁDIO] do servidor (a música que toca na call). '' sem rádio tocando, pausada ou carregando. Nunca lança.
 * @param {object|null} radioSession  a sessão do rádio do servidor (music/radioDatabase.js getSession), que é do bot
 */
export function radioPromptBlock(radioSession) {
    try {
        if (radioSession && (radioSession.status === 'PLAYING' || radioSession.status === 'PAUSED' || radioSession.status === 'BUFFERING') && radioSession.currentTrack) {
            const track = radioSession.currentTrack;
            const statusStr = radioSession.status === 'PAUSED' ? 'pausada' : radioSession.status === 'BUFFERING' ? 'carregando' : 'tocando';
            const posStr = radioSession.currentIndex >= 0 ? `#${radioSession.currentIndex + 1}` : '';
            const totalStr = Array.isArray(radioSession.playlist) ? `${radioSession.playlist.length}` : '0';
            let musicInfo = `\n[MODO RÁDIO / MÚSICA ATUAL NO SERVIDOR]:\n- Você está conectada na chamada de voz deste servidor com o Modo Rádio ativo.\n- Status da reprodução: ${statusStr}.\n- Faixa atual (${posStr} de ${totalStr}): "${track.title}" — Artista: "${track.artist}"`;
            if (track.album) musicInfo += ` (Álbum: "${track.album}")`;
            if (Array.isArray(radioSession.playlist) && radioSession.playlist.length > 1) {
                const nextIdx = radioSession.currentIndex + 1;
                if (nextIdx < radioSession.playlist.length) {
                    const nextTrack = radioSession.playlist[nextIdx];
                    musicInfo += `.\n- Próxima música da fila: "${nextTrack.title}" — Artista: "${nextTrack.artist}"`;
                }
            }
            musicInfo += `.\n[INSTRUÇÕES SOBRE O MODO RÁDIO NO CHAT]:\n1) Se o usuário perguntar o que está tocando, qual música é essa, quem está cantando ou sobre a playlist atual, responda informando os dados acima de forma natural.\n2) Se o usuário pedir no chat para você controlar o rádio (ex: pular música, pausar, passar para a próxima, parar) ou adicionar/tocar uma música nova no rádio, informe a ele que para controlar ou adicionar músicas no rádio ele deve usar os botões do menu do Modo Rádio (o painel de embed) ou o comando de voz na call.`;
            return musicInfo;
        }
    } catch (_) { /* rádio com dado estranho: sem o bloco */ }
    return '';
}

/**
 * Bloco de override do canal (persona e humor definidos pelo /yui-persona do canal, que é configuração do bot). '' sem nada definido.
 * @param {string|{instruction?: string, mood?: string}|null} settings  o que o bot guarda para o canal (channel_settings.json)
 */
export function channelPersonaBlock(settings) {
    const channelPersona = (typeof settings === 'string') ? settings : settings?.instruction;
    const channelMood = settings?.mood;
    if (!channelPersona && !channelMood) return '';
    let overrideMsg = `\n\n====================================================================================\n[⚠️ ALERTA IMPORTANTE DO SISTEMA: DEFINIÇÕES DO CANAL]\n`;
    if (channelPersona) {
        overrideMsg += `MESCLE SUA PERSONALIDADE DANDO PRIORIDADE A ESSA NOVA PERSONALIDADE/INSTRUÇÃO:
>>> ${channelPersona} <<<
VOCÊ DEVE ADERIR A ESSA NOVA PERSONA ACIMA DE TUDO.\n`;
    }
    if (channelMood) {
        overrideMsg += `\nESTADO EMOCIONAL/HUMOR ATUAL (MUDE SUA FORMA DE FALAR DE ACORDO):
>>> ${channelMood} <<<\n`;
    }
    overrideMsg += `====================================================================================\n`;
    return overrideMsg;
}

/**
 * O prompt de sistema da conversa, SEM a definição de ferramentas (que depende do provedor: ver toolsDefinitionText).
 * A ordem é a de sempre: base (prompt do servidor ou o padrão) + identidade pública + imagem + anti-repetição; a persona do contexto (troca só o
 * bloco de identidade); o ambiente; o rádio; as regras; o override do canal; a memória (só no prompt "com memória": provedor anônimo nunca a
 * recebe); por último o bloco de voz (a memória é texto de terceiros e não pode diluir as regras de fala).
 * @returns {{ withMemory: string, withoutMemory: string }}
 */
export function buildConversationSystemPrompt({
    serverPrompt = null, persona = undefined, guildName = null, channelName = null, radioBlock = '', noToolRule = false,
    channelSettings = null, memoryBlock = '', voice = false, config = legacyConfig,
} = {}) {
    let baseSystemPrompt = (serverPrompt || config.systemPrompt || config.ai?.systemPrompt || "") + "\n[IDENTIDADE — REGRA DE PRIORIDADE MÁXIMA]: " + publicPersonaText() + "\n[IMAGEM/VISÃO]: Você cria imagens novas com generate_image (pedido vago: invente um prompt criativo). Não enxerga nem edita imagens enviadas.\n[ANTI-REPETIÇÃO]: Não repita frases entre mensagens seguidas.";
    // Personalidade por contexto (Yui Core): só há override para o dono em DM/canal
    // privado e para o app; no Discord público segue a persona original.
    baseSystemPrompt = applyPersona(baseSystemPrompt, persona);
    if (config.sendEnvironmentInfo && (guildName || channelName)) {
        baseSystemPrompt += `\n[CONTEXTO DO AMBIENTE]: Você está conversando no servidor Discord "${guildName || 'DM'}" no canal/chat "#${channelName || 'Chat'}".`;
    }
    if (radioBlock) baseSystemPrompt += radioBlock;
    baseSystemPrompt += "\n[REGRAS]: Você não tem acesso a cargos, membros, logs nem regras do servidor (diga que não sabe). Código aberto: https://github.com/MauroBragaFilho/Yui (cite se pedirem). Se o histórico tiver 'erro da ia', a resposta anterior falhou: peça desculpas rápido e pergunte de novo. " + (noToolRule ? NEVER_PROMISE_RULE_NO_TOOLS : NEVER_PROMISE_RULE) + "\n[RESPOSTAS LONGAS E LIMITES]: Se pedirem uma lista ou um texto longo, escreva COMPLETO, sem se limitar ao \"curto\": o sistema divide em várias mensagens sozinho. NUNCA escreva \"Parte N de M\" nem peça para o usuário mandar um ponto ou um \"continua\" para você seguir. Você não envia DM, não agenda avisos nem guarda nada por conta própria (listas salvas só o sistema faz, quando a pessoa pede «anota na lista X: itens»); não prometa isso (nada de \"te aviso depois\", \"anotei\", \"te mando mais tarde\"). Se a pessoa mandar o conteúdo na própria mensagem (lista, texto), trabalhe com ele agora e entregue o resultado na resposta: não recuse nem prometa guardar. Nunca invente link de download: sem fonte confirmada, diga que não consegue confirmar o link.";
    baseSystemPrompt += channelPersonaBlock(channelSettings);
    // A memória (pessoal ou não) só vai para provedores identificados, nunca para os anônimos.
    let withoutMemory = baseSystemPrompt;
    if (memoryBlock) {
        baseSystemPrompt += memoryBlock;
    }
    // Voz: o bloco [MODO VOZ] é o ÚLTIMO do prompt de sistema (depois do override do canal e da memória, que é texto de terceiros e
    // não pode diluir as regras de fala). Vale para os dois prompts: com e sem memória (provedores anônimos).
    if (voice === true) {
        baseSystemPrompt = applyVoicePersona(baseSystemPrompt);
        withoutMemory = applyVoicePersona(withoutMemory);
    }
    return { withMemory: baseSystemPrompt, withoutMemory };
}

// A pesquisa na web é OFERECIDA ao modelo nesta conversa? Em conversa sensível (DM, canal privado do dono, app) só quando o YUI_PRIVATE_SEARCH libera este usuário;
// senão a ferramenta seria recusada na hora e o modelo prometeria pesquisar (C7). Nunca lança.
// Conversa espontânea (`chatter`: a Yui entrando sozinha no canal) nunca pesquisa nem gasta a cota de quem só falou: a ferramenta nem é oferecida (só com o agente ligado;
// com YUI_RESEARCH_ENABLED=false vale o ramo antigo, que não distinguia). Com o agente desligado o privado também sempre recusa, então a ferramenta não é oferecida lá.
export function searchOfferedFor({ sensitive = false, userId = null, chatter = false } = {}) {
    try {
        const cfg = readResearchConfig();
        if (chatter === true && cfg.enabled) return false;
        if (sensitive !== true) return true;
        return cfg.enabled && privateSearchAllowed(cfg.privateSearch, { isOwner: isOwnerId(userId) });
    } catch (_) { return sensitive !== true; }
}

/**
 * Texto da definição de ferramentas (o formato JSON que os provedores sem ferramentas nativas seguem).
 * @param {Array<object>} activeTools  as ferramentas oferecidas (objetos do mcp_tools.json), já filtradas
 * @param {string[]} disabled          os nomes que NÃO estão disponíveis (os exemplos deles saem)
 */
export function toolsDefinitionText(activeTools, disabled) {
    let toolList = '';
    let exampleList = '';
    let idx = 1;
    for (const t of activeTools) {
        const f = t.function;
        if (!f.textual_triggers) continue;
        toolList += `\n${idx}. **${f.name}**: ${f.description}\n`;
        toolList += `   - ${f.textual_triggers}\n`;
        toolList += `   - Args: ${f.textual_args}\n`;
        idx++;
    }
    const examplesMap = {
        download_audio:  'User: "Baixe pra mim https://youtu.be/..."\nResponse: { "thought": "User quer baixar audio.", "tool": "download_audio", "args": { "url": "https://youtu.be/..." } }',
        download_video:  'User: "Baixa esse vídeo https://www.instagram.com/reel/..."\nResponse: { "thought": "User quer baixar vídeo.", "tool": "download_video", "args": { "url": "https://www.instagram.com/reel/..." } }',
        search_game:     'User: "Arruma o torrent do GTA V"\nResponse: { "thought": "User quer jogo GTA V.", "tool": "search_game", "args": { "game_name": "Grand Theft Auto V" } }',
        search_web:      'User: "Pesquise sobre Hytale"\nResponse: { "thought": "User quer info externa (Web).", "tool": "search_web", "args": { "query": "Hytale game information news" } }\n' + SEARCH_WEB_EXTRA_EXAMPLES,
        show_bot_menu:   'User: "Yui, abra o menu interativo de ajuda por favor"\nResponse: { "thought": "User pediu explicitamente para abrir o menu visual de ajuda.", "tool": "show_bot_menu", "args": { "context": "geral" } }',
        generate_image:  'User: "gera uma imagem de um gato spacial"\nResponse: { "thought": "User quer uma imagem gerada por IA.", "tool": "generate_image", "args": { "prompt": "a space cat floating in galaxy, cinematic, detailed fur, neon lights", "negative_prompt": "nsfw, nude, explicit, gore, violence, blood, adult content, 18+, pornographic, sexual, disturbing, hentai, r18" } }',
        check_steam:     'User: "Elden Ring ta em promo na steam?"\nResponse: { "thought": "User quer saber preço de Elden Ring.", "tool": "check_steam", "args": { "game": "Elden Ring" } }',
        check_game_info: 'User: "qual a nota de Elden Ring?"\nResponse: { "thought": "User quer info geral do jogo.", "tool": "check_game_info", "args": { "game": "Elden Ring" } }\nUser: "quanto tempo pra zerar Baldur\u0027s Gate 3?"\nResponse: { "thought": "User quer tempo de jogo.", "tool": "check_game_info", "args": { "game": "Baldur\u0027s Gate 3" } }',
        check_pc_compatibility: 'User: "meu pc com rtx 3060 e 16gb roda cyberpunk?"\nResponse: { "thought": "User quer saber se roda.", "tool": "check_pc_compatibility", "args": { "game": "Cyberpunk 2077", "gpu": "RTX 3060", "ram": "16 GB" } }\nUser: "requisitos de GTA VI"\nResponse: { "thought": "User quer requisitos do jogo.", "tool": "check_pc_compatibility", "args": { "game": "GTA VI" } }',
        convert_currency:'User: "quanto ta 50 dolares em reais?"\nResponse: { "thought": "User quer converter 50 USD para BRL.", "tool": "convert_currency", "args": { "amount": 50, "from": "USD", "to": "BRL" } }',
        get_current_music:'User: "Yui, baixe a musica do meu status"\nResponse: { "thought": "User quer baixar música tocando no seu status.", "tool": "get_current_music", "args": { "download": true } }\nUser: "oq eu to escutando no status"\nResponse: { "thought": "User quer saber música do seu status.", "tool": "get_current_music", "args": { "download": true } }',
    };
    for (const [name, example] of Object.entries(examplesMap)) {
        if (!disabled.includes(name)) exampleList += `\n${example}\n`;
    }
    // Pesquisa ligada no servidor: a introdução cita a web e a 3ª regra manda chamar search_web NA HORA (nunca "vou pesquisar"). Desligada: nada disso entra.
    const searchOn = !disabled.includes('search_web');
    const introLine = searchOn ? TOOLS_INTRO_LINE : 'Use-as quando o usuário pedir para baixar algo ou buscar um jogo.';
    const searchDecisionLine = searchOn ? `\n${TOOLS_SEARCH_DECISION}` : '';
    return `\n--- FERRAMENTAS DISPONÍVEIS ---\nVocê tem acesso às seguintes ferramentas para executar ações reais.\n${introLine}\n${toolList}\n--- INSTRUÇÃO DE PENSAMENTO E DECISÃO ---\nAntes de responder, ANALISE:\n1. O usuário quer apenas conversar ou uma informação que você já sabe? -> Responda apenas com texto (Sem JSON).\n2. O usuário quer uma AÇÃO ESPECÍFICA (Download, Busca Web)? -> Responda com JSON.${searchDecisionLine}\n\nFORMATO PARA USO DE FERRAMENTA (JSON):\n{\n  "thought": "Pensamento ultra-curto (1 a 3 palavras para economizar tokens, ex: 'baixar audio')",\n  "tool": "nome_da_ferramenta",\n  "args": { ...argumentos... }\n}\n\nEXEMPLOS:${exampleList}\nUser: "Como você está?"\nResponse: Estou bem, e você?\n\n---------------------------------------\n`;
}

/**
 * A definição de ferramentas em versão CURTA, para um modelo pequeno com contexto de 4096 tokens (a rota privada com IA local, core/ai/localPrivada.js): o nome, a primeira frase da
 * descrição e os argumentos de cada ferramenta, mais a regra de quando chamar. O formato da chamada é o MESMO da definição completa (um JSON { thought, tool, args } em texto), então o
 * despachante da fila o lê igual. Só entra a ferramenta que a definição completa também ofereceria.
 * @param {Array<object>} activeTools  as ferramentas oferecidas (objetos do mcp_tools.json), já filtradas
 * @param {string[]} disabled          os nomes que NÃO estão disponíveis
 */
export function toolsCompactText(activeTools, disabled = []) {
    const linhas = [];
    for (const t of activeTools) {
        const f = t?.function;
        if (!f?.name || !f.textual_triggers) continue;
        const frase = String(f.description ?? '').split(/(?<=[.!?])\s/)[0].replace(/\s+/g, ' ').trim().slice(0, 110);
        linhas.push(`- ${f.name}: ${frase} | Args: ${String(f.textual_args ?? '').replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    const searchOn = !disabled.includes('search_web');
    return `\n--- FERRAMENTAS (versão curta) ---\nConversa comum, ou algo que você já sabe: responda só com texto, sem JSON.\nPedido de uma AÇÃO desta lista: responda SOMENTE com o JSON { "thought": "motivo curto", "tool": "nome", "args": { ... } } e nada mais; nunca prometa a ação em texto.\n${searchOn ? 'Pediu para pesquisar na web ou ver novidades: chame search_web na hora.\n' : ''}${linhas.join('\n')}\n`;
}

/** As ferramentas do mcp_tools.json (código versionado, só leitura). [] se não der para ler. */
export function loadMcpTools(file = MCP_TOOLS_FILE) {
    try {
        const list = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(list) ? list : [];
    } catch (_) {
        return [];
    }
}

/**
 * A definição de ferramentas a partir dos NOMES que o bot diz estarem ligados no servidor (configuração dele: interruptores do
 * /yui-ferramentas, AutoMod, lista de exceções) e das regras do CÉREBRO para a oferta da pesquisa (conversa privada, espontânea).
 * Mesma saída do buildToolsDefinition do bot para a mesma situação (conferido no teste).
 * @param {{ allTools: object[], active: string[], disabled: string[], offerSearch: boolean }} p
 */
export function toolsDefinitionFromNames({ allTools, active, disabled, offerSearch, compact = false }) {
    const activeSet = new Set(active);
    const off = offerSearch ? [...disabled] : [...disabled, 'search_web'];
    const list = allTools.filter((t) => activeSet.has(t?.function?.name) && !off.includes(t.function.name));
    return compact === true ? toolsCompactText(list, off) : toolsDefinitionText(list, off);
}
