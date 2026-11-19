import { Platform } from 'react-native';
import { lerConfigServidores, type ConfigServidores } from './servidores.ts';

/** Os endereços do servidor desta instalação (nunca digitados pelo usuário). A lógica está em servidores.ts. */
export function getConfigServidores(): ConfigServidores {
  return lerConfigServidores({
    // O Expo troca process.env.EXPO_PUBLIC_* pelo valor na hora do build (precisa ser escrito assim, com ponto).
    lista: process.env.EXPO_PUBLIC_YUI_SERVER_URLS,
    env: process.env.EXPO_PUBLIC_YUI_SERVER_URL,
    apiPort: process.env.EXPO_PUBLIC_YUI_API_PORT,
    // A chave PÚBLICA Ed25519 do servidor (base64): com ela o app só envia senha e token a um servidor que provar a identidade. É pública (pode estar no APK); a privada nunca sai do servidor.
    identidadePubkey: process.env.EXPO_PUBLIC_YUI_IDENTIDADE_PUBKEY,
    platform: Platform.OS,
    location: typeof window !== 'undefined' && window.location ? window.location : null,
  });
}
