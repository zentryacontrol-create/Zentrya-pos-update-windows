# Zentrya POS — Windows (Electron)

## Probar
    npm install
    npm start

## Crear instalador
    npm run dist        -> dist/Zentrya-POS-Setup-1.0.0.exe
(En Windows, o con GitHub Actions: .github/workflows/build-exe.yml)

## Impresora
- Bluetooth, USB y Serial: el selector de dispositivos de la app (ventana "Impresoras USB"/Bluetooth). Permisos concedidos solo al origen de la app.
- Impresoras instaladas en Windows (USB/red): botón "Impresora de Windows" (impresión RAW por el spooler).
- WiFi/red local: IP + puerto 9100.

## Notas
- El instalador no está firmado: Windows SmartScreen mostrará "Más información > Ejecutar de todos modos".
- Instalación por usuario (sin administrador).
- No probado en un Windows real ni con impresoras físicas.

## Actualizaciones automáticas (GitHub) — obligatorias
Los POS instalados se actualizan solos desde GitHub Releases:
1. Al abrir (y cada 30 min) la app revisa si hay una versión nueva en GitHub.
2. Si la hay, la **descarga en segundo plano** (se puede seguir vendiendo; sale una tarjeta pequeña con el avance).
3. Al terminar sale una **tarjeta obligatoria** "Actualización obligatoria · Actualizar ahora" (sin botón para omitir). Al pulsar, se instala en silencio y la app se abre sola.
   Si cierran el POS con la actualización ya descargada, se instala al salir.

### Configuración (una sola vez)
1. Crea un repositorio **público** en GitHub (ej. `zentrya-pos`).
2. En `package.json` → `build.publish` ya están configurados: usuario `zentryacontrol-create`, repositorio `Zentrya-pos-update-windows`.
3. Sube este proyecto al repositorio.
4. En GitHub: Settings → Actions → General → Workflow permissions → **Read and write permissions**.

### Publicar una actualización
1. En `package.json` sube `"version"` (de `1.0.0` a `1.0.1`, etc.). **Sin subir la versión nadie se actualiza.**
2. Haz commit y crea la etiqueta:  `git tag v1.0.1`  y  `git push origin v1.0.1`
   (la etiqueta debe coincidir con la versión).
3. GitHub Actions (`.github/workflows/publicar-actualizacion.yml`) genera el instalador y lo publica en **Releases**.
   Alternativa en tu Windows: `set GH_TOKEN=tu_token` y `npm run publicar`.
4. Los POS instalados reciben la tarjeta de actualización.

### Notas
- Los clientes que tienen una versión **anterior sin esta función** deben instalar una vez el `.exe` nuevo a mano; después se actualizan solos.
- Solo funciona en la app instalada (no con `npm start`).
- Probado: la lógica del actualizador con un simulador y la tarjeta en pantalla. **No probado**: descarga e instalación reales en un Windows con GitHub.

## Facturación electrónica DGII (e-CF) — primera etapa: configuración y certificado
Botón **⚡ Activar facturación electrónica DGI** en Configuración (abre una tarjeta): RNC, razón social, datos fiscales, ambiente
(pruebas / certificación / producción), autorización declarada y carga/validación del certificado digital (.p12/.pfx).
- El certificado y su contraseña se validan y guardan **solo en esta app de Windows, cifrados con DPAPI (safeStorage)**, uno por negocio
  (`fe-cert.js`). Nunca van a Supabase, GitHub ni quedan en el JavaScript de la página. En el teléfono/navegador no se cargan.
- Supabase solo guarda datos NO secretos (`zentrya-pos-facturacion-electronica.sql` → tabla `pos_fe_config`).
- **No implementado todavía**: conexión con la DGII (semilla/token, XML, firma, envío, TrackId, notas de crédito). No se emite ni se marca
  ningún e-CF; la facturación tradicional no cambia.
- Requiere `npm install` (agrega `node-forge`).
