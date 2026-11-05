// Pedido de imagem por conversa ("yui gera uma imagem de um gato"), decidido pelo CÓDIGO (Porta I), sem depender de o modelo
// lembrar de chamar a ferramenta generate_image. Módulo puro: sem Discord, sem rede, sem ler o .env no import.
//
// Regras de segurança (testadas em tests/test-image-intent.js):
//  - só pedido DIRETO à Yui, em texto (nada de voz, rádio, log de terceiros nem ferramentas desligadas);
//  - pedido curto e afirmativo: pergunta sobre a capacidade ("você consegue gerar imagem?"), negação ou pedido com link não disparam;
//  - o texto da pessoa é DADO: a extração só recorta o assunto, nunca interpreta ordens dentro dele;
//  - o filtro de conteúdo impróprio continua sendo o do despachante (llmHandler), que vê o prompt final;
//  - limite de imagens por pessoa por hora (o dono não tem limite), valendo também para a ferramenta chamada pelo modelo.

export const IMAGE_REQUEST_MAX_CHARS = 400;
export const SUBJECT_MAX_CHARS = 200;

// O \b do JavaScript só entende ASCII ("faça" não tem fim de palavra para ele): tudo é comparado SEM acentos.
// A remoção de acento é 1 para 1 em português, então a posição achada no texto sem acento vale no original.
function fold(text) {
    return String(text ?? '').normalize('NFC').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const VERB_WORDS = ['gera', 'gere', 'gerar', 'cria', 'crie', 'criar', 'faz', 'faca', 'fazer', 'produz', 'produza', 'monta', 'monte', 'desenha', 'desenhe', 'desenhar'];
const NOUN_WORDS = ['imagem', 'imagens', 'foto', 'fotos', 'arte', 'artes', 'ilustracao', 'ilustracoes', 'desenho', 'desenhos',
    'wallpaper', 'wallpapers', 'papel de parede', 'pfp', 'avatar', 'banner', 'logo', 'logotipo', 'poster'];
const VERBS = `(?:${VERB_WORDS.join('|')})`;
const NOUNS = `(?:${NOUN_WORDS.join('|')})`;
const REQUEST_RE = new RegExp('\\b' + VERBS + '\\b[^.!?\\n]{0,40}?\\b' + NOUNS + '\\b', 'i');
// "desenha um dragão" (sem substantivo): desenhar já é pedir imagem.
const DRAW_RE = /\b(?:desenha|desenhe|desenhar)\b\s+(?!(?:o que|como|quando|onde|por que)\b)\S/i;
// Quem NÃO deve disparar: pergunta de capacidade/ajuda, negação, edição ou análise de imagem enviada.
const NOT_A_REQUEST_RE = new RegExp('\\b(?:' + [
    'nao', 'nunca', 'como', 'quando', 'consegue', 'sabe', 'edita', 'editar', 'edite', 'melhora', 'descreve',
    'por ?que', 'da pra', 'sera que', 'ser capaz', 'onde (?:eu|posso)', 'o que (?:tem|e)',
    'ta (?:gerando|criando)', 'estou (?:gerando|criando)', 'ja gerou', 'sem\\s+(?:gerar|criar)'
].join('|') + ')\\b', 'i');
// Sem assunto de verdade ("uma imagem pra mim", "uma imagem aleatória").
const EMPTY_SUBJECT_RE = /^(?:mim|nos|pra mim|para mim|pra nos|ai|agora|aleatori[ao]|qualquer(?: coisa| uma)?|do que (?:voce|vc) quiser|que (?:voce|vc) quiser|bonit[ao]|legal|massa|top|nova|diferente)$/i;

// Pedido vago ("yui gera uma imagem"): o código escolhe um assunto criativo, em inglês (os modelos de imagem entendem melhor).
export const CREATIVE_PROMPTS = Object.freeze([
    'a cozy cabin in a snowy forest at dusk, warm lights in the windows, cinematic, highly detailed',
    'a friendly robot gardening on a floating island in the sky, vibrant colors, soft light, digital art',
    'a neon-lit cyberpunk street in the rain at night, reflections on the pavement, detailed, atmospheric',
    'a majestic dragon curled around a mountain peak at sunrise, epic fantasy painting, dramatic clouds',
    'a tiny astronaut cat drinking tea on the moon, Earth in the background, whimsical, detailed fur',
    'an enchanted library with glowing books floating in the air, magical atmosphere, rich details',
    'a retro-futuristic city skyline at golden hour, flying cars, synthwave palette, wide shot',
    'a peaceful japanese garden with koi pond and cherry blossoms in spring, soft focus, serene',
    'a lone lighthouse on a stormy sea, waves crashing, moody dramatic lighting, oil painting style',
    'a steampunk airship over a canyon at sunset, intricate brass details, adventurous, cinematic'
]);

/** Remove menção, o nome da Yui e vocativos do começo/fim ("ei yui,", "@yui", "por favor"). */
function stripAddressing(text) {
    let t = String(text ?? '').replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/^(?:e a[ií]|ei|oi|ol[aá]|opa|fala|salve)[\s,!.]+/i, '');
    t = t.replace(/^@?yui\b[\s,:!.-]*/i, '');
    t = t.replace(/^(?:por favor|pf|pfv|pls|please)[\s,:!.-]*/i, '');
    t = t.replace(/[\s,.!?]*\b(?:por favor|pf|pfv|pls|please)\b[\s,.!?]*$/i, '').trim();
    return t;
}

/** Recorta o assunto ("gera uma imagem de um gato espacial" => "um gato espacial"). `text` é o original; `folded` o sem acento. */
function extractSubject(text, folded) {
    let rest;
    const m = folded.match(REQUEST_RE);
    if (m) {
        rest = text.slice(m.index + m[0].length);
    } else {
        const d = folded.match(DRAW_RE);
        if (!d) return '';
        rest = text.slice(d.index).replace(/^\S+\s*/, ''); // "desenha X": tudo depois do verbo
    }
    let subject = rest.trim().replace(/^[:\-–—,\s]+/, '');
    subject = subject.replace(/^(?:de|do|da|dos|das|com|sobre|em que|onde|que|para|pra)\s+/i, '');
    subject = subject.replace(/[?!.\s]+$/, '').trim();
    subject = subject.replace(/\s+(?:pra mim|para mim|pra nós|aí)$/i, '').trim();
    if (EMPTY_SUBJECT_RE.test(fold(subject))) return '';
    return subject.slice(0, SUBJECT_MAX_CHARS);
}

/**
 * Decide se a fala é um pedido claro de imagem.
 * @returns {{explicit:boolean, vague?:boolean, subject?:string, reason:string}}
 */
export function detectImageRequest(text, ctx = {}) {
    const { voice = false, direct = false, radioMode = false, disableTools = false, thirdPartyPrompt = false, hasAttachment = false } = ctx;
    if (typeof text !== 'string' || !text.trim()) return { explicit: false, reason: 'sem texto' };
    if (voice) return { explicit: false, reason: 'voz' };
    if (radioMode) return { explicit: false, reason: 'rádio' };
    if (disableTools) return { explicit: false, reason: 'ferramentas desligadas' };
    if (thirdPartyPrompt) return { explicit: false, reason: 'texto de terceiros' };
    if (!direct) return { explicit: false, reason: 'não é direto à Yui' };
    if (hasAttachment) return { explicit: false, reason: 'anexo (eu não edito nem vejo imagens)' };
    if (/\n[\s\S]*\n[\s\S]*\n/.test(text)) return { explicit: false, reason: 'texto longo/colado' };
    const clean = stripAddressing(text);
    if (clean.length === 0 || clean.length > IMAGE_REQUEST_MAX_CHARS) return { explicit: false, reason: 'tamanho' };
    if (/https?:\/\//i.test(clean)) return { explicit: false, reason: 'tem link' };
    const folded = fold(clean);
    if (!REQUEST_RE.test(folded) && !DRAW_RE.test(folded)) return { explicit: false, reason: 'não pede imagem' };
    if (NOT_A_REQUEST_RE.test(folded)) return { explicit: false, reason: 'pergunta, negação ou edição' };
    const subject = extractSubject(clean, folded);
    if (!subject) return { explicit: true, vague: true, subject: '', reason: 'pedido vago: assunto criativo' };
    return { explicit: true, vague: false, subject, reason: 'pedido com assunto' };
}

/** Assunto criativo para o pedido vago (aleatório; `rnd` permite testar). */
export function pickCreativePrompt(rnd = Math.random) {
    const i = Math.min(CREATIVE_PROMPTS.length - 1, Math.floor(rnd() * CREATIVE_PROMPTS.length));
    return CREATIVE_PROMPTS[i];
}

/** Limpa a saída do modelo ao "traduzir/melhorar" o assunto: uma linha, sem aspas/JSON/recusa; '' se não serviu. */
export function sanitizeEnhancedPrompt(raw, maxChars = 320) {
    let t = String(raw ?? '').replace(/\n-# .*$/gm, '').trim();
    if (!t) return '';
    const json = t.match(/\{[\s\S]*\}/);
    if (json) {
        try {
            const o = JSON.parse(json[0]);
            t = String(o.prompt ?? o.response ?? o.text ?? o.reply ?? '').trim();
        } catch (_) { return ''; }
    }
    t = t.split(/\n/)[0].replace(/^["'“”`]+|["'“”`]+$/g, '').replace(/^(?:prompt|image prompt)\s*:\s*/i, '').trim();
    if (!t || t.length < 4) return '';
    if (/\b(?:n[aã]o posso|n[aã]o consigo|desculpa|desculpe|sorry|i can(?:no|')t|as an ai|como (?:uma )?ia)\b/i.test(t)) return '';
    if (/tool_code|default_api|"tool"\s*:/i.test(t)) return '';
    return t.slice(0, maxChars);
}

// ── Limite por pessoa (memória do processo; some ao reiniciar, de propósito: é só proteção de cota dos provedores) ──
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map(); // userId -> [timestamps]

export function imageLimitPerHour(env = process.env) {
    const n = Number.parseInt(env.YUI_IMAGE_PER_HOUR ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : 6;
}

/** Registra uma geração e diz se pode. O dono não tem limite; limite 0 desliga a checagem. */
export function takeImageQuota(userId, { isOwner = false, now = Date.now(), limit = imageLimitPerHour() } = {}) {
    if (isOwner || limit === 0) return { ok: true, remaining: Infinity };
    const key = String(userId ?? 'anon');
    const recent = (hits.get(key) ?? []).filter(t => now - t < WINDOW_MS);
    if (recent.length >= limit) {
        hits.set(key, recent);
        return { ok: false, remaining: 0, retryAfterMs: WINDOW_MS - (now - recent[0]) };
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) { for (const [k, v] of hits) if (!v.some(t => now - t < WINDOW_MS)) hits.delete(k); }
    return { ok: true, remaining: limit - recent.length };
}

export function __resetImageQuotaForTests() { hits.clear(); }

/** A pré-rota fica ligada por padrão; YUI_IMAGE_PRE_ROUTE=false desliga (a ferramenta chamada pelo modelo continua valendo). */
export function imagePreRouteEnabled(env = process.env) {
    return String(env.YUI_IMAGE_PRE_ROUTE ?? 'true').trim().toLowerCase() !== 'false';
}
