/**
 * Endereço do painel do OmniRoute, tirado do provedor "omniroute" que a API informa (GET /v1/admin/ai).
 * Arquivo sem React, testável em Node.
 */
export function findOmniRoute<T extends { id: string; label: string; baseUrl: string }>(custom: T[] | null | undefined): T | null {
  const lista = custom ?? [];
  return lista.find((c) => c.id === 'omniroute') ?? lista.find((c) => /omniroute/i.test(`${c.id} ${c.label}`)) ?? null;
}

const LOCAL = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\])$/i;

function httpUrl(value: string | null | undefined): URL | null {
  try {
    const u = new URL(String(value ?? ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/**
 * O painel fica na raiz do mesmo endereço do provedor (sem o /v1). Se o provedor está em "localhost", isso é o
 * computador da Yui, não o de quem abriu a página: troca pelo nome do servidor da API.
 */
export function omniRouteUrl(providerBaseUrl: string | null | undefined, serverUrl: string | null | undefined): string | null {
  const provider = httpUrl(providerBaseUrl);
  if (!provider) return null;
  let host = provider.hostname;
  if (LOCAL.test(host)) {
    const server = httpUrl(serverUrl);
    if (!server) return null;
    host = server.hostname;
  }
  return `${provider.protocol}//${host}${provider.port ? `:${provider.port}` : ''}/`;
}
