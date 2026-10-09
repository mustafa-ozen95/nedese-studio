<?php
// Yerel model / DeepSeek'in GEÇMİŞTE ürettiği içerik karşılaştırması. DeepSeek'e HİÇ istek atılmaz:
// completeJson yalnız yerel modele gider; DeepSeek adresi kapatılır. Girdi, o günkü hâl (otomasyon
// snapshot'ı / kaynak link) ile yeniden kurulur; referans, DeepSeek'in o gün yazıp sitede kalan çıktısı.
// Hepsi DB işleminde, sonunda GERİ ALINIR; kuyruk/posta sahte, Telegram kapalı, dış HTTP yalnız kaynak sitelere.
// Kullanım: php yerel-eski.php <kok> <site> <cikti.json> <tarih Y-m-d> <adet> [gorevler]
declare(strict_types=1);

[$_, $kok, $site, $cikti, $tarih, $adet] = $argv;
$adet = (int) $adet;
$gorevler = explode(',', $argv[6] ?? 'bolum,meta,tazele,yaz,cevir');
require $kok.'/vendor/autoload.php';
$app = require $kok.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Models\ContentAutomationRun;
use App\Models\Post;
use App\Models\PostTranslation;
use App\Services\Bot\DeepSeekClient;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Schema;

config([
    'services.deepseek.base_url' => 'http://127.0.0.1:9/kapali',
    'services.deepseek.api_key' => 'kapali',
    'services.telegram.bot_token' => null,
    'services.telegram.channel' => null,
]);

final class YerelKayitci extends DeepSeekClient
{
    public static array $cagrilar = [];
    public static string $gorev = '';

    // Sitenin yerelJson'u ile aynı: özgün yazı (PostRewriter::requestAndNormalize) bölüm bölüm üretilir.
    private static function bolumlu(?string $tur): bool
    {
        if ($tur !== null) {
            return str_contains($tur, 'requestAndNormalize');
        }
        foreach (debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 8) as $c) {
            if (($c['class'] ?? null) !== null && ! in_array($c['class'], [self::class, DeepSeekClient::class], true)) {
                return ($c['function'] ?? '') === 'requestAndNormalize';
            }
        }

        return false;
    }

    public function completeJson(string $systemPrompt, string $userPrompt, ?string $tur = null): ?array
    {
        $bas = microtime(true);
        try {
            $r = (new GuzzleHttp\Client(['timeout' => 900, 'http_errors' => false]))->post(rtrim(config('services.yerel_llm.url'), '/').'/responses', ['headers' => ['Authorization' => 'Bearer '.config('services.yerel_llm.api_key'), 'Content-Type' => 'application/json'], 'body' => json_encode(['model' => 'yerel', 'instructions' => $systemPrompt, 'input' => $userPrompt, 'text' => ['format' => ['type' => 'json_object']], 'temperature' => 0.7, 'max_output_tokens' => 8192, 'metadata' => ['bolumlu' => self::bolumlu($tur)]], JSON_UNESCAPED_UNICODE)]);
            $j = json_decode((string) $r->getBody(), true) ?? [];
            $mesaj = collect($j['output'] ?? [])->firstWhere('type', 'message');
            $metin = collect($mesaj['content'] ?? [])->firstWhere('type', 'output_text')['text'] ?? null;
            $temiz = $metin === null ? null : preg_replace('/^\s*```(?:json)?\s*|\s*```\s*$/', '', $metin);
            $json = $temiz === null ? null : json_decode($temiz, true);
            $yr = ['kod' => $r->getStatusCode(), 'json' => is_array($json) ? $json : null, 'ham' => is_array($json) ? null : mb_substr((string) $metin, 0, 2000)];
        } catch (Throwable $e) {
            $yr = ['kod' => 0, 'json' => null, 'ham' => $e->getMessage()];
        }
        $yr['sure'] = round(microtime(true) - $bas, 1);
        self::$cagrilar[] = ['gorev' => self::$gorev, 'tur' => $tur, 'system' => $systemPrompt, 'user' => $userPrompt, 'yerel' => $yr];
        fwrite(STDERR, sprintf("  [%s] yerel %.0fs %s\n", self::$gorev, $yr['sure'], $yr['json'] ? 'json' : 'YOK'));

        return $yr['json'];
    }
}

$app->instance(DeepSeekClient::class, new YerelKayitci);
Queue::fake();
Bus::fake();
Mail::fake();

$dil = Schema::hasColumn('post_translations', 'language_code') ? 'language_code' : 'locale';
$alanlar = ['title', 'slug', 'excerpt', 'content', 'meta_title', 'meta_description', 'meta_keywords'];
$sonuc = ['site' => $site, 'tarih' => $tarih, 'ornekler' => [], 'hatalar' => []];
$izinliHostlar = [];
Http::preventStrayRequests();
Http::fake(function ($istek) use (&$izinliHostlar) {
    $host = parse_url((string) $istek->url(), PHP_URL_HOST);
    if ($host && in_array($host, $izinliHostlar, true)) {
        return null; // kaynak siteye gerçek istek
    }

    return Http::response('engellendi', 503);
});
Http::allowStrayRequests();

// DeepSeek'in O KOŞUDA yazdığı: etkinlik günlüğünde koşu anındaki güncellemenin "after" değerleri
// (snapshot üstüne). Günlük yoksa bir sonraki koşunun snapshot'ı, o da yoksa bugünkü kayıt.
$sonraki = function (ContentAutomationRun $run) use ($dil, $alanlar): array {
    $t = PostTranslation::query()->where('post_id', $run->post_id)->where($dil, $run->{$dil})->first();
    $log = $t ? DB::table('activity_logs')->where('subject_type', PostTranslation::class)->where('subject_id', $t->id)
        ->where('event', 'updated')->whereBetween('created_at', [$run->created_at->copy()->subSeconds(5), $run->created_at->copy()->addMinutes(2)])
        ->orderBy('id')->first() : null;
    $degisim = $log ? json_decode((string) $log->changes, true) : null;
    if (is_array($degisim) && $degisim) {
        $sonra = array_intersect_key($run->snapshot, array_flip($alanlar));
        foreach ($degisim as $k => $d) {
            if (in_array($k, $alanlar, true) && is_array($d) && array_key_exists('after', $d)) {
                $sonra[$k] = $d['after'];
            }
        }

        return $sonra + ['_kaynak' => "günlük #{$log->id} ({$log->actor_label})"];
    }
    $s = ContentAutomationRun::query()->where('post_id', $run->post_id)->where($dil, $run->{$dil})
        ->where('id', '>', $run->id)->whereNotNull('snapshot')->where('applied', true)->orderBy('id')->first();
    if ($s) {
        return array_intersect_key($s->snapshot, array_flip($alanlar)) + ['_kaynak' => "koşu #{$s->id} snapshot"];
    }
    $t = PostTranslation::query()->where('post_id', $run->post_id)->where($dil, $run->{$dil})->first();

    return ($t ? $t->only($alanlar) : []) + ['_kaynak' => 'bugünkü kayıt'];
};
// Çevirinin belirli bir andaki hâli: o andan sonraki ilk koşunun snapshot'ı, yoksa bugünkü kayıt.
$andaki = function (int $postId, string $kod, string $an) use ($dil, $alanlar): ?array {
    $t = PostTranslation::query()->where('post_id', $postId)->where($dil, $kod)->first();
    if (! $t) {
        return null;
    }
    // Her alanın, o andan sonraki İLK değişikliğinin "before" değeri; hiç değişmemişse bugünkü değer.
    // Günlük uzun metni "[N karakterlik metin]" diye kısaltır: o alan için ilk snapshot'a bakılır.
    $s = ContentAutomationRun::query()->where('post_id', $postId)->where($dil, $kod)->where('created_at', '>=', $an)
        ->whereNotNull('snapshot')->where('applied', true)->orderBy('id')->first();
    $hal = $t->only($alanlar);
    $bulundu = [];
    foreach (DB::table('activity_logs')->where('subject_type', PostTranslation::class)->where('subject_id', $t->id)
        ->where('event', 'updated')->where('created_at', '>=', $an)->orderBy('id')->get() as $log) {
        foreach ((array) json_decode((string) $log->changes, true) as $k => $d) {
            if (in_array($k, $alanlar, true) && ! isset($bulundu[$k]) && is_array($d) && array_key_exists('before', $d)) {
                $kisaltilmis = is_string($d['before']) && preg_match('/^\[\d+ karakterlik metin\]$/u', $d['before']);
                $hal[$k] = $kisaltilmis ? ($s->snapshot[$k] ?? $hal[$k]) : $d['before'];
                $bulundu[$k] = true;
            }
        }
    }

    return $hal;
};

// Eklenen bölüm: önceki metin önekse kalan kısım; değilse (aradan geçen düzenlemeler) önceki metinde
// başlığı geçmeyen <h2> blokları.
$yeniBolum = function (string $once, string $sonra): string {
    if (str_starts_with($sonra, rtrim($once))) {
        return trim(mb_substr($sonra, mb_strlen(rtrim($once))));
    }
    $bloklar = preg_split('/(?=<h2[\s>])/i', $sonra);
    $duz = mb_strtolower(strip_tags($once));

    return trim(implode('', array_filter(array_slice($bloklar, 1), fn ($b) => preg_match('#<h2[^>]*>(.*?)</h2>#is', $b, $m) && ! str_contains($duz, mb_strtolower(trim(strip_tags($m[1])))))));
};
$calis = function (string $gorev, array $kimlik, callable $is) use (&$sonuc) {
    YerelKayitci::$gorev = $gorev;
    $once = count(YerelKayitci::$cagrilar);
    $kayit = ['gorev' => $gorev] + $kimlik;
    DB::beginTransaction();
    try {
        $kayit += $is();
    } catch (Throwable $e) {
        $kayit['hata'] = get_class($e).': '.mb_substr($e->getMessage(), 0, 400);
    } finally {
        DB::rollBack();
    }
    $kayit['cagrilar'] = array_keys(array_slice(YerelKayitci::$cagrilar, $once, null, true));
    $sonuc['ornekler'][] = $kayit;
    fwrite(STDERR, "$gorev ".json_encode($kimlik, JSON_UNESCAPED_UNICODE).(isset($kayit['hata']) ? " HATA {$kayit['hata']}" : '')."\n");
};

// Tarihe en yakın, uygulanmış ve geri alınmamış koşular.
$kosular = fn (string $task) => ContentAutomationRun::query()->where('task', $task)->where('applied', true)
    ->whereNull('reverted_at')->whereNotNull('snapshot')
    ->orderByRaw('ABS(TIMESTAMPDIFF(HOUR, created_at, ?))', [$tarih.' 12:00:00'])->limit($adet)->get();

$snapshottanCeviri = function (ContentAutomationRun $run) use ($dil, $alanlar): PostTranslation {
    $t = PostTranslation::query()->where('post_id', $run->post_id)->where($dil, $run->{$dil})->firstOrFail();
    $t->forceFill(array_intersect_key($run->snapshot, array_flip($alanlar)));
    $t->syncOriginal();

    return $t;
};
$ns = 'App\\Services\\Seo\\Automation\\';

if (in_array('bolum', $gorevler)) {
    foreach ($kosular('opportunity_section') as $run) {
        $calis('bolum', ['kosu' => $run->id, 'post' => $run->post_id, 'dil' => $run->{$dil}, 'sorgu' => $run->query, 'tarih' => (string) $run->created_at], function () use ($app, $run, $ns, $sonraki, $snapshottanCeviri, $yeniBolum) {
            $sonra = $sonraki($run);
            $once = (string) $run->snapshot['content'];
            $ds = $yeniBolum($once, (string) ($sonra['content'] ?? ''));
            $t = $snapshottanCeviri($run);
            $r = $app->make($ns.'OpportunitySectionWriter')->write($t, (string) $run->query);
            $yeni = (string) $t->fresh()->content;

            return ['deepseek' => $ds, 'deepseek_kaynak' => $sonra['_kaynak'], 'yerel_uygulandi' => (bool) $r->applied, 'yerel_mesaj' => $r->message,
                'yerel' => $r->applied ? $yeniBolum($once, $yeni) : null];
        });
    }
}
if (in_array('meta', $gorevler)) {
    foreach ($kosular('meta_fix') as $run) {
        $calis('meta', ['kosu' => $run->id, 'post' => $run->post_id, 'dil' => $run->{$dil}, 'tarih' => (string) $run->created_at], function () use ($app, $run, $ns, $sonraki, $snapshottanCeviri) {
            $sonra = $sonraki($run);
            $t = $snapshottanCeviri($run);
            $r = $app->make($ns.'MetaOptimizer')->optimize($t);
            $t2 = $t->fresh();
            $m = fn ($x) => ['meta_title' => $x['meta_title'] ?? null, 'meta_description' => $x['meta_description'] ?? null];

            return ['once' => $m($run->snapshot), 'deepseek' => $m($sonra), 'deepseek_kaynak' => $sonra['_kaynak'], 'yerel_uygulandi' => (bool) $r->applied, 'yerel_mesaj' => $r->message, 'yerel' => $m($t2->toArray())];
        });
    }
}
if (in_array('tazele', $gorevler)) {
    foreach ($kosular('stale_refresh') as $run) {
        $calis('tazele', ['kosu' => $run->id, 'post' => $run->post_id, 'dil' => $run->{$dil}, 'tarih' => (string) $run->created_at], function () use ($app, $run, $ns, $sonraki, $snapshottanCeviri) {
            $sonra = $sonraki($run);
            $t = $snapshottanCeviri($run);
            // Dönem, o günkü (snapshot) başlıktan tarayıcı ile çözülür — işin kendisi gibi.
            $post = Post::findOrFail($run->post_id);
            $post->setRelation('translations', collect([$t]));
            $donem = $app->make(App\Services\Seo\StaleDatedContentScanner::class)->periodFor($post);
            $etiket = $donem['label'] ?? (preg_match('/20\d\d/', (string) $t->title, $m) ? $m[0] : (string) $run->created_at->format('Y'));
            $r = $app->make($ns.'StaleContentRefresher')->refresh($t, $etiket);
            $t2 = $t->fresh();
            $s = fn ($x) => array_intersect_key((array) $x, array_flip(['title', 'excerpt', 'content', 'meta_title', 'meta_description']));

            return ['etiket' => $etiket, 'once' => $s($run->snapshot), 'deepseek' => $s($sonra), 'deepseek_kaynak' => $sonra['_kaynak'], 'yerel_uygulandi' => (bool) $r->applied, 'yerel_mesaj' => $r->message, 'yerel' => $s($t2->toArray())];
        });
    }
}

// Bot yazıları: kaynak linkten yeniden yazma ve çeviri.
$botYazilari = Schema::hasColumn('posts', 'source_url') && (in_array('yaz', $gorevler) || in_array('cevir', $gorevler))
    ? Post::query()->where('is_bot_generated', true)->whereNotNull('source_url')
        ->orderByRaw('ABS(TIMESTAMPDIFF(HOUR, created_at, ?))', [$tarih.' 12:00:00'])->limit($adet)->get()
    : collect();
foreach ($botYazilari as $post) {
    $an = (string) $post->created_at;
    $trIlk = $andaki($post->id, 'tr', $an);
    if (in_array('yaz', $gorevler)) {
        $calis('yaz', ['post' => $post->id, 'kaynak' => $post->source_url, 'tarih' => $an], function () use ($app, $post, $trIlk, &$izinliHostlar) {
            $izinliHostlar[] = parse_url($post->source_url, PHP_URL_HOST);
            $cekilen = $app->make(App\Services\Bot\UrlContentFetcher::class)->fetch($post->source_url);
            if (! $cekilen || trim((string) ($cekilen['body'] ?? '')) === '') {
                return ['atlandi' => 'kaynak çekilemedi', 'deepseek' => $trIlk];
            }
            $resmi = class_exists(App\Support\ResmiAlanlar::class) ? App\Support\ResmiAlanlar::kaynaktanCikar($post->source_url) : [];
            $yasak = class_exists(App\Support\Content\KaynakKimligi::class) ? App\Support\Content\KaynakKimligi::adVeAdrestenKur($post->source_name, $post->source_url, (string) $cekilen['title'])->yasakAdlar() : [];
            try {
                $etiketler = $app->make(App\Support\Bot\EtiketSecici::class)->adaylar((string) $cekilen['title'], strip_tags((string) $cekilen['body']));
            } catch (Throwable) {
                $etiketler = [];
            }
            $y = $app->make(App\Services\Bot\PostRewriter::class)->rewriteFromSource((string) $cekilen['title'], (string) $cekilen['body'], $post->source_url, 'tr', $resmi, $yasak, $etiketler, []);

            return ['kaynak_baslik' => $cekilen['title'], 'kaynak_uzunluk' => mb_strlen(strip_tags((string) $cekilen['body'])), 'deepseek' => $trIlk, 'yerel' => $y];
        });
    }
    if (in_array('cevir', $gorevler) && $trIlk) {
        foreach (['en', 'de'] as $kod) {
            $ref = $andaki($post->id, $kod, $an);
            if (! $ref) {
                continue;
            }
            $calis('cevir', ['post' => $post->id, 'dil' => $kod, 'tarih' => $an], function () use ($app, $post, $trIlk, $kod, $ref) {
                $etiketler = $post->tags()->pluck('name')->all();
                $y = $app->make(App\Services\Bot\PostRewriter::class)->translate($trIlk, $kod, $etiketler, []);

                return ['tr' => $trIlk, 'deepseek' => $ref, 'yerel' => $y];
            });
        }
    }
}

$sonuc['cagrilar'] = YerelKayitci::$cagrilar;
file_put_contents($cikti, json_encode($sonuc, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
fwrite(STDERR, 'tamam: '.count($sonuc['ornekler']).' örnek, '.count(YerelKayitci::$cagrilar)." yerel çağrı\n");
