/**
 * Teste funcional das novas funcionalidades de monitoramento social:
 * - Bancos de dados YouTube/Twitch (schema + repositórios)
 * - Classificador de item do YouTube (vídeo/Short/live/vod)
 *
 * Uso: node tests/test-social.js
 */
import { initDatabase } from '../src/database/db.js';
import { YOUTUBE_SCHEMA, TWITCH_SCHEMA } from '../src/database/schemas.js';
import { youtubeRepository } from '../src/database/repositories/youtubeRepo.js';
import { twitchRepository } from '../src/database/repositories/twitchRepo.js';
import { classifyYoutubeItem, resolveChannel } from '../src/handlers/youtubeApiHandler.js';
import { config } from '../src/config/index.js';

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

async function run() {
  console.log('\n=== INICIALIZANDO BANCOS ===');
  await initDatabase('social-youtube', YOUTUBE_SCHEMA);
  await initDatabase('social-twitch', TWITCH_SCHEMA);
  console.log('  ✅ Bancos social-youtube.db e social-twitch.db prontos');

  console.log('\n=== YOUTUBE REPOSITÓRIO ===');
  const testGuild = '__TEST_GUILD_1__';
  const testChannel = 'UC_test_channel_1234567890123';
  const testVideoId = '__test_video_1__';

  const addRes = youtubeRepository.addSubscription({
    guildId: testGuild,
    youtubeChannelId: testChannel,
    channelName: 'Canal de Teste',
    uploadsPlaylistId: 'UU_test_playlist_1234567890123',
    discordChannelId: '111111111111111111',
    mentionRoleId: null,
  });
  assert(addRes.changes > 0, 'addSubscription insere novo registro');

  const dupRes = youtubeRepository.addSubscription({
    guildId: testGuild,
    youtubeChannelId: testChannel,
    channelName: 'Canal de Teste',
    uploadsPlaylistId: 'UU_test_playlist_1234567890123',
    discordChannelId: '111111111111111111',
  });
  assert(dupRes.changes === 0, 'addSubscription duplicada é ignorada (INSERT OR IGNORE)');

  const byGuild = youtubeRepository.getSubscriptionsByGuild(testGuild);
  assert(byGuild.length === 1 && byGuild[0].youtube_channel_id === testChannel, 'getSubscriptionsByGuild retorna subscription');

  const tracked = youtubeRepository.getAllTrackedChannels();
  assert(tracked.some((t) => t.youtube_channel_id === testChannel && t.uploads_playlist_id === 'UU_test_playlist_1234567890123'), 'getAllTrackedChannels retorna uploads_playlist_id');

  // Seen items
  assert(youtubeRepository.getSeenItem(testVideoId) === null, 'getSeenItem retorna null antes de upsert');
  youtubeRepository.upsertSeenItem(testVideoId, testChannel, 'video');
  const seen1 = youtubeRepository.getSeenItem(testVideoId);
  assert(seen1 && seen1.last_known_state === 'video', 'upsertSeenItem grava estado inicial');
  youtubeRepository.upsertSeenItem(testVideoId, testChannel, 'live');
  const seen2 = youtubeRepository.getSeenItem(testVideoId);
  assert(seen2 && seen2.last_known_state === 'live', 'upsertSeenItem atualiza transição de estado');

  const rmRes = youtubeRepository.removeByGuildAndChannel(testGuild, testChannel);
  assert(rmRes.changes === 1, 'removeByGuildAndChannel remove subscription');

  console.log('\n=== TWITCH REPOSITÓRIO ===');
  const twitchGuild = '__TEST_GUILD_2__';
  twitchRepository.addSubscription({
    guildId: twitchGuild,
    twitchLogin: 'streamexemplo',
    twitchUserId: '123456789',
    discordChannelId: '222222222222222222',
  });
  const twitchByGuild = twitchRepository.getSubscriptionsByGuild(twitchGuild);
  assert(twitchByGuild.length === 1 && twitchByGuild[0].twitch_login === 'streamexemplo', 'addSubscription Twitch + getSubscriptionsByGuild');

  // Stream state transitions
  assert(twitchRepository.getStreamState('streamexemplo') === null, 'getStreamState null antes');

  twitchRepository.upsertStreamState('streamexemplo', true, 'stream-abc-123');
  const state1 = twitchRepository.getStreamState('streamexemplo');
  assert(state1 && state1.is_live === 1 && state1.last_stream_id === 'stream-abc-123', 'upsertStreamState grava online');

  twitchRepository.upsertStreamState('streamexemplo', false, null);
  const state2 = twitchRepository.getStreamState('streamexemplo');
  assert(state2 && state2.is_live === 0 && state2.last_stream_id === null, 'upsertStreamState grava offline');

  twitchRepository.removeByGuildAndLogin(twitchGuild, 'streamexemplo');
  assert(twitchRepository.getSubscriptionsByGuild(twitchGuild).length === 0, 'removeByGuildAndLogin Twitch');

  console.log('\n=== CLASSIFICADOR DE ITEM DO YOUTUBE ===');
  assert(classifyYoutubeItem(null) === 'video', 'null details -> video (fallback)');
  assert(classifyYoutubeItem({}) === 'video', 'objeto vazio -> video');

  assert(
    classifyYoutubeItem({ snippet: { liveBroadcastContent: 'live' } }) === 'live',
    'liveBroadcastContent=live -> live'
  );
  assert(
    classifyYoutubeItem({ snippet: { liveBroadcastContent: 'upcoming' } }) === 'upcoming',
    'liveBroadcastContent=upcoming -> upcoming'
  );
  assert(
    classifyYoutubeItem({ snippet: { liveBroadcastContent: 'none' }, liveStreamingDetails: { actualStartTime: 'x' } }) === 'ended_vod',
    'liveBroadcastContent=none + liveStreamingDetails -> ended_vod'
  );
  assert(
    classifyYoutubeItem({ snippet: { liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT0M40S' } }) === 'short',
    'duração 40s -> short'
  );
  assert(
    classifyYoutubeItem({ snippet: { liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT12M30S' } }) === 'video',
    'duração 12m30s -> video'
  );
  assert(
    classifyYoutubeItem({ snippet: { liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT1H0M0S' } }) === 'video',
    'duração 1h -> video (não é short)'
  );

  console.log('\n=== RESOLVE CHANNEL (parsing de handle/URL com fetch mockado) ===');
  const savedApiKey = config.youtube.apiKey;
  config.youtube.apiKey = 'test-api-key';

  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: true,
      json: async () => ({
        items: [{
          id: 'UC_resolved_channel_1234',
          snippet: { title: 'Canal Resolvido' },
          contentDetails: { relatedPlaylists: { uploads: 'UU_uploads_playlist_123' } },
        }],
      }),
    };
  };

  const cases = [
    ['@Minecraft', 'Minecraft'],
    ['minecraft', 'minecraft'],
    ['https://www.youtube.com/@Minecraft', 'Minecraft'],
    ['https://youtube.com/@Minecraft?si=abc123', 'Minecraft'],
    ['https://youtube.com/c/Minecraft', 'Minecraft'],
    ['https://youtube.com/user/Minecraft', 'Minecraft'],
  ];

  for (const [rawInput, expectedHandle] of cases) {
    const res = await resolveChannel(rawInput);
    const url = requestedUrls[requestedUrls.length - 1] || '';
    const forHandle = new URL(url).searchParams.get('forHandle');
    assert(
      res && res.channelId === 'UC_resolved_channel_1234' && forHandle === expectedHandle,
      `"${rawInput}" -> forHandle="${forHandle}" (esperado "${expectedHandle}")`
    );
  }

  // Comando de teste: URL com /channel/UC... (vai por fetchChannelById com o ID extraído)
  requestedUrls.length = 0;
  const raw = 'https://youtube.com/channel/UC1234567890123456789012';
  const resChannelId = await resolveChannel(raw);
  const lastUrl = requestedUrls[requestedUrls.length - 1] || '';
  assert(
    resChannelId && resChannelId.channelId === 'UC_resolved_channel_1234' && lastUrl.includes('id=UC1234567890123456789012'),
    `URL com /channel/UC... resolve via fetchChannelById (URL: ${lastUrl.slice(0, 100)})`
  );

  config.youtube.apiKey = savedApiKey;
  global.fetch = undefined;

  console.log(`\n=== RESULTADO: ${passed} ✅ / ${failed} ❌ ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('❌ Falha no teste:', err);
  process.exit(1);
});