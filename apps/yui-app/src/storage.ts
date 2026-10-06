import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseStoredHistory, trimHistory, type ChatMessage } from './chat/messages.ts';

/**
 * Armazenamento local do app. Tudo é protegido por try/catch: o app precisa
 * funcionar mesmo se o armazenamento estiver bloqueado ou corrompido.
 *
 * Observação de segurança: o token fica no armazenamento do app (no Android,
 * restrito ao próprio app; na web, no localStorage do navegador). Use um token
 * exclusivo para cada dispositivo para poder revogá-lo sem afetar os outros.
 */

const KEY_SETTINGS = 'yui.settings.v1';
const KEY_HISTORY = 'yui.history.v1';

export interface Settings {
  baseUrl: string;
  token: string;
}

export async function loadSettings(): Promise<Settings | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_SETTINGS);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (typeof data?.baseUrl === 'string' && typeof data?.token === 'string' && data.baseUrl && data.token) {
      return { baseUrl: data.baseUrl, token: data.token };
    }
  } catch {
    /* ignora */
  }
  return null;
}

export async function saveSettings(settings: Settings): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
  } catch {
    /* sem persistência: o app continua usando a sessão atual */
  }
}

export async function clearAll(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([KEY_SETTINGS, KEY_HISTORY]);
  } catch {
    /* ignora */
  }
}

export async function loadHistory(): Promise<ChatMessage[]> {
  try {
    return parseStoredHistory(await AsyncStorage.getItem(KEY_HISTORY));
  } catch {
    return [];
  }
}

export async function saveHistory(list: ChatMessage[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_HISTORY, JSON.stringify(trimHistory(list)));
  } catch {
    /* ignora */
  }
}

export async function clearHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_HISTORY);
  } catch {
    /* ignora */
  }
}
