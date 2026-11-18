// Lado do PROCESSO FILHO da conversa com o supervisor dos dois processos (etapa 4, docs/RELATORIO_ETAPA4_OPERACAO.md).
//
// O YuiCerebro (src/cerebro.js) e o YuiBot separado (src/index.js com YUI_CEREBRO_EXTERNO=true) usam isto quando foram
// abertos com canal IPC (pelo supervisor src/supervisor.js ou por um teste). Sem IPC (o laço da tarefa de hoje, ou um terminal)
// nada daqui faz efeito.
//
// Mensagens (objetos pequenos, sem dado pessoal):
//  - filho -> pai: { tipo: 'pronto', papel, pid }                  quando a subida terminou;
//  - pai -> filho: { tipo: 'saude', id }                          pergunta de saúde;
//  - filho -> pai: { tipo: 'saude', id, papel, ok, ...dados }     resposta, com RAM e CPU do próprio processo;
//  - pai -> filho: { tipo: 'desligar' }                           desligamento limpo.
//  - filho -> pai: { tipo: 'reiniciar', id, papel, motivo }       pedido de reinício controlado dos dois processos (etapa 10: o dono, pelo app;
//                                                                  SÓ o cérebro pede, depois de conferir o dono e a confirmação; o motivo é uma palavra fixa);
//  - pai -> filho: { tipo: 'reinicio', id, aceito, motivo }       a resposta: aceito, ou recusado com uma palavra fixa (o filho só ouve do pai que o abriu).
// Se o pai sumir (o canal IPC cai: supervisor encerrado de qualquer jeito), o filho se desliga sozinho, de forma limpa. Assim
// nunca sobra um bot órfão com o token (o próximo supervisor abriria outro) nem um cérebro segurando as travas.
// Este arquivo é importado pelo cérebro: não pode alcançar o Discord (tests/test-core-import-graph.js).

let lastCpu = null;
let lastCpuAt = 0;

/** RAM e CPU deste processo (CPU em % de UM núcleo desde a última leitura; null na primeira). */
export function processUsage(now = Date.now()) {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  let cpuPct = null;
  if (lastCpu && now > lastCpuAt) {
    const usedMicros = (cpu.user - lastCpu.user) + (cpu.system - lastCpu.system);
    cpuPct = Math.round((usedMicros / 1000 / (now - lastCpuAt)) * 1000) / 10;
  }
  lastCpu = cpu;
  lastCpuAt = now;
  return {
    rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    heapMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
    cpuPct,
    uptimeSeconds: Math.round(process.uptime()),
  };
}

/**
 * Liga este processo ao supervisor (se houver canal IPC). Devolve { pronto(), ativo }.
 * @param {{ papel: string, saude: () => object, desligar: (motivo: string) => void, proc?: NodeJS.Process }} options
 */
export function ligarAoSupervisor({ papel, saude, desligar, proc = process }) {
  // Sem supervisor (rodado à mão): nenhum pedido de reinício pode ser feito, e por isso a resposta diz a verdade: ninguém religaria este processo.
  if (typeof proc.send !== 'function' || !proc.connected) return { ativo: false, pronto() {}, pedirReinicio: async () => ({ aceito: false, motivo: 'sem-supervisor' }) };
  const enviar = (msg) => {
    try { if (proc.connected) proc.send(msg); } catch { /* o pai saiu: o 'disconnect' cuida do resto */ }
  };
  let seq = 0;
  const pedidos = new Map(); // id -> resolve (pedidos de reinício esperando a resposta do supervisor)
  proc.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.tipo === 'reinicio') {
      const resolve = pedidos.get(m.id);
      if (resolve) { pedidos.delete(m.id); resolve({ aceito: m.aceito === true, motivo: typeof m.motivo === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(m.motivo) ? m.motivo : 'sem-motivo' }); }
    } else if (m.tipo === 'saude') {
      let dados;
      try { dados = { ok: true, ...(saude() || {}) }; } catch (err) { dados = { ok: false, erro: String(err?.message ?? err).slice(0, 120) }; }
      enviar({ tipo: 'saude', id: m.id ?? null, papel, pid: proc.pid, uso: processUsage(), ...dados });
    } else if (m.tipo === 'desligar') {
      desligar('pedido do supervisor');
    }
  });
  proc.on('disconnect', () => desligar('o supervisor (processo pai) saiu'));
  return {
    ativo: true,
    pronto() { enviar({ tipo: 'pronto', papel, pid: proc.pid }); },
    /**
     * Pede ao supervisor o reinício controlado dos dois processos. Só quem conferiu o dono e a confirmação (a API do cérebro) deve chamar.
     * Devolve { aceito, motivo } (nunca lança): sem resposta no prazo, `sem-resposta` (não se sabe se o reinício começou).
     */
    pedirReinicio({ motivo = 'pedido-do-dono', timeoutMs = 4_000 } = {}) {
      return new Promise((resolve) => {
        const id = `r${++seq}`;
        const timer = setTimeout(() => { pedidos.delete(id); resolve({ aceito: false, motivo: 'sem-resposta' }); }, timeoutMs);
        timer.unref?.();
        pedidos.set(id, (r) => { clearTimeout(timer); resolve(r); });
        if (!proc.connected) { clearTimeout(timer); pedidos.delete(id); resolve({ aceito: false, motivo: 'sem-supervisor' }); return; }
        try { proc.send({ tipo: 'reiniciar', id, papel, motivo }); } catch { clearTimeout(timer); pedidos.delete(id); resolve({ aceito: false, motivo: 'sem-supervisor' }); }
      });
    },
  };
}
