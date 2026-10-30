"""Fetch the recorded instruments the music is rendered from.

    python3 tools/samples.py

FluidR3 GM (Frank Wen), as rendered note by note by gleitz/midi-js-soundfonts:
one ~3 s mp3 per note, A0 to C8 - the same source Dry Fly's music uses.
Licence: Creative Commons Attribution 3.0, so the game credits "FluidR3 GM
soundfont by Frank Wen" (the hangar screen and README do). Kept in
tools/samples/, which git ignores; only the rendered music ships.
"""
import os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = 'https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/FluidR3_GM'
INSTRUMENTS = ['french_horn', 'trumpet', 'trombone', 'tuba', 'string_ensemble_1', 'pizzicato_strings',
               'contrabass', 'cello', 'timpani', 'taiko_drum', 'orchestral_harp', 'celesta', 'glockenspiel',
               'flute', 'choir_aahs', 'acoustic_grand_piano', 'orchestra_hit', 'reverse_cymbal', 'tremolo_strings',
               'brass_section']
NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']


def note(m):
    return NAMES[m % 12] + str(m // 12 - 1)


def get(job):
    inst, m = job
    d = os.path.join(HERE, 'samples', inst)
    f = os.path.join(d, note(m) + '.mp3')
    if os.path.exists(f) and os.path.getsize(f) > 1000:
        return 0
    os.makedirs(d, exist_ok=True)
    try:
        urllib.request.urlretrieve(f'{BASE}/{inst}-mp3/{note(m)}.mp3', f)
        return 1
    except Exception as e:
        print('missing', inst, note(m), e, file=sys.stderr)
        return 0


if __name__ == '__main__':
    jobs = [(i, m) for i in (sys.argv[1:] or INSTRUMENTS) for m in range(21, 109)]
    with ThreadPoolExecutor(16) as ex:
        n = sum(ex.map(get, jobs))
    print(f'{n} fetched, {len(jobs)} wanted')
