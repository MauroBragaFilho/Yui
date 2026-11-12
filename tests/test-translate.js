// Tradução (MyMemory): pedaços de até 450 caracteres e mensagens de erro da API nunca viram texto. Sem rede. npm run test:translate
import assert from 'node:assert/strict';
const { translateToPortuguese, splitForTranslation, isTranslationApiError, translateDeps, TRANSLATE_CHUNK_MAX } = await import('../src/utils/translate.js');

// divisão em pedaços
assert.deepEqual(splitForTranslation(''), []);
assert.deepEqual(splitForTranslation('  Oi.  '), ['Oi.']);
const frase = 'Get in, get out, and make a killing in this week’s GTA Online Heist Event.';
const longo = Array.from({ length: 12 }, (_, i) => `${frase} (${i})`).join(' ');
const partes = splitForTranslation(longo);
assert.ok(partes.length >= 2 && partes.every((p) => p.length <= TRANSLATE_CHUNK_MAX && p.length > 0), 'todos os pedaços cabem no limite');
assert.equal(partes.join(' '), longo.replace(/\s+/g, ' ').trim(), 'juntar os pedaços reconstrói o texto');
assert.ok(partes.slice(0, -1).every((p) => /[.!?)]$/.test(p)), 'corta no fim de frase');
const semPonto = 'palavra '.repeat(200).trim(); // 1 "frase" de 1599 caracteres
const cortes = splitForTranslation(semPonto);
assert.ok(cortes.length >= 4 && cortes.every((p) => p.length <= TRANSLATE_CHUNK_MAX), 'frase gigante é cortada no espaço');
assert.equal(cortes.join(' '), semPonto);
assert.ok(splitForTranslation('x'.repeat(1300)).every((p) => p.length <= TRANSLATE_CHUNK_MAX), 'sem espaço nenhum: corte seco');

// reconhece as mensagens de erro da API
for (const e of ['QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS', 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY', 'NO QUERY SPECIFIED. EXAMPLE REQUEST: GET?Q=HELLO&LANGPAIR=EN|IT', 'PLEASE SELECT TWO DISTINCT LANGUAGES']) assert.equal(isTranslationApiError(e), true, e);
assert.equal(isTranslationApiError('Destrua o Centro Kortz.'), false);
assert.equal(isTranslationApiError(undefined), false);

// parágrafo longo: a API só recebe pedaços pequenos, e o resultado volta inteiro
const pedidos = [];
translateDeps.get = async (_url, { params }) => {
  pedidos.push(params.q);
  if (params.q.length > 500) return { data: { responseData: { translatedText: 'QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS' }, responseStatus: 403 } };
  return { data: { responseData: { translatedText: `PT[${params.q.slice(0, 12)}]` }, responseStatus: 200 } };
};
const traduzido = await translateToPortuguese(longo);
assert.ok(pedidos.length >= 2 && pedidos.every((q) => q.length <= TRANSLATE_CHUNK_MAX), 'nenhum pedido passa de 450 caracteres');
assert.ok(!/QUERY LENGTH/.test(traduzido) && traduzido.includes('PT['), 'o resultado é tradução, não erro');

// a API devolve mensagem de erro com status 200: vira o original em inglês, nunca o erro
translateDeps.get = async () => ({ data: { responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY. NEXT AVAILABLE IN 05 HOURS' }, responseStatus: 200 } });
assert.equal(await translateToPortuguese('Fresh original sentence one.'), 'Fresh original sentence one.');
// status de erro com texto qualquer: também mantém o original
translateDeps.get = async () => ({ data: { responseData: { translatedText: 'qualquer coisa' }, responseStatus: 429 } });
assert.equal(await translateToPortuguese('Another fresh sentence two.'), 'Another fresh sentence two.');
// erro de rede: mantém o original e não lança
translateDeps.get = async () => { throw new Error('rede fora'); };
assert.equal(await translateToPortuguese('Third fresh sentence three.'), 'Third fresh sentence three.');
// um pedaço falha e os outros traduzem: mistura, sem perder nada
let n = 0;
translateDeps.get = async (_u, { params }) => { n += 1; if (n === 1) throw new Error('timeout'); return { data: { responseData: { translatedText: 'TR:' + params.q.slice(0, 6) }, responseStatus: 200 } }; };
const misto = await translateToPortuguese(`${'Alpha sentence goes here and keeps going for a good while. '.repeat(10)}`.trim());
assert.ok(misto.includes('Alpha sentence') && misto.includes('TR:'), 'o pedaço que falhou fica em inglês e os outros são traduzidos');
// vazio e não texto passam direto
assert.equal(await translateToPortuguese(''), '');
assert.equal(await translateToPortuguese(undefined), undefined);
console.log('test-translate OK');
process.exit(0);
