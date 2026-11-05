#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { restoreMemoryBackup } from '../src/core/memory/backup.js';

async function main() {
  const args = process.argv.slice(2);
  let backupFolder = null;
  let targetDir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) {
      backupFolder = path.resolve(args[++i]);
    } else if (args[i] === '--to' && args[i + 1]) {
      targetDir = path.resolve(args[++i]);
    }
  }

  if (!backupFolder || !targetDir) {
    console.error('Uso: node scripts/restore-memory.mjs --from <pasta-do-backup> --to <pasta-de-destino>');
    process.exit(1);
  }

  console.log(`Restaurando backup de ${backupFolder} para ${targetDir}...`);
  const res = await restoreMemoryBackup({ backupFolder, targetDir });

  console.log(`Restauração concluída com sucesso!`);
  for (const item of res.restored) {
    console.log(`  - Restaurado: ${item.name} (SHA-256 verificado: ${item.sha256.slice(0, 16)}...)`);
  }
}

main().catch((err) => {
  console.error(`Erro na restauração: ${err.message}`);
  process.exit(1);
});
