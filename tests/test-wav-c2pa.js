// WAV do Gemini TTS via OmniRoute: o manifesto C2PA vem contado como áudio no fim do data e é cortado na leitura. Sem rede.
import assert from 'node:assert/strict';
import { parseWav, encodeWav, toDiscordPcm } from '../src/services/tts/audio.js';

let ok = 0;
const test = (name, fn) => { fn(); ok++; console.log(`  ok - ${name}`); };
const u32 = (n, le = true) => { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(n); else b.writeUInt32BE(n); return b; };
function c2pa(bytes = 7600) {
  const jumd = Buffer.concat([u32(25, false), Buffer.from('jumdc2pa'), Buffer.alloc(13)]);
  const fill = Buffer.alloc(bytes, 0x7f);
  const jumb = Buffer.concat([u32(8 + jumd.length + fill.length, false), Buffer.from('jumb'), jumd, fill]);
  return Buffer.concat([Buffer.from('C2PA'), u32(jumb.length), jumb, Buffer.alloc(jumb.length & 1)]);
}
const voice = Buffer.alloc(24000);
for (let i = 0; i < 12000; i++) voice.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i * 2);
const wav = (pcm) => encodeWav({ pcm, sampleRate: 24000, channels: 1 });

test('chunk dentro do data é cortado, o áudio fica intacto', () => {
  assert.deepEqual(parseWav(wav(Buffer.concat([voice, c2pa()]))).pcm, voice);
  assert.deepEqual(parseWav(wav(Buffer.concat([voice, c2pa(7601)]))).pcm, voice);
});
test('data em streaming (tamanho 0xFFFFFFFF) também', () => {
  const w = wav(Buffer.concat([voice, c2pa()]));
  w.writeUInt32LE(0xffffffff, 40);
  assert.deepEqual(parseWav(w).pcm, voice);
});
test('o resultado para o Discord é o mesmo do áudio limpo (pico e duração)', () => {
  assert.deepEqual(toDiscordPcm(parseWav(wav(Buffer.concat([voice, c2pa()])))), toDiscordPcm(parseWav(wav(voice))));
});
test('áudio legítimo nunca é cortado', () => {
  const casos = [
    voice,
    Buffer.concat([voice, Buffer.from('C2PA'), voice]), // só as 4 letras
    Buffer.concat([voice, c2pa(), voice]), // assinatura com áudio depois do chunk
    Buffer.concat([voice, c2pa().subarray(0, 16)]), // assinatura incompleta
  ];
  for (const pcm of casos) assert.deepEqual(parseWav(wav(pcm)).pcm, pcm.subarray(0, pcm.length - (pcm.length % 2)));
});
console.log(`${ok} testes OK`);
