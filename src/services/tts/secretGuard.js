/**
 * Guarda de SEGREDOS da fala: "este texto tem cara de chave, token ou senha?"
 *
 * Por que existe: o que a Yui fala por uma voz da NUVEM (OmniRoute, Azure, Edge) sai do computador dela. Credenciais e segredos técnicos NUNCA podem sair
 * assim. O texto passa por duas conferências que a Yui já tem, mais três formatos que a fala encontra:
 *   1. o mascaramento de segredos do painel (`redact`, src/core/api/panelLogs.js): valores de variáveis de ambiente com nome de segredo (chaves de IA,
 *      tokens) e os formatos conhecidos (Google, Groq, Hugging Face, sk-..., token de bot do Discord, "Bearer ...", ?key=...): se mascarar algo, o texto tem segredo;
 *   2. o detector de dado pessoal da fala (`findPii`, ./policy.js), só nos tipos de segredo: 'token' (sequência longa com cara de chave, prefixos conhecidos)
 *      e 'secret' ("senha é Hunter2", "PIN: 4821");
 *   3. sequências hexadecimais longas (hash, chave em hexa), "Bearer <algo>" e "api_key: <algo>" / "token = <algo>" / "senha: <algo>".
 *
 * Devolve só uma PALAVRA FIXA ('chave', 'token', 'senha', 'hexa', 'bearer' ou 'atribuicao') ou null. NUNCA devolve o trecho achado nem nada do texto: quem chama
 * conta o evento e escreve no log só um número. Não lança. Sem efeito colateral ao importar.
 */
import { redact } from '../../core/api/panelLogs.js';
import { findPii } from './policy.js';

const MAX_SCAN_CHARS = 4000;
const HEX_RUN_RE = /(?<![0-9A-Za-z])[0-9a-fA-F]{24,}(?![0-9A-Za-z])/;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const ASSIGN_RE = /\b(?:api[_ -]?key|apikey|access[_ -]?token|auth[_ -]?token|secret|token|senha|password)\b\s*[:=]\s*[^\s"'`,;]{6,}/i;

/**
 * @param {string} text
 * @param {object} [env]  de onde `redact` lê os VALORES das variáveis com nome de segredo (padrão process.env)
 * @returns {'chave'|'token'|'senha'|'hexa'|'bearer'|'atribuicao'|null}
 */
export function findSecret(text, env = process.env) {
  try {
    if (typeof text !== 'string' || !text) return null;
    const t = text.slice(0, MAX_SCAN_CHARS);
    if (redact(t, env) !== t) return 'chave';
    if (BEARER_RE.test(t)) return 'bearer';
    if (ASSIGN_RE.test(t)) return 'atribuicao';
    if (HEX_RUN_RE.test(t)) return 'hexa';
    const pii = findPii(t);
    if (pii === 'token') return 'token';
    if (pii === 'secret') return 'senha';
    return null;
  } catch {
    // na dúvida (erro ao conferir) o texto conta como segredo: nenhuma nuvem recebe
    return 'chave';
  }
}
