#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { createMemoryBackup } from '../src/core/memory/backup.js';

async function main() {
  const args = process.argv.slice(2);
  let backupDir = null;
  let maxKeep = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1]) {
      backupDir = path.resolve(args[++i]);
    } else if (args[i] === '--keep' && args[i + 1]) {
      maxKeep = parseInt(args[++i], 10);
    }
  }

  console.log('Iniciando backup de memória da Yui...');
  const res = await createMemoryBackup({
    ...(backupDir ? { backupDir } : {}),
    ...(maxKeep ? { maxKeep } : {}),
  });

  console.log(`Backup finalizado com sucesso!`);
  console.log(`Destino: ${res.folder}`);
  console.log(`Bancos salvos (${res.count}):`);
  for (const f of res.manifest.files) {
    console.log(`  - ${f.name} (${f.sizeOriginal} bytes -> ${f.sizeEncrypted} bytes cifrados)`);
  }
}

main().catch((err) => {
  console.error(`Erro no backup: ${err.message}`);
  process.exit(1);
});
