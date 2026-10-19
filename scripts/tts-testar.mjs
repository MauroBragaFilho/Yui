// Página LOCAL para testar a voz neural sem usar a Yui nem o Discord.
//   npm run tts:testar        (ou "Testar Voz.bat")  ->  abre http://127.0.0.1:4747
//   node scripts/tts-testar.mjs --selftest   (sobe, sintetiza uma frase fixa por HTTP e encerra)
// Só escuta em 127.0.0.1, exige um token aleatório (impede outra página do navegador de usar o servidor)
// e limita o texto a 300 caracteres. O texto digitado SAI do PC (Microsoft), como na voz da nuvem da Yui.
import http from 'node:http';
import crypto from 'node:crypto';
import { createEdgeProvider, safeProsody } from '../src/services/tts/providers/edge.js';
import { encodeWav } from '../src/services/tts/audio.js';
import { createAzureProvider, safeVoice as azureVoiceOk, safeStyle } from '../src/services/tts/providers/azure.js';
import 'dotenv/config'; // lê o .env do projeto (a chave do Azure fica SÓ no servidor desta página, nunca vai ao navegador)

const PORT = Number(process.env.YUI_TTS_TESTAR_PORT || 4747);
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(16).toString('hex');
const VOICES = { 'pt-BR-FranciscaNeural': 'Francisca (calma, natural)', 'pt-BR-ThalitaNeural': 'Thalita (mais jovem)', 'pt-BR-ThalitaMultilingualNeural': 'Thalita Multilingual (mais nova; fala inglês também)', 'pt-BR-AntonioNeural': 'Antonio (masculina)', 'pt-PT-RaquelNeural': 'Raquel (sotaque de Portugal)', 'pt-PT-DuarteNeural': 'Duarte (Portugal, masculina)' };
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Testar voz da Yui</title>
<style>
:root{--bg:#14121a;--card:#1f1b29;--fg:#ece8f5;--mut:#9c93b3;--acc:#c084fc;--ok:#4ade80;--bad:#f87171}
@media (prefers-color-scheme: light){:root{--bg:#f6f3fb;--card:#fff;--fg:#221c33;--mut:#6b6485;--acc:#7c3aed;--ok:#15803d;--bad:#b91c1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,Segoe UI,sans-serif;display:grid;place-items:start center;padding:24px 16px}
main{width:100%;max-width:680px;background:var(--card);border-radius:16px;padding:24px;box-shadow:0 8px 30px #0003}
h1{margin:0 0 4px;font-size:1.4rem}p.s{margin:0 0 18px;color:var(--mut);font-size:.9rem}
label{display:block;margin:14px 0 6px;font-weight:600;font-size:.9rem}
select,textarea{width:100%;padding:10px;border-radius:10px;border:1px solid #8884;background:transparent;color:inherit;font:inherit}
textarea{min-height:90px;resize:vertical}input[type=range]{width:100%;accent-color:var(--acc)}
.row{display:flex;justify-content:space-between;color:var(--mut);font-size:.85rem}.v{color:var(--acc);font-weight:700}
.presets{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}button{cursor:pointer;border:0;border-radius:10px;padding:10px 16px;font:inherit;font-weight:700}
.p{background:#8883;color:inherit;font-weight:600;padding:6px 12px;font-size:.85rem}.go{background:var(--acc);color:#fff;width:100%;margin-top:16px;padding:14px;font-size:1.05rem}
.go:disabled{opacity:.6;cursor:wait}#st{min-height:1.4em;margin:10px 0 0;font-size:.9rem}#st.ok{color:var(--ok)}#st.bad{color:var(--bad)}
pre{background:#0004;padding:12px;border-radius:10px;overflow:auto;font-size:.85rem;margin:8px 0 0}audio{width:100%;margin-top:14px}
</style></head><body><main>
<h1>🔊 Testar a voz da Yui</h1><p class="s">Roda só no seu PC. O texto digitado sai para a Microsoft para gerar a voz (como na Yui).</p>
<label for="engine">Motor</label><select id="engine"><option value="edge">Edge (grátis, não oficial)</option><option value="azure">Azure Speech (oficial; precisa de chave no .env)</option></select>
<label for="voice">Voz</label><select id="voice">${Object.entries(VOICES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
<div id="stylebox" hidden><label for="style">Estilo (só no Azure; nem toda voz tem)</label><select id="style"><option value="">(normal)</option></select></div>
<label for="text">Frase</label><textarea id="text" maxlength="300">Oi, eu sou a Yui! Tudo bem com você? Hoje o dia está tranquilo, e eu estou aqui para ajudar no que precisar.</textarea>
<div class="presets"><b style="align-self:center;font-size:.85rem">Atalhos:</b>
<button class="p" data-v="pt-BR-FranciscaNeural" data-p="0" data-r="-4">Francisca calma</button>
<button class="p" data-v="pt-BR-ThalitaNeural" data-p="6" data-r="3">Thalita A (leve)</button>
<button class="p" data-v="pt-BR-ThalitaNeural" data-p="12" data-r="5">Thalita B (jovem)</button>
<button class="p" data-v="pt-BR-ThalitaNeural" data-p="18" data-r="6">Thalita C (bem aguda)</button></div>
<label for="pitch">Tom <span class="v" id="pv"></span></label><input id="pitch" type="range" min="-20" max="30" step="1" value="12">
<div class="row"><span>mais grave</span><span>mais agudo</span></div>
<label for="rate">Velocidade <span class="v" id="rv"></span></label><input id="rate" type="range" min="-25" max="25" step="1" value="5">
<div class="row"><span>mais devagar</span><span>mais rápida</span></div>
<button class="go" id="go">▶ Falar</button><p id="st"></p><audio id="au" controls></audio>
<label>Para usar essa voz na Yui, cole no <code>.env</code> e reinicie:</label><pre id="env"></pre>
</main><script>
const TOKEN=${JSON.stringify(TOKEN)};
const $=id=>document.getElementById(id);
const sign=n=>(n>=0?'+':'')+n;
const EDGE_VOICES=$('voice').innerHTML; let azureVoices=[];
function upd(){ $('pv').textContent=sign($('pitch').value)+'Hz'; $('rv').textContent=sign($('rate').value)+'%';
 const r=sign($('rate').value)+'%', p=sign($('pitch').value)+'Hz';
 $('env').textContent=$('engine').value==='azure'
  ? 'AZURE_SPEECH_KEY=(sua chave)\\nAZURE_SPEECH_REGION=(ex.: brazilsouth)\\nYUI_TTS_AZURE_VOICE='+$('voice').value+(($('style').value)?'\\nYUI_TTS_AZURE_STYLE='+$('style').value:'')+'\\nYUI_TTS_AZURE_RATE='+r+'\\nYUI_TTS_AZURE_PITCH='+p
  : 'YUI_TTS_EDGE_VOICE='+$('voice').value+'\\nYUI_TTS_EDGE_RATE='+r+'\\nYUI_TTS_EDGE_PITCH='+p; }
function fillStyles(){ const v=azureVoices.find(x=>x.name===$('voice').value); const st=$('style'); st.innerHTML='<option value="">(normal)</option>'+((v&&v.styles)||[]).map(s=>'<option value="'+s+'">'+s+'</option>').join(''); $('stylebox').hidden=!(v&&v.styles&&v.styles.length); }
async function setEngine(){ const st=$('st'); st.className=''; st.textContent='';
 if($('engine').value==='azure'){ st.textContent='Buscando as vozes do seu recurso Azure...';
  try{ const r=await fetch('/vozes-azure',{headers:{'x-token':TOKEN}}); if(!r.ok) throw new Error(await r.text()); azureVoices=await r.json();
   $('voice').innerHTML=azureVoices.filter(v=>v.locale==='pt-BR').map(v=>'<option value="'+v.name+'">'+v.name.replace('pt-BR-','').replace('Neural','')+' ('+(v.gender==='Female'?'fem.':'masc.')+(v.styles.length?', '+v.styles.length+' estilos':'')+')</option>').join('')||'<option value="">(nenhuma voz pt-BR)</option>';
   fillStyles(); st.textContent=azureVoices.length+' vozes em português no seu recurso.'; st.className='ok'; }
  catch(e){ st.className='bad'; st.textContent='Azure: '+e.message; $('engine').value='edge'; $('voice').innerHTML=EDGE_VOICES; $('stylebox').hidden=true; } }
 else { $('voice').innerHTML=EDGE_VOICES; $('stylebox').hidden=true; }
 upd(); }
$('engine').addEventListener('change',setEngine); $('voice').addEventListener('input',()=>{ if($('engine').value==='azure') fillStyles(); upd(); });
for(const id of ['pitch','rate','style']) $(id).addEventListener('input',upd); upd();
for(const b of document.querySelectorAll('.p')) b.onclick=()=>{ $('voice').value=b.dataset.v; $('pitch').value=b.dataset.p; $('rate').value=b.dataset.r; upd(); };
$('go').onclick=async()=>{ const st=$('st'); st.className=''; st.textContent='Gerando...'; $('go').disabled=true;
 try{ const r=await fetch('/falar',{method:'POST',headers:{'content-type':'application/json','x-token':TOKEN},body:JSON.stringify({engine:$('engine').value,style:$('style').value,text:$('text').value,voice:$('voice').value,rate:sign($('rate').value)+'%',pitch:sign($('pitch').value)+'Hz'})});
  if(!r.ok){ throw new Error((await r.text())||('erro '+r.status)); }
  const url=URL.createObjectURL(await r.blob()); $('au').src=url; await $('au').play().catch(()=>{}); st.className='ok'; st.textContent='Pronto.';
 }catch(e){ st.className='bad'; st.textContent='Não consegui: '+e.message; } finally{ $('go').disabled=false; } };
</script></body></html>`;

async function synth(body) {
  const text = String(body?.text ?? '').trim().slice(0, 300);
  if (!text) throw Object.assign(new Error('Escreva uma frase.'), { status: 400 });
  if (body?.engine === 'azure') {
    const az = createAzureProvider({ config: { azureRegion: process.env.AZURE_SPEECH_REGION, azureVoice: azureVoiceOk(body?.voice, 'pt-BR-ThalitaMultilingualNeural'), azureStyle: safeStyle(body?.style), azureRate: safeProsody(body?.rate, '+0%'), azurePitch: safeProsody(body?.pitch, '+0Hz'), azureMaxCharsPerMonth: 450000 }, env: process.env, logger: quiet });
    const pr = await az.probe();
    if (!pr.ok) throw Object.assign(new Error(pr.detail), { status: 400 });
    const r = await az.synth(text, {});
    return encodeWav({ pcm: r.pcm, sampleRate: r.sampleRate, channels: r.channels });
  }
  const voice = Object.hasOwn(VOICES, body?.voice) ? body.voice : 'pt-BR-FranciscaNeural';
  const provider = createEdgeProvider({ config: { edgeVoice: voice, edgeRate: safeProsody(body?.rate, '+0%'), edgePitch: safeProsody(body?.pitch, '+0Hz'), edgeMaxCharsPerDay: 100000 }, logger: quiet });
  const r = await provider.synth(text, {});
  return encodeWav({ pcm: r.pcm, sampleRate: r.sampleRate, channels: r.channels });
}

const server = http.createServer(async (req, res) => {
  try {
    const hostOk = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(req.headers.host || ''));
    if (!hostOk) { res.writeHead(403); return res.end('host inválido'); }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(PAGE);
    }
    if (req.method === 'GET' && req.url === '/vozes-azure') {
      if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token inválido'); }
      const az = createAzureProvider({ config: { azureRegion: process.env.AZURE_SPEECH_REGION }, env: process.env, logger: quiet });
      const pr = await az.probe();
      if (!pr.ok) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(`${pr.detail}. Veja o passo a passo em docs/content_pt/TTS.md.`); }
      const list = await az.listVoices({});
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(list));
    }
    if (req.method === 'POST' && req.url === '/falar') {
      if (req.headers['x-token'] !== TOKEN) { res.writeHead(403); return res.end('token inválido'); }
      const chunks = [];
      let size = 0;
      for await (const c of req) { size += c.length; if (size > 4096) { res.writeHead(413); return res.end('grande demais'); } chunks.push(c); }
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); return res.end('JSON inválido'); }
      const wav = await synth(body);
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store' });
      return res.end(wav);
    }
    res.writeHead(404); res.end('não encontrado');
  } catch (err) {
    const status = err?.status || 502;
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(status === 400 ? err.message : 'A voz da nuvem não respondeu agora. Tente de novo.');
  }
});

if (process.argv.includes('--selftest')) {
  server.listen(0, HOST, async () => {
    const { port } = server.address();
    try {
      const page = await fetch(`http://${HOST}:${port}/`);
      const html = await page.clone().text();
      const js = (html.match(/<script>([\s\S]*)<\/script>/) || [])[1] || '';
      try { new Function(js); console.log('JavaScript da página: sintaxe ok'); } catch (e) { console.log('JavaScript da página: ERRO', e.message); }
      const noToken = await fetch(`http://${HOST}:${port}/falar`, { method: 'POST', body: '{}' });
      const r = await fetch(`http://${HOST}:${port}/falar`, { method: 'POST', headers: { 'x-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Teste.', voice: 'pt-BR-ThalitaNeural', rate: '+5%', pitch: '+12Hz' }) });
      const buf = Buffer.from(await r.arrayBuffer());
      console.log('página', page.status, '| sem token', noToken.status, '| síntese', r.status, buf.length, 'bytes', buf.subarray(0, 4).toString());
    } catch (e) { console.log('FALHOU', e.message); }
    server.close(() => process.exit(0));
  });
} else {
  server.listen(PORT, HOST, () => console.log(`Teste de voz: http://${HOST}:${PORT}  (Ctrl+C para fechar)`));
}
