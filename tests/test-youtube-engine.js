// Testes do motor do YouTube: consumo de cota (detalhes só do que precisa, em lote), resiliência a falhas
// e pausa quando a cota diária acaba. Sem rede e sem banco real: API e repositório são dublês.
// Execução: npm run test:youtubeengine
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-yt-'));
process.env.DATABASE_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.chdir(tmp);

const { createYoutubeEngine, fetchVideoDetailsBatch, needsDetails } = await import(new URL('../src/engines/youtube/index.js', import.meta.url));

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FALHA  ${name}\n      ${err.stack || err.message}`);
  }
};

const NOW = Date.parse('2026-10-14T12:00:00Z');
const sqlTime = (msAgo) => new Date(NOW - msAgo).toISOString().slice(0, 19).replace('T', ' '); // formato do SQLite
const HOUR = 3600_000;

const silentLog = { info() {}, warn() {}, error() {} };
const details = (id, over = {}) => ({
  id,
  snippet: { title: `Título ${id}`, channelTitle: 'Canal X', publishedAt: '2026-10-14T10:00:00Z', liveBroadcastContent: 'none', thumbnails: {} },
  contentDetails: { duration: 'PT10M' },
  ...over,
});

/** Monta motor + dublês. channels: { UC1: [ids...] } */
function make({ channels, seen = {}, detailsFor = (id) => details(id), fetchError = null, listError = {}, failUpsertFor = null, log = silentLog } = {}) {
  const calls = { list: [], details: [] };
  const upserts = [];
  const state = { now: NOW };
  const repo = {
    getAllSubscriptions: () => Object.keys(channels).map((c) => ({ youtube_channel_id: c })),
    getAllTrackedChannels: () => Object.keys(channels).map((c) => ({ youtube_channel_id: c, channel_name: `Canal ${c}`, uploads_playlist_id: `UU${c}` })),
    getSeenItem: (id) => seen[id],
    upsertSeenItem: (id, ch, st) => {
      if (failUpsertFor === id) throw new Error('disco cheio');
      upserts.push({ id, ch, st });
      seen[id] = { last_known_state: st, first_seen_at: sqlTime(0) };
    },
  };
  const api = {
    resolveChannel: async () => null,
    getLatestChannelItems: async (playlistId) => {
      calls.list.push(playlistId);
      const ch = playlistId.slice(2);
      if (listError[ch]) throw listError[ch];
      return channels[ch].map((videoId) => ({ videoId, title: `Título ${videoId}`, publishedAt: '2026-10-14T10:00:00Z', thumbnails: {} }));
    },
    fetchVideoDetails: async (ids) => {
      calls.details.push([...ids]);
      if (fetchError) throw fetchError;
      const map = new Map();
      for (const id of ids) {
        const d = detailsFor(id);
        if (d) map.set(id, d);
      }
      return map;
    },
  };
  const engine = createYoutubeEngine({ repo, api, now: () => state.now, log });
  return { engine, calls, upserts, seen, state };
}
const seenVideo = (agoMs = 30 * 24 * HOUR, st = 'video') => ({ last_known_state: st, first_seen_at: sqlTime(agoMs) });
const quotaError = () => Object.assign(new Error('YouTube API playlistItems error 403: {"error":{"errors":[{"reason":"quotaExceeded"}]}}'), { status: 403 });

console.log('Consumo de cota');
await test('7 canais com tudo já visto e estável: ZERO chamadas de detalhes (antes eram 35 por ciclo)', async () => {
  const channels = {};
  const seen = {};
  for (let c = 1; c <= 7; c++) {
    channels['C' + c] = [1, 2, 3, 4, 5].map((n) => `v${c}_${n}`);
    for (const id of channels['C' + c]) seen[id] = seenVideo();
  }
  const t = make({ channels, seen });
  const events = await t.engine.checkYoutubeChannels();
  assert.deepEqual(events, []);
  assert.equal(t.calls.list.length, 7);
  assert.equal(t.calls.details.length, 0);
  assert.equal(t.upserts.length, 0);
});
await test('um vídeo novo entre vistos: UMA chamada de detalhes só com o ID novo, evento publicado e item marcado', async () => {
  const seen = { a: seenVideo(), b: seenVideo() };
  const t = make({ channels: { C1: ['novo', 'a', 'b'] }, seen });
  const events = await t.engine.checkYoutubeChannels();
  assert.deepEqual(t.calls.details, [['novo']]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'video');
  assert.equal(events[0].videoId, 'novo');
  assert.equal(events[0].url, 'https://youtu.be/novo');
  assert.equal(events[0].channelId, 'C1');
  assert.deepEqual(t.upserts, [{ id: 'novo', ch: 'C1', st: 'video' }]);
});
await test('vários canais com novidades: os detalhes saem em UM lote só (id=a,b,c)', async () => {
  const t = make({ channels: { C1: ['n1', 'x'], C2: ['n2'], C3: ['n3'] }, seen: { x: seenVideo() } });
  const events = await t.engine.checkYoutubeChannels();
  assert.equal(t.calls.details.length, 1);
  assert.deepEqual(t.calls.details[0].sort(), ['n1', 'n2', 'n3']);
  assert.deepEqual(events.map((e) => e.videoId), ['n1', 'n2', 'n3'], 'ordem dos canais preservada');
});
await test('regras de reconferência: upcoming/live sempre; video/ended_vod só nas primeiras 48 h; short nunca', async () => {
  const seen = {
    up: seenVideo(90 * 24 * HOUR, 'upcoming'),
    live: seenVideo(90 * 24 * HOUR, 'live'),
    recente: seenVideo(2 * HOUR, 'video'),
    recenteVod: seenVideo(10 * HOUR, 'ended_vod'),
    antigo: seenVideo(100 * HOUR, 'video'),
    antigoVod: seenVideo(100 * HOUR, 'ended_vod'),
    curto: seenVideo(1 * HOUR, 'short'),
  };
  const t = make({ channels: { C1: Object.keys(seen) }, seen });
  await t.engine.checkYoutubeChannels();
  assert.deepEqual(t.calls.details[0].sort(), ['live', 'recente', 'recenteVod', 'up']);
  assert.equal(needsDetails(undefined, NOW), true);
  assert.equal(needsDetails({ last_known_state: 'video', first_seen_at: null }, NOW), true, 'sem data confiável: reconfere (comportamento antigo)');
});
await test('transição upcoming -> live gera live_started; live -> ended_vod gera live_ended (mesmo comportamento de antes)', async () => {
  const seen = { s1: seenVideo(5 * HOUR, 'upcoming'), s2: seenVideo(5 * HOUR, 'live') };
  const detailsFor = (id) => details(id, {
    snippet: { title: id, channelTitle: 'Canal X', publishedAt: '2026-10-14T10:00:00Z', liveBroadcastContent: id === 's1' ? 'live' : 'none' },
    ...(id === 's2' ? { liveStreamingDetails: { actualEndTime: '2026-10-14T11:00:00Z' } } : {}),
  });
  const t = make({ channels: { C1: ['s1', 's2'] }, seen, detailsFor });
  const events = await t.engine.checkYoutubeChannels();
  assert.deepEqual(events.map((e) => `${e.videoId}:${e.type}`), ['s1:live_started', 's2:live_ended']);
  assert.deepEqual(t.upserts.map((u) => `${u.id}:${u.st}`), ['s1:live', 's2:ended_vod']);
});
await test('ID que a API não devolve (null): segue o comportamento antigo e anuncia como vídeo', async () => {
  const t = make({ channels: { C1: ['fantasma'] }, detailsFor: () => null });
  const events = await t.engine.checkYoutubeChannels();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'video');
  assert.equal(events[0].title, 'Título fantasma');
});
await test('o que já foi anunciado não é anunciado de novo no ciclo seguinte', async () => {
  const t = make({ channels: { C1: ['novo'] } });
  assert.equal((await t.engine.checkYoutubeChannels()).length, 1);
  assert.equal((await t.engine.checkYoutubeChannels()).length, 0);
  assert.equal(t.upserts.length, 1);
});

console.log('Resiliência');
await test('falha na busca de detalhes: ciclo não lança, nada é anunciado nem marcado como visto; o próximo ciclo recupera', async () => {
  const t = make({ channels: { C1: ['novo'] }, fetchError: new Error('YouTube API videos error 500') });
  assert.deepEqual(await t.engine.checkYoutubeChannels(), []);
  assert.equal(t.upserts.length, 0);
  const t2 = make({ channels: { C1: ['novo'] } });
  assert.equal((await t2.engine.checkYoutubeChannels()).length, 1);
});
await test('erro em UM canal não aborta os outros (antes, um erro jogava fora o ciclo inteiro)', async () => {
  const t = make({ channels: { C1: ['a1'], C2: ['b1'], C3: ['c1'] }, listError: { C2: new Error('fetch failed') } });
  const events = await t.engine.checkYoutubeChannels();
  assert.deepEqual(events.map((e) => e.videoId), ['a1', 'c1']);
});
await test('falha ao gravar UM item não derruba os demais nem repete o anúncio dele', async () => {
  const t = make({ channels: { C1: ['ruim', 'bom'] }, failUpsertFor: 'ruim' });
  const events = await t.engine.checkYoutubeChannels();
  assert.deepEqual(events.map((e) => e.videoId), ['bom']);
});
await test('erro inesperado no fim do ciclo não joga fora os eventos já gravados como vistos', async () => {
  const log = { info(m) { if (/Checagem concluída/.test(m)) throw new Error('log quebrado'); }, warn() {}, error() {} };
  const t = make({ channels: { C1: ['a'], C2: ['b'] }, log });
  const events = await t.engine.checkYoutubeChannels();
  assert.deepEqual(events.map((e) => e.videoId), ['a', 'b']);
  assert.equal(t.upserts.length, 2);
});
await test('ciclos concorrentes: o segundo retorna vazio sem tocar na API', async () => {
  const t = make({ channels: { C1: ['a'] } });
  const [r1, r2] = await Promise.all([t.engine.checkYoutubeChannels(), t.engine.checkYoutubeChannels()]);
  assert.equal(r1.length + r2.length, 1);
  assert.equal(t.calls.list.length, 1);
});

console.log('Cota diária esgotada');
await test('quotaExceeded na lista de uploads: para os outros canais (1 chamada) e pausa por 15 min', async () => {
  const t = make({ channels: { C1: ['a'], C2: ['b'], C3: ['c'] }, listError: { C1: quotaError() } });
  assert.deepEqual(await t.engine.checkYoutubeChannels(), []);
  assert.equal(t.calls.list.length, 1, 'não insiste nos outros canais');
  t.state.now += 5 * 60_000;
  await t.engine.checkYoutubeChannels();
  assert.equal(t.calls.list.length, 1, 'dentro da pausa não chama a API');
  t.state.now += 11 * 60_000;
  await t.engine.checkYoutubeChannels();
  assert.ok(t.calls.list.length > 1, 'depois da pausa volta a tentar');
});
await test('quotaExceeded na busca de detalhes também pausa as checagens', async () => {
  const err = Object.assign(new Error('YouTube API videos error 403'), { quotaExceeded: true, status: 403 });
  const t = make({ channels: { C1: ['a'] }, fetchError: err });
  await t.engine.checkYoutubeChannels();
  assert.equal(t.calls.details.length, 1);
  t.state.now += 60_000;
  await t.engine.checkYoutubeChannels();
  assert.equal(t.calls.details.length, 1);
  assert.equal(t.calls.list.length, 1);
});

console.log('Busca em lote (fetchVideoDetailsBatch)');
function fakeFetch(handler) {
  const urls = [];
  const impl = async (url) => {
    urls.push(String(url));
    return handler(String(url));
  };
  return { impl, urls };
}
const okResponse = (items) => ({ ok: true, status: 200, json: async () => ({ items }), text: async () => '' });
await test('junta os IDs em id=a,b,c numa chamada só e devolve um mapa por ID', async () => {
  const f = fakeFetch((url) => okResponse(new URL(url).searchParams.get('id').split(',').map((id) => ({ id }))));
  const map = await fetchVideoDetailsBatch(['a', 'b', 'c', 'a'], { apiKey: 'CHAVE-FALSA', fetchImpl: f.impl });
  assert.equal(f.urls.length, 1);
  const u = new URL(f.urls[0]);
  assert.equal(u.searchParams.get('id'), 'a,b,c');
  assert.equal(u.searchParams.get('part'), 'snippet,contentDetails,liveStreamingDetails');
  // videos.list NÃO aceita maxResults junto com id (a API pode responder 400): não pode ir na URL.
  assert.equal(u.searchParams.has('maxResults'), false);
  assert.deepEqual([...map.keys()], ['a', 'b', 'c']);
});
await test('mais de 50 IDs: lotes de 50 (120 IDs = 3 chamadas)', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `id${i}`);
  const f = fakeFetch((url) => okResponse(new URL(url).searchParams.get('id').split(',').map((id) => ({ id }))));
  const map = await fetchVideoDetailsBatch(ids, { apiKey: 'CHAVE-FALSA', fetchImpl: f.impl });
  assert.equal(f.urls.length, 3);
  assert.equal(map.size, 120);
});
await test('sem chave ou sem IDs: não chama a API', async () => {
  const f = fakeFetch(() => okResponse([]));
  assert.equal((await fetchVideoDetailsBatch(['a'], { apiKey: '', fetchImpl: f.impl })).size, 0);
  assert.equal((await fetchVideoDetailsBatch([], { apiKey: 'K', fetchImpl: f.impl })).size, 0);
  assert.equal(f.urls.length, 0);
});
await test('403 quotaExceeded vira erro marcado (quotaExceeded) e a mensagem não carrega a chave', async () => {
  const f = fakeFetch(() => ({ ok: false, status: 403, text: async () => '{"error":{"errors":[{"reason":"quotaExceeded"}]}}' }));
  await assert.rejects(
    fetchVideoDetailsBatch(['a'], { apiKey: 'CHAVE-FALSA-123', fetchImpl: f.impl }),
    (err) => err.quotaExceeded === true && err.status === 403 && !err.message.includes('CHAVE-FALSA-123')
  );
  const g = fakeFetch(() => ({ ok: false, status: 500, text: async () => 'erro interno' }));
  await assert.rejects(fetchVideoDetailsBatch(['a'], { apiKey: 'K', fetchImpl: g.impl }), (err) => err.quotaExceeded === false);
});

console.log(`\n${passed} testes OK${failed ? `, ${failed} FALHARAM` : ''}`);
process.exit(failed ? 1 : 0);
