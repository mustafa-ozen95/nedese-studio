<?php
// yerel-eski.php çıktısındaki DeepSeek referanslarının İÇERİK alanını düzeltir: etkinlik günlüğü uzun
// metni "[N karakterlik metin]" diye kısaltıyor. İçerik: koşudan sonraki ilk snapshot, yoksa bugünkü kayıt.
// Yalnız okur. Kullanım: php ref-duzelt.php <kok> <eski.json>
declare(strict_types=1);

[$_, $kok, $dosya] = $argv;
require $kok.'/vendor/autoload.php';
$app = require $kok.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
config(['services.telegram.bot_token' => null, 'services.telegram.channel' => null]);

use App\Models\ContentAutomationRun;
use App\Models\PostTranslation;

$yerTutucu = fn ($s) => is_string($s) && preg_match('/^\[\d+ karakterlik metin\]$/u', $s);
// O andan sonraki ilk uygulanmış koşunun snapshot içeriği, yoksa bugünkü içerik.
$icerik = function (int $postId, string $kod, string $an, ?int $sonrakiKosu = null): array {
    $q = ContentAutomationRun::query()->where('post_id', $postId)->where('language_code', $kod)->whereNotNull('snapshot')->where('applied', true);
    $s = $sonrakiKosu !== null ? $q->where('id', '>', $sonrakiKosu)->orderBy('id')->first() : $q->where('created_at', '>=', $an)->orderBy('id')->first();
    if ($s && isset($s->snapshot['content'])) {
        return [(string) $s->snapshot['content'], "koşu #{$s->id} snapshot"];
    }

    return [(string) PostTranslation::query()->where('post_id', $postId)->where('language_code', $kod)->value('content'), 'bugünkü kayıt'];
};
$yeniBolum = function (string $once, string $sonra): string {
    if (str_starts_with($sonra, rtrim($once))) {
        return trim(mb_substr($sonra, mb_strlen(rtrim($once))));
    }
    $duz = mb_strtolower(strip_tags($once));

    return trim(implode('', array_filter(array_slice(preg_split('/(?=<h2[\s>])/i', $sonra), 1), fn ($b) => preg_match('#<h2[^>]*>(.*?)</h2>#is', $b, $m) && ! str_contains($duz, mb_strtolower(trim(strip_tags($m[1])))))));
};

$v = json_decode(file_get_contents($dosya), true);
foreach ($v['ornekler'] as &$o) {
    if (isset($o['hata'])) {
        continue;
    }
    if ($o['gorev'] === 'bolum' && ($o['deepseek'] ?? '') === '') {
        $run = ContentAutomationRun::find($o['kosu']);
        [$sonra, $k] = $icerik($run->post_id, $run->language_code, (string) $run->created_at, $run->id);
        $o['deepseek'] = $yeniBolum((string) $run->snapshot['content'], $sonra);
        $o['deepseek_kaynak'] = $k;
    } elseif ($o['gorev'] === 'tazele' && $yerTutucu($o['deepseek']['content'] ?? null)) {
        [$o['deepseek']['content'], $o['deepseek_kaynak']] = $icerik($o['post'], $o['dil'], $o['tarih'], $o['kosu']);
    } elseif ($o['gorev'] === 'yaz' && $yerTutucu($o['deepseek']['content'] ?? null)) {
        [$o['deepseek']['content'], $o['deepseek_kaynak']] = $icerik($o['post'], 'tr', $o['tarih']);
    } elseif ($o['gorev'] === 'cevir') {
        if ($yerTutucu($o['deepseek']['content'] ?? null)) {
            [$o['deepseek']['content'], $o['deepseek_kaynak']] = $icerik($o['post'], $o['dil'], $o['tarih']);
        }
        if ($yerTutucu($o['tr']['content'] ?? null)) {
            [$o['tr']['content']] = $icerik($o['post'], 'tr', $o['tarih']);
        }
    }
    fwrite(STDERR, "{$o['gorev']} {$o['post']} ".($o['deepseek_kaynak'] ?? '')."\n");
}
unset($o);
file_put_contents($dosya, json_encode($v, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT));
