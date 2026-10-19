// Sobe a Yui API para DESENVOLVER/TESTAR os apps, sem o bot do Discord.
//
//   npm run dev:api                  IA real (cadeia atual), banco temporário
//   npm run dev:api -- --fake        IA simulada + ferramentas de demonstração
//   opções: --port 3939 --host 127.0.0.1 --cors http://localhost:8081 --as owner|member --real-db
//           --dev-write  libera gravar/rodar comandos no módulo de código simulado (sempre com aprovação)
//           --panel   liga o login por usuário/senha (descartáveis) e um painel de administração SIMULADO
//
// Por padrão usa um BANCO TEMPORÁRIO e o papel "member", então nada do seu
// dado pessoal é tocado. O token impresso é descartável (vale só nesta execução).
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const withPanel = flag('panel');
const asOwner = withPanel || opt('as', 'member') === 'owner';
if (!flag('real-db')) process.env.DATABASE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dev-api-'));
// Chaves de IA adicionadas pelo painel de teste ficam num arquivo descartável (nunca no secrets/ real).
process.env.YUI_AI_SETTINGS_FILE = path.join(process.env.DATABASE_DIR || os.tmpdir(), 'dev-ai-providers.json');
// A auditoria de desenvolvimento também fica no diretório temporário (não suja o log real).
if (!flag('real-db')) process.env.YUI_AUDIT_FILE = path.join(process.env.DATABASE_DIR, 'audit.jsonl');
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.YUI_API_ENABLED = 'true';
process.env.YUI_API_HOST = opt('host', '127.0.0.1');
process.env.YUI_API_PORT = opt('port', '3939');
process.env.YUI_API_CORS_ORIGINS = opt('cors', 'http://localhost:8081,http://localhost:19006');

const userId = asOwner ? process.env.YUI_OWNER_ID || process.env.OWNER_ID || '111' : '222';
const panelPassword = process.env.DEV_PANEL_PASSWORD || crypto.randomBytes(9).toString('hex');
if (withPanel) {
  process.env.YUI_PANEL_USER = 'admin';
  process.env.YUI_PANEL_PASSWORD = panelPassword;
}
if (asOwner) process.env.YUI_OWNER_ID = userId;
const token = process.env.DEV_API_TOKEN || crypto.randomBytes(18).toString('hex');
process.env.YUI_API_TOKENS = `${token}=${userId}`;

const { initMemory } = await import('../src/core/index.js');
const ai = await import('../src/core/ai/manager.js');
const { registerTool } = await import('../src/core/agent/tools.js');
const { startApi } = await import('../src/core/api/server.js');

await initMemory();

if (flag('fake')) {
  registerTool({
    name: 'demo.ping', description: 'Responde pong (demonstração).', minRole: 'MEMBER', access: 'read', privateOnly: false,
    async run() { return 'pong 🏓'; },
  });
  registerTool({
    name: 'demo.limpar_cache', description: 'Ação sensível de demonstração.', minRole: 'MEMBER', access: 'open', privateOnly: false, confirm: true,
    async run() { return 'Cache limpo (simulação).'; },
  });
  ai.registerBackend({
    name: 'fake', local: false,
    async chat({ prompt }) {
      // O Agent manda o pedido do usuário depois de "MENSAGEM DO USUÁRIO:".
      const text = (prompt.split('MENSAGEM DO USUÁRIO:\n').pop() || prompt).toLowerCase();
      if (text.includes('ping')) return '{"tool":"demo.ping","args":{}}';
      if (text.includes('limpar') || text.includes('apaga')) return '{"tool":"demo.limpar_cache","args":{}}';
      if (text.includes('formata')) return '{"tool":"pc.formatar_disco","args":{}}';
      return JSON.stringify({ reply: `Oi! Você disse: “${text.trim().slice(0, 200)}”. (IA simulada)` });
    },
  }, { activate: true });
}

// Painel simulado: banimentos, servidores e Discord falsos (nada real é tocado).
let fakeAdmin;
if (withPanel) {
  const textChannels = [{ id: '111111111111111111', name: 'noticias' }, { id: '222222222222222222', name: 'diario-gta' }, { id: '333333333333333333', name: 'videos' }, { id: '444444444444444440', name: 'lives' }];
  const ref = (id) => ({ id, name: textChannels.find((c) => c.id === id)?.name ?? id });
  const radioDemo = { guildId: '444444444444444444', voiceChannelId: '333333333333333333', status: 'PLAYING', playlist: [{ title: 'Música de exemplo', artist: 'Artista' }, { title: 'Segunda faixa', artist: 'Outro artista' }], currentIndex: 0, shuffle: true, loopMode: 'OFF', voiceMode: 'DIRECT', streamMode: 'HYBRID' };
  radioDemo.currentTrack = radioDemo.playlist[0];
  radioDemo.queue = radioDemo.playlist.slice(1);
  const demo = {
    channels: { noticias: ref('111111111111111111'), diario: ref('222222222222222222'), semanal: null },
    youtube: [{ id: 'UCdemo0', name: 'Canal de Exemplo', role: null, channel: ref('333333333333333333'), videos: true, shorts: false, lives: true }],
    twitch: [{ id: 'streamer_exemplo', name: 'streamer_exemplo', role: null, channel: ref('444444444444444440') }],
  };
  const { createAdmin } = await import('../src/core/api/admin.js');
  const bans = { users: { '999999999999999999': { reason: 'exemplo', timestamp: new Date().toISOString() } }, guilds: {}, channels: {} };
  const modes = {};
  const guilds = new Map([
    ['444444444444444444', { id: '444444444444444444', name: 'Servidor de Teste', memberCount: 42, channels: { cache: new Map([['111111111111111111', { id: '111111111111111111', name: 'noticias', type: 0 }], ['222222222222222222', { id: '222222222222222222', name: 'diario-gta', type: 0 }], ['333333333333333333', { id: '333333333333333333', name: 'videos', type: 0 }], ['444444444444444440', { id: '444444444444444440', name: 'lives', type: 0 }]]) }, roles: { cache: new Map([['999999999999999999', { id: '999999999999999999', name: 'Avisos' }]]) } }],
    ['555555555555555555', { id: '555555555555555555', name: 'Outro Servidor', memberCount: 7 }],
  ]);
  fakeAdmin = createAdmin({
    client: { isReady: () => true, user: { tag: 'Yui#0000' }, guilds: { cache: guilds } },
    deps: {
      getBans: () => bans,
      addBan: (t, id, r) => { bans[`${t}s`][id] = { reason: r, timestamp: new Date().toISOString() }; },
      removeBan: (t, id) => { delete bans[`${t}s`][id]; },
      setAutoBlock: (g, m) => { modes[g] = m; },
      getAutoBlockMode: (g) => modes[g] ?? 'both',
      isServerAccepted: (g) => g !== '555555555555555555',
      setGuildChannel: async (g, col, ch) => {
        const key = { news_channel_id: 'noticias', daily_channel_id: 'diario', weekly_channel_id: 'semanal' }[col];
        demo.channels[key] = ch ? { id: ch, name: textChannels.find((c) => c.id === ch)?.name ?? ch } : null;
      },
      addYoutube: async (x) => { demo.youtube.push({ id: 'UCdemo' + demo.youtube.length, name: x.input, role: x.roleId, channel: ref(x.discordChannelId), videos: x.videos, shorts: x.shorts, lives: x.lives }); return { added: true, channelId: 'UCdemo', name: x.input }; },
      removeYoutube: async (g, y) => { demo.youtube = demo.youtube.filter((s) => s.id !== y); return true; },
      addTwitch: async (x) => { demo.twitch.push({ id: x.login, name: x.login, role: x.roleId, channel: ref(x.discordChannelId) }); return { added: true, login: x.login, name: x.login }; },
      removeTwitch: async (g, l) => { demo.twitch = demo.twitch.filter((s) => s.id !== l); return true; },
      aiChat: async () => ({ x_gateway: { model: 'demo' } }),
      radio: {
        sessions: () => [radioDemo],
        getSession: (g) => (g === radioDemo.guildId ? radioDemo : null),
        connected: () => true,
        pause: async () => { radioDemo.status = 'PAUSED'; return true; },
        resume: async () => { radioDemo.status = 'PLAYING'; return true; },
        stopMusic: async () => { radioDemo.status = 'STOPPED'; radioDemo.currentTrack = null; },
        leave: async () => { radioDemo.status = 'STOPPED'; },
      },
      integrationData: async () => ({ youtubeSubs: demo.youtube.length, twitchSubs: demo.twitch.length, lastDaily: '2026-10-08', lastWeekly: '2026-10-06', gateway: { inChain: true } }),
      guildDetail: async (g) => ({
        id: g.id, name: g.name, members: g.memberCount,
        channels: { ...demo.channels, atualizacoes: null },
        respondToEveryone: true,
        textChannels,
        roles: [{ id: '999999999999999999', name: 'Avisos' }],
        youtube: demo.youtube,
        twitch: demo.twitch,
        tools: { enabled: ['join_voice_call', 'radio_voice_stt'], disabled: [] },
      }),
    },
    exit: () => console.log('(simulação) a Yui seria reiniciada agora'),
  });
}

// Chave por DM simulada: em vez de enviar para o Discord, imprime a mensagem aqui no terminal.
const fakeNotify = withPanel
  ? async (userId, text) => { console.log(`
[DM simulada para ${userId}]
${text}
`); }
  : undefined;

// Módulo de código simulado: um projeto de demonstração e uma "IA" que segue um roteiro simples.
// --dev-write libera gravação/comandos (como YUI_READ_ONLY=false), sempre com aprovação.
let fakeDev;
if (asOwner) {
  const { createDev } = await import('../src/core/dev/index.js');
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dev-demo-'));
  fs.mkdirSync(path.join(demoDir, 'src'));
  fs.writeFileSync(path.join(demoDir, 'src', 'soma.js'), 'function soma(a, b) {\n  return a + b;\n}\nmodule.exports = { soma };\n');
  fs.writeFileSync(path.join(demoDir, 'README.md'), '# Projeto de demonstração\nSomas e subtrações.\n');
  if (flag('dev-write')) process.env.YUI_READ_ONLY = 'false';
  const act = (action, params, thought = '') => JSON.stringify({ action, params, thought });
  const script = {
    async chat({ messages }) {
      const last = String(messages.at(-1).content);
      await new Promise((r) => setTimeout(r, 400));
      if (last.includes('[RESULTADO de write_file')) return { text: 'Pronto: criei o arquivo notas.txt.', provider: 'simulada', model: 'demo' };
      if (last.includes('[RESULTADO de read_file')) return { text: 'A função `soma` recebe dois números e devolve a soma deles.\n\n```js\nsoma(2, 3) // 5\n```', provider: 'simulada', model: 'demo' };
      if (last.includes('[RESULTADO')) return { text: 'Feito.', provider: 'simulada', model: 'demo' };
      if (/crie|grave|escreva/i.test(last)) return { text: act('write_file', { path: 'notas.txt', content: 'Anotações da Yui\n' }, 'criar o arquivo'), provider: 'simulada', model: 'demo' };
      if (/soma|explique|ler|leia/i.test(last)) return { text: act('read_file', { path: 'src/soma.js' }, 'ver o código'), provider: 'simulada', model: 'demo' };
      return { text: 'Oi! Eu sou a Yui. Pergunte sobre o projeto (ex.: "o que faz a soma?") ou peça uma mudança (ex.: "crie notas.txt"). (IA simulada)', provider: 'simulada', model: 'demo' };
    },
  };
  fakeDev = createDev({
    env: { ...process.env, YUI_DEV_ENABLED: 'true', YUI_PROJECTS: `Demonstração=${demoDir}`, YUI_DEV_PROJECTS_FILE: path.join(process.env.DATABASE_DIR || os.tmpdir(), 'dev-projects.json') },
    llm: script,
    historyDir: path.join(process.env.DATABASE_DIR || os.tmpdir(), 'dev-history'),
    indexDir: path.join(process.env.DATABASE_DIR || os.tmpdir(), 'dev-index'),
  });
}

const server = startApi(null, { ...(fakeAdmin ? { admin: fakeAdmin } : {}), ...(fakeNotify ? { notify: fakeNotify } : {}), ...(fakeDev ? { dev: fakeDev } : {}) });
if (!server) {
  console.error('A API não iniciou (verifique YUI_API_TOKENS).');
  process.exit(1);
}

console.log('\n──────── Yui API (desenvolvimento) ────────');
console.log(`URL:    http://${process.env.YUI_API_HOST}:${process.env.YUI_API_PORT}`);
console.log(`Token:  ${token}`);
if (withPanel) console.log(`Login:  usuário "admin"  senha "${panelPassword}"  (descartáveis; painel SIMULADO)`);
console.log(`Papel:  ${asOwner ? 'OWNER (memória pessoal)' : 'MEMBER (memória temporária)'}  |  IA: ${flag('fake') ? 'simulada' : 'real'}`);
console.log(`Banco:  ${process.env.DATABASE_DIR || './database (REAL)'}`);
console.log('CORS:  ', process.env.YUI_API_CORS_ORIGINS);
console.log('Ctrl+C para encerrar.\n');
