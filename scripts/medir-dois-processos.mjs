// Medição de RAM e CPU dos dois processos da Yui (o cérebro e o bot) SEM tocar neles (etapa 6, para rodar no notebook quando o Braga der o OK).
//
// Só LÊ o logs/supervisor-estado.json que o supervisor (node src/supervisor.js, com YUI_CEREBRO_EXTERNO=true) já grava: a cada rodada de saúde
// ele pergunta a cada processo, pelo IPC, a RAM (rss e heap) e a CPU usada, e renova o arquivo a cada 30 s (YUI_SUPERVISOR_ESTADO_MS).
// Nada aqui abre, encerra ou procura processo por PID; não lê o .env, os bancos nem a conversa.
//
// Uso (na pasta da Yui):  node scripts/medir-dois-processos.mjs [minutos=10] [intervalo_s=30] [arquivo=logs/supervisor-estado.json]
// Saída: uma linha por leitura e, no fim, o resumo por processo (RAM mínima, média e máxima; CPU média em % de UM núcleo no período).
import fs from 'node:fs';
import path from 'node:path';

const minutos = Math.max(1, Number(process.argv[2]) || 10);
const intervaloS = Math.max(5, Number(process.argv[3]) || 30);
const arquivo = path.resolve(process.argv[4] || path.join('logs', 'supervisor-estado.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ler() {
  try {
    const e = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    const out = {};
    for (const [papel, p] of Object.entries(e?.processos ?? {})) {
      const u = p?.ultimaSaude?.uso;
      if (!u) continue;
      out[papel] = { em: p.ultimaSaude.em, rssMB: u.rssMB, heapMB: u.heapMB, cpuMs: (u.cpuUserMs ?? 0) + (u.cpuSystemMs ?? 0), uptimeS: u.uptimeSeconds, inicios: p.inicios };
    }
    return out;
  } catch (err) {
    console.log(`(não consegui ler ${arquivo}: ${err.code || err.message})`);
    return {};
  }
}

const leituras = [];
const fim = Date.now() + minutos * 60_000;
console.log(`Lendo ${arquivo} a cada ${intervaloS} s por ${minutos} min (só leitura).`);
while (Date.now() <= fim) {
  const l = ler();
  leituras.push(l);
  console.log(`${new Date().toISOString()} ${Object.entries(l).map(([p, v]) => `${p}: rss=${v.rssMB} MB heap=${v.heapMB} MB cpu=${v.cpuMs} ms`).join(' | ') || '(sem dados)'}`);
  await sleep(intervaloS * 1000);
}

const resumo = {};
for (const papel of new Set(leituras.flatMap((l) => Object.keys(l)))) {
  const xs = leituras.map((l) => l[papel]).filter(Boolean);
  const unicos = [...new Map(xs.map((x) => [x.em, x])).values()]; // o supervisor renova a cada 30 s: leituras repetidas contam uma vez
  const rss = unicos.map((x) => x.rssMB).filter(Number.isFinite);
  const mesmoProcesso = unicos.filter((x) => x.inicios === unicos.at(-1)?.inicios); // CPU só dentro do mesmo processo (sem religamento no meio)
  let cpuPct = null;
  if (mesmoProcesso.length >= 2) {
    const a = mesmoProcesso[0];
    const b = mesmoProcesso.at(-1);
    const ms = Date.parse(b.em) - Date.parse(a.em);
    if (ms > 0) cpuPct = Math.round(((b.cpuMs - a.cpuMs) / ms) * 1000) / 10;
  }
  resumo[papel] = rss.length ? {
    leituras: unicos.length,
    rssMB: { min: Math.min(...rss), media: Math.round((rss.reduce((s, x) => s + x, 0) / rss.length) * 10) / 10, max: Math.max(...rss) },
    cpuPctDeUmNucleo: cpuPct,
  } : { leituras: 0 };
}
console.log(`\nResumo: ${JSON.stringify(resumo, null, 2)}`);
