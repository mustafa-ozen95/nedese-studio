# Nedese Studio guide (local AI system, measured on an RTX 5070)

User, 29.09.2026: *"Let's build a ready-made AI system right away; we'll use it later as the need arises."*
Image, video, narration and transcription run entirely on this computer, without sending data to the internet.
All models are licensed **for commercial use** (Apache 2.0 / MIT).

## Hardware and limits

| | |
|---|---|
| Graphics card | NVIDIA RTX 5070, **12 GB VRAM** (Blackwell, driver 596) |
| RAM | **16 GB** — the real bottleneck. Large models are loaded in pieces; closing Chrome during generation noticeably increases speed |
| Disk | Models ~77 GB (`models\`) |

## Starting

```
Desktop > Nedese Studio (Nedese Studio.vbs, tray)  → http://127.0.0.1:1071 (easy use: "Panel" below)
<install folder>\start_comfyui.bat                   → http://127.0.0.1:8188 (UI + API)
```
The flags are tuned for the machine (`--disable-pinned-memory --disable-dynamic-vram --cache-none --use-sage-attention`):
with pinned memory, loading the Wan text encoder crashed with an *access violation* (measured).

## Command-line tools (`tools\`, Node)

| Job | Command | Duration (5070) |
|---|---|---|
| Image (strongest) | `node tools\image.mjs "prompt" output.png [--width 1664 --height 928 --seed 42]` | ~65 s |
| Image (fast) | `node tools\image.mjs "prompt" output.png --fast` | ~16 s |
| Frame to video | `node tools\video.mjs frame.png "motion" folder [--smooth 3]` | 720p 5 s ≈ 6 min (SageAttention) |

Prompts work best in English. Projects import the shared client:
`import { run, qwenJob, wan14Job } from 'file:///<install folder>/tools/comfy.mjs'`.

## Voice (`voice\`, separate Python 3.14 environment)

| Job | Command |
|---|---|
| Turkish narration (voice cloning) | `voice\speak.bat --text "Merhaba." --reference ref.wav --output merhaba.wav` |
| Many lines, best take selection | `voice\speak.bat --job job.json --folder output --trial 3` (Whisper transcribes every take, the one closest to the text is chosen) |
| Transcription + word timings | `voice\.venv\Scripts\python.exe voice\dump.py recording.wav` |

| More natural narration (recommended) | `voice\speak.bat --job job.json --folder output --trial 6 --vary --naturalness` — every take uses different settings; among the correctly read ones the highest UTMOS naturalness score wins; a syllable made up at the end is cut using Whisper word timings and listened to again |
| Splitting a short line out of a sentence | `voice\.venv\Scripts\python.exe voice\divide.py take.wav "first part" one.wav two.wav` — when a short line like "O gün…" is read on its own the model makes things up; read "O gün… Bugündür!" and split at the quietest moment (if the boundary is not below −40 dBFS, pick another take) |
| Voice design from a description (old, deep, raspy…) | `voice\design\.venv\Scripts\python.exe voice\design\design.py --spec "A very old man…" --text "Come, sit…" --output timbre.wav --count 3` |
| English etc. narration, the most natural way | read the WHOLE text in one breath with `design.py --spec @spec.txt --text @text.txt --output read.wav --count 2` (UTMOS ~4.4; Turkish clone ~3.8), then split it into lines with `voice\.venv\Scripts\python.exe voice\lines.py read.wav narration.json lines\ --lang en [--device cpu --model small.en]` |
| Re-reading a missing line with the same voice | `voice\design\.venv\Scripts\python.exe voice\design\clone.py --reference ref10s.wav --reference-text "…" --text "…" --output x.wav --count 6` (Qwen3-TTS Base clone; VoiceDesign changes the timbre on every generation) |
| Timbre conversion (words stay, voice changes) | `voice\.venv\Scripts\python.exe voice\convert.py source.wav target_timbre.wav output.wav` (batch with `--folder`) |
| Measurement (pitch, timbre, transcription) | `voice\.venv\Scripts\python.exe voice\measure.py a.wav b.wav [--dump --lang tr]` |

Reference: ~10 s of clean speech (the timbre to clone). If a timbre the Turkish model does not have is needed (old grandfather,
giant, witch…), first generate an English timbre from a description with Qwen3-TTS VoiceDesign, then give it to Chatterbox as the reference;
the Turkish narration comes out with that timbre. The design model does not know Turkish; it lives in a separate environment (`voice\design\.venv`,
Python 3.13, pinned to transformers 4.57.3, conflicts with Chatterbox). `exaggeration` (0.25–2) is the emotion intensity; a low `cfg` (0–1) gives
a slower, more measured reading. Write foreign words like "Prime" the way they are pronounced ("Praym").
The voice environment is **separate** from ComfyUI: Chatterbox pins PyTorch to 2.6 on Python ≤3.13, which does not recognise the RTX 50 series.

### Character voices (Film dialogue, 07.10.2026)

**Input.**
- In the scene card's "Dialogue" field every line is written as "Name: words".
- Every speaking name appears in the film form's "Characters" list with gender and age.
- The scene writer (local Gemma) writes the characters and the lines too.

**Voice selection.** In order:
1. The voice chosen by the user.
2. The previous voice of a character with the same name in the library (the same voice throughout a series).
3. A library voice whose gender and age match. The narrator's voice, the user's own recordings and voices with a LoRA are excluded from this choice.
4. If none, a new voice is designed from a description with VoxCPM2. It is added to the library with the `gender`, `age` and `character` fields.

**Candidate selection in design (08.10.2026).** The same description came out very different depending on the seed (measured 07.10: child probability
0.51 / 0.78 / 0.99; Elif, designed neutrally, was at the adult-female border with 234 Hz). Now `voice\voxcpm\description.py` generates
**3 seeds** for a character voice, measures each candidate and picks the one closest to the target (`--candidate 3 --target --gender --type --separate --report`):
- pitch: pYIN F0 median; age/gender: the audeering wav2vec2 age-gender model (CC BY-NC-SA 4.0, measurement only; the software
  is not free/commercial); separation: WavLM-SV x-vector cosine (MIT), against the other character voices and the narrator in the same film.
- Score: human child → child probability ×2 + closeness of the pitch to 280 Hz; animal → closeness of the pitch to 380 Hz ×2 + "not human";
  adult → gender probability ×2 + closeness to the age target (young 22, adult 40, old 68); −0.5 if the pitch is outside expectation;
  −1 if the similarity is 0.94 or above (WavLM; calibration: ECAPA 0.27-0.35 distinct pairs → 0.88-0.90, confusable 0.74-0.87 → 0.96-0.99).
- Real run (08.10): Elif's description seed 101 → 234 Hz, 202 → **287 Hz, child 0.97** (chosen), 303 → 259 Hz. Pamuk (animal,
  separation against Elif): 101 → 253 Hz, adult-like (child 0.26; this was the old library voice), 202 → 377 Hz male 0.65,
  303 → **594 Hz, child 0.98, similarity to Elif 0.89** (chosen). Generation ~8-13 s/candidate.
- The chosen candidate's measurement is stored in the library record as `measurement` (seed, f0, age, child, female, male, similarity, score); the candidates
  are in the log ("Voice design candidates: … → chosen seed N"), the report in `character-voices\<name>\report.json`.
- The models are downloaded by `setup.bat` (`voice-models.py voxcpm`); measurement runs on the CPU (~1 s/candidate).

**Type (human / animal).** A speaking animal's voice is separated from the humans in the same film:
- Why: when the cat Pamuk was designed with a "little girl" description, a 494 Hz girl voice came out, and Elif was 445-513 Hz. User: "Is it the cat
  talking or Elif, they're mixed up".
- "Type" is chosen in the character list; the scene writer writes it too. If missing, it is inferred from the description ("kitten", "cat", "dog"…).
- An animal only gets a library voice with `type: animal`; a human never gets an animal voice.
- An animal voice is designed with the description "cartoon animal, not a human child"; the pitch-range check is not applied to animals.

**Narration.**
- Every line is read with its own voice (`reference` in the `job.json` line); the lines are joined into the scene audio with 0.3 s gaps.
- The pitch of the chosen take (F0, pYIN median) is measured. The log says "suitable" or "deeper/thinner than expected".
  - Ranges: male 70-175 Hz, female 150-350 Hz, child 200-600 Hz.
  - Measured examples (real dialogue film):
    - narrator C2 90-94 Hz;
    - Father (A2 from the library) 110 Hz;
    - designed little girl 445 Hz (normal), 513 Hz (calling out);
    - cat 494 Hz;
    - EMA Lightning female voice ~233 Hz.
- In the subtitles a line starts with the speaker's name ("Elif: …").

## Local text model (`llm\`, llama.cpp)

- `llm\bin\`: llama.cpp `llama-server` (ggml-org/llama.cpp b11392, Windows CUDA 13.4).
- `llm\bin-prism\`: PrismML's llama.cpp build (PrismML-Eng/llama.cpp prism-b10754-2459f68, Windows CUDA 12.4); the PQ2_0 and PTQ1_0 quantizations load only here, the panel picks this server for them.
- `llm\models\Ternary-Bonsai-2-27B-PQ2_0.gguf`: PrismML Ternary Bonsai 2 27B, PQ2_0 (6.71 GiB), **the default** when nothing is chosen in Settings > Text model; its vision encoder (BF16) is `mmproj-Ternary-Bonsai-2-27B-PQ2_0.gguf`. Measured 08.10.2026: 65 tokens/s on the 12 GB card.
- `llm\models\gemma-4-26B-qat-q4_0.gguf`: Google Gemma 4 26B-A4B, official QAT Q4_0 (Apache 2.0, 13.45 GiB).
  - Mixture of experts; the expert layers that do not fit on the card stay in RAM (`--n-cpu-moe`, from the file size).
  - Can be changed under Settings > Text model.
- `llm\models\mmproj-gemma-4-26B-qat-q4_0.gguf`: Gemma's image encoder (official, 1.11 GiB). If `mmproj-<name>` sits next to the model file, the model "understands images": llama-server is started with `--mmproj`, and the `image_url` part of a `/llm/v1/chat/completions` request is read. If it is deleted, the model reads text only.
  - The encoder's placement is in `llamaConfig`: on the CPU for a MoE model (`--no-mmproj-offload`); for a dense model on the graphics card if it fits in the 10.8 GB budget together with the context and KV.
  - Measured (05.10.2026, Gemma 26B): with the encoder on the card 14 expert layers drop to RAM, text 51.7 → 43.3 tokens/s, image reply 4.4 s. On the CPU the text speed is kept (51.5), image reply 18 s. The CPU was chosen because the bots' workload is mostly text.
- Measured (04.10.2026, with the exact prompts the nedese bot sends to DeepSeek):
  - Translation at DeepSeek quality; ~35 s per call (~61 tokens/s).
  - Original writing from a source 550–850 words; DeepSeek writes ~1000 words and its structure is more analytical.
  - Eliminated:
    - Gemma 4 12B: insufficient at original writing.
    - 26B IQ4_XS: 2.4× slower.
    - Turkish-pruned 26B: writes far too short.
    - Qwen3.6-35B IQ3: weak Turkish.
- The panel manages it:
  - Starts it when a request arrives.
  - Stops it when an image/video/voice job starts; the graphics card and RAM are shared with ComfyUI.
  - Stops it after 5 min idle.
  - An external request arriving while a job is running waits until the job finishes (at most ~5.5 min, then 503; the nedese bot then falls back to DeepSeek).
  - In a job that uses the text model itself (data collection, image description: `textModelShares`) external requests do not wait; the same model is shared in turn.
- OpenAI-compatible address: `http://<this-computer>:1071/llm/v1` (`/responses`, `/chat/completions`, `/models`).
  - Key: the panel API key (Bearer).
  - `/responses` works internally by forcing the JSON format (DeepSeekClient format).
  - `/responses` thinks first (default 3072 tokens; `reasoning.effort`: none/low/medium/high).
    Without thinking it diverged from DeepSeek on decision/control prompts: the section writer always said "already exists", the checker skipped `reason`.
    Sectioned articles (`metadata.sectioned`), `/chat/completions` and prompt translation do not think.
  - `/responses` temperature is capped at 0.3: at 0.7 with thinking it corrupted words while copying long text ("Konfor" → "Konfer").
  - A length note is added to the system prompt (it kept the section/paragraph count short).
  - If a script absent from the input (e.g. Hangul) leaks into the output, it retries once without thinking.
  - Context 32k, single slot; concurrent requests are processed in turn. 11 of the expert layers are in RAM (~0.9 GB share on the card; when it overflowed the speed dropped to ~4 tokens/s).
- In the panel, Single > Text uses this model (fix, translate, summarise, rewrite).
- All text work is done only with this model: prompt translation, motion prompts, the scene writer, the lyric writer, the music plan and the edit plan (`panel\lib\text-model.mjs`). The call to an external command-line assistant was removed on 07.10.2026 (user: it must run on the models the panel itself owns). Because the panel has no login, anyone opening it from the local network could have used that external session on this computer. While a film is being generated the scene writer waits for the graphics card to become free; it appears in the Queue as a side task and can be cancelled. Measurement: 4 scenes 45 s (including model loading).

## Model training (`training\`, separate Python 3.13 environment)

The **Training** tab in the panel (API: `type: "training"`, `POST /uploads/data`, `GET /training`). Trains the text model on your own texts; the result goes into `llm\models\` as GGUF and is selected under Settings > Text model (or with "Use as text model" on the result).

| Method | What it does | Measured (RTX 5070 12 GB) |
|---|---|---|
| Improve an existing one (fine-tuning) | A ready base (Qwen3 14B recommended, 8B, 4B Instruct, 1.7B or another Hugging Face text model) is loaded in 4-bit and a LoRA is trained (QLoRA); the LoRA is streamed from disk, merged with the bf16 base and converted to GGUF, the merged copy is deleted (the LoRA is kept) | Qwen3 1.7B, 84k tokens: 7 steps 125 s, Q4_K_M 1.03 GiB, ~340 tokens/s. Qwen3 14B: below |
| Improve a model trained here | The LoRA of a fine-tuned model continues training on the same base; a model trained from scratch continues training all its weights with its own vocabulary | — |
| Train from scratch | SentencePiece vocabulary from the data (BPE, byte fallback) + Llama architecture: small ~30M, medium ~100M, large ~240M parameters | Small, 83k tokens: 18 s (it cannot write meaningfully with this much data; a few MB of text are needed) |

- Data: TXT/MD/HTML plain text (style and knowledge), JSONL/JSON/CSV question-answer: `{"prompt","response"}`, `{"messages":[…]}` or CSV `question,answer`. In chat examples only the last assistant reply is taught.
- Stages: `train.py prepare` → `fine`/`scratch` → `example` → `gguf` (the llama.cpp b11392 converter in `training\converter\` + `llm\bin\llama-quantize.exe`). When an interrupted job is retried, finished stages are skipped.
- **Pause / resume:** the training loop writes a checkpoint about every 2 minutes (on 14B at every step) (`training\models\<id>\checkpoint.pt`: trained weights, optimizer, scheduler, data order, randomness; first as `.writing`, fsync, then rename). **Pause** in the panel stops the process (the graphics card and RAM are freed, status `paused`); **Resume** continues from the last completed step on the same trajectory. Closing the panel/computer and a power cut are recovered the same way. A checkpoint is only resumed with the same data and settings (signature). API: `POST /jobs/{id}/pause`, `/jobs/{id}/retry`.
- **Disk:** the GGUF stage looks at the free space: if enough, the f16 intermediate file and the merged HF copy are kept until the GGUF is done (no re-merge on a retry); if not, a q8_0 intermediate file (`--allow-requantize`, the difference is negligible) and/or the HF copy is deleted after conversion; if nothing fits, a readable error. Every output is first written under the `.writing` name: a half-written file does not count as "ready". 14B: HF copy ~30 GB + f16 ~30 GB + Q4_K_M 9 GB.
- **A trained 14B as the text model:** the llama-server configuration is chosen from the GGUF metadata (`llm.mjs llamaConfig`): MoE (Gemma 26B-A4B) as before with expert layers in RAM and 32k context; a dense model (Qwen3 14B Q4_K_M 8.4 GiB) is fitted on the 12 GB card with 16k context + q8_0 KV (32k f16 KV ~14 GiB overflowed and dropped the speed from 60 to ~4 tokens/s).
- **First 14B training (05.10.2026, "Nedese SEO writer 14B"):** 569 selected nedese examples (532 chunks, 2.83 M tokens, context 8192), 1 epoch 34 steps, loss 0.62 → 0.45, peak VRAM 11.85 GB, training 2 h 32 min; merge + GGUF ~15 min. Evaluation with `tools\data\evaluate.mjs` (19 held-out examples: 6 articles, 6 translations, 6 meta, 1 refresh; `data\comparison\*-separate.json` + raw outputs `*-outputs.jsonl`):
  - It **did not beat** Gemma 26B. In original writing, meta fields were missing in half of the 6 examples, the meta description was never within the 140-160 range, one example was in English instead of Turkish; translation chrF 78.3 (Gemma 83.9); meta description compliance 17% (Gemma 100%). Equal on refresh. Speed 1.5-15× (article 30 s / Gemma 164 s).
  - Reason (measured): only 6/92 of the article examples were skipped for exceeding the context, so the model did see the examples; one epoch and rank 16 with ~570 examples were not enough to teach the long Turkish article format firmly. The text model stayed on Gemma.
  - For the next attempt: 2-3 epochs, rank 32-64, more article/meta examples (generate targets with Gemma from the collected sources and filter them with the SEO rules: `tools\data\generate-targets.mjs`), enforce the meta length rules in the targets.
- The trained HF folder `training\models\<id>\hf` is kept (the base for retraining); the list is in `training\models\record.json`. Ready bases are downloaded into the `training\hf\` cache.
- **14B on 12 GB (measured 05.10.2026):** load 6.8 GB (input embedding in RAM, output layer 4-bit), LoRA r16 64M parameters, 8-bit Adam.
  - The Windows torch build has no flash attention: transformers' GQA SDPA call fell back to the math path (attention +10 GB at 4096 tokens). `attention_patch()` repeats the heads → memory-friendly kernel (0.3 GB). At 2048: 160 → 477 tokens/s.
  - `prepare_model_for_kbit_training` is not used: it upcasts the bf16 embedding/output layer to fp32 (+6 GB).
  - The loss is computed in 512-token chunks at the output layer (with recomputation); with a 151k vocabulary the logits took ~1.2 GB in one piece.
  - Above 4096 context: checkpoint intermediates go to RAM (`save_on_cpu`), the MLP runs in 2048-token chunks along the sequence. 8192: peak 9.6 GB, 276 tokens/s. 12288 overflows (the allocated memory fragments; no `expandable_segments` on Windows).
  - When it overflows Windows gives no error, it moves memory to system RAM and the speed drops 10-20×: watch the step time and `peakVramGb`. RAM also fills up during training (0.3 of 15.6 GB free); do not run heavy work alongside.
- **Prompt abbreviation:** long fixed texts that go verbatim in every request (bot guides) are replaced by `[[marker]]` in the training data; the mapping file (`*abbreviations.json`, `{"[[marker]]": "full text"}`) is uploaded with the data and goes into the model's folder. If the active text model was trained in the panel, the panel does the same replacement on `/llm/v1` requests; it does not add the length note, turns thinking off and skips the sectioned flow (the model writes in a single call). The nedese original-article prompt went from 10.7k to 6.6k tokens.
- A 26B text model cannot be trained on 12 GB (Unsloth: 26B-A4B LoRA > 40 GB); multimodal models (Gemma 4 E4B, Qwen3.5) are not on this path. During training the graphics card belongs to this job: requests to the text model (bots included) wait until the job finishes, and in a long training they time out and fall back to DeepSeek.
- transformers 5: `LlamaTokenizer(vocab_file=…)` no longer reads SentencePiece; the vocabulary is converted to a fast tokenizer with `SentencePieceExtractor`. The leading space marker (`add_dummy_prefix`) is off: the tokenisation in training and in llama.cpp is identical.

### Image LoRA training (Training > Field: Image; `training\image.py`, separate environment `training\musubi\.venv`)

- Tool: **musubi-tuner** (kohya-ss, pinned commit `f8a1b03`, source `training\musubi`; supports FLUX.2 klein, Qwen-Image and Wan 2.2 LoRA training). Python 3.12.14, torch 2.11 cu128; installed by setup.ps1.
- Model: **FLUX.2 [klein] 4B** (Apache 2.0). Training is done on the undistilled **base 4B** that musubi recommends (`training\bases\flux2-klein-base-4b`, 7.2 GB) + the Qwen3 4B text encoder (`bases\flux2-klein-4b\text_encoder`, 7.5 GB); downloaded automatically at the first training. The LoRA is used with the 4-step fp8 klein in ComfyUI (tried: it loads and does not break the image).
- VAE: musubi wants the original BFL naming; ComfyUI's `flux2-vae.safetensors` has diffusers naming and the original `ae.safetensors` is in the gated FLUX.2-dev repository. `training\vae_convert.py` converts it once (`bases\flux2-ae\ae.safetensors`; 251 tensors, strict load, round-trip encode 41.1 dB PSNR).
- Flow: images (PNG/JPEG/WebP, .zip) + same-named .txt captions (if missing, "trigger, general description") → long edge at most 2048, shortest 256 → latents and captions cached (VAE bf16, Qwen3 fp8) → training (fp8 base + fp8 scaled, gradient checkpointing, AdamW 8-bit, lr 1e-4, rank 16, flux2_shift) → LoRA `models\loras\<name>-<job>.safetensors` → record → a sample image without/with the LoRA from the same prompt in ComfyUI.
- **Measured (05.10.2026, RTX 5070, 1024 px):** peak 7.3 GB VRAM, ~5 s/step, a 40-step trial 3.5 min including model loading; the end-to-end job (preparation + training + ComfyUI samples) 5 min. Default steps ~60 per image (400-2000): 20 images ~1,200 steps ~1.7 h. LoRA rank 16 = 88 MB.
- A checkpoint every ~10% (musubi `--save_state`); a paused/interrupted job continues from the last checkpoint with the remaining steps. An existing LoRA is trained with new images via "Improve this one" (`--network_weights`).
- Use: Image tab > Fine settings > Model FLUX.2 klein > **LoRA** (and its strength). The trigger word is added to the prompt automatically. API: `type: "image", model: "flux", lora: "<file>"`.

### Music LoRA training (Training > Field: Music; `training\music.py`, separate environment `training\sidestep\.venv`)

- Tool: **Side-Step** (koda-dernet, MIT, pinned commit `fc80093`, source `training\sidestep`; the command-line trainer recommended by the ACE-Step 1.5 documentation). Its repository has no `uv.lock`; the resolution that works on this machine is `setup\lock\sidestep-uv.lock`, setup.ps1 copies it into the source and installs exactly from it (Python 3.11.16, torch 2.7.1 cu128). Note: the project announced it is "being deprecated" (read-only archive on 1 March 2027; a successor written from scratch is coming); it works at the pinned commit, migration will be evaluated when the successor is out.
- Model: training is done on **ACE-Step 1.5 base** (`training\bases\acestep`: base DiT 4.5 GB + Qwen3-Embedding 0.6B + VAE ~1.4 GB; downloaded automatically at the first training). The LoRA is exported to the ComfyUI format (`--target native`, alpha = rank) and used with **ACE-Step 1.5 turbo** in music generation (tried: the keys load, the output changes with the same seed).
- Flow: songs (WAV/MP3/FLAC/OGG/OPUS/M4A, .zip) + same-named `.txt` (or `.lyrics.txt`) lyrics, `.caption.txt` description (prepended to the style description from the form: the description that comes from a collection is often just "Song by Artist"; without one only the style description) → `dataset.json` (ACE-Step format, trigger word at the start of the description) → preprocessing (VAE + text encoder, two passes, peak normalisation, the first 240 s of the song) → training (LoRA rank 32 default, alpha 2×rank, lr 1e-4, AdamW 8-bit, gradient checkpointing, encoder on the CPU) → `models\loras\<name>-<job>.safetensors` → record → a 30 s sample song without/with the LoRA from the same seed in ComfyUI.
- Epochs (default, ACE-Step guide): ≤20 songs 800, ≤100 songs 500, more 300. A checkpoint every ~10% (`training\checkpoints\epoch_N`, optimizer + scheduler + randomness); a paused/interrupted job continues from the last checkpoint, the loss list (`losses.json`) is kept. An existing music LoRA is trained with new songs via "Improve this one".
- **Measured (05.10.2026, RTX 5070 12 GB):**
  - 4 songs of 30 s, rank 16: epoch 1.3 s, peak 5.8 GB VRAM; 60 epochs + preprocessing + sample songs, end-to-end panel job 4 min. LoRA 39 MB.
  - A 3 min song, rank 32: epoch ~0.9 s per song, peak 6.8 GB VRAM. LoRA 78 MB. Accordingly 10 three-minute songs × 800 epochs ~2 h, 20 songs ~4 h.
  - Pause → resume tried: paused at epoch 25, continued from the epoch 20 checkpoint with the same settings.
- Use: Music tab > **LoRA (trained here)** (and its strength 0.6-1.2). The trigger word is prepended to the style automatically. API: `type: "music", lora: "<file>", loraStrength: 1`.
- **ACE-Step decision (05.10.2026):** turbo stays for generation; the comparison with XL turbo using audiobox-aesthetics and Whisper lyric accuracy is in `data\quality\ace-step-decision.json`.
- **"Jazz" LoRA measured (06.10.2026):** 30 Commons recordings, 500 epochs, 3 h 7 min; loss 0.71 (40 epochs) → 0.57.
  - Method: jazz and EDM style, 2 seeds, 30 s. Conditions: no LoRA, trigger word only (LoRA strength 0), 40 epochs, 500 epochs.
  - Measured with CLAP (similarity to the mean of the training recordings) and audiobox-aesthetics.
  - At strength 1 almost all of the effect comes from the trigger word: the LoRA weights raised the similarity by +0.005 on average over the trigger word; 500 epochs were indistinguishable from 40.
  - At strength 2 it is measurable: +0.033 on average (+0.009 … +0.043); production quality (PQ ~8) and enjoyment (CE) did not drop.
  - `recommendedStrength: 2` was written into the record: the Music form sets the strength to 2 when this LoRA is selected; if the API gives no strength the recommendation in the record is used. The strength options in the form go up to 2.

### Video LoRA training (Training > Field: Video; ComfyUI's built-in training nodes)

- No separate environment or download: trained inside ComfyUI with the installed **Wan 2.2 TI2V 5B** (`wan2.2_ti2v_5B_fp16`, loaded as fp8), the umt5 fp8 text encoder and the Wan 2.2 VAE (`TrainLoraNode`, `MakeTrainingDataset` / `SaveTrainingDataset`; ComfyUI 2026-09). musubi-tuner does not support 5B; A14B (the panel's 4-step video model) needs a 28 GB fp16 file per expert and more than 14 GB RAM, it cannot be trained on this machine (16 GB RAM, 15 GB free disk).
- Flow (`panel\lib\jobs\training.mjs runVideo`): clips/images (+ same-named .txt caption, .zip) → ffmpeg: 24 fps, fixed size by orientation (480p: 832×480 / 480×832 / 640×640; 320p: 576×320 …), fixed length (17/33/49 frames; from a long clip at most 4 evenly spaced pieces, a short clip is padded with its last frame, an image is a single frame; phone video rotation metadata is read), trigger word at the start of the caption → uploaded to ComfyUI input → dataset (Wan VAE + T5) to disk (`ComfyUI\datasets\aipanel\<job>`, once) → `/free` → training in 150-step slices (fp8 5B, bypass LoRA, gradient checkpointing per block, AdamW lr 1e-4, rank 16) → `models\loras\<name>-<job>.safetensors` → record → a 49-frame sample video without/with the LoRA from the same frame. The intermediate files in ComfyUI are deleted at the end.
- Two settings are required for it to run on this card (measured): gradient checkpoint depth 2 (1 wraps the whole model in one piece: 17.4 GB, overflows) and bypass mode (a LoRA patched into the weights goes up to 17.7 GB; with a forward hook 8.4 GB).
- **Pause / resume:** every slice saves the LoRA as `<name>-interim_<step>_steps_.safetensors` (`TrainLoraNode` reads the previous step count from the file name); a paused or interrupted job continues from the last finished slice, the dataset is not re-encoded. The steps inside the slice and the AdamW state start over (at most ~150 steps repeated).
- **Measured (05.10.2026, RTX 5070):** 480p 33 frames rank 16: 3.4 s/step, peak 8.4 GB VRAM (1000 steps ~1 h); 320p 17 frames: ~0.9 s/step. Default steps 100 per sample (300-2000). Even a 10-step LoRA changes the output (with the same seed ~11/255 mean difference at frame 16, ~24/255 at frame 32); 0 "lora key not loaded".
- **"Silent film" measured (06.10.2026):** 75 clips; 600 steps (34 min) and 2000 steps (1 h 49 min).
  - Method: Wan 5B 480p, 2 start frames × 2 seeds; conditions: trigger word only (strength 0), 600 steps, 2000 steps.
  - DINOv2 similarity to the training clips 0.372 / 0.359 / 0.388; colour saturation 0.439 / 0.448 / 0.379 (clips 0.132, black and white).
  - Decision: the 2000-step "Silent film" is used. The 600-step one did not beat the trigger-word baseline; it is kept apart in the record as "Silent film (600 steps)".
- Use: Video tab > Fine settings > Model **Wan 2.2 5B** > **LoRA** (and its strength). The trigger word (translated to English) is added to the prompt automatically. API: `type: "video", model: "wan5", lora: "<file>"`.

### General model training (Training > Field: General; `training\general.py`, training environment `training\.venv`)

- A single model that understands image and text together: **Qwen3.5** (Apache 2.0; 4B recommended ~9 GB, 2B fast ~5 GB; downloaded into `training\hf` at the first training). QLoRA: language model 4-bit + LoRA (full attention, Gated DeltaNet and MLP layers), image encoder bf16 frozen. The training loop, checkpoint (pause/resume), streamed merge and GGUF step are shared with `train.py`.
- Data: image + same-named `.txt` (that image's answer: caption, tag, the desired reply; the question is the form's "Image question", default "Describe this image in detail."), image chat JSONL (`{"messages": [...], "images": [...]}`, with `{"type": "image"}` or `<image>` in the content; or `{"image", "prompt", "response"}`), the text/question-answer formats of the text model and `.zip` files containing these. ~256 tokens per image (262,144 pixels).
- Result: `llm\models\<name>-training-<job>-q4_k_m.gguf` + the image encoder `mmproj-<same name>` (f16). Shown as "understands images" in the Settings > Text model list; when selected llama-server starts with `--mmproj`, and the `image_url` (data URL) part of a `/llm/v1/chat/completions` request is read. For a model trained in the panel, the prompt abbreviations are applied only to the text parts of an image request.
- **Measured (05.10.2026, RTX 5070, 4B):** 19 examples (16 images + 3 question-answers) 3 epochs 56-62 s, peak 5.8 GB VRAM; the panel job end to end 4 min (merge + mmproj 0.63 GB + Q4_K_M 2.59 GB). Tried with llama.cpp: it described an orange circle it had not seen in training correctly in the learned format ("… there is a single orange circle. Shape: circle. Colour: orange."), general knowledge was kept. Facts are not learned from 3 question-answers (it takes the format, invents the content): facts need many examples.
- Known: Qwen3.5's fast DeltaNet kernels (flash-linear-attention, triton) are not available in the Windows environment; the torch path is fast enough on small data. `pillow` and `torchvision 0.26 cu128` were added to the training environment (lock `setup\lock\training.txt`).

## Data (`data\`, outside git) and data collection

Data collection and image description are inside Nedese Studio (Training tab). The separate "Data Panel" project tried on 06.10.2026 was cancelled by the user's decision; its code is archived outside the repository (`eski\veri-paneli` on the development machine). All the engine fixes made there are in this panel too.

### Data collection filters and measurements (06.10.2026)

- **Adult / gambling / betting** sites and their CDNs are never taken by any path: candidate, site-to-site, page, embedded media (`isUnsuitable`). In a 20 min trial these sites had been reached through Bing's tabloid drift; the records are in `data\quarantine\`.
- **Search result pre-filter (drift signature):** a result of a topic-bound query is not visited if the title + snippet contain none of the topic's words and fewer than 40% of the query's. In real results 21 of 276 were eliminated, all drift (Bing "Famous …" → tabloid / stock market). A result with no word in common with the query and a query in another language are not judged.
- **Focused topic match in rule mode:** the topic words must be in the title + introduction (first 300 words) or spread through the text (each at least 2 times, once per 1,500 words). Previously a single occurrence in a long article was enough ("Anıtkabir", "Kur'an" got in).
- **Search engines (from this connection):** Bing RSS returns an empty channel for foreign markets and drifts to the Turkey market without parameters. DuckDuckGo 202, Yahoo 500, Mojeek CAPTCHA (impassable). The Wikipedia search API was added as an engine (`wiki`, in the query's language).
- **Google News** links do not redirect to the publisher over HTTP (~600 KB JavaScript page); they are resolved to the publisher address with the signature on the page + `batchexecute` "garturlreq" (~0.4 s). Previously none of these candidates turned into an article.
- **Site to site:** wiki editions in unwanted languages and non-Commons Wikimedia subdomains are not skipped; on a giant site like Wikipedia there is no home-page discovery after a search.
- **PDF lock-up (fixed):** the text parser backtracked exponentially in the font width array (12 numbers 335 ms, ~16× per 2 numbers); the stream-start pattern also captured the end of `endstream`. The test fails with a timeout on the old code.
- HTML entities in JSON-LD titles are decoded ("UNESCO&#039;ya" was being saved).

12 min comparison ("Osmanlı minyatürleri", rule extraction, meta only, tr+en; "on-topic" counted by hand from the titles):

| Run | Articles | On-topic | Note |
|---|---|---|---|
| Filters | 12 | ~6 | the site queue ran out at 11.5 min |
| + Wikipedia, language filter, PDF fix | 80 | ~27 | long articles got in while off-topic |
| + focused rule | 34 | ~23 | |
| + Google News resolution | 75 | ~55 | 45 different sites (9 before) |

- ~35% of the candidates from search and ~4% of those from site-to-site hopping turn into articles.
- Tried and reverted: in rule mode, priority to external sites whose link text contains a topic word. Hop acceptance dropped from 12/~308 to 8/~487; a general word like "Osmanlı" pushed general history sites forward.

- `data\`: data kept for our own models (do not delete). nedese training data, source sites, comparisons; its contents are described in `data\README.md`. The scripts that produce it are in `tools\data\`.
- In the panel, Training > **Data collection** (API `type: "data"`; code `panel\lib\jobs\data.mjs`, helpers `data-collection.mjs`, browser `browser.mjs`, documents `read-document.mjs`; dependency-free). Two modes, which also work together:
  - **Topic** (automatic discovery): the local model generates search queries (templates if there is none) → Bing RSS, DuckDuckGo HTML, Google News RSS, Wikipedia search API (in the query's language; no key needed) → candidate pages → once 2+ good articles come from the same site, feed / sitemap (robots.txt `Sitemap`) / WordPress API discovery and in-site crawling; stops when the `target` count is reached.
  - **Sources**: site home page, RSS/Atom, OPML (feed list), sitemap (including indexes), `/wp-json` (WordPress REST: content + Yoast meta + category/tags in one request), page, PDF/DOCX/PPTX/XLSX link, `cc:domain` (Common Crawl: CDX index + WARC range; no load on the live site).
  - **Wikimedia Commons** (`commons:Category:Name` or `commons:search words`): licensed media from the API with its description, license and author. The text filter is not applied.
    - Image: the 1280 px reduced version (a TIFF scan comes as JPEG); video: the webm/mp4 derivative closest to 480p; audio: the original file (for large FLAC/WAV the mp3/ogg derivative).
    - Subcategories are followed up to `depth`; at most `max` files per source. Used with `media: download` and, if needed, `mediaMaxMb` (80+ for video).
    - A User-Agent identifying the tool is sent to the API (Wikimedia rule).
  - In-site crawling: internal links are classified from the address pattern as **article / list-category / static / document / media**; list pages are followed up to `depth`, static ones (about, login, cart…) are never requested; `sitePerPage` limit.
  - **Site to site** (`hopSites`, on by default in topic mode): the sites of external links on accepted (on-topic) pages enter the queue.
    - Social networks, search, shops, shorteners, ads and embedded video platforms do not enter.
    - The most-linked site is visited first (discovery: feed, sitemap, WordPress API, in-site crawling). A site with no on-topic article among its first 8 candidates is dropped.
    - The queue is kept in `site-queue.json`. A paused job continues where it left off, together with the half-done site.
    - On a hopped-to site the linked pages are read first (if none of the first 3 is on topic the site is dropped). If an on-topic one appears, the site is explored widely. On giant general sites like Wikipedia, Commons and archives only the linked pages are taken.
    - The model (`extract: model`) picks the on-topic ones among the external links on every accepted page: one call per page, at most 8 links.
    - **In-site search:** on a hopped-to or productive site the search engine is first asked `site:<site> <distinctive word>`.
      - The word is the topic's longest word with the Turkish plural suffix stripped: `minyatür` for "Osmanlı minyatürleri". With the whole topic Bing drifted to general results.
      - The topic pages found are processed before the linked pages; their internal links go to the front of the in-site crawl.
      - Because DuckDuckGo blocks the bot query, the first general engine (Bing) is used. Asked once per site.
      - Why: on the TDV İslâm Ansiklopedisi the home page linked to random articles. 91 pages were visited and the "Minyatür" article was never reached (05.10.2026).
    - In in-site crawling a link whose address or link text contains the topic stem is moved forward ("related articles" on TDV: Şükûfe, Âhar). In topic mode, if 60 pages yield no article the crawl is abandoned.
  - **Manager** (`manager`, on by default; needs the model and a topic): the local model looks at a summary of the crawl about every 8 minutes.
    - The summary contains: what was collected, the latest articles, productive and empty sites, the sites next in line, the queries used.
    - Based on these the model moves sites forward or drops them and proposes new search queries.
    - When the queue runs dry it asks for a new direction; if 3 rounds in a row bring nothing new, the job ends. Its memory is kept in `site-queue.json`.
  - **Unlimited** (`target: 0`): the job collects until stopped or until `durationMin` runs out. If the panel closes and reopens (crash or clean shutdown) the job does not become "interrupted": it resumes by itself when the queue empties.
    - Queue rules:
      - Jobs with a definite end (training, image, bounded collection) run before unlimited collection.
      - Unlimited collection yields the queue to a bounded job that arrives or is "Resumed".
      - A cancelled job does not come back. A job that has yielded (paused) can be cancelled.
      - A job in its final-processing stage does not yield.
    - On resumption it continues where it left off:
      - The target and duration counters are kept (`dataProgress`).
      - Tried pages (`tried.txt`) are not downloaded again.
      - Media left in the pool re-enters the queue with a "waiting" record.
      - The site queue and the manager's memory are in `site-queue.json` (written atomically, read from `.bak` if corrupt).
    - Data collection is a **yielding** job (`yields`): if another job is added while it runs, it pauses itself ("Queue yielded"). When the queue empties it resumes by itself.
    - The single-queue rule is never broken; a manually paused job does not resume by itself.
  - **Media** (`media: download`; default in the UI): the media of pages not taken as articles is taken too ("whatever it finds"): gallery, video page, short, off-topic, low-scored or other-language page. Duplicate pages excluded.
    - The large version of an image is taken from the widest `srcset` candidate. Images without alt text are taken too; logo, icon and avatar addresses are not. At most 50 images per page.
    - In topic mode Wikimedia Commons is searched as well (topic + the first English query).
    - No total quota (`mediaTotalGb: 0`): when 10 GB of disk is left free media downloading stops, articles continue. Per file `mediaMaxMb` (default 300).
    - robots.txt and the `noai` / `noimageai` prohibitions still count.
  - Page processing: JSON-LD (Article, FAQPage, HowTo, VideoObject…), Open Graph, meta (SEO title/description, date, author, tags, section, canonical), hreflang alternates → **translation pairs**, HTML → Markdown blocks (link-dense blocks dropped; numbered lists, code, quotes kept), rule extraction = the densest content region, language detection (writing system + stop words), category (section > breadcrumb > address), FAQ question-answers, image/video/audio metadata (`media: meta|download|none`; per-file and total limits when downloading).
  - Labelling with the local model (`extract: model`): the main content blocks, language, topic, **category** (fixed list), **content type**, tags, one-sentence summary, **quality** and **accuracy** (1-5), topic fit. Thresholds: `minWord`, `minQuality`, `minAccuracy`, `minFit`. With `rule` the model is never used (Gopher/C4-like quality rules still run).
  - Cleaning: exact duplicates (digest of the body without the title) and **near duplicates** (64-bit simhash, ≤3 bits) are skipped; e-mail/phone/IBAN/national ID numbers are masked; `<meta name=robots content=noai>` and TDM reservation count (`noimageai` turns images off).
  - Browser: when script-heavy (single-page application) pages or bot protection (403/429) are seen, the Edge/Chrome on this computer is opened headless (DevTools protocol, GPU off): the cookie banner is dismissed, the page is scrolled to the end (lazy loading), and if needed the model clicks one of the numbered interactive elements in `agent` mode (read more, tab); the step screenshots become job outputs (`screen\*.jpg`). `browser: automatic|always|agent|closed`.
  - **Finds its own pace:** the interval between requests is learned per site.
    - On 429/503 the interval doubles (2-60 s) and the time the server asks for (Retry-After) is waited; after 20 successful requests it shrinks by 15%.
    - The `RateLimit-Remaining` / `-Reset` headers are read: when the allowance is used up the reset time is waited.
    - The tool goes to Wikimedia servers under its own name: disguised as a browser it got 429 and "wait 600 s".
  - **Concurrent media:** downloads run in a background pool (8 at a time, order kept per site). The crawl continues without waiting for the page; if more than 400 jobs pile up in the pool it slows down.
    - A file that fails to download because of a rate limit or network error is not recorded and is retried in the next run. At the end of the job the media records are deduplicated.
    - A page whose whole text is still short or contains none of the topic words is not sent to the local model (the model is single-channel, 10-20 s per page); its media is still taken.
  - Robustness: sequential requests per site with a ≥1 s interval (Crawl-delay), site-specific exponential backoff on 429/5xx/network errors (at most 90 s, `Retry-After`), a 10 min rest after 5 consecutive errors, 2 retries on transient errors, 6 MB body limit (counted stream), non-HTML/XML/JSON/document content skipped, private network / loopback / Tailscale addresses and redirects to them refused (SSRF). Parallel across sites (`parallel`, default 4).
  - Time: a `durationMin` budget (when it runs out what is in hand is saved; no new discovery in the last 20%), articles/min and estimated remaining time in the progress. The job can be paused; running it again with the same name appends from where it left off (`onlyNew`: only items after the last update).
  - Output `data\collected\<collection>\`: `articles.jsonl` (raw record: text, meta, tags, scores), `images/videos/voices.jsonl`, `media\`, training-ready chat files `training-meta` (content → meta title/description), `training-translation` (hreflang pairs, both directions), `training-write` (title → article), `training-summary`, `training-title`, `training-question` (FAQ/HowTo), `training-classification` (text → category/type/tags), `training-image` (image ↔ caption), `summary.json` (languages, categories, sources, statistics). In training, `collection/<id>` (raw) or e.g. `collection/<id>/training-meta` is selected.
  - Downloaded media is training data too: `collection/<id>/images` (image LoRA, general model, video), `.../videos` (video LoRA), `.../voices` (music LoRA).
    - The media is prepared in the job folder with hard links (taking no space); the caption becomes a same-named `.txt` (for images the caption/alt text, for video and audio the description or title; for audio the description goes to `.caption.txt`).
    - The caption is cleaned (`data-collection.mjs cleanCaption / mergeCaptions`). The hidden elements of Commons HTML (`display:none` Wikidata `label QS:` lines, the "English:" language label) are dropped at collection time. In old records this residue is cut at training time. Dropped:
      - license/permission sentences ("public domain", "Photography was permitted"; the license stays in a separate field),
      - addresses, camera file names (DSC04222), underscores.
    - The description is primary. The title (file name) only enters if it adds 3+ new words: if the description is only location information ("Exhibit in the … Museum") the title is chosen; if both add information both are written together. Generic names like "File 1" do not count.
    - This folder is deleted after preparation. The UI shows the options suitable for the field with the number of downloaded files. In the general model `training-image` can be used as well.
  - **Image description** (`panel\lib\jobs\describe.mjs`, job type `describe`): Training > Collected collections > "Describe images".
    - The text model (Gemma with mmproj) describes the downloaded images in Turkish (or English). The source caption is given as a hint, and it is asked not to write what is not in the image.
    - The image goes as a JPEG of at most 896 px; the encoder is on the CPU.
    - Result `captions.jsonl` (`file, caption, lang, model, hint, topic?, fit?`). Resumes where it left off, stops after 5 consecutive non-answers.
    - **Topic check:** if the collection has a topic (`summary.json`), the same call asks whether the image fits the topic (the first line of the reply: FITS / DOES NOT FIT). A non-fitting image is described but does not enter training (`fit: false`); the collection keeps collecting "whatever it finds". Turned off with `topicCheck: false`.
    - In training `collection/<id>/captions` = "images described by the model" (image LoRA, general model).
    - Why: Commons captions are mostly catalogue titles (median 14 words). A general model trained on them invented titles instead of describing ("Battle of Mohács (1526)").
  - Tests in the data collection test file (`panel\test\data.test.mjs`): fake site (robots, duplicates, hreflang, JSON-LD/FAQ, WP API, crawling, PDF, resumption after 429), fake search engine (`dataSearchTemplate` setting), fake model. In the tests `dataPrivateNetworkAllowed`, `dataMinDelayMs`, `browserPath: null`.

## Models (`models\`)

| Model | Job | License |
|---|---|---|
| Qwen-Image-2512 20B (GGUF Q4_K_M, unsloth) + lightx2v Lightning 8 steps | Image, strongest (~65 s) | Apache 2.0 |
| FLUX.2 klein 4B fp8 + Qwen3 4B fp4 | Image, very fast (~8 s); weak at text | Apache 2.0 |
| Wan 2.2 I2V A14B, lightx2v 720p distilled 4 steps (GGUF Q5_K_M, 2 experts; jayn7) | Frame to video, 16 fps | Apache 2.0 |
| Wan 2.2 TI2V 5B | Light video, 24 fps | Apache 2.0 |
| RIFE 4.9 (ComfyUI-Frame-Interpolation) | Frame interpolation: 16 → 48 fps | MIT |
| Chatterbox Multilingual (voice\hf) | Turkish narration | MIT |
| Whisper large-v3 | Transcription | MIT |
| Qwen3-TTS VoiceDesign 1.7B (`models\voice\`) | Voice design from a description (10 languages, no Turkish) | Apache 2.0 |
| Qwen3-TTS Base 1.7B (`models\voice\`) | Continuing the same voice (ICL clone) | Apache 2.0 |
| UTMOS22 strong (`voice\torch_hub`) | Naturalness score (take selection) | MIT |
| TRELLIS.2 int8 + DINOv3 L + BiRefNet (built into ComfyUI) | Textured 3D model (GLB) from an image | MIT |

## Setup notes

- ComfyUI portable (Python 3.13, PyTorch 2.13 CUDA 13); extensions: ComfyUI-GGUF, ComfyUI-Frame-Interpolation.
- **Third-party code is in the repository** (08.10.2026, to avoid version drift): `setup\vendor\<name>` — ComfyUI-GGUF,
  ComfyUI-Frame-Interpolation, LatentSync, musubi-tuner, Side-Step, the llama.cpp GGUF converter. Every folder has a `SOURCE.txt`
  (origin, commit, license, the promotional media that was removed). `setup.ps1` copies them to their targets with `Copy-Vendor` (the `.setup-source` marker
  is a digest of SOURCE.txt; when it changes the copy is redone, the environment/output/weight files at the target are kept; when LatentSync is copied the patch is
  reapplied as well). To update: change the folder contents and update the commit in SOURCE.txt.
- **The binary tools come from this repository's own GitHub release** (09.10.2026, user decision: nothing from another site, no version drift;
  putting them in git was tried and dropped: GitHub refuses files over 100 MB and every tool update would add 2.5 GB to the history): release
  `tools-2026.10` holds the ComfyUI 7z, Node, ffmpeg, uv, 7zr, Python 3.12.15, the llama.cpp CUDA zips, the SageAttention wheel and the
  environments' Pythons (python-build-standalone 20260924). `setup\tools.json` lists file, size and SHA-256; `Get-Tool` in setup.ps1 downloads
  into `setup\_downloads`, verifies the SHA-256 and returns the path. uv reads the Pythons from `setup\_downloads\python` through
  `UV_PYTHON_INSTALL_MIRROR=file://…`. The fetch helper tries the mirror first, then the upstream source (404/name not resolved → next address),
  and verifies SHA-256. Python packages come from PyPI / download.pytorch.org at the versions pinned in the lock files (not mirrored: ~15 GB of wheels).
- `extra_model_paths.yaml`: the models are outside ComfyUI and are not deleted by an update.
- `uv\`: Python 3.14 and the package cache (for the voice environment).
- Hugging Face downloads can fail on Windows with a symbolic-link error (WinError 1314): download with `snapshot_download(..., local_dir=...)` under `models\voice\`.
- The first project that used it: `nedese-youtube\prime2` (the Nedese Prime advertisement film).

## Fine settings (`panel\lib\fine-settings.mjs`)

The memory measures and limits chosen for this machine (RTX 5070 12 GB, 16 GB RAM) are changed with ticks and choices under Settings › Fine settings (by graphics card).

- The defaults are this machine's measured configuration. Only the values that differ are stored in `panel-data\settings.json` (`fineSettings`).
- The code that uses them reads them every time: no restart needed.
  - The ComfyUI flags take effect when ComfyUI is reopened. If there is no job the panel closes ComfyUI, and the next job opens it with the new flags.
  - `start_comfyui.bat` reads its flags from `AI_COMFY_MEMORY`; when started by hand, this machine's three flags are used.
- Groups:
  - **General:** the text model and ComfyUI taking turns on the card, unloading before voice/training, waiting for RAM and for a foreign GPU process.
  - **ComfyUI:** `--cache-none`, `--disable-pinned-memory`, `--disable-dynamic-vram`.
  - **Text model:** VRAM budget (automatic: the card's memory − 1.14 GiB; 10.8 on a 12 GB card), placement of the image encoder, image size for description.
  - **Video:** direct 1080p.
  - **Training:** fp8, gradient checkpointing, video LoRA depth, 720p / 81 frames, sample limit, music encoder, 4-bit (QLoRA), voice clone batch size.

### 1080p video (measured 06.10.2026)

- Direct 1080p (Wan 1920×1088) is not practical on this card.
  - ComfyUI put all 10.6 GB of the Wan model into RAM (0 MB on the card); the card was 100% "busy" but drew 55-59 W, i.e. it was waiting for memory.
  - The first sampling step did not finish in 26 minutes (at 720p a step is 71-85 s); the job was cancelled at 28.8 min.
- Default: Wan generates 720p, and the frames of every part are upscaled to 1920×1080 with `tools\upscale.py`.
  - Model: 2xNomosUni SPAN (Philip Hofmann, CC-BY-4.0, 4.4 MB, `models\upscale_models\`); ComfyUI's python and spandrel.
  - Cat jump, 5 s: Wan 377 s + upscaling 53 s (161 frames after RIFE, 0.33 s per frame); total 463 s, 14% longer than plain 720p.
  - Looked at closely, the belt, armour and fur edges are noticeably sharper than plain upscaling; no artefacts seen.
- A film can be 1080p too: every scene is upscaled once after all its parts are done; editing and subtitles at 1920×1080.
- On a strong card, Fine settings › Direct 1080p is turned on.

### Generation speed (measured 06.10.2026, RTX 5070 12 GB)

`job.json` durations of finished video jobs (job duration / video duration):

| Model / resolution | Real-time factor | 1 min of video | 1 h of video |
|---|---|---|---|
| Wan 2.2 14B, 720p (12 jobs, median) | ×76 (×69-90) | ~76 min | ~76 h |
| Wan 2.2 14B, 1080p with upscaling (1 job) | ×92 | ~92 min | ~92 h |
| Wan 2.2 14B, 480p (2 jobs) | ×35-36 | ~36 min | ~36 h |
| Wan 2.2 5B, 480p (2 jobs) | ×37-38 | ~37 min | ~37 h |
| Wan 2.2 5B, 720p (2 jobs) | ×74-75 | ~75 min | ~75 h |

- A 1-hour series/film at 720p means more than 3 days of continuous generation on this card; ~1.5 days at 480p.
- The "light" 5B model is not fast in this setup: 14B runs with the 4-step accelerated configuration. Only the resolution reduces the time.

### Character consistency in long video (measured 06.10.2026)

Source: an armoured cat warrior with a red cape and a black dragon; Wan 2.2 A14B, 720p, seed 3030.
Measure: local Gemma 26B (with the image encoder) looks at one frame per second as a single image, first lists every cat with its position and outfit, then counts. Agrees with the eye count in 59 of 60 frames. A direct two-image "how many cats are there" question did not see the duplicates.

**60 s, the same 12 English part prompts in both runs (translation off):**

| Method | Frames with a duplicate cat | Outfit loss (no armour + cape) | DINOv2 similarity to the source | Duration |
|---|---|---|---|---|
| Chain (continue from the last frame + colour pinning) | 0/60 | 25/60 | 0.51 | 4498 s |
| Keyframe + duplicate check | 0/60 | 4/60 | 0.72 | 6648 s |

- In the chain the cat lost its armour and cape after the 12th second, the black dragon turned red, and in the last seconds the cat left the frame.
- With keyframes 6 of the 12 frames were eliminated by the duplicate check (those parts continued with the chain); the remaining keyframes pulled the character back to the source every time.
- With this result keyframes are **on by default** for multi-part video on A14B: Video › Fine settings › Long video › "Keep the character with keyframes (A14B)". Ignored on 5B and in a single part; if Qwen-Image-Edit is not installed it continues with the chain.
- In 15 s (3 parts) trials the chain did not drift (0/15 duplicates, 0/15 outfit loss): the drift accumulates with time.
- Identity preservation (last frame + source, two-image Qwen) produced duplicate cats and a text strip in 10/15 frames at 15 s; not recommended.

**The source of duplicates and the check:**
- Single-image Qwen-Image-Edit doubles the character in big motion actions ("dodges by jumping aside", "somersaults and lands on its back"): 12/12 samples. "Each character once" and end-state prompts did not fix it.
- Duplicate check: the characters in the source are counted by type ("kitten = 1, dragon = 1"); if a keyframe has one type too many, the frame is not used. The type name must be specific: with "animal / creature" the dragon counted as an animal too. 21/21 correct (14 with duplicates, 7 clean); ~13 s per frame.

**Duration:**
- In the 60 s run, with Wan in memory, 8 keyframes took 1272 s (159 s per frame). Sampling is only ~20 s; the rest is Qwen-Image-Edit (12.7 GB) and the text encoder (7.9 GB) swapping through the page file on every image in 16 GB RAM.
- That is why ComfyUI memory is flushed before the keyframe group. After flushing, 2 keyframes took 252 s (including model loading); on a clean ComfyUI 8 film images ~11 min (~80 s per image). 32 GB RAM would remove this swapping.
- The duration estimate in the UI includes the keyframe time (60 s 720p: ~1 h 47 min instead of ~1 h 16 min).

**Film:** scene images (character reference + "compose a new image" prompt) 12/12 a single cat, 12/12 the same outfit; no duplicate check is needed there. In 4 images the jumping pose from the source was repeated.

DINOv2 similarity alone is not an identity measure: it also penalises scene changes (in the 15 s chain it dropped from 0.88 to 0.53 while the outfit was kept).

## Updates (`panel\lib\update.mjs`)

- Source: GitHub `mustafa-ozen95/nedese-studio` (`main`). The repository is public: requests go without a key (GitHub allows 60 unauthenticated requests an hour per address; the panel makes one per check).
- Under Settings › Updates and in the tray icon's menu:
  - "Check for updates", "Update now", "Daily update check" (on by default).
  - When on, it checks once a day, installs the new version and the panel restarts. A running job is not interrupted: it is installed when the job finishes. Unlimited data collection is no obstacle: it pauses and resumes at start-up.
- Top bar: an "Update available" badge when there is a new version ("Updating…" while installing); clicking it opens Settings › Updates.
  - The result of the last check is in `panel-data\settings.json` (`update.lastResult`): known even after the panel reopens. No badge in a development copy.
- Applying:
  - The new version's file list comes from the git tree (one API request, path + blob id per file). Every listed file is compared with the installed one by git blob SHA-1; only the changed and new files are downloaded from raw.githubusercontent.com (no request limit) and checked against the blob id before anything is written.
  - Only files in the repository are written. The old version of a changed file is moved to `update\backup-<old version>\`.
  - A file that was in the previous version but not in the new one is deleted. A version containing an unsafe path is never applied.
  - `panel-data` (settings, port, keys), `outputs`, `data`, `models` and `llm\models` are not in the repository and never change.
  - If the Python environments changed (`setup\`, `uv.lock`, `requirements`) it warns: `setup.bat -Models none`.
- Version: `version.json` (written by the updater, with the file list).
  - If absent, `panel\version.txt`: git archive and the GitHub zip write the commit id through `export-subst`.
  - A development copy (git repository) does not update itself; it is updated with `git pull`.
- Restart:
  - If the tray manages it (`AI_PANEL_TRAY=1`) the panel exits and the watchdog starts it within 10 s.
  - Otherwise `panel\lib\restart.mjs` starts the panel with the same arguments and environment.
- Prompt translation (Settings › Prompts, on by default): prompts are translated to English before going to the model. When off, they go as written (the prompt translation module `panel\lib\prompt-translate.mjs`, the `translatePrompt` setting).

## Acceleration (measured)

- **SageAttention 2.2** (`sageattention-2.2.0+cu130torch2.10.0andhigher`, `triton-windows 3.8.0`): attention computation 7.1×;
  a Wan A14B step 114–118 → 62–65 s, a 720p 5 s clip ~600 → 365 s. Quality the same (frames compared).
- The card at 100% / ~220 W during sampling: the bottleneck is compute. The driver type (Studio / Game Ready) does not change CUDA speed.
- RAM 16 GB: the overflowing part of the 14B model goes to the page file; 32 GB shortens the load times.

### Film speed (measured 07.10.2026)

The same film was generated twice: 5 scenes, 48 s, 9:16, 720p Quality, same input and seed.

| Stage | Before | After |
|---|---|---|
| Narration (5 lines × 3 takes) | 313 s | 306 s |
| ComfyUI start-up (waiting) | 42 s | 0: started while the narration is running |
| Motion prompts + music plan (text model) | 5 separate loads (18-20 s), 30-34 s between scenes | a single session 42 s |
| Images (5) | 892 s | **247 s** (pixel-for-pixel identical) |
| Until the start of the video | 21.3 min | 9.9 min |
| Video (10 parts) | 70.8 min | 66.3 min |
| **Total** | **93.3 min** | **77.1 min (−17%)** |

The gain in the images came from ComfyUI's node order:
- ComfyUI runs the node closest to the output first (`comfy_execution/graph.py`).
- So even within a single request the "encode → draw" order repeated for every image.
- In 16 GB RAM the text encoder (7.9 GB) and the model (12.7 GB) were swapped on every image.
- The fix is `encodingsBefore` in `graph.mjs`: sampling does not start until all encodings are done (ConditioningAverage 1.0, numerically the same conditioning).

Node durations of a video part (s), in the order below:

| Node | Duration (s) |
|---|---|
| CLIPLoader | 3 |
| CLIPTextEncode | 7 |
| WanImageToVideo | 13 |
| KSamplerAdvanced (two experts) | 163-177 and 160-169 |
| VAEDecode | 23 |
| RIFE VFI | 6 |
| SaveImage (161 PNG) | 12 |

73% of the remaining time is 720p sampling.

### Narration engine measurement: EMA Lightning (07.10.2026)

`canberkkkkkk/ema-lightning` (Apache 2.0, 8.6M parameters), tried inside `voice\ema\.venv`:
- The checkpoints were opened with `weights_only=True`: they contain only tensors and dictionaries.
- The same 5 narration sentences were used.

| | EMA Lightning | VoxCPM2 (best of 3 takes) |
|---|---|---|
| Loading | 1.0 s | ~80 s |
| Generation | 0.05 s/sentence (135× real time; batched 257×) | ~10 s/take |
| Whisper error rate | 0.2% | 0.4% |
| Naturalness (UTMOS) | 3.17 | 3.58 |
| Voice | a single voice, female (pitch ~233 Hz); no cloning | from the library or a description, clone |

EMA cannot do character voices, because it has a single voice. Suitable for quick draft narration, but its naturalness is lower.

**Voice engine: EMA Lightning** (Settings > Voice engine; 07.10.2026 user: "Wasn't the voice engine going to be EMA"):
- When selected, lines without a reference (narration, "Model's default voice") are read with EMA.
- Lines with a chosen voice or a character voice are cloned with VoxCPM2, because EMA does not clone. Voice design is also on VoxCPM2.
- EMA is very fast on the CPU too (measured: loading 1.1 s, 0.15-0.4 s per line).

**Characters with EMA + voice conversion (tried).** EMA reads, Chatterbox's voice converter (ChatterboxVC) converts to the character's
timbre.
- Similarity to the character (ECAPA): EMA's own voice 0.05-0.12; converted 0.49-0.64.
- The current VoxCPM2 clone 0.26-0.69.
- The pitch comes down to the character: Elif 401-438 Hz, Father 108 Hz.
- EMA has no emotion control: "Çok korkuyorum" ("I'm so scared") was still classified "happy".
- Conversion on the CPU ~11 s per line.
Setup (`setup.ps1`) installs EMA too: `voice\ema\.venv` (Python 3.14, `lock\ema.txt`; the heavy packages from `voice\.venv` through a `.pth`
file), the model and the "EMA Lightning" voice in the library with `voice-models.py ema`.

Alania-2 (PatientDesk AI, 5 October 2026) was examined and not connected to the panel:
- Weights closed, paid API only.
- In their own tables WER 1.44%, UTMOS 3.67; EMA 1.04% / 3.30.
- Trained from scratch on 18,000 hours of Turkish with the VoxCPM2 architecture. The Turkish data they left open (CC BY 4.0) is an option for our own
  training.

### Lip sync (Film, measured 07.10.2026)

When **Editing > "Speakers' lips move with their voice"** is selected in the film form, scenes with dialogue are generated with InfiniteTalk at
25 fps; the speaker's (even an animal's) mouth moves with its own voice. Models: Settings > Models > "Lip sync (InfiniteTalk)"
(~16 GB; Wan 2.2 A14B HighNoise, UMT5 and the Wan 2.1 VAE are needed as well). At setup: `setup.bat -Models all` or by selection.

**The setup was chosen by measurement.** Same image (a girl with a cat on her lap), same 3.24 s line, 720×1280, 81 frames:

| Setup | Mouth ~ audio (r) | Shuffled-audio control (max) | Gaze (Gemma, 14 frames) | Duration |
|---|---|---|---|---|
| InfiniteTalk patch on the Wan 2.2 A14B experts | 0.31 | 0.43 | 13/14 at the cat; colour drifts (orange cat turns grey) | 869 s |
| Wan 2.1 I2V 720p + lightx2v, 6 steps | 0.56 | 0.33 | 8/14 (3 frames at the camera) | 1072 s |
| Wan 2.1 I2V 720p + lightx2v, 4 steps | 0.59 | 0.32 | 9/14 (3 frames at the camera) | 724 s |
| **Hybrid: Wan 2.2 high noise 2 steps + Wan 2.1 InfiniteTalk 2 steps, audio strength 3** | **0.64** | 0.39 | **13/14, 0 at the camera**; colour correct | 608 s |

- Mouth measurement: the nose-mouth-chin region is tracked frame by frame (cv2); the correlation between the frame-to-frame change in the mouth and the audio energy;
  the largest r obtained after shuffling the audio envelope 50 times is the control.
- User: "Wan 2.2 is better, the other one looks elsewhere". InfiniteTalk on Wan 2.1 turns the speaker to the camera,
  and when attached to Wan 2.2 it does not move the lips; in the hybrid Wan 2.2 sets the motion, gaze and colour and InfiniteTalk moves the lips.
- At audio strength 1 the mouth opens with the audio but little (motion in voiced/silent frames 5.0/4.4); at 3 it is 7.0/4.3, teeth and lips clean.

**Re-measured with SyncNet; audio strength lowered to 2.** The r measure above measures how much the mouth moves, not how well it
fits the audio.
- The standard measure for lip-audio fit is SyncNet (LSE-C, higher is better; 7-8 on real speech videos). Setup:
  a `measure\` folder (syncnet_python, MIT; `measure\syncnet-measure.py video.mp4 [--audio speaker-track.wav]`).
- Same image and audio:

  | Setup | Elif's line | Dense speech |
  |---|---|---|
  | Pure Wan 2.1 InfiniteTalk (looks at the camera) | 3.91 | – |
  | Hybrid, audio strength 1 | 2.75 | – |
  | **Hybrid, audio strength 2** | **2.94** | **2.60** |
  | Hybrid, audio strength 3 (old) | 2.08 | 1.22 |
  | Hybrid, audio strength 3, Wan 2.2 1 step | – | 2.11 |
  | Hybrid, audio strength 3, 6 steps | – | 1.69 (1348 s) |

- With two speakers every face was measured against its own voice: Elif 1.68 (0.58 with Father's voice), Father 2.00 (0.68 with Elif's voice).
  The mouths do not get mixed up; the fit is low.

**Speed: the bottleneck is RAM.** A lip-synced window takes ~690 s to generate; ~430 s of that is the InfiniteTalk sampler (2.5× a Wan 2.2
step). Measured (InfiniteTalk stage):
- ComfyUI private memory 29 GB (16 GB RAM), working set 1.7 GB; Windows compresses 8 GB and writes it to disk.
- The GPU mostly draws 56-160 W (~200-250 W at full compute): it is waiting for weights.
- The editing and merging done on the CPU take 6-8 s for the whole film.

Fixes (same settings, frames identical):
- Dynamic VRAM on (Settings > Fine settings > ComfyUI): 789 → 696 s.
- The window in two requests (`lipStages`: the Wan 2.2 steps to a latent file, the InfiniteTalk steps from it): 675 s.
  Compressed memory 8.3 → 4.1 GB.

**Mouth correction (LatentSync, measured 07.10.2026).** After the hybrid scene is generated, the mouths of speaking **humans** are redrawn with their own audio
track (`lip\mouth.py`, LatentSync 1.5, 256-pixel face). Mask from the nose to below the chin; eyes, gaze,
hair and background remain Wan 2.2's frame. Animal speakers keep the InfiniteTalk result, the face model is for humans.
- Same clip and audio:

  | Clip | Without LatentSync | With LatentSync | Mouth-audio offset |
  |---|---|---|---|
  | Dense speech, audio strength 3 | 1.28 | **5.20** | −6 frames → 0 |
  | Dense speech, audio strength 2 | 2.60 | 4.24 | −4 → 0 |
  | Dense speech, Wan 2.2 1 step | 2.92 | 3.88 | −3 → 0 |
  | Elif's line, audio strength 3 | 1.94 | 4.11 | 1 → 0 |

- Checked by eye: no seam or blurry region. In the old hybrid the girl smiled in every frame, now the mouth takes its shape from the
  speech.
- Duration: a 3.24 s clip ~75 s (including ~40 s of model loading). If a scene has two speakers the model is loaded once and the speakers
  are corrected in turn.
- Face detection: LatentSync's InsightFace models are for non-commercial research only. MediaPipe face landmarks
  (Apache-2.0) are put in their place (`lip\patch.py`). The alignment points are the same: between the eyebrows, the middle of the nose. The target face is the face closest
  to the speaker's box in the scene. In a frame where no face is found the previous frame's points are used.
- Setup: `setup.bat` (`lip\LatentSync` pinned commit + patch + `lip\.venv`, sharing the `voice\.venv` packages); models under
  Settings > Models > "Mouth correction (LatentSync)" (~5.5 GB). If not installed, the film is generated with InfiniteTalk only.
- License: the LatentSync code is Apache-2.0, its weights OpenRAIL++ (commercial use allowed, with misuse restrictions).

**Long scene.** A window is 81 frames (3.24 s); the next window continues from the last 9 frames of the previous one (+72 frames).
- 9 s, 3 windows: 1819 s → a second of a dialogue scene ≈ 3.4 min (a normal scene ≈ 1 min).
- Uncorrected windows drifted the colour (brightness 118 → 95, a jump at the start of the 2nd window). Every frame is mapped to the source image's
  colours (ComfyUI `ColorTransfer`, mkl_lab, frame by frame); the next window starts from the corrected frames.
- In the hybrid the first frame of the first window comes out broken (InfiniteTalk rebuilds the first frame at every step); the second frame is copied over it.

**Director's note (every scene, before narration; even when lip sync is off).** User: "Emotion, thought,
behaviour, attitude, expression… it has to be a real human film". The local text model reads the scene image, the narration, the characters and
the lines and writes a director's note for every scene (`directorNote` in the prompt translation module, `director` in the job record):
- **moment:** that moment of the story and its emotional tone.
- **image:** one sentence for the still frame: who looks where, facial expression, body language.
- **characters:** every character's emotion and its intensity, what goes through them, their attitude to the others.
- **lines:** for every line the acting (to whom, gaze, expression, hands and body), the voice (how it is said) and the listener's
  reaction.

These go into the following prompts:
- Image prompt: the image sentence is added in every scene.
- Motion prompts: the text model writes the parts with the emotion, expression, gesture, gaze, listener reaction from the note and small movements such as blinking, breathing,
  shifting weight. In a single-part scene the prompt is written too if this note exists.
- Lip window prompt: the speaker's acting and the listener's reaction.

Why: the old general rule ("speakers look into each other's eyes") made the girl calling "Pamuk! Where are you?" for her lost cat in the forest
look at her father laughing. User: "she's laughing, they're like lovers". The rules of the note:
- The expression matches the meaning of the words (worry while searching for the lost one, joy on reuniting); if the moment is not joyful nobody laughs.
- Whoever calls someone not in the scene looks in that direction.
- Family members do not exchange romantic looks; nobody looks at the camera.

If there is no text model or the note cannot be written, the general layout is used: the speaker turns to the person addressed; the expression matches
the words.

**Window prompt: who is speaking.** In the hybrid Wan 2.2 sets the motion and does not know the audio; InfiniteTalk only fits the lips to the audio in the last two
steps. So the prompt says who is speaking in the window.
- Measured (girl + cat scene, Gemma asked every 0.2 s whether the mouth is open):
  - When the first part prompt saying "the girl is talking" was given to all windows, the girl's mouth was open in 6 of 10 frames while the cat was
    speaking, and the cat's never opened.
  - When "the camera moves closer" was repeated in every window, the framing narrowed.
- Now every window's prompt is built like this:
  - The prompt of the part that falls in the middle of the window.
  - At the start, who is speaking: "Only the kitten is talking…; the girl listens with a closed mouth". If the speech is shorter than 25% of the window,
    "Nobody is talking".
  - Both characters are kept in frame; in continuation windows the camera is static.
- The character definition comes from the type, age and gender ("the girl", "the old man", the animal in the description "the kitten"), because names
  mean nothing to Wan.

**Two speakers.** ComfyUI adds the two voices in sequence: in the window first speaker 1 (with its own mask), then
speaker 2; the split is the middle of the gap where the speaker changes. If the same window goes A-B-A the split that keeps the most speech
is chosen (`panel\lib\lip.mjs`).
- Measured (Elif + Father, 2 windows, 1409 s): Elif's mouth with her own voice r 0.67 (control 0.29), with Father's voice −0.15;
  Father's open mouth with his own voice r 0.32 (control 0.21), closed while Elif speaks. The two spoke turning to each other.
- Position of the speakers: when the images are done, local Gemma finds every speaker's **face** box in the scene image; the mask is that
  box widened 15% to the sides and 30% downwards (chin and mouth); if two masks intersect the raw face boxes are used.
  - Gemma gives the box as `[y_min, x_min, y_max, x_max]` (0-1000); it sometimes writes the humanity as `"label": "human"`.
  - When "head and shoulders" was asked it gave a full-body box: the box of the cat on the lap included the girl's mouth too. When "face
    only" was asked the girl's and the cat's faces were boxed separately and correctly.
- **Animals speak too** (user: "We must be able to make even an animal speak"). Measured (cat on the lap, the cat's line,
  Gemma asked "is the mouth open" every 3 frames): the cat's mouth was open in 15/16 of the voiced frames and 4/11 of the silent ones (right at the start and end
  of the speech); the girl's mouth was open in 2/16 of the voiced frames. The narrator's lips are not moved; if there is no visible speaker
  the scene is generated normally.

**ComfyUI patch.** `comfy_extras\nodes_model_patch.py` installs the InfiniteTalk patch without passing a `dtype`, so the weights are expanded
to fp32 (9.5 GB in RAM instead of 4.7). Before starting ComfyUI the panel adds `dtype=dtype` to the `MultiTalkModelPatch(...)` call
(`panel\lib\comfy-process.mjs` `comfyPatch`); if the block differs from what is expected (ComfyUI was updated) it is left untouched.

## Panel (easy use from the browser)

User, 02.10.2026: *"a panel for easy image-video-voice generation and for generating all of it as a single piece"*.
The **Nedese Studio** shortcut on the desktop (or **Nedese Studio.vbs** in the install folder) opens the tray application
(`tray\tray.ps1`): Nedese Studio (port 1071) runs **without opening a window**, an icon appears at the bottom right.
Right-click: Open panel, Start/stop ComfyUI, Restart panel, Open logs, **Exit** (closes everything;
asks if a job is running). Double-click opens the panel. A service that exits is restarted within 10 s (at most 3 times in 5 min).
ComfyUI is started without a window when a job arrives and closed when the queue empties (Settings, default 10 min).
Logs in `logs\` (panel.log, comfyui.log, tray.log). If the icon is already open the shortcut only opens the panel.
(The personal "Quick Access" page on the developer's machine, `quick-access\`, is not in the repository; if the folder exists the tray serves it on 8190.)
The old way (with a console window): `panel.bat`; if the port is in use `panel.bat --port 1166`; to see ComfyUI in a window `AI_PANEL_COMFY_WINDOW=1`.

**Network access (user's decision: no membership/login):** the panel listens on `0.0.0.0:1071` (`panel\defaults.json`); it opens from every network of the computer **without login** (the router and the firewall rule decide who reaches it; chats from other devices can use files and commands unless Settings › Assistant rules turns it off) (browser requests through the Host/Origin/X-Panel check, programs with `Authorization: Bearer <key>`). If wanted, optional login can be turned on with `AI_PANEL_LOGIN=1`: when opened from another device the API key is asked once (`POST /api/v1/login`), a 90-day session with an HttpOnly + SameSite=Strict cookie (`panel-data\sessions.json`), 8 wrong attempts per IP in 15 minutes → 429. Off by default. The ComfyUI proxy (:8189) is open to the private network without a password (`lib\comfy-proxy.mjs`).

| Section | What it does |
|---|---|
| Image | Prompt → Qwen-Image-2512 or FLUX.2 klein 4B; aspect presets (Qwen's official sizes), steps, seed, count. N images are generated in ONE request: the models load once |
| Video | Source image (upload, drag or pick from the gallery) → Wan 2.2 A14B or 5B; duration 2–8 s, 720p/480p, RIFE 2×/3× → mp4. The orientation is taken from the image |
| Voice | Text → Chatterbox. Voice: a reference from the library, the model's default voice or a **new voice from a description** (Qwen3-TTS designs an English timbre, adds it to the library, the Turkish reading uses that timbre). Quality: 1 take / 3 takes + Whisper / 6 takes + naturalness score. Speed (atempo, pitch preserved) |
| Film | Scene list (narration, image prompt, motion prompt, character lines; optionally a ready image from the gallery) + one voice → one mp4 (+ `.srt`; subtitles can be burned into the video; soft transitions; optional lip sync in dialogue scenes) |
| 3D | Image or a frame chosen from a video → TRELLIS.2 textured GLB. Only the visible part is modelled; **Complete to full body** first draws the person/object from head to toe with Qwen-Image-Edit. If Blender is installed (any version; `Program Files\Blender Foundation\Blender *`, PATH or `AI_PANEL_BLENDER`) a 4 s turntable video and FBX / OBJ (ZIP) / STL (`tools\blender\model3d.py`, headless) |
| Gallery | All outputs: preview, download, "Send to video", retry, delete (to the recycle bin; only the panel's own folders) |

**Film order:** first all narrations in one voice-over run (so the durations are known) → missing images in one ComfyUI request →
every scene's video → scene duration = 0.6 s + narration + 0.7 s: if short the clip is trimmed; if long it is slowed down by at most 1.6× with RIFE
intermediate frames, and if that is not enough the clip is extended by generating a **continuation part from its last frame** → 1280×720 (or 720×1280) 30 fps scene
clips → joined with 0.5 s cross-fades, audio −16 LUFS. If it stops halfway, **Retry** continues where it left off
(ready audio, images and video frames are not regenerated).

**Queue:** graphics-card jobs run in a single line; ComfyUI and narration never at the same time — before narration the job in ComfyUI
is waited for, VRAM is released with `/free`, and the release is measured with nvidia-smi and logged. If ComfyUI is off, the first image/video
job starts `start_comfyui.bat` in its own window (minimised); there is a button in the top bar too. Progress comes from the ComfyUI websocket
(step count) and from script output. The server runs the job: it continues even if the browser tab is closed, and the status is visible when it is reopened.
If the panel window closes, the running job becomes "interrupted". Errors are readable in the UI language (missing model file, VRAM/RAM not enough, ComfyUI exited…);
the raw detail is in the job's log.

**Files:**
- Code in `panel\` (Node, dependency-free; UI on the NDS design system, fonts local), launcher `panel.bat`, icon `panel\icon.ico`.
- Outputs in `outputs\<date-time-type-id>\` (`job.json` + `log.txt` + files); uploaded images and music in `outputs\uploads\`; panel settings and database in `panel-data\`.
- Voice library `voice\references\` (`<id>.wav` + `.json`): starts with "Tok bariton" (the Nedese Prime narrator) and "Yaşlı dede".
- Model file names come from `tools\comfy.mjs` (Q4_K_M on this machine, Q8_0 on the remote machine): the panel code is the same on both machines.
- The duration estimate is the median of the jobs finished on this machine ("no measurement yet" for the first jobs).

**Test:** `node --test "panel\test\*.test.mjs"` — fake ComfyUI + fake narration + real ffmpeg, no graphics card used
(queue, cancel, error paths, security, film end to end). The UI test (`panel\test\ui.test.mjs`) opens the panel in headless Edge, walks through all
the tabs, the training fields, the video models and the language switch; it fails on a page exception or console error
(skipped if Edge is missing). UI check (screenshot + console error / overflow / font measurement):
`node panel\test\ui.mjs --address http://127.0.0.1:1071/ --output <folder>`.
