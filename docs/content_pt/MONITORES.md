# Monitores de busca e alertas por evento

A Yui costuma agir quando alguém pede. Os **monitores** e os **alertas por evento** são os primeiros passos para ela avisar sozinha, dentro de limites bem fechados. Os dois nascem **desligados** (`YUI_MONITORES=false` e `YUI_ALERTAS_EVENTOS=false`) e, desligados, nada muda: não há laço, não há arquivo, não há rota ligada.

> Os monitores existem **só com o cérebro separado** (`YUI_CEREBRO_EXTERNO=true`, veja [Operação](OPERACAO.md)): o laço roda no processo do cérebro e o aviso sai pelo bot. No processo único eles não existem.

## 1. Os monitores: "me avisa quando..."

O **dono** pede em conversa, em português, por uma mensagem dirigida à Yui (DM, menção, o nome dela ou resposta a ela). Quem lê o pedido é o **código**, não o modelo de IA.

| Você diz | O que acontece |
|---|---|
| `me avisa quando sair o patch 1.5 do jogo X` | cria o monitor e confirma de volta em uma frase curta, com o número |
| `me avisa se aparecer notícia de Y por 7 dias` | o mesmo, com prazo de 7 dias |
| `monitora as notícias do GTA 6`, `fica de olho no preço do Hades por 10 dias`, `cria um monitor para ...` | o mesmo |
| `meus monitores` / `lista meus monitores` | lista (número, consulta, estado, próxima checagem, até quando vale) |
| `cancela o monitor 2` | encerra o monitor 2 |
| `pausa o monitor 3` / `retoma o monitor 3` | pausa e volta |

O prazo vem de `por 7 dias`, `durante 2 semanas`, `pelos próximos 10 dias`, `por um mês` ou `por 12 horas`. **Sem prazo, vale 14 dias; o máximo é 60 dias** (acima disso a Yui limita e avisa). Frases com horário de lembrete (`em 7 dias`, `daqui a 3 dias`, `amanhã`) continuam sendo **lembretes**: a pré-rota de lembretes vem antes e fica com elas.

### Limites

- No máximo **5 monitores ativos** (os pausados e os encerrados não contam; retomar também respeita o limite).
- A mesma consulta não vira dois monitores.
- Intervalo entre as checagens: **6 horas** por padrão e **no mínimo 60 minutos** (o pedido por conversa não muda o intervalo).
- Um monitor encerrado fica na lista por 7 dias e depois sai do arquivo.

### Como funciona

1. A cada `YUI_MONITORES_MS` (padrão 10 min) o cérebro olha quais monitores estão devidos.
2. Para cada um, busca pela **porta central de pesquisa** (a mesma da conversa: cota por hora e por mês, falha fechada, diário), como busca **privada** (nunca compartilhada nem reaproveitada) e com uma identidade própria que não gasta a cota de ninguém.
3. Calcula a **assinatura** dos 3 primeiros resultados (um hash de título e endereço normalizados) e compara com a anterior.
4. **A primeira checagem só guarda a referência e nunca avisa.** Assinatura igual não avisa. Assinatura diferente manda **uma** mensagem privada ao dono: `Achei novidade sobre <consulta>: <título do 1º resultado> (<fonte>)`.
5. O monitor que passou do prazo **encerra sozinho** e avisa **uma vez**.
6. Um reinício do cérebro **retoma** de onde estava, sem repetir aviso.

### O texto da web é dado, nunca instrução

Do 1º resultado só entram o **título** (limpo: uma linha, sem menção, sem link, sem formatação, no máximo 120 caracteres) e o **domínio**. O trecho do resultado e qualquer texto que pareça uma ordem nunca chegam a ninguém. **O texto dos resultados nunca é guardado**: o arquivo `monitores.json` tem a consulta que a pessoa pediu e, da busca, só a assinatura (o hash).

O estado fica em `<DATABASE_DIR>/monitores.json`. O **dono é o cérebro**: só o processo do cérebro o abre e grava (o bot nunca), com gravação atômica (arquivo temporário e troca), no mesmo padrão do arquivo dos lembretes. Se o disco não aceitar a gravação, a mudança não vale: a Yui diz que não conseguiu anotar e nenhum aviso sai sem o registro no disco.

### Cota de busca: a conversa nunca perde a vez

Os monitores têm uma **reserva própria** (`YUI_MONITORES_RESERVA`, padrão 10% do limite por hora): enquanto restar menos que isso, só a conversa busca. Cota cheia, limite por hora, cota mensal perto do fim ou a porta de saída fechada (sem o dono da cota ou sem o registro em disco) **adiam a passada sem custo e sem erro**: nada é gasto e o monitor continua devido. Uma busca que falha (rede, buscador fora) não muda a referência e é tentada de novo em 30 minutos; nunca vira aviso.

### Entrega do aviso: uma vez, sem se perder em silêncio

O aviso sai pelo mesmo caminho dos lembretes: uma DM do bot ao dono, com chave de idempotência por monitor e assinatura, estados (`pendente`, `enviando`, `enviado`, `incerto`) e reconciliação (nonce do Discord e histórico da DM). Se o bot cair no meio, o aviso fica `enviando` (visível na lista) e, na volta, a Yui confere se a mensagem saiu antes de mandar. Quando não dá para provar, o aviso fica `incerto` e **visível**; ela tenta confirmar a cada 10 minutos, **nunca reenvia às cegas**, e depois de 24 horas descarta com registro na auditoria. Depois de um reinício o aviso de novidade sai sem o título (o título nunca foi guardado): diz só que houve novidade.

### Segurança

- **Só o dono** cria, lista, pausa, retoma e cancela. Para qualquer outra pessoa a frase segue para a conversa de sempre, e nada é criado.
- **Só mensagem dirigida à Yui**: conversa espontânea, voz e pedidos em nome de terceiros não criam monitor.
- O que muda estado passa pelo **motor de políticas** (a mesma ação dos lembretes do painel). Em `observe` só registra; em `enforce`, o dono num canal público é tratado como membro e não cria (em conversa privada funciona).
- A auditoria guarda o número do monitor e nunca a consulta; o log não recebe a consulta nem texto de resultado.
- A passada respeita o guarda das tarefas automáticas: `POLICY_JOB_AUTONOMY=DENY` pausa os monitores.

### O que os monitores NÃO fazem

- Não agem sozinhos além de **avisar**: não abrem páginas, não resumem, não respondem por ninguém.
- Não guardam resultados, páginas nem trechos.
- Não funcionam no processo único, nem para outras pessoas, nem por voz, nem pelo comando `/yui` (o pedido vale por mensagem).
- Não avisam na primeira checagem nem por causa do que mudou enquanto estavam pausados.
- Não fazem busca fora da cota central.

### Painel e API (só o dono)

| Rota | O que faz |
|---|---|
| `GET /v1/admin/monitores` | Lista: `id`, `consulta` (curta), `estado` (`ativo`, `pausado` ou `encerrado`), `proximaChecagem`, `ate`, `avisos` e, se há um aviso em andamento, `entrega` (`pendente`, `enviando` ou `incerto`). Também traz `resumo` (só contadores). Com a chave desligada, devolve `{ "ligado": false, "monitores": [] }` |
| `DELETE /v1/admin/monitores/:id` | Cancela o monitor (`404` se não existe, já está encerrado ou a chave está desligada). Fica na auditoria como `admin.monitor.remove`, sem a consulta |

Detalhes e o formato das respostas estão em [Yui API](YUI_API.md).

## 2. Alertas por evento

Verificações leves e periódicas, a cada `YUI_ALERTAS_EVENTOS_MS` (padrão 5 min), que avisam o **dono** com o mesmo mecanismo dos avisos de erro (`alertOwner`): mensagem curta, com o intervalo de repetição (`YUI_ALERTS_COOLDOWN_MINUTES`) e o limite por hora que ele já tem. Nada novo vai para mais ninguém. Sem `YUI_ALERTAS_EVENTOS=true`, nada roda; com `YUI_ALERTS=false` (que desliga todos os avisos automáticos) a conferência roda, mas nenhuma mensagem sai.

| Evento | Quando avisa | Chave |
|---|---|---|
| **Disco** | o espaço livre onde ficam os dados fica abaixo do limite | `YUI_ALERTA_DISCO_GB` (padrão 5; `0` desliga) |
| **Memória** | a RAM livre fica abaixo do limite **por vários minutos seguidos** (um pico curto não avisa) | `YUI_ALERTA_RAM_MB` (padrão 400; `0` desliga) e `YUI_ALERTA_RAM_MIN` (padrão 5) |
| **Internet** | 3 sondas seguidas falham contra o alvo configurado (conexão TCP, sem enviar nada); quando volta, um segundo aviso curto | `YUI_ALERTA_INTERNET_ALVO` (`host` ou `host:porta`; **vazio desliga**, que é o padrão) |
| **Supervisor** | o supervisor religou o bot ou o cérebro (lê `logs/supervisor-estado.json` em modo só leitura; o aviso leva só o nome do processo e a contagem) | — |

Em teste (`NODE_ENV=test`) um alvo de internet fora do próprio computador não é sondado.

## 3. Chaves

Todas estão em [Variáveis de ambiente](ENVIRONMENT.md): `YUI_MONITORES`, `YUI_MONITORES_MS`, `YUI_MONITORES_RESERVA`, `YUI_ALERTAS_EVENTOS`, `YUI_ALERTAS_EVENTOS_MS`, `YUI_ALERTA_DISCO_GB`, `YUI_ALERTA_RAM_MB`, `YUI_ALERTA_RAM_MIN` e `YUI_ALERTA_INTERNET_ALVO`.

## 4. Testes

`npm run test:monitoresunidade` (o pedido, a assinatura, o estado, a pré-rota, a execução com o buscador e o relógio falsos, os alertas e a API) e `npm run test:monitores` (cérebro e bot de verdade, com Discord, IA e busca falsos). A descrição de cada suíte está no `README_TESTES.md`.
