"""Render Mission Control's music from recorded instruments.

    python3 tools/samples.py      # once: the FluidR3 instrument recordings
    python3 tools/music.py [name ...]

Every piece is written out below as notes, rendered note by note from the
FluidR3 GM recordings (the same instruments Dry Fly's music uses), put
through a hall reverb, and encoded into web/music/ as MP3 - MP3 because
every browser decodes it, the iPad's included, which Opus in Ogg is not.

Loops are made to loop: the reverb tail that runs past the end is folded
back onto the start, and the file carries a little of the end before bar 1
and a little of the start after the last bar, so the game can loop between
music.json's loopStart and loopEnd without a seam whatever a decoder does
with the first few milliseconds of an MP3.

Licence: FluidR3 GM by Frank Wen, CC BY 3.0. The game credits it.
"""
import json, math, os, random, subprocess, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SAMPLES = os.path.join(HERE, 'samples')
OUT = os.path.join(REPO, 'web', 'music')
SR = 44100
NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

# ---------------------------------------------------------------- instruments
# sus: a held note, carried past the end of the recording by crossfading
# repeats of its steady middle. ring: how long a struck note is left to ring
# after its written length. send: how much goes to the hall.
INST = {
    'horn':     dict(gm='french_horn', gain=0.55, pan=-0.25, send=0.45, rel=0.35, sus=True),
    'trumpet':  dict(gm='trumpet', gain=0.42, pan=0.2, send=0.35, rel=0.25, sus=True),
    'brass':    dict(gm='brass_section', gain=0.38, pan=0.05, send=0.4, rel=0.3, sus=True),
    'trombone': dict(gm='trombone', gain=0.45, pan=0.25, send=0.3, rel=0.2, sus=True),
    'tuba':     dict(gm='tuba', gain=0.5, pan=0.1, send=0.2, rel=0.2, sus=True),
    'strings':  dict(gm='string_ensemble_1', gain=0.36, pan=0.0, send=0.5, rel=0.6, sus=True),
    'spicc':    dict(gm='string_ensemble_1', gain=0.34, pan=-0.1, send=0.3, rel=0.08, sus=False, ring=0.12),
    'trem':     dict(gm='tremolo_strings', gain=0.34, pan=0.1, send=0.45, rel=0.4, sus=True),
    'pizz':     dict(gm='pizzicato_strings', gain=0.55, pan=0.15, send=0.3, rel=0.2, sus=False, ring=0.6),
    'bass':     dict(gm='contrabass', gain=0.5, pan=0.0, send=0.2, rel=0.3, sus=True),
    'cello':    dict(gm='cello', gain=0.42, pan=0.15, send=0.35, rel=0.4, sus=True),
    'timp':     dict(gm='timpani', gain=0.7, pan=0.0, send=0.4, rel=0.4, sus=False, ring=1.4),
    'taiko':    dict(gm='taiko_drum', gain=0.62, pan=0.0, send=0.3, rel=0.3, sus=False, ring=0.9),
    'harp':     dict(gm='orchestral_harp', gain=0.45, pan=-0.3, send=0.5, rel=0.8, sus=False, ring=2.0),
    'celesta':  dict(gm='celesta', gain=0.32, pan=0.3, send=0.55, rel=0.8, sus=False, ring=1.4),
    'glock':    dict(gm='glockenspiel', gain=0.24, pan=0.35, send=0.55, rel=0.8, sus=False, ring=1.4),
    'flute':    dict(gm='flute', gain=0.42, pan=0.2, send=0.5, rel=0.25, sus=True),
    'choir':    dict(gm='choir_aahs', gain=0.3, pan=0.0, send=0.65, rel=0.8, sus=True),
    'piano':    dict(gm='acoustic_grand_piano', gain=0.42, pan=0.0, send=0.35, rel=0.6, sus=False, ring=2.2),
    'hit':      dict(gm='orchestra_hit', gain=0.5, pan=0.0, send=0.5, rel=0.5, sus=False, ring=1.5),
    'revcym':   dict(gm='reverse_cymbal', gain=0.35, pan=0.0, send=0.3, rel=0.0, sus=False, ring=0.0),
}

_cache = {}


def midi_of(name):
    """'C#5', 'Bb3', 'G4' -> MIDI number."""
    letter, rest = name[0], name[1:]
    acc = 0
    while rest and rest[0] in '#b':
        acc += 1 if rest[0] == '#' else -1
        rest = rest[1:]
    pc = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}[letter] + acc
    return 12 * (int(rest) + 1) + pc


def load(gm, m):
    key = (gm, m)
    if key in _cache:
        return _cache[key]
    path = os.path.join(SAMPLES, gm, NAMES[m % 12] + str(m // 12 - 1) + '.mp3')
    if not os.path.exists(path):
        raise SystemExit(f'missing sample {path} - run python3 tools/samples.py')
    raw = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', path, '-f', 'f32le',
                          '-ac', '2', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    a = np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)
    # start at the note's onset, not the mp3's leading silence
    loud = np.nonzero(np.abs(a).max(axis=1) > 0.003)[0]
    if len(loud):
        a = a[max(0, loud[0] - int(0.002 * SR)):]
    _cache[key] = a
    return a


def extend(s, n):
    """A held note longer than its recording: crossfade repeats of the middle."""
    if n <= len(s):
        return s[:n]
    a, b, xf = int(0.8 * SR), len(s) - int(0.4 * SR), int(0.15 * SR)
    if b - a < xf * 3:
        return np.concatenate([s, np.zeros((n - len(s), 2))])
    loop = s[a:b]
    out = s[:b].copy()
    fade = np.linspace(0, 1, xf)[:, None]
    while len(out) < n:
        head = out[-xf:] * (1 - fade) + loop[:xf] * fade
        out = np.concatenate([out[:-xf], head, loop[xf:]])
    return out[:n]


# ---------------------------------------------------------------- the score
CHORDS = {'': [0, 4, 7], 'm': [0, 3, 7], 'dim': [0, 3, 6], 'sus': [0, 5, 7], '7': [0, 4, 7, 10], 'm7': [0, 3, 7, 10]}


def chord(name):
    """'Am' -> (root pc, [pcs]); 'E/D' keeps E major over a D bass: (bass pc, pcs)."""
    bass = None
    if '/' in name:
        name, b = name.split('/')
        bass = midi_of(b + '0') % 12
    root = name[0]
    i = 1
    if len(name) > 1 and name[1] in '#b':
        root += name[1]
        i = 2
    r = midi_of(root + '0') % 12
    q = CHORDS[name[i:]]
    return (r if bass is None else bass), [(r + x) % 12 for x in q], r


def voice(pcs, lo, hi):
    """Every chord tone between two MIDI notes, low to high."""
    return [m for m in range(lo, hi + 1) if m % 12 in pcs]


def near(pc, lo, hi):
    """The pitch class's first note at or above lo (within hi)."""
    for m in range(lo, hi + 1):
        if m % 12 == pc:
            return m
    return lo


class Score:
    def __init__(self, bpm, bars, beats=4, seed=1):
        self.bpm, self.bars, self.beats = bpm, bars, beats
        self.notes = []          # (inst, t_sec, dur_sec, midi, vel)
        self.fx = []             # synthesised drums: (kind, t_sec, vel)
        self.rng = random.Random(seed)

    def sec(self, beat):
        return beat * 60.0 / self.bpm

    @property
    def length(self):
        return self.sec(self.bars * self.beats)

    def note(self, inst, beat, dur, pitch, vel=0.8):
        m = midi_of(pitch) if isinstance(pitch, str) else pitch
        # humanised a little: a few milliseconds and a few percent
        jit = self.rng.uniform(-0.006, 0.006) if INST[inst].get('sus') or inst not in ('taiko', 'timp') else self.rng.uniform(-0.003, 0.003)
        self.notes.append((inst, max(0, self.sec(beat) + jit), self.sec(dur), m, vel * self.rng.uniform(0.95, 1.04)))

    def line(self, inst, beat, tokens, vel=0.8, shift=0, legato=1.0):
        """'G4:1 C5:1.5 r:0.5' from a beat; returns the beat after."""
        for tok in tokens.split():
            p, d = tok.split(':')
            d = float(d)
            if p != 'r':
                self.note(inst, beat, d * legato, midi_of(p) + shift, vel)
            beat += d
        return beat

    def hold(self, inst, beat, dur, pitches, vel=0.6):
        for p in pitches:
            self.note(inst, beat, dur, p, vel)

    def drum(self, kind, beat, vel=0.8):
        self.fx.append((kind, self.sec(beat) + self.rng.uniform(-0.003, 0.003), vel * self.rng.uniform(0.92, 1.05)))


# ---------------------------------------------------------------- synthesised drums
def snare(vel):
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(int(vel * 1e6) % 9973)
    noise = rng.standard_normal(n)
    # band-limited: the top of the noise taken off, then the bottom, so it
    # reads as a drum and not as hiss
    noise = np.convolve(noise, np.ones(5) / 5, mode='same')
    noise = noise - np.convolve(noise, np.ones(24) / 24, mode='same')
    body = np.sin(2 * np.pi * 185 * t) * np.exp(-t / 0.05)
    s = (noise * np.exp(-t / 0.07) * 0.9 + body * 0.5) * vel * 0.26
    return np.stack([s, s], axis=1)


def crash(vel):
    """A real cymbal: FluidR3's reverse cymbal, played forwards again."""
    s = load('reverse_cymbal', 60)[::-1].copy()
    loud = np.nonzero(np.abs(s).max(axis=1) > 0.01)[0]
    s = s[loud[0]:] if len(loud) else s
    fade = int(0.3 * SR)
    s[-fade:] *= np.linspace(1, 0, fade)[:, None]
    return s * vel * 0.55


def crash_noise(vel):
    n = int(2.6 * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(7)
    l, r = rng.standard_normal(n), rng.standard_normal(n)
    band = lambda x: (lambda y: y - np.convolve(y, np.ones(10) / 10, mode='same'))(np.convolve(x, np.ones(3) / 3, mode='same'))
    env = np.exp(-t / 0.9) * (1 - np.exp(-t / 0.004))
    return np.stack([band(l) * env, band(r) * env], axis=1) * vel * 0.2


def reverb_ir():
    n = int(2.6 * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(3)
    ir = rng.standard_normal((n, 2)) * np.exp(-t / 0.6)[:, None]
    # darker as it decays: a running average whose width grows with time
    k = 12
    ir = np.stack([np.convolve(ir[:, c], np.ones(k) / k, mode='same') for c in range(2)], axis=1)
    ir[:int(0.018 * SR)] = 0
    return ir / np.sqrt((ir ** 2).sum() / 2) * 0.55


def render(score, tail=3.0, loop=True):
    L = int(round(score.length * SR))
    N = L + int(tail * SR)
    dry = np.zeros((N, 2))
    wet = np.zeros((N, 2))
    for inst, t, dur, m, vel in score.notes:
        spec = INST[inst]
        s = load(spec['gm'], m)
        if inst == 'revcym':
            # a reverse cymbal swells INTO its beat: line its end up with it
            start = int(t * SR) - len(s)
            seg = s.copy()
            if start < 0:
                seg, start = seg[-start:], 0
        else:
            keep = dur + (spec['rel'] if spec['sus'] else spec.get('ring', 0.5))
            n = int(keep * SR)
            seg = extend(s, n) if spec['sus'] else s[:n].copy()
            # release: hold to the written end, then fade
            rel_n = max(1, int((spec['rel'] if spec['sus'] else min(spec.get('ring', 0.5), 0.3)) * SR))
            fade_from = max(0, len(seg) - rel_n)
            env = np.ones(len(seg))
            env[fade_from:] = np.cos(np.linspace(0, np.pi / 2, len(seg) - fade_from)) ** 2
            seg = seg * env[:, None]
            start = int(t * SR)
        g = spec['gain'] * (vel ** 1.5)
        p = (spec['pan'] + 1) * np.pi / 4
        seg = seg * np.array([math.cos(p), math.sin(p)]) * g * 1.41
        end = min(N, start + len(seg))
        if end <= start:
            continue
        dry[start:end] += seg[:end - start]
        wet[start:end] += seg[:end - start] * spec['send']
    for kind, t, vel in score.fx:
        s = snare(vel) if kind == 'snare' else crash(vel)
        start = int(t * SR)
        end = min(N, start + len(s))
        dry[start:end] += s[:end - start]
        wet[start:end] += s[:end - start] * 0.35
    ir = reverb_ir()
    size = 1 << int(np.ceil(np.log2(N + len(ir))))
    rev = np.stack([np.fft.irfft(np.fft.rfft(wet[:, c], size) * np.fft.rfft(ir[:, c], size), size)[:N] for c in range(2)], axis=1)
    mix = dry + rev
    if loop:
        # the tail past the last bar belongs at the start of the next time round
        mix[:N - L] += mix[L:]
        mix = mix[:L]
    else:
        loud = np.nonzero(np.abs(mix).max(axis=1) > 0.0008)[0]
        mix = mix[:(loud[-1] + int(0.05 * SR)) if len(loud) else N]
        fade = min(len(mix), int(0.05 * SR))
        mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
    return mix


def master(mix, rms_target=0.11, peak=0.8):
    rms = np.sqrt((mix ** 2).mean()) + 1e-9
    mix = mix * (rms_target / rms)
    # a gentle limiter rather than a clip
    mix = np.tanh(mix * 1.1) / np.tanh(1.1)
    mx = np.abs(mix).max()
    if mx > peak:
        mix *= peak / mx
    return mix


def encode(mix, path):
    data = mix.astype(np.float32).tobytes()
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2',
                    '-i', '-', '-c:a', 'libmp3lame', '-b:a', '128k', path], input=data, check=True)


# ================================================================ the pieces
def ostinato(sc, inst, bar, name, pattern, lo, hi, vel, step=0.5, dur=0.45):
    """An arpeggiated figure over a bar: pattern indexes the chord's tones
    from the lowest in range (0, 1, 2...), -1 being the bass note."""
    bass, pcs, root = chord(name)
    tones = voice(pcs, lo, hi)
    # start the figure on the root
    while tones and tones[0] % 12 != root:
        tones = tones[1:]
    for i, k in enumerate(pattern):
        b = bar * sc.beats + i * step
        if b >= (bar + 1) * sc.beats:
            break
        m = near(bass, lo - 12, hi) if k == -1 else tones[min(k, len(tones) - 1)]
        sc.note(inst, b, dur, m, vel)


def pad(sc, inst, bar, name, lo, hi, vel, beats=None):
    _, pcs, _ = chord(name)
    sc.hold(inst, bar * sc.beats, beats or sc.beats, voice(pcs, lo, hi), vel)


def bassline(sc, inst, bar, name, octave_lo, vel, beats=None):
    bass, _, _ = chord(name)
    sc.note(inst, bar * sc.beats, beats or sc.beats, near(bass, octave_lo, octave_lo + 11), vel)


def roll(sc, inst, beat, beats, pitch, v0, v1, step=0.125):
    n = int(beats / step)
    for i in range(n):
        sc.note(inst, beat + i * step, step, pitch, v0 + (v1 - v0) * i / max(1, n - 1))


def snare_roll(sc, beat, beats, v0, v1, step=0.125):
    n = int(beats / step)
    for i in range(n):
        sc.drum('snare', beat + i * step, v0 + (v1 - v0) * i / max(1, n - 1))


def liftoff():
    """Option 1: heroic and bright. Horns then trumpets over driving strings,
    timpani and a march snare. C major, 112 bpm."""
    sc = Score(112, 32, seed=11)
    prog = (['C', 'Am', 'F', 'G'] +                                   # intro
            ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'C'] +             # A
            ['F', 'G', 'Em', 'Am', 'F', 'G', 'Ab', 'Bb'] +           # B
            ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'C'] +             # A'
            ['C', 'C', 'Bb', 'G'])                                   # bridge, back to the top
    for bar, ch in enumerate(prog):
        sect = 'intro' if bar < 4 else 'A' if bar < 12 else 'B' if bar < 20 else "A'" if bar < 28 else 'bridge'
        v = {'intro': 0.5, 'A': 0.58, 'B': 0.66, "A'": 0.7, 'bridge': 0.6}[sect]
        name = ch
        if bar in (10, 26):           # F then G in one bar
            ostinato(sc, 'spicc', bar, 'F', [0, 1, 2, 1], 53, 72, v)
            ostinato(sc, 'spicc', bar, 'G', [0, 0, 0, 0, 0, 1, 2, 1], 55, 74, v)
            sc.note('bass', bar * 4, 2, 'F2', 0.6); sc.note('bass', bar * 4 + 2, 2, 'G2', 0.6)
        else:
            ostinato(sc, 'spicc', bar, name, [0, 1, 2, 1, 0, 1, 2, 1], 48, 72, v)
            bassline(sc, 'bass', bar, name, 36, 0.62)
        # timpani on one and three
        bass, _, _ = chord(name)
        sc.note('timp', bar * 4, 1, near(bass, 41, 53), 0.55 if sect != 'intro' else 0.45)
        if sect in ('B', "A'"):
            sc.note('timp', bar * 4 + 2, 1, near((bass + 7) % 12, 41, 53), 0.45)
            pad(sc, 'strings', bar, name, 60, 76, 0.42)
            for b in (1, 3):
                sc.drum('snare', bar * 4 + b, 0.55)
            sc.drum('snare', bar * 4 + 3.5, 0.3)
        if sect == 'B':
            pad(sc, 'horn', bar, name, 50, 62, 0.42)
            pad(sc, 'choir', bar, name, 57, 69, 0.38)
        if sect == "A'":
            sc.note('cello', bar * 4, 4, near(bass, 48, 59), 0.5)
    # melody A: the horns, then the whole band
    melA = ['G4:1 C5:1.5 D5:0.5 E5:1', 'E5:2 D5:1 C5:1', 'A4:1.5 C5:0.5 F5:2', 'E5:1 D5:1 B4:1 D5:1',
            'G4:1 C5:1.5 D5:0.5 E5:1', 'E5:1.5 G5:0.5 A5:2', 'F5:1 E5:1 D5:1 G5:1', 'E5:0.5 D5:0.5 C5:3']
    for i, ln in enumerate(melA):
        sc.line('horn', (4 + i) * 4, ln, 0.78)
        sc.line('trumpet', (20 + i) * 4, ln, 0.74)
        sc.line('horn', (20 + i) * 4, ln, 0.6, shift=-12)
        sc.line('glock', (20 + i) * 4, ln, 0.35, shift=12)
    melB = ['C5:1 F5:1 A5:2', 'B5:1.5 A5:0.5 G5:2', 'G5:1 E5:1 B5:2', 'A5:3 r:1',
            'A5:1 C6:1 A5:1 F5:1', 'G5:1.5 B5:0.5 D6:2', 'C6:1 Ab5:1 Eb5:2', 'D5:1 F5:1 Bb5:2']
    for i, ln in enumerate(melB):
        sc.line('trumpet', (12 + i) * 4, ln, 0.78)
        sc.line('strings', (12 + i) * 4, ln, 0.4, shift=-12)
    # the bridge: horns hold, timpani builds, back to the top
    for i, ln in enumerate(['G4:4', 'C5:4', 'D5:4', 'B4:2 D5:2']):
        sc.line('horn', (28 + i) * 4, ln, 0.6)
    roll(sc, 'timp', 30 * 4, 8, 'G2', 0.3, 0.75)
    snare_roll(sc, 31 * 4, 4, 0.2, 0.7)
    # swells and crashes into each section
    for bar in (4, 12, 20):
        sc.note('revcym', bar * 4, 0.1, 'C4', 0.7)
        sc.drum('crash', bar * 4, 0.8)
        sc.note('harp', bar * 4 - 2, 0.125, 'C5', 0.4)
    for i, p in enumerate(['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5', 'C6', 'D6']):
        sc.note('harp', 3 * 4 + 2 + i * 0.125, 0.5, p, 0.45)
    snare_roll(sc, 11 * 4 + 3, 1, 0.25, 0.6)
    snare_roll(sc, 19 * 4 + 3, 1, 0.25, 0.6)
    return sc


def starlight():
    """Option 2: wonder. Celesta and harp turning over, a flute tune, strings
    and choir. D Lydian, 88 bpm."""
    sc = Score(88, 24, seed=22)
    prog = ['D', 'E/D', 'Bm', 'G', 'D', 'E/D', 'G', 'A',
            'Bm', 'G', 'D', 'A', 'Bm', 'G', 'Em', 'A',
            'D', 'E/D', 'G', 'A', 'D', 'E/D', 'Gm', 'A']
    for bar, ch in enumerate(prog):
        bass, pcs, root = chord(ch)
        ostinato(sc, 'celesta', bar, ch, [0, 1, 2, 3, 4, 3, 2, 1], 72, 92, 0.42, dur=0.5)
        ostinato(sc, 'harp', bar, ch, [-1, 0, 1, 2], 50, 66, 0.5, step=1, dur=1)
        if bar >= 4:
            pad(sc, 'strings', bar, ch, 57, 71, 0.34)
        if bar >= 8:
            sc.note('pizz', bar * 4, 1, near(bass, 38, 49), 0.6)
            sc.note('pizz', bar * 4 + 2, 1, near((bass + 7) % 12 if '/' not in ch else bass, 38, 49), 0.5)
            sc.note('bass', bar * 4, 4, near(bass, 26, 37), 0.38)
        if 8 <= bar < 16:
            pad(sc, 'choir', bar, ch, 57, 69, 0.36)
    flute = ['A5:2 F#5:1 A5:1', 'G#5:1.5 F#5:0.5 E5:2', 'F#5:1 D5:1 B4:2', 'D5:3 E5:1',
             'A5:2 B5:1 C#6:1', 'D6:1.5 C#6:0.5 B5:2', 'B5:1 A5:1 G5:1 F#5:1', 'E5:4',
             'D6:2 C#6:1 B5:1', 'B5:1.5 A5:0.5 G5:2', 'A5:2 F#5:1 D5:1', 'E5:3 C#5:1',
             'D5:1 F#5:1 B5:2', 'A5:1 G5:1 D5:2', 'E5:1 G5:1 B5:1 E6:1', 'C#6:4']
    for i, ln in enumerate(flute):
        sc.line('flute', i * 4, ln, 0.72)
        if i >= 8:
            sc.line('strings', i * 4, ln, 0.34, shift=-12)
    for i, ln in enumerate(['F#4:4', 'G#4:4', 'B4:4', 'A4:2 C#5:2', 'D5:4', 'B4:4', 'Bb4:4', 'A4:4']):
        sc.line('horn', (16 + i) * 4, ln, 0.5)
    for bar in (7, 15, 23):
        for k, p in enumerate(['A6', 'C#7', 'E7', 'A7']):
            sc.note('glock', bar * 4 + 2 + k * 0.5, 0.5, p, 0.35)
    for bar in (8, 16):
        roll(sc, 'timp', bar * 4 - 2, 2, 'A2', 0.15, 0.45)
        sc.note('revcym', bar * 4, 0.1, 'C4', 0.45)
    return sc


def hyperdrive():
    """Option 3: driving adventure. Strings hammering eighths, taiko, low
    brass, horns and trumpets on top. D minor, 132 bpm."""
    sc = Score(132, 32, seed=33)
    prog = (['Dm', 'Bb', 'F', 'C'] +
            ['Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'F', 'Dm'] +
            ['Gm', 'Bb', 'Dm', 'A', 'Gm', 'Bb', 'Dm', 'A'] +
            ['Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'F', 'Dm'] +
            ['Dm', 'Bb', 'C', 'A'])
    for bar, ch in enumerate(prog):
        sect = 'intro' if bar < 4 else 'A' if bar < 12 else 'B' if bar < 20 else "A'" if bar < 28 else 'break'
        bass, pcs, root = chord(ch)
        v = {'intro': 0.55, 'A': 0.62, 'B': 0.68, "A'": 0.72, 'break': 0.6}[sect]
        ostinato(sc, 'spicc', bar, ch, [0, 0, 2, 0, 1, 0, 2, 0], 50, 69, v)
        # taiko: the engine
        for b, tv in ((0, 0.85), (1.5, 0.55), (2, 0.75), (3, 0.5), (3.5, 0.6)):
            sc.note('taiko', bar * 4 + b, 0.5, 'C3' if b in (0, 2) else 'G3', tv * (0.85 if sect == 'intro' else 1))
        sc.note('timp', bar * 4, 1, near(bass, 41, 53), 0.55)
        if sect != 'intro':
            r = near(root, 36, 47)
            for b, d, off in ((0, 1.5, 0), (1.5, 0.5, 0), (2, 1, 0), (3, 0.5, 7), (3.5, 0.5, 12)):
                sc.note('trombone', bar * 4 + b, d * 0.9, r + off, 0.62)
                sc.note('tuba', bar * 4 + b, d * 0.9, r + off - 12, 0.5)
            sc.note('bass', bar * 4, 4, near(bass, 26, 37), 0.5)
        if sect in ('B', "A'"):
            pad(sc, 'strings', bar, ch, 62, 77, 0.4)
            sc.drum('snare', bar * 4 + 1, 0.6)
            sc.drum('snare', bar * 4 + 3, 0.6)
            sc.drum('snare', bar * 4 + 3.75, 0.3)
        if sect == 'B':
            pad(sc, 'choir', bar, ch, 57, 69, 0.4)
    melA = ['D5:1.5 A4:0.5 D5:1 E5:1', 'F5:2 E5:1 D5:1', 'C5:1.5 A4:0.5 C5:1 D5:1', 'E5:3 C5:1',
            'D5:1.5 A4:0.5 D5:1 F5:1', 'G5:2 F5:1 E5:1', 'F5:1 E5:1 D5:1 C5:1', 'D5:4']
    for i, ln in enumerate(melA):
        sc.line('horn', (4 + i) * 4, ln, 0.8)
        sc.line('trumpet', (20 + i) * 4, ln, 0.78)
        sc.line('horn', (20 + i) * 4, ln, 0.62, shift=-12)
    melB = ['Bb5:2 A5:1 G5:1', 'F5:2 D5:2', 'F5:1.5 E5:0.5 F5:1 A5:1', 'E5:2 C#5:2',
            'G5:1 Bb5:1 D6:2', 'C6:1 Bb5:1 F5:2', 'A5:1 F5:1 E5:1 D5:1', 'C#5:2 E5:2']
    for i, ln in enumerate(melB):
        sc.line('trumpet', (12 + i) * 4, ln, 0.8)
    for bar in (4, 12, 20):
        sc.note('revcym', bar * 4, 0.1, 'C4', 0.7)
        sc.drum('crash', bar * 4, 0.85)
    for bar in range(28, 32):
        for k in range(8):
            sc.note('taiko', bar * 4 + k * 0.5, 0.5, 'G3', 0.35 + 0.08 * (bar - 28) + 0.02 * k)
    snare_roll(sc, 30 * 4, 8, 0.15, 0.75)
    roll(sc, 'timp', 31 * 4, 4, 'A2', 0.35, 0.8)
    return sc


def mothership():
    """The boss: low brass grinding, taiko, tremolo strings, choir. E minor,
    144 bpm."""
    sc = Score(144, 24, seed=44)
    prog = ['Em', 'Em', 'C', 'B', 'Em', 'Em', 'C', 'B',
            'Am', 'Em', 'C', 'B', 'Am', 'Em', 'F', 'B',
            'Em', 'C', 'Am', 'B', 'Em', 'C', 'F', 'B']
    for bar, ch in enumerate(prog):
        bass, pcs, root = chord(ch)
        r = near(root, 33, 44)
        for k, off in enumerate([0, 0, 3, 0, 1, 0, -5, 0]):
            sc.note('trombone', bar * 4 + k * 0.5, 0.42, r + off + 12, 0.6)
            sc.note('tuba', bar * 4 + k * 0.5, 0.42, r + off, 0.55)
        pad(sc, 'trem', bar, ch, 52, 67, 0.45)
        for k in range(8):
            sc.note('taiko', bar * 4 + k * 0.5, 0.5, 'C3' if k % 4 == 0 else 'G3', 0.85 if k % 4 == 0 else 0.45)
        if bar % 2 == 1:
            for k in range(4):
                sc.note('taiko', bar * 4 + 3 + k * 0.25, 0.25, 'G3', 0.5 + k * 0.1)
        sc.note('timp', bar * 4, 1, near(bass, 40, 52), 0.65)
        sc.note('timp', bar * 4 + 2, 1, near(bass, 40, 52), 0.5)
        for b in (0, 2.5):
            sc.hold('horn', bar * 4 + b, 0.6, voice(pcs, 52, 64), 0.6)
        if bar >= 8:
            pad(sc, 'choir', bar, ch, 55, 67, 0.42)
            sc.drum('snare', bar * 4 + 1, 0.55)
            sc.drum('snare', bar * 4 + 3, 0.55)
    mel = ['A4:1 C5:1 E5:2', 'B4:1.5 G4:0.5 E4:2', 'C5:1 E5:1 G5:2', 'F#5:3 D#5:1',
           'A5:1.5 G5:0.5 E5:2', 'G5:1 F#5:1 E5:2', 'F5:1 A5:1 C6:2', 'B5:4']
    for i, ln in enumerate(mel):
        sc.line('trumpet', (8 + i) * 4, ln, 0.8)
        sc.line('trumpet', (16 + i) * 4, ln, 0.84)
        sc.line('horn', (16 + i) * 4, ln, 0.6, shift=-12)
    for bar in (8, 16):
        sc.drum('crash', bar * 4, 0.9)
        sc.note('hit', bar * 4, 0.5, 'E4', 0.6)
    snare_roll(sc, 23 * 4, 4, 0.2, 0.75)
    return sc


def hangar():
    """Between launches: piano, soft strings, harp. F major, 76 bpm."""
    sc = Score(76, 16, seed=55)
    prog = ['F', 'C/E', 'Dm', 'Bb', 'F', 'C', 'Bb', 'C',
            'Dm', 'Bb', 'F', 'C', 'Gm', 'Bb', 'Csus', 'C']
    for bar, ch in enumerate(prog):
        bass, pcs, root = chord(ch)
        sc.note('piano', bar * 4, 2, near(bass, 41, 52), 0.5)
        ostinato(sc, 'piano', bar, ch, [0, 1, 2, 1, 2, 1], 53, 69, 0.36, step=0.5, dur=0.6)
        pad(sc, 'strings', bar, ch, 57, 69, 0.28)
        sc.note('bass', bar * 4, 4, near(bass, 29, 40), 0.3)
    mel = ['A5:2 G5:1 F5:1', 'E5:2 G5:2', 'F5:1 E5:1 D5:2', 'D5:3 r:1',
           'C5:1 F5:1 A5:1 C6:1', 'C6:2 G5:2', 'Bb5:1 A5:1 G5:1 F5:1', 'E5:3 r:1',
           'F5:2 A5:2', 'Bb5:2 D6:2', 'C6:1 A5:1 F5:2', 'G5:3 r:1',
           'Bb5:1 A5:1 G5:2', 'F5:1 D5:1 Bb4:2', 'C5:2 F5:2', 'E5:4']
    for i, ln in enumerate(mel):
        sc.line('piano', i * 4, ln, 0.55)
        if i >= 8:
            sc.line('flute', i * 4, ln, 0.4, shift=-12)
    for bar in (3, 7, 11, 15):
        for k, p in enumerate(['F5', 'A5', 'C6', 'F6']):
            sc.note('harp', bar * 4 + 3 + k * 0.25, 0.5, p, 0.35)
    return sc


# ---------------------------------------------------------------- short cues
def cue(bpm, bars, fn, seed=7):
    sc = Score(bpm, bars, seed=seed)
    fn(sc)
    return sc


def c_liftoff(sc):
    roll(sc, 'timp', 0, 1.5, 'C3', 0.25, 0.8)
    sc.line('trumpet', 0, 'G4:0.5 C5:0.5 E5:0.5 G5:2.5', 0.82)
    sc.hold('horn', 1.5, 2.5, ['C4', 'E4', 'G4'], 0.7)
    sc.hold('strings', 1.5, 2.5, ['C4', 'G4', 'C5', 'E5'], 0.6)
    sc.note('hit', 1.5, 0.5, 'C4', 0.7)
    sc.note('bass', 1.5, 2.5, 'C2', 0.7)
    sc.drum('crash', 1.5, 0.9)


def c_space(sc):
    sc.line('trumpet', 0, 'C5:1 D5:1 E5:1 G5:1 C6:4', 0.85)
    sc.line('horn', 0, 'G4:2 B4:2 C5:4', 0.7)
    for b, ch in ((0, 'F'), (2, 'G'), (4, 'C')):
        _, pcs, _ = chord(ch)
        sc.hold('strings', b, 2 if b < 4 else 4, voice(pcs, 55, 72), 0.6)
        sc.hold('choir', b, 2 if b < 4 else 4, voice(pcs, 55, 67), 0.5)
        sc.note('timp', b, 1, near(chord(ch)[0], 41, 52), 0.75)
    sc.note('bass', 4, 4, 'C2', 0.7)
    sc.note('hit', 4, 0.5, 'C4', 0.75)
    sc.drum('crash', 4, 1.0)
    for i, p in enumerate(['C5', 'E5', 'G5', 'C6', 'E6', 'G6', 'C7']):
        sc.note('harp', 3 + i * 0.14, 0.5, p, 0.5)
        sc.note('glock', 4 + i * 0.25, 0.5, p, 0.3)


def c_sector(sc):
    sc.line('horn', 0, 'G4:0.5 C5:0.5 D5:1 G5:2', 0.75)
    sc.hold('strings', 1, 3, ['C4', 'G4', 'D5'], 0.45)
    for i, p in enumerate(['C5', 'D5', 'G5', 'C6', 'D6', 'G6']):
        sc.note('harp', 1 + i * 0.17, 0.5, p, 0.4)
    sc.note('timp', 1, 1, 'G2', 0.5)


def c_victory(sc):
    roll(sc, 'timp', 0, 1, 'G2', 0.3, 0.75)
    sc.line('trumpet', 1, 'G4:0.5 C5:0.5 E5:0.5 G5:1 E5:0.5 G5:0.5 C6:3.5', 0.86)
    sc.line('horn', 1, 'E4:1.5 G4:1 C5:1 E5:3.5', 0.66)
    sc.hold('strings', 1, 3, ['C4', 'G4', 'E5'], 0.55)
    sc.hold('strings', 4, 3.5, ['F4', 'A4', 'C5', 'F5'], 0.5)
    sc.hold('choir', 4, 3.5, ['C4', 'E4', 'G4', 'C5'], 0.5)
    sc.note('hit', 1, 0.5, 'C4', 0.7)
    sc.note('hit', 4, 0.5, 'C4', 0.75)
    sc.drum('crash', 4, 1.0)
    sc.note('bass', 4, 3.5, 'C2', 0.7)


def c_gameover(sc):
    sc.line('horn', 0, 'E5:1 D5:1 C5:1 B4:1 A4:4', 0.62)
    sc.hold('strings', 0, 4, ['A3', 'C4', 'E4'], 0.45)
    sc.hold('strings', 4, 4, ['F3', 'A3', 'C4', 'E4'], 0.42)
    sc.note('cello', 0, 8, 'A2', 0.5)
    sc.note('timp', 0, 1, 'A2', 0.5)
    sc.note('timp', 4, 1, 'F2', 0.4)


def c_record(sc):
    for i, p in enumerate(['C6', 'E6', 'G6', 'C7', 'E7', 'G7']):
        sc.note('celesta', i * 0.25, 0.5, p, 0.5)
        sc.note('glock', 1.5 + i * 0.25, 0.5, p, 0.35)
    sc.line('trumpet', 1.5, 'C5:0.5 E5:0.5 G5:0.5 C6:3', 0.84)
    sc.hold('horn', 1.5, 4.5, ['C4', 'E4', 'G4'], 0.6)
    sc.hold('choir', 3, 3, ['C4', 'E4', 'G4', 'C5'], 0.5)
    sc.note('hit', 3, 0.5, 'C4', 0.7)
    sc.drum('crash', 3, 0.9)


def c_pickup(sc):
    sc.line('celesta', 0, 'C6:0.25 G6:0.5', 0.8)


def c_battery(sc):
    sc.line('glock', 0, 'C6:0.15 E6:0.15 G6:0.15 C7:0.5', 0.85)


def c_gem(sc):
    sc.line('celesta', 0, 'E6:0.2 B6:0.2 E7:0.5', 0.8)


def c_count(sc):
    sc.note('timp', 0, 1, 'G2', 0.85)


def c_go(sc):
    sc.note('hit', 0, 0.5, 'C4', 0.85)
    sc.note('timp', 0, 1, 'C3', 0.9)
    sc.drum('crash', 0, 1.0)


def c_stage(sc):
    sc.note('timp', 0, 1, 'C3', 0.9)
    sc.note('taiko', 0, 1, 'C3', 0.9)
    sc.note('hit', 0.02, 0.5, 'G3', 0.55)


def c_alarm(sc):
    sc.line('trumpet', 0, 'B4:0.3 r:0.1 B4:0.3 r:0.1 B4:0.3', 0.8)
    sc.line('trombone', 0, 'F4:0.3 r:0.1 F4:0.3 r:0.1 F4:0.3', 0.7)


THEMES = {
    'liftoff': ('Liftoff', 'Heroic brass and a marching snare', liftoff),
    'starlight': ('Starlight', 'Celesta, harp and flute - wonder', starlight),
    'hyperdrive': ('Hyperdrive', 'Driving strings, taiko and horns', hyperdrive),
}
LOOPS = {'hangar': hangar, 'mothership': mothership}
CUES = {
    'liftoff-cue': (100, 1, c_liftoff), 'space': (100, 2, c_space), 'sector': (110, 1, c_sector),
    'victory': (120, 2, c_victory), 'gameover': (80, 2, c_gameover), 'record': (110, 2, c_record),
    'pickup': (120, 1, c_pickup), 'battery': (120, 1, c_battery), 'gem': (120, 1, c_gem),
    'count': (120, 1, c_count), 'go': (120, 1, c_go), 'stage': (120, 1, c_stage), 'alarm': (120, 1, c_alarm),
}
EDGE = 0.3        # seconds of wrap-around either side of a loop


def main():
    want = set(sys.argv[1:])
    os.makedirs(OUT, exist_ok=True)
    man_path = os.path.join(OUT, 'music.json')
    man = json.load(open(man_path)) if os.path.exists(man_path) else {'themes': {}, 'loops': {}, 'cues': {}}
    loops = {k: (k, '', fn) for k, fn in LOOPS.items()}
    for kind, table in (('themes', THEMES), ('loops', loops)):
        for key, (title, blurb, fn) in table.items():
            if want and key not in want:
                continue
            sc = fn()
            mix = master(render(sc, loop=True))
            e = int(EDGE * SR)
            body = np.concatenate([mix[-e:], mix, mix[:e]])
            encode(body, os.path.join(OUT, key + '.mp3'))
            entry = {'file': key + '.mp3', 'loopStart': EDGE, 'loopEnd': EDGE + len(mix) / SR, 'bpm': sc.bpm}
            if kind == 'themes':
                entry.update(title=title, blurb=blurb)
            man[kind][key] = entry
            print(f'{key}: {len(mix) / SR:.1f} s loop')
    for key, (bpm, bars, fn) in CUES.items():
        if want and key not in want:
            continue
        sc = cue(bpm, bars, fn)
        quiet = key in ('pickup', 'battery', 'gem', 'count')
        mix = render(sc, tail=2.2 if not quiet else 1.0, loop=False)
        mix = master(mix, rms_target=0.08 if quiet else 0.12)
        encode(mix, os.path.join(OUT, key + '.mp3'))
        man['cues'][key] = {'file': key + '.mp3', 'len': round(len(mix) / SR, 2)}
        print(f'{key}: {len(mix) / SR:.1f} s')
    man['credit'] = 'Instruments: FluidR3 GM soundfont by Frank Wen (CC BY 3.0)'
    json.dump(man, open(man_path, 'w'), indent=1)


if __name__ == '__main__':
    main()
