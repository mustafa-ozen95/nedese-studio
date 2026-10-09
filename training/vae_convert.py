"""FLUX.2 VAE: diffusers adlandırması (ComfyUI'nin flux2-vae.safetensors'u, klein deposundaki vae/) -> BFL özgün
adlandırması (musubi-tuner'ın beklediği ae.safetensors). Özgün ae.safetensors yalnız onay isteyen FLUX.2-dev
deposunda; ağırlıklar aynı, yalnız anahtar adları ve dikkat katmanlarının biçimi (Linear -> 1x1 Conv) farklı.

python vae_convert.py <input diffusers.safetensors> <output ae.safetensors>
Her hedef anahtar ve boyutu musubi'nin AutoEncoder'ından alınır; eşleşmeyen ya da artan anahtar varsa hata verir.
"""
from __future__ import annotations

import re
import sys

import torch
from safetensors.torch import load_file, save_file


def target_keys() -> dict[str, tuple[int, ...]]:
    from accelerate import init_empty_weights
    from musubi_tuner.flux_2 import flux2_models

    with init_empty_weights():
        ae = flux2_models.AutoEncoder(flux2_models.AutoEncoderParams())
    return {k: tuple(v.shape) for k, v in ae.state_dict().items()}


def bfl_name(k: str, up_count: int) -> str:
    """Tek bir diffusers anahtarının BFL karşılığı."""
    k = k.replace('conv_norm_out', 'norm_out')
    if k.startswith(('quant_conv.', 'post_quant_conv.')):
        return ('encoder.' if k.startswith('quant_conv.') else 'decoder.') + k
    m = re.match(r'(encoder|decoder)\.mid_block\.resnets\.(\d)\.(.*)', k)
    if m:
        return f'{m[1]}.mid.block_{int(m[2]) + 1}.{m[3].replace("conv_shortcut", "nin_shortcut")}'
    m = re.match(r'(encoder|decoder)\.mid_block\.attentions\.0\.(.*)', k)
    if m:
        sub = {'group_norm': 'norm', 'to_q': 'q', 'to_k': 'k', 'to_v': 'v', 'to_out.0': 'proj_out'}
        for d, b in sub.items():
            if m[2].startswith(d + '.'):
                return f'{m[1]}.mid.attn_1.{b}{m[2][len(d):]}'
    m = re.match(r'encoder\.down_blocks\.(\d)\.resnets\.(\d)\.(.*)', k)
    if m:
        return f'encoder.down.{m[1]}.block.{m[2]}.{m[3].replace("conv_shortcut", "nin_shortcut")}'
    m = re.match(r'encoder\.down_blocks\.(\d)\.downsamplers\.0\.conv\.(.*)', k)
    if m:
        return f'encoder.down.{m[1]}.downsample.conv.{m[2]}'
    # Kod çözücüde düzey sırası ters: diffusers up_blocks.0 = BFL up.(n-1)
    m = re.match(r'decoder\.up_blocks\.(\d)\.resnets\.(\d)\.(.*)', k)
    if m:
        return f'decoder.up.{up_count - 1 - int(m[1])}.block.{m[2]}.{m[3].replace("conv_shortcut", "nin_shortcut")}'
    m = re.match(r'decoder\.up_blocks\.(\d)\.upsamplers\.0\.conv\.(.*)', k)
    if m:
        return f'decoder.up.{up_count - 1 - int(m[1])}.upsample.conv.{m[2]}'
    return k  # conv_in, conv_out, norm_out, bn.*


def main() -> None:
    input, output = sys.argv[1], sys.argv[2]
    sd = load_file(input)
    target = target_keys()
    up = 1 + max(int(m[1]) for k in sd if (m := re.match(r'decoder\.up_blocks\.(\d)\.', k)))
    fresh: dict[str, torch.Tensor] = {}
    for k, t in sd.items():
        b = bfl_name(k, up)
        if b not in target:
            raise SystemExit(f'Eşleşmeyen anahtar: {k} -> {b}')
        if tuple(t.shape) != target[b]:
            # Dikkat: diffusers Linear [C, C] -> BFL Conv2d 1x1 [C, C, 1, 1]
            if t.ndim == 2 and len(target[b]) == 4 and tuple(t.shape) == target[b][:2]:
                t = t[:, :, None, None]
            else:
                raise SystemExit(f'Boyut uyuşmuyor: {k} {tuple(t.shape)} -> {b} {target[b]}')
        fresh[b] = t.contiguous()
    missing = sorted(set(target) - set(fresh))
    if missing:
        raise SystemExit(f'Eksik anahtar ({len(missing)}): {missing[:8]}')
    save_file(fresh, output, metadata={'format': 'pt', 'source': 'diffusers -> BFL (training/vae_convert.py)'})
    print(f'TAMAM: {len(fresh)} tensör -> {output}')


if __name__ == '__main__':
    main()
