# Mouth correction (LatentSync 1.5, 256-pixel face): the mouth of a speaking person is fitted to their own voice.
# The face is cropped and redrawn from the nose to under the chin; eyes and gaze stay outside the mask (the gaze of Wan 2.2 is kept).
# Measured 07.10.2026 (SyncNet LSE-C, higher is better; same clip, same voice): hybrid audio strength 3: 1.28 -> 5.20; strength 2: 2.60 -> 4.24;
# Elif line: 1.94 -> 4.11; mouth-voice offset -6/-4 frames -> 0. A 3.24 s clip ~75 s (model loading included).
# Face finding with MediaPipe (Apache-2.0; the InsightFace models of LatentSync are for non-commercial research only), see patch.py.
#
# Usage (lip\.venv):
#   python mouth.py --video scene.mp4 --output out.mp4 --speaker track1.wav@x0,y0,x1,y1 [--speaker track2.wav@...]
#   Speakers in turn (the input of the second is the output of the first); the model loads once. The audio track must be as
#   long as the video (longer: LatentSync plays the video back and forth, shorter: it cuts): the panel trims the track to the scene.
#   Printed lines: "model loaded (<s> s)", "speaker <n>/<total> done (<s> s)", at the end "mouth done (<s> s)".
import argparse
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
LS = os.path.join(ROOT, "LatentSync")
MODEL = os.environ.get("AI_LATENTSYNC_MODEL") or os.path.join(os.path.dirname(ROOT), "models", "latentsync")
os.environ.setdefault("LS_FACE_MODEL", os.path.join(MODEL, "face_landmarker.task"))
# Model folder (models\latentsync): latentsync_unet.pt, whisper-tiny.pt, sd-vae-ft-mse.safetensors, face_landmarker.task
VAE_SETTING = {
    "act_fn": "silu", "block_out_channels": [128, 256, 512, 512], "down_block_types": ["DownEncoderBlock2D"] * 4, "in_channels": 3,
    "latent_channels": 4, "layers_per_block": 2, "norm_num_groups": 32, "out_channels": 3, "sample_size": 256, "up_block_types": ["UpDecoderBlock2D"] * 4,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--speaker", action="append", required=True, help="voice.wav@x0,y0,x1,y1 (face box, video pixels)")
    ap.add_argument("--step", type=int, default=20)
    ap.add_argument("--guidance", type=float, default=1.5)
    ap.add_argument("--seed", type=int, default=1247)
    a = ap.parse_args()
    speakers = []
    for k in a.speaker:
        voice, _, box = k.rpartition("@")
        if not voice or len(box.split(",")) != 4:
            raise SystemExit(f"a speaker must be voice.wav@x0,y0,x1,y1: {k}")
        speakers.append((os.path.abspath(voice), box))
    video = os.path.abspath(a.video)
    output = os.path.abspath(a.output)
    started = time.time()

    sys.path.insert(0, LS)
    os.chdir(LS)  # LatentSync uses relative paths (configs/, latentsync/utils/mask.png, the "temp" folder of read_video)
    import torch
    from accelerate.utils import set_seed
    from DeepCache import DeepCacheSDHelper
    from diffusers import AutoencoderKL, DDIMScheduler
    from omegaconf import OmegaConf

    from latentsync.models.unet import UNet3DConditionModel
    from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline
    from latentsync.whisper.audio2feature import Audio2Feature

    import json

    setting = OmegaConf.load(os.path.join(LS, "configs", "unet", "stage2.yaml"))
    dtype = torch.float16
    voice_encoder = Audio2Feature(model_path=os.path.join(MODEL, "whisper-tiny.pt"), device="cuda", num_frames=setting.data.num_frames, audio_feat_length=setting.data.audio_feat_length)
    # stabilityai/sd-vae-ft-mse as one file (no subfolder in the model folder): from_pretrained converts the old attention
    # keys, so a temporary folder gets the config + a hard link to the file (same disk; otherwise a copy)
    vae_folder = tempfile.mkdtemp(prefix="aipanel-vae-")
    with open(os.path.join(vae_folder, "config.json"), "w", encoding="utf-8") as f:
        json.dump({"_class_name": "AutoencoderKL", **VAE_SETTING}, f)
    try:
        os.link(os.path.join(MODEL, "sd-vae-ft-mse.safetensors"), os.path.join(vae_folder, "diffusion_pytorch_model.safetensors"))
    except OSError:
        shutil.copyfile(os.path.join(MODEL, "sd-vae-ft-mse.safetensors"), os.path.join(vae_folder, "diffusion_pytorch_model.safetensors"))
    try:
        vae = AutoencoderKL.from_pretrained(vae_folder, torch_dtype=dtype)
    finally:
        shutil.rmtree(vae_folder, ignore_errors=True)
    vae.config.scaling_factor = 0.18215
    vae.config.shift_factor = 0
    unet, _ = UNet3DConditionModel.from_pretrained(OmegaConf.to_container(setting.model), os.path.join(MODEL, "latentsync_unet.pt"), device="cpu")
    pipe = LipsyncPipeline(vae=vae, audio_encoder=voice_encoder, unet=unet.to(dtype=dtype), scheduler=DDIMScheduler.from_pretrained(os.path.join(LS, "configs"))).to("cuda")
    cache = DeepCacheSDHelper(pipe=pipe)
    cache.set_params(cache_interval=3, cache_branch_id=0)
    cache.enable()
    print(f"model loaded ({time.time() - started:.0f} s)", flush=True)

    temp = tempfile.mkdtemp(prefix="nedese-mouth-")
    try:
        current = video
        for n, (voice, box) in enumerate(speakers, 1):
            t = time.time()
            os.environ["LS_TARGET_BOX"] = box  # the face finder is built again on every call and reads the box from here
            step_output = output if n == len(speakers) else os.path.join(temp, f"step{n}.mp4")
            set_seed(a.seed)
            pipe(video_path=current, audio_path=voice, video_out_path=step_output, num_frames=setting.data.num_frames, num_inference_steps=a.step, guidance_scale=a.guidance,
                 weight_dtype=dtype, width=setting.data.resolution, height=setting.data.resolution, mask_image_path=setting.data.mask_image_path, temp_dir=os.path.join(temp, f"job{n}"))
            current = step_output
            print(f"speaker {n}/{len(speakers)} done ({time.time() - t:.0f} s)", flush=True)
    finally:
        shutil.rmtree(temp, ignore_errors=True)
        shutil.rmtree(os.path.join(LS, "temp"), ignore_errors=True)
    print(f"mouth done ({time.time() - started:.0f} s)", flush=True)


if __name__ == "__main__":
    main()
