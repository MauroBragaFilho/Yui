// Datas no FUSO do dono (YUI_GOOGLE_FUSO, ou YUI_FUSO se não existir), sem biblioteca: só o Intl do Node. "Hoje", "amanhã" e "semana" são dias do fuso, não do servidor nem de UTC.
// As contas de fuso moram em src/core/fuso.js (uma só implementação); aqui ficam só as de agenda.
import { partesNoFuso, deslocamentoMs, inicioDoDia, somarDias } from '../../core/fuso.js';
export { partesNoFuso, deslocamentoMs, inicioDoDia, somarDias };

const DIAS = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.'];
const pad = (n) => String(n).padStart(2, '0');

/**
 * A janela de uma consulta: "hoje", "amanha" ou "semana" (os próximos 7 dias, a partir do começo de hoje).
 * @returns {{ de: Date, ate: Date, rotulo: string, dias: number }}  `de` inclusive, `ate` exclusivo
 */
export function janelaDeConsulta(tipo, agora, fuso) {
  const hoje = partesNoFuso(agora, fuso);
  const base = { ano: hoje.ano, mes: hoje.mes, dia: hoje.dia };
  const [dia0, dias, rotulo] = tipo === 'amanha' ? [1, 1, 'amanhã'] : tipo === 'semana' ? [0, 7, 'os próximos 7 dias'] : tipo === 'mes' ? [0, 30, 'os próximos 30 dias'] : tipo === 'ano' ? [0, 365, 'o próximo ano'] : [0, 1, 'hoje'];
  const ini = somarDias(base, dia0);
  const fim = somarDias(base, dia0 + dias);
  return { de: inicioDoDia(ini.ano, ini.mes, ini.dia, fuso), ate: inicioDoDia(fim.ano, fim.mes, fim.dia, fuso), rotulo, dias };
}

/** "HH:MM" de um instante no fuso. */
export function formatarHora(instante, fuso) {
  const p = partesNoFuso(instante, fuso);
  return `${pad(p.hora)}:${pad(p.minuto)}`;
}

/** "sex., 20/11" de um instante no fuso (ou de uma data "AAAA-MM-DD" puxada de um evento de dia inteiro). */
export function formatarDia(instanteOuData, fuso) {
  if (typeof instanteOuData === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(instanteOuData)) {
    const [a, m, d] = instanteOuData.split('-').map(Number);
    const semana = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
    return `${DIAS[semana]}, ${pad(d)}/${pad(m)}`;
  }
  const p = partesNoFuso(instanteOuData, fuso);
  return `${DIAS[p.semana]}, ${pad(p.dia)}/${pad(p.mes)}`;
}

/** A data de hoje no fuso, "AAAA-MM-DD". */
export function dataDeHoje(agora, fuso) {
  const p = partesNoFuso(agora, fuso);
  return `${p.ano}-${pad(p.mes)}-${pad(p.dia)}`;
}
