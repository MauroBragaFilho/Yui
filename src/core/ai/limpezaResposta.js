// Limpeza da resposta da IA (etapa 6): tirar o raciocínio (<think>...</think>, <ctrlN>, "Thought: ... Response: ..."), a chamada de
// ferramenta escrita como texto (tool_code, default_api.x(...), print(...)) e os embrulhos JSON ({"response": "..."}, generate_reply).
// MOVIDO do handlers/llmHandler.js SEM mudança no comportamento (o llmHandler importa daqui e passa quem conhece os nomes das ferramentas
// carregadas no bot): o cérebro precisa da MESMA limpeza para o /yui e a síntese da pesquisa, que agora rodam nele. Uma fonte só.
// Puro: não importa o bot nem o discord.js (tests/test-core-import-graph.js).
import { loadMcpTools } from './promptConversa.js';

// Nomes de ferramenta que o modelo pode "vazar" como texto. Só estes (ou um marcador explícito tool_code/default_api.)
// são apagados da resposta: "Mod(1.20)" e "Ovos(12 unidades)" são texto normal.
export const EXTRA_TOOL_NAMES = new Set([
    'generate_reply', 'gerar_resposta', 'default_api', 'get_help', 'search_and_download_music', 'get_current_music',
    'check_game_info', 'check_pc_compatibility', 'search_game', 'search_web', 'download_audio', 'download_video',
    'generate_image', 'check_steam', 'convert_currency', 'show_bot_menu', 'ia_automod', 'join_voice_call', 'leave_voice_call'
]);
let mcpNames = null;
/** Nome de ferramenta conhecido: os extras acima, as do rádio e as do mcp_tools.json (lido uma vez). O bot passa a função dele (as já carregadas). */
export function isKnownToolNameDefault(name) {
    const n = String(name ?? '');
    if (!n) return false;
    if (EXTRA_TOOL_NAMES.has(n.toLowerCase()) || /^radio_/i.test(n)) return true;
    if (!mcpNames) mcpNames = new Set(loadMcpTools().map((t) => t?.function?.name).filter(Boolean));
    return mcpNames.has(n);
}
// Tira os blocos <think>...</think> (e um <think> sem fechamento, até o fim do texto) numa passagem só. O par de expressões antigo varria o texto inteiro a
// partir de CADA "<think>": uma saída degenerada de 100 mil caracteres com "<think>" repetido custava mais de 1 s e parava o laço de eventos (resíduo F1).
// Mesmo resultado de antes: um bloco vai da PRIMEIRA abertura pendente até o primeiro "</think>" depois dela; "</think>" sem abertura fica como está.
export function removeThinkBlocks(text, { onStrippedBlock } = {}) {
    const tag = /<(\/?)think>/gi;
    let out = '';
    let last = 0;
    let openAt = -1;
    let m;
    while ((m = tag.exec(text)) !== null) {
        if (m[1] === '') {
            if (openAt === -1) openAt = m.index;
        } else if (openAt !== -1) {
            out += text.slice(last, openAt);
            if (typeof onStrippedBlock === 'function') {
                onStrippedBlock(text.slice(openAt + m[0].length, m.index));
            }
            last = m.index + m[0].length;
            openAt = -1;
        }
    }
    if (openAt !== -1) {
        out += text.slice(last, openAt);
        if (typeof onStrippedBlock === 'function') {
            onStrippedBlock(text.slice(openAt + 7));
        }
        last = text.length;
    }
    return out + text.slice(last);
}
export function extractThinkingFallback(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const innerBlocks = [];
    removeThinkBlocks(raw, { onStrippedBlock: (b) => innerBlocks.push(b) });
    for (const block of innerBlocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        const respMatch = trimmed.match(/[\(\[\*]*\s*(?:response|reply|resposta|fala|yui|output|text|speech)\s*[\*\)\]]*\s*:\s*([\s\S]+)$/i);
        if (respMatch) {
            const cleanResp = respMatch[1].replace(/^[\(\[\*]*\s*(?:fala|resposta|yui|speech)\s*[\*\)\]]*\s*:\s*/i, '').trim();
            if (cleanResp) return cleanResp;
        }
    }
    for (let i = innerBlocks.length - 1; i >= 0; i--) {
        const trimmed = innerBlocks[i].trim();
        if (trimmed.length > 5 && !/^(?:pensando|thinking|thought)\b/i.test(trimmed)) {
            return trimmed;
        }
    }
    return innerBlocks.join(' ').trim();
}
// A heurística "Thought: ... Response: ..." (expressões sem âncora) só vale para respostas curtas: numa saída degenerada de dezenas de milhares de caracteres
// ("thought: (((((...") ela custava vários segundos. Um texto maior que isto segue sem essa limpeza.
export const THINK_LABEL_SCAN_MAX = 12000;
export function stripThinking(text, { isKnownToolName = isKnownToolNameDefault } = {}) {
    if (!text) return text;
    const isToolCallText = (fullMatch, name) => isKnownToolName(name) || /tool_code|default_api\./i.test(String(fullMatch ?? ''));
    text = removeThinkBlocks(text);
    text = text.replace(/<ctrl\d+>[\s\S]*?(?=\n\n|$)/gi, '');
    text = text.replace(/<ctrl\d+>/gi, '');
    const jsonResponseKeys = ['response', 'reply', 'content', 'answer', 'text', 'resposta', 'mensagem', 'message'];
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed.generate_reply) {
                if (typeof parsed.generate_reply === 'string') return parsed.generate_reply.trim();
                if (typeof parsed.generate_reply === 'object' && parsed.generate_reply.content) return parsed.generate_reply.content.trim();
            }
            if (parsed.tool === 'generate_reply' || parsed.name === 'generate_reply' || parsed.action === 'generate_reply') {
                const c = parsed.args?.content || parsed.args?.text || parsed.arguments?.content || parsed.action_input?.content || parsed.content || parsed.text;
                if (c && typeof c === 'string') return c.trim();
            }
            if (!parsed.tool && !parsed.thought) {
                for (const key of jsonResponseKeys) {
                    if (parsed[key] && typeof parsed[key] === 'string') {
                        return parsed[key].trim();
                    }
                }
            }
        } catch (e) {}
    }
    let cleanVal = text.trim();
    const genReplyRegex = /(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?\(?(?:default_api\.)?(?:generate_reply|gerar_resposta|gerar\s+resposta)(?:\(|\s+)+(?:content=)?(['"]{1,3})([\s\S]*?)\1\)?\)?(?:[\s\n]*```)?/i;
    const matchGenReply = cleanVal.match(genReplyRegex);
    if (matchGenReply) {
        return matchGenReply[2].trim();
    }
    const prefixRegex = /^(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?\(?(?:default_api\.)?(?:generate_reply|gerar_resposta|gerar\s+resposta)(?:\(|\s+)+(?:content=)?(['"]{1,3})/i;
    const prefixMatch = cleanVal.match(prefixRegex);
    if (prefixMatch) {
        const quoteChar = prefixMatch[1];
        cleanVal = cleanVal.replace(prefixRegex, '');
        const escapedQuote = quoteChar.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const suffixRegex = new RegExp(escapedQuote + '\\)?\\)?(?:\\s*```)?$', 'i');
        cleanVal = cleanVal.replace(suffixRegex, '');
        return cleanVal.trim();
    }
    // O nome da ferramenta tem no máximo 64 caracteres (\w{1,64}, não \w+): com \w+ uma resposta de UMA palavra só e longa (loop degenerado
    // "aaaa...") custava O(n²) e parava o laço de eventos (100 mil caracteres = 5 s). Nenhuma ferramenta tem nome com mais de 64.
    const toolCodeGeneric = text.match(/^(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?\(?(?:default_api\.)?(\w{1,64})\(([^]*?)\)\)?(?:[\s\n]*```)?$/i);
    if (toolCodeGeneric && isToolCallText(toolCodeGeneric[0], toolCodeGeneric[1])) {
        return '';
    }
    // O padrão exige um ")" depois de cada "nome(": sem nenhum, não há o que apagar. Cada candidato varre até o primeiro ")" seguinte, então só o trecho até o
    // ÚLTIMO ")" (mais a cerca de código que pode fechá-lo) é examinado: ")" seguido de "a(" repetido (100 mil caracteres) custava 1,9 s, porque cada "a("
    // percorria o texto inteiro atrás de um ")" que não existia. Daí em diante a varredura é linear.
    const lastParen = text.lastIndexOf(')');
    if (lastParen !== -1) {
        const scanEnd = Math.min(text.length, lastParen + 1 + 16);
        text = text.slice(0, scanEnd).replace(/(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?\(?(?:default_api\.)?(\w{1,64})\([^]*?\)\)?(?:[\s\n]*```)?/gi, (full, name) => (isToolCallText(full, name) ? '' : full)) + text.slice(scanEnd);
    }
    const mcpToolNames = ['search_game', 'search_web', 'generate_reply', 'download_audio', 'download_video', 'generate_image', 'check_steam', 'convert_currency', 'show_bot_menu', 'ia_automod', 'join_voice_call', 'leave_voice_call', 'default_api'];
    const toolMentionRegex = new RegExp('(?:`?' + mcpToolNames.join('`?|`?') + '`?)', 'i');
    const thinkingIndicators = /(?:usar a ferramenta|chamar a ferramenta|a resposta deve ser|a ferramenta mais adequada|o melhor seria usar|preciso (?:saber|analisar|verificar)|vou (?:usar|chamar)|devo (?:usar|chamar))\b/i;
    if (toolMentionRegex.test(text) && thinkingIndicators.test(text)) {
        console.log('[StripThinking] Detectado vazamento de raciocínio MCP no texto.');
        const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
        if (paragraphs.length > 1) {
            const cleanParagraphs = [];
            for (let i = paragraphs.length - 1; i >= 0; i--) {
                const p = paragraphs[i];
                const hasToolRef = toolMentionRegex.test(p) && thinkingIndicators.test(p);
                if (!hasToolRef) {
                    cleanParagraphs.unshift(p);
                } else {
                    break;
                }
            }
            if (cleanParagraphs.length > 0) {
                const result = cleanParagraphs.join('\n\n').trim();
                console.log(`[StripThinking] Extraído ${cleanParagraphs.length} parágrafos limpos de ${paragraphs.length} total.`);
                return result;
            }
        }
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!toolMentionRegex.test(lines[i]) && !thinkingIndicators.test(lines[i]) && lines[i].length > 10) {
                console.log('[StripThinking] Extraída última linha limpa como resposta.');
                return lines[i];
            }
        }
        console.warn('[StripThinking] Não foi possível isolar raciocínio MCP. Mantendo resposta original.');
    }
    let clean = text.trim();
    if (clean.length <= THINK_LABEL_SCAN_MAX && /^[\(\[\*]*\s*(?:thought|thinking|pensamento|pensamentos|thinking\s+process|racioc[íi]nio|plan|planejamento)s?[\*\)\]]*\s*:?/i.test(clean)) {
        const labelMatch = clean.match(/[\(\[\*]*\s*(?:response|reply|resposta|fala|yui|output|text|speech|final\s+speech)\s*[\*\)\]]*\s*:\s*([\s\S]+)$/i);
        if (labelMatch) {
            clean = labelMatch[1].replace(/^[\(\[\*]*\s*(?:fala|resposta|yui|speech)\s*[\*\)\]]*\s*:\s*/i, '').trim();
        } else {
            const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length > 1) {
                let lastLine = lines[lines.length - 1];
                lastLine = lastLine.replace(/^(?:looks good|lgtm|perfect|done|all set)[\.!\s]*/i, '');
                lastLine = lastLine.replace(/^(?:let's go with|going with|using)\s+[^.]+[\.!\s]*/i, '');
                const concatMatch = lastLine.match(/^(?:i'll|i will|i should|i need to|let's|so i'll|therefore|i must)\s+[\s\S]+?[\.!\?]\s*([A-Z\u00C0-\u00DC\d].*)$/i);
                if (concatMatch) {
                    clean = concatMatch[1].trim();
                } else {
                    clean = lastLine.replace(/^[\(\[\*]*\s*(?:fala|resposta|yui|speech)\s*[\*\)\]]*\s*:\s*/i, '').trim();
                }
            }
        }
    }
    clean = clean.replace(/^[\(\[\*]*\s*(?:gerar\s*resposta|gerar_resposta|resposta|fala|yui|output|text|speech)\s*[\*\)\]]*\s*:\s*/i, '').trim();
    const quotedMatch = clean.match(/^(['"]{1,3})([\s\S]+?)\1/);
    if (quotedMatch) {
        clean = quotedMatch[2].trim();
    }
    return clean;
}

// ── Respostas de sistema (movidas do llmHandler na etapa 6, com o mesmo texto) ─────────────────────────────────────────────────────────
// Nenhuma resposta aproveitável (o modelo só "pensou" ou repetiu lixo). Contém "erro ao processar seu pedido" para o isSystemReply tratá-la como resposta de sistema.
export const EMPTY_REPLY_TEXT = '⚠️ Tive um erro ao processar seu pedido: a IA respondeu algo vazio. Tenta de novo ou reformula a pergunta.';
const SYSTEM_REPLY_MARKER = /SYSTEM ERROR|Limites de Processamento|erro ao processar seu pedido|🔒 Rota privada de IA/i;
/**
 * "Isto é uma resposta de erro/aviso do SISTEMA", nunca um comentário da Yui (TG-16/C13): "Limites de Processamento Atingidos", o aviso de
 * pedido grande demais, "SYSTEM ERROR", "erro ao processar seu pedido". Um comentário que começa com emoji ("⚡ Que preço bom!") NÃO é.
 */
export function isSystemReply(text) {
    return SYSTEM_REPLY_MARKER.test(String(text ?? ''));
}

/**
 * O acabamento que o generateResponse (e o passo do cérebro, no bot) sempre fez numa resposta SEM ferramentas: tira o raciocínio; se só sobrou
 * raciocínio, resgata a fala de dentro dele; nada aproveitável vira EMPTY_REPLY_TEXT. Usado pelo cérebro no /yui e na pesquisa antiga.
 */
export function acabamentoSemFerramentas(text, { isKnownToolName = isKnownToolNameDefault } = {}) {
    const raw = String(text ?? '');
    let stripped = stripThinking(raw, { isKnownToolName });
    if (!stripped && raw) {
        const recovered = extractThinkingFallback(raw);
        if (recovered && /[\p{L}\p{N}]/u.test(recovered.replace(/<\/?think>/gi, ''))) stripped = recovered;
    }
    return String(stripped ?? '').trim() || EMPTY_REPLY_TEXT;
}
