// SUPERVISOR dos dois processos da Yui (etapa 4, docs/RELATORIO_ETAPA4_OPERACAO.md §2). A lógica fica aqui, com tudo
// injetável para os testes (tests/test-operacao.js); a entrada de verdade é src/supervisor.js.
//
// Modo "dois" (YUI_CEREBRO_EXTERNO=true):
//  - SOBE em ordem: primeiro o cérebro; o bot só sobe depois de o cérebro avisar "pronto" (ou, se o cérebro não ficar pronto
//    em `esperaCerebroMs`, sobe assim mesmo: o bot funciona sem o cérebro, com a memória indisponível, como a etapa 3 provou);
//  - SAÚDE por processo, pelo IPC ({tipo:'saude'}): sem resposta `falhasParaReligar` vezes seguidas = travado = religa só
//    aquele processo. O bot também religa se o Discord ficar fora por `discordForaMs` ou se ficar sem o canal com o cérebro
//    (com o cérebro pronto) por `canalForaMs`. Processo que não avisa "pronto" em `subidaMs` também é religado;
//  - RELIGAR com espera crescente: esperaMinMs, o dobro a cada queda seguida, até esperaMaxMs; a contagem zera depois de o
//    processo ficar `estavelMs` de pé. Antes de religar, espera as travas de dono do processo MORTO vencerem (um processo
//    derrubado à força deixa a trava no disco; o novo seria recusado até ela vencer): nunca mexe na trava de ninguém;
//  - PARA em ordem: o bot primeiro, depois o cérebro, cada um pelo pedido limpo ({tipo:'desligar'}); quem não sair em
//    `paradaMs` é encerrado PELO HANDLE que o supervisor guardou ao abri-lo.
//  - REINÍCIO CONTROLADO (etapa 10, piloto do app): o dono pede "Reiniciar a Yui" no app; quem confere o dono e a confirmação é o cérebro
//    (src/core/api/admin.js) e ele pede aqui pelo MESMO canal IPC que já liga o supervisor ao filho: { tipo: 'reiniciar', id, motivo }.
//    O supervisor só aceita o pedido do processo CÉREBRO (o bot nunca), no modo dois, um de cada vez; responde { tipo: 'reinicio', id,
//    aceito, motivo }. Aceito, ele espera `reinicioAtrasoMs` (a resposta HTTP sai antes), PARA o bot e depois o cérebro (cada um pelo pedido
//    limpo; só se não saírem no prazo, pelo handle) e SOBE de novo na ordem de sempre (o cérebro, depois o bot quando ele ficar pronto).
//    Não é queda: não conta como queda seguida nem usa a espera crescente. Nada reinicia sem este pedido e nada é encontrado por PID.
// Modo "unico" (sem a chave): sobe só `node src/index.js`, sem IPC, e religa 15 s depois de qualquer saída: exatamente o laço
// da tarefa YuiBot de hoje (`while ($true) { node src/index.js; Start-Sleep 15 }`).
//
// REGRA DE SEGURANÇA: o supervisor só encerra os processos que ELE abriu, pelo objeto do processo guardado na abertura. Não
// existe aqui nenhuma varredura de processos (Get-Process, tasklist, wmic, netstat) nem encerramento por PID solto. O PID que
// aparece no estado é só informação.

export const MODOS = Object.freeze(['dois', 'unico']);

export const TEMPOS_PADRAO = Object.freeze({
  saudeMs: 15_000, // intervalo entre as perguntas de saúde
  prazoSaudeMs: 5_000, // prazo de cada resposta
  falhasParaReligar: 3, // respostas perdidas seguidas = travado
  // Prazo para avisar "pronto" antes de religar. Longo de propósito: no notebook (HD, 4 GB) a subida baixa dados do GTA e às
  // vezes binários; religar por lentidão criaria um laço. Processo travado de verdade (sem responder à saúde) é pego antes.
  subidaMs: 900_000,
  discordForaMs: 600_000, // Discord fora por 10 min com o bot de pé = religa o bot (a mesma regra do watchdog de hoje)
  canalForaMs: 600_000, // bot sem o canal com o cérebro (cérebro pronto) por 10 min = religa o bot
  esperaMinMs: 5_000,
  esperaMaxMs: 60_000,
  estavelMs: 300_000,
  paradaMs: 20_000, // prazo do desligamento limpo de cada processo antes de encerrar pelo handle
  esperaCerebroMs: 120_000, // quanto o bot espera o cérebro ficar pronto antes de subir sem ele
  unicoReinicioMs: 15_000, // modo único: o mesmo intervalo do laço da tarefa de hoje
  estadoMs: 30_000, // sem mudança, o arquivo de estado é renovado no máximo a cada 30 s (o watchdog estranha depois de 3 min)
  reinicioAtrasoMs: 700, // reinício controlado (pedido do dono pelo app): espera isto antes de parar o bot, para a resposta HTTP do cérebro sair
});

const MINIMOS = { saudeMs: 50, prazoSaudeMs: 20, falhasParaReligar: 1, subidaMs: 200, discordForaMs: 100, canalForaMs: 100, esperaMinMs: 10, esperaMaxMs: 10, estavelMs: 50, paradaMs: 100, esperaCerebroMs: 0, unicoReinicioMs: 10, estadoMs: 0, reinicioAtrasoMs: 0 };
const VARIAVEIS = {
  reinicioAtrasoMs: 'YUI_SUPERVISOR_REINICIO_ATRASO_MS',
  estadoMs: 'YUI_SUPERVISOR_ESTADO_MS',
  saudeMs: 'YUI_SUPERVISOR_SAUDE_MS', prazoSaudeMs: 'YUI_SUPERVISOR_PRAZO_SAUDE_MS', falhasParaReligar: 'YUI_SUPERVISOR_FALHAS',
  subidaMs: 'YUI_SUPERVISOR_SUBIDA_MS', discordForaMs: 'YUI_SUPERVISOR_DISCORD_FORA_MS', canalForaMs: 'YUI_SUPERVISOR_CANAL_FORA_MS',
  esperaMinMs: 'YUI_SUPERVISOR_ESPERA_MIN_MS', esperaMaxMs: 'YUI_SUPERVISOR_ESPERA_MAX_MS', estavelMs: 'YUI_SUPERVISOR_ESTAVEL_MS',
  paradaMs: 'YUI_SUPERVISOR_PARADA_MS', esperaCerebroMs: 'YUI_SUPERVISOR_ESPERA_CEREBRO_MS', unicoReinicioMs: 'YUI_SUPERVISOR_UNICO_REINICIO_MS',
};

/** Tempos do supervisor: padrão, com as variáveis YUI_SUPERVISOR_* (valores inválidos ou abaixo do mínimo voltam ao padrão). */
export function temposDoAmbiente(env = process.env) {
  const out = { ...TEMPOS_PADRAO };
  for (const [k, name] of Object.entries(VARIAVEIS)) {
    const raw = String(env[name] ?? '').trim();
    if (!raw) continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= MINIMOS[k]) out[k] = Math.round(n);
  }
  if (out.esperaMaxMs < out.esperaMinMs) out.esperaMaxMs = out.esperaMinMs;
  return out;
}

/** Espera antes de religar depois de `quedas` quedas seguidas (1 = a primeira): esperaMin, o dobro a cada queda, até esperaMax. */
export function calcularEspera(quedas, tempos = TEMPOS_PADRAO) {
  const n = Math.max(1, Math.floor(quedas));
  return Math.min(tempos.esperaMaxMs, tempos.esperaMinMs * 2 ** Math.min(n - 1, 30));
}

/** Os processos de cada modo, na ordem de subida (a parada é na ordem inversa). */
export function especificacoes(modo, { env = process.env, bancos = {} } = {}) {
  if (modo === 'unico') return [{ papel: 'yui', script: 'src/index.js', ipc: false, env: { ...env }, bancos: [] }];
  const base = { ...env };
  delete base.YUI_DB_OWNER_ROLE; // cada entrada define o próprio papel
  return [
    { papel: 'cerebro', script: 'src/cerebro.js', ipc: true, env: { ...base }, bancos: bancos.cerebro ?? [] },
    { papel: 'bot', script: 'src/index.js', ipc: true, env: { ...base, YUI_CEREBRO_EXTERNO: 'true' }, bancos: bancos.bot ?? [], depende: 'cerebro' },
  ];
}

const noop = () => {};

/**
 * @param {{
 *   modo: 'dois'|'unico',
 *   specs?: object[],
 *   spawnFilho: (spec: object) => { pid?: number, send?: Function, kill: Function, on: Function, connected?: boolean },
 *   tempos?: object,
 *   travas?: { dir: string, staleMs: number, heartbeatMs: number, inspecionar: (dbPath: string, opts: object) => object } | null,
 *   log?: (nivel: 'info'|'aviso'|'erro', msg: string) => void,
 *   gravarEstado?: (estado: object) => void,
 *   agora?: () => number,
 *   relogio?: { setTimeout: Function, clearTimeout: Function, setInterval: Function, clearInterval: Function },
 * }} options
 */
export function createSupervisor({
  modo,
  specs = especificacoes(modo),
  spawnFilho,
  tempos = TEMPOS_PADRAO,
  travas = null,
  log = noop,
  gravarEstado = noop,
  agora = Date.now,
  relogio = { setTimeout, clearTimeout, setInterval, clearInterval },
} = {}) {
  if (!MODOS.includes(modo)) throw new TypeError(`Modo do supervisor inválido: ${modo}`);
  if (typeof spawnFilho !== 'function') throw new TypeError('createSupervisor: informe spawnFilho.');
  const t = { ...TEMPOS_PADRAO, ...tempos };
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const slots = new Map(specs.map((spec) => [spec.papel, {
    spec, proc: null, estado: 'parado', pid: null, iniciadoEm: null, prontoEm: null, inicios: 0, religadas: 0, quedasSeguidas: 0,
    falhasSaude: 0, ultimaSaude: null, ultimaSaida: null, timer: null, proximaEm: null, pedidoReinicio: null,
    discordForaDesde: null, canalForaDesde: null, aguardandoDesde: null, avisouTrava: false, eventos: [],
  }]));
  const ordem = specs.map((s) => s.papel);
  let estadoGeral = 'parado';
  let iniciadoEm = null;
  let saudeTimer = null;
  let rodadaSaude = false;
  let seq = 0;
  // Reinício controlado (pedido do dono pelo app): `emCurso` só existe enquanto o supervisor para e sobe os dois de novo.
  let reinicioEmCurso = null; // { motivo, desde }
  let reinicios = 0;
  let ultimoReinicio = null; // { em, motivo, origem }
  const pendentesSaude = new Map(); // id -> resolve
  const esperasSaida = new Map(); // papel -> [resolve]

  function evento(slot, texto) {
    slot.eventos.push(`${new Date(agora()).toISOString()} ${texto}`);
    if (slot.eventos.length > 20) slot.eventos.shift();
  }

  function snapshot() {
    return {
      versao: 1,
      modo,
      estado: estadoGeral,
      pid: process.pid,
      iniciadoEm: iso(iniciadoEm),
      atualizadoEm: new Date(agora()).toISOString(),
      // só contagens e uma palavra fixa: o pedido do dono pelo app (o motivo nunca é texto livre)
      reinicioControlado: { emCurso: reinicioEmCurso !== null, total: reinicios, ultimo: ultimoReinicio ? { ...ultimoReinicio } : null },
      processos: Object.fromEntries([...slots].map(([papel, s]) => [papel, {
        estado: s.estado,
        pid: s.pid, // só informação: nunca é usado para encerrar nada
        inicios: s.inicios,
        religadas: s.religadas,
        quedasSeguidas: s.quedasSeguidas,
        iniciadoEm: iso(s.iniciadoEm),
        prontoEm: iso(s.prontoEm),
        proximaTentativaEm: iso(s.proximaEm),
        falhasSaude: s.falhasSaude,
        ultimaSaude: s.ultimaSaude,
        ultimaSaida: s.ultimaSaida,
        eventos: [...s.eventos],
      }])),
    };
  }

  let ultimoSalvo = 0;
  /** Grava o estado. `urgente` (mudança de estado) grava na hora; a rodada de saúde só renova a cada `estadoMs`. */
  function salvar(urgente = true) {
    if (!urgente && agora() - ultimoSalvo < t.estadoMs) return;
    ultimoSalvo = agora();
    try { gravarEstado(snapshot()); } catch (err) { log('aviso', `não consegui gravar o estado (${err?.code || err?.message})`); }
  }

  /**
   * Quanto falta para as travas de dono de um processo MORTO vencerem (0 = nada a esperar). Só olha, nunca mexe.
   * Conta a trava do processo que este supervisor abriu e viu sair, e a de um dono que não existe mais (ex.: o supervisor
   * anterior foi derrubado junto com os filhos). Trava de processo vivo não conta: a subida é recusada e vira espera crescente.
   */
  function esperaTravas(slot) {
    if (!travas || !slot.spec.bancos?.length) return 0;
    const pidMorto = slot.ultimaSaida?.pid ?? null;
    let wait = 0;
    for (const name of slot.spec.bancos) {
      let info = null;
      try { info = travas.inspecionar(`${travas.dir}/${name}.db`, { staleMs: travas.staleMs }); } catch { info = null; }
      const dono = info?.owner?.pid;
      if (!info?.exists || info.stale || !dono) continue;
      if (info.owner?.hostname && travas.hostname && info.owner.hostname !== travas.hostname) continue;
      let morto = dono === pidMorto;
      if (!morto && typeof travas.processoExiste === 'function') {
        try { morto = travas.processoExiste(dono) === false; } catch { morto = false; }
      }
      if (!morto) continue;
      wait = Math.max(wait, travas.staleMs - (info.heartbeatAgeMs ?? 0) + travas.heartbeatMs);
    }
    return Math.max(0, Math.round(wait));
  }

  function agendar(slot, esperaMs, motivo) {
    if (estadoGeral === 'parando' || estadoGeral === 'parado') return;
    relogio.clearTimeout(slot.timer);
    slot.estado = 'esperando';
    slot.proximaEm = agora() + esperaMs;
    if (motivo) log('info', `${slot.spec.papel}: sobe em ${(esperaMs / 1000).toFixed(1)} s (${motivo}).`);
    slot.timer = relogio.setTimeout(() => { slot.timer = null; tentarSubir(slot); }, esperaMs);
    slot.timer?.unref?.();
    salvar();
  }

  function tentarSubir(slot) {
    if (estadoGeral !== 'rodando' || slot.proc) return;
    const dep = slot.spec.depende ? slots.get(slot.spec.depende) : null;
    if (dep && dep.estado !== 'pronto') {
      slot.aguardandoDesde ??= agora();
      const esperou = agora() - slot.aguardandoDesde;
      if (esperou < t.esperaCerebroMs) {
        if (!slot.avisouEspera) { log('info', `${slot.spec.papel}: esperando o ${dep.spec.papel} ficar pronto (até ${Math.round(t.esperaCerebroMs / 1000)} s).`); slot.avisouEspera = true; }
        slot.estado = 'aguardando';
        slot.timer = relogio.setTimeout(() => { slot.timer = null; tentarSubir(slot); }, Math.min(250, Math.max(10, t.esperaCerebroMs - esperou)));
        slot.timer?.unref?.();
        return;
      }
      log('aviso', `${slot.spec.papel}: o ${dep.spec.papel} não ficou pronto em ${Math.round(t.esperaCerebroMs / 1000)} s; subo assim mesmo (ele reconecta sozinho quando o ${dep.spec.papel} voltar).`);
    }
    const lockWait = esperaTravas(slot);
    if (lockWait > 0) {
      if (!slot.avisouTrava) {
        log('aviso', `${slot.spec.papel}: o processo anterior caiu sem soltar as travas de dono; espero ${(lockWait / 1000).toFixed(1)} s elas vencerem (nada é apagado à força).`);
        slot.avisouTrava = true;
      }
      slot.estado = 'esperando';
      slot.proximaEm = agora() + lockWait;
      slot.timer = relogio.setTimeout(() => { slot.timer = null; tentarSubir(slot); }, lockWait);
      slot.timer?.unref?.();
      salvar();
      return;
    }
    subir(slot);
  }

  function subir(slot) {
    slot.aguardandoDesde = null;
    slot.avisouEspera = false;
    slot.avisouTrava = false;
    slot.proximaEm = null;
    slot.falhasSaude = 0;
    slot.discordForaDesde = null;
    slot.canalForaDesde = null;
    slot.pedidoReinicio = null;
    slot.prontoEm = null;
    let proc;
    try {
      proc = spawnFilho(slot.spec);
    } catch (err) {
      log('erro', `${slot.spec.papel}: não consegui abrir o processo (${err?.code || err?.message}).`);
      slot.ultimaSaida = { code: null, signal: null, em: new Date(agora()).toISOString(), pid: null, erro: String(err?.code || err?.message) };
      aposSaida(slot, 'falha ao abrir');
      return;
    }
    slot.proc = proc;
    slot.pid = proc.pid ?? null;
    slot.estado = slot.spec.ipc ? 'subindo' : 'pronto';
    slot.iniciadoEm = agora();
    if (!slot.spec.ipc) slot.prontoEm = slot.iniciadoEm;
    slot.inicios += 1;
    evento(slot, `subiu (pid ${slot.pid})`);
    log('info', `${slot.spec.papel}: subiu (início nº ${slot.inicios}, pid ${slot.pid ?? '?'}).`);
    let saiu = false;
    const onExit = (code, signal) => {
      if (saiu) return;
      saiu = true;
      onSaida(slot, proc, code ?? null, signal ?? null);
    };
    proc.on('exit', onExit);
    proc.on('error', (err) => {
      log('erro', `${slot.spec.papel}: erro no processo (${err?.code || err?.message}).`);
      if (!proc.pid) onExit(null, null);
    });
    if (slot.spec.ipc) proc.on('message', (m) => onMensagem(slot, proc, m));
    salvar();
  }

  function onMensagem(slot, proc, m) {
    if (!m || typeof m !== 'object' || slot.proc !== proc) return;
    if (m.tipo === 'pronto') {
      slot.estado = 'pronto';
      slot.prontoEm = agora();
      evento(slot, 'pronto');
      log('info', `${slot.spec.papel}: pronto em ${((slot.prontoEm - slot.iniciadoEm) / 1000).toFixed(1)} s.`);
      salvar();
      // Quem espera por este (o bot espera o cérebro) tenta já, sem esperar o próximo ciclo.
      for (const other of slots.values()) {
        if (other.spec.depende === slot.spec.papel && other.estado === 'aguardando' && !other.proc) {
          relogio.clearTimeout(other.timer);
          other.timer = null;
          tentarSubir(other);
        }
      }
    } else if (m.tipo === 'saude' && m.id && pendentesSaude.has(m.id)) {
      const resolve = pendentesSaude.get(m.id);
      pendentesSaude.delete(m.id);
      resolve(m);
    } else if (m.tipo === 'reiniciar') {
      const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null;
      const responder = (r) => { try { proc.send({ tipo: 'reinicio', id, aceito: r.aceito === true, motivo: r.motivo }); } catch { /* o canal caiu: o pedido não tem a quem responder */ } };
      // O motivo do pedido vira UMA palavra fixa (minúsculas e hífen): o supervisor nunca registra texto livre vindo do filho.
      const motivo = typeof m.motivo === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(m.motivo) ? m.motivo : 'sem-motivo';
      responder(reiniciarTudo(motivo, { origem: slot.spec.papel }));
    }
  }

  /**
   * Pedido de REINÍCIO CONTROLADO dos dois processos (o dono, pelo app). Só aceita se: o modo é "dois", o pedido veio do CÉREBRO (o processo que conferiu o
   * dono e a confirmação; o bot nunca pede), o supervisor está rodando e não há outro reinício em curso. Devolve { aceito, motivo } na hora; o
   * reinício em si roda depois (`reinicioAtrasoMs`, para a resposta HTTP do cérebro sair antes de o bot e o cérebro pararem).
   */
  function reiniciarTudo(motivo = 'pedido-do-dono', { origem = 'cerebro' } = {}) {
    if (modo !== 'dois') return { aceito: false, motivo: 'modo-unico' };
    if (origem !== 'cerebro') {
      log('aviso', `${origem}: pedido de reinício RECUSADO (só o cérebro pode pedir; ele confere o dono e a confirmação).`);
      return { aceito: false, motivo: 'origem-nao-permitida' };
    }
    if (estadoGeral !== 'rodando') return { aceito: false, motivo: 'supervisor-parando' };
    if (reinicioEmCurso) return { aceito: false, motivo: 'ja-em-curso' };
    reinicioEmCurso = { motivo, desde: agora() };
    reinicios += 1;
    ultimoReinicio = { em: new Date(agora()).toISOString(), motivo, origem };
    log('aviso', `REINÍCIO CONTROLADO dos dois processos (${motivo}, pedido por: ${origem}): ${[...ordem].reverse().join(' -> ')} param e ${ordem.join(' -> ')} sobem de novo.`);
    for (const s of slots.values()) evento(s, `reinício controlado pedido (${motivo})`);
    salvar();
    const t0 = relogio.setTimeout(() => { executarReinicio().catch((err) => log('erro', `reinício controlado: falha inesperada (${err?.message})`)); }, t.reinicioAtrasoMs);
    t0?.unref?.();
    return { aceito: true, motivo: 'aceito' };
  }

  /** O reinício controlado: para na ordem inversa (cada um pelo pedido limpo; no prazo estourado, pelo handle) e sobe na ordem de sempre. */
  async function executarReinicio() {
    const r = reinicioEmCurso;
    if (!r) return;
    try {
      for (const papel of [...ordem].reverse()) {
        if (estadoGeral !== 'rodando') return; // uma parada pedida no meio vence
        const s = slots.get(papel);
        relogio.clearTimeout(s.timer);
        s.timer = null;
        s.proximaEm = null;
        s.aguardandoDesde = null;
        if (!s.proc) { s.estado = 'parado'; continue; } // esperando para subir: a subida abaixo cuida dele
        s.pedidoReinicio = `reinício controlado (${r.motivo})`;
        await pararFilho(s, `reinício controlado (${r.motivo})`);
      }
      if (estadoGeral !== 'rodando') return;
      // Não foi uma queda: a contagem de quedas seguidas e a espera crescente recomeçam do zero.
      for (const s of slots.values()) { s.quedasSeguidas = 0; s.pedidoReinicio = null; }
      for (const papel of ordem) tentarSubir(slots.get(papel));
      log('info', `Reinício controlado: ${ordem.join(' -> ')} sobem de novo (a parada levou ${((agora() - r.desde) / 1000).toFixed(1)} s).`);
    } finally {
      reinicioEmCurso = null;
      salvar();
    }
  }

  function onSaida(slot, proc, code, signal) {
    if (slot.proc !== proc) return;
    slot.proc = null;
    const duracaoMs = slot.iniciadoEm ? agora() - slot.iniciadoEm : null;
    slot.ultimaSaida = { code, signal, em: new Date(agora()).toISOString(), pid: slot.pid, duracaoMs };
    evento(slot, `saiu (código ${code ?? '-'}${signal ? `, sinal ${signal}` : ''})`);
    const waiters = esperasSaida.get(slot.spec.papel) ?? [];
    esperasSaida.delete(slot.spec.papel);
    for (const w of waiters) w();
    if (estadoGeral === 'parando' || estadoGeral === 'parado') {
      slot.estado = 'parado';
      log('info', `${slot.spec.papel}: parou (código ${code ?? '-'}).`);
      salvar();
      return;
    }
    // Reinício controlado em curso: quem sai agora saiu porque o supervisor o parou (ou caiu no meio); a subida é feita por executarReinicio,
    // sem queda seguida e sem a espera crescente.
    if (reinicioEmCurso) {
      slot.estado = 'parado';
      slot.pedidoReinicio = null;
      log('info', `${slot.spec.papel}: parou para o reinício controlado (código ${code ?? '-'}).`);
      salvar();
      return;
    }
    aposSaida(slot, slot.pedidoReinicio ? `religado: ${slot.pedidoReinicio}` : `saiu sozinho com código ${code ?? '-'}${signal ? ` (${signal})` : ''}`);
  }

  function aposSaida(slot, motivo) {
    // Ficou de pé tempo bastante: a queda de agora é a primeira de uma série nova.
    if (slot.prontoEm && agora() - slot.prontoEm >= t.estavelMs) slot.quedasSeguidas = 0;
    slot.quedasSeguidas += 1;
    slot.religadas += 1;
    slot.prontoEm = null;
    const espera = slot.spec.ipc ? calcularEspera(slot.quedasSeguidas, t) : t.unicoReinicioMs;
    log(slot.pedidoReinicio ? 'aviso' : 'erro', `${slot.spec.papel}: ${motivo}; queda seguida nº ${slot.quedasSeguidas}.`);
    slot.pedidoReinicio = null;
    agendar(slot, espera, `espera ${slot.spec.ipc ? 'crescente' : 'fixa'}`);
  }

  /** Espera o processo do slot sair (ou o prazo). true se saiu. */
  function esperarSaida(slot, ms) {
    if (!slot.proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const fim = (v) => { if (!done) { done = true; relogio.clearTimeout(timer); resolve(v); } };
      const timer = relogio.setTimeout(() => fim(false), ms);
      const list = esperasSaida.get(slot.spec.papel) ?? [];
      list.push(() => fim(true));
      esperasSaida.set(slot.spec.papel, list);
    });
  }

  /** Para UM processo: pedido limpo pelo IPC; se não sair no prazo, encerra pelo HANDLE guardado na abertura. */
  async function pararFilho(slot, motivo) {
    const proc = slot.proc;
    if (!proc) return true;
    slot.estado = 'parando';
    salvar();
    if (slot.spec.ipc && proc.connected !== false) {
      try { proc.send({ tipo: 'desligar', motivo }); } catch { /* canal já caiu */ }
      if (await esperarSaida(slot, t.paradaMs)) return true;
      log('aviso', `${slot.spec.papel}: não saiu em ${Math.round(t.paradaMs / 1000)} s depois do pedido limpo; encerrando pelo handle (o processo que este supervisor abriu).`);
    }
    try { proc.kill(); } catch { /* já saiu */ }
    if (await esperarSaida(slot, 5_000)) return true;
    log('erro', `${slot.spec.papel}: o processo não saiu nem depois de encerrado pelo handle.`);
    return false;
  }

  /** Religa só um processo (travado, Discord fora...). A espera crescente vale como numa queda. */
  async function religar(slot, motivo) {
    if (slot.pedidoReinicio || !slot.proc || estadoGeral !== 'rodando') return;
    slot.pedidoReinicio = motivo;
    log('aviso', `RELIGANDO ${slot.spec.papel}: ${motivo}.`);
    await pararFilho(slot, motivo);
  }

  function perguntarSaude(slot) {
    const proc = slot.proc;
    if (!proc || !slot.spec.ipc) return Promise.resolve(null);
    const id = `s${++seq}`;
    return new Promise((resolve) => {
      const timer = relogio.setTimeout(() => { pendentesSaude.delete(id); resolve(null); }, t.prazoSaudeMs);
      pendentesSaude.set(id, (m) => { relogio.clearTimeout(timer); resolve(m); });
      try { proc.send({ tipo: 'saude', id }); } catch { relogio.clearTimeout(timer); pendentesSaude.delete(id); resolve(null); }
    });
  }

  async function verificarSlot(slot) {
    if (!slot.proc || !slot.spec.ipc || slot.pedidoReinicio || slot.estado === 'parando') return;
    if (slot.estado === 'subindo' && agora() - slot.iniciadoEm > t.subidaMs) {
      await religar(slot, `não avisou "pronto" em ${Math.round(t.subidaMs / 1000)} s`);
      return;
    }
    const r = await perguntarSaude(slot);
    if (!slot.proc || slot.pedidoReinicio) return;
    if (!r || r.ok !== true) {
      slot.falhasSaude += 1;
      log('aviso', `${slot.spec.papel}: sem resposta de saúde (${slot.falhasSaude} de ${t.falhasParaReligar}).`);
      if (slot.estado === 'pronto' && slot.falhasSaude >= t.falhasParaReligar) await religar(slot, `não respondeu à saúde ${slot.falhasSaude} vezes seguidas (travado)`);
      return;
    }
    slot.falhasSaude = 0;
    slot.ultimaSaude = { em: new Date(agora()).toISOString(), uso: r.uso ?? null, pronto: r.pronto ?? null, canal: r.canal ?? null, discord: r.discord ?? null, bot: r.bot ?? null };
    if (slot.spec.papel !== 'bot' || slot.estado !== 'pronto') return;
    // Discord fora (o falso dos testes nunca fica fora).
    if (r.discord === false) {
      slot.discordForaDesde ??= agora();
      const fora = agora() - slot.discordForaDesde;
      if (fora >= t.discordForaMs) { await religar(slot, `o Discord está fora há ${Math.round(fora / 1000)} s`); return; }
    } else slot.discordForaDesde = null;
    // Sem o canal com o cérebro, com o cérebro pronto (cérebro fora não é culpa do bot).
    const cerebro = slots.get('cerebro');
    if (r.canal === false && cerebro?.estado === 'pronto') {
      slot.canalForaDesde ??= agora();
      const fora = agora() - slot.canalForaDesde;
      if (fora >= t.canalForaMs) await religar(slot, `sem o canal com o cérebro há ${Math.round(fora / 1000)} s (cérebro pronto)`);
    } else slot.canalForaDesde = null;
  }

  async function rodadaDeSaude() {
    if (rodadaSaude || estadoGeral !== 'rodando') return;
    rodadaSaude = true;
    try {
      await Promise.all([...slots.values()].map((s) => verificarSlot(s).catch((err) => log('aviso', `${s.spec.papel}: falha na verificação (${err?.message})`))));
    } finally {
      rodadaSaude = false;
      salvar(false);
    }
  }

  return {
    /** Sobe tudo (o cérebro primeiro; o bot espera ele ficar pronto). */
    iniciar() {
      if (estadoGeral === 'rodando') return;
      estadoGeral = 'rodando';
      iniciadoEm = agora();
      log('info', `Supervisor no modo ${modo === 'dois' ? 'DOIS PROCESSOS (cérebro + bot)' : 'PROCESSO ÚNICO (como o laço da tarefa)'}; ordem de subida: ${ordem.join(' -> ')}.`);
      for (const papel of ordem) tentarSubir(slots.get(papel));
      if (modo === 'dois') {
        saudeTimer = relogio.setInterval(() => { rodadaDeSaude(); }, t.saudeMs);
        saudeTimer?.unref?.();
      }
      salvar();
    },
    /** Para tudo na ordem inversa (o bot antes do cérebro). Nunca lança. */
    async parar(motivo = 'pedido') {
      if (estadoGeral === 'parado' || estadoGeral === 'parando') return;
      estadoGeral = 'parando';
      log('info', `Parando (${motivo}): ${[...ordem].reverse().join(' -> ')}.`);
      relogio.clearInterval(saudeTimer);
      saudeTimer = null;
      for (const s of slots.values()) { relogio.clearTimeout(s.timer); s.timer = null; s.proximaEm = null; if (!s.proc) s.estado = 'parado'; }
      for (const papel of [...ordem].reverse()) {
        const s = slots.get(papel);
        await pararFilho(s, motivo);
        s.estado = 'parado';
      }
      estadoGeral = 'parado';
      log('info', 'Tudo parado.');
      salvar();
    },
    /** Uma rodada de saúde agora (os testes usam; em produção roda sozinha a cada saudeMs). */
    verificarAgora: rodadaDeSaude,
    /** Reinício controlado dos dois processos (o mesmo que o cérebro pede por IPC). Devolve { aceito, motivo }. Os testes usam; em produção só o IPC do cérebro chega aqui. */
    reiniciarTudo,
    /** SÓ PARA TESTE (a entrada só aceita com NODE_ENV=test): derruba à força, pelo handle, o processo que este supervisor abriu. */
    simularQueda(papel) {
      const alvo = papel === 'todos' ? [...slots.values()] : [slots.get(papel)].filter(Boolean);
      let n = 0;
      for (const s of alvo) if (s.proc) { try { s.proc.kill(); n += 1; } catch { /* */ } }
      return n;
    },
    estado: snapshot,
    get modo() { return modo; },
  };
}
