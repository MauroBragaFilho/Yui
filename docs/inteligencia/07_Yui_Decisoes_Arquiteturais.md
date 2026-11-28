# 07. Yui: decisões arquiteturais (ADR)

**Status:** **Proposta** = aguardando o OK do dono; **Aceita** = já decidida pelo dono.

| ID | Decisão | Status |
|---|---|---|
| ADR-01 | Monólito modular: Core, Policy, Tasks e Memory dentro do cérebro; nenhum processo novo sem medição | Proposta |
| ADR-02 | Fase inicial 100% no ASUS; Neon só backup cifrado; Dell excluído | **Aceita** (chat de 28/11), mas contradiz a spec P4/§7 → **C1**: revisar a spec |
| ADR-03 | Toda inferência de IA na nuvem (4 GB de RAM); modelos locais pausados | Proposta (coerente com a decisão de 10/11 e o foco na nuvem) |
| ADR-04 | Interpretador = perfil do AI Manager existente, sem novo gerente (diretrizes §9) | Proposta |
| ADR-05 | Pré-rotas por código continuam como caminho rápido e reserva | Proposta |
| ADR-06 | Permissão aplicada por código em 7 classes; `enforce` gradual por classe | Proposta |
| ADR-07 | Bancos novos em `node:sqlite` com WAL | Proposta |
| ADR-08 | Cache offline nos clientes, não no Neon → **C4** | Proposta |
| ADR-09 | Critério "degradação se o ASUS cair" vira "restauração documentada, meta de 4 h" → **C2** | Proposta |
| ADR-10 | Área isolada = worktree + usuário Windows sem privilégio (Home não tem Sandbox), ou o Neon se permitido | Proposta / **A DECIDIR** |
| ADR-11 | Custo de nuvem: só camadas gratuitas; nunca ligar provedor pago sozinha | Proposta |
| ADR-12 | O backup continua também no GitHub privado (cópia fora de casa), além do Neon | Proposta / **A DECIDIR** |

## Contradições registradas (regra 8 do questionário)

- **C1. Neon.** A spec P4/§7 diz "parte do núcleo no Neon". A decisão posterior diz "só backup". A spec precisa de uma revisão formal.
- **C2. Critério de degradação com ASUS único.** Ver ADR-09.
- **C3. Windows.** Foi informado Pro; o medido é Home Single Language 22H2.
- **C4. Cache offline sem segundo nó.** Ver ADR-08.
- **C5. Celular principal.** A spec cita o S20 FE; os testes atuais usam o A51.

## Respostas do dono (28/11/2026)

1. **Windows:** manter o Home (C3 resolvida).
2. **Hardware:** RAM e SSD ficam para o futuro; o projeto segue com 4 GB e HDD.
3. **Backup:** GitHub **e** Neon (ADR-12 aceita).
4. **Roteador de IA:** segue o OmniRoute; o dono avalia migrar para o **FreeLLMAPI**. Por isso o interpretador fala com o AI Manager e não com o OmniRoute diretamente, para a troca não afetar a inteligência.
5. **Desenvolvimento:** o Neon pode ser a área de desenvolvimento isolado (ADR-10 aceita), em tarefa de baixa prioridade que não atrapalhe jogo, live ou edição.
6. **Restauração:** meta de **5 minutos**. Proposta técnica para cumprir:
   - **reserva fria no Neon**: a Yui fica instalada e parada, e o backup chega sempre atualizado;
   - a reserva só sobe com o ASUS confirmadamente fora, para não haver dois bots com o mesmo token;
   - o acionamento é **manual** no começo.
   - Isso não é "parte do núcleo no Neon": não roda nada lá em operação normal.
7. **Ordem:** **Fases A e B autorizadas.**

**Observação do dono sobre C1:** a ideia original era rodar parte no Neon, mas ficaria complicado com jogo, live e edição. A decisão "Neon só backup + desenvolvimento + reserva fria" fica mantida. A spec v2.0 deve ser revisada em P4/§7.

## Decisões pendentes do dono (lista original)

1. Windows: ESU, upgrade para Pro ou outra saída.
2. Hardware: 8 GB de RAM e SSD no ASUS.
3. Backup: GitHub + Neon, ou só Neon.
4. OmniRoute: onde roda hoje e se continua como roteador principal.
5. Neon como área de desenvolvimento isolado.
6. Meta de restauração (4 h?).
7. Ordem: Fase A antes do restante.
