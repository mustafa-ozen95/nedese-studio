# Adapts LatentSync to this installation (setup.ps1 runs it after downloading the code; running it again changes nothing).
# 1) No decord (no Python 3.14 wheel on Windows): video is read with cv2, audio with librosa.
# 2) Face finding with MediaPipe Face Landmarker (Apache-2.0) instead of InsightFace; the InsightFace models are for
#    non-commercial research only. LatentSync aligns with three points (the middle of both eyebrows, the middle of the
#    nose); only those places of the 106-point array are filled. The target face is chosen with LS_TARGET_BOX="x0,y0,x1,y1"
#    (the speaker in a two-person scene). Where no face is found in a frame the points of the previous frame are used (one
#    frame must not fail the whole job).
import pathlib

K = pathlib.Path(__file__).parent / "LatentSync" / "latentsync" / "utils"


def change(file, old, fresh, legacy=()):
    """Replaces old with fresh once. An earlier version of fresh (legacy, written by an older patch.py) is updated."""
    s = file.read_text(encoding="utf-8")
    if fresh in s:
        return
    for earlier in legacy:
        if earlier in s:
            file.write_text(s.replace(earlier, fresh), encoding="utf-8")
            return
    if s.count(old) != 1:
        raise SystemExit(f"{file.name}: expected line found {s.count(old)} times: {old[:60]!r}")
    file.write_text(s.replace(old, fresh), encoding="utf-8")


u = K / "util.py"
change(
    u,
    "from decord import AudioReader, VideoReader\n",
    "try:\n    from decord import AudioReader, VideoReader\nexcept ImportError:  # Nedese Studio: no decord\n    AudioReader = VideoReader = None\n",
    ["try:\n    from decord import AudioReader, VideoReader\nexcept ImportError:  # AI Panel: decord yok\n    AudioReader = VideoReader = None\n"],
)
change(u, "def read_video(video_path: str, change_fps=True, use_decord=True):", "def read_video(video_path: str, change_fps=True, use_decord=VideoReader is not None):")
change(
    u,
    "    ar = AudioReader(audio_path, sample_rate=audio_sample_rate, mono=True)\n\n    # To access the audio samples\n    audio_samples = torch.from_numpy(ar[:].asnumpy())\n    audio_samples = audio_samples.squeeze(0)\n",
    "    if AudioReader is None:  # Nedese Studio: soundfile + librosa\n        import librosa\n\n        x, _ = librosa.load(audio_path, sr=audio_sample_rate, mono=True)\n        return torch.from_numpy(x)\n    ar = AudioReader(audio_path, sample_rate=audio_sample_rate, mono=True)\n\n    # To access the audio samples\n    audio_samples = torch.from_numpy(ar[:].asnumpy())\n    audio_samples = audio_samples.squeeze(0)\n",
    ["    if AudioReader is None:  # AI Panel: soundfile + librosa\n        import librosa\n\n        x, _ = librosa.load(audio_path, sr=audio_sample_rate, mono=True)\n        return torch.from_numpy(x)\n    ar = AudioReader(audio_path, sample_rate=audio_sample_rate, mono=True)\n\n    # To access the audio samples\n    audio_samples = torch.from_numpy(ar[:].asnumpy())\n    audio_samples = audio_samples.squeeze(0)\n"],
)

# 3) ffmpeg commands as an argument list and check=True: an unquoted path (folder with spaces, %TEMP%) made ffmpeg fail
#    silently and cv2 returned an empty array. The input is already 25 fps (written by the panel's mouth.mjs): not encoded
#    again; the final mux copies the video (two full x264 encodes per speaker and the generation loss are gone).
change(
    u,
    '''        command = (
            f"ffmpeg -loglevel error -y -nostdin -i {video_path} -r 25 -crf 18 {os.path.join(temp_dir, 'video.mp4')}"
        )
        subprocess.run(command, shell=True)''',
    '''        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-nostdin", "-i", video_path, "-r", "25", "-crf", "18", os.path.join(temp_dir, "video.mp4")], check=True)  # Nedese Studio''',
    ['''        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-nostdin", "-i", video_path, "-r", "25", "-crf", "18", os.path.join(temp_dir, "video.mp4")], check=True)  # AI Panel'''],
)
p = K.parent / "pipelines" / "lipsync_pipeline.py"
change(
    p,
    "        video_frames = read_video(video_path, use_decord=False)",
    "        video_frames = read_video(video_path, change_fps=False, use_decord=False)  # Nedese Studio: input is 25 fps",
    ["        video_frames = read_video(video_path, change_fps=False, use_decord=False)  # AI Panel: girdi 25 fps"],
)
change(
    p,
    '''        command = f"ffmpeg -y -loglevel error -nostdin -i {os.path.join(temp_dir, 'video.mp4')} -i {os.path.join(temp_dir, 'audio.wav')} -c:v libx264 -crf 18 -c:a aac -q:v 0 -q:a 0 {video_out_path}"
        subprocess.run(command, shell=True)''',
    '''        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-nostdin", "-i", os.path.join(temp_dir, "video.mp4"), "-i", os.path.join(temp_dir, "audio.wav"), "-c:v", "copy", "-c:a", "aac", "-q:a", "0", video_out_path], check=True)  # Nedese Studio''',
    ['''        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-nostdin", "-i", os.path.join(temp_dir, "video.mp4"), "-i", os.path.join(temp_dir, "audio.wav"), "-c:v", "copy", "-c:a", "aac", "-q:a", "0", video_out_path], check=True)  # AI Panel'''],
)

(K / "face_detector.py").write_text(
    '''# Nedese Studio: MediaPipe Face Landmarker (Apache-2.0) instead of InsightFace, see lip\\\\patch.py.
import os

import mediapipe as mp
import numpy as np
from mediapipe.tasks import python as mpp
from mediapipe.tasks.python import vision

MODEL = os.environ.get("LS_FACE_MODEL") or "face_landmarker.task"
BROW_A = [70, 63, 105, 66, 107]
BROW_B = [300, 293, 334, 296, 336]
NOSE = [197, 195, 5, 4]


class FaceDetector:
    def __init__(self, device="cuda"):
        options = vision.FaceLandmarkerOptions(
            base_options=mpp.BaseOptions(model_asset_path=os.path.abspath(os.environ.get("LS_FACE_MODEL") or MODEL)),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=4,
            min_face_detection_confidence=0.3,
            min_face_presence_confidence=0.3,
        )
        self.landmarker = vision.FaceLandmarker.create_from_options(options)
        box = os.environ.get("LS_TARGET_BOX")
        self.target = [float(v) for v in box.split(",")] if box else None
        self.last = None

    def __call__(self, frame, threshold=0.5):
        h, w, _ = frame.shape
        result = self.landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(frame)))
        if not result.face_landmarks:
            return self.last if self.last else (None, None)
        candidates = []
        for face in result.face_landmarks:
            p = np.array([[n.x * w, n.y * h] for n in face])
            candidates.append((p, [*p.min(0), *p.max(0)]))
        if self.target:
            x0, y0, x1, y1 = self.target
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            # A candidate only when its center is inside the target box (widened by half on every side): when the
            # speaker's face is not found in this frame but the listener's is, the listener's mouth must not be drawn
            # with the speaker's voice; the previous frame is used.
            pw, ph = (x1 - x0) / 2, (y1 - y0) / 2
            inside = [c for c in candidates if x0 - pw <= (c[1][0] + c[1][2]) / 2 <= x1 + pw and y0 - ph <= (c[1][1] + c[1][3]) / 2 <= y1 + ph]
            if not inside and self.last:
                return self.last
            p, box = min(inside or candidates, key=lambda c: ((c[1][0] + c[1][2]) / 2 - cx) ** 2 + ((c[1][1] + c[1][3]) / 2 - cy) ** 2)
        else:
            p, box = max(candidates, key=lambda c: (c[1][2] - c[1][0]) * (c[1][3] - c[1][1]))
        a, b = p[BROW_A].mean(0), p[BROW_B].mean(0)
        left, right = (a, b) if a[0] <= b[0] else (b, a)
        lmk = np.zeros((106, 2))
        lmk[[43, 48, 49, 51, 50]] = left
        lmk[101:106] = right
        lmk[[74, 77, 83, 86]] = p[NOSE].mean(0)
        self.last = (np.array(box).astype(np.int_), lmk)
        return self.last
''',
    encoding="utf-8",
)
print("LatentSync patch done")
