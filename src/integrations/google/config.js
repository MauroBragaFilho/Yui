// A configuração da integração com o Google (etapa 15): tudo DESLIGADO por padrão.
//   YUI_GOOGLE=true              liga a leitura da Agenda e das Tarefas do dono (somente leitura). Padrão: false (nada muda, nenhuma chamada ao Google).
//   YUI_GOOGLE_GMAIL=true        libera o código do Gmail (somente leitura), mas ele SÓ funciona com a rota privada de IA validada. Padrão: false.
//   YUI_GOOGLE_TOKEN_ARQUIVO     o arquivo da autorização (padrão: secrets/google-token.json, pasta ignorada pelo git).
//   YUI_GOOGLE_FUSO              o fuso dos "hoje", "amanhã" e "semana" (nome IANA, padrão America/Sao_Paulo).
import path from 'node:path';

const RAIZ = path.resolve(import.meta.dirname, '..', '..', '..');

export const FUSO_PADRAO = 'America/Sao_Paulo';
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

/** O caminho do arquivo da autorização. */
export function arquivoDoToken(env = process.env) {
  const configurado = String(env?.YUI_GOOGLE_TOKEN_ARQUIVO ?? '').trim();
  return configurado ? path.resolve(configurado) : path.join(RAIZ, 'secrets', 'google-token.json');
}

/** O mesmo caminho padrão, para o script de autorização gravar no lugar onde a Yui procura. */
export function arquivoDoTokenPadrao() {
  return path.join(RAIZ, 'secrets', 'google-token.json');
}

export function fusoValido(fuso) {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: String(fuso) }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/** O fuso das consultas: YUI_GOOGLE_FUSO se for um nome IANA válido; senão o padrão. */
export function fusoDoGoogle(env = process.env) {
  const bruto = String(env?.YUI_GOOGLE_FUSO ?? '').trim();
  return bruto && fusoValido(bruto) ? bruto : FUSO_PADRAO;
}
