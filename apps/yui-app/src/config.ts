import { Platform } from 'react-native';
import { lerConfigServidores, type ConfigServidores } from './servidores.ts';

/** Os endereços do servidor desta instalação (nunca digitados pelo usuário). A lógica está em servidores.ts. */
export function getConfigServidores(): ConfigServidores {
  return lerConfigServidores({
    // O Expo troca process.env.EXPO_PUBLIC_* pelo valor na hora do build (precisa ser escrito assim, com ponto).
    lista: process.env.EXPO_PUBLIC_YUI_SERVER_URLS,
    env: process.env.EXPO_PUBLIC_YUI_SERVER_URL,
    apiPort: process.env.EXPO_PUBLIC_YUI_API_PORT,
    platform: Platform.OS,
    location: typeof window !== 'undefined' && window.location ? window.location : null,
  });
}
