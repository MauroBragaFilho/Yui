// Gera amostras de voz (WAV) dos provedores LOCAIS do TTS para o dono OUVIR e escolher.
//
// Só usa FRASES FIXAS escritas aqui (nunca texto de usuário) e não toca no Discord,
// no .env nem em banco de dados. Os arquivos saem já no formato que a call recebe
// (48 kHz, estéreo, 16 bits, com volume normalizado), então o que você ouve é o que
// a Yui vai falar.
//
// Uso:
//   node scripts/tts-amostra.mjs            # SAPI (voz do Windows)
//   node scripts/tts-amostra.mjs --fake     # provedor falso (só um tom); testa o script sem voz
//   node scripts/tts-amostra.mjs --verbose  # mostra o log do provedor
//   node scripts/tts-amostra.mjs --limpar   # apaga a pasta no fim (para testar o script sem deixar nada)
//
// A pasta de saída é criada em %TEMP% com nome único e, por padrão, NÃO é apagada (você precisa
// ouvir os arquivos); no fim o script mostra o caminho e o comando para apagá-la. Com --limpar,
// ou se nenhum arquivo foi gerado, a pasta é apagada no fim.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTtsConfig } from '../src/services/tts/config.js';
import { encodeWav, pcmDurationMs, toDiscordPcm, DISCORD_CHANNELS, DISCORD_SAMPLE_RATE } from '../src/services/tts/audio.js';
import { createSapiProvider } from '../src/services/tts/providers/sapi.js';
import { createFakeProvider } from '../src/services/tts/providers/fake.js';

// Frases fixas, já escritas "como se fala" (o normalizador do bot faria isso com texto real).
// Inclui as grafias de "Yui" para escolher a que sai melhor, e as frases fixas do bot.
const FRASES = [
  ['pergunta', 'Canberra, não Sydney.'],
  ['saudacao', 'Oi! Tudo bem com você?'],
  ['nome-yui', 'Meu nome é Yui.'],
  ['nome-iuii', 'Meu nome é Iúi.'],
  ['nome-iui', 'Meu nome é Iui.'],
  ['numeros', 'São catorze horas e trinta minutos, e a conta deu cinco reais e vinte centavos.'],
  ['siglas', 'A gê pê u e o cê pê u do seu pê cê aguentam sessenta éfe pê ésse.'],
  ['longa', 'A capital da Austrália é Canberra, e não Sydney como muita gente pensa. Ela foi planejada para acabar com a rivalidade entre as duas cidades.'],
  ['fixa-resto', 'O resto está no chat.'],
  ['fixa-detalhes', 'Mandei os detalhes no chat.'],
  ['fixa-passo', 'Essa eu passo.'],
];

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log('Uso: node scripts/tts-amostra.mjs [--fake] [--verbose] [--limpar]');
  process.exit(0);
}
const verbose = args.has('--verbose');
const logger = {
  info: (m) => verbose && console.log(m),
  debug: (m) => verbose && console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

// getTtsConfig só lê variáveis YUI_TTS_*; este script não carrega o .env.
const config = getTtsConfig(process.env);
const providers = args.has('--fake')
  ? [createFakeProvider({ name: 'fake' })]
  : [createSapiProvider({ config, logger })]; // Piper/Edge ficaram para depois

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-tts-amostra-'));
let made = 0;

try {
  for (const provider of providers) {
    if (!provider.local) continue; // amostras só de provedores locais
    const probe = await provider.probe();
    if (!probe.ok) {
      console.log(`[${provider.name}] indisponível: ${probe.detail}`);
      continue;
    }
    console.log(`[${provider.name}] ${probe.detail}`);
    await provider.warmup();

    let n = 0;
    for (const [slug, text] of FRASES) {
      n++;
      const t0 = Date.now();
      try {
        const raw = await provider.synth(text);
        const ms = Date.now() - t0;
        const pcm = toDiscordPcm(raw);
        if (pcm.length === 0) {
          console.log(`  ${provider.name} ${slug}: o provedor devolveu silêncio`);
          continue;
        }
        const file = path.join(dir, `${provider.name}-${String(n).padStart(2, '0')}-${slug}.wav`);
        fs.writeFileSync(file, encodeWav({ pcm, sampleRate: DISCORD_SAMPLE_RATE, channels: DISCORD_CHANNELS }));
        made++;
        console.log(`  ok   ${path.basename(file)}  (${(pcmDurationMs(pcm) / 1000).toFixed(2)} s de áudio, síntese em ${ms} ms)`);
      } catch (err) {
        console.log(`  FALHA ${provider.name} ${slug}: ${err?.code || 'erro'}`);
      }
    }
  }
} finally {
  await Promise.all(providers.map((p) => p.dispose().catch(() => {})));
}

console.log('');
if (args.has('--limpar') || made === 0) {
  // Nada para ouvir (ou pedido explícito): não deixa pasta temporária para trás.
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Amostras: ${made} arquivo(s) gerado(s); a pasta temporária foi apagada: ${dir}`);
} else {
  console.log(`Amostras: ${made} arquivo(s) em ${dir}`);
  console.log('Esta pasta NÃO é apagada sozinha. Para apagar depois de ouvir:');
  console.log(`  PowerShell: Remove-Item -Recurse -Force "${dir}"`);
  console.log(`  Git Bash:   rm -rf "${dir.replace(/\\/g, '/')}"`);
}
process.exit(made > 0 ? 0 : 1);
