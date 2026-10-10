/**
 * Errors: a clear message for the user, the details to the log.
 *
 * Rule: the message on screen says "what happened + what to do"; the raw error (ComfyUI's JSON,
 * a Python traceback) stays only in the log and in the details part of the preview window.
 */

/** The user cancelled. Not counted as an error; the job becomes "cancelled". */
export class CancelError extends Error {
  constructor(message = 'Cancelled.') {
    super(message);
    this.name = 'CancelError';
  }
}

/** Invalid input: the message is shown to the user as it is. */
export class UserError extends Error {
  constructor(message, detail = '') {
    super(message);
    this.name = 'UserError';
    this.detail = detail;
  }
}

/** The ComfyUI request did not pass validation (POST /prompt 400). */
export class ComfyValidationError extends Error {
  constructor(response) {
    super(`ComfyUI rejected the request: ${JSON.stringify(response).slice(0, 4000)}`);
    this.name = 'ComfyValidationError';
    this.response = response;
  }
}

/** The ComfyUI job failed while running (execution_error). */
export class ComfyRuntimeError extends Error {
  constructor(info) {
    super(`ComfyUI error: ${info.exception_type ?? ''} ${info.exception_message ?? ''}`.trim());
    this.name = 'ComfyRuntimeError';
    this.info = info;
  }
}

/** An outside process (voice, ffmpeg) exited with a non-zero code. The name is the process's (voice, design, ffmpeg). */
export class ProcessError extends Error {
  constructor(name, code, lastLines) {
    super(`${name} exited with code ${code}`);
    this.name = name;
    this.code = code;
    this.lastLines = lastLines ?? [];
  }
}

// model_name: MoGe (LoadMoGeModel), the 3D high quality's geometry model
const MODEL_FIELDS = ['unet_name', 'ckpt_name', 'lora_name', 'clip_name', 'vae_name', 'model_name'];

function isMemory(text) {
  return /out of memory|OutOfMemoryError|CUDA error: out of memory|Allocation on device|CUBLAS_STATUS_ALLOC_FAILED/i.test(text);
}

/** Did the ComfyUI job fail because the graphics card ran out of memory (not RAM). */
export function isOutOfVram(error) {
  if (!(error instanceof ComfyRuntimeError)) return false;
  const text = `${error.info?.exception_type ?? ''} ${error.info?.exception_message ?? ''}`;
  // the "MemoryError" pattern of isRam() also catches torch.OutOfMemoryError: only the CPU side allocators are left out
  return isMemory(text) && !/DefaultCPUAllocator|paging file|bad allocation|0xC000012D/i.test(text);
}

function isRam(text) {
  return /DefaultCPUAllocator|not enough memory|paging file|MemoryError|bad allocation|0xC000012D/i.test(text);
}

function isCrash(text) {
  return /access violation|0xC0000005|3221225477|-1073741819/i.test(text);
}

/** A clear reason from a ComfyUI validation response (a missing model, a missing extension). */
function validationReason(response) {
  const nodeErrors = Object.values(response?.node_errors ?? {});
  for (const d of nodeErrors) {
    for (const h of d.errors ?? []) {
      const detail = `${h.details ?? ''} ${h.message ?? ''}`;
      const field = MODEL_FIELDS.find((a) => detail.includes(a));
      if (h.type === 'value_not_in_list' && field) {
        const name = /'([^']+)'\s+not in/.exec(detail)?.[1] ?? h.extra_info?.received_value ?? '';
        return `Model file not found: ${name}. Download it in Settings > Models (a download still running must finish first).`;
      }
      if (h.type === 'value_not_in_list' && /image/.test(detail)) {
        return 'The source image did not reach ComfyUI (not in the input folder). Retry the job.';
      }
    }
  }
  const type = response?.error?.type ?? '';
  const message = response?.error?.message ?? '';
  if (/node_not_found|invalid_prompt/.test(type) && /does not exist|not found/i.test(message + JSON.stringify(response?.error?.details ?? ''))) {
    const node = /node (?:type )?['"]?([\w .-]+?)['"]? (?:does not exist|not found)/i.exec(`${message} ${response?.error?.details ?? ''}`)?.[1];
    return `ComfyUI is missing a required node${node ? `: ${node}` : ''}. Is the extension (ComfyUI-GGUF / ComfyUI-Frame-Interpolation) installed and enabled?`;
  }
  if (nodeErrors.length) {
    const first = nodeErrors[0]?.errors?.[0];
    return `ComfyUI rejected the request: ${first?.message ?? message}${first?.details ? ` (${first.details})` : ''}`;
  }
  return `ComfyUI rejected the request: ${message || type || 'unknown reason'}`;
}

/**
 * Turns any error into { message, detail }: the message on screen, the detail in the log.
 */
export function friendlyError(error) {
  if (!error) return { message: 'Unknown error.', detail: '' };
  if (error instanceof CancelError) return { message: error.message, detail: '' };
  if (error instanceof UserError) return { message: error.message, detail: error.detail ?? '' };

  const raw = [error.message, ...(error.lastLines ?? []), JSON.stringify(error.info ?? '')].join('\n');

  if (error instanceof ComfyValidationError) {
    return { message: validationReason(error.response), detail: error.message };
  }

  if (error instanceof ComfyRuntimeError) {
    const b = error.info ?? {};
    const text = `${b.exception_type ?? ''} ${b.exception_message ?? ''}`;
    const node = b.node_type ? ` (${b.node_type})` : '';
    if (/interrupt/i.test(text)) return { message: 'Job stopped in ComfyUI.', detail: raw };
    if (isMemory(text)) {
      return {
        message: `Not enough GPU memory${node}. Choose a smaller size or shorter duration; close other GPU apps.`,
        detail: raw,
      };
    }
    if (isRam(text)) {
      return { message: `Not enough system memory (RAM)${node}. Close browser tabs and heavy apps, then retry.`, detail: raw };
    }
    return { message: `ComfyUI failed${node}: ${(b.exception_message ?? '').trim().split('\n')[0].slice(0, 300) || 'details in the log'}`, detail: raw };
  }

  if (error instanceof ProcessError) {
    const last = error.lastLines.join('\n');
    const names = { voice: 'Voice-over', design: 'Voice design', ffmpeg: 'ffmpeg' };
    const name = names[error.name] ?? error.name;
    if (isMemory(last)) return { message: `${name}: not enough GPU memory. Free ComfyUI or close other GPU work.`, detail: raw };
    if (isRam(last)) return { message: `${name}: not enough system memory (RAM).`, detail: raw };
    if (isCrash(last) || isCrash(String(error.code))) return { message: `${name} crashed (memory access error). Retry.`, detail: raw };
    // the last line of a Python traceback usually says why ("FileNotFoundError: ...").
    const reason = [...error.lastLines].reverse().find((s) => /(Error|Exception|error:)/.test(s) && s.trim().length > 3);
    return { message: `${name} failed${reason ? `: ${reason.trim().slice(0, 300)}` : ` (exit code ${error.code})`}`, detail: raw };
  }

  const m = String(error.message ?? error);
  if (/ECONNREFUSED|fetch failed|ECONNRESET|socket hang up|UND_ERR_SOCKET/i.test(m) || error.cause?.code === 'ECONNREFUSED') {
    return { message: 'Could not connect to ComfyUI: it is off or crashed. Start it from the top bar and retry the job.', detail: raw };
  }
  if (/ENOENT/.test(m)) return { message: `File not found: ${error.path ?? m}`, detail: raw };
  if (/ENOSPC/.test(m)) return { message: 'The disk is full.', detail: raw };
  if (isMemory(m)) return { message: 'Not enough GPU memory.', detail: raw };
  return { message: m.length > 300 ? `${m.slice(0, 300)}…` : m, detail: raw };
}
