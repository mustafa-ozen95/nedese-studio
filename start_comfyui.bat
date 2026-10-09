@echo off
rem Yerel yapay zeka sistemi: ComfyUI (image + video), RTX 5070.
rem Arayuz: http://127.0.0.1:8188 (API same address; tools\comfy.mjs). Ev agindan
rem http://<bu-bilgisayar>:8189: Nedese Studio aktarir (guvenlik duvari python'u kapatiyor).
rem Bayraklar bu makineye gore (16 GB RAM): pinned bellek ve dinamik VRAM closed,
rem cache none. Olculdu 29.09.2026: pinned bellekle Wan text kodlayicisi
rem yuklenirken "access violation" ile coktu; bu bayraklarla calisti.
rem --use-sage-attention: SageAttention 2.2 (cu130) + triton-windows 3.8. Olculdu 29.09.2026:
rem dikkat 7,1x (277 -> 39 ms), Wan A14B step 114-118 -> 62-65 sec, clip ~600 -> 365 sec; quality same.
rem Bellek bayraklari Nedese Studio > Ayarlar > Ince settings'dan gelir (AI_COMFY_MEMORY; "none": hicbiri). Elle
rem acilista (degisken none) bu makinenin ayari.
set "BELLEK=--disable-pinned-memory --disable-dynamic-vram --cache-none"
if defined AI_COMFY_MEMORY set "BELLEK=%AI_COMFY_MEMORY%"
if "%BELLEK%"=="none" set "BELLEK="
cd /d "%~dp0ComfyUI_windows_portable"
.\python_embeded\python.exe -s ComfyUI\main.py --windows-standalone-build --listen 127.0.0.1 --port 8188 %BELLEK% --use-sage-attention %*
