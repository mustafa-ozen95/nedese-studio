"""14B QLoRA bellek dökümü: yükleme / LoRA / tek adım (farklı bağlamlarda), adım süresi.
python vram-olc.py <model_klasoru> <baglam,...> [secenekler: kaydet_cpu]"""
import json
import sys
import time
from pathlib import Path

import torch

sys.path.insert(0, r'C:\Users\root\ai\training')
import train  # noqa: E402
from peft import LoraConfig, get_peft_model  # noqa: E402
from transformers import AutoModelForCausalLM, BitsAndBytesConfig  # noqa: E402

train.attention_patch()
folder = Path(sys.argv[1])
contexts = [int(x) for x in sys.argv[2].split(',')]
option = sys.argv[3] if len(sys.argv) > 3 else ''
G = 2 ** 30
structure = json.loads((folder / 'config.json').read_text())
map = {'model.embed_tokens': 'cpu', '': 0} if not structure.get('tie_word_embeddings') else {'': 0}
model = AutoModelForCausalLM.from_pretrained(
    str(folder), dtype=torch.bfloat16, device_map=map, low_cpu_mem_usage=True,
    quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_compute_dtype=torch.bfloat16,
                                           bnb_4bit_use_double_quant=True, llm_int8_enable_fp32_cpu_offload=True, llm_int8_skip_modules=[]))
print('yükleme', round(torch.cuda.memory_allocated() / G, 2), 'GB; lm_head', type(model.lm_head).__name__, model.lm_head.weight.dtype, flush=True)
model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
model.enable_input_require_grads()
model.config.use_cache = False
model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type='CAUSAL_LM', target_modules='all-linear'))
print('lora', round(torch.cuda.memory_allocated() / G, 2), 'GB', flush=True)
import bitsandbytes as bnb  # noqa: E402

model.train()
if 'mlp' in option:
    print('mlp yaması', train.chunked_mlp_patch(model), flush=True)
opt = bnb.optim.AdamW8bit([p for p in model.parameters() if p.requires_grad], lr=1e-4)
for n in contexts:
    torch.cuda.reset_peak_memory_stats()
    ids = torch.randint(100, 50000, (1, n), device='cuda')
    startedAt = time.time()
    for _ in range(2):
        ctx = torch.autograd.graph.save_on_cpu(pin_memory='pin' in option) if 'kaydet_cpu' in option else torch.autocast('cuda', enabled=False)
        with ctx, torch.autocast('cuda', dtype=torch.bfloat16):
            loss = train.chunked_loss(model, ids, None, ids.clone())
        loss.backward()
        opt.step()
        opt.zero_grad(set_to_none=True)
    torch.cuda.synchronize()
    sec = (time.time() - startedAt) / 2
    print(f'bağlam {n}: tepe {torch.cuda.max_memory_allocated() / G:.2f} GB ayrılan {torch.cuda.max_memory_reserved() / G:.2f} GB, '
          f'adım {sec:.1f} sn, {n / sec:.0f} belirteç/sn', flush=True)
