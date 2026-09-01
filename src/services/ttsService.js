import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Serviço de Text-to-Speech (TTS) da Yui.
 *
 * Utiliza a capacidade NATIVA de geração de fala do Google Gemini (Gemini TTS),
 * aproveitando a MESMA GEMINI_API_KEY já configurada no projeto — ou seja, a
 * própria IA que processa a conversa também gera o áudio da resposta, tornando
 * a fala muito mais natural do que um TTS tradicional.
 *
 * O serviço opera em modo "best-effort": se a chave não estiver configurada,
 * o modelo não suportar o recurso, ou ocorrer qualquer erro (rate limit, quota,
 * rede), a função retorna `null`. Dessa forma, o bot sempre pode cair de volta
 * para a resposta em texto — nunca quebrando o fluxo de conversa existente.
 */

// Modelos Gemini com capacidade de geração de fala (TTS) — recurso em Preview.
const TTS_SUPPORTED_MODELS = [
    'gemini-2.5-flash-preview-tts',
    'gemini-2.5-flash-tts',
    'gemini-2.5-pro-preview-tts',
    'gemini-2.5-pro-tts',
    'gemini-3.1-flash-tts-preview'
];

// Vozes pré-definidas disponíveis no Gemini TTS. A "Kore" é uma voz feminina
// natural e agradável, ideal para a personalidade da Yui.
const DEFAULT_VOICE = 'Kore';

/**
 * Normaliza uma lista de chaves Gemini (suporta múltiplas chaves separadas por vírgula).
 * Remove chaves placeholder inválidas.
 */
function getGeminiKeys() {
    const raw = process.env.GEMINI_API_KEY || '';
    return raw
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k && k.length > 10 && isPlaceholderKey(k) === false);
}

/**
 * Detecta se uma chave parece ser um placeholder de exemplo (não um valor real).
 */
function isPlaceholderKey(key) {
    if (!key || typeof key !== 'string') return true;
    const k = key.toLowerCase().trim();
    return (
        k.includes('sua_chave') ||
        k.includes('suas_chave') ||
        k.includes('seu_token') ||
        k.includes('seu_key') ||
        k.includes('your_key') ||
        k.includes('placeholder') ||
        k.length < 10
    );
}

/**
 * Seleciona o modelo TTS a ser usado, com base na configuração.
 * Prioriza variáveis de ambiente, depois um modelo padrão de síntese.
 */
function getTtsModel() {
    const envModel = (process.env.GEMINI_TTS_MODEL || '').trim();
    if (envModel) return envModel;

    // Se o usuário definiu um modelo Gemini base, tenta inferir a variante TTS
    // correspondente (ex: gemini-2.5-flash -> gemini-2.5-flash-tts).
    const baseModel = (process.env.GEMINI_MODEL_FALLBACK || process.env.GEMINI_MODEL || '').trim();
    if (baseModel) {
        return `${baseModel.replace(/-preview$/, '')}-tts`;
    }
    return 'gemini-2.5-flash-preview-tts';
}

/**
 * Limpa o texto de marcações Discord e anotações internas que não devem ser faladas,
 * mantendo apenas o conteúdo falável.
 */
function sanitizeForSpeech(text) {
    if (!text) return '';
    return String(text)
        // Remove menções/IDs do Discord
        .replace(/<@!?\d+>/g, '')
        .replace(/<#\d+>/g, '')
        .replace(/<@&\d+>/g, '')
        // Remove anotações internas "-# ..." (usadas pelo bot para notas de fonte)
        .replace(/\n-# .*$/gm, '')
        .replace(/^-# .*$/gm, '')
        // Remove blocos de código e links Markdown
        .replace(/```[\s\S]*?```/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        // Remove formatação Markdown básica (negrito, itálico, sublinhado)
        .replace(/[*_~`]/g, '')
        // Remove emojis unicode que não podem ser falados
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Gera áudio de fala (TTS) para um texto usando o Gemini TTS nativo.
 *
 * @param {string} text - Texto a ser falado.
 * @param {object} options - Opções opcionais.
 * @param {string} [options.voice] - Voz a usar (ex: 'Kore', 'Puck', 'Aoede', 'Zephyr').
 * @param {string} [options.instructions] - Instruções de direção de fala em linguagem natural.
 * @returns {Promise<{audio: Buffer, mimeType: string} | null>}
 *          Buffer de áudio e MIME type, ou `null` em caso de falha/sem suporte.
 */
async function synthesizeSpeech(text, options = {}) {
    try {
        const keys = getGeminiKeys();
        if (keys.length === 0) {
            console.warn('[TTS] ⚠️ Nenhuma GEMINI_API_KEY válida configurada para TTS. Ignorando fala.');
            return null;
        }

        const cleanText = sanitizeForSpeech(text);
        if (!cleanText || cleanText.length === 0) {
            console.warn('[TTS] ⚠️ Texto vazio após sanitização. Sem fala para gerar.');
            return null;
        }

        const model = getTtsModel();
        const voice = options.voice || process.env.GEMINI_TTS_VOICE || DEFAULT_VOICE;
        const instructions =
            options.instructions ||
            process.env.GEMINI_TTS_INSTRUCTIONS ||
            'Fale de forma natural, calorosa e amigável, como uma assistente virtual carismática.';

        const speechConfig = {
            voiceConfig: {
                prebuiltVoiceConfig: { voiceName: voice }
            }
        };

        const parts = [{ text: cleanText }];

        // Instruções de direção (estilo/entonação) em linguagem natural, quando fornecidas.
        if (instructions && instructions.trim()) {
            parts.push({ text: `Instructions: ${instructions}` });
        }

        let lastError = null;

        // Tenta cada chave Gemini (rotação) até obter áudio com sucesso.
        for (const apiKey of keys) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                const payload = {
                    contents: [{ parts }],
                    generationConfig: {
                        responseModalities: ['TEXT', 'AUDIO'],
                        speechConfig
                    }
                };

                const response = await axios.post(url, payload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 30000,
                    responseType: 'arraybuffer'
                });

                // A API retorna JSON (em bytes) com o áudio em base64 dentro de um part.
                const data = parseJsonResponse(response.data);
                const partsOut = data?.candidates?.[0]?.content?.parts || [];
                const audioPart = partsOut.find((p) => p.inlineData && p.inlineData.data);

                if (audioPart?.inlineData?.data) {
                    const audio = Buffer.from(audioPart.inlineData.data, 'base64');
                    const mimeType = audioPart.inlineData.mimeType || 'audio/L16;rate=24000';
                    console.log(`[TTS] ✅ Fala gerada (${audio.length} bytes, ${mimeType}, modelo ${model}).`);
                    return { audio, mimeType };
                }

                // Sem áudio na resposta — modelo ativo não suporta TTS ou retornou texto.
                console.warn(`[TTS] ⚠️ API Gemini não retornou áudio para o modelo ${model} (apenas texto).`);
                lastError = new Error('NO_AUDIO_IN_RESPONSE');
            } catch (error) {
                const status = error.response?.status;
                const isRate = status === 429 || status === 492;
                lastError = error;
                console.warn(
                    `[TTS] ⚠️ Falha ao gerar fala (Status: ${status || 'Erro de Conexão'}). ${
                        isRate ? 'Rate limit — tentando próxima chave.' : 'Tentando próximo fallback...'
                    }`
                );
            }
        }

        console.warn('[TTS] ❌ Nenhuma chave/provedor TTS conseguiu gerar áudio. Ignorando fala.', lastError?.message);
        return null;
    } catch (error) {
        console.error('[TTS] ❌ Erro inesperado no serviço de TTS:', error.message || error);
        return null;
    }
}


/**
 * Converte o buffer de resposta (que pode ser texto JSON ou bytes) em objeto JSON.
 * O axios foi configurado com responseType 'arraybuffer', então precisamos tratar o JSON.
 */
function parseJsonResponse(buffer) {
    try {
        if (Buffer.isBuffer(buffer)) {
            const text = buffer.toString('utf8');
            // Remove BOM e caracteres de controle antes do JSON
            const jsonStart = text.indexOf('{');
            if (jsonStart === -1) return null;
            return JSON.parse(text.substring(jsonStart));
        }
        if (typeof buffer === 'object' && buffer !== null) return buffer;
        return JSON.parse(buffer);
    } catch (e) {
        console.warn('[TTS] ⚠️ Erro ao interpretar resposta JSON do Gemini:', e.message);
        return null;
    }
}

/**
 * Metadados do provider TTS.
 */
const TTS_PROVIDER = {
    name: 'Gemini TTS Nativo',
    models: TTS_SUPPORTED_MODELS
};

export { synthesizeSpeech, sanitizeForSpeech, TTS_PROVIDER };

export default {
    synthesizeSpeech,
    sanitizeForSpeech,
    TTS_PROVIDER
};

