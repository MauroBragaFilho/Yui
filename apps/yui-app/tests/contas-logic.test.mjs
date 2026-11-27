// Testes do Início para as "contas da Yui" (lacunas do painel, entrega B, 26/11/2026): o cartão "Live do YouTube" (só enquanto a Yui está numa live), os
// avisos do Google no buildAlerts (perto de vencer, renovação falhando, autorizar de novo), o cliente da API (GET /v1/admin/live e /google) e a ligação
// na tela. Sem React e sem rede. Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, createClient } from '../src/api/client.ts';
import { AVISO_DE_VENCIMENTO_MS, alertasDoGoogle, cartaoDaLive, duracaoDesde, textoDoErroDaLive } from '../src/contasLogic.ts';
import { buildAlerts } from '../src/overviewLogic.ts';

const AGORA = new Date(2026, 10, 28, 21, 30, 0);
const HORA = 3_600_000;
const DIA = 24 * HORA;
const iso = (ms) => new Date(ms).toISOString();
const LIVE = (over = {}) => ({
  ligado: true, disponivel: true, estado: 'ouvindo', ativo: true, live: { videoId: 'abcdefghijk', titulo: 'Live de sábado' }, desde: iso(AGORA.getTime() - 65 * 60_000),
  mensagens: { lidas: 120, respondidas: 9, espontaneas: 0 }, cota: { dia: '2026-11-28', usado: 2500, limiteDiario: 10000, reserva: 1000, restante: 6500, nivel: 'ok' }, ultimoErro: null, ...over,
});
const GOOGLE = (over = {}) => ({
  ligado: true, conectado: true, arquivo: 'ok', escopos: ['agenda', 'tarefas'], autorizadoEm: iso(AGORA.getTime() - 3 * DIA), venceEm: iso(AGORA.getTime() + 4 * DIA), validade: 'testando-7-dias',
  ultimaRenovacaoEm: iso(AGORA.getTime() - HORA), ultimoErro: null, renovacaoFalhou: false, precisaAutorizar: false, motivoDeAutorizar: null, avisoPendente: false, renovacoes: 3, ...over,
});

test('cartão da live: só aparece enquanto a Yui está numa live (procurando ou ouvindo); desligada, fora de live ou sem resposta, nada', () => {
  assert.equal(cartaoDaLive(null, AGORA), null);
  assert.equal(cartaoDaLive(undefined, AGORA), null);
  assert.equal(cartaoDaLive(LIVE({ ligado: false }), AGORA), null);
  for (const estado of ['ociosa', 'encerrada', 'interrompida', 'desligado']) assert.equal(cartaoDaLive(LIVE({ estado, ativo: false, live: null }), AGORA), null, estado);
  assert.ok(cartaoDaLive(LIVE(), AGORA));
  assert.deepEqual(cartaoDaLive(LIVE({ estado: 'procurando' }), AGORA).estado, { texto: 'Procurando o chat', tom: 'atencao' });
});

test('cartão da live: título, desde quando (com a duração), lidas, respostas, cota em unidades e em porcentagem', () => {
  const c = cartaoDaLive(LIVE({ mensagens: { lidas: 120, respondidas: 9, espontaneas: 2 } }), AGORA);
  assert.equal(c.titulo, 'Live de sábado');
  assert.deepEqual(c.estado, { texto: 'No chat', tom: 'ok' });
  const linha = (r) => c.linhas.find((l) => l.rotulo === r)?.valor;
  assert.equal(linha('Desde'), 'hoje às 20:25 (há 1 h 05 min)');
  assert.equal(linha('Mensagens lidas'), '120');
  assert.equal(linha('Respostas dela'), '9 (+2 puxando assunto)');
  assert.equal(linha('Cota de hoje'), '2.500 de 10.000 unidades (25%)');
  assert.deepEqual([c.cota.percentual, c.cota.tom], [25, 'ok']);
  assert.equal(c.nota, null);
  // sem título: o id; sem contadores nem cota: "—" (nada inventado); cota apertada muda o tom
  const sem = cartaoDaLive(LIVE({ live: { videoId: 'abcdefghijk', titulo: null }, mensagens: null, cota: null, desde: null }), AGORA);
  assert.equal(sem.titulo, 'Vídeo abcdefghijk');
  assert.deepEqual(sem.linhas.map((l) => l.valor), ['—', '—', '—', '—']);
  assert.equal(sem.cota, null);
  assert.equal(cartaoDaLive(LIVE({ cota: { usado: 9500, limiteDiario: 10000, nivel: 'critico' } }), AGORA).cota.tom, 'critico');
  assert.equal(cartaoDaLive(LIVE({ cota: { usado: 12000, limiteDiario: 10000, nivel: 'esgotada' } }), AGORA).cota.percentual, 100, 'a barra não passa de 100%');
});

test('cartão da live: só mostra o erro que aconteceu DEPOIS de entrar nesta live, em português (código desconhecido aparece como código)', () => {
  const desde = AGORA.getTime() - HORA;
  assert.equal(cartaoDaLive(LIVE({ desde: iso(desde), ultimoErro: { codigo: 'cota_esgotada', em: iso(desde - 1000) } }), AGORA).nota, null, 'o erro de antes não conta');
  assert.equal(cartaoDaLive(LIVE({ desde: iso(desde), ultimoErro: { codigo: 'nao-escreve', em: iso(desde + 1000) } }), AGORA).nota, 'Último erro: o YouTube não deixou escrever no chat.');
  assert.equal(textoDoErroDaLive('codigo-novo'), 'erro (código codigo-novo)');
  assert.equal(textoDoErroDaLive(null), '—');
});

test('duração: minutos, horas e minutos, horas cheias; sem data, inválida ou no futuro: null', () => {
  assert.equal(duracaoDesde(iso(AGORA.getTime() - 12 * 60_000), AGORA), '12 min');
  assert.equal(duracaoDesde(iso(AGORA.getTime() - 3 * HORA), AGORA), '3 h');
  assert.equal(duracaoDesde(iso(AGORA.getTime() - (2 * HORA + 7 * 60_000)), AGORA), '2 h 07 min');
  for (const nada of [null, undefined, '', 'lixo', iso(AGORA.getTime() + 60_000)]) assert.equal(duracaoDesde(nada, AGORA), null, String(nada));
});

test('Google: tudo certo ou desligado não avisa; menos de 2 dias para os 7 dias do modo Testando avisa (atenção), com quanto falta', () => {
  assert.deepEqual(alertasDoGoogle(GOOGLE(), AGORA), []);
  assert.deepEqual(alertasDoGoogle(null, AGORA), []);
  assert.deepEqual(alertasDoGoogle(GOOGLE({ ligado: false, conectado: false, precisaAutorizar: false }), AGORA), []);
  assert.equal(AVISO_DE_VENCIMENTO_MS, 2 * DIA);
  assert.deepEqual(alertasDoGoogle(GOOGLE({ venceEm: iso(AGORA.getTime() + 2 * DIA + 60_000) }), AGORA), [], 'mais de 2 dias: ainda não');
  const perto = alertasDoGoogle(GOOGLE({ venceEm: iso(AGORA.getTime() + DIA + 3 * HORA) }), AGORA);
  assert.equal(perto.length, 1);
  assert.equal(perto[0].level, 'warn');
  assert.match(perto[0].text, /vence em 1 dia e 3 h \(modo Testando\)/);
  assert.match(alertasDoGoogle(GOOGLE({ venceEm: iso(AGORA.getTime() + 5 * HORA) }), AGORA)[0].text, /vence em 5 h/);
  // sem a data da autorização (validade não informada): não avisa de vencimento
  assert.deepEqual(alertasDoGoogle(GOOGLE({ venceEm: null, validade: 'nao-informado' }), AGORA), []);
});

test('Google: passou dos 7 dias sem renovar depois disso é problema; renovou depois dos 7 dias (não está em Testando) não avisa', () => {
  const vencido = AGORA.getTime() - HORA;
  const passou = alertasDoGoogle(GOOGLE({ venceEm: iso(vencido), ultimaRenovacaoEm: iso(vencido - HORA) }), AGORA);
  assert.deepEqual(passou.map((a) => a.level), ['danger']);
  assert.match(passou[0].text, /passou dos 7 dias/);
  assert.deepEqual(alertasDoGoogle(GOOGLE({ venceEm: iso(vencido), ultimaRenovacaoEm: iso(vencido + 60_000) }), AGORA), []);
  assert.equal(alertasDoGoogle(GOOGLE({ venceEm: iso(vencido), ultimaRenovacaoEm: null }), AGORA)[0].level, 'danger');
});

test('Google: renovação falhando avisa (atenção); autorizar de novo, sem arquivo ou arquivo ilegível é problema e vem sozinho', () => {
  const falha = alertasDoGoogle(GOOGLE({ renovacaoFalhou: true, ultimoErro: { codigo: 'rede', em: iso(AGORA.getTime()) } }), AGORA);
  assert.deepEqual(falha.map((a) => a.level), ['warn']);
  assert.match(falha[0].text, /renovação do acesso ao Google falhou \(rede\)/);
  const ambos = alertasDoGoogle(GOOGLE({ renovacaoFalhou: true, ultimoErro: { codigo: 'erro', em: null }, venceEm: iso(AGORA.getTime() + HORA) }), AGORA);
  assert.deepEqual(ambos.map((a) => a.level), ['warn', 'warn'], 'falha e vencimento juntos');
  const recusada = alertasDoGoogle(GOOGLE({ precisaAutorizar: true, motivoDeAutorizar: 'recusada', renovacaoFalhou: true, venceEm: iso(AGORA.getTime() + HORA) }), AGORA);
  assert.deepEqual(recusada.map((a) => a.level), ['danger'], 'autorizar de novo vem sozinho');
  assert.match(recusada[0].text, /recusou a autorização/);
  assert.match(alertasDoGoogle(GOOGLE({ conectado: false, arquivo: 'ausente', precisaAutorizar: true, motivoDeAutorizar: 'sem-arquivo' }), AGORA)[0].text, /falta a autorização/);
  assert.match(alertasDoGoogle(GOOGLE({ conectado: false, arquivo: 'invalido', precisaAutorizar: true, motivoDeAutorizar: 'arquivo-invalido' }), AGORA)[0].text, /não pôde ser lido/);
});

test('buildAlerts: os avisos do Google entram no fim da lista do Início; sem Google (servidor antigo), nada muda', () => {
  const base = { discordOnline: true, aiOk: true, hostLevel: 'ok', agora: AGORA };
  assert.deepEqual(buildAlerts(base), []);
  assert.deepEqual(buildAlerts({ ...base, google: null }), []);
  const out = buildAlerts({ ...base, discordOnline: false, google: GOOGLE({ venceEm: iso(AGORA.getTime() + HORA) }) });
  assert.deepEqual(out.map((a) => a.level), ['danger', 'warn']);
  assert.match(out[1].text, /Google vence em 1 h/);
});

test('cliente: GET /v1/admin/live e /v1/admin/google com o token; os erros do servidor chegam como vieram', async () => {
  const calls = [];
  let resposta = { status: 200, body: LIVE() };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, auth: init?.headers?.Authorization, body: init?.body ?? null });
    return new Response(JSON.stringify(resposta.body), { status: resposta.status, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  assert.equal((await c.admin.live()).estado, 'ouvindo');
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url, calls.at(-1).auth, calls.at(-1).body], ['GET', 'http://yui.local:3939/v1/admin/live', 'Bearer tok-1234567890123456', null]);
  resposta = { status: 200, body: GOOGLE() };
  assert.deepEqual((await c.admin.google()).escopos, ['agenda', 'tarefas']);
  assert.deepEqual([calls.at(-1).method, calls.at(-1).url], ['GET', 'http://yui.local:3939/v1/admin/google']);
  resposta = { status: 403, body: { error: 'Apenas o dono pode usar o painel de administração.' } };
  await assert.rejects(() => c.admin.google(), (e) => e instanceof ApiError && e.status === 403);
});

test('a tela: o Início busca a live e o Google sem travar o resto, mostra o cartão só quando há cartão e passa o Google ao buildAlerts', () => {
  const tela = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'screens', 'OverviewScreen.tsx'), 'utf8');
  assert.match(tela, /Promise\.allSettled\(\[[^\]]*client\.admin\.live\(\), client\.admin\.google\(\)\]\)/, 'junto com as outras leituras, sem derrubar o Início se falhar');
  assert.match(tela, /setLive\(lv\.status === 'fulfilled' \? lv\.value : null\)/);
  assert.match(tela, /buildAlerts\(\{[^}]*google \}\)/);
  assert.match(tela, /const cartaoLive = cartaoDaLive\(live\);/);
  assert.match(tela, /\{cartaoLive \? \(\s*<Card/, 'o cartão só existe quando a lógica devolve um');
  assert.ok(tela.includes('title="Live do YouTube"'));
});
