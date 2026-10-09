"""A local transcript (Whisper large-v3, RTX 5070): the text + word times.

    python dump.py record.wav [--lang tr] [--output dump.json]

The output JSON: {"text": "...", "words": [[word, start, end], ...]}. To measure how accurate a voice-over is, or to
align subtitles or an edit.
"""
import argparse
import json
from pathlib import Path

import whisper


def main():
    p = argparse.ArgumentParser()
    p.add_argument('record')
    p.add_argument('--lang', default='tr')
    p.add_argument('--output')
    a = p.parse_args()
    model = whisper.load_model('large-v3', device='cuda')
    s = model.transcribe(a.record, language=a.lang, word_timestamps=True, condition_on_previous_text=False)
    result = {
        'text': s['text'].strip(),
        'words': [[w['word'].strip(), round(w['start'], 3), round(w['end'], 3)] for seg in s['segments'] for w in seg['words']],
    }
    output = a.output or str(Path(a.record).with_suffix('.dump.json'))
    Path(output).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding='utf-8')
    print(result['text'])
    print(output)


if __name__ == '__main__':
    main()
