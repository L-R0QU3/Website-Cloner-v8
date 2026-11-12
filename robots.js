const axios = require('axios');
const { URL } = require('url');

// Parser simplificado: solo lee el bloque "User-agent: *" y sus reglas Disallow/Crawl-delay.
// No implementa el spec completo de robots.txt (ej. no resuelve Allow más específico que Disallow),
// pero cubre los casos más comunes para evitar rutas explícitamente bloqueadas.
function parseRobots(text) {
  const lines = text.split('\n').map((l) => l.trim());
  let inWildcardBlock = false;
  const disallow = [];
  let crawlDelay = 0;

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      inWildcardBlock = value === '*';
    } else if (inWildcardBlock && key === 'disallow' && value) {
      disallow.push(value);
    } else if (inWildcardBlock && key === 'crawl-delay') {
      const parsed = parseFloat(value);
      if (!isNaN(parsed)) crawlDelay = parsed * 1000;
    }
  }

  return { disallow, crawlDelay };
}

async function loadRobots(rootUrl) {
  try {
    const u = new URL(rootUrl);
    const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
    const res = await axios.get(robotsUrl, { timeout: 8000, validateStatus: (s) => s === 200 });
    return parseRobots(res.data);
  } catch {
    return { disallow: [], crawlDelay: 0 };
  }
}

function isAllowed(url, robots) {
  try {
    const pathname = new URL(url).pathname;
    return !robots.disallow.some((rule) => pathname.startsWith(rule));
  } catch {
    return true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { loadRobots, isAllowed, sleep };
