// ═══════════════════════════════════════════════════════════════════════
// Zentrya POS — actualizaciones automáticas desde GitHub Releases
//  · Revisa al abrir, cada 15 min y cada vez que se vuelve a la ventana. Descarga en SEGUNDO PLANO (el cajero sigue vendiendo).
//  · Cuando la descarga termina, la pantalla muestra una tarjeta OBLIGATORIA "Actualizar ahora".
//  · Al pulsar, se instala en silencio y la app se vuelve a abrir sola.
// Solo actúa en la app instalada (no con "npm start").
// ═══════════════════════════════════════════════════════════════════════
const MIN = 60 * 1000;

function initUpdater({ app, ipcMain, getWindow, loadUpdater }) {
  let upd = { estado: 'idle' };
  let au = null;

  const send = (s) => {
    upd = s;
    const w = getWindow && getWindow();
    if (w && !w.isDestroyed()) { try { w.webContents.send('zp-update', s); } catch (_) {} }
  };

  ipcMain.handle('zp-update-state', () => upd);
  ipcMain.handle('zp-update-install', () => {
    if (!au || upd.estado !== 'lista') return false;
    send({ estado: 'instalando', version: upd.version });
    // (silencioso, volver a abrir la app al terminar)
    setTimeout(() => { try { au.quitAndInstall(true, true); } catch (_) {} }, 600);
    return true;
  });

  if (!app.isPackaged) return { state: () => upd };
  try { au = (loadUpdater || (() => require('electron-updater').autoUpdater))(); } catch (_) { return { state: () => upd }; }
  if (!au) return { state: () => upd };

  au.autoDownload = true;
  au.autoInstallOnAppQuit = true;   // si cierran la app con la actualización lista, se instala al salir
  au.allowPrerelease = false;
  au.logger = null;

  au.on('update-available', (i) => send({ estado: 'descargando', version: i && i.version, pct: 0 }));
  au.on('download-progress', (p) => send({ estado: 'descargando', version: upd.version, pct: Math.max(0, Math.min(100, Math.round((p && p.percent) || 0))) }));
  au.on('update-downloaded', (i) => send({ estado: 'lista', version: (i && i.version) || upd.version }));
  au.on('error', () => { if (upd.estado === 'descargando') send({ estado: 'error', version: upd.version }); });

  // Revisa GitHub. Con "force" ignora el límite de tiempo (botón Reintentar).
  let lastCheck = 0;
  const check = (force) => {
    if (upd.estado === 'lista' || upd.estado === 'instalando') return;
    const now = Date.now();
    if (!force && now - lastCheck < 2 * MIN) return;
    lastCheck = now;
    try { Promise.resolve(au.checkForUpdates()).catch(() => {}); } catch (_) {}
  };
  ipcMain.handle('zp-update-retry', () => { check(true); return true; });
  setTimeout(() => check(true), 3 * 1000);   // al abrir: casi de inmediato
  setInterval(check, 15 * MIN);              // y cada 15 min
  return { state: () => upd, check };
}

module.exports = { initUpdater };
