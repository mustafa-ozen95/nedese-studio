# Nedese Studio

[English](../README.md) · [Türkçe](#nedese-studio) · [Kılavuz](BENIOKU.tr.md)

Windows için yerel yapay zekâ medya stüdyosu: görsel, video, ses, müzik, 3B model ve tek parça film üretimi, dudak eşleme, model eğitimi, veri toplama ve sohbet ajanı. Hepsi kendi bilgisayarınızda çalışır, veriler dışarı gönderilmez.

## Videolar

- Türkçe: [masaüstü](https://github.com/mustafa-ozen95/nedese-studio/releases/download/promo-2026.10/nedese-studio-tr-desktop.mp4) · [telefon](https://github.com/mustafa-ozen95/nedese-studio/releases/download/promo-2026.10/nedese-studio-tr-phone.mp4)
- İngilizce: [masaüstü](https://github.com/mustafa-ozen95/nedese-studio/releases/download/promo-2026.10/nedese-studio-en-desktop.mp4) · [telefon](https://github.com/mustafa-ozen95/nedese-studio/releases/download/promo-2026.10/nedese-studio-en-phone.mp4)

## Neler yapar

- **Görsel:** Qwen-Image 2512 ve FLUX.2 klein ile üretim; Qwen-Image-Edit 2511 ile çok referanslı düzenleme.
- **Video:** Wan 2.2 (A14B / 5B) ile görselden video; süre sınırsız (5 saniyelik parçalar bir öncekinin son karesinden sürer); 480p, 720p ve 1080p; RIFE ile akıcılaştırma.
- **Ses:** seslendirme (VoxCPM2, Chatterbox, EMA Lightning), kendi kaydınızdan ses klonlama, tariften ses tasarımı (Qwen3-TTS), filmde karakter başına ses.
- **Müzik:** ACE-Step 1.5 ile sözlü ya da sözsüz parça; eğitilen LoRA ile tarz verilebilir.
- **3B:** TRELLIS.2 ve Pixal3D ile görselden model; Blender ile döner tabla videosu ve FBX/OBJ/STL dışa aktarma.
- **Tek parça film:** sahneler, karakter tutarlılığı, seslendirme, konuşmalar, müzik, altyazı ve isteğe bağlı dudak eşleme (InfiniteTalk + LatentSync) tek videoda birleşir.
- **Model eğitimi:** yazı modeli (QLoRA ya da sıfırdan), görsel LoRA, video LoRA, müzik LoRA ve görsel + metin genel model.
- **Veri toplama:** sitelerden ve Wikimedia Commons'tan eğitime hazır metin, görsel, video ve ses; görseller yerel yazı modeliyle betimlenir.
- **Yerel yazı modeli:** varsayılan Bonsai 2 27B, seçenek olarak Gemma 4 26B (llama.cpp), OpenAI uyumlu `/llm/v1` adresi.
- **Sohbet ve ajan:** yerel yazı modeli araç çağrılarıyla paneli yönetir (aşağıda).
- **API:** panelin yaptığı her şey `/api/v1` ile yapılabilir (belgeler panelde `/api/documents`).

## Gereksinimler

- Windows 10 ya da 11, 64 bit
- NVIDIA RTX ekran kartı (varsayılanlar 12 GB VRAM ile ölçüldü)
- 16 GB RAM (32 GB önerilir)
- Bütün modellerle ~150 GB boş disk
- Python, Node.js, ffmpeg ve ComfyUI `setup.bat` ile **bu klasörün içine** kurulur; sisteme hiçbir şey kurulmaz.

## Kurulum

1. Depoyu indirin (Code › Download ZIP) ve örneğin `C:\nedese-studio` içine açın (kısa, boşluksuz, Türkçe karaktersiz bir yol; OneDrive dışında).
2. `setup.bat` dosyasını çalıştırın. Windows SmartScreen "Windows PC'nizi korudu" derse *Ek bilgi › Yine de çalıştır* deyin (betik kod imzalı değildir). ComfyUI, Node, ffmpeg, Python, Python ortamları ve isteğe bağlı olarak modeller bu klasörün içine kurulur; bilgisayarda kurulu olanlar (başka sürüm Python, Node, ffmpeg ya da hiçbiri) kullanılmaz. Kurulum önce ekran kartı sürücüsünü, belleği, disk alanını ve klasör yolunu denetler, sürerken bilgisayarın uyumasını engeller ve kesilirse yeniden çalıştırıldığında kaldığı yerden devam eder.
   - `setup.bat -Models all`: bütün modeller (~150 GB)
   - `setup.bat -Models none`: model indirmeden (sonra panelde Ayarlar › Modeller'den indirilir ya da "Varsayılan modelleri indir" kullanılır)
3. Başlatın (aşağıda) ve tarayıcıda açın: <http://127.0.0.1:1071>

## Başlatma

- **Tepsi (önerilen):** "Nedese Studio" kısayoluna (ya da `Nedese Studio.vbs`) çift tıklayın. Panel pencere açmadan çalışır, tarayıcıda kendiliğinden açılır ve sağ altta simge belirir; bir bildirim telefon ve evdeki diğer cihazlar için adresi gösterir (örneğin `http://192.168.1.20:1071`). Sağ tık: paneli aç, ComfyUI başlat/kapat, paneli yeniden başlat, güncelleme denetle, günlükleri aç, çıkış. Çift tık paneli açar.
- **Konsol penceresiyle:** `panel.bat` (başka port: `panel.bat --port 1166`).
- Doğrudan: `node panel\server.mjs [--port 1071] [--no-browser]`.
- ComfyUI'yi panel iş gelince kendisi başlatır, kuyruk boş kalınca (Ayarlar, varsayılan 10 dk) kapatır. Elle açmak için: `start_comfyui.bat` (<http://127.0.0.1:8188>).

Arayüzün ana dili İngilizcedir, Türkçe çevirisi vardır: üst çubukta TR seçilir ve seçim hatırlanır. İstemciler `?lang=` ya da `X-Panel-Lang` başlığını kullanabilir.

## Panelin bölümleri

| Bölüm | Ne yapar |
|---|---|
| Görsel | İstem → Qwen-Image-2512 ya da FLUX.2 klein 4B; oran hazırları, adım, tohum, adet; eğitilmiş LoRA'lar |
| Video | Kaynak görsel → Wan 2.2 A14B ya da 5B; 2–8 sn'lik parçalar zincirlenerek sınırsız süre; 480p/720p/1080p; RIFE 2×/3× |
| Ses | Metin → seslendirme; kütüphaneden ses, kendi kaydınız (klon) ya da tariften yeni ses; Whisper denetimli ve doğallık puanlı kalite kipleri |
| Müzik | Söz ya da enstrümantal → ACE-Step 1.5; söz yazarı; tarz LoRA'ları |
| Tek parça | Sahne listesi (anlatım, görsel istemi, hareket istemi, konuşmalar) → altyazılı, müzikli, isteğe bağlı dudak eşlemeli tek mp4; konudan sahne yazarı |
| 3D | Görsel ya da video karesi → dokulu GLB; "Tam boy tamamla"; Blender döner tabla ve FBX/OBJ/STL |
| Galeri | Bütün çıktılar: önizleme, indirme, videoya aktarma, yeniden deneme, silme |
| Eğitim | Yazı modeli, görsel/video/müzik LoRA, genel model; veri toplama; toplanan koleksiyonlar |
| Sohbet | Yerel yazı modeliyle sohbet ve ajan oturumları |
| Ayarlar | Modeller ve indirmeler, yazı modeli, ses motoru, istemler, ince ayarlar, güncelleme, API anahtarı |

İşler sunucuda tek ekran kartı kuyruğunda yürür: tarayıcı sekmesi kapansa da sürer; yarıda kalan iş kaldığı yerden yeniden denenir.

## API

- Temel adres: `http://127.0.0.1:1071/api/v1`. Bütün rotaları, alanları ve örnekleri içeren belge sayfası panelde `/api/documents`; OpenAPI tanımı `/api/v1/openapi.json`.
- Yetki: `Authorization: Bearer <anahtar>`; anahtar Ayarlar'da görünür (yenilenebilir). Paneli çalıştıran bilgisayardaki tarayıcı anahtar istemez.
- İşler: `POST /jobs`, JSON gövdede `type` alanı işi seçer (`image`, `video`, `voice`, `music`, `film`, `training`, `data`, …); `GET /jobs/{id}`, `POST /jobs/{id}/cancel`, yeniden deneme/duraklatma, `GET /gallery`, `GET /voices`, `POST /write-scenes`, `POST /write-lyrics`, `GET/PATCH /settings`, `GET /models`, `POST /comfy/start`.
- Yerel yazı modeli: OpenAI uyumlu `http://<bu-bilgisayar>:1071/llm/v1` (`/chat/completions`, `/responses`, `/models`), aynı anahtarla.

## Sohbet ve ajan

Sohbet sekmesi yerel yazı modeliyle konuşur; model araç çağırabilir: panelin kendi API'si (iş açar, bekler, dosyaları döndürür), dosya, kabuk, SSH, web arama, MCP sunucuları (`panel-data\mcp.json`) ve beceriler (`panel-data\skills` altındaki `SKILL.md` klasörleri). Claude Code eklentileri, becerileri ve MCP sunucuları panele kurulabilir (Ayarlar › Asistan ya da `install_plugin` aracıyla GitHub deposundan, pazar yerinden ya da klasörden) ve ajan tarafından aynı biçimde kullanılır; proje klasöründeki `NEDESE.md`, `AGENTS.md` ya da `CLAUDE.md` kendi kurallarını ekler. **Ajan** kipinde tek mesaj çok adımlı iş olur (adım sınırı 40). Tehlikeli işlemler (silme, yıkıcı komutlar, ayar değişikliği) onay ister; onaysız oturumda sormadan yapılır. Tam erişim (dosya/kabuk/SSH/MCP) yalnız paneli çalıştıran bilgisayardan ya da API anahtarıyla açılan oturumlara verilir; ağdan anahtarsız tarayıcı yalnız panel işlemleri ve web araçlarını kullanır. Aynı ajan `/llm/v1/chat/completions` üzerinden `nedese-ajan` modeli olarak da çağrılır.

## Ağdan erişim

Panel `0.0.0.0:1071` dinler (ikisi de `panel\defaults.json` içinde) ve bilgisayarın bağlı olduğu her ağdan **girişsiz** açılır; kimin ulaşabileceğini modeminiz ve güvenlik duvarı kuralı (yalnız özel ağlar) belirler. Tarayıcı istekleri Host/Origin başlıklarıyla denetlenir, programlar Bearer anahtarı kullanır. Diğer cihazlardan açılan sohbetler dosya ve komut kullanabilir (Ayarlar › Asistan kuralları'ndan kapatılır). Yalnız bu bilgisayar için `AI_PANEL_ADDRESS=127.0.0.1` ya da `panel-data\settings.json` içinde `"address": "127.0.0.1"` verin. İsteğe bağlı giriş `AI_PANEL_LOGIN=1` ile açılır.

## Güncelleme

Panel günde bir GitHub'daki son sürümü denetler ve kurar: yalnız değişen dosyalar iner. Yeni sürüm varsa üst çubukta "Güncelleme var" görünür. Elle denetim: Ayarlar › Güncelleme ya da sağ alttaki simgenin menüsü. Ayarlar, çıktılar, modeller ve veriler güncellemede değişmez. Geliştirme kopyası (git) `git pull` ile güncellenir.

## Daha güçlü ekran kartı

Varsayılanlar 12 GB ekran kartı ve 16 GB RAM için ölçüldü. Daha güçlü bir makinede Ayarlar › İnce ayarlar'dan bellek önlemleri kapatılabilir:

- ComfyUI model önbelleği
- eğitimde fp8 ve 4 bit
- yazı modelinin bellek bütçesi
- 720p video eğitimi, doğrudan 1080p video

## Sorun giderme

- Günlükler: `logs\` (`panel.log`, `comfyui.log`, `tray.log`); her işin kendi `log.txt` dosyası `outputs\<iş>\` altında.
- "Port dolu": `panel.bat --port 1166` (port ayarlarda saklanır).
- ComfyUI açılmıyor: `start_comfyui.bat` ile elle açıp pencereyi görün ya da `panel.bat` öncesi `AI_PANEL_COMFY_WINDOW=1` verin.
- VRAM/RAM yetmedi: başka GPU programlarını (uzun işte tarayıcıyı da) kapatın; Ayarlar › İnce ayarlar'a bakın.
- Eksik model dosyası: Ayarlar › Modeller kurulu olanı gösterir; indirme, yükleme ve taşıma oradan.
- Hugging Face indirmesi bazı Windows kurulumlarında sembolik bağ hatası verir (WinError 1314); kurulum betiği düz klasöre indirerek bunu aşar.
- Duran ya da sürünen model indirmesi kendiliğinden kesilip yeni bağlantıyla sürdürülür (kurulum ve Ayarlar › Modeller); kesilen kurulumdan sonra `setup.bat` yarım dosyalardan devam eder.
- Kurulum yol hatasıyla duruyorsa klasörü `C:\nedese-studio` gibi kısa, Türkçe karaktersiz bir yola (OneDrive dışına) taşıyıp yeniden çalıştırın.
- Antivirüs kurulum sırasında dosya karantinaya alıyorsa (Triton/SageAttention derleme adımları) klasörü dışlamalara ekleyip `setup.bat` dosyasını yeniden çalıştırın.
- Python ortamlarını değiştiren güncellemeden sonra panel `setup.bat -Models none` çalıştırmanızı ister.
- Blender `Program Files\Blender Foundation\Blender *`, `PATH` ya da `AI_PANEL_BLENDER` ile bulunur.

Ortam değişkenleri: `AI_PANEL_ADDRESS`, `AI_PANEL_PORT`, `AI_PANEL_LOGIN`, `AI_PANEL_TRAY` (tepsi verir), `AI_PANEL_COMFY_WINDOW`, `AI_COMFY_MEMORY` (ComfyUI bellek bayrakları), `AI_PANEL_BLENDER`.

## Lisans

Nedese Studio [PolyForm Noncommercial License 1.0.0](../LICENSE.md) ile yayımlanır: **ticari olmayan** her amaçla (kişisel kullanım, eğitim, araştırma, hobi projeleri, kâr amacı gütmeyen işler) kullanabilir, kopyalayabilir, değiştirebilir ve paylaşabilirsiniz. Ticari kullanıma izin verilmez. Telif hakkı 2026 Mustafa Özen.

## Üçüncü taraf bileşenler

Modeller yayımcılarından kendi lisanslarıyla indirilir (çoğu Apache 2.0 / MIT; LatentSync ağırlıkları OpenRAIL++, audeering yaş-cinsiyet modeli CC BY-NC-SA 4.0 ve yalnız ölçümde kullanılır; ayrıntı kılavuzda). Üçüncü taraf kod `setup\vendor\<ad>` altında depodadır; her klasörde köken, commit ve lisansı veren `SOURCE.txt` bulunur. İkili araçlar (7-Zip açıcı, Node, ffmpeg, uv, Python, ComfyUI taşınabilir, llama.cpp, SageAttention, ortamların Python'ları) bu deponun kendi GitHub yayınından iner (`tools-2026.10`; `setup\tools.json` boyut ve SHA-256 verir, kurulum doğrular), başka siteden asla. Yalnız Python paketleri (PyPI, sabit sürüm) ve modeller başka yerden gelir.

## Belgeler

- Türkçe kılavuz (mimari, ölçümler, bütün alt sistemler): [BENIOKU.tr.md](BENIOKU.tr.md)
- English guide: [GUIDE.md](GUIDE.md)
- English README: [../README.md](../README.md)
