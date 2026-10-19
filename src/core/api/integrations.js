import fs from 'fs';
import path from 'path';
import { activeProviders, providerConfigured } from '../../search/providers.js';
import { describeTtsReason } from '../../services/tts/index.js';

/**
 * Estado das integrações da Yui para o painel (SOMENTE LEITURA).
 *
 * Mostra o que está configurado e ligado, nunca o valor de chaves ou tokens: só
 * "configurada", a quantidade de chaves ou o que falta. A configuração em si
 * continua no .env.
 */

const csv = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const on = (v, def = false) => (v === undefined || v === '' ? def : String(v).toLowerCase() === 'true');

/** status: 'ok' (funcionando/ligada), 'off' (desligada de propósito), 'missing' (falta configurar). */
function item(key, name, status, detail = '') {
  return { key, name, status, detail };
}

function keys(env, ...names) {
  return [...new Set(names.flatMap((n) => csv(env[n])))].length;
}

/**
 * Item de um provedor de busca na web, com a MESMA regra de src/search/providers.js: chave com
 * menos de 10 caracteres (ex.: o texto-modelo "opcional") é ignorada, então não conta como configurada.
 */
function searchItem(env, key, name, what, { hasValue, optional }) {
  const raw = String(env[what] ?? '').trim();
  const idle = optional ? 'off' : 'missing';
  if (!providerConfigured(key, env)) {
    return item(key, name, idle, raw ? (key === 'searxng' ? `${what} precisa começar com http:// ou https://: ignorado` : `${what} curta demais ou texto-modelo: ignorada`) : optional ? 'sem configuração (opcional)' : 'sem chave: usa as outras fontes');
  }
  if (!activeProviders(env).includes(key)) return item(key, name, 'off', `${hasValue}, mas fora de YUI_SEARCH_PROVIDERS`);
  return item(key, name, 'ok', hasValue);
}

/**
 * Item de uma ferramenta Python opcional (hoje o deemix; o spotdl entra depois com este mesmo formato).
 * `state` é o resultado da checagem SEM rede de loadIntegrationData: { ok, code, message }; vazio = ainda não verificada.
 * 'ok' = instalada e importável; 'missing' = ausente ou com defeito (o motivo vai no detalhe); 'off' = sem verificação.
 */
function pythonToolItem(key, name, state, { missingByCode, missingDefault }) {
  if (!state || typeof state.ok !== 'boolean') return item(key, name, 'off', 'ainda não verificado');
  if (state.ok) return item(key, name, 'ok', String(state.message || 'instalado').slice(0, 120));
  return item(key, name, 'missing', missingByCode[state.code] || missingDefault);
}

/**
 * Item da voz falada (TTS). A fala é local (voz do Windows/SAPI), sem chave nem rede: o estado vem do serviço (getTtsStatus), não do .env.
 * 'ok' = ligado e com provedor; 'off' = desligado de propósito ou ainda não iniciado; 'missing' = precisa de atenção (sem Opus, sem provedor...).
 * Por servidor, quem decide é o interruptor "Resposta por Voz (TTS)" do /yui-ferramentas (desligado por padrão).
 */
function ttsItem(status) {
  const name = 'Voz: fala (TTS)';
  if (!status || typeof status !== 'object') return item('tts', name, 'off', 'ainda não verificado');
  if (!status.initialized || !status.enabled) {
    const reason = String(status.reason ?? '');
    const attention = ['no-opus', 'no-providers', 'init-error'].includes(reason);
    return item('tts', name, attention ? 'missing' : 'off', `desligada: ${describeTtsReason(reason)}`);
  }
  const providers = Array.isArray(status.engine?.providers) ? status.engine.providers : [];
  const usable = providers.filter((p) => p?.breaker?.state !== 'open' && p?.probe?.ok !== false);
  if (providers.length && !usable.length) return item('tts', name, 'missing', 'nenhum provedor de voz disponível no momento (em pausa ou indisponível)');
  const names = (usable.length ? usable : providers).map((p) => String(p?.name ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24)).filter(Boolean).join(', ') || 'local';
  return item('tts', name, 'ok', `voz local (${names}), sem chave; ligue por servidor em /yui-ferramentas`);
}

/** Lê o que está salvo nos bancos (contagens e últimas datas). Qualquer falha vira null. */
export async function loadIntegrationData() {
  const safe = async (fn) => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };
  return {
    // Checagem do deemix: `python download_deezer.py --check`, sem rede e sem login (resultado em cache por 10 min;
    // o boot já a aquece em validateMediaTools). O import dinâmico evita carregar o serviço do Deezer junto com este módulo.
    deemix: await safe(async () => (await import('../../services/deezerMusicService.js')).getDeemixStatus({ timeoutMs: 8000, log: false })),
    youtubeSubs: await safe(async () => (await import('../../database/repositories/youtubeRepo.js')).youtubeRepository.getAllSubscriptions().length),
    twitchSubs: await safe(async () => (await import('../../database/repositories/twitchRepo.js')).twitchRepository.getAllSubscriptions().length),
    // Voz falada (TTS): só contagens e nomes de provedor (getTtsStatus sem "detailed" nunca traz IDs nem texto).
    tts: await safe(async () => (await import('../../services/tts/index.js')).getTtsStatus()),
    lastDaily: await safe(async () => (await import('../../database/repositories/dailyRepo.js')).dailyRepository.getLatestDaily()?.reset_date ?? null),
    lastWeekly: await safe(async () => (await import('../../database/repositories/weeklyRepo.js')).weeklyRepository.getLatestWeekly()?.event_week ?? null),
    gateway: await safe(async () => {
      const { gatewayInChain } = await import('../../gateway/index.js');
      return { inChain: gatewayInChain() };
    }),
  };
}

export function buildIntegrations({ env = process.env, client = null, data = {}, readOnly = true, memoryEnabled = true, tools = 0 } = {}) {
  const count = (n) => (n === 1 ? '1 chave' : `${n} chaves`);
  const subs = (n, what) => (n === null || n === undefined ? what : `${n} ${what}`);

  const gem = keys(env, 'GEMINI_API_KEYS', 'GEMINI_API_KEY');
  const groq = keys(env, 'GROQ_API_KEY');
  const stab = keys(env, 'STABILITY_API_KEYS', 'STABILITY_API_KEY');
  const gwServer = on(env.YUI_GATEWAY_ENABLED) && csv(env.YUI_GATEWAY_KEYS).some((k) => k.length >= 16);
  const weeklyOn = on(env.GTA_WEEKLY_ENABLED, true);
  const newsOn = on(env.NEWSWIRE_ENABLED);
  const redditMode = (env.REDDIT_FETCH_MODE || 'browser').toLowerCase();
  const panelUser = Boolean(String(env.YUI_PANEL_USER || '').trim() && (env.YUI_PANEL_PASSWORD_HASH || env.YUI_PANEL_PASSWORD));
  const tokens = csv(env.YUI_API_TOKENS).length;

  const groups = [
    {
      title: 'Núcleo',
      items: [
        item('discord', 'Discord', client?.isReady?.() ? 'ok' : 'missing', client?.isReady?.() ? `${client.guilds?.cache?.size ?? 0} servidor(es)` : 'desconectado'),
        item('memory', 'Memória por usuário', memoryEnabled ? 'ok' : 'off', memoryEnabled ? `retenção de ${env.MEMORY_RETENTION_DAYS || 30} dias` : 'YUI_MEMORY_ENABLED=false'),
        item('readonly', 'Modo somente leitura', readOnly ? 'ok' : 'missing', readOnly ? 'ligado (seguro)' : 'DESLIGADO: ferramentas podem alterar o PC'),
        item('pctools', 'Ferramentas do PC', on(env.YUI_TOOLS_PC_ENABLED) ? 'ok' : 'off', on(env.YUI_TOOLS_PC_ENABLED) ? `${tools} ferramenta(s) registrada(s)` : 'desligadas'),
        item('login', 'Login por usuário e senha', panelUser ? 'ok' : 'off', panelUser ? 'configurado' : 'defina YUI_PANEL_USER e a senha (npm run panel:password)'),
        item('tokens', 'Tokens fixos da API', tokens ? 'ok' : 'off', tokens ? `${tokens} token(s)` : 'nenhum (opcional)'),
      ],
    },
    {
      title: 'Inteligência artificial',
      items: [
        item('lmstudio', 'LM Studio / modelo local', env.LOCAL_LLM_URL || env.AI_BASE_URL ? 'ok' : 'off', env.LOCAL_LLM_URL || env.AI_BASE_URL ? 'endereço configurado' : 'sem LOCAL_LLM_URL (usa o padrão localhost:1234)'),
        item('gateway', 'Yui Gateway (cadeia interna)', data.gateway?.inChain ? 'ok' : 'off', data.gateway?.inChain ? 'ativo após o LM Studio' : 'desativado ou sem provedores'),
        item('gateway-server', 'Yui Gateway (servidor OpenAI)', gwServer ? 'ok' : 'off', gwServer ? `${env.YUI_GATEWAY_HOST || '127.0.0.1'}:${env.YUI_GATEWAY_PORT || 20130}` : 'desligado'),
        item('gemini', 'Gemini', gem ? 'ok' : 'missing', gem ? count(gem) : 'sem chave'),
        item('groq', 'Groq', groq ? 'ok' : 'missing', groq ? count(groq) : 'sem chave'),
        item('hf', 'Hugging Face', env.HF_TOKEN ? 'ok' : 'missing', env.HF_TOKEN ? 'token configurado' : 'sem token'),
        item('cloudflare', 'Cloudflare Workers AI', env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID ? 'ok' : 'missing', env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID ? 'configurado' : 'falta token ou ID da conta'),
        item('together', 'Together AI', env.TOGETHER_API_KEY ? 'ok' : 'missing', env.TOGETHER_API_KEY ? 'chave configurada' : 'sem chave'),
        item('horde', 'AI Horde (texto)', 'ok', env.HORDE_API_KEY && env.HORDE_API_KEY !== '0000000000' ? 'com chave' : 'anônimo'),
      ],
    },
    {
      title: 'Imagem, busca e voz',
      items: [
        item('stability', 'Stability AI (imagens)', stab ? 'ok' : 'missing', stab ? count(stab) : 'sem chave'),
        item('pollinations', 'Pollinations (imagens)', 'ok', 'gratuito, sem chave'),
        searchItem(env, 'brave', 'Busca na web (Brave)', 'BRAVE_API_KEY', { hasValue: 'chave configurada', optional: false }),
        searchItem(env, 'tavily', 'Busca na web (Tavily)', 'TAVILY_API_KEY', { hasValue: 'chave configurada', optional: true }),
        searchItem(env, 'searxng', 'Busca na web (SearXNG)', 'SEARXNG_URL', { hasValue: 'servidor próprio configurado', optional: true }),
        item('rawg', 'RAWG (informações de jogos)', env.RAWG_API_KEY ? 'ok' : 'off', env.RAWG_API_KEY ? 'chave configurada' : 'sem chave: usa Steam e HowLongToBeat'),
        item('stt', 'Voz: transcrição (STT)', groq || gem || env.HF_TOKEN || env.OPENAI_STT_KEY || env.WITAI_TOKEN || env.WIT_AI_KEY ? 'ok' : 'missing', 'usa Groq, Gemini, Hugging Face ou outro provedor com chave'),
        ttsItem(data.tts),
        item('deezer', 'Música (Deezer)', env.DEEZER_ARL || env.DEEMIX_ARL ? 'ok' : 'missing', env.DEEZER_ARL || env.DEEMIX_ARL ? 'ARL configurado' : 'sem ARL: downloads em alta qualidade indisponíveis'),
        pythonToolItem('deemix', 'Música (Deemix)', data.deemix, {
          missingByCode: {
            DEEMIX_NOT_INSTALLED: 'não instalado (pip install -r requirements-deemix.txt e PYTHON_PATH): os downloads usam o YouTube como plano B',
            DEEZER_TIMEOUT: 'a verificação demorou demais: os downloads usam o YouTube se o Deezer falhar',
          },
          missingDefault: 'não foi possível verificar: os downloads usam o YouTube se o Deezer falhar',
        }),
      ],
    },
    {
      title: 'GTA Online',
      items: [
        item('gta-daily', 'Reset diário (06:00 UTC)', 'ok', data.lastDaily ? `último: ${data.lastDaily}` : 'ainda sem registro'),
        item('gta-weekly', 'Evento semanal (Reddit)', weeklyOn ? 'ok' : 'off', weeklyOn ? `a cada ${env.GTA_WEEKLY_INTERVAL_MINUTES || 30} min, via ${redditMode === 'cookies' ? 'cookies' : 'navegador'}${data.lastWeekly ? `, último: ${data.lastWeekly}` : ''}` : 'GTA_WEEKLY_ENABLED=false'),
        item('newswire', 'Rockstar Newswire', newsOn ? 'ok' : 'off', newsOn ? `a cada ${env.NEWSWIRE_INTERVAL_MINUTES || 30} min` : 'desligado (use /gta-noticias sob demanda)'),
      ],
    },
    {
      title: 'Avisos sociais',
      items: [
        item('youtube', 'YouTube', env.YOUTUBE_API_KEY ? 'ok' : 'missing', env.YOUTUBE_API_KEY ? `${subs(data.youtubeSubs, 'inscrições')}, a cada ${env.YOUTUBE_INTERVAL_MINUTES || 5} min` : 'sem YOUTUBE_API_KEY'),
        item('twitch', 'Twitch', env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET ? 'ok' : 'missing', env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET ? `${subs(data.twitchSubs, 'inscrições')}, a cada ${env.TWITCH_INTERVAL_MINUTES || 2} min` : 'sem Client ID/Secret'),
      ],
    },
  ];

  return { groups };
}

/** Detalhes de um servidor: canais configurados, avisos de YouTube/Twitch e ferramentas liberadas. */
export async function loadGuildDetail(guild, { dataDir = path.join(process.cwd(), 'src', 'data') } = {}) {
  const safe = async (fn, fallback) => {
    try {
      return (await fn()) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const chanName = (id) => (id ? guild?.channels?.cache?.get?.(id)?.name ?? null : null);
  const link = (id) => (id ? { id, name: chanName(id) } : null);
  const id = guild.id;

  const row = await safe(async () => (await import('../../database/repositories/guildRepo.js')).guildRepository.get(id), null);
  const yt = await safe(async () => (await import('../../database/repositories/youtubeRepo.js')).youtubeRepository.getSubscriptionsByGuild(id), []);
  const tw = await safe(async () => (await import('../../database/repositories/twitchRepo.js')).twitchRepository.getSubscriptionsByGuild(id), []);
  const settings = await safe(() => JSON.parse(fs.readFileSync(path.join(dataDir, 'server_settings.json'), 'utf8'))[id], {});
  const tools = await safe(() => JSON.parse(fs.readFileSync(path.join(dataDir, 'server_tools.json'), 'utf8'))[id], null);

  return {
    id,
    name: guild.name,
    members: guild.memberCount ?? null,
    channels: {
      noticias: link(row?.news_channel_id),
      diario: link(row?.daily_channel_id),
      semanal: link(row?.weekly_channel_id),
      atualizacoes: link(settings?.updateChannelId),
    },
    respondToEveryone: settings?.respondToEveryone ?? null,
    textChannels: [...(guild.channels?.cache?.values?.() ?? [])]
      .filter((c) => c.type === 0 || c.type === 5)
      .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
      .slice(0, 200)
      .map((c) => ({ id: c.id, name: c.name })),
    roles: [...(guild.roles?.cache?.values?.() ?? [])]
      .filter((r) => !r.managed && r.name !== '@everyone')
      .slice(0, 200)
      .map((r) => ({ id: r.id, name: r.name })),
    youtube: yt.map((s) => ({
      id: s.youtube_channel_id,
      name: s.channel_name || s.youtube_channel_id,
      role: s.mention_role_id || null,
      channel: link(s.discord_channel_id),
      videos: Boolean(s.notify_videos),
      shorts: Boolean(s.notify_shorts),
      lives: Boolean(s.notify_lives),
    })),
    twitch: tw.map((s) => ({ id: s.twitch_login, name: s.twitch_login, role: s.mention_role_id || null, channel: link(s.discord_channel_id) })),
    tools: tools ? { enabled: tools.enabled ?? [], disabled: tools.disabled ?? [] } : null,
  };
}
