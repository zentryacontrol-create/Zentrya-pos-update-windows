const { contextBridge, ipcRenderer } = require('electron');

// Interfaz mínima para que la página pueda imprimir (ESC/POS) en Windows y por WiFi.
contextBridge.exposeInMainWorld('electronAPI', {
  zentryaPrint: true,
  listPrinters: () => ipcRenderer.invoke('zp-list-printers'),
  lanCheck: (o) => ipcRenderer.invoke('zp-lan-check', o),
  rawPrint: (o) => ipcRenderer.invoke('zp-raw-print', o),
  // Certificado digital de facturación electrónica (se guarda cifrado en Windows; la página nunca lo conserva)
  feCertSave: (o) => ipcRenderer.invoke('zp-fe-cert-save', o),
  feCertInfo: (id) => ipcRenderer.invoke('zp-fe-cert-info', id),
  feCertValidate: (id) => ipcRenderer.invoke('zp-fe-cert-validate', id),
  feCertDelete: (id) => ipcRenderer.invoke('zp-fe-cert-delete', id),
});

// ───────────────────────── Actualizaciones (tarjeta en pantalla) ─────────────────────────
// 1) Mientras se descarga en segundo plano: tarjeta pequeña abajo a la derecha (se puede seguir vendiendo).
// 2) Cuando está lista: tarjeta OBLIGATORIA a pantalla completa con el botón "Actualizar ahora".
(function () {
  const GOLD = '#D9A441';
  let ov = null, ui = null, last = null;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const FONT = "font-family:'Inter','Segoe UI',Arial,sans-serif;";

  function quitar() { if (ov && ov.parentNode) ov.parentNode.removeChild(ov); ov = null; }
  function montar(html, bloqueante) {
    if (!document.body) return null;
    if (!ov || !ov.isConnected) {
      ov = document.createElement('div');
      ov.id = 'zp-update-ov';
      document.body.appendChild(ov);
    }
    ov.setAttribute('data-zok', '1');
    ov.style.cssText = bloqueante
      ? 'position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.72);display:flex;align-items:center;justify-content:center;padding:20px;' + FONT
      : 'position:fixed;right:16px;bottom:16px;z-index:2147483646;width:340px;max-width:calc(100vw - 32px);' + FONT;
    ov.innerHTML = html;
    return ov;
  }
  function pintar(s) {
    last = s;
    if (!s || s.estado === 'idle') return quitar();
    const v = s.version ? 'v' + esc(s.version) : '';
    if (s.estado === 'descargando' || s.estado === 'error') {
      const pct = s.estado === 'error' ? 0 : (s.pct || 0);
      montar(
        '<div style="background:#fff;color:#1F2937;border:1.5px solid ' + GOLD + ';border-radius:14px;padding:14px 16px;box-shadow:0 10px 30px rgba(0,0,0,.25);">' +
        '<div style="font-weight:800;font-size:14px;">🔄 Nueva actualización ' + v + '</div>' +
        '<div style="font-size:12px;color:#6B7280;margin:4px 0 10px;line-height:1.45;">' +
        (s.estado === 'error' ? 'No se pudo descargar la nueva versión. Revisa tu internet; se reintentará automáticamente.' : 'Descargando en segundo plano… puedes seguir vendiendo. Al terminar deberás actualizar.') + '</div>' +
        (s.estado === 'error' ? '<button id="zp-update-retry" style="width:100%;padding:9px;border:0;border-radius:10px;background:' + GOLD + ';color:#fff;font-weight:800;font-size:13px;cursor:pointer;margin-bottom:4px;' + FONT + '">Reintentar ahora</button>' : '') +
        '<div style="height:8px;border-radius:6px;background:#F3EAD3;overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:' + GOLD + ';transition:width .3s;"></div></div>' +
        '<div style="font-size:11px;color:#6B7280;margin-top:5px;text-align:right;">' + (s.estado === 'error' ? '' : pct + ' %') + '</div></div>', false);
      const rb = ov && ov.querySelector('#zp-update-retry');
      if (rb) rb.onclick = function () { rb.disabled = true; rb.textContent = 'Buscando…'; ipcRenderer.invoke('zp-update-retry').catch(() => {}); };
      return;
    }
    if (s.estado === 'lista' || s.estado === 'instalando') {
      const inst = s.estado === 'instalando';
      const o = montar(
        '<div style="background:#fff;color:#1F2937;border-radius:18px;padding:26px 24px;width:100%;max-width:420px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.45);border:2px solid ' + GOLD + ';">' +
        '<div style="font-size:38px;line-height:1;">🔄</div>' +
        '<div style="font-weight:900;font-size:19px;margin:10px 0 6px;">Actualización obligatoria ' + v + '</div>' +
        '<div style="font-size:13px;color:#6B7280;line-height:1.55;margin-bottom:18px;">' +
        (inst ? 'Instalando la nueva versión… Zentrya POS se abrirá solo en unos segundos. <b>No lo cierres.</b>'
              : 'Hay una nueva versión de Zentrya POS lista. Para seguir usando el sistema debes actualizar.<br>Si estás en medio de una venta, termínala y pulsa el botón. La app se reiniciará sola.') + '</div>' +
        '<button id="zp-update-go" ' + (inst ? 'disabled' : '') + ' style="width:100%;padding:14px;border:0;border-radius:12px;background:' + GOLD + ';color:#fff;font-weight:800;font-size:15px;cursor:pointer;' + (inst ? 'opacity:.6;' : '') + FONT + '">' + (inst ? 'Instalando…' : 'Actualizar ahora') + '</button></div>', true);
      const b = o && o.querySelector('#zp-update-go');
      if (b && !inst) b.onclick = function () { b.disabled = true; b.textContent = 'Preparando…'; ipcRenderer.invoke('zp-update-install').catch(() => {}); };
    }
  }

  ipcRenderer.on('zp-update', (_e, s) => pintar(s));
  function iniciar() {
    ipcRenderer.invoke('zp-update-state').then(pintar).catch(() => {});
    // Si la actualización es obligatoria y la página intenta quitar la tarjeta, se vuelve a poner
    try {
      new MutationObserver(() => { if (last && (last.estado === 'lista' || last.estado === 'instalando') && (!ov || !ov.isConnected)) pintar(last); })
        .observe(document.body, { childList: true });
    } catch (_) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
