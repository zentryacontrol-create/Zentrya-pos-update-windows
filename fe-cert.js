// ═══════════════════════════════════════════════════════════════════════
// Zentrya POS — certificado digital para facturación electrónica (e-CF)
// El certificado (.p12/.pfx) y su contraseña:
//  · se validan y se guardan SOLO en el proceso principal de Windows, cifrados con el almacén seguro del
//    sistema operativo (Electron safeStorage → Windows DPAPI). Nunca en texto plano.
//  · nunca se envían a Supabase ni a GitHub ni quedan dentro del JavaScript de la página.
//  · se guardan separados por negocio: <datos de la app>/fe/<id-del-negocio>.bin
// A la página solo regresan datos NO secretos (titular, vigencia, huella).
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_OK = /^[A-Za-z0-9_-]{8,64}$/;
const DAY = 86400000;

function createFeCert({ safeStorage, dir, forge }) {
  const base = path.join(dir, 'fe');
  const fBin = (id) => path.join(base, id + '.bin');
  const fMeta = (id) => path.join(base, id + '.meta.json');
  const bad = (m) => ({ ok: false, error: m });

  function leer(b64, password) {
    let p12;
    try {
      const der = forge.util.decode64(String(b64 || ''));
      if (!der || der.length < 64) return { error: 'El archivo no parece un certificado .p12 / .pfx.' };
      p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, String(password || ''));
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/mac|password|decrypt|invalid/i.test(m)) return { error: 'La contraseña del certificado es incorrecta (o el archivo está dañado).' };
      return { error: 'El archivo no es un certificado .p12 / .pfx válido.' };
    }
    const keyBags = [].concat(
      p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || [],
      p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []);
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    if (!keyBags.length || !keyBags[0].key) return { error: 'El certificado no contiene la clave privada (se necesita para firmar).' };
    if (!certBags.length) return { error: 'El archivo no contiene ningún certificado.' };
    const key = keyBags[0].key;
    let cert = certBags.map((b) => b.cert).find((c) => c && c.publicKey && key.n && c.publicKey.n && c.publicKey.n.equals(key.n)) || certBags[0].cert;
    const attr = (list, n) => { const a = list.getField(n); return a ? a.value : ''; };
    const derCert = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    const sha = crypto.createHash('sha256').update(Buffer.from(derCert, 'binary')).digest('hex').toUpperCase().replace(/(..)(?=.)/g, '$1:');
    return {
      meta: {
        titular: attr(cert.subject, 'CN') || attr(cert.subject, 'O') || '',
        organizacion: attr(cert.subject, 'O'),
        pais: attr(cert.subject, 'C'),
        serie_subject: attr(cert.subject, 'serialNumber'),
        emisor: attr(cert.issuer, 'CN') || attr(cert.issuer, 'O') || '',
        serie: cert.serialNumber,
        desde: cert.validity.notBefore.toISOString(),
        hasta: cert.validity.notAfter.toISOString(),
        huella_sha256: sha,
        bits: key.n ? key.n.bitLength() : null,
      },
      subjectText: cert.subject.attributes.map((a) => String(a.value)).join(' '),
    };
  }

  const vigencia = (meta) => {
    const now = Date.now(), h = Date.parse(meta.hasta), d = Date.parse(meta.desde);
    const dias = Math.floor((h - now) / DAY);
    const estado = now < d ? 'aun_no_vigente' : now > h ? 'vencido' : dias <= 30 ? 'por_vencer' : 'vigente';
    return { estado, dias_restantes: dias };
  };

  return {
    // Guarda (cifrado) el certificado de UN negocio. Devuelve solo datos no secretos.
    save({ empresaId, b64, password, rnc }) {
      if (!ID_OK.test(String(empresaId || ''))) return bad('Negocio no válido.');
      if (!password) return bad('Escribe la contraseña del certificado.');
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return bad('Este equipo no tiene almacenamiento seguro disponible; por seguridad no se guarda el certificado.');
      const r = leer(b64, password);
      if (r.error) return bad(r.error);
      const v = vigencia(r.meta);
      if (v.estado === 'vencido') return bad('El certificado está VENCIDO desde ' + r.meta.hasta.slice(0, 10) + '. Necesitas uno vigente.');
      if (v.estado === 'aun_no_vigente') return bad('El certificado todavía no es vigente (desde ' + r.meta.desde.slice(0, 10) + ').');
      const digits = String(rnc || '').replace(/\D/g, '');
      const coincide = digits ? (r.subjectText + ' ' + r.meta.serie_subject).replace(/\D/g, '').includes(digits) : null;
      const enc = safeStorage.encryptString(JSON.stringify({ p12: String(b64), password: String(password) }));
      fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(fBin(empresaId), enc, { mode: 0o600 });
      const meta = Object.assign({}, r.meta, { guardado: new Date().toISOString(), rnc_coincide: coincide });
      fs.writeFileSync(fMeta(empresaId), JSON.stringify(meta), { mode: 0o600 });
      return { ok: true, meta: Object.assign({}, meta, vigencia(meta)) };
    },
    // Datos NO secretos del certificado guardado
    info(empresaId) {
      if (!ID_OK.test(String(empresaId || ''))) return bad('Negocio no válido.');
      if (!fs.existsSync(fMeta(empresaId)) || !fs.existsSync(fBin(empresaId))) return { ok: true, cargado: false };
      try { const m = JSON.parse(fs.readFileSync(fMeta(empresaId), 'utf8')); return { ok: true, cargado: true, meta: Object.assign({}, m, vigencia(m)) }; }
      catch (_) { return { ok: true, cargado: false }; }
    },
    // Descifra y vuelve a comprobar que la contraseña abre el certificado y que sigue vigente
    validate(empresaId) {
      if (!ID_OK.test(String(empresaId || ''))) return bad('Negocio no válido.');
      if (!fs.existsSync(fBin(empresaId))) return bad('No hay un certificado cargado para este negocio.');
      let s;
      try { s = JSON.parse(safeStorage.decryptString(fs.readFileSync(fBin(empresaId)))); }
      catch (_) { return bad('No se pudo abrir el certificado guardado (¿otro usuario de Windows o equipo?). Cárgalo de nuevo.'); }
      const r = leer(s.p12, s.password);
      if (r.error) return bad(r.error);
      return { ok: true, meta: Object.assign({}, r.meta, vigencia(r.meta)) };
    },
    remove(empresaId) {
      if (!ID_OK.test(String(empresaId || ''))) return bad('Negocio no válido.');
      [fBin(empresaId), fMeta(empresaId)].forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
      return { ok: true };
    },
    // USO INTERNO (firma futura): nunca se expone por IPC
    _cargar(empresaId) {
      if (!ID_OK.test(String(empresaId || '')) || !fs.existsSync(fBin(empresaId))) return null;
      try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(fBin(empresaId)))); } catch (_) { return null; }
    },
  };
}

module.exports = { createFeCert };
