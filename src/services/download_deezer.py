import sys
import os
from deezer import Deezer
from deemix.downloader import Downloader
from deemix import generateDownloadObject
from deemix.settings import load as loadSettings

url = sys.argv[1]
output_folder = sys.argv[2]
arl = sys.argv[3] if len(sys.argv) > 3 else ""

dz = Deezer()
if arl:
    dz.login_via_arl(arl)

settings = loadSettings()
settings['downloadLocation'] = output_folder
settings['createSingleFolder'] = False
settings['createAlbumFolder'] = False
settings['maxBitrateFallback'] = True

download_object = generateDownloadObject(dz, url, 3)
Downloader(dz, download_object, settings).start()

if download_object.failed:
    download_object = generateDownloadObject(dz, url, 1)
    Downloader(dz, download_object, settings).start()

found = False
if hasattr(download_object, 'files') and download_object.files:
    for item in download_object.files:
        if isinstance(item, dict) and item.get('path'):
            print(f"DOWNLOADED_FILE:{item.get('path')}")
            found = True

if not found and os.path.exists(output_folder):
    audio_files = [os.path.join(output_folder, f) for f in os.listdir(output_folder) if f.lower().endswith(('.mp3', '.flac'))]
    if audio_files:
        audio_files.sort(key=lambda x: os.path.getmtime(x), reverse=True)
        print(f"DOWNLOADED_FILE:{audio_files[0]}")
