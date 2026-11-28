// OS DADOS da live dos amigos, etapa 1 (docs/PLANO_TECNICO_LIVE_AMIGOS_ETAPA1.md §3): dois arquivos JSON em DATABASE_DIR.
//   vinculos-live-amigos.json  { versao, vinculos: [{ codigo, discordId, canalId, estado: 'ativo'|'encerrando', criadoEm }] }
//   live-amigos-diario.json    { versao, encerramentos: [...], limpezas: [...] }
//
// DONO ÚNICO: só o cérebro (ou o processo único) abre estes arquivos; com YUI_DB_OWNER_ROLE=bot o store recusa. Gravação ATÔMICA
// (writeJsonAtomic: temporário + fsync + rename). FORA DE TODO BACKUP, de propósito: nenhum dos dois nomes está nas listas do backup
// (src/core/memory/backup.js), para uma exclusão não deixar cópia (um teste confere).
// Leitura: só ENOENT é "vazio". Erro passageiro (EBUSY, EPERM, EACCES) repete; se persistir, ou se o conteúdo não for um JSON válido, o arquivo é
// ILEGÍVEL e quem chama falha fechado. Diferente de outros stores, NUNCA se guarda cópia ".corrompido" (ela teria IDs).
// Temporários órfãos (<arquivo>.<pid>.tmp) são apagados ao abrir.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../channel/idemPersistente.js';

export const NOME_VINCULOS = 'vinculos-live-amigos.json';
export const NOME_DIARIO = 'live-amigos-diario.json';
const VERSAO = 1;
const MAX_BYTES = 2 * 1024 * 1024;

const pasta = (env) => env.DATABASE_DIR || path.join(process.cwd(), 'database');
export const arquivoDosVinculos = (env = process.env) => path.join(pasta(env), NOME_VINCULOS);
export const arquivoDoDiario = (env = process.env) => path.join(pasta(env), NOME_DIARIO);

function pausar(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* */ } }

export class ErroIlegivel extends Error {
  constructor(qual) { super(`arquivo ${qual} ilegível`); this.code = 'ILEGIVEL'; this.qual = qual; }
}

function lerJson(file, qual) {
  for (let tentativa = 1; ; tentativa++) {
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_BYTES) throw new ErroIlegivel(qual);
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      if (err instanceof ErroIlegivel) throw err;
      if (['EBUSY', 'EPERM', 'EACCES'].includes(err?.code) && tentativa < 4) { pausar(30 * tentativa); continue; }
      throw new ErroIlegivel(qual);
    }
  }
}

function apagarOrfaos(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let nomes = [];
  try { nomes = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const nome of nomes) {
    if (nome.startsWith(`${base}.`) && nome.endsWith('.tmp')) {
      try { fs.rmSync(path.join(dir, nome), { force: true }); n++; } catch { /* */ }
    }
  }
  return n;
}

const vinculoValido = (v) => v && typeof v.codigo === 'string' && typeof v.discordId === 'string' && typeof v.canalId === 'string' && ['ativo', 'encerrando'].includes(v.estado);

/**
 * @param {{ env?: object, arquivos?: { vinculos?: string, diario?: string }, gravar?: (file: string, data: object) => void }} [o]
 */
export function criarStoreLiveAmigos({ env = process.env, arquivos = {}, gravar = writeJsonAtomic } = {}) {
  if (String(env?.YUI_DB_OWNER_ROLE ?? '').trim().toLowerCase() === 'bot') {
    const err = new Error('Os vínculos da live dos amigos são do cérebro: o bot não abre este arquivo.');
    err.code = 'PAPEL_ERRADO';
    throw err;
  }
  const fVinculos = arquivos.vinculos ?? arquivoDosVinculos(env);
  const fDiario = arquivos.diario ?? arquivoDoDiario(env);
  const orfaos = apagarOrfaos(fVinculos) + apagarOrfaos(fDiario);

  return {
    arquivos: { vinculos: fVinculos, diario: fDiario },
    orfaosApagados: orfaos,
    /** @returns {Array<object>} lança ErroIlegivel */
    lerVinculos() {
      const d = lerJson(fVinculos, 'vinculos');
      if (d === null) return [];
      if (!d || d.versao !== VERSAO || !Array.isArray(d.vinculos) || !d.vinculos.every(vinculoValido)) throw new ErroIlegivel('vinculos');
      return d.vinculos.map((v) => ({ ...v }));
    },
    gravarVinculos(lista) { gravar(fVinculos, { versao: VERSAO, vinculos: lista }); },
    /** Diário ilegível: é apagado sem cópia (pode ter IDs) e recomeça vazio; os vínculos em "encerrando" cobrem o que ele perdeu. */
    lerDiario() {
      let d;
      try { d = lerJson(fDiario, 'diario'); } catch { try { fs.rmSync(fDiario, { force: true }); } catch { /* */ } return { encerramentos: [], limpezas: [], descartado: true }; }
      if (d === null) return { encerramentos: [], limpezas: [] };
      return { encerramentos: Array.isArray(d.encerramentos) ? d.encerramentos : [], limpezas: Array.isArray(d.limpezas) ? d.limpezas : [] };
    },
    gravarDiario({ encerramentos, limpezas }) { gravar(fDiario, { versao: VERSAO, encerramentos, limpezas }); },
    /** O recomeço confirmado pelo dono: apaga o arquivo ilegível (sem cópia). */
    apagarVinculosIlegiveis() { fs.rmSync(fVinculos, { force: true }); },
  };
}
