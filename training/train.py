"""
Text model training (the panel's "Model training" job). One script, subcommands:

  prepare  files (txt/md/html/jsonl/json/csv/code/zip) -> data.jsonl + summary.json (chat and plain text samples)
  fine     improves an existing model: QLoRA (4-bit base + LoRA), then a merged HF model
  scratch  from scratch: a SentencePiece vocabulary from the data + a small Llama architecture, random initial weights
  gguf     HF model -> GGUF (llama.cpp converter, b11392) -> quantized with llama-quantize
  example  sample answers from the trained model (one JSON line)

The panel reads the output line by line: "progress <percent> <text>", "ERROR: <text>", "result <json>".
GPU: the panel unloads ComfyUI and the text model before the job starts; this runs alone.
"""
from __future__ import annotations

import argparse
import contextlib
import csv
import html
import io
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ.setdefault('HF_HOME', str(HERE / 'hf'))
os.environ.setdefault('TOKENIZERS_PARALLELISM', 'false')
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
sys.stderr.reconfigure(encoding='utf-8')


def progress(percent: float, text: str) -> None:
    print(f'progress {int(max(0, min(100, percent)))} {text}', flush=True)


def error(text: str) -> None:
    print(f'ERROR: {text}', flush=True)
    sys.exit(2)


def result(data: dict) -> None:
    print('result ' + json.dumps(data, ensure_ascii=False), flush=True)


# ── Data ────────────────────────────────────────────────────────────────────

# Field names a user's data may use (English and Turkish; lower case)
PROMPT_KEYS = ('prompt', 'question', 'instruction', 'input', 'user', 'istem', 'soru', 'kullanici')
RESPONSE_KEYS = ('response', 'output', 'completion', 'answer', 'assistant', 'yanit', 'cevap', 'asistan')
SYSTEM_KEYS = ('system', 'sistem')
TEXT_KEYS = ('text', 'content', 'body', 'metin', 'icerik')
TITLE_KEYS = ('title', 'baslik')
ROLES = {'system': 'system', 'sistem': 'system', 'user': 'user', 'kullanici': 'user', 'human': 'user',
         'assistant': 'assistant', 'asistan': 'assistant', 'gpt': 'assistant', 'model': 'assistant', 'bot': 'assistant'}


def clean_html(s: str) -> str:
    """HTML to plain text, keeping the paragraphs (article bodies)."""
    if '<' not in s:
        return s.strip()
    s = re.sub(r'(?is)<(script|style)[^>]*>.*?</\1>', ' ', s)
    s = re.sub(r'(?i)<br\s*/?>', '\n', s)
    s = re.sub(r'(?i)</(p|div|h[1-6]|li|tr|blockquote|section|article)>', '\n\n', s)
    s = re.sub(r'(?i)<li[^>]*>', '- ', s)
    s = re.sub(r'<[^>]+>', ' ', s)
    s = html.unescape(s)
    s = re.sub(r'[ \t ]+', ' ', s)
    s = re.sub(r' *\n *', '\n', s)
    return re.sub(r'\n{3,}', '\n\n', s).strip()


def key(record: dict, names: tuple[str, ...]):
    lower = {str(k).lower(): v for k, v in record.items()}
    for n in names:
        if n in lower and lower[n] not in (None, ''):
            return lower[n]
    return None


def record_to_example(record) -> dict | None:
    """One record -> {"messages": [...]} (chat) or {"text": ...} (plain text)."""
    if isinstance(record, str):
        t = clean_html(record)
        return {'text': t} if t else None
    if not isinstance(record, dict):
        return None
    messages = key(record, ('messages', 'mesajlar', 'conversations', 'konusma'))
    if isinstance(messages, list):
        clean = []
        for m in messages:
            if not isinstance(m, dict):
                continue
            role = ROLES.get(str(m.get('role', m.get('rol', m.get('from', '')))).lower())
            content = m.get('content', m.get('icerik', m.get('value', m.get('text', m.get('metin')))))
            if role and isinstance(content, str) and content.strip():
                clean.append({'role': role, 'content': content.strip()})
        if any(m['role'] == 'assistant' for m in clean) and any(m['role'] == 'user' for m in clean):
            return {'messages': clean}
        return None
    prompt, response = key(record, PROMPT_KEYS), key(record, RESPONSE_KEYS)
    if isinstance(prompt, str) and isinstance(response, str) and prompt.strip() and response.strip():
        m = []
        system = key(record, SYSTEM_KEYS)
        if isinstance(system, str) and system.strip():
            m.append({'role': 'system', 'content': system.strip()})
        m += [{'role': 'user', 'content': prompt.strip()}, {'role': 'assistant', 'content': response.strip()}]
        return {'messages': m}
    text = key(record, TEXT_KEYS)
    if isinstance(text, str):
        title = key(record, TITLE_KEYS)
        t = clean_html(text)
        if isinstance(title, str) and title.strip():
            t = f'{title.strip()}\n\n{t}'
        return {'text': t} if t.strip() else None
    return None


def split_plain_text(text: str, target: int = 6000) -> list[str]:
    """Splits long plain text at paragraph breaks into documents of about target characters."""
    paragraphs = [p.strip() for p in re.split(r'\n\s*\n', text) if p.strip()]
    documents, part = [], ''
    for p in paragraphs:
        if part and len(part) + len(p) > target:
            documents.append(part)
            part = ''
        part = f'{part}\n\n{p}' if part else p
    if part:
        documents.append(part)
    return documents


CODE_EXTENSIONS = {'.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.php', '.java', '.kt', '.go', '.rs', '.c', '.h',
                   '.cpp', '.hpp', '.cs', '.rb', '.swift', '.dart', '.sql', '.sh', '.ps1', '.bat', '.vue', '.svelte', '.css',
                   '.scss', '.yaml', '.yml', '.toml', '.xml', '.gradle', '.lua', '.r', '.scala', '.blade.php'}
SKIPPED_FOLDERS = {'node_modules', 'vendor', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
                   'storage', 'bin', 'obj', 'target', '.next', 'coverage', '.dart_tool', 'Pods'}


def code_document(name: str, text: str) -> dict | None:
    """Code file -> plain text sample with its path in the heading (the model sees which file it is). Very large or
    generated files are skipped."""
    text = text.replace('\r\n', '\n')
    if len(text) > 200_000 or not text.strip():
        return None
    lines = text.splitlines()
    if lines and max(len(s) for s in lines) > 2000:  # minified
        return None
    # "Dosya:" is training content (the heading the earlier code models learned), not interface text
    return {'text': f'Dosya: {name}\n```{Path(name).suffix.lstrip(".")}\n{text.rstrip()}\n```'}


def read_zip(path: Path) -> list[dict]:
    """Repository archive: code and document files (without node_modules/vendor/.git/build output)."""
    import zipfile

    examples = []
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            name = info.filename.replace('\\', '/')
            parts = name.split('/')
            if info.is_dir() or any(p in SKIPPED_FOLDERS for p in parts[:-1]):
                continue
            extension = Path(name).suffix.lower()
            if extension not in CODE_EXTENSIONS and extension not in ('.md', '.txt'):
                continue
            try:
                text = z.read(info).decode('utf-8')
            except UnicodeDecodeError:
                continue
            o = code_document(name, text) if extension in CODE_EXTENSIONS else ({'text': text.strip()} if text.strip() else None)
            if o:
                examples.append(o)
    return examples


def read_file(path: Path) -> list[dict]:
    extension = path.suffix.lower()
    if extension == '.zip':
        return read_zip(path)
    raw = path.read_bytes()
    for encoding in ('utf-8-sig', 'utf-16', 'cp1254'):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        error(f'{path.name}: could not read the text encoding (save it as UTF-8).')
    if extension == '.jsonl':
        records = []
        for no, line in enumerate(text.splitlines(), 1):
            if line.strip():
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    error(f'{path.name}: line {no} is not valid JSON.')
        return [o for o in map(record_to_example, records) if o]
    if extension == '.json':
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            error(f'{path.name}: not valid JSON ({e.msg}, line {e.lineno}).')
        if isinstance(data, dict):
            records = next((v for v in data.values() if isinstance(v, list)), [data])
        else:
            records = data if isinstance(data, list) else [data]
        return [o for o in map(record_to_example, records) if o]
    if extension in ('.csv', '.tsv'):
        separator = '\t' if extension == '.tsv' else (csv.Sniffer().sniff(text[:4096], ',;\t').delimiter if text.strip() else ',')
        rows = list(csv.reader(io.StringIO(text), delimiter=separator))
        if not rows:
            return []
        header = [h.strip().lower() for h in rows[0]]
        known = set(PROMPT_KEYS + RESPONSE_KEYS + SYSTEM_KEYS + TEXT_KEYS + TITLE_KEYS)
        if known & set(header):
            return [o for o in (record_to_example(dict(zip(header, r))) for r in rows[1:]) if o]
        if all(len(r) >= 2 for r in rows if r):  # no header: 1st column prompt, 2nd column response
            return [o for o in (record_to_example({'prompt': r[0], 'response': r[1]}) for r in rows if len(r) >= 2) if o]
        return [{'text': r[0].strip()} for r in rows if r and r[0].strip()]
    if extension in CODE_EXTENSIONS:
        o = code_document(path.name, text)
        return [o] if o else []
    # .txt / .md / .html and the rest: plain text documents
    return [{'text': b} for b in split_plain_text(clean_html(text) if extension in ('.html', '.htm') else text.strip())]


def command_prepare(a) -> None:
    output = Path(a.output)
    output.mkdir(parents=True, exist_ok=True)
    examples, seen, abbreviations = [], set(), {}
    for i, f in enumerate(a.files):
        path = Path(f)
        progress(100 * i / max(1, len(a.files)), f'Reading: {path.name}')
        if not path.exists():
            error(f'File not found: {path.name}')
        # Prompt abbreviation map ({"[[mark]]": "full text"}): not data; it goes to the model folder and the panel puts the
        # mark in place of the full text in prompts (as it was shortened in training).
        if path.suffix.lower() == '.json':
            try:
                j = json.loads(path.read_text(encoding='utf-8-sig'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                j = None
            if isinstance(j, dict) and j and all(re.fullmatch(r'\[\[[^\]]{1,80}\]\]', k) and isinstance(v, str) for k, v in j.items()):
                abbreviations.update(j)
                continue
        for o in read_file(path):
            signature = json.dumps(o, ensure_ascii=False, sort_keys=True)
            if signature not in seen:
                seen.add(signature)
                examples.append(o)
    if not examples:
        error('No usable training text in the files (the formats are in the README, Model training).')
    if abbreviations:
        (output / 'abbreviations.json').write_text(json.dumps(abbreviations, ensure_ascii=False), encoding='utf-8')
        progress(99, f'{len(abbreviations)} prompt abbreviations')
    with open(output / 'data.jsonl', 'w', encoding='utf-8') as f:
        for o in examples:
            f.write(json.dumps(o, ensure_ascii=False) + '\n')
    chat = sum(1 for o in examples if 'messages' in o)
    characters = sum(len(o.get('text', '')) + sum(len(m['content']) for m in o.get('messages', [])) for o in examples)
    # The first (short) user questions of the data, for sample answers after training
    prompts = [m['content'] for o in examples for m in o.get('messages', [])[:3] if m['role'] == 'user' and len(m['content']) <= 300][:2]
    summary = {'example': len(examples), 'chat': chat, 'text': len(examples) - chat, 'characters': characters,
               'tokenEstimate': characters // 4, 'files': len(a.files), 'examplePrompts': prompts, 'abbreviations': len(abbreviations)}
    (output / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding='utf-8')
    progress(100, f'{len(examples)} samples ({chat} chat, {len(examples) - chat} plain text), ~{characters // 4:,} tokens')
    result(summary)


def read_data(folder: Path) -> list[dict]:
    path = folder / 'data.jsonl'
    if not path.exists():
        error('No prepared data (run prepare first).')
    return [json.loads(s) for s in path.read_text(encoding='utf-8').splitlines() if s.strip()]


# ── Shared training loop ────────────────────────────────────────────────────

def attention_patch() -> None:
    """Windows torch builds have no flash attention. transformers hands maskless GQA (enable_gqa) to SDPA; the memory
    efficient kernel does not support GQA, so it falls back to the math path: on Qwen3-14B at 4096 tokens attention
    takes +10 GB (0.3 GB with the heads repeated; measured). Without flash the heads are repeated."""
    import torch
    import transformers.integrations.sdpa_attention as sdpa

    try:
        from torch.nn.attention import SDPBackend, sdpa_kernel

        q = torch.zeros(1, 2, 16, 64, device='cuda', dtype=torch.bfloat16)
        with sdpa_kernel(SDPBackend.FLASH_ATTENTION):
            torch.nn.functional.scaled_dot_product_attention(q, q, q, is_causal=True)
        return  # flash is there: GQA is safe
    except Exception:  # noqa: BLE001
        sdpa.use_gqa_in_sdpa = lambda *a, **k: False


def chunked_mlp_patch(model, part: int = 2048) -> int:
    """Runs the MLP in chunks along the sequence (recomputed) in long contexts.
    When backward recomputed a layer, the MLP intermediates (14B, 10k tokens: ~356 MB each, several at once) were made for
    the whole sequence; chunked, only one chunk's are in memory. Returns the number of patched MLPs."""
    import torch
    from torch.utils.checkpoint import checkpoint

    number = 0
    for m in model.modules():
        if type(m).__name__.endswith('MLP') and hasattr(m, 'down_proj'):
            def chunked(x, _forward=m.forward):
                if x.shape[-2] <= part or not torch.is_grad_enabled():
                    return _forward(x)
                return torch.cat([checkpoint(_forward, x[..., i:i + part, :], use_reentrant=False)
                                  for i in range(0, x.shape[-2], part)], dim=-2)
            m.forward = chunked
            number += 1
    return number


def chunked_loss(model, ids, mask, lab, part: int = 512, extra: dict | None = None):
    """Causal language model loss with the output layer run in chunks and recomputed (checkpoint).
    With a 151k token vocabulary the logits of one 2048 token sample alone held ~1.2 GB (fp32); here only one chunk's
    are in memory at a time. Falls back to the model's own loss when the architecture does not fit.
    extra: further model inputs (in an image model pixel_values, image_grid_thw, mm_token_type_ids)."""
    import torch
    import torch.nn.functional as F
    from torch.utils.checkpoint import checkpoint

    extra = extra or {}
    base = model.get_base_model() if hasattr(model, 'get_base_model') else model
    body, lm = getattr(base, 'model', None), base.get_output_embeddings()
    if mask is not None and bool(mask.all()):
        mask = None  # no padding: the causal kernel (no 4D mask tensor is built)
    if body is None or lm is None or getattr(base.config, 'final_logit_softcapping', None):
        return model(input_ids=ids, attention_mask=mask, labels=lab, **extra).loss
    h = body(input_ids=ids, attention_mask=mask, **extra).last_hidden_state[:, :-1]
    y = lab[:, 1:]
    count = (y != -100).sum().clamp(min=1)

    def ce(hp, yp):
        return F.cross_entropy(lm(hp).float().flatten(0, 1), yp.flatten(), ignore_index=-100, reduction='sum')

    total = h.new_zeros((), dtype=torch.float32)
    for i in range(0, h.shape[1], part):
        yp = y[:, i:i + part]
        if (yp != -100).any():
            total = total + checkpoint(ce, h[:, i:i + part], yp, use_reentrant=False)
    return total / count


def training_loop(model, parts, *, epoch: float, ratio: float, batch: int, accumulation: int, params,
                  start_pct: float, end_pct: float, tag: str, warmup: float = 0.05, limit_sec: float = 0, eight_bit: bool = False,
                  activation_cpu: bool = False, ckpt: Path | None = None, ckpt_interval: float = 120,
                  compute_loss=None, tokens: int | None = None):
    """A plain loop without dependencies: AdamW + warmup + cosine, bf16 autocast, gradient accumulation.
    parts: [(input_ids, labels)] of different lengths -> each batch is padded on its own.
    compute_loss(group): when given it computes the batch loss (image model: the samples are ready tensor dicts);
    tokens: then the total token count for the checkpoint signature.
    ckpt: the checkpoint file. At least every ckpt_interval seconds, at a step's end, the trained weights, optimizer,
    scheduler, data order and random state are written; a process stopped (pause, shutdown, power cut) and started
    again goes on from the last finished step. Deleting it after training is the caller's job (after it saves the result)."""
    import torch

    device = next(p for p in model.parameters() if p.requires_grad).device
    if eight_bit:
        import bitsandbytes as bnb  # large model: 8-bit optimizer states (the LoRA parameters stay fp32)
        optimizer = bnb.optim.AdamW8bit(params, lr=ratio, weight_decay=0.0, betas=(0.9, 0.95))
    else:
        optimizer = torch.optim.AdamW(params, lr=ratio, weight_decay=0.0 if tag == 'fine' else 0.1, betas=(0.9, 0.95), fused=device.type == 'cuda')
    steps_per_epoch = math.ceil(len(parts) / batch)
    total = max(1, math.ceil(steps_per_epoch * epoch / accumulation))
    warmup_steps = max(1, int(total * warmup))

    def lr_factor(step):
        if step < warmup_steps:
            return (step + 1) / warmup_steps
        done = (step - warmup_steps) / max(1, total - warmup_steps)
        return 0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(1.0, done)))

    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lr_factor)
    pad = 0
    model.train()
    step, micro, loss_total, loss_count = 0, 0, 0.0, 0
    start = time.time()
    last_report = 0.0
    order = list(range(len(parts)))
    rnd = random.Random(1234)
    losses = []
    # A checkpoint goes on only with the same data and settings
    signature = {'version': 2, 'tag': tag, 'parts': len(parts), 'tokens': tokens if tokens is not None else sum(len(p[0]) for p in parts), 'total': total,
                 'batch': batch, 'accumulation': accumulation, 'ratio': ratio, 'epoch': epoch, 'eightBit': eight_bit,
                 'shapes': [list(p.shape) for p in params]}
    first, shuffled = 0, False
    if ckpt and ckpt.exists():
        try:
            d = torch.load(ckpt, map_location='cpu', weights_only=False)
        except Exception as e:  # a half or broken file: not expected, it is written with os.replace
            d = {}
            progress(start_pct, f'Could not read the checkpoint ({type(e).__name__}); training starts over')
        if d and d.get('signature') != signature:
            progress(start_pct, 'The checkpoint does not match this data and these settings; training starts over')
        elif d:
            with torch.no_grad():
                for p, t in zip(params, d['params']):
                    p.copy_(t.to(device=p.device, dtype=p.dtype))
            optimizer.load_state_dict(d['optimizer'])
            scheduler.load_state_dict(d['scheduler'])
            step, order, first, shuffled = d['step'], d['order'], d['next'], True
            rnd.setstate(d['rnd'])
            losses = d['losses']
            micro = step * accumulation
            torch.set_rng_state(d['torch_rng'])
            if d.get('cuda_rng') is not None and device.type == 'cuda':
                torch.cuda.set_rng_state(d['cuda_rng'])
            start = time.time() - d['elapsed']
            progress(start_pct + (end_pct - start_pct) * step / total, f'Going on from the checkpoint: step {step}/{total}'
                     + (f' · last loss {losses[-1]:.3f}' if losses else ''))
        del d
    last_save = time.time()

    def save_checkpoint(next_index: int) -> None:
        temp = ckpt.with_name(ckpt.name + '.writing')
        try:
            with open(temp, 'wb') as f:
                torch.save({'signature': signature, 'step': step, 'params': [p.detach() for p in params],
                            'optimizer': optimizer.state_dict(), 'scheduler': scheduler.state_dict(), 'order': list(order),
                            'next': next_index, 'rnd': rnd.getstate(), 'losses': list(losses), 'elapsed': time.time() - start,
                            'torch_rng': torch.get_rng_state(), 'cuda_rng': torch.cuda.get_rng_state() if device.type == 'cuda' else None,
                            'dateText': time.strftime('%Y-%m-%d %H:%M:%S')}, f)
                f.flush()
                os.fsync(f.fileno())  # a power cut must not leave a renamed but empty file
            os.replace(temp, ckpt)  # stopped while writing: the previous checkpoint stays whole
        except (OSError, RuntimeError) as e:  # full disk etc.: training goes on, the next interval tries again
            temp.unlink(missing_ok=True)
            progress(start_pct + (end_pct - start_pct) * step / total, f'Could not write the checkpoint ({e.__class__.__name__}: {str(e)[:80]}); training goes on')

    def summary() -> dict:
        return {'step': step, 'totalSteps': total, 'losses': losses, 'durationSec': round(time.time() - start),
                'peakVramGb': round(torch.cuda.max_memory_reserved() / 2 ** 30, 2) if torch.cuda.is_available() else None}

    while step < total:
        if not shuffled:
            rnd.shuffle(order)
        shuffled = False
        for i in range(first, len(order), batch):
            group = [parts[j] for j in order[i:i + batch]]
            # activation_cpu: the values checkpoint keeps per layer go to RAM (14B at 8192 tokens: ~3.4 GB)
            keep = torch.autograd.graph.save_on_cpu(pin_memory=False) if activation_cpu else contextlib.nullcontext()
            if compute_loss:
                with keep, torch.autocast('cuda', dtype=torch.bfloat16, enabled=device.type == 'cuda'):
                    loss = compute_loss(group)
            else:
                longest = max(len(g[0]) for g in group)
                ids = torch.full((len(group), longest), pad, dtype=torch.long)
                lab = torch.full((len(group), longest), -100, dtype=torch.long)
                mask = torch.zeros((len(group), longest), dtype=torch.long)
                for k, (x, y) in enumerate(group):
                    ids[k, :len(x)] = torch.tensor(x)
                    lab[k, :len(y)] = torch.tensor(y)
                    mask[k, :len(x)] = 1
                with keep, torch.autocast('cuda', dtype=torch.bfloat16, enabled=device.type == 'cuda'):
                    loss = chunked_loss(model, ids.to(device), mask.to(device), lab.to(device))
            (loss / accumulation).backward()
            loss_total += float(loss.detach())
            loss_count += 1
            micro += 1
            if micro % accumulation:
                continue
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad(set_to_none=True)
            if activation_cpu:
                torch.cuda.empty_cache()  # fragmented reserved memory must not pass the physical limit and spill to RAM on Windows
            step += 1
            now = time.time()
            if now - last_report > 5 or step == total:
                avg = loss_total / max(1, loss_count)
                losses.append(round(avg, 4))
                elapsed = now - start
                remaining = elapsed / step * (total - step)
                progress(start_pct + (end_pct - start_pct) * step / total,
                         f'Training step {step}/{total} · loss {avg:.3f} · ~{int(remaining // 60)} min {int(remaining % 60)} s left')
                loss_total, loss_count, last_report = 0.0, 0, now
            if step >= total or (limit_sec and time.time() - start > limit_sec):
                return summary()
            if ckpt and time.time() - last_save >= ckpt_interval:
                save_checkpoint(i + batch)
                last_save = time.time()
        first = 0
    return summary()


# ── Fine-tuning (QLoRA) ─────────────────────────────────────────────────────

def chat_parts(tok, examples: list[dict], context: int) -> list[tuple[list[int], list[int]]]:
    """Chat: only the LAST assistant answer is taught (the prompt is masked). Plain text: all of it, in context-sized
    slices. Samples longer than the context are skipped and counted in chat_parts.skipped."""
    parts = []
    chat_parts.skipped = 0
    eos = tok.eos_token_id
    for o in examples:
        if 'messages' in o:
            m = o['messages']
            last_assistant = max(i for i, x in enumerate(m) if x['role'] == 'assistant')
            m = m[:last_assistant + 1]
            prompt = tok.apply_chat_template(m[:-1], tokenize=False, add_generation_prompt=True)
            full = tok.apply_chat_template(m, tokenize=False)
            a = tok(prompt, add_special_tokens=False)['input_ids']
            b = tok(full, add_special_tokens=False)['input_ids']
            if b[:len(a)] != a:  # the template does not make a prefix: tokenize the answer on its own
                b = a + tok(m[-1]['content'], add_special_tokens=False)['input_ids'] + [eos]
            if len(b) > context:
                # Cutting would leave the answer half: the model would learn to write half JSON/HTML. The sample is skipped.
                chat_parts.skipped += 1
                continue
            labels = [-100] * min(len(a), len(b)) + b[len(a):]
            if any(t != -100 for t in labels):
                parts.append((b, labels))
        else:
            ids = tok(o['text'], add_special_tokens=False)['input_ids'] + [eos]
            for i in range(0, len(ids), context):
                p = ids[i:i + context]
                if len(p) > 16:
                    parts.append((p, list(p)))
    return parts


chat_parts.skipped = 0


def base_folder(base: str) -> Path:
    """The base model's local folder: a local path or a copy downloaded from Hugging Face (training\\hf cache)."""
    if Path(base).is_dir():
        return Path(base)
    from huggingface_hub import snapshot_download

    return Path(snapshot_download(base, allow_patterns=['*.json', '*.safetensors', '*.model', '*.txt', '*.jinja', 'tokenizer*']))


def weight_bytes(folder: Path) -> int:
    return sum(p.stat().st_size for p in folder.glob('*.safetensors'))


def merge_streaming(base: Path, adaptor: Path, target: Path) -> int:
    """Adds the LoRA to the base weights tensor by tensor (W + scale·B·A), shard file by shard file.
    Never holds the whole model: 14B (bf16 ~30 GB) merges in 16 GB RAM. Returns the number of merged tensors."""
    import torch
    from safetensors import safe_open
    from safetensors.torch import save_file

    config = json.loads((adaptor / 'adapter_config.json').read_text(encoding='utf-8'))
    r, alpha = config['r'], config['lora_alpha']
    scale = alpha / (math.sqrt(r) if config.get('use_rslora') else r)
    pairs: dict[str, dict] = {}
    with safe_open(str(adaptor / 'adapter_model.safetensors'), 'pt') as f:
        for k in f.keys():
            m = re.match(r'base_model\.model\.(.+)\.lora_([AB])\.weight$', k)
            if m:
                pairs.setdefault(m.group(1) + '.weight', {})[m.group(2)] = f.get_tensor(k).float()
    target.mkdir(parents=True, exist_ok=True)
    merged = 0
    shards = sorted(base.glob('*.safetensors'))
    for no, file in enumerate(shards, 1):
        progress(82 + 6 * no / len(shards), f'Merging the LoRA: shard {no}/{len(shards)}')
        output = {}
        with safe_open(str(file), 'pt') as f:
            metadata = f.metadata() or {}
            for k in f.keys():
                t = f.get_tensor(k)
                c = pairs.get(k)
                if c:
                    t = (t.float() + scale * (c['B'] @ c['A'])).to(t.dtype)
                    merged += 1
                output[k] = t.contiguous()
        save_file(output, str(target / file.name), metadata={**metadata, 'format': 'pt'})
        del output
    if merged != len(pairs):  # before the end mark (config.json) is written: a retry merges again
        error(f'LoRA merge incomplete: {merged}/{len(pairs)} tensors matched.')
    # architecture, generation config, shard index, tokenizer files; config.json last: the mark that the merge is complete
    for d in sorted(base.iterdir(), key=lambda d: d.name == 'config.json'):
        if d.is_file() and not d.name.endswith('.safetensors') and not d.name.startswith('.'):
            shutil.copyfile(d, target / (d.name + '.writing' if d.name == 'config.json' else d.name))
    (target / 'config.json.writing').replace(target / 'config.json')
    return merged


def command_fine(a) -> None:
    import torch
    from peft import LoraConfig, PeftModel, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    output = Path(a.output)
    output.mkdir(parents=True, exist_ok=True)
    adaptor, hf = output / 'adaptor', output / 'hf'
    examples = read_data(Path(a.data))
    if not torch.cuda.is_available():
        error('No graphics card (CUDA) found; training needs a GPU.')

    progress(1, f'Preparing the base model: {a.base} (downloaded the first time)')
    base = base_folder(a.base)
    param = weight_bytes(base) / 2  # bf16
    large = param > 10e9  # ~14B: embedding in RAM, output layer 4-bit
    medium = param > 5e9  # ~8B: 8-bit optimizer
    tok = AutoTokenizer.from_pretrained(str(base))
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    if not tok.chat_template and any('messages' in o for o in examples):
        error('This base model has no chat template; for chat data pick its "-Instruct"/"-it" version.')

    if not (adaptor / 'adapter_config.json').exists():
        parts = chat_parts(tok, examples, a.context)
        if not parts:
            error('No training sample came out of the data (empty answers or the context is too short).')
        tokens = sum(len(p[0]) for p in parts)
        skipped = chat_parts.skipped
        if skipped:
            progress(3, f'{skipped} samples skipped, longer than the context ({a.context} tokens); raise the context or split the data')
        four_bit = not a.full_precision  # panel fine setting: bf16 LoRA on a large card
        progress(4, f'{len(parts)} training parts, {tokens:,} tokens; loading the model ({param / 1e9:.1f}B) {"4-bit" if four_bit else "bf16"}')
        config = json.loads((base / 'config.json').read_text(encoding='utf-8'))
        device_map = {'': 0}
        if four_bit and large and not config.get('tie_word_embeddings'):
            device_map = {'model.embed_tokens': 'cpu', '': 0}  # the input embedding is only a table lookup: it stays in RAM
        model = AutoModelForCausalLM.from_pretrained(
            str(base), dtype=torch.bfloat16, device_map=device_map, low_cpu_mem_usage=True,
            quantization_config=BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True,
                llm_int8_enable_fp32_cpu_offload=len(device_map) > 1,
                # In a large model the output layer is 4-bit too (frozen; GGUF quantizes it anyway); bf16 would be ~1.5 GB.
                llm_int8_skip_modules=[] if large else None) if four_bit else None)
        # prepare_model_for_kbit_training is NOT used: it grows the bf16 embedding/output layer to fp32
        # (+6 GB on 14B). All that is needed: gradient checkpointing + input gradients (a fine setting can turn checkpointing off).
        if not a.no_gradient:
            model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
        model.enable_input_require_grads()
        model.config.use_cache = False
        if a.previous_adaptor:
            model = PeftModel.from_pretrained(model, a.previous_adaptor, is_trainable=True)
        else:
            model = get_peft_model(model, LoraConfig(r=a.lora_r, lora_alpha=a.lora_r * 2, lora_dropout=0.05, bias='none',
                                                     task_type='CAUSAL_LM', target_modules='all-linear'))
        if large and a.context > 4096:
            # Long context: MLP intermediates in chunks (14B at 8192 tokens: 276 tokens/s without spilling; measured)
            chunked_mlp_patch(model)
        trained = sum(p.numel() for p in model.parameters() if p.requires_grad)
        progress(8, f'LoRA ready: {trained / 1e6:.1f}M trained parameters{" (going on from the earlier training)" if a.previous_adaptor else ""}; '
                    f'VRAM {torch.cuda.memory_allocated() / 2 ** 30:.1f} GB; training starts')
        # Long parts must not run out of memory: batch 1-4, effective batch ~16
        batch = 1 if large else max(1, min(4, 4096 // a.context))
        ckpt = output / 'checkpoint.pt'
        info = training_loop(model, parts, epoch=a.epoch, ratio=a.ratio, batch=batch, accumulation=max(1, 16 // batch),
                             params=[p for p in model.parameters() if p.requires_grad], start_pct=8, end_pct=80, tag='fine',
                             eight_bit=medium, activation_cpu=large and a.context > 2048, ckpt=ckpt)
        # Written beside it first, then renamed in one move: a half written LoRA must not pass as finished
        fresh = output / 'adaptor.writing'
        shutil.rmtree(fresh, ignore_errors=True)
        model.save_pretrained(str(fresh))
        tok.save_pretrained(str(fresh))
        (fresh / 'base.json').write_text(json.dumps({'base': a.base, 'folder': str(base)}, ensure_ascii=False), encoding='utf-8')
        (output / 'training.json').write_text(json.dumps({**info, 'parts': len(parts), 'tokens': tokens, 'skipped': skipped,
                                                          'param': round(param)}, ensure_ascii=False), encoding='utf-8')
        shutil.rmtree(adaptor, ignore_errors=True)
        fresh.replace(adaptor)
        ckpt.unlink(missing_ok=True)
        del model
        torch.cuda.empty_cache()

    if not (hf / 'config.json').exists():
        # bf16 full precision, streamed: merging over 4-bit loses quality, and the whole model in RAM does not fit for 14B.
        progress(82, 'Merging the LoRA into the base model (bf16)')
        n = merge_streaming(base, adaptor, hf)
        tok.save_pretrained(str(hf))
        progress(88, f'{n} tensors merged')
    info = json.loads((output / 'training.json').read_text(encoding='utf-8')) if (output / 'training.json').exists() else {}
    progress(90, 'Merged model saved')
    result({'hf': str(hf), **info})


# ── Training from scratch ───────────────────────────────────────────────────

SIZES = {  # hidden, layers, heads, vocabulary
    'small': (512, 8, 8, 8000),
    'medium': (768, 12, 12, 16000),
    'large': (1024, 16, 16, 32000),
}
# The role tokens are part of the vocabulary of the models trained so far: they stay as they are
CHAT_TEMPLATE = (
    "{{ bos_token }}{% for m in messages %}"
    "{% if m['role'] == 'system' %}<|sistem|>{% elif m['role'] == 'user' %}<|kullanici|>{% else %}<|asistan|>{% endif %}"
    "{{ m['content'] }}{% if m['role'] == 'assistant' %}{{ eos_token }}{% else %}\n{% endif %}{% endfor %}"
    "{% if add_generation_prompt %}<|asistan|>{% endif %}"
)
CHAT_TOKENS = ['<|sistem|>', '<|kullanici|>', '<|asistan|>']


def spm_tokenizer(model_path: Path):
    """transformers 5 fast tokenizer from a SentencePiece model (vocab_file is no longer read)."""
    from tokenizers import AddedToken
    from tokenizers.models import BPE
    from transformers import LlamaTokenizer
    from transformers.convert_slow_tokenizer import SentencePieceExtractor

    r = SentencePieceExtractor(str(model_path)).extract(BPE)
    tok = LlamaTokenizer(vocab=r['vocab'], merges=r['merges'], legacy=False, add_prefix_space=False, add_bos_token=True,
                         add_eos_token=False, pad_token='<pad>', unk_token='<unk>', bos_token='<s>', eos_token='</s>')
    tok.add_tokens([AddedToken(x, normalized=False, special=False) for x in CHAT_TOKENS])
    tok.chat_template = CHAT_TEMPLATE
    return tok


def chat_flatten(m: list[dict]) -> str:
    tag = {'system': '<|sistem|>', 'user': '<|kullanici|>', 'assistant': '<|asistan|>'}
    return ''.join(tag[x['role']] + x['content'] + ('' if x['role'] == 'assistant' else '\n') for x in m)


def command_scratch(a) -> None:
    import sentencepiece as spm
    import torch
    from transformers import LlamaConfig, LlamaForCausalLM

    output = Path(a.output)
    hf = output / 'hf'
    if (output / 'training.json').exists() and (hf / 'config.json').exists() and any(hf.glob('*.safetensors')):
        # Training finished before (the job stopped at a later stage): not trained again
        progress(90, 'Trained model ready (from the earlier run)')
        result({'hf': str(hf), **json.loads((output / 'training.json').read_text(encoding='utf-8'))})
        return
    hf.mkdir(parents=True, exist_ok=True)
    examples = read_data(Path(a.data))
    if not torch.cuda.is_available():
        error('No graphics card (CUDA) found; training needs a GPU.')
    hidden, layers, heads, vocabulary = SIZES[a.size]
    texts = [o['text'] if 'text' in o else chat_flatten(o['messages']) for o in examples]
    characters = sum(map(len, texts))
    # Small data, small vocabulary: a token the data hardly shows cannot be learned.
    vocabulary = int(max(1000, min(vocabulary, characters // 60)))

    if a.resume:
        # A model trained from scratch before: vocabulary and architecture kept, training goes on with all weights.
        progress(1, 'Loading the earlier model and its vocabulary (training goes on)')
        tok = spm_tokenizer(Path(a.resume) / 'tokenizer.model')
        tok.save_pretrained(str(hf))
        shutil.copyfile(Path(a.resume) / 'tokenizer.model', hf / 'tokenizer.model')  # the GGUF converter reads it
        model = LlamaForCausalLM.from_pretrained(a.resume, dtype=torch.float32).to('cuda')
        train_full(a, tok, model, texts, output, hf, default_ratio=1e-4)
        return

    if (output / 'checkpoint.pt').exists() and (hf / 'tokenizer.model').exists():
        # Training stopped halfway: the vocabulary is not trained again (the checkpoint weights go with it)
        progress(1, 'Using the earlier vocabulary (going on from the checkpoint)')
    else:
        progress(1, f'Training the vocabulary (SentencePiece BPE, {vocabulary} tokens)')
        raw = output / 'vocabulary-data.txt'
        raw.write_text('\n'.join(texts), encoding='utf-8')
        spm.SentencePieceTrainer.train(
            input=str(raw), model_prefix=str(output / 'tokenizer'), vocab_size=vocabulary, model_type='bpe',
            character_coverage=0.9995, byte_fallback=True, split_digits=True, allow_whitespace_only_pieces=True,
            # No leading space mark: the same split as the HF fast tokenizer and llama.cpp (add_space_prefix).
            remove_extra_whitespaces=False, normalization_rule_name='identity', add_dummy_prefix=False,
            user_defined_symbols=CHAT_TOKENS + ['\n'],
            unk_id=0, bos_id=1, eos_id=2, pad_id=3, input_sentence_size=2_000_000, shuffle_input_sentence=True,
            train_extremely_large_corpus=False, num_threads=os.cpu_count() or 4, minloglevel=2)
        raw.unlink(missing_ok=True)
        (output / 'tokenizer.model').replace(hf / 'tokenizer.model')
        (output / 'tokenizer.vocab').unlink(missing_ok=True)
    tok = spm_tokenizer(hf / 'tokenizer.model')
    tok.save_pretrained(str(hf))

    intermediate = int(round(hidden * 8 / 3 / 64) * 64)
    config = LlamaConfig(vocab_size=len(tok), hidden_size=hidden, intermediate_size=intermediate, num_hidden_layers=layers,
                         num_attention_heads=heads, num_key_value_heads=heads, max_position_embeddings=a.context,
                         rms_norm_eps=1e-5, rope_theta=10000.0, tie_word_embeddings=True,
                         bos_token_id=tok.bos_token_id, eos_token_id=tok.eos_token_id, pad_token_id=tok.pad_token_id)
    torch.manual_seed(1234)
    model = LlamaForCausalLM(config).to('cuda')
    train_full(a, tok, model, texts, output, hf, default_ratio={'small': 6e-4, 'medium': 4e-4, 'large': 3e-4}[a.size])


def train_full(a, tok, model, texts: list[str], output: Path, hf: Path, default_ratio: float) -> None:
    """Full weight training (from scratch or going on): token stream -> blocks, 2% validation, save."""
    import torch

    progress(6, 'Splitting the data into tokens')
    stream = []
    for t in texts:
        stream.extend([tok.bos_token_id] + tok(t, add_special_tokens=False)['input_ids'] + [tok.eos_token_id])
    block = min(a.context, model.config.max_position_embeddings)
    blocks = [stream[i:i + block] for i in range(0, len(stream) - 32, block)]
    if len(blocks) < 8:
        error(f'Too little data to train from scratch ({len(stream):,} tokens). Give at least a few hundred thousand characters of text.')
    rnd = random.Random(7)
    rnd.shuffle(blocks)
    held = max(1, len(blocks) // 50)  # 2% validation
    validation, training = blocks[:held], blocks[held:]

    param = sum(p.numel() for p in model.parameters())
    if param > 60e6:
        model.gradient_checkpointing_enable()
    model.config.use_cache = False
    tokens = len(stream)
    progress(8, f'Model: {param / 1e6:.0f}M parameters, {model.config.num_hidden_layers} layers; {tokens:,} tokens, {len(training)} blocks')

    # Small data, smaller batch: at least ~50 updates per epoch (otherwise the model ends before it learns anything).
    batch = max(4, min(32, 16384 // block, len(training) // 50))
    ckpt = output / 'checkpoint.pt'
    info = training_loop(model, [(b, list(b)) for b in training], epoch=a.epoch, ratio=a.ratio or default_ratio, batch=batch, accumulation=1,
                         params=list(model.parameters()), start_pct=8, end_pct=88, tag='scratch', warmup=0.02, ckpt=ckpt)

    progress(89, 'Measuring the validation loss')
    model.eval()
    total_loss, count = 0.0, 0
    with torch.no_grad(), torch.autocast('cuda', dtype=torch.bfloat16):
        for i in range(0, len(validation), 8):
            x = torch.tensor([b + [tok.pad_token_id] * (block - len(b)) for b in validation[i:i + 8]], device='cuda')
            y = torch.tensor([b + [-100] * (block - len(b)) for b in validation[i:i + 8]], device='cuda')
            total_loss += float(model(input_ids=x, labels=y).loss) * len(x)
            count += len(x)
    validation_loss = total_loss / max(1, count)
    model.config.use_cache = True
    model.save_pretrained(str(hf), safe_serialization=True)
    info = {**info, 'param': param, 'tokens': tokens, 'vocabulary': len(tok), 'validationLoss': round(validation_loss, 4),
            'perplexity': round(math.exp(min(20, validation_loss)), 2)}
    (output / 'training.json').write_text(json.dumps(info, ensure_ascii=False), encoding='utf-8')
    ckpt.unlink(missing_ok=True)
    progress(90, f'Model saved; validation loss {validation_loss:.3f} (perplexity {info["perplexity"]})')
    result({'hf': str(hf), **info})


# ── GGUF ────────────────────────────────────────────────────────────────────

# Target size against the 16 bit model (an estimate, for the disk check)
QUANTIZATION_RATIO = {'Q4_K_M': 0.31, 'Q5_K_M': 0.36, 'Q8_0': 0.54, 'F16': 1.0}


def command_gguf(a) -> None:
    """HF -> GGUF. Every output is written as ".writing" first and renamed when done: a conversion or quantization cut
    halfway never leaves a half file that looks "ready". A finished intermediate file (f16/q8_0 .tmp) is not made again on
    the next try. With enough disk the merged HF copy stays until the GGUF is done (a retry needs no new merge); without,
    it is deleted after the conversion to make room (the LoRA adaptor stays beside it)."""
    hf, target = Path(a.hf), Path(a.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    quantization = a.quantization.upper()
    direct = quantization in ('F16', 'Q8_0')  # the converter writes this type itself, no separate quantization
    for leftover in target.parent.glob(f'{target.stem}*.writing'):  # half written files
        leftover.unlink(missing_ok=True)
    has_adaptor = (hf.parent / 'adaptor' / 'adapter_config.json').exists()
    ready = next((p for p in (target.with_suffix('.f16.gguf.tmp'), target.with_suffix('.q8_0.gguf.tmp')) if p.exists()), None)
    f16_bytes = weight_bytes(hf) if hf.exists() else 0
    if not ready and not f16_bytes:
        error('No model to convert (the merged copy was deleted); retry the job.')
    free = shutil.disk_usage(target.parent).free
    margin = 3 * 2 ** 30
    final = (f16_bytes or ready.stat().st_size) * QUANTIZATION_RATIO.get(quantization, 1.0)
    converter = HERE / 'converter' / 'convert_hf_to_gguf.py'
    if not converter.exists():
        error('The GGUF converter is missing (training\\converter; run setup).')

    if ready:
        inter_type, inter, remove = ready.suffixes[-3].lstrip('.'), ready, False
        if free < final + margin:
            error(f'Not enough disk space: GGUF needs ~{(final + margin) / 2 ** 30:.0f} GB, {free / 2 ** 30:.0f} GB free.')
        progress(91, f'Using the ready intermediate file ({inter.name})')
    else:
        # Intermediate file: f16 (best); q8_0 when the disk is short (a very small difference; llama-quantize --allow-requantize).
        # First the option that fits with the HF copy kept, then the one that fits by deleting it after the conversion.
        candidates = [(quantization.lower(), final)] if direct else [('f16', f16_bytes), ('q8_0', f16_bytes * 0.54)]
        choice = None
        for deleting in (False, True):
            if deleting and not has_adaptor:
                break
            for kind, size in candidates:
                remaining = free - size + (f16_bytes if deleting else 0)
                if free >= size + margin and (direct or remaining >= final + margin):
                    choice = (kind, size, deleting)
                    break
            if choice:
                break
        if not choice:
            required = (candidates[-1][1] + (0 if direct else final) + margin) / 2 ** 30
            error(f'Not enough disk space: GGUF needs ~{required:.0f} GB, {free / 2 ** 30:.0f} GB free ({target.parent.drive or target.parent}).')
        inter_type, _, remove = choice
        inter = target.with_suffix('.gguf.tmp') if direct else target.with_suffix(f'.{inter_type}.gguf.tmp')
        temp = inter.with_name(inter.name + '.writing')
        progress(91, f'Converting to GGUF ({inter_type}; {free / 2 ** 30:.0f} GB free disk)')
        r = subprocess.run([sys.executable, str(converter), str(hf), '--outfile', str(temp), '--outtype', inter_type],
                           capture_output=True, text=True, encoding='utf-8', errors='replace')
        if r.returncode != 0:
            temp.unlink(missing_ok=True)
            lines = (r.stderr or r.stdout).strip().splitlines()
            error('GGUF conversion failed: ' + (lines[-1] if lines else f'code {r.returncode}'))
        temp.replace(inter)
        if remove:
            shutil.rmtree(hf, ignore_errors=True)
            progress(94, 'Merged intermediate copy deleted (the LoRA adaptor is kept)')
    if direct:
        inter.replace(target)
    else:
        progress(95, f'Quantizing: {a.quantization}')
        extra = ['--allow-requantize'] if inter_type != 'f16' else []
        temp = target.with_name(target.name + '.writing')
        r = subprocess.run([a.quantize, *extra, str(inter), str(temp), quantization], capture_output=True, text=True, encoding='utf-8', errors='replace')
        if r.returncode != 0:
            temp.unlink(missing_ok=True)  # the intermediate file stays: a retry does not convert again
            lines = (r.stderr or r.stdout).strip().splitlines()
            error('Quantization failed: ' + (lines[-1] if lines else f'code {r.returncode}'))
        temp.replace(target)
        inter.unlink(missing_ok=True)
    gib = target.stat().st_size / 2 ** 30
    progress(98, f'GGUF ready: {target.name} ({gib:.2f} GiB)')
    result({'gguf': str(target), 'gib': round(gib, 2)})


# ── Sample answers ──────────────────────────────────────────────────────────

def command_example(a) -> None:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    tok = AutoTokenizer.from_pretrained(a.hf)
    # A model whose bf16 does not fit the card (over 8 GB of weights: larger than ~4B) loads 4-bit for the samples.
    four_bit = weight_bytes(Path(a.hf)) > 8e9
    model = AutoModelForCausalLM.from_pretrained(
        a.hf, dtype=torch.bfloat16, device_map={'': 0}, low_cpu_mem_usage=True,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_compute_dtype=torch.bfloat16) if four_bit else None)
    model.eval()
    examples = []
    for prompt in a.prompt:
        if tok.chat_template:
            # enable_thinking: turns thinking off in thinking templates such as Qwen3, ignored by the others
            text = tok.apply_chat_template([{'role': 'user', 'content': prompt}], tokenize=False, add_generation_prompt=True, enable_thinking=False)
            ids = tok(text, add_special_tokens=False, return_tensors='pt').input_ids.to(model.device)
        else:
            ids = tok(prompt, return_tensors='pt').input_ids.to(model.device)
        with torch.no_grad():
            out = model.generate(ids, max_new_tokens=a.length, do_sample=True, temperature=0.7, top_p=0.9,
                                 repetition_penalty=1.1, pad_token_id=tok.pad_token_id or tok.eos_token_id)
        examples.append({'prompt': prompt, 'response': tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True).strip()})
    result({'examples': examples})


def main() -> None:
    p = argparse.ArgumentParser(description='Text model training')
    sub = p.add_subparsers(dest='command', required=True)
    h = sub.add_parser('prepare')
    h.add_argument('--output', required=True)
    h.add_argument('files', nargs='+')
    i = sub.add_parser('fine')
    i.add_argument('--data', required=True)
    i.add_argument('--base', required=True)
    i.add_argument('--output', required=True)
    i.add_argument('--epoch', type=float, default=2)
    i.add_argument('--ratio', type=float, default=2e-4)
    i.add_argument('--context', type=int, default=2048)
    i.add_argument('--lora-r', type=int, default=16)
    i.add_argument('--previous-adaptor', default='')
    i.add_argument('--full-precision', action='store_true', help='bf16 LoRA instead of 4-bit (large card)')
    i.add_argument('--no-gradient', action='store_true', help='gradient checkpointing off (large card)')
    s = sub.add_parser('scratch')
    s.add_argument('--data', required=True)
    s.add_argument('--output', required=True)
    s.add_argument('--size', choices=list(SIZES), default='small')
    s.add_argument('--epoch', type=float, default=3)
    s.add_argument('--ratio', type=float, default=0)
    s.add_argument('--context', type=int, default=512)
    s.add_argument('--resume', default='')
    g = sub.add_parser('gguf')
    g.add_argument('--hf', required=True)
    g.add_argument('--output', required=True)
    g.add_argument('--quantization', default='Q4_K_M')
    g.add_argument('--quantize', required=True)
    o = sub.add_parser('example')
    o.add_argument('--hf', required=True)
    o.add_argument('--prompt', action='append', required=True)
    o.add_argument('--length', type=int, default=200)
    a = p.parse_args()
    try:
        if a.command in ('fine', 'scratch', 'example'):
            attention_patch()
        {'prepare': command_prepare, 'fine': command_fine, 'scratch': command_scratch, 'gguf': command_gguf, 'example': command_example}[a.command](a)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - the panel shows one error line, the details are in the log
        import traceback
        traceback.print_exc()
        message = str(e).splitlines()[0][:300] if str(e) else type(e).__name__
        if 'out of memory' in message.lower():
            message = 'Not enough graphics card memory: lower the context (e.g. 1024) or the model size.'
        error(message)


if __name__ == '__main__':
    main()
