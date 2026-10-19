// Testes de src/discord/embedLimits.js (limites do Discord para embeds, menus e listas), sem Discord real.
// Execução: npm run test:embedlimits   (ou: node tests/test-embed-limits.js)
import assert from 'node:assert/strict';
import { MessagePayload, StringSelectMenuBuilder, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import {
  LIMITS, clampText, makeEmbed, fitEmbeds, clampOptions, chunkLines, clampContent,
  embedLength, isHttpUrl, isAttachmentUrl,
} from '../src/discord/embedLimits.js';

let passed = 0;
const failures = [];
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✘ FALHA ${name}\n      ${String(e?.message ?? e).split('\n')[0]}`); }
};

const big = (n, c = 'x') => c.repeat(n);
const size = (j) => (j.title?.length ?? 0) + (j.description?.length ?? 0) + (j.footer?.text.length ?? 0)
  + (j.author?.name.length ?? 0) + (j.fields ?? []).reduce((a, f) => a + f.name.length + f.value.length, 0);
const wellFormed = (s) => (typeof s.isWellFormed === 'function'
  ? s.isWellFormed()
  : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s));

console.log('clampText');
test('texto curto não muda', () => assert.equal(clampText('abc', 10), 'abc'));
test('texto exatamente no limite não muda', () => assert.equal(clampText(big(256), 256), big(256)));
test('corta no máximo', () => assert.ok(clampText(big(5000), 256).length <= 256));
test('termina em reticências', () => assert.ok(clampText(big(500), 100).endsWith('…')));
test('null e undefined viram texto vazio', () => { assert.equal(clampText(null, 10), ''); assert.equal(clampText(undefined, 10), ''); });
test('máximo zero, negativo ou inválido vira vazio (nunca fatia com índice negativo)', () => {
  for (const m of [0, -5, NaN, undefined, 'abc']) assert.equal(clampText('abcdef', m), '');
});
test('max menor ou igual às reticências', () => { assert.equal(clampText('abcdef', 1).length, 1); assert.ok(clampText('abcdef', 1).length <= 1); });
test('não parte emoji simples na fronteira', () => {
  for (let n = 90; n < 110; n++) assert.ok(wellFormed(clampText('a'.repeat(n) + '😀'.repeat(20), 100)));
});
test('não parte ZWJ nem bandeira', () => {
  const fam = '👨‍👩‍👧‍👦';
  const flag = '🇧🇷';
  for (let n = 90; n < 110; n++) {
    const r = clampText('a'.repeat(n) + fam.repeat(10) + flag.repeat(10), 100);
    assert.ok(wellFormed(r) && r.length <= 100);
    assert.ok(!/‍…$/.test(r));
  }
});
test('prefere cortar em espaço', () => assert.equal(clampText('palavra '.repeat(30), 50).endsWith(' …'), false));
test('corta em espaço quando ele está nos últimos 20%', () => {
  assert.equal(clampText('aaaa bbbb cccc dddd eeee ffff gggg', 30), 'aaaa bbbb cccc dddd eeee…');
});
test('sem espaço perto do fim, corta seco no orçamento', () => {
  assert.equal(clampText(`ab ${'c'.repeat(60)}`, 20), `ab ${'c'.repeat(16)}…`);
});
test('reticências personalizadas e vazias', () => {
  assert.equal(clampText('abcdefghij', 5, { ellipsis: '' }), 'abcde');
  assert.ok(clampText('abcdefghij', 6, { ellipsis: '...' }).endsWith('...'));
});
test('entrada de 2 MB é cortada rápido', () => {
  const huge = 'palavra '.repeat(300000);
  const t0 = performance.now();
  const r = clampText(huge, 1024);
  assert.ok(r.length <= 1024);
  assert.ok(performance.now() - t0 < 200, `levou ${Math.round(performance.now() - t0)} ms`);
});
test('grafema inicial maior que o orçamento (ZWJ longo) também não deixa meio emoji', () => {
  const zwj = '😀' + '‍😀'.repeat(10);
  for (let max = 3; max < 30; max++) {
    const r = clampText(zwj, max);
    assert.ok(r.length <= max && wellFormed(r), `max=${max}`);
  }
});
test('fuzz determinístico: sempre <= max, nunca meio emoji, nunca termina em ZWJ', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const atoms = ['a', 'b', ' ', '\n', 'ç', 'é', '😀', '👨‍👩‍👧‍👦', '🇧🇷', '1️⃣', '𝒳', '中', '**', '`', ' ', 'palavra', 'x'];
  const gen = (n) => { let s = ''; while (s.length < n) s += atoms[Math.floor(rnd() * atoms.length)]; return s; };
  for (let i = 0; i < 4000; i++) {
    const max = 20 + Math.floor(rnd() * 300);
    const r = clampText(gen(Math.floor(rnd() * 3000)), max);
    assert.ok(r.length <= max, `len ${r.length} > ${max}`);
    assert.ok(wellFormed(r), 'par substituto partido');
    assert.ok(!/‍…$/.test(r), 'ZWJ solto antes das reticências');
  }
});
test('clampContent usa 2000', () => assert.equal(clampContent(big(5000)).length <= 2000, true));

console.log('URLs');
test('isHttpUrl aceita http e https e recusa o resto', () => {
  assert.ok(isHttpUrl('https://exemplo.com/a?b=1'));
  assert.ok(isHttpUrl('http://127.0.0.1:8080/x'));
  for (const bad of ['nao-url', 'ftp://x.com/a', 'javascript:alert(1)', 'https://', 'https://a b.com', '', null, undefined, 42, `https://x.com/${big(2100)}`]) assert.equal(isHttpUrl(bad), false, String(bad).slice(0, 30));
});
test('isAttachmentUrl aceita attachment://arquivo e recusa caminhos e espaços', () => {
  assert.ok(isAttachmentUrl('attachment://image.png'));
  assert.ok(isAttachmentUrl('attachment://draw.png'));
  for (const bad of ['attachment://', 'attachment://a b.png', 'attachment://dir/a.png', 'attachment://..\\x.png', 'https://x.com/a.png', 'attachment:/a.png', null, 3]) assert.equal(isAttachmentUrl(bad), false, String(bad));
});

console.log('makeEmbed');
const e1 = makeEmbed({
  title: big(300), description: big(10000), footer: big(3000), author: big(300), url: 'nao-url', thumbnail: 'foo', image: undefined,
  fields: Array.from({ length: 40 }, (_, i) => ({ name: big(300), value: big(5000), inline: i % 2 === 0 })),
});
test('embed extremo: construtor aceita', () => assert.ok(e1.toJSON()));
test('embed extremo: título <= 256', () => assert.ok(e1.toJSON().title.length <= 256));
test('embed extremo: soma <= 6000', () => assert.ok(size(e1.toJSON()) <= 6000, `soma=${size(e1.toJSON())}`));
test('embed extremo: campos <= 25 e valores <= 1024', () => {
  const f = e1.toJSON().fields ?? [];
  assert.ok(f.length <= 25);
  assert.ok(f.every((x) => x.value.length <= 1024 && x.name.length <= 256));
});
test('url inválida é omitida', () => assert.equal(e1.toJSON().url, undefined));
test('thumbnail inválida é omitida', () => assert.equal(e1.toJSON().thumbnail, undefined));
test('no máximo 25 campos, mesmo pequenos (a soma de 6000 não ajuda aqui)', () => {
  const j = makeEmbed({ title: 't', fields: Array.from({ length: 40 }, (_, i) => ({ name: `n${i}`, value: 'v' })) }).toJSON();
  assert.equal(j.fields.length, 25);
  assert.equal(j.fields[24].name, 'n24');
});
test('campo vazio é descartado', () => {
  assert.equal(makeEmbed({ title: 't', fields: [{ name: 'a', value: '' }, { name: '', value: 'b' }, { name: 'ok', value: 'ok' }] }).toJSON().fields.length, 1);
});
test('entradas vazias, null e undefined não lançam', () => {
  assert.ok(makeEmbed({ title: '', description: undefined, footer: null }).toJSON());
  assert.ok(makeEmbed().toJSON());
  assert.ok(makeEmbed(null).toJSON());
  assert.ok(makeEmbed({ fields: 'não é lista' }).toJSON());
});
test('título só de espaços é omitido', () => assert.equal(makeEmbed({ title: '   ', description: 'x' }).toJSON().title, undefined));
test('segue o corpo enviado ao discord.js', () => {
  const body = MessagePayload.create({ isInteraction: false, isMessage: false, isWebhook: false, options: {}, client: { options: {} }, id: 'x', channel: { id: 'c' } }, { embeds: [e1] }).resolveBody().body;
  assert.ok(size(body.embeds[0]) <= 6000);
});
test('descrição de 4096 exata passa', () => assert.equal(makeEmbed({ description: big(4096) }).toJSON().description.length, 4096));
test('descrição de 4097 vira 4096', () => assert.equal(makeEmbed({ description: big(4097) }).toJSON().description.length, 4096));
test('soma: descrição 4096 + 3 campos de 1024 => <= 6000', () => {
  assert.ok(size(makeEmbed({ description: big(4096), fields: [1, 2, 3].map(() => ({ name: 'n', value: big(1024) })) }).toJSON()) <= 6000);
});
test('soma: sem descrição, campos do fim são descartados', () => {
  const j = makeEmbed({ fields: Array.from({ length: 25 }, (_, i) => ({ name: `n${i}`, value: big(1024) })) }).toJSON();
  assert.ok(size(j) <= 6000);
  assert.equal(j.fields[0].name, 'n0');
});
test('fila do rádio: 150 linhas vira descrição <= 4096', () => {
  const desc = Array.from({ length: 150 }, (_, i) => `**#${i + 1}.** Título longo da música — Artista (3:45)`).join('\n');
  assert.ok(makeEmbed({ description: desc }).toJSON().description.length <= 4096);
});
test('total personalizado é respeitado', () => assert.ok(size(makeEmbed({ description: big(4000), title: 'x' }, { total: 1000 }).toJSON()) <= 1000));

console.log('makeEmbed: attachment:// e formas em objeto (C13)');
test('attachment:// é aceito em image', () => assert.equal(makeEmbed({ title: 't', image: 'attachment://image.png' }).toJSON().image.url, 'attachment://image.png'));
test('attachment:// é aceito em thumbnail', () => assert.equal(makeEmbed({ title: 't', thumbnail: 'attachment://draw.png' }).toJSON().thumbnail.url, 'attachment://draw.png'));
test('image e thumbnail aceitam a forma { url }', () => {
  const j = makeEmbed({ title: 't', image: { url: 'attachment://a.png' }, thumbnail: { url: 'https://x.com/t.png' } }).toJSON();
  assert.equal(j.image.url, 'attachment://a.png');
  assert.equal(j.thumbnail.url, 'https://x.com/t.png');
});
test('attachment:// NÃO vale como link do título (url)', () => assert.equal(makeEmbed({ title: 't', url: 'attachment://a.png' }).toJSON().url, undefined));
test('attachment:// malformado em image é omitido', () => {
  for (const bad of ['attachment://', 'attachment://a b.png', 'attachment://x/y.png']) assert.equal(makeEmbed({ title: 't', image: bad }).toJSON().image, undefined, bad);
});
test('imagem http válida continua aceita; inválida é omitida', () => {
  assert.equal(makeEmbed({ title: 't', image: 'https://x.com/a.png' }).toJSON().image.url, 'https://x.com/a.png');
  assert.equal(makeEmbed({ title: 't', image: 'javascript:alert(1)' }).toJSON().image, undefined);
});
test('footer em objeto com ícone; ícone inválido é omitido', () => {
  const ok = makeEmbed({ footer: { text: 'rodapé', iconURL: 'https://x.com/i.png' } }).toJSON().footer;
  assert.equal(ok.text, 'rodapé');
  assert.equal(ok.icon_url, 'https://x.com/i.png');
  assert.equal(makeEmbed({ footer: { text: 'r', iconURL: 'lixo' } }).toJSON().footer.icon_url, undefined);
});
test('author em objeto com ícone e url', () => {
  const a = makeEmbed({ author: { name: 'Fulano', iconURL: 'attachment://a.png', url: 'https://x.com/u' } }).toJSON().author;
  assert.equal(a.name, 'Fulano');
  assert.equal(a.icon_url, 'attachment://a.png');
  assert.equal(a.url, 'https://x.com/u');
});
test('author em objeto sem nome é omitido', () => assert.equal(makeEmbed({ author: { name: '', iconURL: 'https://x.com/i.png' } }).toJSON().author, undefined));
test('cor: número, hex e inválida', () => {
  assert.equal(makeEmbed({ color: 0xE11D48 }).toJSON().color, 0xE11D48);
  assert.equal(makeEmbed({ color: '#FF0000' }).toJSON().color, 0xFF0000);
  assert.equal(makeEmbed({ color: 0 }).toJSON().color, 0);
  assert.equal(makeEmbed({ color: 'banana' }).toJSON().color, undefined);
  assert.equal(makeEmbed({ color: 99999999 }).toJSON().color, undefined);
});
test('timestamp: Date, true e inválido', () => {
  assert.equal(makeEmbed({ timestamp: new Date('2026-10-14T12:00:00Z') }).toJSON().timestamp, '2026-10-14T12:00:00.000Z');
  assert.ok(typeof makeEmbed({ timestamp: true }).toJSON().timestamp === 'string');
  assert.equal(makeEmbed({ timestamp: 'não é data' }).toJSON().timestamp, undefined);
});
test('retorna EmbedBuilder (compatível com .setFooter etc. depois)', () => {
  const e = makeEmbed({ title: 'a' });
  assert.ok(e instanceof EmbedBuilder);
  e.setFooter({ text: 'ok' });
});
test('fuzz de makeEmbed: sempre dentro dos limites', () => {
  let seed = 777;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const gen = (n) => { let s = ''; while (s.length < n) s += rnd() < 0.2 ? ' ' : (rnd() < 0.1 ? '😀' : 'ab'); return s; };
  for (let i = 0; i < 500; i++) {
    const j = makeEmbed({
      title: gen(400), description: gen(6000), footer: gen(2500), author: gen(300),
      fields: Array.from({ length: Math.floor(rnd() * 40) }, () => ({ name: gen(300), value: gen(1500) })),
    }).toJSON();
    assert.ok(size(j) <= 6000 && (j.fields?.length ?? 0) <= 25 && (j.title?.length ?? 0) <= 256);
  }
});

console.log('embedLength, fitEmbeds');
test('embedLength soma o que o Discord conta', () => {
  const e = makeEmbed({ title: 'abc', description: 'defg', footer: 'hi', author: 'j', fields: [{ name: 'kl', value: 'mno' }] });
  assert.equal(embedLength(e), 3 + 4 + 2 + 1 + 2 + 3);
  assert.equal(embedLength({ title: 'abc' }), 3);
  assert.equal(embedLength(null), 0);
});
const many = Array.from({ length: 12 }, () => makeEmbed({ description: big(1000) }));
test('fitEmbeds respeita 6000 somados', () => {
  const r = fitEmbeds(many);
  assert.ok(r.reduce((a, e) => a + size(e.toJSON()), 0) <= 6000);
  assert.equal(r.length, 6);
});
test('fitEmbeds respeita 10 embeds', () => assert.equal(fitEmbeds(Array.from({ length: 14 }, () => makeEmbed({ title: 'a' }))).length, 10));
test('fitEmbeds aceita JSON simples e entrada inválida', () => {
  assert.equal(fitEmbeds([{ title: 'a' }, { title: 'b' }]).length, 2);
  assert.deepEqual(fitEmbeds(null), []);
});

console.log('clampOptions, chunkLines');
const opts = clampOptions([
  ...Array.from({ length: 40 }, (_, i) => ({ label: big(200), description: big(300), value: `v${i}` })),
  { label: 'dup', value: 'v1' }, { label: '', value: 'vazio' },
]);
test('opções: no máximo 25', () => assert.equal(opts.length, 25));
test('opções: label e descrição <= 100', () => assert.ok(opts.every((o) => o.label.length <= 100 && o.description.length <= 100)));
test('opções: aceitas pelo StringSelectMenuBuilder (valida)', () => {
  const m = new StringSelectMenuBuilder().setCustomId('x').addOptions(opts);
  new ActionRowBuilder().addComponents(m).toJSON();
});
test('opções: valores repetidos e rótulos vazios saem; value é cortado em 100', () => {
  const r = clampOptions([{ label: 'a', value: 'x' }, { label: 'b', value: 'x' }, { label: '', value: 'y' }, { label: 'c', value: big(300) }, null]);
  assert.deepEqual(r.map((o) => o.label), ['a', 'c']);
  assert.equal(r[1].value.length, 100);
});
test('opções: max menor e entrada inválida', () => {
  assert.equal(clampOptions(Array.from({ length: 10 }, (_, i) => ({ label: `l${i}`, value: `v${i}` })), { max: 3 }).length, 3);
  assert.deepEqual(clampOptions(undefined), []);
});
test('chunkLines: nenhum bloco > 1000', () => assert.ok(chunkLines(Array.from({ length: 300 }, (_, i) => `linha ${i} ${big(80)}`)).every((c) => c.length <= 1000)));
test('chunkLines: linha única de 5000 é cortada', () => assert.ok(chunkLines([big(5000)])[0].length <= 1000));
test('chunkLines: não corta uma linha no meio e preserva a ordem', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `item-${i}-${big(60)}`);
  const chunks = chunkLines(lines);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.join('\n').split('\n'), lines);
});
test('chunkLines: lista vazia ou inválida', () => { assert.deepEqual(chunkLines([]), []); assert.deepEqual(chunkLines(null), []); });
test('LIMITS está congelado e com os valores do Discord', () => {
  assert.ok(Object.isFrozen(LIMITS));
  assert.equal(LIMITS.description, 4096);
  assert.equal(LIMITS.fieldValue, 1024);
  assert.equal(LIMITS.embedTotal, 6000);
});

console.log(`\n${passed} ok, ${failures.length} falha(s)`);
if (failures.length) { console.log(`FALHAS: ${failures.join(' | ')}`); process.exit(1); }
