# Diagnóstico Técnico: Falha HTTP 403 do Reddit no Weekly

Este relatório detalha a causa da falha HTTP 403 (Forbidden) observada nas requisições ao Reddit no subsistema Weekly do GTA Online, a solução arquitetural já adotada e as recomendações de mitigação.

---

## 1. Causa-Raiz Técnica do Erro 403

### A. Política Anti-Scraping e Mudança de API do Reddit (2023-2026)
1. **Bloqueio no WAF / Cloudflare do Reddit:**
   - O Reddit bloqueia sistematicamente chamadas diretas via HTTP (`fetch`, `curl`, `axios`) para endpoints `.json` públicos (`https://www.reddit.com/r/gtaonline/search.json`), retornando:
     ```
     HTTP 403 Forbidden: "Blocked by network security" / Cloudflare Bot Management
     ```
2. **Inviabilidade do Bypass por Cookies Puros:**
   - O método legado tentava lançar o Puppeteer, visitar `reddit.com`, salvar os cookies em `reddit-cookies-cache.json` e reaproveitá-los em requisições `rawFetch()`.
   - **Por que falha:** O Cloudflare e os mecanismos de segurança do Reddit validam o fingerprint TLS (JA3/JA4), cabeçalhos HTTP/2 e execução real de scripts do cliente. Usar apenas a string de Cookie em um `fetch()` nativo do Node.js é imediatamente bloqueado com **HTTP 403**.

---

## 2. Solução Implementada e Ativa na Yui

Para contornar o bloqueio de forma 100% legítima e sem violar termos de uso, a Yui implementou a estratégia **Dual-Mode** com prioridade no navegador do sistema:

### A. Modo Padrão: Feed Atom/RSS via Navegador Real (`reddit-browser.js`)
- Em vez de chamar o endpoint JSON bloqueado, o módulo `reddit-browser.js` usa o Puppeteer conectado ao Chrome/Edge instalado no sistema para acessar:
  ```
  https://www.reddit.com/r/gtaonline/search.rss?q=title:"Weekly Bonuses and Discounts"&sort=new
  ```
- **Por que funciona:** O feed RSS/Atom é entregue diretamente pelo Reddit para navegadores reais sem ser barrado pelo Cloudflare.
- O parser do `reddit-browser.js` extrai o HTML do Atom, converte de volta para Markdown estruturado e normaliza o objeto exatamente no mesmo schema do JSON original (`title`, `selftext`, `permalink`, `createdUtc`).
- O navegador é aberto sob demanda apenas no momento da checagem semanal e fechado imediatamente em seguida.

### B. Fallback Seguro
Se o Puppeteer falhar em instanciar o navegador local:
1. Tenta a rota de cookies armazenados com uma renovação transparente.
2. Caso o Reddit continue respondendo 403, a Yui usa primeiro o **GTABase** (página de terceiros com os mesmos dados estruturados; `gtabase.js`) e depois o **Rockstar Newswire** como reservas. O Newswire é o artigo semanal oficial, o artigo semanal oficial, escolhido por pontuação (`pickWeeklyArticle`: categoria GTA Online, mínimo de 4 pontos, até 10 dias, brinde do GTA+ penalizado), com cache de 6 h (`NEWSWIRE_CACHE_HOURS`).
3. Sem resposta de nenhuma fonte, usa a cópia da mesma semana; sem ela, o último semanal válido de outra semana, **com aviso** ao usuário.

> O scraper do GTAForums (`gtaForumsScraper.js`) continua no código, mas não faz parte desse fluxo (código morto).

### C. Achado recente
O feed RSS e a busca, antes entregues ao Chrome automatizado, passaram a devolver 403 também. Por isso o Newswire deixou de ser só alternativa teórica e virou a reserva que sustenta o semanal quando o Reddit bloqueia.

---

## 3. Recomendações e Boas Práticas

1. **Retirar `reddit-cookies-cache.json` do Git (R07):**
   - Como os cookies contêm token de sessão e expiram periodicamente, eles não devem ser versionados no repositório.
2. **Configuração Opcional de Navegador:**
   - No `.env`, pode-se definir `REDDIT_BROWSER_PATH` apontando para o binário do Chrome ou Edge caso o caminho padrão mude.
3. **API Oficial do Reddit (OAuth):**
   - Para ambientes em nuvem ou servidores headless sem interface gráfica onde o Puppeteer não possa rodar, a migração para a API de desenvolvedor oficial do Reddit com `REDDIT_CLIENT_ID` e `REDDIT_CLIENT_SECRET` é o caminho recomendado a longo prazo.
