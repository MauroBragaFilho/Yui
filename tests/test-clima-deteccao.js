// O DETECTOR do pedido de clima (etapa 11, src/core/tools/clima.js: detectarPedidoDeClima, interpretarLocal, interpretarRespostaDeCidade, traduzirCodigoDoTempo).
// Só CÓDIGO decide (nenhuma IA, nenhuma rede, nenhum disco). Prova: a frase exata do Braga, muitas variações positivas (com e sem acento, "Cuiabá-MT", "em
// Manaus", "pra amanhã", "essa semana", "fim de semana", "vai chover", "tá quente?") com o LOCAL e o QUANDO certos, e uma lista longa de conversas que só CITAM a
// palavra ("o tempo de jogo", "tempo de download", "clima da reunião", "temperatura da CPU") e NÃO podem disparar; o texto das frases fixas da Yui (nenhuma é lida
// como "promessa vazia" pelas portas do bot); e todos os códigos WMO traduzidos.
// Execução: npm run test:climadeteccao
import assert from 'node:assert/strict';
import { detectarPedidoDeClima, interpretarContinuacaoDeClima, misturaComFerramenta, interpretarLocal, interpretarRespostaDeCidade, traduzirCodigoDoTempo, UF_PARA_ESTADO, TEXTO_CLIMA_FALHA, TEXTO_CLIMA_SEM_CIDADE, TEXTO_CLIMA_LOCAL_NAO_ACHADO, TEXTO_CLIMA_LIMITE, textoDeFalhaDoClima } from '../src/core/tools/clima.js';
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
  ['preciso levar guarda-chuva hoje em BH?', { nome: 'Belo Horizonte', uf: null }, 'hoje'], // o apelido vira o nome da cidade
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
  ['como vai estar o tempo no sábado em Floripa?', { nome: 'Florianópolis', uf: null }, 'dia'],
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
  for (const t of ['vai chover em casa hoje?', 'como está o clima aqui?', 'clima no Brasil hoje', 'como está o clima na minha cidade?']) {
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

// ─────────────── Revisão independente (19/11/2026): privacidade, sequestro e lacunas do detector ───────────────
const PALAVRAS_DA_CONVERSA = /cama|cima|HIV|positivo|pr[oó]stata|c[aâ]ncer|exame|pai|assustado|notebook|spam|servidor|jogo|discuss/i;

await test('A2: o TEXTO DA CONVERSA nunca vira local: só um nome com cara de lugar, COLADO ao sinal do clima (a Yui pergunta a cidade ou usa a padrão)', () => {
  const casos = [
    'vai chover? meu exame de HIV deu positivo e estou assustado', 'como está o clima? meu pai tem câncer de próstata', 'vai chover hoje? vou levar meu pai no hospital de Brasília',
    'qual a previsão do tempo? estou em casa sozinho em cima da cama', 'vai chover amanhã? o Rafael me disse que a Maria foi para a UTI', 'previsão do tempo, depois eu falo do exame de HIV',
    'como está o clima? Meu Deus o exame deu Positivo', 'clima? estou em Crise Existencial', 'qual a temperatura? sobre o jogo de Ontem',
  ];
  for (const t of casos) {
    const r = detectarPedidoDeClima(t);
    assert.ok(!r.local || !PALAVRAS_DA_CONVERSA.test(r.local.nome), `"${t}" virou o local "${r.local?.nome}"`);
    assert.equal(r.local, null, `sem local colado ao sinal: "${t}" -> ${JSON.stringify(r.local)}`);
  }
  assert.equal(local('o notebook ta quente agora em cima da cama'), null);
  assert.equal(detectarPedidoDeClima('o notebook ta quente agora em cima da cama').clima, false);
});

await test('A3: o local não leva a preposição nem o resto da frase ("Cuiabá na sexta" é Cuiabá) e o candidato mais próximo do sinal vence', () => {
  const nomes = [
    ['clima em Cuiabá na sexta', 'Cuiabá', null], ['clima em Cuiabá no domingo', 'Cuiabá', null], ['clima em Cuiabá-MT na próxima semana', 'Cuiabá', 'MT'],
    ['clima em Cuiabá pelo fim de semana', 'Cuiabá', null], ['clima em Cuiabá nos próximos dias', 'Cuiabá', null], ['clima em Cuiabá em novembro', 'Cuiabá', null],
    ['preciso de guarda-chuva amanhã em SP?', 'São Paulo', null], ['umidade do ar em Cuiabá', 'Cuiabá', null], ['vai chover em Sao Paulo capital hoje', 'Sao Paulo', null],
    ['clima em Foz do Iguaçu na quinta', 'Foz do Iguaçu', null], ['previsão do tempo em Santa Cruz do Sul/RS na sexta', 'Santa Cruz do Sul', 'RS'], ['vai chover hoje em BH?', 'Belo Horizonte', null],
  ];
  for (const [t, nome, uf] of nomes) assert.deepEqual(local(t), { nome, uf }, t);
  assert.equal(detectarPedidoDeClima('clima em Cuiabá na sexta').quando.tipo, 'dia');
});

await test('A3: só entra como local um nome com inicial maiúscula, "Cidade-UF" ou uma cidade conhecida (minúsculas só da lista)', () => {
  assert.deepEqual(local('como está o clima em manaus?'), { nome: 'manaus', uf: null });
  assert.deepEqual(local('clima em cuiabá-mt hoje'), { nome: 'cuiabá', uf: 'MT' });
  assert.equal(local('vai chover hoje em casa do vizinho?'), null);
  assert.equal(local('clima em lugar nenhum hoje'), null);

  assert.deepEqual(local('Em Manaus, como está o clima?'), { nome: 'Manaus', uf: null }, 'o lugar na frente da frase');
});

await test('B: sinais fracos ("vai esquentar", "tá quente", "faz calor") só com "?" ou com o local dito, e NUNCA com sujeito figurado', () => {
  const nao = ['o jogo vai esquentar na final hoje', 'vai esfriar a discussão', 'o servidor tá quente agora', 'vai chover muito spam no servidor', 'o café esfriou', 'vai chover no servidor hoje?',
    'a discussão no chat tá quente', 'o mercado vai esquentar amanhã?', 'o preço vai esfriar hoje?', 'o notebook tá quente hoje?', 'o PC faz calor demais?', 'vai chover bala no lobby hoje',
    'tá quente', 'tá frio', 'hoje faz calor', 'vai esfriar', 'vai esquentar amanhã'];
  for (const t of nao) assert.equal(detectarPedidoDeClima(t).clima, false, t);
  const sim = ['tá quente aí?', 'faz calor em Fortaleza?', 'vai esfriar amanhã?', 'tá calor em Cuiabá?', 'hoje faz calor em Manaus', 'vai fazer frio no final de semana em Gramado?', 'vai esquentar em Cuiabá amanhã'];
  for (const t of sim) assert.equal(detectarPedidoDeClima(t).clima, true, t);
});

await test('B: mensagem MISTA (outro pedido de ferramenta junto) não é sequestrada pelo clima: o outro pedido não se perde', () => {
  const mistas = ['baixa a música X e me diz se vai chover amanhã', 'me lembra de ver o clima amanhã', 'cria um lembrete pro clima de amanhã em Manaus', 'toca uma música e me diz se vai chover',
    'gera uma imagem de um dia de chuva e vê o clima em Manaus', 'me avisa se vai chover amanhã em Cuiabá', 'mostra a imagem do gato e depois o clima em Manaus', 'baixa o vídeo e como está o clima em Recife?'];
  for (const t of mistas) {
    const r = detectarPedidoDeClima(t);
    assert.equal(r.clima, false, t);
    assert.equal(r.motivo, 'mistura_com_ferramenta', t);
  }
  for (const t of ['mostra o clima em Manaus', 'me manda o clima de Salvador', 'me diz o clima de Salvador e se vai chover amanhã', 'manda a previsão do tempo de Belém']) assert.equal(detectarPedidoDeClima(t).clima, true, t);
  assert.equal(misturaComFerramenta('baixa a musica x e me diz se vai chover'), true);
  assert.equal(misturaComFerramenta('como esta o clima em manaus'), false);
});

await test('lacunas do detector: "previsão para a semana em Cuiabá-MT", "previsão pra sexta em Cuiabá", "clima Cuiabá", "tempo em Cuiabá?", "tá calor em Cuiabá?", "qual o clima?"', () => {
  const certos = [
    ['qual a previsão para a semana em Cuiabá-MT?', { nome: 'Cuiabá', uf: 'MT' }, 'semana'], ['previsão pra sexta em Cuiabá', { nome: 'Cuiabá', uf: null }, 'dia'],
    ['clima Cuiabá', { nome: 'Cuiabá', uf: null }, 'hoje'], ['tempo em Cuiabá?', { nome: 'Cuiabá', uf: null }, 'hoje'], ['tá calor em Cuiabá?', { nome: 'Cuiabá', uf: null }, 'hoje'],
    ['Yui, qual o clima?', null, 'hoje'], ['qual é o clima?', null, 'hoje'], ['previsão pro fim de semana em Cuiabá-MT', { nome: 'Cuiabá', uf: 'MT' }, 'fim_de_semana'],
  ];
  for (const [t, loc, quando] of certos) {
    const r = detectarPedidoDeClima(t);
    assert.equal(r.clima, true, t);
    assert.deepEqual(r.local, loc, t);
    assert.equal(r.quando.tipo, quando, t);
  }
  for (const t of ['tempo em casa?', 'previsão para amanhã das vendas', 'tempo na fila?', 'a previsão para a semana é de trabalho em Cuiabá']) assert.equal(detectarPedidoDeClima(t).clima, false, t);
  // a frase exata do dono continua funcionando
  assert.deepEqual(local('Olá, poderia ver o clima de Cuiabá-MT para essa semana?'), { nome: 'Cuiabá', uf: 'MT' });
});

await test('A1: a resposta a "De qual cidade?" tem de PARECER o nome de um lugar (a mensagem inteira): frases, saudações e desabafos não viram cidade', () => {
  for (const t of ['meu pai tem câncer', 'bom dia', 'Bom dia', 'to triste hoje', 'To triste', 'Obrigado', 'sim', 'Não', 'Oi', 'Tudo bem', 'não sei', 'cansado', 'Meu exame deu positivo', 'o jogo foi bom', 'Cuiabá é quente demais', 'hoje não']) {
    assert.equal(interpretarRespostaDeCidade(t), null, t);
  }
  assert.deepEqual(interpretarRespostaDeCidade('Cuiabá'), { nome: 'Cuiabá', uf: null });
  assert.deepEqual(interpretarRespostaDeCidade('em Manaus'), { nome: 'Manaus', uf: null });
  assert.deepEqual(interpretarRespostaDeCidade('recife'), { nome: 'recife', uf: null });
  assert.deepEqual(interpretarRespostaDeCidade('Cuiabá-MT'), { nome: 'Cuiabá', uf: 'MT' });
  assert.deepEqual(interpretarRespostaDeCidade('na cidade de Campinas, SP'), { nome: 'Campinas', uf: 'SP' });
  assert.deepEqual(interpretarRespostaDeCidade('SP'), { nome: 'São Paulo', uf: null });
});

await test('VÁRIOS LOCAIS: "o clima em cuiabá e o de curitiba" lê os dois, na ordem, até 3, sem repetir; o que não parece lugar encerra a lista', () => {
  const nomes = (t) => detectarPedidoDeClima(t).locais.map((l) => `${l.nome}${l.uf ? `-${l.uf}` : ''}`);
  assert.deepEqual(nomes('Tudo tranquilo como esquilo, poderia me informar o clima em cuiabá e o de curitiba para hoje?'), ['cuiabá', 'curitiba']);
  assert.deepEqual(nomes('como está o tempo em Curitiba e em Porto Alegre?'), ['Curitiba', 'Porto Alegre']);
  assert.deepEqual(nomes('clima em Cuiabá, Curitiba e Manaus hoje'), ['Cuiabá', 'Curitiba', 'Manaus']);
  assert.deepEqual(nomes('clima em Cuiabá-MT e Curitiba-PR amanhã'), ['Cuiabá-MT', 'Curitiba-PR']);
  assert.deepEqual(nomes('clima em Cuiabá, Curitiba, Manaus e Recife'), ['Cuiabá', 'Curitiba', 'Manaus'], 'no máximo 3 locais');
  assert.deepEqual(nomes('clima em Cuiabá-MT e Cuiabá-MT'), ['Cuiabá-MT'], 'sem repetir');
  assert.deepEqual(nomes('clima em Cuiabá e hoje vai chover?'), ['Cuiabá'], 'o que não é nome encerra a lista');
  assert.deepEqual(nomes('qual o clima em Cuiabá e o meu pai tem câncer'), ['Cuiabá'], 'texto da conversa nunca vira o segundo local');
  assert.deepEqual(nomes('clima em Cuiabá e o Pedro'), ['Cuiabá'], '"e o Pedro" nunca vira o segundo local (só cidade conhecida, Cidade-UF ou com preposição)');
  assert.deepEqual(nomes('clima em Cuiabá e Pedro'), ['Cuiabá']);
  assert.deepEqual(nomes('clima em Cuiabá e o de Curitiba'), ['Cuiabá', 'Curitiba']);
  assert.equal(detectarPedidoDeClima('como está o clima hoje?').locais.length, 0, 'sem local: lista vazia (usa a cidade padrão)');
  assert.equal(detectarPedidoDeClima('oi tudo bem?').clima, false);
  assert.deepEqual(detectarPedidoDeClima('oi tudo bem?').locais, []);
  assert.deepEqual(local('o clima em cuiabá e o de curitiba para hoje'), { nome: 'cuiabá', uf: null }, 'o campo `local` continua sendo o primeiro');
});

await test('CONTINUAÇÃO: "e de São Paulo?" só como a mensagem INTEIRA, com lugar de verdade (conhecido, Cidade-UF ou com a preposição), nunca nome de pessoa', () => {
  const nomes = (t) => (interpretarContinuacaoDeClima(t) ?? []).map((l) => `${l.nome}${l.uf ? `-${l.uf}` : ''}`);
  assert.deepEqual(nomes('e de São Paulo?'), ['São Paulo']);
  assert.deepEqual(nomes('E em Curitiba?'), ['Curitiba']);
  assert.deepEqual(nomes('e Curitiba?'), ['Curitiba']);
  assert.deepEqual(nomes('e Manaus e Recife?'), ['Manaus', 'Recife']);
  assert.deepEqual(nomes('e aí, Floripa?'), ['Florianópolis']);
  assert.deepEqual(nomes('e no Rio de Janeiro?'), ['Rio de Janeiro']);
  assert.deepEqual(nomes('e Cuiabá-MT?'), ['Cuiabá-MT']);
  assert.deepEqual(nomes('e de Foz do Iguaçu?'), ['Foz do Iguaçu']);
  for (const nao of ['e o João?', 'e você?', 'e lá?', 'e agora?', 'e o clima de Manaus', 'e de São Paulo? me lembra de ligar', 'e o Pedro, vai?', 'e vc', 'São Paulo?', 'e de', 'e ', '', 'e a Maria Clara?']) {
    assert.equal(interpretarContinuacaoDeClima(nao), null, `não é continuação: "${nao}"`);
  }
  assert.equal(interpretarContinuacaoDeClima(`e de ${'São Paulo '.repeat(20)}?`), null, 'texto longo não vale');
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
