// Testes dos detectores do agente de pesquisa (src/handlers/searchIntent.js): promessa vazia ("Vou pesquisar isso!"), pedido de pesquisa,
// consulta, pré-rota estrita, plano de recuperação e guarda final. SEM rede, SEM bancos, SEM Discord: só funções puras.
// As frases de tests/fixtures/search-phrases.json (requests, nonRequests, promises, nonPromises) foram usadas para AJUSTAR os detectores:
// aqui elas são GUARDA DE REGRESSÃO. Os corpora legitReplies, preRoute*, notWeb, musicGame e realIncidents são os CEGOS do plano.
// Execução: npm run test:searchintent   (node tests/test-search-intent.js)
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FALHA ${name}\n        ${String(err?.message ?? err).split('\n').join('\n        ')}`);
  }
};

const I = await import(pathToFileURL(path.join(repoRoot, 'src/handlers/searchIntent.js')).href);
const {
  detectUnfulfilledPromise, detectSearchRequest, buildSearchQuery, preRouteDecision, queryFromPromise, recoveryPlan, finalGuard, inspectFinalGuard,
  userNeedsAnswer, buildNoPromiseRetryPrompt, keywordsOf, saneQuery, lineCount, clipInput,
  PROMISE_ONLY_FALLBACK, SENSITIVE_SEARCH_REFUSAL, NEED_TOPIC_REPLY, SEARCH_DISABLED_REPLY, VOICE_REFUSAL, MAX_DETECT_CHARS,
} = I;
const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'search-phrases.json'), 'utf8'));
const NOW = new Date('2026-10-14T12:00:00-03:00');
const pick = (d) => ({ promise: d.promise, kind: d.kind, strength: d.strength });
const MODS = fx.realIncidents.mods;
const FIN = fx.realIncidents.financiamento;
// negativos gerados (dois dos 34 do plano): lista de 45 linhas e texto longo
const GENERATED_NEG = [
  `yui pesquisa esses mods:\n${Array.from({ length: 45 }, (_, i) => `Mod ${i + 1}`).join('\n')}`,
  `yui pesquisa ${'sobre a historia de um assunto muito longo '.repeat(20)}`,
];

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('1. Promessa vazia do modelo (o que a Yui NÃO consegue cumprir)');
await test(`as ${fx.promises.length} promessas conhecidas são todas detectadas`, () => {
  const missed = fx.promises.filter((p) => !detectUnfulfilledPromise(p).promise);
  assert.deepEqual(missed, [], `não detectadas: ${JSON.stringify(missed)}`);
});
await test(`nenhuma das ${fx.nonPromises.length} respostas legítimas do fixture é tratada como promessa`, () => {
  const fp = fx.nonPromises.filter((p) => detectUnfulfilledPromise(p).promise);
  assert.deepEqual(fp, [], `falsos positivos: ${JSON.stringify(fp)}`);
});
await test('Q39: das 26 respostas legítimas de enchimento + conteúdo, pelo menos 24 passam como não-promessa', () => {
  assert.equal(fx.legitReplies.length, 26);
  const flagged = fx.legitReplies.filter((p) => detectUnfulfilledPromise(p).promise);
  assert.ok(fx.legitReplies.length - flagged.length >= 24, `sinalizadas demais (${flagged.length}): ${JSON.stringify(flagged)}`);
  // as únicas aceitas como sinalizadas são as duas conhecidas (espera solta e "vou ler com calma, mas já adianto")
  for (const t of flagged) assert.ok(/^Já volto, vou pegar uma água kkk$|^Vou ler com calma, mas já adianto: parece ok\.$/.test(t), t);
});
await test('Q39: regra de cauda: conteúdo DEPOIS da promessa = resposta entregue; só promessa (ou promessa + até 15 letras) continua promessa', () => {
  for (const t of [
    'Deixa eu ver... acho que o Hytale ainda não tem data certa, mas o último anúncio falava de 2026.',
    'Um segundo, deixa eu calcular: 2400 dividido por 200 dá 12 dias.',
    'Pesquisando na memória... achei! É o Karin Sultan RS Classic.',
    'Pesquisando nas fontes que achei... o preço fica entre R$ 3.799 e R$ 3.999 [1][2].',
    'Vou pesquisar isso. Enquanto isso, que tal jogar?',
  ]) assert.equal(detectUnfulfilledPromise(t).promise, false, t);
  for (const t of ['Vou pesquisar isso!', 'Pesquisando...', 'Um segundo, já te respondo', 'Vou pesquisar isso! Já volto!', 'Deixa eu dar uma olhada. Um instante.']) {
    assert.equal(detectUnfulfilledPromise(t).promise, true, t);
  }
});
await test('os dois incidentes reais do historico.txt são promessa', () => {
  assert.equal(detectUnfulfilledPromise(FIN.reply).promise, true);
  assert.equal(detectUnfulfilledPromise(MODS.reply).promise, true);
});
await test('tipo e força: "Vou pesquisar isso!" é consulta forte; "Pesquisando..." é progresso; "Um segundo, já te respondo" é espera', () => {
  assert.deepEqual(pick(detectUnfulfilledPromise('Vou pesquisar isso!')), { promise: true, kind: 'future-lookup', strength: 'strong' });
  assert.equal(detectUnfulfilledPromise('Pesquisando...').kind, 'progress');
  assert.equal(detectUnfulfilledPromise('Um segundo, já te respondo').promise, true);
  assert.equal(detectUnfulfilledPromise('Vou ver o que encontro.').strength, 'weak');
  assert.equal(detectUnfulfilledPromise('Quer que eu pesquise isso?').kind, 'offer');
});
await test('negação, entrega no mesmo texto e rodapé não viram promessa', () => {
  assert.equal(detectUnfulfilledPromise('Não vou pesquisar isso, é um tema que eu já conheço: saiu em 2023.').promise, false);
  assert.equal(detectUnfulfilledPromise('Nunca mais vou pesquisar nada kkk').promise, false);
  assert.equal(detectUnfulfilledPromise('Já te mando o link do servidor: https://exemplo.test/convite').promise, false, 'link = entrega');
  assert.equal(detectUnfulfilledPromise('Vou pesquisar aqui, olha o que achei:\n- Hytale\n- Patch notes').promise, false, 'lista = entrega');
  assert.equal(detectUnfulfilledPromise(`${'Resposta completa e longa. '.repeat(20)}Vou pesquisar mais depois.`).promise, false, 'tem conteúdo de sobra');
  assert.equal(detectUnfulfilledPromise('Vou pesquisar isso!\n-# 🧠 Gemini | ⏱️ 2.1s').promise, true, 'o rodapé não atrapalha');
  assert.equal(detectUnfulfilledPromise('Hm, essa eu não sei de cabeça — vou dar uma checada agora.').promise, true, 'negação longe do verbo não anula');
  assert.equal(detectUnfulfilledPromise('Ei, vou buscar meu café ☕').promise, false, 'vou buscar um café não é pesquisa');
});
await test('reação ("espera aí, quê?"), apoio ("calma aí, respira") e instrução ao usuário ("aguarde, o servidor reinicia") não são promessa', () => {
  for (const t of ['Espera aí, isso não faz sentido kkk', 'Calma aí, respira fundo que vai dar certo', 'Peraí, quê?', 'Aguarde um momento, o servidor está reiniciando.',
    'Aguarde 5 minutos antes de tentar de novo.', 'Segura a onda, é só um bug.']) {
    assert.equal(detectUnfulfilledPromise(t).promise, false, t);
  }
  for (const t of ['Peraí que eu vou ver isso', 'Segura aí, vou pesquisar', 'Calma aí que vou procurar!', 'Aguarde um instante enquanto eu verifico.', 'Só um momento que eu vou checar']) {
    assert.equal(detectUnfulfilledPromise(t).promise, true, t);
  }
});
await test('com e sem acento, maiúsculas e letras alongadas', () => {
  for (const t of ['VOU PESQUISAR ISSO!', 'vou pesquisar isso', 'Peraí que eu vou ver isso', 'pera ai que eu vou ver isso', 'Já volto!']) {
    assert.equal(detectUnfulfilledPromise(t).promise, true, t);
  }
});
await test('vazio, nulo e texto sem letras nunca lançam', () => {
  for (const t of [undefined, null, '', '   ', '🔎🔎', 42, {}, []]) assert.equal(detectUnfulfilledPromise(t).promise, false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('2. Pedido de pesquisa do usuário e consulta');
await test(`os ${fx.requests.length} pedidos conhecidos são reconhecidos`, () => {
  const missed = fx.requests.filter((t) => !detectSearchRequest(t, { now: NOW }).wanted);
  assert.deepEqual(missed, [], `não reconhecidos: ${JSON.stringify(missed)}`);
});
await test(`nenhuma das ${fx.nonRequests.length} frases comuns é tratada como pedido de pesquisa`, () => {
  const fp = fx.nonRequests.filter((t) => detectSearchRequest(t, { now: NOW }).wanted);
  assert.deepEqual(fp, [], `falsos positivos: ${JSON.stringify(fp)}`);
});
await test('pergunta sobre a CAPACIDADE ("você consegue pesquisar?") não é pedido; com assunto é', () => {
  for (const t of ['você consegue pesquisar na internet?', 'você sabe pesquisar?', 'yui, você pode buscar na web?']) {
    const d = detectSearchRequest(t, { now: NOW });
    assert.equal(d.wanted, false, t);
    assert.equal(d.capability, true, t);
    assert.equal(d.blocked, 'capability', t);
  }
  assert.equal(detectSearchRequest('você pode pesquisar o preço da RTX 4060?', { now: NOW }).explicit, true);
});
await test('negação, "como pesquisar" e "vou pesquisar" (1ª pessoa) NÃO são pedido, mesmo tendo o verbo (explicit false, com o motivo)', () => {
  const cases = [
    ['yui não pesquise nada, só conversa comigo', 'negated'], ['não precisa pesquisar não yui', 'negated'], ['sem pesquisar, o que você acha?', 'negated'],
    ['pesquisa isso (mas sem usar o google)', 'negated'], ['nem precisa pesquisar, deixa quieto', 'negated'], ['yui não quero que você pesquise isso', 'negated'],
    ['como pesquisar no google?', 'howto'], ['onde eu busco legendas de filmes?', 'howto'], ['como faço uma pesquisa no google acadêmico?', 'howto'],
    ['vou pesquisar isso depois', 'statement'], ['to procurando um bom jogo de terror', 'statement'], ['eu vou procurar um apartamento no centro', 'statement'],
  ];
  for (const [text, blocked] of cases) {
    const d = detectSearchRequest(text, { now: NOW });
    if (blocked) {
      assert.equal(d.explicit, false, text);
      assert.equal(d.wanted, false, text);
      assert.equal(d.blocked, blocked, text);
    } else {
      assert.equal(d.blocked, '', text);
    }
  }
  // não confundir: vírgula quebra a negação; "quando puder" e "qual o preço" não são "como pesquisar"; "sem enrolar" e "não esquece" não negam
  assert.equal(detectSearchRequest('não sei, pesquise o preço do ps5', { now: NOW }).explicit, true);
  assert.equal(detectSearchRequest('não, pesquise o preço do ps5', { now: NOW }).explicit, true);
  assert.equal(detectSearchRequest('sem enrolar pesquise o preço do ps5', { now: NOW }).explicit, true);
  assert.equal(detectSearchRequest('qual o preço do ps5 pesquise aí', { now: NOW }).blocked, '');
  assert.equal(detectSearchRequest('qual o preço do ps5 pesquise aí', { now: NOW }).explicit, true);
  assert.equal(detectSearchRequest('não esquece de pesquisar o preço do ps5', { now: NOW }).blocked, '');
  assert.equal(detectSearchRequest('como faço uma pesquisa no google acadêmico?', { now: NOW }).blocked, 'howto');
  assert.equal(detectSearchRequest('yui, quando puder, pesquise o preço do ps5', { now: NOW }).explicit, true);
});
await test('explícito x dado atual', () => {
  assert.equal(detectSearchRequest('pesquise sobre Hytale', { now: NOW }).explicit, true);
  const fresh = detectSearchRequest('qual a notícia de hoje sobre o GTA VI?', { now: NOW });
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.explicit, false);
  assert.equal(detectSearchRequest('que dia é hoje?', { now: NOW }).wanted, false, '"hoje" sozinho não é pesquisa');
});
await test('consultas limpas (sem "pesquisa aí pra mim"), com acento e com o ano só em dado que muda', () => {
  const cases = [
    ['pesquise sobre Hytale', 'Hytale'],
    ['dá uma pesquisadinha rápida sobre Silksong', 'Silksong'],
    ['pesquisa aí quem ganhou o jogo do Flamengo ontem', 'quem ganhou o jogo do Flamengo ontem'],
    ['procura pra mim o patch notes do GTA', 'o patch notes do GTA 2026'],
    ['Yui, pesquisa isso pra mim: melhor build de Elden Ring', 'melhor build de Elden Ring'],
    ['quando sai o próximo evento semanal de GTA Online?', 'quando sai o próximo evento semanal de GTA Online 2026'],
    ['por favor, pesquise o que mudou na última atualização do Valorant', 'o que mudou na última atualização do Valorant 2026'],
    ['faz uma pesquisa rápida sobre o novo console da Valve', 'o novo console da Valve'],
    ['pesquisaaa sobre a Hypixel Studios', 'a Hypixel Studios'],
  ];
  for (const [text, want] of cases) assert.equal(buildSearchQuery(text, { now: NOW }), want, text);
  assert.equal(buildSearchQuery('procura pra mim o patch notes do GTA', { now: NOW, withYear: false }), 'o patch notes do GTA');
  assert.ok(buildSearchQuery(`pesquise ${'x'.repeat(500)}`, { now: NOW }).length <= 200);
});
await test('"pesquisa isso" / "procura aí" não têm assunto: a consulta fica vazia e pede o assunto', () => {
  for (const t of ['pesquisa isso', 'procura aí', 'pesquisa']) assert.equal(detectSearchRequest(t, { now: NOW }).query, '', t);
  assert.equal(detectSearchRequest('pesquisa isso', { now: NOW }).needsTopic, true);
});
await test('cotação de moeda aponta para convert_currency (a descrição da ferramenta proíbe search_web para isso)', () => {
  const d = detectSearchRequest('dá uma pesquisada no preço do dólar hoje', { now: NOW });
  assert.equal(d.route, 'convert_currency');
  assert.deepEqual(d.args, { amount: 1, from: 'USD', to: 'BRL' });
  assert.deepEqual(detectSearchRequest('quanto é 50 euros hoje? pesquisa aí', { now: NOW }).args, { amount: 50, from: 'EUR', to: 'BRL' });
  assert.equal(detectSearchRequest('pesquise sobre Hytale', { now: NOW }).route, null);
});
await test('palavras-chave e consulta sã (utilitários que o agente importa daqui)', () => {
  assert.deepEqual(keywordsOf('pesquise o preço do PS5 hoje'), ['preco', 'ps5', 'hoje']);
  assert.equal(saneQuery('"preço do dólar"'), 'preço do dólar');
  assert.equal(saneQuery('https://exemplo.test/x'), '');
  assert.equal(saneQuery('ab'), '');
  assert.equal(saneQuery(undefined), '');
  assert.equal(lineCount('a\n\n b \n'), 2);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('3. Pré-rota estrita (Porta A): só pesquisa web inequívoca');
const explicit = (t) => preRouteDecision(t, { direct: true, now: NOW }).explicit;
await test('Q40: pelo menos 28 de 30 positivos pesquisam', () => {
  const ok = fx.preRoutePositives.filter(explicit);
  assert.equal(fx.preRoutePositives.length, 30);
  assert.ok(ok.length >= 28, `só ${ok.length}/30; perdidos: ${JSON.stringify(fx.preRoutePositives.filter((t) => !explicit(t)))}`);
});
await test('Q40: 0 falsos positivos nos 34 negativos do plano (conversa, negação, como pesquisar, ferramenta própria, link, lista, texto longo, moeda)', () => {
  const neg = [...fx.preRouteNegatives, ...GENERATED_NEG];
  assert.equal(neg.length, 34);
  const fp = neg.filter(explicit);
  assert.deepEqual(fp.map((t) => t.slice(0, 60)), []);
});
await test('Q40: 0 de 17 pedidos que NÃO são web viram pesquisa (confere, ache, encontre, descubra, verifique, nome, tema, sinônimo...)', () => {
  assert.equal(fx.notWeb.length, 17);
  assert.deepEqual(fx.notWeb.filter(explicit), []);
});
await test('Q40: 0 de 4 pedidos de música/clipe/letra/nota de jogo (têm ferramenta própria)', () => {
  assert.equal(fx.musicGame.length, 4);
  assert.deepEqual(fx.musicGame.filter(explicit), []);
  for (const t of ['yui pesquisa o álbum novo do Coldplay', 'yui busca a cifra de Wonderwall', 'yui pesquisa a playlist de rock']) assert.equal(explicit(t), false, t);
});
await test('motivos da pré-rota e consulta devolvida', () => {
  const r = (t, o) => preRouteDecision(t, { direct: true, now: NOW, ...o });
  assert.deepEqual(r('yui pesquise o preço do ps5', { voice: true }), { explicit: false, reason: 'voice' });
  assert.equal(r('x'.repeat(601)).reason, 'size');
  assert.equal(r(MODS.user).reason, 'size', 'lista de 45 linhas');
  assert.equal(r('yui pesquisa https://exemplo.test/a').reason, 'url');
  assert.equal(r('yui não pesquise isso').reason, 'negated');
  assert.equal(r('como pesquisar no google?').reason, 'howto');
  assert.equal(r('vou pesquisar o preço do iphone amanhã').reason, 'statement');
  assert.equal(r('yui você consegue pesquisar na internet?').reason, 'capability');
  assert.equal(r('yui pesquisa os requisitos do cyberpunk').reason, 'other_tool');
  assert.equal(r('yui busca a letra de Evidências').reason, 'music_game');
  assert.equal(r('oi yui tudo bem?').reason, 'no_trigger');
  assert.equal(r('yui pesquisa o dólar hoje').reason, 'currency_tool');
  assert.equal(r('yui pesquisa isso').reason, 'no_subject');
  assert.equal(r('yui ache um sinônimo pra feliz').reason, 'not_web');
  const ok = r('Yui, pesquisa aí por favor sobre o novo update do GTA?');
  assert.deepEqual([ok.explicit, ok.reason], [true, 'trigger']);
  assert.match(ok.query, /update do GTA/);
  assert.ok(!/pesquis|por favor|yui/i.test(ok.query), ok.query);
});
await test('texto que não é string nunca lança', () => {
  for (const t of [undefined, null, 42, {}, []]) assert.equal(preRouteDecision(t, { direct: true }).explicit, false);
});
await test('Q43: contexto: sem chamada direta (conversa espontânea), /chat_resumo, rádio e voz NUNCA pré-roteiam, mesmo com pedido perfeito', () => {
  const ask = 'yui pesquise o preço do ps5 hoje';
  assert.equal(preRouteDecision(ask, { direct: true, now: NOW }).explicit, true);
  assert.deepEqual(preRouteDecision(ask, { now: NOW }), { explicit: false, reason: 'not_direct' }, 'padrão seguro: sem direct não pesquisa');
  assert.deepEqual(preRouteDecision(ask, { direct: false, now: NOW }), { explicit: false, reason: 'not_direct' });
  for (const flags of [{ thirdPartyPrompt: true }, { disableTools: true }, { radioMode: true }]) {
    assert.deepEqual(preRouteDecision(ask, { direct: true, now: NOW, ...flags }), { explicit: false, reason: 'context' }, JSON.stringify(flags));
  }
  assert.deepEqual(preRouteDecision(ask, { direct: true, voice: true, now: NOW }), { explicit: false, reason: 'voice' });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('4. Consulta tirada da PROMESSA do modelo');
await test('o caso real de 14/10: a consulta sai do objeto da promessa, sem "pra te dar opções"', () => {
  const q = queryFromPromise(FIN.reply);
  assert.match(q, /financiamento/);
  assert.match(q, /Rio de Janeiro/);
  assert.ok(!/te dar|pra /i.test(q), q);
});
await test('objeto vago ("isso", "tudo") ou curto não vira consulta', () => {
  for (const t of ['Vou pesquisar isso pra você!', 'Vou procurar isso agora.', 'Vou pesquisar.', 'Vou pesquisar tudo.', 'Vou ver o que acho.', 'Olá', '', undefined]) {
    assert.equal(queryFromPromise(t), '', String(t));
  }
  assert.match(queryFromPromise(MODS.reply), /CurseForge/, 'a consulta existe; quem barra o caso dos 45 mods é o tamanho do pedido (recoveryPlan)');
  assert.match(queryFromPromise('Beleza, vou procurar o horário do jogo do Flamengo e já te falo.'), /Flamengo/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('5. O que fazer com a promessa (recoveryPlan, Porta C)');
const D = { direct: true, now: NOW }; // chamada direta à Yui
const plan = (o) => recoveryPlan({ ...D, ...o });
await test('Q01: caso real de 14/10 (fala sem verbo de pesquisa + promessa de buscar dados) => pesquisa com a consulta da PROMESSA', () => {
  const p = plan({ reply: FIN.reply, userText: FIN.user });
  assert.equal(p.action, 'search');
  assert.match(p.query, /financiamento/);
  assert.equal(p.private, false);
  assert.equal(p.reason, 'consulta tirada da promessa');
  assert.match(p.intent, /financiamento/, 'a intenção anunciada vai à síntese');
});
await test('Q02: caso real dos 45 mods => NÃO pesquisa; pede a resposta final ao modelo', () => {
  const p = plan({ reply: MODS.reply, userText: MODS.user });
  assert.equal(p.action, 'regenerate');
  assert.match(p.reason, /grande demais/);
});
await test('promessa + pedido explícito => pesquisa com a pergunta ORIGINAL (não com o texto da promessa)', () => {
  const p = plan({ reply: 'Vou pesquisar isso!', userText: 'pesquise sobre Hytale' });
  assert.equal(p.action, 'search');
  assert.equal(p.query, 'Hytale');
  assert.ok(!('intent' in p), 'consulta do usuário não leva intenção');
});
await test('promessa + pergunta de dado atual sem verbo => pesquisa', () => {
  const p = plan({ reply: 'Deixa eu dar uma olhada', userText: 'qual a notícia de hoje sobre o GTA VI?' });
  assert.equal(p.action, 'search');
  assert.match(p.query, /GTA VI/);
});
await test('conversa SENSÍVEL sem pesquisa privada liberada: recusa curta, nunca pesquisa', () => {
  const p = plan({ reply: 'Vou pesquisar isso!', userText: 'pesquise sobre Hytale', sensitive: true });
  assert.deepEqual([p.action, p.message], ['refuse', SENSITIVE_SEARCH_REFUSAL]);
});
await test('voz: recusa de voz, sem pesquisar', () => {
  const p = plan({ reply: 'Vou pesquisar isso!', userText: 'pesquise o preço do ps5', voice: true });
  assert.deepEqual([p.action, p.message], ['refuse', VOICE_REFUSAL]);
  assert.match(VOICE_REFUSAL, /voz/);
});
await test('ferramenta search_web desligada no servidor: avisa em vez de prometer', () => {
  const p = plan({ reply: 'Vou pesquisar isso!', userText: 'pesquise sobre Hytale', searchAvailable: false });
  assert.deepEqual([p.action, p.message], ['refuse', SEARCH_DISABLED_REPLY]);
});
await test('sem assunto ("pesquisa isso"): pergunta o assunto', () => {
  const p = plan({ reply: 'Vou pesquisar!', userText: 'yui pesquisa isso' });
  assert.deepEqual([p.action, p.message], ['ask', NEED_TOPIC_REPLY]);
});
await test('cotação: chama convert_currency (e guarda a consulta para o caso da ferramenta estar desligada)', () => {
  const p = plan({ reply: 'Vou pesquisar isso!', userText: 'dá uma pesquisada no preço do dólar hoje' });
  assert.equal(p.action, 'route');
  assert.equal(p.tool, 'convert_currency');
  assert.deepEqual(p.args, { amount: 1, from: 'USD', to: 'BRL' });
  assert.ok(p.query);
});
await test('promessa sem pedido de pesquisa (conhecimento, ou assunto sem relação com a fala): pede ao modelo a resposta final, sem pesquisar', () => {
  assert.equal(plan({ reply: 'Um segundo, já te respondo', userText: 'me explica como funciona o rollback netcode' }).action, 'regenerate');
  assert.equal(plan({ reply: 'Um segundo, já te respondo', userText: 'yui qual a capital da frança?' }).action, 'regenerate');
  assert.equal(plan({ reply: 'Vou buscar dados sobre a previsão do tempo em Paris pra você.', userText: 'oi yui' }).action, 'regenerate');
  const q = buildNoPromiseRetryPrompt('me explica "rollback"');
  assert.match(q, /Responda AGORA/);
  assert.ok(!q.includes('"rollback"'), 'aspas do usuário não quebram o prompt');
});
await test('oferta ("Quer que eu pesquise?") só vira ação quando o usuário JÁ pediu a pesquisa', () => {
  assert.equal(plan({ reply: 'Quer que eu pesquise isso?', userText: 'pesquise sobre Hytale' }).action, 'search');
  assert.equal(plan({ reply: 'Quer que eu pesquise isso?', userText: 'yui me conta uma piada' }).action, 'none');
});
await test('"já volto kkk" solto, sem pedido nem pergunta, passa; com pergunta pendente pede a resposta final', () => {
  assert.equal(plan({ reply: 'Já volto kkkk', userText: 'yui vou ali comer' }).action, 'none');
  assert.equal(plan({ reply: 'Já volto!', userText: 'yui qual o melhor carro?' }).action, 'regenerate');
});
await test('resposta normal => nada a fazer', () => {
  assert.equal(plan({ reply: 'O Hytale entrou em acesso antecipado em 2026.', userText: 'pesquise sobre Hytale' }).action, 'none');
  assert.equal(plan({ reply: 'O dólar está em R$ 5,40 segundo as fontes.', userText: 'pesquise o dólar' }).action, 'none');
});
await test('Q43: sem chamada direta (conversa espontânea) nunca pesquisa: pede a resposta final (ou deixa passar a espera solta)', () => {
  const p = recoveryPlan({ reply: 'Vou pesquisar isso!', userText: 'pesquise sobre Hytale', now: NOW }); // direct omitido = false
  assert.equal(p.action, 'regenerate');
  assert.match(p.reason, /sem chamada direta/);
  assert.equal(recoveryPlan({ reply: 'Vou buscar dados de preços de financiamento e manutenção no Rio de Janeiro pra te dar opções precisas.', userText: FIN.user, direct: false, now: NOW }).action, 'regenerate');
  assert.equal(recoveryPlan({ reply: 'Já volto kkkk', userText: 'a galera tá animada hoje', direct: false, now: NOW }).action, 'none');
});
await test('Q43: /chat_resumo (thirdPartyPrompt, disableTools) e rádio nunca pesquisam', () => {
  for (const flags of [{ thirdPartyPrompt: true }, { disableTools: true }, { radioMode: true }]) {
    const p = plan({ reply: 'Vou pesquisar isso!', userText: 'pesquise sobre Hytale', ...flags });
    assert.equal(p.action, 'none', JSON.stringify(flags));
  }
});
await test('Q43: sem fala do autor (userText ausente, nulo ou número) a promessa pede a resposta final', () => {
  for (const userText of [undefined, null, 42, '']) assert.equal(plan({ reply: 'Vou pesquisar isso!', userText }).action, 'regenerate');
});
await test('pesquisa PRIVADA liberada: só em pedido explícito e estrito, com a consulta tirada do texto literal da mensagem', () => {
  const priv = { sensitive: true, privateSearch: true };
  const p = plan({ reply: 'Vou pesquisar isso!', userText: 'Yui, pesquise o preço do ps5 hoje', ...priv });
  assert.equal(p.action, 'search');
  assert.equal(p.private, true);
  assert.equal(p.query, 'o preço do ps5 hoje 2026');
  assert.ok(!('intent' in p));
  // pedido frouxo (verbo ambíguo de fora da pré-rota): não pesquisa no privado
  assert.equal(plan({ reply: 'Vou pesquisar isso!', userText: 'yui confere se o meu nome tá certo: João Paulo da Silva', ...priv }).action, 'regenerate');
  // promessa com assunto de contexto (o modelo leu histórico/memória): nunca vira consulta no privado
  assert.equal(plan({ reply: FIN.reply, userText: FIN.user, ...priv }).action, 'regenerate');
  // dado atual sem verbo no privado: não pesquisa
  assert.equal(plan({ reply: 'Deixa eu dar uma olhada', userText: 'qual a notícia de hoje sobre o GTA VI?', ...priv }).action, 'regenerate');
  // privado liberado mas ferramenta desligada ou cotação seguem as mesmas regras
  assert.equal(plan({ reply: 'Vou pesquisar isso!', userText: 'pesquise o preço do ps5', searchAvailable: false, ...priv }).action, 'refuse');
  assert.equal(plan({ reply: 'Vou pesquisar isso!', userText: 'dá uma pesquisada no preço do dólar hoje', ...priv }).action, 'route');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('6. Última guarda (finalGuard, Porta D)');
await test('troca SÓ a promessa vazia pelo aviso honesto; mantém o rodapé', () => {
  assert.equal(PROMISE_ONLY_FALLBACK, 'Desculpe, tive um erro ao fechar essa resposta. Pode perguntar de novo?');
  assert.equal(finalGuard('Vou pesquisar isso!'), PROMISE_ONLY_FALLBACK);
  assert.equal(finalGuard('Vou pesquisar isso!\n-# 🧠 Gemini'), `${PROMISE_ONLY_FALLBACK}\n-# 🧠 Gemini`);
  assert.equal(finalGuard('Vou pesquisar isso!\n-# modelo x\n-# 2.1s'), `${PROMISE_ONLY_FALLBACK}\n-# modelo x\n-# 2.1s`);
  assert.equal(finalGuard('O jogo saiu em 2023.'), 'O jogo saiu em 2023.');
  assert.equal(finalGuard(undefined), '');
});
await test('"Desculpe, tive um erro" é o marcador que o messageCreate/isErrorReply já tratam como erro da IA', () => {
  assert.match(PROMISE_ONLY_FALLBACK, /Desculpe, tive um erro/);
  const ctx = fs.readFileSync(path.join(repoRoot, 'src/core/context/contextStore.js'), 'utf8');
  assert.match(ctx, /Desculpe, tive um erro/);
});
await test('com ação de verdade nesta troca (hadAction) não mexe; oferta passa; espera solta passa sem pergunta e é trocada com pergunta', () => {
  assert.equal(finalGuard('Vou pesquisar mais um pouco', { hadAction: true }), 'Vou pesquisar mais um pouco');
  assert.equal(finalGuard('Quer que eu pesquise isso?'), 'Quer que eu pesquise isso?');
  assert.equal(finalGuard('Já volto kkkk'), 'Já volto kkkk');
  assert.equal(finalGuard('Já volto!', { userNeedsAnswer: true }), PROMISE_ONLY_FALLBACK);
  assert.equal(finalGuard('Pesquisei e achei isso: o patch saiu ontem.'), 'Pesquisei e achei isso: o patch saiu ontem.');
});
await test('Q39: nenhuma resposta legítima do fixture é tocada; as promessas são trocadas quando há pergunta pendente', () => {
  const touched = fx.nonPromises.filter((t) => finalGuard(t) !== t);
  assert.deepEqual(touched, []);
  const kept = fx.promises.filter((t) => finalGuard(t, { userNeedsAnswer: true }) === t && inspectFinalGuard(t, { userNeedsAnswer: true }).reason !== 'oferta');
  assert.deepEqual(kept, [], `promessas que passaram: ${JSON.stringify(kept)}`);
});
await test('inspectFinalGuard devolve só metadados (para o modo observe)', () => {
  assert.deepEqual(inspectFinalGuard('Vou pesquisar isso!'), { replace: true, reason: 'promessa vazia', kind: 'future-lookup', strength: 'strong' });
  assert.deepEqual(inspectFinalGuard('O jogo saiu.'), { replace: false, reason: 'sem promessa' });
  assert.deepEqual(inspectFinalGuard('Vou pesquisar', { hadAction: true }), { replace: false, reason: 'houve ação' });
  const none = inspectFinalGuard('Já volto kkk');
  assert.equal(none.replace, false);
  assert.ok(!JSON.stringify(none).includes('kkk'), 'nunca devolve o texto');
});
await test('userNeedsAnswer: pergunta, "me explica", pedido de pesquisa; conversa solta não', () => {
  for (const t of ['qual a capital da frança?', 'yui, como funciona o rollback', 'me explica isso', 'pesquise sobre Hytale', 'yui tá aí?']) assert.equal(userNeedsAnswer(t), true, t);
  for (const t of ['yui vou ali comer', 'kkkk boa', '', undefined]) assert.equal(userNeedsAnswer(t), false, String(t));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('7. Desempenho e ReDoS (Q38): toda entrada é cortada em 700 caracteres');
const now = () => performance.now();
const timed = (fn) => { const t0 = now(); fn(); return now() - t0; };
const REPEAT_TOKENS = ['yui', 'oi', 'ola', 'ei', 'e ai'];
await test('Q38: "yui, " (e oi, ola, ei, "e ai") repetido 200 vezes: cada detector abaixo de 50 ms', () => {
  const detectors = {
    detectSearchRequest: (s) => detectSearchRequest(s),
    detectUnfulfilledPromise: (s) => detectUnfulfilledPromise(s),
    buildSearchQuery: (s) => buildSearchQuery(s),
    preRouteDecision: (s) => preRouteDecision(s, { direct: true }),
    recoveryPlan: (s) => recoveryPlan({ reply: s, userText: s, direct: true }),
    userNeedsAnswer: (s) => userNeedsAnswer(s),
    queryFromPromise: (s) => queryFromPromise(s),
    finalGuard: (s) => finalGuard(s, { userNeedsAnswer: true }),
  };
  for (const tok of REPEAT_TOKENS) {
    for (const suffix of ['', ' pesquise o preco do ps5', ' voce consegue pesquisar?', ' vou pesquisar isso']) {
      const text = `${`${tok}, `.repeat(200)}${suffix}`;
      for (const [name, fn] of Object.entries(detectors)) {
        const ms = timed(() => fn(text));
        assert.ok(ms < 50, `${name} com "${tok}" x200${suffix ? ` + "${suffix.trim()}"` : ''} levou ${ms.toFixed(1)} ms`);
      }
    }
  }
});
await test('Q38: o texto de 100 mil caracteres é cortado em 700: nada passa de 50 ms, e o que está além do corte não conta', () => {
  assert.equal(MAX_DETECT_CHARS, 700);
  assert.equal(clipInput('a'.repeat(5000)).length, 700);
  const big = `${'kkkk '.repeat(20000)}pesquise o preço do ps5`;
  assert.ok(timed(() => detectSearchRequest(big)) < 50);
  assert.ok(timed(() => detectUnfulfilledPromise(big)) < 50);
  assert.equal(detectSearchRequest(`${'a '.repeat(400)}pesquise o preço do ps5`).explicit, false, 'pedido depois do corte não conta');
  assert.equal(detectUnfulfilledPromise(`${'conteúdo '.repeat(100)} vou pesquisar isso`).promise, false);
  assert.equal(detectUnfulfilledPromise(`vou pesquisar isso ${'x'.repeat(50000)}`).promise, true, 'cabeça de promessa pura segue promessa (e rápido)');
});
await test('Q38: fuzz de repetição (um token x26 com cada separador e sufixo, contra todos os detectores): 0 chamadas acima de 300 ms', () => {
  const tokens = ['yui', 'oi', 'ola', 'ei', 'e ai', 'ai', 'po', 'bom', 'ok', 'beleza', 'mano', 'cara', 'pf', 'pfv', 'por favor', 'vamos', 'bora', 've', 'veja', 'olha',
    'pera', 'espera', 'segura', 'calma', 'vou', 'ja', 'so', 'logo', 'agora', 'rapidinho', 'tentar', 'te', 'me', 'nao', 'nunca', 'um', 'momento', 'segundo', 'pesquise',
    'pesquisa', 'procura', 'busca', 'quero', 'saber', 'pode', 'consegue', 'voce', 'vc', 'sabe', 'de', 'a', 'o', 'que', 'eu', 'deixa', 'aguarde', 'volto', 'enquanto',
    'fazer', 'faz', 'uma', 'da', 'dar', 'pra', 'para', 'mim', 'e', 'na', 'no', 'em', 'se', 'sobre', '1', 'x', 'ae', 'la', 'aqui', 'entao', 'mesmo', 'de novo', 'estou', 'to'];
  const seps = [' ', ', ', '. ', '! ', '... ', '\n', ' - ', ': ', ',', ''];
  const suffixes = ['', ' zzz', ' ?', ' pesquisar', ' consegue pesquisar', ' pesquise o preco'];
  const fns = {
    search: (s) => detectSearchRequest(s), promise: (s) => detectUnfulfilledPromise(s), query: (s) => buildSearchQuery(s), pre: (s) => preRouteDecision(s, { direct: true }),
    rec: (s) => recoveryPlan({ reply: s, userText: s, direct: true }), qfp: (s) => queryFromPromise(s), guard: (s) => finalGuard(s, { userNeedsAnswer: true }),
  };
  let calls = 0;
  const slow = [];
  const script = new vm.Script('__fn(__s)');
  const context = vm.createContext({ __fn: null, __s: '' });
  for (const tok of tokens) for (const sep of seps) for (const suf of suffixes) {
    const s = (tok + sep).repeat(26) + suf;
    if (s.length > 590) continue;
    for (const [name, fn] of Object.entries(fns)) {
      context.__fn = fn;
      context.__s = s;
      calls++;
      try { script.runInContext(context, { timeout: 300 }); } catch (e) { slow.push(`${name}|${tok}|${JSON.stringify(sep)}|${e.code ?? e.message}`); }
    }
  }
  assert.ok(calls > 20000, `fuzz pequeno demais (${calls})`);
  assert.deepEqual(slow.slice(0, 10), [], `${slow.length} chamadas passaram de 300 ms`);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log('8. Diagnóstico (não reprova): respostas reais gravadas no historico.txt');
await test('nas respostas reais do historico.txt, só as promessas de verdade são sinalizadas (informativo)', () => {
  const file = path.join(repoRoot, 'src/data/historico.txt');
  if (!fs.existsSync(file)) { console.log('       (historico.txt ausente: nada a medir)'); return; }
  const replies = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('Resposta IA:')).map((l) => l.replace(/^Resposta IA:\s*"?/, '').replace(/"$/, ''));
  const flagged = replies.filter((r) => detectUnfulfilledPromise(r).promise);
  console.log(`       ${replies.length} respostas reais; ${flagged.length} sinalizadas como promessa (esperado: só promessas de verdade)`);
});

console.log(`\n${failures.length === 0 ? 'Tudo certo' : 'COM FALHAS'}: ${passed} teste(s) ok${failures.length ? `, ${failures.length} falhou(aram): ${failures.join(' | ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
