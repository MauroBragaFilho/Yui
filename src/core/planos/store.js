// O arquivo dos planos (<DATABASE_DIR>/planos.json). Dono: o cérebro (ou o processo único); o bot separado nunca o abre.
// Guarda só os passos (ferramenta e argumentos) e o estado de cada um: NUNCA o resultado de uma leitura nem o texto do pedido.
// Sem cache: cada operação relê o disco (apagar a memória vale na hora). Arquivo ilegível = erro (nada é executado nem sobrescrito).
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../channel/idemPersistente.js';

export const GUARDA_ENCERRADOS_MS = 7 * 24 * 60 * 60_000;
export const arquivoDosPlanos = (env = process.env) => path.join(env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'planos.json');
const ilegivel = () => Object.assign(new Error('arquivo de planos ilegível'), { code: 'PLANOS_ILEGIVEL' });

export function criarStoreDePlanos({ env = process.env, file = null } = {}) {
  const arquivo = file ?? arquivoDosPlanos(env);
  function ler() {
    let bruto;
    try { bruto = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw ilegivel();
    }
    if (!bruto || !Array.isArray(bruto.planos) || !bruto.planos.every((p) => p && typeof p.id === 'string' && Array.isArray(p.passos))) throw ilegivel();
    return bruto.planos;
  }
  const gravar = (planos) => writeJsonAtomic(arquivo, { versao: 1, planos });
  return {
    arquivo,
    ler,
    obter: (id) => ler().find((p) => p.id === id) ?? null,
    adicionar(plano) { gravar([...ler(), plano]); },
    /** Muda um plano e grava antes de valer. Devolve o plano novo, ou null se ele não existe mais. Lança se o disco recusar. */
    mudar(id, fn) {
      const planos = ler();
      const p = planos.find((x) => x.id === id);
      if (!p) return null;
      fn(p);
      gravar(planos);
      return p;
    },
    limpar(agora = Date.now()) {
      if (!fs.existsSync(arquivo)) return 0;
      const planos = ler();
      const ficam = planos.filter((p) => !p.encerradoEm || agora - p.encerradoEm < GUARDA_ENCERRADOS_MS);
      if (ficam.length !== planos.length) gravar(ficam);
      return planos.length - ficam.length;
    },
  };
}

const apagamentos = new Map(); // userId -> quantas vezes apagou neste processo
/** Muda a cada "apagar minha memória": um plano ainda sendo proposto não pode ser gravado depois. */
export const geracaoDeApagamento = (userId) => apagamentos.get(String(userId)) ?? 0;

/** "Apagar minha memória": tira os planos da pessoa. Sem arquivo, nada acontece; arquivo ilegível é removido inteiro. Nunca lança. */
export function apagarPlanosDe(userId, { env = process.env, file = null } = {}) {
  try {
    const arquivo = file ?? arquivoDosPlanos(env);
    if (userId) apagamentos.set(String(userId), geracaoDeApagamento(userId) + 1);
    if (!userId || !fs.existsSync(arquivo)) return 0;
    let planos;
    try { planos = criarStoreDePlanos({ file: arquivo }).ler(); } catch { fs.rmSync(arquivo, { force: true }); return 0; }
    const ficam = planos.filter((p) => String(p.userId) !== String(userId));
    if (ficam.length !== planos.length) writeJsonAtomic(arquivo, { versao: 1, planos: ficam });
    return planos.length - ficam.length;
  } catch {
    return 0;
  }
}
