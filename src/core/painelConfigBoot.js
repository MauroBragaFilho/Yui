import dotenv from 'dotenv';
import { aplicarPainelConfig } from './painelConfig.js';

// Efeito colateral de propósito: importado logo depois de netDefaultsBoot em src/index.js e src/cerebro.js, ANTES de src/config/index.js (que lê o ambiente ao ser importado).
// Carrega o .env (sem sobrescrever o que já existe no ambiente) e depois coloca por cima os valores salvos no painel (secrets/painel-config.json): o do painel vence o do .env.
dotenv.config({ quiet: true });
aplicarPainelConfig();
