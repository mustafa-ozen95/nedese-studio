/**
 * ComfyUI'yi ev agina aktarir: <panel adresi>:8189 -> 127.0.0.1:8188 (ham TCP: HTTP ve
 * WebSocket ayni yoldan). ComfyUI yalniz bu makinede dinler; Windows guvenlik duvari
 * python.exe'yi kapattigi icin agdan dogrudan erisilemez, panelin Node'u ise izinlidir.
 *
 * Yalniz yerel ve ozel ag adreslerinden (10/8, 172.16/12, 192.168/16, 127/8) baglanti
 * kabul edilir; digerleri hemen kapatilir. Sifre yok: guvenilen agda acik tutun.
 */
import { createConnection, createServer } from 'node:net';

const CUSTOM_NETWORK = /^(?:::ffff:)?(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)|^::1$/;

export function isCustomNetwork(address) {
  return CUSTOM_NETWORK.test(String(address ?? ''));
}

export function createComfyProxy({ target = 'http://127.0.0.1:8188', port = 8189, address = '0.0.0.0', log = () => {} } = {}) {
  const u = new URL(target);
  const server = createServer((client) => {
    if (!isCustomNetwork(client.remoteAddress)) {
      client.destroy();
      return;
    }
    const comfy = createConnection({ host: u.hostname, port: Number(u.port || 8188) });
    client.pipe(comfy).pipe(client);
    const close = () => {
      client.destroy();
      comfy.destroy();
    };
    client.on('error', close);
    comfy.on('error', close);
  });
  server.on('error', (e) => log(`Could not open the ComfyUI forwarder (${port}): ${e.code ?? e.message}`));
  server.listen(port, address);
  return server;
}
