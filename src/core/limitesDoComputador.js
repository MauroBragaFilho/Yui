// OS LIMITES DE RAM E DISCO DO COMPUTADOR, numa regra só (Fase 1 do painel, regra R10 da matriz do painel):
// o alerta por DM (src/cerebro/eventos.js) e o Início do painel (GET /v1/admin/overview, campo host.alerta) leem daqui.
// Antes o Início tinha a própria regra no app (porcentagem fixa: abaixo de 15% livre "atenção", de 8% "crítico") e media outra pasta,
// então o Início e a DM podiam discordar. Agora o servidor manda a medida e o nível, e o app só mostra.
//
// - Limites: YUI_ALERTA_DISCO_GB (padrão 5 GB) e YUI_ALERTA_RAM_MB (padrão 400 MB); 0 desliga a verificação. YUI_ALERTA_RAM_MIN (padrão 5)
//   é quantos minutos seguidos a RAM precisa ficar baixa para o alerta por DM sair (o Início mostra a leitura do momento).
// - Disco: o espaço livre na pasta dos dados (DATABASE_DIR, quando existe; senão a pasta de trabalho), a mesma que o alerta mede.
// - Nível: "critico" abaixo do limite (a mesma condição do alerta); "atencao" abaixo do dobro do limite (chegando perto); "ok" acima;
//   null sem leitura ou com o limite desligado.
import fs from 'node:fs';

/** Número de um limite: vazio, inválido ou abaixo do mínimo = o padrão. */
export function numeroDoLimite(valor, padrao, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const bruto = String(valor ?? '').trim();
  const n = Number(bruto);
  return bruto !== '' && Number.isFinite(n) && n >= min ? Math.min(max, n) : padrao;
}

/** Os limites do alerta de disco e de RAM (os mesmos do alerta por DM). */
export function limitesDoComputador(env = process.env) {
  return {
    discoGB: numeroDoLimite(env.YUI_ALERTA_DISCO_GB, 5),
    ramMB: numeroDoLimite(env.YUI_ALERTA_RAM_MB, 400),
    ramMin: numeroDoLimite(env.YUI_ALERTA_RAM_MIN, 5),
  };
}

/** A pasta cujo disco é medido: a dos dados (DATABASE_DIR) quando ela existe; senão a pasta de trabalho. */
export function pastaDoDisco(env = process.env, { fsImpl = fs, cwd = () => process.cwd() } = {}) {
  const dir = env.DATABASE_DIR;
  try {
    if (dir && fsImpl.existsSync(dir)) return dir;
  } catch { /* sem acesso: a pasta de trabalho */ }
  return cwd();
}

/** O nível de um recurso pelo espaço livre e o limite do alerta. */
export function nivelDoLivre(livre, limite) {
  if (livre === null || livre === undefined || !Number.isFinite(livre)) return null;
  if (!(Number.isFinite(limite) && limite > 0)) return null;
  if (livre < limite) return 'critico';
  if (livre < limite * 2) return 'atencao';
  return 'ok';
}
