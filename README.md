# Nedese Studio

[English](#nedese-studio) · [Türkçe](docs/README.tr.md) · [Guide](docs/GUIDE.md)

A local AI media studio for Windows: image, video, voice, music, 3D model and single-piece film generation, lip sync, model training, data collection and a chat agent. Everything runs on your own computer; no data is sent out.

## Videos

- Turkish: [desktop](https://github.com/mustafa-ozen95/nedese-studio/releases/download/promo-2026.10/nedese-studio-tr-desktop.mp4) · [phone](https://github.com/mustafa-ozen95/nedese-studio/releases/download/promo-2026.10/nedese-studio-tr-phone.mp4)
- English: [desktop](https://github.com/mustafa-ozen95/nedese-studio/releases/download/promo-2026.10/nedese-studio-en-desktop.mp4) · [phone](https://github.com/mustafa-ozen95/nedese-studio/releases/download/promo-2026.10/nedese-studio-en-phone.mp4)

## What it does

- **Images:** generation with Qwen-Image 2512 and FLUX.2 klein; multi-reference editing with Qwen-Image-Edit 2511.
- **Video:** image-to-video with Wan 2.2 (A14B / 5B); unlimited length (5-second parts continue from the previous part's last frame); 480p, 720p and 1080p; frame interpolation with RIFE.
- **Voice:** narration (VoxCPM2, Chatterbox, EMA Lightning), voice cloning from your own recordings, voice design from a description (Qwen3-TTS), per-character voices in films.
- **Music:** songs with or without lyrics using ACE-Step 1.5; a trained LoRA can set the style.
- **3D:** image-to-model with TRELLIS.2 and Pixal3D; turntable video and FBX/OBJ/STL export with Blender.
- **Film:** scenes, character consistency, narration, dialogue, music, subtitles and optional lip sync (InfiniteTalk + LatentSync) combined into one video.
- **Model training:** text model (QLoRA or from scratch), image LoRA, video LoRA, music LoRA and a general image + text model.
- **Data collection:** text, images, video and audio from websites and Wikimedia Commons, ready for training; images are described by the local text model.
- **Local text model:** Gemma (llama.cpp) at an OpenAI-compatible `/llm/v1` endpoint.
- **Chat and agent:** the local text model drives the panel with tool calls (see below).
- **API:** everything the panel does is available through `/api/v1` (docs in the panel at `/api/documents`).

## Requirements

- Windows 10 or 11, 64-bit
- NVIDIA RTX graphics card (defaults were measured on 12 GB VRAM)
- 16 GB RAM (32 GB recommended)
- ~150 GB free disk with all models
- Python, Node.js, ffmpeg and ComfyUI are installed **inside this folder** by `setup.bat`; nothing is installed system-wide.

## Installation

1. Download the repository (Code › Download ZIP) and extract it, e.g. to `C:\nedese-studio` (a short path without spaces or non-ASCII characters, outside OneDrive).
2. Run `setup.bat`. If Windows SmartScreen shows "Windows protected your PC", click *More info › Run anyway* (the script is not code-signed). ComfyUI, Node, ffmpeg, Python, the Python environments and, optionally, the models are installed inside this folder; whatever is installed on the computer (another Python, Node or ffmpeg, any version or none) is not used. The setup checks the graphics driver, memory, disk space and the folder's path first, keeps the computer awake while it runs, and can be run again after an interruption: it continues where it stopped.
   - `setup.bat -Models all`: all models (~150 GB)
   - `setup.bat -Models none`: no model download (download them later from Settings › Models in the panel, or use "Download default models")
3. Start it (see below) and open <http://127.0.0.1:1071> in your browser.

## Starting

- **Tray (recommended):** double-click `Nedese Studio.vbs`. The panel runs without a window; an icon appears in the system tray. Right-click: open the panel, start/stop ComfyUI, restart the panel, open the logs, exit. Double-click opens the panel.
- **Console window:** `panel.bat` (another port: `panel.bat --port 1166`).
- Directly: `node panel\server.mjs [--port 1071] [--no-browser]`.
- ComfyUI is started by the panel when a job needs it and closed when the queue has been idle (Settings, default 10 min). To run it by hand: `start_comfyui.bat` (<http://127.0.0.1:8188>).

The interface is in English (the main language) with a Turkish translation: pick TR in the top bar and the choice is remembered. Clients can pass `?lang=` or the `X-Panel-Lang` header.

## Sections of the panel

| Section | What it does |
|---|---|
| Image | Prompt → Qwen-Image-2512 or FLUX.2 klein 4B; aspect presets, steps, seed, count; trained LoRAs |
| Video | Source image → Wan 2.2 A14B or 5B; 2–8 s parts chained for any length; 480p/720p/1080p; RIFE 2×/3× |
| Voice | Text → narration; voice from the library, your own recording (clone), or a new voice from a description; quality modes with Whisper checking and naturalness scoring |
| Music | Lyrics or instrumental → ACE-Step 1.5; lyric writer; style LoRAs |
| Film | Scene list (narration, image prompt, motion prompt, dialogue) → one MP4 with subtitles, music and optional lip sync; scene writer from a topic |
| 3D | Image or video frame → textured GLB; "Complete to full body"; Blender turntable and FBX/OBJ/STL |
| Gallery | All outputs: preview, download, send to video, retry, delete |
| Training | Text model, image/video/music LoRA, general model; data collection; collected collections |
| Chat | Chat and agent sessions with the local text model |
| Settings | Models and downloads, text model, voice engine, prompts, fine settings, updates, API key |

Jobs run in a single GPU queue on the server: closing the browser tab does not stop them, and a job that was interrupted can be retried from where it left off.

## API

- Base URL: `http://127.0.0.1:1071/api/v1`. The documentation page with every route, field and example is served by the panel at `/api/documents`; an OpenAPI definition at `/api/v1/openapi.json`.
- Authorization: `Authorization: Bearer <key>`; the key is shown (and can be regenerated) under Settings. The browser on the computer running the panel needs no key.
- Jobs: `POST /jobs` with a JSON body whose `type` field selects the job (`image`, `video`, `voice`, `music`, `film`, `training`, `data`, …); `GET /jobs/{id}`, `POST /jobs/{id}/cancel`, retry/pause, `GET /gallery`, `GET /voices`, `POST /write-scenes`, `POST /write-lyrics`, `GET/PATCH /settings`, `GET /models`, `POST /comfy/start`.
- Local text model: OpenAI-compatible `http://<this-computer>:1071/llm/v1` (`/chat/completions`, `/responses`, `/models`) with the same key.

## Chat and agent

The Chat tab talks to the local text model, which can call tools: the panel's own API (create a job, wait for it, return the files), files, shell, SSH, web search, MCP servers (`panel-data\mcp.json`) and skills (`SKILL.md` folders under `panel-data\skills`). Claude Code plugins, skills and MCP servers can be installed into the panel (Settings › Assistant, or the `install_plugin` tool from a GitHub repository, a marketplace or a folder) and are used by the agent the same way; a project folder's `NEDESE.md`, `AGENTS.md` or `CLAUDE.md` adds its own rules. In **agent** mode a single message becomes a multi-step task (step limit 40). Dangerous actions (deleting, destructive commands, settings changes) ask for approval unless the session is unattended. Full access (file/shell/SSH/MCP) is only given to sessions opened from the computer running the panel or with the API key; a keyless browser on the network gets panel operations and web tools only. The same agent is reachable as the `nedese-ajan` model through `/llm/v1/chat/completions`.

## Network access

The panel listens on `0.0.0.0:1071` (both in `panel\defaults.json`) and opens **without a login** from every network the computer is on; who can reach it is up to your router and the firewall rule (private networks only). Browser requests are checked by Host/Origin headers, programs use the Bearer key. Chats from other devices can use files and commands (Settings › Assistant rules turns this off). To keep it on this computer, set `AI_PANEL_ADDRESS=127.0.0.1` or `"address": "127.0.0.1"` in `panel-data\settings.json`. Optional sign-in can be turned on with `AI_PANEL_LOGIN=1`.

## Updates

The panel checks GitHub for the latest version once a day and installs it: only the files that changed are downloaded. When a new version is available, the top bar shows "Update available". To check by hand, use Settings › Updates or the tray icon's menu. Settings, outputs, models and data are not changed by updates. A development copy (git clone) updates with `git pull`.

## Stronger graphics cards

The defaults were measured on a 12 GB graphics card with 16 GB RAM. On a stronger machine, memory measures can be turned off under Settings › Fine settings:

- the ComfyUI model cache
- fp8 and 4-bit in training
- the text model's memory budget
- 720p video training, direct 1080p video

## Troubleshooting

- Logs: `logs\` (`panel.log`, `comfyui.log`, `tray.log`); each job keeps its own `log.txt` under `outputs\<job>\`.
- "Port in use": `panel.bat --port 1166` (the port is remembered in settings).
- ComfyUI does not start: run `start_comfyui.bat` by hand to see its window, or set `AI_PANEL_COMFY_WINDOW=1` before `panel.bat`.
- Out of VRAM/RAM: close other GPU programs (and the browser during long jobs); check Settings › Fine settings.
- Missing model file: Settings › Models shows what is installed and lets you download, upload or move files.
- Hugging Face downloads fail with a symbolic-link error (WinError 1314) on some Windows setups; the setup script downloads into plain folders to avoid it.
- A model download that stalls or crawls is cut and resumed on a fresh connection by itself (setup and Settings › Models); a run of `setup.bat` after an interruption continues from the partial files.
- Setup stops with a path error: move the folder to a short ASCII path such as `C:\nedese-studio` (not inside OneDrive) and run it again.
- An antivirus that quarantines files during setup (Triton/SageAttention build steps): add the folder to its exclusions and run `setup.bat` again.
- After an update that changed the Python environments, the panel asks you to run `setup.bat -Models none`.
- Blender is detected in `Program Files\Blender Foundation\Blender *`, on `PATH` or via `AI_PANEL_BLENDER`.

Environment variables: `AI_PANEL_ADDRESS`, `AI_PANEL_PORT`, `AI_PANEL_LOGIN`, `AI_PANEL_TRAY` (set by the tray), `AI_PANEL_COMFY_WINDOW`, `AI_COMFY_MEMORY` (ComfyUI memory flags), `AI_PANEL_BLENDER`.

## License

Nedese Studio is released under the [PolyForm Noncommercial License 1.0.0](LICENSE.md): you may use, copy, change and share it for any **noncommercial** purpose (personal use, education, research, hobby projects, non-profit work). Commercial use is not permitted. Copyright 2026 Mustafa Özen.

## Third-party components

The models are downloaded from their publishers under their own licenses (most are Apache 2.0 / MIT; LatentSync weights are OpenRAIL++, the audeering age/gender model is CC BY-NC-SA 4.0 and is used only for measurement; details in the guide). Third-party code is vendored under `setup\vendor\<name>` with a `SOURCE.txt` giving its origin, commit and license; the binary tools (7-Zip extractor, Node, ffmpeg, uv, Python, ComfyUI portable, llama.cpp, SageAttention, the environments' Pythons) are downloaded from this repository's own GitHub release (`tools-2026.10`; `setup\tools.json` lists size and SHA-256, which setup verifies), never from another site. Only Python packages (PyPI, pinned versions) and models come from elsewhere.

## Documentation

- English guide (architecture, measurements, every subsystem): [docs/GUIDE.md](docs/GUIDE.md)
- Türkçe README: [docs/README.tr.md](docs/README.tr.md)
- Türkçe kılavuz: [docs/BENIOKU.tr.md](docs/BENIOKU.tr.md)
