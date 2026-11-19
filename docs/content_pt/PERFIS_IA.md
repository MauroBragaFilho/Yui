# Perfis de IA e a rota privada

Os **perfis de IA** deixam o cérebro da Yui escolher, para cada tipo de tarefa, **como** chamar a IA: qual combo do [OmniRoute](GATEWAY.md), quantos tokens no máximo e qual a classificação de privacidade. Este guia explica a configuração, o **perfil privado** (que só liga depois de uma verificação), a rota de administração que pede a verificação, o script que testa o cabeçalho do OmniRoute e a lista de condições para ligar o privado.

> **Nada disto vem ligado.** Sem `YUI_IA_PERFIS` (ou o arquivo dele), a Yui segue **exatamente** como sempre. Os perfis só valem com o cérebro separado (`YUI_CEREBRO_EXTERNO=true`). O perfil privado só liga com a configuração completa **e** uma verificação válida da rota, e continua desligado até você declará-lo.

## 1. O que é um perfil

Um perfil é uma **modalidade de execução** da IA, não um agente: ele diz só o `modelo` (o id do combo que vai no campo `model` do pedido), o `maxTokens`, a `privacidade` e o `provedor` cadastrado na Yui. Não tem persona, memória, ferramentas nem permissão (um campo desses é recusado na configuração). O modelo escolhido **não concede permissão nenhuma**: o motor de políticas e o `guardToolCall` valem igual para qualquer perfil.

| Perfil | Para que serve |
|--------|----------------|
| `conversa` | A conversa principal e o `/yui` |
| `rapido` | Respostas curtas: o comentário do `/steam_jogo` e do `/converter_moeda`, o otimizador da busca (quando público) e a voz |
| `pesquisa` | A síntese da pesquisa na web |
| `raciocinio` | A conversa que sobe de nível por sinais simples (bloco ou erro de código, pedido de plano ou comparação, contexto longo) |
| `visao` | Mensagens com imagem |
| `privado` | Toda chamada **privada** (conversa privada do dono, memória pessoal, texto de anexo): só liga verificado, veja a seção 3 |
| `local` | Reservado para uma IA local no futuro; aceito na configuração, mas **nunca ativo** |

Quem decide o quê: o **cérebro** escolhe o **perfil** (regras simples, sem chamar IA); o **OmniRoute** escolhe o **provedor** dentro do combo. A Yui não tem um segundo roteador: cada chamada por perfil é **uma** chamada ao OmniRoute.

## 2. Configuração

`YUI_IA_PERFIS` recebe o JSON dos perfis; `YUI_IA_PERFIS_ARQUIVO` aponta para um arquivo com o mesmo JSON (a variável vence o arquivo, perfil por perfil; o arquivo trocado é relido sozinho). As duas estão na [tabela de variáveis](ENVIRONMENT.md#perfis-de-ia-e-o-omniroute-etapa-9-só-local-só-com-provedores-falsos-nos-testes), junto com o intervalo da sonda e o tempo limite da chamada.

Cada perfil tem:

| Campo | O que é |
|-------|---------|
| `modelo` | O id do combo (ou modelo) que vai no campo `model`. **Obrigatório.** Nunca `auto/chaos` (qualquer modelo com "chaos" é recusado) |
| `maxTokens` | De 64 a 8192; o efetivo é o menor entre este valor, a capacidade conhecida do provedor e o teto global, e **nunca passa de 4096** |
| `privacidade` | **Explícita:** `geral` (todos os perfis, menos o `privado`) ou `privada` (só o `privado`) |
| `provedor` | O id de um provedor cadastrado na Yui (Admin, IA, ou `YUI_GATEWAY_CUSTOM`); padrão `omniroute` |
| `habilitado` | `false` desliga o perfil de propósito |
| `chaveVinculada`, `provedoresPermitidos`, `decisao` | **Só no `privado`**, veja abaixo |

Exemplo de perfis gerais (os combos `auto`, `auto/fast` e `auto/smart` são os virtuais do OmniRoute; confira no seu OmniRoute antes de usar):

```json
{
  "conversa":   { "modelo": "auto",       "maxTokens": 1024, "privacidade": "geral", "provedor": "omniroute" },
  "rapido":     { "modelo": "auto/fast",  "maxTokens": 256,  "privacidade": "geral", "provedor": "omniroute" },
  "pesquisa":   { "modelo": "auto/smart", "maxTokens": 2048, "privacidade": "geral", "provedor": "omniroute" },
  "raciocinio": { "modelo": "auto/smart", "maxTokens": 4096, "privacidade": "geral", "provedor": "omniroute" }
}
```

Exemplo do **perfil privado**. Os `provedoresPermitidos` são os **apelidos** que o OmniRoute devolve no cabeçalho de decisão (o mesmo do `X-OmniRoute-Provider`), **não** o id completo do provedor; a `decisao` é a definição estrita do formato real do cabeçalho:

```json
{
  "privado": {
    "modelo": "<combo só de provedores autenticados>",
    "maxTokens": 1024,
    "privacidade": "privada",
    "provedor": "omniroute-privado",
    "chaveVinculada": true,
    "provedoresPermitidos": ["<apelido 1>", "<apelido 2>"],
    "decisao": { "formato": "pares", "campoProvedor": "provider" }
  }
}
```

- `provedor: "omniroute-privado"` é um **segundo cadastro** do OmniRoute na Yui (por exemplo, pela aba Admin, IA, ou no `YUI_GATEWAY_CUSTOM`), **não anônimo** (com a opção "Sem conversas pessoais" desligada) e com a **chave vinculada ao combo privado**. O provedor `omniroute` do modelo pronto é anônimo e **nunca** serve ao privado.
- `chaveVinculada: true` é a sua declaração de que essa chave só enxerga o combo privado no OmniRoute.
- O modelo do privado **nunca** é um combo virtual (`auto`, `auto/...`): eles misturam provedores anônimos.
- `decisao` vale `{ "formato": "pares", "campoProvedor": "provider" }` para o cabeçalho real do OmniRoute 3.8.52, que tem a forma `strategy=<nome ou single>; provider=<apelido>; latency_ms=<n>`. Sem a `decisao` o perfil privado **não habilita**.

Para **deixar o privado desligado**, não o declare (ou use `"habilitado": false`): a conversa privada segue como sempre. Declarado mas incompleto, ou ainda não verificado, ele **fecha** a conversa privada com uma mensagem curta, em vez de cair numa rota pública.

## 3. A rota privada: estados, sonda e bloqueio

O perfil privado só envia uma conversa quando **as duas** coisas valem:

1. **Configuração completa:** privacidade `privada`, `chaveVinculada: true`, `provedoresPermitidos`, a `decisao`, e o provedor da Yui cadastrado como **não anônimo** e com chave.
2. **Rota verificada por uma sonda:** uma chamada **sem nenhum conteúdo privado** (uma frase fixa), pelo **mesmo combo e a mesma chave** do perfil. O cabeçalho `X-OmniRoute-Decision` da resposta é lido por um leitor **estrito** (só o formato declarado em `decisao`) e tem de nomear **um** provedor da lista `provedoresPermitidos`.

O estado da rota é sempre um destes (o mesmo vocabulário do diagnóstico e da rota de administração):

| Estado | Significa |
|--------|-----------|
| `desligada` | O perfil privado não foi declarado |
| `incompleta` | Falta algo na configuração (o motivo diz o quê); nada sai |
| `nao-verificada` | Configuração completa, ainda sem sonda válida; a conversa privada fica fechada |
| `validada` | A sonda foi válida: a conversa privada pode usar a rota |
| `nao-validada` | A última sonda falhou (cabeçalho ausente, ilegível, provedor fora da lista, erro de rede ou do servidor...); fechada |
| `bloqueada` | Uma chamada **real** violou a regra (veja abaixo); fechada até uma nova sonda **válida** |

**Em cada chamada privada real**, cabeçalho ausente, inválido, em formato desconhecido, com o campo repetido ou com um provedor fora da lista significa: a resposta **não é entregue**, a rota passa a `bloqueada`, o dono recebe um aviso (no máximo um por hora) e a auditoria registra (`ia.rota_privada_bloqueada`, só o motivo e o provedor citado). Uma falha de rede, de cota (429) ou do servidor (500) fecha **aquela** chamada, mas **não** bloqueia a rota e nunca desvia a conversa para outra rota.

**Limite honesto:** quando a violação é detectada, a resposta daquele pedido já saiu para o provedor que o OmniRoute escolheu, e isso não se desfaz. A Yui descarta a resposta, bloqueia a rota e avisa; a sonda e a lista de apelidos conferida existem para reduzir a chance de isso acontecer.

**A sonda** roda: na subida do cérebro (em segundo plano), quando o dono pede (seção 4) e **sozinha a cada 5 minutos** enquanto a rota não está verificada (`YUI_IA_SONDA_INTERVALO_S`; `0` desliga as sozinhas). Depois de 12 falhas seguidas (`YUI_IA_SONDA_MAX_TENTATIVAS`) as sondas sozinhas **pausam**; só um pedido de propósito, uma configuração nova ou um reinício as retoma. Uma rota `bloqueada` **nunca** é sondada sozinha. Nenhum estado sobrevive a um reinício (a nova sonda decide), e mudar a configuração, o endereço ou a chave do provedor volta a rota para `nao-verificada`.

## 4. Pedir a nova verificação (rota de administração)

`POST /v1/admin/ia/rota-privada/verificar` com `{"confirm": true}`, só o dono (detalhes na [API](YUI_API.md)). O pedido **só pede**: nunca desbloqueia direto. A Yui faz uma sonda e **só uma sonda válida** libera a rota; se a sonda falha, a rota fica como estava (uma rota bloqueada continua bloqueada).

- **Resposta:** `{ ok, estado, motivo, liberada, sondaEnviada, mensagem }`, só com palavras fixas (`estado` é um dos seis acima; `motivo` é uma palavra fixa ou `null`). Nunca traz chave, cabeçalho, nome do combo, endereço nem conteúdo.
- **Limite de repetição:** 3 pedidos a cada 10 minutos (a sonda é uma chamada paga ao combo); depois disso, `429` sem sonda. Sem o perfil privado configurado, ou com a configuração incompleta, o pedido não gasta nada e não conta no limite.
- **Auditoria:** `admin.ia.rota_privada.verificar` (e `admin.ia.rota_privada.recusado` quando o limite barra), só com o estado e o motivo.
- Membro recebe `403`; sem `confirm: true` (o booleano), `400`.

## 5. Testar o cabeçalho de verdade (script)

Antes de ligar o privado, confira **num OmniRoute de verdade**, com **um combo e uma chave de teste**, o que o cabeçalho diz. O script `scripts/testar-cabecalho-omniroute.mjs` roda no computador onde o OmniRoute está (Node, sem instalar nada), faz **uma chamada mínima** (sem streaming, 8 tokens, a frase fixa "Responda apenas: ok", nenhum conteúdo privado) e mostra o que a Yui leria. Não altera nada no OmniRoute nem na Yui.

```powershell
# PowerShell
$env:OMNIROUTE_KEY = '<a chave de teste>'
node scripts/testar-cabecalho-omniroute.mjs --modelo <combo-de-teste> --permitidos <apelido1>,<apelido2> --repetir 5
```

```bash
# Bash
OMNIROUTE_KEY='<a chave de teste>' node scripts/testar-cabecalho-omniroute.mjs --modelo <combo-de-teste>
```

| Argumento | O que faz |
|-----------|-----------|
| `--modelo` | O id do combo que vai no campo `model`. Obrigatório |
| `--url` | O endereço do OmniRoute (padrão `http://127.0.0.1:20128`; aceita com ou sem `/v1`; sem usuário, senha nem parâmetros) |
| `--permitidos` | Os apelidos que o perfil privado vai permitir (opcional). Se dado, o apelido lido é conferido contra a lista |
| `--repetir N` | N chamadas seguidas (1 a 20), para ver se o provedor **muda** num combo com fallback |
| `--timeout S` | O tempo máximo de cada chamada, em segundos (0,5 a 120; padrão 30) |
| `--ajuda` | O texto de ajuda |

**A chave vem só da variável `OMNIROUTE_KEY`**: nunca por argumento (ficaria no histórico do terminal; um argumento desses é recusado) e **nunca é impressa**. A saída inteira passa por um filtro que apaga a chave e qualquer coisa com cara de segredo, e o corpo da resposta do servidor nunca é mostrado.

**O que aparece** em cada chamada: o status HTTP; o cabeçalho `X-OmniRoute-Decision` (só estratégia, apelido e latência); o **apelido do provedor lido pelo leitor estrito da Yui** (a mesma definição `pares` + `provider` da seção 2); a estratégia; o `X-OmniRoute-Provider`, se vier (com um aviso se discordar); e um **veredito** em palavras claras, como "o cabeçalho nomeia UM provedor" ou o que faltou. Com `--repetir`, um resumo diz se o provedor mudou entre as chamadas.

| Código de saída | Significa |
|-----------------|-----------|
| `0` | O cabeçalho nomeia **um** provedor (e, com `--permitidos`, ele está na lista) |
| `2` | Uso errado (argumento inválido ou faltando) |
| `3` | `OMNIROUTE_KEY` não definida (ou inválida) |
| `4` | Sem resposta do servidor (conexão recusada, tempo esgotado, erro de rede) |
| `5` | O servidor respondeu com erro HTTP, ou com um corpo que não é uma resposta de chat |
| `6` | O cabeçalho `X-OmniRoute-Decision` não veio |
| `7` | O cabeçalho veio, mas a Yui não consegue ler dele o nome de **um** provedor |
| `8` | O provedor lido não está na lista de `--permitidos` |

Com `--repetir`, vale o primeiro código diferente de zero. Um `0` é um teste do **formato**: as outras condições para ligar o privado estão na lista abaixo.

## 6. Condições para ligar o perfil privado

Só declare o `privado` quando **todas** estas condições valerem:

1. **Um combo só de provedores autenticados** (com conta ou chave própria) **e que não usem o conteúdo para treino** (confira os termos de cada um). Nenhum combo virtual `auto...`, nenhum provedor anônimo, nenhuma chave gratuita compartilhada: sem uma rota autenticada que não use o conteúdo para treino, o privado fica desligado.
2. **A chave vinculada ao combo:** uma chave do OmniRoute que só enxerga esse combo, cadastrada na Yui como um provedor **não anônimo** (e `chaveVinculada: true` no perfil como declaração disso).
3. **Os apelidos conferidos pelo teste real:** `provedoresPermitidos` com os **apelidos que o OmniRoute realmente emite** (rode o script, de preferência com `--repetir`), cobrindo todos os provedores do combo, e nada além deles.
4. **O cabeçalho confiável no seu OmniRoute:** o script mostra o `provider` nomeando um provedor em todas as chamadas e, num combo com fallback, o provedor **que de fato respondeu** (e não só o primeiro da fila). Se o OmniRoute não oferecer um cabeçalho com um provedor único e estável, o privado não pode ser ligado; a alternativa é um combo com **um único provedor**, com a lista de um nome só.
5. **A `decisao` declarada** (`pares` + `provider`) e o provedor da Yui cadastrado com a chave certa.
6. **Uma sonda válida:** depois de configurar, a rota precisa chegar a `validada` (na subida do cérebro, ou pedindo a verificação pela rota de administração, seção 4). Enquanto estiver `nao-verificada`, `nao-validada` ou `bloqueada`, a conversa privada fica fechada.
7. **Saber o limite:** a resposta de uma chamada que viola a regra já saiu para o provedor antes de ser descartada. A lista deve ter só provedores que você aceitaria receber essa conversa.
8. **Ensaiar com a chave e o combo de teste** antes de usar os de verdade, e só então declarar o perfil.

## 7. O que o diagnóstico mostra

`GET /v1/admin/diagnostico` traz `perfisDeIa` (os perfis, os contadores, as últimas chamadas com o combo pedido, o provedor que respondeu, a estratégia, o fallback, o limite de tokens, a latência e o resultado, e o estado da rota privada com as falhas recentes das sondas) e `motorAgente`. **Nunca** leva chave, cabeçalho, prompt nem conteúdo. Rota privada `bloqueada` marca o estado geral como `problema`; incompleta, não verificada ou não validada, como `atencao`.

Para os testes, veja `npm run test:rotaprivadaadmin` e `npm run test:scriptcabecalho` no [guia de testes](../../README_TESTES.md).

## 8. IA local para a conversa privada

Há um segundo jeito de manter a conversa privada longe da nuvem, **independente** do perfil `privado` das seções 2 a 6: um **modelo pequeno num computador seu** (LM Studio, Ollama, llama.cpp ou outro servidor compatível com a API da OpenAI, por exemplo um modelo `granite-4.0-micro` alcançado pela rede privada ou pelo Tailscale). Ele vem **desligado** e as chaves estão na [tabela de variáveis](ENVIRONMENT.md) (`YUI_IA_LOCAL_PRIVADA` e as outras que a acompanham).

**Como funciona.** Toda chamada que a Yui já marca como privada (a conversa do dono em DM ou em canal privado, a que leva memória pessoal, dados do Google ou texto de anexo) tenta **primeiro** esse modelo. Se o computador estiver desligado, dormindo ou lento, ou se a resposta não servir, vale o **fallback** (`YUI_IA_LOCAL_PRIVADA_FALLBACK`):

| Valor | O que acontece quando o local não atende |
|-------|------------------------------------------|
| `fechar` (**padrão do código**) | A conversa privada **não vai a nenhum provedor da cadeia**. A Yui responde uma frase fixa curta ("rota privada de IA fora do ar", ou "mensagem grande demais para o modelo local") e avisa o dono (no máximo a cada 30 minutos). Nada do conteúdo sai da Yui. Chamadas privadas ficam sem IA enquanto o computador não voltar |
| `nuvem` | **A mesma chamada** segue pela cadeia de hoje, sem erro visível e sem repetir nada para a pessoa. **Risco:** o conteúdo privado (a conversa, a memória pessoal, dados do Google, texto de anexo) chega aos provedores de nuvem da cadeia sempre que o computador falhar. Isto **não é privacidade total**: só tira da nuvem as conversas que o computador conseguir atender |

Chamada **pública** nunca passa por ali (nem é fechada por isso: segue a cadeia normal). Um valor desconhecido na chave vale `fechar`, e uma rota ligada com o endereço recusado também **fecha** (nunca manda a conversa à nuvem por causa de um erro de configuração), salvo com `nuvem`.

**O computador com o modelo é uma dependência externa.** A Yui não presume que ele está no ar: ele pode estar desligado, dormindo, sem rede ou lento. Por isso a conexão tem prazo curto (3 s), a resposta tem prazo (`YUI_IA_LOCAL_PRIVADA_TIMEOUT_S`), o disjuntor segura o local depois de falhas seguidas e o diagnóstico mostra o estado. Com `fechar`, quem quiser conversa privada sempre disponível precisa manter o computador ligado (ou escolher `nuvem`, aceitando o risco acima).

- **Quem decide que é privada** é o cérebro, a partir dos fatos da conversa (escopo pessoal da memória, texto de anexo), nunca por uma afirmação do bot. Memória pública no prompt não torna a chamada privada.
- **Onde entra:** à frente da cadeia de provedores (um provedor "local privado" que só participa de chamada privada) e, no app e no cérebro separado, antes do perfil e do backend. É um passo à parte: não liga, não desliga e não altera o perfil `privado` do OmniRoute nem o perfil `local` reservado (que continuam como estão: o `privado` com a sua verificação de cabeçalho própria, o `local` recusado).
- **Quando o local não atende:** conexão recusada, tempo esgotado, erro HTTP, resposta vazia, resposta só com "raciocínio", JSON de ferramenta quebrado, pedido que não cabe no modelo ou rota em descanso (o que vem depois depende do fallback acima). A resposta local só é entregue **inteira e válida**.
- **Disjuntor:** depois de 3 falhas seguidas, o local descansa por um tempo crescente (30 s, 1 min, 2 min, 4 min, 8 min, no máximo 10 min). Passado o descanso, uma sondagem leve (`GET /v1/models`, em segundo plano) o reabilita ou estende o descanso. A conversa nunca espera o computador.
- **Contexto pequeno:** o teto é de 4096 tokens (pedido mais resposta). Se não couber, a Yui manda menos histórico, depois a conversa sem a memória; se ainda não couber, vai direto para a cadeia. O modelo **não recebe ferramentas nativas**: o fluxo de ferramentas por JSON em texto continua valendo, com uma lista curta das ferramentas (o JSON passa pelo mesmo leitor da fila).
- **Endereço:** validado ao ler a chave. Só IP da rede local, loopback, Tailscale ou nome `.ts.net`/`.local`, sem usuário, senha nem parâmetros, sem seguir redirecionamento e sem enviar chave de API. Um nome `.ts.net` ou `.local` depende da resolução de nomes da sua rede: prefira o IP se tiver dúvida. O conteúdo privado nunca vai a um endereço que não seja o configurado.
- **O que fica registrado:** só metadados. O log diz qual rota respondeu (`local-privada` ou `cadeia`), a latência, o motivo da queda em palavra fixa e o **tipo** do endereço, nunca o conteúdo nem o endereço. Com a rota ligada, `GET /v1/admin/diagnostico` (e a saúde do cérebro) trazem `iaLocalPrivada`: estado (`ativa`, `em-descanso`, `sondando` ou `url-invalida`), o fallback em vigor, quantas respostas vieram do local, quantas caíram para a cadeia, quantas foram fechadas (por motivo) e o descanso restante; o computador em descanso aparece como atenção e o endereço recusado como problema. Desligada, nada disso aparece e o diagnóstico é o de antes.

Para o teste, veja `npm run test:ialocalprivada` no [guia de testes](../../README_TESTES.md).
