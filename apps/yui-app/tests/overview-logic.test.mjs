// Testes da lógica da Visão Geral do painel (sem React e sem rede). Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import { RECONEXOES_ATENCAO, RESPOSTAS_PARA_GRAFICO, alertasDoDiagnostico, buildAlerts, chartBars, describeEvent, formatUptime, greetingFor, groupEvents, corDoMedidor, levelForFree, medidorDeUso, percent, relativeTime, resumoDaVoz, resumoDasRespostas, systemSummary } from '../src/overviewLogic.ts';
import { TABS, tabVisible } from '../src/tabs.ts';

test('saudação por horário', () => {
  assert.equal(greetingFor(5), 'Bom dia');
  assert.equal(greetingFor(11), 'Bom dia');
  assert.equal(greetingFor(12), 'Boa tarde');
  assert.equal(greetingFor(17), 'Boa tarde');
  assert.equal(greetingFor(18), 'Boa noite');
  assert.equal(greetingFor(0), 'Boa noite');
  assert.equal(greetingFor(4), 'Boa noite');
  assert.equal(greetingFor(Number.NaN), 'Olá');
});

test('tempo ligada', () => {
  assert.equal(formatUptime(90), '1min');
  assert.equal(formatUptime(5400), '1h 30min');
  assert.equal(formatUptime(93784), '1d 2h');
  assert.equal(formatUptime(null), '—');
  assert.equal(formatUptime(-1), '—');
  assert.equal(formatUptime(undefined), '—');
});

test('percentual e nível de RAM/disco livres', () => {
  assert.equal(percent(1024, 4096), 25);
  assert.equal(percent(0, 4096), 0);
  assert.equal(percent(5000, 4096), 100);
  assert.equal(percent(null, 4096), null);
  assert.equal(percent(10, 0), null);
  assert.equal(levelForFree(25), 'ok');
  assert.equal(levelForFree(15), 'ok');
  assert.equal(levelForFree(14), 'warn');
  assert.equal(levelForFree(8), 'warn');
  assert.equal(levelForFree(7), 'danger');
  assert.equal(levelForFree(null), 'unknown');
});

test('"há quanto tempo"', () => {
  const now = Date.parse('2026-11-10T20:00:00Z');
  assert.equal(relativeTime('2026-11-10T19:59:30Z', now), 'agora');
  assert.equal(relativeTime('2026-11-10T19:55:00Z', now), 'há 5 min');
  assert.equal(relativeTime('2026-11-10T17:00:00Z', now), 'há 3 h');
  assert.equal(relativeTime('2026-11-08T20:00:00Z', now), 'há 2 d');
  assert.equal(relativeTime('2026-11-10T21:00:00Z', now), 'agora', 'relógio adiantado não vira número negativo');
  assert.equal(relativeTime('lixo', now), '—');
  assert.equal(relativeTime(null, now), '—');
});

test('eventos da auditoria em texto simples', () => {
  assert.equal(describeEvent('api.chat').label, 'Conversa pelo app');
  assert.equal(describeEvent('agent.tool.denied').tone, 'bad');
  assert.equal(describeEvent('auth.login.fail').tone, 'bad');
  assert.equal(describeEvent('admin.follow.youtube.liveMode').label, 'Modo das lives alterado');
  assert.equal(describeEvent('admin.algo.novo').label, 'Ajuste feito no painel', 'prefixo conhecido');
  assert.equal(describeEvent('dev.run.start').label, 'Módulo de código');
  assert.equal(describeEvent('evento.desconhecido').label, 'evento.desconhecido', 'sem tradução: mostra o próprio nome');
  assert.equal(describeEvent('').label, 'Evento');
});

test('frase de estado diz a verdade', () => {
  const ok = systemSummary({ discordOnline: true, aiOk: true, hostLevel: 'ok' });
  assert.equal(ok.ok, true);
  assert.match(ok.text, /funcionando normalmente/);
  assert.equal(systemSummary({ discordOnline: true, aiOk: null, hostLevel: 'unknown' }).ok, true, 'sem leitura da IA não afirma problema');
  assert.match(systemSummary({ discordOnline: true, aiOk: true, hostLevel: 'warn' }).text, /apertado/);
  const bad = systemSummary({ discordOnline: false, aiOk: false, hostLevel: 'danger' });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /Discord está desconectado, nenhum provedor de IA está disponível e o computador/);
  assert.match(systemSummary({ discordOnline: false, aiOk: true, hostLevel: 'ok' }).text, /^Preciso de atenção: o Discord está desconectado\.$/);
  // Com aviso no cartão de alertas, a frase do topo não diz "todos operacionais".
  assert.equal(systemSummary({ discordOnline: true, aiOk: true, hostLevel: 'ok', avisos: 1 }).text, 'Estou funcionando, mas há 1 aviso nos alertas abaixo.');
  assert.match(systemSummary({ discordOnline: true, aiOk: true, hostLevel: 'ok', avisos: 3 }).text, /há 3 avisos/);
  assert.doesNotMatch(systemSummary({ discordOnline: true, aiOk: true, hostLevel: 'ok', avisos: 2 }).text, /Todos os sistemas/);
});

test('abas: Visão Geral e Admin só para o dono; a aba Código foi removida', () => {
  assert.equal(TABS[0].key, 'home');
  assert.equal(tabVisible('home', {}), false);
  assert.equal(tabVisible('home', { showAdmin: true }), true);
  assert.equal(tabVisible('admin', { showAdmin: false }), false);
  assert.equal(TABS.some((t) => t.key === 'code'), false, 'a aba Código não existe mais');
  assert.equal(tabVisible('chat', {}), true);
  assert.equal(tabVisible('memory', {}), true);
  assert.equal(tabVisible('status', {}), true);
});

test('eventos iguais seguidos viram uma linha com contagem, sem perder a hora do mais recente', () => {
  const g = groupEvents([
    { ts: '2026-11-10T20:00:00Z', event: 'dev.tool' },
    { ts: '2026-11-10T19:59:00Z', event: 'dev.run.start' },
    { ts: '2026-11-10T19:58:00Z', event: 'dev.tool' },
    { ts: '2026-11-10T19:50:00Z', event: 'auth.login.ok' },
    { ts: '2026-11-10T19:40:00Z', event: 'dev.tool' },
  ]);
  assert.deepEqual(g.map((x) => [x.label, x.count]), [['Módulo de código', 3], ['Login no painel', 1], ['Módulo de código', 1]]);
  assert.equal(g[0].ts, '2026-11-10T20:00:00Z');
  assert.deepEqual(groupEvents([]), []);
});

test('leitura da saúde do computador: converte as unidades e nunca lança', async () => {
  const root = new URL('../../../src/core/api/admin.js', import.meta.url);
  const { readHostStats } = await import(root.href);
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  const osFake = { platform: () => 'win32', totalmem: () => 4096 * MB, freemem: () => 1024 * MB };
  const fsFake = { statfsSync: () => ({ blocks: 100 * (GB / 4096), bavail: 25 * (GB / 4096), bsize: 4096 }) };
  assert.deepEqual(readHostStats({ osImpl: osFake, fsImpl: fsFake }), { platform: 'win32', ramTotalMB: 4096, ramFreeMB: 1024, diskTotalGB: 100, diskFreeGB: 25 });
  const broken = { platform: () => 'linux', totalmem: () => { throw new Error('x'); }, freemem: () => { throw new Error('x'); } };
  const noDisk = { statfsSync: () => { throw new Error('sem permissão'); } };
  assert.deepEqual(readHostStats({ osImpl: broken, fsImpl: noDisk }), { platform: 'linux', ramTotalMB: null, ramFreeMB: null, diskTotalGB: null, diskFreeGB: null });
});

test('gráfico de 24 h: altura proporcional, vazio sem inventar barra', () => {
  const s = [{ hour: '2026-11-11T10:00:00.000Z', count: 0 }, { hour: '2026-11-11T11:00:00.000Z', count: 2 }, { hour: '2026-11-11T12:00:00.000Z', count: 10 }, { hour: '2026-11-11T13:00:00.000Z', count: 1 }];
  const bars = chartBars(s);
  assert.deepEqual(bars.map((b) => b.heightPercent), [0, 20, 100, 10]);
  assert.equal(chartBars([{ hour: 'x', count: 1 }, { hour: 'y', count: 100 }])[0].heightPercent, 6); // mínimo visível
  assert.deepEqual(chartBars([{ hour: '2026-11-11T10:00:00.000Z', count: 0 }]).map((b) => b.heightPercent), [0]);
  assert.deepEqual(chartBars(null), []);
  assert.equal(chartBars([{ hour: 'lixo', count: 3 }])[0].label, '');
});

test('alertas só com o que foi medido', () => {
  assert.deepEqual(buildAlerts({ discordOnline: true, aiOk: true, hostLevel: 'ok', problems: { loginFail: 0, toolError: 0, toolDenied: 0, alertFail: 0 } }), []);
  assert.deepEqual(buildAlerts({ discordOnline: true, aiOk: null, hostLevel: 'unknown' }), []); // sem leitura da IA não afirma nada
  const a = buildAlerts({ discordOnline: false, aiOk: false, hostLevel: 'warn', problems: { loginFail: 1, toolError: 2, toolDenied: 0, alertFail: 1 } });
  assert.equal(a.length, 6);
  assert.equal(a[0].level, 'danger');
  assert.match(a.map((x) => x.text).join('|'), /1 tentativa de login recusada/);
  assert.match(a.map((x) => x.text).join('|'), /2 ferramentas com erro/);
  assert.equal(a.find((x) => /apertado/.test(x.text)).level, 'warn');
});

test('Início usa os mesmos motivos do Status: banco com nome, sem repetir Discord e IA, problema em vermelho, reconexões a partir de 5', () => {
  assert.equal(RECONEXOES_ATENCAO, 5);
  assert.deepEqual(alertasDoDiagnostico(null), []);
  const a = alertasDoDiagnostico({
    motivos: [
      { codigo: 'banco-com-alerta', texto: 'Algum banco de dados tem alerta.' },
      { codigo: 'discord-fora', texto: 'O Discord está desconectado.' },
      { codigo: 'sem-provedor-de-ia', texto: 'Nenhum provedor de IA está disponível agora.' },
      { codigo: 'trava-perdida', texto: 'Uma trava de dono foi perdida.' },
      { codigo: 'trava-perdida', texto: 'repetido' },
      { codigo: 'erros-no-log', texto: 'Muitos erros\u0007 no log.' },
    ],
    bancosComAlerta: ['memory-discord'],
    reconexoesDoDiscord24h: 10,
  });
  assert.deepEqual(a.map((x) => x.text), [
    'Banco de dados com alerta: memory-discord.',
    'Uma trava de dono foi perdida.',
    'Muitos erros no log.',
    '10 reconexões do Discord nas últimas 24 h (a rede da máquina da Yui pode estar instável).',
  ]);
  assert.deepEqual(a.map((x) => x.level), ['warn', 'danger', 'warn', 'warn']);
  assert.deepEqual(alertasDoDiagnostico({ motivos: [], reconexoesDoDiscord24h: 4 }), [], 'abaixo de 5 reconexões não avisa');
  // buildAlerts junta os do diagnóstico depois dos medidos direto, e o badge deixa de dizer "Tudo certo".
  const b = buildAlerts({ discordOnline: true, aiOk: true, hostLevel: 'ok', diagnostico: { motivos: [{ codigo: 'banco-com-alerta', texto: 'x' }], bancosComAlerta: ['memory-discord'] } });
  assert.equal(b.length, 1);
  assert.match(b[0].text, /memory-discord/);
});

test('atividade recente: nomes internos da segurança viram frases', () => {
  assert.equal(describeEvent('policy.evaluate').label, 'Permissão conferida');
  assert.equal(describeEvent('policy.violation').tone, 'bad');
  assert.equal(describeEvent('policy.algo.novo').label, 'Verificação de segurança', 'prefixo conhecido');
  assert.equal(describeEvent('auth.discord.verify.fail').tone, 'bad');
  assert.equal(describeEvent('auth.discord.request').label, 'Entrada pelo Discord');
  assert.equal(describeEvent('reminder.fire').label, 'Lembrete enviado');
});

test('gráfico de respostas: com poucas respostas vira uma frase; cartão de voz a partir das sessões do Rádio', () => {
  assert.equal(RESPOSTAS_PARA_GRAFICO, 5);
  const vazio = chartBars([{ hour: '2026-11-11T10:00:00', count: 0 }]);
  assert.equal(resumoDasRespostas(vazio), 'Nenhuma resposta da IA nas últimas 24 h.');
  const uma = chartBars([{ hour: '2026-11-11T10:00:00', count: 0 }, { hour: '2026-11-11T20:00:00', count: 1 }, { hour: '2026-11-11T21:00:00', count: 0 }]);
  assert.equal(resumoDasRespostas(uma), '1 resposta da IA nas últimas 24 h (a última por volta das 20h).');
  assert.match(resumoDasRespostas(chartBars([{ hour: '2026-11-11T09:00:00', count: 3 }])), /^3 respostas da IA/);
  assert.equal(resumoDaVoz(null).level, 'unknown');
  assert.deepEqual(resumoDaVoz([]), { level: 'ok', text: 'Fora dos canais de voz agora.' });
  const em = resumoDaVoz([{ guildName: 'GTA BR', voiceChannel: 'Geral', connected: true, current: { title: 'Rádio\nLos Santos' } }, { guildName: 'Outro', voiceChannel: 'x', connected: true }]);
  assert.equal(em.level, 'ok');
  assert.equal(em.text, 'Em chamada: GTA BR · Geral (+1). Tocando: Rádio Los Santos');
  assert.equal(resumoDaVoz([{ guildName: 'GTA BR', voiceChannel: null, connected: false }]).level, 'warn');
});

test('saúde do computador: a barra mostra o que está EM USO (disco 91% livre = barra de 9%), o texto diz o livre', () => {
  const disco = medidorDeUso(421.2, 464.9, 'GB');
  assert.equal(disco.usadoPercent, 9, 'disco quase vazio = barra quase vazia');
  assert.equal(disco.detalhe, '43,7 GB em uso de 464,9 GB · 421,2 GB livres');
  const ram = medidorDeUso(1660, 3979, 'MB');
  assert.equal(ram.usadoPercent, 58);
  assert.equal(ram.detalhe, '2.319 MB em uso de 3.979 MB · 1.660 MB livres');
  assert.equal(medidorDeUso(0, 100, 'GB').usadoPercent, 100, 'lotado = barra cheia');
  assert.deepEqual(medidorDeUso(null, 100, 'MB'), { usadoPercent: null, detalhe: null }, 'sem leitura não inventa barra');
  assert.deepEqual(medidorDeUso(10, 0, 'MB'), { usadoPercent: null, detalhe: null });
  // A cor vem do LIVRE: folgado fica na cor da Yui; amarelo e vermelho só quando falta espaço.
  assert.equal(corDoMedidor(levelForFree(91)), 'yui');
  assert.equal(corDoMedidor(levelForFree(42)), 'yui');
  assert.equal(corDoMedidor(levelForFree(12)), 'atencao');
  assert.equal(corDoMedidor(levelForFree(5)), 'critico');
  assert.equal(corDoMedidor(levelForFree(null)), 'yui', 'sem leitura não acende alerta');
});
