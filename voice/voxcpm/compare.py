# Chatterbox ile VoxCPM2 ciktilarini Whisper large-v3 ile dinleyip harf hata oranini (CER) olcer.
# Kullanim: ses\.venv\Scripts\python.exe karsilastir.py <klasor>
import re
import sys
import unicodedata

import whisper

SENTENCES = [
    "Kaplumbağa sakin adımlarla denize doğru yürüdü.",
    "Ağaçlığın ötesinde, eski şöminenin ateşi hâlâ yanıyordu.",
    "Öğretmenlerimizden aldığımız öğütleri hiçbir zaman unutmadık.",
    "Gel otur evlat, sana bir efsane anlatayım. Çok eskiden, dağların ardında, ışıklarla örülmüş bir şehir vardı.",
]


def plain(s):
    s = unicodedata.normalize("NFC", s).replace("I", "ı").replace("İ", "i").lower().replace("â", "a")
    return re.sub(r"[^a-zçğıöşü ]", "", s).split()


def cer(a, b):
    a, b = " ".join(plain(a)), " ".join(plain(b))
    d = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        o, d[0] = d[0], i
        for j, y in enumerate(b, 1):
            o, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, o + (x != y))
    return d[len(b)] / max(1, len(a))


folder = sys.argv[1]
stt = whisper.load_model("large-v3", device="cuda")
for model in ("chatterbox", "voxcpm"):
    total = 0
    for i, text in enumerate(SENTENCES, 1):
        needed = stt.transcribe(f"{folder}/{model}_{i}.wav", language="tr", temperature=0)["text"].strip()
        c = cer(text, needed)
        total += c
        print(f"{model:10s} {i} CER {c:.3f} | {needed}", flush=True)
    print(f"{model:10s} ORTALAMA CER {total / len(SENTENCES):.3f}", flush=True)
