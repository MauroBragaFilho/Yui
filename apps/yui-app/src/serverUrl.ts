import { normalizeBaseUrl } from './api/client.ts';

/**
 * Qual servidor o app usa. O usuário NÃO digita endereço: ele é configuração
 * do build (ou, na versão web, o próprio PC que serviu o app).
 *
 * Ordem:
 *  1. EXPO_PUBLIC_YUI_SERVER_URL (definida na hora do build; é o caso do app Android);
 *  2. web: o mesmo computador que serviu a página, na porta da API (padrão 3939);
 *  3. nenhum: o app mostra que o servidor não foi configurado neste build.
 */
export interface ServerUrlInput {
  /** Valor de EXPO_PUBLIC_YUI_SERVER_URL. */
  env?: string | null;
  /** Porta da API quando derivada do endereço da página (EXPO_PUBLIC_YUI_API_PORT). */
  apiPort?: string | number | null;
  platform: string;
  location?: { protocol: string; hostname: string } | null;
}

export function resolveServerUrl({ env, apiPort, platform, location }: ServerUrlInput): string | null {
  const configured = String(env ?? '').trim();
  if (configured) {
    try {
      return normalizeBaseUrl(configured);
    } catch {
      return null; // configuração inválida: melhor avisar do que conectar em outro lugar
    }
  }
  if (platform === 'web' && location?.hostname) {
    const port = String(apiPort ?? '').trim() || '3939';
    const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
    return `${protocol}//${location.hostname}:${port}`;
  }
  return null;
}
