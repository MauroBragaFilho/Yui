// SONDA DE HARDWARE (docs/PREPARO_ITEM_7.md): mostra o que esta máquina aguenta de IA LOCAL, em palavras claras. Roda no PC ou no servidor.
//   node scripts/sonda-hardware.mjs            relatório em texto
//   node scripts/sonda-hardware.mjs --json     o mesmo, em JSON
//   node scripts/sonda-hardware.mjs --pasta=D:\modelos   o disco livre dessa pasta (padrão: a pasta atual)
//
// SÓ LEITURA e SEM REDE: lê o sistema (os, fs.statfsSync) e, no Windows, pergunta ao PowerShell só `Get-CimInstance` (CPU e placa de vídeo); se houver uma placa NVIDIA, lê a VRAM
// exata com `nvidia-smi` (também só leitura). Nada é gravado, instalado, baixado nem enviado. Os testes (tests/test-sonda-hardware.js) usam saídas SIMULADAS: não abrem programa algum.
//
// ATENÇÃO: os números das faixas abaixo são ESTIMATIVAS de referência (modelos de 4 bits ocupam algo perto de 0,6 GB por bilhão de parâmetros, mais o contexto) e mudam com o
// modelo, o programa e o tamanho do contexto. A decisão de verdade vem de MEDIR dois ou três modelos na máquina (Fase M de docs/PROPOSTA_FASES_YUI_UNIFICADA.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const GIB = 1024 ** 3;
/** O comando do PowerShell: só Get-CimInstance (leitura). */
export const COMANDO_CIM = "$ErrorActionPreference='Stop'; $p = @(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed); $g = @(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion); [pscustomobject]@{ cpu = $p; gpu = $g } | ConvertTo-Json -Depth 4 -Compress";
export const ARGS_NVIDIA_SMI = ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'];
/** O PowerShell pode levar uns 20 s para responder numa máquina ocupada (a primeira consulta ao WMI é lenta): prazo largo. */
export const PRAZO_CIM_MS = 60_000;

/** As faixas e o que cada uma exige (ESTIMATIVAS). */
export const TABELA_DE_FAIXAS = Object.freeze([
  Object.freeze({ id: 'externo', nome: 'Apenas provedores externos (nuvem)', exige: 'qualquer máquina; nenhum modelo roda aqui', modelos: 'nenhum local', observacao: 'é o que a Yui faz hoje' }),
  Object.freeze({ id: 'pequeno', nome: 'Modelos pequenos locais', exige: 'uma placa com 6 GB de VRAM ou mais, ou 16 GB de RAM no total com 4 núcleos ou mais (só na CPU, devagar; uns 8 GB livres para o modelo)', modelos: '1 a 8 bilhões de parâmetros, em 4 bits (uns 2 a 6 GB por modelo)', observacao: 'serve para conversa curta e tarefas simples; código só o básico' }),
  Object.freeze({ id: 'medio', nome: 'Modelos médios locais', exige: 'uma placa com 16 GB de VRAM ou mais (o ideal é 24 GB), ou 32 GB de RAM no total com 8 núcleos ou mais (só na CPU, bem devagar)', modelos: '14 a 32 bilhões de parâmetros, em 4 bits (uns 9 a 20 GB por modelo)', observacao: 'a faixa mínima razoável para um agente de código' }),
]);
export const ESTIMATIVA = true;

// ── Leitura (a parte que toca o sistema; os testes não passam por aqui) ──────────────────────────────────────────────────────────────

/** Roda um programa de LEITURA e devolve a saída (ou null se falhar). Sem shell, com prazo, sem janela. */
export function executarLeitura(programa, args, prazoMs = 15_000) {
  try {
    return execFileSync(programa, args, { encoding: 'utf8', timeout: prazoMs, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 });
  } catch {
    return null;
  }
}

// ── Conversão das saídas (puras) ──────────────────────────────────────────────────────────────────────────────────────────────────────

const comoLista = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []);
const inteiro = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);

/** A saída do COMANDO_CIM (JSON) -> { cpus, gpus }. Saída vazia ou inválida: listas vazias. */
export function converterCim(texto) {
  let j;
  try { j = JSON.parse(String(texto ?? '').replace(/^\uFEFF/, '')); } catch { return { cpus: [], gpus: [] }; }
  const cpus = comoLista(j?.cpu).map((c) => ({ nome: String(c?.Name ?? '').replace(/\s+/g, ' ').trim(), nucleos: inteiro(c?.NumberOfCores), nucleosLogicos: inteiro(c?.NumberOfLogicalProcessors), mhz: inteiro(c?.MaxClockSpeed) })).filter((c) => c.nome);
  const gpus = comoLista(j?.gpu).map((g) => ({ nome: String(g?.Name ?? '').replace(/\s+/g, ' ').trim(), vramBytes: inteiro(g?.AdapterRAM), driver: String(g?.DriverVersion ?? '').trim() })).filter((g) => g.nome);
  return { cpus, gpus };
}

/** A saída do nvidia-smi (CSV: nome, total MiB, livre MiB) -> [{ nome, vramBytes, vramLivreBytes }]. */
export function converterNvidiaSmi(texto) {
  const out = [];
  for (const linha of String(texto ?? '').split(/\r?\n/)) {
    const m = /^(.*\S)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(linha); // "nome, total MiB, livre MiB" (o nome pode ter vírgula)
    if (!m) continue;
    const total = Number(m[2]);
    const livre = Number(m[3]);
    if (m[1].trim() && total > 0) out.push({ nome: m[1].trim(), vramBytes: Math.round(total * 1024 * 1024), vramLivreBytes: Math.round(livre * 1024 * 1024) });
  }
  return out;
}

/** Placa integrada ou virtual (não conta como capacidade de IA). */
export const ehPlacaIntegrada = (nome) => /uhd graphics|iris|hd graphics|vega \d+ graphics|radeon\(tm\) graphics|microsoft basic|virtual|vmware|hyper-v|parsec|remote display/i.test(String(nome ?? ''));

/**
 * Junta as placas do CIM e do nvidia-smi. O AdapterRAM do CIM é um número de 32 bits (trava em uns 4 GB: não serve para placas maiores), então a VRAM do nvidia-smi vence
 * quando o nome bate. `vramFonte`: 'nvidia-smi', 'cim' ou null.
 */
export function juntarPlacas(cim, nvidia) {
  const lista = cim.map((g) => ({ nome: g.nome, vramBytes: g.vramBytes, vramLivreBytes: null, vramFonte: g.vramBytes ? 'cim' : null, integrada: ehPlacaIntegrada(g.nome) }));
  for (const n of nvidia) {
    const par = lista.find((g) => g.nome.toLowerCase() === n.nome.toLowerCase()) ?? lista.find((g) => /nvidia/i.test(g.nome) && n.nome.toLowerCase().includes(g.nome.toLowerCase().replace(/^nvidia\s+/, '')));
    if (par) Object.assign(par, { vramBytes: n.vramBytes, vramLivreBytes: n.vramLivreBytes, vramFonte: 'nvidia-smi' });
    else lista.push({ nome: n.nome, vramBytes: n.vramBytes, vramLivreBytes: n.vramLivreBytes, vramFonte: 'nvidia-smi', integrada: false });
  }
  return lista;
}

/**
 * Coleta o retrato da máquina. As dependências são INJETÁVEIS (os testes passam saídas simuladas).
 * @param {{ sistema?: typeof os, executar?: (programa: string, args: string[]) => string|null, statfs?: (pasta: string) => { bsize: number, blocks: number, bavail: number }, pasta?: string, plataforma?: string }} [o]
 */
export function coletar({ sistema = os, executar = executarLeitura, statfs = (p) => fs.statfsSync(p), pasta = process.cwd(), plataforma = process.platform } = {}) {
  const avisos = [];
  const cpusDoSistema = sistema.cpus?.() ?? [];
  let cpu = { modelo: String(cpusDoSistema[0]?.model ?? 'desconhecido').replace(/\s+/g, ' ').trim(), nucleosLogicos: cpusDoSistema.length || null, nucleosFisicos: null };
  let cim = { cpus: [], gpus: [] };
  if (plataforma === 'win32') {
    cim = converterCim(executar('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', COMANDO_CIM], PRAZO_CIM_MS));
    if (!cim.cpus.length && !cim.gpus.length) avisos.push('Não consegui ler o processador e a placa de vídeo pelo PowerShell (Get-CimInstance): demorou demais ou falhou.');
    const c = cim.cpus[0];
    if (c) cpu = { modelo: c.nome || cpu.modelo, nucleosLogicos: cim.cpus.reduce((s, x) => s + (x.nucleosLogicos ?? 0), 0) || cpu.nucleosLogicos, nucleosFisicos: cim.cpus.reduce((s, x) => s + (x.nucleos ?? 0), 0) || null };
  } else {
    avisos.push('Fora do Windows a sonda só detalha a placa NVIDIA (nvidia-smi).');
  }
  const nvidia = converterNvidiaSmi(executar('nvidia-smi', ARGS_NVIDIA_SMI));
  const gpus = juntarPlacas(cim.gpus, nvidia);
  if (!gpus.length) avisos.push('Nenhuma placa de vídeo identificada.');
  if (gpus.some((g) => g.vramFonte === 'cim' && g.vramBytes >= 4 * GIB - 2 * 1024 * 1024)) avisos.push('A VRAM veio do Windows (CIM), que trava em uns 4 GB: numa placa maior o número real pode ser maior.');

  let disco = null;
  try {
    const s = statfs(pasta);
    disco = { pasta: path.resolve(pasta), totalBytes: s.blocks * s.bsize, livreBytes: s.bavail * s.bsize };
  } catch { avisos.push('Não consegui ler o espaço livre do disco.'); }

  return {
    so: { plataforma, versao: String(sistema.release?.() ?? ''), arquitetura: String(sistema.arch?.() ?? '') },
    cpu,
    ram: { totalBytes: sistema.totalmem(), livreBytes: sistema.freemem() },
    gpus,
    disco,
    avisos,
  };
}

// ── Recomendação ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A placa com mais VRAM entre as dedicadas (bytes), ou 0. */
export const maiorVram = (gpus) => Math.max(0, ...gpus.filter((g) => !g.integrada).map((g) => g.vramBytes ?? 0));

/**
 * A recomendação, por faixa (ESTIMATIVAS): médios locais com 16 GB de VRAM, ou 32 GB de RAM no total e 8 núcleos (só na CPU, bem devagar); pequenos locais com 6 GB de VRAM, ou
 * 16 GB de RAM no total e 4 núcleos (só na CPU, devagar). A RAM LIVRE de agora (que muda o tempo todo) só entra como aviso: a conta da faixa usa a RAM TOTAL.
 * @returns {{ faixa: 'externo'|'pequeno'|'medio', titulo: string, texto: string, motivos: string[], estimativa: true }}
 */
export function recomendar(info) {
  const ramLivre = (info.ram?.livreBytes ?? 0) / GIB;
  const ramTotal = (info.ram?.totalBytes ?? 0) / GIB;
  const vram = maiorVram(info.gpus ?? []) / GIB;
  const nucleos = info.cpu?.nucleosLogicos ?? 0;
  const motivos = [];
  let faixa = 'externo';
  let soNaCpu = false;
  if (vram >= 16) { faixa = 'medio'; motivos.push(`a placa tem ${vram.toFixed(0)} GB de VRAM (a faixa média pede 16 GB ou mais)`); }
  else if (ramTotal >= 32 && nucleos >= 8) { faixa = 'medio'; soNaCpu = true; motivos.push(`há ${ramTotal.toFixed(0)} GB de RAM e ${nucleos} núcleos: dá para rodar um modelo médio, mas só na CPU (bem devagar)`); }
  else if (vram >= 6) { faixa = 'pequeno'; motivos.push(`a placa tem ${vram.toFixed(0)} GB de VRAM (a faixa pequena pede 6 GB ou mais)`); }
  else if (ramTotal >= 16 && nucleos >= 4) { faixa = 'pequeno'; soNaCpu = true; motivos.push(`há ${ramTotal.toFixed(0)} GB de RAM e ${nucleos} núcleos: dá para rodar um modelo pequeno só na CPU, devagar (poucos tokens por segundo)${vram > 0 ? `; a placa de ${vram.toFixed(0)} GB só ajuda com modelos de uns 3 bilhões de parâmetros` : ''}`); }
  else {
    motivos.push(`RAM de ${ramTotal.toFixed(1)} GB${vram ? ` e placa de ${vram.toFixed(0)} GB de VRAM` : ' e sem placa de vídeo dedicada'}: abaixo do mínimo da faixa pequena (16 GB de RAM com 4 núcleos, ou 6 GB de VRAM)`);
  }
  if (soNaCpu && ramLivre < 8) motivos.push(`agora só há ${ramLivre.toFixed(1)} GB de RAM livres: feche os programas pesados antes de testar um modelo`);
  const base = TABELA_DE_FAIXAS.find((f) => f.id === faixa);
  const texto = {
    externo: 'Use só provedores externos (nuvem). Esta máquina não tem folga para um modelo local útil.',
    pequeno: 'Dá para testar modelos pequenos locais (conversa curta e tarefas simples). Para código a sério, continue com os provedores externos.',
    medio: 'Dá para testar modelos médios locais, a faixa mínima razoável para um agente de código. Meça a velocidade (tokens por segundo) antes de depender dela.',
  }[faixa];
  return { faixa, titulo: base.nome, texto, motivos, estimativa: ESTIMATIVA };
}

// ── Texto ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function formatarBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'desconhecido';
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

/** O relatório em texto, em português. */
export function formatarRelatorio(info, rec = recomendar(info)) {
  const l = [];
  l.push('SONDA DE HARDWARE (só leitura, sem rede)');
  l.push('');
  l.push(`Sistema: ${info.so.plataforma} ${info.so.versao} (${info.so.arquitetura})`);
  l.push(`Processador: ${info.cpu.modelo}, ${info.cpu.nucleosFisicos ? `${info.cpu.nucleosFisicos} núcleos (${info.cpu.nucleosLogicos} lógicos)` : `${info.cpu.nucleosLogicos ?? '?'} núcleos lógicos`}`);
  l.push(`Memória RAM: ${formatarBytes(info.ram.totalBytes)} no total, ${formatarBytes(info.ram.livreBytes)} livres agora`);
  if (info.gpus.length) for (const g of info.gpus) l.push(`Placa de vídeo: ${g.nome}${g.integrada ? ' (integrada ou virtual)' : ''}, VRAM ${g.vramBytes ? formatarBytes(g.vramBytes) : 'desconhecida'}${g.vramFonte ? ` (fonte: ${g.vramFonte})` : ''}`);
  else l.push('Placa de vídeo: nenhuma identificada');
  l.push(info.disco ? `Disco (${info.disco.pasta}): ${formatarBytes(info.disco.livreBytes)} livres de ${formatarBytes(info.disco.totalBytes)}` : 'Disco: não consegui ler');
  l.push('');
  l.push(`RECOMENDAÇÃO: ${rec.titulo}`);
  l.push(rec.texto);
  for (const m of rec.motivos) l.push(`- ${m}`);
  l.push('');
  l.push('Faixas (valores APROXIMADOS, são estimativas; o que vale é medir modelos de verdade na máquina):');
  for (const f of TABELA_DE_FAIXAS) {
    l.push(`- ${f.nome}${f.id === rec.faixa ? '  <= esta máquina' : ''}`);
    l.push(`    exige: ${f.exige}`);
    l.push(`    modelos: ${f.modelos}. ${f.observacao}.`);
  }
  if (info.avisos.length) { l.push(''); for (const a of info.avisos) l.push(`Aviso: ${a}`); }
  return l.join('\n');
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const json = argv.includes('--json');
  const pastaArg = argv.find((a) => a.startsWith('--pasta='));
  const info = coletar({ pasta: pastaArg ? pastaArg.slice('--pasta='.length) : process.cwd(), ...deps });
  const rec = recomendar(info);
  console.log(json ? JSON.stringify({ info, recomendacao: rec, tabela: TABELA_DE_FAIXAS, estimativa: ESTIMATIVA }, null, 2) : formatarRelatorio(info, rec));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
