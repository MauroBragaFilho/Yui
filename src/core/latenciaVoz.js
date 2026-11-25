// Medição de latência da voz (Fase 1). Módulo puro: sem Discord, TTS ou handlers.
// As durações são LOCAIS a cada processo (bot e cérebro têm relógios próprios): nunca se subtrai um relógio do outro.
// A linha de log leva só o id do turno (hex) e inteiros em ms: nunca texto de conversa.

export const ETAPAS = Object.freeze(['stt', 'fila', 'ctx', 'prov', 'ferr', 'tts', 'entrega', 'total']);

const inteiro = (n) => (Number.isFinite(n) && n >= 0 ? Math.round(n) : null);

/** Só caracteres seguros de id: o que sobra de um id estranho nunca vira texto de conversa no log. */
const idSeguro = (id) => {
  const s = String(id ?? '').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 32);
  return s || '-';
};

/** Monta a linha única de latência. Etapa ausente (ou inválida) sai "-". */
export function formatarLinha(turnoId, etapas = {}) {
  const e = etapas && typeof etapas === 'object' ? etapas : {};
  const partes = ETAPAS.map((nome) => {
    const v = inteiro(e[nome]);
    return `${nome}=${v === null ? '-' : v}`;
  });
  return `[VOZ-LAT] turno=${idSeguro(turnoId)} ${partes.join(' ')}`;
}

/**
 * Medidor de um turno. `relogio` devolve ms (padrão Date.now); injetável para teste.
 * inicio/fim fora de ordem não lançam e nunca produzem duração negativa; fim sem inicio é ignorado.
 */
export function criarMedidor({ turnoId = null, relogio = Date.now } = {}) {
  const agora = () => {
    try {
      const t = relogio();
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  };
  const inicios = new Map();
  const etapas = {};

  const marcar = (etapa, ms) => {
    if (!ETAPAS.includes(etapa)) return;
    const v = inteiro(ms);
    if (v !== null) etapas[etapa] = v;
  };

  return {
    inicio(etapa) {
      const t = agora();
      if (t !== null && ETAPAS.includes(etapa)) inicios.set(etapa, t);
    },
    fim(etapa) {
      const t0 = inicios.get(etapa);
      const t = agora();
      if (t0 === undefined || t === null) return;
      inicios.delete(etapa);
      marcar(etapa, Math.max(0, t - t0));
    },
    marcar,
    valores() {
      return { ...etapas };
    },
    linha() {
      return formatarLinha(turnoId, etapas);
    },
  };
}
