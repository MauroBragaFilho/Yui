// Testes dos avisos de live do YouTube que editam a mensagem já enviada (modos 'auto' | 'new' | 'edit'), da duração da live,
// da migração da coluna live_mode e do publicador. Sem rede e sem Discord: cliente de mentira, banco em pasta temporária.
// Execução: npm run test:youtubelive
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ytlive-'));
process.env.DATABASE_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.chdir(tmp);

const root = (p) => new URL(`../${p}`, import.meta.url);
const { pickLiveEditTarget, autoEditWindowMs, parseSqlTime } = await import(root('src/discord/youtubeLive.js'));
const { formatLiveDuration, createYoutubeLiveEmbed } = await import(root('src/discord/embeds/youtubeEmbed.js'));
const { initDatabase, getDbWrapper } = await import(root('src/database/db.js'));
const { CORE_SCHEMA } = await import(root('src/database/schemas.js'));

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { failed++; console.log(`  FALHA  ${name}\n      ${err.stack || err.message}`); }
};

const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const NOW = Date.parse('2026-11-10T20:00:00Z');
const MIN = 60_000;
const rec = (agoMin) => ({ channel_id: 'C1', message_id: 'M1', published_at: sqlTime(NOW - agoMin * MIN) });

await test('decisão: modo "new" nunca edita', () => {
  for (const type of ['live_started', 'live_ended']) {
    assert.strictEqual(pickLiveEditTarget({ mode: 'new', type, scheduledRec: rec(1), startedRec: rec(1), now: NOW }), null);
  }
});

await test('decisão: agendada, vod e vídeo nunca editam', () => {
  for (const type of ['live_scheduled', 'vod', 'video']) {
    assert.strictEqual(pickLiveEditTarget({ mode: 'edit', type, scheduledRec: rec(1), startedRec: rec(1), now: NOW }), null);
  }
});

await test('decisão: modo "edit" edita a agendada no início e a do início no fim', () => {
  assert.strictEqual(pickLiveEditTarget({ mode: 'edit', type: 'live_started', scheduledRec: rec(60 * 24), now: NOW }).message_id, 'M1');
  assert.strictEqual(pickLiveEditTarget({ mode: 'edit', type: 'live_started', scheduledRec: null, now: NOW }), null);
  const started = { channel_id: 'C2', message_id: 'M2', published_at: sqlTime(NOW) };
  assert.strictEqual(pickLiveEditTarget({ mode: 'edit', type: 'live_ended', scheduledRec: rec(500), startedRec: started, now: NOW }).message_id, 'M2');
  assert.strictEqual(pickLiveEditTarget({ mode: 'edit', type: 'live_ended', scheduledRec: rec(500), startedRec: null, now: NOW }).message_id, 'M1');
  assert.strictEqual(pickLiveEditTarget({ mode: 'edit', type: 'live_ended', now: NOW }), null);
});

await test('decisão: modo "auto" edita no início só se foi agendada há pouco (janela de 120 min)', () => {
  const pick = (scheduledRec) => pickLiveEditTarget({ mode: 'auto', type: 'live_started', scheduledRec, now: NOW, windowMs: 120 * MIN });
  assert.strictEqual(pick(rec(10)).message_id, 'M1');
  assert.strictEqual(pick(rec(120)).message_id, 'M1', 'no limite ainda edita');
  assert.strictEqual(pick(rec(121)), null);
  assert.strictEqual(pick(rec(60 * 20)), null, 'agendada para o dia seguinte: mensagem nova');
  assert.strictEqual(pick({ channel_id: 'C', message_id: 'M', published_at: 'lixo' }), null, 'sem data legível: mensagem nova');
});

await test('decisão: no modo "auto" o fim sempre edita a mensagem que existir', () => {
  assert.strictEqual(pickLiveEditTarget({ mode: 'auto', type: 'live_ended', startedRec: rec(60 * 72), now: NOW }).message_id, 'M1');
  assert.strictEqual(pickLiveEditTarget({ mode: 'auto', type: 'live_ended', scheduledRec: rec(60 * 72), now: NOW }).message_id, 'M1');
});

await test('janela do auto vem do ambiente, com limites', () => {
  assert.strictEqual(autoEditWindowMs({}), 120 * MIN);
  assert.strictEqual(autoEditWindowMs({ YUI_YT_LIVE_AUTO_EDIT_MIN: '30' }), 30 * MIN);
  assert.strictEqual(autoEditWindowMs({ YUI_YT_LIVE_AUTO_EDIT_MIN: '1' }), 5 * MIN);
  assert.strictEqual(autoEditWindowMs({ YUI_YT_LIVE_AUTO_EDIT_MIN: '99999' }), 1440 * MIN);
  assert.strictEqual(autoEditWindowMs({ YUI_YT_LIVE_AUTO_EDIT_MIN: 'abc' }), 120 * MIN);
  assert.strictEqual(parseSqlTime('2026-11-10 20:00:00'), NOW);
  assert.strictEqual(parseSqlTime(''), null);
});

await test('duração da live em texto', () => {
  assert.strictEqual(formatLiveDuration(20_000), 'menos de 1 min');
  assert.strictEqual(formatLiveDuration(42 * MIN), '42min');
  assert.strictEqual(formatLiveDuration(60 * MIN), '1h');
  assert.strictEqual(formatLiveDuration(192 * MIN), '3h 12min');
  assert.strictEqual(formatLiveDuration((3 * 1440 + 7 * 60) * MIN), '3d 7h');
  assert.strictEqual(formatLiveDuration(2 * 1440 * MIN), '2d');
  assert.strictEqual(formatLiveDuration(-5), '');
  assert.strictEqual(formatLiveDuration(null), '');
  assert.strictEqual(formatLiveDuration(undefined), '');
});

await test('embed de live encerrada mostra a duração; os outros não', () => {
  const base = { videoId: 'v1', channelId: 'UC1', channelName: 'Canal', title: 'Título', url: 'https://youtu.be/v1' };
  const ended = createYoutubeLiveEmbed({ ...base, type: 'live_ended', durationMs: 192 * MIN }).toJSON();
  assert.ok(ended.fields?.some((f) => f.name.includes('Duração') && f.value === '3h 12min'));
  assert.ok(!createYoutubeLiveEmbed({ ...base, type: 'live_ended', durationMs: null }).toJSON().fields?.length);
  assert.ok(!createYoutubeLiveEmbed({ ...base, type: 'live_started', durationMs: 5 * MIN }).toJSON().fields?.length);
});

// ── Banco: migração e modo por inscrição ──
const OLD_YOUTUBE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS youtube_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL, youtube_channel_id TEXT NOT NULL, channel_name TEXT, uploads_playlist_id TEXT,
    discord_channel_id TEXT NOT NULL, mention_role_id TEXT,
    notify_videos INTEGER DEFAULT 1, notify_shorts INTEGER DEFAULT 1, notify_lives INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(guild_id, youtube_channel_id, discord_channel_id)
  );
  CREATE TABLE IF NOT EXISTS youtube_seen_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT UNIQUE NOT NULL, youtube_channel_id TEXT NOT NULL,
    last_known_state TEXT NOT NULL DEFAULT 'video', first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;
await initDatabase('social-youtube', OLD_YOUTUBE_SCHEMA); // banco "antigo", sem live_mode
await initDatabase('core', CORE_SCHEMA);
const { youtubeRepository, ensureYoutubeSchema, normalizeLiveMode, LIVE_MODES } = await import(root('src/database/repositories/youtubeRepo.js'));
const yt = getDbWrapper('social-youtube');
yt.prepare("INSERT INTO youtube_subscriptions (guild_id, youtube_channel_id, channel_name, discord_channel_id) VALUES ('G0','UCold','Antigo','D0')").run();

await test('migração: acrescenta live_mode, inscrições antigas ficam "new", e roda uma vez só', () => {
  assert.strictEqual(ensureYoutubeSchema(), true);
  assert.strictEqual(yt.prepare("SELECT live_mode FROM youtube_subscriptions WHERE guild_id='G0'").get().live_mode, 'new');
  assert.strictEqual(ensureYoutubeSchema(), false);
});

await test('inscrição nova nasce em "auto"; o modo muda por inscrição e valor inválido vira "auto"', () => {
  youtubeRepository.addSubscription({ guildId: 'G1', youtubeChannelId: 'UC1', channelName: 'Um', discordChannelId: 'D1' });
  youtubeRepository.addSubscription({ guildId: 'G1', youtubeChannelId: 'UC1', channelName: 'Um', discordChannelId: 'D2', liveMode: 'edit' });
  youtubeRepository.addSubscription({ guildId: 'G1', youtubeChannelId: 'UC2', channelName: 'Dois', discordChannelId: 'D1', liveMode: 'xyz' });
  const mode = (g, c, d) => yt.prepare('SELECT live_mode m FROM youtube_subscriptions WHERE guild_id=? AND youtube_channel_id=? AND discord_channel_id=?').get(g, c, d).m;
  assert.strictEqual(mode('G1', 'UC1', 'D1'), 'auto');
  assert.strictEqual(mode('G1', 'UC1', 'D2'), 'edit');
  assert.strictEqual(mode('G1', 'UC2', 'D1'), 'auto');
  assert.strictEqual(youtubeRepository.setLiveMode('G1', 'UC1', 'D1', 'new').changes, 1);
  assert.strictEqual(mode('G1', 'UC1', 'D1'), 'new');
  assert.strictEqual(mode('G1', 'UC1', 'D2'), 'edit', 'só a inscrição escolhida muda');
  assert.strictEqual(youtubeRepository.setLiveMode('G1', 'UC1', 'D1', 'lixo').changes, 1);
  assert.strictEqual(mode('G1', 'UC1', 'D1'), 'auto');
  assert.deepStrictEqual([...LIVE_MODES], ['auto', 'new', 'edit']);
  assert.strictEqual(normalizeLiveMode(' EDIT '), 'edit');
});

// ── Publicador com Discord de mentira ──
const { discordPublisher } = await import(root('src/discord/publisher.js'));

function fakeDiscord({ failEdit = false } = {}) {
  const sent = [];
  const edits = [];
  let n = 0;
  const messages = new Map();
  const channel = {
    isTextBased: () => true,
    send: async (payload) => {
      const id = `msg${++n}`;
      sent.push({ id, payload });
      messages.set(id, { id, edit: async (p) => { if (failEdit) throw new Error('Unknown Message'); edits.push({ id, payload: p }); } });
      return { id };
    },
    messages: {
      fetch: async (id) => {
        const m = messages.get(id);
        if (!m) throw new Error('Unknown Message');
        return m;
      },
    },
  };
  return { sent, edits, client: { channels: { fetch: async () => channel } } };
}

const ev = (type, extra = {}) => ({ type, videoId: 'VID', channelId: 'UCx', channelName: 'Canal', title: 'Live', url: 'https://youtu.be/VID', thumbnailUrl: 'https://img/x.jpg', publishedAt: '2026-11-10T20:00:00Z', ...extra });
let seq = 0;
function subscribe(mode, role = null) {
  const guildId = `GP${++seq}`;
  youtubeRepository.addSubscription({ guildId, youtubeChannelId: 'UCx', channelName: 'Canal', discordChannelId: `DP${seq}`, mentionRoleId: role, liveMode: mode });
  return guildId;
}
const resetSubs = () => yt.prepare("DELETE FROM youtube_subscriptions WHERE youtube_channel_id='UCx'").run();
const newVideo = () => `VID${++seq}`;
const age = (guildId, videoId, type, minutes) =>
  getDbWrapper('core').prepare('UPDATE published_messages SET published_at=? WHERE guild_id=? AND content_id=?').run(sqlTime(Date.now() - minutes * MIN), guildId, `${videoId}:${type}`);
const publish = (d, type, extra) => discordPublisher.publishYoutubeEvent(d.client, ev(type, extra));

await test('auto, live iniciada logo: uma mensagem só (agendada -> ao vivo -> encerrada editada, com duração)', async () => {
  resetSubs(); subscribe('auto', 'ROLE1'); const d = fakeDiscord(); const v = newVideo();
  await publish(d, 'live_scheduled', { videoId: v });
  await publish(d, 'live_started', { videoId: v });
  await publish(d, 'live_ended', { videoId: v, durationMs: 192 * MIN });
  assert.strictEqual(d.sent.length, 1, 'uma única mensagem enviada');
  assert.ok(String(d.sent[0].payload.content).includes('ROLE1'), 'o aviso com o cargo saiu na primeira');
  assert.strictEqual(d.edits.length, 2);
  assert.ok(d.edits.every((e) => e.id === 'msg1'));
  assert.ok(!('content' in d.edits[0].payload), 'a edição não mexe no texto (não reenvia o aviso)');
  const last = d.edits[1].payload.embeds[0].toJSON();
  assert.ok(last.footer.text.includes('encerrada') && last.fields.some((f) => f.value === '3h 12min'));
  await publish(d, 'live_ended', { videoId: v }); // repetir não faz nada (registro por etapa)
  assert.strictEqual(d.edits.length, 2);
  assert.strictEqual(d.sent.length, 1);
});

await test('auto, agendada para longe: mensagem nova no início (com aviso) e o fim edita ESSA', async () => {
  resetSubs(); const g = subscribe('auto', 'ROLE2'); const d = fakeDiscord(); const v = newVideo();
  await publish(d, 'live_scheduled', { videoId: v });
  age(g, v, 'live_scheduled', 60 * 20); // agendada há 20 h
  await publish(d, 'live_started', { videoId: v });
  assert.strictEqual(d.sent.length, 2, 'início = mensagem nova');
  assert.ok(String(d.sent[1].payload.content).includes('ROLE2'));
  await publish(d, 'live_ended', { videoId: v, durationMs: 60 * MIN });
  assert.strictEqual(d.sent.length, 2, 'o fim não manda mensagem nova');
  assert.deepStrictEqual(d.edits.map((e) => e.id), ['msg2'], 'edita a mensagem do início');
});

await test('modo "new": uma mensagem por etapa, como sempre foi', async () => {
  resetSubs(); subscribe('new'); const d = fakeDiscord(); const v = newVideo();
  for (const t of ['live_scheduled', 'live_started', 'live_ended']) await publish(d, t, { videoId: v });
  assert.strictEqual(d.sent.length, 3);
  assert.strictEqual(d.edits.length, 0);
});

await test('modo "edit": edita sempre, mesmo agendada há um dia', async () => {
  resetSubs(); const g = subscribe('edit'); const d = fakeDiscord(); const v = newVideo();
  await publish(d, 'live_scheduled', { videoId: v });
  age(g, v, 'live_scheduled', 60 * 30);
  await publish(d, 'live_started', { videoId: v });
  await publish(d, 'live_ended', { videoId: v });
  assert.strictEqual(d.sent.length, 1);
  assert.strictEqual(d.edits.length, 2);
});

await test('sem o início anunciado, o fim vira mensagem nova (não há o que editar)', async () => {
  resetSubs(); subscribe('auto'); const d = fakeDiscord(); const v = newVideo();
  await publish(d, 'live_ended', { videoId: v, durationMs: 5 * MIN });
  assert.strictEqual(d.sent.length, 1);
  assert.strictEqual(d.edits.length, 0);
});

await test('edição que falha (mensagem apagada, sem permissão): cai para uma mensagem nova', async () => {
  resetSubs(); subscribe('auto'); const d = fakeDiscord({ failEdit: true }); const v = newVideo();
  await publish(d, 'live_scheduled', { videoId: v });
  await publish(d, 'live_started', { videoId: v });
  assert.strictEqual(d.sent.length, 2, 'a edição falhou e foi enviada uma nova');
  assert.strictEqual(d.edits.length, 0);
});

await test('servidores diferentes: cada um segue o próprio modo', async () => {
  resetSubs(); subscribe('auto'); subscribe('new'); const d = fakeDiscord(); const v = newVideo();
  await publish(d, 'live_scheduled', { videoId: v });
  await publish(d, 'live_started', { videoId: v });
  assert.strictEqual(d.sent.length, 3, '2 agendadas + 1 início (só o servidor em "new" manda mensagem nova)');
  assert.strictEqual(d.edits.length, 1);
});

await test('vídeo comum não é afetado pelo modo', async () => {
  resetSubs(); subscribe('edit'); const d = fakeDiscord(); const v = newVideo();
  await publish(d, 'video', { videoId: v });
  assert.strictEqual(d.sent.length, 1);
  assert.strictEqual(d.edits.length, 0);
});

console.log(`\n${passed} teste(s) ok, ${failed} falha(s).`);
process.exit(failed ? 1 : 0);
