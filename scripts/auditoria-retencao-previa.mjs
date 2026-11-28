#!/usr/bin/env node
/**
 * PRÉVIA da retenção da auditoria: mostra o que a próxima rodada faria (girar, apagar pelo prazo ou pela quantidade, âncoras) e a verificação
 * da cadeia de cada arquivo. NÃO gira, NÃO grava e NÃO apaga nada. Só números, datas e nomes de arquivo; nenhum conteúdo das linhas.
 *
 *   node scripts/auditoria-retencao-previa.mjs                      # logs/core-audit.jsonl (ou YUI_AUDIT_FILE)
 *   node scripts/auditoria-retencao-previa.mjs logs/core-audit-bot.jsonl
 */
import path from 'node:path';
import { previaDaRetencao } from '../src/core/auditRetencao.js';

const alvo = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
console.log(JSON.stringify(previaDaRetencao(alvo ? { file: alvo } : {}), null, 2));
