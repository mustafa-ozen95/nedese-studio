# Yerel Yapay Zekâ Sistemi (RTX 5070)

Kullanıcı, 29.09.2026: *"Hazır bir ai sistemi oluşturalım direk, ihtiyaç oldukça ileride kullanırız."*
Görsel, video, seslendirme ve döküm tamamen bu bilgisayarda, internete veri göndermeden çalışır.
Tüm modeller **ticari kullanıma açık** lisanslıdır (Apache 2.0 / MIT).

## Donanım ve sınırlar

| | |
|---|---|
| Ekran kartı | NVIDIA RTX 5070, **12 GB VRAM** (Blackwell, sürücü 596) |
| RAM | **16 GB** — asıl darboğaz. Büyük modeller parça parça yüklenir; üretim sırasında Chrome'u kapatmak hızı belirgin artırır |
| Disk | Modeller ~77 GB (`models\`) |

## Başlatma

```
Masaüstü > Nedese Studio (Nedese Studio.vbs, tepsi)  → http://127.0.0.1:1071 (kolay kullanım: aşağıda "Panel")
<kurulum klasörü>\start_comfyui.bat        → http://127.0.0.1:8188 (arayüz + API)
```
Bayraklar makineye göre ayarlı (`--disable-pinned-memory --disable-dynamic-vram --cache-none --use-sage-attention`):
pinned bellekle Wan metin kodlayıcısı yüklenirken *access violation* ile çöktü (ölçüldü).

## Komut satırı araçları (`tools\`, Node)

| İş | Komut | Süre (5070) |
|---|---|---|
| Görsel (en güçlü) | `node tools\image.mjs "istem" cikti.png [--width 1664 --height 928 --seed 42]` | ~65 sn |
| Görsel (hızlı) | `node tools\image.mjs "istem" cikti.png --fast` | ~16 sn |
| Kareden video | `node tools\video.mjs kare.png "hareket" klasor [--smooth 3]` | 720p 5 sn ≈ 6 dk (SageAttention) |

İstemler İngilizce en iyisi. Projeler ortak istemciyi içe aktarır:
`import { run, qwenJob, wan14Job } from 'file:///<kurulum klasörü>/tools/comfy.mjs'`.

## Ses (`voice\`, ayrı Python 3.14 ortamı)

| İş | Komut |
|---|---|
| Türkçe seslendirme (ses klonlama) | `voice\speak.bat --text "Merhaba." --reference ref.wav --output merhaba.wav` |
| Çok satır, en iyi çekim seçimi | `voice\speak.bat --job job.json --folder cikti --trial 3` (Whisper her çekimi dökümler, metne en yakını seçer) |
| Döküm + kelime zamanları | `voice\.venv\Scripts\python.exe voice\dump.py kayit.wav` |

| Daha doğal seslendirme (önerilen) | `voice\speak.bat --job job.json --folder cikti --trial 6 --vary --naturalness` — her çekim farklı ayar; doğru okunanlar arasından UTMOS doğallık puanı en yüksek seçilir; sona uydurulan hece Whisper kelime zamanlarıyla kesilip yeniden dinlenir |
| Kısa satırı cümle içinden ayırma | `voice\.venv\Scripts\python.exe voice\divide.py cekim.wav "ilk parça" bir.wav iki.wav` — "O gün…" gibi kısa satırı tek okutunca model uyduruyor; "O gün… Bugündür!" okut, en sessiz andan böl (sınır −40 dBFS altında değilse başka çekim seç) |
| Tariften ses tasarımı (yaşlı, tok, hışırtılı…) | `voice\design\.venv\Scripts\python.exe voice\design\design.py --spec "A very old man…" --text "Come, sit…" --output tini.wav --count 3` |
| İngilizce vb. anlatım, en doğal yol | `design.py --spec @tarif.txt --text @metin.txt --output oku.wav --count 2` ile metnin TAMAMINI tek nefeste okut (UTMOS ~4,4; Türkçe klon ~3,8), sonra `voice\.venv\Scripts\python.exe voice\lines.py oku.wav anlatim.json satirlar\ --lang en [--device cpu --model small.en]` ile satırlara böl |
| Aynı sesle eksik satırı yeniden okutma | `voice\design\.venv\Scripts\python.exe voice\design\clone.py --reference ref10sn.wav --reference-text "…" --text "…" --output x.wav --count 6` (Qwen3-TTS Base klon; VoiceDesign her üretimde tınıyı değiştirir) |
| Tını dönüşümü (sözler kalır, ses değişir) | `voice\.venv\Scripts\python.exe voice\convert.py kaynak.wav hedef_tini.wav cikti.wav` (`--folder` ile toplu) |
| Ölçüm (perde, tını, döküm) | `voice\.venv\Scripts\python.exe voice\measure.py a.wav b.wav [--dump --lang tr]` |

Referans: ~10 sn temiz konuşma (klonlanacak tını). Türkçe modelde olmayan bir tını gerekirse (yaşlı dede,
dev, cadı…) önce Qwen3-TTS VoiceDesign ile tariften İngilizce tını üret, sonra onu Chatterbox'a referans ver;
Türkçe seslendirme o tınıyla çıkar. Tasarım modeli Türkçe bilmez; ayrı ortamda (`voice\design\.venv`,
Python 3.13, transformers 4.57.3'e sabit, Chatterbox'la çakışır). `exaggeration` (0.25–2) duygu şiddeti, `cfg` (0–1) düşükse
daha yavaş ve ölçülü okuma. "Prime" gibi yabancı kelimeleri okunuşuyla yaz ("Praym").
Ses ortamı ComfyUI'den **ayrı**: Chatterbox Python ≤3.13'te PyTorch'u 2.6'ya sabitler, bu RTX 50'yi tanımaz.

### Sesle söylet (Düzenle > Sesle söylet, 10.10.2026)

Var olan bir şarkı kütüphanedeki bir sesle (Kendi sesim'deki sesiniz, tasarlanan ya da yüklenen bir ses) yeniden söyletilir; ezgi,
sözler ve çalgılar kalır. `voice\sing.py` **YingMusic-SVC**'yi çalıştırır (GiantAILab, sıfır atış, Seed-VC tabanlı; kod MIT,
`voice\svc`; ağırlıklar **CC BY-NC 4.0: ticari olmayan kullanım**):
1. BS-RoFormer şarkıyı ana vokal, arka vokaller ve müzik olarak ayırır;
2. ana vokal (varsayılan olarak arka vokaller de) kütüphane sesinin tınısına dönüştürülür (sesin WAV'ı referans, en çok 25 sn);
3. ffmpeg dönüşen vokali müzikle yeniden karıştırır (`song.mp3`); `vocal.mp3` yalnız yeni vokal.

- **Ton değil oktav:** müzik kaydırılmaz, bu yüzden vokal yalnız tam oktav kayar (−12 / 0 / +12). "Otomatik" iki sesin perdesine bakarak
  modele seçtirir (uyarlama katsayısından sonra fark ≥7 yarım tonsa bir oktav; erkek arabesk şarkı EMA kadın sesiyle 0'da kaldı, tahmin 4,2).
- **Ölçüm (RTX 5070, 150 sn arabesk şarkı):** ayırma model yüklemeyle ~50 sn (~6,7 GB VRAM), dönüştürme RTF 0,19-0,31; ana + arka
  vokal toplam 87 sn. Whisper large-v3 sözlerin %79'unu ayrılmış orijinal vokalde, %69'unu dönüşmüş vokalde duydu.
- Yeniden deneme kaldığı yerden sürer: ayrılmış parçalar ve dönüşen vokaller işin `work\` klasöründe kalır.
- Kurulum: `setup.bat` kodu kopyalar (`setup\vendor\YingMusic-SVC`), `voice\svc\.venv`'i kurar (Python 3.12.14, torch cu130,
  `setup\lock\svc.txt`) ve yardımcıları sabit sürümle `voice-models.py svc` ile indirir (RMVPE, CAM++, BigVGAN, Whisper small;
  ~1,6 GB, sonra çevrimdışı çalışır). İki büyük model Ayarlar > Modeller > "Şarkı sesi (YingMusic-SVC)" altında (~2 GB).
- Windows: `sing.py` soundfile ile kaydeder (torchaudio 2.9+ torchcodec ister), sox tabanlı remiks ve wandb'yi yüklemez.

### Karakter sesleri (Tek parça diyalog, 07.10.2026)

**Girdi.**
- Sahne kartındaki "Konuşmalar" alanında her satır "Ad: söz" biçiminde yazılır.
- Konuşan her ad, film formundaki "Karakterler" listesinde cinsiyeti ve yaşıyla yer alır.
- Sahne yazarı (yerel Gemma) karakterleri ve replikleri de yazar.

**Ses seçimi.** Sırayla:
1. Kullanıcının seçtiği ses.
2. Kütüphanede aynı adlı karakterin önceki sesi (dizi boyunca aynı ses).
3. Kütüphanede cinsiyeti ve yaşı uyan ses. Anlatıcının sesi, kendi kayıtları ve LoRA'lı sesler bu seçime girmez.
4. Hiçbiri yoksa VoxCPM2 ile tariften yeni ses tasarlanır. Kütüphaneye `gender`, `age` ve `character` alanlarıyla eklenir.

**Tasarımda aday seçimi (08.10.2026).** Aynı tarif tohuma göre çok farklı çıkıyordu (ölçüldü 07.10: çocuk olasılığı
0,51 / 0,78 / 0,99; yansız tasarlanan Elif 234 Hz ile yetişkin kadın sınırındaydı). Artık `voice\voxcpm\description.py` karakter sesi
için **3 tohum** üretir, her adayı ölçer ve hedefe en uyanı seçer (`--candidate 3 --target --gender --type --separate --report`):
- perde: pYIN F0 ortancası; yaş/cinsiyet: audeering wav2vec2 yaş-cinsiyet modeli (CC BY-NC-SA 4.0, yalnız ölçüm; yazılım
  ücretsiz/ticari değil); ayrışma: WavLM-SV x-vektör kosinüsü (MIT), aynı filmdeki öteki karakter sesleri ve anlatıcıya karşı.
- Puan: insan çocuk → çocuk olasılığı ×2 + perde 280 Hz'e yaklaşma; hayvan → perde 380 Hz'e yaklaşma ×2 + "insan değil";
  yetişkin → cinsiyet olasılığı ×2 + yaş hedefine yakınlık (genç 22, yetişkin 40, yaşlı 68); perde beklenti dışıysa −0,5;
  benzerlik 0,94 ve üstü (WavLM; kalibrasyon: ECAPA 0,27-0,35 ayrık çiftler → 0,88-0,90, karışan 0,74-0,87 → 0,96-0,99) −1.
- Gerçek koşu (08.10): Elif tarifi tohum 101 → 234 Hz, 202 → **287 Hz, çocuk 0,97** (seçildi), 303 → 259 Hz. Pamuk (hayvan,
  Elif'e karşı ayrışma): 101 → 253 Hz yetişkin gibi (çocuk 0,26; eski kütüphane sesi buydu), 202 → 377 Hz erkek 0,65,
  303 → **594 Hz, çocuk 0,98, Elif'e benzerlik 0,89** (seçildi). Üretim ~8-13 sn/aday.
- Seçilen adayın ölçümü kütüphane kaydında `measurement` (seed, f0, age, child, female, male, similarity, score); adaylar
  günlükte ("Ses tasarımı adayları: ... → seçilen tohum N"), rapor `character-voices\<ad>\report.json`.
- Modeller `setup.bat` ile iner (`voice-models.py voxcpm`); ölçüm CPU'da (~1 sn/aday).

**Tür (insan / hayvan).** Konuşan hayvanın sesi aynı filmdeki insanlardan ayrılır:
- Neden: kedi Pamuk "kız çocuğu" tarifiyle tasarlanınca 494 Hz kız sesi çıktı, Elif 445-513 Hz. Kullanıcı: "Kedi mi
  konuşuyor Elif mi, karışmış".
- Karakter listesinde "Tür" seçilir; sahne yazarı da yazar. Yazılmamışsa tariften çıkarılır ("kitten", "kedi", "dog"...).
- Hayvana yalnız kütüphanede `type: animal` olan ses verilir, insana hayvan sesi verilmez.
- Hayvan sesi "çizgi film hayvanı, insan çocuğu değil" tarifiyle tasarlanır; perde aralığı denetimi hayvanda yapılmaz.

**Seslendirme.**
- Her satır kendi sesiyle okunur (`job.json` satırında `reference`); satırlar 0,3 sn arayla sahne sesine birleşir.
- Seçilen çekimin perdesi (F0, pYIN ortancası) ölçülür. Günlükte "uygun" ya da "beklenenden kalın/ince" yazar.
  - Aralıklar: erkek 70-175 Hz, kadın 150-350 Hz, çocuk 200-600 Hz.
  - Ölçülen örnekler (gerçek diyalog filmi):
    - anlatıcı C2 90-94 Hz;
    - Baba (kütüphaneden A2) 110 Hz;
    - tasarlanan kız çocuğu 445 Hz (normal), 513 Hz (seslenirken);
    - kedi 494 Hz;
    - EMA Lightning kadın sesi ~233 Hz.
- Altyazıda replik konuşanın adıyla başlar ("Elif: ...").

## Yerel yazı modeli (`llm\`, llama.cpp)

- `llm\bin\`: llama.cpp `llama-server` (ggml-org/llama.cpp b11392, Windows CUDA 13.4).
- `llm\bin-prism\`: PrismML'in llama.cpp derlemesi (PrismML-Eng/llama.cpp prism-b10754-2459f68, Windows CUDA 12.4); PQ2_0 ve PTQ1_0 nicemlemeleri yalnız burada açılır, panel bunlar için bu sunucuyu seçer.
- `llm\models\Ternary-Bonsai-2-27B-PQ2_0.gguf`: PrismML Ternary Bonsai 2 27B, PQ2_0 (6,71 GiB), Ayarlar > Yazı modeli'nde seçim yoksa **varsayılan**; görsel kodlayıcısı (BF16) `mmproj-Ternary-Bonsai-2-27B-PQ2_0.gguf`. Ölçüldü 08.10.2026: 12 GB kartta 65 belirteç/sn.
- `llm\models\gemma-4-26B-qat-q4_0.gguf`: Google Gemma 4 26B-A4B, resmî QAT Q4_0 (Apache 2.0, 13,45 GiB).
  - Uzmanlar karması; ekrana sığmayan uzman katmanları RAM'de (`--n-cpu-moe`, dosya boyutundan).
  - Ayarlar > Yazı modeli ile değiştirilebilir.
- `llm\models\mmproj-gemma-4-26B-qat-q4_0.gguf`: Gemma'nın görsel kodlayıcısı (resmî, 1,11 GiB). Model dosyasının yanında `mmproj-<ad>` varsa model "görsel anlar": llama-server `--mmproj` ile açılır, `/llm/v1/chat/completions` isteğinde `image_url` parçası okunur. Silinirse model yalnız yazı okur.
  - Kodlayıcının yeri `llamaConfig`'nda: MoE modelde CPU'da (`--no-mmproj-offload`); yoğun modelde bağlam ve KV ile birlikte 10,8 GB bütçeye sığarsa ekran kartında.
  - Ölçüldü (05.10.2026, Gemma 26B): kodlayıcı ekran kartında 14 uzman katmanı RAM'e iner, yazı 51,7 → 43,3 belirteç/sn, görsel yanıtı 4,4 sn. CPU'da yazı hızı korunur (51,5), görsel yanıtı 18 sn. Botların yazı işi ağır bastığı için CPU seçildi.
- Ölçüldü (04.10.2026, nedese botunun DeepSeek'e giden birebir istemleriyle):
  - Çeviri DeepSeek kalitesinde; çağrı başına ~35 sn (~61 token/sn).
  - Kaynaktan özgün yazı 550–850 kelime; DeepSeek ~1000 kelime yazıyor ve kurgusu daha analitik.
  - Elenenler:
    - Gemma 4 12B: özgün yazıda yetersiz.
    - 26B IQ4_XS: 2,4 kat yavaş.
    - Türkçe budanmış 26B: çok kısa yazıyor.
    - Qwen3.6-35B IQ3: Türkçesi zayıf.
- Panel yönetir:
  - İstek gelince açar.
  - Görsel/video/ses işi başlarken kapatır; ekran kartı ve RAM ComfyUI ile paylaşılır.
  - 5 dk boşta kalınca kapatır.
  - İş sürerken gelen dış istek iş bitene kadar bekler (en çok ~5,5 dk, sonra 503; nedese botu o zaman DeepSeek yedeğine düşer).
  - Yazı modelini kendisi kullanan işte (veri toplama, görsel betimleme: `textModelShares`) dış istek beklemez, aynı modeli sırayla paylaşır.
- OpenAI uyumlu adres: `http://<bu-bilgisayar>:1071/llm/v1` (`/responses`, `/chat/completions`, `/models`).
  - Anahtar: panel API anahtarı (Bearer).
  - `/responses` içeride JSON biçimi zorlanarak çalışır (DeepSeekClient biçimi).
  - `/responses` önce düşünür (varsayılan 3072 token; `reasoning.effort`: none/low/medium/high).
    Düşünmeden karar/denetim istemlerinde DeepSeek'ten ayrışıyordu: bölüm yazıcı hep "zaten var" diyor, denetçi `reason`'ı atlıyordu.
    Bölümlü makale (`metadata.sectioned`), `/chat/completions` ve istem çevirisi düşünmez.
  - `/responses` sıcaklığı en çok 0.3: düşünerek 0.7'de uzun yazıyı kopyalarken kelime bozuyordu ("Konfor" → "Konfer").
  - Sistem istemine uzunluk notu eklenir (bölüm/paragraf sayısını kısa tutuyordu).
  - Çıktıya girdide olmayan bir yazı (ör. Hangul) karışırsa bir kez düşünmeden yeniden dener.
  - Bağlam 32k, tek yuva; eşzamanlı istekler sırayla işlenir. Uzman katmanı 11'i RAM'de (ekran kartında ~0,9 GB pay; taşınca hız ~4 token/sn'ye düşüyordu).
- Panelde Tekil > Metin bu modeli kullanır (düzelt, çevir, özetle, yeniden yaz).
- Bütün yazı işleri yalnız bu modelle yapılır: istem çevirisi, hareket istemleri, sahne yazarı, söz yazarı, müzik planı ve düzenleme planı (`panel\lib\text-model.mjs`). Dış komut satırı asistanı çağrısı 07.10.2026'da kaldırıldı (kullanıcı: yazı işleri panelin kendi sahip olduğu modellerle olmalı). Panelde giriş olmadığından yerel ağdan açan biri bu bilgisayardaki o dış oturumu kullandırabiliyordu. Sahne yazarı film üretilirken ekran kartı boşalana kadar bekler; Kuyruk'ta yan görev olarak görünür, iptal edilebilir. Ölçüm: 4 sahne 45 sn (model yüklemesi dahil).

## Model eğitimi (`training\`, ayrı Python 3.13 ortamı)

Panelde **Eğitim** sekmesi (API: `type: "training"`, `POST /uploads/data`, `GET /training`). Yazı modelini kendi metinlerinle eğitir; sonuç GGUF olarak `llm\models\`'e girer, Ayarlar > Yazı modeli'nden (ya da sonuçtaki "Yazı modeli yap" ile) seçilir.

| Yöntem | Ne yapar | Ölçüldü (RTX 5070 12 GB) |
|---|---|---|
| Var olanı geliştir (ince ayar) | Hazır temel (Qwen3 14B önerilen, 8B, 4B Instruct, 1.7B ya da başka bir Hugging Face metin modeli) 4-bit yüklenir, LoRA eğitilir (QLoRA); LoRA diskten akıtılarak bf16 temelle birleştirilip GGUF'a çevrilir, birleşik kopya silinir (LoRA saklanır) | Qwen3 1.7B, 84 bin belirteç: 7 adım 125 sn, Q4_K_M 1,03 GiB, ~340 token/sn. Qwen3 14B: aşağıda |
| Burada eğitilmiş modeli geliştir | İnce ayarlı modelin LoRA'sı aynı temel üstünde eğitime devam eder; sıfırdan eğitilmiş model kendi sözlüğüyle tüm ağırlıklarından eğitime devam eder | — |
| Sıfırdan eğit | Veriden SentencePiece sözlüğü (BPE, bayt yedekli) + Llama mimarisi: küçük ~30M, orta ~100M, büyük ~240M parametre | Küçük, 83 bin belirteç: 18 sn (bu kadar veriyle anlamlı yazamaz; birkaç MB metin gerekir) |

- Veri: TXT/MD/HTML düz metin (üslup ve bilgi), JSONL/JSON/CSV soru-cevap: `{"prompt","response"}`, `{"messages":[…]}` ya da CSV `question,answer`. Sohbet örneklerinde yalnız son asistan yanıtı öğretilir.
- Aşamalar: `train.py prepare` → `fine`/`scratch` → `example` → `gguf` (llama.cpp b11392 dönüştürücüsü `training\converter\` + `llm\bin\llama-quantize.exe`). Yarıda kalan iş yeniden denenince biten aşamalar atlanır.
- **Duraklat / devam:** eğitim döngüsü ~2 dakikada bir (14B'de her adımda) kayıt noktası yazar (`training\models\<kimlik>\checkpoint.pt`: eğitilen ağırlıklar, iyileştirici, zamanlayıcı, veri sırası, rastgelelik; önce `.writing`, fsync, sonra adlandırma). Panelde **Duraklat** süreci durdurur (ekran kartı ve RAM boşalır, durum `paused`); **Devam ettir** son tamamlanan adımdan aynı yörüngeyle sürer. Panel/bilgisayar kapanması ve elektrik kesintisi de aynı yoldan kurtarılır. Kayıt noktası yalnız aynı veri ve ayarlarla (imza) sürdürülür. API: `POST /jobs/{id}/pause`, `/jobs/{id}/retry`.
- **Disk:** GGUF aşaması boş alana bakar: yeterse f16 ara dosya ve birleşik HF kopyası GGUF bitene kadar korunur (yeniden denemede yeniden birleştirme yok); yetmezse q8_0 ara dosya (`--allow-requantize`, fark ihmal edilebilir) ve/veya dönüştürmeden sonra HF kopyası silinir; hiç yetmezse anlaşılır bir hata. Her çıktı önce `.writing` adıyla yazılır: yarım dosya "hazır" sayılmaz. 14B: HF kopyası ~30 GB + f16 ~30 GB + Q4_K_M 9 GB.
- **Yazı modeli olarak eğitilmiş 14B:** llama-server ayarı GGUF üst verisinden seçilir (`llm.mjs llamaConfig`): MoE (Gemma 26B-A4B) eskisi gibi uzman katmanları RAM'de 32k bağlam; yoğun model (Qwen3 14B Q4_K_M 8,4 GiB) 12 GB karta 16k bağlam + q8_0 KV ile sığdırılır (32k f16 KV ~14 GiB taşıp hızı 60'tan ~4 belirteç/sn'ye düşürüyordu).
- **İlk 14B eğitimi (05.10.2026, "Nedese SEO yazarı 14B"):** 569 seçilmiş nedese örneği (532 parça, 2,83 M belirteç, bağlam 8192), 1 devir 34 adım, kayıp 0,62 → 0,45, tepe VRAM 11,85 GB, eğitim 2 sa 32 dk; birleştirme + GGUF ~15 dk. Değerlendirme `tools\data\evaluate.mjs` (eğitim dışı 19 örnek: 6 yazı, 6 çeviri, 6 meta, 1 tazele; `data\comparison\*-separate.json` + ham çıktılar `*-outputs.jsonl`):
  - Gemma 26B'yi **geçemedi**. Özgün yazıda 6 örneğin yarısında meta alanları eksik, meta açıklama hiç 140-160 aralığında değil, bir örnekte Türkçe yerine İngilizce; çeviri chrF 78,3 (Gemma 83,9); meta açıklama uygunluğu %17 (Gemma %100). Tazelemede eşit. Hız 1,5-15× (yazı 30 sn / Gemma 164 sn).
  - Sebep (ölçüldü): yazı örneklerinin yalnız 6/92'si bağlamı aştığı için atlandı, yani model örnekleri gördü; tek devir ve rank 16 ile ~570 örnek uzun Türkçe makale biçimini sağlam öğretmeye yetmedi. Yazı modeli Gemma'da kaldı.
  - Sonraki deneme için: 2-3 devir, rank 32-64, daha çok yazı/meta örneği (toplanan kaynaklardan Gemma ile hedef üretip SEO kurallarıyla ayıklama: `tools\data\generate-targets.mjs`), meta uzunluk kurallarını hedefte zorlamak.
- Eğitilen HF klasörü `training\models\<kimlik>\hf` kalır (yeniden eğitimde temel); liste `training\models\record.json`. Hazır temeller `training\hf\` önbelleğine iner.
- **14B, 12 GB'ta (ölçüldü 05.10.2026):** yükleme 6,8 GB (giriş embedding'i RAM'de, çıktı katmanı 4-bit), LoRA r16 64M parametre, 8-bit Adam.
  - Windows torch derlemesinde flash attention yok: transformers'ın GQA'lı SDPA çağrısı matematik yoluna düşüyordu (4096 belirteçte dikkat +10 GB). `attention_patch()` kafaları çoğaltır → bellek dostu çekirdek (0,3 GB). 2048'de 160 → 477 belirteç/sn.
  - `prepare_model_for_kbit_training` kullanılmaz: bf16 embedding/çıktı katmanını fp32'ye büyütüyor (+6 GB).
  - Kayıp, çıktı katmanında 512'lik parçalarla (yeniden hesaplamalı); 151 bin sözlükte logitler tek parça ~1,2 GB tutuyordu.
  - Bağlam 4096 üstünde: checkpoint ara değerleri RAM'e (`save_on_cpu`), MLP dizi boyunca 2048'lik parçalarla. 8192: tepe 9,6 GB, 276 belirteç/sn. 12288 taşıyor (ayrılan bellek parçalanıyor; Windows'ta `expandable_segments` yok).
  - Taşınca Windows hata vermez, belleği sistem RAM'ine taşır ve hız 10-20 kat düşer: adım süresi ve `peakVramGb` ile izle. Eğitim sırasında RAM de dolar (15,6 GB'ın 0,3'ü boş); yanında ağır iş çalıştırma.
- **İstem kısaltma:** her istekte birebir giden uzun sabit metinler (bot kılavuzları) eğitim verisinde `[[işaret]]` ile değiştirilir; eşleme dosyası (`*abbreviations.json`, `{"[[işaret]]": "tam metin"}`) veriyle yüklenir ve modelin klasörüne gider. Etkin yazı modeli panelde eğitilmişse panel `/llm/v1` isteklerinde aynı değişimi yapar; uzunluk notunu eklemez, düşünmeyi kapatır, bölümlü akışı atlar (model tek çağrıda yazar). nedese özgün yazı istemi 10,7 → 6,6 bin belirteç.
- 12 GB'ta 26B yazı modeli eğitilemez (Unsloth: 26B-A4B LoRA > 40 GB); çok kipli modeller (Gemma 4 E4B, Qwen3.5) bu yolda yok. Eğitim süresince ekran kartı bu işte: yazı modeline gelen istekler (botlar dahil) iş bitene kadar bekler, uzun eğitimde zaman aşımına uğrayıp DeepSeek'e düşer.
- transformers 5: `LlamaTokenizer(vocab_file=…)` artık SentencePiece okumuyor; sözlük `SentencePieceExtractor` ile hızlı tokenizer'a çevrilir. Baştaki boşluk işareti (`add_dummy_prefix`) kapalı: eğitimdeki ve llama.cpp'deki bölme birebir aynı.

### Görsel LoRA eğitimi (Eğitim > Alan: Görsel; `training\image.py`, ayrı ortam `training\musubi\.venv`)

- Araç: **musubi-tuner** (kohya-ss, sabit commit `f8a1b03`, kaynak `training\musubi`; FLUX.2 klein, Qwen-Image, Wan 2.2 LoRA eğitimini destekler). Python 3.12.14, torch 2.11 cu128; setup.ps1 kurar.
- Model: **FLUX.2 [klein] 4B** (Apache 2.0). Eğitim, musubi'nin önerdiği damıtılmamış **base 4B** üzerinde yapılır (`training\bases\flux2-klein-base-4b`, 7,2 GB) + Qwen3 4B metin kodlayıcı (`bases\flux2-klein-4b\text_encoder`, 7,5 GB); ilk eğitimde kendiliğinden iner. LoRA, ComfyUI'deki 4 adımlık fp8 klein ile kullanılır (denendi: yüklenir, görüntüyü bozmaz).
- VAE: musubi özgün BFL adlandırmasını ister; ComfyUI'nin `flux2-vae.safetensors`'u diffusers adlandırmalı ve özgün `ae.safetensors` onaylı FLUX.2-dev deposunda. `training\vae_convert.py` bir kez çevirir (`bases\flux2-ae\ae.safetensors`; 251 tensör, katı yükleme, geri kodlama 41,1 dB PSNR).
- Akış: görseller (PNG/JPEG/WebP, .zip) + aynı adlı .txt altyazılar (yoksa "tetik, genel açıklama") → uzun kenar en çok 2048, en kısa 256 → gizli değerler ve altyazılar önbelleğe (VAE bf16, Qwen3 fp8) → eğitim (fp8 base + fp8 scaled, gradyan checkpoint, AdamW 8-bit, lr 1e-4, rank 16, flux2_shift) → LoRA `models\loras\<ad>-<iş>.safetensors` → kayıt → ComfyUI'de aynı istemle LoRA'sız/LoRA'lı örnek görsel.
- **Ölçüldü (05.10.2026, RTX 5070, 1024 px):** tepe 7,3 GB VRAM, ~5 sn/adım, 40 adımlık deneme model yükleme dahil 3,5 dk; uçtan uca iş (hazırlama + eğitim + ComfyUI örnekleri) 5 dk. Varsayılan adım görsel başına ~60 (400-2000): 20 görsel ~1.200 adım ~1,7 saat. LoRA rank 16 = 88 MB.
- Kayıt noktası her ~%10'da (musubi `--save_state`); duraklatılan/yarıda kalan iş son kayıttan kalan adımlarla sürer. Var olan LoRA "Bununla geliştir" ile yeni görsellerle eğitilir (`--network_weights`).
- Kullanım: Görsel sekmesi > İnce ayarlar > Model FLUX.2 klein > **LoRA** (ve gücü). Tetik kelime isteme kendiliğinden eklenir. API: `type: "image", model: "flux", lora: "<file>"`.

### Müzik LoRA eğitimi (Eğitim > Alan: Müzik; `training\music.py`, ayrı ortam `training\sidestep\.venv`)

- Araç: **Side-Step** (koda-dernet, MIT, sabit commit `fc80093`, kaynak `training\sidestep`; ACE-Step 1.5 belgelerinin önerdiği komut satırı eğiticisi). Deposunda `uv.lock` yok; bu makinede çalışan çözüm `setup\lock\sidestep-uv.lock`, setup.ps1 kaynağa kopyalayıp onunla birebir kurar (Python 3.11.16, torch 2.7.1 cu128). Not: proje "kullanımdan kalkıyor" dedi (1 Mart 2027'de salt okunur arşiv; yerine sıfırdan yazılan bir halef geliyor); sabit commit'te çalışır, halef çıkınca geçiş değerlendirilir.
- Model: eğitim **ACE-Step 1.5 base** üzerinde yapılır (`training\bases\acestep`: base DiT 4,5 GB + Qwen3-Embedding 0.6B + VAE ~1,4 GB; ilk eğitimde kendiliğinden iner). LoRA ComfyUI biçimine aktarılır (`--target native`, alfa = rank) ve Müzik üretiminde **ACE-Step 1.5 turbo** ile kullanılır (denendi: anahtarlar yüklenir, aynı tohumla çıktı değişir).
- Akış: şarkılar (WAV/MP3/FLAC/OGG/OPUS/M4A, .zip) + aynı adlı `.txt` (ya da `.lyrics.txt`) sözler, `.caption.txt` tarif (formdaki tarz tarifi başına eklenir: koleksiyondan gelen tarif çoğu kez yalnız "Şarkı by Sanatçı"; tarif yoksa yalnız tarz tarifi) → `dataset.json` (ACE-Step biçimi, tetik kelime tarifin başına) → ön işleme (VAE + metin kodlayıcı, iki geçiş, tepe normalleştirme, şarkının ilk 240 sn'si) → eğitim (LoRA rank 32 varsayılan, alfa 2×rank, lr 1e-4, AdamW 8-bit, gradyan checkpoint, kodlayıcı CPU'da) → `models\loras\<ad>-<iş>.safetensors` → kayıt → ComfyUI'de aynı tohumla LoRA'sız/LoRA'lı 30 sn'lik örnek şarkı.
- Devir (varsayılan, ACE-Step rehberi): ≤20 şarkı 800, ≤100 şarkı 500, daha çok 300. Kayıt noktası her ~%10'da (`training\checkpoints\epoch_N`, iyileştirici + zamanlayıcı + rastgelelik); duraklatılan/yarıda kalan iş son kayıttan sürer, kayıp listesi (`losses.json`) korunur. Var olan müzik LoRA'sı "Bununla geliştir" ile yeni şarkılarla eğitilir.
- **Ölçüldü (05.10.2026, RTX 5070 12 GB):**
  - 30 sn'lik 4 şarkı, rank 16: devir 1,3 sn, tepe 5,8 GB VRAM; 60 devir + ön işleme + örnek şarkılar, uçtan uca panel işi 4 dk. LoRA 39 MB.
  - 3 dk'lık şarkı, rank 32: şarkı başına devir ~0,9 sn, tepe 6,8 GB VRAM. LoRA 78 MB. Buna göre 3 dakikalık 10 şarkı × 800 devir ~2 saat, 20 şarkı ~4 saat.
  - Duraklat → devam denendi: devir 25'te duraklatıldı, devir 20 kaydından aynı ayarlarla sürdü.
- Kullanım: Müzik sekmesi > **LoRA (burada eğitilmiş)** (ve gücü 0,6-1,2). Tetik kelime tarzın başına kendiliğinden eklenir. API: `type: "music", lora: "<file>", loraStrength: 1`.
- **ACE-Step karar (05.10.2026):** üretimde turbo kaldı; XL turbo ile audiobox-aesthetics ve Whisper söz doğruluğu karşılaştırması `data\quality\ace-step-decision.json`.
- **"Caz" LoRA'sı ölçüldü (06.10.2026):** 30 Commons kaydı, 500 devir, 3 sa 7 dk; kayıp 0,71 (40 devir) → 0,57.
  - Yöntem: caz ve EDM tarzı, 2 tohum, 30 sn. Koşullar: LoRA'sız, yalnız tetik kelime (LoRA gücü 0), 40 devir, 500 devir.
  - CLAP (eğitim kayıtlarının ortalamasına benzerlik) ve audiobox-aesthetics ile ölçüldü.
  - Güç 1'de etkinin neredeyse tamamı tetik kelimeden geliyor: LoRA ağırlıkları benzerliği tetik kelimenin üstüne ortalama +0,005 artırdı; 500 devir 40 devirden ayırt edilemedi.
  - Güç 2'de ölçülebilir: ortalama +0,033 (+0,009 … +0,043); yapım kalitesi (PQ ~8) ve keyif (CE) düşmedi.
  - Kayda `recommendedStrength: 2` yazıldı: Müzik formu bu LoRA seçilince gücü 2 yapar; API'de güç verilmezse kayıttaki öneri kullanılır. Formdaki güç seçenekleri 2'ye kadar.

### Video LoRA eğitimi (Eğitim > Alan: Video; ComfyUI'nin yerleşik eğitim düğümleri)

- Ayrı ortam ya da indirme yok: kurulu **Wan 2.2 TI2V 5B** (`wan2.2_ti2v_5B_fp16`, fp8 yüklenir), umt5 fp8 metin kodlayıcı ve Wan 2.2 VAE ile ComfyUI içinde eğitilir (`TrainLoraNode`, `MakeTrainingDataset` / `SaveTrainingDataset`; ComfyUI 2026-09). musubi-tuner 5B'yi desteklemiyor; A14B (panelin 4 adımlık video modeli) uzman başına 28 GB fp16 dosya ve 14 GB üstü RAM ister, bu makinede (16 GB RAM, 15 GB boş disk) eğitilemez.
- Akış (`panel\lib\jobs\training.mjs runVideo`): klipler/görseller (+ aynı adlı .txt altyazı, .zip) → ffmpeg: 24 fps, yönüne göre sabit boyut (480p: 832×480 / 480×832 / 640×640; 320p: 576×320 …), sabit uzunluk (17/33/49 kare; uzun klipten eşit aralıklı en çok 4 parça, kısa klip son kareyle tamamlanır, görsel tek kare; telefon videosunun dönme bilgisi okunur), altyazının başında tetik kelime → ComfyUI input'a yüklenir → veri seti (Wan VAE + T5) diske (`ComfyUI\datasets\aipanel\<iş>`, bir kez) → `/free` → eğitim 150 adımlık dilimlerle (fp8 5B, bypass LoRA, blok başına gradyan checkpoint, AdamW lr 1e-4, rank 16) → `models\loras\<ad>-<iş>.safetensors` → kayıt → aynı kareden LoRA'sız/LoRA'lı 49 karelik örnek video. Bitince ComfyUI'deki ara dosyalar silinir.
- Bu kartta çalışması için iki ayar şart (ölçüldü): gradyan checkpoint derinliği 2 (1 tüm modeli tek parça sarar: 17,4 GB, taşar) ve bypass modu (ağırlığa yamalı LoRA 17,7 GB'a çıkar; ileri kancayla 8,4 GB).
- **Duraklat / devam:** her dilim LoRA'yı `<ad>-interim_<adım>_steps_.safetensors` olarak kaydeder (`TrainLoraNode` önceki adım sayısını dosya adından okur); duraklatılan ya da yarıda kalan iş son biten dilimden sürer, veri seti yeniden kodlanmaz. Dilim içindeki adımlar ve AdamW durumu baştan alınır (en çok ~150 adım tekrar).
- **Ölçüldü (05.10.2026, RTX 5070):** 480p 33 kare rank 16: 3,4 sn/adım, tepe 8,4 GB VRAM (1000 adım ~1 saat); 320p 17 kare: ~0,9 sn/adım. Varsayılan adım örnek başına 100 (300-2000). 10 adımlık LoRA bile çıktıyı değiştiriyor (aynı tohumla 16. karede ~11/255, 32. karede ~24/255 ortalama fark); 0 "lora key not loaded".
- **"Sessiz film" ölçüldü (06.10.2026):** 75 klip; 600 adım (34 dk) ve 2000 adım (1 sa 49 dk).
  - Yöntem: Wan 5B 480p, 2 başlangıç karesi × 2 tohum; koşullar: yalnız tetik kelime (güç 0), 600 adım, 2000 adım.
  - Eğitim kliplerine DINOv2 benzerliği 0,372 / 0,359 / 0,388; renk doygunluğu 0,439 / 0,448 / 0,379 (klipler 0,132, siyah-beyaz).
  - Karar: 2000 adımlık "Sessiz film" kullanılır. 600 adımlık tetik kelime tabanını geçmedi; kayıtta "Sessiz film (600 adım)" olarak ayrıldı.
- Kullanım: Video sekmesi > İnce ayarlar > Model **Wan 2.2 5B** > **LoRA** (ve gücü). Tetik kelime (İngilizceye çevrilmiş) isteme kendiliğinden eklenir. API: `type: "video", model: "wan5", lora: "<file>"`.

### Genel model eğitimi (Eğitim > Alan: Genel; `training\general.py`, eğitim ortamı `training\.venv`)

- Görsel ve metni birlikte anlayan tek model: **Qwen3.5** (Apache 2.0; 4B önerilen ~9 GB, 2B hızlı ~5 GB; ilk eğitimde `training\hf`'e iner). QLoRA: dil modeli 4-bit + LoRA (tam dikkat, Gated DeltaNet ve MLP katmanları), görsel kodlayıcı bf16 donuk. Eğitim döngüsü, kayıt noktası (duraklat/devam), akıtmalı birleştirme ve GGUF adımı `train.py` ile ortak.
- Veri: görsel + aynı adlı `.txt` (o görselin yanıtı: betim, etiket, istenen cevap; soru formdaki "Görsel sorusu", varsayılan "Bu görseli ayrıntılı betimle."), görselli sohbet JSONL (`{"messages": [...], "images": [...]}`, içerikte `{"type": "image"}` ya da `<image>`; ya da `{"image", "prompt", "response"}`), yazı modelindeki metin/soru-cevap biçimleri ve bunları içeren `.zip`. Görsel başına ~256 belirteç (262.144 piksel).
- Sonuç: `llm\models\<ad>-training-<iş>-q4_k_m.gguf` + görsel kodlayıcı `mmproj-<aynı ad>` (f16). Ayarlar > Yazı modeli listesinde "görsel anlar"; seçilince llama-server `--mmproj` ile açılır, `/llm/v1/chat/completions` isteğinde `image_url` (data URL) parçası okunur. Panelde eğitilmiş modelin istem kısaltmaları görselli istekte yalnız metin parçalarına uygulanır.
- **Ölçüldü (05.10.2026, RTX 5070, 4B):** 19 örnek (16 görsel + 3 soru-cevap) 3 devir 56-62 sn, tepe 5,8 GB VRAM; panel işi uçtan uca 4 dk (birleştirme + mmproj 0,63 GB + Q4_K_M 2,59 GB). llama.cpp ile denendi: eğitimde görmediği turuncu daireyi öğrendiği biçimde doğru betimledi ("… tek bir turuncu daire var. Şekil: daire. Renk: turuncu."), genel bilgi korundu. 3 soru-cevapla olgu öğrenilmez (biçimi alır, içeriği uydurur): olgu için çok sayıda örnek gerekir.
- Bilinen: Qwen3.5'in hızlı DeltaNet çekirdekleri (flash-linear-attention, triton) Windows ortamında yok; torch yolu küçük veride yeterli hızda. Eğitim ortamına `pillow` ve `torchvision 0.26 cu128` eklendi (kilit `setup\lock\training.txt`).

## Veri (`data\`, git dışı) ve veri toplama

Veri toplama ve görsel betimleme Nedese Studio'nun içinde (Eğitim sekmesi). 06.10.2026'da denenen ayrı "Veri Paneli" projesi kullanıcı kararıyla iptal edildi; kodu depo dışında arşivde (geliştirme makinesinde `eski\veri-paneli`). Oradaki bütün motor düzeltmeleri bu panelde de var.

### Veri toplama süzgeçleri ve ölçümleri (06.10.2026)

- **Yetişkin / kumar / bahis** siteleri ve CDN'leri hiçbir yoldan alınmaz: aday, siteden siteye, sayfa, gömülü medya (`isUnsuitable`). 20 dk denemesinde Bing'in magazin kayması üzerinden bu sitelere gidilmişti; kayıtlar `data\quarantine\`'da.
- **Arama sonucu ön süzgeci (kayma imzası):** konuya bağlı sorgunun sonucu, başlık + özette konunun hiçbir sözcüğü yoksa ve sorgunun %40'ından azı geçiyorsa gezilmez. Gerçek sonuçlarda 276'dan 21'i elendi, hepsi kayma (Bing "Ünlü …" → magazin / borsa). Sorguyla hiç ortak sözcüğü olmayan sonuç ve başka dildeki sorgu yargılanmaz.
- **Kural kipinde odaklı konu uyumu:** konu sözcükleri başlık + girişte (ilk 300 sözcük) ya da metne yayılmış olmalı (her biri en az 2 kez, her 1.500 sözcükte bir). Önceden uzun bir maddede bir kez geçmesi yetiyordu ("Anıtkabir", "Kur'an" girdi).
- **Arama motorları (bu bağlantıdan):** Bing RSS yabancı pazarda boş kanal döndürüyor, parametresiz Türkiye pazarına kayıyor. DuckDuckGo 202, Yahoo 500, Mojeek CAPTCHA (aşılmaz). Vikipedi arama API'si motor olarak eklendi (`wiki`, sorgunun dilinde).
- **Google Haberler** bağlantısı yayıncıya HTTP ile yönlenmiyor (~600 KB JavaScript sayfası); sayfadaki imza + `batchexecute` "garturlreq" ile yayıncı adresine çözülür (~0,4 sn). Önceden bu adayların hiçbiri yazıya dönüşmüyordu.
- **Siteden siteye:** istenmeyen dillerdeki viki sürümleri ve Commons dışı Wikimedia alt alanları atlanmaz; Vikipedi gibi dev sitede arama sonrası ana sayfa keşfi yok.
- **PDF kilitlenmesi (düzeltildi):** metin ayrıştırıcısı yazı tipi genişlik dizisinde üstel geri izliyordu (12 sayı 335 ms, her 2 sayıda ~16 kat); akış başı deseni `endstream`in sonunu da yakalıyordu. Test eski kodda zaman aşımıyla düşüyor.
- JSON-LD başlıklarındaki HTML varlıkları çözülür ("UNESCO&#039;ya" kaydediliyordu).

12 dk karşılaştırma ("Osmanlı minyatürleri", kural ayıklama, yalnız meta, tr+en; "konulu" başlıklara bakılarak elle sayıldı):

| Koşu | Yazı | Konulu | Not |
|---|---|---|---|
| Süzgeçler | 12 | ~6 | 11,5 dk'da site sırası bitti |
| + Vikipedi, dil süzgeci, PDF düzeltmesi | 80 | ~27 | uzun maddeler konu dışıyken giriyordu |
| + odaklı kural | 34 | ~23 | |
| + Google Haberler çözümü | 75 | ~55 | 45 farklı site (önce 9) |

- Aramadan gelen adayların ~%35'i, siteden siteye atlamadan gelenlerin ~%4'ü yazıya dönüşüyor.
- Denendi, geri alındı: kural kipinde bağlantı metninde konu sözcüğü geçen dış siteye öncelik. Atlama kabulü 12/~308'den 8/~487'ye düştü; "Osmanlı" gibi genel sözcük genel tarih sitelerini öne aldı.

- `data\`: kendi modellerimiz için saklanan veri (silme). nedese eğitim verisi, kaynak siteler, karşılaştırmalar; içeriği `data\README.md`. Üreten betikler `tools\data\`.
- Panelde Eğitim > **Veri toplama** (API `type: "data"`; kod `panel\lib\jobs\data.mjs`, yardımcılar `data-collection.mjs`, tarayıcı `browser.mjs`, belgeler `read-document.mjs`; bağımlılıksız). İki kip, birlikte de çalışır:
  - **Konu** (otomatik keşif): yerel model arama sorguları üretir (yoksa kalıplar) → Bing RSS, DuckDuckGo HTML, Google Haberler RSS, Vikipedi arama API'si (sorgunun dilinde; anahtar gerekmez) → aday sayfalar → aynı siteden 2+ iyi yazı çıkınca besleme / site haritası (robots.txt `Sitemap`) / WordPress API keşfi ve site içi gezinme; `target` sayıya ulaşınca durur.
  - **Kaynaklar**: site ana sayfası, RSS/Atom, OPML (akış listesi), site haritası (dizin dahil), `/wp-json` (WordPress REST: içerik + Yoast meta + kategori/etiket tek istekte), sayfa, PDF/DOCX/PPTX/XLSX linki, `cc:alanadi` (Common Crawl: CDX dizini + WARC aralığı; canlı siteye yük yok).
  - **Wikimedia Commons** (`commons:Category:Ad` ya da `commons:arama sözcükleri`): API'den lisanslı medya, açıklaması, lisansı ve yazarıyla. Metin filtresi uygulanmaz.
    - Görsel 1280 px küçültülmüş sürüm (TIFF taraması JPEG gelir), video 480p'ye en yakın webm/mp4 türevi, ses asıl dosya (büyük FLAC/WAV'da mp3/ogg türevi).
    - Alt kategoriler `depth` kadar izlenir; kaynak başına en çok `max` dosya. `media: download` ve gerekirse `mediaMaxMb` (video için 80+) ile kullanılır.
    - API'ye aracı tanıtan User-Agent gider (Wikimedia kuralı).
  - Site içi gezinme: iç linkler adres kalıbından **yazı / liste-kategori / statik / belge / medya** diye sınıflanır; liste sayfaları `depth` kadar izlenir, statikler (hakkımızda, giriş, sepet…) hiç istenmez; `sitePerPage` sınırı.
  - **Siteden siteye** (`hopSites`, konu kipinde varsayılan açık): kabul edilen (konuya uyan) sayfalardaki dış bağlantıların siteleri kuyruğa girer.
    - Sosyal ağ, arama, mağaza, kısaltıcı, reklam ve gömülü video platformları girmez.
    - En çok bağlanan site önce gezilir (keşif: akış, site haritası, WordPress API, site içi gezinme). İlk 8 adayında konuya uyan yazı çıkmayan site bırakılır.
    - Kuyruk `site-queue.json`'da durur. Duraklatılan iş, yarıda kalan siteyle birlikte kaldığı yerden sürer.
    - Atlanan sitede önce bağlanan sayfalar okunur (ilk 3'te konuya uyan yoksa site bırakılır). Konuya uyan çıkarsa site geniş keşfedilir. Wikipedia, Commons, arşiv gibi dev genel sitelerde yalnız bağlanan sayfalar alınır.
    - Model (`extract: model`) kabul edilen her sayfadaki dış bağlantılardan konuya uygun olanları seçer: sayfa başına tek çağrı, en çok 8 bağlantı.
    - **Site içi arama:** atlanan ya da verimli bulunan sitede önce arama motoruna `site:<site> <ayırt edici sözcük>` sorulur.
      - Sözcük konunun en uzun sözcüğüdür, Türkçe çoğul eki atılır: "Osmanlı minyatürleri" için `minyatür`. Konunun tamamıyla Bing genel sonuçlara kayıyordu.
      - Bulunan konu sayfaları bağlı sayfalardan önce işlenir; bunların iç bağlantıları site içi gezinmenin başına geçer.
      - DuckDuckGo bot sorgusunu engellediği için ilk genel motor (Bing) kullanılır. Site başına bir kez sorulur.
      - Neden: TDV İslâm Ansiklopedisi'nde ana sayfa rastgele maddelere bağlanıyordu. 91 sayfa gezildi, "Minyatür" maddesine hiç ulaşılamadı (05.10.2026).
    - Site içi gezinmede adresinde ya da bağlantı metninde konu kökü geçen bağlantı öne alınır (TDV'de "ilişkili maddeler", Şükûfe, Âhar). Konu kipinde 60 sayfada hiç yazı çıkmazsa gezinme bırakılır.
  - **Yönetici** (`manager`, varsayılan açık; model ve konu gerekir): yerel model ~8 dakikada bir taramanın özetine bakar.
    - Özette şunlar var: toplananlar, son yazılar, verimli ve boş çıkan siteler, sıradaki siteler, kullanılmış sorgular.
    - Model bunlara göre siteleri öne alır ya da bırakır, yeni arama sorguları önerir.
    - Sıra boşalınca yeni yön ister; üst üste 3 turda yeni bir şey çıkmazsa iş biter. Hafızası `site-queue.json`'da durur.
  - **Sınırsız** (`target: 0`): iş, durdurulana ya da `durationMin` dolana kadar toplar. Panel kapanıp açılırsa (çökme ya da düzgün kapanış) iş "yarıda" kalmaz: sıra boşalınca kendiliğinden sürer.
    - Sıra kuralları:
      - Sonu belli işler (eğitim, görsel, sonu belli toplama) sınırsız toplamadan önce çalışır.
      - Sınırsız toplama, yeni gelen ya da "Devam ettir" denen sonu belli işe sırayı bırakır.
      - İptal edilen iş geri gelmez. Sıra bırakmış (duraklatılmış) iş iptal edilebilir.
      - Son işleme aşamasındaki iş sırayı bırakmaz.
    - Sürdürmede kaldığı yerden devam eder:
      - Hedef ve süre sayaçları korunur (`dataProgress`).
      - Denenmiş sayfalar (`tried.txt`) yeniden indirilmez.
      - Havuzda kalan medya "bekliyor" kaydıyla yeniden sıraya girer.
      - Site kuyruğu ve yönetici hafızası `site-queue.json`'da (atomik yazılır, bozuksa `.bak`'tan okunur).
    - Veri toplama **yol veren** iştir (`yields`): çalışırken başka bir iş eklenirse kendini duraklatır ("Sıra bırakıldı"). Sıra boşalınca kaldığı yerden kendiliğinden sürer.
    - Tek sıra kuralı bozulmaz; elle duraklatılan iş kendiliğinden sürmez.
  - **Medya** (`media: download`; arayüzde varsayılan): yazı olarak alınmayan sayfaların da medyası alınır ("ne bulursa"): galeri, video sayfası, kısa, konu dışı, düşük puanlı ya da başka dilde sayfa. Kopya sayfa hariç.
    - Görselin büyük sürümü `srcset` adaylarının en genişinden alınır. Alt metni olmayan görsel de alınır; logo, simge ve avatar adresleri alınmaz. Sayfa başına en çok 50 görsel.
    - Konu kipinde Wikimedia Commons'ta da aranır (konu + ilk İngilizce sorgu).
    - Toplam kota yok (`mediaTotalGb: 0`): diskte 10 GB boş kalınca medya indirme durur, yazılar sürer. Dosya başına `mediaMaxMb` (varsayılan 300).
    - robots.txt ve `noai` / `noimageai` yasakları yine sayılır.
  - Sayfa işleme: JSON-LD (Article, FAQPage, HowTo, VideoObject…), Open Graph, meta (SEO başlık/açıklama, tarih, yazar, etiketler, bölüm, kanonik), hreflang alternatifleri → **çeviri çiftleri**, HTML → Markdown blokları (bağlantı yoğun bloklar atılır; numaralı liste, kod, alıntı korunur), kural ayıklama = en yoğun içerik bölgesi, dil tahmini (yazı sistemi + durak kelimeler), kategori (bölüm > ekmek kırıntısı > adres), SSS soru-cevapları, görsel/video/ses meta verisi (`media: meta|download|none`; indirmede dosya ve toplam sınırı).
  - Yerel modelle etiketleme (`extract: model`): asıl içerik blokları, dil, konu, **kategori** (sabit liste), **içerik türü**, etiketler, tek cümle özet, **kalite** ve **doğruluk** (1-5), konu uyumu. Eşikler: `minWord`, `minQuality`, `minAccuracy`, `minFit`. `rule` seçilirse model hiç kullanılmaz (Gopher/C4 benzeri kalite kuralları yine çalışır).
  - Temizlik: tam kopya (başlık hariç gövde özeti) ve **yakın kopya** (64 bit simhash, ≤3 bit) atlanır; e-posta/telefon/IBAN/TC kimlik maskelenir; `<meta name=robots content=noai>` ve TDM rezervasyonu sayılır (`noimageai` görselleri kapatır).
  - Tarayıcı: betik ağır (tek sayfa uygulaması) sayfalar ya da bot koruması (403/429) görülünce bu bilgisayardaki Edge/Chrome başlıksız açılır (DevTools protokolü, GPU kapalı): çerez bildirimi kapatılır, sayfa sonuna kaydırılır (tembel yükleme), gerekirse `agent` kipinde model numaralı etkileşim öğelerinden birine tıklatır (devamını oku, sekme); adım ekran görüntüleri işin çıktısı olur (`screen\*.jpg`). `browser: automatic|always|agent|closed`.
  - **Hızı kendi bulur:** site başına istek arası öğrenilir.
    - 429/503'te aralık iki katına çıkar (2-60 sn) ve sunucunun istediği süre (Retry-After) beklenir; 20 başarılı istekte %15 kısalır.
    - `RateLimit-Remaining` / `-Reset` başlıkları okunur: hak bitince sıfırlanma zamanı beklenir.
    - Wikimedia sunucularına araç kendi adıyla gider: tarayıcı kılığına 429 ve "600 sn bekle" dönüyordu.
  - **Eşzamanlı medya:** indirmeler arka plandaki havuzda (aynı anda 8, site başına sıra korunur). Tarama sayfayı beklemeden sürer; havuzda 400'den çok iş birikirse yavaşlar.
    - Hız sınırı ya da ağ hatasıyla inmeyen dosya kaydedilmez, sonraki çalıştırmada yeniden denenir. İş sonunda medya kayıtları tekilleşir.
    - Tüm metni bile kısa olan ya da konunun hiçbir sözcüğünü içermeyen sayfa yerel modele gönderilmez (model tek kanal, sayfa başına 10-20 sn); medyası yine alınır.
  - Dayanıklılık: site başına sıralı istek ve ≥1 sn aralık (Crawl-delay), 429/5xx/ağ hatasında siteye özel üstel bekleme (en çok 90 sn, `Retry-After`), art arda 5 hatada 10 dk dinlenme, gecici hatada 2 yeniden deneme, 6 MB gövde sınırı (sayaçlı akış), HTML/XML/JSON/belge dışı içerik atlanır, özel ağ / döngü / Tailscale adresleri ve oraya yönlendirmeler reddedilir (SSRF). Siteler arasında paralel (`parallel`, varsayılan 4).
  - Zaman: `durationMin` bütçesi (dolunca eldekiler kaydedilir; son %20'de yeni keşif yok), ilerlemede yazı/dk ve tahmini kalan süre. İş duraklatılabilir; aynı adla yeniden çalıştırınca kaldığı yerden ekler (`onlyNew` yalnız son güncellemeden sonrakiler).
  - Çıktı `data\collected\<koleksiyon>\`: `articles.jsonl` (ham kayıt: metin, meta, etiketler, puanlar), `images/videos/voices.jsonl`, `media\`, eğitime hazır sohbet dosyaları `training-meta` (içerik → meta başlık/açıklama), `training-translation` (hreflang çiftleri, iki yön), `training-write` (başlık → yazı), `training-summary`, `training-title`, `training-question` (SSS/HowTo), `training-classification` (metin → kategori/tür/etiket), `training-image` (görsel ↔ altyazı), `summary.json` (diller, kategoriler, kaynaklar, istatistik). Eğitimde `collection/<kimlik>` (ham) ya da `collection/<kimlik>/training-meta` gibi seçilir.
  - İndirilen medya da eğitim verisidir: `collection/<kimlik>/images` (görsel LoRA, genel model, video), `.../videos` (video LoRA), `.../voices` (müzik LoRA).
    - Medya iş klasörüne sert bağlantıyla (yer kaplamadan) hazırlanır; altyazı aynı adlı `.txt` olur (görselde altyazı/alt metin, video ve seste açıklama ya da başlık; seste tarif `.caption.txt`).
    - Altyazı temizlenir (`data-collection.mjs cleanCaption / mergeCaptions`). Commons HTML'inin gizli öğeleri (`display:none` Wikidata `label QS:` satırları, "İngilizce:" dil etiketi) toplamada atılır. Eski kayıtlarda bu kalıntı eğitimde kesilir. Atılanlar:
      - lisans/izin cümleleri ("public domain", "Photography was permitted"; lisans ayrı alanda durur),
      - adresler, kamera dosya adları (DSC04222), alt çizgiler.
    - Açıklama esastır. Başlık (dosya adı) yalnız 3+ yeni sözcük katıyorsa girer: açıklama yalnız yer bilgisiyse ("Exhibit in the … Museum") başlık seçilir, ikisi de bilgi katıyorsa ikisi birlikte yazılır. "Dosya 1" gibi genel adlar sayılmaz.
    - Hazırlıktan sonra bu klasör silinir. Arayüz alanına uygun seçenekleri, indirilen dosya sayısıyla gösterir. Genel modelde `training-image` de kullanılabilir.
  - **Görsel betimleme** (`panel\lib\jobs\describe.mjs`, iş türü `describe`): Eğitim > Toplanan koleksiyonlar > "Görselleri betimle".
    - Yazı modeli (mmproj'li Gemma) indirilen görselleri Türkçe (ya da İngilizce) betimler. Kaynak altyazı ipucu olarak verilir, görselde olmayanı yazmaması istenir.
    - Görsel en çok 896 px JPEG olarak gider; kodlayıcı CPU'da.
    - Sonuç `captions.jsonl` (`file, caption, lang, model, hint, topic?, fit?`). Kaldığı yerden sürer, art arda 5 yanıtsızlıkta durur.
    - **Konu denetimi:** koleksiyonun konusu varsa (`summary.json`) aynı çağrıda görselin konuya uyup uymadığı sorulur (yanıtın ilk satırı UYGUN / UYGUN DEĞİL). Uymayan betimlenir ama eğitime girmez (`fit: false`); koleksiyon "ne bulursa" toplamaya devam eder. `topicCheck: false` ile kapanır.
    - Eğitimde `collection/<kimlik>/captions` = "model betimlemeli görseller" (görsel LoRA, genel model).
    - Neden: Commons altyazıları çoğu kez katalog başlığı (medyan 14 sözcük). Bunlarla eğitilen genel model betimlemek yerine başlık uyduruyordu ("Battle of Mohács (1526)").
  - Testler `panel\test\data.test.mjs`: sahte site (robots, kopya, hreflang, JSON-LD/SSS, WP API, gezinme, PDF, 429 sonrası devam), sahte arama motoru (`dataSearchTemplate` ayarı), sahte model. Testlerde `dataPrivateNetworkAllowed`, `dataMinDelayMs`, `browserPath: null`.

## Modeller (`models\`)

| Model | İş | Lisans |
|---|---|---|
| Qwen-Image-2512 20B (GGUF Q4_K_M, unsloth) + lightx2v Lightning 8 adım | Görsel, en güçlü (~65 sn) | Apache 2.0 |
| FLUX.2 klein 4B fp8 + Qwen3 4B fp4 | Görsel, çok hızlı (~8 sn); yazıda zayıf | Apache 2.0 |
| Wan 2.2 I2V A14B, lightx2v 720p damıtılmış 4 adım (GGUF Q5_K_M, 2 uzman; jayn7) | Kareden video, 16 fps | Apache 2.0 |
| Wan 2.2 TI2V 5B | Hafif video, 24 fps | Apache 2.0 |
| RIFE 4.9 (ComfyUI-Frame-Interpolation) | Ara kare: 16 → 48 fps | MIT |
| Chatterbox Multilingual (voice\hf) | Türkçe seslendirme | MIT |
| Whisper large-v3 | Döküm | MIT |
| Qwen3-TTS VoiceDesign 1.7B (`models\voice\`) | Tariften ses tasarımı (10 dil, Türkçe yok) | Apache 2.0 |
| Qwen3-TTS Base 1.7B (`models\voice\`) | Aynı sesi sürdürme (ICL klon) | Apache 2.0 |
| UTMOS22 strong (`voice\torch_hub`) | Doğallık puanı (çekim seçimi) | MIT |
| TRELLIS.2 int8 + DINOv3 L + BiRefNet (ComfyUI yerleşik) | Görselden dokulu 3D model (GLB) | MIT |

## Kurulum notları

- ComfyUI taşınabilir (Python 3.13, PyTorch 2.13 CUDA 13); eklentiler: ComfyUI-GGUF, ComfyUI-Frame-Interpolation.
- **Üçüncü taraf kod depoda** (08.10.2026, sürüm kayması olmasın diye): `setup\vendor\<ad>` — ComfyUI-GGUF,
  ComfyUI-Frame-Interpolation, LatentSync, musubi-tuner, Side-Step, YingMusic-SVC, llama.cpp GGUF dönüştürücüsü. Her klasörde `SOURCE.txt`
  (köken, commit, lisans, çıkarılan tanıtım medyası). `setup.ps1` `Copy-Vendor` ile hedefe kopyalar (`.setup-source` işareti
  SOURCE.txt özeti; değişince yeniden kopyalar, hedefteki ortam/çıktı/ağırlık dosyaları korunur; LatentSync kopyalanınca yama da
  yeniden uygulanır). Güncellemek için: klasör içeriğini değiştir, SOURCE.txt'deki commit'i güncelle.
- **İkili araçlar bu deponun kendi GitHub yayınından gelir** (09.10.2026, kullanıcı kararı: başka siteden indirme yok, sürüm kayması yok;
  git'e koymak denenip bırakıldı: GitHub 100 MB üstü dosyayı almıyor, her araç güncellemesi geçmişe 2,5 GB eklerdi): `tools-2026.10` yayınında
  ComfyUI 7z, Node, ffmpeg, uv, 7zr, Python 3.12.15, llama.cpp CUDA zip'leri, SageAttention tekerleği ve ortamların Python'ları
  (python-build-standalone 20260924). `setup\tools.json` dosya, boyut ve SHA-256 verir; setup.ps1'deki `Get-Tool` `setup\_downloads` içine
  indirir, SHA-256 doğrular, yolu döndürür. uv Python'ları `setup\_downloads\python`'dan okur (`UV_PYTHON_INSTALL_MIRROR=file://…`). `Fetch` önce aynayı, sonra üst kaynağı dener (404/ad çözülemedi → sonraki adres),
  SHA-256 doğrular. Python paketleri kilitlerdeki sabit sürümle PyPI / download.pytorch.org'dan gelir (aynalanmadı: ~15 GB tekerlek).
- `extra_model_paths.yaml`: modeller ComfyUI dışında, güncellemede silinmez.
- `uv\`: Python 3.14 ve paket önbelleği (ses ortamı için).
- Hugging Face indirmesi Windows'ta sembolik bağ hatası verebilir (WinError 1314): `snapshot_download(..., local_dir=...)` ile `models\voice\` altına indir.
- İlk kullanan proje: `nedese-youtube\prime2` (Nedese Prime reklam filmi).

## İnce ayarlar (`panel\lib\fine-settings.mjs`)

Bu makineye (RTX 5070 12 GB, 16 GB RAM) göre seçilmiş bellek önlemleri ve sınırlar Ayarlar › İnce ayarlar (ekran kartına göre) bölümünde tik ve seçimlerle değiştirilir.

- Varsayılanlar bu makinenin ölçülmüş ayarıdır. `panel-data\settings.json`'da yalnız farklı olanlar durur (`fineSettings`).
- Kullanan kod her seferinde okur: yeniden başlatma gerekmez.
  - ComfyUI bayrakları ComfyUI yeniden açılınca geçerli olur. İş yoksa panel ComfyUI'yi kapatır, sonraki iş yeni bayraklarla açar.
  - `start_comfyui.bat` bayrakları `AI_COMFY_MEMORY`'ten okur; elle açılışta bu makinenin üç bayrağı kullanılır.
- Gruplar:
  - **Genel:** yazı modeli ile ComfyUI'nin kartı paylaşması, ses/eğitim öncesi boşaltma, RAM ve yabancı GPU beklemesi.
  - **ComfyUI:** `--cache-none`, `--disable-pinned-memory`, `--disable-dynamic-vram`.
  - **Yazı modeli:** VRAM bütçesi (otomatik: kartın belleği − 1,14 GiB; 12 GB kartta 10,8), görsel kodlayıcının yeri, betimleme görsel boyutu.
  - **Video:** doğrudan 1080p.
  - **Eğitim:** fp8, gradyan denetim noktaları, video LoRA derinliği, 720p / 81 kare, örnek sınırı, müzik kodlayıcısı, 4 bit (QLoRA), ses klonu toplu boyutu.

### 1080p video (ölçüldü 06.10.2026)

- Doğrudan 1080p (Wan 1920×1088) bu kartta pratik değil.
  - ComfyUI Wan modelinin 10,6 GB'ının tamamını RAM'e aldı (kartta 0 MB); kart %100 "meşgul" ama 55-59 W çekti, yani belleği bekledi.
  - İlk örnekleme adımı 26 dakikada bitmedi (720p'de adım 71-85 sn); iş 28,8 dk'da iptal edildi.
- Varsayılan: Wan 720p üretir, her parçanın kareleri `tools\upscale.py` ile 1920×1080'e büyütülür.
  - Model: 2xNomosUni SPAN (Philip Hofmann, CC-BY-4.0, 4,4 MB, `models\upscale_models\`); ComfyUI'nin python'u ve spandrel.
  - Kedi atlayışı, 5 sn: Wan 377 sn + büyütme 53 sn (RIFE sonrası 161 kare, kare başına 0,33 sn); toplam 463 sn, düz 720p'den %14 uzun.
  - Yakından bakınca kemer, zırh ve tüy kenarları düz büyütmeden belirgin keskin; bozulma görülmedi.
- Tek parça film de 1080p seçilebilir: her sahne bütün parçaları bitince bir kez büyütülür, kurgu ve altyazı 1920×1080.
- Güçlü kartta İnce ayarlar › Doğrudan 1080p açılır.

### Üretim hızı (ölçüldü 06.10.2026, RTX 5070 12 GB)

Bitmiş video işlerinin `job.json` süreleri (iş süresi / video süresi):

| Model / çözünürlük | Gerçek zaman katsayısı | 1 dk video | 1 sa video |
|---|---|---|---|
| Wan 2.2 14B, 720p (12 iş, ortanca) | ×76 (×69-90) | ~76 dk | ~76 sa |
| Wan 2.2 14B, 1080p büyütmeli (1 iş) | ×92 | ~92 dk | ~92 sa |
| Wan 2.2 14B, 480p (2 iş) | ×35-36 | ~36 dk | ~36 sa |
| Wan 2.2 5B, 480p (2 iş) | ×37-38 | ~37 dk | ~37 sa |
| Wan 2.2 5B, 720p (2 iş) | ×74-75 | ~75 dk | ~75 sa |

- 1 saatlik dizi/film bu kartta 720p'de 3 günden uzun sürekli üretim demek; 480p'de ~1,5 gün.
- "Hafif" 5B modeli bu kurulumda hızlı değil: 14B, 4 adımlık hızlandırılmış ayarla çalışıyor. Süreyi yalnız çözünürlük düşürüyor.

### Uzun videoda karakter tutarlılığı (ölçüldü 06.10.2026)

Kaynak: zırhlı, kırmızı pelerinli kedi savaşçı ve kara ejderha; Wan 2.2 A14B, 720p, tohum 3030.
Ölçü: yerel Gemma 26B (görsel kodlayıcıyla) her saniyeden bir kareye tek görsel olarak bakar, önce her kediyi konumu ve kıyafetiyle listeler, sonra sayar. Göz sayımıyla 60 karenin 59'unda aynı. İki görselli doğrudan "kaç kedi var" sorusu kopyaları görmüyordu.

**60 sn, iki koşuda aynı 12 İngilizce parça istemi (çeviri kapalı):**

| Yöntem | Kopya kedili kare | Kıyafet kaybı (zırh + pelerin yok) | DINOv2 kaynak benzerliği | Süre |
|---|---|---|---|---|
| Zincir (son kareden devam + renk sabitleme) | 0/60 | 25/60 | 0,51 | 4498 sn |
| Anahtar kare + kopya denetimi | 0/60 | 4/60 | 0,72 | 6648 sn |

- Zincirde kedi 12. saniyeden sonra zırhını ve pelerinini kaybetti, kara ejderha kızıla döndü, son saniyelerde kedi kadrajdan kayboldu.
- Anahtar karede 12 karenin 6'sı kopya denetiminde elendi (o parçalar zincirle sürdü); kalan anahtar kareler karakteri her seferinde kaynağa geri çekti.
- Bu sonuçla anahtar kare A14B'de çok parçalı videoda **varsayılan açık**: Video › İnce ayarlar › Uzun video › "Karakteri anahtar karelerle koru (A14B)". 5B'de ve tek parçada yok sayılır; Qwen-Image-Edit kurulu değilse zincirle sürer.
- 15 sn (3 parça) denemelerinde zincir kaymadı (0/15 kopya, 0/15 kıyafet kaybı): kayma süreyle birikiyor.
- Kimlik koruma (son kare + kaynak, iki görselli Qwen) 15 sn'de 10/15 karede kopya kedi ve yazı şeridi üretti; önerilmez.

**Kopyanın kaynağı ve denetimi:**
- Tek görselli Qwen-Image-Edit büyük hareketli eylemde ("yana atlayarak sıyrılıyor", "takla atıp sırtına konuyor") karakteri ikiliyor: 12/12 örnek. "Her karakter bir kez" ve son-durum istemleri düzeltmedi.
- Kopya denetimi: kaynaktaki karakterler türüne göre sayılır ("kitten = 1, dragon = 1"); anahtar karede bir tür fazlaysa kare kullanılmaz. Tür adı özel olmalı: "animal / creature" denince ejder de hayvan sayıldı. 21/21 doğru (14 kopyalı, 7 temiz); kare başına ~13 sn.

**Süre:**
- 60 sn koşusunda Wan bellekteyken 8 anahtar kare 1272 sn (kare başına 159 sn). Örnekleme yalnız ~20 sn; gerisi 16 GB RAM'de Qwen-Image-Edit (12,7 GB) ile metin kodlayıcısının (7,9 GB) her görselde sayfa dosyasından yer değiştirmesi.
- Bu yüzden anahtar kare grubundan önce ComfyUI belleği boşaltılır. Boşaltmadan sonra 2 anahtar kare 252 sn (model yüklemesi dahil); temiz ComfyUI'de 8 film görseli ~11 dk (görsel başına ~80 sn). 32 GB RAM bu yer değiştirmeyi kaldırır.
- Arayüzdeki süre tahmini anahtar kare süresini de katar (60 sn 720p: ~1 sa 16 dk yerine ~1 sa 47 dk).

**Tek parça film:** sahne görselleri (karakter referansı + "yeni görsel kur" istemi) 12/12 tek kedi, 12/12 aynı kıyafet; orada kopya denetimi gerekmiyor. 4 görselde kaynaktaki sıçrama pozu tekrarlandı.

DINOv2 benzerliği tek başına kimlik ölçüsü değil: sahne değişimini de cezalandırıyor (15 sn zincirde 0,88 → 0,53 düştü ama kıyafet korunmuştu).

## Güncelleme (`panel\lib\update.mjs`)

- Kaynak GitHub `mustafa-ozen95/nedese-studio` (`main`). Depo herkese açık: istekler anahtarsız gider (GitHub adres başına saatte 60 anahtarsız istek verir; panel denetim başına bir istek yapar).
- Ayarlar › Güncelleme ve sağ alttaki simgenin menüsünde:
  - "Güncellemeleri denetle", "Şimdi güncelle", "Günlük güncelleme denetimi" (varsayılan açık).
  - Açıkken günde bir denetler, yeni sürümü kurar, panel yeniden başlar. Çalışan iş kesilmez: bitince kurulur. Sınırsız veri toplama engel değil: duraklar, açılışta sürer.
- Üst çubuk: yeni sürüm varsa "Güncelleme var" rozeti (kuruluyorsa "Güncelleniyor…"); tıklayınca Ayarlar › Güncelleme.
  - Son denetimin sonucu `panel-data\settings.json`'da (`update.lastResult`): panel yeniden açılınca da bilinir. Geliştirme kopyasında rozet yok.
- Uygulama:
  - Yeni sürümün dosya listesi git ağacından gelir (tek API isteği, dosya başına yol + blob kimliği). Listedeki her dosya kurulu olanla git blob SHA-1'i üzerinden karşılaştırılır; yalnız değişen ve yeni dosyalar raw.githubusercontent.com'dan iner (istek sınırı yok) ve yazılmadan önce blob kimliğiyle doğrulanır.
  - Yalnız depodaki dosyalar yazılır. Değişenin eski hali `update\backup-<eski sürüm>\`'e alınır.
  - Önceki sürümde olup yenisinde olmayan dosya silinir. Güvensiz yol içeren sürüm hiç uygulanmaz.
  - `panel-data` (ayarlar, port, anahtarlar), `outputs`, `data`, `models` ve `llm\models` depoda olmadığı için hiç değişmez.
  - Python ortamları değiştiyse (`setup\`, `uv.lock`, `requirements`) uyarı verir: `setup.bat -Models none`.
- Sürüm: `version.json` (güncelleyicinin yazdığı, dosya listesiyle).
  - Yoksa `panel\version.txt`: git archive ve GitHub zip'i `export-subst` ile commit kimliğini yazar.
  - Geliştirme kopyası (git deposu) kendini güncellemez, `git pull` ile güncellenir.
- Yeniden başlatma:
  - Tepsi yönetiyorsa (`AI_PANEL_TRAY=1`) panel kapanır, bekçi 10 sn'de açar.
  - Değilse `panel\lib\restart.mjs` paneli aynı argüman ve ortamla açar.
- İstem çevirisi (Ayarlar › İstemler, varsayılan açık): istemler modele gitmeden İngilizceye çevrilir. Kapalıysa yazıldığı gibi gider (`prompt-translate.mjs`, `translatePrompt`).

## Hızlandırma (ölçülü)

- **SageAttention 2.2** (`sageattention-2.2.0+cu130torch2.10.0andhigher`, `triton-windows 3.8.0`): dikkat hesabı 7,1×;
  Wan A14B adımı 114–118 → 62–65 sn, 720p 5 sn klip ~600 → 365 sn. Kalite aynı (kareler karşılaştırıldı).
- Kart örneklemede %100 / ~220 W: darboğaz hesap. Sürücü tipi (Studio / Game Ready) CUDA hızını değiştirmez.
- RAM 16 GB: 14B modelin taşan kısmı sayfa dosyasına gider; 32 GB yükleme sürelerini kısaltır.

### Tek parça film hızı (ölçüldü 07.10.2026)

Aynı film iki kez üretildi: 5 sahne, 48 sn, 9:16, 720p Kalite, aynı girdi ve tohum.

| Aşama | Önce | Sonra |
|---|---|---|
| Seslendirme (5 satır × 3 çekim) | 313 sn | 306 sn |
| ComfyUI açılışı (bekleme) | 42 sn | 0: seslendirme sürerken açılır |
| Hareket istemleri + müzik planı (yazı modeli) | 5 ayrı yükleme (18-20 sn), sahne arası 30-34 sn | tek oturum 42 sn |
| Görseller (5) | 892 sn | **247 sn** (piksel piksel aynı) |
| Videonun başına kadar | 21,3 dk | 9,9 dk |
| Video (10 parça) | 70,8 dk | 66,3 dk |
| **Toplam** | **93,3 dk** | **77,1 dk (−%17)** |

Görsellerdeki kazancın nedeni ComfyUI'nin düğüm sırasıydı:
- ComfyUI çıktıya en yakın düğümü önce çalıştırıyor (`comfy_execution/graph.py`).
- Bu yüzden tek istekte bile her görsel için "kodla → çiz" sırası dönüyordu.
- 16 GB RAM'de metin kodlayıcı (7,9 GB) ile model (12,7 GB) her görselde takas ediliyordu.
- Çözüm `graph.mjs` içindeki `encodingsBefore`: bütün kodlamalar bitmeden örnekleme başlamıyor (ConditioningAverage 1.0, sayısal olarak aynı koşul).

Video parçası düğüm süreleri (sn), aşağıdaki sırayla:

| Düğüm | Süre (sn) |
|---|---|
| CLIPLoader | 3 |
| CLIPTextEncode | 7 |
| WanImageToVideo | 13 |
| KSamplerAdvanced (iki uzman) | 163-177 ve 160-169 |
| VAEDecode | 23 |
| RIFE VFI | 6 |
| SaveImage (161 PNG) | 12 |

Kalan sürenin %73'ü 720p örnekleme.

### Seslendirme motoru ölçümü: EMA Lightning (07.10.2026)

`canberkkkkkk/ema-lightning` (Apache 2.0, 8,6M parametre), `voice\ema\.venv` içinde denendi:
- Kontrol noktaları `weights_only=True` ile açıldı: yalnız tensör ve sözlük içeriyor.
- Aynı 5 anlatım cümlesi kullanıldı.

| | EMA Lightning | VoxCPM2 (3 çekimin en iyisi) |
|---|---|---|
| Yükleme | 1,0 sn | ~80 sn |
| Üretim | 0,05 sn/cümle (gerçek zamanın 135 katı; toplu 257 katı) | ~10 sn/çekim |
| Whisper hata oranı | %0,2 | %0,4 |
| Doğallık (UTMOS) | 3,17 | 3,58 |
| Ses | tek ses, kadın (perde ~233 Hz); klonlama yok | kütüphaneden ya da tariften, klon |

EMA karakter seslerini yapamaz, çünkü tek sesli. Hızlı taslak anlatım için uygun ama doğallığı daha düşük.

**Ses motoru: EMA Lightning** (Ayarlar > Ses motoru; 07.10.2026 kullanıcı: "Ses motoru EMA olmayacak mıydı"):
- Seçilince referanssız satırlar (anlatım, "Modelin kendi sesi") EMA ile okunur.
- Seçilen ses ya da karakter sesi olan satırlar VoxCPM2 ile klonlanır, çünkü EMA klonlamaz. Ses tasarımı da VoxCPM2'de.
- EMA işlemcide de çok hızlı (ölçüldü: yükleme 1,1 sn, satır başına 0,15-0,4 sn).

**EMA + ses dönüştürme ile karakterler (denendi).** EMA okur, Chatterbox'ın ses dönüştürücüsü (ChatterboxVC) karakterin
tınısına çevirir.
- Karaktere benzerlik (ECAPA): EMA'nın kendi sesi 0,05-0,12; dönüştürülünce 0,49-0,64.
- Şimdiki VoxCPM2 klonu 0,26-0,69.
- Perde karaktere iner: Elif 401-438 Hz, Baba 108 Hz.
- EMA'da duygu ayarı yok: "Çok korkuyorum" yine "mutlu" sınıflandı.
- Dönüştürme işlemcide satır başına ~11 sn.
Kurulum (`setup.ps1`) EMA'yı da kurar: `voice\ema\.venv` (Python 3.14, `lock\ema.txt`; ağır paketler `voice\.venv`'den `.pth`
ile), model ve kütüphanedeki "EMA Lightning" sesi `voice-models.py ema` ile.

Alania-2 (PatientDesk AI, 5 Ekim 2026) incelendi, panele bağlanmadı:
- Ağırlıkları kapalı, yalnız ücretli API.
- Kendi tablolarında WER %1,44, UTMOS 3,67; EMA %1,04 / 3,30.
- VoxCPM2 mimarisiyle 18.000 saat Türkçe üzerinde sıfırdan eğitilmiş. Açık bıraktıkları Türkçe veriler (CC BY 4.0) kendi
  eğitimimiz için bir seçenek.

### Dudak eşleme (Tek parça, ölçüldü 07.10.2026)

Tek parça formunda **Kurgu > "Konuşanların dudakları sesle oynasın"** seçilince konuşmalı sahneler InfiniteTalk ile
25 fps üretilir; konuşanın (hayvan da) ağzı kendi sesiyle oynar. Modeller: Ayarlar > Modeller > "Dudak eşleme (InfiniteTalk)"
(~16 GB; Wan 2.2 A14B HighNoise, UMT5 ve Wan 2.1 VAE de gerekir). Kurulumda: `setup.bat -Models all` ya da seçerek.

**Kurulum ölçümle seçildi.** Aynı görsel (kucağında kedi olan kız), aynı 3,24 sn replik, 720×1280, 81 kare:

| Kurulum | Ağız ~ ses (r) | Karışık ses denetimi (en çok) | Bakış (Gemma, 14 kare) | Süre |
|---|---|---|---|---|
| Wan 2.2 A14B uzmanlarına InfiniteTalk yaması | 0,31 | 0,43 | 13/14 kedide; renk kayıyor (turuncu kedi griye) | 869 sn |
| Wan 2.1 I2V 720p + lightx2v, 6 adım | 0,56 | 0,33 | 8/14 (3 karede kameraya) | 1072 sn |
| Wan 2.1 I2V 720p + lightx2v, 4 adım | 0,59 | 0,32 | 9/14 (3 karede kameraya) | 724 sn |
| **Karma: Wan 2.2 yüksek gürültü 2 adım + Wan 2.1 InfiniteTalk 2 adım, ses gücü 3** | **0,64** | 0,39 | **13/14, kameraya 0**; renk doğru | 608 sn |

- Ağız ölçümü: burun-ağız-çene bölgesi kare kare izlenir (cv2), ağızdaki kare-kare değişim ile ses enerjisinin
  korelasyonu; ses zarfı 50 kez karıştırılınca çıkan en büyük r denetimdir.
- Kullanıcı: "Wan 2.2 daha iyi, diğeri başka yerlere bakıyor". InfiniteTalk Wan 2.1'de konuşanı kameraya çeviriyor,
  Wan 2.2'ye takınca dudağı oynatmıyor; karmada hareket, bakış ve rengi Wan 2.2 kurar, dudağı InfiniteTalk oynatır.
- Ses gücü 1'de ağız sesle açılıyor ama az (sesli/sessiz karede hareket 5,0/4,4); 3'te 7,0/4,3, dişler ve dudak temiz.

**SyncNet ile yeniden ölçüldü; ses gücü 2'ye inildi.** Yukarıdaki r ölçütü ağzın ne kadar oynadığını ölçüyor, sese ne kadar
oturduğunu değil.
- Dudak-ses uyumu için standart ölçüt SyncNet (LSE-C, yüksek iyi; gerçek konuşma videolarında 7-8). Kurulum:
  `measure\` (syncnet_python, MIT; `measure\syncnet-measure.py video.mp4 [--audio konusmacinin-izi.wav]`).
- Aynı görsel ve ses:

  | Kurulum | Elif repliği | Yoğun konuşma |
  |---|---|---|
  | Saf Wan 2.1 InfiniteTalk (kameraya bakıyor) | 3,91 | – |
  | Karma, ses gücü 1 | 2,75 | – |
  | **Karma, ses gücü 2** | **2,94** | **2,60** |
  | Karma, ses gücü 3 (eski) | 2,08 | 1,22 |
  | Karma, ses gücü 3, Wan 2.2 1 adım | – | 2,11 |
  | Karma, ses gücü 3, 6 adım | – | 1,69 (1348 sn) |

- İki konuşmacıda her yüz kendi sesiyle ölçüldü: Elif 1,68 (Baba'nın sesiyle 0,58), Baba 2,00 (Elif'in sesiyle 0,68).
  Ağızlar karışmıyor; uyum düşük.

**Hız: darboğaz RAM.** Dudaklı pencere üretimde ~690 sn; bunun ~430 sn'si InfiniteTalk örnekleyicisi (Wan 2.2 adımının
2,5 katı). Ölçüldü (InfiniteTalk aşaması):
- ComfyUI özel belleği 29 GB (16 GB RAM), çalışma kümesi 1,7 GB; Windows 8 GB'ı sıkıştırıp diske yazıyor.
- GPU çoğu zaman 56-160 W çekiyor (tam hesapta ~200-250 W): ağırlık bekliyor.
- İşlemcide yapılan kurgu ve birleştirme bütün filmde 6-8 sn.

Düzeltmeler (aynı ayar, kareler birebir aynı):
- Dinamik VRAM açık (Ayarlar > İnce ayarlar > ComfyUI): 789 → 696 sn.
- Pencere iki istekte (`lipStages`: Wan 2.2 adımları latent dosyasına, InfiniteTalk adımları ondan): 675 sn.
  Sıkıştırılan bellek 8,3 → 4,1 GB.

**Ağız düzeltme (LatentSync, ölçüldü 07.10.2026).** Karma sahne üretildikten sonra konuşan **insanların** ağzı kendi ses
iziyle yeniden çizilir (`lip\mouth.py`, LatentSync 1.5, 256 piksel yüz). Burundan çene altına kadar maske; gözler, bakış,
saç ve arka plan Wan 2.2'nin karesi olarak kalır. Hayvan konuşanlar InfiniteTalk sonucuyla kalır, yüz modeli insan için.
- Aynı klip ve ses:

  | Klip | LatentSync'siz | LatentSync'li | Ağız-ses kayması |
  |---|---|---|---|
  | Yoğun konuşma, ses gücü 3 | 1,28 | **5,20** | −6 kare → 0 |
  | Yoğun konuşma, ses gücü 2 | 2,60 | 4,24 | −4 → 0 |
  | Yoğun konuşma, Wan 2.2 1 adım | 2,92 | 3,88 | −3 → 0 |
  | Elif repliği, ses gücü 3 | 1,94 | 4,11 | 1 → 0 |

- Gözle bakıldı: dikiş ya da bulanık bölge yok. Eski karmada kız her karede gülümsüyordu, şimdi ağız konuşmaya göre şekil
  alıyor.
- Süre: 3,24 sn klip ~75 sn (model yükleme ~40 sn dahil). Sahnede iki konuşan varsa model bir kez yüklenir, konuşmacılar
  sırayla düzeltilir.
- Yüz bulma: LatentSync'in InsightFace modelleri yalnız ticari olmayan araştırma için. Yerine MediaPipe yüz işaretleri
  (Apache-2.0) konur (`lip\patch.py`). Hizalama noktaları aynı: iki kaşın ortası, burun ortası. Hedef yüz, sahnedeki
  konuşanın kutusuna en yakın yüz. Yüz bulunamayan karede bir önceki karenin noktaları kullanılır.
- Kurulum: `setup.bat` (lip\LatentSync sabit commit + yama + `lip\.venv`, voice\.venv paketleri paylaşılır); modeller
  Ayarlar > Modeller > "Ağız düzeltme (LatentSync)" (~5,5 GB). Kurulu değilse film yalnız InfiniteTalk ile üretilir.
- Lisans: LatentSync kodu Apache-2.0, ağırlıkları OpenRAIL++ (ticari kullanım serbest, kötüye kullanım kısıtları var).

**Uzun sahne.** Pencere 81 kare (3,24 sn); sonraki pencere öncekinin son 9 karesinden sürer (+72 kare).
- 9 sn, 3 pencere: 1819 sn → konuşmalı sahnenin saniyesi ≈ 3,4 dk (normal sahne ≈ 1 dk).
- Düzeltmesiz pencereler rengi kaydırıyordu (parlaklık 118 → 95, 2. pencere başında sıçrama). Her kare kaynak görselin
  renklerine eşlenir (ComfyUI `ColorTransfer`, mkl_lab, kare kare); sonraki pencere düzeltilmiş karelerden başlar.
- Karmada ilk pencerenin ilk karesi bozuk çıkar (InfiniteTalk ilk kareyi her adımda yeniden kurar); ikinci kare kopyalanır.

**Yönetmen notu (her sahne, seslendirmeden önce; dudak eşleme açık olmasa da).** Kullanıcı: "Duygu, düşünce,
davranış, tavır, mimik... gerçek insan filmi olmalı". Yerel yazı modeli sahne görselini, anlatımı, karakterleri ve
replikleri okuyup her sahne için bir yönetmen notu yazar (`prompt-translate.mjs` `directorNote`, iş kaydında `director`):
- **an:** hikâyenin o anı ve duygusal tonu.
- **görsel:** durağan kare için tek cümle: kim nereye bakıyor, yüz ifadesi, beden dili.
- **karakterler:** her karakterin duygusu ve şiddeti, içinden geçen, ötekilere tavrı.
- **replikler:** her replik için oyunculuk (kime, bakış, mimik, el ve beden), ses (nasıl söylenir) ve dinleyenin
  tepkisi.

Bunlar şu istemlere girer:
- Görsel istemi: görsel cümlesi her sahnede eklenir.
- Hareket istemleri: yazı modeli parçaları nottaki duygu, mimik, jest, bakış, dinleyen tepkisi ve göz kırpma, nefes,
  ağırlık aktarma gibi küçük hareketlerle yazar. Tek parçalı sahnede de bu not varsa istem yazılır.
- Dudak pencere istemi: konuşanın oyunculuğu ve dinleyenin tepkisi.

Neden: eski genel kural ("konuşanlar birbirinin gözlerine bakar") ormanda kayıp kediye "Pamuk! Neredesin?" diye seslenen
kızı babasına gülerek baktırdı. Kullanıcı: "gülüyor, sevgili gibiler". Notun kuralları:
- İfade sözlerin anlamına uyar (kayıp ararken endişe, kavuşunca sevinç); an sevinçli değilse kimse gülmez.
- Sahnede olmayana seslenen o yöne bakar.
- Aile üyeleri romantik bakışmaz; kimse kameraya bakmaz.

Yazı modeli yoksa ya da not yazılamazsa genel düzen kullanılır: konuşan, seslendiği kişiye döner; ifadesi sözlerine
uyar.

**Pencere istemi: kim konuşuyor.** Karmada hareketi Wan 2.2 kurar, sesi bilmez; InfiniteTalk yalnız son iki adımda
dudağı sese uydurur. Bu yüzden istem pencerede kimin konuştuğunu söyler.
- Ölçüldü (kız + kedi sahnesi, Gemma her 0,2 sn'de ağız açık mı):
  - Bütün pencerelere "kız konuşuyor" diyen ilk parça istemi verilince kedi konuşurken kızın ağzı 10 karenin 6'sında
    açıktı, kedininki hiç açılmadı.
  - Her pencerede yeniden "kamera yaklaşır" denince kadraj daraldı.
- Şimdi her pencerenin istemi şöyle kurulur:
  - Pencerenin ortasına düşen parçanın istemi.
  - Başına kim konuşuyor: "Only the kitten is talking…; the girl listens with a closed mouth". Konuşma pencerenin
    %25'inden kısaysa "Nobody is talking".
  - İki karakter kadrajda tutulur; devam pencerelerinde kamera sabit.
- Karakter tanımı tür, yaş ve cinsiyetten gelir ("the girl", "the old man", tarifteki hayvan "the kitten"), çünkü adlar
  Wan'a bir şey söylemez.

**İki konuşmacı.** ComfyUI iki sesi ardışık ekler: pencerede önce konuşan 1. konuşmacı (kendi maskesiyle), sonra
konuşan 2. konuşmacı; bölünme konuşmacının değiştiği boşluğun ortası. Aynı pencerede A-B-A olursa en çok konuşmayı
koruyan bölünme seçilir (`panel\lib\lip.mjs`).
- Ölçüldü (Elif + Baba, 2 pencere, 1409 sn): Elif'in ağzı kendi sesiyle r 0,67 (denetim 0,29), Baba'nın sesiyle −0,15;
  Baba'nın açık ağzı kendi sesiyle r 0,32 (denetim 0,21), Elif konuşurken kapalı. İkisi birbirine dönerek konuştu.
- Konuşanların yeri: görseller bitince yerel Gemma sahne görselinde her konuşanın **yüz** kutusunu bulur; maske bu
  kutunun yanlara %15, aşağı %30 genişletilmişidir (çene ve ağız), iki maske kesişirse ham yüz kutuları kullanılır.
  - Gemma kutuyu `[y_min, x_min, y_max, x_max]` (0-1000) verir; insanlığı bazen `"label": "human"` diye yazar.
  - "Baş ve omuz" istenince tam boy kutu veriyordu: kucaktaki kedinin kutusu kızın ağzını da içine alıyordu. "Yalnız
    yüz" istenince kızın ve kedinin yüzü ayrık ve doğru kutulandı.
- **Hayvan da konuşur** (kullanıcı: "Hayvan da olsa konuşturabilmeliyiz"). Ölçüldü (kucakta kedi, kedinin repliği,
  Gemma her 3 karede "ağız açık mı"): kedinin ağzı sesli karelerin 15/16'sında açık, sessizlerin 4/11'inde (konuşmanın
  hemen başı ve sonu); kızın ağzı sesli karelerin 2/16'sında açık. Anlatıcının dudağı oynatılmaz; görünen konuşan
  yoksa sahne normal üretilir.

**ComfyUI yaması.** `comfy_extras\nodes_model_patch.py` InfiniteTalk yamasını `dtype` vermeden kurar, ağırlıklar fp32'ye
açılır (RAM'de 4,7 yerine 9,5 GB). Panel ComfyUI'yi açmadan önce `MultiTalkModelPatch(...)` çağrısına `dtype=dtype`
ekler (`panel\lib\comfy-process.mjs` `comfyPatch`); blok beklenenden farklıysa (ComfyUI güncellendiyse) dokunmaz.

## Panel (tarayıcıdan kolay kullanım)

Kullanıcı, 02.10.2026: *"kolay bir görsel-video-ses üretimi ve tümünün tek parça üretimi için bir panel"*.
Masaüstündeki **Nedese Studio** kısayolu (ya da kurulum klasöründeki `Nedese Studio.vbs`) tepsi uygulamasını
(`tray\tray.ps1`) açar: Nedese Studio (port 1071) **pencere açmadan** çalışır, sağ altta simge belirir.
Sağ tık: Paneli aç, ComfyUI başlat/kapat, Paneli yeniden başlat, Günlükleri aç, **Çıkış** (hepsini kapatır;
çalışan iş varsa sorar). Çift tık paneli açar. Kapanan hizmeti 10 sn içinde yeniden başlatır (5 dk'da en çok 3 kez).
ComfyUI'yi panel iş gelince penceresiz başlatır, kuyruk boşalınca (Ayarlar, varsayılan 10 dk) kapatır.
Günlükler `logs\` (panel.log, comfyui.log, tray.log). Simge zaten açıksa kısayol yalnızca paneli açar.
(Geliştirici makinesindeki kişisel "Hızlı Erişim" sayfası `quick-access\` depoda değildir; klasör varsa tepsi onu 8190'da açar.)
Eski yol (konsol penceresiyle): `panel.bat`; port doluysa `panel.bat --port 1166`; ComfyUI'yi pencerede görmek için `AI_PANEL_COMFY_WINDOW=1`.

**Ağdan erişim (kullanıcı kararı: üyelik/giriş yok):** panel `0.0.0.0:1071` dinler (`panel\defaults.json`); bilgisayarın her ağından **girişsiz** açılır (kimin ulaşacağını modem ve güvenlik duvarı kuralı belirler; diğer cihazlardan açılan sohbetler, Ayarlar › Asistan kuralları'ndan kapatılmadıkça dosya ve komut kullanabilir) (tarayıcı istekleri Host/Origin/X-Panel denetimiyle, programlar `Authorization: Bearer <anahtar>` ile). İstenirse `AI_PANEL_LOGIN=1` ile isteğe bağlı giriş açılabilir: başka cihazdan açılınca API anahtarı bir kez sorulur (`POST /api/v1/login`), HttpOnly + SameSite=Strict çerezle 90 günlük oturum (`panel-data\sessions.json`), IP başına 15 dakikada 8 yanlış deneme → 429. Varsayılan kapalıdır. ComfyUI aktarıcısı (:8189) özel ağa şifresiz açıktır (`lib\comfy-proxy.mjs`).

| Bölüm | Ne yapar |
|---|---|
| Görsel | İstem → Qwen-Image-2512 ya da FLUX.2 klein 4B; oran hazırları (Qwen'in resmi boyutları), adım, tohum, adet. N görsel TEK istekte üretilir: modeller bir kez yüklenir |
| Video | Kaynak görsel (yükle, sürükle ya da galeriden seç) → Wan 2.2 A14B ya da 5B; süre 2–8 sn, 720p/480p, RIFE 2×/3× → mp4. Yön görselden alınır |
| Ses | Metin → Chatterbox. Ses: kütüphaneden referans, modelin kendi sesi ya da **tariften yeni ses** (Qwen3-TTS İngilizce tını tasarlar, kütüphaneye ekler, Türkçe okuma o tınıyla yapılır). Kalite: 1 çekim / 3 çekim + Whisper / 6 çekim + doğallık puanı. Hız (atempo, perde korunur) |
| Tek parça | Sahne listesi (anlatım, görsel istemi, hareket istemi, karakter replikleri; istenirse galeriden hazır görsel) + tek ses → tek mp4 (+ `.srt`, istenirse altyazı videoya yazılır, yumuşak geçiş; konuşmalı sahnede isteğe bağlı dudak eşleme) |
| 3D | Görsel ya da videodan seçilen kare → TRELLIS.2 dokulu GLB. Yalnız görünen kısım modellenir; **Tam boy tamamla** önce Qwen-Image-Edit ile kişiyi/nesneyi baştan ayağa çizer. Blender kuruluysa (sürüm fark etmez; `Program Files\Blender Foundation\Blender *`, PATH ya da `AI_PANEL_BLENDER`) 4 sn dönen tanıtım videosu ve FBX / OBJ (ZIP) / STL (`tools\blender\model3d.py`, penceresiz) |
| Galeri | Bütün çıktılar: önizleme, indirme, "Videoya aktar", yeniden dene, sil (geri dönüşüm kutusuna; yalnızca panelin kendi klasörleri) |

**Tek parça sırası:** önce bütün anlatımlar tek seslendirmede (süreler belli olsun) → eksik görseller tek ComfyUI isteğinde →
her sahnenin videosu → sahne süresi = 0,6 sn + anlatım + 0,7 sn: kısaysa klip kırpılır; uzunsa RIFE ara kareleriyle en çok 1,6×
yavaşlatılır, o da yetmezse klip **son karesinden devam parçası** üretilerek uzatılır → 1280×720 (ya da 720×1280) 30 fps sahne
klipleri → 0,5 sn çapraz geçişle birleştirme, ses −16 LUFS. Yarıda kalırsa **Yeniden dene** kaldığı yerden sürer
(hazır ses, görsel ve video kareleri yeniden üretilmez).

**Kuyruk:** ekran kartı işleri tek sırada çalışır; ComfyUI ile seslendirme asla aynı anda değil — seslendirmeden önce ComfyUI'deki
iş bitmesi beklenir, `/free` ile VRAM boşaltılır ve boşaldığı nvidia-smi ile ölçülüp günlüğe yazılır. ComfyUI kapalıysa ilk görsel/video
işi `start_comfyui.bat`'ı kendi penceresinde (simge durumunda) başlatır; üst çubukta da düğme var. İlerleme ComfyUI websocket'inden
(adım sayısı) ve betik çıktısından gelir. İşi sunucu yürütür: tarayıcı sekmesi kapansa da sürer, yeniden açılınca durum görünür.
Panel penceresi kapanırsa çalışan iş "yarıda kaldı" olur. Hatalar arayüz dilinde okunur (eksik model dosyası, VRAM/RAM yetmedi, ComfyUI kapandı…);
ham ayrıntı işin günlüğünde.

**Dosyalar:**
- Kod `panel\` (Node, bağımlılıksız; arayüz NDS tasarım sistemi, yazı tipleri yerel), başlatıcı `panel.bat`, simge `panel\icon.ico`.
- Çıktılar `outputs\<tarih-saat-tür-kimlik>\` (`job.json` + `log.txt` + dosyalar); yüklenen görseller ve müzikler `outputs\uploads\`; panel ayarları ve veritabanı `panel-data\`.
- Ses kütüphanesi `voice\references\` (`<kimlik>.wav` + `.json`): "Tok bariton" (Nedese Prime anlatıcısı) ve "Yaşlı dede" ile başlar.
- Model dosya adları `tools\comfy.mjs`'ten gelir (bu makinede Q4_K_M, uzak makinede Q8_0): panel kodu iki makinede aynıdır.
- Süre tahmini bu makinede biten işlerin ortancasıdır (ilk işlerde "henüz ölçüm yok").

**Test:** `node --test "panel\test\*.test.mjs"` — sahte ComfyUI + sahte seslendirme + gerçek ffmpeg, ekran kartı kullanmaz
(kuyruk, iptal, hata yolları, güvenlik, tek parça baştan sona). `ui.test.mjs` paneli görünmez Edge'de açar, bütün
sekmeleri, eğitim alanlarını, video modellerini ve dil değişimini gezer; sayfa istisnası ya da konsol hatası varsa düşer
(Edge yoksa atlanır). Arayüz denetimi (ekran görüntüsü + konsol hatası / taşma / yazı tipi ölçümü):
`node panel\test\ui.mjs --address http://127.0.0.1:1071/ --output <klasör>`.
