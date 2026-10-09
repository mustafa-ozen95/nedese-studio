/**
 * Kalici panel ayarlari: <ai>\panel-data\ayar.json (kodun DISINDA; panel klasoru baska
 * makineye kopyalaninca gizli anahtar tasinmaz).
 *
 *   apiAnahtari     API istemcileri icin "Authorization: Bearer <anahtar>" (ilk acilista uretilir)
 *   modelSecimleri  comfy.mjs'teki model dosyasi yerine kullanilacak niceleme (Q4_K_M / Q8_0 ...)
 *                   { qwen: 'Q4_K_M', wan14: 'Q4_K_M' }  ('' = comfy.mjs'teki ad, degistirme)
 *   sesMotoru       seslendirme motoru: voxcpm (varsayilan) | ema (anlatim EMA; klon ve karakterler VoxCPM2) | kizagan | chatterbox
 *   comfyBostaKapatDk  kuyruk bosalinca ComfyUI'yi kac dakika sonra kapat (0 = kapatma)
 *   yaziModeli      yerel yazi modeli dosyasi (<ai>\llm\modeller\*.gguf; '' = ilk dosya)
 *   guncelleme      { otomatik (varsayilan acik), sonDenetim (ms), sonSonuc (son denetimin uzak surumu) }
 *   istemCevir      istemler modele gitmeden Ingilizceye cevrilsin mi (varsayilan acik)
 *   inceAyarlar     donanima gore ince ayarlar (lib/ince-ayarlar.mjs; yalniz varsayilandan farkli olanlar)
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_SETTINGS = { apiKey: '', modelChoices: { qwen: '', wan14: '' }, voiceEngine: 'voxcpm', comfyIdleCloseMin: 10 };

/** Boşta kapatma seçenekleri (dakika; 0 = kapatma). */
export const IDLE_CLOSE_MIN = [0, 5, 10, 30, 60];

/**
 * Text model: minutes idle before it leaves memory; 0 = keep it loaded (user request 08.10.2026: "modelin sürekli
 * bellekte tutulup tutulmayacağı ile ilgili bi ayar", "boşta bellekten çıkarma da"). Default 5 (the old fixed time).
 */
export const TEXT_MODEL_IDLE_MIN = [0, 2, 5, 10, 30, 60];
const TEXT_MODEL_IDLE_DEFAULT = 5;

/** Seslendirme motorlari: ses\seslendir.bat (Chatterbox) ya da ses\voxcpm\seslendir.bat (VoxCPM2). */
export const VOICE_ENGINES = { ema: 'EMA Lightning (narration; characters and clone via VoxCPM2)', voxcpm: 'VoxCPM2 (most natural Turkish)', kizagan: 'Kizagan (Turkish fine-tune of VoxCPM2)', chatterbox: 'Chatterbox' };

export function generateKey() {
  return `aip_${randomBytes(24).toString('base64url')}`;
}

export class SettingsFile {
  constructor(path) {
    this.path = path;
    this.data = structuredClone(DEFAULT_SETTINGS);
    this.load();
  }

  load() {
    if (existsSync(this.path)) {
      try {
        const read = JSON.parse(readFileSync(this.path, 'utf8'));
        this.data = { ...structuredClone(DEFAULT_SETTINGS), ...read, modelChoices: { ...DEFAULT_SETTINGS.modelChoices, ...(read.modelChoices ?? {}) } };
      } catch {
        /* bozuk dosya: varsayilanla surer, kaydedince yenilenir */
      }
    }
    if (!this.data.apiKey) {
      this.data.apiKey = generateKey();
      this.save();
    }
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.writing`;
    writeFileSync(temp, JSON.stringify(this.data, null, 1), 'utf8');
    renameSync(temp, this.path);
  }

  get apiKey() {
    return this.data.apiKey;
  }

  refreshKey() {
    this.data.apiKey = generateKey();
    this.save();
    return this.data.apiKey;
  }

  get modelChoices() {
    return { ...this.data.modelChoices };
  }

  get voiceEngine() {
    return VOICE_ENGINES[this.data.voiceEngine] ? this.data.voiceEngine : 'voxcpm';
  }

  get comfyIdleCloseMin() {
    const min = Number(this.data.comfyIdleCloseMin);
    return IDLE_CLOSE_MIN.includes(min) ? min : DEFAULT_SETTINGS.comfyIdleCloseMin;
  }

  saveComfyIdleClose(min) {
    this.data.comfyIdleCloseMin = min;
    this.save();
  }

  get textModelIdleMin() {
    const min = Number(this.data.textModelIdleMin);
    return TEXT_MODEL_IDLE_MIN.includes(min) ? min : TEXT_MODEL_IDLE_DEFAULT;
  }

  saveTextModelIdle(min) {
    this.data.textModelIdleMin = min;
    this.save();
  }

  get textModel() {
    return String(this.data.textModel ?? '');
  }

  saveTextModel(file) {
    this.data.textModel = file;
    this.save();
  }

  saveVoiceEngine(engine) {
    this.data.voiceEngine = engine;
    this.save();
  }

  saveModelChoice(choices) {
    this.data.modelChoices = { ...this.data.modelChoices, ...choices };
    this.save();
  }

  get updateAuto() {
    return this.data.update?.auto !== false;
  }

  get updateLastControl() {
    return Number(this.data.update?.lastControl ?? 0) || 0;
  }

  /** Son denetimin sonucu ({ tarih, uzak: { sha, tarih, mesaj }, kurulumGerekli }): yeniden acilista ust cubuk bilir. */
  get updateLastResult() {
    return this.data.update?.lastResult ?? null;
  }

  /** degisen: { otomatik?, sonDenetim?, sonSonuc? } */
  saveUpdate(changing) {
    this.data.update = { ...(this.data.update ?? {}), ...changing };
    this.save();
  }

  get translatePrompt() {
    return this.data.translatePrompt !== false;
  }

  savePromptTranslate(isOpen) {
    this.data.translatePrompt = Boolean(isOpen);
    this.save();
  }

  /**
   * Where the panel listens on this installation (Settings › Network; user request 08.10.2026): address 0.0.0.0 (all
   * networks) or 127.0.0.1 (this computer only). The port is not in Settings (user 08.10.2026); a "port" written here by
   * hand still counts. null = panel\defaults.json. Applies after a restart.
   */
  get listen() {
    return { address: this.data.address ?? null, port: Number(this.data.port) > 0 ? Number(this.data.port) : null };
  }

  saveListen({ address, port }) {
    if (address !== undefined) this.data.address = address;
    if (port !== undefined) this.data.port = port;
    this.save();
  }

  /** Chats opened from other devices get the file and command tools (default on; no sign-in by design). */
  get networkFullAccess() {
    return this.data.networkFullAccess !== false;
  }

  saveNetworkFullAccess(on) {
    this.data.networkFullAccess = Boolean(on);
    this.save();
  }

  /**
   * Search services for the assistant's search_web (Settings › Web search; user request 08.10.2026): Brave Search and
   * Tavily API keys, a SearXNG address; '' = not set. Stored here like the API key; answers show them masked.
   */
  get webSearch() {
    const w = this.data.webSearch ?? {};
    return { brave: String(w.brave ?? ''), tavily: String(w.tavily ?? ''), searxng: String(w.searxng ?? '') };
  }

  /** changing: checked { service: value }; '' removes the service. */
  saveWebSearch(changing) {
    const fresh = { ...this.webSearch, ...changing };
    for (const [k, v] of Object.entries(fresh)) if (!v) delete fresh[k];
    this.data.webSearch = fresh;
    this.save();
  }

  /**
   * Remote OpenAI-compatible text model (Settings › Remote model; user request 08.10.2026): base address, API key, model
   * name, and whenBusy (chats use it while the GPU is busy with a job); '' = not set. The key is stored here like the
   * web search keys; answers show it masked.
   */
  get remoteModel() {
    const r = this.data.remoteModel ?? {};
    return { url: String(r.url ?? ''), key: String(r.key ?? ''), model: String(r.model ?? ''), whenBusy: r.whenBusy === true };
  }

  /** changing: checked { url?, key?, model?, whenBusy? }; '' (false) removes a field. */
  saveRemoteModel(changing) {
    const fresh = { ...this.remoteModel, ...changing };
    for (const [k, v] of Object.entries(fresh)) if (!v) delete fresh[k];
    this.data.remoteModel = fresh;
    this.save();
  }

  /** Ince ayarlar (lib/ince-ayarlar.mjs): yalniz varsayilandan farkli olanlar kayitli. */
  get fineSettings() {
    return { ...(this.data.fineSettings ?? {}) };
  }

  /** degisen: dogrulanmis { anahtar: deger }; varsayilana donen anahtar silinir. */
  saveFineSettings(changing, defaults) {
    const fresh = { ...(this.data.fineSettings ?? {}), ...changing };
    for (const [k, v] of Object.entries(fresh)) if (defaults?.[k] === v) delete fresh[k];
    this.data.fineSettings = fresh;
    this.save();
  }
}
