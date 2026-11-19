// Etapa 13: o script do dono que testa o cabeçalho X-OmniRoute-Decision de um OmniRoute de verdade (scripts/testar-cabecalho-omniroute.mjs). Execução: npm run test:scriptcabecalho
//
// O script roda como PROCESSO DE VERDADE (o `node` do teste), contra o OMNIROUTE FALSO deste teste (tests/helpers/omnirouteCabecalhoFalso.js, no formato REAL do cabeçalho), sob o bloqueio de
// integração externa: o único lugar que ele alcança é a porta do servidor falso (ou uma porta fechada que o teste declara). Nada do OmniRoute de verdade é tocado.
//  A. A ajuda e o uso errado (códigos de saída e textos): nada é enviado ao servidor; a chave NUNCA vai em argumento (e o valor de um argumento recusado nunca é impresso).
//  B. A chamada: UMA chamada mínima (sem streaming, 8 tokens, a frase fixa, a chave só no Authorization) e o relatório (status, cabeçalho filtrado, apelido lido pelo leitor ESTRITO, estratégia,
//     X-OmniRoute-Provider, veredito); a conferência com --permitidos; --repetir (o provedor muda ou não).
//  C. Os vereditos e os códigos de saída: sem cabeçalho (6), cabeçalho que a Yui não lê (7), fora da lista (8), HTTP de erro (5), sem resposta (4), sem chave (3), uso (2).
//  D. A CHAVE NUNCA É IMPRESSA (nem a de teste que o script lê, nem um pedaço dela, nem a que o servidor repete no cabeçalho, no corpo e nos erros), e um segredo plantado no cabeçalho também não.
//  E. As peças puras do script (o filtro de segredos, o que mostra do cabeçalho, a leitura dos argumentos).
// SEM rede (só o servidor falso), SEM IA, buscador ou Discord de verdade.
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { criarBloqueioTemporario } from './helpers/bloqueioExternoTeste.js';
import { criarOmniRouteCabecalhoFalso, CHAVE_DE_TESTE, SEGREDO_NO_CABECALHO } from './helpers/omnirouteCabecalhoFalso.js';
import { redigir, mostrarCabecalho, lerArgumentos, CODIGOS, AJUDA, FRASE_DO_TESTE, MAX_TOKENS_DO_TESTE, FORMATO_ESTRITO } from '../scripts/testar-cabecalho-omniroute.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const SCRIPT = 'scripts/testar-cabecalho-omniroute.mjs';
const say = (s) => process.stdout.write(`${s}\n`);

// O bloqueio de integração externa dos processos que este teste abre (o script): nenhuma exceção declarada.
const bloqueio = criarBloqueioTemporario({ teste: 'test:scriptcabecalho', liberar: {} });
const omni = await criarOmniRouteCabecalhoFalso();
bloqueio.portaDoTeste(omni.port);

/** Uma porta que ESTE teste abriu e fechou: o filho pode tentar, e leva "conexão recusada" (sem passar pelo bloqueio). */
async function portaFechada() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  bloqueio.portaDoTeste(port);
  return port;
}

const todas = []; // toda saída de todos os processos (a chave não pode estar em nenhuma)
/** Roda o script como um processo de verdade (assíncrono: o servidor falso está NESTE processo). */
function rodar(args, { chave = CHAVE_DE_TESTE, env = {} } = {}) {
  return new Promise((resolve) => {
    const e = { ...process.env, NODE_ENV: 'test', ...bloqueio.env('script') };
    delete e.OMNIROUTE_KEY;
    if (chave !== null) e.OMNIROUTE_KEY = chave;
    Object.assign(e, env);
    const filho = spawn(process.execPath, [...bloqueio.argv, SCRIPT, ...args], { cwd: repoRoot, env: e, windowsHide: true });
    let saida = '';
    let erro = '';
    const guarda = setTimeout(() => { try { filho.kill(); } catch { /* */ } }, 40_000);
    filho.stdout.on('data', (d) => { saida += d; });
    filho.stderr.on('data', (d) => { erro += d; });
    filho.on('close', (codigo) => {
      clearTimeout(guarda);
      const r = { codigo, saida, erro, tudo: `${saida}${erro}` };
      todas.push({ args, ...r });
      resolve(r);
    });
  });
}
const comOmni = (extra = []) => ['--modelo', 'combo-teste', '--url', omni.url, ...extra];

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 10).join('\n        ')}`);
  }
};
const section = (t) => say(`\n${t}`);
const semChave = (onde, texto, chave = CHAVE_DE_TESTE) => {
  assert.ok(!texto.includes(chave), `a chave inteira apareceu em ${onde}`);
  for (let i = 0; i + 10 <= chave.length; i += 1) assert.ok(!texto.includes(chave.slice(i, i + 10)), `um pedaço da chave ("${chave.slice(i, i + 10)}") apareceu em ${onde}`);
  assert.ok(!/sk-omni/.test(texto), `algo com cara da chave apareceu em ${onde}`);
};
const semSegredo = (onde, texto) => {
  assert.ok(!texto.includes(SEGREDO_NO_CABECALHO) && !/SEGREDO/.test(texto), `o segredo plantado no cabeçalho apareceu em ${onde}`);
};

try {
  // ═════════════════════════════════════════════════════════════════════════════════════
  section('A. A ajuda e o uso errado');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('--ajuda (e -h): código 0, o texto em português com o uso, a variável OMNIROUTE_KEY, os códigos de saída e o formato lido; nada é enviado', async () => {
    omni.limpar();
    for (const flag of ['--ajuda', '-h', '--help']) {
      const r = await rodar([flag], { chave: null });
      assert.equal(r.codigo, CODIGOS.OK, flag);
      assert.equal(r.erro, '');
      for (const trecho of ['OMNIROUTE_KEY', 'Códigos de saída', 'X-OmniRoute-Decision', '--modelo', '--url', '--permitidos', '--repetir', 'nunca é impressa', 'apelido', 'PowerShell', 'Bash']) assert.ok(r.saida.includes(trecho), `${flag}: falta "${trecho}" na ajuda`);
      for (const c of Object.values(CODIGOS)) assert.match(r.saida, new RegExp(`^  ${c}  `, 'm'), `${flag}: o código ${c} não está explicado`);
    }
    assert.equal(AJUDA.includes(CHAVE_DE_TESTE), false);
    assert.equal(omni.requisicoes.length, 0);
  });

  await test('uso errado: código 2, uma mensagem curta no stderr e NADA enviado (sem --modelo, argumento desconhecido ou solto, valores inválidos)', async () => {
    omni.limpar();
    const casos = [
      [[], /faltou --modelo/],
      [['--url', omni.url], /faltou --modelo/],
      [['--modelo'], /faltou o valor de --modelo/],
      [['--modelo', 'combo teste'], /--modelo inválido/],
      [['--modelo', 'a'.repeat(130)], /--modelo inválido/],
      [['--modelo', 'x', '--foo', 'y'], /argumento desconhecido: --foo/],
      [['--modelo', 'x', 'solto'], /argumento solto/],
      [['--modelo', 'x', '--modelo', 'y'], /duas vezes/],
      [['--modelo', 'x', '--repetir', '0'], /--repetir precisa/],
      [['--modelo', 'x', '--repetir', '21'], /--repetir precisa/],
      [['--modelo', 'x', '--repetir', 'abc'], /--repetir precisa/],
      [['--modelo', 'x', '--repetir', '1.5'], /--repetir precisa/],
      [['--modelo', 'x', '--timeout', '0'], /--timeout precisa/],
      [['--modelo', 'x', '--timeout', '121'], /--timeout precisa/],
      [['--modelo', 'x', '--permitidos', ''], /--permitidos/],
      [['--modelo', 'x', '--permitidos', 'a b'], /--permitidos/],
      [['--modelo', 'x', '--permitidos', 'ok,,ok2'], /--permitidos/],
      [['--modelo', 'x', '--url', 'ftp://127.0.0.1'], /--url precisa começar/],
      [['--modelo', 'x', '--url', 'isto não é uma url'], /--url inválida/],
      [['--modelo', 'x', '--url', 'http://usuario:segredo@127.0.0.1:1'], /não pode levar usuário nem senha/],
      [['--modelo', 'x', '--url', 'http://127.0.0.1:1/?chave=abc'], /não pode levar parâmetros/],
    ];
    for (const [args, padrao] of casos) {
      const r = await rodar(args);
      assert.equal(r.codigo, CODIGOS.USO, `${JSON.stringify(args)}: ${r.tudo}`);
      assert.match(r.erro, padrao, JSON.stringify(args));
      assert.equal(r.saida, '', 'o erro de uso só escreve no stderr');
      assert.ok(!r.tudo.includes('segredo@') && !r.tudo.includes('usuario:'), 'a senha de uma URL recusada não é repetida');
    }
    assert.equal(omni.requisicoes.length, 0, 'nenhum uso errado chega ao servidor');
  });

  await test('a chave NUNCA vai em argumento: --chave, --key, --token... são recusados com o código 2 e o valor nunca é impresso (nem o de um argumento solto)', async () => {
    omni.limpar();
    const segredo = 'sk-ARGUMENTO-VAZADO-0123456789abcdef';
    for (const args of [['--chave', segredo], [`--chave=${segredo}`], ['--key', segredo], ['--api-key', segredo], [`--token=${segredo}`], ['--senha', segredo], ['--authorization', `Bearer ${segredo}`], ['--omniroute-key', segredo]]) {
      const r = await rodar(['--modelo', 'x', ...args]);
      assert.equal(r.codigo, CODIGOS.USO, JSON.stringify(args.map((a) => a.slice(0, 12))));
      assert.match(r.erro, /a chave não vai em argumento/);
      assert.match(r.erro, /OMNIROUTE_KEY/);
      assert.ok(!r.tudo.includes(segredo) && !r.tudo.includes('VAZADO'), 'o valor do argumento apareceu na saída');
    }
    for (const args of [[segredo], ['--modelo', 'x', segredo], ['--foo', segredo], [`--foo=${segredo}`]]) {
      const r = await rodar(args);
      assert.equal(r.codigo, CODIGOS.USO);
      assert.ok(!r.tudo.includes(segredo) && !r.tudo.includes('VAZADO'), `o valor de um argumento recusado apareceu: ${JSON.stringify(args.map((a) => a.slice(0, 10)))}`);
    }
    assert.equal(omni.requisicoes.length, 0);
  });

  await test('sem a variável OMNIROUTE_KEY (ou com uma chave inválida): código 3, nada é enviado, e a mensagem diz de onde a chave vem', async () => {
    omni.limpar();
    for (const chave of [null, '', '   ', 'abc123', 'com espaço no meio 0123456789', 'com\ttab-0123456789']) {
      const r = await rodar(comOmni(), { chave });
      assert.equal(r.codigo, CODIGOS.SEM_CHAVE, `chave ${JSON.stringify(chave)}: ${r.tudo}`);
      assert.match(r.erro, /OMNIROUTE_KEY/);
      assert.equal(r.saida, '');
      if (chave && chave.trim()) assert.ok(!r.tudo.includes(chave.trim()), 'a chave inválida não é repetida');
    }
    assert.equal(omni.requisicoes.length, 0);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('B. A chamada e o relatório');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('UMA chamada mínima (sem streaming, 8 tokens, a frase fixa, a chave só no Authorization) e o relatório com o apelido lido pelo leitor estrito', async () => {
    omni.limpar();
    const r = await rodar(comOmni());
    assert.equal(r.codigo, CODIGOS.OK, r.tudo);
    assert.equal(r.erro, '');
    assert.equal(omni.requisicoes.length, 1, 'uma chamada só');
    const q = omni.requisicoes[0];
    assert.deepEqual([q.metodo, q.caminho, q.modelo, q.papel, q.stream, q.maxTokens], ['POST', '/v1/chat/completions', 'combo-teste', 'chave-certa', false, MAX_TOKENS_DO_TESTE]);
    assert.equal(MAX_TOKENS_DO_TESTE, 8);
    assert.deepEqual(q.mensagens, [{ role: 'user', content: 'Responda apenas: ok' }], 'a frase fixa, sem nenhum conteúdo privado');
    assert.equal(FRASE_DO_TESTE, 'Responda apenas: ok');
    assert.deepEqual(q.chavesDoCorpo, ['max_tokens', 'messages', 'model', 'stream']);
    assert.equal(q.temCabecalhoDeCookie, false);
    for (const linha of [
      /Status HTTP:\s+200/,
      /X-OmniRoute-Decision:\s+strategy=single; provider=gemini-cli; latency_ms=120/,
      /Provedor lido pelo leitor estrito:\s+gemini-cli$/m,
      /Estratégia:\s+single$/m,
      /Latência informada:\s+120 ms/,
      /X-OmniRoute-Provider:\s+gemini-cli$/m,
      /Veredito:\s+o cabeçalho nomeia UM provedor \("gemini-cli"\)\.$/m,
      /RESULTADO: o cabeçalho nomeia UM provedor/,
    ]) assert.match(r.saida, linha);
    assert.match(r.saida, /Chave:\s+lida de OMNIROUTE_KEY \(não é impressa\)/);
    assert.ok(!/AVISO/.test(r.saida), 'os dois cabeçalhos concordam');
    assert.equal(FORMATO_ESTRITO.formato, 'pares');
    assert.equal(FORMATO_ESTRITO.campoProvedor, 'provider');
  });

  await test('--url aceita o endereço com ou sem /v1 e com a barra final: sempre POST em /v1/chat/completions', async () => {
    for (const url of [omni.url, `${omni.url}/`, `${omni.url}/v1`, `${omni.url}/v1/`, `${omni.url}/v1/chat/completions`]) {
      omni.limpar();
      const r = await rodar(['--modelo', 'combo-teste', '--url', url]);
      assert.equal(r.codigo, CODIGOS.OK, `${url}: ${r.tudo}`);
      assert.deepEqual(omni.requisicoes.map((q) => [q.metodo, q.caminho]), [['POST', '/v1/chat/completions']], url);
    }
    // e a forma --nome=valor
    omni.limpar();
    const r = await rodar([`--modelo=combo-igual`, `--url=${omni.url}`, '--timeout=5']);
    assert.equal(r.codigo, CODIGOS.OK, r.tudo);
    assert.equal(omni.requisicoes[0].modelo, 'combo-igual');
  });

  await test('--permitidos: o apelido lido é conferido contra a lista (sem diferenciar maiúsculas): na lista = 0; fora da lista = 8, com o motivo dito', async () => {
    omni.limpar();
    const ok = await rodar(comOmni(['--permitidos', 'Groq, GEMINI-CLI']));
    assert.equal(ok.codigo, CODIGOS.OK, ok.tudo);
    assert.match(ok.saida, /e ele está na lista de --permitidos/);
    assert.match(ok.saida, /Permitidos:\s+groq, gemini-cli/);
    const fora = await rodar(comOmni(['--permitidos', 'groq,openai']));
    assert.equal(fora.codigo, CODIGOS.FORA_DA_LISTA, fora.tudo);
    assert.match(fora.saida, /nomeia UM provedor \("gemini-cli"\), mas ele NÃO está na lista de --permitidos \(groq, openai\)/);
    assert.match(fora.saida, /RESULTADO: falhou \(código de saída 8\)/);
    omni.definir({ provedor: 'anonimo-x' });
    const outro = await rodar(comOmni(['--permitidos', 'gemini-cli,groq']));
    assert.equal(outro.codigo, CODIGOS.FORA_DA_LISTA);
    assert.match(outro.saida, /"anonimo-x"/);
  });

  await test('--repetir: N chamadas; com um combo de fallback (o provedor muda) o resumo diz que MUDOU e lista os vistos; com o mesmo provedor diz que foi o MESMO', async () => {
    omni.limpar();
    omni.definir({ modo: 'rodizio', provedores: ['gemini-cli', 'groq'] });
    const muda = await rodar(comOmni(['--repetir', '4']));
    assert.equal(muda.codigo, CODIGOS.OK, muda.tudo);
    assert.equal(omni.requisicoes.length, 4);
    assert.match(muda.saida, /Chamada 1 de 4/);
    assert.match(muda.saida, /Chamada 4 de 4/);
    assert.match(muda.saida, /Provedores vistos:\s+gemini-cli, groq/);
    assert.match(muda.saida, /O provedor MUDOU entre as chamadas/);
    assert.match(muda.saida, /Com um provedor lido:\s+4/);
    omni.limpar();
    const igual = await rodar(comOmni(['--repetir', '3']));
    assert.equal(igual.codigo, CODIGOS.OK);
    assert.equal(omni.requisicoes.length, 3);
    assert.match(igual.saida, /O provedor foi o MESMO em todas as chamadas/);
    assert.ok(!/MUDOU/.test(igual.saida));
    // com a lista, a chamada que cai fora dá o código 8 (o primeiro diferente de zero), mas todas são feitas e relatadas
    omni.limpar();
    omni.definir({ modo: 'rodizio', provedores: ['gemini-cli', 'groq'] });
    const parcial = await rodar(comOmni(['--repetir', '3', '--permitidos', 'gemini-cli']));
    assert.equal(parcial.codigo, CODIGOS.FORA_DA_LISTA, parcial.tudo);
    assert.equal(omni.requisicoes.length, 3);
    assert.match(parcial.saida, /Chamada 3 de 3/);
  });

  await test('o X-OmniRoute-Provider que discorda do provider da decisão vira um AVISO (o apelido lido continua sendo o da decisão)', async () => {
    omni.limpar();
    omni.definir({ provedorDoCabecalho: 'outro-provedor' });
    const r = await rodar(comOmni());
    assert.equal(r.codigo, CODIGOS.OK, r.tudo);
    assert.match(r.saida, /AVISO: o X-OmniRoute-Provider \(outro-provedor\) difere do provider do X-OmniRoute-Decision \(gemini-cli\)/);
    omni.limpar();
    omni.definir({ cabecalhoProvider: false });
    const sem = await rodar(comOmni());
    assert.equal(sem.codigo, CODIGOS.OK);
    assert.match(sem.saida, /X-OmniRoute-Provider:\s+\(não veio\)/);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('C. Os vereditos e os códigos de saída');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('cabeçalho que não veio = 6; o que a Yui não consegue ler (sem o provider, repetido, JSON, texto estranho, segredo) = 7: o veredito diz o que faltou', async () => {
    const casos = [
      [{ modo: 'ausente' }, CODIGOS.SEM_CABECALHO, /NÃO enviou o cabeçalho X-OmniRoute-Decision.*o perfil privado não pode ser ligado/],
      [{ modo: 'sem-provider' }, CODIGOS.CABECALHO_INVALIDO, /não tem o campo "provider"/],
      [{ modo: 'duplicado' }, CODIGOS.CABECALHO_INVALIDO, /repete algum campo/],
      [{ modo: 'json' }, CODIGOS.CABECALHO_INVALIDO, /não segue o formato/],
      [{ modo: 'estranho' }, CODIGOS.CABECALHO_INVALIDO, /não segue o formato/],
      [{ modo: 'bruto', valorBruto: '   ' }, CODIGOS.SEM_CABECALHO, /NÃO enviou/],
      [{ modo: 'segredo' }, CODIGOS.CABECALHO_INVALIDO, /não segue o formato/],
      [{ modo: 'segredo-no-provedor' }, CODIGOS.CABECALHO_INVALIDO, /não parece o apelido de um provedor/],
      [{ modo: 'bruto', valorBruto: 'strategy=single; provider=Gemini Cli; latency_ms=1' }, CODIGOS.CABECALHO_INVALIDO, /não segue o formato/],
    ];
    for (const [defs, codigo, padrao] of casos) {
      omni.limpar();
      omni.definir(defs);
      const r = await rodar(comOmni());
      assert.equal(r.codigo, codigo, `${JSON.stringify(defs)}: ${r.tudo}`);
      assert.match(r.saida, padrao, JSON.stringify(defs));
      assert.match(r.saida, new RegExp(`RESULTADO: falhou \\(código de saída ${codigo}\\)`));
      assert.equal(omni.requisicoes.length, 1);
    }
  });

  await test('o servidor que erra: HTTP de erro, corpo que não é uma resposta de chat ou resposta vazia = 5; sem resposta (queda, tempo esgotado, porta fechada) = 4', async () => {
    const http = [
      [{ status: 500 }, /HTTP 500: erro do servidor/],
      [{ status: 429 }, /HTTP 429: limite ou cota/],
      [{ status: 401 }, /HTTP 401: a chave foi recusada/],
      [{ status: 404 }, /HTTP 404: modelo ou rota não encontrados/],
      [{ corpoInvalido: true }, /não é uma resposta de chat válida/],
      [{ vazio: true }, /veio vazia/],
    ];
    for (const [defs, padrao] of http) {
      omni.limpar();
      omni.definir(defs);
      const r = await rodar(comOmni());
      assert.equal(r.codigo, CODIGOS.ERRO_HTTP, `${JSON.stringify(defs)}: ${r.tudo}`);
      assert.match(r.saida, padrao, JSON.stringify(defs));
    }
    // a chave errada: o servidor recusa com 401 (e repete a chave no erro, se for o caso: o script não imprime o corpo)
    omni.limpar();
    const errada = await rodar(comOmni(), { chave: 'sk-omni-OUTRA-CHAVE-0123456789abcdef' });
    assert.equal(errada.codigo, CODIGOS.ERRO_HTTP);
    assert.match(errada.saida, /HTTP 401/);
    assert.equal(omni.requisicoes[0].papel, 'chave-errada');
    assert.ok(!errada.tudo.includes('OUTRA-CHAVE'), 'a chave errada também nunca é impressa');
    // sem resposta
    omni.limpar();
    omni.definir({ cair: true });
    const queda = await rodar(comOmni());
    assert.equal(queda.codigo, CODIGOS.SEM_RESPOSTA, queda.tudo);
    assert.match(queda.saida, /sem resposta do servidor/);
    omni.limpar();
    omni.definir({ travar: true });
    const lento = await rodar(comOmni(['--timeout', '0.5']));
    assert.equal(lento.codigo, CODIGOS.SEM_RESPOSTA, lento.tudo);
    assert.match(lento.saida, /sem resposta do servidor: tempo esgotado/);
    const porta = await portaFechada();
    const recusada = await rodar(['--modelo', 'x', '--url', `http://127.0.0.1:${porta}`]);
    assert.equal(recusada.codigo, CODIGOS.SEM_RESPOSTA, recusada.tudo);
    assert.match(recusada.saida, /conexão recusada/);
  });

  await test('com --repetir, a chamada que o servidor recusa ou não responde PARA as outras (repetir não resolve); o código é o do primeiro erro', async () => {
    omni.limpar();
    omni.definir({ status: 401 });
    const recusada = await rodar(comOmni(['--repetir', '5']));
    assert.equal(recusada.codigo, CODIGOS.ERRO_HTTP);
    assert.equal(omni.requisicoes.length, 1, 'só a primeira chamada');
    assert.match(recusada.saida, /as 4 chamadas restantes foram canceladas/);
    omni.limpar();
    omni.definir({ cair: true });
    const queda = await rodar(comOmni(['--repetir', '3']));
    assert.equal(queda.codigo, CODIGOS.SEM_RESPOSTA);
    assert.equal(omni.requisicoes.length, 1);
    // o cabeçalho que falta, ao contrário, não impede as outras (o resumo mostra quantas deram certo)
    omni.limpar();
    omni.definir({ modo: 'ausente' });
    const ausente = await rodar(comOmni(['--repetir', '3']));
    assert.equal(ausente.codigo, CODIGOS.SEM_CABECALHO);
    assert.equal(omni.requisicoes.length, 3);
    assert.match(ausente.saida, /Com um provedor lido:\s+0/);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('D. A chave nunca é impressa; um segredo no cabeçalho também não');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('um servidor que REPETE a chave recebida (no cabeçalho de decisão, no X-OmniRoute-Provider, no corpo e nos erros): nada disso é impresso, em nenhum veredito', async () => {
    const cenarios = [{}, { modo: 'ausente' }, { modo: 'json' }, { modo: 'estranho' }, { status: 500 }, { status: 401 }, { vazio: true }, { corpoInvalido: true }, { modo: 'sem-provider' }, { modo: 'duplicado' }];
    for (const extra of cenarios) {
      omni.limpar();
      omni.definir({ ecoaChave: true, ...extra });
      const r = await rodar(comOmni(['--repetir', '2', '--permitidos', 'gemini-cli']));
      semChave(`a saída de ${JSON.stringify(extra)}`, r.tudo);
      assert.ok(omni.requisicoes.length >= 1);
    }
    // o X-OmniRoute-Provider que é a própria chave não vira "apelido" na saída
    omni.limpar();
    omni.definir({ ecoaChave: true });
    const r = await rodar(comOmni());
    assert.match(r.saida, /X-OmniRoute-Provider:\s+\[apagado\]/);
    assert.match(r.saida, /chave=\[apagado\]/);
    assert.equal(r.codigo, CODIGOS.OK, 'o campo extra não atrapalha o apelido');
  });

  await test('uma chave SEM cara de chave (sem prefixo, curta, que nenhum padrão reconhece): só a redação exata a protege, e ela funciona contra o servidor que a repete em todo lugar', async () => {
    const chavePura = 'Zq7-meu-valor-0001';
    const outro = await criarOmniRouteCabecalhoFalso({ chave: chavePura });
    bloqueio.portaDoTeste(outro.port);
    try {
      for (const extra of [{}, { modo: 'ausente' }, { modo: 'json' }, { status: 500 }, { modo: 'sem-provider' }]) {
        outro.limpar();
        outro.definir({ ecoaChave: true, ...extra });
        const r = await rodar(['--modelo', 'combo-teste', '--url', outro.url, '--repetir', '2'], { chave: chavePura });
        assert.ok(outro.requisicoes.length >= 1 && outro.requisicoes[0].papel === 'chave-certa', 'o servidor recebeu a chave certa');
        semChave(`a saída de ${JSON.stringify(extra)} com a chave sem prefixo`, r.tudo, chavePura);
      }
    } finally { await outro.close(); }
  });

  await test('um segredo plantado no cabeçalho (outros campos e no provider) nunca aparece: só estratégia, apelido e latência de aparência segura são mostrados', async () => {
    for (const modo of ['segredo', 'segredo-no-provedor']) {
      omni.limpar();
      omni.definir({ modo });
      const r = await rodar(comOmni());
      assert.equal(r.codigo, CODIGOS.CABECALHO_INVALIDO, r.tudo);
      semSegredo(`a saída (${modo})`, r.tudo);
      semChave(`a saída (${modo})`, r.tudo);
      assert.match(r.saida, /X-OmniRoute-Decision:\s+strategy=single; /);
      assert.match(r.saida, /\[apagado\]/);
    }
    // e um segredo plantado em OUTRO formato (JSON, texto livre) também fica de fora
    for (const valorBruto of [JSON.stringify({ provider: 'groq', token: SEGREDO_NO_CABECALHO }), `texto livre com ${SEGREDO_NO_CABECALHO} no meio`, `provider=groq; chave=${CHAVE_DE_TESTE}`]) {
      omni.limpar();
      omni.definir({ modo: 'bruto', valorBruto });
      const r = await rodar(comOmni());
      semSegredo('a saída (bruto)', r.tudo);
      semChave('a saída (bruto)', r.tudo);
    }
  });

  await test('NENHUMA saída de NENHUM processo deste teste contém a chave (nem pedaços de 10 caracteres dela), nem o segredo plantado, nem o texto da resposta do servidor', async () => {
    assert.ok(todas.length >= 40, `foram ${todas.length} execuções do script`);
    for (const t of todas) {
      semChave(`a saída de ${JSON.stringify(t.args.map((a) => String(a).slice(0, 14)))}`, t.tudo);
      semSegredo(`a saída de ${JSON.stringify(t.args.map((a) => String(a).slice(0, 14)))}`, t.tudo);
      assert.ok(!/recebi a chave|erro simulado|chave inválida/.test(t.tudo), 'o texto do corpo da resposta do servidor nunca é impresso');
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════
  section('E. As peças puras do script');
  // ═════════════════════════════════════════════════════════════════════════════════════
  await test('redigir: apaga a chave inteira, pedaços dela de 10 caracteres e o que tem cara de segredo; o texto comum fica igual', () => {
    const k = CHAVE_DE_TESTE;
    assert.ok(!redigir(`a chave é ${k} mesmo`, k).includes(k));
    assert.ok(!redigir(`${k}${k}`, k).includes(k.slice(0, 10)));
    assert.ok(!redigir(`pedaço ${k.slice(5, 25)} solto`, k).includes(k.slice(5, 15)));
    for (const s of ['Bearer abc.def.ghi', 'sk-abcdef123456', 'gsk_abcdefghijk', 'AIzaSyA-1234567890abc', `eyJhbGciOiJIUzI1NiJ9.${'a'.repeat(20)}.xyz`, 'a'.repeat(40)]) assert.ok(redigir(`x ${s} y`, '').includes('[apagado]'), s);
    for (const comum of ['Status HTTP: 200', 'strategy=single; provider=gemini-cli; latency_ms=120', 'http://127.0.0.1:20128/v1/chat/completions', 'o cabeçalho nomeia UM provedor ("groq").']) assert.equal(redigir(comum, k), comum);
    assert.equal(redigir(null, k), '');
    assert.equal(redigir('texto', ''), 'texto');
    assert.equal(redigir('texto', 'abc'), 'texto', 'uma chave curtíssima não apaga nada por engano (só valores de 4 caracteres ou mais)');
  });

  await test('mostrarCabecalho: só strategy, provider e latency_ms de aparência segura; tudo o mais vira [apagado]; nunca devolve o valor bruto; ausente = null', () => {
    const k = CHAVE_DE_TESTE;
    assert.equal(mostrarCabecalho(null, k), null);
    assert.equal(mostrarCabecalho(undefined, k), null);
    assert.equal(mostrarCabecalho('   ', k), '(vazio)');
    assert.equal(mostrarCabecalho('strategy=single; provider=gemini-cli; latency_ms=120', k), 'strategy=single; provider=gemini-cli; latency_ms=120');
    assert.equal(mostrarCabecalho('strategy=priority; provider=groq; latency_ms=5; extra=1', k), 'strategy=priority; provider=groq; latency_ms=5; extra=[apagado]');
    assert.equal(mostrarCabecalho(`strategy=single; provider=${SEGREDO_NO_CABECALHO}; latency_ms=7`, k), 'strategy=single; provider=[apagado]; latency_ms=7');
    assert.equal(mostrarCabecalho(`provider=${k}`, k), 'provider=[apagado]');
    assert.equal(mostrarCabecalho('strategy=single; provider=gemini-cli; latency_ms=abc', k), 'strategy=single; provider=gemini-cli; latency_ms=[apagado]');
    assert.equal(mostrarCabecalho(`api_key=${SEGREDO_NO_CABECALHO}; nota=Bearer ${SEGREDO_NO_CABECALHO}`, k), '[apagado]=[apagado]; nota=[apagado]');
    assert.match(mostrarCabecalho('um texto livre qualquer', k), /^\[apagado: texto livre de 23 caracteres\]$/);
    assert.match(mostrarCabecalho('x'.repeat(500), k), /^\[apagado: valor longo demais/);
    assert.match(mostrarCabecalho('a=1\u0007; b=2', k), /^\[apagado: valor longo demais ou com caracteres de controle\]$/);
    // JSON: só os nomes dos campos e os valores dos três campos conhecidos
    const j = JSON.parse(mostrarCabecalho(JSON.stringify({ provider: 'groq', strategy: 'single', latency_ms: 9, token: SEGREDO_NO_CABECALHO, nested: { provider: SEGREDO_NO_CABECALHO } }), k));
    assert.equal(j.provider, 'groq');
    assert.equal(j.strategy, 'single');
    assert.equal(j.latency_ms, '9');
    assert.equal(JSON.stringify(j).includes('SEGREDO'), false);
    assert.match(mostrarCabecalho('{isto não é json', k), /^\[apagado: texto livre/);
  });

  await test('lerArgumentos: os padrões, as formas --nome valor e --nome=valor, os limites e a chave que nunca entra', () => {
    const base = lerArgumentos(['--modelo', 'combo-1']);
    assert.deepEqual([base.ok, base.endpoint, base.modelo, base.permitidos, base.repetir, base.timeoutMs], [true, 'http://127.0.0.1:20128/v1/chat/completions', 'combo-1', null, 1, 30_000]);
    const todos = lerArgumentos(['--modelo=auto/best-chat', '--url', 'https://omni.exemplo.local:8443/', '--permitidos', 'A,b,a', '--repetir=20', '--timeout', '0,5']);
    assert.deepEqual([todos.ok, todos.endpoint, todos.modelo, todos.permitidos, todos.repetir, todos.timeoutMs], [true, 'https://omni.exemplo.local:8443/v1/chat/completions', 'auto/best-chat', ['a', 'b'], 20, 500]);
    assert.equal(lerArgumentos(['--ajuda']).ajuda, true);
    assert.equal(lerArgumentos(['-h']).ajuda, true);
    for (const ruim of [['--modelo', 'x', '--chave', 'sk-abc'], ['--modelo', 'x', '--token=abc'], [], ['--url', 'x']]) assert.equal(lerArgumentos(ruim).ok, false, JSON.stringify(ruim));
    assert.match(lerArgumentos(['--modelo', 'x', '--chave=sk-1234567890abcdef']).erro, /OMNIROUTE_KEY/);
    assert.ok(!JSON.stringify(lerArgumentos(['--modelo', 'x', '--chave=sk-1234567890abcdef'])).includes('1234567890'));
  });

  await test('o script e o leitor da Yui concordam no formato REAL: o cabeçalho do OmniRoute 3.8.52 é lido pelo leitor estrito com a definição "pares" e o campo "provider"', async () => {
    const { lerDecisaoEstrita } = await import('../src/core/ai/decisaoOmniRoute.js');
    assert.deepEqual(lerDecisaoEstrita('strategy=single; provider=gemini-cli; latency_ms=812', FORMATO_ESTRITO), { ok: true, provedor: 'gemini-cli' });
    assert.deepEqual(lerDecisaoEstrita('strategy=priority;provider=groq;latency_ms=3', FORMATO_ESTRITO), { ok: true, provedor: 'groq' });
    assert.equal(lerDecisaoEstrita('strategy=single; latency_ms=812', FORMATO_ESTRITO).motivo, 'campo-ausente');
    assert.equal(lerDecisaoEstrita('strategy=single; provider=a; provider=b', FORMATO_ESTRITO).motivo, 'formato-desconhecido');
    assert.equal(lerDecisaoEstrita(null, FORMATO_ESTRITO).motivo, 'cabecalho-ausente');
  });
} finally {
  try { await omni.close(); } catch { /* */ }
  try { bloqueio.fechar('test:scriptcabecalho'); } catch (err) { failures.push(`bloqueio: ${String(err?.message ?? err).split('\n')[0]}`); say(`  FALHA o bloqueio de integração externa registrou tentativas:\n        ${String(err?.message ?? err).split('\n').slice(0, 6).join('\n        ')}`); }
}
if (failures.length) { say(`\n${failures.length} FALHA(S): ${failures.join(' | ')}`); process.exit(1); }
say(`\n${passed} testes OK`);
process.exit(0);
