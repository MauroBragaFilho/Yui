// A PORTA DE ENTRADA da integração com o Google (etapa 15) para o resto da Yui: uma instância por conjunto de variáveis de ambiente (a do processo, ou a que o teste passar),
// criada só quando a chave YUI_GOOGLE está ligada. Com a chave desligada nada aqui toca o Google, o disco nem o log: devolve null e tudo segue como sempre.
import { googleLigado } from './config.js';
import { criarGoogle } from './google.js';

let instancias = new WeakMap();

/** A instância do Google para estas variáveis de ambiente (criada na primeira vez que a chave está ligada). */
export function googleDoProcesso(env = process.env, deps = {}) {
  let g = instancias.get(env);
  if (!g) { g = criarGoogle({ env, ...deps }); instancias.set(env, g); }
  return g;
}

/** Só para teste: esquece as instâncias (e o estado do autenticador de cada uma). */
export function reiniciarGoogleParaTeste() { instancias = new WeakMap(); }

/**
 * A pré-rota do cérebro (uma chamada só no passo da conversa). null = nada a fazer (chave desligada, pedido que não é do Google, não é o dono...).
 * @param {{ ctx: object, call?: object, texto: string, prompt: string, env?: object }} p
 * @returns {null | Promise<null | { resposta: string } | { prompt: string, opcoes: object, revisar: (t: string) => string, tipo: string }>}  null (sem Promise) com a chave desligada
 */
export function preRotaGoogle({ ctx, call = {}, texto, prompt, env = process.env, deps = {} }) {
  // Chave desligada: devolve null NA HORA (sem Promise, sem esperar um ciclo): o passo da conversa fica idêntico ao de antes.
  if (!googleLigado(env)) return null;
  return (async () => {
    try {
      return await googleDoProcesso(env, deps).rotear({ ctx, call, texto, prompt });
    } catch {
      return null; // um defeito aqui nunca derruba a conversa: segue como sempre
    }
  })();
}

/** As linhas do relatório matinal ("Agenda e tarefas de hoje") ou null (desligado, sem conexão ou falha: o relatório fica idêntico). */
export async function linhasDoRelatorioMatinal({ env = process.env, now = new Date(), deps = {} } = {}) {
  if (!googleLigado(env)) return null;
  try {
    return await googleDoProcesso(env, deps).linhasDoRelatorio(now);
  } catch {
    return null;
  }
}
