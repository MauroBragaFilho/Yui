// A autorização da CONTA DO CANAL DA YUI no YouTube (cliente OAuth e refresh token). É um SEGREDO, num arquivo SEPARADO do Google da Agenda.
// Criado por scripts/youtube-autorizar.mjs; lido pelo cérebro (ou pelo processo único). Nada daqui vai para log nem para mensagem de erro.
// A gravação é atômica e restrita (usuário que gravou, SYSTEM e Administradores: a mesma do segredo do canal).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { restrictFileToOwner } from '../channel/secret.js';
import { ErroYoutube } from '../../adaptadores/youtube/api.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CAMPOS = ['client_id', 'client_secret', 'refresh_token', 'canalId'];

export const arquivoDaCredencial = (env = process.env) => {
  const posto = String(env.YUI_YOUTUBE_TOKEN_ARQUIVO ?? '').trim();
  return posto ? path.resolve(posto) : path.join(ROOT, 'secrets', 'youtube-token.json');
};

const valida = (d) => Boolean(d) && typeof d === 'object' && CAMPOS.every((c) => typeof d[c] === 'string' && /^[\x21-\x7e]{5,2048}$/.test(d[c]));

/** @returns {{ ok: true, dados: object } | { ok: false, motivo: 'ausente'|'ilegivel'|'invalido' }} */
export function lerCredencial(arquivo) {
  let texto;
  try { texto = fs.readFileSync(arquivo, 'utf8'); } catch (e) { return { ok: false, motivo: e?.code === 'ENOENT' ? 'ausente' : 'ilegivel' }; }
  let dados = null;
  try { dados = JSON.parse(texto.replace(/^﻿/, '')); } catch { /* inválido */ }
  return valida(dados) ? { ok: true, dados } : { ok: false, motivo: 'invalido' };
}

export function gravarCredencial(arquivo, dados, { restringir = restrictFileToOwner } = {}) {
  if (!valida(dados)) throw new Error('youtube: os dados da autorização são inválidos; nada foi gravado.');
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.closeSync(fs.openSync(tmp, 'wx', 0o600));
  try {
    restringir(tmp); // antes de o segredo entrar no arquivo
    fs.writeFileSync(tmp, JSON.stringify(dados), { mode: 0o600 });
    fs.renameSync(tmp, arquivo);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Quem entrega o access token ao cliente da API: renova com o refresh token e guarda em memória até um minuto antes de vencer.
 * Autorização recusada = NAO_AUTENTICADO (não passa sozinho); rede ou erro do servidor = passageiro.
 */
export function criarObterToken({ arquivo, tokenUrl, fetchImpl = globalThis.fetch, agora = Date.now, timeoutMs = 15_000 }) {
  let cache = null; // { refresh, token, ate }
  return async () => {
    const lida = lerCredencial(arquivo);
    if (!lida.ok) throw new ErroYoutube('SEM_CREDENCIAL', { permanente: true });
    const { client_id: id, client_secret: segredo, refresh_token: refresh } = lida.dados;
    if (cache && cache.refresh === refresh && agora() < cache.ate) return cache.token;
    let res;
    let json = null;
    try {
      res = await fetchImpl(tokenUrl, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: id, client_secret: segredo, refresh_token: refresh }).toString(),
      });
      json = await res.json().catch(() => null);
    } catch {
      throw new ErroYoutube('REDE');
    }
    if (res.status === 429 || res.status >= 500) throw new ErroYoutube('FALHA_TEMPORARIA', { status: res.status });
    if (!res.ok || typeof json?.access_token !== 'string' || !json.access_token) throw new ErroYoutube('NAO_AUTENTICADO', { status: res.status, permanente: true });
    const segundos = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600;
    cache = { refresh, token: json.access_token, ate: agora() + Math.max(30, segundos - 60) * 1000 };
    return cache.token;
  };
}
