/**
 * Pencere (modal).
 *
 * `tasarim.js` gibi KLASİK BETİK. Ayrı dosyada çünkü panellerin hepsi
 * `tasarim.js`i yüklemiyor (biri kendi davranış dosyasını koruyor) ama
 * pencereyi hepsi kullanıyor — davranış tek yerde dursun diye ayrıldı.
 *
 * SÖZLEŞME:
 *
 *   [data-modal] id="x"        pencerenin kendisi; `hidden` ile kapalı durur
 *   [data-modal-open="x"]      açan düğme/bağlantı
 *   [data-modal-close]         kapatan düğme (pencerenin içinde)
 *   [data-modal-opened]          sunucu açık getirsin (doğrulama hatasından sonra)
 *   [data-modal-closing="/…"]  kapanınca bu adrese dönülür (sunucu penceresi)
 *
 * Açan öğe GERÇEK bir adres taşımalıdır (`<a href="…/edit">`): betik
 * çalışmazsa bağlantı yine de sayfayı açar, adres paylaşılabilir kalır.
 *
 * İKİ AÇILIŞ BİÇİMİ:
 *
 * 1. İstemci penceresi — düğme açar, kapatınca adres değişmez.
 * 2. SUNUCU penceresi — `/kayitlar/{id}/duzenle` adresi listenin kendisini
 *    döndürür, pencere de `hidden` OLMADAN basılır. Betik hiç çalışmasa bile
 *    form ekranda olur; adres paylaşılabilir ve yer imine eklenebilir kalır.
 *    Kapanış adresi değiştirmek zorundadır, yoksa sayfa yenilendiğinde
 *    pencere geri gelir: bunu `data-modal-closing` söyler.
 */

function openNdsWindow(modal) {
    modal.hidden = false;

    /* Sayfa arkada kaymasın. */
    document.documentElement.style.overflow = 'hidden';

    modal.querySelector('input:not([type="hidden"]), select, textarea, button')?.focus();
}

function ndsCloseWindow(modal) {
    if (!modal) {
        return;
    }

    modal.hidden = true;

    if (!document.querySelector('[data-modal]:not([hidden])')) {
        document.documentElement.style.overflow = '';
    }

    /*
     * Sunucu penceresi: adres hâlâ `/…/duzenle` üzerinde. Sadece gizlemek
     * yetmez — yenilemede pencere geri gelir, geri tuşu formu tekrar açar.
     * Listeye dönülür; `ndsGit` varsa yenilemesiz, yoksa normal yükleme.
     */
    const retval = modal.dataset.modalClosing;

    if (retval) {
        (window.ndsGit || ((address) => location.assign(address)))(retval);
    }
}

function setupNdsWindow() {
    document.addEventListener('click', (event) => {
        const opener = event.target.closest('[data-modal-open]');

        if (opener) {
            const modal = document.getElementById(opener.dataset.modalOpen);

            /* Pencere yoksa bağlantı kendi işini yapsın (gerçek sayfaya gider). */
            if (modal) {
                event.preventDefault();
                openNdsWindow(modal);
            }

            return;
        }

        const closer = event.target.closest('[data-modal-close]');

        if (closer) {
            ndsCloseWindow(closer.closest('[data-modal]'));

            return;
        }

        /* Zemine tıklamak kapatır; kutunun içine tıklamak kapatmaz. */
        if (event.target.matches('[data-modal]')) {
            ndsCloseWindow(event.target);
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            document.querySelectorAll('[data-modal]:not([hidden])').forEach(ndsCloseWindow);
        }
    });

    /* Sunucudan açık gelen pencere: doğrulama hatasından sonra kullanıcı
       formunu yeniden açmak zorunda kalmasın. */
    const toOpen = () => document
        .querySelectorAll('[data-modal][data-modal-opened]')
        .forEach(openNdsWindow);

    toOpen();

    /* Yenilemesiz geçişten sonra yeni sayfanın penceresi de açılabilsin. */
    document.addEventListener('nds:page', toOpen);
}

if (!window.ndsWindowInstalled) {
    window.ndsWindowInstalled = true;
    setupNdsWindow();
}
