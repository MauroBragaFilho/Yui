import { Alert, Platform } from 'react-native';

/** Confirmação que funciona na web (window.confirm) e no celular (Alert). */
export function confirmAction(title: string, message: string, onYes: () => void, yesLabel = 'Confirmar') {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`)) onYes();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancelar', style: 'cancel' },
    { text: yesLabel, style: 'destructive', onPress: onYes },
  ]);
}
