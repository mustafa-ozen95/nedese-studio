# Nedese Studio one-click setup (Windows 10/11 x64, NVIDIA RTX). Called by setup.bat; safe to run again:
# finished steps are skipped, an interrupted model download resumes where it stopped.
#
# Versions are pinned (the setup that runs on the development machine, 04.10.2026): ComfyUI 0.37.0 portable (Python 3.13,
# torch 2.13 cu130) + custom nodes at fixed commits, Node 24.19.0, ffmpeg 9.0.2, uv 0.12.20, Python environments from
# setup\lock\*.txt. Nothing is installed system-wide and nothing installed on the computer is used (a different Python,
# Node or ffmpeg there does not matter); everything lives inside this folder.
#
# Everything the panel runs on comes from this project itself so versions cannot drift: third-party CODE in
# setup\vendor\<name> (origin and license in SOURCE.txt; when it changes, setup copies the folder again) and the binary
# tools (7zr, Node, ffmpeg, uv, Python, ComfyUI portable, llama.cpp, the SageAttention wheel, the Pythons of the
# environments) from this repository's own GitHub release (tools-2026.10; setup\tools.json lists size and SHA-256, every
# download is checked). Nothing is fetched from another site. Only the Python packages come from PyPI at the versions in
# the lock files, and the models from Hugging Face.
#
#   setup.bat                  interactive (asks about the models)
#   setup.bat -Models all      image + video + music + voice models + text model + lip sync + mouth correction (~147 GB)
#   setup.bat -Models none     no model download (download them later in the panel's Settings, or move your own files)
param(
    [ValidateSet('ask', 'all', 'none')][string]$Models = 'ask',
    [switch]$NoShortcut
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$Downloads = Join-Path $PSScriptRoot '_downloads'
# Windows' own tar (bsdtar, opens zip). Full path, so Git Bash's tar on the PATH (which does not understand Windows paths) is not used.
$Tar = Join-Path $env:WINDIR 'System32\tar.exe'
New-Item -ItemType Directory -Force $Downloads | Out-Null
Start-Transcript -Path (Join-Path $PSScriptRoot 'setup.log') -Append | Out-Null

function Title($m) { Write-Host ''; Write-Host "== $m" -ForegroundColor Cyan }
function Done($m) { Write-Host "   $m" -ForegroundColor Green }
function Info($m) { Write-Host "   $m" }
function Stop-Setup($m) { Write-Host ''; Write-Host "ERROR: $m" -ForegroundColor Red; Stop-Transcript | Out-Null; exit 1 }

# curl.exe (comes with Windows 10 1803+): redirects, resume, retries; the file is checked with SHA-256 when one is given.
function Fetch($url, $target, $sha256) {
    if ((Test-Path $target) -and $sha256 -and ((Get-FileHash $target -Algorithm SHA256).Hash -eq $sha256.ToUpper())) { return }
    New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
    for ($i = 1; $i -le 3; $i++) {
        & curl.exe -L --fail --retry 5 --retry-delay 5 -C - -o $target $url
        if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 33) {
            if (-not $sha256) { return }
            if ((Get-FileHash $target -Algorithm SHA256).Hash -eq $sha256.ToUpper()) { return }
            Info "SHA-256 mismatch, downloading again: $(Split-Path -Leaf $target)"
            Remove-Item $target -Force
        }
        Start-Sleep 5
    }
    Stop-Setup "Could not download $url."
}

# The binary tools come from this repository's own GitHub release (setup\tools.json: file, size, sha256; the release
# holds the same files under their base names), never from another site: a file upstream may change or disappear,
# this copy cannot. Downloaded into setup\_downloads, checked with SHA-256. Returns the local path.
$Mirror = 'https://github.com/mustafa-ozen95/nedese-studio/releases/download/tools-2026.10'
$Tools = Get-Content (Join-Path $PSScriptRoot 'tools.json') -Raw -Encoding UTF8 | ConvertFrom-Json
function Get-Tool($name) {
    $t = $Tools | Where-Object { $_.file -eq $name }
    if (-not $t) { Stop-Setup "setup\tools.json does not list $name." }
    $target = Join-Path $Downloads ($name -replace '/', '\')
    if (-not ((Test-Path $target) -and (Get-Item $target).Length -eq $t.size -and (Get-FileHash $target -Algorithm SHA256).Hash -eq $t.sha256.ToUpper())) {
        Info "Downloading $(Split-Path -Leaf $name) ($([math]::Round($t.size / 1MB)) MB)..."
        Fetch "$Mirror/$([uri]::EscapeDataString((Split-Path -Leaf $name)))" $target $t.sha256
    }
    return $target
}

# Third-party code (setup\vendor\<name>, origin/license in SOURCE.txt) is copied to its target; extra files there
# (environment, outputs, downloaded weights) are kept. Copied again when SOURCE.txt changes. Returns $true if it copied.
function Copy-Vendor($name, $target) {
    $source = Join-Path $PSScriptRoot "vendor\$name"
    $note = Join-Path $source 'SOURCE.txt'
    if (-not (Test-Path $note)) { Stop-Setup "setup\vendor\$name is missing (the repository was downloaded incompletely)." }
    $digest = (Get-FileHash $note -Algorithm SHA256).Hash
    $marker = Join-Path $target '.setup-source'
    if ((Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $digest)) { Done "$name ready."; return $false }
    New-Item -ItemType Directory -Force $target | Out-Null
    Copy-Item (Join-Path $source '*') $target -Recurse -Force
    Set-Content $marker $digest
    Done "$name copied (setup\vendor)."
    return $true
}

# Runs a command; stops if the exit code is not 0.
function Invoke-Step($exe, [string[]]$arguments, $description) {
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { Stop-Setup "$description failed (exit code $LASTEXITCODE)." }
}

# Whether the lock file's digest matches the marker (the step already ran with this lock).
function Test-Lock($marker, $digest) { return (Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $digest) }

Write-Host 'Nedese Studio setup' -ForegroundColor Cyan
Write-Host "Folder: $Root"

# -- 1. Checks ---------------------------------------------------------------
Title 'Checks'
if (-not [Environment]::Is64BitOperatingSystem) { Stop-Setup '64-bit Windows is required.' }
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { Stop-Setup 'curl.exe not found (Windows 10 1803 or later is required).' }
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $smi) { Stop-Setup 'NVIDIA graphics driver not found (no nvidia-smi). Install the driver from nvidia.com.' }
$gpu = (& nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader | Select-Object -First 1).Split(',') | ForEach-Object { $_.Trim() }
$driver = [version]($gpu[1])
Info "Graphics card: $($gpu[0]), $($gpu[2]), driver $($gpu[1])"
# CUDA 13 (ComfyUI torch cu130) needs driver 580 or later.
if ($driver.Major -lt 580) { Stop-Setup "Driver $($gpu[1]) is too old: CUDA 13 needs at least 580. Update it from nvidia.com." }
$disk = (Get-PSDrive -Name (Split-Path -Qualifier $Root).TrimEnd(':'))
$freeGb = [math]::Round($disk.Free / 1GB)
Info "Free disk: $freeGb GB"
# A first install needs ~45 GB without models; a repeated run needs much less.
$firstInstall = -not (Test-Path (Join-Path $Root 'ComfyUI_windows_portable\python_embeded\python.exe'))
if ($firstInstall -and $freeGb -lt 45) { Stop-Setup 'At least 45 GB of free space is needed (models not included).' }
Done 'OK.'

# -- 2. Tools: 7-Zip (extractor), Node, ffmpeg, uv, Python --------------------
Title 'Tools'
$7z = Get-Tool '7zr.exe'

# Extracts a tool archive (zip or tar.gz, with Windows' tar) into <root>\<target>.
function Install-Zip($name, $file, $innerFolder, $target, $check) {
    if (Test-Path (Join-Path $Root $check)) { Done "$name ready."; return }
    $zip = Get-Tool $file
    $temp = Join-Path $Downloads "_open_$name"
    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
    Invoke-Step $Tar @('-xf', $zip, '-C', (New-Item -ItemType Directory -Force $temp).FullName) "Extracting $name"
    $targetPath = Join-Path $Root $target
    if (Test-Path $targetPath) { Remove-Item $targetPath -Recurse -Force }
    $source = if ($innerFolder) { Join-Path $temp $innerFolder } else { $temp }
    Move-Item $source $targetPath
    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
    Remove-Item $zip -Force
    Done "$name installed."
}
Install-Zip 'Node 24.19.0' 'node-v24.19.0-win-x64.zip' 'node-v24.19.0-win-x64' 'node' 'node\node.exe'
Install-Zip 'ffmpeg 9.0.2' 'ffmpeg-9.0.2-essentials_build.zip' 'ffmpeg-9.0.2-essentials_build' 'ffmpeg' 'ffmpeg\bin\ffmpeg.exe'
Install-Zip 'uv 0.12.20' 'uv-x86_64-pc-windows-msvc.zip' $null 'uv' 'uv\uv.exe'
# Python for the assistant's commands (portable, pinned: no version trouble with what is installed on the computer)
Install-Zip 'Python 3.12.15' 'cpython-3.12.15+20261003-x86_64-pc-windows-msvc-install_only_stripped.tar.gz' 'python' 'python' 'python\python.exe'
$Node = Join-Path $Root 'node\node.exe'
$Uv = Join-Path $Root 'uv\uv.exe'
$env:PATH = "$(Join-Path $Root 'ffmpeg\bin');$(Join-Path $Root 'node');$env:PATH"

# -- 3. ComfyUI ----------------------------------------------------------------
Title 'ComfyUI 0.37.0'
$Portable = Join-Path $Root 'ComfyUI_windows_portable'
$Py = Join-Path $Portable 'python_embeded\python.exe'
if (-not (Test-Path $Py)) {
    $7zFile = Get-Tool 'ComfyUI_windows_portable_nvidia.7z'
    Info 'Extracting...'
    Invoke-Step $7z @('x', $7zFile, "-o$Root", '-y', '-bso0', '-bsp1') 'Extracting ComfyUI'
    if (-not (Test-Path $Py)) { Stop-Setup 'ComfyUI was extracted but python_embeded was not found.' }
    Remove-Item $7zFile -Force
}
Done 'ComfyUI ready.'

# Custom nodes (ComfyUI-GGUF, ComfyUI-Frame-Interpolation) from the repository's copy: setup\vendor\<name>\SOURCE.txt (commit, license).
foreach ($name in @('ComfyUI-GGUF', 'ComfyUI-Frame-Interpolation')) {
    Copy-Vendor $name (Join-Path $Portable "ComfyUI\custom_nodes\$name") | Out-Null
}

$comfyLock = Join-Path $PSScriptRoot 'lock\comfy-extra.txt'
$comfyMarker = Join-Path $Portable '.setup-packages'
$comfyDigest = (Get-FileHash $comfyLock -Algorithm SHA256).Hash
if (-not (Test-Lock $comfyMarker $comfyDigest)) {
    # The SageAttention wheel is in the lock with its upstream URL + sha256: the release copy is used, the lock is copied pointing to it.
    $lockText = Get-Content $comfyLock -Raw
    $lockToInstall = $comfyLock
    if ($lockText -match 'sageattention @ (\S+?)#sha256=([0-9a-f]{64})') {
        $sageFile = Get-Tool ([uri]::UnescapeDataString((Split-Path -Leaf $Matches[1])))
        $lockToInstall = Join-Path $Downloads 'comfy-extra.txt'
        Set-Content $lockToInstall ($lockText -replace 'sageattention @ \S+', "sageattention @ file:///$($sageFile.Replace('\', '/'))") -Encoding ASCII
    }
    Info 'Installing the extra packages (GGUF, SageAttention, Triton, Whisper...)...'
    Invoke-Step $Py @('-s', '-m', 'pip', 'install', '--no-deps', '--no-warn-script-location', '-r', $lockToInstall) 'ComfyUI extra packages'
    Set-Content $comfyMarker $comfyDigest
}
Done 'ComfyUI packages ready.'

# The models live outside ComfyUI (an update does not delete them): extra_model_paths.yaml points to this folder.
$modelRoot = (Join-Path $Root 'models').Replace('\', '/') + '/'
$yaml = @"
# Written by setup: ComfyUI looks for models outside its own folder ($modelRoot).
local:
  base_path: $modelRoot
  checkpoints: checkpoints/
  diffusion_models: diffusion_models/
  text_encoders: text_encoders/
  clip: text_encoders/
  vae: vae/
  loras: loras/
  upscale_models: upscale_models/
  clip_vision: clip_vision/
  background_removal: background_removal/
  geometry_estimation: geometry_estimation/
  audio_encoders: audio_encoders/
  model_patches: model_patches/
"@
foreach ($k in @('checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras', 'upscale_models', 'clip_vision', 'background_removal', 'geometry_estimation', 'audio_encoders', 'model_patches', 'voice')) { New-Item -ItemType Directory -Force (Join-Path $Root "models\$k") | Out-Null }
Set-Content -Path (Join-Path $Portable 'ComfyUI\extra_model_paths.yaml') -Value $yaml -Encoding ASCII
Set-Content -Path (Join-Path $Root 'extra_model_paths.yaml') -Value $yaml -Encoding ASCII
Done 'Model folders ready.'

# -- 4. Python environments: voice + model training (uv, pinned Python) -------
Title 'Python environments (voice, model training)'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $Root 'uv\python'
$env:UV_CACHE_DIR = Join-Path $Root 'uv\cache'
$env:UV_LINK_MODE = 'copy'
# The environments' Pythons (python-build-standalone 20260924) come from the release too: uv reads them from setup\_downloads\python, not from the internet.
foreach ($t in $Tools) { if ($t.file -like 'python/*') { Get-Tool $t.file | Out-Null } }
$env:UV_PYTHON_INSTALL_MIRROR = 'file:///' + (Join-Path $Downloads 'python').Replace('\', '/')
$Environments = @(
    @{ name = 'Narration (Chatterbox + Whisper)'; folder = 'voice\.venv'; python = '3.14.7'; lock = 'voice.txt'; cuda = 'cu130' },
    @{ name = 'VoxCPM2 (narration)'; folder = 'voice\voxcpm\.venv'; python = '3.12.14'; lock = 'voxcpm.txt'; cuda = 'cu128' },
    @{ name = 'Voice design (Qwen3-TTS)'; folder = 'voice\design\.venv'; python = '3.13.15'; lock = 'design.txt'; cuda = 'cu130' },
    # Model training (training\train.py): bitsandbytes (QLoRA) works with torch 2.11 cu128 on RTX 50 cards.
    @{ name = 'Model training (QLoRA, from scratch)'; folder = 'training\.venv'; python = '3.13.15'; lock = 'training.txt'; cuda = 'cu128' },
    # Image LoRA training (training\image.py): musubi-tuner (code in setup\vendor\musubi-tuner, environment training\musubi\.venv).
    @{ name = 'Image training (musubi-tuner)'; folder = 'training\musubi\.venv'; python = '3.12.14'; lock = 'musubi.txt'; cuda = 'cu128'; source = 'musubi' }
)
# musubi-tuner (kohya-ss, Apache 2.0; commit in SOURCE.txt): FLUX.2 klein / Wan 2.2 / Qwen-Image LoRA training.
Copy-Vendor 'musubi-tuner' (Join-Path $Root 'training\musubi') | Out-Null
foreach ($o in $Environments) {
    $venv = Join-Path $Root $o.folder
    $vpy = Join-Path $venv 'Scripts\python.exe'
    $lock = Join-Path $PSScriptRoot "lock\$($o.lock)"
    $marker = Join-Path $venv '.setup-lock'
    $digest = (Get-FileHash $lock -Algorithm SHA256).Hash
    if (Test-Lock $marker $digest) { Done "$($o.name) ready."; continue }
    Info "$($o.name): Python $($o.python) + packages (torch $($o.cuda))..."
    if (-not (Test-Path $vpy)) { Invoke-Step $Uv @('venv', '--python', $o.python, $venv) "$($o.name) environment" }
    # --no-deps: the lock is the complete package list (no dependency resolution; e.g. Chatterbox's spacy-pkuseg, which
    # we do not need, would have to be compiled on Python 3.14). The environment is exactly the tested one.
    $uvArgs = @('pip', 'install', '--no-deps', '--python', $vpy, '-r', $lock,
        '--index-url', "https://download.pytorch.org/whl/$($o.cuda)",
        '--extra-index-url', 'https://pypi.org/simple',
        '--index-strategy', 'unsafe-best-match')
    # Building a package occasionally crashes (memory pressure, 0xc0000005): try once more.
    & $Uv @uvArgs
    if ($LASTEXITCODE -ne 0) { Info 'Trying again...'; Invoke-Step $Uv $uvArgs "$($o.name) packages" }
    # A package installed from source (musubi-tuner): its dependencies are in the lock, itself in editable mode
    if ($o.source) { Invoke-Step $Uv @('pip', 'install', '--no-deps', '--python', $vpy, '-e', (Join-Path $Root "training\$($o.source)")) "$($o.name) source" }
    Set-Content $marker $digest
    Done "$($o.name) installed."
}

# EMA Lightning (one Turkish female voice, very fast; Apache 2.0): a small separate environment, the heavy packages
# (torch, numpy...) are shared from voice\.venv (same Python 3.14). Model (~34 MB) and the library voice: voice-models.py ema.
$emaVenv = Join-Path $Root 'voice\ema\.venv'
$emaPy = Join-Path $emaVenv 'Scripts\python.exe'
$emaLock = Join-Path $PSScriptRoot 'lock\ema.txt'
$emaMarker = Join-Path $emaVenv '.setup-lock'
$emaDigest = (Get-FileHash $emaLock -Algorithm SHA256).Hash
if (Test-Lock $emaMarker $emaDigest) { Done 'EMA Lightning ready.' } else {
    if (-not (Test-Path $emaPy)) { Invoke-Step $Uv @('venv', '--python', '3.14.7', $emaVenv) 'EMA Lightning environment' }
    Set-Content (Join-Path $emaVenv 'Lib\site-packages\_voice_environment.pth') (Join-Path $Root 'voice\.venv\Lib\site-packages') -Encoding ASCII
    Invoke-Step $Uv @('pip', 'install', '--no-deps', '--python', $emaPy, '-r', $emaLock) 'EMA Lightning packages'
    $env:PYTHONUTF8 = '1'
    Invoke-Step $emaPy @((Join-Path $PSScriptRoot 'voice-models.py'), 'ema') 'EMA Lightning model and library voice'
    Set-Content $emaMarker $emaDigest
    Done 'EMA Lightning installed.'
}

# Mouth correction (LatentSync 1.5, lip\mouth.py): in single-piece lip sync the mouths of talking people follow their
# own voice (measured 07.10.2026: SyncNet LSE-C 1.28 -> 5.20). Code in setup\vendor\LatentSync (Apache-2.0, commit in
# SOURCE.txt); face detection through a MediaPipe patch (lip\patch.py; LatentSync's InsightFace models are for
# noncommercial use). The environment shares voice\.venv's packages (same Python 3.14); the models (~5.5 GB) come with
# download-models.mjs (catalog "Mouth correction (LatentSync)").
$Lip = Join-Path $Root 'lip'
$lipVenv = Join-Path $Lip '.venv'
$lipPy = Join-Path $lipVenv 'Scripts\python.exe'
$lipLock = Join-Path $PSScriptRoot 'lock\lip.txt'
$lipMarker = Join-Path $lipVenv '.setup-lock'
# If the source was copied again (first install or a new version) the patch must be applied again: the marker is deleted.
if (Copy-Vendor 'LatentSync' (Join-Path $Lip 'LatentSync')) { Remove-Item $lipMarker -Force -ErrorAction SilentlyContinue }
$lipDigest = (Get-FileHash $lipLock -Algorithm SHA256).Hash + (Get-FileHash (Join-Path $Lip 'patch.py') -Algorithm SHA256).Hash
if (Test-Lock $lipMarker $lipDigest) { Done 'Mouth correction (LatentSync) ready.' } else {
    if (-not (Test-Path $lipPy)) { Invoke-Step $Uv @('venv', '--python', '3.14.7', $lipVenv) 'Mouth correction environment' }
    Set-Content (Join-Path $lipVenv 'Lib\site-packages\_voice_environment.pth') (Join-Path $Root 'voice\.venv\Lib\site-packages') -Encoding ASCII
    Invoke-Step $Uv @('pip', 'install', '--no-deps', '--python', $lipPy, '-r', $lipLock, '--index-url', 'https://download.pytorch.org/whl/cu130', '--extra-index-url', 'https://pypi.org/simple', '--index-strategy', 'unsafe-best-match') 'Mouth correction packages'
    $env:PYTHONUTF8 = '1'
    Invoke-Step $lipPy @((Join-Path $Lip 'patch.py')) 'LatentSync patch (MediaPipe, no decord)'
    Set-Content $lipMarker $lipDigest
    Done 'Mouth correction (LatentSync) installed.'
}

# Music LoRA training (training\music.py): Side-Step (koda-dernet, MIT; code in setup\vendor\Side-Step); ACE-Step 1.5 LoRA.
# Its repository has no uv.lock (.gitignore): the solution that works here is kept as setup\lock\sidestep-uv.lock, copied
# into the source and installed exactly (Python 3.11.16, torch 2.7.1 cu128, a prebuilt flash-attn wheel).
$SideStep = Join-Path $Root 'training\sidestep'
Copy-Vendor 'Side-Step' $SideStep | Out-Null
$ssLock = Join-Path $PSScriptRoot 'lock\sidestep-uv.lock'
$ssMarker = Join-Path $SideStep '.venv\.setup-lock'
$ssDigest = (Get-FileHash $ssLock -Algorithm SHA256).Hash
if (Test-Lock $ssMarker $ssDigest) { Done 'Music training (Side-Step) ready.' } else {
    Info 'Music training (Side-Step): Python 3.11.16 + packages (torch 2.7.1 cu128)...'
    Copy-Item $ssLock (Join-Path $SideStep 'uv.lock') -Force
    Invoke-Step $Uv @('sync', '--frozen', '--project', $SideStep, '--python', '3.11.16') 'Music training packages'
    Set-Content $ssMarker $ssDigest
    Done 'Music training (Side-Step) installed.'
}

# Model training: the llama.cpp GGUF converter (convert_hf_to_gguf.py + conversion\; in setup\vendor\llama.cpp).
# The SAME version as llama-server/llama-quantize in llm\bin (b11392); the gguf package in the lock is from this commit too.
Copy-Vendor 'llama.cpp' (Join-Path $Root 'training\converter') | Out-Null

# The local text model server (llm\bin): llama.cpp b11392, Windows CUDA 13.4 (the same version as the GGUF converter).
$LlmBin = Join-Path $Root 'llm\bin'
if (Test-Path (Join-Path $LlmBin 'llama-server.exe')) { Done 'llama.cpp (text model server) ready.' } else {
    New-Item -ItemType Directory -Force $LlmBin | Out-Null
    foreach ($name in @('llama-b11392-bin-win-cuda-13.4-x64.zip', 'cudart-llama-bin-win-cuda-13.4-x64.zip')) {
        $zip = Get-Tool $name
        Invoke-Step $Tar @('-xf', $zip, '-C', $LlmBin) "Extracting $name"
        Remove-Item $zip -Force
    }
    Done 'llama.cpp (text model server) installed.'
}

# -- 5. Models (optional) ------------------------------------------------------
Title 'Models'
$choice = $Models
if ($choice -eq 'ask') {
    & $Node (Join-Path $PSScriptRoot 'download-models.mjs') --list
    Write-Host ''
    Write-Host '   Download the models now? Not required: you can download them later in the panel''s Settings,'
    Write-Host '   or pick a file you downloaded yourself with "Browse" and move it in.'
    Write-Host '     1) All (image + video + music + voice)'
    Write-Host '     2) Choose'
    Write-Host '     3) None (for now)'
    $c = Read-Host '   Choice [1/2/3]'
    $choice = switch ($c) { '1' { 'all' } '2' { 'choose' } default { 'none' } }
}
if ($choice -eq 'none') {
    Info 'No models downloaded. Download them in Panel > Settings > Models.'
} else {
    $skip = @()
    $voiceModels = $true
    $textModel = $true
    if ($choice -eq 'choose') {
        $groups = @(
            @{ question = 'Image: Qwen-Image (strongest, ~23 GB)'; generator = 'qwenJob' },
            @{ question = 'Image: FLUX.2 klein 4B (very fast, ~8 GB)'; generator = 'fluxJob' },
            @{ question = 'Video: Wan 2.2 A14B (~27 GB)'; generator = 'wan14Job' },
            @{ question = 'Video: Wan 2.2 5B (light, ~11 GB)'; generator = 'wanJob' },
            @{ question = 'Music: ACE-Step 1.5 (~10 GB)'; generator = 'musicJob' },
            @{ question = 'Lip sync: InfiniteTalk (lips follow the voice in films with dialogue, ~16 GB)'; generator = 'lipJob' },
            @{ question = 'Mouth correction: LatentSync (the mouths of talking people follow the voice, ~5.5 GB)'; generator = 'mouthJob' }
        )
        foreach ($g in $groups) {
            $y = Read-Host "   Download $($g.question)? [Y/n]"
            if ($y -match '^[nN]') { $skip += $g.generator }
        }
        $y = Read-Host '   Download the voice models (Chatterbox, VoxCPM2, Whisper, Qwen3-TTS; ~17 GB)? [Y/n]'
        if ($y -match '^[nN]') { $voiceModels = $false }
        $y = Read-Host '   Download the text model Gemma 4 26B-A4B QAT (~14 GB)? [Y/n]'
        if ($y -match '^[nN]') { $textModel = $false }
    }
    # The text model (Settings > Text model; /llm/v1): Google's official QAT Q4_0 GGUF (Apache 2.0)
    if ($textModel) {
        $gemma = Join-Path $Root 'llm\models\gemma-4-26B-qat-q4_0.gguf'
        New-Item -ItemType Directory -Force (Split-Path $gemma) | Out-Null
        if (Test-Path $gemma) { Done 'Text model (Gemma 4 26B) ready.' } else {
            Info 'Downloading the text model Gemma 4 26B-A4B QAT Q4_0 (~14 GB)...'
            $part = "$gemma.part"
            Fetch 'https://huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf/resolve/main/gemma-4-26B_q4_0-it.gguf' $part '3eca3b8f6d7baf218a7dd6bba5fb59a56ee25fe2d567b6f5f589b4f697eca51d'
            Move-Item $part $gemma
            Done 'Text model (Gemma 4 26B) downloaded.'
        }
        # The vision encoder (official, 1.19 GB): the text model reads images too; the panel runs it on the CPU for MoE models (the writing speed does not change)
        $gemmaVision = Join-Path $Root 'llm\models\mmproj-gemma-4-26B-qat-q4_0.gguf'
        if (-not (Test-Path $gemmaVision)) {
            Fetch 'https://huggingface.co/google/gemma-4-26B-A4B-it-qat-q4_0-gguf/resolve/main/gemma-4-26B-it-mmproj.gguf' "$gemmaVision.part" 'a359953a076b877db30c31dbbb4c6d93b4a6e017ee5db5784247e4d4c0dd4f3b'
            Move-Item "$gemmaVision.part" $gemmaVision
            Done 'The text model''s vision encoder downloaded.'
        }
    }
    $arguments = @((Join-Path $PSScriptRoot 'download-models.mjs'))
    if ($skip.Count) { $arguments += @('--skip', ($skip -join ',')) }
    Invoke-Step $Node $arguments 'Model download'
    if ($voiceModels) {
        $voiceScript = Join-Path $PSScriptRoot 'voice-models.py'
        $env:PYTHONUTF8 = '1'
        Invoke-Step (Join-Path $Root 'voice\.venv\Scripts\python.exe') @($voiceScript, 'voice') 'Voice models (Chatterbox/Whisper)'
        Invoke-Step (Join-Path $Root 'voice\voxcpm\.venv\Scripts\python.exe') @($voiceScript, 'voxcpm') 'VoxCPM2 model'
        Invoke-Step (Join-Path $Root 'voice\design\.venv\Scripts\python.exe') @($voiceScript, 'design') 'Qwen3-TTS models'
    }
    Done 'Models done.'
}

# -- 6. Desktop shortcut -------------------------------------------------------
if (-not $NoShortcut) {
    Title 'Shortcut'
    $desktop = [Environment]::GetFolderPath('Desktop')
    $ws = New-Object -ComObject WScript.Shell
    $icon = Join-Path $Root 'panel\icon.ico'
    # Tray icon (Nedese Studio.vbs -> tray\tray.ps1): the panel runs without a window, with an icon at the bottom right.
    # A one-click shortcut on the desktop and in the install folder.
    foreach ($place in @((Join-Path $desktop 'Nedese Studio.lnk'), (Join-Path $Root 'Nedese Studio.lnk'))) {
        $k = $ws.CreateShortcut($place)
        $k.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
        $k.Arguments = '"' + (Join-Path $Root 'Nedese Studio.vbs') + '"'
        $k.WorkingDirectory = $Root
        $k.Description = 'Nedese Studio (icon at the bottom right)'
        if (Test-Path $icon) { $k.IconLocation = $icon }
        $k.Save()
    }
    Done "'Nedese Studio' shortcut on the desktop and in the install folder (opens the icon at the bottom right)."
}

# -- 6b. Command line: "nedese" in any folder (<ai>\bin on the user PATH; only the launcher lives there) --
$bin = Join-Path $Root 'bin'
if (Test-Path (Join-Path $bin 'nedese.cmd')) {
    Title 'CLI'
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if ($parts -notcontains $bin) { [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User') }
    Done "nedese: in a new terminal, type 'nedese' in any folder (nedese --help)."
}

# -- 6c. Firewall: the panel's port for the phone and other computers at home (Private networks only; one UAC prompt) --
# the port of this installation (panel-data\settings.json), else the default in panel\defaults.json
$panelPort = (Get-Content (Join-Path $Root 'panel\defaults.json') -Raw -Encoding UTF8 | ConvertFrom-Json).port
try { $p = [int](Get-Content (Join-Path $Root 'panel-data\settings.json') -Raw -Encoding UTF8 | ConvertFrom-Json).port; if ($p -gt 0) { $panelPort = $p } } catch {}
$ruleName = "Nedese Studio $panelPort"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    Title 'Firewall'
    $rule = "New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Protocol TCP -LocalPort $panelPort -Action Allow -Profile Private | Out-Null"
    try {
        Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $rule)
    } catch {}
    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
        Done "Firewall: port $panelPort is open on private networks (home Wi-Fi), closed on public ones."
        $public = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })
        if ($public.Count) { Info "This network is set to Public: to reach the panel from the phone, set it to Private in Windows Settings > Network." }
    } else {
        Info "Firewall rule not added (approval declined): the panel works on this computer; other devices cannot reach it."
    }
}

# -- 7. Verification -----------------------------------------------------------
Title 'Verification'
$failed = 0
function Test-Tool($name, $exe, [string[]]$arguments) {
    # PowerShell 5.1: a stderr line coming with 2>&1 (e.g. qwen_tts' "no sox" warning) stops the script under 'Stop'.
    $ErrorActionPreference = 'Continue'
    # Show the version line (some packages print a banner at the end): the CUDA/ffmpeg/Node line, else the last non-empty line.
    $lines = @(& $exe @arguments 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match '\S' })
    $output = ($lines | Where-Object { $_ -match 'NVIDIA|ffmpeg version|^v\d' } | Select-Object -First 1)
    if (-not $output) { $output = $lines | Select-Object -Last 1 }
    if ($LASTEXITCODE -eq 0) { Done "$name`: $output" } else { Write-Host "   $name`: FAILED ($output)" -ForegroundColor Red; $script:failed++ }
}
Test-Tool 'Node' $Node @('--version')
Test-Tool 'ffmpeg' (Join-Path $Root 'ffmpeg\bin\ffmpeg.exe') @('-version')
# NO double quotes in the code: PowerShell 5.1 drops double quotes in an argument to a native program and splits the code.
$torchCheck = 'import torch; assert torch.cuda.is_available(), ''no CUDA''; print(torch.__version__, torch.cuda.get_device_name(0))'
Test-Tool 'ComfyUI torch' $Py @('-s', '-c', "$torchCheck; import sageattention, gguf")
Test-Tool 'Narration' (Join-Path $Root 'voice\.venv\Scripts\python.exe') @('-c', "$torchCheck; import chatterbox, whisper")
Test-Tool 'VoxCPM2' (Join-Path $Root 'voice\voxcpm\.venv\Scripts\python.exe') @('-c', "$torchCheck; import voxcpm")
Test-Tool 'Voice design' (Join-Path $Root 'voice\design\.venv\Scripts\python.exe') @('-c', "$torchCheck; import qwen_tts")
Test-Tool 'EMA Lightning' $emaPy @('-c', "$torchCheck; import ema_lightning")
Test-Tool 'Mouth correction (LatentSync)' $lipPy @('-c', "$torchCheck; import mediapipe, diffusers, kornia, DeepCache, torchvision")
Test-Tool 'Model training' (Join-Path $Root 'training\.venv\Scripts\python.exe') @('-c', "$torchCheck; import peft, bitsandbytes, sentencepiece, gguf")
Test-Tool 'Image training' (Join-Path $Root 'training\musubi\.venv\Scripts\python.exe') @('-c', "$torchCheck; import musubi_tuner, accelerate, diffusers, bitsandbytes")
Test-Tool 'Music training' (Join-Path $Root 'training\sidestep\.venv\Scripts\python.exe') @('-c', "$torchCheck; import sidestep_engine, peft, lightning, bitsandbytes")
& $Node (Join-Path $PSScriptRoot 'download-models.mjs') --list | Select-Object -First 1 | ForEach-Object { Info $_ }

Write-Host ''
if ($failed) {
    Write-Host "Setup finished, but $failed checks failed; details in setup\setup.log." -ForegroundColor Yellow
} else {
    Write-Host "Setup complete. Open the `"Nedese Studio`" shortcut on the desktop: an icon appears at the bottom right (right-click for the menu, double-click for the panel); the panel is at http://127.0.0.1:$panelPort." -ForegroundColor Green
}
Stop-Transcript | Out-Null
