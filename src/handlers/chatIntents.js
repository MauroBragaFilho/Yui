// Funções de baixo risco acionadas por conversa (e não só por comando), decididas pelo CÓDIGO como a Porta I (imagem):
//   Porta N (memória própria): "o que você sabe de mim?", "esquece a lembrança #3", "esquece que eu gosto de X", "apaga tudo que sabe de mim" (com confirmação).
//   Porta R (resumo do chat):  "yui resume as últimas 50 mensagens", "faz um resumo da conversa".
// Módulo puro: sem Discord, sem rede, sem ler o .env no import. As dependências (memória, contexto) entram por parâmetro, para testar offline.
//
// Regras (docs/content_pt/CONVERSA_E_COMANDOS.md): só pedido DIRETO à Yui, em texto (nada de voz, rádio, anexo, log de terceiros nem ferramentas desligadas);
// pergunta sobre capacidade ("você consegue apagar...?"), negação e link não disparam; apagar TUDO exige confirmação em até 2 minutos;
// em canal público a lista de lembranças NÃO é exibida (só a contagem): o conteúdo só aparece na DM ou no comando efêmero.

export const CHAT_INTENT_MAX_CHARS = 300;
const PENDING_MS = 2 * 60 * 1000;
const SUMMARY_COOLDOWN_MS = 60 * 1000;
export const SUMMARY_DEFAULT = 20;
export const SUMMARY_MIN = 5;
export const SUMMARY_MAX = 100;

function fold(text) {
    return String(text ?? '').normalize('NFC').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Remove menção, o nome da Yui e vocativos do começo ("ei yui,", "@yui") e "por favor" do fim. */
function stripAddressing(text) {
    let t = String(text ?? '').replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/^(?:e a[ií]|ei|oi|ol[aá]|opa|fala|salve)[\s,!.]+/i, '');
    t = t.replace(/^@?yui\b[\s,:!.-]*/i, '');
    t = t.replace(/^(?:por favor|pf|pfv|pls|please)[\s,:!.-]*/i, '');
    t = t.replace(/[\s,.!?]*\b(?:por favor|pf|pfv|pls|please)\b[\s,.!?]*$/i, '').trim();
    return t;
}

/** Porta de entrada comum: devolve o texto limpo ou '' quando o contexto nunca deve disparar. */
function gate(text, ctx = {}) {
    const { voice = false, direct = false, radioMode = false, disableTools = false, thirdPartyPrompt = false, hasAttachment = false } = ctx;
    if (typeof text !== 'string' || !text.trim()) return '';
    if (voice || radioMode || disableTools || thirdPartyPrompt || hasAttachment || !direct) return '';
    if (/\n[\s\S]*\n[\s\S]*\n/.test(text)) return '';
    const clean = stripAddressing(text);
    if (!clean || clean.length > CHAT_INTENT_MAX_CHARS) return '';
    if (/https?:\/\//i.test(clean)) return '';
    return clean;
}

// Pergunta de capacidade/ajuda e negação: nunca é ordem.
const NOT_AN_ORDER_RE = /\b(?:nao|nunca|como|consegue|sera que|por ?que|quando|onde|quanto tempo|da pra|ser capaz)\b/i;

// ── Porta N: memória ────────────────────────────────────────────────────────────────────────────────────────────
const VIEW_RES = [
    /\bo que (?:voce |vc |tu )?(?:sabe|lembra|guardou|tem guardado|anotou)\b[^.!?\n]{0,30}\b(?:de|sobre|a respeito de)\s+mim\b/i,
    /\b(?:mostra|mostre|ver|veja|lista|liste|me (?:mostra|mostre|fala|diz|lista))\b[^.!?\n]{0,25}\b(?:minhas? (?:memorias?|lembrancas?)|minha memoria)\b/i,
    /\bquais (?:sao )?(?:as )?minhas (?:memorias|lembrancas)\b/i
];
const FORGET_ID_RE = /\b(?:esquece|esqueca|apaga|apague|remove|remova|tira|tire|deleta|delete|exclui|exclua)\b[^.!?\n]{0,25}?\b(?:lembranca|memoria)\s*(?:numero\s*|no\s*|#)?(\d{1,7})\b/i;
const FORGET_ALL_RES = [
    /\b(?:apaga|apague|esquece|esqueca|limpa|limpe|deleta|delete|exclui|exclua|zera|zere)\b[^.!?\n]{0,20}?\b(?:tudo|toda|todas|todos)\b[^.!?\n]{0,30}?\b(?:sobre mim|de mim|minha memoria|minhas (?:memorias|lembrancas)|que (?:voce )?(?:sabe|lembra|guardou)|que tem (?:de mim|guardado))\b/i,
    /\b(?:apaga|apague|limpa|limpe|zera|zere|deleta|delete)\b\s+(?:toda\s+)?(?:a\s+)?minha\s+memoria\b/i
];
const FORGET_TEXT_RE = /^(?:esquece|esqueca)\s+que\s+(.{4,200})$/i;
const CONFIRM_RE = /^(?:sim|confirmo|confirma|pode|pode sim|pode apagar|apaga|apague|isso|isso mesmo|tenho certeza|quero)(?:[\s,.!]+(?:apagar|apaga|tudo|apagar tudo|sim|confirmo|pode))*[\s.!]*$/i;
const CANCEL_RE = /^(?:nao|cancela|cancelar|cancele|deixa|deixa pra la|melhor nao|esquece|espera|para)\b/i;
const FILLER = new Set(['quando', 'sobre', 'esse', 'essa', 'isso', 'aquilo', 'falei', 'disse', 'tinha', 'para', 'pelo', 'pela', 'voce', 'mais', 'muito']);

/** Palavras (4+ letras, sem acento) do trecho que a pessoa quer esquecer. */
export function forgetTokens(text) {
    return [...new Set(fold(text).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !FILLER.has(w)))];
}

/**
 * Pedido de memória por conversa.
 * @param {string} text
 * @param {object} ctx  direct/voice/radioMode/... e `pendingForgetAll` (há um "apagar tudo" aguardando confirmação desta pessoa)
 * @returns {{kind:'none'|'view'|'forget_id'|'forget_text'|'forget_all'|'confirm_forget_all'|'cancel_forget_all', id?:number, tokens?:string[], reason:string}}
 */
export function detectMemoryIntent(text, ctx = {}) {
    const clean = gate(text, ctx);
    if (!clean) return { kind: 'none', reason: 'contexto ou texto não serve' };
    const folded = fold(clean);
    const bare = folded.replace(/^[\s,.!?]+|[\s,.!?]+$/g, '');
    if (ctx.pendingForgetAll) {
        if (CONFIRM_RE.test(bare)) return { kind: 'confirm_forget_all', reason: 'confirmação' };
        if (CANCEL_RE.test(bare)) return { kind: 'cancel_forget_all', reason: 'cancelou' };
        return { kind: 'none', reason: 'outra conversa' }; // a confirmação pendente expira ao falar de outra coisa
    }
    if (NOT_AN_ORDER_RE.test(folded)) return { kind: 'none', reason: 'pergunta, negação ou como-fazer' };
    if (FORGET_ALL_RES.some(re => re.test(folded))) return { kind: 'forget_all', reason: 'apagar tudo' };
    const byId = folded.match(FORGET_ID_RE);
    if (byId) return { kind: 'forget_id', id: Number.parseInt(byId[1], 10), reason: 'por número' };
    if (VIEW_RES.some(re => re.test(folded))) return { kind: 'view', reason: 'ver a memória' };
    const byText = bare.match(FORGET_TEXT_RE);
    if (byText) {
        const tokens = forgetTokens(byText[1]);
        if (tokens.length > 0) return { kind: 'forget_text', tokens, reason: 'por texto' };
    }
    return { kind: 'none', reason: 'não é pedido de memória' };
}

// Confirmação pendente de "apagar tudo" (em RAM; some ao reiniciar, de propósito).
const pending = new Map(); // userId -> expiresAt
export function setForgetAllPending(userId, now = Date.now()) { pending.set(String(userId), now + PENDING_MS); }
export function hasForgetAllPending(userId, now = Date.now()) {
    const until = pending.get(String(userId));
    if (!until) return false;
    if (now > until) { pending.delete(String(userId)); return false; }
    return true;
}
export function clearForgetAllPending(userId) { pending.delete(String(userId)); }

const HISTORY_NOTE = '\n-# O registro de uso do bot (historico.txt) não é apagado por este pedido.';
const LIST_BUDGET = 1800;
const LINE_MAX = 180;

function listLines(rows) {
    const lines = [];
    let used = 0;
    for (const r of rows) {
        const line = `**#${r.id}** · \`${r.type}\` — ${String(r.content).replace(/\s+/g, ' ').trim().slice(0, LINE_MAX)}`;
        if (used + line.length + 1 > LIST_BUDGET) break;
        lines.push(line);
        used += line.length + 1;
    }
    const hidden = rows.length - lines.length;
    return hidden > 0 ? `${lines.join('\n')}\n(+${hidden} lembrança(s) não exibida(s))` : lines.join('\n');
}

/**
 * Executa o pedido de memória. Nunca lança. `handled:false` => segue para o modelo (ex.: "esquece que ..." sem nenhuma lembrança parecida).
 * @param {object} intent  retorno de detectMemoryIntent
 * @param {object} deps    { userId, isDM, enabled, scopeLabel, memoryCtx, memory:{listMemories,forget,forgetAll}, wipeContext?, audit?, now? }
 */
export async function runMemoryIntent(intent, deps) {
    const { userId, isDM = false, enabled = false, scopeLabel = '', memoryCtx, memory, wipeContext, audit, now = Date.now() } = deps;
    try {
        if (intent.kind === 'cancel_forget_all') {
            clearForgetAllPending(userId);
            return { handled: true, text: 'Tudo bem, não apaguei nada. 🙂' };
        }
        if (intent.kind === 'confirm_forget_all') {
            clearForgetAllPending(userId);
            const n = enabled ? memory.forgetAll(memoryCtx) : 0;
            const removedContext = typeof wipeContext === 'function' ? await wipeContext(userId) : 0;
            try { audit?.('memory.forgetAll.chat', { userId, platform: 'discord' }, { memories: n, contextTurns: removedContext }); } catch (_) { /* auditoria nunca derruba */ }
            if (!enabled && removedContext === 0) return { handled: true, text: '🧠 O sistema de memória da Yui está desativado no momento.' };
            const extra = removedContext > 0 ? ` e ${removedContext} fala(s) do contexto das conversas recentes` : '';
            return { handled: true, text: `🗑️ Apaguei ${n} lembrança(s) da sua memória${extra}.${HISTORY_NOTE}` };
        }
        if (!enabled) return { handled: true, text: '🧠 O sistema de memória da Yui está desativado no momento.' };

        if (intent.kind === 'forget_all') {
            setForgetAllPending(userId, now);
            return { handled: true, text: '⚠️ Isso apaga **toda** a sua memória comigo (e as falas recentes guardadas como contexto), e não dá para desfazer.\nPara confirmar, responda **sim, apagar tudo** em até 2 minutos. Para desistir, é só dizer **não**.' };
        }
        if (intent.kind === 'view') {
            const rows = memory.listMemories(memoryCtx, { limit: 25 });
            if (!rows.length) return { handled: true, text: 'Ainda não guardei nada sobre você. Diga algo como “lembra que eu gosto de Sultan RS” e eu anoto.' };
            if (!isDM) {
                return { handled: true, text: `Tenho ${rows.length} lembrança(s) sobre você. Aqui o canal é público, então não mostro o conteúdo: me chama no privado ou usa \`/yui-memoria ver\` (só você vê).` };
            }
            return { handled: true, text: `🧠 **O que eu lembro sobre você**\n${listLines(rows)}\n\n-# ${scopeLabel}\n-# Para apagar uma: “esquece a lembrança #número”. Para apagar tudo: “apaga tudo que você sabe de mim”.` };
        }
        if (intent.kind === 'forget_id') {
            const ok = memory.forget(memoryCtx, intent.id);
            return { handled: true, text: ok ? `🗑️ Lembrança #${intent.id} apagada.` : `Não encontrei a lembrança #${intent.id} na sua memória.` };
        }
        if (intent.kind === 'forget_text') {
            const rows = memory.listMemories(memoryCtx, { limit: 200 });
            const hits = rows.filter(r => { const c = fold(r.content).toLowerCase(); return intent.tokens.every(t => c.includes(t)); });
            if (hits.length === 0) return { handled: false, text: '' }; // pode ser só uma frase solta ("esquece que eu falei isso"): segue para o modelo
            if (hits.length === 1) {
                const ok = memory.forget(memoryCtx, hits[0].id);
                return { handled: true, text: ok ? '🗑️ Pronto, esqueci essa lembrança.' : 'Não consegui apagar essa lembrança agora.' };
            }
            if (!isDM) return { handled: true, text: `Achei ${hits.length} lembranças parecidas. Diga qual com “esquece a lembrança #número” (os números estão em \`/yui-memoria ver\`).` };
            return { handled: true, text: `Achei ${hits.length} lembranças parecidas. Diga qual: “esquece a lembrança #número”.\n${listLines(hits.slice(0, 10))}` };
        }
        return { handled: false, text: '' };
    } catch (_) {
        return { handled: true, text: 'Não consegui mexer na sua memória agora. Tenta de novo daqui a pouco.' };
    }
}

// ── Porta R: resumo do chat ─────────────────────────────────────────────────────────────────────────────────────
const SUMMARY_VERB_RE = /\b(?:resume|resuma|resumir|resumo)\b/i;
const SUMMARY_TARGET_RE = /\b(?:conversa|chat|canal|mensagem|mensagens|papo|discussao)\b/i;
const WHAT_HAPPENED_RE = /\bo que (?:rolou|aconteceu|foi falado|falaram)\b[^.!?\n]{0,25}\b(?:aqui|no chat|no canal|na conversa)\b/i;

/** Pedido de resumo do canal por conversa. `amount` fica entre SUMMARY_MIN e SUMMARY_MAX (padrão 20, como o /chat_resumo). */
export function detectSummaryRequest(text, ctx = {}) {
    const clean = gate(text, ctx);
    if (!clean) return { explicit: false, reason: 'contexto ou texto não serve' };
    const folded = fold(clean);
    if (NOT_AN_ORDER_RE.test(folded)) return { explicit: false, reason: 'pergunta ou negação' };
    const asks = (SUMMARY_VERB_RE.test(folded) && SUMMARY_TARGET_RE.test(folded)) || WHAT_HAPPENED_RE.test(folded);
    if (!asks) return { explicit: false, reason: 'não pede resumo do chat' };
    const m = folded.match(/\b(\d{1,3})\s*(?:ultimas?\s*)?(?:mensagem|mensagens)\b/) || folded.match(/\bultimas?\s*(\d{1,3})\b/);
    const n = m ? Number.parseInt(m[1], 10) : SUMMARY_DEFAULT;
    return { explicit: true, amount: Math.max(SUMMARY_MIN, Math.min(SUMMARY_MAX, n)), reason: 'resumo do chat' };
}

const summaryHits = new Map(); // userId -> último pedido
/** 1 resumo por pessoa por minuto (cada um custa uma chamada de IA); o dono não tem limite. */
export function takeSummaryQuota(userId, { isOwner = false, now = Date.now() } = {}) {
    if (isOwner) return { ok: true };
    const key = String(userId ?? 'anon');
    const last = summaryHits.get(key);
    if (last !== undefined && now - last < SUMMARY_COOLDOWN_MS) return { ok: false, retryAfterMs: SUMMARY_COOLDOWN_MS - (now - last) };
    summaryHits.set(key, now);
    if (summaryHits.size > 5000) { for (const [k, v] of summaryHits) if (now - v > SUMMARY_COOLDOWN_MS) summaryHits.delete(k); }
    return { ok: true };
}

/**
 * Tira do log o que não é conversa: o próprio pedido de resumo (a última fala de quem pediu) e os "Processando..." da Yui.
 * @param {Array} messagesAsc mensagens em ordem cronológica
 */
export function pickMessagesToSummarize(messagesAsc, { requesterId, amount = SUMMARY_DEFAULT } = {}) {
    const list = (Array.isArray(messagesAsc) ? messagesAsc : []).filter(m => m && !(m.author?.bot && /processando/i.test(String(m.content ?? ''))));
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (String(m.author?.id) === String(requesterId)) {
            const f = fold(m.content);
            if (/\bresum|o que (?:rolou|aconteceu|foi falado|falaram)\b/i.test(f)) list.splice(i, 1);
            break;
        }
    }
    return list.slice(-amount);
}

export function __resetChatIntentsForTests() { pending.clear(); summaryHits.clear(); }

// ── Porta G: GTA Online sob demanda (diário, semanal, notícias) ──────────────────────────────────────────────────
// Permite consultar os resets e novidades diretamente pela conversa ("o que tem no gta hoje?", "semanal do gta", "noticias do gta").
const GTA_CONTEXT_RE = /\b(?:gta|gtao|gta online|rockstar|newswire)\b/i;
const GTA_DAILY_RE = /\b(?:diario|hoje|gun van|carrinha de armamento|dealer|dealers|naufragio|reset de hoje|reset diario)\b/i;
const GTA_WEEKLY_RE = /\b(?:semanal|semana|descontos?|bonus|veiculo do podio|carro do podio|premio do evento|evento semanal|reset semanal)\b/i;
const GTA_NEWS_RE = /\b(?:noticia|noticias|novidade|novidades|artigo|artigos|newswire)\b/i;

/**
 * Detecta pedido sob demanda de GTA Online por conversa.
 * @param {string} text
 * @param {object} ctx
 * @returns {{kind:'none'|'daily'|'weekly'|'news', reason:string}}
 */
export function detectGtaIntent(text, ctx = {}) {
    const clean = gate(text, ctx);
    if (!clean) return { kind: 'none', reason: 'contexto ou texto não serve' };
    const folded = fold(clean);
    const GTA_NOT_ORDER = /\b(?:nao|nunca|como voce|consegue|sera que|por ?que|da pra|ser capaz)\b/i;
    if (GTA_NOT_ORDER.test(folded)) return { kind: 'none', reason: 'pergunta de capacidade ou negacao' };

    // Deve ter menção explícita a GTA/Rockstar/Newswire ou termos inconfundíveis como gun van
    const hasGtaMention = GTA_CONTEXT_RE.test(folded) || /\bgun van\b/i.test(folded);
    if (!hasGtaMention) return { kind: 'none', reason: 'sem contexto de gta' };

    // Classificação por especificidade
    if (GTA_DAILY_RE.test(folded)) {
        return { kind: 'daily', reason: 'reset diario do gta' };
    }
    if (GTA_WEEKLY_RE.test(folded)) {
        return { kind: 'weekly', reason: 'evento semanal do gta' };
    }
    if (GTA_NEWS_RE.test(folded)) {
        return { kind: 'news', reason: 'noticias da rockstar' };
    }

    // Se falou apenas "gta hoje" ou "gta agora"
    if (/\b(?:hoje|agora)\b/i.test(folded)) {
        return { kind: 'daily', reason: 'gta hoje' };
    }

    return { kind: 'none', reason: 'termo generico de gta' };
}


// ── Porta M: Modo Rádio por conversa ─────────────────────────────────────────────────────────────
// Permite ligar, pausar, passar música, ver o que está tocando e parar a rádio diretamente pelo chat.
const RADIO_KEYWORD_RE = /\b(?:radio|musica|som|playlist|toca|tocar|pausa|pausar|pula|skip|proxima musica)\b/i;

/**
 * Detecta intenção de controle de rádio por conversa.
 * @param {string} text
 * @param {object} ctx
 * @returns {{kind:'none'|'play'|'pause'|'resume'|'stop'|'next'|'info', query?:string, reason:string}}
 */
export function detectRadioIntent(text, ctx = {}) {
    const clean = gate(text, { ...ctx, radioMode: false });
    if (!clean) return { kind: 'none', reason: 'contexto ou texto nao serve' };
    const folded = fold(clean);
    const RADIO_NOT_ORDER = /\b(?:nao|nunca|como voce|consegue|sera que|por ?que|da pra|ser capaz|gosto de|lembra que)\b/i;
    if (RADIO_NOT_ORDER.test(folded)) return { kind: 'none', reason: 'pergunta de capacidade ou negacao' };

    if (/\b(?:pausa|pausar|pause|silencio|espera um pouco)\b/i.test(folded)) {
        return { kind: 'pause', reason: 'pausar radio' };
    }
    if (/\b(?:despausa|despausar|retoma|retomar|continua|continue)\b/i.test(folded)) {
        return { kind: 'resume', reason: 'retomar radio' };
    }
    if (/\b(?:para o radio|parar o radio|para a radio|desliga o radio|desliga a musica|para a musica|parar a musica|desconecta|sai da call)\b/i.test(folded)) {
        return { kind: 'stop', reason: 'parar radio' };
    }
    if (/\b(?:proxima musica|passa a musica|passa essa musica|passa essa|pula essa|troca de musica|pula musica|skip)\b/i.test(folded)) {
        return { kind: 'next', reason: 'proxima musica' };
    }
    if (/\b(?:que musica e essa|qual musica ta tocando|o que ta tocando|nome da musica)\b/i.test(folded)) {
        return { kind: 'info', reason: 'info da musica atual' };
    }
    const playMatch = folded.match(/\b(?:toca|tocar|bota|botar|coloca|colocar|solta|soltar)\s+(?:a\s+musica\s+|o\s+som\s+|musica\s+|radio\s+)?(.{2,100})$/i);
    if (playMatch && playMatch[1]) {
        const query = playMatch[1].trim();
        if (!/^(?:uma imagem|um desenho|foto)\b/i.test(query)) {
            return { kind: 'play', query, reason: 'tocar musica' };
        }
    }
    return { kind: 'none', reason: 'sem intencao de radio clara' };
}