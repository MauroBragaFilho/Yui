const fs   = require('fs');
const path = require('path');
const config = require('../config');
require('dotenv').config();
const SAFETY_NEGATIVE_BASE = 'nsfw, nude, explicit, gore, violence, blood, adult content, 18+, pornographic, sexual, disturbing, hentai, r18, genitals, suggestive, semi-nude';
function enforceSafetyNegative(negativePrompt = '') {
    if (!negativePrompt.trim()) return SAFETY_NEGATIVE_BASE;
    const safetyTokens = SAFETY_NEGATIVE_BASE.split(',').map(t => t.trim());
    const existing = negativePrompt.toLowerCase();
    const missing = safetyTokens.filter(t => !existing.includes(t));
    return missing.length > 0 ? negativePrompt + ', ' + missing.join(', ') : negativePrompt;
}
async function saveImageLocally(imageUrl, seed) {
    try {
        const imageResponse = await fetch(imageUrl);
        if (!imageResponse.ok) throw new Error(`HTTP ${imageResponse.status}`);
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const tempDir = path.join(__dirname, '../data/temp_images');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const localFilePath = path.join(tempDir, `image_${Date.now()}_${seed || 'na'}.png`);
        fs.writeFileSync(localFilePath, imageBuffer);
        console.log(`[ImageHandler] Imagem salva em: ${localFilePath}`);
    } catch (e) {
        console.warn('[ImageHandler] Falha ao salvar imagem localmente:', e.message);
    }
}
async function tryGradioSDXL(prompt, negativePrompt, width, height) {
    const { Client } = await import('@gradio/client');
    console.log('[Image 1/5] Tentando Gradio (SDXL-Flash)...');
    const client = await Client.connect('KingNish/SDXL-Flash');
    const result = await client.predict('/run', {
        prompt,
        negative_prompt: negativePrompt,
        use_negative_prompt: true,
        seed: Math.floor(Math.random() * 1_000_000_000),
        width,
        height,
        guidance_scale: 3,
        num_inference_steps: 8,
        randomize_seed: true,
    });
    const imageUrl = result?.data?.[0]?.[0]?.image?.url;
    const actualSeed = result?.data?.[1] ?? Math.floor(Math.random() * 1e9);
    if (!imageUrl) throw new Error('URL da imagem não encontrada na resposta Gradio');
    await saveImageLocally(imageUrl, actualSeed);
    return { imageUrl, actualSeed, modelName: 'SDXL-Flash (Gradio)' };
}
async function tryHuggingFace(prompt, negativePrompt, width, height) {
    const hfToken = config.hfToken;
    if (!hfToken) throw new Error('HF_TOKEN não configurado');
    console.log('[Image 2/5] Tentando HuggingFace (FLUX.1-schnell)...');
    const model  = 'black-forest-labs/FLUX.1-schnell';
    const apiUrl = `https://router.huggingface.co/hf-inference/models/${model}`;
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${hfToken}`,
            'Content-Type': 'application/json',
            'x-wait-for-model': 'true',
        },
        body: JSON.stringify({
            inputs: prompt,
            parameters: {
                negative_prompt: negativePrompt,
                width:  Math.min(width,  1024),
                height: Math.min(height, 1024),
                num_inference_steps: 4,
                guidance_scale: 3.5,
            }
        }),
        signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HuggingFace HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('image')) {
        const body = await response.text();
        throw new Error(`HuggingFace retornou content-type inesperado (${contentType}): ${body.substring(0, 150)}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const seed = Math.floor(Math.random() * 1e9);
    const tempDir = path.join(__dirname, 'temp_images');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(tempDir, `image_${Date.now()}_${seed}.png`);
    fs.writeFileSync(filePath, buffer);
    return { imageUrl: null, localFilePath: filePath, actualSeed: seed, modelName: 'FLUX.1-schnell (HuggingFace)' };
}
async function tryStableHorde(prompt, negativePrompt, width, height) {
    const apiKey = config.hordeImageApiKey;
    console.log('[Image 3/5] Tentando Stable Horde...');
    const submitRes = await fetch('https://stablehorde.net/api/v2/generate/async', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': apiKey,
            'Client-Agent': 'HikariBot:3.0:github.com/yguilhermy/Hikari',
        },
        body: JSON.stringify({
            prompt: `${prompt} ### ${negativePrompt}`,
            params: {
                sampler_name: 'k_euler',
                cfg_scale: 7,
                steps: 20,
                width:  Math.round(Math.min(width,  1024) / 64) * 64,
                height: Math.round(Math.min(height, 1024) / 64) * 64,
                karras: true,
                n: 1,
            },
            models: ['AlbedoBase XL (SDXL)'],
            nsfw: false,
            censor_nsfw: true,
            shared: true,
            r2: true,
        }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!submitRes.ok) {
        const errBody = await submitRes.text().catch(() => '');
        throw new Error(`Stable Horde submit HTTP ${submitRes.status}: ${errBody.substring(0, 100)}`);
    }
    const { id } = await submitRes.json();
    if (!id) throw new Error('Stable Horde não retornou ID de job');
    console.log(`[Image 3/5] Stable Horde job ID: ${id} — aguardando geração...`);
    for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(r => setTimeout(r, 5000));
        const checkRes = await fetch(`https://stablehorde.net/api/v2/generate/check/${id}`);
        if (!checkRes.ok) continue;
        const checkData = await checkRes.json();
        if (checkData.done) {
            const resultRes = await fetch(`https://stablehorde.net/api/v2/generate/status/${id}`);
            if (!resultRes.ok) throw new Error(`Stable Horde result HTTP ${resultRes.status}`);
            const resultData = await resultRes.json();
            const generation = resultData?.generations?.[0];
            const hordeModel = generation?.model || 'AlbedoBase XL';
            if (generation?.img) {
                let buffer;
                if (generation.img.startsWith('http')) {
                    const imgRes = await fetch(generation.img, { signal: AbortSignal.timeout(30_000) });
                    if (!imgRes.ok) throw new Error(`Stable Horde R2 download HTTP ${imgRes.status}`);
                    buffer = Buffer.from(await imgRes.arrayBuffer());
                } else {
                    buffer = Buffer.from(generation.img, 'base64');
                }
                const seed    = generation?.seed || Math.floor(Math.random() * 1e9);
                const tempDir = path.join(__dirname, '../data/temp_images');
                if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
                const filePath = path.join(tempDir, `image_${Date.now()}_${seed}.png`);
                fs.writeFileSync(filePath, buffer);
                return { imageUrl: null, localFilePath: filePath, actualSeed: seed, modelName: `${hordeModel} (Stable Horde)` };
            }
            throw new Error('Stable Horde não retornou imagem');
        }
        if (checkData.faulted) throw new Error('Stable Horde: job falhou (faulted)');
        console.log(`[Image 3/5] Stable Horde: aguardando... (fila: ${checkData.queue_position || '?'})`);
    }
    throw new Error('Stable Horde Timeout (120s)');
}
async function tryTogetherAI(prompt, negativePrompt, width, height) {
    const apiKey = config.togetherApiKey;
    if (!apiKey) throw new Error('TOGETHER_API_KEY não configurado');
    console.log('[Image 4/5] Tentando Together AI (FLUX.1-schnell)...');
    const response = await fetch('https://api.together.ai/v1/images/generations', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model:  'black-forest-labs/FLUX.1-schnell',
            prompt: `${prompt}, safe for work, family friendly`,
            negative_prompt: negativePrompt,
            width:  Math.min(width,  1440),
            height: Math.min(height, 1440),
            steps: 4,
            n: 1,
            response_format: 'b64_json',
        }),
        signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Together AI HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }
    const data = await response.json();
    const b64  = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error('Together AI não retornou imagem base64');
    const buffer  = Buffer.from(b64, 'base64');
    const seed    = data?.data?.[0]?.seed || Math.floor(Math.random() * 1e9);
    const tempDir = path.join(__dirname, 'temp_images');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(tempDir, `image_${Date.now()}_${seed}.png`);
    fs.writeFileSync(filePath, buffer);
    return { imageUrl: null, localFilePath: filePath, actualSeed: seed, modelName: 'FLUX.1-schnell (Together AI)' };
}
async function tryStabilityAI(prompt, negativePrompt, width, height) {
    const apiKey = config.getStabilityKey();
    if (!apiKey) throw new Error('STABILITY_API_KEY não configurado');
    console.log('[Image 0/6] Tentando Stability AI (Ultra)...');
    
    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('negative_prompt', negativePrompt);
    formData.append('output_format', 'webp');
    formData.append('aspect_ratio', width > height ? '16:9' : (height > width ? '9:16' : '1:1'));

    const response = await fetch('https://api.stability.ai/v2beta/stable-image/generate/ultra', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'image/*'
        },
        body: formData,
        signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Stability AI HTTP ${response.status}: ${errText.substring(0, 200)}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const seed = Math.floor(Math.random() * 1e9);
    const tempDir = path.join(__dirname, '../data/temp_images');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(tempDir, `image_${Date.now()}_${seed}.webp`);
    fs.writeFileSync(filePath, buffer);
    return { imageUrl: null, localFilePath: filePath, actualSeed: seed, modelName: 'Stable Image Ultra (Stability AI)' };
}
async function tryPollinations(prompt, negativePrompt, width, height) {
    console.log('[Image 5/5] Tentando Pollinations AI (último fallback)...');
    const encodedPrompt   = encodeURIComponent(prompt);
    const encodedNegative = encodeURIComponent(negativePrompt);
    const seed = Math.floor(Math.random() * 1e9);
    const model = 'flux';
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?negative=${encodedNegative}&width=${Math.min(width, 1280)}&height=${Math.min(height, 1280)}&seed=${seed}&model=${model}&nologo=true&safe=true`;
    const getRes = await fetch(imageUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(45_000),
    });
    if (!getRes.ok) throw new Error(`Pollinations GET HTTP ${getRes.status}`);
    const contentType = getRes.headers.get('content-type') || '';
    if (!contentType.includes('image')) throw new Error(`Pollinations retornou content-type inesperado: ${contentType}`);
    const buffer = Buffer.from(await getRes.arrayBuffer());
    const tempDir = path.join(__dirname, 'temp_images');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(tempDir, `image_${Date.now()}_${seed}.png`);
    fs.writeFileSync(filePath, buffer);
    return { imageUrl: null, localFilePath: filePath, actualSeed: seed, modelName: 'Flux (Pollinations AI)' };
}
async function generateImage(prompt, negativePrompt = '', width = 1024, height = 1024, options = {}) {
    const { provider = 'auto', bypassSafety = false } = options;
    console.log(`[LOG] Geração de Imagem | Provedor: ${provider} | Prompt: "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
    const finalNegative = bypassSafety ? negativePrompt : enforceSafetyNegative(negativePrompt);
    const allProviders = [
        { id: 'stability',    name: 'Stability AI',      fn: tryStabilityAI },
        { id: 'gradio',       name: 'Gradio/SDXL-Flash', fn: tryGradioSDXL },
        { id: 'huggingface',  name: 'HuggingFace/FLUX',  fn: tryHuggingFace },
        { id: 'stablehorde',  name: 'StableHorde',       fn: tryStableHorde },
        { id: 'together',     name: 'Together AI',       fn: tryTogetherAI },
        { id: 'pollinations', name: 'Pollinations AI',   fn: tryPollinations },
    ];
    let providersToTry = allProviders;
    if (provider && provider !== 'auto') {
        const selected = allProviders.find(p => p.id === provider);
        if (selected) providersToTry = [selected];
    }
    for (const p of providersToTry) {
        try {
            const result = await p.fn(prompt, finalNegative, width, height);
            if (result) {
                console.log(`[ImageHandler] ✅ Sucesso via ${p.name}`);
                return result;
            }
        } catch (err) {
            console.warn(`[ImageHandler] ❌ ${p.name} falhou: ${err.message}`);
        }
    }
    console.error(`[ImageHandler] CRITICAL: Fallback failed para a lista de provedores tentados (${providersToTry.map(p => p.id).join(', ')}).`);
    return null;
}
module.exports = { generateImage };