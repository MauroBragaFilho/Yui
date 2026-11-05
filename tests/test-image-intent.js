// Teste offline do pedido de imagem por conversa (Porta I): detecção, pedido vago, filtros de segurança e limite por hora.
// Roda sem Discord, sem rede e sem tocar em banco: npm run test:imageintent
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    detectImageRequest, pickCreativePrompt, CREATIVE_PROMPTS, sanitizeEnhancedPrompt,
    takeImageQuota, imageLimitPerHour, imagePreRouteEnabled, __resetImageQuotaForTests
} from '../src/handlers/imageIntent.js';

const direct = { direct: true };
const ok = (t) => detectImageRequest(t, direct);

test('pedidos claros disparam, com ou sem acento', () => {
    for (const t of ['yui gera uma imagem de um gato espacial', 'Yui, cria uma imagem de um castelo', 'faça uma ilustração de um robô',
        'faca uma ilustracao de um robo', 'gere um wallpaper: floresta neon', 'ei yui, desenha um dragão', 'crie um avatar de uma raposa por favor']) {
        assert.equal(ok(t).explicit, true, t);
    }
});

test('o assunto é recortado e o vocativo/“pra mim” saem', () => {
    assert.equal(ok('Yui, gera uma imagem de um gato espacial').subject, 'um gato espacial');
    assert.equal(ok('cria um wallpaper: floresta neon').subject, 'floresta neon');
    assert.equal(ok('desenha um dragão pra mim').subject, 'um dragão');
    assert.equal(ok('ei yui, cria uma imagem de um castelo por favor').subject, 'um castelo');
});

test('pedido vago ("yui gera uma imagem") vira assunto criativo escolhido pelo código', () => {
    for (const t of ['yui gera uma imagem', 'gera uma imagem aleatória', 'cria uma imagem pra mim']) {
        const r = ok(t);
        assert.equal(r.explicit, true, t);
        assert.equal(r.vague, true, t);
    }
    assert.ok(CREATIVE_PROMPTS.includes(pickCreativePrompt(() => 0)));
    assert.ok(CREATIVE_PROMPTS.includes(pickCreativePrompt(() => 0.9999)));
    assert.notEqual(pickCreativePrompt(() => 0), pickCreativePrompt(() => 0.5));
});

test('pergunta, negação, edição, link e conversa comum NÃO disparam', () => {
    for (const t of ['yui você consegue gerar imagem?', 'não quero gerar imagem', 'como faço pra gerar uma imagem', 'sabe criar imagens?',
        'edita essa imagem pra mim', 'faz uma foto https://x.com/a.png', 'oi yui tudo bem', 'desenha', 'qual a imagem do jogo?']) {
        assert.equal(ok(t).explicit, false, t);
    }
});

test('contextos que nunca disparam: voz, rádio, terceiros, ferramentas desligadas, anexo, conversa não direta', () => {
    const t = 'yui gera uma imagem de um gato';
    assert.equal(detectImageRequest(t, { direct: true, voice: true }).explicit, false);
    assert.equal(detectImageRequest(t, { direct: true, radioMode: true }).explicit, false);
    assert.equal(detectImageRequest(t, { direct: true, thirdPartyPrompt: true }).explicit, false);
    assert.equal(detectImageRequest(t, { direct: true, disableTools: true }).explicit, false);
    assert.equal(detectImageRequest(t, { direct: true, hasAttachment: true }).explicit, false);
    assert.equal(detectImageRequest(t, { direct: false }).explicit, false);
});

test('texto colado/longo não dispara', () => {
    assert.equal(ok('gera uma imagem ' + 'x'.repeat(500)).explicit, false);
    assert.equal(ok('a\nb\nc\nd gera uma imagem de um gato').explicit, false);
});

test('a saída do modelo ao melhorar o prompt é saneada (recusa, JSON e vazio caem no texto original)', () => {
    assert.equal(sanitizeEnhancedPrompt('"a red fox in a forest, detailed"'), 'a red fox in a forest, detailed');
    assert.equal(sanitizeEnhancedPrompt('{"prompt":"a red fox, cinematic"}'), 'a red fox, cinematic');
    assert.equal(sanitizeEnhancedPrompt('Desculpe, não posso fazer isso'), '');
    assert.equal(sanitizeEnhancedPrompt('{"tool":"search_web"}'), '');
    assert.equal(sanitizeEnhancedPrompt(''), '');
    assert.equal(sanitizeEnhancedPrompt('x'.repeat(1000)).length, 320);
});

test('limite por hora: o 7º pedido é negado, o dono não tem limite, a janela expira', () => {
    __resetImageQuotaForTests();
    const t0 = 1_000_000;
    for (let i = 0; i < 6; i++) assert.equal(takeImageQuota('u1', { now: t0 + i, limit: 6 }).ok, true);
    assert.equal(takeImageQuota('u1', { now: t0 + 10, limit: 6 }).ok, false);
    assert.equal(takeImageQuota('u2', { now: t0, limit: 6 }).ok, true, 'outra pessoa não é afetada');
    for (let i = 0; i < 50; i++) assert.equal(takeImageQuota('dono', { isOwner: true, now: t0 + i, limit: 6 }).ok, true);
    assert.equal(takeImageQuota('u1', { now: t0 + 61 * 60 * 1000, limit: 6 }).ok, true, 'depois de 1 hora libera');
    assert.equal(takeImageQuota('u3', { now: t0, limit: 0 }).ok, true, 'limite 0 desliga');
});

test('configuração por variável de ambiente', () => {
    assert.equal(imageLimitPerHour({}), 6);
    assert.equal(imageLimitPerHour({ YUI_IMAGE_PER_HOUR: '10' }), 10);
    assert.equal(imageLimitPerHour({ YUI_IMAGE_PER_HOUR: 'abc' }), 6);
    assert.equal(imagePreRouteEnabled({}), true);
    assert.equal(imagePreRouteEnabled({ YUI_IMAGE_PRE_ROUTE: 'false' }), false);
});
