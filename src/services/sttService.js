const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const STT_PROVIDERS_CONFIG = {
    GROQ: true,
    WITAI: true,
    GEMINI: true,
    HUGGINGFACE: true,
    OPENAI: true,
    LOCAL: true
};

function isPlaceholderKey(key) {
    if (!key || typeof key !== 'string') return true;
    const k = key.toLowerCase().trim();
    return k.includes('sua_chave') || k.includes('suas_chave') || k.includes('seu_token') || k.includes('your_key') || k.includes('placeholder') || k.length < 10;
}

async function transcribeWithGroq(audioBuffer, apiKey, filename) {
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename, contentType: 'audio/wav' });
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'pt');
    formData.append('response_format', 'json');
    formData.append('prompt', 'Hikari, assistente virtual Hikari, fale com a Hikari.');

    const response = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
        headers: {
            ...formData.getHeaders(),
            'Authorization': `Bearer ${apiKey}`
        },
        timeout: 10000
    });

    if (response.data && response.data.text) {
        return response.data.text.trim();
    }
    return null;
}

async function transcribeWithGemini(audioBuffer, apiKey) {
    const base64Audio = audioBuffer.toString('base64');
    const model = process.env.GEMINI_MODEL_FALLBACK && !process.env.GEMINI_MODEL_FALLBACK.includes('2.5')
        ? process.env.GEMINI_MODEL_FALLBACK
        : 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const payload = {
        contents: [
            {
                parts: [
                    { text: 'Transcreva exatamente o áudio em português fornecido. Retorne APENAS o texto falado, sem saudações ou comentários.' },
                    {
                        inlineData: {
                            mimeType: 'audio/wav',
                            data: base64Audio
                        }
                    }
                ]
            }
        ]
    };

    const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 12000
    });

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
        return text.trim();
    }
    return null;
}

async function transcribeWithWitAi(audioBuffer, token) {
    const response = await axios.post('https://api.wit.ai/speech?v=20230215', audioBuffer, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'audio/wav'
        },
        timeout: 10000
    });

    const rawData = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    const matches = rawData.match(/\{[\s\S]*?\}(?=\s*\{|$)/g);
    if (matches && matches.length > 0) {
        for (let i = matches.length - 1; i >= 0; i--) {
            try {
                const parsed = JSON.parse(matches[i]);
                if (parsed.text && parsed.text.trim()) {
                    return parsed.text.trim();
                }
            } catch (_) {}
        }
    }
    return null;
}

async function transcribeWithHuggingFace(audioBuffer, token) {
    const endpoint = process.env.HF_STT_URL || 'https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3-turbo';

    const response = await axios.post(endpoint, audioBuffer, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'audio/wav'
        },
        timeout: 12000
    });

    if (response.data && response.data.text) {
        return response.data.text.trim();
    }
    return null;
}

async function transcribeWithOpenAI(audioBuffer, apiKey, filename) {
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename, contentType: 'audio/wav' });
    formData.append('model', 'whisper-1');
    formData.append('language', 'pt');
    formData.append('response_format', 'json');
    formData.append('prompt', 'Hikari, assistente virtual Hikari, fale com a Hikari.');

    const endpoint = process.env.OPENAI_STT_URL || 'https://api.openai.com/v1/audio/transcriptions';

    const response = await axios.post(endpoint, formData, {
        headers: {
            ...formData.getHeaders(),
            'Authorization': `Bearer ${apiKey}`
        },
        timeout: 12000
    });

    if (response.data && response.data.text) {
        return response.data.text.trim();
    }
    return null;
}

async function transcribeWithLocal(audioBuffer, localUrl, filename) {
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename, contentType: 'audio/wav' });
    formData.append('language', 'pt');

    const headers = { ...formData.getHeaders() };
    if (process.env.LM_STUDIO_API_KEY) {
        headers['Authorization'] = `Bearer ${process.env.LM_STUDIO_API_KEY}`;
    }

    const response = await axios.post(localUrl, formData, {
        headers,
        timeout: 15000
    });

    if (response.data && response.data.text) {
        return response.data.text.trim();
    }
    return null;
}

async function transcribeAudio(audioBuffer, filename = 'speech.wav') {
    const providers = [];

    const groqKeysRaw = process.env.GROQ_API_KEY || '';
    if (STT_PROVIDERS_CONFIG.GROQ && groqKeysRaw) {
        const keys = groqKeysRaw.split(',').map(k => k.trim()).filter(k => !isPlaceholderKey(k));
        keys.forEach((k, idx) => {
            providers.push({
                name: `Groq (Chave ${idx + 1})`,
                fn: () => transcribeWithGroq(audioBuffer, k, filename)
            });
        });
    }

    const witToken = process.env.WITAI_TOKEN || process.env.WIT_AI_KEY;
    if (STT_PROVIDERS_CONFIG.WITAI && !isPlaceholderKey(witToken)) {
        providers.push({
            name: 'Discord Speech / Wit.ai',
            fn: () => transcribeWithWitAi(audioBuffer, witToken)
        });
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (STT_PROVIDERS_CONFIG.GEMINI && !isPlaceholderKey(geminiKey)) {
        providers.push({
            name: 'Gemini Flash Audio (Google API)',
            fn: () => transcribeWithGemini(audioBuffer, geminiKey)
        });
    }

    const hfToken = process.env.HF_TOKEN;
    if (STT_PROVIDERS_CONFIG.HUGGINGFACE && !isPlaceholderKey(hfToken)) {
        providers.push({
            name: 'HuggingFace STT',
            fn: () => transcribeWithHuggingFace(audioBuffer, hfToken)
        });
    }

    const openAiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_STT_KEY;
    if (STT_PROVIDERS_CONFIG.OPENAI && !isPlaceholderKey(openAiKey)) {
        providers.push({
            name: 'OpenAI Whisper',
            fn: () => transcribeWithOpenAI(audioBuffer, openAiKey, filename)
        });
    }

    const localSttUrl = process.env.LOCAL_STT_URL || process.env.WHISPER_LOCAL_URL;
    if (STT_PROVIDERS_CONFIG.LOCAL && localSttUrl) {
        providers.push({
            name: 'Local Whisper STT',
            fn: () => transcribeWithLocal(audioBuffer, localSttUrl, filename)
        });
    }

    if (providers.length === 0) {
        console.error('[STT] ❌ Nenhuma chave/provedor de STT válido configurado no .env');
        return null;
    }

    let lastRateLimit = null;

    for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];
        try {
            const text = await provider.fn();
            if (text) {
                if (i > 0) {
                    console.log(`[STT] ✅ Transcrito com sucesso via Fallback: ${provider.name}`);
                }
                return text;
            }
        } catch (error) {
            const status = error.response?.status;
            const isRate = status === 429 || status === 492 || error.response?.data?.error?.code === 'rate_limit_exceeded';

            if (isRate) {
                lastRateLimit = { isRateLimit: true, status, message: error.response?.data?.error?.message || 'Rate limit' };
            }

            console.warn(`[STT] ⚠️ Falha no provedor ${provider.name} (Status: ${status || 'Erro de Conexão'}). Tentando próximo fallback...`);
        }
    }

    if (lastRateLimit) {
        console.error('[STT] ❌ Todos os provedores de STT ativos atingiram limite de requisições.');
        return lastRateLimit;
    }

    return null;
}

module.exports = {
    transcribeAudio,
    STT_PROVIDERS_CONFIG
};
