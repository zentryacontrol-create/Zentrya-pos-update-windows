// ═══════════════════════════════════════════════════════════════════════
// Zentrya POS para Windows — proceso principal (Electron)
// - Permisos de Bluetooth, USB y puerto serie con selector de dispositivos
// - Impresión directa (ESC/POS) a impresoras instaladas en Windows y por WiFi/LAN
// ═══════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, ipcMain, session, protocol, shell, Menu, safeStorage, net: electronNet } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { initUpdater } = require('./updater');

const APP_DIR = path.join(__dirname, 'app');
const APP_URL = 'app://zentrya/index.html';

// La app se sirve desde un esquema propio y "seguro": hace falta contexto seguro
// para Web Bluetooth / WebUSB / Web Serial, y así localStorage (sesión, correo y
// contraseña recordados) queda estable entre ejecuciones.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) { app.quit(); }

let mainWindow = null;
const isAppOrigin = (u) => typeof u === 'string' && u.startsWith('app://');

// ───────────────────────── Ventana de selección de dispositivo ─────────────────────────
const pickers = new Map(); // webContents.id -> { finish }

function showPicker({ title, hint }, onResult) {
  const win = new BrowserWindow({
    parent: mainWindow || undefined, modal: !!mainWindow,
    width: 440, height: 540, resizable: false, minimizable: false, maximizable: false,
    show: false, autoHideMenuBar: true, title,
    webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  const st = { done: false, items: [], win };
  const id = win.webContents.id;
  const finish = (choice) => {
    if (st.done) return;
    st.done = true;
    pickers.delete(id);
    try { onResult(choice); } catch (_) {}
    if (!win.isDestroyed()) win.destroy();
  };
  st.finish = finish;
  st.update = (items) => {
    st.items = items;
    if (!win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send('picker-items', items);
  };
  pickers.set(id, st);
  win.loadFile(path.join(__dirname, 'picker.html'));
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('picker-init', { title, hint });
    win.webContents.send('picker-items', st.items);
    win.show();
  });
  win.on('closed', () => finish(null));
  return st;
}
ipcMain.on('picker-choose', (e, choice) => { const st = pickers.get(e.sender.id); if (st) st.finish(String(choice)); });
ipcMain.on('picker-cancel', (e) => { const st = pickers.get(e.sender.id); if (st) st.finish(null); });

// ───────────────────────── Ventana principal ─────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366, height: 850, minWidth: 1000, minHeight: 640,
    show: false, backgroundColor: '#FFFFFF', title: 'Zentrya POS',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Pantalla de inicio: logo centrado sin fondo durante 4 s y luego la aplicación
  const splash = new BrowserWindow({
    width: 460, height: 460, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    center: true, show: true, alwaysOnTop: true, skipTaskbar: true, transparent: true, hasShadow: false, backgroundColor: '#00000000', title: 'Zentrya POS',
    icon: path.join(__dirname, 'build', 'icon.png'),
  });
  splash.setMenu(null);
  splash.loadFile(path.join(__dirname, 'splash.html'));
  let minTime = false, ready = false, shown = false;
  const reveal = () => {
    if (shown || !minTime || !ready) return;
    shown = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    if (!splash.isDestroyed()) splash.close();
  };
  setTimeout(() => { minTime = true; reveal(); }, 4000);
  mainWindow.once('ready-to-show', () => { ready = true; reveal(); });
  mainWindow.on('closed', () => { if (!splash.isDestroyed()) splash.close(); });
  mainWindow.on('closed', () => { mainWindow = null; });

  // Enlaces externos (WhatsApp, correo, web) → navegador/aplicación del sistema
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:|tel:|whatsapp:)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppOrigin(url)) { event.preventDefault(); if (/^(https?:|mailto:|tel:|whatsapp:)/i.test(url)) shell.openExternal(url); }
  });

  // ── Bluetooth (Web Bluetooth) ──
  let btPicker = null, btCallback = null;
  mainWindow.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    btCallback = callback;
    if (!btPicker || btPicker.done) {
      btPicker = showPicker(
        { title: 'Impresoras Bluetooth', hint: 'Enciende la impresora y elígela en la lista. Buscando…' },
        (choice) => { const cb = btCallback; btPicker = null; btCallback = null; if (cb) cb(choice || ''); }
      );
    }
    btPicker.update(devices.map((d) => ({ id: d.deviceId, name: d.deviceName || 'Dispositivo sin nombre', sub: d.deviceId })));
  });
  // Emparejamiento (Windows): confirmar automáticamente
  mainWindow.webContents.session.setBluetoothPairingHandler((details, callback) => {
    if (details.pairingKind === 'confirm' || details.pairingKind === 'confirmPin') callback({ confirmed: true });
    else callback({ confirmed: false });
  });

  mainWindow.loadURL(APP_URL);
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.zentrya.pos.windows');

  protocol.handle('app', (request) => {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(APP_DIR, p));
    if (!file.startsWith(APP_DIR)) return new Response('Prohibido', { status: 403 });
    return electronNet.fetch(pathToFileURL(file).toString());
  });

  const ses = session.defaultSession;

  // ── Permisos: Bluetooth, USB, serie, portapapeles, etc. solo para la app ──
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(isAppOrigin((details && details.requestingUrl) || wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => isAppOrigin(origin) || isAppOrigin(wc && wc.getURL()));
  ses.setDevicePermissionHandler((details) => isAppOrigin(details.origin));

  // ── USB (WebUSB) ──
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const items = (details.deviceList || []).map((d) => ({
      id: d.deviceId,
      name: d.productName || 'Dispositivo USB',
      sub: 'VID ' + (d.vendorId || 0).toString(16).padStart(4, '0') + ' · PID ' + (d.productId || 0).toString(16).padStart(4, '0') + (d.manufacturerName ? ' · ' + d.manufacturerName : ''),
    }));
    const st = showPicker({ title: 'Impresoras USB', hint: 'Elige tu impresora USB.' }, (choice) => callback(choice || undefined));
    st.update(items);
  });

  // ── Puerto serie (USB con COM virtual / Bluetooth clásico emparejado) ──
  ses.on('select-serial-port', (event, portList, webContents, callback) => {
    event.preventDefault();
    const items = (portList || []).map((p) => ({
      id: p.portId,
      name: p.displayName || p.portName || 'Puerto serie',
      sub: p.portName + (p.vendorId ? ' · VID ' + Number(p.vendorId).toString(16) : ''),
    }));
    const st = showPicker({ title: 'Puertos serie (COM)', hint: 'Elige el puerto de tu impresora.' }, (choice) => callback(choice || ''));
    st.update(items);
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Editar', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Ver', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));

  createWindow();
  // Actualizaciones automáticas desde GitHub (descarga en segundo plano; la instalación es obligatoria)
  const up = initUpdater({ app, ipcMain, getWindow: () => mainWindow });
  if (mainWindow && up && up.check) mainWindow.on('focus', () => up.check());   // al volver a la ventana, revisa de nuevo
});

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});
app.on('window-all-closed', () => app.quit());

// ───────────────────────── Impresión directa ─────────────────────────
const fromApp = (e) => mainWindow && e.sender === mainWindow.webContents && isAppOrigin(e.senderFrame && e.senderFrame.url);

ipcMain.handle('zp-list-printers', async (e) => {
  if (!fromApp(e)) return [];
  const list = await mainWindow.webContents.getPrintersAsync();
  return list.map((p) => ({ name: p.name, isDefault: !!p.isDefault }));
});

ipcMain.handle('zp-lan-check', (e, o) => new Promise((resolve) => {
  if (!fromApp(e)) return resolve({ ok: false, error: 'No permitido' });
  const host = String((o && o.host) || ''), port = Number(o && o.port) || 9100;
  if (!/^[\w.\-:]+$/.test(host)) return resolve({ ok: false, error: 'IP inválida' });
  const s = new net.Socket();
  s.setTimeout(4000);
  s.once('connect', () => { s.destroy(); resolve({ ok: true }); });
  s.once('timeout', () => { s.destroy(); resolve({ ok: false, error: 'Sin respuesta de ' + host + ':' + port }); });
  s.once('error', (err) => resolve({ ok: false, error: 'No se pudo conectar: ' + err.message }));
  s.connect(port, host);
}));

function sendLan(host, port, buf) {
  return new Promise((resolve, reject) => {
    const s = new net.Socket();
    s.setTimeout(8000);
    s.once('timeout', () => { s.destroy(); reject(new Error('La impresora WiFi no respondió')); });
    s.once('error', reject);
    s.connect(port, host, () => s.end(buf, resolve));
  });
}

// Envío "RAW" a una impresora instalada en Windows (cola del spooler), sin driver gráfico.
const PS_RAW = `
param([string]$PrinterName,[string]$DataFile)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ZRawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true)]
  public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true)]
  public static extern bool StartDocPrinter(IntPtr h, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool WritePrinter(IntPtr h, IntPtr pBytes, Int32 count, out Int32 written);
  public static void Send(string printer, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("No se pudo abrir la impresora '" + printer + "' (error " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFOA di = new DOCINFOA(); di.pDocName = "Zentrya"; di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter fallo (" + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter fallo (" + Marshal.GetLastWin32Error() + ")");
        IntPtr p = Marshal.AllocCoTaskMem(data.Length);
        try {
          Marshal.Copy(data, 0, p, data.Length);
          int w;
          if (!WritePrinter(h, p, data.Length, out w) || w != data.Length) throw new Exception("WritePrinter fallo (" + Marshal.GetLastWin32Error() + ")");
        } finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
[ZRawPrint]::Send($PrinterName, [System.IO.File]::ReadAllBytes($DataFile))
`;

function sendSpooler(name, buf) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('La impresión por Windows solo funciona en Windows'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zentrya-'));
    const ps1 = path.join(dir, 'raw.ps1');
    const bin = path.join(dir, 'job.bin');
    fs.writeFileSync(ps1, '\uFEFF' + PS_RAW, 'utf8');
    fs.writeFileSync(bin, buf);
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const ch = spawn(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-PrinterName', name, '-DataFile', bin], { windowsHide: true });
    let err = '';
    ch.stderr.on('data', (d) => { err += d.toString(); });
    ch.on('error', (e) => { cleanup(); reject(e); });
    ch.on('close', (code) => {
      cleanup();
      if (code === 0) resolve(); else reject(new Error((err.trim().split('\n')[0]) || ('Error de impresión (' + code + ')')));
    });
    function cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  });
}

ipcMain.handle('zp-raw-print', async (e, o) => {
  try {
    if (!fromApp(e)) throw new Error('No permitido');
    const buf = Buffer.from(String(o.b64 || ''), 'base64');
    if (!buf.length) throw new Error('Sin datos para imprimir');
    if (o.kind === 'lan') {
      const host = String(o.host || ''), port = Number(o.port) || 9100;
      if (!/^[\w.\-:]+$/.test(host)) throw new Error('IP inválida');
      await sendLan(host, port, buf);
    } else if (o.kind === 'spooler') {
      const name = String(o.name || '');
      if (!name) throw new Error('Falta el nombre de la impresora');
      await sendSpooler(name, buf);
    } else {
      throw new Error('Tipo de impresora desconocido');
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ───────────────────────── Facturación electrónica: certificado digital (seguro) ─────────────────────────
// El certificado y su contraseña se guardan CIFRADOS (Windows DPAPI vía safeStorage) en el equipo, por negocio.
// La página solo recibe datos no secretos (titular, vigencia, huella). Nada va a Supabase ni a GitHub.
let feCert = null;
function getFeCert() {
  if (feCert) return feCert;
  try {
    const { createFeCert } = require('./fe-cert');
    feCert = createFeCert({ safeStorage, dir: app.getPath('userData'), forge: require('node-forge') });
  } catch (_) { feCert = null; }
  return feCert;
}
const feNo = { ok: false, error: 'Módulo de certificados no disponible en esta instalación.' };
ipcMain.handle('zp-fe-cert-save', (e, o) => { if (!fromApp(e)) return { ok: false, error: 'No autorizado' }; const f = getFeCert(); return f ? f.save(o || {}) : feNo; });
ipcMain.handle('zp-fe-cert-info', (e, id) => { if (!fromApp(e)) return { ok: false, error: 'No autorizado' }; const f = getFeCert(); return f ? f.info(id) : feNo; });
ipcMain.handle('zp-fe-cert-validate', (e, id) => { if (!fromApp(e)) return { ok: false, error: 'No autorizado' }; const f = getFeCert(); return f ? f.validate(id) : feNo; });
ipcMain.handle('zp-fe-cert-delete', (e, id) => { if (!fromApp(e)) return { ok: false, error: 'No autorizado' }; const f = getFeCert(); return f ? f.remove(id) : feNo; });
