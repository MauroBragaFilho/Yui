# -*- coding: utf-8 -*-
"""Baixa UMA faixa do Deezer com o deemix e imprime o caminho do arquivo.

Uso:
  python download_deezer.py <link-da-faixa> <pasta-de-saida> [arl-legado]
  python download_deezer.py --check

O ARL (cookie de sessao) vem de os.environ['DEEZER_ARL']. O argumento 3 so e
aceito como alternativa legada, porque argumentos aparecem na lista de processos.

Saida (stdout): exatamente uma linha  DOWNLOADED_FILE:<caminho absoluto>
Erros (stderr): linhas YUI_DEEZER_* curtas; o detalhe tecnico fica so no log do Node.

Codigos de saida:
  0  ok
  1  erro generico
  2  modulo ausente (deezer/deemix nao instalados)  -> pip install -r requirements-deemix.txt
  3  login recusado, ARL ausente/expirado ou conta sem licenca
  4  o deemix terminou sem gerar arquivo
  64 uso incorreto

Variaveis opcionais:
  YUI_DEEMIX_CONFIG_DIR  pasta de configuracao propria do deemix (padrao: %APPDATA%\\deemix)
"""
import json
import os
import platform
import sys

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_MISSING_MODULE = 2
EXIT_LOGIN = 3
EXIT_NO_FILE = 4
EXIT_USAGE = 64

AUDIO_EXTENSIONS = ('.mp3', '.flac')


def configure_streams():
    """Forca UTF-8: o stdout do Python 3.12 em pipe no Windows usa cp1252 e corrompe acentos."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass


def import_dependencies():
    from deezer import Deezer
    from deemix.downloader import Downloader
    from deemix import generateDownloadObject
    from deemix.settings import load as load_settings
    return Deezer, Downloader, generateDownloadObject, load_settings


def package_version(dist_name, module):
    try:
        from importlib.metadata import version
        return version(dist_name)
    except Exception:
        return getattr(module, '__version__', None)


def run_check():
    """Apenas importa os modulos e imprime as versoes em JSON (sem rede, sem login)."""
    info = {'ok': False, 'python': platform.python_version()}
    try:
        import_dependencies()
        import deemix
        import deezer
    except ImportError as exc:
        info['missing'] = getattr(exc, 'name', None) or str(exc)
        print(json.dumps(info, ensure_ascii=False))
        print('%s: %s' % (type(exc).__name__, exc), file=sys.stderr)
        return EXIT_MISSING_MODULE
    except Exception as exc:
        info['error'] = type(exc).__name__
        print(json.dumps(info, ensure_ascii=False))
        print('YUI_DEEZER_ERROR: falha ao importar (%s)' % type(exc).__name__, file=sys.stderr)
        return EXIT_ERROR
    info['ok'] = True
    info['deemix'] = package_version('deemix', deemix)
    info['deezer-py'] = package_version('deezer-py', deezer)
    print(json.dumps(info, ensure_ascii=False))
    return EXIT_OK


def scan_audio_files(folder):
    """Procura audio so dentro da pasta do pedido (que e unica por pedido)."""
    found = []
    for root, _dirs, names in os.walk(folder):
        for name in names:
            if name.lower().endswith(AUDIO_EXTENSIONS):
                full = os.path.join(root, name)
                try:
                    if os.path.getsize(full) > 0:
                        found.append(full)
                except OSError:
                    pass
    found.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return found


def collect_files(download_object, output_folder):
    files = []
    for item in (getattr(download_object, 'files', None) or []):
        path = item.get('path') if isinstance(item, dict) else item
        if path and os.path.isfile(path):
            files.append(os.path.abspath(path))
    if not files and not getattr(download_object, 'failed', 0):
        files = scan_audio_files(output_folder)
    return files


def apply_settings(settings, output_folder):
    settings['downloadLocation'] = output_folder
    settings['tracknameTemplate'] = '%artist% - %title%'
    settings['albumTracknameTemplate'] = '%artist% - %title%'
    settings['createSingleFolder'] = False
    settings['createAlbumFolder'] = False
    settings['createArtistFolder'] = False
    settings['createPlaylistFolder'] = False
    # chaves reais do deemix 3.6.6 (a chave antiga usada aqui nao existia no deemix e era ignorada)
    settings['maxBitrate'] = '3'
    settings['fallbackBitrate'] = True
    # pasta unica por pedido: sobrescrever e seguro; sem capa solta nem log de erros em arquivo
    settings['overwriteFile'] = 'y'
    settings['saveArtwork'] = False
    settings['saveArtworkArtist'] = False
    settings['logErrors'] = False
    # nunca executar comando externo vindo de um config.json compartilhado
    settings['executeCommand'] = ''
    # o arquivo entregue nao diz de onde veio: o deemix grava as tags SOURCE/SOURCEID quando 'source' esta ligado
    tags = settings.get('tags')
    if isinstance(tags, dict):
        tags['source'] = False
    return settings


def summarize_errors(download_object):
    """Devolve (codigo de saida, linhas curtas) a partir dos erros do deemix."""
    errids = set()
    lines = []
    for error in (getattr(download_object, 'errors', None) or []):
        if not isinstance(error, dict):
            continue
        errid = str(error.get('errid') or '')
        if errid:
            errids.add(errid)
        message = str(error.get('message') or '')[:160]
        lines.append('YUI_DEEZER_ERROR: %s %s' % (errid or 'erro', message))
        if len(lines) >= 3:
            break
    if errids & {'notLoggedIn', 'wrongLicense'}:
        return EXIT_LOGIN, ['YUI_DEEZER_LOGIN_FAILED: conta sem acesso a faixa'] + lines
    return EXIT_NO_FILE, lines or ['YUI_DEEZER_ERROR: o deemix nao gerou arquivo']


def main(argv):
    configure_streams()

    if len(argv) >= 2 and argv[1] == '--check':
        return run_check()

    if len(argv) < 3:
        print('uso: download_deezer.py <link> <pasta-de-saida>  |  --check', file=sys.stderr)
        return EXIT_USAGE

    link = argv[1]
    output_folder = os.path.abspath(argv[2])
    arl = (os.environ.get('DEEZER_ARL') or (argv[3] if len(argv) > 3 else '') or '').strip()

    def safe(text):
        text = str(text)
        return text.replace(arl, '***') if arl else text

    try:
        Deezer, Downloader, generate_download_object, load_settings = import_dependencies()
    except ImportError as exc:
        print('%s: %s' % (type(exc).__name__, exc), file=sys.stderr)
        return EXIT_MISSING_MODULE

    if not arl:
        print('YUI_DEEZER_LOGIN_FAILED: ARL ausente (defina DEEZER_ARL)', file=sys.stderr)
        return EXIT_LOGIN

    dz = Deezer()
    try:
        logged_in = dz.login_via_arl(arl)
    except (KeyError, TypeError, ValueError) as exc:
        # resposta malformada do Deezer ao validar o cookie: trata como login recusado
        print('YUI_DEEZER_LOGIN_FAILED: resposta invalida no login (%s)' % type(exc).__name__, file=sys.stderr)
        return EXIT_LOGIN
    except Exception as exc:
        print('YUI_DEEZER_ERROR: falha de rede no login (%s: %s)' % (type(exc).__name__, safe(exc)[:160]), file=sys.stderr)
        return EXIT_ERROR
    if not logged_in:
        print('YUI_DEEZER_LOGIN_FAILED: ARL invalido ou expirado', file=sys.stderr)
        return EXIT_LOGIN

    try:
        os.makedirs(output_folder, exist_ok=True)
        settings = apply_settings(load_settings(os.environ.get('YUI_DEEMIX_CONFIG_DIR') or None), output_folder)

        download_object = generate_download_object(dz, link, 3)
        Downloader(dz, download_object, settings).start()
        if getattr(download_object, 'failed', 0):
            # segundo passe em MP3 128 kbps
            download_object = generate_download_object(dz, link, 1)
            Downloader(dz, download_object, settings).start()
    except Exception as exc:
        print('YUI_DEEZER_ERROR: %s: %s' % (type(exc).__name__, safe(exc)[:160]), file=sys.stderr)
        return EXIT_ERROR

    files = collect_files(download_object, output_folder)
    if getattr(download_object, 'failed', 0) and not files:
        code, lines = summarize_errors(download_object)
        for line in lines:
            print(safe(line), file=sys.stderr)
        return code
    if not files:
        print('YUI_DEEZER_ERROR: o deemix nao gerou arquivo', file=sys.stderr)
        return EXIT_NO_FILE

    print('DOWNLOADED_FILE:%s' % files[0])
    return EXIT_OK


if __name__ == '__main__':
    sys.exit(main(sys.argv))
