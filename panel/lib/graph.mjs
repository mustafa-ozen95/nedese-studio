/**
 * ComfyUI API is akisi (graf) yardimcilari. Graflari panel YAZMAZ: araclar\comfy.mjs'teki
 * qwenIsi / fluxIsi / wan14Isi / wanIsi uretir (model adlari makineye ozel, orada).
 * Burada yalnizca uretilmis graf uzerinde genel islemler var:
 *
 * - birlestir: birden cok grafi TEK isteme koyar, ayni dugumleri (model yukleyiciler,
 *   ayni istem kodlamasi) bir kez calistirir; yukleyiciler 1 kez calisir. --cache-none ile her
 *   istekte modeller diskten yeniden okunuyor (16 GB RAM'de dakikalar). Farkli istemlerde once
 *   butun kodlamalar, sonra ornekleme (kodlamalarOnce): yoksa kodlayici/model her gorselde takas.
 * - adimAyarla, onekAyarla, rifeEkle: graf uzerinde kucuk degisiklikler.
 */

/** ["dugum", cikisNo] bicimindeki baglanti mi? */
export function isConnection(v) {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && Number.isInteger(v[1]);
}

/** Dugum kimliklerini bagimlilik sirasina dizer (once girdiler). */
export function orderedNodes(job) {
  const position = [];
  const status = new Map();
  const visit = (id) => {
    const d = status.get(id);
    if (d === 2) return;
    if (d === 1) throw new Error(`Cycle in the graph: ${id}`);
    status.set(id, 1);
    const node = job[id];
    if (!node) throw new Error(`Link to a node that is not in the graph: ${id}`);
    for (const v of Object.values(node.inputs ?? {})) if (isConnection(v)) visit(v[0]);
    status.set(id, 2);
    position.push(id);
  };
  for (const id of Object.keys(job)) visit(id);
  return position;
}

const OUTPUT_CLASSES = new Set(['SaveImage', 'PreviewImage', 'SaveVideo', 'SaveAnimatedWEBP', 'SaveWEBM']);

/**
 * Graflari tek grafa birlestirir; ozdes dugumler (sinif + girdiler ayni) bir kez kalir.
 * Doner: { is, eslesme: [ {eskiId: yeniId} her graf icin ] }.
 */
export function merge(graphs) {
  const job = {};
  const fromSignature = new Map();
  const match = [];
  let counter = 0;
  for (const g of graphs) {
    const fresh = {};
    for (const id of orderedNodes(g)) {
      const d = g[id];
      const inputs = {};
      for (const [k, v] of Object.entries(d.inputs ?? {})) inputs[k] = isConnection(v) ? [fresh[v[0]], v[1]] : v;
      const signature = JSON.stringify([d.class_type, inputs]);
      if (!OUTPUT_CLASSES.has(d.class_type) && fromSignature.has(signature)) {
        fresh[id] = fromSignature.get(signature);
        continue;
      }
      counter += 1;
      const nid = String(counter);
      job[nid] = { ...d, inputs: inputs };
      fromSignature.set(signature, nid);
      fresh[id] = nid;
    }
    match.push(fresh);
  }
  return { job: graphs.length > 1 ? encodingsBefore(job) : job, match };
}

// Metin kodlayici dugumleri ('clip' girdisi bagli) ve ornekleyicilerin geciktirilen kosul girdisi
const ENCODER = /^(CLIPTextEncode|CLIPTextEncodeFlux|CLIPTextEncodeSD3|TextEncodeQwenImageEdit|TextEncodeQwenImageEditPlus)$/;
const CONDITION_INPUT = { KSampler: 'positive', KSamplerAdvanced: 'positive', CFGGuider: 'positive', BasicGuider: 'conditioning' };

/**
 * Birlesik grafta once butun metin kodlamalari, sonra ornekleme. ComfyUI ciktiya en yakin dugumu once calistirir
 * (comfy_execution/graph.py ux_friendly_pick_node): tek istekte bile "kodla -> ciz -> kaydet" gorsel gorsel doner ve
 * 16 GB RAM'de metin kodlayici (Qwen 7,9 GB) ile cizim modeli (12,7 GB) her gorselde takas edilir. Olculdu 07.10.2026:
 * 5 gorsel 892 sn, cizim yalniz 278 sn; kodlayici 5 kez yeniden yuklendi. Bekletme ConditioningAverage zinciriyle:
 * guc 1.0'da cikti sayisal olarak 'to' kosulunun aynisi (t*1 + f*0). Zincirin sonu butun kodlamalara bagli; her
 * ornekleyicinin pozitif kosulu ondan gecer. Farkli metin kodlayicili (boyutu farkli) ya da donguye yol acacak
 * graflara dokunulmaz.
 */
export function encodingsBefore(job) {
  const encoders = Object.keys(job).filter((id) => ENCODER.test(job[id].class_type) && isConnection(job[id].inputs?.clip));
  const gates = Object.keys(job).filter((id) => isConnection(job[id].inputs?.[CONDITION_INPUT[job[id].class_type]]));
  if (encoders.length < 2 || gates.length < 2) return job;
  if (new Set(encoders.map((id) => job[id].inputs.clip[0])).size !== 1) return job;
  const fresh = structuredClone(job);
  let last = Math.max(...Object.keys(fresh).map(Number).filter(Number.isFinite), 0);
  const center = (to, from) => {
    last += 1;
    fresh[String(last)] = { class_type: 'ConditioningAverage', inputs: { conditioning_to: to, conditioning_from: from, conditioning_to_strength: 1 } };
    return [String(last), 0];
  };
  let chain = [encoders[0], 0];
  for (const id of encoders.slice(1)) chain = center([id, 0], chain);
  for (const id of gates) {
    const name = CONDITION_INPUT[fresh[id].class_type];
    fresh[id].inputs[name] = center(fresh[id].inputs[name], chain);
  }
  try {
    orderedNodes(fresh);
  } catch {
    return job; // kodlama bir ornekleyicinin ciktisina bagliysa dongu olur: oldugu gibi
  }
  return fresh;
}

/**
 * ComfyUI dugum sureleri ozeti (is gunlugu): [{ id, sn }] calisma sirasiyla. 1 sn'den kisalar atlanir; en cok 12 dugum
 * tek tek, fazlasi sinifa gore toplanir ("KSampler ×5 278"). Olculdu 07.10.2026: video parcasinda ornekleme disindaki
 * ~111 sn (yukleme, cozme, RIFE, kayit) gunlukte zaman olmadigindan ayrilamiyordu.
 */
export function nodeDurationSummary(durations, cls) {
  const name = (id) => cls[id] ?? id;
  const long = durations.filter((x) => x.sec >= 1);
  if (!long.length) return '';
  if (long.length <= 12) return long.map((x) => `${name(x.id)} ${Math.round(x.sec)}`).join(' · ');
  const groups = new Map();
  for (const x of durations) {
    const g = groups.get(name(x.id)) ?? { sec: 0, count: 0 };
    g.sec += x.sec;
    g.count += 1;
    groups.set(name(x.id), g);
  }
  return [...groups].filter(([, g]) => g.sec >= 1).map(([a, g]) => `${a}${g.count > 1 ? ` ×${g.count}` : ''} ${Math.round(g.sec)}`).join(' · ');
}

/** Yalniz verilen cikis dugumlerine giden dugumler kalir (bolunmus isteklerde kullanilmayan yukleyiciler calismasin). */
export function pruned(job, exits) {
  const remaining = new Set();
  const walk = (id) => {
    if (remaining.has(id) || !job[id]) return;
    remaining.add(id);
    for (const v of Object.values(job[id].inputs ?? {})) if (isConnection(v)) walk(v[0]);
  };
  exits.forEach(walk);
  return Object.fromEntries(Object.entries(job).filter(([id]) => remaining.has(id)));
}

/** Sinifa gore dugum kimlikleri. */
export function nodes(job, cls) {
  return Object.keys(job).filter((id) => job[id].class_type === cls);
}

/** KSampler adim sayisi (hizlandirilmis modellerde 4/8 onerilir). */
export function configureStep(job, step) {
  for (const id of [...nodes(job, 'KSampler'), ...nodes(job, 'Flux2Scheduler')]) job[id].inputs.steps = step;
  return job;
}

/** SaveImage dosya on eki (ComfyUI/output altinda alt klasor olabilir: 'panel/<id>/g'). */
export function configurePrefix(job, prefix) {
  for (const id of nodes(job, 'SaveImage')) job[id].inputs.filename_prefix = prefix;
  return job;
}

/**
 * Kaydetmeden once RIFE ara kare dugumu ekler (Wan 5B grafinda yok). Dugum ayarlari bir
 * sablondan kopyalanir: wan14Isi({ akici: 2 }) grafindaki RIFE dugumu (tek kaynak comfy.mjs).
 */
export function addRife(job, factor, template) {
  if (!(factor > 1)) return job;
  if (!template) throw new Error('No RIFE template (comfy.mjs wan14Job smooth support)');
  const record = nodes(job, 'SaveImage')[0];
  if (!record) throw new Error('No SaveImage in graph');
  const source = job[record].inputs.images;
  const newId = String(Math.max(...Object.keys(job).map(Number).filter(Number.isFinite), 0) + 1);
  job[newId] = { class_type: template.class_type, inputs: { ...template.inputs, frames: source, multiplier: factor } };
  job[record].inputs.images = [newId, 0];
  return job;
}

/**
 * Panelde egitilen LoRA'yi (Model egitimi > Gorsel) modele baglar: UNETLoader'in MODEL cikisini kullanan her
 * dugum, araya eklenen LoraLoaderModelOnly'den beslenir. Grafta birden cok UNETLoader varsa hepsine eklenir.
 */
export function addLora(job, loraName, strength = 1) {
  if (!loraName) return job;
  for (const unet of nodes(job, 'UNETLoader')) {
    const newId = String(Math.max(...Object.keys(job).map(Number).filter(Number.isFinite), 0) + 1);
    job[newId] = { class_type: 'LoraLoaderModelOnly', inputs: { model: [unet, 0], lora_name: loraName, strength_model: strength } };
    for (const [id, d] of Object.entries(job)) {
      if (id === newId) continue;
      for (const [name, v] of Object.entries(d.inputs ?? {})) if (isConnection(v) && v[0] === unet && v[1] === 0) d.inputs[name] = [newId, 0];
    }
  }
  return job;
}

/** Dugum -> sinif haritasi (ilerleme metni icin). */
export function classes(job) {
  return Object.fromEntries(Object.entries(job).map(([id, d]) => [id, d.class_type]));
}

/** Graftaki model dosya adlari (ekranda "hangi model" bilgisi; makineye gore Q4/Q8). */
export function modelFiles(job) {
  const fields = ['unet_name', 'ckpt_name'];
  const names = [];
  for (const d of Object.values(job)) for (const a of fields) if (typeof d.inputs?.[a] === 'string') names.push(d.inputs[a]);
  return names;
}

const NODE_NAMES = {
  UnetLoaderGGUF: 'Loading model',
  UNETLoader: 'Loading model',
  CheckpointLoaderSimple: 'Loading model',
  SamplerCustomAdvanced: 'Drawing image',
  Flux2Scheduler: 'Step schedule',
  CFGGuider: 'Guidance',
  KSamplerSelect: 'Sampler',
  RandomNoise: 'Noise',
  EmptyFlux2LatentImage: 'Empty image',
  LoraLoaderModelOnly: 'Loading LoRA',
  CLIPLoader: 'Loading text encoder',
  VAELoader: 'Loading VAE',
  CLIPTextEncode: 'Encoding prompt',
  TextEncodeQwenImageEditPlus: 'Encoding prompt',
  ConditioningAverage: 'Ordering prompts',
  EmptySD3LatentImage: 'Preparing',
  ModelSamplingAuraFlow: 'Preparing',
  ModelSamplingSD3: 'Preparing',
  LoadImage: 'Reading source image',
  WanImageToVideo: 'Preparing video',
  Wan22ImageToVideoLatent: 'Preparing video',
  KSampler: 'Sampling',
  KSamplerAdvanced: 'Sampling',
  VAEDecode: 'Decoding frames',
  'RIFE VFI': 'Intermediate frames (RIFE)',
  SaveImage: 'Saving',
  // TRELLIS.2 (3D model)
  LoadBackgroundRemovalModel: 'Loading the background model',
  RemoveBackground: 'Removing the background',
  ImageCropToMask: 'Cropping the subject',
  CLIPVisionLoader: 'Loading the vision encoder',
  Trellis2Conditioning: 'Encoding the image',
  EmptyTrellis2LatentStructure: 'Preparing',
  VaeDecodeStructureTrellis2: 'Decoding the structure',
  Trellis2ShapeStage: 'Preparing the shape',
  Trellis2UpsampleStage: 'Upsampling the shape',
  VaeDecodeShapeTrellis: 'Decoding the shape',
  Trellis2TextureStage: 'Preparing the texture',
  VaeDecodeTextureTrellis: 'Decoding the texture',
  RemeshMesh: 'Remeshing',
  DecimateMesh: 'Simplifying the mesh',
  MeshSmoothNormals: 'Smoothing normals',
  UnwrapMesh: 'Unwrapping UVs',
  BakeTextureFromVoxel: 'Baking the texture',
  BakeNormalMapFromMesh: 'Baking the normal map',
  BakeAmbientOcclusion: 'Baking ambient occlusion',
  ApplyTextureToMesh: 'Applying textures',
  SaveGLB: 'Saving',
  LoadVideoTextDataSetFromFolder: 'Reading clips',
  GetVideoComponents: 'Extracting frames',
  MakeTrainingDataset: 'Encoding dataset',
  SaveTrainingDataset: 'Saving dataset',
  LoadTrainingDataset: 'Reading dataset',
  TrainLoraNode: 'LoRA training',
  SaveLoRA: 'Saving LoRA',
  PreviewAny: 'Loss values',
};

export function nodeName(cls) {
  return NODE_NAMES[cls] ?? cls;
}
