"""
General (multimodal) model training: panel "Model training" > Field: General. Qwen3.5 (Apache 2.0), which understands
images and text, is trained with QLoRA (the image encoder frozen, a LoRA on the language model); the LoRA is merged into
the bf16 base by streaming, and llama.cpp makes the text GGUF (quantized) and the image encoder (mmproj-<name>.gguf, in
the same folder). The panel picks it as a text model; llama-server --mmproj lets it read images too.

Commands (the line protocol of train.py: "progress <percent> <text>", "result <json>", "ERROR: <text>"):
  prepare --output <folder> [--prompt <question for the images>] <files>
      Images (PNG/JPEG/WebP) + a .txt of the same name (that image's answer: a caption, tags, a description); JSONL/JSON
      chats with images ({"messages": [...], "images": [...]} or {"image", "prompt", "response"}); text, Q&A, code and .zip
      (the train.py formats). -> data.jsonl (+ images/) + summary.json
  fine   --data <folder> --base Qwen/Qwen3.5-4B --output <model folder> [--epoch 2] [--ratio 2e-4] [--context 2048]
         [--lora-r 16] [--image-pixels 262144] [--previous-adaptor <folder>] [--full-precision] [--no-gradient]
         (goes on from the checkpoint; the train.py loop)
  mmproj --hf <merged folder> --output <mmproj-<name>.gguf>
  example --hf <merged folder> [--prompt <text>]... [--image <file> --image-prompt <text>] [--length 200]
  The text GGUF comes from train.py gguf.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import train  # the same folder: HF_HOME, output encoding, the shared loop, loss, merge, readers
from train import HERE, error, progress, result

IMAGE_EXTENSIONS = ('.png', '.jpg', '.jpeg', '.webp')
# The question the model learns to answer for an image; Turkish because the panel's users caption in Turkish
DEFAULT_PROMPT = 'Bu görseli ayrıntılı betimle.'
# The LoRA only in the language model: full attention (q/k/v/o), Gated DeltaNet (in_proj_qkv/z, out_proj) and the MLP layers
LANGUAGE_LAYERS = r'.*language_model.*\.(q_proj|k_proj|v_proj|o_proj|in_proj_qkv|in_proj_z|out_proj|gate_proj|up_proj|down_proj)'
UPLOAD_PREFIX = re.compile(r'^\d{8}-\d{6}-(?:data|veri)-')  # file name prefix of a panel upload
# Keys of a data record; the Turkish ones are what users and the older data collection write
IMAGES_KEYS = ('images', 'gorseller')
IMAGE_KEYS = ('image', 'gorsel')
MESSAGES_KEYS = ('messages', 'mesajlar')


def actual_name(path: Path) -> str:
    return UPLOAD_PREFIX.sub('', path.stem).lower()


def read_text(path: Path) -> str:
    raw = path.read_bytes()
    for code in ('utf-8-sig', 'utf-16', 'cp1254'):
        try:
            return raw.decode(code)
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', 'replace')


def first(record: dict, keys: tuple[str, ...]):
    return next((record[k] for k in keys if record.get(k)), None)


# ── Data ───────────────────────────────────────────────────────────────────

def open_files(paths):
    """A folder gives the files in it (a data collection: media + a .txt caption of the same name)."""
    for d in paths:
        p = Path(d)
        if p.is_dir():
            yield from sorted(str(q) for q in p.rglob('*') if q.is_file() and not q.name.startswith('.'))
        else:
            yield d


def command_prepare(a) -> None:
    from PIL import Image

    output = Path(a.output)
    folder = output / 'images'
    shutil.rmtree(output / '_zip', ignore_errors=True)
    folder.mkdir(parents=True, exist_ok=True)
    prompt = (a.prompt or '').strip() or DEFAULT_PROMPT
    examples, seen = [], set()
    counter = {'image': 0, 'skipped': 0}

    def add(o: dict | None) -> None:
        if not o:
            return
        signature = json.dumps(o, ensure_ascii=False, sort_keys=True)
        if signature not in seen:
            seen.add(signature)
            examples.append(o)

    def copy_image(path: Path) -> str | None:
        """Copies the image into data/images under a sequence name (None when it does not open)."""
        try:
            with Image.open(path) as im:
                im.verify()
        except Exception:  # noqa: BLE001 - a broken or unreadable image is skipped
            return None
        counter['image'] += 1
        name = f'{counter["image"]:05d}{path.suffix.lower()}'
        shutil.copyfile(path, folder / name)
        return f'images/{name}'

    def with_image(images: list[str], question: str, response: str) -> dict:
        content = [{'type': 'image'} for _ in images] + [{'type': 'text', 'text': question}]
        return {'messages': [{'role': 'user', 'content': content}, {'role': 'assistant', 'content': response}], 'images': images}

    def messages_with_images(k: dict, root: Path) -> dict | None:
        """{"messages": [...], "images": [...]}: an image in place of each {"type": "image"} of a content list or each
        <image> in a text; the paths in the record or in the item, relative to the JSONL file."""
        queue = [x for x in (first(k, IMAGES_KEYS) or []) if isinstance(x, str)]
        images, messages = [], []

        def take_image(path: str | None) -> bool:
            y = path or (queue.pop(0) if queue else None)
            copy = copy_image(Path(y) if Path(y).is_absolute() else root / y) if y else None
            if copy:
                images.append(copy)
            return bool(copy)

        for m in first(k, MESSAGES_KEYS) or []:
            if not isinstance(m, dict):
                continue
            role = train.ROLES.get(str(m.get('role', m.get('rol', ''))).lower())
            content = m.get('content', m.get('icerik'))
            if not role:
                continue
            if isinstance(content, str):
                parts = content.split('<image>')
                fresh = []
                for i, p in enumerate(parts):
                    if i and not take_image(None):
                        return None
                    if i:
                        fresh.append({'type': 'image'})
                    if p.strip():
                        fresh.append({'type': 'text', 'text': p.strip()})
                content = fresh if len(parts) > 1 else content.strip()
            elif isinstance(content, list):
                fresh = []
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    kind = item.get('type')
                    if kind in ('image', 'image_url'):
                        path = item.get('image') or item.get('path') or item.get('url') or (item.get('image_url') or {}).get('url')
                        if not take_image(path if isinstance(path, str) else None):
                            return None
                        fresh.append({'type': 'image'})
                    elif kind == 'text' and str(item.get('text', '')).strip():
                        fresh.append({'type': 'text', 'text': str(item['text']).strip()})
                content = fresh
            else:
                continue
            if role == 'assistant' and not isinstance(content, str):  # the answer must be plain text
                content = ' '.join(o['text'] for o in content if o.get('type') == 'text')
            if content:
                messages.append({'role': role, 'content': content})
        if not images or not any(m['role'] == 'assistant' for m in messages) or not any(m['role'] == 'user' for m in messages):
            return None
        return {'messages': messages, 'images': images}

    def process_json(path: Path) -> None:
        text = read_text(path)
        try:
            if path.suffix.lower() == '.jsonl':
                records = [json.loads(s) for s in text.splitlines() if s.strip()]
            else:
                data = json.loads(text)
                records = next((v for v in data.values() if isinstance(v, list)), [data]) if isinstance(data, dict) else (data if isinstance(data, list) else [data])
        except json.JSONDecodeError as e:
            error(f'{path.name}: not valid JSON ({e.msg}).')
        def image_items(k: dict) -> bool:
            """A message names its image in a content item ({"type": "image", "image": "cat.png"})."""
            return any(isinstance(m, dict) and isinstance(m.get('content'), list)
                       and any(isinstance(c, dict) and c.get('type') in ('image', 'image_url') for c in m['content'])
                       for m in first(k, MESSAGES_KEYS) or [])

        for k in records:
            if isinstance(k, dict) and first(k, MESSAGES_KEYS) and (first(k, IMAGES_KEYS) or image_items(k)):
                o = messages_with_images(k, path.parent)
                counter['skipped'] += o is None
                add(o)
            elif isinstance(k, dict) and isinstance(first(k, IMAGE_KEYS), str):
                question = train.key(k, train.PROMPT_KEYS) or prompt
                # a data collection record: {image, text}
                response = train.key(k, train.RESPONSE_KEYS) or train.key(k, train.TEXT_KEYS)
                copy = copy_image(path.parent / first(k, IMAGE_KEYS)) if isinstance(response, str) and response.strip() else None
                counter['skipped'] += copy is None
                if copy:
                    add(with_image([copy], str(question).strip(), response.strip()))
            else:
                add(train.record_to_example(k))

    def process_files(files: list[Path]) -> None:
        """An image and a .txt of the same name in the same folder pair up; the other files go to the train.py reader."""
        image_names = {actual_name(p) for p in files if p.suffix.lower() in IMAGE_EXTENSIONS}
        responses = {actual_name(p): p for p in files if p.suffix.lower() == '.txt' and actual_name(p) in image_names}
        for p in sorted(files):
            u = p.suffix.lower()
            if u in IMAGE_EXTENSIONS:
                response = read_text(responses[actual_name(p)]).strip() if actual_name(p) in responses else ''
                copy = copy_image(p) if response else None
                if copy:
                    add(with_image([copy], prompt, response))
                else:
                    counter['skipped'] += 1  # an image without its answer (a .txt of the same name) or that does not open
            elif u in ('.jsonl', '.json'):
                process_json(p)
            elif u == '.txt' and actual_name(p) in responses:
                continue  # used as an image's answer
            elif u == '.zip':
                target = output / '_zip' / f'{len(list((output / "_zip").glob("*"))) if (output / "_zip").exists() else 0}'
                target.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(p) as z:
                    for info in z.infolist():
                        name = info.filename.replace('\\', '/')
                        if info.is_dir() or '__MACOSX' in name or any(x.startswith('.') or x == '..' for x in name.split('/')):
                            continue
                        z.extract(info, target)
                groups: dict[Path, list[Path]] = {}
                for q in target.rglob('*'):
                    if q.is_file():
                        groups.setdefault(q.parent, []).append(q)
                for group in groups.values():
                    process_files(group)
            else:
                for o in train.read_file(p):
                    add(o)

    paths = [Path(d) for d in open_files(a.files)]
    for y in paths:
        if not y.exists():
            error(f'File not found: {y.name}')
    groups: dict[Path, list[Path]] = {}
    for y in paths:
        groups.setdefault(y.parent, []).append(y)
    for i, group in enumerate(groups.values()):
        progress(100 * i / max(1, len(groups)), f'Reading: {len(group)} files')
        process_files(group)
    shutil.rmtree(output / '_zip', ignore_errors=True)
    if not examples:
        error('No training sample in the files: an image\'s answer goes in a .txt file of the same name (cat.png + cat.txt); '
              'text and Q&A formats are those of text model training.')
    with open(output / 'data.jsonl', 'w', encoding='utf-8') as f:
        for o in examples:
            f.write(json.dumps(o, ensure_ascii=False) + '\n')
    with_images = sum(1 for o in examples if o.get('images'))
    chat = sum(1 for o in examples if 'messages' in o)
    sample = next((o for o in examples if o.get('images')), None)
    question = next((c['text'] for c in sample['messages'][0]['content'] if c.get('type') == 'text'), prompt) if sample else None
    prompts = [m['content'] for o in examples if not o.get('images') for m in o.get('messages', [])[:3]
               if m['role'] == 'user' and isinstance(m['content'], str) and len(m['content']) <= 300][:1]
    summary = {'example': len(examples), 'withImage': with_images, 'chat': chat - with_images, 'text': len(examples) - chat,
               'image': counter['image'], 'skipped': counter['skipped'], 'files': len(paths), 'examplePrompts': prompts,
               'exampleImage': sample['images'][0] if sample else None, 'exampleImagePrompt': question}
    (output / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding='utf-8')
    progress(100, f'{len(examples)} samples ({with_images} with images, {chat - with_images} chat, {len(examples) - chat} plain text)'
                  + (f'; {counter["skipped"]} images skipped (no answer or could not be opened)' if counter['skipped'] else ''))
    result(summary)


# ── Training ───────────────────────────────────────────────────────────────

def prepare_examples(examples: list[dict], processor, data: Path, context: int) -> tuple[list[dict], int]:
    """Each sample -> {'ids', 'lab', 'extra'} (extra: pixel_values, image_grid_thw, mm_token_type_ids; on the CPU).
    In a chat only the last assistant answer is taught (the prefix is run apart with the same images, so the token counts
    match). Plain text is taught whole in context-long slices. Returns (samples, skipped)."""
    from PIL import Image

    tok = processor.tokenizer
    ready, skipped = [], 0
    for o in examples:
        if 'text' in o:
            ids = tok(o['text'], add_special_tokens=False).input_ids + ([tok.eos_token_id] if tok.eos_token_id is not None else [])
            for i in range(0, len(ids), context):
                part = ids[i:i + context]
                if len(part) > 16:
                    ready.append({'ids': part, 'lab': list(part), 'extra': {}})
            continue
        messages = o['messages']
        if messages[-1]['role'] != 'assistant':
            skipped += 1
            continue
        images = [Image.open(data / g).convert('RGB') for g in o.get('images', [])] or None
        full = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=False, enable_thinking=False)
        prefix = processor.apply_chat_template(messages[:-1], tokenize=False, add_generation_prompt=True, enable_thinking=False)
        inputs = processor(text=[full], images=images, return_tensors='pt')
        prefix_length = processor(text=[prefix], images=images, return_tensors='pt').input_ids.shape[1]
        ids = inputs.input_ids[0].tolist()
        if prefix_length >= context or prefix_length >= len(ids):
            skipped += 1  # the question (image tokens included) does not fit the context
            continue
        ids = ids[:context]
        lab = [-100] * prefix_length + ids[prefix_length:]
        extra = {k: v for k, v in inputs.items() if k in ('pixel_values', 'image_grid_thw', 'mm_token_type_ids')}
        if 'mm_token_type_ids' in extra:
            extra['mm_token_type_ids'] = extra['mm_token_type_ids'][:, :len(ids)]
        ready.append({'ids': ids, 'lab': lab, 'extra': extra})
    return ready, skipped


def command_fine(a) -> None:
    import torch
    from peft import LoraConfig, PeftModel, get_peft_model
    from transformers import AutoModelForImageTextToText, AutoProcessor, BitsAndBytesConfig

    output = Path(a.output)
    output.mkdir(parents=True, exist_ok=True)
    adaptor, hf = output / 'adaptor', output / 'hf'
    data = Path(a.data)
    if not torch.cuda.is_available():
        error('No graphics card (CUDA) found; training needs a GPU.')
    progress(1, f'Preparing the base model: {a.base} (~9 GB is downloaded the first time)')
    base = train.base_folder(a.base)
    if not (adaptor / 'adapter_config.json').exists():
        processor = AutoProcessor.from_pretrained(str(base))
        # Token limit per image (32x32 pixel patches): 262144 pixels ~256 tokens
        processor.image_processor.size = {'longest_edge': a.image_pixels, 'shortest_edge': min(65536, a.image_pixels)}
        examples = train.read_data(data)
        progress(2, f'Turning {len(examples)} samples into tokens')
        ready, skipped = prepare_examples(examples, processor, data, a.context)
        if not ready:
            error('No training sample came out of the data (empty answers or the context is too short).')
        tokens = sum(len(o['ids']) for o in ready)
        if skipped:
            progress(3, f'{skipped} samples skipped, longer than the context ({a.context} tokens)')
        four_bit = not a.full_precision  # panel fine setting: bf16 LoRA on a large card
        progress(4, f'{len(ready)} training samples, {tokens:,} tokens; loading the model {"4-bit" if four_bit else "bf16"} (image encoder bf16, frozen)')
        model = AutoModelForImageTextToText.from_pretrained(
            str(base), dtype=torch.bfloat16, device_map={'': 0}, low_cpu_mem_usage=True,
            quantization_config=BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True,
                llm_int8_skip_modules=['visual', 'lm_head']) if four_bit else None)
        if not a.no_gradient:
            model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
        model.enable_input_require_grads()
        model.config.use_cache = False
        if a.previous_adaptor:
            model = PeftModel.from_pretrained(model, a.previous_adaptor, is_trainable=True)
        else:
            model = get_peft_model(model, LoraConfig(r=a.lora_r, lora_alpha=a.lora_r * 2, lora_dropout=0.05, bias='none',
                                                     task_type='CAUSAL_LM', target_modules=LANGUAGE_LAYERS))
        trained = sum(p.numel() for p in model.parameters() if p.requires_grad)
        progress(8, f'LoRA ready: {trained / 1e6:.1f}M trained parameters; VRAM {torch.cuda.memory_allocated() / 2 ** 30:.1f} GB; training starts')

        def compute_loss(group):
            o = group[0]
            ids = torch.tensor([o['ids']], device='cuda')
            lab = torch.tensor([o['lab']], device='cuda')
            extra = {k: v.to('cuda') for k, v in o['extra'].items()}
            return train.chunked_loss(model, ids, torch.ones_like(ids), lab, extra=extra)

        ckpt = output / 'checkpoint.pt'
        info = train.training_loop(model, ready, epoch=a.epoch, ratio=a.ratio, batch=1, accumulation=8,
                                   params=[p for p in model.parameters() if p.requires_grad], start_pct=8, end_pct=80, tag='fine',
                                   ckpt=ckpt, compute_loss=compute_loss, tokens=tokens)
        # Written beside it first, then renamed in one move: a half written LoRA must not pass as finished
        fresh = output / 'adaptor.writing'
        shutil.rmtree(fresh, ignore_errors=True)
        model.save_pretrained(str(fresh))
        (fresh / 'base.json').write_text(json.dumps({'base': a.base, 'folder': str(base)}, ensure_ascii=False), encoding='utf-8')
        (output / 'training.json').write_text(json.dumps({**info, 'parts': len(ready), 'tokens': tokens, 'skipped': skipped},
                                                         ensure_ascii=False), encoding='utf-8')
        shutil.rmtree(adaptor, ignore_errors=True)
        fresh.replace(adaptor)
        ckpt.unlink(missing_ok=True)
        del model
        torch.cuda.empty_cache()

    if not (hf / 'config.json').exists():
        progress(82, 'Merging the LoRA into the base model (bf16)')
        n = train.merge_streaming(base, adaptor, hf)
        progress(88, f'{n} tensors merged')
    info = json.loads((output / 'training.json').read_text(encoding='utf-8')) if (output / 'training.json').exists() else {}
    progress(90, 'Merged model saved')
    result({'hf': str(hf), **info})


# ── GGUF image encoder ─────────────────────────────────────────────────────

def command_mmproj(a) -> None:
    """The image encoder GGUF (f16) of the merged HF folder. Written as .writing first, renamed when it is done."""
    hf, target = Path(a.hf), Path(a.output)
    if target.exists():
        result({'mmproj': str(target), 'gib': round(target.stat().st_size / 2 ** 30, 2)})
        return
    converter = HERE / 'converter' / 'convert_hf_to_gguf.py'
    if not converter.exists():
        error('No GGUF converter (training\\converter; setup\\setup.ps1).')
    if not (hf / 'config.json').exists():
        error('No model to convert (the merged copy was deleted); retry the job.')
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + '.writing')
    progress(90, 'Converting the image encoder to GGUF (mmproj)')
    r = subprocess.run([sys.executable, str(converter), str(hf), '--mmproj', '--outfile', str(temp), '--outtype', 'f16'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0 or not temp.exists():
        temp.unlink(missing_ok=True)
        lines = (r.stderr or r.stdout).strip().splitlines()
        error('Converting the image encoder failed: ' + (lines[-1] if lines else f'exit code {r.returncode}'))
    temp.replace(target)
    result({'mmproj': str(target), 'gib': round(target.stat().st_size / 2 ** 30, 2)})


# ── Sample answers ─────────────────────────────────────────────────────────

def command_example(a) -> None:
    import torch
    from PIL import Image
    from transformers import AutoModelForImageTextToText, AutoProcessor, BitsAndBytesConfig

    processor = AutoProcessor.from_pretrained(a.hf)
    model = AutoModelForImageTextToText.from_pretrained(
        a.hf, dtype=torch.bfloat16, device_map={'': 0}, low_cpu_mem_usage=True,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_compute_dtype=torch.bfloat16,
                                               llm_int8_skip_modules=['visual', 'lm_head']))
    model.eval()
    requests = [(i, None) for i in (a.prompt or [])]
    if a.image:
        requests.append((a.image_prompt or DEFAULT_PROMPT, a.image))
    results = []
    for prompt, image in requests:
        content = ([{'type': 'image'}] if image else []) + [{'type': 'text', 'text': prompt}]
        text = processor.apply_chat_template([{'role': 'user', 'content': content}], tokenize=False, add_generation_prompt=True, enable_thinking=False)
        inputs = processor(text=[text], images=[Image.open(image).convert('RGB')] if image else None, return_tensors='pt').to(model.device)
        with torch.no_grad():
            out = model.generate(**inputs, max_new_tokens=a.length, do_sample=True, temperature=0.7, top_p=0.9, repetition_penalty=1.05)
        response = processor.tokenizer.decode(out[0, inputs.input_ids.shape[1]:], skip_special_tokens=True).strip()
        results.append({'prompt': prompt, 'image': Path(image).name if image else None, 'response': response})
    result({'examples': results})


def main() -> None:
    p = argparse.ArgumentParser(description='General (multimodal) model training')
    sub = p.add_subparsers(dest='command', required=True)
    h = sub.add_parser('prepare')
    h.add_argument('--output', required=True)
    h.add_argument('--prompt', default='')
    h.add_argument('files', nargs='+')
    i = sub.add_parser('fine')
    i.add_argument('--data', required=True)
    i.add_argument('--base', required=True)
    i.add_argument('--output', required=True)
    i.add_argument('--epoch', type=float, default=2)
    i.add_argument('--ratio', type=float, default=2e-4)
    i.add_argument('--context', type=int, default=2048)
    i.add_argument('--lora-r', type=int, default=16)
    i.add_argument('--image-pixels', type=int, default=262144)
    i.add_argument('--previous-adaptor', default='')
    i.add_argument('--full-precision', action='store_true', help='bf16 LoRA instead of 4-bit (large card)')
    i.add_argument('--no-gradient', action='store_true', help='gradient checkpointing off (large card)')
    m = sub.add_parser('mmproj')
    m.add_argument('--hf', required=True)
    m.add_argument('--output', required=True)
    o = sub.add_parser('example')
    o.add_argument('--hf', required=True)
    o.add_argument('--prompt', action='append', default=[])
    o.add_argument('--image', default='')
    o.add_argument('--image-prompt', default='')
    o.add_argument('--length', type=int, default=200)
    a = p.parse_args()
    try:
        {'prepare': command_prepare, 'fine': command_fine, 'mmproj': command_mmproj, 'example': command_example}[a.command](a)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - the panel shows a one-line error, the details are in the log
        import traceback
        traceback.print_exc()
        message = str(e).splitlines()[0][:300] if str(e) else type(e).__name__
        if 'out of memory' in message.lower():
            message = 'Not enough graphics card memory: lower the context (e.g. 1024) or the image size.'
        error(message)


if __name__ == '__main__':
    main()
