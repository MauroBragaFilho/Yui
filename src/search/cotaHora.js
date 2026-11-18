// A cota de busca POR HORA em disco: QUEM liga e QUEM é o dono do arquivo, nas duas configurações (etapa 8, revisão da Liz, §9 do relatório da etapa 7:
// "a cota por hora em disco também no processo único, para não haver comportamento diferente entre as duas configurações").
//
// O arquivo (search-budget-hora.json, ao lado do search-budget.json) tem UM dono por configuração:
//
//   | Configuração                        | Quem grava                | Papel          |
//   | Processo único (sem a chave)        | o PRÓPRIO processo        | `unico`        |
//   | Cérebro separado (YUI_CEREBRO_EXTERNO) | o CÉREBRO               | `cerebro`      |
//   | Cérebro separado, o bot             | NINGUÉM (nunca grava)      | `bot-separado` |
//
// Para nunca haver dois processos gravando o mesmo arquivo, além de o bot separado nem tentar, quem grava pega uma TRAVA DE DONO no arquivo
// (`search-budget-hora.json.owner`: o mesmo mecanismo da trava dos bancos, src/database/ownerLock.js: criação atômica, batimento, retomada só
// se o dono morreu, nunca encerra processo). Se a trava é de outro processo VIVO (um processo único e um cérebro na mesma pasta, por engano), este
// processo NÃO grava e NÃO busca (a pesquisa dele fica indisponível, com um aviso no log e no diagnóstico), e ele tenta de novo de tempos em tempos (se o
// outro cair, este assume). Trava de um dono que MORREU (queda): espera o prazo de abandono, sem atrasar a subida (a espera é em segundo plano; enquanto
// isso a pesquisa fica indisponível; quando o arquivo é pego, as buscas da última hora voltam do disco). Trava perdida depois de ligada (alguém trocou a
// trava): para de gravar na hora (budget.desligarHora) E de buscar até reiniciar (a pesquisa fica indisponível): nunca volta a ler o arquivo (as buscas
// que este processo já gravou contariam em dobro).
// YUI_COTA_HORA_DISCO=false volta a só memória nas duas configurações. O padrão é ligado (como no cérebro desde a etapa 6); como tudo da etapa 8,
// só chega à produção no próximo deploy que o Braga autorizar.
//
// UM DONO, NENHUMA COTA INDEPENDENTE EM MEMÓRIA (revisão da Liz, §12 do relatório da etapa 8): "um processo sem a propriedade da trava deve encaminhar a
// operação ao proprietário ou falhar de forma controlada, nunca operar com uma cota independente em memória". Por isso este módulo comanda a PORTA DE
// SAÍDA da busca externa (budget.definirDespacho): ela só fica ABERTA com a trava na mão (o dono), ou com a cota desligada DE PROPÓSITO
// (YUI_COTA_HORA_DISCO=false: escolha explícita do dono, avisada no log e no diagnóstico, não uma falha). Esperando a trava (de outro processo vivo, ou de um
// dono morto ainda dentro do prazo de abandono), com a trava perdida, com erro na trava e no bot separado, a porta fica FECHADA: nenhuma busca começa, nada
// é cobrado, e a Yui continua conversando e avisa que a pesquisa está temporariamente indisponível (src/search/indisponivel.js). A pesquisa do bot separado
// vai ao cérebro, que é o dono. Depois de uma queda, a pesquisa fica indisponível até o prazo de abandono da trava do dono morto vencer (~75 s com os
// tempos de produção) ou até o outro processo sair.
import path from 'node:path';
import os from 'node:os';
import { getDefaultBudget, hourlyFileFor, hourlyPersistEnabled } from './budget.js';
import { acquireOwnerLock, defaultQueryProcess, processExists, OWNER_HELD, OWNER_HUNG } from '../database/ownerLock.js';
import { ownerLockTiming } from '../database/owners.js';

/** Os papéis de quem liga a cota por hora (veja a tabela acima). */
export const PAPEIS_COTA_HORA = Object.freeze({ UNICO: 'unico', CEREBRO: 'cerebro', BOT_SEPARADO: 'bot-separado' });

/** O dono do arquivo em cada configuração: o cérebro com os processos separados; o próprio processo no único. */
export const donoDoArquivoDaCota = (separado) => (separado ? PAPEIS_COTA_HORA.CEREBRO : PAPEIS_COTA_HORA.UNICO);

let atual = null;

/**
 * Situação da cota por hora deste processo (só estados e números; nunca o caminho completo nem o id de ninguém). Sem nada ligado: `{ ligada: false }`.
 */
export function estadoDaCotaHora() {
  return atual ? atual.estado() : { papel: null, ligada: false, motivo: 'não ligada neste processo', pesquisaDisponivel: true };
}

/**
 * Liga a cota por hora em disco para o papel deste processo. Não lança e não atrasa a subida. Devolve `{ estado(), parar() }`.
 * Tudo injetável para teste (budget, env, logger, arquivo, acquire, queryProcess, processoExiste).
 * @param {{ papel: 'unico'|'cerebro'|'bot-separado', budget?: object, env?: object, logger?: object|null, arquivo?: string|null,
 *           acquire?: Function, queryProcess?: Function, processoExiste?: Function }} o
 */
export function ligarCotaHora({ papel, budget = getDefaultBudget(), env = process.env, logger = null, arquivo = null, acquire = acquireOwnerLock, queryProcess = defaultQueryProcess, processoExiste = processExists } = {}) {
  if (!Object.values(PAPEIS_COTA_HORA).includes(papel)) throw new TypeError(`ligarCotaHora: papel inválido "${papel}".`);
  const log = (nivel, msg) => { try { logger?.[nivel]?.(msg); } catch { /* o log nunca derruba a subida */ } };
  const estado = {
    papel,
    dono: papel === PAPEIS_COTA_HORA.BOT_SEPARADO ? PAPEIS_COTA_HORA.CEREBRO : papel,
    // `codigo`: o motivo de não estar gravando, como uma palavra fixa (o diagnóstico do app mostra só isto): bot-separado | desligada |
    // trava-de-outro-processo | dono-morto | erro-na-trava | perdida (null = gravando).
    ligada: false, aguardandoTrava: false, codigo: null, motivo: null, carregadas: 0, tentativas: 0, perdida: false, arquivo: null,
  };
  /** Abre ou fecha a porta de saída da busca externa deste processo (veja o comentário do topo). Nunca lança. */
  const porta = (permitido, codigo = null) => { try { budget.definirDespacho?.(permitido, codigo); } catch { /* */ } };
  let trava = null;
  let timer = null;
  let parado = false;
  const handle = {
    // `pesquisaDisponivel`: este processo PODE despachar uma busca externa agora (a porta de saída está aberta).
    estado: () => ({ ...estado, pesquisaDisponivel: budget.despacho?.().permitido !== false, trava: trava ? { papel: trava.record?.role ?? papel, pid: trava.record?.pid ?? null, segura: trava.held } : null }),
    parar() {
      parado = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { budget.desligarHora?.('parada'); } catch { /* */ }
      try { trava?.release(); } catch { /* */ }
      porta(false, 'parada'); // parado (desligamento): nenhuma busca nova
      estado.ligada = false;
      estado.motivo ??= 'parada';
      estado.codigo ??= 'parada';
    },
  };
  atual = handle;

  if (papel === PAPEIS_COTA_HORA.BOT_SEPARADO) {
    estado.codigo = 'bot-separado';
    estado.motivo = 'o dono do arquivo é o cérebro: o bot separado nunca grava a cota por hora nem busca por conta própria';
    porta(false, 'bot-separado'); // o bot separado nunca despacha uma busca externa: a pesquisa dele vai ao cérebro (o dono)
    log('info', '[Cota] Cota de busca por hora: com o cérebro separado quem grava o arquivo é o cérebro; o bot não grava e não busca por conta própria (a pesquisa vai ao cérebro; se algum caminho tentar, a pesquisa fica indisponível).');
    return handle;
  }
  if (!hourlyPersistEnabled(env)) {
    estado.codigo = 'desligada';
    estado.motivo = 'desligada (YUI_COTA_HORA_DISCO=false)';
    porta(true); // escolha EXPLÍCITA do dono (não é falha): só memória, com o aviso abaixo e o código 'desligada' no diagnóstico
    log('warn', `[Cota] YUI_COTA_HORA_DISCO=false: a cota de busca por hora (${papel}) fica só na memória e zera num reinício (escolha explícita do dono; as buscas seguem saindo).`);
    return handle;
  }

  const file = path.resolve(arquivo ?? hourlyFileFor(budget.filePath));
  estado.arquivo = path.basename(file);
  const timing = ownerLockTiming(env);
  /** O registro da trava é de um processo DESTE computador que não existe mais? (só pergunta ao sistema; nunca encerra nada) */
  const donoMorto = (owner) => {
    if (!owner || !Number.isInteger(owner.pid) || owner.pid === process.pid) return false;
    if (owner.hostname && owner.hostname !== os.hostname()) return false;
    try { return processoExiste(owner.pid) === false; } catch { return false; } // só pergunta ao sistema (sinal 0), sem PowerShell
  };
  const agendar = (ms) => {
    if (parado) return;
    timer = setTimeout(() => { timer = null; tentar(); }, Math.max(50, ms));
    timer.unref?.();
  };
  function perdeu(info) {
    estado.ligada = false;
    estado.perdida = true;
    estado.codigo = 'perdida';
    porta(false, 'perdida'); // sem a trava, nenhuma busca nova: nunca uma cota independente em memória
    estado.motivo = `perdi o dono do arquivo (${String(info?.reason ?? 'trava trocada').slice(0, 80)}); parei de gravar e de buscar até reiniciar`;
    try { budget.desligarHora?.('perdeu o dono do arquivo'); } catch { /* */ }
    log('error', `[Cota] A trava do arquivo da cota por hora foi PERDIDA (${String(info?.reason ?? '?').slice(0, 80)}). Parei de gravar para não haver dois processos no mesmo arquivo e parei de buscar (a pesquisa fica indisponível até reiniciar): nunca uma cota independente em memória.`);
  }
  function tentar() {
    if (parado || estado.ligada || estado.perdida) return;
    estado.tentativas += 1;
    try {
      trava = acquire(file, { role: papel, ...timing, queryProcess, onLost: perdeu });
    } catch (err) {
      const conflito = err?.code === OWNER_HELD || err?.code === OWNER_HUNG;
      const morto = err?.code === OWNER_HELD && donoMorto(err.owner);
      estado.aguardandoTrava = true;
      const quem = err?.owner ? `${String(err.owner.role ?? '?').slice(0, 20)}, PID ${Number(err.owner.pid) || '?'}` : 'dono desconhecido';
      if (morto) { estado.codigo = 'dono-morto'; estado.motivo = `a trava é de um processo que não existe mais (${quem}); aguardando o prazo de abandono; a pesquisa fica indisponível até lá`; }
      else if (conflito) { estado.codigo = 'trava-de-outro-processo'; estado.motivo = `a trava do arquivo é de outro processo (${quem}); este processo NÃO grava a cota por hora e NÃO busca: a pesquisa fica indisponível enquanto a trava for do outro`; }
      else { estado.codigo = 'erro-na-trava'; estado.motivo = `não consegui a trava do arquivo (${String(err?.code ?? 'erro').slice(0, 30)}); a pesquisa fica indisponível até conseguir`; }
      porta(false, estado.codigo); // sem a trava, nenhuma busca (nunca uma cota independente em memória)
      if (estado.tentativas === 1) {
        log('warn', `[Cota] Cota de busca por hora (${papel}): ${estado.motivo}. Nada é apagado nem encerrado à força.${morto ? '' : ' Tento de novo de tempos em tempos.'}`);
      }
      // dono morto: espera o prazo de abandono (o mesmo cálculo da trava dos bancos); dono vivo, travado ou erro: tenta de novo a cada alguns batimentos
      const espera = morto
        ? Math.max(0, timing.staleMs - (Number(err.heartbeatAgeMs) || 0)) + timing.heartbeatMs
        : Math.max(timing.heartbeatMs * 2, 1000);
      agendar(espera);
      return;
    }
    estado.aguardandoTrava = false;
    estado.ligada = true;
    estado.codigo = null;
    estado.motivo = null;
    estado.carregadas = budget.persistirHora(file);
    porta(true); // a trava está na mão: este processo é o dono e a pesquisa pode sair
    log('info', `[Cota] Cota de busca por hora em disco (dono: ${papel}): ${estado.carregadas} busca(s) da última hora voltaram a contar.`);
  }
  // A porta só abre com a trava na mão: até lá (e se a trava não vier) nenhuma busca sai. `tentar()` abre a porta se pegar a trava na hora.
  porta(false, 'aguardando-trava');
  tentar();
  return handle;
}
