// Testes do TEXTO do TTS (normalização para fala e divisão em frases), sem rede, sem Discord e sem bancos.
// Cobre: Markdown/Discord/emoji, números por extenso, léxico, divisão em frases, modos de fala,
// a invariante "saída sem dígito nem * _ ~ | < > # { } [ ] @" e entradas patológicas (desempenho).
// Execução: node tests/test-tts-text.js   (npm: test:tts-text)
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { normalizeForSpeech, numberToWordsPt, loadLexicon, setLexiconForTests } from '../src/services/tts/normalize.js';
import { FIXED_PHRASES, splitSentences, splitSentencesRaw, prepareSpeech } from '../src/services/tts/segment.js';
import { getTtsConfig } from '../src/services/tts/config.js';

// O dono ajusta lexicon.pt-BR.json "de ouvido": os testes usam esta CÓPIA fixa (e só o teste de fumaça
// "loadLexicon (arquivo real)" lê o arquivo), assim trocar uma pronúncia não reprova nada aqui.
const TEST_LEXICON = {
  Yui: 'Iúi', Discord: 'Discórdi', Steam: 'Stim', YouTube: 'Iútube', Twitch: 'Tuítch', Spotify: 'Espotifai', Deezer: 'Dízer',
  WhatsApp: 'Uótsapi', TikTok: 'Tique toque', Google: 'Gúgol', Windows: 'Uíndous', Nvidia: 'Envídia', AMD: 'á ême dê',
  RTX: 'érre tê xis', GTX: 'gê tê xis', GPU: 'gê pê u', CPU: 'cê pê u', API: 'á pê i', PC: 'pê cê', GTA: 'gê tê á',
  FPS: 'éfe pê ésse', RPG: 'érre pê gê', NPC: 'ene pê cê', PVP: 'pê vê pê', DLC: 'dê éle cê', SSD: 'ésse ésse dê',
  HDD: 'agá dê dê', HD: 'agá dê', USB: 'u ésse bê', URL: 'u érre éle', TV: 'tê vê', IA: 'i á', UI: 'u i', OK: 'okei',
  WiFi: 'uaifai', 'Wi-Fi': 'uaifai',
};
setLexiconForTests(TEST_LEXICON);

let passed = 0;
let failed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FALHA  ${name}\n      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

const cfg = getTtsConfig({}); // padrões: 220 / 3 / 160
const norm = (s, o) => normalizeForSpeech(s, o);
const say = (s, o) => normalizeForSpeech(s, o).text;
const cp = (...codes) => String.fromCodePoint(...codes); // caracteres invisíveis são montados por código
const KEYCAP = (c) => c + cp(0xfe0f, 0x20e3);
const flagsOf = (r) => Object.entries(r.flags).filter(([, v]) => v).map(([k]) => k).sort();

/** Tabela entrada -> saída: cada linha é um caso. */
function table(title, rows, opts) {
  for (const [input, expected] of rows) {
    test(`${title}: ${JSON.stringify(input).slice(0, 70)}`, () => assert.equal(say(input, opts), expected));
  }
}

// Invariante da saída: nunca dígito (de nenhum alfabeto) nem símbolo que o sintetizador leria.
const FORBIDDEN = /[*_~|<>#{}[\]@`$%\\/^=+&]/u;
function assertClean(text, label = '') {
  assert.equal(typeof text, 'string', `${label} não é string`);
  assert.ok(!/\p{N}/u.test(text), `${label} tem dígito: ${JSON.stringify(text.slice(0, 80))}`);
  assert.ok(!FORBIDDEN.test(text), `${label} tem símbolo proibido: ${JSON.stringify(text.slice(0, 80))}`);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(text), `${label} tem caractere de controle`);
  assert.ok(!/\p{Extended_Pictographic}/u.test(text), `${label} tem emoji`);
  assert.ok(text === text.trim() && !/ {2}/.test(text), `${label} tem espaço sobrando: ${JSON.stringify(text.slice(0, 80))}`);
}

console.log('\n== Markdown, Discord, links, emoji ==');
table('markdown', [
  ['**negrito** e *itálico* e __sublinhado__ e ~~riscado~~ e `código`', 'negrito e itálico e sublinhado e riscado e código'],
  ['Isto é ***muito*** importante', 'Isto é muito importante'],
  ['> citação importante aqui', 'citação importante aqui'],
  ['# Título\ntexto', 'Título. Texto'],
  ['## Subtítulo\n\nParágrafo um.\n\nParágrafo dois.', 'Subtítulo. Parágrafo um. Parágrafo dois.'],
  ['-# Pedido por fulano\nTexto normal.', 'Texto normal.'],
  ['Resposta curta.\n-# rodapé que não se fala', 'Resposta curta.'],
  ['Hashtag #yui e #123', 'Hashtag Iúi e cento e vinte e três'],
]);
test('spoiler some e marca hadSpoiler', () => {
  const r = norm('O final é ||ele morre|| mesmo.');
  assert.equal(r.text, 'O final é mesmo.');
  assert.deepEqual(flagsOf(r), ['hadSpoiler']);
});
test('spoiler aberto (||) sem fechar não derruba nada e não marca', () => {
  const r = norm('Isso || aquilo');
  assert.equal(r.text, 'Isso aquilo');
  assert.deepEqual(flagsOf(r), []);
});
test('bloco de código some e marca hadCode', () => {
  const r = norm('Use isto:\n```js\nconsole.log(1)\n```\nPronto.');
  assert.equal(r.text, 'Use isto: Pronto.');
  assert.deepEqual(flagsOf(r), ['hadCode']);
});
test('cerca de código sem fechar: o resto é código', () => {
  const r = norm('Veja:\n```py\nprint(1)\nprint(2)');
  assert.equal(r.text, 'Veja:');
  assert.deepEqual(flagsOf(r), ['hadCode']);
});
test('código em uma linha só (```x```) também some', () => {
  const r = norm('Rode ```ls -la``` e pronto');
  assert.ok(!/ls|la/.test(r.text.replace('pronto', '')), r.text);
  assert.deepEqual(flagsOf(r), ['hadCode']);
});
test('lista com 3+ itens marca hadList e cada item vira uma frase', () => {
  const r = norm('- um\n- dois\n- três');
  // A 1ª linha fica como veio; as seguintes abrem frase nova e começam em maiúscula.
  assert.equal(r.text, 'um. Dois. Três');
  assert.deepEqual(flagsOf(r), ['hadList']);
  assert.equal(norm('1. primeiro\n2. segundo\n3. terceiro\n4. quarto').text, 'primeiro. Segundo. Terceiro. Quarto');
  assert.equal(norm('* a\n* b\n* c').text, 'a. B. C');
});
test('lista com só 2 itens NÃO marca hadList', () => {
  const r = norm('- um\n- dois');
  assert.deepEqual(flagsOf(r), []);
});
test('negrito com asterisco colado não é lista', () => {
  const r = norm('**um**\n**dois**\n**três**');
  assert.deepEqual(flagsOf(r), []);
});
test('link markdown vira o texto e marca hadLink', () => {
  const r = norm('Clique em [este site](https://exemplo.com/a) para ver');
  assert.equal(r.text, 'Clique em este site para ver');
  assert.deepEqual(flagsOf(r), ['hadLink']);
});
test('imagem markdown some inteira', () => {
  const r = norm('Olha ![foto do gato](https://x.com/g.png) que fofo');
  assert.equal(r.text, 'Olha que fofo');
});
test('URL solta some (a pontuação final da frase fica) e marca hadLink', () => {
  const r = norm('Veja https://exemplo.com/pagina?x=1 agora.');
  assert.equal(r.text, 'Veja agora.');
  assert.deepEqual(flagsOf(r), ['hadLink']);
  assert.equal(say('Acesse www.exemplo.com.br/teste, ou não.'), 'Acesse, ou não.');
  assert.equal(say('Fale em (https://a.com/b).'), 'Fale em.');
  assert.equal(say('<https://a.com/b> e **https://c.com/d**'), 'e');
});

console.log('\n== Menções e marcações do Discord ==');
const names = { user: 'Maria', role: 'Admins', channel: 'geral' };
const resolver = (id, kind) => names[kind];
table('menção', [
  ['<@123> disse oi', 'disse oi'],
  ['<@!123> disse oi', 'disse oi'],
  ['@everyone atenção, @here também', 'atenção, também'],
  ['Olha <:pepe:123456789> e <a:dance:99887766> hein', 'Olha e hein'],
  ['Marcado <t:1700000000:R> ou <t:1700000000>', 'Marcado ou'],
]);
table('menção com resolvedor', [
  ['<@123> disse oi', 'Maria disse oi'],
  ['<@!123> disse oi', 'Maria disse oi'],
  ['Oi <@1>, <@&2> e <#3>!', 'Oi Maria, Admins e geral!'],
], { resolveMention: resolver });
test('resolvedor recebe (id, tipo)', () => {
  const seen = [];
  say('<@111> <@&222> <#333>', { resolveMention: (id, kind) => { seen.push([id, kind]); return 'x'; } });
  assert.deepEqual(seen, [['111', 'user'], ['222', 'role'], ['333', 'channel']]);
});
test('resolvedor que lança, devolve Promise, objeto, número ou nada: a menção some', () => {
  for (const fn of [() => { throw new Error('boom'); }, () => Promise.resolve('Ana'), () => ({ a: 1 }), () => 42, () => null, () => undefined, () => '']) {
    assert.equal(say('Oi <@1> tchau', { resolveMention: fn }), 'Oi tchau');
  }
  assert.equal(say('Oi <@1> tchau', { resolveMention: 'não é função' }), 'Oi tchau');
});
test('apelido hostil: só letras, números e espaço, no máximo 24 caracteres', () => {
  const hostile = '@everyone [evil](http://x.com) ' + cp(0x1f525) + ' <@123> {ignore} ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const out = say('Oi <@1>!', { resolveMention: () => hostile });
  assertClean(out, 'apelido');
  assert.match(out, /^Oi [\p{L} ]+!$/u);
  const name = out.slice(3, -1);
  assert.ok(name.length <= 24, `nome com ${name.length} caracteres: ${name}`);
  // Sem dígitos o corte é exatamente em 24 caracteres.
  assert.equal(say('Oi <@1>!', { resolveMention: () => 'Maria da Silva Pereira Santos Oliveira Souza' }), 'Oi Maria da Silva Pereira S!');
  assert.equal(say('Oi <@1>!', { resolveMention: () => '[' + cp(0x1f480) + ']@Ze<>{}' }), 'Oi Ze!');
  assert.equal(say('Oi <@1>!', { resolveMention: () => 'Zé123' }), 'Oi Zé cento e vinte e três!');
  assert.equal(say('Oi <@1>!', { resolveMention: () => '*_~|<>#{}[]@' }), 'Oi!');
});
test('apelido de 1 MB não pesa nem vaza', () => {
  const t0 = performance.now();
  const out = say('Oi <@1>!', { resolveMention: () => 'a'.repeat(1 << 20) });
  assert.ok(performance.now() - t0 < 200);
  assert.ok(out.length <= 'Oi !'.length + 24);
});
test('o apelido não vira marcação de nada (nome com "||" e "```")', () => {
  const out = say('A <@1> chegou <@2> aqui', { resolveMention: (id) => (id === '1' ? '||spoiler||' : '```code```') });
  assertClean(out, 'apelido-md');
  assert.equal(out, 'A spoiler chegou code aqui');
});

console.log('\n== Emoji ==');
test('emoji Unicode (tom de pele, bandeira, coração, família, sequência ZWJ) somem', () => {
  const heart = cp(0x2764, 0xfe0f);
  const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  assert.equal(say(`Oi ${cp(0x1f44b, 0x1f3fd)} tudo bem ${heart} ${cp(0x1f1e7, 0x1f1f7)} ${family} fim`), 'Oi tudo bem fim');
  assert.equal(say(cp(0x1f600, 0x1f600) + 'legal' + cp(0x1f44d)), 'legal');
  assert.equal(say(`texto${cp(0x1f600)}colado`), 'texto colado');
});
test('caracteres invisíveis (largura zero, hífen suave, direção) somem sem partir a palavra', () => {
  assert.equal(say('ol' + cp(0x200b) + 'á ' + cp(0x00ad) + 'mun' + cp(0x202e) + 'do'), 'olá mundo');
  assert.equal(say(cp(0xfeff) + 'início'), 'início');
});
test('keycap: o dígito é tratado ANTES da conversão de números (vira palavra solta)', () => {
  assert.equal(say(`${KEYCAP('1')} primeiro ${KEYCAP('2')} segundo ${KEYCAP('3')} terceiro`), 'um primeiro dois segundo três terceiro');
  assert.equal(say(`${KEYCAP('1')}${KEYCAP('2')}`), 'um dois'); // não vira "doze"
  assert.equal(say(`ligue ${KEYCAP('#')} e ${KEYCAP('*')} agora`), 'ligue e agora');
  assert.equal(say(`${KEYCAP('0')}${KEYCAP('9')}`), 'zero nove');
});
test('U+20E3 e FE0F soltos são removidos', () => {
  const out = say('a' + cp(0x20e3) + 'b ' + cp(0xfe0f) + 'c');
  assert.equal(out, 'a b c');
});
test('símbolos { } [ ] @ são removidos antes de sintetizar', () => {
  assert.equal(say('usa {chaves} [colchetes] e @alguem'), 'usa chaves colchetes e alguem');
  assert.equal(say('fulano@exemplo.com'), 'fulano exemplo.com');
});
test('setas e operadores viram pausa ou palavra, nunca símbolo', () => {
  assert.equal(say('A -> B => C'), 'A, B, C');
  assert.equal(say('rock & roll'), 'rock e roll');
  assert.equal(say('2+2=4'), 'dois mais dois igual a quatro');
});

console.log('\n== Números por extenso ==');
table('número', [
  ['0', 'zero'], ['1', 'um'], ['2', 'dois'], ['10', 'dez'], ['14', 'catorze'], ['16', 'dezesseis'], ['19', 'dezenove'],
  ['20', 'vinte'], ['21', 'vinte e um'], ['99', 'noventa e nove'], ['100', 'cem'], ['101', 'cento e um'],
  ['110', 'cento e dez'], ['200', 'duzentos'], ['999', 'novecentos e noventa e nove'],
  ['1000', 'mil'], ['1001', 'mil e um'], ['1100', 'mil e cem'], ['1101', 'mil cento e um'], ['2026', 'dois mil e vinte e seis'],
  ['10000', 'dez mil'], ['100000', 'cem mil'], ['101000', 'cento e um mil'], ['999999', 'novecentos e noventa e nove mil novecentos e noventa e nove'],
  ['1.000', 'mil'], ['1.234', 'mil duzentos e trinta e quatro'], ['12.345', 'doze mil trezentos e quarenta e cinco'],
  ['1.000.000', 'um milhão'], ['2.000.000', 'dois milhões'], ['1.000.001', 'um milhão e um'], ['1.200.000', 'um milhão e duzentos mil'],
  ['1.234.567', 'um milhão duzentos e trinta e quatro mil quinhentos e sessenta e sete'],
  ['1.000.000.000', 'um bilhão'], ['2.001.000', 'dois milhões e mil'],
  ['999.999.999.999', 'novecentos e noventa e nove bilhões novecentos e noventa e nove milhões novecentos e noventa e nove mil novecentos e noventa e nove'],
  ['3,14', 'três vírgula catorze'], ['0,5', 'zero vírgula cinco'], ['2,05', 'dois vírgula zero cinco'],
  ['1.234,56', 'mil duzentos e trinta e quatro vírgula cinquenta e seis'], ['3,14159', 'três vírgula um quatro um cinco nove'],
  ['3.14', 'três vírgula catorze'], ['1.2.3', 'um ponto dois ponto três'], ['10, 20, 30', 'dez, vinte, trinta'],
  ['-5', 'menos cinco'], ['+3', 'mais três'],
]);
table('dinheiro', [
  ['R$ 5,20', 'cinco reais e vinte centavos'], ['R$ 1,00', 'um real'], ['R$ 1', 'um real'], ['R$ 0,50', 'cinquenta centavos'],
  ['R$ 0,01', 'um centavo'], ['R$ 1.234,56', 'mil duzentos e trinta e quatro reais e cinquenta e seis centavos'],
  ['R$5', 'cinco reais'], ['R$ 10,5', 'dez reais e cinquenta centavos'], ['R$ 1.000', 'mil reais'], ['R$ 2.000.000', 'dois milhões de reais'],
  ['R$ 5 mil', 'cinco mil reais'], ['R$ 1 mil', 'mil reais'], ['R$ 2 milhões', 'dois milhões de reais'], ['R$ 1 milhão', 'um milhão de reais'],
  ['US$ 10', 'dez dólares'], ['US$ 1', 'um dólar'], ['$5', 'cinco dólares'], ['$1,234.56', 'mil duzentos e trinta e quatro dólares e cinquenta e seis centavos'],
  ['€ 3,50', 'três euros e cinquenta centavos'], ['10€', 'dez euros'], ['10 €', 'dez euros'], ['£ 2', 'duas libras'], ['£ 1', 'uma libra'],
  ['£ 2,50', 'duas libras e cinquenta centavos'],
  ['custa R$ 5,20.', 'custa cinco reais e vinte centavos.'],
  ['R$ 49,90/mês', 'quarenta e nove reais e noventa centavos por mês'], ['R$ 1,00/h', 'um real por h'],
]);
table('porcentagem, ordinal, hora, data', [
  ['50%', 'cinquenta por cento'], ['12,5%', 'doze vírgula cinco por cento'], ['1 %', 'um por cento'], ['100%', 'cem por cento'],
  ['1º', 'primeiro'], ['2º', 'segundo'], ['3ª', 'terceira'], ['10º', 'décimo'], ['11º', 'décimo primeiro'], ['21º', 'vigésimo primeiro'],
  ['100º', 'centésimo'], ['123º', 'centésimo vigésimo terceiro'], ['9ª vez', 'nona vez'], ['1° lugar', 'primeiro lugar'],
  ['2° fase', 'segunda fase'], ['30°', 'trinta graus'], ['1°', 'um grau'], ['nº 5', 'número cinco'], ['Nº5', 'número cinco'],
  ['14h30', 'catorze e trinta'], ['14:30', 'catorze e trinta'], ['14h', 'catorze horas'], ['14:00', 'catorze horas'],
  ['1h', 'uma hora'], ['2h', 'duas horas'], ['21h', 'vinte e uma horas'], ['1:05', 'uma e cinco'], ['2:30', 'duas e trinta'],
  ['24h', 'vinte e quatro horas'], ['100h', 'cem horas'], ['8h15min', 'oito e quinze'],
  ['14/10/2026', 'catorze de outubro de dois mil e vinte e seis'], ['1/10/2026', 'primeiro de outubro de dois mil e vinte e seis'],
  ['25/12/99', 'vinte e cinco de dezembro de mil novecentos e noventa e nove'], ['2026-10-14', 'catorze de outubro de dois mil e vinte e seis'],
  ['31/12/2026', 'trinta e um de dezembro de dois mil e vinte e seis'],
  ['Às 14h30 do dia 14/10/2026', 'Às catorze e trinta do dia catorze de outubro de dois mil e vinte e seis'],
  ['1/2', 'um meio'], ['3/4', 'três quartos'], ['24/7', 'vinte e quatro por sete'], ['1920x1080', 'mil novecentos e vinte por mil e oitenta'],
  ['5v5', 'cinco contra cinco'],
]);
table('unidades', [
  ['16 GB', 'dezesseis gigabytes'], ['16GB', 'dezesseis gigabytes'], ['1 GB', 'um gigabyte'], ['512 MB', 'quinhentos e doze megabytes'],
  ['2 TB', 'dois terabytes'], ['60 FPS', 'sessenta quadros por segundo'], ['144fps', 'cento e quarenta e quatro quadros por segundo'],
  ['3,5 GHz', 'três vírgula cinco gigahertz'], ['4.2GHz', 'quatro vírgula dois gigahertz'], ['10 km', 'dez quilômetros'], ['1 km', 'um quilômetro'],
  ['5kg', 'cinco quilos'], ['250g', 'duzentos e cinquenta gramas'], ['2m', 'dois metros'], ['100 ms', 'cem milissegundos'],
  ['30°C', 'trinta graus Celsius'], ['100 km/h', 'cem quilômetros por hora'], ['5 min', 'cinco minutos'], ['50 m²', 'cinquenta metros quadrados'],
  ['100 mbps', 'cem megabits por segundo'], ['2 L', 'dois L'], // uma letra só vale colada: "2 L" é ambíguo
  ['2 GB/mês', 'dois gigabytes por mês'], ['e/ou', 'e ou'], ['2x mais rápido', 'duas vezes mais rápido'], ['1x', 'uma vez'],
  ['3 x 4', 'três x quatro'],
]);
table('concordância de gênero', [
  ['1 hora', 'uma hora'], ['2 horas', 'duas horas'], ['2 pessoas', 'duas pessoas'], ['21 vezes', 'vinte e uma vezes'],
  ['1 semana', 'uma semana'], ['2 semanas', 'duas semanas'], ['2.000 músicas', 'duas mil músicas'], ['201 faixas', 'duzentas e uma faixas'],
  ['3 pessoas', 'três pessoas'], ['2 homens', 'dois homens'], ['2 mensagens', 'duas mensagens'], ['200 pessoas', 'duzentas pessoas'],
]);
table('letras e números juntos, formas estranhas', [
  ['H2O', 'H dois O'], ['COVID-19', 'COVID dezenove'], ['GTA5', 'Gê tê á cinco'], ['RTX 4060', 'Érre tê xis quatro mil e sessenta'],
  ['007', 'zero zero sete'], ['0123', 'zero um dois três'], ['1234567890123', 'um dois três quatro cinco seis sete oito nove zero um dois três'],
  ['1.234,5,6', 'um, duzentos e trinta e quatro, cinco, seis'], // forma sem sentido: lê como lista
  ['½ xícara', 'um meio xícara'], // (antes esta linha estava dentro do comentário acima e nunca rodava)
  [cp(0x663) + cp(0x661), 'trinta e um'], // dígitos arábico-índicos (٣١)
  [cp(0xff11, 0xff12, 0xff13), 'cento e vinte e três'], // largura total (１２３)
  ['x²', 'x ao quadrado'], ['soma º e ª soltos', 'soma e soltos'], ['R$ sem valor', 'reais sem valor'], ['10% de 5€', 'dez por cento de cinco euros'],
]);

console.log('\n== Léxico, abreviações, risadas ==');
table('léxico', [
  ['A GPU e a CPU do PC', 'A gê pê u e a cê pê u do pê cê'],
  ['gpu GPU Gpu', 'Gê pê u gê pê u gê pê u'], // maiúscula só no começo da frase (o divisor de frases depende dela)
  ['GPUs e GPU-based', 'GPUs e gê pê u-based'],
  ['A Yui no YouTube e no Discord e na Steam', 'A Iúi no Iútube e no Discórdi e na Stim'],
  ['API, FPS, RPG, SSD, USB, URL', 'Á pê i, éfe pê ésse, érre pê gê, ésse ésse dê, u ésse bê, u érre éle'],
  ['GTA é legal', 'Gê tê á é legal'],
  ['Isso é bom. GPU é caro.', 'Isso é bom. Gê pê u é caro.'],
  ['Ele ia sair e a IA também', 'Ele ia sair e a i á também'], // "ia" (verbo) não é trocado; só "IA" em maiúsculas
  ['ui que susto, UI nova', 'ui que susto, u i nova'],
  ['Use o Wi-Fi', 'Use o uaifai'],
]);
test('léxico personalizado: palavra inteira, sem diferenciar maiúsculas', () => {
  const lexicon = { Foo: 'fú', 'bar-baz': 'barbás', _comentario: 'ignorado', ruim: 12, 'a b': 'x', '': 'y' };
  assert.equal(say('foo FOO Foo foobar xfoo', { lexicon }), 'Fú fú fú foobar xfoo');
  assert.equal(say('um bar-baz aqui', { lexicon }), 'um barbás aqui');
  assert.equal(say('ruim a b comentario', { lexicon }), 'ruim a b comentario'); // valor inválido, chave com espaço e chave "_" não valem
  assert.equal(say('GPU', { lexicon: {} }), 'GPU'); // léxico vazio: nada é trocado
});
test('léxico: chaves como "constructor" não alcançam o protótipo', () => {
  assert.equal(say('constructor toString __proto__ hasOwnProperty'), 'constructor toString proto hasOwnProperty');
});
test('loadLexicon (arquivo real, teste de fumaça): lê o JSON, cache, sem comentários e sem pronúncia perigosa', () => {
  setLexiconForTests(null); // volta a ler o arquivo de verdade
  try {
    const a = loadLexicon();
    const b = loadLexicon();
    assert.equal(a, b);
    assert.ok(!Object.keys(a).some((k) => k.startsWith('_')));
    assert.ok(Object.values(a).every((v) => typeof v === 'string' && !/[0-9*_~|<>#{}[\]@]/.test(v)), 'pronúncias sem dígitos nem símbolos');
    const c = loadLexicon({ force: true });
    assert.deepEqual({ ...c }, { ...a });
  } finally {
    setLexiconForTests(TEST_LEXICON);
  }
});
test('setLexiconForTests: troca o léxico usado por padrão e null volta ao arquivo', () => {
  setLexiconForTests({ Zeta: 'zêta' });
  try {
    assert.equal(say('o Zeta e a GPU'), 'o zêta e a GPU');
  } finally {
    setLexiconForTests(TEST_LEXICON);
  }
  assert.equal(say('a GPU'), 'a gê pê u');
});
table('abreviações', [
  ['Dr. Silva chegou', 'Doutor Silva chegou'], ['o dr. Silva', 'o doutor Silva'], ['Dra. Ana e Sr. João e Sra. Maria', 'Doutora Ana e Senhor João e Senhora Maria'],
  ['Prof. Pedro', 'Professor Pedro'], ['frutas, legumes, etc. Depois', 'frutas, legumes, etcétera. Depois'], ['maçã, pera etc.', 'maçã, pera etcétera.'],
  ['etc. e tal', 'etcétera e tal'], ['p.ex. isto', 'por exemplo isto'], ['vc tb pq blz', 'Você também porque beleza'], ['Vc viu? Msg nova', 'Você viu? Mensagem nova'],
  ['Mto bom, vlw', 'Muito bom, valeu'], ['TB de memória', 'TB de memória'], ['2 TB de memória', 'dois terabytes de memória'],
  ['kkkkk', ''], ['KKK que isso', 'que isso'], ['rsrs verdade', 'verdade'], ['hahaha', ''], ['hehe ok', 'okei'], ['kk rs', ''],
  ['Moro no RS', 'Moro no RS'], ['sim kkkk não', 'sim não'],
]);

console.log('\n== numberToWordsPt ==');
const nw = [
  [0, 'zero'], [1, 'um'], [9, 'nove'], [15, 'quinze'], [30, 'trinta'], [42, 'quarenta e dois'], [100, 'cem'], [115, 'cento e quinze'],
  [999, 'novecentos e noventa e nove'], [1000, 'mil'], [1500, 'mil e quinhentos'], [1999, 'mil novecentos e noventa e nove'],
  [20000, 'vinte mil'], [100000, 'cem mil'], [1000000, 'um milhão'], [1000000000, 'um bilhão'], [2500000, 'dois milhões e quinhentos mil'],
  [12345678, 'doze milhões trezentos e quarenta e cinco mil seiscentos e setenta e oito'],
  [999999999999, 'novecentos e noventa e nove bilhões novecentos e noventa e nove milhões novecentos e noventa e nove mil novecentos e noventa e nove'],
  [-5, 'menos cinco'], [3.99, 'três'], [2n, 'dois'], ['0042', 'zero zero quatro dois'], ['21', 'vinte e um'],
  [1000000000000, 'um zero zero zero zero zero zero zero zero zero zero zero zero'], [1e21, 'um zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero zero'],
  [NaN, ''], [Infinity, ''], ['abc', ''], [null, ''],
];
for (const [input, expected] of nw) {
  test(`numberToWordsPt(${typeof input === 'string' ? JSON.stringify(input) : String(input)})`, () => assert.equal(numberToWordsPt(input), expected));
}
const fem = [[1, 'uma'], [2, 'duas'], [3, 'três'], [21, 'vinte e uma'], [22, 'vinte e duas'], [200, 'duzentas'], [201, 'duzentas e uma'],
  [2000, 'duas mil'], [21000, 'vinte e uma mil'], [200000, 'duzentas mil'], [1000, 'mil'], [1000002, 'um milhão e duas'], [2000000, 'dois milhões'], [100, 'cem'], [101, 'cento e uma']];
for (const [input, expected] of fem) {
  test(`numberToWordsPt(${input}, feminino)`, () => assert.equal(numberToWordsPt(input, { gender: 'f' }), expected));
}
test('numberToWordsPt: todos os inteiros de 0 a 3000 geram palavras sem dígito e sem repetir o mesmo texto', () => {
  const seen = new Set();
  for (let i = 0; i <= 3000; i++) {
    const w = numberToWordsPt(i);
    assert.ok(w && !/\d/.test(w), `${i} -> ${w}`);
    assert.ok(!seen.has(w), `${i} repetido: ${w}`);
    seen.add(w);
  }
});

console.log('\n== Invariante: sem dígito e sem * _ ~ | < > # { } [ ] @ ==');
const HANDMADE = [
  '', ' ', '\n\n\n', '0', '1234567890', '*_~|<>#{}[]@', '**bold** __under__ ~~strike~~ ||spoiler|| `code` ```block```',
  '<@1><@!2><@&3><#4><t:5:R><:a:6><a:b:7>@everyone@here', '[a](b) [c](d)(e) ![i](j)', 'R$ US$ $ € £ % ° º ª ² ³ ½',
  'a'.repeat(5000), '9'.repeat(5000), '1.'.repeat(3000), '(((((((((((', ')))))))))', '[[[[[[]]]]]]', '{{{{}}}}', '<<<<>>>>',
  '#'.repeat(100) + ' titulo', '-# footer\n-# footer 2', '> > > quote', '- - - - -', '1. 2. 3. 4.', '\t\t\ttab\t', '\r\n\r\n',
  'http://', 'https://x', 'www.', 'a@b.c', 'a@@b', '@@@', '@everyone@everyone', '||||||||', '| | | |', '``````', '` ` `',
  '14:30:15', '99:99', '99h99', '32/13/2026', '00/00/0000', '1/0', '0/0', '9999999999999999999999', '1e308', '0.0.0.0', '1.2.3.4.5.6.7.8',
  '١٢٣٤٥٦٧٨٩٠', '１２３４５６', '①②③', 'Ⅻ', '٣٫١٤', 'x²y³', '½¼¾⅓⅔', cp(0x1d7ce, 0x1d7cf, 0x1d7ff), cp(0x0ed0, 0x0ed9),
  KEYCAP('1') + KEYCAP('#') + KEYCAP('*') + cp(0x20e3, 0xfe0f), cp(0xd83d), cp(0xde00), cp(0xd83d) + 'a', 'a' + cp(0xde00),
  cp(0x1f600).repeat(500), cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466), cp(0xe0067, 0xe0062, 0xe0065),
  'Dr. Dr. Dr.', 'etc. etc. etc.', 'p.ex.p.ex.', 'kkkkkkkkkk rsrsrsrs hahahaha', 'ia IA ia IA', 'GPU-GPU-GPU', 'a-b-c-d', '-----', '- - -',
  '...', '!!!???', '?!?!', ',,,', ';;;', ':::', '. . .', '  .  ,  ', 'Olá!!!!!!!!!! Tudo bem????',
];
for (const [i, input] of HANDMADE.entries()) {
  test(`invariante, caso manual ${i}: ${JSON.stringify(input.slice(0, 30))}`, () => {
    const r = norm(input, { resolveMention: () => '1 2 3 @x' });
    assertClean(r.text, `caso ${i}`);
    for (const flag of Object.values(r.flags)) assert.equal(typeof flag, 'boolean');
    const p = prepareSpeech(r, cfg);
    for (const s of p.sentences) assertClean(s, `frase do caso ${i}`);
  });
}

// Gerador pseudoaleatório com semente fixa (mulberry32): mesmo resultado em qualquer máquina.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PIECES = [
  'a', 'b', 'Z', 'ã', 'ç', 'é', 'Olá', 'tudo', 'bem', 'de', 'e', 'x', 'v', 'h', 'k', ' ', ' ', ' ', '  ', '\n', '\n\n', '\t', '. ', '! ', '? ', ', ', ': ', '; ', '...', '…',
  '0', '1', '7', '9', '12', '345', '2026', '1.000', '1.234.567', '3,14', '1.234,56', '0,05', '007', '99999999999999', 'R$ ', 'R$', 'US$', '$', '€', '£', '%', ' %', 'º', 'ª', '°', '°C', ' kg', ' GB', 'GB', 'fps', ' FPS', ' km/h',
  'h', 'h30', ':', '14:30', '25:61', '14/10/2026', '31/02/2026', '/', '1/2', '-', '--', ' - ', '_', '__', '*', '**', '***', '~', '~~', '|', '||', '`', '```', '#', '##', '-# ', '> ', '>', '<', '<@', '<@123>', '<@!4>', '<@&9>', '<#5>', '<:e:1>', '<t:1:R>', '@everyone', '@here', '@', '{', '}', '[', ']',
  '[x](http://a.b)', '[y](', '](', '![z](http://a.b/c.png)', '(', ')', 'http://x.y/z', 'https://a.b/c?d=1', 'www.c.d', 'ftp://q',
  cp(0x1f600), cp(0x1f1e7, 0x1f1f7), cp(0x1f44d, 0x1f3fd), cp(0x2764, 0xfe0f), KEYCAP('1'), KEYCAP('#'), cp(0x200b), cp(0x202e), cp(0xfeff), cp(0xd83d), cp(0x663, 0x661), cp(0xff11), '²', '³', '½', '①',
  'kk', 'kkkk', 'rsrs', 'hahaha', 'Dr.', 'Sra.', 'etc.', 'p.ex.', 'vc', 'tb', 'GPU', 'Yui', 'YouTube', 'ia', 'IA', 'Nº ', 'nº', '1ª', '2º', '10°', '1° lugar', '5v5', '1920x1080', '& ', '+', '=', '\\', '^',
];
test('invariante com 6000 entradas pseudoaleatórias (semente fixa) em normalize + segment', () => {
  const rnd = mulberry32(20261014);
  const pick = () => PIECES[Math.floor(rnd() * PIECES.length)];
  let withText = 0;
  for (let i = 0; i < 6000; i++) {
    const n = 1 + Math.floor(rnd() * 40);
    let input = '';
    for (let k = 0; k < n; k++) input += pick();
    const r = norm(input, { resolveMention: (id) => (rnd() < 0.5 ? null : `n${id} @x [y]`) });
    assertClean(r.text, `aleatório ${i} (${JSON.stringify(input.slice(0, 60))})`);
    const p = prepareSpeech(r, cfg);
    assert.ok(['full', 'truncated', 'pointer', 'none'].includes(p.mode), `modo ${p.mode}`);
    assert.ok(p.sentences.length <= cfg.maxSentences + 2, `frases demais: ${p.sentences.length}`);
    const spoken = p.sentences.filter((s) => s !== FIXED_PHRASES.rest && s !== FIXED_PHRASES.details);
    assert.ok(spoken.length <= cfg.maxSentences, `frases faladas demais: ${spoken.length}`);
    assert.ok(spoken.join(' ').length <= cfg.maxChars, `fala com ${spoken.join(' ').length} caracteres`);
    for (const s of p.sentences) {
      assertClean(s, `frase ${i}`);
      assert.ok(s.length > 0 && s.length <= cfg.maxChars, `frase com ${s.length} caracteres`);
    }
    if (p.mode === 'none') assert.equal(p.sentences.length, 0);
    else assert.ok(p.sentences.length > 0);
    if (r.text) withText++;
    // Determinismo: a mesma entrada dá a mesma saída (sem estado escondido entre chamadas).
    if (i % 500 === 0) assert.deepEqual(norm(input), norm(input));
  }
  assert.ok(withText > 3000, `poucos casos com texto (${withText}): o gerador está fraco`);
});

console.log('\n== Divisão em frases ==');
const SENT = 'Esta é uma frase de teste com tamanho razoável para falar.';
test('"Dr. Silva" não divide frase (guarda de abreviação, medida sem a junção de curtos)', () => {
  assert.deepEqual(splitSentencesRaw('Dr. Silva chegou. Ele saiu.'), ['Dr. Silva chegou.', 'Ele saiu.']);
  assert.deepEqual(splitSentencesRaw('Falei com a Sra. Maria e com o Prof. Pedro. Depois fui embora.'), ['Falei com a Sra. Maria e com o Prof. Pedro.', 'Depois fui embora.']);
  assert.deepEqual(splitSentencesRaw('Fui com J. Silva ao cinema. Foi bom.'), ['Fui com J. Silva ao cinema.', 'Foi bom.']);
});
test('duas frases de tamanho normal viram 2 frases (e "Dr." não corta)', () => {
  const out = splitSentences('O Dr. Silva chegou ao evento ontem à noite. Ele saiu cedo para casa depois.', cfg);
  assert.deepEqual(out, ['O Dr. Silva chegou ao evento ontem à noite.', 'Ele saiu cedo para casa depois.']);
});
test('URL não divide frase', () => {
  const out = splitSentences('Veja o site https://exemplo.com/a.b.html para saber mais detalhes. Depois volte aqui sem falta.', cfg);
  assert.equal(out.length, 2);
  assert.ok(out[0].includes('https://exemplo.com/a.b.html'), out[0]);
  assert.deepEqual(splitSentencesRaw('Acesse exemplo.com/a.B.c agora'), ['Acesse exemplo.com/a.B.c agora']);
});
test('divide em . ! ? … e linhas; não divide antes de minúscula nem em decimal', () => {
  assert.deepEqual(splitSentencesRaw('Acabou! Será mesmo? Sim… Talvez. Pronto'), ['Acabou!', 'Será mesmo?', 'Sim…', 'Talvez.', 'Pronto']);
  assert.deepEqual(splitSentencesRaw('Custa 3.5 reais. ok e pronto'), ['Custa 3.5 reais. ok e pronto']);
  assert.deepEqual(splitSentencesRaw('primeira linha\nsegunda linha'), ['primeira linha', 'segunda linha']);
  assert.deepEqual(splitSentencesRaw('Ele disse "vou sair." Depois foi.'), ['Ele disse "vou sair."', 'Depois foi.']);
  assert.deepEqual(splitSentencesRaw('   \n \n'), []);
});
test('junta pedaços curtos (menos de 25 caracteres) ao vizinho', () => {
  assert.deepEqual(splitSentences('Oi. Tudo bem? Sim.', cfg), ['Oi. Tudo bem? Sim.']);
  assert.deepEqual(splitSentences('Dr. Silva chegou. Ele saiu.', cfg), ['Dr. Silva chegou. Ele saiu.']);
  const out = splitSentences(`${SENT} Ok. ${SENT}`, cfg);
  assert.equal(out.length, 2);
  assert.ok(out[1].startsWith('Ok. '), out[1]); // "Ok." curto grudou na frase seguinte
  const tail = splitSentences(`${SENT} Sim.`, cfg);
  assert.deepEqual(tail, [`${SENT} Sim.`]); // cauda curta junta com a anterior
});
test('1ª frase longa é partida na vírgula (até 80 caracteres) para o primeiro som sair rápido', () => {
  const long1 = 'Eu acho que a melhor opção para você neste momento, considerando tudo o que conversamos até agora, é esperar mais um pouco.';
  const out = splitSentences(long1, cfg);
  assert.equal(out.length, 2);
  assert.ok(out[0].length <= 80, `1ª com ${out[0].length}`);
  assert.equal(out[0], 'Eu acho que a melhor opção para você neste momento,');
  assert.equal(out.join(' '), long1); // nada se perde
  // Frase de até 80 caracteres não é partida.
  assert.equal(splitSentences('Esta frase é curta, mas tem vírgula e tem mais de vinte e cinco letras.', cfg).length, 1);
  // Sem vírgula nem " e " perto: não parte.
  assert.equal(splitSentences('Uma frase comprida sem nenhuma pausa interna para cortar então ela fica inteira mesmo assim ok.', cfg).length, 1);
  // Corte em " e " quando não há vírgula.
  const eCut = splitSentences('Eu vou conversar com o pessoal do servidor sobre isso hoje e depois te conto o que eles acharam disso tudo.', cfg);
  assert.equal(eCut.length, 2);
  assert.ok(eCut[0].length <= 80 && eCut[1].startsWith('e '), JSON.stringify(eCut));
  // Só a 1ª frase é partida.
  const two = splitSentences(`${long1} ${long1}`, cfg);
  assert.equal(two.length, 3);
});
test('frase de 500 caracteres respeita o limite por frase (padrão 160) e não perde palavras', () => {
  const words = Array.from({ length: 63 }, () => 'palavra').join(' ');
  assert.equal(words.length, 503);
  const out = splitSentences(`${words}.`, cfg);
  assert.ok(out.length >= 4, `só ${out.length} pedaços`);
  for (const s of out) assert.ok(s.length <= cfg.maxSentenceChars, `pedaço com ${s.length}`);
  assert.equal(out.join(' ').replace(/\./g, ''), words);
  const small = splitSentences(`${words}.`, { maxSentenceChars: 100, maxChars: 220 });
  for (const s of small) assert.ok(s.length <= 100, `pedaço com ${s.length}`);
  assert.ok(small.every((s) => s.length >= 25), 'sem cauda minúscula');
  // Prefere cortar em vírgula; sem vírgula nem espaço, corte duro.
  const comma = splitSentences(`${'a'.repeat(60)}, ${'b'.repeat(60)}, ${'c'.repeat(60)}.`, { maxSentenceChars: 130, maxChars: 220 });
  assert.ok(comma.every((s) => s.length <= 130), JSON.stringify(comma.map((s) => s.length)));
  assert.ok(comma[0].endsWith(','), comma[0].slice(-5));
  const hard = splitSentences('x'.repeat(500), { maxSentenceChars: 100, maxChars: 220 });
  assert.ok(hard.every((s) => s.length <= 100) && hard.join('').length === 500, JSON.stringify(hard.map((s) => s.length)));
});
test('cfg ausente ou inválido cai nos padrões do config.js', () => {
  const words = Array.from({ length: 63 }, () => 'palavra').join(' ');
  for (const bad of [undefined, null, {}, { maxSentenceChars: 'x' }, { maxSentenceChars: -5 }, { maxSentenceChars: NaN }]) {
    for (const s of splitSentences(`${words}.`, bad)) assert.ok(s.length <= 160);
  }
});

console.log('\n== prepareSpeech: modos e frases fixas ==');
const prep = (text, flags = {}, c = cfg) => prepareSpeech({ text, flags: { hadCode: false, hadLink: false, hadList: false, hadSpoiler: false, ...flags } }, c);
test('frases fixas exatamente como no desenho', () => {
  assert.equal(FIXED_PHRASES.rest, 'O resto está no chat.');
  assert.equal(FIXED_PHRASES.details, 'Mandei os detalhes no chat.');
  assert.equal(FIXED_PHRASES.pass, 'Essa eu passo.');
  assert.ok(Object.isFrozen(FIXED_PHRASES));
});
test('modo full: cabe tudo; pontuação final garantida', () => {
  assert.deepEqual(prep('Canberra é a capital da Austrália, não Sydney.'), { mode: 'full', sentences: ['Canberra é a capital da Austrália, não Sydney.'] });
  assert.deepEqual(prep('Resposta sem ponto final'), { mode: 'full', sentences: ['Resposta sem ponto final.'] });
  const three = `${SENT} ${SENT.replace('teste', 'prova')} ${SENT.replace('teste', 'exame')}`;
  const r = prep(three);
  assert.equal(r.mode, 'full');
  assert.equal(r.sentences.length, 3);
});
test('modo truncated: primeiras frases que cabem, em fim de frase, + "O resto está no chat."', () => {
  const s = (n) => `Esta é a frase número ${n} com um tamanho bem razoável de falar.`; // ~58 caracteres
  const six = [1, 2, 3, 4, 5, 6].map(s).join(' ');
  const r = prep(six);
  assert.equal(r.mode, 'truncated');
  assert.deepEqual(r.sentences, [s(1), s(2), s(3), FIXED_PHRASES.rest]);
  // Teto de caracteres (220): frases de ~90 caracteres, só 2 cabem.
  const big = (n) => `Frase ${n}: ${'abc def '.repeat(11).trim()} fim.`;
  const r2 = prep([1, 2, 3, 4].map(big).join(' '));
  const spoken = r2.sentences.slice(0, -1);
  assert.equal(r2.mode, 'truncated');
  assert.equal(r2.sentences.at(-1), FIXED_PHRASES.rest);
  assert.ok(spoken.join(' ').length <= 220, `fala com ${spoken.join(' ').length}`);
  assert.ok(spoken.length >= 1 && spoken.length <= 3);
  for (const x of spoken) assert.match(x, /[.!?]$/);
});
test('modo truncated com limites pequenos vindos do cfg', () => {
  const r = prep(`${SENT} ${SENT} ${SENT}`, {}, { maxChars: 80, maxSentences: 1, maxSentenceChars: 80 });
  assert.equal(r.mode, 'truncated');
  assert.deepEqual(r.sentences, [SENT, FIXED_PHRASES.rest]);
  const r2 = prep(`${SENT} ${SENT}`, {}, { maxChars: 220, maxSentences: 1, maxSentenceChars: 160 });
  assert.deepEqual(r2.sentences, [SENT, FIXED_PHRASES.rest]);
});
test('truncated: uma única frase gigante é cortada em vírgula/espaço dentro do teto', () => {
  const words = Array.from({ length: 100 }, () => 'palavra').join(' ');
  const r = prep(words);
  assert.equal(r.mode, 'truncated');
  assert.equal(r.sentences.at(-1), FIXED_PHRASES.rest);
  assert.ok(r.sentences[0].length <= 220);
  assert.ok(r.sentences.slice(0, -1).join(' ').length <= 220);
});
test('modo pointer: código, lista ou link => 1ª frase de introdução (15+ caracteres) + "Mandei os detalhes no chat."', () => {
  const intro = 'Claro, esse é o código que você pediu para o seu projeto.';
  for (const flag of ['hadCode', 'hadList', 'hadLink']) {
    assert.deepEqual(prep(`${intro} Depois mais coisas aqui.`, { [flag]: true }), { mode: 'pointer', sentences: [intro, FIXED_PHRASES.details] }, flag);
  }
});
test('pointer sem introdução: só a frase fixa (termina em ":", curta demais, vazio)', () => {
  const only = { mode: 'pointer', sentences: [FIXED_PHRASES.details] };
  assert.deepEqual(prep('Aqui está o código que você pediu:', { hadCode: true }), only);
  assert.deepEqual(prep('Segue a lista com tudo:', { hadList: true }), only);
  assert.deepEqual(prep('Claro!', { hadCode: true }), only);
  assert.deepEqual(prep('Veja mais em', { hadLink: true }), only);
  assert.deepEqual(prep('', { hadCode: true }), only);
  assert.deepEqual(prep('', { hadLink: true }), only);
});
test('pointer de ponta a ponta com normalizeForSpeech', () => {
  const t = (s) => prepareSpeech(norm(s), cfg);
  assert.deepEqual(t('Use este comando agora mesmo para instalar:\n```\nnpm i\n```'), { mode: 'pointer', sentences: [FIXED_PHRASES.details] });
  assert.deepEqual(t('Aqui estão as opções:\n- maçã\n- banana\n- uva'), { mode: 'pointer', sentences: [FIXED_PHRASES.details] });
  assert.deepEqual(t('Existem três frutas boas para comer.\n- maçã\n- banana\n- uva'), { mode: 'pointer', sentences: ['Existem três frutas boas para comer.', FIXED_PHRASES.details] });
  assert.deepEqual(t('- Maçã\n- Banana\n- Uva'), { mode: 'pointer', sentences: [FIXED_PHRASES.details] });
  assert.deepEqual(t('https://exemplo.com/abc'), { mode: 'pointer', sentences: [FIXED_PHRASES.details] });
  assert.deepEqual(t('A capital é Canberra, veja em https://pt.wikipedia.org/wiki/Canberra para saber mais.'), { mode: 'pointer', sentences: ['A capital é Canberra, veja em para saber mais.', FIXED_PHRASES.details] });
});
test('modo none: nada para falar', () => {
  for (const text of ['', '   ', '...', '!?', '-- ,;']) assert.deepEqual(prep(text), { mode: 'none', sentences: [] }, JSON.stringify(text));
  assert.deepEqual(prepareSpeech(norm(cp(0x1f600, 0x1f44d)), cfg), { mode: 'none', sentences: [] });
  assert.deepEqual(prepareSpeech(norm('<@1> @everyone'), cfg), { mode: 'none', sentences: [] });
  assert.deepEqual(prepareSpeech(norm('||segredo||'), cfg), { mode: 'none', sentences: [] });
  assert.deepEqual(prepareSpeech({ text: 'x' }, cfg).mode, 'full'); // flags ausentes
  assert.deepEqual(prepareSpeech('texto solto', cfg), { mode: 'full', sentences: ['texto solto.'] }); // aceita string
  assert.deepEqual(prepareSpeech(null, cfg), { mode: 'none', sentences: [] });
  assert.deepEqual(prepareSpeech(undefined), { mode: 'none', sentences: [] });
});
test('uma frase fixa nunca é cortada nem repetida; a fixa vem sempre por último', () => {
  const r = prep(Array.from({ length: 8 }, (_, i) => `${SENT} Número ${i}.`).join(' '));
  assert.equal(r.sentences.filter((s) => s === FIXED_PHRASES.rest).length, 1);
  assert.equal(r.sentences.at(-1), FIXED_PHRASES.rest);
});

console.log('\n== Entradas patológicas (desempenho) ==');
const MB = 1 << 20;
const rep = (s, bytes) => s.repeat(Math.ceil(bytes / s.length)).slice(0, bytes);
const PATHOLOGICAL = {
  '100.000 letras iguais': 'a'.repeat(100000),
  '5.000 parênteses abertos': '('.repeat(5000),
  '20.000 asteriscos': '*'.repeat(20000),
  '1 MB de "a"': 'a'.repeat(MB),
  '1 MB de "a "': rep('a ', MB),
  '1 MB de "("': '('.repeat(MB),
  '1 MB de "["': '['.repeat(MB),
  '1 MB de "*"': '*'.repeat(MB),
  '1 MB de "_"': '_'.repeat(MB),
  '1 MB de "~"': '~'.repeat(MB),
  '1 MB de "|"': '|'.repeat(MB),
  '1 MB de "`"': '`'.repeat(MB),
  '1 MB de "#"': '#'.repeat(MB),
  '1 MB de ">"': '>'.repeat(MB),
  '1 MB de "<@"': rep('<@', MB),
  '1 MB de "<:a"': rep('<:a', MB),
  '1 MB de "[a]("': rep('[a](', MB),
  '1 MB de "!["': rep('![', MB),
  '1 MB de dígitos': '1'.repeat(MB),
  '1 MB de "1."': rep('1.', MB),
  '1 MB de "1,"': rep('1,', MB),
  '1 MB de "1.234"': rep('1.234', MB),
  '1 MB de "R$ "': rep('R$ ', MB),
  '1 MB de "1h"': rep('1h', MB),
  '1 MB de "1/"': rep('1/', MB),
  '1 MB de "1GB"': rep('1GB', MB),
  '1 MB de "http://"': rep('http://', MB),
  '1 MB de espaços': ' '.repeat(MB),
  '1 MB de quebras de linha': '\n'.repeat(MB),
  '1 MB de "- "': rep('- ', MB),
  '1 MB de "1. "': rep('1. ', MB),
  '1 MB de ". "': rep('. ', MB),
  '1 MB de "Dr. "': rep('Dr. ', MB),
  '1 MB de "a.A "': rep('a.A ', MB),
  '1 MB de "!?"': rep('!?', MB),
  '1 MB de "-"': '-'.repeat(MB),
  '1 MB de "a-"': rep('a-', MB),
  '1 MB de emoji': cp(0x1f600).repeat(MB / 2),
  '1 MB de surrogate solto': cp(0xd83d).repeat(MB),
  '1 MB de "kk "': rep('kk ', MB),
  '1 MB de texto normal': rep('O servidor da Yui tem 16 GB e custa R$ 5,20 às 14h30. ', MB),
};
/**
 * Tempo máximo com tolerância a PC ocupado: tenta até 3 vezes e passa na primeira que couber no limite.
 * Uma regex quadrática erra por ordens de grandeza (segundos), então reprova nas 3; já um pico de CPU de
 * outro programa (jogo aberto, outra suíte rodando) costuma atingir uma tentativa só.
 */
function withinMs(limitMs, fn, tries = 3) {
  let worst = 0;
  for (let i = 0; i < tries; i++) {
    const t0 = performance.now();
    const out = fn();
    const ms = performance.now() - t0;
    if (ms < limitMs) return out;
    worst = Math.max(worst, ms);
  }
  assert.fail(`demorou ${worst.toFixed(0)} ms em ${tries} tentativas (limite ${limitMs} ms)`);
}
for (const [name, input] of Object.entries(PATHOLOGICAL)) {
  test(`patológico: ${name} < 500 ms`, () => {
    const { r, p, s } = withinMs(500, () => {
      const r = norm(input);
      const p = prepareSpeech(r, cfg);
      const s = splitSentences(input.slice(0, 200000), cfg); // o divisor também recebe texto cru enorme
      return { r, p, s };
    });
    assertClean(r.text, name);
    for (const x of p.sentences) assertClean(x, name);
    assert.ok(Array.isArray(s));
  });
}
test('patológico: a regex em si é linear (sem o corte de entrada, 200 mil caracteres ainda são rápidos)', () => {
  for (const input of ['a'.repeat(200000), '('.repeat(200000), rep('[a](', 200000), rep('1.', 200000), rep('<@', 200000), '*'.repeat(200000), rep('a ', 200000), rep('```', 200000), rep('||', 200000),
    rep('a.b/', 200000), rep('a.', 200000), rep('discord.gg/', 200000)]) {
    // 200 mil caracteres: o pior caso leva ~300 ms sozinho; uma regex quadrática levaria dezenas de segundos,
    // então 2 s separam as duas coisas mesmo com o PC ocupado.
    const r = withinMs(2000, () => norm(input, { maxInputChars: 200000 }));
    assertClean(r.text);
  }
});
test('normalizar 10.000 caracteres normais leva menos de 50 ms (melhor de 7 depois de aquecer)', () => {
  const base = 'O servidor **Yui** tem 16 GB de RAM e custa R$ 1.234,56 por mês, então vale 50% mais. Veja https://exemplo.com/a e fale com <@123> às 14h30, dia 14/10/2026. A GPU roda a 60 FPS (kkkk) - ok! ';
  const text = rep(base, 10000);
  norm(text);
  let best = Infinity;
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    norm(text);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 50, `melhor tempo ${best.toFixed(1)} ms`);
  const t1 = performance.now();
  prepareSpeech(norm(text), cfg);
  assert.ok(performance.now() - t1 < 100);
});
test('entrada de tipos estranhos não lança', () => {
  for (const v of [undefined, null, 0, 123, true, {}, [], () => 1, Symbol.iterator.toString(), new String('abc')]) {
    const r = norm(v);
    assert.equal(typeof r.text, 'string');
    assertClean(r.text);
  }
  assert.equal(say(12345), 'doze mil trezentos e quarenta e cinco');
  assert.equal(say(null), '');
});
test('maxInputChars corta a entrada (padrão 10 mil; mínimo aceito 100)', () => {
  const text = rep('palavra ', 50000);
  assert.ok(say(text).length <= 10000);
  assert.ok(say(text, { maxInputChars: 1000 }).length <= 1000);
  assert.ok(say(text, { maxInputChars: 5 }).length <= 10000); // valor inválido volta ao padrão
});

console.log('\n== Correções da revisão ==');

test('splitSentences/prepareSpeech não travam com substituto UTF-16 solitário no começo (regressão: laço infinito)', () => {
  // Rodado em outro processo com prazo: se a regressão voltar, o teste reprova em vez de travar a suíte.
  const url = new URL('../src/services/tts/segment.js', import.meta.url).href;
  const code = `
    const { splitSentences, prepareSpeech } = await import(${JSON.stringify(url)});
    const lone = String.fromCharCode(0xd83d);
    const a = splitSentences(lone + ' ' + 'x'.repeat(300));
    const b = prepareSpeech(lone + ' ' + 'y'.repeat(400));
    const c = splitSentences('x'.repeat(100) + ' ' + lone + ' ' + 'z'.repeat(250));
    console.log(JSON.stringify({ a: a.length, b: b.sentences.length, c: c.length, max: Math.max(...a.map((s) => s.length), ...c.map((s) => s.length)) }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 10_000, maxBuffer: 1 << 20 }).toString();
  const r = JSON.parse(out);
  assert.ok(r.a >= 2 && r.b >= 1 && r.c >= 2, out);
  assert.ok(r.max <= 161, `nenhuma frase passa do limite (${r.max})`);
});

test('link sem esquema mas com caminho ("discord.gg/abc", "github.com/x/y") é link, não texto lido', () => {
  for (const [input, falado] of [
    ['Entra lá: discord.gg/abcDEF1 agora', 'Entra lá agora'],
    ['veja github.com/fulano/repo ok', 'veja okei'],
    ['bit.ly/xYzAb1.', ''],
    ['Acesse youtu.be/dQw4w9WgXcQ e curta', 'Acesse e curta'],
  ]) {
    const r = norm(input);
    assert.equal(r.flags.hadLink, true, input);
    assert.equal(r.text.replace(/[.:,]/g, '').trim(), falado.replace(/[.:,]/g, '').trim(), input);
  }
  // Sem caminho, domínio solto em prosa e números NÃO viram link (continua como antes).
  for (const input of ['no site exemplo.com tem', 'versão 2.5/10 ficou boa', 'ele/ela e/ou nós', 'km/h e m/s', 'casa.Com isso']) {
    assert.equal(norm(input).flags.hadLink, false, input);
  }
});

test('apelido de menção: caracteres invisíveis somem (não viram espaço) e pontuação some', () => {
  const nome = (raw) => say('Oi <@1>', { resolveMention: () => raw });
  assert.equal(nome(`pu${cp(0x200b)}ta`), 'Oi puta');
  assert.equal(nome(`pu${cp(0x00ad)}ta`), 'Oi puta');
  assert.equal(nome(`pu${cp(0xfe0f)}ta`), 'Oi puta');
  assert.equal(nome('pu.ta'), 'Oi pu ta');
  assert.equal(nome('Ana!!! *x* [y]'), 'Oi Ana x y');
  assert.equal(nome('A'.repeat(40)), 'Oi AA', 'a higiene de repetição vale também para o apelido');
  assert.equal(Array.from(nome('abcdefghij'.repeat(5)).slice(3)).length, 24, 'no máximo 24 caracteres');
});

test('concordância de gênero: libras, substantivos comuns e terminações femininas (-ção, -dade, -gem)', () => {
  for (const [input, expected] of [
    ['2 coisas', 'duas coisas'], ['1 garrafa', 'uma garrafa'], ['3 versões', 'três versões'], ['1 opção', 'uma opção'],
    ['2 opções', 'duas opções'], ['2 cidades', 'duas cidades'], ['1 viagem', 'uma viagem'], ['2 imagens', 'duas imagens'],
    ['21 noites', 'vinte e uma noites'], ['2 dicas', 'duas dicas'],
    // Masculinos continuam masculinos.
    ['2 problemas', 'dois problemas'], ['2 dias', 'dois dias'], ['1 mapa', 'um mapa'], ['2 jogos', 'dois jogos'],
  ]) {
    assert.equal(say(input), expected, input);
  }
});

test('letras repetidas (4 ou mais) viram duas; palavra normal não muda', () => {
  assert.equal(say(`n${'ã'.repeat(5)}o`), `n${'ã'.repeat(2)}o`);
  assert.equal(say('aaaaaaa'), 'aa');
  assert.equal(say('verdade'), 'verdade');
});

console.log(`\n${passed} passaram, ${failed} falharam.`);
if (failed > 0) process.exit(1);
