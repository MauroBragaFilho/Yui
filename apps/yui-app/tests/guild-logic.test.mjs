// Regras e chamadas das configurações por servidor (ferramentas, Termos de Uso, canal), sem React.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../src/guildLogic.ts';
import { campoDoAjuste, filtrarAjustes, gruposDosAjustes } from '../src/configLogic.ts';
import { createClient } from '../src/api/client.ts';

test('ferramentas: avisos nas sensíveis e rótulo sem emoji', () => {
  for (const nome of ['voice_tts', 'join_voice_call', 'radio_voice_stt', 'download_video']) assert.ok(g.avisoDaFerramenta(nome), nome);
  assert.equal(g.avisoDaFerramenta('web_search'), null);
  assert.equal(g.semEmoji('🎙️ Assistente de Voz (Call)'), 'Assistente de Voz (Call)');
  assert.match(g.perguntaDaFerramenta({ nome: 'voice_tts', rotulo: 'Fala' }, true).texto, /todos/);
  assert.doesNotMatch(g.perguntaDaFerramenta({ nome: 'voice_tts', rotulo: 'Fala' }, false).texto, /Atenção/);
});

test('termos: resumo, aviso de terceiros, resultado e texto sem markdown', () => {
  const base = { donoDoServidor: false, aceito: false, exigido: true, aceitoEm: null, aceitoPor: null, origem: null };
  assert.match(g.resumoDosTermos(base), /Pendente/);
  assert.match(g.resumoDosTermos({ ...base, aceito: true, aceitoEm: '2026-11-26T12:00:00Z', origem: 'painel' }), /pelo painel/);
  assert.match(g.resumoDosTermos({ ...base, exigido: false, aceito: true }), /não são exigidos/);
  assert.match(g.perguntaDoAceite(base, 'X'), /terceiros[\s\S]*ENVIAR/);
  assert.doesNotMatch(g.perguntaDoAceite({ donoDoServidor: true }, 'X'), /terceiros/);
  assert.match(g.resultadoDoAceite({ jaAceito: true, avisoEnviado: false }), /Já estava/);
  assert.equal(g.textoSemMarkdown('### 🛡️ Título\n\n**forte** e `cmd`\n* *Nota:* item'), 'Título\n\nforte e cmd\n• Nota: item');
});

test('canal: porcentagem e mudança da persona', () => {
  assert.equal(g.lerPorcentagem('0'), 0);
  assert.equal(g.lerPorcentagem(' 100 '), 100);
  for (const ruim of ['', '101', '-1', '2.5', 'x']) assert.equal(g.lerPorcentagem(ruim), null, ruim);
  const atual = { instrucao: 'a', humor: null };
  assert.equal(g.mudancaDaPersona(atual, 'a', ''), null);
  assert.deepEqual(g.mudancaDaPersona(atual, '', ''), { instrucao: '' });
  assert.deepEqual(g.mudancaDaPersona(atual, 'a', 'calma'), { humor: 'calma' });
});

test('cliente: rotas por servidor seguem o contrato, com confirm no que altera', async () => {
  const chamadas = [];
  const { admin } = createClient({
    baseUrl: 'http://192.168.0.2:3939',
    token: 't',
    fetchImpl: async (url, init) => {
      chamadas.push([init.method, new URL(url).pathname, init.body ? JSON.parse(init.body) : undefined]);
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await admin.guildTools('1');
  await admin.setGuildTool('1', 'voice_tts', true);
  await admin.resetGuildTools('1');
  await admin.tosTerms();
  await admin.guildTos('1');
  await admin.acceptGuildTos('1');
  await admin.acceptGuildTos('1', true);
  await admin.revokeGuildTos('1');
  await admin.channelConfig('1', '2');
  await admin.setPersona('1', '2', { humor: '' });
  await admin.resetPersona('1', '2');
  await admin.setChatter('1', '2', { porcentagem: 7 });
  await admin.setMentions('1', false);
  await admin.setGuildChannel('1', 'atualizacoes', null);
  const c = { confirm: true };
  assert.deepEqual(chamadas, [
    ['GET', '/v1/admin/guilds/1/mcp-tools', undefined],
    ['PUT', '/v1/admin/guilds/1/mcp-tools/voice_tts', { ligada: true, ...c }],
    ['POST', '/v1/admin/guilds/1/mcp-tools/reset', c],
    ['GET', '/v1/admin/tos', undefined],
    ['GET', '/v1/admin/guilds/1/tos', undefined],
    ['POST', '/v1/admin/guilds/1/tos', c],
    ['POST', '/v1/admin/guilds/1/tos', { ...c, emNomeDeTerceiros: true }],
    ['DELETE', '/v1/admin/guilds/1/tos', c],
    ['GET', '/v1/admin/guilds/1/channels/2', undefined],
    ['PUT', '/v1/admin/guilds/1/channels/2/persona', { humor: '', ...c }],
    ['DELETE', '/v1/admin/guilds/1/channels/2/persona', c],
    ['PUT', '/v1/admin/guilds/1/channels/2/espontaneo', { porcentagem: 7, ...c }],
    ['PUT', '/v1/admin/guilds/1/mentions', { respondToEveryone: false, ...c }],
    ['PUT', '/v1/admin/guilds/1/channels', { type: 'atualizacoes', channelId: null, ...c }],
  ]);
});

test('falas: ligar sem frequência já escolhe a baixa', () => {
  const m = (ativo, frequencia, porcentagem = null) => g.mudancaAoAlternarFalas({ ativo, frequencia, porcentagem }).mudanca;
  assert.deepEqual(m(false, null), { ativo: true, frequencia: 'low' });
  assert.deepEqual(m(false, 'high'), { ativo: true });
  assert.deepEqual(m(false, 'custom', 7), { ativo: true });
  assert.deepEqual(m(true, null), { ativo: false });
});

test('ajustes: confirmação só no valor que afrouxa, e o cliente leva o confirm', async () => {
  const item = { rotulo: 'Avisos', descricao: 'Desligar para.', confirmar: ['false'] };
  assert.match(g.perguntaDoAjuste(item, 'false'), /Avisos/);
  assert.equal(g.perguntaDoAjuste(item, 'true'), null);
  assert.equal(g.perguntaDoAjuste({ rotulo: 'x', descricao: 'y' }, 'true'), null);
  assert.match(g.avisoDeRecarga(true, 'tempo esgotado'), /desatualizado/);
  assert.equal(g.avisoDeRecarga(true, null), null);
  const corpos = [];
  const { admin } = createClient({
    baseUrl: 'http://192.168.0.2:3939',
    token: 't',
    fetchImpl: async (url, init) => {
      corpos.push(init.body ? JSON.parse(init.body) : undefined);
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await admin.configSet('YUI_ALERTS', 'false', true);
  await admin.configSet('YUI_ALERTS', 'true');
  await admin.configRemove('YUI_ALERTS', true);
  await admin.configRemove('YUI_FUSO');
  assert.deepEqual(corpos, [{ valor: 'false', confirm: true }, { valor: 'true' }, { confirm: true }, undefined]);
  // Correção C5 do parecer da Liz: a versão que a tela viu vai junto (0 também); sem versão, o corpo fica como antes.
  corpos.length = 0;
  await admin.configSet('YUI_ALERTS', 'false', true, 3);
  await admin.configSet('YUI_ALERTS', 'true', false, 0);
  await admin.configRemove('YUI_ALERTS', true, 4);
  await admin.configRemove('YUI_FUSO', false, 0);
  assert.deepEqual(corpos, [{ valor: 'false', confirm: true, versao: 3 }, { valor: 'true', versao: 0 }, { confirm: true, versao: 4 }, { versao: 0 }]);
});

test('configuração: grupos e busca sem acento em todos os grupos', () => {
  const itens = [
    { chave: 'YUI_A', rotulo: 'Relatório da manhã', grupo: 'Relatório', descricao: 'Resumo diário' },
    { chave: 'YUI_B', rotulo: 'Voz', grupo: 'Voz', descricao: 'Fala em call' },
  ];
  assert.deepEqual(gruposDosAjustes(itens), ['Relatório', 'Voz']);
  assert.equal(filtrarAjustes(itens, 'Voz', '').length, 1);
  assert.equal(filtrarAjustes(itens, null, '').length, 2);
  assert.equal(filtrarAjustes(itens, 'Voz', 'relatorio')[0].chave, 'YUI_A');
  assert.equal(filtrarAjustes(itens, null, 'nada disso').length, 0);
});

test('configuração (lacunas do painel, item 6): número com casas decimais ganha campo e teclado decimal; ligado/desligado e opção não têm campo', () => {
  const temperatura = campoDoAjuste({ tipo: 'decimal', min: 0, max: 2 });
  assert.deepEqual([temperatura.digitado, temperatura.numerico, temperatura.teclado], [true, true, 'decimal-pad']);
  assert.equal(temperatura.exemplo, 'Número de 0 a 2 (por exemplo 0,7)');
  assert.deepEqual(campoDoAjuste({ tipo: 'decimal', min: 0.5, max: 1.5 }).exemplo, 'Número de 0,5 a 1,5 (por exemplo 0,7)');
  const prazo = campoDoAjuste({ tipo: 'int', min: 5000, max: 300000 });
  assert.deepEqual([prazo.digitado, prazo.teclado, prazo.exemplo], [true, 'numeric', 'Número de 5000 a 300000']);
  assert.deepEqual([campoDoAjuste({ tipo: 'texto' }).digitado, campoDoAjuste({ tipo: 'texto' }).exemplo], [true, 'Novo valor']);
  assert.deepEqual([campoDoAjuste({ tipo: 'segredo' }).digitado, campoDoAjuste({ tipo: 'segredo' }).exemplo], [true, 'Colar nova chave']);
  for (const tipo of ['bool', 'enum']) assert.equal(campoDoAjuste({ tipo }).digitado, false, tipo);
});
