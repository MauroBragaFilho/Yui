// A configuração da integração com o Google (etapa 15): tudo DESLIGADO por padrão.
//   YUI_GOOGLE=true              liga a leitura da Agenda e das Tarefas do dono (somente leitura). Padrão: false (nada muda, nenhuma chamada ao Google).
//   YUI_GOOGLE_GMAIL=true        libera o código do Gmail (somente leitura), mas ele SÓ funciona com a rota privada de IA validada. Padrão: false.
//   YUI_GOOGLE_TOKEN_ARQUIVO     o arquivo da autorização (padrão: secrets/google-token.json, pasta ignorada pelo git).
//   YUI_GOOGLE_FUSO              o fuso dos "hoje", "amanhã" e "semana" (nome IANA). Se não existir (ou for inválido), vale o fuso do dono, YUI_FUSO (padrão America/Sao_Paulo).
//   YUI_GOOGLE_REAUTORIZAR_PAINEL=true   libera reautorizar pelo painel web (reautorizar.js; só Agenda e Tarefas, nunca o Gmail). Padrão: false (só o script renova).
import path from 'node:path';
import { FUSO_PADRAO as FUSO_DO_CODIGO, fusoValido as fusoIanaValido, fusoDoDono } from '../../core/fuso.js';

const RAIZ = path.resolve(import.meta.dirname, '..', '..', '..');

export const FUSO_PADRAO = FUSO_DO_CODIGO;
/** Prazo de cada chamada ao Google (uma tentativa só). */
export const PRAZO_DA_CHAMADA_MS = 10_000;

const LIGADO = new Set(['true', '1', 'on', 'sim', 'yes']);
const ligada = (v) => LIGADO.has(String(v ?? '').trim().toLowerCase());

/** A integração com o Google está ligada? (YUI_GOOGLE; padrão: não) */
export function googleLigado(env = process.env) {
  return ligada(env?.YUI_GOOGLE);
}

/** O Gmail está liberado pela chave? (YUI_GOOGLE_GMAIL, e só com o Google ligado; a rota privada de IA é outra condição, conferida no gmail.js) */
export function gmailLigadoPelaChave(env = process.env) {
  return googleLigado(env) && ligada(env?.YUI_GOOGLE_GMAIL);
}

/**
 * A EXCEÇÃO EXPLÍCITA DO DONO (YUI_GOOGLE_SEM_ROTA_PRIVADA, padrão false): só com o texto exato `true` (nada de "1", "sim" ou "on": é uma decisão expressa) a Agenda
 * e as Tarefas dispensam o portão da rota privada de IA, e o texto delas passa pela IA em nuvem (nunca por provedor anônimo). NUNCA vale para o Gmail.
 * Sem YUI_GOOGLE ligado não vale nada.
 */
export function semRotaPrivadaPelaChave(env = process.env) {
  return googleLigado(env) && env?.YUI_GOOGLE_SEM_ROTA_PRIVADA === 'true';
}

/**
 * Reautorizar o Google pelo painel web (lacunas do painel, entrega F, item 14; YUI_GOOGLE_REAUTORIZAR_PAINEL, padrão false): só o texto `true` liga (como as outras
 * ações do painel). Lida A CADA PEDIDO só pela API do painel (o cérebro, com os dois processos; o processo único, sem eles). Não depende de YUI_GOOGLE: basta já
 * existir um arquivo de autorização (a primeira vez continua pelo script).
 */
export function reautorizacaoPeloPainelLigada(env = process.env) {
  return String(env?.YUI_GOOGLE_REAUTORIZAR_PAINEL ?? '').trim().toLowerCase() === 'true';
}

/** O caminho do arquivo da autorização. */
export function arquivoDoToken(env = process.env) {
  const configurado = String(env?.YUI_GOOGLE_TOKEN_ARQUIVO ?? '').trim();
  return configurado ? path.resolve(configurado) : path.join(RAIZ, 'secrets', 'google-token.json');
}

/** O mesmo caminho padrão, para o script de autorização gravar no lugar onde a Yui procura. */
export function arquivoDoTokenPadrao() {
  return path.join(RAIZ, 'secrets', 'google-token.json');
}

export const fusoValido = fusoIanaValido;

/** O fuso das consultas: YUI_GOOGLE_FUSO se for um nome IANA válido; senão o fuso do dono (YUI_FUSO, padrão America/Sao_Paulo). */
export function fusoDoGoogle(env = process.env) {
  const bruto = String(env?.YUI_GOOGLE_FUSO ?? '').trim();
  return bruto && fusoValido(bruto) ? bruto : fusoDoDono(env);
}
