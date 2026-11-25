// Executa as suítes OFFLINE da Yui (sem Discord, sem chaves, sem rede) e resume o resultado.
//   npm run test:ci            roda tudo
//   npm run test:ci -- core    roda só as que contêm "core" no nome
//
// Cada suíte é um script do package.json ("test:...") que começa com `node`. Falha = código de saída
// diferente de zero. Exceção documentada: no Node 24 para Windows, algumas suítes terminam com um aborto
// do libuv DEPOIS de imprimir "N testes OK" (defeito ao sair com handles abertos, anterior ao CI);
// isso só é aceito se a saída mostrar o resumo de sucesso e nenhum erro de asserção.
//
// BLOQUEIO DE INTEGRAÇÃO EXTERNA (etapa 8, rodada depois da revisão da Liz, §12): nenhum teste normal acessa um serviço externo em silêncio. Cada suíte roda do
// jeito que tests/helpers/coberturaBloqueio.mjs a classifica: `proprio` (o teste cria o bloqueio dos processos que abre), `envolvida` (o teste roda num processo
// só: AQUI o processo dele sobe com o bloqueio carregado e o registro é conferido no fim; qualquer tentativa de rede, DNS, UDP, programa ou worker que não esteja
// declarada em tests/externos.json derruba a suíte) ou `declarada` (fora do bloqueio, com o motivo no registro). Os testes que acessam serviços de verdade NÃO estão
// aqui: ficam em tests/externos.json e só rodam com YUI_TESTES_EXTERNOS=true (npm run test:externos). O test:cobertura-bloqueio confere tudo isso.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classificarSuite, liberarDe, lerRegistro } from '../tests/helpers/coberturaBloqueio.mjs';
import { criarBloqueio } from '../tests/helpers/bloqueioExternoTeste.js';

const root = path.resolve(import.meta.dirname, '..');
const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;

/** Suítes que rodam sem rede, sem Discord e sem Windows específico. Acrescente aqui ao criar uma nova. */
export const SUITES = [
  'test:core', 'test:core-api', 'test:core-agent', 'test:readonly', 'test:permgaps', 'test:panel', 'test:alerts',
  'test:persona', 'test:mentions', 'test:search', 'test:gateway', 'test:config', 'test:memperm', 'test:hybrid',
  'test:audit', 'test:backup', 'test:dmowner', 'test:chatintents', 'test:imageintent', 'test:library',
  'test:reminders', 'test:remindersapi', 'test:fusodono','test:llmsafety', 'test:context', 'test:safefetch', 'test:netdefaults',
  'test:healthreport', 'test:guilddelete', 'test:redditguard', 'test:chromeprofile', 'test:interactionstats',
  'test:dev', 'test:security', 'test:approvals', 'test:routes', 'test:discordguard', 'test:jobguard', 'test:binverify', 'test:aibaseurl', 'test:lockverify',
  'test:importgraph', 'test:dbnative', 'test:backupwal', 'test:contextnative',
  'test:coreresearch', 'test:ownerlock', 'test:channel',
  // Etapa 14 (item 4a): skills no padrão aberto (agentskills.io), DESLIGADAS por padrão (YUI_SKILLS). O carregador, a validação da especificação, a escolha determinística e a prova de que nada
  // de uma skill é executado (num processo só, pasta temporária); e a conversa do cérebro com a IA falsa: só o dono, só dirigida à Yui, sem ferramentas, chave desligada = nada muda.
  'test:skillspadrao', 'test:skillscerebro',
  // Etapa 3: cérebro e bot em processos de verdade (cópia do código e bancos em pasta temporária, IA falsa, token falso).
  'test:separacao',
  // Etapa 4: operação dos dois processos (supervisor de verdade, quedas, idempotência persistente, backup com o cérebro
  // rodando; IA falsa e Discord falso, só em NODE_ENV=test). ~50 s.
  'test:operacao',
  // Etapa 4: memory.admin_wipe_user igual nos dois modos (o mesmo roteiro do /yui-criador memorias, local e pelo canal).
  'test:memoriaadmin',
  // Etapa 4 (depois da revisão da Liz): entrega dos lembretes com estados e reconciliação, sem DM em dobro.
  'test:entregalembretes',
  // Etapa 5: a conversa do Discord pelo cérebro (chat.turn e chat.commit) e o contexto por horas no cérebro. A unidade roda num processo
  // só (prompt igual ao do processo único, ordem, idempotência, canal falso); a de ponta a ponta usa processos de verdade (~2 min).
  'test:chatturnunidade',
  'test:chatturn',
  // Etapa 6: a pesquisa inteira no cérebro, os limites de tokens por provedor, o "Processando..." guardado e o JSON de ferramenta do cérebro como
  // pedido. A unidade roda num processo só (com o canal de verdade e um cabo TCP cortado no meio da pesquisa); a de ponta a ponta usa processos
  // de verdade, com IA e busca falsas (~45 s).
  'test:pesquisaunidade',
  'test:pesquisa',
  // Etapa 6 (ajustes da Liz): a retomada da pesquisa sem repetição cega, a busca do /yui decidida pelo contexto, os limites de tokens
  // unificados (Discord e app) e o ajuste do painel no cérebro (num processo só); e a prova de que o bloqueio de integração externa dos
  // testes com processos de verdade funciona (rede, DNS, UDP e programas como o yt-dlp falham e ficam registrados).
  'test:retomadapesquisa',
  'test:bloqueioexterno',
  // Segunda revisão da Liz na etapa 6 (§12/§13 do relatório): a reserva configurável, o painel só no Discord (o app nunca herda), o
  // AI_MAX_TOKENS inválido no log e no diagnóstico (a mesma regra no Discord e no app) e a cota por hora em disco no cérebro (num processo só).
  'test:cotalimites',
  // Etapa 7: os comentários fora da fila (/steam_jogo e /converter_moeda) no cérebro. A unidade roda num processo só (o pedido igual ao do
  // processo único, o cérebro isolado, o canal de verdade, o interactionCreate de verdade); a de ponta a ponta usa processos de verdade, com
  // IA e Discord falsos (comandos de barra) e o bloqueio de integração externa (~60 s).
  'test:comentariosunidade',
  'test:comentarios',
  // Etapa 8 (antes do piloto no app, revisão da Liz): a cota de busca por hora em disco TAMBÉM no processo único, com o dono do arquivo e a trava (num
  // processo só e com processos de verdade, sob o bloqueio de integração externa); o endpoint do diagnóstico (só leitura, só o dono, sem nenhum
  // conteúdo privado); e o /steam_jogo de ponta a ponta com processos de verdade (reinício, falhas, prazo e conteúdo privado fora dos logs) (~55 s).
  'test:cotahora',
  'test:diagnostico',
  'test:steamjogo',
  // Etapa 8, rodada depois da revisão da Liz (§12): falhar fechado na pesquisa (nenhuma busca sem o dono da cota e sem o registro persistente, nos quatro caminhos,
  // pública e privada) e a reutilização sem cobrança com as condições da Liz (a privada nunca é compartilhada); a separação dos testes externos (o registro único
  // tests/externos.json, o bloqueio em TODA suíte normal e a prova de que nenhum teste externo está aqui); e a versão da CI do teste semanal do Reddit, com a
  // resposta GRAVADA (a de rede real é externa e opt-in).
  'test:falhafechada',
  'test:cobertura-bloqueio',
  'test:weeklygravado',
  // Etapa 8, rodada de fechamento depois da 3ª revisão da Liz (§14): a busca do app (o agente de código) passa pela MESMA cota central, e quem esperava uma busca
  // pública cancelada pelo dono dela pode fazer a PRÓPRIA busca (reserva e diário próprios, uma nova tentativa só). Os dois num processo só, com buscador falso,
  // cota em disco numa pasta temporária e sob o bloqueio de integração externa. O test:soak2h (2 horas, MANUAL) NÃO está aqui: fora da CI, como o test:importarmemoria.
  'test:buscaapp',
  'test:buscacancelada',
  // Etapa 9 (perfis de IA no Motor 0, só com o OmniRoute FALSO): as peças puras (configuração validada, os dois leitores do cabeçalho de decisão, o seletor, o motor do agente, o diagnóstico e a
  // preservação); a rota contra o servidor falso em loopback (a seleção, o privado com falha fechada, o fallback, o segredo plantado, a concorrência, o reinício e o isolamento entre pessoas); e
  // os processos de verdade (cérebro e bot com Discord falso e o OmniRoute falso, sob o bloqueio de integração externa).
  'test:perfisiaunidade',
  'test:perfisiarota',
  'test:perfisiaprocessos',
  // Etapa 10 (piloto do app, só local): "Reiniciar a Yui" com os dois processos (o pedido vai ao supervisor; supervisor com processos falsos e o lado do filho; o chat do app com o
  // perfil de IA contra o OmniRoute falso; num processo só) e a ponta a ponta com o supervisor, o cérebro e o bot de verdade (Discord e IA falsos, ~15 s).
  'test:pilotoapp',
  'test:reinicioprocessos',
  // Etapa 12 (voz pelo OmniRoute): a unidade (configuração, preparação do texto, o provedor com fetch falso: corpo, chave, falhas, teto, cache, estilo, MP3, e o lugar dele no
  // motor: ordem de reserva e porta de privacidade) e a integração com o OmniRoute FALSO em loopback (aberto pelo teste; corpo exato, WAV tocável, cada falha caindo no próximo
  // provedor, segredos fora do log, o caminho inteiro initTts -> speakVoiceReply -> PCM do Discord). Os dois num processo só, sob o bloqueio de integração externa.
  'test:ttsomniroute',
  'test:ttsomnirouteint',
  'test:tts429',
  'test:recusageral',
  // Etapa 15 (Google, SOMENTE LEITURA, desligado, só com um Google FALSO em loopback): a unidade (os endereços só em um arquivo, o arquivo da autorização restrito e atômico, o
  // autenticador com o invalid_grant avisando uma vez, a Agenda e as Tarefas no fuso, os dados cercados, a pré-rota só do dono em conversa privada, o Gmail travado, o relatório
  // matinal igual sem a chave) e o script de autorização única de verdade (PKCE, state, o retorno em 127.0.0.1, o arquivo restrito).
  'test:google',
  'test:googlecontinuacao',
  'test:googleautorizar',
  // Etapa 17 (itens 6 e 7, só PREPARO, tudo desligado por chave e sem efeito): o contrato único canal <-> cérebro (pedido e resposta estritos, papel nunca vindo do pedido, tamanho e estilo por canal), o
  // adaptador de YouTube Live contra um servidor FALSO em loopback (estados, quando falar, cota, 200 caracteres, o chat nunca manda), as tarefas do Yui Dev (máquina de estados, branch isolada, push só da branch,
  // pacote de revisão), a sonda de hardware com saídas simuladas e o ponto de ligação da IA local (perfil `local` continua recusado). Nenhuma abre programa nem fala com serviço de verdade (~5 s no total).
  'test:canais',
  'test:canalyoutube',
  'test:devtarefas',
  'test:sondahardware',
  'test:ialocal',
  // A rota privada com IA local (YUI_IA_LOCAL_PRIVADA, desligada por padrão): a chamada privada tenta o modelo local ANTES da cadeia e cai para ela na mesma chamada (computador fora,
  // prazo, resposta vazia, só raciocínio, JSON quebrado, pedido grande), o disjuntor, a pública que nunca passa por ali e a chave desligada que não muda nada; servidor FALSO em 127.0.0.1.
  'test:ialocalprivada',
  // Etapa 11 (clima como ferramenta própria e pesquisa por intenção no chat, só no cérebro): o detector do clima; o cliente e o serviço do Open-Meteo contra um servidor FALSO em
  // loopback (a cota por hora, o cache, as falhas); o detector e a política da pesquisa por intenção (chave x dono/membro x DM/servidor x YUI_PRIVATE_SEARCH); e o chat.turn, a fila do
  // llmHandler e o /yui de ponta a ponta com a IA, o buscador e o Open-Meteo falsos. Todos num processo só, sob o bloqueio de integração externa.
  'test:climadeteccao',
  'test:climacliente',
  'test:intencaobusca',
  'test:climaintencao',
  // Etapa 13 (preparar o perfil privado de IA para ser ligado depois; continua DESLIGADO): a rota de administração que só PEDE a nova verificação da rota privada (só o dono, com a confirmação,
  // auditada, com limite de repetição; nunca desbloqueia direto; num processo só, com o OmniRoute falso) e o script do dono que testa o cabeçalho X-OmniRoute-Decision (processos de verdade
  // contra o servidor falso, com o bloqueio de integração externa e a prova de que a chave nunca é impressa).
  'test:rotaprivadaadmin',
  'test:scriptcabecalho',
  // Etapa 16 (proatividade, tudo desligado por padrão): os monitores de busca do dono e os alertas por evento. A unidade roda num processo só (o buscador é um dublê do fetch,
  // a cota e o relógio são injetados); a de ponta a ponta usa processos de verdade (cérebro e bot, Discord, IA e busca falsos, sob o bloqueio de integração externa).
  'test:monitoresunidade',
  'test:monitores',
  // Prova de IDENTIDADE do servidor para o app (GET /v1/identidade: assinatura Ed25519 de um desafio com a chave privada que só o servidor tem): a rota desligada e ligada, o nonce, o limite de
  // repetição por origem, o sigilo da chave privada (nunca no corpo, em log nem no repositório) e o gerador da identidade (permissão restrita, nunca sobrescreve sem --forcar). Num processo só, sem rede.
  'test:identidadeapi',
];

function argvOf(command) {
  const parts = command.trim().split(/\s+/);
  if (parts[0] !== 'node') throw new Error(`só scripts "node ..." são aceitos: ${command}`);
  return parts.slice(1).map((p) => p.replace(/^"|"$/g, ''));
}

const filter = process.argv[2] ?? '';
const results = [];
const registro = lerRegistro();
for (const name of SUITES) {
  if (filter && !name.includes(filter)) continue;
  if (!scripts[name]) { results.push({ name, status: 'AUSENTE', ms: 0 }); continue; }
  const t0 = Date.now();
  // Como esta suíte roda: com o bloqueio dela mesma (proprio), SOB o bloqueio que o CI abre (envolvida) ou declarada no registro (veja o topo)
  const como = classificarSuite(name, { scripts, registro, raiz: root });
  let argv = argvOf(scripts[name]);
  let envExtra = {};
  let bloqueio = null;
  let pastaBloqueio = null;
  if (como.modo === 'envolvida') {
    pastaBloqueio = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-ci-bloqueio-'));
    bloqueio = criarBloqueio(pastaBloqueio, { teste: name, liberar: liberarDe(como.excecoes) });
    argv = [...bloqueio.argv, ...argv];
    envExtra = { NODE_ENV: 'test', ...bloqueio.env(name) };
  }
  const r = spawnSync(process.execPath, argv, { cwd: root, encoding: 'utf8', timeout: 180_000, env: { ...process.env, NO_COLOR: '1', ...envExtra } });
  const tentativas = bloqueio ? bloqueio.lista() : [];
  const usosDasExcecoes = bloqueio ? bloqueio.resumo() : [];
  if (pastaBloqueio) { try { fs.rmSync(pastaBloqueio, { recursive: true, force: true, maxRetries: 3 }); } catch { /* sobra em %TEMP%: inofensiva */ } }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const okSummary = /\b(\d+) testes? OK\b|ℹ fail 0|\bpass \d+/.test(out);
  const libuvExit = /UV_HANDLE_CLOSING/.test(out) && okSummary && !/AssertionError|ℹ fail [1-9]|✖/.test(out);
  // Qualquer tentativa de integração externa bloqueada derruba a suíte, mesmo que ela tenha passado (nenhum teste normal acessa algo de fora em silêncio)
  const passed = (r.status === 0 || libuvExit) && tentativas.length === 0;
  const aviso = tentativas.length ? `\n[bloqueio de integração externa] ${tentativas.length} tentativa(s) bloqueada(s) em ${name}:\n${tentativas.slice(0, 10).map((l) => JSON.stringify(l)).join('\n')}` : '';
  const nota = [r.status !== 0 && libuvExit && tentativas.length === 0 ? 'aborto do libuv ao sair (tolerado)' : '', como.modo === 'envolvida' ? 'sob o bloqueio' : '', tentativas.length ? `${tentativas.length} tentativa(s) externa(s)` : ''].filter(Boolean).join('; ');
  results.push({ name, status: passed ? 'ok' : 'FALHOU', ms: Date.now() - t0, note: nota, modo: como.modo, usos: usosDasExcecoes, out: passed ? '' : `${out.split('\n').slice(-25).join('\n')}${aviso}` });
  console.log(`${passed ? '✔' : '✖'} ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${nota ? ` — ${nota}` : ''}`);
}

const failed = results.filter((r) => r.status !== 'ok');
for (const f of failed) console.log(`\n── ${f.name}: ${f.status}\n${f.out ?? ''}`);
const porModo = (m) => results.filter((r) => r.modo === m).length;
console.log(`\n${results.length - failed.length}/${results.length} suítes OK${failed.length ? `; falharam: ${failed.map((f) => f.name).join(', ')}` : ''}`);
if (!filter) console.log(`bloqueio de integração externa: ${porModo('proprio')} suíte(s) com o bloqueio próprio, ${porModo('envolvida')} sob o bloqueio do CI, ${porModo('declarada')} declarada(s) no registro (tests/externos.json)`);
process.exit(failed.length ? 1 : 0);
