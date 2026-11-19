// Itens 6 e 7 (preparo): o CONTRATO ÚNICO entre canal e cérebro (src/core/canais/contrato.js), o ajuste do texto ao canal (estilo.js) e a persona do YouTube Live.
// Tudo desligado e sem efeito: só funções puras, sem rede, sem disco (fora a leitura dos arquivos de persona e do código-fonte), sem Discord.
//  A. a lista fechada de canais e o PEDIDO (validação estrita: canal fora da lista, campo desconhecido, PAPEL vindo do pedido, limites, anexos e capacidades);
//  B. a RESPOSTA (tamanho e estilo por canal, ações, confirmação) e o teto de papel por canal (no YouTube todo mundo é público, até o dono);
//  C. a tabela de tamanho e estilo (YouTube 200, sem lista, sem link, uma ideia; PC igual ao app; Discord como hoje) e o ajuste do texto ao canal;
//  D. a persona do YouTube (a regra de não se dizer IA nem humana, mais as regras de chat ao vivo) e a ausência de Discord nos arquivos novos.
// Execução: npm run test:canais   (node tests/test-canais-contrato.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
process.chdir(repoRoot);
const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const lerFonte = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const contrato = await imp('src/core/canais/contrato.js');
const estilo = await imp('src/core/canais/estilo.js');
const persona = await imp('src/core/persona.js');
const { CANAIS, validarPedido, validarResposta, limitarPapel, REGRAS_DO_CANAL, CAPACIDADES_DO_CANAL, YOUTUBE_MAX_CARACTERES, LIMITES, temLink, temLista, temMarkdown } = contrato;
const { ajustarTextoAoCanal, cortarNoLimite, removerMarkdown, limitarEmojis } = estilo;

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok - ${name}`); } catch (err) { failures.push(name); console.log(`  FALHA - ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 6).join('\n      ')}`); }
};
const codigos = (r) => r.erros.map((e) => e.codigo);
const pedidoBase = (canal = 'app', extra = {}) => ({ canal, pessoa: 'sessao-123', conversa: 'conversa-1', texto: 'oi', anexos: [], capacidades: [], ...extra });

console.log('A. O pedido (canal -> cérebro)');
await test('a lista de canais é fechada e tem exatamente os cinco do contrato', () => {
  assert.deepEqual([...CANAIS], ['discord_dm', 'discord_guild', 'app', 'pc', 'youtube_live']);
  assert.ok(Object.isFrozen(CANAIS) && Object.isFrozen(REGRAS_DO_CANAL) && Object.isFrozen(CAPACIDADES_DO_CANAL));
  for (const c of CANAIS) assert.ok(REGRAS_DO_CANAL[c] && CAPACIDADES_DO_CANAL[c], `canal sem regras ou capacidades: ${c}`);
});
await test('um pedido válido de cada canal é aceito, normalizado e congelado', () => {
  for (const canal of CANAIS) {
    const r = validarPedido(pedidoBase(canal, { capacidades: [CAPACIDADES_DO_CANAL[canal][0]] }));
    assert.equal(r.ok, true, `${canal}: ${JSON.stringify(r.erros)}`);
    assert.ok(Object.isFrozen(r.pedido) && Object.isFrozen(r.pedido.capacidades) && Object.isFrozen(r.pedido.anexos));
    assert.deepEqual(Object.keys(r.pedido).sort(), ['anexos', 'canal', 'capacidades', 'conversa', 'pessoa', 'texto']);
  }
});
await test('canal FORA da lista é recusado (outro nome, caixa diferente, vazio, nulo, objeto, __proto__)', () => {
  for (const canal of ['whatsapp', 'telegram', 'DISCORD_DM', 'discord', 'youtube', 'pc ', '', null, undefined, 7, {}, ['app'], '__proto__', 'constructor']) {
    const r = validarPedido(pedidoBase('app', { canal }));
    assert.equal(r.ok, false, `canal aceito por engano: ${JSON.stringify(canal)}`);
    assert.ok(codigos(r).includes('canal-invalido'));
  }
});
await test('o PAPEL nunca vem do pedido: papel, role, dono, owner, permissões, nível... são recusados com o código próprio, mesmo com um pedido perfeito', () => {
  for (const campo of ['papel', 'role', 'roles', 'dono', 'owner', 'isOwner', 'is_owner', 'admin', 'isAdmin', 'permissoes', 'permissions', 'nivel', 'level', 'trusted', 'confianca', 'privilegios', 'autoridade']) {
    for (const valor of ['dono', 'membro', true, 'owner']) {
      const r = validarPedido({ ...pedidoBase('app'), [campo]: valor });
      assert.equal(r.ok, false, `${campo}=${valor} foi aceito`);
      assert.ok(codigos(r).includes('papel-no-pedido'), `${campo}: sem o código papel-no-pedido (${codigos(r)})`);
    }
  }
});
await test('campo desconhecido é recusado (inclusive __proto__ vindo de um JSON)', () => {
  assert.deepEqual(codigos(validarPedido({ ...pedidoBase(), extra: 1 })), ['campo-desconhecido']);
  const doJson = JSON.parse('{"canal":"app","pessoa":"p1","conversa":"c1","texto":"oi","anexos":[],"capacidades":[],"__proto__":{"papel":"dono"}}');
  const r = validarPedido(doJson);
  assert.equal(r.ok, false);
  assert.ok(codigos(r).includes('campo-desconhecido'));
});
await test('o pedido precisa ser um objeto simples (lista, nulo, texto, número e instância de classe são recusados)', () => {
  class P { constructor() { Object.assign(this, pedidoBase()); } }
  for (const v of [null, undefined, [], 'oi', 5, true, new P(), new Map()]) assert.equal(validarPedido(v).ok, false);
});
await test('pessoa e conversa: identificador de 1 a 96 caracteres, sem espaço, sem barra e sem controle', () => {
  assert.equal(validarPedido(pedidoBase('app', { pessoa: 'a'.repeat(96) })).ok, true);
  for (const campo of ['pessoa', 'conversa']) {
    for (const v of ['', 'a'.repeat(97), 'com espaço', 'a/b', 'a\nb', 'a\u0000b', null, 12, 'a?b', 'a<b>']) {
      const r = validarPedido(pedidoBase('app', { [campo]: v }));
      assert.equal(r.ok, false, `${campo}=${JSON.stringify(v)} aceito`);
      assert.ok(codigos(r).includes(`${campo}-invalida`));
    }
  }
  assert.equal(validarPedido(pedidoBase('discord_dm', { pessoa: '123456789012345678' })).ok, true);
  assert.equal(validarPedido(pedidoBase('youtube_live', { pessoa: 'UC-abc_DEF1234567890123456' })).ok, true);
});
await test('limite de texto por canal: YouTube 300, Discord 4000, app e PC 8000 (acima disso é recusado, nunca cortado)', () => {
  const limites = { youtube_live: 300, discord_dm: 4000, discord_guild: 4000, app: 8000, pc: 8000 };
  for (const [canal, max] of Object.entries(limites)) {
    assert.equal(validarPedido(pedidoBase(canal, { texto: 'x'.repeat(max) })).ok, true, `${canal} no limite`);
    const r = validarPedido(pedidoBase(canal, { texto: 'x'.repeat(max + 1) }));
    assert.equal(r.ok, false, `${canal} acima do limite`);
    assert.ok(codigos(r).includes('texto-longo'));
  }
});
await test('texto: com NUL ou controle é recusado; vazio só passa com anexo; não-texto é recusado', () => {
  assert.ok(codigos(validarPedido(pedidoBase('app', { texto: 'a\u0000b' }))).includes('texto-com-controle'));
  assert.ok(codigos(validarPedido(pedidoBase('app', { texto: 'a\u0007b' }))).includes('texto-com-controle'));
  assert.equal(validarPedido(pedidoBase('app', { texto: 'linha 1\nlinha 2\ttab' })).ok, true, 'quebra de linha e tabulação são texto normal');
  assert.ok(codigos(validarPedido(pedidoBase('app', { texto: '   ' }))).includes('texto-vazio'));
  const anexo = { tipo: 'imagem', nome: 'foto.png', mime: 'image/png', bytes: 1000, ref: 'att:123' };
  assert.equal(validarPedido(pedidoBase('app', { texto: '', anexos: [anexo] })).ok, true);
  for (const v of [null, 5, {}, ['a']]) assert.ok(codigos(validarPedido(pedidoBase('app', { texto: v }))).includes('texto-invalido'));
});
await test('anexos: YouTube não aceita nenhum, Discord até 10, app e PC até 5; cada anexo é conferido campo a campo', () => {
  const anexo = (i = 0) => ({ tipo: 'arquivo', nome: `a${i}.txt`, mime: 'text/plain', bytes: 10, ref: `att:${i}` });
  assert.ok(codigos(validarPedido(pedidoBase('youtube_live', { anexos: [anexo()] }))).includes('anexos-demais'));
  assert.equal(validarPedido(pedidoBase('discord_dm', { anexos: Array.from({ length: 10 }, (_, i) => anexo(i)) })).ok, true);
  assert.ok(codigos(validarPedido(pedidoBase('discord_dm', { anexos: Array.from({ length: 11 }, (_, i) => anexo(i)) }))).includes('anexos-demais'));
  assert.equal(validarPedido(pedidoBase('app', { anexos: Array.from({ length: 5 }, (_, i) => anexo(i)) })).ok, true);
  assert.ok(codigos(validarPedido(pedidoBase('pc', { anexos: Array.from({ length: 6 }, (_, i) => anexo(i)) }))).includes('anexos-demais'));
  const ruins = [
    [{ ...anexo(), tipo: 'executavel' }, 'anexo-tipo-invalido'], [{ ...anexo(), nome: '../x.txt' }, 'anexo-nome-invalido'], [{ ...anexo(), nome: 'a\\b.txt' }, 'anexo-nome-invalido'],
    [{ ...anexo(), nome: '' }, 'anexo-nome-invalido'], [{ ...anexo(), mime: 'texto' }, 'anexo-mime-invalido'], [{ ...anexo(), bytes: -1 }, 'anexo-tamanho-invalido'],
    [{ ...anexo(), bytes: LIMITES.anexoBytesMax + 1 }, 'anexo-tamanho-invalido'], [{ ...anexo(), bytes: 1.5 }, 'anexo-tamanho-invalido'],
    [{ ...anexo(), ref: 'https://x.com/a?b=c' }, 'anexo-ref-invalida'], [{ ...anexo(), ref: '' }, 'anexo-ref-invalida'], [{ ...anexo(), extra: 1 }, 'campo-desconhecido'], ['texto', 'anexo-invalido'],
  ];
  for (const [a, codigo] of ruins) {
    const r = validarPedido(pedidoBase('app', { anexos: [a] }));
    assert.equal(r.ok, false, `anexo ruim aceito: ${JSON.stringify(a)}`);
    assert.ok(codigos(r).includes(codigo), `${JSON.stringify(a)}: esperava ${codigo}, veio ${codigos(r)}`);
  }
  assert.ok(codigos(validarPedido(pedidoBase('app', { anexos: 'x' }))).includes('anexos-invalidos'));
});
await test('capacidades: só as do canal (a lista é fechada), sem repetir; as de outro canal são recusadas', () => {
  assert.equal(validarPedido(pedidoBase('youtube_live', { capacidades: ['youtube.chat.enviar'] })).ok, true);
  assert.equal(validarPedido(pedidoBase('discord_dm', { capacidades: ['discord.dm.enviar', 'discord.voz.entrar'] })).ok, true);
  assert.ok(codigos(validarPedido(pedidoBase('youtube_live', { capacidades: ['discord.voz.entrar'] }))).includes('capacidade-desconhecida'), 'o YouTube não declara capacidade do Discord');
  assert.ok(codigos(validarPedido(pedidoBase('app', { capacidades: ['youtube.chat.enviar'] }))).includes('capacidade-desconhecida'));
  assert.ok(codigos(validarPedido(pedidoBase('discord_dm', { capacidades: ['discord.dm.enviar', 'discord.dm.enviar'] }))).includes('capacidade-repetida'));
  assert.ok(codigos(validarPedido(pedidoBase('app', { capacidades: ['qualquer.coisa'] }))).includes('capacidade-desconhecida'));
  assert.ok(codigos(validarPedido(pedidoBase('app', { capacidades: [7] }))).includes('capacidade-desconhecida'));
  assert.ok(codigos(validarPedido(pedidoBase('app', { capacidades: 'app.anexo.enviar' }))).includes('capacidades-invalidas'));
  assert.ok(codigos(validarPedido({ ...pedidoBase('app'), capacidades: undefined })).includes('capacidades-invalidas'), 'a lista é obrigatória (pode ser vazia)');
});
await test('a validação devolve TODOS os erros de uma vez e nenhum erro repete o conteúdo recebido (nada de texto privado no erro)', () => {
  const segredo = 'SEGREDO-PRIVADO-9f8e7d';
  const r = validarPedido({ canal: 'telegram', pessoa: `${segredo} com espaço`, conversa: '', texto: `${segredo}\u0000`, anexos: [], capacidades: [], papel: segredo, extra: segredo });
  assert.equal(r.ok, false);
  assert.ok(r.erros.length >= 5, `esperava vários erros, vieram ${r.erros.length}`);
  assert.equal(JSON.stringify(r.erros).includes(segredo), false, 'o erro devolveu o conteúdo recebido');
  for (const e of r.erros) assert.deepEqual(Object.keys(e).sort(), ['campo', 'codigo', 'texto']);
});

console.log('B. A resposta (cérebro -> canal) e o papel');
await test('uma resposta válida de cada canal é aceita, normalizada e congelada', () => {
  for (const canal of CANAIS) {
    const r = validarResposta(canal, { texto: 'Oi, tudo bem?' });
    assert.equal(r.ok, true, `${canal}: ${JSON.stringify(r.erros)}`);
    assert.ok(Object.isFrozen(r.resposta) && Object.isFrozen(r.resposta.acoes));
    assert.deepEqual(r.resposta.acoes, []);
    assert.equal(r.resposta.confirmacao, null);
  }
});
await test('YouTube: a resposta tem NO MÁXIMO 200 caracteres (201 é recusado, nunca cortado em silêncio)', () => {
  assert.equal(YOUTUBE_MAX_CARACTERES, 200);
  assert.equal(validarResposta('youtube_live', { texto: 'x'.repeat(200) }).ok, true);
  const r = validarResposta('youtube_live', { texto: 'x'.repeat(201) });
  assert.equal(r.ok, false);
  assert.ok(codigos(r).includes('texto-longo'));
  assert.equal(validarResposta('youtube_live', { texto: 'x'.repeat(5000) }).ok, false);
});
await test('YouTube: sem quebra de linha (uma ideia), sem link, sem lista e sem Markdown', () => {
  const ruins = [
    ['primeira\nsegunda', 'texto-com-quebra'], ['veja https://exemplo.com/x', 'texto-com-link'], ['veja www.exemplo.com', 'texto-com-link'], ['entra em youtu.be/abcdefghijk', 'texto-com-link'],
    ['discord.gg/abc', 'texto-com-link'], ['- um\n- dois', 'texto-com-lista'], ['1. um\n2. dois', 'texto-com-lista'], ['**negrito** aqui', 'texto-com-markdown'], ['use `codigo` aqui', 'texto-com-markdown'], ['# titulo', 'texto-com-markdown'],
  ];
  for (const [texto, codigo] of ruins) {
    const r = validarResposta('youtube_live', { texto });
    assert.equal(r.ok, false, `aceito: ${JSON.stringify(texto)}`);
    assert.ok(codigos(r).includes(codigo), `${JSON.stringify(texto)}: esperava ${codigo}, veio ${codigos(r)}`);
  }
  assert.equal(validarResposta('youtube_live', { texto: 'Boa! Esse jogo é muito bom mesmo, 10/10.' }).ok, true);
});
await test('Discord, app e PC aceitam lista, link e Markdown e até 20000 caracteres (20001 é recusado)', () => {
  for (const canal of ['discord_dm', 'discord_guild', 'app', 'pc']) {
    assert.equal(validarResposta(canal, { texto: '**oi**\n- um\n- dois\nhttps://exemplo.com' }).ok, true, canal);
    assert.equal(validarResposta(canal, { texto: 'x'.repeat(20000) }).ok, true, `${canal} no limite`);
    assert.ok(codigos(validarResposta(canal, { texto: 'x'.repeat(20001) })).includes('texto-longo'), `${canal} acima do limite`);
  }
});
await test('ações: o YouTube não executa nenhuma; nos outros canais só as capacidades que o canal declarou no pedido', () => {
  assert.ok(codigos(validarResposta('youtube_live', { texto: 'ok', acoes: [{ id: 'a1', tipo: 'youtube.chat.enviar' }] })).includes('acoes-nao-permitidas'));
  const acao = (tipo = 'discord.voz.entrar', extra = {}) => ({ id: 'a1', tipo, parametros: { sala: 'geral' }, ...extra });
  assert.equal(validarResposta('discord_guild', { texto: 'entrando', acoes: [acao()] }).ok, true, 'sem lista de capacidades, vale a lista do canal');
  assert.equal(validarResposta('discord_guild', { texto: 'entrando', acoes: [acao()] }, { capacidades: ['discord.voz.entrar'] }).ok, true);
  assert.ok(codigos(validarResposta('discord_guild', { texto: 'entrando', acoes: [acao()] }, { capacidades: ['discord.voz.sair'] })).includes('acao-sem-capacidade'), 'o canal não declarou esta capacidade');
  assert.ok(codigos(validarResposta('discord_guild', { texto: 'x', acoes: [acao('discord.dm.enviar')] })).includes('acao-desconhecida'), 'DM não existe no servidor');
  assert.ok(codigos(validarResposta('app', { texto: 'x', acoes: [acao('discord.voz.entrar')] })).includes('acao-desconhecida'));
  assert.ok(codigos(validarResposta('discord_dm', { texto: 'x', acoes: [{ tipo: 'discord.voz.entrar' }] })).includes('acao-id-invalido'), 'sem id o resultado não volta ao cérebro');
  assert.ok(codigos(validarResposta('discord_dm', { texto: 'x', acoes: [acao('discord.voz.entrar', { extra: 1 })] })).includes('campo-desconhecido'));
  assert.ok(codigos(validarResposta('discord_dm', { texto: 'x', acoes: [acao('discord.voz.entrar', { parametros: { a: 'x'.repeat(LIMITES.parametrosBytesMax) } })] })).includes('parametros-grandes'));
  assert.ok(codigos(validarResposta('discord_dm', { texto: 'x', acoes: Array.from({ length: 9 }, (_, i) => acao('discord.voz.entrar', { id: `a${i}` })) })).includes('acoes-demais'));
  assert.ok(codigos(validarResposta('discord_dm', { texto: 'x', acoes: 'entrar' })).includes('acoes-invalidas'));
});
await test('confirmação: só nos canais privados do dono (DM, app e PC), com prazo e resumo de uma linha', () => {
  const conf = (extra = {}) => ({ id: 'c1', resumo: 'Gravar src/a.js', nivel: 'critico', expiraEmMs: 60_000, ...extra });
  for (const canal of ['discord_dm', 'app', 'pc']) assert.equal(validarResposta(canal, { texto: 'preciso da sua confirmação', confirmacao: conf() }).ok, true, canal);
  for (const canal of ['discord_guild', 'youtube_live']) assert.ok(codigos(validarResposta(canal, { texto: 'ok', confirmacao: conf() })).includes('confirmacao-nao-permitida'), canal);
  const ruins = [[conf({ expiraEmMs: 500 }), 'confirmacao-prazo-invalido'], [conf({ expiraEmMs: LIMITES.confirmacaoExpiraMaxMs + 1 }), 'confirmacao-prazo-invalido'], [conf({ expiraEmMs: null }), 'confirmacao-prazo-invalido'],
    [conf({ nivel: 'baixo' }), 'confirmacao-nivel-invalido'], [conf({ resumo: 'a\nb' }), 'confirmacao-resumo-invalido'], [conf({ resumo: '' }), 'confirmacao-resumo-invalido'], [conf({ id: 'a b' }), 'confirmacao-id-invalido'],
    [conf({ extra: 1 }), 'campo-desconhecido'], ['sim', 'confirmacao-invalida']];
  for (const [c, codigo] of ruins) assert.ok(codigos(validarResposta('app', { texto: 'x', confirmacao: c })).includes(codigo), `${JSON.stringify(c)}: esperava ${codigo}`);
  assert.equal(validarResposta('app', { texto: 'x', confirmacao: null }).ok, true, 'null = sem confirmação');
});
await test('a resposta não carrega papel nem permissão, não aceita campo desconhecido e não pode ser vazia', () => {
  for (const campo of ['papel', 'role', 'dono', 'permissoes']) assert.ok(codigos(validarResposta('app', { texto: 'x', [campo]: 'dono' })).includes('papel-na-resposta'), campo);
  assert.ok(codigos(validarResposta('app', { texto: 'x', extra: 1 })).includes('campo-desconhecido'));
  assert.ok(codigos(validarResposta('app', { texto: '' })).includes('resposta-vazia'));
  assert.ok(codigos(validarResposta('app', { texto: '   ' })).includes('resposta-vazia'));
  assert.equal(validarResposta('discord_dm', { texto: '', acoes: [{ id: 'a1', tipo: 'discord.voz.entrar' }] }).ok, true, 'só uma ação também é uma resposta');
  assert.ok(codigos(validarResposta('app', { texto: 5 })).includes('texto-invalido'));
  assert.ok(codigos(validarResposta('app', 'oi')).includes('resposta-invalida'));
  assert.ok(codigos(validarResposta('telegram', { texto: 'x' })).includes('canal-invalido'));
  assert.ok(codigos(validarResposta('app', { texto: 'a\u0000b' })).includes('texto-com-controle'));
});
await test('limitarPapel: o dono no YouTube Live é PÚBLICO; nos outros canais o papel decidido pelo cérebro vale; nunca eleva ninguém', () => {
  assert.equal(limitarPapel('youtube_live', 'dono'), 'publico');
  assert.equal(limitarPapel('youtube_live', 'membro'), 'publico');
  assert.equal(limitarPapel('youtube_live', 'publico'), 'publico');
  for (const canal of ['discord_dm', 'discord_guild', 'app', 'pc']) {
    assert.equal(limitarPapel(canal, 'dono'), 'dono');
    assert.equal(limitarPapel(canal, 'membro'), 'membro');
    assert.equal(limitarPapel(canal, 'publico'), 'publico', 'nunca eleva');
  }
  for (const ruim of ['admin', '', null, undefined, 'DONO']) assert.equal(limitarPapel('app', ruim), 'publico', `papel desconhecido: ${ruim}`);
  assert.equal(limitarPapel('whatsapp', 'dono'), 'publico', 'canal desconhecido: o menor papel');
});

console.log('C. Tamanho e estilo por canal; o ajuste do texto');
await test('a tabela: YouTube 200, sem lista, sem link, uma ideia; PC igual ao app; Discord como hoje (2000 por mensagem, 20000 por resposta)', () => {
  const y = REGRAS_DO_CANAL.youtube_live;
  assert.equal(y.maxResposta, 200);
  assert.equal(y.maxParte, 200);
  assert.equal(y.dividePartes, false);
  assert.equal(y.maxAnexos, 0);
  assert.equal(y.acoes, false);
  assert.deepEqual({ ...y.estilo }, { markdown: false, listas: false, links: false, codigo: false, mencoes: false, umaIdeiaPorMensagem: true });
  assert.deepEqual(REGRAS_DO_CANAL.pc, REGRAS_DO_CANAL.app, 'PC: igual ao app');
  for (const canal of ['discord_dm', 'discord_guild']) {
    assert.equal(REGRAS_DO_CANAL[canal].maxParte, 2000);
    assert.equal(REGRAS_DO_CANAL[canal].maxResposta, 20000);
    assert.equal(REGRAS_DO_CANAL[canal].dividePartes, true);
  }
  // "como hoje": os mesmos números do código do Discord (conferidos no texto do arquivo; o contrato não importa nada)
  const longReply = lerFonte('src/discord/longReply.js');
  assert.match(longReply, /DISCORD_LIMIT = 2000/);
  assert.match(longReply, /MAX_REPLY_CHARS = 20000/);
});
await test('os detectores de estilo: link, lista e Markdown', () => {
  for (const t of ['https://a.com', 'http://a.com/x?y=1', 'www.a.com', 'youtu.be/abc', 'veja site.com.br/pagina', 'discord.gg/abc']) assert.equal(temLink(t), true, t);
  for (const t of ['oi, tudo bem?', 'nota 9.5 de 10', 'versão 1.2.3', 'fim. Começo']) assert.equal(temLink(t), false, t);
  assert.equal(temLista('- a'), true); assert.equal(temLista('a\n* b'), true); assert.equal(temLista('1. a'), true); assert.equal(temLista('2) b'), true);
  assert.equal(temLista('a - b'), false); assert.equal(temLista('10-20 jogadores'), false);
  assert.equal(temMarkdown('**a**'), true); assert.equal(temMarkdown('`a`'), true); assert.equal(temMarkdown('[a](https://x.com)'), true); assert.equal(temMarkdown('a * b'), false);
});
await test('ajuste para o YouTube: NUNCA passa de 200 caracteres, em nenhum tamanho de entrada, com texto longo de verdade ou sem espaços', () => {
  const frase = 'O jogo tem um mapa enorme, muitas missões e um modo cooperativo que funciona muito bem quando a turma joga junta. ';
  for (const n of [1, 50, 199, 200, 201, 220, 400, 1000, 5000, 20000]) {
    for (const base of [frase, 'x', 'palavra '.repeat(10), 'ação—sem espaços—'.repeat(30)]) {
      const entrada = base.repeat(Math.ceil(n / base.length)).slice(0, n);
      const r = ajustarTextoAoCanal('youtube_live', entrada);
      assert.ok(r.texto.length <= 200, `${n} (${base.slice(0, 10)}): saiu com ${r.texto.length}`);
      assert.equal(validarResposta('youtube_live', { texto: r.texto || 'x' }).ok, true, 'o ajuste sempre cumpre o contrato');
    }
  }
  const longo = ajustarTextoAoCanal('youtube_live', frase.repeat(20));
  assert.equal(longo.cortado, true);
  assert.ok(longo.texto.length >= 80 && longo.texto.length <= 200, 'não deixa um toco');
  assert.match(longo.texto, /[.…]$/, 'termina em fim de frase ou em reticências');
});
await test('ajuste para o YouTube: não parte um emoji ao meio e deixa no máximo um', () => {
  const r = ajustarTextoAoCanal('youtube_live', `${'a'.repeat(198)}😀😀😀`);
  assert.ok(r.texto.length <= 200);
  assert.ok(!/[\ud800-\udbff]$/.test(r.texto), 'terminou no meio de um par substituto');
  assert.equal(limitarEmojis('oi 😀 tudo 😎 bem 🎮', 1), 'oi 😀 tudo  bem ');
  assert.equal([...ajustarTextoAoCanal('youtube_live', 'boa 😀😎🎮 jogo').texto.matchAll(/\p{Extended_Pictographic}/gu)].length, 1);
});
await test('ajuste para o YouTube: tira Markdown, marcador de lista, link, menção e hashtag, e fica só com a primeira ideia', () => {
  const casos = [
    ['**Boa** pergunta, _viu_?', 'Boa pergunta, viu?'],
    ['Segue o link: https://exemplo.com/x e depois conversamos', 'Segue o link: e depois conversamos'],
    ['- primeiro item\n- segundo item\n- terceiro', 'primeiro item'],
    ['1. um\n2. dois', 'um'],
    ['Primeira ideia.\n\nSegunda ideia que não vai.', 'Primeira ideia.'],
    ['# Título\ncorpo', 'Título'],
    ['olha o [guia](https://guia.com/x) aí', 'olha o guia aí'],
    ['@Fulano valeu! #gaming', 'Fulano valeu! gaming'],
    ['use `npm test` agora', 'use npm test agora'],
    ['```js\ncodigo()\n```', 'codigo()'],
    ['veja youtu.be/abcdefghijk e discord.gg/xyz', 'veja e'],
  ];
  for (const [entrada, esperado] of casos) {
    const r = ajustarTextoAoCanal('youtube_live', entrada);
    assert.equal(r.texto, esperado, `${JSON.stringify(entrada)}`);
    assert.equal(validarResposta('youtube_live', { texto: r.texto }).ok, true);
  }
  assert.equal(removerMarkdown('snake_case_nome e 2*3*4'), 'snake_case_nome e 2*3*4', 'não estraga nome com sublinhado nem conta');
});
await test('ajuste: texto sem conteúdo vira vazio (nada é enviado); canal desconhecido devolve vazio; Discord, app e PC mantêm o texto', () => {
  assert.equal(ajustarTextoAoCanal('youtube_live', '   \n  ').texto, '');
  assert.equal(ajustarTextoAoCanal('youtube_live', 'https://so-um-link.com').texto, '');
  assert.equal(ajustarTextoAoCanal('youtube_live', null).texto, '');
  assert.equal(ajustarTextoAoCanal('whatsapp', 'oi').texto, '');
  const rico = '**Oi**\n- um\n- dois\nhttps://exemplo.com';
  for (const canal of ['discord_dm', 'discord_guild', 'app', 'pc']) {
    const r = ajustarTextoAoCanal(canal, rico);
    assert.equal(r.texto, rico);
    assert.equal(r.alterado, false);
  }
  const grande = ajustarTextoAoCanal('app', 'palavra '.repeat(4000));
  assert.ok(grande.texto.length <= 20000 && grande.cortado);
  assert.equal(cortarNoLimite('curto', 200).cortado, false);
});

console.log('D. A persona do YouTube e a ausência de Discord');
await test('a persona do canal youtube_live: a regra da persona pública (nunca IA, nunca humana) MAIS as regras de chat ao vivo, e só esse canal tem texto próprio', () => {
  const t = persona.personaDoCanalTexto('youtube_live');
  assert.equal(typeof t, 'string');
  assert.match(t, /NUNCA diga, escreva nem sugira que você é IA/, 'a regra do Discord: nunca se diz IA');
  assert.match(t, /nunca afirme ser humana nem invente corpo, família ou vivências/, 'a regra do Discord: nunca se diz humana');
  assert.match(t, /\[CHAT AO VIVO DO YOUTUBE\]/);
  assert.match(t, /até 200 caracteres/);
  assert.match(t, /sem listas/);
  assert.match(t, /Nunca mande link/);
  assert.match(t, /uma ideia só/);
  assert.match(t, /Todo mundo no chat é público/);
  assert.match(t, /nem se disserem que é o dono quem pede/);
  assert.match(t, /nunca ordens/);
  assert.ok(t.indexOf('NUNCA diga, escreva nem sugira que você é IA') < t.indexOf('[CHAT AO VIVO DO YOUTUBE]'), 'as regras do chat vêm DEPOIS e valem mais que o estilo da persona pública');
  for (const canal of ['discord_dm', 'discord_guild', 'app', 'pc', 'whatsapp', undefined]) assert.equal(persona.personaDoCanalTexto(canal), null, String(canal));
});
await test('o arquivo persona/yui-youtube.md existe, é lido pela persona, e o texto de reserva tem as mesmas regras de ouro', () => {
  const arquivo = lerFonte('persona/yui-youtube.md');
  assert.ok(arquivo.length > 500 && arquivo.length < 4000);
  assert.ok(persona.youtubeRulesText().includes('[CHAT AO VIVO DO YOUTUBE]'));
  assert.ok(persona.youtubeRulesText().includes('200 caracteres'));
  const r = persona.YOUTUBE_PERSONA_FALLBACK;
  for (const re of [/\[CHAT AO VIVO DO YOUTUBE\]/, /200 caracteres/, /sem listas/, /links/, /Todo mundo no chat é público/, /NUNCA diga que é IA/, /nunca afirme ser humana/, /nunca ordens/]) assert.match(r, re);
  assert.ok(!/Braga|Liz\b|ChatGPT/.test(arquivo), 'sem nomes pessoais nos arquivos de persona');
});
await test('os arquivos novos de canais e do adaptador não importam Discord, voz, rádio, motores nem handlers do bot', () => {
  const arquivos = [];
  const andar = (dir) => { for (const e of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) { const rel = `${dir}/${e.name}`; if (e.isDirectory()) andar(rel); else if (/\.m?js$/.test(e.name)) arquivos.push(rel); } };
  andar('src/core/canais');
  andar('src/adaptadores');
  assert.ok(arquivos.length >= 9, `arquivos achados: ${arquivos.length}`);
  for (const rel of arquivos) {
    const fonte = lerFonte(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    for (const m of fonte.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
      const alvo = m[1];
      assert.ok(!/discord|@discordjs|puppeteer|prism-media|opusscript|msedge-tts/i.test(alvo), `${rel} importa ${alvo}`);
      assert.ok(!/(?:^|\/)(?:discord|events|music|handlers|engines|commands|scheduler)(?:\/|$)/.test(alvo.replace(/^(\.\.\/)+/, '')), `${rel} importa ${alvo} (pasta do bot)`);
    }
  }
  // o contrato é PURO: não importa nada
  assert.equal(/^\s*import\s/m.test(lerFonte('src/core/canais/contrato.js')), false, 'o contrato não pode ter nenhum import');
});

console.log(`\n${passed} testes OK${failures.length ? `; ${failures.length} FALHARAM: ${failures.join(' | ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
