// Plugin de configuração do Expo (local, sem pacote novo): permite tráfego em texto claro (http://) no app Android.
//
// Por quê: o Android 9 ou mais novo bloqueia http:// em apps de produção (APK/AAB). O endereço da rede local do servidor da Yui não tem certificado,
// então sem isto o app gerado não consegue falar com ele (o Expo Go e as versões de desenvolvimento já permitem). O Tailscale cifra o caminho por conta própria.
// O app só conversa com os endereços que vêm do build (EXPO_PUBLIC_YUI_SERVER_URLS / EXPO_PUBLIC_YUI_SERVER_URL); ele nunca pede endereço ao usuário.
// Para voltar ao padrão do Android (só https), tire a linha deste plugin de "plugins" no app.json.
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0];
    if (application) {
      application.$ = application.$ || {};
      application.$['android:usesCleartextTraffic'] = 'true';
    }
    return cfg;
  });
};
