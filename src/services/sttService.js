const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

async function transcribeAudio(audioBuffer, filename = 'speech.wav') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
        console.error('[STT] ❌ GROQ_API_KEY não configurada no .env');
        return null;
    }

    try {
        const formData = new FormData();
        formData.append('file', audioBuffer, {
            filename: filename,
            contentType: 'audio/wav'
        });
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
    } catch (error) {
        if (error.response) {
            console.error(`[STT] ❌ Erro na API Groq: Status ${error.response.status}`, error.response.data);
        } else {
            console.error(`[STT] ❌ Erro na requisição STT:`, error.message);
        }
        return null;
    }
}

module.exports = {
    transcribeAudio
};
