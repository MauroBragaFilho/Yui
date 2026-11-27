// Imagem no Chat do app (lacunas do painel, item 11): a GERAÇÃO, no processo do BOT. O gerador (imageHandler.js) usa o @gradio/client e mora nos
// handlers, que o Core e o cérebro não carregam (tests/test-core-import-graph.js); a regra, a política, o limite e o link curto ficam no Core
// (src/core/imagemDoApp.js). Este arquivo só gera, confere o tipo pelo conteúdo e entrega os bytes:
//  - processo único: o src/index.js registra `gerarImagemParaApp` como o gerador da API (os bytes voltam em memória);
//  - bot separado: o canal (src/discord/canalCerebro.js, método `imagem.gerar`) chama `entregarImagemAoCerebro`, que grava os bytes na pasta de entrega
//    com um nome ALEATÓRIO (só hexadecimal) e devolve só esse nome; o cérebro lê e apaga (o quadro do canal tem 1 MB, pouco para uma imagem).
// O arquivo que o imageHandler grava é apagado na hora, em qualquer caso. O texto do pedido nunca vai para o log (o imageHandler registra só o tamanho).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateImage } from './imageHandler.js';
import {
  tipoDaImagem, pastaDasImagens, limparEntregasAntigas, MAX_BYTES_DA_IMAGEM, PEDIDO_MAX, PRAZO_DA_IMAGEM_MS, EXTENSAO_DA_ENTREGA,
} from '../core/imagemDoApp.js';

/** Prazo do lado do bot: um pouco antes do prazo do Core, para a resposta "demorou" ser a do Core e o arquivo atrasado ser apagado aqui. */
export const PRAZO_DO_BOT_MS = PRAZO_DA_IMAGEM_MS - 5_000;
const NOME_DO_GERADOR_RE = /^image_\d+_[\w.-]{1,40}\.(?:png|webp|jpe?g|gif)$/i;

function apagarDoGerador(arquivo) {
  // Só o arquivo que o imageHandler acabou de gravar (o nome tem o formato dele); nunca outro caminho.
  if (typeof arquivo !== 'string' || !NOME_DO_GERADOR_RE.test(path.basename(arquivo))) return;
  try { fs.rmSync(arquivo, { force: true }); } catch { /* já saiu */ }
}

/** Lê o resultado do imageHandler e apaga o arquivo dele. @returns {null | { buffer: Buffer, tipo: string, modelo: string|null }} */
function lerResultado(data) {
  const arquivo = data?.localFilePath;
  if (typeof arquivo !== 'string' || !arquivo) return null; // os provedores de hoje sempre gravam o arquivo; link remoto não é baixado aqui
  try {
    const st = fs.statSync(arquivo);
    if (!st.isFile() || st.size > MAX_BYTES_DA_IMAGEM) return null;
    const buffer = fs.readFileSync(arquivo);
    const tipo = tipoDaImagem(buffer);
    return tipo ? { buffer, tipo, modelo: typeof data.modelName === 'string' ? data.modelName.slice(0, 60) : null } : null;
  } catch {
    return null;
  } finally {
    apagarDoGerador(arquivo);
  }
}

/**
 * Gera com prazo. Passou do prazo: devolve null e, quando o resultado atrasado chegar, apaga o arquivo dele.
 * @param {{ prompt: string }} pedido
 */
export async function gerarImagemParaApp({ prompt } = {}, { gerar = generateImage, prazoMs = PRAZO_DO_BOT_MS } = {}) {
  const texto = String(prompt ?? '').slice(0, PEDIDO_MAX).trim();
  if (!texto) return null;
  const tarefa = Promise.resolve().then(() => gerar(texto, '', 1024, 1024));
  let timer = null;
  const venceu = Symbol('prazo');
  const prazo = new Promise((resolve) => { timer = setTimeout(() => resolve(venceu), prazoMs); timer.unref?.(); });
  try {
    const data = await Promise.race([tarefa, prazo]);
    if (data === venceu) {
      tarefa.then((atrasado) => apagarDoGerador(atrasado?.localFilePath), () => {});
      return null;
    }
    return lerResultado(data);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bot separado: gera e grava a entrega para o cérebro. @returns {null | { id: string, modelo: string|null, bytes: number }}
 * O nome é aleatório (32 hexadecimais); o cérebro só aceita esse formato e apaga depois de ler.
 */
export async function entregarImagemAoCerebro({ prompt } = {}, { gerar = generateImage, prazoMs = PRAZO_DO_BOT_MS, pasta = pastaDasImagens(), agora = Date.now } = {}) {
  limparEntregasAntigas({ pasta, agora: agora() });
  const r = await gerarImagemParaApp({ prompt }, { gerar, prazoMs });
  if (!r) return null;
  const id = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(path.join(pasta, `${id}${EXTENSAO_DA_ENTREGA}`), r.buffer, { flag: 'wx', mode: 0o600 });
  } catch {
    return null;
  }
  return { id, modelo: r.modelo, bytes: r.buffer.length };
}
