#!/usr/bin/env node
// Gera a IDENTIDADE do servidor da Yui: um par de chaves Ed25519 (node:crypto, sem pacote).
//   node scripts/gerar-identidade-yui.mjs                 cria o par; grava a chave PRIVADA em secrets/identidade-yui.key (ou YUI_API_IDENTIDADE_ARQUIVO)
//   node scripts/gerar-identidade-yui.mjs --arquivo=X     usa outro caminho para a chave privada
//   node scripts/gerar-identidade-yui.mjs --forcar        troca a identidade que já existe (os apps já gerados deixam de confirmar o servidor até serem refeitos)
//   node scripts/gerar-identidade-yui.mjs --publica       mostra de novo a chave PÚBLICA da identidade que já existe
//
// A chave PRIVADA fica só no arquivo, com permissão restrita ao seu usuário (a mesma regra do segredo do canal local), e nunca é impressa. A saída padrão traz SÓ a chave
// PÚBLICA (base64, 32 bytes): é ela que vai no ambiente do build do app, em EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY (a pública pode estar no APK; a privada nunca sai do servidor).
// As mensagens para a pessoa vão para a saída de erro, assim a pública pode ser capturada sozinha (`$pub = node scripts/gerar-identidade-yui.mjs`).
// Nunca sobrescreve uma identidade existente sem --forcar. Depois de criar, reinicie a Yui para a rota /v1/identidade ligar.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { arquivoDaIdentidade } from '../src/core/api/identidade.js';
import { restrictFileToOwner } from '../src/core/channel/secret.js';

/** A chave pública Ed25519 crua (32 bytes) em base64: o formato que o app lê. */
export function chavePublicaBase64(publica) {
  return Buffer.from(publica.export({ format: 'jwk' }).x, 'base64url').toString('base64');
}

/** A chave pública (base64) da identidade que já está no arquivo. Lança erro se o arquivo não existe ou não é uma chave Ed25519. */
export function publicaDoArquivo(arquivo) {
  const privada = crypto.createPrivateKey(fs.readFileSync(arquivo, 'utf8'));
  if (privada.asymmetricKeyType !== 'ed25519') throw new Error('o arquivo não tem uma chave Ed25519');
  return chavePublicaBase64(crypto.createPublicKey(privada));
}

/**
 * Cria o par e grava a chave privada: o arquivo nasce VAZIO, é restringido e conferido, e só então recebe a chave (não existe janela com a chave legível).
 * Sem `forcar`, uma identidade existente nunca é tocada. Com `forcar`, a nova é montada ao lado e só então troca a antiga.
 * @returns {{ arquivo: string, publica: string }}  a chave PRIVADA nunca é devolvida
 */
export function gerarIdentidade({ arquivo, forcar = false, restrict = restrictFileToOwner } = {}) {
  if (!arquivo) throw new Error('informe o arquivo da identidade');
  if (fs.existsSync(arquivo) && !forcar) {
    const erro = new Error('já existe uma identidade neste arquivo; use --forcar para trocá-la (os apps já gerados deixam de confirmar o servidor)');
    erro.codigo = 'JA_EXISTE';
    throw erro;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const novo = `${arquivo}.novo`;
  fs.rmSync(novo, { force: true }); // nunca reaproveita um arquivo que já estava lá (poderia ter permissão aberta)
  fs.closeSync(fs.openSync(novo, 'wx', 0o600));
  try {
    restrict(novo);
    fs.writeFileSync(novo, pem);
    fs.renameSync(novo, arquivo);
  } catch (err) {
    fs.rmSync(novo, { force: true });
    throw new Error(`não consegui gravar a identidade com a permissão restrita (${String(err?.message ?? err).slice(0, 120)}); nada foi gravado`);
  }
  return { arquivo, publica: chavePublicaBase64(publicKey) };
}

function principal(argv) {
  const opcao = (nome) => argv.find((a) => a === `--${nome}` || a.startsWith(`--${nome}=`));
  const dado = opcao('arquivo');
  const arquivo = dado && dado.includes('=') ? path.resolve(dado.slice(dado.indexOf('=') + 1)) : arquivoDaIdentidade();
  try {
    if (opcao('publica')) {
      process.stdout.write(`${publicaDoArquivo(arquivo)}\n`);
      return 0;
    }
    const { publica } = gerarIdentidade({ arquivo, forcar: Boolean(opcao('forcar')) });
    process.stdout.write(`${publica}\n`);
    process.stderr.write([
      'Identidade do servidor criada.',
      `Chave PRIVADA gravada em ${arquivo} (permissão restrita ao seu usuário). Nunca copie, envie nem versione esse arquivo.`,
      'A linha acima é a chave PÚBLICA: coloque-a em EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY no ambiente do build do app (não no repositório).',
      'Reinicie a Yui para a rota /v1/identidade ligar.',
      '',
    ].join('\n'));
    return 0;
  } catch (err) {
    process.stderr.write(`${err?.codigo === 'JA_EXISTE' ? err.message : `Não deu certo: ${String(err?.message ?? err).slice(0, 200)}`}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) { process.exitCode = principal(process.argv.slice(2)); }
