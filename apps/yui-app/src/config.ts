import { Platform } from 'react-native';
import { resolveServerUrl } from './serverUrl.ts';

/** Endereço do servidor desta instalação (nunca digitado pelo usuário). */
export function getServerUrl(): string | null {
  return resolveServerUrl({
    // O Expo troca process.env.EXPO_PUBLIC_* pelo valor na hora do build.
    env: process.env.EXPO_PUBLIC_YUI_SERVER_URL,
    apiPort: process.env.EXPO_PUBLIC_YUI_API_PORT,
    platform: Platform.OS,
    location: typeof window !== 'undefined' && window.location ? window.location : null,
  });
}
