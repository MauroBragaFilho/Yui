/**
 * Modelos Gemini aposentados pelo Google para contas novas respondem 404
 * ("no longer available to new users"). Se o .env ainda tiver um desses
 * nomes, usamos o apelido "-latest", que acompanha o modelo atual sozinho.
 */
export const GEMINI_FAST = 'gemini-flash-lite-latest';
export const GEMINI_SMART = 'gemini-flash-latest';

const RETIRED = [/^gemini-1\./, /^gemini-2\.0-/, /^gemini-2\.5-flash(-lite)?$/];

export function isRetiredGeminiModel(name) {
  const n = String(name ?? '').trim();
  return RETIRED.some((re) => re.test(n));
}

/** Devolve `value` se estiver em uso; senão `fallback`. */
export function currentGeminiModel(value, fallback) {
  const v = String(value ?? '').trim();
  return !v || isRetiredGeminiModel(v) ? fallback : v;
}
