import { installDefaultTimeouts } from './netDefaults.js';

// Efeito colateral de propósito: importado PRIMEIRO em src/index.js, antes de qualquer módulo que use fetch ou axios.
installDefaultTimeouts();
