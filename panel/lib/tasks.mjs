/**
 * Yan gorevler: kuyruga girmeyen kisa isler (sahne yazari: yerel yazi modeli; panel isi surerken ekran kartini bekler). Calisirken
 * Kuyruk panelinde ilerlemesiyle gorunur, iptal edilebilir. Kuyruk tek seritli: sahne yazimi oraya konsa film
 * bitene kadar beklerdi. Kalici degil (panel yeniden acilinca bos). 07.10.2026 kullanici: "Sahneleri yaz'a
 * tiklayinca ilerleme gostergesine dusmuyor".
 */
export class Tasks {
  constructor() {
    this.map = new Map();
    this.counter = 0;
  }

  /**
   * Yeni gorev. beklenenSn: olculen ortalamadan tahmini sure (yoksa ilerleme belirsiz gosterilir).
   * Doner: { id, sinyal, ilerle({ oran?, asama?, ayrinti? }), bitir() }; oran 0-1 (bitmis obek payi).
   */
  add({ type, title, expectedSec = null }) {
    this.counter += 1;
    const id = `gorev-${Date.now().toString(36)}-${this.counter}`;
    const control = new AbortController();
    const g = { id, type, status: 'running', summary: { title }, start: Date.now(), expectedSec, ratio: 0, stage: '', detail: '', control };
    this.map.set(id, g);
    return {
      id,
      signal: control.signal,
      advance: ({ ratio, stage, detail } = {}) => {
        if (Number.isFinite(ratio)) g.ratio = Math.max(g.ratio, Math.min(1, ratio));
        if (stage !== undefined) g.stage = stage;
        if (detail !== undefined) g.detail = detail;
      },
      finish: () => {
        this.map.delete(id);
      },
    };
  }

  /** Calisan gorevi durdurur (sureci olur); yoksa false. */
  cancel(id) {
    const g = this.map.get(id);
    if (!g) return false;
    g.status = 'cancelled';
    g.detail = 'Cancelling…';
    g.control.abort();
    return true;
  }

  /** Arayuz ozeti: yuzde = bitmis obek payi ile gecen/beklenen surenin buyugu (en cok 95); olcum yoksa null (belirsiz). */
  list() {
    const now = Date.now();
    return [...this.map.values()].map((g) => {
      const duration = (now - g.start) / 1000;
      const time = g.expectedSec ? Math.min(95, (duration / g.expectedSec) * 100) : null;
      const chunk = g.ratio > 0 ? g.ratio * 100 : null;
      const percent = time === null && chunk === null ? null : Math.round(Math.min(99, Math.max(time ?? 0, chunk ?? 0)));
      return { id: g.id, type: g.type, status: g.status, summary: g.summary, start: new Date(g.start).toISOString(), duration: Math.round(duration), progress: { percent, stage: g.stage, detail: g.detail } };
    });
  }
}
