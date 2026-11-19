// TAREFAS DO YUI DEV: o agente de código em segundo plano (Fase 4 de docs/PROPOSTA_FASES_YUI_UNIFICADA.md; docs/PREPARO_ITEM_7.md). PREPARADO e DESLIGADO
// (YUI_DEV_TAREFAS=false): este arquivo SÓ tem funções puras (a máquina de estados, as validações e o formato do pacote de revisão). Não executa comando, não lê nem grava
// arquivo, não abre rede e não cria branch: o EXECUTOR é uma interface (`executarTarefa`) que hoje devolve "não implementado".
//
// Uma TAREFA nasce do dono (só ele, só pelo app, pelo PC ou pela DM), numa lista permitida de projetos, e anda por estados:
//
//   pendente ─▶ preparando ─▶ rodando ─▶ revisao ─▶ aprovada | rejeitada
//       │           │            │          │
//       └───────────┴────────────┴──────────┴──▶ cancelada (o dono)          preparando e rodando ─▶ falhou (erro ou tempo esgotado)
//
// As regras da Fase 4, como validações: SÓ o dono; SÓ projeto da lista permitida; o trabalho acontece SEMPRE numa branch e num worktree ISOLADOS (nunca na `main`, nunca na pasta
// do projeto); push SÓ da branch da própria tarefa (nunca força, nunca apagar, nunca outro destino); tempo máximo; SÓ os executáveis da lista (a mesma do terminal da aba Código,
// sem shell); aprovação do dono para o que é destrutivo ou sai da máquina. A saída é um PACOTE DE REVISÃO (resumo, arquivos, diff limitado, resultado dos testes, branch): o dono
// aprova ou rejeita, e quem leva o trabalho para a `main` é o dono (a Yui nunca faz push na `main`). O modelo nunca concede permissão: tudo passa por aqui e pelo motor de políticas.
import crypto from 'node:crypto';
import path from 'node:path';
import { analyzeCommand } from './terminalSanitizer.js';
import { classifyCommand } from './policy.js';
import { isSensitive } from './workspace-fs.js';

export const ESTADOS_DA_TAREFA = Object.freeze(['pendente', 'preparando', 'rodando', 'revisao', 'aprovada', 'rejeitada', 'falhou', 'cancelada']);
export const ESTADOS_FINAIS = Object.freeze(['aprovada', 'rejeitada', 'falhou', 'cancelada']);
/** estado -> { evento: próximo estado }. */
export const TRANSICOES_DA_TAREFA = Object.freeze({
  pendente: Object.freeze({ preparar: 'preparando', cancelar: 'cancelada' }),
  preparando: Object.freeze({ iniciar: 'rodando', falhar: 'falhou', tempo_esgotado: 'falhou', cancelar: 'cancelada' }),
  rodando: Object.freeze({ entregar: 'revisao', falhar: 'falhou', tempo_esgotado: 'falhou', cancelar: 'cancelada' }),
  revisao: Object.freeze({ aprovar: 'aprovada', rejeitar: 'rejeitada', cancelar: 'cancelada' }),
  aprovada: Object.freeze({}), rejeitada: Object.freeze({}), falhou: Object.freeze({}), cancelada: Object.freeze({}),
});
export const EVENTOS_DA_TAREFA = Object.freeze(['preparar', 'iniciar', 'entregar', 'aprovar', 'rejeitar', 'cancelar', 'falhar', 'tempo_esgotado']);

export const LIMITES_DA_TAREFA = Object.freeze({
  tituloMax: 120, descricaoMax: 4000, tempoMaximoPadraoMs: 30 * 60_000, tempoMaximoMinMs: 60_000, tempoMaximoTetoMs: 2 * 60 * 60_000,
  resumoMax: 2000, arquivosMax: 200, caminhoMax: 260, diffMaxBytes: 100_000, saidaDosTestesMax: 4000, motivoMax: 500, historicoMax: 50,
});
/** Quem pode CRIAR tarefa: o dono, pelo app, pelo PC ou pela DM. Servidor público do Discord e chat de live nunca. */
export const CANAIS_QUE_CRIAM = Object.freeze(['app', 'pc', 'discord_dm']);
export const BRANCHES_PROTEGIDAS = Object.freeze(['main', 'master', 'develop', 'dev', 'trunk', 'prod', 'production', 'release', 'head']);
export const REMOTOS_PERMITIDOS = Object.freeze(['origin']);

const negar = (codigo, texto) => ({ ok: false, codigo, texto });
const SEM_CONTROLE_RE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

// ── A chave ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** As tarefas só ligam com YUI_DEV_TAREFAS=true E o módulo de código (YUI_DEV_ENABLED=true) ligado. @returns {{ ligado: boolean, motivo: string|null }} */
export function tarefasLigadas(env = process.env) {
  const ligada = (v) => String(v ?? 'false').trim().toLowerCase() === 'true';
  if (!ligada(env?.YUI_DEV_TAREFAS)) return { ligado: false, motivo: 'YUI_DEV_TAREFAS está desligada' };
  if (!ligada(env?.YUI_DEV_ENABLED)) return { ligado: false, motivo: 'o módulo de código (YUI_DEV_ENABLED) está desligado' };
  return { ligado: true, motivo: null };
}

// ── Quem e onde ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Só o dono (papel decidido pelo cérebro, nunca pelo texto), por um canal privado dele. */
export function validarSolicitante({ papel, canal } = {}) {
  if (papel !== 'dono') return negar('nao-e-o-dono', 'Só o dono pode criar tarefas do Yui Dev.');
  if (!CANAIS_QUE_CRIAM.includes(canal)) return negar('canal-nao-permitido', 'Tarefas do Yui Dev só podem ser criadas pelo app, pelo PC ou pela DM do dono.');
  return { ok: true };
}

/**
 * O projeto está na lista PERMITIDA (a mesma de src/core/dev/projects.js: YUI_PROJECTS ou o cadastro do app) e a pasta existe? O caminho nunca vem do pedido: só o id.
 * @param {string} id
 * @param {readonly (string | { id: string, exists?: boolean })[]} permitidos
 */
export function validarProjeto(id, permitidos) {
  const alvo = typeof id === 'string' ? id.trim().toLowerCase() : '';
  const lista = Array.isArray(permitidos) ? permitidos : [];
  const achado = alvo ? lista.find((p) => String(typeof p === 'string' ? p : p?.id ?? '').toLowerCase() === alvo) : null;
  if (!achado) return negar('projeto-fora-da-lista', 'Esse projeto não está na lista de projetos liberados.');
  if (typeof achado === 'object' && achado.exists === false) return negar('projeto-sem-pasta', 'A pasta desse projeto não existe mais.');
  return { ok: true, projeto: alvo };
}

// ── Branch e worktree isolados (nunca a main) ─────────────────────────────────────────────────────────────────────────────────────────

const BRANCH_RE = /^yui\/[a-z0-9][a-z0-9._-]{0,60}$/;
const semPrefixo = (nome) => String(nome ?? '').trim().replace(/^refs\/heads\//i, '').replace(/^(?:refs\/remotes\/)?origin\//i, '');

/** O nome é de uma branch que a tarefa pode usar? Só `yui/<id>-<assunto>` (uma branch só da Yui). `main` e as outras protegidas são recusadas com um código próprio. */
export function validarBranch(nome) {
  const texto = typeof nome === 'string' ? nome : ''; // sem "limpar": um nome com espaço ou quebra de linha não é um nome de branch da tarefa
  const limpo = semPrefixo(texto); // só para reconhecer as protegidas (" main ", "origin/main", "refs/heads/main")
  if (BRANCHES_PROTEGIDAS.includes(limpo.toLowerCase())) return negar('branch-protegida', 'A Yui nunca trabalha na main nem em outra branch protegida.');
  if (!BRANCH_RE.test(texto) || texto.includes('..') || texto.endsWith('.lock') || texto.endsWith('.')) return negar('branch-fora-do-padrao', 'A branch da tarefa precisa seguir o padrão yui/<id>-<assunto>.');
  return { ok: true, branch: texto };
}

const slug = (t) => String(t ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** O nome da branch de uma tarefa: yui/<id>-<assunto>. */
export function nomeDaBranch(id, titulo) {
  const base = String(id ?? '').replace(/^tar_/i, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'sem-id';
  const assunto = slug(titulo).slice(0, 36).replace(/-+$/, '') || 'tarefa';
  return `yui/${base}-${assunto}`;
}

const mesmaPasta = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
/**
 * O ambiente de trabalho é ISOLADO: o worktree fica DENTRO de `<projeto>/.yui/worktrees/<id da tarefa>` (nunca a pasta do projeto, nunca outra tarefa, nunca dentro de .git),
 * e a branch é a da tarefa (nunca a main). A conferência é só de CAMINHO (sem tocar o disco): o executor ainda confere o realpath.
 * @param {{ projetoPasta: string, worktree: string, branch: string, idDaTarefa?: string }} p
 */
export function validarAmbiente({ projetoPasta, worktree, branch, idDaTarefa } = {}) {
  const b = validarBranch(branch);
  if (!b.ok) return b;
  if (typeof projetoPasta !== 'string' || typeof worktree !== 'string' || !path.isAbsolute(projetoPasta) || !path.isAbsolute(worktree) || worktree.includes('\0') || projetoPasta.includes('\0')) {
    return negar('ambiente-invalido', 'A pasta do projeto e a do worktree precisam ser caminhos absolutos.');
  }
  const projeto = path.resolve(projetoPasta);
  const trabalho = path.resolve(worktree);
  if (mesmaPasta(projeto, trabalho)) return negar('worktree-e-o-projeto', 'O trabalho nunca acontece na pasta do projeto: só num worktree isolado.');
  const area = path.join(projeto, '.yui', 'worktrees');
  const rel = path.relative(area, trabalho);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).length !== 1) return negar('worktree-fora-da-area', 'O worktree precisa ficar em <projeto>/.yui/worktrees/<id da tarefa>.');
  if (rel.split(path.sep).some((p) => p === '.git')) return negar('worktree-fora-da-area', 'O worktree não pode ficar dentro de .git.');
  if (idDaTarefa !== undefined && rel !== idDaTarefa) return negar('worktree-de-outra-tarefa', 'O worktree precisa ter o id da própria tarefa.');
  return { ok: true, worktree: trabalho, branch: b.branch };
}

/** O que está com checkout agora é a branch da tarefa? O executor chama antes de cada `git add`/`git commit` (a decisão de comando não enxerga o HEAD). */
export function conferirBranchAtual(tarefa, branchAtual) {
  return semPrefixo(branchAtual) === tarefa?.branch && validarBranch(tarefa?.branch).ok ? { ok: true } : negar('na-branch-errada', 'O checkout não está na branch da tarefa: nada é gravado.');
}

// ── Push só da branch da tarefa ───────────────────────────────────────────────────────────────────────────────────────────────────────

const FLAGS_DE_PUSH_OK = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--porcelain', '--progress', '--no-progress']);
const FORCA_RE = /^(?:-f|--force(?:-with-lease|-if-includes)?(?:=.*)?|--no-force-with-lease)$/;
/**
 * O `git push` (argumentos depois de "git", ex.: ['push', '-u', 'origin', 'yui/abc-x']) só leva a branch DA TAREFA para um remoto permitido: sem força, sem apagar, sem `--all`, `--tags`
 * nem `--mirror`, sem destino diferente, e sempre com remoto e branch explícitos (um `git push` solto iria para onde o upstream aponta, que pode ser a main).
 */
export function validarPush({ branchDaTarefa, argv } = {}) {
  const b = validarBranch(branchDaTarefa);
  if (!b.ok) return b;
  if (!Array.isArray(argv) || argv[0] !== 'push' || argv.some((a) => typeof a !== 'string')) return negar('nao-e-push', 'Não é um comando git push.');
  const resto = argv.slice(1);
  const flags = resto.filter((a) => a.startsWith('-'));
  if (flags.some((a) => FORCA_RE.test(a))) return negar('forca-proibida', 'Push com força nunca é permitido.');
  if (flags.some((a) => /^(?:-d|--delete)$/.test(a))) return negar('delete-proibido', 'A Yui nunca apaga branch no remoto.');
  const ruim = flags.find((a) => !FLAGS_DE_PUSH_OK.has(a));
  if (ruim) return negar('flag-nao-permitida', `A opção ${ruim.slice(0, 30)} não é permitida no push da tarefa.`);
  const posicionais = resto.filter((a) => !a.startsWith('-'));
  if (posicionais.length !== 2) return negar('push-sem-destino-explicito', 'O push precisa dizer o remoto e a branch (git push <remoto> <branch>).');
  const [remoto, refspec] = posicionais;
  if (!REMOTOS_PERMITIDOS.includes(remoto)) return negar('remoto-nao-permitido', 'Só o remoto "origin" é permitido.');
  if (refspec.startsWith('+')) return negar('forca-proibida', 'Push com força (+) nunca é permitido.');
  const [origem, destino, ...sobra] = refspec.split(':');
  if (sobra.length) return negar('refspec-invalida', 'Destino do push inválido.');
  const ehDaTarefa = (r) => r === b.branch || r === `refs/heads/${b.branch}`; // exatamente a branch da tarefa (nada de origin/..., nem outra referência)
  if (destino === undefined) return ehDaTarefa(origem) ? { ok: true, remoto, branch: b.branch } : negar('branch-de-outra-tarefa', 'O push só leva a branch da própria tarefa.');
  if (origem === '') return negar('delete-proibido', 'A Yui nunca apaga branch no remoto.');
  if (!ehDaTarefa(destino) || !(ehDaTarefa(origem) || origem === 'HEAD')) return negar('branch-de-outra-tarefa', 'O push só leva a branch da própria tarefa, para a mesma branch.');
  return { ok: true, remoto, branch: b.branch };
}

// ── Tempo máximo ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** O tempo máximo pedido, ou o padrão (30 min). De 1 minuto a 2 horas. */
export function normalizarTempoMaximo(ms) {
  if (ms === undefined || ms === null) return { ok: true, tempoMaximoMs: LIMITES_DA_TAREFA.tempoMaximoPadraoMs };
  if (!Number.isInteger(ms) || ms < LIMITES_DA_TAREFA.tempoMaximoMinMs || ms > LIMITES_DA_TAREFA.tempoMaximoTetoMs) return negar('tempo-invalido', 'O tempo máximo precisa ser de 1 minuto a 2 horas.');
  return { ok: true, tempoMaximoMs: ms };
}
/** O relógio da tarefa começa ao sair de `pendente` e vale até ela sair de `preparando`/`rodando`. */
export function verificarPrazo(tarefa, agora = Date.now()) {
  if (!tarefa || !Number.isFinite(tarefa.comecouEm) || !Number.isFinite(tarefa.tempoMaximoMs)) return { estourou: false, restanteMs: null };
  const decorrido = agora - tarefa.comecouEm;
  return { estourou: decorrido > tarefa.tempoMaximoMs, restanteMs: Math.max(0, tarefa.tempoMaximoMs - decorrido) };
}

// ── Comandos: lista de executáveis e aprovação para o destrutivo ────────────────────────────────────────────────────────────────────────

const GIT_LEITURA = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'describe', 'shortlog', 'remote']);
const GIT_PEDE_APROVACAO = new Set(['restore', 'stash', 'merge', 'pull', 'fetch', 'cherry-pick', 'revert']);
const GIT_BRANCH_LISTA = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '-l', '--list', '--show-current']); // `git branch` só LISTA; qualquer outro argumento cria, apaga ou renomeia
const ok = (decisao, motivo) => ({ decisao, motivo });

function decidirGit(tarefa, args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += 1;
  const sub = String(args[i] ?? '').toLowerCase();
  const resto = args.slice(i + 1);
  if (GIT_LEITURA.has(sub)) return ok('allow', 'consulta');
  if (sub === 'branch') return resto.every((a) => GIT_BRANCH_LISTA.has(a)) ? ok('allow', 'consulta') : ok('deny', 'a Yui não cria, apaga nem renomeia branch por comando (só lista)');
  if (sub === 'tag') return resto.length ? ok('deny', 'a Yui não cria nem apaga tag') : ok('allow', 'consulta');
  // daqui para baixo o comando MUDA algo: só com uma tarefa que tenha a branch própria válida (uma tarefa com a branch trocada para a main não faz nada)
  if (!validarBranch(tarefa?.branch).ok) return ok('deny', 'a tarefa não tem uma branch própria válida: nada é gravado');
  if (sub === 'add' || sub === 'commit') return ok('allow', 'grava só no worktree da tarefa (confira a branch antes: conferirBranchAtual)');
  if (sub === 'checkout' || sub === 'switch') {
    if (resto.includes('--') || resto.includes('.')) return ok('ask', 'descarta alterações ainda não gravadas');
    const alvos = resto.filter((a) => !a.startsWith('-'));
    if (resto.some((a) => /^-(?:b|B|c|C|-orphan|-detach|d)$/.test(a)) || alvos.length !== 1 || alvos[0] !== tarefa?.branch) return ok('deny', 'a Yui só fica na branch da própria tarefa');
    return ok('allow', 'continua na branch da tarefa');
  }
  if (sub === 'push') {
    const v = validarPush({ branchDaTarefa: tarefa?.branch, argv: ['push', ...resto] });
    return v.ok ? ok('ask', 'envia a branch da tarefa ao remoto: o dono aprova') : ok('deny', v.texto);
  }
  if (GIT_PEDE_APROVACAO.has(sub)) return ok('ask', `git ${sub} muda o histórico ou descarta trabalho: o dono aprova`);
  return ok('deny', `git ${sub || '(sem subcomando)'} não é liberado nas tarefas`);
}

/**
 * Pode rodar este comando numa tarefa? 'allow' (consulta, teste, git add/commit na branch), 'ask' (o dono aprova no computador: instalar pacote, push, descartar ou reescrever
 * trabalho, qualquer comando que não é de consulta) ou 'deny' (fora da lista de executáveis, sintaxe de shell, perigoso, outra branch). SEM shell: a mesma análise do terminal
 * da aba Código (src/core/dev/terminalSanitizer.js), que ainda vale na hora de executar.
 * @returns {{ decisao: 'allow'|'ask'|'deny', motivo: string }}
 */
export function decidirComando(tarefa, comando, { env = process.env } = {}) {
  const analise = analyzeCommand(comando, { env });
  if (!analise.ok) return ok('deny', `comando não permitido: ${analise.reason}`);
  const tipo = classifyCommand(comando);
  if (tipo === 'dangerous' || tipo === 'invalid') return ok('deny', 'comando perigoso ou inválido');
  if (analise.exe === 'git') return decidirGit(tarefa, analise.args);
  if (analise.exe === 'npm') {
    const sub = analise.args.find((a) => !a.startsWith('-')) ?? '';
    if (/^(?:install|i|ci|uninstall|update)$/.test(sub)) return ok('ask', 'npm instala ou muda pacotes (roda scripts e baixa da rede): o dono aprova');
    if (sub === 'run' || sub === 'run-script') {
      const script = analise.args.filter((a) => !a.startsWith('-'))[1] ?? '';
      if (/^test(?::[\w-]+)?$/.test(script)) return ok('allow', 'roda os testes do projeto');
    }
  }
  return tipo === 'safe' ? ok('allow', 'consulta ou teste') : ok('ask', 'comando que não é de consulta: o dono aprova');
}

// ── O pacote de revisão ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const SEGREDOS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:api[_-]?key|secret|token|password|senha)\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}['"]?/gi,
];
/** Troca por "[segredo removido]" o que parece chave, token ou senha: o pacote vai ao app e à DM, e o diff nunca deve levar um segredo. */
export function mascararSegredos(texto) {
  return SEGREDOS.reduce((t, re) => t.replace(re, '[segredo removido]'), String(texto ?? ''));
}

/** Corta o diff em `max` BYTES (UTF-8) numa quebra de linha, sem partir um caractere, e avisa quanto ficou de fora. */
export function limitarDiff(diff, max = LIMITES_DA_TAREFA.diffMaxBytes) {
  const texto = mascararSegredos(diff);
  const total = Buffer.byteLength(texto, 'utf8');
  if (total <= max) return { texto, bytes: total, bytesOriginais: total, cortado: false };
  let corte = Buffer.from(texto, 'utf8').subarray(0, Math.max(0, max - 100)).toString('utf8').replace(/�+$/u, ''); // 100 bytes de reserva para o aviso: o total nunca passa de `max`
  const quebra = corte.lastIndexOf('\n');
  if (quebra > 0) corte = corte.slice(0, quebra);
  const aviso = `\n[... diff cortado: ${total - Buffer.byteLength(corte, 'utf8')} bytes a mais ficaram de fora ...]\n`;
  const final = `${corte}${aviso}`;
  return { texto: final, bytes: Buffer.byteLength(final, 'utf8'), bytesOriginais: total, cortado: true };
}

const SITUACOES = Object.freeze(['adicionado', 'modificado', 'removido', 'renomeado']);
/** O que o dono precisa olhar com cuidado: arquivos que rodam código no computador dele ou mudam a entrega. */
export function alertasDosArquivos(arquivos) {
  const alertas = new Set();
  for (const a of arquivos) {
    const c = a.caminho;
    if (/(^|\/)package\.json$/.test(c)) alertas.add('package-json-alterado');
    if (/(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(c)) alertas.add('lockfile-alterado');
    if (/^\.github\/workflows\//.test(c)) alertas.add('workflow-alterado');
    if (/(^|\/)(?:\.husky\/|\.gitattributes$|\.gitmodules$)/.test(c)) alertas.add('hook-ou-config-do-git-alterado');
    if (/\.(?:ps1|sh|bat|cmd)$/i.test(c)) alertas.add('script-do-sistema-alterado');
  }
  if (arquivos.filter((a) => a.situacao === 'removido').length > 20) alertas.add('muitas-remocoes');
  return [...alertas];
}

function validarArquivo(a, i, erros) {
  const base = `arquivos[${i}]`;
  if (!a || typeof a !== 'object' || Array.isArray(a)) { erros.push({ campo: base, codigo: 'arquivo-invalido', texto: 'Cada arquivo precisa ser um objeto.' }); return null; }
  const campos = Object.keys(a).filter((k) => !['caminho', 'situacao', 'adicoes', 'remocoes'].includes(k));
  if (campos.length) erros.push({ campo: base, codigo: 'campo-desconhecido', texto: 'Campo desconhecido no arquivo.' });
  const caminho = typeof a.caminho === 'string' ? a.caminho.replace(/\\/g, '/') : '';
  if (!caminho || caminho.length > LIMITES_DA_TAREFA.caminhoMax || /[\u0000-\u001f\u007f]/.test(caminho) || caminho.startsWith('/') || /^[a-zA-Z]:/.test(caminho) || caminho.split('/').some((p) => p === '..' || p === '')) {
    erros.push({ campo: `${base}.caminho`, codigo: 'caminho-invalido', texto: 'O caminho precisa ser relativo à raiz do projeto, sem "..".' });
    return null;
  }
  if (isSensitive(caminho)) { erros.push({ campo: `${base}.caminho`, codigo: 'arquivo-sensivel', texto: 'Um arquivo sensível (chaves, senhas, .git) não entra no pacote.' }); return null; }
  if (!SITUACOES.includes(a.situacao)) erros.push({ campo: `${base}.situacao`, codigo: 'situacao-invalida', texto: `A situação precisa ser: ${SITUACOES.join(', ')}.` });
  for (const k of ['adicoes', 'remocoes']) if (!Number.isInteger(a[k]) || a[k] < 0) erros.push({ campo: `${base}.${k}`, codigo: `${k}-invalidas`, texto: 'Contagem de linhas inválida.' });
  return { caminho, situacao: a.situacao, adicoes: a.adicoes, remocoes: a.remocoes };
}

/**
 * Monta e valida o PACOTE DE REVISÃO de uma tarefa: resumo, lista de arquivos, diff LIMITADO em tamanho (e sem segredos), resultado dos testes e a branch.
 * @param {{ tarefa: { id: string, projeto: string, branch: string }, resumo: string, arquivos: object[], diff: string, testes: object|null, commit?: string|null, base?: string }} entrada
 * @param {{ agora?: () => number }} [o]
 * @returns {{ ok: true, pacote: object } | { ok: false, erros: { campo: string|null, codigo: string, texto: string }[] }}
 */
export function montarPacoteDeRevisao({ tarefa, resumo, arquivos, diff, testes, commit = null, base = 'main' } = {}, { agora = Date.now } = {}) {
  const erros = [];
  const b = validarBranch(tarefa?.branch);
  if (!b.ok) erros.push({ campo: 'branch', codigo: b.codigo, texto: b.texto });
  if (typeof resumo !== 'string' || !resumo.trim() || resumo.length > LIMITES_DA_TAREFA.resumoMax || !SEM_CONTROLE_RE.test(resumo.replace(/[\r\n]/g, ' '))) erros.push({ campo: 'resumo', codigo: 'resumo-invalido', texto: `O resumo precisa ter de 1 a ${LIMITES_DA_TAREFA.resumoMax} caracteres.` });
  if (commit !== null && !/^[0-9a-f]{7,40}$/i.test(String(commit))) erros.push({ campo: 'commit', codigo: 'commit-invalido', texto: 'O commit precisa ser um hash de 7 a 40 caracteres.' });
  if (typeof base !== 'string' || !/^[A-Za-z0-9._/-]{1,60}$/.test(base)) erros.push({ campo: 'base', codigo: 'base-invalida', texto: 'Nome de branch base inválido.' });
  if (typeof diff !== 'string') erros.push({ campo: 'diff', codigo: 'diff-invalido', texto: 'O diff precisa ser um texto.' });

  let lista = [];
  if (!Array.isArray(arquivos) || !arquivos.length) erros.push({ campo: 'arquivos', codigo: 'sem-arquivos', texto: 'Um pacote de revisão precisa de pelo menos um arquivo alterado.' });
  else if (arquivos.length > LIMITES_DA_TAREFA.arquivosMax) erros.push({ campo: 'arquivos', codigo: 'arquivos-demais', texto: `No máximo ${LIMITES_DA_TAREFA.arquivosMax} arquivos por pacote.` });
  else lista = arquivos.map((a, i) => validarArquivo(a, i, erros)).filter(Boolean);

  let resultado;
  if (testes === null || testes === undefined) resultado = { semTestes: true };
  else if (typeof testes !== 'object' || Array.isArray(testes)) erros.push({ campo: 'testes', codigo: 'testes-invalidos', texto: '"testes" precisa ser um objeto (ou nulo, se o projeto não tem testes).' });
  else {
    const analise = analyzeCommand(testes.comando);
    if (!analise.ok) erros.push({ campo: 'testes.comando', codigo: 'comando-de-teste-invalido', texto: 'O comando dos testes precisa seguir a lista de executáveis permitidos.' });
    const inteiros = ['executados', 'passaram', 'falharam', 'duracaoMs'];
    if (inteiros.some((k) => !Number.isInteger(testes[k]) || testes[k] < 0) || testes.passaram + testes.falharam > testes.executados) erros.push({ campo: 'testes', codigo: 'contagem-de-testes-invalida', texto: 'As contagens dos testes são inconsistentes (passaram + falharam passa de executados).' });
    const saida = typeof testes.saidaFinal === 'string' ? mascararSegredos(testes.saidaFinal).slice(-LIMITES_DA_TAREFA.saidaDosTestesMax) : '';
    if (!erros.some((e) => e.campo?.startsWith('testes'))) {
      resultado = { comando: String(testes.comando).slice(0, 200), executados: testes.executados, passaram: testes.passaram, falharam: testes.falharam, duracaoMs: testes.duracaoMs, ok: testes.executados > 0 && testes.falharam === 0, saidaFinal: saida };
    }
  }

  if (erros.length) return { ok: false, erros };
  const d = limitarDiff(diff);
  const alertas = alertasDosArquivos(lista);
  if (d.cortado) alertas.push('diff-cortado');
  if (resultado.semTestes) alertas.push('sem-testes');
  else if (!resultado.ok) alertas.push('testes-falhando');
  return {
    ok: true,
    pacote: Object.freeze({
      versao: 1, tarefa: tarefa.id, projeto: tarefa.projeto, branch: b.branch, base, commit: commit === null ? null : String(commit).toLowerCase(), geradoEm: new Date(agora()).toISOString(),
      resumo: mascararSegredos(resumo).trim(), arquivos: Object.freeze(lista.map((a) => Object.freeze(a))),
      totais: Object.freeze({ arquivos: lista.length, adicoes: lista.reduce((s, a) => s + a.adicoes, 0), remocoes: lista.reduce((s, a) => s + a.remocoes, 0) }),
      diff: Object.freeze({ texto: d.texto, bytes: d.bytes, bytesOriginais: d.bytesOriginais, cortado: d.cortado }),
      testes: Object.freeze(resultado), alertas: Object.freeze(alertas),
    }),
  };
}

// ── A tarefa e a máquina de estados ───────────────────────────────────────────────────────────────────────────────────────────────────

const novoId = () => `tar_${crypto.randomBytes(5).toString('hex')}`;
const campoTexto = (v, max, codigo, rotulo) => {
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > max || !SEM_CONTROLE_RE.test(t.replace(/[\r\n\t]/g, ' '))) return negar(codigo, `${rotulo} precisa ter de 1 a ${max} caracteres.`);
  return { ok: true, valor: t };
};

/**
 * Cria uma tarefa PENDENTE (nada é executado). Recusa: chave desligada, quem não é o dono, canal não permitido, projeto fora da lista, título ou descrição inválidos, tempo fora do limite.
 * @param {{ projeto: string, titulo: string, descricao: string, tempoMaximoMs?: number }} pedido
 * @param {{ papel: string, canal: string, pessoa: string, projetosPermitidos: readonly (string|{id:string, exists?:boolean})[], env?: object, agora?: () => number, gerarId?: () => string }} ctx
 */
export function criarTarefa(pedido, { papel, canal, pessoa, projetosPermitidos, env = process.env, agora = Date.now, gerarId = novoId } = {}) {
  const liga = tarefasLigadas(env);
  if (!liga.ligado) return negar('desligado', 'As tarefas do Yui Dev estão desligadas.');
  const quem = validarSolicitante({ papel, canal });
  if (!quem.ok) return quem;
  if (!pedido || typeof pedido !== 'object' || Array.isArray(pedido)) return negar('pedido-invalido', 'O pedido da tarefa precisa ser um objeto.');
  const desconhecido = Object.keys(pedido).find((k) => !['projeto', 'titulo', 'descricao', 'tempoMaximoMs'].includes(k));
  if (desconhecido) return negar('campo-desconhecido', `Campo desconhecido no pedido: ${desconhecido.slice(0, 30)}.`); // inclusive "branch", "pasta" e "papel": nada disso vem do pedido
  const proj = validarProjeto(pedido.projeto, projetosPermitidos);
  if (!proj.ok) return proj;
  const t = campoTexto(pedido.titulo, LIMITES_DA_TAREFA.tituloMax, 'titulo-invalido', 'O título');
  if (!t.ok) return t;
  const d = campoTexto(pedido.descricao, LIMITES_DA_TAREFA.descricaoMax, 'descricao-invalida', 'A descrição');
  if (!d.ok) return d;
  const tempo = normalizarTempoMaximo(pedido.tempoMaximoMs);
  if (!tempo.ok) return tempo;
  const id = gerarId();
  const branch = validarBranch(nomeDaBranch(id, t.valor));
  if (!branch.ok) return branch;
  const em = agora();
  return {
    ok: true,
    tarefa: Object.freeze({
      id, estado: 'pendente', projeto: proj.projeto, titulo: t.valor, descricao: d.valor, solicitante: Object.freeze({ canal, pessoa: String(pessoa ?? '').slice(0, 96) }),
      branch: branch.branch, worktree: null, tempoMaximoMs: tempo.tempoMaximoMs, criadaEm: em, atualizadaEm: em, comecouEm: null, terminouEm: null, pacote: null, erro: null,
      historico: Object.freeze([Object.freeze({ de: null, para: 'pendente', evento: 'criar', em })]),
    }),
  };
}

/**
 * Aplica um evento a uma tarefa e devolve a tarefa NOVA (a antiga não muda). Eventos: preparar, iniciar ({ projetoPasta, worktree }), entregar ({ resumo, arquivos, diff, testes, commit, base }),
 * aprovar ({ papel, canal, ciente }), rejeitar ({ papel, canal, motivo }), cancelar ({ papel, canal }), falhar ({ codigo, texto }), tempo_esgotado (só vale se o prazo estourou de verdade).
 * Aprovar, rejeitar e cancelar são SÓ do dono, por um canal privado dele. Aprovar um pacote com testes falhando ou sem testes exige `ciente: true`.
 */
export function aplicarEvento(tarefa, evento, dados = {}, { agora = Date.now } = {}) {
  if (!tarefa || !ESTADOS_DA_TAREFA.includes(tarefa.estado)) return negar('tarefa-invalida', 'Tarefa inválida.');
  if (!EVENTOS_DA_TAREFA.includes(evento)) return negar('evento-desconhecido', 'Evento desconhecido.');
  const para = TRANSICOES_DA_TAREFA[tarefa.estado][evento];
  if (ESTADOS_FINAIS.includes(tarefa.estado)) return negar('tarefa-encerrada', 'A tarefa já terminou.');
  if (!para) return negar('transicao-invalida', `O evento "${evento}" não vale no estado "${tarefa.estado}".`);
  const em = agora();
  const muda = { estado: para, atualizadaEm: em };

  if (evento === 'aprovar' || evento === 'rejeitar' || evento === 'cancelar') {
    const quem = validarSolicitante({ papel: dados?.papel, canal: dados?.canal });
    if (!quem.ok) return quem;
  }
  if (evento === 'preparar') muda.comecouEm = em;
  if (evento === 'iniciar') {
    const amb = validarAmbiente({ projetoPasta: dados?.projetoPasta, worktree: dados?.worktree, branch: tarefa.branch, idDaTarefa: tarefa.id });
    if (!amb.ok) return amb;
    muda.worktree = amb.worktree;
  }
  if (evento === 'entregar') {
    const p = montarPacoteDeRevisao({ tarefa, resumo: dados?.resumo, arquivos: dados?.arquivos, diff: dados?.diff, testes: dados?.testes, commit: dados?.commit, base: dados?.base }, { agora: () => em });
    if (!p.ok) return { ok: false, codigo: 'pacote-invalido', texto: 'O pacote de revisão é inválido.', erros: p.erros };
    muda.pacote = p.pacote;
  }
  if (evento === 'aprovar') {
    if (!tarefa.pacote) return negar('sem-pacote', 'Não há pacote de revisão para aprovar.');
    const limpo = tarefa.pacote.testes?.ok === true;
    if (!limpo && dados?.ciente !== true) return negar('ciente-necessario', 'Os testes falharam ou não existem: aprovar exige a confirmação explícita do dono (ciente).');
  }
  if (evento === 'rejeitar' && dados?.motivo !== undefined && (typeof dados.motivo !== 'string' || dados.motivo.length > LIMITES_DA_TAREFA.motivoMax)) return negar('motivo-invalido', `O motivo precisa ter até ${LIMITES_DA_TAREFA.motivoMax} caracteres.`);
  if (evento === 'tempo_esgotado') {
    if (!verificarPrazo(tarefa, em).estourou) return negar('prazo-nao-estourou', 'O prazo da tarefa ainda não acabou.');
    muda.erro = Object.freeze({ codigo: 'tempo-esgotado', texto: 'A tarefa passou do tempo máximo e foi parada.' });
  }
  if (evento === 'falhar') {
    const codigo = typeof dados?.codigo === 'string' && /^[a-z0-9-]{1,40}$/.test(dados.codigo) ? dados.codigo : 'erro';
    muda.erro = Object.freeze({ codigo, texto: String(dados?.texto ?? 'A tarefa falhou.').replace(/[\r\n]+/g, ' ').slice(0, 200) });
  }
  if (ESTADOS_FINAIS.includes(para)) muda.terminouEm = em;
  const historico = [...tarefa.historico, Object.freeze({ de: tarefa.estado, para, evento, em })].slice(-LIMITES_DA_TAREFA.historicoMax);
  return { ok: true, tarefa: Object.freeze({ ...tarefa, ...muda, historico: Object.freeze(historico) }) };
}

// ── O executor (interface; hoje não implementado) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * O executor de verdade (a ser feito na Fase 4) implementa `executar(tarefa, { decidirComando })`: prepara o worktree e a branch, roda os comandos SÓ depois de `decidirComando`
 * (com a aprovação do dono nos "ask"), mantém o prazo e devolve o pacote de revisão. Hoje não existe: devolve "não implementado".
 */
export const EXECUTOR_NAO_IMPLEMENTADO = Object.freeze({
  nome: 'nao-implementado',
  async executar() { return negar('nao-implementado', 'O executor de tarefas do Yui Dev ainda não foi implementado.'); },
});

/**
 * Pede a execução de uma tarefa pendente. Desligada (YUI_DEV_TAREFAS): "desligado". Ligada: confere a tarefa e a branch e chama o executor; o padrão é "não implementado".
 * Nenhum comando, arquivo ou rede é tocado aqui.
 */
export async function executarTarefa(tarefa, { env = process.env, executor = EXECUTOR_NAO_IMPLEMENTADO } = {}) {
  const liga = tarefasLigadas(env);
  if (!liga.ligado) return negar('desligado', 'As tarefas do Yui Dev estão desligadas.');
  if (!tarefa || tarefa.estado !== 'pendente') return negar('tarefa-invalida', 'Só uma tarefa pendente pode ser executada.');
  const b = validarBranch(tarefa.branch);
  if (!b.ok) return b;
  if (typeof executor?.executar !== 'function') return EXECUTOR_NAO_IMPLEMENTADO.executar();
  return executor.executar(tarefa, { decidirComando: (comando) => decidirComando(tarefa, comando, { env }) });
}
