import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { TEXTOS_DA_CHAVE, chavePronta, mascaraDaChave, normalizarChave } from '../confirmacaoLogic.ts';
import { colors, radius, spacing } from '../theme.ts';
import { Button, FieldLabel } from './ui.tsx';

/**
 * Correção C2: o campo da chave de confirmação que chegou pela DM (aprovar um plano, reautorizar o Google). Mostra o aviso do envio, o campo de 6 dígitos,
 * Confirmar (só com 6 dígitos), Pedir outra e Cancelar. A chave digitada só vai para `onConfirmar`; nada fica guardado.
 */
export function ChaveDaDm({
  aviso, erro, ocupado, onConfirmar, onPedirOutra, onCancelar, testID = 'chave-da-dm',
}: {
  aviso: string;
  erro?: string | null;
  ocupado?: boolean;
  onConfirmar: (chave: string) => void;
  onPedirOutra: () => void;
  onCancelar: () => void;
  testID?: string;
}) {
  const [texto, setTexto] = useState('');
  return (
    <View style={styles.caixa} testID={testID}>
      <Text style={styles.hint}>{aviso}</Text>
      <FieldLabel>{TEXTOS_DA_CHAVE.rotulo}</FieldLabel>
      <TextInput
        testID={`${testID}-campo`}
        style={styles.input}
        value={texto}
        onChangeText={(t) => setTexto(mascaraDaChave(t))}
        placeholder="000-000"
        placeholderTextColor={colors.muted}
        keyboardType="number-pad"
        inputMode="numeric"
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={7}
        autoCorrect={false}
      />
      {erro ? <Text accessibilityRole="alert" style={styles.erro}>{erro}</Text> : null}
      <View style={styles.acoes}>
        <Button testID={`${testID}-cancelar`} label={TEXTOS_DA_CHAVE.cancelar} variant="ghost" compact onPress={onCancelar} disabled={ocupado} />
        <Button testID={`${testID}-outra`} label={TEXTOS_DA_CHAVE.pedirOutra} variant="ghost" compact onPress={() => { setTexto(''); onPedirOutra(); }} disabled={ocupado} />
        <Button testID={`${testID}-confirmar`} label={TEXTOS_DA_CHAVE.confirmar} icon="check" compact onPress={() => onConfirmar(normalizarChave(texto))} loading={ocupado} disabled={!chavePronta(texto)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  caixa: { gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  erro: { color: colors.danger, fontSize: 14, lineHeight: 20 },
  acoes: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.sm },
  input: {
    backgroundColor: colors.inputBg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.sm,
    fontSize: 20,
    letterSpacing: 4,
    maxWidth: 200,
  },
});
