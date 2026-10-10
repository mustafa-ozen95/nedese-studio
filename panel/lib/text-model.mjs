/**
 * Text model calls: ONLY the local model (llama-server + <ai>\llm\models\*.gguf; Gemma). The scene and lyric writers,
 * the music and edit plans and prompt translation go through here. No external CLI or service is called (07.10.2026
 * user decision: the panel has no login, so anyone on the local network could otherwise use this computer's accounts).
 */
import { CancelError, UserError } from './errors.mjs';

/** The local text model (lib/llm.mjs LocalLlm); server.mjs sets it, in tests a fake or none. */
let model = null;
export function setTextModel(llm) {
  model = llm?.installed ? llm : null;
}
export const hasText = () => Boolean(model);
/** Yazi modeli gorsel de okuyor mu (ayni klasorde gorsel kodlayici mmproj-<model> var). */
export const readsImages = () => Boolean(model?.info?.mmproj);

/**
 * Tek sohbet istegi; yanit coz() ile cozulur. disIstek: arayuzden/API'den (is disi) cagri: panelde is calisirken
 * ekran karti bosalana kadar bekler (beklemeSn; varsayilan sinirsiz, iptal sinyaliyle durur), bekliyor(true|false)
 * bekleme durumunu bildirir. Is icinden cagri (disIstek false) beklemez. json: yanit gecerli JSON nesnesi (dilbilgisiyle).
 * gorsel: istemle birlikte okunacak gorsel (data: URL; gorsel kodlayici kurulu olmali).
 */
export async function runText({ system, prompt, image = null, parse = (m) => m, json = false, schema = null, temperature = 0.3, maxToken = 2048, signal = null, externalRequest = false, waitSec = Infinity, waiting = null, name = 'Text model' }) {
  if (!model) throw new UserError('Text model is not installed (<ai>\\llm); this feature runs on the local text model.');
  if (image && !readsImages()) throw new UserError("The text model's image encoder (mmproj) is not installed; the image cannot be read.");
  if (signal?.aborted) throw new CancelError();
  const r = await model.req(
    '/v1/chat/completions',
    {
      messages: [{ role: 'system', content: system }, { role: 'user', content: image ? [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: prompt }] : prompt }],
      temperature: temperature,
      max_tokens: maxToken,
      chat_template_kwargs: { enable_thinking: false },
      // schema: the answer's exact shape (a JSON schema); json alone: any JSON object
      ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } } } : json ? { response_format: { type: 'json_object' } } : {}),
    },
    { externalRequest, waitSec, signal, waiting },
  );
  const text = r.json?.choices?.[0]?.message?.content;
  if (r.code !== 200 || !text) throw new Error(`${name}: ${r.json?.error?.message ?? `HTTP ${r.code}`}`);
  return parse(text);
}
