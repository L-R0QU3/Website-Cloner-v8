const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { URL } = require('url');

const { autoScroll, fixElementorStretchedSections, fixJsComputedFullWidthElements, triggerCarousels, clickThroughCarousels, prepareLayerSlider, resetCarouselWidgets, detectPageTech, rebuildKnownCarousels, extractLayerSliderFromServerHtml, SIMPLE_CAROUSEL_CSS, SIMPLE_CAROUSEL_JS } = require('./crawler');

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

function guessMime(url) {
  const match = url.match(/\.[a-z0-9]+(?:\?|$)/i);
  const ext = match ? match[0].replace(/\?.*$/, '').toLowerCase() : '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function toDataUri(buffer, contentType) {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

async function fetchBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
  return { buffer: Buffer.from(res.data), contentType: res.headers['content-type'] || guessMime(url) };
}

// Incrusta las referencias url(...) e @import de un CSS como data URIs / CSS inline
async function inlineCss(cssUrl, cssText, depth = 0) {
  if (depth > 3) return cssText; // evita recursión infinita en @import circulares
  let newCss = cssText;

  const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  const seen = new Set();
  let match;
  while ((match = urlRegex.exec(cssText)) !== null) {
    const raw = match[2];
    if (raw.startsWith('data:') || seen.has(raw)) continue;
    seen.add(raw);
    try {
      const abs = new URL(raw, cssUrl).toString();
      const { buffer, contentType } = await fetchBuffer(abs);
      newCss = newCss.split(raw).join(toDataUri(buffer, contentType));
    } catch {
      // si no se puede descargar, se deja la referencia original
    }
  }

  const importRegex = /@import\s+(?:url\()?["']?([^"')]+)["']?\)?\s*;?/g;
  let importMatch;
  while ((importMatch = importRegex.exec(cssText)) !== null) {
    try {
      const abs = new URL(importMatch[1], cssUrl).toString();
      const res = await axios.get(abs, { timeout: 15000 });
      const importedCss = await inlineCss(abs, res.data, depth + 1);
      newCss = newCss.replace(importMatch[0], importedCss);
    } catch {
      // se ignora el @import si falla
    }
  }

  return newCss;
}

function attrsToString(attribs) {
  return Object.entries(attribs)
    .map(([k, v]) => (v === '' ? k : `${k}="${String(v).replace(/"/g, '&quot;')}"`))
    .join(' ');
}

// Busca URLs de imágenes/fuentes/video escondidas en JSON embebido o scripts inline
// (típico de Elementor: configuración de carruseles y fondos en atributos data-settings)
// que no aparecen en ningún <img>/<link> normal, y las incrusta igual como data URI.
const EMBEDDED_ASSET_REGEX = /https?:\/\/[^\s"'\\)<>]+?\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|ogg)(?:\?[^\s"'\\)<>]*)?/gi;

async function inlineEmbeddedAssetUrls(html, onLog) {
  const found = new Set(html.match(EMBEDDED_ASSET_REGEX) || []);
  let newHtml = html;
  for (const rawUrl of found) {
    if (rawUrl.startsWith('data:')) continue;
    try {
      const { buffer, contentType } = await fetchBuffer(rawUrl);
      newHtml = newHtml.split(rawUrl).join(toDataUri(buffer, contentType));
      onLog(`Recurso embebido (JSON/script) incrustado: ${rawUrl}`);
    } catch (e) {
      onLog(`No se pudo incrustar recurso embebido ${rawUrl}: ${e.message}`);
    }
  }
  return newHtml;
}

// Descarga la página con Puppeteer (para incluir contenido generado por JS) y devuelve
// un único HTML con todo el CSS, JS e imágenes incrustados como texto/base64. Detecta por
// su cuenta la tecnología de la página (WordPress, Elementor, Slider Revolution, Swiper,
// etc.) para aplicar automáticamente las correcciones que necesite, sin que el usuario
// tenga que indicarlo.
async function extractSinglePageInline(pageUrl, onLog) {
  const log = onLog || (() => {});
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  try {
    const page = await browser.newPage();
    const viewportWidth = 1440;
    await page.setViewport({ width: viewportWidth, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (WebsiteCloner)');

    // Captura el HTML crudo del documento (sin JS) para extraer el contenido real de LayerSlider.
    let rawDocumentHtml = null;
    page.on('response', async (response) => {
      try {
        if (response.request().resourceType() === 'document' && rawDocumentHtml === null
          && response.status() >= 200 && response.status() < 300) {
          rawDocumentHtml = (await response.buffer()).toString('utf8');
        }
      } catch { /* se ignora */ }
    });

    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    let detected = { isWordPress: false, isElementor: false, pageBuilder: null, sliders: [], needsExtendedFixes: false };
    try {
      detected = await detectPageTech(page);
      const techList = [detected.isWordPress ? 'WordPress' : null, detected.pageBuilder, ...detected.sliders].filter(Boolean);
      if (techList.length) log(`Tecnología detectada: ${techList.join(' · ')}`);
    } catch (e) {
      log(`Aviso: no se pudo detectar la tecnología de la página: ${e.message}`);
    }

    try {
      await autoScroll(page);
      await new Promise((r) => setTimeout(r, detected.needsExtendedFixes ? 1500 : 600));
      await page.evaluate(() => window.scrollTo(0, 0));
      if (detected.needsExtendedFixes) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          const carouselsTouched = await triggerCarousels(page);
          if (carouselsTouched > 0) {
            log(`Recorridos ${carouselsTouched} carrusel(es) Swiper para forzar la carga de todos sus slides`);
            await new Promise((r) => setTimeout(r, 400));
          }
        } catch (e) {
          log(`Aviso: no se pudo recorrer carruseles: ${e.message}`);
        }
        try {
          const navClicks = await clickThroughCarousels(page);
          if (navClicks > 0) {
            log(`Se hizo clic ${navClicks} vez/veces en botones "siguiente" de carruseles (Slider Revolution u otros)`);
            await new Promise((r) => setTimeout(r, 400));
            await page.evaluate(() => window.scrollTo(0, 0));
          }
        } catch (e) {
          log(`Aviso: no se pudo recorrer carruseles genéricos: ${e.message}`);
        }
        try {
          const ls = await prepareLayerSlider(page);
          if (ls.navClicks > 0 || ls.fixedImages > 0) {
            log(`LayerSlider preparado: ${ls.fixedImages} imagen(es) de fondo restauradas, ${ls.navClicks} clic(s) de navegación`);
            await new Promise((r) => setTimeout(r, 400));
            await page.evaluate(() => window.scrollTo(0, 0));
          }
        } catch (e) {
          log(`Aviso: no se pudo preparar LayerSlider: ${e.message}`);
        }
      }
      const fixedCount = await fixJsComputedFullWidthElements(page, viewportWidth);
      if (fixedCount > 0) log(`Corregidos ${fixedCount} elemento(s) con ancho fijo calculado por JS`);
    } catch (e) {
      log(`Aviso: no se pudo hacer scroll completo: ${e.message}`);
    }

    const html = await page.content();
    const $ = cheerio.load(html);

    // Datos de LayerSlider desde el HTML crudo del servidor (fondo + título de cada slide).
    let layerSliderData = null;
    if (rawDocumentHtml) {
      try { layerSliderData = extractLayerSliderFromServerHtml(cheerio.load(rawDocumentHtml)); } catch { /* se ignora */ }
    }

    for (const el of $('link[rel="stylesheet"]').toArray()) {
      const href = $(el).attr('href');
      if (!href) continue;
      try {
        const abs = new URL(href, pageUrl).toString();
        const res = await axios.get(abs, { timeout: 15000 });
        const inlined = await inlineCss(abs, res.data);
        $(el).replaceWith(`<style>${inlined}</style>`);
        log(`CSS incrustado: ${abs}`);
      } catch (e) {
        log(`No se pudo incrustar CSS ${href}: ${e.message}`);
      }
    }

    for (const el of $('script[src]').toArray()) {
      const src = $(el).attr('src');
      if (!src) continue;
      try {
        const abs = new URL(src, pageUrl).toString();
        const res = await axios.get(abs, { timeout: 15000 });
        const attrs = { ...el.attribs };
        delete attrs.src;
        $(el).replaceWith(`<script ${attrsToString(attrs)}>${res.data}</script>`);
        log(`Script incrustado: ${abs}`);
      } catch (e) {
        log(`No se pudo incrustar script ${src}: ${e.message}`);
      }
    }

    for (const el of $('img[src]').toArray()) {
      const src = $(el).attr('src');
      if (!src || src.startsWith('data:')) continue;
      try {
        const abs = new URL(src, pageUrl).toString();
        const { buffer, contentType } = await fetchBuffer(abs);
        $(el).attr('src', toDataUri(buffer, contentType));
      } catch (e) {
        log(`No se pudo incrustar imagen ${src}: ${e.message}`);
      }
    }

    // Respaldo para lazy-loading que no llegó a dispararse (carruseles, plugins de lazy-load)
    const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-lazy', 'data-original', 'data-bg', 'data-background-image'];
    for (const attr of LAZY_ATTRS) {
      for (const el of $(`[${attr}]`).toArray()) {
        const val = $(el).attr(attr);
        if (!val || val.startsWith('data:')) continue;
        try {
          const abs = new URL(val, pageUrl).toString();
          const { buffer, contentType } = await fetchBuffer(abs);
          const dataUri = toDataUri(buffer, contentType);
          if (attr === 'data-bg' || attr === 'data-background-image') {
            const existingStyle = $(el).attr('style') || '';
            $(el).attr('style', `${existingStyle};background-image:url('${dataUri}')`.replace(/^;/, ''));
          } else if (!$(el).attr('src')) {
            $(el).attr('src', dataUri);
          }
        } catch (e) {
          log(`No se pudo incrustar ${attr} ${val}: ${e.message}`);
        }
      }
    }

    for (const el of $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').toArray()) {
      const href = $(el).attr('href');
      if (!href) continue;
      try {
        const abs = new URL(href, pageUrl).toString();
        const { buffer, contentType } = await fetchBuffer(abs);
        $(el).attr('href', toDataUri(buffer, contentType));
      } catch {
        // ícono opcional, se ignora si falla
      }
    }

    // Aseguramos una etiqueta <base> ausente (ya no hace falta, todo quedó absoluto/incrustado)
    $('base').remove();

    let finalHtml;
    if (detected.needsExtendedFixes) {
      if (detected.isElementor) {
        const fixed = fixElementorStretchedSections($);
        if (fixed) log(`Corregidas secciones "stretched" de Elementor.`);
      }
    }
    
    const rebuiltCarousels = rebuildKnownCarousels($, log, pageUrl, layerSliderData);
    
    if (rebuiltCarousels > 0) {
      $('head').append(`<style>${SIMPLE_CAROUSEL_CSS}</style>`);
      $('body').append(`<script>${SIMPLE_CAROUSEL_JS}</script>`);
    }
    if (detected.needsExtendedFixes) {
      const carouselsReset = resetCarouselWidgets($);
      if (carouselsReset) log(`Reiniciadas marcas de carrusel (Swiper/Owl/Slick) restante para que se re-inicialicen limpios.`);
      finalHtml = await inlineEmbeddedAssetUrls($.html(), log);
    } else {
      finalHtml = $.html();
    }

    await page.close();
    return finalHtml;
  } finally {
    await browser.close();
  }
}

module.exports = { extractSinglePageInline };