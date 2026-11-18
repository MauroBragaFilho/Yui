// A COBERTURA do bloqueio de integração externa nos testes (etapa 8, rodada depois da revisão da Liz, §12 do docs/RELATORIO_ETAPA8_PRE_PILOTO.md).
// Regra: nenhum teste normal (da CI) acessa um serviço externo em silêncio, e não existe exceção global. Este módulo é a FONTE ÚNICA da classificação de
// cada suíte da CI, usada pelo scripts/run-ci.mjs (que roda cada uma do jeito certo) e pelo tests/test-cobertura-bloqueio.js (que confere tudo contra o
// código). O registro das exceções e dos testes externos é o tests/externos.json.
//
// Cada suíte da CI está em UM destes modos:
//  - `proprio`: o teste (ou um teste que ele importa) cria o PRÓPRIO bloqueio para os processos auxiliares que abre (tests/helpers/bloqueioExternoTeste.js:
//    criarBloqueio, criarBloqueioTemporario ou rodarSobBloqueio);
//  - `envolvida`: o teste roda num processo só e NÃO abre os próprios bloqueios: o run-ci a abre com o bloqueio carregado (--import) e confere o registro no fim
//    (qualquer tentativa de rede, DNS, UDP, programa ou worker que não esteja declarada no registro derruba a suíte);
//  - `declarada`: não roda sob o bloqueio, e o registro (semBloqueio) diz por quê.
// Só este arquivo lê o registro; ele nunca importa código da Yui (só fs e path).
import fs from 'node:fs';
import path from 'node:path';

export const RAIZ = path.resolve(import.meta.dirname, '..', '..');
export const ARQUIVO_REGISTRO = path.join(RAIZ, 'tests', 'externos.json');

/** O registro único (tests/externos.json). */
export function lerRegistro(arquivo = ARQUIVO_REGISTRO) {
  const r = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  return { excecoesDaCI: r.excecoesDaCI ?? [], semBloqueio: r.semBloqueio ?? [], externos: r.externos ?? [], bruto: r };
}

/** Os scripts do package.json. */
export function lerScripts(raiz = RAIZ) {
  return JSON.parse(fs.readFileSync(path.join(raiz, 'package.json'), 'utf8')).scripts;
}

/** As suítes da CI normal (a lista SUITES do scripts/run-ci.mjs, lida do texto: o run-ci roda tudo ao ser importado). */
export function lerSuitesDaCI(raiz = RAIZ) {
  const texto = fs.readFileSync(path.join(raiz, 'scripts', 'run-ci.mjs'), 'utf8');
  const bloco = /export const SUITES = \[([\s\S]*?)\];/.exec(texto)?.[1];
  if (!bloco) throw new Error('não achei a lista SUITES no scripts/run-ci.mjs');
  return [...bloco.matchAll(/'(test:[a-z0-9-]+)'/g)].map((m) => m[1]);
}

/** O arquivo de teste de um script do package.json ("node tests/x.js" -> "tests/x.js"), ou null. */
export function arquivoDoScript(comando) {
  return /\btests\/[\w./-]+\.(?:js|mjs|ps1)\b/.exec(String(comando ?? ''))?.[0] ?? null;
}

// Só o USO de verdade (importar o ajudante ou CHAMAR as funções): uma menção em comentário ou texto não conta.
const USA_BLOQUEIO_RE = /from\s+['"][^'"]*bloqueioExternoTeste\.js['"]|\b(?:criarBloqueio|criarBloqueioTemporario|rodarSobBloqueio)\s*\(/;
const IMPORTA_TESTE_RE = /(?:import\s*\(\s*|from\s*|import\s+)['"](\.\/[\w.-]+\.(?:js|mjs))['"]/g;

/** O teste (ou um teste que ele importa, até 2 níveis) cria o próprio bloqueio para os processos que abre? */
export function usaBloqueio(arquivo, raiz = RAIZ, profundidade = 2, vistos = new Set()) {
  const completo = path.join(raiz, arquivo);
  if (vistos.has(completo) || !fs.existsSync(completo)) return false;
  vistos.add(completo);
  const texto = fs.readFileSync(completo, 'utf8');
  if (USA_BLOQUEIO_RE.test(texto)) return true;
  if (profundidade <= 0) return false;
  for (const m of texto.matchAll(IMPORTA_TESTE_RE)) {
    const alvo = path.posix.join(path.posix.dirname(arquivo.replace(/\\/g, '/')), m[1]);
    if (/^tests\/test-[\w-]+\.(?:js|mjs)$/.test(alvo) && usaBloqueio(alvo, raiz, profundidade - 1, vistos)) return true;
  }
  return false;
}

/** As exceções que o registro declara para um teste: [{ teste, excecao, recurso, justificativa }]. */
export function excecoesDe(registro, teste) {
  return registro.excecoesDaCI.filter((e) => e.teste === teste);
}

/**
 * Como a suíte da CI roda: `{ modo: 'proprio' | 'envolvida' | 'declarada', arquivo, excecoes }`.
 * `envolvida` leva as exceções que o registro declara para ela (a lista pode ser vazia).
 */
export function classificarSuite(nome, { scripts = lerScripts(), registro = lerRegistro(), raiz = RAIZ } = {}) {
  const comando = scripts[nome];
  if (!comando) throw new Error(`a suíte ${nome} não existe no package.json`);
  const arquivo = arquivoDoScript(comando);
  if (registro.semBloqueio.some((s) => s.teste === nome)) return { modo: 'declarada', arquivo, excecoes: [] };
  if (arquivo && usaBloqueio(arquivo, raiz)) return { modo: 'proprio', arquivo, excecoes: excecoesDe(registro, nome) };
  return { modo: 'envolvida', arquivo, excecoes: excecoesDe(registro, nome) };
}

/** As exceções de um teste no formato { excecao: justificativa }, que o criarBloqueio recebe. */
export function liberarDe(excecoes) {
  return Object.fromEntries(excecoes.map((e) => [e.excecao, e.justificativa]));
}

/** As exceções que um teste (ou o que ele importa) escreve no código: as strings 'programa:x', 'worker:parseWorker', 'node:com-bloqueio' e 'nome-local:x'. */
export function excecoesNoCodigo(arquivo, raiz = RAIZ) {
  const completo = path.join(raiz, arquivo);
  if (!fs.existsSync(completo)) return [];
  const texto = fs.readFileSync(completo, 'utf8');
  return [...new Set([...texto.matchAll(/['"`](programa:[a-z0-9_.-]{1,40}|worker:parseWorker|node:com-bloqueio|nome-local:[a-z0-9.-]{1,60}|ip-da-maquina)['"`]/g)].map((m) => m[1]))];
}
