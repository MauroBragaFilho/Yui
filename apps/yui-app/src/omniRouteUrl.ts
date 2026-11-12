/** Endereço do painel do OmniRoute: o MESMO computador da API da Yui, na porta dele (padrão 20128). Arquivo sem React, testável em Node. */
export const OMNIROUTE_DEFAULT_PORT = 20128;

export function omniRouteUrl(serverUrl: string | null | undefined, port?: string | number | null): string | null {
  let u: URL;
  try {
    u = new URL(String(serverUrl ?? ''));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const p = Number.parseInt(String(port ?? ''), 10);
  const finalPort = Number.isInteger(p) && p > 0 && p < 65536 ? p : OMNIROUTE_DEFAULT_PORT;
  // O OmniRoute atende em http simples na rede local; https só se a página da Yui estiver em https com o mesmo certificado.
  return `${u.protocol}//${u.hostname}:${finalPort}/`;
}
