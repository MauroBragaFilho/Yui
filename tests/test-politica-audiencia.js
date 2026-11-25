// Política de audiência (módulo puro): matriz completa, falha fechado, revalidação, ferramentas e auditoria sem texto. npm run test:audiencia
import assert from 'node:assert/strict';
import {
  decidirAudiencia, revalidar, ferramentaPermitida, eventoAuditoria, NIVEL, MOTIVO, INTERFACE, POLICY_VERSION,
} from '../src/core/politicaAudiencia.js';

const voz = (o = {}) => ({
  interface: INTERFACE.VOZ, chaveLigada: true, falanteVerificado: true, falanteEhDono: true, donoPresente: true, humanosNaCall: 1, dirigida: true, googleVoz: false, ferramentasVoz: false, ...o,
});

// 1) Texto: DM do dono = tudo como hoje; DM de outra pessoa e canal = público.
let d = decidirAudiencia({ interface: INTERFACE.DM, ehDono: true });
assert.equal(d.nivel, NIVEL.PRIVADO);
assert.equal(d.recursos.memoriaPessoal, true);
assert.equal(d.recursos.google, true);
d = decidirAudiencia({ interface: INTERFACE.DM, ehDono: false });
assert.equal(d.nivel, NIVEL.PUBLICO);
assert.equal(d.recursos.memoriaPessoal, false);
assert.equal(d.rebaixadaPor, MOTIVO.NAO_DONO);
d = decidirAudiencia({ interface: INTERFACE.CANAL, ehDono: true });
assert.equal(d.nivel, NIVEL.PUBLICO, 'o dono em canal público continua público');
assert.equal(d.recursos.memoriaPessoal, false);
assert.equal(d.recursos.google, false);

// 2) Voz: o caso privado (dono sozinho, verificado, chave ligada).
d = decidirAudiencia(voz());
assert.equal(d.nivel, NIVEL.PRIVADO);
assert.deepEqual(
  { m: d.recursos.memoriaPessoal, c: d.recursos.contextoPessoal, p: d.recursos.personaDono, fio: d.recursos.fioDM, g: d.recursos.google, f: d.recursos.ferramentas, cp: d.recursos.climaPesquisa },
  { m: true, c: true, p: true, fio: true, g: false, f: 'nenhuma', cp: 'tudo' },
  'Google e ferramentas por voz nascem fechados mesmo no privado',
);
d = decidirAudiencia(voz({ googleVoz: true, ferramentasVoz: true }));
assert.equal(d.recursos.google, true);
assert.equal(d.recursos.ferramentas, 'leitura');
d = decidirAudiencia(voz({ dirigida: false }));
assert.equal(d.nivel, NIVEL.PRIVADO);
assert.equal(d.recursos.climaPesquisa, 'nenhum', 'sem ser chamada, nem clima nem pesquisa');

// 3) Matriz completa por força bruta contra um oráculo independente (todas as combinações dos fatos de voz).
const valoresContagem = [null, undefined, -1, 0, 1, 2, 5, 1.5, '1', NaN];
let casos = 0;
for (const chaveLigada of [true, false, undefined]) {
  for (const falanteVerificado of [true, false, undefined]) {
    for (const falanteEhDono of [true, false, undefined]) {
      for (const donoPresente of [true, false, undefined]) {
        for (const humanosNaCall of valoresContagem) {
          for (const dirigida of [true, false]) {
            const f = voz({ chaveLigada, falanteVerificado, falanteEhDono, donoPresente, humanosNaCall, dirigida });
            const r = decidirAudiencia(f);
            const privadoEsperado = chaveLigada === true && falanteVerificado === true && falanteEhDono === true && donoPresente === true && humanosNaCall === 1;
            assert.equal(r.nivel === NIVEL.PRIVADO, privadoEsperado, JSON.stringify(f));
            if (!privadoEsperado) {
              assert.equal(r.recursos.memoriaPessoal, false, JSON.stringify(f));
              assert.equal(r.recursos.contextoPessoal, false);
              assert.equal(r.recursos.personaDono, false);
              assert.equal(r.recursos.fioDM, false);
              assert.equal(r.recursos.google, false);
              assert.equal(r.recursos.ferramentas, 'nenhuma');
              assert.notEqual(r.recursos.climaPesquisa, 'tudo');
              assert.equal(r.recursos.climaPesquisa, dirigida ? 'clima' : 'nenhum');
              assert.ok(r.rebaixadaPor, 'todo rebaixamento tem motivo');
            }
            casos += 1;
          }
        }
      }
    }
  }
}
assert.ok(casos > 1500);

// 4) Motivos específicos (a ordem das checagens é parte do contrato).
assert.equal(decidirAudiencia(voz({ chaveLigada: false })).rebaixadaPor, MOTIVO.CHAVE_DESLIGADA);
assert.equal(decidirAudiencia(voz({ humanosNaCall: null })).rebaixadaPor, MOTIVO.CONTAGEM_INDISPONIVEL);
assert.equal(decidirAudiencia(voz({ humanosNaCall: undefined })).rebaixadaPor, MOTIVO.CONTAGEM_INDISPONIVEL);
assert.equal(decidirAudiencia(voz({ falanteVerificado: false })).rebaixadaPor, MOTIVO.FALANTE_NAO_VERIFICADO);
assert.equal(decidirAudiencia(voz({ falanteEhDono: false })).rebaixadaPor, MOTIVO.FALANTE_NAO_DONO);
assert.equal(decidirAudiencia(voz({ donoPresente: false })).rebaixadaPor, MOTIVO.DONO_AUSENTE);
assert.equal(decidirAudiencia(voz({ humanosNaCall: 2 })).rebaixadaPor, MOTIVO.OUTROS_HUMANOS);
assert.equal(decidirAudiencia(voz({ humanosNaCall: 0 })).rebaixadaPor, MOTIVO.OUTROS_HUMANOS, 'zero humanos com o dono falando é incoerente: público');
// o dono reconhecido NÃO torna a conversa privada se há mais alguém (identidade ≠ audiência)
d = decidirAudiencia(voz({ humanosNaCall: 3 }));
assert.equal(d.nivel, NIVEL.PUBLICO);
assert.equal(d.speakerVerified, true);
assert.equal(d.recursos.memoriaPessoal, false);

// 5) Entrada sem forma (lixo): sempre público e sem lançar.
for (const lixo of [undefined, null, 0, 'voz', [], {}, { interface: 'telepatia' }]) {
  const r = decidirAudiencia(lixo);
  assert.equal(r.nivel, NIVEL.PUBLICO);
  assert.equal(r.recursos.memoriaPessoal, false);
  assert.equal(r.recursos.ferramentas, 'nenhuma');
}

// 6) Sem promoção dentro do turno: se o turno começou público, ninguém sair o torna privado.
d = decidirAudiencia(voz(), { nivelInicialDoTurno: NIVEL.PUBLICO });
assert.equal(d.nivel, NIVEL.PUBLICO);
assert.equal(d.rebaixadaPor, MOTIVO.SEM_PROMOCAO_NO_TURNO);
assert.equal(decidirAudiencia(voz(), { nivelInicialDoTurno: NIVEL.PRIVADO }).nivel, NIVEL.PRIVADO);

// 7) Revalidação: convidado entra no meio do turno privado -> invalida.
const inicial = decidirAudiencia(voz());
assert.equal(revalidar(inicial, voz()).mantem, true);
let r = revalidar(inicial, voz({ humanosNaCall: 2 }));
assert.equal(r.mantem, false);
assert.equal(r.decisao.nivel, NIVEL.PUBLICO);
assert.equal(r.motivo, MOTIVO.OUTROS_HUMANOS);
r = revalidar(inicial, voz({ humanosNaCall: null }));
assert.equal(r.mantem, false, 'a contagem falhou no meio: invalida');
assert.equal(r.motivo, MOTIVO.CONTAGEM_INDISPONIVEL);
r = revalidar(inicial, voz({ falanteVerificado: false }));
assert.equal(r.mantem, false);
r = revalidar(inicial, voz({ chaveLigada: false }));
assert.equal(r.mantem, false, 'a chave desligada no meio do turno invalida');
// turno público: o convidado sair não promove
const publica = decidirAudiencia(voz({ humanosNaCall: 2 }));
r = revalidar(publica, voz({ humanosNaCall: 1 }));
assert.equal(r.decisao.nivel, NIVEL.PUBLICO, 'sair alguém não torna o turno público em privado');

// 8) Ferramentas: deny by default no executor.
const lista = ['listar_lembretes', 'clima'];
const priv = decidirAudiencia(voz({ ferramentasVoz: true }));
assert.equal(ferramentaPermitida(priv, { nome: 'listar_lembretes', somenteLeitura: true, permitidas: lista }), true);
assert.equal(ferramentaPermitida(priv, { nome: 'listar_lembretes', somenteLeitura: false, permitidas: lista }), false, 'não é só leitura');
assert.equal(ferramentaPermitida(priv, { nome: 'criar_lembrete', somenteLeitura: true, permitidas: lista }), false, 'fora da lista fechada');
assert.equal(ferramentaPermitida(priv, { nome: 'listar_lembretes', somenteLeitura: true }), false, 'sem lista, nada');
assert.equal(ferramentaPermitida(decidirAudiencia(voz()), { nome: 'listar_lembretes', somenteLeitura: true, permitidas: lista }), false, 'chave de ferramentas desligada');
assert.equal(ferramentaPermitida(decidirAudiencia(voz({ humanosNaCall: 2, ferramentasVoz: true })), { nome: 'listar_lembretes', somenteLeitura: true, permitidas: lista }), false, 'público nunca');
assert.equal(ferramentaPermitida(null, { nome: 'x', somenteLeitura: true, permitidas: ['x'] }), false);
assert.equal(ferramentaPermitida(priv, { somenteLeitura: true, permitidas: lista }), false);
assert.equal(ferramentaPermitida(decidirAudiencia({ interface: INTERFACE.DM, ehDono: true }), { nome: 'qualquer' }), true, 'texto: as travas de sempre seguem');

// 9) Auditoria: campos da Liz, sem texto, sem nome, sem id.
const ev = eventoAuditoria(decidirAudiencia(voz({ googleVoz: true })), { turnId: 'turno-1', timestamp: 1700000000000 });
assert.equal(ev.action, 'politica.audiencia');
assert.deepEqual(Object.keys(ev).sort(), ['action', 'audience_level', 'directed', 'downgrade_reason', 'human_count', 'interface', 'owner_present', 'policy_version', 'resources_allowed', 'speaker_verified', 'timestamp', 'turn_id'].sort());
assert.equal(ev.audience_level, 'privado');
assert.equal(ev.policy_version, POLICY_VERSION);
assert.ok(ev.resources_allowed.includes('google') && ev.resources_allowed.includes('memoriaPessoal'));
assert.ok(!ev.resources_allowed.includes('ferramentas'), 'ferramentas "nenhuma" não conta como permitida');
const evB = eventoAuditoria(decidirAudiencia(voz({ humanosNaCall: 2 })), { turnId: 't2', timestamp: 1, bloqueio: 'memoria_pessoal' });
assert.equal(evB.action, 'politica.audiencia.bloqueio');
assert.equal(evB.blocked_resource, 'memoria_pessoal');
assert.equal(evB.audience_level, 'publico');
assert.equal(evB.downgrade_reason, MOTIVO.OUTROS_HUMANOS);
const texto = JSON.stringify([ev, evB]);
assert.ok(!/\d{15,}/.test(texto), 'nenhum id de pessoa');
// as decisões e os eventos são imutáveis
assert.throws(() => { 'use strict'; priv.nivel = 'x'; }, TypeError);
assert.throws(() => { 'use strict'; priv.recursos.memoriaPessoal = false; }, TypeError);

console.log('test-politica-audiencia OK (' + casos + ' combinações)');
