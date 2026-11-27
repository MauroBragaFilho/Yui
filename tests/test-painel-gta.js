// Lacunas do painel, ENTREGA D, item 9 v1 (27/11/2026; docs/PLANO_LACUNAS_PAINEL.md): GET /v1/admin/gta, SÓ DO DONO e SÓ DE LEITURA.
// O último reset diário, o último semanal VÁLIDO, a última notícia do Newswire, onde cada um foi publicado e o estado das fontes. Os bancos do GTA são do BOT
// (src/database/owners.js): o dado cru é lido lá (src/discord/gtaPainel.js) e a vista com lista fechada de campos é montada lá e limpa de novo no cérebro.
// A. A vista (src/core/api/leiturasDoPainel.js: montarVistaDoGta e limparVistaDoGta) com o dado ENVENENADO: só o resumo legível sai; o Reddit desligado é
//    "desligado" (não erro); em recuo, "em-espera"; o que só vale ao reiniciar; datas do SQLite em UTC; link só de fonte conhecida; idempotente.
// B. O leitor do bot contra os bancos DE VERDADE numa pasta temporária: o semanal inválido mais novo é pulado, onde cada um saiu (servidor e canal), quantos
//    servidores têm canal, e uma leitura que falha não derruba as outras.
// C. A rota HTTP de verdade (processo único): o dono vê (com os nomes de servidor e canal), o membro leva 403, sem token 401, só GET, fora do routeGuard,
//    e nada do texto do post, da análise da IA, da miniatura nem do id da mensagem sai. Sem a ponte do bot, 503.
// D. O cérebro separado: vai ao bot por panel.admin (leitura, sem idempotência), limpa de novo o que volta, barra o membro antes do canal; o bot aceita
//    a leitura nova pelo canal só do dono.
// Num processo só, pasta temporária, sem .env, sem rede de fora. Execução: npm run test:painelgta
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-gta-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const T_OWNER = 'token-do-dono-0123456789abcdef';
const T_MEMBER = 'token-do-membro-0123456789abcdef';
const SEGREDO = 'SEGREDO-DO-GTA-5e2b';
const DB = path.join(tmp, 'db');
const G1 = '300000000000000001';
const G2 = '300000000000000002';
const G3 = '300000000000000003';
const C1 = '400000000000000001';
const C2 = '400000000000000002';
const C3 = '400000000000000003';
const MSG = '500000000000000099';

Object.assign(process.env, {
  DATABASE_DIR: DB, YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', YUI_GATEWAY_IN_CHAIN: 'false',
  LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe', YUI_LOG_DIR: path.join(tmp, 'logs'), YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'secrets', 'search-budget.json'),
});
for (const k of ['YUI_CEREBRO_EXTERNO', 'OWNER_ID', 'OWNER_IDS', 'YUI_READ_ONLY', 'YUI_API_TOKENS', 'YUI_DB_OWNER_ROLE', 'YUI_DB_NATIVE', 'REDDIT_FETCH_MODE']) delete process.env[k];
fs.mkdirSync(DB, { recursive: true });
process.chdir(tmp); // sem .env, sem logs reais

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const L = await imp('src/core/api/leiturasDoPainel.js');
const { initDatabase, closeAllDatabases } = await imp('src/database/db.js');
const S = await imp('src/database/schemas.js');
const { dailyRepository } = await imp('src/database/repositories/dailyRepo.js');
const { weeklyRepository } = await imp('src/database/repositories/weeklyRepo.js');
const { newsRepository } = await imp('src/database/repositories/newsRepo.js');
const { publicationRepository } = await imp('src/database/repositories/publicationRepo.js');
const { guildRepository } = await imp('src/database/repositories/guildRepo.js');
const { lerGtaDoBot, chavesDoSemanal } = await imp('src/discord/gtaPainel.js');
const { createAdmin, registrarServidorDoPainel } = await imp('src/core/api/admin.js');
const { createApiServer, parseTokens } = await imp('src/core/api/server.js');
const { createCerebroAdmin, PANEL_ACTIONS } = await imp('src/cerebro/painel.js');
const { registerBotActions, BOT_PANEL_ACTIONS } = await imp('src/discord/canalCerebro.js');
const { actionForRoute } = await imp('src/core/security/routeGuard.js');

let passed = 0;
const failures = [];
const say = (s) => console.log(s);
const section = (t) => say(`\n${t}`);
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) { failures.push(name); say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 9).join('\n        ')}`); }
};
const ctxDono = { role: 'OWNER', userId: OWNER, platform: 'api' };
// `alvos` (onde dá para republicar) entrou com o item 9 v2 (entrega E, parte 2; tests/test-painel-republicar.js).
const CHAVES_DA_VISTA = ['alvos', 'canais', 'diario', 'erros', 'fontes', 'noticia', 'semanal'];

/** Nada que é texto bruto da fonte, análise da IA, miniatura, id de mensagem ou o segredo plantado pode estar na resposta inteira. */
const PROIBIDOS = [SEGREDO, MSG, 'fullText', 'selftext', 'analysis', 'thumbnail', 'message_id', 'data_json', 'evil.example', 'javascript:'];
function semVazamento(valor, rotulo = '') {
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor);
  for (const p of PROIBIDOS) assert.ok(!texto.includes(p), `${rotulo} vazou: ${p}`);
}

// ── O dado cru que o bot lê (o formato de src/discord/gtaPainel.js), ENVENENADO ──
const DIARIO = {
  date: '2026-11-27', collectedAt: '2026-11-27T06:00:10.000Z', segredo: SEGREDO,
  gunVan: { locationName: 'Paleto Bay', segredo: SEGREDO, weapons: [{ name: 'Railgun', discountPercent: 40, extra: SEGREDO }, { name: `Pistola\u0007 Pesada\n${'x'.repeat(200)}`, discountPercent: 'abc' }, { name: '', discountPercent: 10 }] },
  streetDealers: { dealers: [{ locationName: 'Vespucci Beach', premiumProduct: 'Meth', telefone: SEGREDO }, { locationName: 'Sandy Shores', premiumProduct: null }] },
  collectibles: { shipwreck: { locationName: 'Chumash' }, treasureChests: [{ locationName: 'a' }, { locationName: 'b' }] },
  timeTrials: { rcBandito: { locationName: 'Porto de Los Santos' }, junkEnergyBike: { locationName: 'Mount Chiliad' } },
};
const SEMANAL = {
  id: 'abc123', source: 'reddit', title: 'Weekly Bonuses and Discounts', url: 'https://www.reddit.com/r/gtaonline/comments/abc123/weekly/', createdUtc: 1, selftext: SEGREDO,
  fullText: `texto inteiro do post ${SEGREDO}`, analysis: { destaques: `análise da IA ${SEGREDO}` }, periodo: { inicio: '2026-11-20', fim: '2026-11-27' },
  bonus: [{ multiplicador: 2, atividades: ['Corridas de Pódio', 'Missões de Contato'] }, { multiplicador: 'x', atividades: [] }],
  descontos: ['Grotti Turismo R - 30%', { objeto: SEGREDO }], veiculos: { podium: 'Pegassi Zentorno', prizeRide: 'Ocelot Pariah' }, gunVan: ['Railgun - 40%'],
};

const fontesPadrao = { semanal: true, newswire: false, reserva: true, intervaloSemanal: 30, intervaloNewswire: 30, redditModo: 'browser', redditEspera: { ok: true, retryInMs: 0 }, redditFalhas: 0, salvoSemanal: 'true', salvoNewswire: 'false' };
const bruto = (over = {}) => ({
  fontes: { ...fontesPadrao, ...(over.fontes ?? {}) },
  diario: { resetDate: '2026-11-27', criadoEm: '2026-11-27 06:00:05', data: DIARIO },
  semanal: { eventWeek: '2026-W47', criadoEm: '2026-11-20 18:00:00', data: SEMANAL },
  noticia: { id: 'n1', title: 'GTA Online: novidades da semana', url: 'https://www.rockstargames.com/newswire/article/n1/x', category: 'GTA Online', publishedAt: '2026-11-26T15:00:00.000Z', thumbnail: SEGREDO },
  publicacoes: {
    diario: [{ guildId: G1, channelId: C1, em: '2026-11-27 06:01:00', message_id: MSG }],
    semanal: [{ guildId: G2, channelId: C2, em: '2026-11-20 18:05:00' }, { guildId: 'nao-e-id', channelId: C2, em: 'x' }],
    noticia: [{ guildId: G1, channelId: C1, em: '2026-11-26 15:10:00' }],
  },
  canais: { diario: 2, semanal: 2, noticias: 1, extra: SEGREDO },
  erros: ['semanal', 'outro', SEGREDO],
  ...over.raiz,
});
const NOMES = { nomeDoServidor: (id) => ({ [G1]: 'Servidor Um', [G2]: `Servidor\u0000 Dois ${'y'.repeat(100)}` })[id] ?? null, nomeDoCanal: (id) => ({ [C1]: 'gta-diario' })[id] ?? null };

let server = null;
try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. A vista: só o resumo legível sai, mesmo com o dado envenenado');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('diário: Van de Armas (local e até 5 armas, desconto só número de 1 a 100), comerciantes, naufrágio, baús, desafios e onde saiu (com nomes)', () => {
    const v = L.montarVistaDoGta(bruto(), NOMES);
    assert.deepEqual(Object.keys(v).sort(), CHAVES_DA_VISTA);
    assert.deepEqual(Object.keys(v.diario).sort(), ['baus', 'coletadoEm', 'comerciantes', 'data', 'desafios', 'naufragio', 'publicado', 'vanDeArmas']);
    assert.equal(v.diario.data, '2026-11-27');
    assert.equal(v.diario.coletadoEm, '2026-11-27T06:00:10.000Z');
    assert.equal(v.diario.vanDeArmas.local, 'Paleto Bay');
    assert.deepEqual(v.diario.vanDeArmas.armas.map((a) => a.desconto), [40, null], 'a arma sem nome sai; desconto que não é número vira null');
    assert.ok(v.diario.vanDeArmas.armas[1].nome.startsWith('Pistola Pesada') && v.diario.vanDeArmas.armas[1].nome.length <= 60 && !/[\u0000-\u001f]/.test(v.diario.vanDeArmas.armas[1].nome));
    assert.deepEqual(v.diario.comerciantes, [{ local: 'Vespucci Beach', produto: 'Meth' }, { local: 'Sandy Shores', produto: null }]);
    assert.deepEqual([v.diario.naufragio, v.diario.baus], ['Chumash', 2]);
    assert.deepEqual(v.diario.desafios, [{ nome: 'RC Bandito', local: 'Porto de Los Santos' }, { nome: 'Junk Energy Bike', local: 'Mount Chiliad' }]);
    assert.deepEqual(v.diario.publicado, [{ servidorId: G1, servidor: 'Servidor Um', canalId: C1, canal: 'gta-diario', em: '2026-11-27T06:01:00.000Z' }], 'data do SQLite lida como UTC');
    semVazamento(v, 'vista');
  });

  await test('semanal: título, fonte, período, bônus, descontos (só texto), pódio e prêmio, se tem análise (só o sim/não) e o link; nunca o texto do post nem a análise', () => {
    const v = L.montarVistaDoGta(bruto(), NOMES).semanal;
    assert.deepEqual(Object.keys(v).sort(), ['bonus', 'descontos', 'fonte', 'link', 'periodo', 'podio', 'premio', 'publicado', 'salvoEm', 'semana', 'temAnalise', 'titulo']);
    assert.deepEqual([v.semana, v.fonte, v.titulo], ['2026-W47', 'reddit', 'Weekly Bonuses and Discounts']);
    assert.deepEqual(v.periodo, { inicio: '2026-11-20', fim: '2026-11-27' });
    assert.deepEqual(v.bonus, [{ multiplicador: 2, atividades: ['Corridas de Pódio', 'Missões de Contato'] }], 'grupo sem atividade sai');
    assert.deepEqual(v.descontos, ['Grotti Turismo R - 30%']);
    assert.deepEqual([v.podio, v.premio, v.temAnalise], ['Pegassi Zentorno', 'Ocelot Pariah', true]);
    assert.equal(v.link, 'https://www.reddit.com/r/gtaonline/comments/abc123/weekly/');
    assert.equal(v.salvoEm, '2026-11-20T18:00:00.000Z');
    assert.deepEqual(v.publicado.map((p) => [p.servidorId, p.canal]), [[G2, null]], 'id que não é do Discord sai; canal sem nome fica null');
    assert.ok(v.publicado[0].servidor.length <= 60 && !v.publicado[0].servidor.includes('\u0000'));
  });

  await test('notícia: título, categoria, data e link da Rockstar; link de outro site, de javascript ou com usuário vira null', () => {
    const v = L.montarVistaDoGta(bruto(), NOMES).noticia;
    assert.deepEqual(Object.keys(v).sort(), ['categoria', 'link', 'publicadaEm', 'publicado', 'titulo']);
    assert.deepEqual([v.titulo, v.categoria, v.publicadaEm, v.link], ['GTA Online: novidades da semana', 'GTA Online', '2026-11-26T15:00:00.000Z', 'https://www.rockstargames.com/newswire/article/n1/x']);
    for (const ruim of ['https://evil.example/n1', 'http://www.rockstargames.com/x', 'javascript:alert(1)', 'https://user:senha@www.rockstargames.com/x', `https://www.rockstargames.com/${'a'.repeat(400)}`, 42, null]) {
      assert.equal(L.linkDoGta(ruim), null, String(ruim).slice(0, 40));
    }
  });

  await test('fontes: Reddit DESLIGADO aparece como "desligado" (semanal desligado ou REDDIT_FETCH_MODE=off), nunca como erro; em recuo, "em-espera" com a hora', () => {
    const agora = Date.parse('2026-11-27T12:00:00Z');
    const ligado = L.montarVistaDoGta(bruto(), { agora }).fontes;
    assert.deepEqual(ligado, {
      diario: { estado: 'ligado', horario: '06:00 UTC' },
      semanal: { estado: 'ligado', aoReiniciar: null, intervaloMin: 30 },
      reddit: { estado: 'ligado', voltaEm: null, falhas: 0 },
      reserva: { estado: 'ligado' },
      newswire: { estado: 'desligado', aoReiniciar: null, intervaloMin: 30 },
    });
    const off = L.montarVistaDoGta(bruto({ fontes: { redditModo: 'OFF', redditEspera: { ok: false, retryInMs: 60_000 }, redditFalhas: 3 } }), { agora }).fontes.reddit;
    assert.deepEqual([off.estado, off.voltaEm], ['desligado', null], 'off vence o recuo');
    const semSemanal = L.montarVistaDoGta(bruto({ fontes: { semanal: false } }), { agora }).fontes;
    assert.deepEqual([semSemanal.semanal.estado, semSemanal.reddit.estado, semSemanal.reserva.estado], ['desligado', 'desligado', 'desligado']);
    const espera = L.montarVistaDoGta(bruto({ fontes: { redditEspera: { ok: false, retryInMs: 3_600_000 }, redditFalhas: 2 } }), { agora }).fontes.reddit;
    assert.deepEqual(espera, { estado: 'em-espera', voltaEm: '2026-11-27T13:00:00.000Z', falhas: 2 });
    for (const v of [ligado, off, semSemanal, espera]) assert.ok(!JSON.stringify(v).includes('erro'), 'nenhuma fonte aparece como erro');
  });

  await test('o que vale só ao reiniciar: o cofre diz diferente do que está rodando (semanal desligado no cofre, notícias ligadas no cofre)', () => {
    const f = L.montarVistaDoGta(bruto({ fontes: { salvoSemanal: 'false', salvoNewswire: 'true' } })).fontes;
    assert.deepEqual([f.semanal.estado, f.semanal.aoReiniciar, f.newswire.estado, f.newswire.aoReiniciar], ['ligado', 'desligado', 'desligado', 'ligado']);
    const igual = L.montarVistaDoGta(bruto({ fontes: { salvoSemanal: 'true', salvoNewswire: null } })).fontes;
    assert.deepEqual([igual.semanal.aoReiniciar, igual.newswire.aoReiniciar], [null, null]);
  });

  await test('erros: só as palavras fixas (diario, semanal, noticia, canais); nada vazio vira objeto; sem dado, null', () => {
    const v = L.montarVistaDoGta(bruto({ raiz: { diario: null, semanal: 'x', noticia: null, erros: ['diario', 'canais', 'semanal', 'qualquer', SEGREDO] } }));
    assert.deepEqual([v.diario, v.semanal, v.noticia], [null, null, null]);
    assert.deepEqual(v.erros, ['diario', 'canais', 'semanal']);
    assert.deepEqual(v.canais, { diario: 2, semanal: 2, noticias: 1 });
    const vazio = L.montarVistaDoGta(null);
    assert.deepEqual(Object.keys(vazio).sort(), CHAVES_DA_VISTA);
    assert.deepEqual([vazio.fontes.semanal.estado, vazio.fontes.reddit.estado, vazio.diario, vazio.erros], ['desligado', 'desligado', null, []]);
  });

  await test('limpar é idempotente (o cérebro limpa de novo) e corta o que entrou depois (chaves estranhas, texto longo, id inválido, estado inventado)', () => {
    const v = L.montarVistaDoGta(bruto(), NOMES);
    assert.deepEqual(L.limparVistaDoGta(v), v);
    assert.deepEqual(L.limparVistaDoGta(JSON.parse(JSON.stringify(v))), v, 'depois de passar pelo canal (JSON)');
    const sujo = JSON.parse(JSON.stringify(v));
    sujo.token = SEGREDO;
    sujo.fontes.reddit = { estado: 'quebrado', voltaEm: SEGREDO, falhas: -4, motivo: SEGREDO };
    sujo.diario.vanDeArmas.armas.push({ nome: SEGREDO.repeat(9), desconto: 900 });
    sujo.semanal.fullText = SEGREDO;
    sujo.semanal.link = `https://evil.example/${SEGREDO}`;
    sujo.noticia.publicado[0].message_id = MSG;
    sujo.noticia.publicado.push({ servidorId: `${SEGREDO}`, canalId: C1 });
    const limpo = L.limparVistaDoGta(sujo);
    assert.deepEqual(limpo.fontes.reddit, { estado: 'desligado', voltaEm: null, falhas: 0 });
    assert.equal(limpo.diario.vanDeArmas.armas.length, 3);
    assert.ok(limpo.diario.vanDeArmas.armas[2].nome.length <= 60 && limpo.diario.vanDeArmas.armas[2].desconto === null);
    assert.deepEqual(Object.keys(limpo).sort(), CHAVES_DA_VISTA);
    assert.equal(limpo.semanal.link, null);
    assert.equal(limpo.noticia.publicado.length, 1);
    const semArma = JSON.parse(JSON.stringify(limpo));
    semArma.diario.vanDeArmas.armas = semArma.diario.vanDeArmas.armas.slice(0, 2);
    assert.ok(!JSON.stringify(semArma).includes(SEGREDO), 'fora a arma com nome cortado, nada do segredo');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. O leitor do bot contra os bancos de verdade (pasta temporária)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await initDatabase('core', S.CORE_SCHEMA);
  await initDatabase('newswire', S.NEWSWIRE_SCHEMA);
  await initDatabase('gta-diario', S.GTA_DAILY_SCHEMA);
  await initDatabase('gta-semanal', S.GTA_WEEKLY_SCHEMA);
  dailyRepository.saveDaily('2026-11-26', { ...DIARIO, date: '2026-11-26' });
  dailyRepository.saveDaily('2026-11-27', DIARIO);
  weeklyRepository.saveWeekly('2026-W47', SEMANAL);
  weeklyRepository.saveWeekly('2026-W48', { title: `artigo gravado como semanal ${SEGREDO}` }); // mais novo, mas não é semanal: é pulado
  newsRepository.insertMany([
    { id: 'n0', title: 'Notícia antiga', url: 'https://www.rockstargames.com/newswire/article/n0/x', category: 'GTA Online', thumbnailUrl: null, publishedAt: '2026-11-20T15:00:00.000Z' },
    { id: 'n1', title: 'GTA Online: novidades da semana', url: 'https://www.rockstargames.com/newswire/article/n1/x', category: 'GTA Online', thumbnailUrl: `https://cdn.example/${SEGREDO}.jpg`, publishedAt: '2026-11-26T15:00:00.000Z' },
  ]);
  guildRepository.setChannel(G1, 'daily_channel_id', C1);
  guildRepository.setChannel(G1, 'news_channel_id', C1);
  guildRepository.setChannel(G2, 'daily_channel_id', C2);
  guildRepository.setChannel(G2, 'weekly_channel_id', C2);
  guildRepository.setChannel(G3, 'weekly_channel_id', C3);
  publicationRepository.recordPublication('daily', '2026-11-27', G1, C1, MSG);
  publicationRepository.recordPublication('daily', '2026-11-26', G2, C2, MSG); // o diário de ontem não conta para o de hoje
  publicationRepository.recordPublication('weekly', 'reddit:abc123', G2, C2, MSG);
  publicationRepository.recordPublication('news', 'n1', G1, C1, MSG);
  const cfg = { weekly: { enabled: true, gtabaseFallback: true, intervalMinutes: 30 }, newswire: { enabled: false, intervalMinutes: 30 } };
  const guarda = { canTry: () => ({ ok: true, retryInMs: 0 }), failures: 0 };
  const salvo = (chave) => ({ GTA_WEEKLY_ENABLED: { valor: 'true' }, NEWSWIRE_ENABLED: { valor: 'false' } })[chave] ?? null;
  const lerDoBot = (over = {}) => lerGtaDoBot({ cfg, guarda, salvo, env: {}, ...over });

  await test('lê o último diário, o último semanal VÁLIDO (pula o artigo mais novo) e a última notícia; onde saiu em cada servidor com canal', () => {
    const r = lerDoBot();
    assert.deepEqual(r.erros, []);
    assert.equal(r.diario.resetDate, '2026-11-27');
    assert.equal(r.semanal.eventWeek, '2026-W47');
    assert.equal(r.noticia.id, 'n1');
    assert.deepEqual(r.publicacoes.diario.map((p) => [p.guildId, p.channelId]), [[G1, C1]], 'o G2 tem canal de diário, mas o de hoje não saiu lá');
    assert.deepEqual(r.publicacoes.semanal.map((p) => [p.guildId, p.channelId]), [[G2, C2]], 'registrado pela chave reddit:<id>');
    assert.deepEqual(r.publicacoes.noticia.map((p) => [p.guildId, p.channelId]), [[G1, C1]]);
    assert.deepEqual(r.canais, { diario: 2, semanal: 2, noticias: 1 });
    assert.deepEqual(chavesDoSemanal({ event_week: '2026-W48', data: { id: 'p9' } }), ['2026-W48', 'reddit:p9', 'gtabase:p9']);
    assert.deepEqual(chavesDoSemanal({ event_week: '2026-W48', data: {} }), ['2026-W48'], 'o semanal do Newswire sai pela semana');
    const v = L.montarVistaDoGta(r);
    assert.equal(v.diario.publicado[0].em.endsWith('Z'), true);
    assert.equal(v.semanal.fonte, 'reddit');
    semVazamento(v, 'vista do banco');
  });

  await test('as fontes vêm da configuração em uso, do cofre e do recuo do Reddit; Reddit desligado por REDDIT_FETCH_MODE=off sem tocar no Reddit', () => {
    const r = lerDoBot({ env: { REDDIT_FETCH_MODE: 'off' }, guarda: { canTry: () => ({ ok: false, retryInMs: 5000 }), failures: 4 } });
    assert.deepEqual([r.fontes.semanal, r.fontes.newswire, r.fontes.reserva, r.fontes.redditModo, r.fontes.redditFalhas], [true, false, true, 'off', 4]);
    assert.deepEqual(r.fontes.redditEspera, { ok: false, retryInMs: 5000 });
    assert.equal(L.montarVistaDoGta(r).fontes.reddit.estado, 'desligado');
    assert.equal(L.montarVistaDoGta(lerDoBot({ guarda: { canTry: () => ({ ok: false, retryInMs: 5000 }), failures: 4 } })).fontes.reddit.estado, 'em-espera');
    assert.deepEqual([r.fontes.salvoSemanal, r.fontes.salvoNewswire], ['true', 'false']);
    const quebrado = lerDoBot({ salvo: () => { throw new Error(SEGREDO); }, guarda: { canTry: () => { throw new Error('x'); } } });
    assert.deepEqual([quebrado.fontes.salvoSemanal, quebrado.fontes.redditEspera.ok], [null, true], 'cofre e guarda quebrados não derrubam a leitura');
  });

  await test('uma leitura que falha vira um item de "erros" e as outras saem (o banco fora não derruba a tela)', () => {
    const repos = {
      daily: { getLatestDaily: () => { throw new Error(SEGREDO); } },
      weekly: weeklyRepository,
      news: { getLatest: () => { throw new Error('x'); } },
      publication: publicationRepository,
      guild: guildRepository,
    };
    const r = lerDoBot({ repos });
    assert.deepEqual(r.erros, ['diario', 'noticia']);
    assert.deepEqual([r.diario, r.noticia, r.semanal.eventWeek], [null, null, '2026-W47']);
    const v = L.montarVistaDoGta(r);
    assert.deepEqual(v.erros, ['diario', 'noticia']);
    semVazamento(v, 'erros');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. A rota HTTP de verdade (processo único): só o dono, só GET, sem o texto da fonte');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const cache = (pares) => new Map(pares.map(([id, name]) => [id, { id, name }]));
  const clientFalso = { isReady: () => true, guilds: { cache: cache([[G1, 'Servidor Um'], [G2, 'Servidor Dois']]) }, channels: { cache: cache([[C1, 'gta-diario'], [C2, 'gta-semanal']]) } };
  let lidas = 0;
  const ponte = async () => ({ gta: () => { lidas += 1; return lerDoBot(); } });
  server = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_MEMBER}=${MEMBER}`), admin: createAdmin({ client: clientFalso, servidor: ponte, deps: { integrationData: async () => ({}) } }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (method, rota, token, srvBase = base) => {
    const res = await fetch(srvBase + rota, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{"confirm":true}' });
    return { status: res.status, headers: res.headers, texto: await res.text() };
  };

  await test('o dono lê (200, JSON, sem cache) com os nomes de servidor e canal; nada do texto do post, da análise, da miniatura nem do id da mensagem', async () => {
    const r = await chamar('GET', '/v1/admin/gta', T_OWNER);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    semVazamento(r.texto, 'GET /v1/admin/gta');
    assert.ok(!r.texto.includes(OWNER), 'não leva o id do dono');
    const v = JSON.parse(r.texto);
    assert.deepEqual(Object.keys(v).sort(), CHAVES_DA_VISTA);
    assert.deepEqual(v.diario.publicado.map((p) => [p.servidor, p.canal]), [['Servidor Um', 'gta-diario']]);
    assert.deepEqual(v.semanal.publicado.map((p) => [p.servidor, p.canal]), [['Servidor Dois', 'gta-semanal']]);
    assert.equal(v.diario.vanDeArmas.local, 'Paleto Bay');
    assert.deepEqual(v.fontes.reddit, { estado: 'ligado', voltaEm: null, falhas: 0 });
  });

  await test('quem não é o dono: 403 sem nenhum dado e sem chegar ao banco; sem token ou token errado: 401; POST, PUT e DELETE não existem', async () => {
    const antes = lidas;
    const membro = await chamar('GET', '/v1/admin/gta', T_MEMBER);
    assert.equal(membro.status, 403);
    assert.ok(!/Paleto|diario|semanal|Servidor/.test(membro.texto), membro.texto);
    assert.equal(lidas, antes, 'o membro nem chega a ler o banco');
    assert.equal((await chamar('GET', '/v1/admin/gta', null)).status, 401);
    assert.equal((await chamar('GET', '/v1/admin/gta', 'token-errado-0123456789abcdef')).status, 401);
    for (const metodo of ['POST', 'PUT', 'DELETE']) assert.equal((await chamar(metodo, '/v1/admin/gta', T_OWNER)).status, 404, metodo);
  });

  await test('fora do routeGuard, como as outras leituras do painel', () => {
    assert.equal(actionForRoute('GET', '/v1/admin/gta'), null);
    for (const m of ['POST', 'PUT', 'DELETE']) assert.equal(actionForRoute(m, '/v1/admin/gta'), null, m);
  });

  await test('sem a ponte do bot (um processo sem o Discord), 503 com o motivo; nunca lê o banco por conta própria', async () => {
    registrarServidorDoPainel(null);
    const sem = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER}`), admin: createAdmin({ client: null, deps: { integrationData: async () => ({}) } }) });
    await new Promise((r) => sem.listen(0, '127.0.0.1', r));
    try {
      const r = await chamar('GET', '/v1/admin/gta', T_OWNER, `http://127.0.0.1:${sem.address().port}`);
      assert.equal(r.status, 503);
      assert.match(JSON.parse(r.texto).error, /bot do Discord/);
    } finally { sem.close(); sem.closeAllConnections?.(); }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. O cérebro separado e o bot');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const canalFalso = ({ conectado = true, falha = false, resposta = null } = {}) => {
    const pedidos = [];
    return {
      pedidos,
      isConnected: () => conectado,
      emit() {},
      request: async (papel, metodo, params, opts) => {
        pedidos.push({ papel, metodo, action: params?.action, idem: opts?.idem ?? null });
        if (falha) throw Object.assign(new Error('caiu'), { code: 'CONNECTION_LOST' });
        return resposta;
      },
    };
  };

  await test('a mesma lista nos dois lados; "gta" é LEITURA (sem chave de idempotência); a continuidade não vai ao bot', () => {
    assert.deepEqual([...BOT_PANEL_ACTIONS].sort(), Object.keys(PANEL_ACTIONS).sort());
    assert.equal(PANEL_ACTIONS.gta, false);
    for (const k of ['continuidade', 'removerContinuidade', 'listas', 'skills']) assert.ok(!Object.hasOwn(PANEL_ACTIONS, k), k);
  });

  await test('no cérebro: pede ao bot por panel.admin e LIMPA DE NOVO a vista que volta (o que o bot mandasse a mais não passa)', async () => {
    const sujo = JSON.parse(JSON.stringify(L.montarVistaDoGta(bruto(), NOMES)));
    sujo.semanal.fullText = SEGREDO;
    sujo.extra = SEGREDO;
    sujo.diario.publicado[0].message_id = MSG;
    const canal = canalFalso({ resposta: sujo });
    const v = await createCerebroAdmin({ channel: canal }).gta(ctxDono);
    assert.deepEqual(canal.pedidos, [{ papel: 'bot', metodo: 'panel.admin', action: 'gta', idem: null }]);
    assert.deepEqual(Object.keys(v).sort(), CHAVES_DA_VISTA);
    semVazamento(v, 'gta no cérebro');
    assert.equal(v.diario.vanDeArmas.local, 'Paleto Bay');
  });

  await test('membro barrado antes de qualquer pedido ao bot; bot fora: 503 "Disponível só com o bot conectado"', async () => {
    const canal = canalFalso({ resposta: {} });
    const a = createCerebroAdmin({ channel: canal });
    for (const role of ['MEMBER', 'TRUSTED', 'GUEST', undefined]) await assert.rejects(a.gta({ role, userId: MEMBER, platform: 'api' }), (e) => e.status === 403, String(role));
    assert.deepEqual(canal.pedidos, []);
    for (const c of [canalFalso({ conectado: false }), canalFalso({ falha: true })]) {
      await assert.rejects(createCerebroAdmin({ channel: c }).gta(ctxDono), (e) => e.status === 503 && /bot conectado/.test(e.message));
    }
  });

  await test('o bot: aceita a leitura "gta" pelo canal só do dono, monta a vista com os nomes do cliente dele', async () => {
    const handlers = new Map();
    const adminDoBot = createAdmin({ client: clientFalso, servidor: ponte, processo: 'bot', deps: { integrationData: async () => ({}) } });
    registerBotActions({ handle: (m, fn) => handlers.set(m, fn) }, { getClient: () => clientFalso, admin: adminDoBot });
    const r = await handlers.get('panel.admin')({ userId: OWNER, action: 'gta', args: [] }, { role: 'cerebro' });
    assert.deepEqual(Object.keys(r).sort(), CHAVES_DA_VISTA);
    assert.equal(r.diario.publicado[0].servidor, 'Servidor Um');
    semVazamento(r, 'gta pelo canal');
    await assert.rejects(handlers.get('panel.admin')({ userId: MEMBER, action: 'gta', args: [] }, {}), (e) => e.code === 'FORBIDDEN');
  });

  await test('a ponte do bot liga a leitura do GTA ao leitor do bot (src/discord/painelServidor.js -> gtaPainel.js), sem cópia', () => {
    const ponteFonte = fs.readFileSync(path.join(repoRoot, 'src', 'discord', 'painelServidor.js'), 'utf8');
    assert.match(ponteFonte, /gta: async \(\) => \(await import\('\.\/gtaPainel\.js'\)\)\.lerGtaDoBot\(\)/);
  });

  await test('registrado no package.json, no CI (SUITES) e no README_TESTES.md', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts['test:painelgta'], 'node tests/test-painel-gta.js');
    assert.match(fs.readFileSync(path.join(repoRoot, 'scripts', 'run-ci.mjs'), 'utf8'), /'test:painelgta'/);
    assert.match(fs.readFileSync(path.join(repoRoot, 'README_TESTES.md'), 'utf8'), /\| `test:painelgta` \|/);
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  try { server?.close(); server?.closeAllConnections?.(); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 300)); // deixa os soquetes fecharem antes do process.exit (evita o aborto do libuv no Windows)
  try { process.chdir(repoRoot); } catch { /* */ }
  try { closeAllDatabases?.(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
