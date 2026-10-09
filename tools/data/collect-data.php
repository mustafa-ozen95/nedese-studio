<?php
// SEO yazı modeli eğitim verisi: botun ve otomasyonun GERÇEK istemleri yeniden oynatılır, hedef yanıt
// DeepSeek'in o gün yazıp sitede kalan çıktısıdır. HİÇBİR yapay zekâ çağrılmaz: istemci yalnız istemi
// kaydeder ve hazır yanıtı döndürür (kod normal akışını sürdürür). Hepsi DB işleminde, GERİ ALINIR.
// Kullanım: php veri-topla.php <kok> <cikti.jsonl> [gorevler: cevir,meta,bolum,tazele] [en-fazla-yazi]
declare(strict_types=1);

[$_, $kok, $cikti] = $argv;
$gorevler = explode(',', $argv[3] ?? 'cevir,meta,bolum,tazele');
$enFazla = (int) ($argv[4] ?? 100000);
require $kok.'/vendor/autoload.php';
$app = require $kok.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
config([
    'services.deepseek.base_url' => 'http://127.0.0.1:9/kapali',
    'services.deepseek.api_key' => 'kapali',
    'services.yerel_llm.url' => 'http://127.0.0.1:9/kapali',
    'services.telegram.bot_token' => null,
    'services.telegram.channel' => null,
]);

use App\Models\ContentAutomationRun;
use App\Models\Post;
use App\Models\PostTranslation;
use App\Services\Bot\DeepSeekClient;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;

final class Oynatici extends DeepSeekClient
{
    /** @var list<array> sıradaki hazır yanıtlar */
    public static array $yanitlar = [];
    public static array $kayitlar = [];

    public function completeJson(string $systemPrompt, string $userPrompt, ?string $tur = null): ?array
    {
        $yanit = array_shift(self::$yanitlar);
        self::$kayitlar[] = ['system' => $systemPrompt, 'user' => $userPrompt, 'yanit' => $yanit];

        return $yanit;
    }
}

$app->instance(DeepSeekClient::class, new Oynatici);
Queue::fake();
Bus::fake();
Mail::fake();
// Dış HTTP yalnız özgün yazı görevinde, o yazının KAYNAK sitesine (kaynak metni yeniden çekmek için).
$izinliHostlar = [];
Http::fake(function ($istek) use (&$izinliHostlar) {
    $host = parse_url((string) $istek->url(), PHP_URL_HOST);

    return $host && in_array($host, $izinliHostlar, true) ? null : Http::response('engellendi', 503);
});

$alanlar = ['title', 'slug', 'excerpt', 'content', 'meta_title', 'meta_description', 'meta_keywords'];
$yer = fn ($s) => is_string($s) && preg_match('/^\[\d+ karakterlik metin\]$/u', $s);
// Çevirinin belirli bir andaki hâli: her alanın o andan sonraki İLK değişikliğinin "before" değeri;
// günlük uzun metni kısaltmışsa ilk otomasyon snapshot'ı; hiç değişmemişse bugünkü değer.
$andaki = function (PostTranslation $t, string $an) use ($alanlar, $yer): array {
    $s = ContentAutomationRun::query()->where('post_id', $t->post_id)->where('language_code', $t->language_code)
        ->where('created_at', '>=', $an)->whereNotNull('snapshot')->where('applied', true)->orderBy('id')->first();
    $hal = $t->only($alanlar);
    $bulundu = [];
    foreach (DB::table('activity_logs')->where('subject_type', PostTranslation::class)->where('subject_id', $t->id)
        ->where('event', 'updated')->where('created_at', '>=', $an)->orderBy('id')->get() as $log) {
        foreach ((array) json_decode((string) $log->changes, true) as $k => $d) {
            if (in_array($k, $alanlar, true) && ! isset($bulundu[$k]) && is_array($d) && array_key_exists('before', $d)) {
                $hal[$k] = $yer($d['before']) ? ($s->snapshot[$k] ?? $hal[$k]) : $d['before'];
                $bulundu[$k] = true;
            }
        }
    }

    return $hal;
};
// Son 90 gün görüntülenme (performans ağırlığı için)
$goruntulenme = DB::table('post_daily_views')->where('view_date', '>=', now()->subDays(90)->toDateString())
    ->selectRaw('post_id, SUM(views) v')->groupBy('post_id')->pluck('v', 'post_id');

$f = fopen($cikti, 'w');
$say = [];
$yaz = function (string $gorev, array $kayit, array $hedef, array $ek) use ($f, &$say) {
    fwrite($f, json_encode(['gorev' => $gorev, 'messages' => [
        ['role' => 'system', 'content' => $kayit['system']],
        ['role' => 'user', 'content' => $kayit['user']],
        ['role' => 'assistant', 'content' => json_encode($hedef, JSON_UNESCAPED_UNICODE)],
    ]] + $ek, JSON_UNESCAPED_UNICODE)."\n");
    $say[$gorev] = ($say[$gorev] ?? 0) + 1;
};
$oynat = function (array $yanitlar, callable $is) {
    Oynatici::$yanitlar = $yanitlar;
    Oynatici::$kayitlar = [];
    DB::beginTransaction();
    try {
        $is();
    } catch (Throwable $e) {
        fwrite(STDERR, '  hata: '.mb_substr($e->getMessage(), 0, 200)."\n");
    } finally {
        DB::rollBack();
    }

    return Oynatici::$kayitlar[0] ?? null;
};

// ── Çeviri: Türkçe asıl (yayın anı) -> her dil (o dilin oluşturulduğu andaki hâli) ──
if (in_array('cevir', $gorevler)) {
    $rewriter = $app->make(App\Services\Bot\PostRewriter::class);
    $yazilar = Post::query()->where('is_bot_generated', true)->orderByDesc('id')->limit($enFazla)->get();
    foreach ($yazilar as $post) {
        $tr = PostTranslation::query()->where('post_id', $post->id)->where('language_code', 'tr')->first();
        if (! $tr) {
            continue;
        }
        $trIlk = $andaki($tr, (string) $post->created_at);
        $etiketler = $post->tags()->get();
        foreach (PostTranslation::query()->where('post_id', $post->id)->where('language_code', '!=', 'tr')->get() as $t) {
            // Kaynak etiketi: bot (DeepSeek: TranslatePostJob/GenerateBot...), elle yazım betikleri (Claude), tinker/konsol.
            $olusturan = (string) DB::table('activity_logs')->where('subject_type', PostTranslation::class)->where('subject_id', $t->id)
                ->where('event', 'created')->value('actor_label');
            $kaynak = preg_match('/Translate|GenerateBot|generate-bot/i', $olusturan) ? 'deepseek' : (preg_match('/g-|nedese_yaz|nyaz/', $olusturan) ? 'claude' : 'diger');
            $ref = $andaki($t, (string) $t->created_at);
            $etiketCevirisi = [];
            foreach ($etiketler as $e) {
                $ad = DB::table('tag_translations')->where('tag_id', $e->id)->where('language_code', $t->language_code)->value('name');
                if ($ad) {
                    $etiketCevirisi[$e->name] = $ad;
                }
            }
            $hedef = array_intersect_key($ref, array_flip(['title', 'excerpt', 'content', 'meta_title', 'meta_description', 'meta_keywords']));
            if ($etiketler->count()) {
                $hedef['translated_tags'] = (object) $etiketCevirisi;
            }
            $k = $oynat([$hedef, $hedef], fn () => $rewriter->translate(
                array_intersect_key($trIlk, array_flip(['title', 'excerpt', 'content', 'meta_title', 'meta_description', 'meta_keywords'])),
                $t->language_code, $etiketler->pluck('name')->all(), []));
            if ($k) {
                $yaz('cevir', $k, $hedef, ['post' => $post->id, 'dil' => $t->language_code, 'kaynak' => $kaynak, 'goruntulenme' => (int) ($goruntulenme[$post->id] ?? 0)]);
            }
        }
        fwrite(STDERR, "cevir #{$post->id}\n");
    }
}

// ── Özgün yazı: kaynak link (yeniden çekilir) -> yayımlanan Türkçe yazı (yayın anındaki hâli) ──
if (in_array('yaz', $gorevler)) {
    $rewriter = $app->make(App\Services\Bot\PostRewriter::class);
    $fetcher = $app->make(App\Services\Bot\UrlContentFetcher::class);
    foreach (Post::query()->where('is_bot_generated', true)->whereNotNull('source_url')->orderByDesc('id')->limit($enFazla)->get() as $post) {
        $tr = PostTranslation::query()->where('post_id', $post->id)->where('language_code', 'tr')->first();
        if (! $tr) {
            continue;
        }
        $izinliHostlar = [parse_url($post->source_url, PHP_URL_HOST)];
        try {
            $cekilen = $fetcher->fetch($post->source_url);
        } catch (Throwable) {
            $cekilen = null;
        }
        $izinliHostlar = [];
        if (! $cekilen || mb_strlen(strip_tags((string) ($cekilen['body'] ?? ''))) < 800) {
            fwrite(STDERR, "yaz #{$post->id}: kaynak çekilemedi\n");
            continue;
        }
        $ilk = $andaki($tr, (string) $post->created_at);
        $kategori = DB::table('post_categories')->join('category_translations', 'category_translations.category_id', '=', 'post_categories.category_id')
            ->where('post_categories.post_id', $post->id)->where('category_translations.language_code', 'tr')->value('category_translations.name');
        $etiketler = $post->tags()->pluck('name')->all();
        $hedef = array_intersect_key($ilk, array_flip(['title', 'excerpt', 'content', 'meta_title', 'meta_description', 'meta_keywords']))
            + ['category_name' => $kategori, 'tag_keywords_en' => $etiketler];
        $resmi = class_exists(App\Support\ResmiAlanlar::class) ? App\Support\ResmiAlanlar::kaynaktanCikar($post->source_url) : [];
        $yasak = class_exists(App\Support\Content\KaynakKimligi::class) ? App\Support\Content\KaynakKimligi::adVeAdrestenKur($post->source_name, $post->source_url, (string) $cekilen['title'])->yasakAdlar() : [];
        try {
            $adaylar = $app->make(App\Support\Bot\EtiketSecici::class)->adaylar((string) $cekilen['title'], strip_tags((string) $cekilen['body']));
        } catch (Throwable) {
            $adaylar = [];
        }
        $k = $oynat(array_fill(0, 6, $hedef), fn () => $rewriter->rewriteFromSource((string) $cekilen['title'], (string) $cekilen['body'], $post->source_url, 'tr', $resmi, $yasak, $adaylar, []));
        if ($k) {
            $yaz('yaz', $k, $hedef, ['post' => $post->id, 'dil' => 'tr', 'goruntulenme' => (int) ($goruntulenme[$post->id] ?? 0)]);
        }
        fwrite(STDERR, "yaz #{$post->id}\n");
    }
}

// ── SEO otomasyonu: o günkü hâl (snapshot) + sorgu -> DeepSeek'in yazdığı (etkinlik günlüğü / sonraki snapshot) ──
$sonraki = function (ContentAutomationRun $run) use ($alanlar, $yer): array {
    $t = PostTranslation::query()->where('post_id', $run->post_id)->where('language_code', $run->language_code)->first();
    $sonra = array_intersect_key($run->snapshot, array_flip($alanlar));
    $log = $t ? DB::table('activity_logs')->where('subject_type', PostTranslation::class)->where('subject_id', $t->id)->where('event', 'updated')
        ->whereBetween('created_at', [$run->created_at->copy()->subSeconds(5), $run->created_at->copy()->addMinutes(2)])->orderBy('id')->first() : null;
    foreach ((array) json_decode((string) ($log->changes ?? '[]'), true) as $k => $d) {
        if (in_array($k, $alanlar, true) && is_array($d) && array_key_exists('after', $d) && ! $yer($d['after'])) {
            $sonra[$k] = $d['after'];
        }
    }
    // Uzun içerik günlükte kısaltılmışsa: bir sonraki koşunun snapshot'ı, yoksa bugünkü kayıt
    if ($log && $yer(json_decode((string) $log->changes, true)['content']['after'] ?? null)) {
        $s = ContentAutomationRun::query()->where('post_id', $run->post_id)->where('language_code', $run->language_code)
            ->where('id', '>', $run->id)->whereNotNull('snapshot')->where('applied', true)->orderBy('id')->first();
        $sonra['content'] = $s->snapshot['content'] ?? $t?->content;
    }

    return $sonra;
};
$ceviriKur = function (ContentAutomationRun $run): PostTranslation {
    $t = PostTranslation::query()->where('post_id', $run->post_id)->where('language_code', $run->language_code)->firstOrFail();
    $t->forceFill(array_intersect_key($run->snapshot, array_flip(['title', 'slug', 'excerpt', 'content', 'meta_title', 'meta_description', 'meta_keywords'])));
    $t->syncOriginal();

    return $t;
};
$kosular = fn (string $task) => ContentAutomationRun::query()->where('task', $task)->where('applied', true)->whereNull('reverted_at')->whereNotNull('snapshot')->orderBy('id')->get();
$ns = 'App\\Services\\Seo\\Automation\\';
$GECTI = ['passes' => true, 'reason' => 'Uygun.'];

if (in_array('meta', $gorevler)) {
    foreach ($kosular('meta_fix') as $run) {
        $sonra = $sonraki($run);
        $hedef = ['meta_title' => $sonra['meta_title'], 'meta_description' => $sonra['meta_description']];
        $k = $oynat([$hedef, $GECTI], fn () => $app->make($ns.'MetaOptimizer')->optimize($ceviriKur($run)));
        if ($k) {
            $yaz('meta', $k, $hedef, ['post' => $run->post_id, 'dil' => $run->language_code, 'goruntulenme' => (int) ($goruntulenme[$run->post_id] ?? 0)]);
        }
    }
}
if (in_array('bolum', $gorevler)) {
    foreach ($kosular('opportunity_section') as $run) {
        $once = (string) $run->snapshot['content'];
        $sonra = (string) ($sonraki($run)['content'] ?? '');
        if (str_starts_with($sonra, rtrim($once))) {
            $bolum = trim(mb_substr($sonra, mb_strlen(rtrim($once))));
        } else {
            $duz = mb_strtolower(strip_tags($once));
            $bolum = trim(implode('', array_filter(array_slice(preg_split('/(?=<h2[\s>])/i', $sonra), 1), fn ($b) => preg_match('#<h2[^>]*>(.*?)</h2>#is', $b, $m) && ! str_contains($duz, mb_strtolower(trim(strip_tags($m[1])))))));
        }
        if ($bolum === '') {
            continue;
        }
        $hedef = ['already_covered' => false, 'section_html' => $bolum];
        $k = $oynat([$hedef, $GECTI], fn () => $app->make($ns.'OpportunitySectionWriter')->write($ceviriKur($run), (string) $run->query));
        if ($k) {
            $yaz('bolum', $k, $hedef, ['post' => $run->post_id, 'dil' => $run->language_code, 'goruntulenme' => (int) ($goruntulenme[$run->post_id] ?? 0)]);
        }
    }
}
if (in_array('tazele', $gorevler)) {
    foreach ($kosular('stale_refresh') as $run) {
        $sonra = $sonraki($run);
        $t = $ceviriKur($run);
        $post = Post::findOrFail($run->post_id);
        $post->setRelation('translations', collect([$t]));
        $donem = $app->make(App\Services\Seo\StaleDatedContentScanner::class)->periodFor($post);
        $etiket = $donem['label'] ?? (preg_match('/20\d\d/', (string) $t->title, $m) ? $m[0] : (string) $run->created_at->format('Y'));
        $hedef = array_intersect_key($sonra, array_flip(['title', 'excerpt', 'content', 'meta_title', 'meta_description']));
        $k = $oynat([$hedef, $GECTI], fn () => $app->make($ns.'StaleContentRefresher')->refresh($t, $etiket));
        if ($k) {
            $yaz('tazele', $k, $hedef, ['post' => $run->post_id, 'dil' => $run->language_code, 'goruntulenme' => (int) ($goruntulenme[$run->post_id] ?? 0)]);
        }
    }
}
fclose($f);
fwrite(STDERR, 'tamam: '.json_encode($say)."\n");
