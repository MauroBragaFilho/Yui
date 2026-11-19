// A PESQUISA POR INTENÇÃO no chat (etapa 11, src/cerebro/intencaoBusca.js): o detector e a política. Determinístico: nenhuma IA, nenhuma rede, nenhum disco.
//  A. o DETECTOR: muitas perguntas de dado externo ATUAL (resultado de jogo, lançamento, notícia, último episódio, preço ou estoque hoje, serviço fora do ar, horário
//     de evento, patch, "hoje/ontem + fato") disparam; e uma lista longa de conversa comum, opinião, código, ferramenta própria (baixar, imagem, música, Steam, câmbio,
//     clima), pergunta sobre o próprio grupo e o pedido EXPLÍCITO ("pesquise ...", que já vai ao agente) NÃO disparam;
//  B. a POLÍTICA: YUI_PESQUISA_POR_INTENCAO (off | servidor | dono | todos; padrão dono) x dono/membro x DM/servidor/canal privado x YUI_PRIVATE_SEARCH, a chamada dirigida à Yui,
//     o agente de pesquisa ligado e, na DM do proprietário (a ÚNICA conversa privada que conta, revisão da Liz), a limpeza de dados pessoais (scrubQuery) e a consulta só com o
//     pedido; FALHA FECHADA com a classificação incerta e com a limpeza que lança.
// Execução: npm run test:intencaobusca
import assert from 'node:assert/strict';
import { detectarIntencaoDeBusca, avaliarPesquisaPorIntencao, modoPesquisaPorIntencao, classificarConversa, MODOS_DA_INTENCAO } from '../src/cerebro/intencaoBusca.js';
import { detectarPedidoDeClima } from '../src/core/tools/clima.js';

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (err) { failures.push(name); console.log(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 6).join('\n        ')}`); }
};

const POSITIVAS = [
  ['quem ganhou o jogo do Flamengo ontem?', 'resultado_esportivo'],
  ['quem ganhou o jogo do flamengo ontem', 'resultado_esportivo'],
  ['Quem venceu a partida do Palmeiras hoje?', 'resultado_esportivo'],
  ['qual foi o placar do jogo do Corinthians?', 'resultado_esportivo'],
  ['como foi o jogo do Santos ontem?', 'resultado_esportivo'],
  ['quanto ficou o jogo do Brasil?', 'resultado_esportivo'],
  ['o Flamengo ganhou o jogo ontem?', 'resultado_esportivo'],
  ['qual a classificação do Brasileirão?', 'resultado_esportivo'],
  ['quem ganhou o Oscar ontem?', 'resultado_esportivo'],
  ['já saiu o trailer do GTA 6?', 'lancamento'],
  ['ja saiu o trailer do gta 6', 'lancamento'],
  ['quando sai o GTA 6?', 'lancamento'],
  ['quando lança o novo iPhone?', 'lancamento'],
  ['qual a data de lançamento do Hollow Knight Silksong?', 'lancamento'],
  ['quando estreia a nova temporada de Stranger Things?', 'lancamento'],
  ['vê se já saiu o novo Zelda', 'lancamento'],
  ['tem novidade do GTA 6?', 'noticia'],
  ['quais as últimas notícias do Flamengo?', 'noticia'],
  ['o que rolou no BBB ontem?', 'noticia'],
  ['o que aconteceu com a Taylor Swift hoje?', 'noticia'],
  ['qual o último episódio de Demon Slayer?', 'ultimo_recente'],
  ['qual a versão mais recente do Node?', 'ultimo_recente'],
  ['qual o último álbum do Coldplay?', 'ultimo_recente'],
  ['quanto está o PS5 hoje?', 'preco_ou_estoque'],
  ['qual o preço do PS5 hoje?', 'preco_ou_estoque'],
  ['o PS5 está em estoque?', 'preco_ou_estoque'],
  ['quanto custa a gasolina hoje?', 'preco_ou_estoque'],
  ['tem promoção de PS5 na Amazon hoje?', 'preco_ou_estoque'],
  ['o Discord está fora do ar?', 'servico_no_ar'],
  ['o servidor do GTA Online está fora do ar?', 'servico_no_ar'],
  ['o YouTube caiu?', 'servico_no_ar'],
  ['o Instagram está instável hoje?', 'servico_no_ar'],
  ['que horas é o jogo do Flamengo hoje?', 'horario_de_evento'],
  ['a que horas começa a final da Libertadores?', 'horario_de_evento'],
  ['quando é o próximo jogo do Brasil?', 'horario_de_evento'],
  ['onde vai passar o jogo do Brasil?', 'horario_de_evento'],
  ['saiu patch novo do Fortnite?', 'patch_ou_atualizacao'],
  ['o que mudou no último patch de Elden Ring?', null],
  ['tem atualização nova do Windows?', 'patch_ou_atualizacao'],
  ['como foi o show do Coldplay ontem?', 'tempo_e_fato'],
  ['o que aconteceu hoje com o Bolsonaro?', 'tempo_e_fato'],
  ['Yui, quem ganhou o jogo do Flamengo ontem?', 'resultado_esportivo'],
  ['<@900000000000000001> já saiu o trailer do GTA 6?', 'lancamento'],
  ['me diz quem ganhou o jogo do Flamengo ontem', 'resultado_esportivo'],
  ['você sabe quem ganhou o jogo do Flamengo ontem?', 'resultado_esportivo'],
];

const NEGATIVAS = [
  'oi tudo bem?', 'bom dia yui', 'quanto está o dólar hoje?', 'quanto custa 1 euro em reais agora?', 'quanto tá o bitcoin?', 'converte 100 dólares', 'como você está hoje?',
  'o que tem pra jantar hoje?', 'quem está online hoje?', 'que dia é hoje?', 'que horas são agora?', 'qual a data de hoje?', 'me explica fotossíntese', 'qual a capital da França?',
  'quanto é 2 + 2?', 'me conta uma piada', 'o que você acha do GTA 6?', 'eu gosto muito do Flamengo', 'acho que o Flamengo vai ganhar', 'quem é você?',
  'baixa a música Ninguém Explica', 'toca uma música do Coldplay', 'gera uma imagem de um gato', 'mostra os requisitos do GTA 6 no steam', 'qual a nota do jogo Elden Ring?',
  'pesquise o preço do PS5', 'pesquisa quem ganhou o jogo do Flamengo ontem', 'não pesquise nada', 'você consegue pesquisar?', 'como pesquisar no Google?', 'vou pesquisar isso depois',
  'qual o último comando que eu usei?', 'qual a última mensagem que você me mandou?', 'meu time ganhou ontem?', 'quando sai meu salário?', 'quando sai o ônibus?', 'o servidor caiu?',
  'quem ganhou a partida na call?', 'a gente jogou ontem, quem ganhou?', 'quem ganhou?', 'quem ganhou o jogo ontem?', 'já saiu?', 'quando sai?',
  'faz uma função em js: const a = () => { return 1; };', '```js\nconsole.log(1)\n```', 'como está o clima em Manaus?', 'vai chover hoje em São Paulo?', 'o tempo de download foi bom hoje',
  'olha esse link https://exemplo.com quem ganhou', 'quanto custa o ingresso?', 'oi yui, hoje foi legal né?', '/yui quem ganhou ontem', '!ping', 'hoje eu vou jogar GTA',
  'o que aconteceu hoje no servidor?', 'quem falou isso hoje?', 'qual o melhor jogo de todos?', 'tem alguma dica pra Elden Ring?', 'o Flamengo é o melhor time do Brasil?',
  'qual o seu jogo favorito?', 'me recomenda um filme', 'quanto tempo leva pra zerar Elden Ring?', 'cala a boca', 'kkkkk', 'quem ganhou ontem? ele ou ela?', '',
  `quem ganhou o jogo do Flamengo ontem? ${'blá '.repeat(120)}`, 'quem ganhou o jogo do Flamengo ontem?\nlinha 2\nlinha 3\nlinha 4',
];

await test('as perguntas de dado externo ATUAL disparam, cada uma na categoria certa', () => {
  assert.ok(POSITIVAS.length >= 40);
  for (const [texto, categoria] of POSITIVAS) {
    const r = detectarIntencaoDeBusca(texto);
    assert.equal(r.busca, true, `deveria disparar: "${texto}" (${r.motivo})`);
    if (categoria) assert.equal(r.categoria, categoria, `categoria de "${texto}"`);
    assert.ok(r.consulta.length >= 3 && r.consulta.length <= 200, `consulta: "${r.consulta}"`);
  }
});

await test('conversa comum, opinião, código, ferramenta própria, câmbio, clima, grupo e pedido explícito NÃO disparam', () => {
  assert.ok(NEGATIVAS.length >= 60);
  for (const texto of NEGATIVAS) {
    const r = detectarIntencaoDeBusca(texto);
    assert.equal(r.busca, false, `NÃO deveria disparar: "${texto.slice(0, 60)}" (categoria ${r.categoria})`);
    assert.ok(r.motivo, 'o motivo da recusa é dito');
  }
});

await test('os motivos: pedido explícito vai ao agente, cotação e clima têm ferramenta própria, o resto é conversa', () => {
  const m = (t) => detectarIntencaoDeBusca(t).motivo;
  assert.equal(m('pesquise o preço do PS5'), 'pedido_explicito');
  assert.equal(m('quanto está o dólar hoje?'), 'cotacao');
  assert.equal(m('como está o clima em Manaus?'), 'clima');
  assert.equal(m('baixa a música Ninguém Explica'), 'ferramenta_propria');
  assert.equal(m('meu time ganhou ontem?'), 'pessoal');
  assert.equal(m('quem ganhou a partida na call?'), 'do_grupo');
  assert.match(m('não pesquise nada'), /^bloqueado_/);
  assert.equal(m('olha https://exemplo.com quem ganhou'), 'link');
  assert.equal(m('```js\nx\n```'), 'codigo');
  assert.equal(m('/yui oi'), 'comando');
  assert.equal(m('oi tudo bem?'), 'sem_intencao');
});

await test('o clima e a pesquisa por intenção nunca disparam juntos (nenhuma frase positiva de um é do outro)', () => {
  for (const [texto] of POSITIVAS) assert.equal(detectarPedidoDeClima(texto).clima, false, `"${texto}" não é clima`);
  for (const t of ['como está o clima em Manaus?', 'vai chover hoje em São Paulo?', 'qual a previsão do tempo pra amanhã em Curitiba?', 'Olá, poderia ver o clima de Cuiabá-MT para essa semana?']) {
    assert.equal(detectarIntencaoDeBusca(t).busca, false, `"${t}" é clima`);
  }
});

await test('o detector é rápido com entrada hostil', () => {
  const t0 = Date.now();
  detectarIntencaoDeBusca(`quem ganhou ${'o jogo do '.repeat(35)}?`);
  detectarIntencaoDeBusca(`${' '.repeat(380)}quando sai`);
  detectarIntencaoDeBusca(`${'Flamengo '.repeat(40)}?`);
  assert.ok(Date.now() - t0 < 500, `levou ${Date.now() - t0} ms`);
});

const TEXTO = 'quem ganhou o jogo do Flamengo ontem?';
// ─────────────── B. A política ───────────────
const GUILD = '444444444444444444';
const CTX = {
  dono_srv: { channelKind: 'public', guildId: GUILD, role: 'OWNER', memoryScope: 'public' },
  membro_srv: { channelKind: 'public', guildId: GUILD, role: 'MEMBER', memoryScope: 'public' },
  dono_dm: { channelKind: 'dm', guildId: null, role: 'OWNER', memoryScope: 'personal' },
  membro_dm: { channelKind: 'dm', guildId: null, role: 'MEMBER', memoryScope: 'public' },
  dono_canal_privado: { channelKind: 'private', guildId: GUILD, role: 'OWNER', memoryScope: 'personal' },
  membro_canal_privado: { channelKind: 'private', guildId: GUILD, role: 'MEMBER', memoryScope: 'public' },
};
const avaliar = (o) => avaliarPesquisaPorIntencao({ texto: TEXTO, chamadaDireta: true, contexto: CTX.membro_srv, env: {}, ...o });

await test('YUI_PESQUISA_POR_INTENCAO: vazio = dono (o padrão); off, servidor, dono, todos; valor desconhecido = off (na dúvida, não pesquisa)', () => {
  assert.deepEqual([...MODOS_DA_INTENCAO], ['off', 'servidor', 'dono', 'todos']);
  assert.equal(modoPesquisaPorIntencao({}), 'dono');
  assert.equal(modoPesquisaPorIntencao({ YUI_PESQUISA_POR_INTENCAO: '' }), 'dono');
  for (const m of MODOS_DA_INTENCAO) assert.equal(modoPesquisaPorIntencao({ YUI_PESQUISA_POR_INTENCAO: m.toUpperCase() }), m);
  for (const ruim of ['sim', 'true', 'owner', 'tudo', '1']) assert.equal(modoPesquisaPorIntencao({ YUI_PESQUISA_POR_INTENCAO: ruim }), 'off', ruim);
});

await test('a classificação da conversa: servidor, DM do proprietário, DM de outra pessoa, canal privado; qualquer fato que falta ou que se contradiz é "incerta"', () => {
  assert.equal(classificarConversa(CTX.dono_srv), 'servidor');
  assert.equal(classificarConversa(CTX.membro_srv), 'servidor');
  assert.equal(classificarConversa(CTX.dono_dm), 'dm_dono');
  assert.equal(classificarConversa(CTX.membro_dm), 'dm_outro');
  assert.equal(classificarConversa(CTX.dono_canal_privado), 'canal_privado');
  assert.equal(classificarConversa(CTX.membro_canal_privado), 'canal_privado');
  const incertas = [
    null, undefined, {}, 'dm', 42, [],
    { ...CTX.dono_dm, guildId: GUILD }, // DM com servidor
    { ...CTX.dono_dm, memoryScope: 'public' }, // o dono em DM sem o escopo pessoal
    { ...CTX.membro_dm, memoryScope: 'personal' }, // um membro com escopo pessoal
    { ...CTX.dono_dm, role: undefined }, { ...CTX.dono_dm, role: 'owner' }, { ...CTX.dono_dm, role: 'ROOT' },
    { ...CTX.dono_dm, channelKind: undefined }, { ...CTX.dono_dm, channelKind: 'voice' },
    { ...CTX.dono_dm, memoryScope: undefined }, { ...CTX.dono_dm, memoryScope: 'tudo' },
    { ...CTX.membro_srv, guildId: null }, { ...CTX.membro_srv, guildId: 'abc' }, { ...CTX.membro_srv, guildId: '12' },
    { ...CTX.dono_canal_privado, guildId: null },
  ];
  for (const c of incertas) assert.equal(classificarConversa(c), 'incerta', JSON.stringify(c));
});

// A TABELA escrita à mão (nunca recalculada com a mesma fórmula do código): chave x quem x onde x YUI_PRIVATE_SEARCH (off, owner, all). 1 = pesquisa.
// REVISÃO DA LIZ: a ÚNICA conversa privada que conta é a DM do proprietário; a DM de outras pessoas e os canais privados ficam como antes, em TODAS as chaves.
// `todos` é reservado e hoje vale o mesmo que `dono`.
const TABELA = {
  off: { dono_srv: [0, 0, 0], membro_srv: [0, 0, 0], dono_dm: [0, 0, 0], membro_dm: [0, 0, 0], dono_canal_privado: [0, 0, 0], membro_canal_privado: [0, 0, 0] },
  servidor: { dono_srv: [1, 1, 1], membro_srv: [1, 1, 1], dono_dm: [0, 0, 0], membro_dm: [0, 0, 0], dono_canal_privado: [0, 0, 0], membro_canal_privado: [0, 0, 0] },
  dono: { dono_srv: [1, 1, 1], membro_srv: [1, 1, 1], dono_dm: [0, 1, 1], membro_dm: [0, 0, 0], dono_canal_privado: [0, 0, 0], membro_canal_privado: [0, 0, 0] },
  todos: { dono_srv: [1, 1, 1], membro_srv: [1, 1, 1], dono_dm: [0, 1, 1], membro_dm: [0, 0, 0], dono_canal_privado: [0, 0, 0], membro_canal_privado: [0, 0, 0] },
};
const PRIVADAS = ['off', 'owner', 'all'];
for (const [chave, linhas] of Object.entries(TABELA)) {
  for (const [quem, trio] of Object.entries(linhas)) {
    await test(`chave ${chave} x ${quem}: ${trio.map((v, i) => `YUI_PRIVATE_SEARCH=${PRIVADAS[i]} -> ${v ? 'pesquisa' : 'não'}`).join('; ')}`, () => {
      PRIVADAS.forEach((ps, i) => {
        const r = avaliar({ contexto: CTX[quem], env: { YUI_PESQUISA_POR_INTENCAO: chave, YUI_PRIVATE_SEARCH: ps } });
        assert.equal(r.buscar, trio[i] === 1, `${chave}/${quem}/private=${ps}: ${r.motivo}`);
        if (r.buscar) {
          assert.equal(r.privado, quem === 'dono_dm', 'só a busca da DM do proprietário sai com privado: true');
          assert.equal(typeof r.consultaPrivada, quem === 'dono_dm' ? 'string' : 'object');
        }
      });
    });
  }
}

await test('o aprovado NÃO amplia o escopo: em todas as combinações possíveis, só o servidor e a DM do proprietário (com a chave e o YUI_PRIVATE_SEARCH) pesquisam', () => {
  let total = 0;
  let pesquisou = 0;
  for (const chave of ['', 'off', 'servidor', 'dono', 'todos', 'lixo']) {
    for (const ps of ['', 'off', 'owner', 'all', 'lixo']) {
      for (const [quem, contexto] of Object.entries(CTX)) {
        for (const pesquisaLigada of ['true', 'false']) {
          const r = avaliar({ contexto, env: { YUI_PESQUISA_POR_INTENCAO: chave, YUI_PRIVATE_SEARCH: ps, YUI_RESEARCH_ENABLED: pesquisaLigada } });
          total += 1;
          if (!r.buscar) continue;
          pesquisou += 1;
          const modo = modoPesquisaPorIntencao({ YUI_PESQUISA_POR_INTENCAO: chave });
          assert.ok(['servidor', 'dono', 'todos'].includes(modo), `chave ${chave}`);
          if (quem === 'dono_srv' || quem === 'membro_srv') continue;
          assert.equal(quem, 'dono_dm', `só a DM do proprietário: ${quem}`);
          assert.ok(['dono', 'todos'].includes(modo) && ['owner', 'all'].includes(ps) && pesquisaLigada === 'true', `${chave}/${ps}/${pesquisaLigada}`);
          assert.equal(r.privado, true);
        }
      }
    }
  }
  assert.ok(total >= 300 && pesquisou > 0 && pesquisou < total, `${pesquisou} de ${total}`);
});

await test('sem a chave no ambiente o padrão é "dono": servidor para todos e só a DM do proprietário como conversa privada (com YUI_PRIVATE_SEARCH)', () => {
  assert.equal(avaliar({ env: {} }).buscar, true, 'membro no servidor');
  assert.equal(avaliar({ contexto: CTX.dono_srv, env: {} }).buscar, true, 'dono no servidor');
  assert.equal(avaliar({ contexto: CTX.dono_dm, env: { YUI_PRIVATE_SEARCH: 'owner' } }).buscar, true, 'dono em DM com a pesquisa privada liberada');
  assert.equal(avaliar({ contexto: CTX.dono_dm, env: {} }).buscar, false, 'dono em DM SEM YUI_PRIVATE_SEARCH: as regras de antes');
  assert.equal(avaliar({ contexto: CTX.membro_dm, env: { YUI_PRIVATE_SEARCH: 'all' } }).buscar, false, 'membro em DM: como antes, mesmo com a pesquisa privada liberada para todos');
  assert.equal(avaliar({ contexto: CTX.membro_dm, env: { YUI_PRIVATE_SEARCH: 'all' } }).motivo, 'dm_de_outra_pessoa_como_antes');
  assert.equal(avaliar({ contexto: CTX.dono_canal_privado, env: { YUI_PRIVATE_SEARCH: 'all' } }).motivo, 'canal_privado_como_antes');
});

await test('os motivos da recusa na DM do proprietário: chave, YUI_PRIVATE_SEARCH e o agente de pesquisa desligado', () => {
  const dm = (env) => avaliar({ contexto: CTX.dono_dm, env }).motivo;
  assert.equal(dm({ YUI_PESQUISA_POR_INTENCAO: 'off', YUI_PRIVATE_SEARCH: 'owner' }), 'chave_off');
  assert.equal(dm({ YUI_PESQUISA_POR_INTENCAO: 'servidor', YUI_PRIVATE_SEARCH: 'owner' }), 'chave_so_servidor');
  assert.equal(dm({ YUI_PRIVATE_SEARCH: 'off' }), 'privada_nao_liberada');
  assert.equal(dm({ YUI_PRIVATE_SEARCH: 'valor-ruim' }), 'privada_nao_liberada', 'valor desconhecido = off');
  assert.equal(dm({ YUI_PRIVATE_SEARCH: 'owner', YUI_RESEARCH_ENABLED: 'false' }), 'pesquisa_desligada');
  assert.equal(avaliar({ env: { YUI_RESEARCH_ENABLED: 'false' } }).buscar, true, 'no servidor o agente desligado não muda a busca automática');
});

await test('FALHA FECHADA (5): classificação incerta da conversa NÃO pesquisa, em nenhuma chave e com tudo liberado (a Yui responde sem a web)', () => {
  const env = { YUI_PESQUISA_POR_INTENCAO: 'todos', YUI_PRIVATE_SEARCH: 'all' };
  const incertas = [null, undefined, {}, { ...CTX.dono_dm, guildId: GUILD }, { ...CTX.dono_dm, memoryScope: 'public' }, { ...CTX.dono_dm, role: undefined }, { ...CTX.membro_srv, guildId: null },
    { ...CTX.dono_dm, channelKind: 'desconhecido' }, { ...CTX.membro_srv, role: 'owner' }];
  for (const contexto of incertas) {
    const r = avaliar({ contexto, env });
    assert.equal(r.buscar, false, JSON.stringify(contexto));
    assert.equal(r.motivo, 'classificacao_incerta');
    assert.equal(r.privado, false);
    assert.equal(r.consultaPrivada, null);
  }
  assert.equal(avaliarPesquisaPorIntencao({ texto: TEXTO, chamadaDireta: true, env }).motivo, 'classificacao_incerta', 'sem contexto nenhum');
  assert.equal(avaliarPesquisaPorIntencao({ texto: TEXTO, chamadaDireta: true, contexto: CTX.dono_dm, env: new Proxy({}, { get() { throw new Error('ambiente ilegível'); } }) }).buscar, false, 'ambiente que lança: não pesquisa');
});

await test('FALHA FECHADA (5): a limpeza de dados pessoais que LANÇA, que devolve lixo ou que não prova que a consulta está limpa NÃO pesquisa na DM do proprietário', () => {
  const env = { YUI_PRIVATE_SEARCH: 'owner' };
  const com = (scrub) => avaliar({ contexto: CTX.dono_dm, env, scrub });
  assert.equal(com(() => { throw new Error('a limpeza quebrou'); }).motivo, 'limpeza_falhou');
  for (const lixo of [undefined, null, 0, 'ok', [], {}, { ok: false, reason: 'sensitive_data' }, { ok: 'true', query: 'x' }, { ok: true }, { ok: true, query: '' }, { ok: true, query: '   ' }, { ok: true, query: 42 }]) {
    const r = com(() => lixo);
    assert.equal(r.buscar, false, JSON.stringify(lixo));
    assert.equal(r.motivo, 'consulta_barrada');
    assert.equal(r.consultaPrivada, null);
  }
  assert.equal(com(() => ({ ok: true, query: 'flamengo ontem' })).buscar, true, 'a limpeza que prova a consulta limpa libera');
  assert.equal(com(() => ({ ok: true, query: 'flamengo ontem' })).consultaPrivada, 'flamengo ontem');
  // no servidor a política não depende da limpeza daqui (a porta da busca limpa a consulta depois, como sempre)
  assert.equal(avaliar({ contexto: CTX.membro_srv, scrub: () => { throw new Error('x'); } }).buscar, true);
});

await test('só em chamada DIRIGIDA à Yui: espontânea, voz e log de terceiros não passam pela política', () => {
  assert.equal(avaliar({ chamadaDireta: false }).buscar, false);
  assert.equal(avaliar({ chamadaDireta: false }).motivo, 'nao_direta');
  assert.equal(avaliar({ chamadaDireta: undefined }).buscar, false, 'sem a informação, não pesquisa');
  assert.equal(avaliar({ texto: '' }).buscar, false);
  assert.equal(avaliar({ texto: 'oi tudo bem?' }).buscar, false);
  assert.equal(avaliar({ texto: 'oi tudo bem?' }).motivo, 'sem_intencao');
});

await test('DM do proprietário: a consulta é só o pedido (sem a justificativa pessoal) e passa pela limpeza de dados pessoais (scrubQuery); o que não passa NÃO pesquisa', () => {
  const env = { YUI_PRIVATE_SEARCH: 'owner' };
  const dm = (o) => avaliar({ contexto: CTX.dono_dm, env, ...o });
  const ok = dm({});
  assert.equal(ok.buscar, true);
  assert.equal(ok.privado, true);
  assert.match(ok.consultaPrivada, /flamengo/i);
  const longa = dm({ texto: 'quem ganhou o jogo do Flamengo ontem porque eu apostei dinheiro que não tinha e estou desesperado' });
  assert.equal(longa.buscar, true);
  assert.ok(!/apostei|desesperado|dinheiro/i.test(longa.consultaPrivada), longa.consultaPrivada);
  const frases = dm({ texto: 'quem ganhou o jogo do Flamengo ontem? é pra decidir o divórcio com a Ana' });
  assert.equal(frases.buscar, true);
  assert.ok(!/divorcio|divórcio|Ana/i.test(frases.consultaPrivada), frases.consultaPrivada);
  for (const texto of ['quem ganhou o jogo do time 123.456.789-09 ontem?', 'já saiu o trailer do GTA 6 fulano@exemplo.com?', 'quem ganhou o jogo do Flamengo ontem senha=abc123456xyz']) {
    const r = dm({ texto });
    assert.equal(r.buscar, false, texto);
    assert.equal(r.consultaPrivada, null);
  }
  const proibida = dm({ forbiddenKeywords: ['flamengo'] });
  assert.equal(proibida.buscar, false);
  assert.equal(proibida.motivo, 'consulta_barrada');
  assert.equal(avaliar({ texto: 'quem ganhou o jogo do time 123.456.789-09 ontem?' }).buscar, true, 'no servidor a porta da busca limpa depois');
});

await test('a política não inventa pesquisa onde o detector diz não (pedido explícito, câmbio, clima, ferramenta própria), em nenhum cenário', () => {
  const envs = [{ YUI_PESQUISA_POR_INTENCAO: 'todos', YUI_PRIVATE_SEARCH: 'all' }, {}];
  for (const env of envs) for (const texto of ['pesquise o preço do PS5', 'quanto está o dólar hoje?', 'como está o clima em Manaus?', 'baixa a música Ninguém Explica', 'oi tudo bem?']) {
    for (const contexto of Object.values(CTX)) assert.equal(avaliar({ texto, contexto, env }).buscar, false, `${texto} / ${JSON.stringify(contexto)}`);
  }
});

console.log(failures.length ? `\nFALHA: ${passed} passaram, ${failures.length} falharam.\nFalharam: ${failures.join(' | ')}` : `\n${passed} teste(s) passaram, 0 falharam.`);
process.exit(failures.length ? 1 : 0);
