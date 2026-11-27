// Lacunas do painel, ENTREGA E, parte 2, item 10 (27/11/2026; docs/PLANO_LACUNAS_PAINEL.md): o rádio completo pelo painel, SÓ DO DONO.
//   GET  /v1/admin/radio                      as sessões, agora com a fila (as próximas faixas: só título e duração)
//   GET  /v1/admin/radio/:guildId/canais      os canais de voz e de texto do servidor para iniciar (só leitura)
//   POST /v1/admin/radio/:guildId { action }  as de sempre (pause, resume, stop, leave) e as novas: start { voiceChannelId, textChannelId }, skip,
//                                             play { query } e choose { opcao } (a busca ambígua devolve as opções; o painel manda só o NÚMERO)
// A. As regras puras (src/core/api/radioAdmin.js): os canais do servidor (só deste servidor, voz x palco x texto, permissão de entrar e falar / escrever,
//    cheio), a busca, a faixa curta (sem link, capa nem quem pediu) e a fila do GET.
// B. As ações pela rota HTTP de verdade (processo único) com o rádio FALSO injetado: iniciar sem ninguém na call (canal de outro servidor, palco, sem
//    permissão, cheio e o erro do rádio recusam), tocar (achou, não achou, ambígua -> opções -> escolha que usa a faixa guardada NO SERVIDOR, opção
//    inválida, vencida), pular, sem sessão 404, membro 403, a auditoria só com a ação e o servidor (nunca a busca), routeGuard e as ações antigas iguais.
// C. O rádio de verdade (src/music/radioManager.js) com o player, os bancos do rádio, a voz e o Discord FALSOS (module.registerHooks): o miolo do
//    /modo-radio num canal escolhido (entra no canal pedido, cria a sessão com os dois canais, manda o painel do rádio no canal de texto), a espera pela
//    call vazia só no início pelo painel (o /modo-radio continua saindo do canal vazio como antes), a fila do pedido por voz/conversa e o pular.
// D. O cérebro separado (as ações novas vão ao bot pelo radioAction de sempre, COM idempotência e prazo maior; os canais são leitura) e o bot.
// Num processo só, pasta temporária, sem .env, sem rede, sem áudio e sem Discord de verdade. Execução: npm run test:painelradio
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'test';
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-radio-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const T_OWNER = 'token-do-dono-0123456789abcdef';
const T_MEMBER = 'token-do-membro-0123456789abcdef';
const AUDIT = path.join(tmp, 'audit.jsonl');
const BUSCA_SECRETA = 'lofi-da-madrugada-q7x';
const BOT = '999999999999999999';
const G1 = '300000000000000001';
const G2 = '300000000000000002';
const G_FORA = '300000000000000009';
const V1 = '500000000000000001'; // voz, pode
const V_SEM = '500000000000000002'; // voz, sem "Falar"
const V_CHEIO = '500000000000000003'; // voz, cheio
const PALCO = '500000000000000004';
const T1 = '600000000000000001'; // texto, pode
const T_SEM = '600000000000000002'; // texto, sem "Inserir links"
const AVISOS = '600000000000000003'; // anúncios, pode
const CATEGORIA = '600000000000000004';
const V_OUTRO = '700000000000000001'; // voz do G2

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: AUDIT, YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', YUI_GATEWAY_IN_CHAIN: 'false',
  LOG_LEVEL: 'error', YUI_CONTEXT_ENABLED: 'false', YUI_POLICY_MODE: 'observe', YUI_READ_ONLY: 'false', YUI_LOG_DIR: path.join(tmp, 'logs'),
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'secrets', 'search-budget.json'),
});
for (const k of ['YUI_CEREBRO_EXTERNO', 'OWNER_ID', 'OWNER_IDS', 'YUI_API_TOKENS']) delete process.env[k];
fs.mkdirSync(process.env.DATABASE_DIR, { recursive: true });
process.chdir(tmp); // sem .env, sem logs reais

// ── Dublês do rádio, da voz e do Discord (só para a seção C; nada toca áudio nem grava em src/music/data) ──────────────────────────────────────────
const R = { sessoes: new Map(), chamadas: [], resolved: { type: 'not_found' }, nextTrackValue: null, opus: true, client: null, conexao: null };
globalThis.__radio = R;
const stubDir = path.join(tmp, 'stubs');
fs.mkdirSync(stubDir);
const porArquivo = new Map();
const porPacote = new Map();
const escrever = (nome, code) => { const f = path.join(stubDir, nome); fs.writeFileSync(f, `const R = globalThis.__radio;\n${code}`); return pathToFileURL(f).href; };
const stubArquivo = (rel, code) => porArquivo.set(pathToFileURL(path.join(repoRoot, rel)).href.toLowerCase(), escrever(`a${porArquivo.size}.mjs`, code));
const stubPacote = (nome, code) => porPacote.set(nome, escrever(`p${porPacote.size}.mjs`, code));
stubPacote('@discordjs/voice', `
export const VoiceConnectionStatus = { Ready: 'ready', Disconnected: 'disconnected' };
export const EndBehaviorType = { AfterSilence: 1 };
export const joinVoiceChannel = (o) => { R.chamadas.push(['joinVoiceChannel', o.channelId, o.guildId]); return { on() {}, destroy() { R.chamadas.push(['destroyConn']); }, receiver: {} }; };
export const entersState = async () => {};
export const getVoiceConnection = () => R.conexao;
`);
stubPacote('prism-media', 'export default { opus: { Decoder: class {} } };');
stubArquivo('src/utils/logger.js', 'export const logger = { info() {}, warn() {}, error() {}, debug() {} }; export default logger;');
stubArquivo('src/utils/binaries.js', 'export const isOpusAvailable = () => R.opus;');
stubArquivo('src/utils/voiceSafety.js', `
export const VOICE_UNAVAILABLE_MESSAGE = 'voz indisponível';
export const attachConnectionSafety = () => {};
export const attachSpeakingListener = () => ({ guard: { isDisabled: () => false } });
export const createSpeakerGuard = () => ({ isDisabled: () => false });
export const errMsg = (e) => String(e?.message ?? e);
`);
stubArquivo('src/services/sttService.js', 'export const transcribeAudio = async () => "";');
stubArquivo('src/services/tts/index.js', 'export const interruptSpeech = () => {};');
stubArquivo('src/handlers/llmHandler.js', 'export const isToolDisabled = () => false; export const addToQueue = () => {};');
stubArquivo('src/music/radioDatabase.js', `
export const createSession = (g, v, t) => { R.chamadas.push(['createSession', g, v, t]); const s = { guildId: g, voiceChannelId: v, textChannelId: t, status: 'STOPPED', playlist: [], currentIndex: -1, currentTrack: null, queue: [], voiceMode: 'DIRECT' }; R.sessoes.set(g, s); return s; };
export const getSession = (g) => R.sessoes.get(g) ?? null;
export const getAllSessions = () => [...R.sessoes.values()];
export const updateSession = (g, p) => { const s = R.sessoes.get(g); if (s) Object.assign(s, p); return s ?? null; };
export const destroySession = (g) => { R.chamadas.push(['destroySession', g]); R.sessoes.delete(g); };
export const nextTrack = (g) => { R.chamadas.push(['nextTrack', g]); return R.nextTrackValue; };
export const prevTrack = () => null;
export const skipToTrack = (g, pos) => { R.chamadas.push(['skipToTrack', g, pos]); const s = R.sessoes.get(g); if (!s) return null; s.currentIndex = pos - 1; s.status = 'PLAYING'; s.currentTrack = s.playlist[pos - 1] ?? null; return s; };
export const addTrackToQueue = (g, t) => { R.chamadas.push(['addTrackToQueue', g, t.title]); const s = R.sessoes.get(g); s.playlist.push(t); return s.playlist.length; };
export const toggleVoiceListening = () => {};
export const setLoopMode = () => 'OFF';
export const toggleShuffle = () => false;
export const removeTrackFromPlaylist = () => null;
export const stopRadio = () => {};
`);
stubArquivo('src/music/radioAudioPlayer.js', `
export const playTrack = async (g, t, ch, client) => { R.chamadas.push(['playTrack', g, t?.title, ch?.id ?? null, client === R.client]); };
export const pausePlayer = async () => true;
export const resumePlayer = async () => true;
export const stopPlayer = (g) => { R.chamadas.push(['stopPlayer', g]); };
export const updateEmbed = async (g, ch) => { R.chamadas.push(['updateEmbed', g, ch?.id ?? null]); };
`);
stubArquivo('src/music/radioEmbed.js', 'export const buildRadioEmbed = () => ({ embeds: [{ titulo: "rádio" }], components: [] }); export const buildQueueEmbed = () => ({});');
stubArquivo('src/music/radioProviders.js', 'export const resolveInput = async (q, g) => { R.chamadas.push(["resolveInput", q, g]); return R.resolved; };');
stubArquivo('src/music/radioPrefetcher.js', 'export const prefetchNextTrack = async (g) => { R.chamadas.push(["prefetch", g]); }; export const cleanupSessionAudioFiles = () => {};');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (porPacote.has(specifier)) return { url: porPacote.get(specifier), shortCircuit: true };
    const resolved = nextResolve(specifier, context);
    const hit = porArquivo.get(String(resolved.url).toLowerCase());
    return hit ? { url: hit, shortCircuit: true } : resolved;
  },
});

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const RA = await imp('src/core/api/radioAdmin.js');
const { createAdmin } = await imp('src/core/api/admin.js');
const { createApiServer, parseTokens } = await imp('src/core/api/server.js');
const { createCerebroAdmin, PANEL_ACTIONS, PANEL_TIMEOUTS } = await imp('src/cerebro/painel.js');
const { registerBotActions, BOT_PANEL_ACTIONS } = await imp('src/discord/canalCerebro.js');
const { actionForRoute } = await imp('src/core/security/routeGuard.js');
const manager = await imp('src/music/radioManager.js');

let passed = 0;
const failures = [];
const say = (s) => console.log(s);
const section = (t) => say(`\n${t}`);
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) { failures.push(name); say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 9).join('\n        ')}`); }
};
const ctxDono = { role: 'OWNER', userId: OWNER, platform: 'api' };
const auditoria = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const servidores = [];

// ── O Discord FALSO: servidores, canais e permissões ──
const ME = { id: BOT, user: { id: BOT, bot: true } };
const permissoes = (lista) => ({ has: (p) => [].concat(p).every((x) => lista.includes(x)) });
const TUDO = ['ViewChannel', 'Connect', 'Speak', 'SendMessages', 'EmbedLinks'];
const pessoa = (bot = false) => ({ user: { bot } });
const canal = ({ id, name, type, guildId = G1, perms = TUDO, membros = [], full = false, pos = 0 }) => ({
  id, name, type, guildId, rawPosition: pos, full,
  members: new Map(membros.map((m, i) => [String(i), m])),
  permissionsFor: (quem) => (quem === ME ? permissoes(perms) : permissoes([])),
});
const canaisG1 = [
  canal({ id: V1, name: 'Música', type: 2, membros: [pessoa(), pessoa(true)], pos: 1 }),
  canal({ id: V_SEM, name: 'Sem falar', type: 2, perms: ['ViewChannel', 'Connect'], pos: 2 }),
  canal({ id: V_CHEIO, name: 'Cheio', type: 2, full: true, pos: 3 }),
  canal({ id: PALCO, name: 'Palco', type: 13, pos: 4 }),
  canal({ id: T1, name: `geral\u0007 ${'x'.repeat(80)}`, type: 0, pos: 1 }),
  canal({ id: T_SEM, name: 'sem-embed', type: 0, perms: ['ViewChannel', 'SendMessages'], pos: 2 }),
  canal({ id: AVISOS, name: 'avisos', type: 5, pos: 3 }),
  canal({ id: CATEGORIA, name: 'Categoria', type: 4, pos: 0 }),
];
const canalDoOutro = canal({ id: V_OUTRO, name: 'Voz do outro', type: 2, guildId: G2 });
const guild1 = { id: G1, name: 'Servidor Um', members: { me: ME }, channels: { cache: new Map([...canaisG1, canalDoOutro].map((c) => [c.id, c])) } };
const guild2 = { id: G2, name: 'Servidor Dois', members: { me: ME }, channels: { cache: new Map([[V_OUTRO, canalDoOutro]]) } };
const clientFalso = {
  isReady: () => true,
  guilds: { cache: new Map([[G1, guild1], [G2, guild2]]) },
  channels: { cache: new Map([...canaisG1, canalDoOutro].map((c) => [c.id, c])) },
};

// Faixas como o resolveInput entrega (com link, capa, fonte): o painel só pode ver título, artista e duração.
const faixa = (n, extra = {}) => ({ id: String(n), title: `Faixa ${n}`, artist: `Artista ${n}`, album: 'Álbum', duration: 180 + n, cover: `https://cdn.exemplo.test/capa-${n}.jpg`, link: `https://www.deezer.com/track/${n}`, source: 'deezer', ...extra });
const PROIBIDOS = ['deezer.com', 'cdn.exemplo', 'capa-', 'addedBy', BUSCA_SECRETA];
const semVazar = (v, rotulo) => { const t = typeof v === 'string' ? v : JSON.stringify(v); for (const p of PROIBIDOS) assert.ok(!t.includes(p), `${rotulo} vazou: ${p}`); };

try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. As regras puras (src/core/api/radioAdmin.js)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('canais: só DESTE servidor; voz (sem o palco) com pessoas e se pode entrar e falar (cheio não dá); texto e anúncios com "pode escrever com embeds"', () => {
    const c = RA.canaisDoRadio(guild1);
    assert.deepEqual(c.voz.map((x) => [x.id, x.pode, x.motivo]), [[V1, true, null], [V_SEM, false, 'sem-permissao'], [V_CHEIO, false, 'cheio']]);
    assert.equal(c.voz[0].pessoas, 1, 'o bot não conta');
    assert.deepEqual(c.texto.map((x) => [x.id, x.pode, x.motivo]), [[T1, true, null], [T_SEM, false, 'sem-permissao'], [AVISOS, true, null]]);
    assert.ok(!c.voz.some((x) => x.id === V_OUTRO || x.id === PALCO), 'outro servidor e palco ficam de fora');
    assert.ok(c.texto[0].nome.length <= 60 && !c.texto[0].nome.includes('\u0007'));
    assert.deepEqual(RA.canaisDoRadio({ id: G1, channels: { cache: new Map() } }), { voz: [], texto: [] });
    assert.deepEqual(RA.canaisDoRadio(null), { voz: [], texto: [] });
    const semMe = RA.canaisDoRadio({ ...guild1, members: {} });
    assert.ok(semMe.voz.every((x) => !x.pode), 'sem saber quem é a Yui no servidor, nada é liberado');
  });

  await test('busca: 2 a 200 caracteres, numa linha só; faixa curta e opções só com título, artista e duração (nunca link, capa ou quem pediu)', () => {
    assert.equal(RA.buscaDoRadio('  lofi  '), 'lofi');
    for (const ruim of ['', ' a ', 'x'.repeat(201), 'duas\nlinhas', 'tab\tno meio', 42, null, undefined, {}]) assert.equal(RA.buscaDoRadio(ruim), null, JSON.stringify(ruim));
    assert.deepEqual(RA.faixaCurta(faixa(1, { addedBy: OWNER })), { title: 'Faixa 1', artist: 'Artista 1', duration: 181 });
    assert.deepEqual(RA.faixaCurta({ title: `t\u0000${'y'.repeat(200)}`, artist: null, duration: 'abc' }).duration, null);
    assert.equal(RA.faixaCurta({ title: 'x'.repeat(300) }).title.length, 120);
    assert.equal(RA.faixaCurta(null), null);
    const opcoes = RA.opcoesDoRadio(Array.from({ length: 15 }, (_, i) => faixa(i + 1)));
    assert.equal(opcoes.length, RA.MAX_OPCOES_DO_RADIO);
    semVazar(opcoes, 'opções');
    assert.deepEqual([RA.duracaoDaFaixa(-1), RA.duracaoDaFaixa(90_000), RA.duracaoDaFaixa(12.6), RA.duracaoDaFaixa('')], [null, null, 13, null]);
  });

  await test('a fila do GET: as próximas (até 10), só título e duração; a faixa atual e o resto como antes', async () => {
    const sessao = { guildId: G1, voiceChannelId: V1, status: 'PLAYING', currentTrack: faixa(1), queue: Array.from({ length: 12 }, (_, i) => faixa(i + 2, { addedBy: OWNER })), playlist: [], currentIndex: 0 };
    const [s] = await RA.listRadio({ sessions: () => [sessao], connected: () => true }, () => 'Servidor Um', () => 'Música');
    assert.equal(s.upcoming.length, RA.MAX_PROXIMAS);
    assert.deepEqual(s.upcoming[0], { title: 'Faixa 2', duration: 182 });
    assert.deepEqual(Object.keys(s.upcoming[0]).sort(), ['duration', 'title']);
    assert.equal(s.queueLength, 12);
    assert.equal(s.next.title, 'Faixa 2');
    assert.deepEqual(RA.RADIO_ACTIONS, ['pause', 'resume', 'stop', 'leave', 'skip', 'start', 'play', 'choose']);
    const [vazia] = await RA.listRadio({ sessions: () => [{ guildId: G1, status: 'STOPPED' }] }, () => null, () => null);
    assert.deepEqual(vazia.upcoming, []);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. As ações pela rota HTTP de verdade (processo único, rádio falso)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const radioFalso = () => {
    const r = {
      chamadas: [], sessoes: new Map(), achado: { type: 'not_found' }, proxima: null, erroAoIniciar: null,
      sessions: () => [...r.sessoes.values()],
      getSession: (g) => r.sessoes.get(g) ?? null,
      connected: () => true,
      pause: async (g) => { r.chamadas.push(['pause', g]); return true; },
      resume: async (g) => { r.chamadas.push(['resume', g]); return true; },
      stopMusic: async (g) => { r.chamadas.push(['stop', g]); },
      leave: async (g) => { r.chamadas.push(['leave', g]); r.sessoes.delete(g); },
      start: async (voz, texto, client) => {
        r.chamadas.push(['start', voz?.id, texto?.id, client === clientFalso]);
        if (r.erroAoIniciar) return { success: false, error: r.erroAoIniciar };
        r.sessoes.set(voz.guildId, { guildId: voz.guildId, voiceChannelId: voz.id, status: 'STOPPED', queue: [], playlist: [], currentIndex: -1 });
        return { success: true };
      },
      resolve: async (q, g) => { r.chamadas.push(['resolve', q, g]); return r.achado; },
      enqueue: async (g, achado, userId, client) => {
        r.chamadas.push(['enqueue', g, achado, userId, client === clientFalso]);
        if (achado.type === 'playlist') return { kind: 'playlist', track: null, count: achado.tracks.length, playing: false };
        return { kind: 'track', track: achado.type === 'track' ? achado.track : achado.results[0], count: 1, playing: true };
      },
      skip: async (g, client) => { r.chamadas.push(['skip', g, client === clientFalso]); return r.proxima; },
    };
    return r;
  };
  const relogio = { t: Date.parse('2026-11-27T20:00:00Z') };
  const rf = radioFalso();
  const subir = async (adm) => {
    const srv = createApiServer({ tokens: parseTokens(`${T_OWNER}=${OWNER},${T_MEMBER}=${MEMBER}`), admin: adm });
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    servidores.push(srv);
    const base = `http://127.0.0.1:${srv.address().port}`;
    return async (method, rota, corpo, { token = T_OWNER } = {}) => {
      const res = await fetch(base + rota, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(corpo ?? {}) });
      const texto = await res.text();
      let json = null;
      try { json = JSON.parse(texto); } catch { json = null; }
      return { status: res.status, texto, json };
    };
  };
  const api = await subir(createAdmin({ client: clientFalso, deps: { radio: rf, integrationData: async () => ({}), agora: () => relogio.t } }));
  const acao = (corpo, opcoes) => api('POST', `/v1/admin/radio/${G1}`, corpo, opcoes);

  await test('canais para iniciar: o dono lê os de voz e de texto do servidor; membro 403; servidor fora 404; fora do routeGuard', async () => {
    const r = await api('GET', `/v1/admin/radio/${G1}/canais`);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.guildId, G1);
    assert.deepEqual(r.json.voz.map((c) => c.id), [V1, V_SEM, V_CHEIO]);
    assert.deepEqual(r.json.texto.filter((c) => c.pode).map((c) => c.id), [T1, AVISOS]);
    assert.equal((await api('GET', `/v1/admin/radio/${G1}/canais`, null, { token: T_MEMBER })).status, 403);
    assert.equal((await api('GET', `/v1/admin/radio/${G_FORA}/canais`)).status, 404);
    assert.equal(actionForRoute('GET', `/v1/admin/radio/${G1}/canais`), null);
  });

  await test('iniciar SEM ninguém na call: o rádio recebe os objetos dos canais escolhidos e o cliente do Discord; auditoria só ação e servidor', async () => {
    const r = await acao({ action: 'start', voiceChannelId: V1, textChannelId: T1 });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, iniciado: true });
    assert.deepEqual(rf.chamadas.at(-1), ['start', V1, T1, true]);
    const ev = auditoria().filter((e) => e.event === 'admin.radio').at(-1);
    assert.deepEqual([ev.guild, ev.action], [G1, 'start']);
    assert.ok(!JSON.stringify(ev).includes(V1) && !JSON.stringify(ev).includes(T1), 'nem os canais vão para a auditoria');
  });

  await test('iniciar recusa: canal de voz de OUTRO servidor, palco, texto no lugar de voz, sem permissão, cheio, texto sem embeds, id ruim, Yui fora; o erro do rádio vira 409', async () => {
    const antes = rf.chamadas.length;
    const casos = [
      [{ voiceChannelId: V_OUTRO, textChannelId: T1 }, 400, /não é deste servidor/],
      [{ voiceChannelId: PALCO, textChannelId: T1 }, 400, /não é deste servidor/],
      [{ voiceChannelId: T1, textChannelId: T1 }, 400, /canal de voz/],
      [{ voiceChannelId: V1, textChannelId: V1 }, 400, /canal de texto/],
      [{ voiceChannelId: V1, textChannelId: CATEGORIA }, 400, /canal de texto/],
      [{ voiceChannelId: V_SEM, textChannelId: T1 }, 409, /permissão para entrar e falar/],
      [{ voiceChannelId: V_CHEIO, textChannelId: T1 }, 409, /cheio/],
      [{ voiceChannelId: V1, textChannelId: T_SEM }, 409, /permissão para escrever/],
      [{ voiceChannelId: 'abc', textChannelId: T1 }, 400, /Canal de voz inválido/],
      [{ textChannelId: T1 }, 400, /Canal de voz inválido/],
    ];
    for (const [corpo, status, re] of casos) {
      const r = await acao({ action: 'start', ...corpo });
      assert.equal(r.status, status, `${JSON.stringify(corpo)} -> ${r.texto}`);
      assert.match(r.json.error, re, JSON.stringify(corpo));
    }
    assert.equal((await api('POST', `/v1/admin/radio/${G_FORA}`, { action: 'start', voiceChannelId: V1, textChannelId: T1 })).status, 404);
    assert.equal(rf.chamadas.length, antes, 'nada chegou ao rádio');
    rf.erroAoIniciar = '⚠️ Já estou em outro canal de voz em modo rádio neste servidor.';
    const r = await acao({ action: 'start', voiceChannelId: V1, textChannelId: T1 });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /outro canal de voz/);
    rf.erroAoIniciar = null;
  });

  await test('tocar: achou -> "tocando" com a faixa curta; o rádio recebe o que o resolveInput achou e quem pediu; não achou -> "nao-encontrado"', async () => {
    rf.achado = { type: 'track', track: faixa(7) };
    const r = await acao({ action: 'play', query: BUSCA_SECRETA });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json, { ok: true, resultado: 'tocando', adicionadas: 1, faixa: { title: 'Faixa 7', artist: 'Artista 7', duration: 187 } });
    assert.deepEqual(rf.chamadas.find((c) => c[0] === 'resolve').slice(1), [BUSCA_SECRETA, G1]);
    const fila = rf.chamadas.filter((c) => c[0] === 'enqueue').at(-1);
    assert.deepEqual([fila[1], fila[2].track.link, fila[3], fila[4]], [G1, 'https://www.deezer.com/track/7', OWNER, true]);
    semVazar(r.texto, 'play');
    rf.achado = { type: 'not_found' };
    assert.deepEqual((await acao({ action: 'play', query: 'nada disso' })).json, { ok: true, resultado: 'nao-encontrado' });
    rf.achado = { type: 'playlist', tracks: [faixa(1), faixa(2), faixa(3)] };
    assert.deepEqual((await acao({ action: 'play', query: 'https://www.deezer.com/playlist/1' })).json, { ok: true, resultado: 'na-fila', adicionadas: 3 });
  });

  await test('busca ambígua: devolve as opções (sem link) e guarda as faixas NO SERVIDOR; a escolha manda só o número e o rádio recebe a faixa guardada; vale uma vez', async () => {
    rf.achado = { type: 'ambiguous', results: [faixa(11), faixa(12), faixa(13)] };
    const r = await acao({ action: 'play', query: 'evidencias' });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.resultado, 'escolher');
    assert.deepEqual(r.json.opcoes.map((o) => o.title), ['Faixa 11', 'Faixa 12', 'Faixa 13']);
    semVazar(r.texto, 'opções');
    const antes = rf.chamadas.filter((c) => c[0] === 'enqueue').length;
    assert.equal(antes, rf.chamadas.filter((c) => c[0] === 'enqueue').length, 'nada entrou na fila antes da escolha');
    const e = await acao({ action: 'choose', opcao: 2, track: { title: 'injetada', link: 'https://evil.example/x' } });
    assert.equal(e.status, 200, e.texto);
    assert.equal(e.json.faixa.title, 'Faixa 13');
    const fila = rf.chamadas.filter((c) => c[0] === 'enqueue').at(-1);
    assert.deepEqual(fila[2], { type: 'track', track: faixa(13) }, 'a faixa guardada no servidor, nunca a do corpo do pedido');
    const de_novo = await acao({ action: 'choose', opcao: 0 });
    assert.equal(de_novo.status, 409, 'a escolha vale uma vez');
    assert.match(de_novo.json.error, /Busque de novo/);
  });

  await test('escolha inválida (fora da lista, texto, negativa) 400 sem gastar as opções; vencida (5 min) 409; parar a música descarta as opções', async () => {
    rf.achado = { type: 'ambiguous', results: [faixa(21), faixa(22)] };
    await acao({ action: 'play', query: 'ambigua' });
    for (const opcao of [2, '1', -1, 1.5, null]) assert.equal((await acao({ action: 'choose', opcao })).status, 400, String(opcao));
    assert.equal((await acao({ action: 'choose', opcao: 1 })).status, 200, 'as opções continuavam lá');
    await acao({ action: 'play', query: 'ambigua' });
    relogio.t += RA.RADIO_ESCOLHA_MS;
    assert.equal((await acao({ action: 'choose', opcao: 0 })).status, 409, 'venceu');
    await acao({ action: 'play', query: 'ambigua' });
    assert.equal((await acao({ action: 'stop' })).status, 200);
    assert.equal((await acao({ action: 'choose', opcao: 0 })).status, 409, 'parar descarta');
  });

  await test('busca inválida 400 sem buscar; pular: "tocando" com a próxima ou "fim-da-fila"; sem sessão 404 para tocar, escolher e pular', async () => {
    const buscas = rf.chamadas.filter((c) => c[0] === 'resolve').length;
    for (const query of ['', 'a', 'x'.repeat(201), 'duas\nlinhas', 7]) assert.equal((await acao({ action: 'play', query })).status, 400, JSON.stringify(query));
    assert.equal(rf.chamadas.filter((c) => c[0] === 'resolve').length, buscas);
    rf.proxima = faixa(30);
    assert.deepEqual((await acao({ action: 'skip' })).json, { ok: true, resultado: 'tocando', faixa: { title: 'Faixa 30', artist: 'Artista 30', duration: 210 } });
    assert.deepEqual(rf.chamadas.at(-1), ['skip', G1, true]);
    rf.proxima = null;
    assert.deepEqual((await acao({ action: 'skip' })).json, { ok: true, resultado: 'fim-da-fila' });
    for (const corpo of [{ action: 'play', query: 'lofi' }, { action: 'choose', opcao: 0 }, { action: 'skip' }]) {
      assert.equal((await api('POST', `/v1/admin/radio/${G2}`, corpo)).status, 404, JSON.stringify(corpo));
    }
  });

  await test('a auditoria nunca leva a busca digitada nem a faixa: só admin.radio com a ação e o servidor', () => {
    const tudo = fs.readFileSync(AUDIT, 'utf8');
    for (const p of [BUSCA_SECRETA, 'evidencias', 'Faixa 7', 'Faixa 13', 'deezer']) assert.ok(!tudo.includes(p), `a auditoria levou ${p}`);
    const acoes = new Set(auditoria().filter((e) => e.event === 'admin.radio').map((e) => e.action));
    for (const a of ['start', 'play', 'choose', 'skip', 'stop']) assert.ok(acoes.has(a), a);
    for (const e of auditoria().filter((x) => x.event === 'admin.radio')) assert.deepEqual(Object.keys(e).filter((k) => !['seq', 'prev_hash', 'ts', 'event', 'userId', 'role', 'platform', 'channelKind', 'hash'].includes(k)).sort(), ['action', 'guild']);
  });

  await test('membro 403 sem tocar no rádio; ação inventada 400; as ações antigas seguem iguais (pause, resume, leave) e o GET mostra a fila', async () => {
    const antes = rf.chamadas.length;
    for (const corpo of [{ action: 'start', voiceChannelId: V1, textChannelId: T1 }, { action: 'play', query: 'lofi' }, { action: 'skip' }]) assert.equal((await acao(corpo, { token: T_MEMBER })).status, 403);
    assert.equal(rf.chamadas.length, antes);
    assert.equal((await acao({ action: 'explodir' })).status, 400);
    rf.sessoes.get(G1).queue = [faixa(40, { addedBy: OWNER })];
    const g = await api('GET', '/v1/admin/radio');
    assert.deepEqual(g.json.sessions[0].upcoming, [{ title: 'Faixa 40', duration: 220 }]);
    semVazar(g.texto, 'GET radio');
    for (const a of ['pause', 'resume', 'leave']) assert.deepEqual((await acao({ action: a })).json, { ok: true }, a);
    assert.equal(rf.getSession(G1), null, 'saiu da call');
    assert.equal(actionForRoute('POST', `/v1/admin/radio/${G1}`), 'radio.play_control', 'o mesmo POST de sempre, já no routeGuard');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. O rádio de verdade (radioManager) com o player, os bancos, a voz e o Discord falsos');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const enviados = [];
  const canalDeTexto = { id: T1, guild: guild1, send: async (p) => { enviados.push(p); return { id: `m${enviados.length}`, delete: async () => ({}) }; }, messages: { fetch: async () => ({ delete: async () => ({}) }) } };
  const vozVazia = { id: V1, guild: { id: G1, voiceAdapterCreator: () => ({}) }, members: { filter: () => ({ size: 0 }) } };
  R.client = { channels: { cache: new Map([[T1, canalDeTexto]]) } };
  const intervalos = [];
  const comIntervalosPresos = async (fn) => {
    const original = globalThis.setInterval;
    globalThis.setInterval = (f) => { intervalos.push(f); return { unref() {} }; };
    try { return await fn(); } finally { globalThis.setInterval = original; }
  };
  const agoraReal = Date.now;

  await test('deps.start (radioAdmin -> startRadioInChannel): entra NO canal pedido, cria a sessão com o canal de voz e o de texto e manda o painel no canal de texto, sem ninguém na call', async () => {
    const deps = await RA.defaultRadioDeps();
    R.chamadas.length = 0;
    const r = await comIntervalosPresos(() => deps.start(vozVazia, canalDeTexto, R.client));
    assert.deepEqual(r, { success: true });
    assert.deepEqual(R.chamadas.find((c) => c[0] === 'joinVoiceChannel'), ['joinVoiceChannel', V1, G1]);
    assert.deepEqual(R.chamadas.find((c) => c[0] === 'createSession'), ['createSession', G1, V1, T1]);
    assert.equal(enviados.length, 1, 'o painel do rádio no canal de texto');
    assert.equal(R.sessoes.get(G1).embedMessageId, 'm1');
  });

  await test('a call vazia: iniciado pelo painel, espera os 10 min antes de sair; depois disso sai sozinho (como o /modo-radio)', async () => {
    assert.ok(intervalos.length >= 1, 'o vigia do canal vazio foi ligado');
    for (const f of intervalos) f();
    assert.ok(R.sessoes.has(G1), 'dentro da espera: continua na call');
    assert.ok(!R.chamadas.some((c) => c[0] === 'destroySession'));
    try {
      Date.now = () => agoraReal() + RA.RADIO_ESPERA_SEM_NINGUEM_MS + 1000;
      intervalos[0]();
      await new Promise((res) => setTimeout(res, 20));
    } finally { Date.now = agoraReal; }
    assert.ok(R.chamadas.some((c) => c[0] === 'destroySession' && c[1] === G1), 'passada a espera, sai do canal vazio');
    assert.equal(RA.RADIO_ESPERA_SEM_NINGUEM_MS, 10 * 60_000);
  });

  await test('o /modo-radio (com alguém na call) continua igual: sem espera, o canal vazio derruba na primeira checagem; sem Opus recusa; canal inválido recusa', async () => {
    intervalos.length = 0;
    R.sessoes.clear();
    const membro = { id: OWNER, voice: { channel: vozVazia } };
    assert.deepEqual(await comIntervalosPresos(() => manager.startRadioMode(membro, canalDeTexto, R.client)), { success: true });
    R.chamadas.length = 0;
    intervalos[0]();
    await new Promise((res) => setTimeout(res, 20));
    assert.ok(R.chamadas.some((c) => c[0] === 'destroySession'), 'sem a espera, como sempre');
    R.opus = false;
    try { assert.deepEqual(await manager.startRadioInChannel(vozVazia, canalDeTexto, R.client), { success: false, error: 'voz indisponível' }); } finally { R.opus = true; }
    assert.equal((await manager.startRadioInChannel(null, canalDeTexto, R.client)).success, false);
    assert.equal((await manager.startRadioInChannel(vozVazia, null, R.client)).success, false);
  });

  await test('a fila (a mesma do pedido por voz/conversa): parado -> põe e já toca no canal do rádio; tocando -> só entra na fila; ambígua -> a 1ª; playlist inteira', async () => {
    R.sessoes.clear();
    R.sessoes.set(G1, { guildId: G1, voiceChannelId: V1, textChannelId: T1, status: 'STOPPED', playlist: [], currentIndex: -1 });
    const deps = await RA.defaultRadioDeps();
    R.chamadas.length = 0;
    const a = await deps.enqueue(G1, { type: 'track', track: faixa(1) }, OWNER, R.client);
    assert.deepEqual([a.kind, a.count, a.playing, a.track.addedBy], ['track', 1, true, OWNER]);
    assert.deepEqual(R.chamadas.map((c) => c[0]), ['addTrackToQueue', 'skipToTrack', 'playTrack']);
    R.chamadas.length = 0;
    const b = await deps.enqueue(G1, { type: 'ambiguous', results: [faixa(2), faixa(3)] }, OWNER, R.client);
    assert.deepEqual([b.track.title, b.playing], ['Faixa 2', false]);
    assert.deepEqual(R.chamadas.map((c) => c[0]), ['addTrackToQueue', 'updateEmbed', 'prefetch']);
    const c = await deps.enqueue(G1, { type: 'playlist', tracks: [faixa(4), faixa(5)] }, OWNER, R.client);
    assert.deepEqual([c.kind, c.count], ['playlist', 2]);
    assert.deepEqual((await deps.enqueue(G1, { type: 'track' }, OWNER, R.client)).count, 0, 'faixa vazia não entra');
    assert.deepEqual((await deps.enqueue(G2, { type: 'track', track: faixa(6) }, OWNER, R.client)).count, 0, 'sem sessão, nada');
  });

  await test('pular (nextTrack + playTrack, como o botão): toca a próxima no canal de texto da sessão; fim da fila só atualiza o painel; sem sessão, nada', async () => {
    const deps = await RA.defaultRadioDeps();
    R.chamadas.length = 0;
    R.nextTrackValue = faixa(9);
    assert.equal((await deps.skip(G1, R.client)).title, 'Faixa 9');
    assert.deepEqual(R.chamadas, [['nextTrack', G1], ['playTrack', G1, 'Faixa 9', T1, true]]);
    R.chamadas.length = 0;
    R.nextTrackValue = null;
    assert.equal(await deps.skip(G1, R.client), null);
    assert.deepEqual(R.chamadas, [['nextTrack', G1], ['updateEmbed', G1, T1]]);
    R.chamadas.length = 0;
    assert.equal(await deps.skip(G2, R.client), null);
    assert.deepEqual(R.chamadas, []);
  });

  await test('buscar (deps.resolve) é o resolveInput do rádio, com a busca e o servidor', async () => {
    const deps = await RA.defaultRadioDeps();
    R.resolved = { type: 'track', track: faixa(50) };
    assert.equal((await deps.resolve('samba', G1)).track.title, 'Faixa 50');
    assert.deepEqual(R.chamadas.at(-1), ['resolveInput', 'samba', G1]);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. O cérebro separado e o bot');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const canalFalso = ({ conectado = true, resposta = { ok: true } } = {}) => {
    const pedidos = [];
    return {
      pedidos,
      isConnected: () => conectado,
      emit() {},
      request: async (papel, metodo, params, opts) => { pedidos.push({ papel, metodo, action: params?.action, args: params?.args, idem: opts?.idem ?? null, timeoutMs: opts?.timeoutMs }); return resposta; },
    };
  };

  await test('as ações novas vão ao bot pelo radioAction de sempre (com o corpo, idempotência e prazo maior); os canais são LEITURA; a mesma lista nos dois lados', async () => {
    assert.deepEqual([...BOT_PANEL_ACTIONS].sort(), Object.keys(PANEL_ACTIONS).sort());
    assert.deepEqual([PANEL_ACTIONS.radioAction, PANEL_ACTIONS.radioCanais], [true, false]);
    const canal = canalFalso({ resposta: { ok: true, iniciado: true } });
    const a = createCerebroAdmin({ channel: canal });
    assert.deepEqual(await a.radioAction(ctxDono, G1, 'start', { action: 'start', voiceChannelId: V1, textChannelId: T1 }), { ok: true, iniciado: true });
    assert.deepEqual(canal.pedidos[0].args, [G1, 'start', { action: 'start', voiceChannelId: V1, textChannelId: T1 }]);
    assert.ok(canal.pedidos[0].idem, 'escrita: com idempotência');
    assert.equal(canal.pedidos[0].timeoutMs, PANEL_TIMEOUTS.radioAction);
    assert.ok(PANEL_TIMEOUTS.radioAction > 30_000, 'um pouco mais que o prazo do handler no bot');
    await a.radioCanais(ctxDono, G1);
    assert.deepEqual([canal.pedidos[1].action, canal.pedidos[1].idem], ['radioCanais', null]);
    await assert.rejects(a.radioAction({ role: 'MEMBER', userId: MEMBER }, G1, 'skip', {}), (e) => e.status === 403);
    await assert.rejects(createCerebroAdmin({ channel: canalFalso({ conectado: false }) }).radioCanais(ctxDono, G1), (e) => e.status === 503);
  });

  await test('o bot: executa o radioAction com o corpo e os canais, só do dono', async () => {
    const handlers = new Map();
    const rb = radioFalso();
    rb.achado = { type: 'track', track: faixa(60) };
    const adminDoBot = createAdmin({ client: clientFalso, processo: 'bot', deps: { radio: rb, integrationData: async () => ({}) } });
    registerBotActions({ handle: (m, fn) => handlers.set(m, fn) }, { getClient: () => clientFalso, admin: adminDoBot });
    const iniciar = await handlers.get('panel.admin')({ userId: OWNER, action: 'radioAction', args: [G1, 'start', { voiceChannelId: V1, textChannelId: T1 }] }, { role: 'cerebro' });
    assert.deepEqual(iniciar, { ok: true, iniciado: true });
    const tocar = await handlers.get('panel.admin')({ userId: OWNER, action: 'radioAction', args: [G1, 'play', { query: 'lofi' }] }, { role: 'cerebro' });
    assert.equal(tocar.faixa.title, 'Faixa 60');
    const canais = await handlers.get('panel.admin')({ userId: OWNER, action: 'radioCanais', args: [G1] }, { role: 'cerebro' });
    assert.deepEqual(canais.voz.map((c) => c.id), [V1, V_SEM, V_CHEIO]);
    await assert.rejects(handlers.get('panel.admin')({ userId: MEMBER, action: 'radioAction', args: [G1, 'skip', {}] }, {}), (e) => e.code === 'FORBIDDEN');
  });

  await test('registrado no package.json, no CI (SUITES) e no README_TESTES.md', () => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts['test:painelradio'], 'node tests/test-painel-radio.js');
    assert.match(fs.readFileSync(path.join(repoRoot, 'scripts', 'run-ci.mjs'), 'utf8'), /'test:painelradio'/);
    assert.match(fs.readFileSync(path.join(repoRoot, 'README_TESTES.md'), 'utf8'), /\| `test:painelradio` \|/);
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  for (const s of servidores) { try { s.close(); s.closeAllConnections?.(); } catch { /* */ } }
  await new Promise((r) => setTimeout(r, 300)); // deixa os soquetes fecharem antes do process.exit (evita o aborto do libuv no Windows)
  try { process.chdir(repoRoot); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
