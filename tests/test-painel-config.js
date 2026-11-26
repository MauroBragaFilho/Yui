// O COFRE DE CONFIGURAÇÃO DO PAINEL (src/core/painelConfig.js e as rotas /v1/admin/config): chaves de API e ajustes que o dono muda pelo painel em vez do .env.
//  A. a LISTA FECHADA: nada de token do Discord, senha do painel, dono, política de segurança, rota privada, Gmail, caminhos ou comandos;
//  B. a validação por tipo (segredo, ligado/desligado, inteiro com limites, opção, texto, fuso) e que o erro NUNCA repete o valor;
//  C. gravar, ler e aplicar: o valor do painel vence o do .env, remover devolve o original, escrita atômica com cópia de segurança, chave fora do catálogo ignorada, edição travável;
//  D. a descrição para a tela: o segredo NUNCA sai (só "definido" e os 4 últimos caracteres do que veio do painel);
//  E. a API: só o dono, o guarda de rotas, a auditoria só com o NOME do ajuste, e nenhum segredo em nenhuma resposta, log ou auditoria.
// SEM rede, SEM bancos reais (pasta temporária). Execução: npm run test:painelconfig   (node tests/test-painel-config.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-config-'));
const ARQ = path.join(tmp, 'secrets', 'painel-config.json');
Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: '111', YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', LOG_LEVEL: 'error',
  YUI_PAINEL_CONFIG_FILE: ARQ, YUI_POLICY_MODE: 'observe',
});
delete process.env.YUI_PAINEL_CONFIG_EDIT;
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });

const cfg = await import('../src/core/painelConfig.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');

// Importar o servidor carrega o .env do PC (a configuração lê dotenv ao ser importada): o teste parte de um ambiente SEM nenhum ajuste do catálogo, para não depender da máquina.
const cfgPrimeiro = cfg.CATALOGO.map((c) => c.chave);
for (const k of cfgPrimeiro) delete process.env[k];

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (err) { failures.push(name); console.log(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 6).join('\n        ')}`); }
};
const section = (t) => console.log(`\n${t}`);
const item = (chave) => cfg.CATALOGO.find((c) => c.chave === chave);
const SEGREDO = 'AZURESEGREDO-0123456789-abcdef';
const limpar = () => { cfg.esquecerParaTeste(); fs.rmSync(path.join(tmp, 'secrets'), { recursive: true, force: true }); };

section('A. A lista fechada');
await test('o catálogo não tem nada que o painel nunca deve mudar', () => {
  const proibidos = [/^DISCORD_/, /^YUI_PANEL_/, /^YUI_OWNER/, /^YUI_TRUSTED/, /POLICY/, /READ_ONLY/, /PRIVATE_SEARCH/, /PRIVADA/, /GMAIL/, /CEREBRO_EXTERNO/, /_FILE$/, /_PATH$/, /_DIR$/, /MEMORY/, /RETENTION/, /TOOLS_PC/, /^YUI_API_TOKENS/, /ED25519|PRIVATE_KEY|IDENTIDADE/i, /COMMAND/i, /^PATH$/, /^NODE_/];
  for (const c of cfg.CATALOGO) for (const re of proibidos) assert.ok(!re.test(c.chave), `${c.chave} não pode estar no painel (${re})`);
  assert.ok(cfg.CATALOGO.length >= 15);
  assert.equal(new Set(cfg.CATALOGO.map((c) => c.chave)).size, cfg.CATALOGO.length, 'sem chave repetida');
});
await test('todo item tem rótulo, grupo, tipo válido e se precisa de reinício; segredo é marcado; o catálogo é congelado', () => {
  for (const c of cfg.CATALOGO) {
    assert.ok(c.rotulo && c.grupo && c.descricao, c.chave);
    assert.ok(['segredo', 'bool', 'int', 'enum', 'texto'].includes(c.tipo), c.chave);
    assert.equal(typeof c.reinicio, 'boolean', c.chave);
    assert.equal(Boolean(c.secreto), c.tipo === 'segredo', c.chave);
    if (c.tipo === 'int') assert.ok(Number.isInteger(c.min) && Number.isInteger(c.max), c.chave);
    if (c.tipo === 'enum') assert.ok(c.opcoes.length >= 2, c.chave);
  }
  assert.ok(Object.isFrozen(cfg.CATALOGO));
  assert.ok(cfg.CATALOGO.filter((c) => c.secreto).length >= 4);
});

await test('os ajustes liberados em 26/11 estão no catálogo; o que ficou de fora de propósito continua de fora; privacidade com aviso', () => {
  for (const c of ['YUI_VOZ_UNIFICADA', 'YUI_VOZ_GOOGLE', 'YUI_VOZ_PRAZO_S', 'YUI_HISTORICO_COMPARTILHADO', 'YUI_CONTEXT_ENABLED', 'YUI_MONITORES', 'YUI_ALERTS', 'YUI_ALERTAS_EVENTOS', 'YUI_MORNING_REPORT', 'YUI_CLIMA', 'YUI_PESQUISA_POR_INTENCAO', 'YUI_TTS_ENABLED', 'YUI_DL_MAX_CONCURRENT']) assert.ok(item(c), c);
  for (const c of ['YUI_VOZ_TOOLS', 'YUI_VOICE_TOOLS', 'YUI_CONTEXT_SCOPE', 'YUI_TTS_OMNIROUTE_SENSIVEL', 'YUI_TTS_PROVIDERS', 'YUI_PRIVATE_SEARCH', 'YUI_GOOGLE_SEM_ROTA_PRIVADA']) assert.ok(!item(c), c);
  for (const c of ['YUI_VOZ_UNIFICADA', 'YUI_VOZ_GOOGLE']) assert.match(item(c).descricao, /PRIVACIDADE/, c);
  assert.equal(item('YUI_HISTORICO_COMPARTILHADO').reinicio, false);
});
await test('o padrão de cada item passa na própria validação; os tetos de mídia não aceitam 0 (sem limite); alvo e nomes de voz com formato', () => {
  for (const c of cfg.CATALOGO) if (c.padrao) assert.equal(cfg.validarValor(c, c.padrao), c.padrao, c.chave);
  for (const c of ['YUI_DL_MAX_MINUTES', 'YUI_DL_MAX_FILESIZE_MB', 'YUI_DL_MAX_CONCURRENT', 'YUI_IMAGE_PER_HOUR']) assert.throws(() => cfg.validarValor(item(c), 0), cfg.PainelConfigError, c);
  const alvo = item('YUI_ALERTA_INTERNET_ALVO');
  for (const bom of ['1.1.1.1', 'exemplo.com:443', '']) assert.equal(cfg.validarValor(alvo, bom), bom);
  for (const ruim of ['http://exemplo.com', 'exemplo.com:70000', 'exemplo.com:0', 'a b', '-x']) assert.throws(() => cfg.validarValor(alvo, ruim), cfg.PainelConfigError, ruim);
  assert.throws(() => cfg.validarValor(item('YUI_TTS_EDGE_VOICE'), '"/><voz'), cfg.PainelConfigError);
  assert.throws(() => cfg.validarValor(item('YUI_PESQUISA_POR_INTENCAO'), 'tudo'), cfg.PainelConfigError);
});

section('B. A validação');
await test('segredo: de 10 a 512 caracteres visíveis, sem espaço e sem vírgula; o erro nunca repete o valor', () => {
  const k = item('AZURE_SPEECH_KEY');
  assert.equal(cfg.validarValor(k, SEGREDO), SEGREDO);
  for (const ruim of ['curta', 'com espaco no meio 12345', 'duas,chaves,juntas-123', 'x'.repeat(513), 'acento-çãõ-123456789']) {
    try { cfg.validarValor(k, ruim); assert.fail('devia recusar'); } catch (e) {
      assert.ok(e instanceof cfg.PainelConfigError && e.status === 400, ruim);
      assert.ok(!e.message.includes(ruim), 'a mensagem de erro não repete o valor');
    }
  }
});
await test('ligado/desligado, inteiro com limites, opção, texto e fuso', () => {
  assert.equal(cfg.validarValor(item('YUI_IA_REFAZER_RECUSA'), true), 'true');
  assert.equal(cfg.validarValor(item('YUI_IA_REFAZER_RECUSA'), ' FALSE '), 'false');
  assert.throws(() => cfg.validarValor(item('YUI_IA_REFAZER_RECUSA'), 'talvez'), /ligado ou desligado/);
  const i = item('YUI_TTS_ESPERA_429_S');
  assert.equal(cfg.validarValor(i, 60), '60');
  assert.equal(cfg.validarValor(i, '0'), '0');
  for (const ruim of [-1, 601, '60.5', 'abc', '1e3', '']) assert.throws(() => cfg.validarValor(i, ruim), cfg.PainelConfigError, String(ruim));
  assert.equal(cfg.validarValor(item('REDDIT_FETCH_MODE'), 'off'), 'off');
  assert.throws(() => cfg.validarValor(item('REDDIT_FETCH_MODE'), 'sempre'), /escolha uma destas opções/);
  assert.equal(cfg.validarValor(item('YUI_FUSO'), 'America/Cuiaba'), 'America/Cuiaba');
  assert.throws(() => cfg.validarValor(item('YUI_FUSO'), 'Marte/Olympus'), /inválido/);
  assert.throws(() => cfg.validarValor(item('YUI_CLIMA_CIDADE_PADRAO'), 'Cuiaba\nYUI_OWNER_ID=999'), /quebra de linha/);
  assert.throws(() => cfg.validarValor(item('AZURE_SPEECH_REGION'), 'Brazil South!'), /formato inválido/);
  assert.throws(() => cfg.validarValor(item('YUI_TTS_OMNIROUTE_ESTILO'), 'x'.repeat(201)), /no máximo/);
  assert.throws(() => cfg.validarValor(item('YUI_FUSO'), null), /informe um valor/);
});

section('C. Gravar, ler e aplicar');
await test('o valor do painel VENCE o do .env; remover devolve o original (e apaga a variável se não existia)', () => {
  limpar();
  const env = { YUI_TTS_ESPERA_429_S: '30' };
  cfg.definir('YUI_TTS_ESPERA_429_S', '90', env);
  assert.equal(env.YUI_TTS_ESPERA_429_S, '90');
  cfg.definir('YUI_IA_REFAZER_RECUSA', 'true', env);
  assert.equal(env.YUI_IA_REFAZER_RECUSA, 'true');
  cfg.remover('YUI_TTS_ESPERA_429_S', env);
  assert.equal(env.YUI_TTS_ESPERA_429_S, '30', 'volta ao valor do .env');
  cfg.remover('YUI_IA_REFAZER_RECUSA', env);
  assert.ok(!('YUI_IA_REFAZER_RECUSA' in env), 'a variável que não existia some');
});
await test('"aplicar" na subida: lê o arquivo salvo e põe no ambiente; idempotente; um arquivo estranho não derruba nada', () => {
  limpar();
  fs.mkdirSync(path.dirname(ARQ), { recursive: true });
  fs.writeFileSync(ARQ, JSON.stringify({ version: 1, valores: { YUI_FUSO: 'America/Cuiaba', DISCORD_TOKEN: 'roubado-0123456789', YUI_OWNER_ID: '999', YUI_TTS_ESPERA_429_S: 60 } }));
  const env = {};
  assert.equal(cfg.aplicarPainelConfig(env), 1, 'só o que está no catálogo e é texto');
  assert.equal(env.YUI_FUSO, 'America/Cuiaba');
  assert.ok(!('DISCORD_TOKEN' in env) && !('YUI_OWNER_ID' in env), 'chave fora do catálogo é ignorada mesmo escrita à mão no arquivo');
  assert.equal(cfg.aplicarPainelConfig(env), 1);
  fs.writeFileSync(ARQ, '{isto não é json');
  assert.equal(cfg.aplicarPainelConfig({}), 0, 'arquivo quebrado: nada aplicado, nada lançado');
  assert.deepEqual(cfg.carregar().valores, {});
});
await test('escrita atômica: sem temporário sobrando, a cópia de segurança do arquivo anterior e o conteúdo certo', () => {
  limpar();
  const env = {};
  cfg.definir('YUI_FUSO', 'America/Cuiaba', env);
  assert.deepEqual(JSON.parse(fs.readFileSync(ARQ, 'utf8')).valores, { YUI_FUSO: 'America/Cuiaba' });
  assert.ok(!fs.existsSync(`${ARQ}.bak`), 'primeira gravação: ainda não há anterior');
  cfg.definir('YUI_CLIMA_CIDADE_PADRAO', 'Cuiaba-MT', env);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${ARQ}.bak`, 'utf8')).valores, { YUI_FUSO: 'America/Cuiaba' }, 'a cópia guarda o estado de antes');
  assert.deepEqual(fs.readdirSync(path.dirname(ARQ)).sort(), ['painel-config.json', 'painel-config.json.bak'], 'nenhum .tmp sobrando');
  if (process.platform !== 'win32') assert.equal(fs.statSync(ARQ).mode & 0o777, 0o600);
});
await test('chave fora do catálogo = 404; remover o que não está salvo = 404; edição desligada = 403 (nada é gravado)', () => {
  limpar();
  assert.throws(() => cfg.definir('DISCORD_TOKEN', 'qualquer-coisa-0123456789', {}), (e) => e.status === 404);
  assert.throws(() => cfg.definir('YUI_OWNER_ID', '999', {}), (e) => e.status === 404);
  assert.throws(() => cfg.remover('YUI_FUSO', {}), (e) => e.status === 404);
  assert.throws(() => cfg.definir('YUI_FUSO', 'America/Cuiaba', { YUI_PAINEL_CONFIG_EDIT: 'false' }), (e) => e.status === 403);
  assert.throws(() => cfg.remover('YUI_FUSO', { YUI_PAINEL_CONFIG_EDIT: 'false' }), (e) => e.status === 403);
  assert.ok(!fs.existsSync(ARQ), 'nada foi gravado');
  assert.equal(cfg.edicaoLigada({}), true);
  for (const v of ['false', 'FALSE', ' false ']) assert.equal(cfg.edicaoLigada({ YUI_PAINEL_CONFIG_EDIT: v }), false);
});

section('C2. Proteção em repouso, falha segura e datas (parecer da Liz)');
// Um protetor FALSO e reversível (só para provar o fluxo; a DPAPI de verdade só roda no Windows e fora do CI).
const falso = { rotulo: 'falso-teste', proteger: (s) => 'PROT:' + Buffer.from(s, 'utf8').toString('base64'), abrir: (s) => { if (!s.startsWith('PROT:')) throw new Error('não abre'); return Buffer.from(s.slice(5), 'base64').toString('utf8'); } };
await test('com YUI_PAINEL_CONFIG_DPAPI=true o arquivo e o .bak NÃO têm o segredo em texto; o cofre continua legível por quem pode abrir', () => {
  limpar();
  cfg.usarProtetorParaTeste(falso);
  try {
    const env = { YUI_PAINEL_CONFIG_DPAPI: 'true' };
    cfg.definir('AZURE_SPEECH_KEY', SEGREDO, env);
    cfg.definir('YUI_FUSO', 'America/Cuiaba', env);
    const bruto = fs.readFileSync(ARQ, 'utf8');
    assert.ok(!bruto.includes(SEGREDO) && !bruto.includes('America/Cuiaba'), 'nada em texto puro no arquivo');
    assert.equal(JSON.parse(bruto).version, 2);
    assert.equal(JSON.parse(bruto).protecao, 'falso-teste');
    assert.ok(!fs.readFileSync(`${ARQ}.bak`, 'utf8').includes(SEGREDO), 'o .bak também não tem o segredo em texto');
    assert.equal(cfg.carregar().valores.AZURE_SPEECH_KEY, SEGREDO, 'quem abre, lê');
    assert.equal(cfg.descrever(env).protegido, true);
    // Desligar a proteção depois: continua lendo o arquivo protegido e a próxima gravação volta ao formato simples
    cfg.definir('YUI_CLIMA_CIDADE_PADRAO', 'Cuiaba-MT', { YUI_PAINEL_CONFIG_DPAPI: 'false' });
    assert.equal(JSON.parse(fs.readFileSync(ARQ, 'utf8')).version, 1);
    assert.equal(cfg.carregar().valores.AZURE_SPEECH_KEY, SEGREDO, 'nada se perdeu na troca de formato');
  } finally { cfg.usarProtetorParaTeste(null); }
});
await test('falha na proteção: nada é gravado (nem o arquivo, nem o .bak) e a variável não muda', () => {
  limpar();
  cfg.usarProtetorParaTeste({ rotulo: 'quebrado', proteger: () => { throw new Error('DPAPI indisponível'); }, abrir: () => '{}' });
  try {
    const env = { YUI_PAINEL_CONFIG_DPAPI: 'true' };
    assert.throws(() => cfg.definir('YUI_FUSO', 'America/Cuiaba', env), /DPAPI indisponível/);
    assert.ok(!fs.existsSync(ARQ), 'nada gravado');
    assert.ok(!('YUI_FUSO' in env), 'nada aplicado');
  } finally { cfg.usarProtetorParaTeste(null); }
});
await test('cofre que existe e NÃO abre (quebrado ou protegido por outra conta): a edição é recusada com 409, o arquivo fica intacto e nada é aplicado', () => {
  limpar();
  fs.mkdirSync(path.dirname(ARQ), { recursive: true });
  for (const conteudo of ['{isto não é json', JSON.stringify({ version: 2, protecao: 'dpapi-currentuser', dados: 'DADOS-DE-OUTRA-CONTA' })]) {
    fs.writeFileSync(ARQ, conteudo);
    cfg.usarProtetorParaTeste({ rotulo: 'x', proteger: (s) => s, abrir: () => { throw new Error('outra conta'); } });
    try {
      assert.throws(() => cfg.definir('YUI_FUSO', 'America/Cuiaba', {}), (e) => e.status === 409 && /não abriu/.test(e.message) && !e.message.includes('DADOS-DE-OUTRA-CONTA'));
      assert.throws(() => cfg.remover('YUI_FUSO', {}), (e) => e.status === 409);
      assert.equal(fs.readFileSync(ARQ, 'utf8'), conteudo, 'o arquivo ficou intacto, byte a byte');
      const env = {};
      assert.equal(cfg.aplicarPainelConfig(env), 0);
      assert.deepEqual(env, {}, 'nada aplicado de um cofre que não abriu');
      assert.equal(cfg.descrever({}).problema, 'cofre-ilegivel', 'a tela mostra o problema');
    } finally { cfg.usarProtetorParaTeste(null); }
  }
});
await test('a data da última alteração é guardada por ajuste e aparece na descrição; sai junto quando o ajuste é removido', () => {
  limpar();
  const env = {};
  const antes = Date.now();
  cfg.definir('YUI_FUSO', 'America/Cuiaba', env);
  const item1 = cfg.descrever(env).itens.find((i) => i.chave === 'YUI_FUSO');
  assert.ok(Date.parse(item1.alteradoEm) >= antes - 1000 && Date.parse(item1.alteradoEm) <= Date.now() + 1000);
  assert.equal(cfg.descrever(env).itens.find((i) => i.chave === 'REDDIT_FETCH_MODE').alteradoEm, null, 'o que não é do painel não tem data');
  cfg.remover('YUI_FUSO', env);
  assert.equal(cfg.descrever(env).itens.find((i) => i.chave === 'YUI_FUSO').alteradoEm, null);
});
await test('valor VAZIO não é remoção: grava texto vazio de verdade (o item segue "do painel") e só remover devolve o .env', () => {
  limpar();
  const env = { YUI_CLIMA_CIDADE_PADRAO: 'Cidade-do-env' };
  cfg.definir('YUI_CLIMA_CIDADE_PADRAO', '', env);
  assert.equal(env.YUI_CLIMA_CIDADE_PADRAO, '');
  const it = cfg.descrever(env).itens.find((i) => i.chave === 'YUI_CLIMA_CIDADE_PADRAO');
  assert.equal(it.origem, 'painel');
  assert.equal(cfg.carregar().valores.YUI_CLIMA_CIDADE_PADRAO, '');
  cfg.remover('YUI_CLIMA_CIDADE_PADRAO', env);
  assert.equal(env.YUI_CLIMA_CIDADE_PADRAO, 'Cidade-do-env');
});

section('D. A descrição para a tela');
await test('o segredo NUNCA sai: só "definido" e os 4 últimos caracteres do que veio do painel; do .env só "definido"', () => {
  limpar();
  const env = { YOUTUBE_API_KEY: 'CHAVE-DO-ENV-0123456789-zzzz' };
  cfg.definir('AZURE_SPEECH_KEY', SEGREDO, env);
  const d = cfg.descrever(env);
  const texto = JSON.stringify(d);
  assert.ok(!texto.includes(SEGREDO) && !texto.includes('CHAVE-DO-ENV'), 'nenhum segredo na resposta');
  const az = d.itens.find((i) => i.chave === 'AZURE_SPEECH_KEY');
  assert.deepEqual([az.definido, az.origem, az.ultimos4, az.secreto, 'valor' in az], [true, 'painel', SEGREDO.slice(-4), true, false]);
  const yt = d.itens.find((i) => i.chave === 'YOUTUBE_API_KEY');
  assert.deepEqual([yt.definido, yt.origem, yt.ultimos4], [true, 'env', null]);
  const br = d.itens.find((i) => i.chave === 'BRAVE_API_KEY');
  assert.deepEqual([br.definido, br.origem], [false, 'padrao']);
});
await test('ajuste comum mostra o valor em vigor e a origem (painel, .env ou padrão), o padrão e se precisa de reinício', () => {
  limpar();
  const env = { REDDIT_FETCH_MODE: 'cookies' };
  const antes = cfg.descrever(env).itens.find((i) => i.chave === 'REDDIT_FETCH_MODE');
  assert.deepEqual([antes.valor, antes.origem, antes.padrao, antes.reinicio], ['cookies', 'env', 'browser', false]);
  cfg.definir('REDDIT_FETCH_MODE', 'off', env);
  const depois = cfg.descrever(env).itens.find((i) => i.chave === 'REDDIT_FETCH_MODE');
  assert.deepEqual([depois.valor, depois.origem], ['off', 'painel']);
  assert.deepEqual(depois.opcoes, ['browser', 'cookies', 'off']);
  const vivo = cfg.descrever(env).itens.find((i) => i.chave === 'YUI_IA_REFAZER_RECUSA');
  assert.deepEqual([vivo.definido, vivo.origem, vivo.reinicio], [false, 'padrao', false]);
  assert.equal(cfg.descrever(env).itens.find((i) => i.chave === 'AZURE_SPEECH_KEY').reinicio, true, 'o que o bot lê pede reinício');
});

section('D2. A subida dos processos');
await test('o módulo de boot aplica o painel por cima do .env, e entra ANTES de a configuração ser lida nas duas entradas (index.js e cerebro.js)', async () => {
  limpar();
  fs.mkdirSync(path.dirname(ARQ), { recursive: true });
  fs.writeFileSync(ARQ, JSON.stringify({ version: 1, valores: { YUI_CLIMA_CIDADE_PADRAO: 'Cidade-do-Painel', REDDIT_FETCH_MODE: 'off', DISCORD_TOKEN: 'nao-deve-entrar-0123456789' } }));
  process.env.YUI_CLIMA_CIDADE_PADRAO = 'Cidade-do-env';
  process.env.REDDIT_FETCH_MODE = 'browser';
  const tokenAntes = process.env.DISCORD_TOKEN;
  try {
    await import('../src/core/painelConfigBoot.js'); // o efeito colateral roda ao importar
    assert.equal(process.env.YUI_CLIMA_CIDADE_PADRAO, 'Cidade-do-Painel', 'o painel vence o ambiente');
    assert.equal(process.env.REDDIT_FETCH_MODE, 'off');
    assert.equal(process.env.DISCORD_TOKEN, tokenAntes, 'chave fora do catálogo não entra');
  } finally { for (const k of cfgPrimeiro) delete process.env[k]; /* o boot também leu o .env do PC (dotenv): volta ao ambiente limpo */ cfg.esquecerParaTeste(); }
  // a ordem dos imports (a configuração lê o ambiente ao ser importada): o boot do painel vem ANTES dela nas duas entradas
  for (const arq of ['src/index.js', 'src/cerebro.js']) {
    const fonte = fs.readFileSync(path.resolve(import.meta.dirname, '..', arq), 'utf8');
    const boot = fonte.indexOf("import './core/painelConfigBoot.js'");
    const configuracao = fonte.indexOf("import { config } from './config/index.js'");
    assert.ok(boot > 0 && configuracao > 0 && boot < configuracao, `${arq}: o boot do painel precisa vir antes da configuração`);
  }
});

section('E. A API');
const OWNER = 'owner-token-0123456789';
const MEMBER = 'member-token-0123456789';
const server = createApiServer({ tokens: parseTokens(`${OWNER}=111,${MEMBER}=222`) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, rota, { token, body } = {}) {
  const res = await fetch(base + rota, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const texto = await res.text();
  let json = null; try { json = JSON.parse(texto); } catch { /* */ }
  return { status: res.status, json, texto };
}
const auditoria = () => (fs.existsSync(process.env.YUI_AUDIT_FILE) ? fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8') : '');
try {
  await test('só o dono lê, grava e remove; sem token = 401, membro = 403', async () => {
    limpar();
    assert.equal((await call('GET', '/v1/admin/config')).status, 401);
    assert.equal((await call('GET', '/v1/admin/config', { token: MEMBER })).status, 403);
    assert.equal((await call('PUT', '/v1/admin/config/YUI_FUSO', { token: MEMBER, body: { valor: 'America/Cuiaba' } })).status, 403);
    assert.equal((await call('DELETE', '/v1/admin/config/YUI_FUSO', { token: MEMBER })).status, 403);
    assert.ok(!fs.existsSync(ARQ), 'o membro não gravou nada');
    const lista = await call('GET', '/v1/admin/config', { token: OWNER });
    assert.equal(lista.status, 200);
    assert.ok(lista.json.itens.length >= 15 && lista.json.edicaoLigada === true);
  });
  await test('o dono grava um segredo e um ajuste; a resposta e a auditoria nunca levam o valor; remover volta ao padrão', async () => {
    limpar();
    const put = await call('PUT', '/v1/admin/config/AZURE_SPEECH_KEY', { token: OWNER, body: { valor: SEGREDO } });
    assert.equal(put.status, 200);
    assert.deepEqual([put.json.ok, put.json.chave, put.json.reinicio], [true, 'AZURE_SPEECH_KEY', true], 'a voz roda no bot: pede reinício');
    assert.ok(!put.texto.includes(SEGREDO), 'a resposta do PUT não devolve o segredo');
    const lista = await call('GET', '/v1/admin/config', { token: OWNER });
    assert.ok(!lista.texto.includes(SEGREDO), 'a listagem não devolve o segredo');
    assert.equal(lista.json.itens.find((i) => i.chave === 'AZURE_SPEECH_KEY').ultimos4, SEGREDO.slice(-4));
    assert.equal((await call('PUT', '/v1/admin/config/YUI_FUSO', { token: OWNER, body: { valor: 'America/Cuiaba' } })).json.reinicio, true);
    assert.ok(auditoria().includes('admin.config.set') && auditoria().includes('AZURE_SPEECH_KEY'), 'a auditoria leva o NOME do ajuste');
    assert.ok(!auditoria().includes(SEGREDO) && !auditoria().includes('America/Cuiaba'), 'a auditoria nunca leva o valor');
    const del = await call('DELETE', '/v1/admin/config/AZURE_SPEECH_KEY', { token: OWNER });
    assert.equal(del.status, 200);
    assert.equal((await call('GET', '/v1/admin/config', { token: OWNER })).json.itens.find((i) => i.chave === 'AZURE_SPEECH_KEY').definido, false);
    assert.ok(auditoria().includes('admin.config.remove'));
  });
  await test('erros claros e sem vazar: valor inválido = 400, chave fora do catálogo = 404, remover o que não existe = 404', async () => {
    limpar();
    const ruim = await call('PUT', '/v1/admin/config/AZURE_SPEECH_KEY', { token: OWNER, body: { valor: 'curta' } });
    assert.equal(ruim.status, 400);
    assert.ok(!ruim.texto.includes('curta'.repeat(2)) && /10 a 512/.test(ruim.texto));
    assert.equal((await call('PUT', '/v1/admin/config/YUI_TTS_ESPERA_429_S', { token: OWNER, body: { valor: 9999 } })).status, 400);
    assert.equal((await call('PUT', '/v1/admin/config/DISCORD_TOKEN', { token: OWNER, body: { valor: 'abcdefghij-0123456789' } })).status, 404);
    assert.equal((await call('PUT', '/v1/admin/config/YUI_OWNER_ID', { token: OWNER, body: { valor: '999' } })).status, 404);
    assert.equal((await call('DELETE', '/v1/admin/config/YUI_FUSO', { token: OWNER })).status, 404);
    assert.equal((await call('PUT', '/v1/admin/config/YUI_FUSO', { token: OWNER, body: {} })).status, 400, 'sem valor');
    assert.ok(!fs.existsSync(ARQ));
  });
  await test('ajuste que afrouxa privacidade ou segurança exige confirm: true para gravar e para remover', async () => {
    const perigosos = [['YUI_VOZ_UNIFICADA', 'true', 'false'], ['YUI_VOZ_GOOGLE', 'true', 'false'], ['YUI_CONTEXT_ENABLED', 'true', 'false'], ['YUI_HISTORICO_COMPARTILHADO', 'true', 'false'], ['YUI_ALERTS', 'false', 'true']];
    const lista = (await call('GET', '/v1/admin/config', { token: OWNER })).json.itens;
    for (const [chave, perigoso, seguro] of perigosos) {
      assert.deepEqual(lista.find((i) => i.chave === chave).confirmar, [perigoso], chave);
      const rota = `/v1/admin/config/${chave}`;
      for (const body of [{ valor: perigoso }, { valor: perigoso === 'true' }, { valor: ` ${perigoso.toUpperCase()} ` }, { valor: perigoso, confirm: 'true' }]) {
        assert.equal((await call('PUT', rota, { token: OWNER, body })).status, 400, `${chave} ${JSON.stringify(body)}`);
      }
      assert.equal((await call('PUT', rota, { token: OWNER, body: { valor: seguro } })).status, 200, `${chave}: o lado seguro não pergunta`);
      assert.equal((await call('PUT', rota, { token: OWNER, body: { valor: perigoso, confirm: true } })).status, 200, chave);
      assert.equal((await call('DELETE', rota, { token: OWNER })).status, 400, `${chave}: remover sem confirm`);
      assert.equal((await call('DELETE', rota, { token: OWNER, body: { confirm: true } })).status, 200, chave);
    }
  });

  await test('YUI_PAINEL_CONFIG_EDIT=false trava a edição pela API (a leitura continua)', async () => {
    limpar();
    process.env.YUI_PAINEL_CONFIG_EDIT = 'false';
    try {
      assert.equal((await call('PUT', '/v1/admin/config/YUI_FUSO', { token: OWNER, body: { valor: 'America/Cuiaba' } })).status, 403);
      assert.equal((await call('GET', '/v1/admin/config', { token: OWNER })).json.edicaoLigada, false);
      assert.ok(!fs.existsSync(ARQ));
    } finally { delete process.env.YUI_PAINEL_CONFIG_EDIT; }
  });
} finally {
  await new Promise((r) => server.close(r));
}

console.log(`\n${passed} testes OK${failures.length ? `; ${failures.length} FALHARAM: ${failures.join(' | ')}` : ''}`);
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* */ }
process.exit(failures.length ? 1 : 0);
