// Avisos na hora certa, modo OBSERVAR (Fase 3, parte 3A). Sem rede, sem Discord.
// Execução: npm run test:avisos
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-avisos-'));
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
const root = path.resolve(import.meta.dirname, '..');
const R = await import('../src/core/avisos/regras.js');
const O = await import('../src/core/avisos/observar.js');
const { createAlerter } = await import('../src/core/alerts.js');
const { runDueReminders } = await import('../src/reminders/runner.js');
const { logger } = await import('../src/utils/logger.js');

let passed = 0;
const test = async (name, fn) => { O.reiniciarUsoDosAvisos(); await fn(); passed++; console.log(`  ✔ ${name}`); };
const FUSO = 'America/Cuiaba'; // UTC-4
const em = (iso) => Date.parse(`${iso}-04:00`);
const cfg = { silencio: R.lerSilencio('23-07'), teto: 8, fuso: FUSO };
const d = (classe, agora, extra = {}) => R.decidir({ classe, agora, ...extra }, cfg);

console.log('Tabela');
/** Todas as chaves pedidas no código: literais, famílias ('x:' + id) e crashAlertKey. Expressão nova e não literal falha. */
function chavesDoCodigo() {
  // Repassadores conhecidos (a chave vem de quem chamou, já varrido).
  const REPASSES = new Set(['core/alerts.js|key', 'cerebro/eventos.js|chave', 'core/ai/rotaPerfil.js|...a', 'integrations/google/auth.js|...a']);
  const chaves = new Set();
  const desconhecidas = [];
  const arquivos = fs.readdirSync(path.join(root, 'src'), { recursive: true }).map((x) => String(x).replaceAll('\\', '/')).filter((x) => x.endsWith('.js'));
  for (const f of arquivos) {
    const src = fs.readFileSync(path.join(root, 'src', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const chamadas = ['alertOwner\\(', 'alertOwnerConfirmado\\(', 'alertar\\(', 'alert\\('];
    if (f === 'core/healthReport.js') chamadas.push('send\\(');
    if (f === 'cerebro/eventos.js') chamadas.push('pedir\\(saida,');
    for (const chamada of chamadas) {
      const re = new RegExp(`(?<![\\w$])(?<!function )${chamada}\\s*([^,)]*(?:\\([^)]*\\))?)`, 'g');
      for (const m of src.matchAll(re)) {
        const arg = m[1].trim();
        const literal = /^'([^']+)'(\s*\+.*)?$/.exec(arg) ?? /^`([^`$]+)(?:\$\{.*)?`?$/.exec(arg);
        if (literal) chaves.add(literal[1]);
        else if (arg.startsWith('crashAlertKey(')) chaves.add('crash:');
        else if (arg && !REPASSES.has(`${f}|${arg}`)) desconhecidas.push(`${f}: ${arg}`);
      }
    }
  }
  return { chaves: [...chaves], desconhecidas };
}
await test('toda chave de alerta do código tem classe na tabela', () => {
  const { chaves, desconhecidas } = chavesDoCodigo();
  assert.deepEqual(desconhecidas, [], 'chave não literal: classifique-a e ensine o teste');
  const semClasse = chaves.filter((c) => !Object.hasOwn(R.TABELA, c) && !Object.hasOwn(R.PREFIXOS, c));
  assert.deepEqual(semClasse, [], 'ponha a chave em src/core/avisos/regras.js');
  for (const c of ['boot', 'ai-down', 'crash:', 'provider:', 'lock-key', 'health-daily', 'evento:supervisor', 'google-reautorizar', 'weekly-publish']) assert.ok(chaves.includes(c), `o leitor não achou ${c}`);
  const outrosPontos = ['lembrete', 'matinal', 'monitor:novidade', 'monitor:fim'];
  assert.deepEqual(Object.keys(R.TABELA).filter((c) => !chaves.includes(c) && !outrosPontos.includes(c)), [], 'linha da tabela sem uso');
});
await test('classe por chave; desconhecida é crítica e não vai para o log', () => {
  assert.equal(R.classeDaChave('crash:senha 123'), 'critico');
  assert.equal(R.classeDaChave('provider:abc'), 'importante');
  assert.equal(R.classeDaChave('evento:novo'), 'critico');
  assert.equal(R.classeDaChave('constructor'), 'critico');
  assert.equal(R.rotuloDaChave('crash:senha 123'), 'crash');
  assert.equal(R.rotuloDaChave('segredo-x:abc'), 'desconhecida');
});

console.log('decidir');
await test('silêncio cruzando a meia-noite, no fuso do dono, e a virada do dia', () => {
  for (const [hora, ate] of [['2026-11-26T23:00:00', '2026-11-27T07:00:00'], ['2026-12-31T23:59:00', '2027-01-01T07:00:00'], ['2026-11-27T00:00:00', '2026-11-27T07:00:00'], ['2026-11-27T06:59:00', '2026-11-27T07:00:00']]) {
    const r = d('importante', em(hora));
    assert.equal(r.acao, 'adiar', hora);
    assert.equal(r.ate.getTime(), em(ate), hora);
  }
  assert.equal(d('informativo', em('2026-11-26T22:59:00')).acao, 'enviar');
  assert.equal(d('informativo', em('2026-11-27T07:00:00')).acao, 'enviar');
  assert.equal(d('resumo', em('2026-11-27T05:00:00')).acao, 'adiar');
});
await test('silêncio no mesmo dia, desligado e inválido', () => {
  const s = R.lerSilencio('13-14');
  assert.equal(R.emSilencio(em('2026-11-26T13:30:00'), s, FUSO), true);
  assert.equal(R.emSilencio(em('2026-11-26T14:00:00'), s, FUSO), false);
  assert.equal(R.lerSilencio('7-7'), null);
  assert.deepEqual(R.lerSilencio('25-99'), { inicio: 23, fim: 7 });
  assert.equal(R.lerTeto('abc'), 8);
  assert.equal(R.lerTeto('0'), 0);
});
await test('crítico, hora marcada e terceiro furam o silêncio e o teto', () => {
  const noite = em('2026-11-27T03:00:00');
  const cheio = { usoDoDia: { total: 99 } };
  assert.equal(d('critico', noite, cheio).acao, 'enviar');
  assert.equal(d('hora-marcada', noite, cheio).acao, 'enviar');
  assert.equal(d('informativo', noite, { ...cheio, destinatario: 'terceiro' }).acao, 'enviar');
});
await test('teto: informativo adia; importante sai uma vez por assunto; resumo não conta', () => {
  const dia = em('2026-11-26T12:00:00');
  const usoDoDia = { total: 8, assuntosAcimaDoTeto: new Set(['ai-down']) };
  assert.equal(d('informativo', dia, { usoDoDia }).motivo, 'teto');
  assert.equal(d('informativo', dia, { usoDoDia }).ate.getTime(), em('2026-11-27T07:00:00'));
  assert.equal(d('importante', dia, { usoDoDia, assunto: 'evento:disco' }).acao, 'enviar');
  assert.equal(d('importante', dia, { usoDoDia, assunto: 'ai-down' }).acao, 'descartar');
  assert.equal(d('resumo', dia, { usoDoDia }).acao, 'enviar');
});

console.log('Observação');
const linhas = [];
const log = { info: (t) => linhas.push(t) };
const env = { YUI_AVISOS_FILTRO: 'observar', YUI_FUSO: FUSO, YUI_AVISOS_POR_DIA: '1' };
await test('desligado (padrão e valor desconhecido) não decide nem registra', () => {
  linhas.length = 0;
  for (const e of [{}, { YUI_AVISOS_FILTRO: 'off' }, { YUI_AVISOS_FILTRO: 'ligado' }]) assert.equal(O.observarAviso({ chave: 'boot', env: e, log }), null);
  assert.deepEqual(linhas, []);
});
await test('conta o uso do dia e zera na virada; a linha não leva a chave inteira', () => {
  linhas.length = 0;
  const obs = (chave, hora) => O.observarAviso({ chave, env, log, agora: em(hora) });
  assert.equal(obs('boot', '2026-11-26T10:00:00').acao, 'enviar');
  assert.equal(obs('youtube', '2026-11-26T11:00:00').acao, 'adiar');
  assert.equal(obs('provider:segredo', '2026-11-26T12:00:00').acao, 'enviar');
  assert.equal(obs('provider:segredo', '2026-11-26T13:00:00').acao, 'descartar');
  assert.equal(obs('youtube', '2026-11-27T10:00:00').acao, 'enviar');
  assert.equal(linhas.length, 5);
  assert.equal(linhas[2], '[Avisos] observar: chave=provider classe=importante decisao=enviar motivo=importante-acima-do-teto');
  assert.ok(!linhas.join('\n').includes('segredo'));
});
await test('adiado pelo silêncio conta no teto do dia em que sairia', () => {
  const obs = (chave, hora) => O.observarAviso({ chave, env, log, agora: em(hora) });
  for (const noite of ['2026-11-26T03:00:00', '2026-11-25T23:30:00']) { // mesmo dia e virando a meia-noite
    O.reiniciarUsoDosAvisos();
    assert.equal(obs('boot', noite).motivo, 'silencio');
    assert.equal(obs('youtube', '2026-11-26T10:00:00').motivo, 'teto', noite);
    assert.equal(obs('youtube', '2026-11-27T10:00:00').motivo, 'dentro-do-teto', noite);
  }
});
await test('falha na observação nunca lança', () => {
  assert.equal(O.observarAviso({ chave: 'boot', env, log: { info: () => { throw new Error('x'); } } }), null);
  assert.equal(O.observarAviso({ chave: 'boot', env, agora: NaN, log }), null);
});

console.log('Ganchos');
await test('alerter e lembretes: envia tudo igual (off, observar e log quebrado); a linha não leva conteúdo', async () => {
  const original = logger.info;
  const antes = process.env.YUI_AVISOS_FILTRO;
  try {
    for (const [modo, quebrado] of [['off', false], ['observar', false], ['observar', true]]) {
      linhas.length = 0;
      logger.info = quebrado ? () => { throw new Error('log quebrado'); } : (t) => linhas.push(t);
      process.env.YUI_AVISOS_FILTRO = modo;
      const enviados = [];
      const alerter = createAlerter({ ownerId: '111111111111111111', env: { YUI_AVISOS_FILTRO: modo, YUI_AVISOS_POR_DIA: '0' }, notify: async (_id, t) => { enviados.push(t); } });
      assert.equal(await alerter.alert('youtube', 'TITULO', 'DETALHE'), true);
      const itens = [{ id: 1, text: 'REMEDIO', at: new Date(0).toISOString(), userId: '222222222222222222' }];
      const store = { due: () => itens, complete: () => {}, recordFailure: () => assert.fail('não falhou') };
      assert.deepEqual(await runDueReminders({ store, send: async (t) => { enviados.push(t); return true; } }), { fired: 1, failed: 0 });
      assert.equal(enviados.length, 2);
      const avisos = linhas.filter((l) => l.startsWith('[Avisos]'));
      assert.equal(avisos.length, modo === 'observar' && !quebrado ? 2 : 0);
      assert.doesNotMatch(avisos.join('\n'), /TITULO|DETALHE|REMEDIO|1111|2222/);
      if (avisos.length) assert.match(avisos[1], /chave=lembrete classe=hora-marcada decisao=enviar motivo=terceiro/);
    }
  } finally {
    logger.info = original;
    if (antes === undefined) delete process.env.YUI_AVISOS_FILTRO; else process.env.YUI_AVISOS_FILTRO = antes;
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
