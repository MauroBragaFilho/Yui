// Ajustes do painel que valem SEM reiniciar: o cérebro avisa o bot (sem valores) e o bot relê o cofre. Dublês, sem rede, cofre temporário.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-recarga-'));
const ARQ = path.join(DIR, 'painel-config.json');
process.env.YUI_PAINEL_CONFIG_FILE = ARQ;
process.env.YUI_PAINEL_CONFIG_DPAPI = 'false';

const cfg = await import('../src/core/painelConfig.js');
const lists = await import('../src/handlers/listAssistant.js');
const { startBotChannel, applyPanelSettingsChange } = await import('../src/discord/canalCerebro.js');
const { createCerebroAdmin } = await import('../src/cerebro/painel.js');

let ok = 0;
let falhas = 0;
async function test(nome, fn) {
  fs.rmSync(ARQ, { force: true });
  cfg.esquecerParaTeste();
  cfg.usarProtetorParaTeste(null);
  try { await fn(); ok += 1; console.log(`  ok  ${nome}`); }
  catch (e) { falhas += 1; console.error(`  FALHOU  ${nome}\n${e.stack}`); }
}
const gravar = (valores) => fs.writeFileSync(ARQ, JSON.stringify({ version: 1, valores, alteradoEm: {} }));
const mudo = { info() {}, warn() {}, error() {}, debug() {} };

await test('a lista das chaves que valem na hora é fechada; privacidade de voz pede reinício', () => {
  const vivas = cfg.CATALOGO.filter((c) => !c.reinicio).map((c) => c.chave).sort();
  // item 2 das lacunas do painel (26/11/2026): + YUI_AUTOMOD_AI_BAN, YUI_LISTS_ENABLED, YUI_MEMORY_ENABLED, YUI_REMINDERS_ENABLED, YUI_RESEARCH_ENABLED e YUI_VISION (lidas a cada uso nos dois processos)
  // item 6 (26/11/2026): + a configuração da IA do painel do Discord (YUI_IA_*: lida a cada uso SÓ pelo bot) e os getters de src/config/index.js (YUI_AUTOMOD_PADRAO,
  // YUI_AUTOMOD_MODO_PADRAO, YUI_CANAL_APELACOES, YUI_SALVAR_HISTORICO, YUI_MUSICA_MANTER_CARTAO); os leitores são conferidos em tests/test-painel-ia-discord.js
  const IA = ['YUI_IA_CONTEXTO_DO_SERVIDOR', 'YUI_IA_GEMINI_MAX_TOKENS', 'YUI_IA_GEMINI_TEMPERATURA', 'YUI_IA_GEMINI_TIMEOUT_MS', 'YUI_IA_HF_MAX_TOKENS', 'YUI_IA_HF_TEMPERATURA', 'YUI_IA_HF_TIMEOUT_MS',
    'YUI_IA_HORDE_MAX_TOKENS', 'YUI_IA_HORDE_TEMPERATURA', 'YUI_IA_HORDE_TIMEOUT_MS', 'YUI_IA_LMSTUDIO_MAX_TOKENS', 'YUI_IA_LMSTUDIO_TEMPERATURA', 'YUI_IA_LMSTUDIO_TIMEOUT_MS', 'YUI_IA_MOSTRAR_MODELO',
    'YUI_IA_MOSTRAR_MODELO_PENSANDO', 'YUI_IA_POLLINATIONS_MAX_TOKENS', 'YUI_IA_POLLINATIONS_TIMEOUT_MS', 'YUI_IA_RETENTATIVAS'];
  assert.deepEqual(vivas, [...['REDDIT_FETCH_MODE', 'YUI_ALERTS', 'YUI_AUTOMOD_AI_BAN', 'YUI_AVISOS_FILTRO', 'YUI_AVISOS_POR_DIA', 'YUI_CLIMA', 'YUI_CLIMA_CIDADE_PADRAO', 'YUI_CONTEXT_MAX_CHARS', 'YUI_CONTEXT_MAX_TURNS',
    'YUI_CONTEXT_TTL_HOURS', 'YUI_CONTINUIDADE', 'YUI_DL_MAX_CONCURRENT', 'YUI_DL_MAX_FILESIZE_MB', 'YUI_DL_MAX_MINUTES', 'YUI_DL_TIMEOUT_SECONDS', 'YUI_GOOGLE', 'YUI_HISTORICO_COMPARTILHADO', 'YUI_HISTORICO_DIAS',
    // live dos amigos, etapa 1 (28/11/2026): YUI_LIVE_AMIGOS é lida a cada pedido pelo serviço (no cérebro ou no processo único); conferida em tests/test-live-amigos.js
    'YUI_IA_REFAZER_RECUSA', 'YUI_IMAGE_PER_HOUR', 'YUI_LISTS_ENABLED', 'YUI_LIVE_AMIGOS', 'YUI_MEMORY_ENABLED', 'YUI_MONITORES_RESERVA', 'YUI_PESQUISA_POR_INTENCAO', 'YUI_REMINDERS_ENABLED', 'YUI_RESEARCH_ENABLED',
    // entrega E (27/11/2026, item 3 v2): YUI_PLANOS_PAINEL é lida a cada pedido só pela API do painel (o bot nunca a lê); conferida em tests/test-painel-acoes.js
    'YUI_PLANOS_PAINEL',
    // entrega F (27/11/2026, item 11): YUI_APP_IMAGEM é lida a cada pedido só pela API (a pré-rota e a ferramenta de imagem do chat); conferida em tests/test-imagem-app.js
    'YUI_APP_IMAGEM',
    // entrega F parte 2 (27/11/2026, item 14): YUI_GOOGLE_REAUTORIZAR_PAINEL é lida a cada pedido só pela API (as rotas de reautorizar o Google); conferida em tests/test-painel-google.js
    'YUI_GOOGLE_REAUTORIZAR_PAINEL',
    // leitura do chat da live em fluxo (28/11/2026): YUI_YOUTUBE_LEITURA é lida a cada entrada na live, só pelo serviço da live (cérebro); conferida em tests/test-youtube-fluxo.js
    'YUI_SILENCIO', 'YUI_SKILLS', 'YUI_UPLOAD_LIMIT_MB', 'YUI_VISION', 'YUI_YOUTUBE_LEITURA', 'YUI_YT_LIVE_AUTO_EDIT_MIN'], ...IA,
    'YUI_AUTOMOD_MODO_PADRAO', 'YUI_AUTOMOD_PADRAO', 'YUI_CANAL_APELACOES', 'YUI_MUSICA_MANTER_CARTAO', 'YUI_SALVAR_HISTORICO'].sort());
  assert.ok(cfg.CATALOGO.filter((c) => c.chave.startsWith('YUI_VOZ_')).every((c) => c.reinicio));
  for (const chave of ['YUI_CONTEXT_TTL_HOURS', 'YUI_CONTEXT_MAX_CHARS', 'YUI_CONTEXT_MAX_TURNS']) assert.match(cfg.CATALOGO.find((c) => c.chave === chave).descricao, /apaga de vez/);
});

await test('o bot atualiza só as chaves ao vivo; remover devolve o original do .env', () => {
  const env = { YUI_CLIMA_CIDADE_PADRAO: 'do-env', YUI_FUSO: 'America/Cuiaba' };
  gravar({ YUI_CLIMA_CIDADE_PADRAO: 'na-subida' });
  cfg.aplicarPainelConfig(env);
  gravar({ YUI_CLIMA_CIDADE_PADRAO: 'nova', YUI_FUSO: 'UTC', YUI_VOZ_UNIFICADA: 'true', YUI_APP_COMANDOS: 'true', YUI_ALERTS: 'false' });
  assert.deepEqual(cfg.recarregarAoVivo(env).sort(), ['YUI_ALERTS', 'YUI_CLIMA_CIDADE_PADRAO']);
  assert.deepEqual(env, { YUI_CLIMA_CIDADE_PADRAO: 'nova', YUI_FUSO: 'America/Cuiaba', YUI_ALERTS: 'false' });
  gravar({});
  cfg.recarregarAoVivo(env);
  assert.deepEqual(env, { YUI_CLIMA_CIDADE_PADRAO: 'do-env', YUI_FUSO: 'America/Cuiaba' });
});

await test('chave que pede reinício, removida do painel, continua no bot até reiniciar', () => {
  const env = { YUI_FUSO: 'do-env' };
  gravar({ YUI_FUSO: 'UTC' });
  cfg.aplicarPainelConfig(env);
  gravar({});
  assert.deepEqual(cfg.recarregarAoVivo(env), []);
  assert.equal(env.YUI_FUSO, 'UTC');
});

await test('cofre ilegível: não mexe em nada', () => {
  const env = {};
  gravar({ YUI_CLIMA: 'false' });
  cfg.aplicarPainelConfig(env);
  fs.writeFileSync(ARQ, '{quebrado');
  assert.equal(cfg.recarregarAoVivo(env), null);
  assert.deepEqual(env, { YUI_CLIMA: 'false' });
  const avisos = [];
  assert.equal(applyPanelSettingsChange({ info() {}, warn: (m) => avisos.push(m) }, { env }), null);
  assert.equal(avisos.length, 1);
  assert.doesNotMatch(avisos[0], /false|quebrado/);
});

await test('com o cofre protegido, abre uma vez por mudança (reconexão sem mudança não abre)', () => {
  let aberturas = 0;
  cfg.usarProtetorParaTeste({ rotulo: 'falso', proteger: (s) => Buffer.from(s).toString('base64'), abrir: (s) => { aberturas += 1; return Buffer.from(s, 'base64').toString(); } });
  const dono = { YUI_PAINEL_CONFIG_DPAPI: 'true' };
  const bot = {};
  cfg.definir('YUI_CLIMA', 'false', dono);
  aberturas = 0;
  cfg.recarregarAoVivo(bot);
  cfg.recarregarAoVivo(bot);
  assert.equal(aberturas, 1);
  assert.equal(bot.YUI_CLIMA, 'false');
});

await test('cofre que não abre: o mesmo arquivo só é tentado de novo depois da espera', () => {
  let aberturas = 0;
  let quebrado = true;
  cfg.usarProtetorParaTeste({ rotulo: 'falso', proteger: (s) => s, abrir: (s) => { aberturas += 1; if (quebrado) throw new Error('dpapi'); return s; } });
  fs.writeFileSync(ARQ, JSON.stringify({ version: 2, dados: JSON.stringify({ valores: { YUI_CLIMA: 'false' } }) }));
  const env = {};
  let t = 1000;
  const agora = () => t;
  for (let i = 0; i < 3; i += 1) assert.equal(cfg.recarregarAoVivo(env, { agora }), null);
  assert.equal(aberturas, 1);
  quebrado = false;
  t += cfg.ESPERA_FALHA_MS;
  assert.deepEqual(cfg.recarregarAoVivo(env, { agora }), ['YUI_CLIMA']);
  assert.equal(aberturas, 2);
});

await test('cérebro dono das listas: o bot pede a ele mesmo com a chave antiga', async () => {
  const eventos = new Map();
  const pedidos = [];
  const canal = { handle() {}, on: (n, fn) => eventos.set(n, fn), onState() {}, request: async (m) => { pedidos.push(m); return { handled: true, text: 'do cérebro' }; } };
  startBotChannel({ getClient: () => null, logger: mudo, connect: () => canal, idemFile: null });
  eventos.get('listas.dono')({ cerebro: true });
  const r = await lists.routeLists({ text: 'mostra minhas listas', userId: '123456789' }, { env: { YUI_APP_COMANDOS: 'false' } });
  assert.equal(r.text, 'do cérebro');
  assert.deepEqual(pedidos, ['lists.route']);
  lists.setListsRemote(null);
});

await test('YUI_APP_COMANDOS não muda em execução (um só escritor de listas); a tela mostra o salvo', () => {
  const env = { YUI_APP_COMANDOS: 'false' };
  const r = cfg.definir('YUI_APP_COMANDOS', 'true', env);
  assert.equal(r.reinicio, true);
  assert.equal(env.YUI_APP_COMANDOS, 'false');
  assert.equal(cfg.descrever(env).itens.find((i) => i.chave === 'YUI_APP_COMANDOS').valor, 'true');
  cfg.aplicarPainelConfig(env); // a subida seguinte
  assert.equal(env.YUI_APP_COMANDOS, 'true');
  cfg.remover('YUI_APP_COMANDOS', env);
  assert.equal(env.YUI_APP_COMANDOS, 'true');
  assert.equal(cfg.descrever(env).itens.find((i) => i.chave === 'YUI_APP_COMANDOS').valor, 'false');
});

await test('o bot relê no aviso do cérebro e ao (re)conectar', () => {
  const eventos = new Map();
  let aoEstado = null;
  const canal = { handle() {}, on: (n, fn) => eventos.set(n, fn), onState: (fn) => { aoEstado = fn; }, request: async () => ({}) };
  delete process.env.YUI_CLIMA_CIDADE_PADRAO;
  startBotChannel({ getClient: () => null, logger: mudo, connect: () => canal, idemFile: null });
  gravar({ YUI_CLIMA_CIDADE_PADRAO: 'pelo-aviso' });
  eventos.get('painel.settingsChanged')({});
  assert.equal(process.env.YUI_CLIMA_CIDADE_PADRAO, 'pelo-aviso');
  gravar({ YUI_CLIMA_CIDADE_PADRAO: 'pela-reconexao' });
  aoEstado({ state: 'disconnected' });
  assert.equal(process.env.YUI_CLIMA_CIDADE_PADRAO, 'pelo-aviso');
  aoEstado({ state: 'open' });
  assert.equal(process.env.YUI_CLIMA_CIDADE_PADRAO, 'pela-reconexao');
  gravar({});
  eventos.get('painel.settingsChanged')({});
  assert.equal(process.env.YUI_CLIMA_CIDADE_PADRAO, undefined);
});

await test('o cérebro avisa sem valores depois de salvar e remover; botConectado diz a verdade; falha não avisa', async () => {
  const emitidos = [];
  let conectado = 1;
  const channel = { request: async () => ({}), isConnected: () => conectado > 0, emit: (...a) => { emitidos.push(a); return conectado; } };
  const base = {
    configSet: async (_c, chave) => ({ ok: true, chave, reinicio: chave === 'YUI_FUSO' }),
    configRemove: async () => { throw new Error('recusado'); },
  };
  const admin = createCerebroAdmin({ channel, base });
  assert.equal((await admin.configSet({}, 'YUI_CLIMA', 'valor-que-nao-vai')).botConectado, true);
  assert.deepEqual(emitidos, [['painel.settingsChanged', {}, { role: 'bot' }]]);
  conectado = 0;
  assert.equal((await admin.configSet({}, 'YUI_CLIMA', 'false')).botConectado, false);
  assert.equal('botConectado' in (await admin.configSet({}, 'YUI_FUSO', 'UTC')), false);
  const antes = emitidos.length;
  await assert.rejects(admin.configRemove({}, 'YUI_CLIMA'));
  assert.equal(emitidos.length, antes);
  conectado = 1;
  const outro = createCerebroAdmin({ channel, base: { configRemove: async () => ({ ok: true, chave: 'YUI_CLIMA', reinicio: false }) } });
  assert.equal((await outro.configRemove({}, 'YUI_CLIMA')).botConectado, true);
});

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\n${ok} ok, ${falhas} falha(s)`);
process.exit(falhas ? 1 : 0);
