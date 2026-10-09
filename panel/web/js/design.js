/**
 * Tasarım sisteminin GÖRSEL davranışları.
 *
 * KLASİK BETİK olarak yazıldı, modül olarak değil: şablonun bir sunucuya
 * ihtiyaç duymadan `file://` üzerinden açılabilmesi için. Tarayıcılar modül
 * betiğini yerel dosyadan yüklemeyi CORS ile engelliyor ve sayfa sessizce
 * davranışsız kalıyordu. Vite/Rollup bu dosyayı yan etki olarak içe
 * aktarabilir: `import './components/tasarim.js';`
 *
 * Buradaki her şey yalnızca DOM işidir: tema, açılır menü, pencere, sekme ve
 * bildirim. Veri, doğrulama ve yetki sunucunun işidir; bu dosya onlara
 * karışmaz — asıl projelerde de aynı ayrım geçerlidir.
 *
 * CSS'in beklediği SÖZLEŞME budur; kendi projenizde bu davranışları başka
 * bir kütüphaneyle kurabilirsiniz, önemli olan aynı sınıf ve nitelikleri
 * üretmesidir.
 */

const THEME_KEY = 'theme';

/* ── Tema ───────────────────────────────────────────────────────────────
 *
 * Seçim <html data-theme="dark|light"> olarak yazılır ve tarayıcıda saklanır.
 * Hiç seçim yapılmadıysa system tercihine bakılır.
 */
function setupTheme() {
    const root = document.documentElement;

    const registered = (() => {
        try {
            return localStorage.getItem(THEME_KEY);
        } catch {
            return null;
        }
    })();

    if (registered) {
        root.dataset.theme = registered;
    }

    document.addEventListener('click', (event) => {
        if (!event.target.closest('[data-theme-toggle]')) {
            return;
        }

        const fresh = root.dataset.theme === 'light' ? 'dark' : 'light';

        root.dataset.theme = fresh;

        try {
            localStorage.setItem(THEME_KEY, fresh);
        } catch {
            /* Gizli sekmede saklanamaz; seçim yalnızca bu sayfada yaşar. */
        }
    });
}

/* ── Açılır menü (hesap menüsü) ──────────────────────────────────────── */
function setupMenu() {
    document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-menu-open]');
        const isOpen = document.querySelector('[data-menu-list]:not([hidden])');

        if (isOpen && (!button || isOpen.previousElementSibling !== button)) {
            isOpen.hidden = true;
            isOpen.previousElementSibling?.setAttribute('aria-expanded', 'false');
        }

        if (!button) {
            return;
        }

        const list = button.nextElementSibling;

        list.hidden = !list.hidden;
        button.setAttribute('aria-expanded', String(!list.hidden));
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') {
            return;
        }

        document.querySelectorAll('[data-menu-list]:not([hidden])').forEach((list) => {
            list.hidden = true;
            list.previousElementSibling?.setAttribute('aria-expanded', 'false');
        });
    });
}

/* ── Pencere (modal) ─────────────────────────────────────────────────────
 *
 * Açmak: herhangi bir düğmeye data-modal-open="<pencere-id>".
 * Kapatmak: data-modal-close, zemine tıklama ya da Escape.
 */
/*
 * Pencere davranışı BU DOSYADA DEĞİL: .
 *
 * Panellerin hepsi tasarim.js yüklemiyor (biri kendi davranış dosyasını
 * koruyor) ama pencereyi hepsi kullanıyor. İki kopya tutmamak için ayrıldı;
 * iki kez yüklenirse pencere iki kez açılıp kapanır.
 */

/* ── Onay penceresi ──────────────────────────────────────────────────────
 *
 * Tehlikeli işlem YAZILI ONAY ister. Herhangi bir forma, bağlantıya ya da
 * düğmeye `data-confirm` eklemek yeter; sayfada tek bir
 * `[data-confirm-dialog]` bulunur (düzenin parçasıdır).
 *
 *   data-confirm          soruyu anlatan cümle
 *   data-confirm-title    pencere başlığı
 *   data-confirm-verify   elle yazılması gereken metin (kayıt adı gibi)
 *   data-confirm-variant  "danger" ise onay düğmesi kırmızı olur
 *
 * GEREKÇE her işlemde istenir ve boş bırakılamaz: denetimde sorulan soru
 * "kim ne yaptı" kadar "neden yaptı"dır da. Sunucu da gerekçesiz isteği
 * reddeder — buradaki alan yalnızca kullanıcıyı geri dönmekten kurtarır.
 */
function setupApproval() {
    const modal = document.querySelector('[data-confirm-dialog]');

    if (!modal) {
        return;
    }

    const title = modal.querySelector('[data-confirm-title]');
    const message = modal.querySelector('[data-confirm-message]');
    const rationaleField = modal.querySelector('[data-confirm-reason]');
    const validationBox = modal.querySelector('[data-confirm-verify-field]');
    const expected = modal.querySelector('[data-confirm-expected]');
    const validation = modal.querySelector('[data-confirm-input]');
    const approve = modal.querySelector('[data-confirm-accept]');
    // data-confirm-check: an optional tick box (its label); its state goes to data-confirm-checked of the trigger and its form
    const checkField = modal.querySelector('[data-confirm-check-field]');
    const checkInput = modal.querySelector('[data-confirm-check-input]');
    const checkLabel = modal.querySelector('[data-confirm-check-label]');

    let source = null;

    const close = () => {
        modal.hidden = true;
        source = null;
    };

    const isValid = () => {
        const rationaleOk = !rationaleField || rationaleField.value.trim() !== '';
        const textOk = validationBox.hidden
            || validation.value.trim() === expected.textContent.trim();

        return rationaleOk && textOk;
    };

    const refresh = () => {
        approve.disabled = !isValid();
    };

    document.addEventListener('click', (event) => {
        const trigger = event.target.closest('[data-confirm]');

        if (!trigger) {
            return;
        }

        /* Formun kendi düğmesine basıldıysa gönderimi durdurup soruyu sor. */
        event.preventDefault();

        source = trigger;
        title.textContent = trigger.dataset.confirmTitle || 'Confirm';
        message.textContent = trigger.dataset.confirm;

        const text = trigger.dataset.confirmVerify || '';

        validationBox.hidden = text === '';
        expected.textContent = text;
        validation.value = '';

        if (rationaleField) {
            rationaleField.value = '';
        }

        if (checkField) {
            const label = trigger.dataset.confirmCheck || '';
            checkField.hidden = label === '';
            checkLabel.textContent = label;
            checkInput.checked = false;
        }

        approve.classList.toggle('btn--danger', trigger.dataset.confirmVariant === 'danger');
        approve.classList.toggle('btn--primary', trigger.dataset.confirmVariant !== 'danger');

        modal.hidden = false;
        refresh();
        (rationaleField || validation).focus();
    });

    modal.addEventListener('input', refresh);

    modal.addEventListener('click', (event) => {
        if (event.target.closest('[data-confirm-cancel]') || event.target === modal) {
            close();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !modal.hidden) {
            close();
        }
    });

    approve.addEventListener('click', () => {
        if (!isValid() || !source) {
            return;
        }

        const form = source.closest('form') ?? document.getElementById(source.getAttribute('form'));

        /* Gerekçe forma gizli alan olarak eklenir; kayda o yazılır. */
        if (form && rationaleField) {
            let field = form.querySelector('input[name="rationale"]');

            if (!field) {
                field = document.createElement('input');
                field.type = 'hidden';
                field.name = 'rationale';
                form.append(field);
            }

            field.value = rationaleField.value.trim();
        }

        if (checkField && !checkField.hidden) {
            const checked = checkInput.checked ? '1' : '0';
            source.dataset.confirmChecked = checked;
            if (form) form.dataset.confirmChecked = checked;
        }

        close();

        if (form) {
            form.submit();

            return;
        }

        if (source.tagName === 'A') {
            window.location.href = source.href;
        }
    });
}


/* ── Sıralama (sürükle-bırak) ────────────────────────────────────────────
 *
 * Satırlar sürüklenerek sıralanır. Sıra alanına elle 10, 20, 30 yazmak
 * sırayı değiştirmenin dolambaçlı yoluydu; ekranda görünen sıra ile kayıttaki
 * sıra da ayrılabiliyordu.
 *
 * Dış kütüphane YOK: tarayıcının kendi sürükleme olayları yeterli.
 *
 *   <ul data-position="/kayit-sirasi" data-position-field="sira">
 *     <li data-position-id="uuid" draggable="true">…</li>
 *   </ul>
 *
 * Bırakma anında yeni sıra sunucuya POST edilir (form gönderimi: hata ve
 * yönlendirme öbür yazma yollarıyla aynı kalsın). `data-position` boşsa istek
 * atılmaz — kılavuzdaki gibi sunucusuz örnekler için.
 */
function setupOrdering() {
    let dragged = null;

    const ids = (list) => [...list.querySelectorAll('[data-position-id]')]
        .map((line) => line.dataset.positionId);

    /* İmlecin üstünde durduğu satır: yarısını geçince araya girilir. */
    const targetLine = (list, y) => [...list.querySelectorAll('[data-position-id]:not(.is-dragging)')]
        .reduce((near, line) => {
            const box = line.getBoundingClientRect();
            const diff = y - box.top - box.height / 2;

            return diff < 0 && diff > near.diff ? { diff, line } : near;
        }, { diff: Number.NEGATIVE_INFINITY, line: null }).line;

    const send = (list) => {
        const address = list.dataset.position;

        if (!address) {
            /* Sunucusuz örnek: yalnızca yeni sırayı duyur. */
            list.dispatchEvent(new CustomEvent('position:changed', { detail: ids(list), bubbles: true }));

            return;
        }

        const form = document.createElement('form');

        form.method = 'POST';
        form.action = address;
        form.hidden = true;

        const fields = [
            ['_token', document.querySelector('meta[name="csrf-token"]')?.content ?? ''],
            ['_method', 'PUT'],
            ...ids(list).map((id) => [`${list.dataset.positionField ?? 'position'}[]`, id]),
        ];

        fields.forEach(([name, value]) => {
            const input = document.createElement('input');

            input.type = 'hidden';
            input.name = name;
            input.value = value;
            form.append(input);
        });

        document.body.append(form);
        form.submit();
    };

    document.addEventListener('dragstart', (event) => {
        const line = event.target.closest('[data-position-id]');

        if (!line) {
            return;
        }

        dragged = line;
        line.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
    });

    document.addEventListener('dragend', (event) => {
        event.target.closest('[data-position-id]')?.classList.remove('is-dragging');
    });

    document.addEventListener('dragover', (event) => {
        const list = event.target.closest('[data-position]');

        if (!list || !dragged || !list.contains(dragged)) {
            return;
        }

        /* Varsayılan davranış bırakmayı engeller. */
        event.preventDefault();

        const target = targetLine(list, event.clientY);

        if (target) {
            list.insertBefore(dragged, target);
        } else {
            list.append(dragged);
        }
    });

    document.addEventListener('drop', (event) => {
        const list = event.target.closest('[data-position]');

        if (!list || !dragged || !list.contains(dragged)) {
            return;
        }

        event.preventDefault();
        dragged = null;
        send(list);
    });
}

/* ── Gizli değer ─────────────────────────────────────────────────────────
 *
 * Parola sayfa kaynağında BULUNMAZ: göz simgesine basılınca `data-secret-source`
 * adresinden ayrı bir istekle alınır ve o istek sunucuda kayda geçer.
 * Kopyalama düğmesi yalnızca değer açıkken görünür.
 *
 * Kaynak verilmemişse (kılavuz örneği) kutudaki hazır değer gösterilir.
 */
function setupHiddenValue() {
    const mask = '••••••••';

    const open = async (box) => {
        const field = box.querySelector('[data-secret-value]');
        const show = box.querySelector('[data-secret-show]');
        const copy = box.querySelector('[data-secret-copy]');
        const source = box.dataset.secretSource;

        if (source) {
            const response = await fetch(source, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-TOKEN': document.querySelector('meta[name="csrf-token"]')?.content ?? '',
                },
            });

            field.textContent = (await response.json()).value ?? '';
        } else {
            field.textContent = box.dataset.secretExample ?? field.textContent;
        }

        box.dataset.secretOpen = 'true';
        show.setAttribute('aria-label', 'Hide password');
        copy?.removeAttribute('hidden');
    };

    const close = (box) => {
        box.querySelector('[data-secret-value]').textContent = mask;
        box.dataset.secretOpen = 'false';
        box.querySelector('[data-secret-show]')?.setAttribute('aria-label', 'Show password');
        box.querySelector('[data-secret-copy]')?.setAttribute('hidden', 'hidden');
    };

    document.addEventListener('click', (event) => {
        const show = event.target.closest('[data-secret-show]');

        if (show) {
            const box = show.closest('[data-secret]');

            if (box.dataset.secretOpen === 'true') {
                close(box);
            } else {
                open(box).catch(() => close(box));
            }

            return;
        }

        const copy = event.target.closest('[data-secret-copy], [data-copy-text]');

        if (!copy) {
            return;
        }

        const box = copy.closest('[data-secret], .secret');
        const text = box?.querySelector('[data-secret-value], [data-copy-source]')?.textContent?.trim();

        if (!text) {
            return;
        }

        navigator.clipboard?.writeText(text).then(
            () => notify('Copied to clipboard.', 'success'),
            () => notify('Clipboard unavailable; select the text manually.', 'danger'),
        );
    });
}

/* ── Toplu seçim ─────────────────────────────────────────────────────────
 *
 * Liste ekranlarındaki seçim çubuğu: kaç satır seçildiğini söyler ve seçim
 * boşken düğmeyi KAPALI tutar. Sayıyı ekranda tutmak, "hangi kayıtlara
 * uygulanacak" sorusunu tıklamadan yanıtlar.
 */
function setupBatchChoice() {
    const refresh = () => {
        const boxes = [...document.querySelectorAll('[data-bulk-item]')];
        const selected = boxes.filter((k) => k.checked);
        const counter = document.querySelector('[data-bulk-count]');
        const button = document.querySelector('[data-bulk-submit]');
        const all = document.querySelector('[data-bulk-all]');

        if (counter) {
            counter.textContent = String(selected.length);
        }

        if (button) {
            button.disabled = selected.length === 0;
        }

        if (all) {
            all.checked = boxes.length > 0 && selected.length === boxes.length;
            all.indeterminate = selected.length > 0 && selected.length < boxes.length;
        }
    };

    document.addEventListener('change', (event) => {
        if (event.target.matches('[data-bulk-all]')) {
            document.querySelectorAll('[data-bulk-item]:not(:disabled)').forEach((k) => {
                k.checked = event.target.checked;
            });
        }

        if (event.target.matches('[data-bulk-item], [data-bulk-all]')) {
            refresh();
        }
    });

    refresh();
}


/* ── Kayan şeritte doğru yere bakmak ─────────────────────────────────────
 *
 * Dar ekranda sütunlar yan yana sığmaz; şerit yatay kayar ve her bölme
 * neredeyse tam ekran kaplar. Şerit her çizimde en soldan başlıyordu:
 * telefonda bir kayda dokunan kişi hâlâ liste sütununa bakıyor, seçtiğinin
 * detayı ekranın dışında duruyordu.
 *
 * Kural TEK: en sağdaki GÖRÜNÜR bölme, kullanıcının indiği en derin
 * seviyedir. Aynı kural üst menü ve sekme şeridine de uygulanır — seçili
 * bölüm ortalanır.
 */
function setupLane() {
    const toSelectedSlide = (lane) => {
        const selected = lane.querySelector('[aria-current="page"]');

        if (!selected || lane.scrollWidth <= lane.clientWidth) {
            return;
        }

        lane.scrollLeft = selected.offsetLeft - (lane.clientWidth - selected.offsetWidth) / 2;
    };

    const widthToRightSlide = (lane) => {
        const compartments = [...lane.children]
            .filter((b) => b.matches('.column, .detail') && getComputedStyle(b).display !== 'none');

        const target = compartments.at(-1);

        /* Taşma yoksa (masaüstü) kaydırılacak bir şey de yok. */
        if (!target || lane.scrollWidth <= lane.clientWidth) {
            return;
        }

        lane.scrollTo({ left: target.offsetLeft - lane.offsetLeft, behavior: 'auto' });
    };

    document.querySelectorAll('.topbar__nav, .tabs').forEach(toSelectedSlide);
    document.querySelectorAll('.columns').forEach(widthToRightSlide);
}

/* ── Klavyeyle gezinme ───────────────────────────────────────────────────
 *
 * Bu tasarımın çekirdeği klavyedir: ↑↓ satırlar arasında dolaşır, → ya da
 * Enter seçili satırı açar, ← bir önceki sütuna döner, "/" filtreye
 * odaklanır. Fare olmadan da panelin tamamı gezilebilir.
 *
 * Yalnızca ODAK yönetilir; hangi satırın nereye gittiğine sunucunun ürettiği
 * bağlantı karar verir.
 */
const LINE_PICKER = '.row-item, .grid-row, a.switch-row, button.port-row';

function prepareLines() {
    document.querySelectorAll(LINE_PICKER).forEach((line) => {
        if (!line.hasAttribute('tabindex') && !['A', 'BUTTON'].includes(line.tagName)) {
            line.tabIndex = 0;
        }
    });
}

function setupKeyboard() {
    const columns = () => [...document.querySelectorAll('.columns .column, .columns .detail')];

    const lines = (column) => [...column.querySelectorAll(LINE_PICKER)]
        .filter((line) => line.offsetParent !== null);

    const writingField = (target) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName);

    const move = (column, direction) => {
        const list = lines(column);

        if (list.length === 0) {
            return;
        }

        const current = list.indexOf(document.activeElement);
        const next = current === -1 ? 0 : Math.min(list.length - 1, Math.max(0, current + direction));

        list[next].focus();
        list[next].scrollIntoView({ block: 'nearest' });
    };

    const neighbor = (column, direction) => {
        const list = columns();
        const next = list[list.indexOf(column) + direction];

        if (!next) {
            return;
        }

        const target = lines(next);

        (target.find((s) => s.getAttribute('aria-selected') === 'true') ?? target[0])?.focus();
        next.scrollIntoView({ inline: 'nearest', behavior: 'smooth' });
    };

    prepareLines();

    document.addEventListener('keydown', (event) => {
        if (!document.querySelector('.columns') || event.metaKey || event.ctrlKey || event.altKey) {
            return;
        }

        if (event.key === '/' && !writingField(event.target)) {
            event.preventDefault();
            document.querySelector('.filter__input')?.focus();

            return;
        }

        if (writingField(event.target)) {
            return;
        }

        const column = document.activeElement?.closest('.column, .detail') ?? columns().at(-1);

        if (!column) {
            return;
        }

        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                move(column, 1);
                break;
            case 'ArrowUp':
                event.preventDefault();
                move(column, -1);
                break;
            case 'ArrowRight':
                event.preventDefault();
                neighbor(column, 1);
                break;
            case 'ArrowLeft':
                event.preventDefault();
                neighbor(column, -1);
                break;
            default:
                break;
        }
    });
}

/* ── Bildirim (toast) ────────────────────────────────────────────────────
 *
 * Sayfada bir yuva bulunmalı:
 *
 *   <div class="toast-host"
 *        data-flash="{{ session('status') ?? session('error') ?? '' }}"
 *        data-flash-variant="{{ session('error') ? 'danger' : 'success' }}"></div>
 *
 * İKİ AYRI KULLANIM var ve ikisi de aynı kutudan çıkar:
 *
 *  - SUNUCUDAN: yönlendirmeden sonra `data-flash` doluysa sayfa açılırken
 *    kendiliğinden gösterilir (sunucuBildirimiKur).
 *  - BETİKTEN: `window.NdsTasarim.bildir(...)` ile, yerinde biten işler için.
 */
function notify(message, type = 'info') {
    const slot = document.querySelector('[data-toast-host], .toast-host');

    if (!slot) {
        return;
    }

    const box = document.createElement('div');

    box.className = `toast toast--${type}`;
    box.setAttribute('role', 'status');
    box.textContent = message;

    slot.append(box);

    setTimeout(() => box.remove(), duration(message));
}

/*
 * Uzun metin daha uzun durur.
 *
 * Süre sabitken uzun bir bildirim okunamadan kayboluyordu: kullanıcı "bir şey
 * yazdı ama ne yazdı" diye bakakalıyordu. Karakter başına küçük bir ek süre,
 * tavanla sınırlı.
 */
function duration(message) {
    return Math.min(4000 + message.length * 45, 12000);
}

/*
 * SUNUCUNUN SÖYLEDİĞİ EKRANA ÇIKAR.
 *
 * Kaydet/delete gibi işlemler yönlendirmeyle biter; sonucu yalnızca sunucu
 * bilir. Bu köprü olmadan işlem sessizce tamamlanır ve kullanıcı olup
 * olmadığını bilemez — kardeş projede tam olarak bu yaşandı: mesaj oturuma
 * bir anahtarla bırakılıp sayfada BAŞKA bir anahtarla aranıyordu.
 *
 * Gösterildikten sonra işaret silinir: sayfa geçişleri tam yenileme
 * yapmıyorsa aynı bildirim her geçişte yeniden çıkardı.
 */
function setupServerNotification() {
    const slot = document.querySelector('[data-toast-host], .toast-host');
    const message = slot?.dataset.flash;

    if (!message) {
        return;
    }

    notify(message, slot.dataset.flashVariant || 'success');
    delete slot.dataset.flash;
}

/* ── Süzgeç seçicileri ───────────────────────────────────────────────────
 *
 *   data-auto-submit   değeri değişince formunu gönderir
 *   data-navigate      seçilen DEĞER bir adrestir, oraya gidilir
 *
 * `requestSubmit()` kullanılır, `submit()` DEĞİL. `submit()` gönderim
 * olayını hiç tetiklemez; yenilemesiz gezinme o olayı dinlediği için
 * süzgeç her seçimde sayfayı baştan yüklüyordu (kullanıcı bildirimi,
 * 12.09.2026 — "dropdown geçişlerinde sayfa yenilemesi oluyor").
 *
 * Dinleyici `document` üzerindedir: yenilemesiz geçişten sonra gelen yeni
 * seçiciler için yeniden kurulum gerekmez.
 */
function setupFilter() {
    document.addEventListener('change', (event) => {
        const el = event.target;

        if (el.matches?.('[data-auto-submit]')) {
            el.form?.requestSubmit();

            return;
        }

        if (el.matches?.('[data-navigate]') && el.value) {
            /* Gezinme betiği varsa yenilemesiz gider; yoksa normal yükleme. */
            (window.ndsGit || ((address) => location.assign(address)))(el.value);
        }
    });
}

function init() {
    setupTheme();
    setupMenu();
    setupApproval();
    setupOrdering();
    setupHiddenValue();
    setupBatchChoice();
    setupLane();
    setupKeyboard();
    setupFilter();
    setupServerNotification();
}

init();

/* Dışarıya açılanlar: bildirim çağrısı ve satır hazırlama. */
window.NdsDesign = { notify, prepareLines, setupServerNotification };
