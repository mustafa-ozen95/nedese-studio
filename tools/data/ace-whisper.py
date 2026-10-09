"""Sozlu ACE-Step ciktilarinda soz dogrulugu: Whisper large-v3 dokumu ile sozler arasinda kelime hata orani.
python ace-whisper.py <klasor> -> whisper.json  (istem 0,1: tr; 4: en; 2,3 enstrumantal)"""
import json
import re
import sys
from pathlib import Path

import whisper

LYRICS = {
    0: ('tr', 'Akşam olunca deniz kenarında Seni düşünürüm sessizce Gel bu gece, kalbim seninle Yıldızlar kadar uzak değilsin'),
    1: ('tr', 'Yollar uzun, dağlar yüksek Yürürüm yine de durmadan Bu toprak benim, bu şarkı senin Ses ver bana uzaklardan'),
    4: ('en', 'City lights are calling out my name Every night we never feel the same Hold on tight, we are dancing in the light Nothing gonna stop us tonight'),
}


def words(s):
    return re.findall(r'[\wçğıöşüâîû]+', s.lower().replace('İ', 'i').replace('I', 'ı'))


def wer(ref, hip):
    r, h = words(ref), words(hip)
    d = [[0] * (len(h) + 1) for _ in range(len(r) + 1)]
    for i in range(len(r) + 1):
        d[i][0] = i
    for j in range(len(h) + 1):
        d[0][j] = j
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] != h[j - 1]))
    return d[len(r)][len(h)] / max(1, len(r))


folder = Path(sys.argv[1])
model = whisper.load_model('large-v3', device='cuda')
result = {}
for wav in sorted(folder.glob('*.wav')):
    m = re.match(r'(turbo|xl)_(\d)_(\d+)', wav.stem)
    if not m or int(m.group(2)) not in LYRICS:
        continue
    language, ref = LYRICS[int(m.group(2))]
    text = model.transcribe(str(wav), language=language, condition_on_previous_text=False)['text'].strip()
    result[wav.stem] = {'wer': round(wer(ref, text), 3), 'duyulan': text}
    print(wav.stem, result[wav.stem]['wer'], text[:100], flush=True)
(folder / 'whisper.json').write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
