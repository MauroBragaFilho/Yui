const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const STT_PROVIDERS_CONFIG = {
    GROQ: true,
    GEMINI: true,
    WITAI: true,
    HUGGINGFACE: true,
    OPENAI: true,
    LOCAL: true
};

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
    const model = process.env.GEMINI_MODEL_FALLBACK || 'gemini-2.5-flash';
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
    const witToken = token || process.env.WITAI_TOKEN || process.env.WIT_AI_KEY;
    if (!witToken) return null;

    const response = await axios.post('https://api.wit.ai/speech?v=20230215', audioBuffer, {
        headers: {
            'Authorization': `Bearer ${witToken}`,
            'Content-Type': 'audio/wav'
        },
        timeout: 10000
    });

    if (typeof response.data === 'string') {
        const lines = response.data.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const parsed = JSON.parse(lines[i]);
                if (parsed.text) return parsed.text.trim();
            } catch (_) {}
        }
    } else if (response.data && response.data.text) {
        return response.data.text.trim();
    }
    return null;
}

async function transcribeWithHuggingFace(audioBuffer, token, filename) {
    const formData = new FormData();
    formData.append('file', audioBuffer, { filename, contentType: 'audio/wav' });
    formData.append('model', 'openai/whisper-large-v3-turbo');
    formData.append('language', 'pt');

    const endpoint = process.env.HF_STT_URL || 'https://router.huggingface.co/openai/v1/audio/transcriptions';

    const response = await axios.post(endpoint, formData, {
        headers: {
            ...formData.getHeaders(),
            'Authorization': `Bearer ${token}`
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
        const keys = groqKeysRaw.split(',').map(k => k.trim()).filter(Boolean);
        keys.forEach((k, idx) => {
            providers.push({
                name: `Groq (Chave ${idx + 1})`,
                fn: () => transcribeWithGroq(audioBuffer, k, filename)
            });
        });
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (STT_PROVIDERS_CONFIG.GEMINI && geminiKey) {
        providers.push({
            name: 'Gemini 2.5 Flash Audio (Google API)',
            fn: () => transcribeWithGemini(audioBuffer, geminiKey)
        });
    }

    const witToken = process.env.WITAI_TOKEN || process.env.WIT_AI_KEY;
    if (STT_PROVIDERS_CONFIG.WITAI && witToken) {
        providers.push({
            name: 'Discord Speech / Wit.ai',
            fn: () => transcribeWithWitAi(audioBuffer, witToken)
        });
    }

    const hfToken = process.env.HF_TOKEN;
    if (STT_PROVIDERS_CONFIG.HUGGINGFACE && hfToken) {
        providers.push({
            name: 'HuggingFace STT',
            fn: () => transcribeWithHuggingFace(audioBuffer, hfToken, filename)
        });
    }

    const openAiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_STT_KEY;
    if (STT_PROVIDERS_CONFIG.OPENAI && openAiKey) {
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
        console.error('[STT] ❌ Nenhuma chave/provedor de STT ativo ou configurado');
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
        console.error('[STT] ❌ Todos os provedores de STT atingiram limite de requisições ou falharam.');
        return lastRateLimit;
    }

    return null;
}

module.exports = {
    transcribeAudio,
    STT_PROVIDERS_CONFIG
};
