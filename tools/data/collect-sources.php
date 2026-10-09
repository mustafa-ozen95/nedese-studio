<?php
// Botun kaynak sitelerinden (bot_rss_sources, etkin + kapalı) yazı toplar: botun KENDİ RSS / site haritası
// okuyucusu ve sayfa ayıklayıcısıyla. Her yazı için botun özgün yazı istemi yeniden oynatılarak kaydedilir
// (yapay zekâ ÇAĞRILMAZ; hedef yanıt sonra yerelde üretilir). Zaten yazılmış kaynaklar atlanır.
// Kullanım: php kaynak-topla.php <kok> <cikti.jsonl> [kaynak-basina-en-fazla=60]
declare(strict_types=1);

[$_, $kok, $cikti] = $argv;
$enFazla = (int) ($argv[3] ?? 60);
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

use App\Services\Bot\DeepSeekClient;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;

final class IstemYakala extends DeepSeekClient
{
    public static ?array $istem = null;

    public function completeJson(string $systemPrompt, string $userPrompt, ?string $tur = null): ?array
    {
        self::$istem ??= ['system' => $systemPrompt, 'user' => $userPrompt];

        return null; // akış burada biter: yalnız istem lazım
    }
}
$app->instance(DeepSeekClient::class, new IstemYakala);
Queue::fake();
Bus::fake();
Mail::fake();
$izinli = [];
Http::fake(function ($istek) use (&$izinli) {
    $host = parse_url((string) $istek->url(), PHP_URL_HOST);

    return $host && in_array(preg_replace('/^www\./', '', $host), $izinli, true) ? null : Http::response('engellendi', 503);
});

$yazilmis = DB::table('posts')->whereNotNull('source_url')->pluck('source_url')->map(fn ($u) => rtrim((string) $u, '/'))->flip();
$rss = $app->make(App\Services\Bot\RssFeedReader::class);
$harita = $app->make(App\Services\Bot\SitemapFeedReader::class);
$fetcher = $app->make(App\Services\Bot\UrlContentFetcher::class);
$rewriter = $app->make(App\Services\Bot\PostRewriter::class);

$gorulen = [];
// Kaldığı yerden sürme: çıktıdaki linkler atlanır.
if (is_file($cikti)) {
    foreach (file($cikti) as $satir) {
        $gorulen[rtrim((string) (json_decode($satir, true)['link'] ?? ''), '/')] = true;
    }
}
$f = fopen($cikti, 'a');
foreach (DB::table('bot_rss_sources')->get() as $kaynak) {
    $host = preg_replace('/^www\./', '', (string) parse_url($kaynak->url, PHP_URL_HOST));
    $izinli = [$host];
    $ogeler = [];
    try {
        $ogeler = $kaynak->type === 'sitemap' ? $harita->fetch(['name' => $kaynak->name, 'url' => $kaynak->url]) : $rss->fetch(['name' => $kaynak->name, 'url' => $kaynak->url]);
    } catch (Throwable $e) {
        fwrite(STDERR, "{$kaynak->name}: besleme okunamadı ({$e->getMessage()})\n");
    }
    // Daha fazla yazı: sitenin kendi site haritası (botun okuyucusu, en yeniler)
    if (count($ogeler) < $enFazla && $kaynak->type !== 'sitemap') {
        foreach (["https://www.$host/sitemap_index.xml", "https://$host/sitemap_index.xml", "https://www.$host/sitemap.xml", "https://$host/sitemap.xml"] as $u) {
            try {
                $ek = $harita->fetch(['name' => $kaynak->name, 'url' => $u]);
            } catch (Throwable) {
                $ek = [];
            }
            if ($ek) {
                $ogeler = array_merge($ogeler, $ek);
                break;
            }
        }
    }
    $alinan = 0;
    foreach ($ogeler as $o) {
        if ($alinan >= $enFazla) {
            break;
        }
        $link = rtrim((string) ($o['link'] ?? ''), '/');
        if ($link === '' || isset($yazilmis[$link]) || isset($gorulen[$link])) {
            continue;
        }
        $gorulen[$link] = true;
        $govde = (string) ($o['body'] ?? '');
        $baslik = (string) ($o['title'] ?? '');
        if (mb_strlen(strip_tags($govde)) < 1500) {
            usleep(1_000_000); // site başına saniyede bir istek
            try {
                $c = $fetcher->fetch($link);
            } catch (Throwable) {
                $c = null;
            }
            if (! $c || mb_strlen(strip_tags((string) ($c['body'] ?? ''))) < 1500) {
                continue;
            }
            [$govde, $baslik] = [(string) $c['body'], (string) ($c['title'] ?: $baslik)];
        }
        // Botun özgün yazı istemi (resmi kaynaklar / yasak adlar / etiket adayları botun yaptığı gibi)
        IstemYakala::$istem = null;
        DB::beginTransaction();
        try {
            $resmi = App\Support\ResmiAlanlar::kaynaktanCikar($link);
            $yasak = App\Support\Content\KaynakKimligi::adVeAdrestenKur($kaynak->name, $link, $baslik)->yasakAdlar();
            try {
                $adaylar = $app->make(App\Support\Bot\EtiketSecici::class)->adaylar($baslik, strip_tags($govde));
            } catch (Throwable) {
                $adaylar = [];
            }
            $rewriter->rewriteFromSource($baslik, $govde, $link, 'tr', $resmi, $yasak, $adaylar, []);
        } catch (Throwable $e) {
            fwrite(STDERR, "  istem kurulamadı: {$e->getMessage()}\n");
        } finally {
            DB::rollBack();
        }
        fwrite($f, json_encode(['kaynak' => $kaynak->name, 'link' => $link, 'baslik' => $baslik, 'govde' => $govde, 'istem' => IstemYakala::$istem], JSON_UNESCAPED_UNICODE)."\n");
        $alinan++;
    }
    fwrite(STDERR, "{$kaynak->name}: {$alinan} yazı (beslemede ".count($ogeler).")\n");
}
fclose($f);
fwrite(STDERR, "tamam\n");
