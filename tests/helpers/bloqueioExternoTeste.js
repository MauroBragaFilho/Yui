// Lado do TESTE (processo pai) do bloqueio de integração externa (tests/helpers/bloqueioExterno.mjs, carregado só nos processos filhos).
// Sem efeitos ao importar. Uso nos testes com processos de verdade:
//   const bloqueio = criarBloqueio(pastaTemporaria, { teste: 'test:separacao', liberar: { 'programa:icacls': 'o motivo', ... } });
//   spawn(process.execPath, [...bloqueio.argv, 'src/cerebro.js'], { env: { ...env, ...bloqueio.env('cerebro') } });
//   bloqueio.conferir('depois do cenário X');   // lança (FALHA ALTO) se algum filho tentou rede, DNS, UDP, processo ou worker
//
// Segunda revisão da Liz (§12): NÃO existe exceção global. Cada teste declara só o que ele precisa (`liberar`, com o MOTIVO de cada exceção),
// e o registro guarda qual teste abriu cada exceção (a declaração, no arquivo das liberações, quando o bloqueio é criado) e cada uso dela
// (o filho anota). As exceções aceitas são as do bloqueioExterno.mjs: "programa:<nome>", "worker:parseWorker" e "node:com-bloqueio".
// `herdar: true` põe o bloqueio também no NODE_OPTIONS dos filhos: um processo do Node aberto por eles (o supervisor abrindo o cérebro e o bot)
// carrega o mesmo bloqueio (exige "node:com-bloqueio").
// Teste que roda tudo NUM processo só (o canal de verdade no loopback, como o test:memoriaadmin): `rodarSobBloqueio` relança o próprio arquivo
// com o bloqueio carregado e confere o registro no fim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { lerRegistro, excecoesDe } from './coberturaBloqueio.mjs';

/** URL do módulo de bloqueio (para o `--import` dos processos filhos). */
export const BLOQUEIO_URL = pathToFileURL(path.join(import.meta.dirname, 'bloqueioExterno.mjs')).href;

/** As exceções que um teste pode declarar (as que o bloqueioExterno.mjs entende). */
const EXCECAO_RE = /^(programa:[a-z0-9_.-]{1,40}|worker:parseWorker|node:com-bloqueio|nome-local:[a-z0-9.-]{1,60}|ip-da-maquina)$/;

/** As exceções do canal cérebro <-> bot no Windows (src/core/channel/secret.js restringe a permissão do arquivo do segredo). */
export const EXCECOES_DO_CANAL = Object.freeze({
  'programa:icacls': 'o canal cérebro <-> bot restringe a permissão do arquivo do segredo (src/core/channel/secret.js; sem rede)',
  'programa:whoami': 'o canal descobre o usuário atual para a permissão do arquivo do segredo (sem rede)',
});

const lerLinhas = (arquivo) => { try { return fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** As tentativas BLOQUEADAS registradas no arquivo (cada uma: { tipo, alvo, teste, papel, pid, at }). */
export function lerBloqueios(arquivo) {
  return lerLinhas(arquivo);
}

/** Lança (falha alto) se algum processo do teste tentou uma integração externa. */
export function conferirBloqueio(arquivo, onde = '') {
  const linhas = lerBloqueios(arquivo);
  if (linhas.length) {
    throw new Error(`INTEGRAÇÃO EXTERNA TENTADA num teste de arquitetura${onde ? ` (${onde})` : ''}: ${linhas.length} tentativa(s) bloqueada(s):\n${linhas.slice(0, 20).map((l) => JSON.stringify(l)).join('\n')}`);
  }
  return 0;
}

/**
 * O bloqueio de um teste: os argumentos do `node` dos filhos, as variáveis de cada filho e a conferência.
 * @param {string} pasta  pasta temporária do teste (o registro, as liberações e as portas ficam nela)
 * @param {{ teste?: string, liberar?: Record<string, string>, herdar?: boolean }} [o]
 *   `teste`: o nome do teste (vai em cada linha do registro); `liberar`: { exceção: motivo } (só o que ESTE teste precisa);
 *   `herdar`: o bloqueio também no NODE_OPTIONS (os netos do Node continuam bloqueados)
 */
export function criarBloqueio(pasta, { teste = path.basename(process.argv[1] ?? 'teste'), liberar = {}, herdar = false } = {}) {
  const registro = path.join(pasta, 'bloqueio-externo.jsonl');
  const portas = path.join(pasta, 'bloqueio-portas.txt');
  const liberacoes = path.join(pasta, 'bloqueio-liberacoes.jsonl');
  fs.mkdirSync(pasta, { recursive: true });
  fs.writeFileSync(portas, '');
  const excecoes = Object.entries(liberar ?? {});
  for (const [excecao, motivo] of excecoes) {
    if (!EXCECAO_RE.test(excecao)) throw new Error(`criarBloqueio: exceção desconhecida "${excecao}" (aceitas: programa:<nome>, worker:parseWorker, node:com-bloqueio, nome-local:<nome>, ip-da-maquina).`);
    if (!String(motivo ?? '').trim()) throw new Error(`criarBloqueio: a exceção "${excecao}" precisa de um motivo.`);
  }
  // REGISTRO ÚNICO (tests/externos.json): uma exceção só vale se o registro a declara PARA ESTE TESTE, com o recurso e a justificativa. Nada de exceção global
  // nem de exceção escondida no código de um teste.
  if (excecoes.length) {
    const declaradas = new Set(excecoesDe(lerRegistro(), teste).map((e) => e.excecao));
    const faltam = excecoes.map(([e]) => e).filter((e) => !declaradas.has(e));
    if (faltam.length) throw new Error(`criarBloqueio: o teste "${teste}" declarou a(s) exceção(ões) ${faltam.join(', ')} que NÃO está(ão) no registro tests/externos.json (excecoesDaCI: teste, excecao, recurso e justificativa).`);
  }
  if (herdar && !Object.hasOwn(liberar ?? {}, 'node:com-bloqueio')) throw new Error('criarBloqueio: herdar=true exige a exceção "node:com-bloqueio".');
  // O registro das liberações começa com a DECLARAÇÃO: qual teste abriu cada exceção, e por quê.
  fs.writeFileSync(liberacoes, excecoes.map(([excecao, motivo]) => JSON.stringify({ tipo: 'declarada', excecao, motivo: String(motivo), teste, at: new Date().toISOString() })).join('\n') + (excecoes.length ? '\n' : ''));
  const lista = excecoes.map(([e]) => e).join(',');
  let conferidas = 0;
  /**
   * Confere as tentativas NOVAS desde a última conferência. `esperados`: tentativas que o cenário ESPERA ver bloqueadas (ex.: o login de
   * verdade no Discord com o token falso, que o bloqueio impede antes de qualquer pacote sair). Cada esperado é { tipo, alvo: RegExp, motivo,
   * opcional? } e TEM de aparecer (a não ser que seja opcional); qualquer outra linha falha alto. Devolve as linhas esperadas encontradas.
   */
  const conferir = (onde, { esperados = [] } = {}) => {
    const todas = lerBloqueios(registro);
    const novas = todas.slice(conferidas);
    conferidas = todas.length;
    const casa = (l) => esperados.some((e) => e.tipo === l.tipo && e.alvo.test(String(l.alvo)));
    const fora = novas.filter((l) => !casa(l));
    if (fora.length) {
      throw new Error(`INTEGRAÇÃO EXTERNA TENTADA num teste de arquitetura${onde ? ` (${onde})` : ''}: ${fora.length} tentativa(s) bloqueada(s):\n${fora.slice(0, 20).map((l) => JSON.stringify(l)).join('\n')}`);
    }
    for (const e of esperados) {
      if (e.opcional) continue;
      if (!novas.some((l) => l.tipo === e.tipo && e.alvo.test(String(l.alvo)))) throw new Error(`${onde}: a tentativa esperada (e bloqueada) não aconteceu: ${e.tipo} ${e.alvo} (${e.motivo})`);
    }
    return novas;
  };
  return {
    registro,
    liberacoes,
    teste,
    argv: ['--import', BLOQUEIO_URL],
    env: (papel) => ({
      YUI_TESTE_BLOQUEIO_REGISTRO: registro, YUI_TESTE_BLOQUEIO_PORTAS: portas, YUI_TESTE_BLOQUEIO_PAPEL: papel,
      YUI_TESTE_BLOQUEIO_LIBERACOES: liberacoes, YUI_TESTE_BLOQUEIO_TESTE: teste, YUI_TESTE_BLOQUEIO_LIBERAR: lista,
      ...(herdar ? { NODE_OPTIONS: `--import=${BLOQUEIO_URL}` } : {}),
    }),
    conferir,
    /** Uma porta que o PRÓPRIO processo do teste abriu (ex.: o canal que o teste serve no papel do cérebro): os filhos podem conectar nela. */
    portaDoTeste: (porta) => { if (Number.isInteger(Number(porta)) && Number(porta) > 0) fs.appendFileSync(portas, `${Number(porta)}\n`); },
    lista: () => lerBloqueios(registro),
    /** As declarações e os usos das exceções deste teste. */
    usos: () => lerLinhas(liberacoes).filter((l) => l.tipo === 'uso'),
    declaradas: () => lerLinhas(liberacoes).filter((l) => l.tipo === 'declarada'),
    /** Resumo para o fim do teste: cada exceção declarada e quantas vezes foi usada (uma exceção nunca usada pode sair da lista). */
    resumo: () => {
      const usos = lerLinhas(liberacoes).filter((l) => l.tipo === 'uso');
      return excecoes.map(([excecao]) => ({ excecao, usos: usos.filter((u) => u.excecao === excecao).length }));
    },
  };
}

/**
 * O bloqueio numa pasta temporária PRÓPRIA (etapa 8, revisão da Liz: os testes de unidade que abrem um `node` auxiliar). Para o teste que não quer o
 * registro dentro da pasta que ele inspeciona (um diretório de bancos, de backup...). `fechar(onde)` confere o registro (FALHA ALTO se algum filho
 * tentou rede, DNS, UDP, programa ou worker), mostra as exceções declaradas e quantas vezes cada uma foi usada, e apaga a pasta.
 * Uso: const bloqueio = criarBloqueioTemporario({ teste: 'test:ownerlock', liberar: {} });
 *      spawn(process.execPath, [...bloqueio.argv, 'arquivo.js'], { env: { ...process.env, NODE_ENV: 'test', ...bloqueio.env('filho') } });
 *      bloqueio.fechar('fim');
 */
export function criarBloqueioTemporario(opcoes = {}) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-bloqueio-'));
  const b = criarBloqueio(pasta, opcoes);
  const limpar = () => { try { fs.rmSync(pasta, { recursive: true, force: true, maxRetries: 3 }); } catch { /* sobra em %TEMP%: inofensiva */ } };
  process.once('exit', limpar); // mesmo se o teste falhar antes do `fechar()`, a pasta temporária do bloqueio sai
  return {
    ...b,
    limpar,
    fechar(onde = '') {
      try {
        b.conferir(onde || b.teste);
        console.log(`  bloqueio de integração externa nos processos auxiliares: nenhuma tentativa; exceções declaradas: ${b.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ') || 'nenhuma'}`);
      } finally { limpar(); }
    },
  };
}

/**
 * Para um teste que roda tudo NUM processo só (ex.: o canal de verdade no loopback, dentro do próprio teste): relança o PRÓPRIO arquivo com o
 * bloqueio carregado (--import) e NODE_ENV=test. No processo do teste (o pai): cria o bloqueio numa pasta temporária, roda o filho, confere o
 * registro (falha alto se houver tentativa), mostra as exceções usadas, apaga a pasta e sai com o código do filho (esta função não volta).
 * No filho (o bloqueio já carregado): volta na hora, e o teste segue normalmente.
 * @param {string} urlDoTeste  import.meta.url do teste
 * @param {{ teste: string, liberar?: Record<string, string> }} o
 */
export function rodarSobBloqueio(urlDoTeste, { teste, liberar = {} } = {}) {
  if (String(process.env.YUI_TESTE_BLOQUEIO_REGISTRO ?? '').trim()) return; // já é o filho, com o bloqueio
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-bloqueio-'));
  let codigo = 1;
  try {
    const b = criarBloqueio(pasta, { teste, liberar });
    const r = spawnSync(process.execPath, [...b.argv, fileURLToPath(urlDoTeste)], { stdio: 'inherit', windowsHide: true, env: { ...process.env, NODE_ENV: 'test', ...b.env(teste) } });
    codigo = r.status ?? 1;
    try {
      b.conferir(teste);
      console.log(`  bloqueio de integração externa: nenhuma tentativa; exceções declaradas: ${b.resumo().map((x) => `${x.excecao} (${x.usos} uso(s))`).join(', ') || 'nenhuma'}`);
    } catch (err) {
      console.error(String(err?.message ?? err));
      codigo = 1;
    }
  } finally {
    try { fs.rmSync(pasta, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
  }
  process.exit(codigo);
}
