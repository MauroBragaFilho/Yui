// O DETECTOR do pedido de clima (etapa 11, src/core/tools/clima.js: detectarPedidoDeClima, interpretarLocal, interpretarRespostaDeCidade, traduzirCodigoDoTempo).
// Só CÓDIGO decide (nenhuma IA, nenhuma rede, nenhum disco). Prova: a frase exata do Braga, muitas variações positivas (com e sem acento, "Cuiabá-MT", "em
// Manaus", "pra amanhã", "essa semana", "fim de semana", "vai chover", "tá quente?") com o LOCAL e o QUANDO certos, e uma lista longa de conversas que só CITAM a
// palavra ("o tempo de jogo", "tempo de download", "clima da reunião", "temperatura da CPU") e NÃO podem disparar; o texto das frases fixas da Yui (nenhuma é lida
// como "promessa vazia" pelas portas do bot); e todos os códigos WMO traduzidos.
// Execução: npm run test:climadeteccao
import assert from 'node:assert/strict';
import { detectarPedidoDeClima, interpretarLocal, interpretarRespostaDeCidade, traduzirCodigoDoTempo, UF_PARA_ESTADO, TEXTO_CLIMA_FALHA, TEXTO_CLIMA_SEM_CIDADE, TEXTO_CLIMA_LOCAL_NAO_ACHADO, TEXTO_CLIMA_LIMITE, textoDeFalhaDoClima } from '../src/core/tools/clima.js';
import { detectUnfulfilledPromise, finalGuardDetailed } from '../src/core/ai/searchIntent.js';

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (err) { failures.push(name); console.log(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 6).join('\n        ')}`); }
};

const local = (texto) => detectarPedidoDeClima(texto).local;
const quando = (texto) => detectarPedidoDeClima(texto).quando;

await test('a frase exata do dono: clima de Cuiabá-MT para essa semana', () => {
  const r = detectarPedidoDeClima('Olá, poderia ver o clima de Cuiabá-MT para essa semana?');
  assert.equal(r.clima, true);
  assert.deepEqual(r.local, { nome: 'Cuiabá', uf: 'MT' });
  assert.equal(r.quando.tipo, 'semana');
});

const POSITIVAS = [
  ['Como está o clima em Manaus?', { nome: 'Manaus', uf: null }, 'hoje'],
  ['como esta o clima em manaus', { nome: 'manaus', uf: null }, 'hoje'],
  ['vai chover hoje em São Paulo?', { nome: 'São Paulo', uf: null }, 'hoje'],
  ['vai chover hoje em sao paulo', { nome: 'sao paulo', uf: null }, 'hoje'],
  ['qual a previsão do tempo pra amanhã em Curitiba?', { nome: 'Curitiba', uf: null }, 'amanha'],
  ['qual a previsao do tempo pra amanha em curitiba', { nome: 'curitiba', uf: null }, 'amanha'],
  ['temperatura em Porto Alegre agora', { nome: 'Porto Alegre', uf: null }, 'agora'],
  ['vai fazer frio no fim de semana em Gramado?', { nome: 'Gramado', uf: null }, 'fim_de_semana'],
  ['previsão do tempo', null, 'hoje'],
  ['tá chovendo aí?', null, 'hoje'],
  ['será que vai chover amanhã?', null, 'amanha'],
  ['preciso levar guarda-chuva hoje em BH?', { nome: 'BH', uf: null }, 'hoje'],
  ['faz calor em Fortaleza?', { nome: 'Fortaleza', uf: null }, 'hoje'],
  ['quantos graus tá fazendo em Brasília?', { nome: 'Brasília', uf: null }, 'hoje'],
  ['clima em Belém essa semana', { nome: 'Belém', uf: null }, 'semana'],
  ['me diz o clima de Salvador', { nome: 'Salvador', uf: null }, 'hoje'],
  ['qual a temperatura em Recife?', { nome: 'Recife', uf: null }, 'hoje'],
  ['vai chover?', null, 'hoje'],
  ['como tá o tempo hoje?', null, 'hoje'],
  ['tá quente aí?', null, 'hoje'],
  ['Como está o clima em Campinas, SP?', { nome: 'Campinas', uf: 'SP' }, 'hoje'],
  ['clima em Foz do Iguaçu amanhã', { nome: 'Foz do Iguaçu', uf: null }, 'amanha'],
  ['previsão do tempo em Santa Cruz do Sul/RS depois de amanhã', { nome: 'Santa Cruz do Sul', uf: 'RS' }, 'depois_de_amanha'],
  ['yui, previsão do tempo pra sexta em Goiânia', { nome: 'Goiânia', uf: null }, 'dia'],
  ['como vai estar o tempo no sábado em Floripa?', { nome: 'Floripa', uf: null }, 'dia'],
  ['Yui, o clima de Rio Branco - AC pros próximos dias', { nome: 'Rio Branco', uf: 'AC' }, 'semana'],
  ['qual o clima em Cuiabá/MT pro fds?', { nome: 'Cuiabá', uf: 'MT' }, 'fim_de_semana'],
  ['vai ter chuva em Belo Horizonte amanhã?', { nome: 'Belo Horizonte', uf: null }, 'amanha'],
  ['tem previsão de chuva pra semana que vem em Vitória?', { nome: 'Vitória', uf: null }, 'semana'],
  ['qual a sensação térmica em Natal agora', { nome: 'Natal', uf: null }, 'agora'],
  ['Yui, dá uma olhada no clima de Joinville pra mim', { nome: 'Joinville', uf: null }, 'hoje'],
  ['quero saber a previsão do tempo de Campo Grande, MS pro domingo', { nome: 'Campo Grande', uf: 'MS' }, 'dia'],
  ['está fazendo sol em Aracaju?', { nome: 'Aracaju', uf: null }, 'hoje'],
  ['<@900000000000000001> clima em Palmas-TO hoje', { nome: 'Palmas', uf: 'TO' }, 'hoje'],
];
for (const [texto, esperadoLocal, esperadoQuando] of POSITIVAS) {
  await test(`positivo: ${texto}`, () => {
    const r = detectarPedidoDeClima(texto);
    assert.equal(r.clima, true, `deveria disparar (${r.motivo})`);
    assert.deepEqual(r.local, esperadoLocal, 'o local');
    assert.equal(r.quando.tipo, esperadoQuando, 'o quando');
  });
}

await test('o QUANDO: dia da semana, fim de semana, semana e o rótulo', () => {
  assert.equal(quando('previsão do tempo pra sexta em Goiânia').dia, 5);
  assert.equal(quando('clima na terça-feira em Manaus').dia, 2);
  assert.equal(quando('clima no sábado em Manaus').dia, 6);
  assert.equal(quando('clima no domingo em Manaus').dia, 0);
  assert.equal(quando('clima em Manaus no fim de semana').tipo, 'fim_de_semana');
  assert.equal(quando('clima em Manaus semana que vem').proximaSemana, true);
  assert.equal(quando('clima em Manaus essa semana').proximaSemana, false);
  assert.equal(quando('clima em Manaus nos próximos 7 dias').tipo, 'semana');
  assert.equal(quando('clima em Manaus hoje e amanhã').tipo, 'amanha', 'a mais específica vence');
  assert.equal(quando('como está o clima em Manaus').rotulo, 'hoje');
});

const NEGATIVAS = [
  'o tempo de jogo foi de 40 minutos', 'tempo de download muito longo', 'o clima da reunião estava tenso', 'clima pesado no servidor', 'quanto tempo falta pra live?',
  'não tenho tempo hoje', 'faz tempo que não jogo', 'temperatura da CPU está alta', 'a temperatura do café', 'tempo de resposta do servidor', 'o clima do jogo é incrível',
  'mudanças climáticas', 'chuva de ideias', 'o café tá frio', 'me dá um tempo', 'o tempo voa', 'tempo é dinheiro', 'há quanto tempo', 'previsão de vendas do mês',
  'oi tudo bem?', 'tempo real', 'a temperatura da GPU chegou a 80 graus', 'qual a temperatura ideal do forno?', 'o tempo de espera na fila é grande', 'clima de terror nesse filme',
  'esse jogo tem um clima de suspense', 'o clima entre a gente tá estranho', 'não deu tempo de terminar', 'quanto tempo leva pra baixar?', 'clima organizacional da empresa',
  'o tempo de campanha do jogo', 'tempo de cozimento do arroz', 'tô sem tempo hoje', 'ao mesmo tempo eu jogo e estudo', 'o tempo todo você fala disso', 'aquecimento global é sério',
  'o tempo de entrega atrasou', 'tempo de execução do script', 'qual o tempo de resposta médio?', 'quanto tempo você demora?', 'a temperatura do servidor subiu', 'cantando na chuva é um filme',
  'tempo de viagem até lá', 'previsão do jogo de amanhã', 'qual a previsão de lançamento?', 'hoje eu vou jogar', 'vou levar meu casaco', 'quero um clima diferente no servidor',
  // frases que TÊM um sinal de clima ("como está o tempo", "qual a temperatura", "vai ter chuva", "como está o clima") mas falam de outra coisa: só as listas de "não é o do céu" as barram
  'como está o tempo de download do jogo?', 'como está o tempo de resposta do servidor hoje?', 'qual o tempo de jogo da campanha?', 'como está o clima da reunião hoje?',
  'qual é o tempo de espera na fila?', 'como está o tempo real do servidor?', 'qual é o tempo máximo da partida?', 'como está o clima no servidor hoje?', 'qual a temperatura da CPU agora?', 'qual a temperatura do servidor em Manaus?', 'vai ter chuva de ideias amanhã?', 'tem tempo livre hoje em Manaus?',
];
for (const texto of NEGATIVAS) {
  await test(`negativo: ${texto}`, () => {
    const r = detectarPedidoDeClima(texto);
    assert.equal(r.clima, false, `não deveria disparar: ${JSON.stringify(r)}`);
  });
}

await test('texto vazio, enorme, com código ou só com menção não dispara', () => {
  assert.equal(detectarPedidoDeClima('').clima, false);
  assert.equal(detectarPedidoDeClima(null).clima, false);
  assert.equal(detectarPedidoDeClima(`vai chover hoje? ${'x'.repeat(600)}`).clima, false, 'texto grande não é uma pergunta de clima');
  assert.equal(detectarPedidoDeClima('```js\nconsole.log("vai chover?")\n```').clima, false);
  assert.equal(detectarPedidoDeClima('<@900000000000000001>').clima, false);
});

await test('o texto de uma URL ou de uma menção não vira local', () => {
  assert.equal(local('como está o clima em https://exemplo.com/cidade?'), null);
  assert.deepEqual(local('como está o clima em Manaus <@900000000000000001>'), { nome: 'Manaus', uf: null });
});

await test('local que não é cidade (casa, aqui, no jogo, no Brasil) não vira local: a Yui pergunta a cidade', () => {
  for (const t of ['vai chover em casa hoje?', 'como está o clima aqui?', 'clima no Brasil hoje', 'como está o clima na minha cidade?', 'vai chover no servidor hoje?']) {
    const r = detectarPedidoDeClima(t);
    assert.equal(r.clima, true, t);
    assert.equal(r.local, null, `sem cidade: ${t}`);
  }
});

await test('interpretarLocal: UF por hífen, vírgula, barra ou sigla maiúscula; nome limpo; recusa lixo', () => {
  assert.deepEqual(interpretarLocal('Cuiabá-MT'), { nome: 'Cuiabá', uf: 'MT' });
  assert.deepEqual(interpretarLocal('Cuiabá - MT'), { nome: 'Cuiabá', uf: 'MT' });
  assert.deepEqual(interpretarLocal('Cuiabá, mt'), { nome: 'Cuiabá', uf: 'MT' });
  assert.deepEqual(interpretarLocal('cuiaba/mt'), { nome: 'cuiaba', uf: 'MT' });
  assert.deepEqual(interpretarLocal('Cuiabá MT'), { nome: 'Cuiabá', uf: 'MT' });
  assert.deepEqual(interpretarLocal('Rio de Janeiro'), { nome: 'Rio de Janeiro', uf: null });
  assert.deepEqual(interpretarLocal('Rio de Janeiro, RJ'), { nome: 'Rio de Janeiro', uf: 'RJ' });
  assert.deepEqual(interpretarLocal("Santa Bárbara d'Oeste-SP"), { nome: "Santa Bárbara d'Oeste", uf: 'SP' });
  assert.deepEqual(interpretarLocal('Manaus se'), { nome: 'Manaus se', uf: null }, '"se" minúsculo e sem separador não é Sergipe');
  assert.equal(interpretarLocal(''), null);
  assert.equal(interpretarLocal('a'), null);
  assert.equal(interpretarLocal('123'), null);
  assert.equal(interpretarLocal('x'.repeat(100)), null);
  assert.equal(interpretarLocal('casa'), null);
  assert.equal(interpretarLocal('uma cidade com muitas muitas muitas palavras demais aqui'), null);
  assert.ok(!/[;<>{}\\]/.test(interpretarLocal('Manaus; drop table')?.nome ?? ''), 'a pontuação perigosa sai do nome');
  assert.ok(!/[;<>{}\\]/.test(interpretarLocal('Manaus<script>')?.nome ?? ''), 'nenhum caractere perigoso sobra no nome');
  for (const uf of Object.keys(UF_PARA_ESTADO)) assert.deepEqual(interpretarLocal(`Vila Nova-${uf}`), { nome: 'Vila Nova', uf }, uf);
  assert.equal(Object.keys(UF_PARA_ESTADO).length, 27);
});

await test('interpretarRespostaDeCidade: a resposta curta a "De qual cidade?"', () => {
  assert.deepEqual(interpretarRespostaDeCidade('Cuiabá'), { nome: 'Cuiabá', uf: null });
  assert.deepEqual(interpretarRespostaDeCidade('em Manaus'), { nome: 'Manaus', uf: null });
  assert.deepEqual(interpretarRespostaDeCidade('Campinas, SP.'), { nome: 'Campinas', uf: 'SP' });
  assert.deepEqual(interpretarRespostaDeCidade('<@900000000000000001> Recife'), { nome: 'Recife', uf: null });
  for (const t of ['não, deixa pra lá', 'obrigado', 'qual cidade você acha melhor?', 'eu moro em uma cidade muito longe daqui sabe', 'ok', '', '123']) assert.equal(interpretarRespostaDeCidade(t), null, t);
});

await test('os códigos WMO (0,1,2,3,45,48,51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,97,99) viram português curto; o desconhecido vira "condição não informada"', () => {
  const codigos = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99];
  const vistos = new Set();
  for (const c of codigos) {
    const t = traduzirCodigoDoTempo(c);
    assert.ok(t && t !== 'condição não informada' && t.length < 40, `código ${c}: ${t}`);
    vistos.add(t);
  }
  assert.equal(vistos.size, codigos.length, 'cada código tem a própria descrição');
  assert.equal(traduzirCodigoDoTempo(0), 'céu limpo');
  assert.equal(traduzirCodigoDoTempo(95), 'trovoada');
  for (const ruim of [4, 100, -1, 'abc', null, undefined, 61.5]) assert.equal(traduzirCodigoDoTempo(ruim), 'condição não informada', String(ruim));
});

await test('as frases fixas da Yui: curtas, sem erro técnico e NENHUMA vira "promessa vazia" nas portas do bot (que as trocariam por um pedido de desculpas)', () => {
  const textos = [TEXTO_CLIMA_FALHA, TEXTO_CLIMA_SEM_CIDADE, TEXTO_CLIMA_LOCAL_NAO_ACHADO, TEXTO_CLIMA_LIMITE];
  assert.equal(TEXTO_CLIMA_FALHA, 'Não consegui ver o clima agora. Tenta de novo daqui a pouco?');
  assert.equal(TEXTO_CLIMA_SEM_CIDADE, 'De qual cidade?');
  for (const t of textos) {
    assert.ok(t.length < 90, t);
    assert.doesNotMatch(t, /erro|exception|http|timeout|api|429|undefined|null/i, 'nada técnico');
    assert.equal(detectUnfulfilledPromise(t).promise, false, `Porta C: "${t}" não é promessa`);
    const guarda = finalGuardDetailed(t, { hadAction: false, userNeedsAnswer: true });
    assert.equal(guarda.text ?? t, t, `Porta D deixa passar: "${t}"`);
  }
  assert.equal(textoDeFalhaDoClima('sem_local'), TEXTO_CLIMA_SEM_CIDADE);
  assert.equal(textoDeFalhaDoClima('local_nao_achado'), TEXTO_CLIMA_LOCAL_NAO_ACHADO);
  assert.equal(textoDeFalhaDoClima('limite_pessoa'), TEXTO_CLIMA_LIMITE);
  assert.equal(textoDeFalhaDoClima('limite_global'), TEXTO_CLIMA_LIMITE);
  for (const m of ['rede', 'api', 'resposta', 'limite_api', 'erro', 'qualquer']) assert.equal(textoDeFalhaDoClima(m), TEXTO_CLIMA_FALHA, m);
});

await test('desempenho: entrada hostil (milhares de espaços e preposições) responde rápido', () => {
  const t0 = Date.now();
  detectarPedidoDeClima(`vai chover em ${'de '.repeat(130)}hoje?`);
  detectarPedidoDeClima(`clima ${' '.repeat(350)}em`);
  detectarPedidoDeClima(`${'em '.repeat(130)}clima`);
  assert.ok(Date.now() - t0 < 500, `levou ${Date.now() - t0} ms`);
});

console.log(failures.length ? `\nFALHA: ${passed} passaram, ${failures.length} falharam.\nFalharam: ${failures.join(' | ')}` : `\n${passed} teste(s) passaram, 0 falharam.`);
process.exit(failures.length ? 1 : 0);
