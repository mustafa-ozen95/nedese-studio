"""
The faces in pictures and their five points (YuNet, OpenCV's face detector; ComfyUI's python has OpenCV):
  python face_points.py --model face_detection_yunet_2023mar.onnx --pictures input.png head-input.png

- Each face is [x, y, w, h, right eye x, y, left eye x, y, nose x, y, mouth right x, y, mouth left x, y, score] in
  pixels from the picture's top left corner, the most certain first.
- The result is printed on the last line as "RESULT {json}" ({pictures: [{file, width, height, faces}]}).
"""
import argparse
import json
import os
import sys

import cv2

# A face under this score is not taken (YuNet's own default is 0.9; a 3D generation's input picture of a full-body
# figure, a face ~100 px tall, scored 0.9 at 0.6 with nothing else found, 11.10.2026)
SCORE = 0.6


def args():
    p = argparse.ArgumentParser(description='Faces and their five points (YuNet)')
    p.add_argument('--model', required=True, help='face_detection_yunet_2023mar.onnx')
    p.add_argument('--pictures', nargs='+', required=True, help='pictures (PNG, JPEG)')
    return p.parse_args()


def main():
    a = args()
    result = {'pictures': []}
    for path in a.pictures:
        image = cv2.imread(path)
        if image is None:
            print(f'ERROR: cannot read {path}', flush=True)
            sys.exit(1)
        height, width = image.shape[:2]
        detector = cv2.FaceDetectorYN.create(a.model, '', (width, height), SCORE, 0.3, 50)
        _, faces = detector.detect(image)
        rows = sorted(([round(float(v), 1) for v in f] for f in (faces if faces is not None else [])), key=lambda f: -f[14])
        result['pictures'].append({'file': os.path.basename(path), 'width': width, 'height': height, 'faces': rows})
        print(f'{os.path.basename(path)}: {len(rows)} face(s)', flush=True)
    print('RESULT ' + json.dumps(result))


main()
