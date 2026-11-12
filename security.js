const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

// ---------- Contraseña de acceso (HTTP Basic) ----------
// Si defines APP_USER y APP_PASSWORD, toda la app pide usuario y contraseña.
// En producción sin credenciales la app se niega a responder (falla cerrado),
// para que nunca quede un clonador abierto a todo internet por descuido.
function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function basicAuth(req, res, next) {
  const user = process.env.APP_USER;
  const pass = process.env.APP_PASSWORD;

  if (!user || !pass) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).send('Configura APP_USER y APP_PASSWORD para usar esta app en producción.');
    }
    return next(); // desarrollo local: sin contraseña
  }

  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const idx = decoded.indexOf(':');
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    const okUser = crypto.timingSafeEqual(digest(u), digest(user));
    const okPass = crypto.timingSafeEqual(digest(p), digest(pass));
    if (idx >= 0 && okUser && okPass) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Website Cloner"');
  return res.status(401).send('Autenticación requerida');
}

// ---------- Protección SSRF ----------
// Impide que alguien use tu servidor para leer direcciones internas
// (localhost, redes privadas, metadatos de la nube, etc.).
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
    if (l.startsWith('::ffff:')) {
      const rest = l.slice(7);
      return net.isIPv4(rest) ? isPrivateIp(rest) : true;
    }
    return false;
  }
  return true; // formato desconocido: por seguridad se bloquea
}

async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('La URL no es válida.'); }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Solo se permiten URLs http:// o https://');
  }
  let addrs;
  try {
    addrs = await dns.lookup(u.hostname, { all: true });
  } catch {
    throw new Error('No se pudo resolver el dominio de la URL.');
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('Esa dirección apunta a una red privada o interna y está bloqueada.');
  }
}

module.exports = { basicAuth, assertPublicUrl, isPrivateIp };
