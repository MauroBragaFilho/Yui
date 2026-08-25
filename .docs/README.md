# 🤖 GTA Online Updates — Documentação do Projeto

Projeto unificado e otimizado de rastreamento de notícias e sistemas diários/semanais do **GTA Online** para Discord, projetado para rodar com alta eficiência e baixo consumo de recursos em um servidor **Oracle Cloud (Ubuntu 24.04 LTS, 2 vCPU, ~4 GB RAM)** ou ambiente local sem dependências de compilação C++.

---

## 🎯 1. Visão Geral e Objetivos

O **GTA Online Updates** substitui e aprimora duas ferramentas clássicas da comunidade em um único bot com apenas **uma conta e um token Discord**:

1. **Rockstar Newswire Engine** (Baseado na referência *Carbowix/rockstar-newswire*):
   - Rastreador inteligente de notícias da Rockstar Games via Puppeteer.
   - **Correção chave:** Resolve a perda de múltiplos artigos publicados no mesmo intervalo através de extração em lote, ordenação cronológica e deduplicação persistente no SQLite.
   - **Gerenciamento de memória:** O navegador Chromium só é aberto on-demand durante a verificação e fechado imediatamente em bloco `finally`, liberando toda a RAM (< 500 MB em pico, < 150 MB em repouso).

2. **GTAO Engine** (Baseado na referência *ShinyWasabi/GTAO-Bot*):
   - Rastreador modular das atividades diárias (reset às **06:00 UTC**) e semanais do GTA Online.
   - Sistemas suportados: *Gun Van (Van de Armas), Street Dealers (Traficantes), Shipwreck (Naufrágio), Hidden Caches / Baús do Cayo, Time Trials (RC Bandito & Junk Energy Bike), Alvos do Madrazo, Eventos Semanais/Descontos*.

---

## ⚡ 2. 100% JavaScript / WebAssembly (Zero C++ / Zero Build Tools)

Para garantir máxima portabilidade e instalação imediata em qualquer máquina sem a necessidade de instalar compiladores C++ (Visual Studio Build Tools / `node-gyp`), a camada de persistência utiliza **`sql.js` (SQLite compilado para WebAssembly)**, mantendo a compatibilidade e persistência completa em arquivo `.db` local de forma extremamente leve e rápida.

---

## 🏗️ 3. Arquitetura Modular

```
GTA Online Updates
│
├── 📰 Newswire Engine   ──> Extração, normalização e deduplicação de notícias
├── 🎮 GTAO Engine       ──> Coletores modulares para cada sistema do jogo
├── 📅 Central Scheduler ──> Cron em UTC (Newswire: 30-60min | Diário: 06:00 UTC | Semanal)
├── 💾 Database (SQLite) ──> WebAssembly Puro (Zero C++) para configs e histórico
├── 📤 Discord Publisher ──> Orquestrador de envio multisservidor independente dos motores
└── 🛠️ Slash Commands    ──> /gta-setup, /gta-daily, /gta-weekly, /gta-news, /status
```

---

## 🚀 4. Como Iniciar e Testar no Windows

Execute o script:

```cmd
start.bat
```

No menu interativo:
1. **[1] Iniciar Bot**: Inicia o bot completo conectado ao Discord.
2. **[2] Testar Newswire**: Dispara a raspagem do Puppeteer e mede o consumo de RAM antes e após fechar o navegador.
3. **[3] Testar GTAO**: Coleta e exibe o JSON formatado dos sistemas diários e semanais.
4. **[4] Registrar Comandos**: Registra os Slash Commands globalmente na API do Discord.
