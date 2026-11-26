import React from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { colors, spacing } from '../theme.ts';
import { Chip } from './ui.tsx';

/** Lista de canais de texto do servidor para escolher um. */
export function ChannelPicker({ channels, value, onPick, allowNone = false, testID }: {
  channels: { id: string; name: string }[]; value: string | null; onPick: (id: string | null) => void; allowNone?: boolean; testID?: string;
}) {
  return (
    <ScrollView style={styles.picker} nestedScrollEnabled contentContainerStyle={styles.chips}>
      {allowNone ? <Chip label="Nenhum" on={value === null} onPress={() => onPick(null)} /> : null}
      {channels.map((c) => (
        <Chip key={c.id} testID={testID ? `${testID}-${c.id}` : undefined} label={`#${c.name}`} on={value === c.id} onPress={() => onPick(c.id)} />
      ))}
      {channels.length === 0 ? <Text style={styles.hint}>A Yui não vê nenhum canal de texto neste servidor.</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  picker: { maxHeight: 150 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
});
