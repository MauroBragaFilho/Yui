import assert from 'node:assert/strict';
process.env.GROQ_API_KEY = 'gsk_test_key_123456789';
process.env.GEMINI_API_KEYS = 'gem_test_key_123456789';
const { describeImages, pickImageAttachments, visionDeps, imageMimeOf } = await import('../src/services/vision.js');
const { applyVisionToAttachments, describeAttachments } = await import('../src/events/messageCreate.js');

const att = (name, contentType, size = 1000, url = 'https://cdn.discordapp.com/attachments/1/2/' + name) => ({ name, contentType, size, url });

// seleção
assert.equal(imageMimeOf(att('a.PNG', '')), 'image/png');
assert.equal(imageMimeOf(att('a.txt', 'text/plain')), '');
const p = pickImageAttachments([att('a.png', 'image/png'), att('b.jpg', 'image/jpeg', 99e6), att('c.png', 'image/png', 10, 'https://evil.com/c.png'), att('d.txt', 'text/plain')]);
assert.equal(p.images.length, 1); assert.equal(p.skipped.size, 1); assert.equal(p.skipped.host, 1);

// Groq ok
const calls = [];
visionDeps.fetch = async (url, opts) => {
  calls.push(url);
  if (url.startsWith('https://cdn.discordapp.com')) return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  if (url.includes('groq')) {
    const body = JSON.parse(opts.body);
    assert.match(body.model, /qwen/);
    assert.equal(body.messages[1].content[1].type, 'image_url');
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Um gato preto.' } }] }) };
  }
  throw new Error('inesperado');
};
let r = await describeImages([att('a.png', 'image/png')], 'o que é isso?', { env: { ...process.env, YUI_VISION_FIRST: 'groq' } });
assert.deepEqual([r.ok, r.provider, r.text], [true, 'groq', 'Um gato preto.']);

// Gemini é o primeiro por padrão; se cair (429), vai para o Groq
visionDeps.fetch = async (url) => {
  if (url.startsWith('https://cdn.discordapp.com')) return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  if (url.includes('generativelanguage')) return { ok: false, status: 429 };
  if (url.includes('groq')) return { ok: true, json: async () => ({ choices: [{ message: { content: 'Cachorro.' } }] }) };
  return { ok: true, json: async () => ({ choices: [{ message: { content: 'Cachorro.' } }] }) };
};
r = await describeImages([att('a.png', 'image/png')], '');
assert.equal(r.provider, 'groq');

// sem imagem / desligado
assert.equal((await describeImages([att('a.txt', 'text/plain')])).reason, 'none');
assert.equal((await describeImages([att('a.png', 'image/png')], '', { env: { YUI_VISION: 'false' } })).reason, 'disabled');

// bloco no prompt marca imagem como lida
const d = describeAttachments([att('a.png', 'image/png')]);
d.items.forEach((i) => { i.status = 'skipped'; });
const block = applyVisionToAttachments(d, { ok: true, text: 'Um gato.', count: 1 });
assert.match(block, /Um gato\./); assert.equal(d.items[0].status, 'read');
assert.equal(applyVisionToAttachments(d, { ok: false }), '');
console.log('test-vision OK'); process.exit(0);
