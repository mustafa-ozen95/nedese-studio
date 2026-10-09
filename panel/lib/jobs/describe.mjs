/**
 * Gorsel betimleme: toplanan koleksiyonun indirilmis gorsellerini yerel yazi modeli (gorsel kodlayicili Gemma) betimler.
 * Kaynak altyazi (Commons basligi / aciklamasi) ipucu olarak verilir; modelden gorselde olmayani yazmamasi istenir.
 * Commons altyazilari cogu kez katalog basligi ("Siege of Belgrade 1456"): genel model bunlarla betimlemeyi degil
 * baslik uydurmayi ogreniyordu (05.10.2026). Sonuc data\collections\<k>\captions.jsonl: { file, caption, language, model,
 * hint, topic?, suitable?, dateText }. Kaldigi yerden surer (betimlenen atlanir); egitimde collection/<k>/captions secilir.
 * Konu denetimi: koleksiyonun konusu varsa ayni cagrida gorselin konuya uyup uymadigi sorulur; uymayan (suitable: false)
 * betimlenir ama egitime girmez (koleksiyon "ne bulursa" toplamaya devam eder).
 */
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CancelError, UserError } from '../errors.mjs';
import { runFfmpeg } from '../ffmpeg.mjs';
import { text, number, choice } from './common.mjs';
import { readCaptions, collectionMedia } from './training.mjs';
import { fineSetting } from '../fine-settings.mjs';

export const name = 'Image captioning';
/** Duraklatilabilir: "Devam ettir" betimlenmemis gorsellerden surer. */
export const pausable = true;
// Yazi modelini kendisi kullanir: calisirken bot istekleri (/llm/v1) bekletilmez, ayni modeli paylasir
export const textModelShares = true;

const SAFE = /^[\p{L}\p{N}._-]+$/u;
/** Gorsel kodlayiciya giden en buyuk genislik (CPU'daki kodlayici buyuk gorselde yavas; ayrinti icin yeterli). */
const WIDTH_WIDE = 896;
// Ince ayar betimKucult kapali (gorsel kodlayici ekran kartinda): en cok 1536
const widthWide = () => (fineSetting('shrinkCaption') ? WIDTH_WIDE : 1536);
/** Art arda bu kadar gorselde yanit alinamazsa is durur (model kapanmis / bozuk). */
const CONSECUTIVE_ERRORS = 5;

/** Yazi modeline giden sistem istemi: betim dili (tr: Turkce betim, en: Ingilizce betim). */
export const CAPTION_SYSTEM = {
  tr: 'Sen görselleri betimleyen bir sanat tarihçisisin. Görseli dikkatle incele ve Türkçe, akıcı tek bir paragrafla (3-6 cümle) betimle: kimler ya da neler var, ne yapıyorlar, ortam, renkler, kompozisyon ve üslup. Görselde görmediğin ayrıntıyı uydurma. Kaynak bilgisi verilirse yalnız görselle uyuşan kısmını (ad, yer, tarih) kullan. Yalnız betimlemeyi yaz; başlık, madde işareti ya da açıklama notu ekleme.',
  en: 'You are an art historian describing images. Look at the image carefully and describe it in English in one fluent paragraph (3-6 sentences): who or what is depicted, what they are doing, the setting, colors, composition and style. Do not invent details you cannot see. If source information is given, use only the parts consistent with the image (names, places, dates). Write only the description; no title, bullet points or notes.',
};
const DEFAULT_PROMPT = { tr: 'Bu görseli betimle.', en: 'Describe this image.' };
const HINT_PREFIX = { tr: 'Kaynak bilgisi (ipucu; doğruluğu kesin değil)', en: 'Source information (a hint; may be inaccurate)' };

/** Konu denetimi: ayni cagrida gorsel koleksiyon konusuna uyuyor mu; yanitin ilk satiri karar. */
export const CONTROL_EXTRA = {
  tr: (topic) => ` Önce görselin şu konuyla ilgili olup olmadığına karar ver: «${topic}». Yanıtının İLK satırına yalnız UYGUN ya da UYGUN DEĞİL yaz; ikinci satırdan başlayarak betimlemeyi yaz (konuyla ilgisiz görseli de betimle).`,
  en: (topic) => ` First decide whether the image is about this topic: «${topic}». On the FIRST line of your answer write only RELEVANT or NOT RELEVANT; from the second line on write the description (describe unrelated images too).`,
};

/** Model yaniti -> { suitable: true | false | null, text }: ilk satirdaki karar ayrilir (yoksa null). */
export function splitControl(s) {
  const m = /^\s*[*_#]*\s*(UYGUN DEĞİL|UYGUN DEGIL|NOT RELEVANT|UYGUN|RELEVANT)\b[*_.:]*\s*\n?/i.exec(String(s ?? ''));
  if (!m) return { suitable: null, text: String(s ?? '') };
  return { suitable: !/DEĞİL|DEGIL|NOT/i.test(m[1]), text: String(s).slice(m[0].length) };
}

export function validate(g, { setting }) {
  const collection = String(g.collection ?? '').trim();
  if (!SAFE.test(collection) || /^\.+$/.test(collection)) throw new UserError('Invalid collection (the collection id from the Data collection tab).');
  // Indirilmis gorsel yoksa burada acik hata (collectionMedia atar)
  const images = collectionMedia(setting, { id: collection, type: 'images' });
  const language = choice(g.language, 'Language', Object.keys(CAPTION_SYSTEM), 'tr');
  // Konu: verilen ya da koleksiyonun ozet.json konusu; denetim konu varken varsayilan acik
  let summaryTopic = null;
  try {
    summaryTopic = JSON.parse(readFileSync(join(setting.aiRoot, 'data', 'collections', collection, 'summary.json'), 'utf8')).topic ?? null;
  } catch {}
  const topic = text(g.topic, 'Topic', { required: false, max: 200 }) || summaryTopic || '';
  const topicControl = Boolean(topic) && g.topicControl !== false && g.topicControl !== 'false';
  return {
    collection,
    language,
    ...(topicControl ? { topic } : {}),
    prompt: text(g.prompt, 'Question', { required: false, max: 300 }) || DEFAULT_PROMPT[language],
    max: number(g.max, 'At most', { min: 0, max: 100000, full: true, defaultValue: 0 }),
    total: images.length,
  };
}

export function summary(g) {
  // Kartta tur adi ("Image captioning") zaten basta: baslik yalniz koleksiyon
  return { title: g.collection, detail: `${g.max ? `at most ${g.max}` : `${g.total} images`} · ${g.language === 'tr' ? 'Turkish' : 'English'}${g.topic ? ` · topic check: ${g.topic.slice(0, 50)}` : ''} · "${g.prompt.slice(0, 60)}"` };
}

/** Model yaniti -> duz betim: Markdown isaretleri, basta "Betimleme:" gibi etiket, fazla bosluk atilir. */
export function cleanCaption(s) {
  return String(s ?? '')
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .replace(/[*_#`>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/^\s*(betimleme|açıklama|description)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

export async function run(ctx) {
  const g = ctx.job.input;
  const llm = ctx.llm;
  if (!llm?.installed) throw new UserError('Text model not installed (llm\\bin\\llama-server.exe and llm\\models\\*.gguf).');
  if (!llm.understandsImages) throw new UserError('The selected text model does not read images (no mmproj image encoder). Pick a model that understands images in Settings > Text model (Gemma 4 26B, with mmproj).');
  if (!ctx.setting.ffmpeg) throw new UserError('ffmpeg not found (setup\\setup.ps1).');
  const root = join(ctx.setting.aiRoot, 'data', 'collections', g.collection);
  const output = join(root, 'captions.jsonl');
  const images = collectionMedia(ctx.setting, { id: g.collection, type: 'images' });
  // Kaldigi yerden: bu dilde betimlenmis olanlar atlanir (konuya uymayan da: yeniden sorulmaz)
  const done = new Set([...readCaptions(root, g.language, { all: true }).keys()]);
  const remaining = images.filter((m) => !done.has(m.file));
  const position = g.max ? remaining.slice(0, g.max) : remaining;
  ctx.log(`${images.length} images; ${done.size} already captioned, ${position.length} to caption (${g.language === 'tr' ? 'Turkish' : 'English'}).`);
  if (!position.length) {
    ctx.progress({ percent: 100, stage: 'Done', detail: 'No images left to caption' });
    ctx.addOutput({ file: null, type: 'data', collection: g.collection, captioned: 0, totalCaption: readCaptions(root, g.language).size });
    return;
  }
  await ctx.flushVoiceForGpu?.();
  const temp = join(ctx.folder, 'temp.jpg');
  const modelName = llm.info?.name ?? null;
  let fresh = 0;
  let error = 0;
  let suitableNot = 0;
  let consecutive = 0;
  let lastError = '';
  let totalSec = 0;
  const examples = [];
  for (const [i, m] of position.entries()) {
    if (ctx.signal?.aborted) throw new CancelError();
    const startedAt = Date.now();
    try {
      // Kucuk JPEG: kodlayici CPU'da; genislik en cok 896 (ince ayarla 1536; kucuk gorsel buyutulmez)
      await runFfmpeg(ctx.setting.ffmpeg, ['-y', '-i', m.path, '-frames:v', '1', '-vf', `scale='min(${widthWide()},iw)':-2`, '-q:v', '3', temp], { signal: ctx.signal });
      const data = readFileSync(temp).toString('base64');
      const textPart = m.text ? `${g.prompt}\n\n${HINT_PREFIX[g.language]}: ${m.text}` : g.prompt;
      const r = await llm.req('/v1/chat/completions', {
        messages: [
          { role: 'system', content: CAPTION_SYSTEM[g.language] + (g.topic ? CONTROL_EXTRA[g.language](g.topic) : '') },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }, { type: 'text', text: textPart }] },
        ],
        temperature: 0.3, max_tokens: 500, chat_template_kwargs: { enable_thinking: false }, stream: false,
      }, { externalRequest: false });
      if (ctx.signal?.aborted) throw new CancelError();
      if (r.code !== 200) throw new Error(r.json?.error?.message ?? `Text model HTTP ${r.code}`);
      const raw = r.json?.choices?.[0]?.message?.content;
      const decision = g.topic ? splitControl(raw) : { suitable: null, text: raw };
      const caption = cleanCaption(decision.text);
      if (caption.length < 20) throw new Error(`response too short: "${caption}"`);
      if (decision.suitable === false) suitableNot++;
      appendFileSync(output, `${JSON.stringify({ file: m.file, caption, language: g.language, model: modelName, hint: m.text || null, ...(g.topic ? { topic: g.topic, suitable: decision.suitable } : {}), dateText: new Date().toISOString() })}\n`);
      fresh++;
      consecutive = 0;
      if (examples.length < 3) examples.push({ file: m.file, caption });
      totalSec += (Date.now() - startedAt) / 1000;
      const avg = totalSec / fresh;
      ctx.progress({ percent: ((i + 1) / position.length) * 100, stage: 'Captioning', detail: `${i + 1}/${position.length} · ${Math.round(avg)} s per image · ~${Math.ceil((avg * (position.length - i - 1)) / 60)} min left · ${caption.slice(0, 60)}` });
    } catch (e) {
      if (ctx.signal?.aborted || e instanceof CancelError) throw new CancelError();
      error++;
      consecutive++;
      lastError = String(e.message ?? e).slice(0, 200);
      ctx.log(`${m.file}: could not be captioned (${lastError})`);
      if (consecutive >= CONSECUTIVE_ERRORS) throw new UserError(`Text model did not respond on ${CONSECUTIVE_ERRORS} consecutive images: ${lastError}`);
    }
  }
  rmSync(temp, { force: true });
  const totalCaption = readCaptions(root, g.language).size;
  ctx.log(`Done: ${fresh} images captioned${error ? `, ${error} could not be captioned (retried on the next run)` : ''}${g.topic ? `; ${suitableNot} off-topic (excluded from training)` : ''}; ${totalCaption} usable captions in the collection. In training select "collection/${g.collection}/captions".`);
  for (const o of examples) ctx.log(`Sample · ${o.file}: ${o.caption.slice(0, 300)}`);
  ctx.addOutput({ file: null, type: 'data', collection: g.collection, captioned: fresh, undescribable: error, ...(g.topic ? { toTopicNonMatching: suitableNot } : {}), totalCaption, examples });
  ctx.progress({ percent: 100, stage: 'Done', detail: `${fresh} images captioned` });
}
