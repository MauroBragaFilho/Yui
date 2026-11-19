import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError, type Diagnostico, type Health, type Me, type YuiClient } from '../api/client.ts';
import { Badge, Button, Card, PageHeader } from '../components/ui.tsx';
import { DIAGNOSTICO_ATUALIZA_MS, podeVerDiagnostico, visaoDoDiagnostico, type Cartao, type Tom } from '../diagnosticoLogic.ts';
import type { GerenciadorDeServidor } from '../servidores.ts';
import { colors, spacing } from '../theme.ts';
import { useTextoDoServidor } from '../useServidor.ts';
import { getTheme, setTheme, type ThemeMode } from '../web.ts';

type Props = { client: YuiClient; me: Me; /** Os endereços do servidor (para mostrar qual está em uso). */ servidor?: GerenciadorDeServidor | null; onLogout: () => void };

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Dono',
  TRUSTED: 'Confiável',
  MEMBER: 'Membro',
  GUEST: 'Convidado',
  BLOCKED: 'Bloqueado',
};

const TOM_COR: Record<Tom, string> = { ok: colors.success, atencao: colors.warning, problema: colors.danger, neutro: colors.muted };

/** Um cartão do diagnóstico: o título com o selo, as linhas (rótulo e valor), os itens e uma nota. Só mostra o que a lógica entregou. */
function CartaoDoDiagnostico({ cartao }: { cartao: Cartao }) {
  return (
    <Card style={styles.card}>
      <View testID={`diag-cartao-${cartao.chave}`} style={styles.row}>
        <Text style={styles.cardTitle}>{cartao.titulo}</Text>
        {cartao.selo ? <Badge label={cartao.selo.texto} color={TOM_COR[cartao.selo.tom]} /> : null}
      </View>
      {cartao.linhas.map((l) => (
        <View key={l.rotulo} style={styles.kv}>
          <Text style={styles.kvLabel}>{l.rotulo}</Text>
          <Text selectable style={[styles.kvValue, l.tom ? { color: TOM_COR[l.tom] } : null]}>{l.valor}</Text>
        </View>
      ))}
      {cartao.itens?.map((i, idx) => (
        <View key={`${i.titulo}-${idx}`} style={styles.item}>
          <Text selectable style={[styles.itemTitle, i.tom ? { color: TOM_COR[i.tom] } : null]}>{i.titulo}</Text>
          {i.detalhe ? <Text selectable style={styles.hint}>{i.detalhe}</Text> : null}
        </View>
      ))}
      {cartao.nota ? <Text style={styles.hint}>{cartao.nota}</Text> : null}
    </Card>
  );
}

/**
 * O diagnóstico completo (só o dono; só leitura). Pede ao abrir, a cada 30 s enquanto a aba está aberta e no botão "Atualizar". Nada é guardado em disco: o dado vive só
 * na memória desta tela e some ao sair dela. Se o servidor recusar (403) ou a sessão acabar, para de pedir.
 */
function DiagnosticoDoServidor({ client }: { client: YuiClient }) {
  const [diag, setDiag] = useState<Diagnostico | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const parado = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current || parado.current) return;
    busy.current = true;
    setLoading(true);
    try {
      setDiag(await client.admin.diagnostico());
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) parado.current = true; // sem permissão: não insiste
      setError(e instanceof ApiError ? e.message : 'Falha ao consultar o diagnóstico.');
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    parado.current = false;
    refresh();
    const timer = setInterval(refresh, DIAGNOSTICO_ATUALIZA_MS);
    return () => { parado.current = true; clearInterval(timer); };
  }, [refresh]);

  const visao = diag ? visaoDoDiagnostico(diag) : null;
  return (
    <>
      <View style={styles.row}>
        <Text style={styles.sectionTitle}>Diagnóstico</Text>
        <Button testID="btn-diag-refresh" label="Atualizar diagnóstico" variant="ghost" onPress={refresh} loading={loading} />
      </View>
      <Text style={styles.hint}>Só você vê esta parte. Só leitura: números e palavras fixas do servidor, nunca conversas, chaves nem textos de erro. Atualiza sozinho a cada 30 segundos.</Text>
      {error ? <Text testID="diag-error" style={styles.error}>{error}</Text> : null}
      {visao ? visao.cartoes.map((c) => <CartaoDoDiagnostico key={c.chave} cartao={c} />) : null}
    </>
  );
}

export function StatusScreen({ client, me, servidor = null, onLogout }: Props) {
  const textoServidor = useTextoDoServidor(servidor);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHealth(await client.health());
    } catch (e) {
      setHealth(null);
      setError(e instanceof ApiError ? e.message : 'Falha ao consultar o servidor.');
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const [theme, setThemeState] = useState<ThemeMode>(getTheme);
  const online = Boolean(health?.ok);
  const active = health?.backends.find((b) => b.active);

  return (
    <View style={styles.root}>
    <PageHeader title="Status" subtitle="Servidor, permissões e segurança" />
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>

      <Card style={styles.card}>
        <View style={styles.row}>
          <Text style={styles.label}>Servidor</Text>
          <Badge label={online ? '● Online' : '● Offline'} color={online ? colors.success : colors.danger} />
        </View>
        <Text testID="status-servidor" selectable style={styles.value}>{textoServidor ?? client.baseUrl}</Text>
        {error ? <Text testID="status-error" style={styles.error}>{error}</Text> : null}
        <Button label="Atualizar" variant="ghost" onPress={refresh} loading={loading} />
      </Card>

      <Card style={styles.card}>
        <Text style={styles.label}>Você</Text>
        <Text style={styles.value}>ID {me.userId}</Text>
        <View style={styles.row}>
          <Badge label={ROLE_LABEL[me.role] ?? me.role} color={colors.accentText} />
          <Badge
            label={me.memoryScope === 'personal' ? 'Memória pessoal' : 'Memória temporária'}
            color={me.memoryScope === 'personal' ? colors.success : colors.warning}
          />
        </View>
        <Text style={styles.hint}>
          O papel e o tipo de memória são decididos pelo servidor, não por este app.
        </Text>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.label}>Inteligência artificial</Text>
        <Text style={styles.value}>{active ? active.name : '—'}</Text>
        {active ? (
          <Badge label={active.local ? 'Local' : 'Nuvem'} color={active.local ? colors.success : colors.warning} />
        ) : null}
        <Text style={styles.hint}>
          Memória: {health ? (health.memory ? 'ativada' : 'desativada') : '—'}
        </Text>
      </Card>

      <Card style={styles.card}>
        <Text style={styles.label}>Segurança no computador</Text>
        {health?.readOnly === false ? (
          <Badge label="Modo somente leitura desligado" color={colors.warning} />
        ) : (
          <Badge label="Somente leitura" color={colors.success} />
        )}
        <Text style={styles.hint}>
          {health?.readOnly === false
            ? 'Ferramentas que executam programas ou alteram arquivos podem estar liberadas.'
            : 'A Yui só consulta e abre pastas: não apaga, grava nem move arquivos e não executa programas.'}
        </Text>
      </Card>

      {podeVerDiagnostico(me.role) ? <DiagnosticoDoServidor client={client} /> : null}

      {Platform.OS === 'web' ? (
        <Card style={styles.card}>
          <Text style={styles.label}>Aparência</Text>
          <View style={styles.row}>
            <Button
              testID="btn-theme-dark"
              label="Escuro"
              variant={theme === 'dark' ? 'primary' : 'ghost'}
              onPress={() => { setTheme('dark'); setThemeState('dark'); }}
              style={styles.themeBtn}
            />
            <Button
              testID="btn-theme-light"
              label="Claro"
              variant={theme === 'light' ? 'primary' : 'ghost'}
              onPress={() => { setTheme('light'); setThemeState('light'); }}
              style={styles.themeBtn}
            />
          </View>
        </Card>
      ) : null}

      <Button testID="btn-logout" label="Sair deste dispositivo" variant="danger" icon="logout" onPress={onLogout} />
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md, width: '100%', maxWidth: 860, alignSelf: 'center' },
  themeBtn: { flex: 1, minHeight: 40 },
  card: { gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
  label: { color: colors.muted, fontSize: 13 },
  value: { color: colors.text, fontSize: 14 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  error: { color: colors.danger },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '600' },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md, flexWrap: 'wrap' },
  kvLabel: { color: colors.muted, fontSize: 13, flexShrink: 1 },
  kvValue: { color: colors.text, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  item: { gap: 2, paddingTop: spacing.xs },
  itemTitle: { color: colors.text, fontSize: 13, lineHeight: 18 },
});
