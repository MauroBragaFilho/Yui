// O ARQUIVO DA AUTORIZAÇÃO do Google (etapa 15): guarda o cliente OAuth e o refresh token. É um SEGREDO.
//  - o script de autorização (scripts/google-autorizar.mjs, no PC do dono) cria o arquivo; o cérebro o lê (e só ele o regrava, para anotar que a
//    autorização expirou: veja auth.js);
//  - a gravação é ATÔMICA e RESTRITA (a mesma do segredo do canal, src/core/channel/secret.js): cria um temporário VAZIO, restringe a permissão ao dono do
//    processo (no Windows por SID, conferida; fora dele, chmod 600), só então grava o conteúdo e troca o arquivo por um rename;
//  - nada daqui escreve o conteúdo no log nem em erro: os erros levam só um código e o nome do arquivo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { restrictFileToOwner } from '../../core/channel/secret.js';
import { ehEscopoDoGoogle } from './endpoints.js';

export const VERSAO_DO_ARQUIVO = 1;
const MAX_BYTES = 16 * 1024;
const TOKEN_RE = /^[\x21-\x7e]{10,2048}$/;

/** A impressão do refresh token (só um pedaço do hash): identifica "esta autorização" sem expô-la. */
export function impressaoDoToken(refreshToken) {
  return crypto.createHash('sha256').update(String(refreshToken ?? '')).digest('hex').slice(0, 12);
}

/**
 * Confere o conteúdo do arquivo. Devolve os dados limpos (só os campos conhecidos) ou null.
 * @returns {{ versao: number, client_id: string, client_secret: string, refresh_token: string, escopos: string[]|null, criadoEm: string|null,
 *             invalido: { em: string, avisadoEm: string|null, impressao: string }|null }|null}
 */
export function validarDados(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.versao !== VERSAO_DO_ARQUIVO) return null;
  const { client_id: clientId, client_secret: clientSecret, refresh_token: refresh } = obj;
  if (typeof clientId !== 'string' || !/^[\x21-\x7e]{5,300}$/.test(clientId)) return null;
  if (typeof clientSecret !== 'string' || !/^[\x21-\x7e]{3,300}$/.test(clientSecret)) return null;
  if (typeof refresh !== 'string' || !TOKEN_RE.test(refresh)) return null;
  let escopos = null;
  if (obj.escopos !== undefined && obj.escopos !== null) {
    if (!Array.isArray(obj.escopos) || obj.escopos.length > 20 || !obj.escopos.every(ehEscopoDoGoogle)) return null;
    escopos = obj.escopos.slice();
  }
  let invalido = null;
  if (obj.invalido && typeof obj.invalido === 'object') {
    const imp = typeof obj.invalido.impressao === 'string' && /^[0-9a-f]{12}$/.test(obj.invalido.impressao) ? obj.invalido.impressao : null;
    if (imp) {
      invalido = {
        em: typeof obj.invalido.em === 'string' ? obj.invalido.em.slice(0, 40) : '',
        avisadoEm: typeof obj.invalido.avisadoEm === 'string' ? obj.invalido.avisadoEm.slice(0, 40) : null,
        impressao: imp,
      };
    }
  }
  return {
    versao: VERSAO_DO_ARQUIVO, client_id: clientId, client_secret: clientSecret, refresh_token: refresh, escopos,
    criadoEm: typeof obj.criadoEm === 'string' ? obj.criadoEm.slice(0, 40) : null, invalido,
  };
}

/** Lê o arquivo. { ok: true, dados } | { ok: false, motivo: 'ausente' | 'ilegivel' | 'invalido' } (o conteúdo nunca vai em erro). */
export function lerArquivoDeToken(file) {
  let texto;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return { ok: false, motivo: 'invalido' };
    texto = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, motivo: err?.code === 'ENOENT' ? 'ausente' : 'ilegivel' };
  }
  let obj;
  try { obj = JSON.parse(texto.replace(/^﻿/, '')); } catch { return { ok: false, motivo: 'invalido' }; }
  const dados = validarDados(obj);
  return dados ? { ok: true, dados } : { ok: false, motivo: 'invalido' };
}

/**
 * Grava o arquivo de forma atômica e restrita ao dono: temporário vazio ('wx') -> restringe e confere -> grava -> rename. Lança Error (sem o conteúdo)
 * se não conseguir restringir; o temporário nunca fica para trás.
 * @param {string} file
 * @param {object} dados  os campos do arquivo (passam pelo validarDados antes de gravar)
 * @param {{ restringir?: (arquivo: string) => void }} [opcoes]
 */
export function gravarArquivoDeToken(file, dados, { restringir = restrictFileToOwner } = {}) {
  const limpo = validarDados({ versao: VERSAO_DO_ARQUIVO, ...dados });
  if (!limpo) throw new Error('google: os dados da autorização são inválidos; nada foi gravado.');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.closeSync(fs.openSync(tmp, 'wx', 0o600));
  try {
    try {
      restringir(tmp);
    } catch (err) {
      throw new Error(`google: não consegui restringir a permissão do arquivo da autorização; ele NÃO foi gravado. ${String(err?.message ?? err).slice(0, 160)}`);
    }
    fs.writeFileSync(tmp, JSON.stringify(limpo, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
