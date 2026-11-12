const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const { URL } = require('url');
const { analyzeSite, renderMarkdown, renderHtml, renderSiteMapSvg, renderDocx, renderPdf } = require('./report');
const { loadRobots, isAllowed, sleep } = require('./robots');

// ---------- Utilidades ----------

function toAbsolute(base, maybeRelative) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

function sameDomain(url, rootHost) {
  try {
    return new URL(url).host === rootHost;
  } catch {
    return false;
  }
}

function urlToLocalPath(url) {
  const u = new URL(url);
  let p = u.pathname;
  if (p.endsWith('/') || p === '') p += 'index.html';
  const ext = path.extname(p);
  if (!ext) p = path.join(p, 'index.html');
  return path.join(u.host, decodeURIComponent(p));
}

function urlToScreenshotPath(url) {
  const u = new URL(url);
  let p = u.pathname;
  if (p.endsWith('/') || p === '') p += 'home';
  p = p.replace(/\/$/, '') + '.png';
  return path.join('screenshots', u.host, decodeURIComponent(p).replace(/^\//, ''));
}

// Detecta automáticamente, DENTRO del navegador ya renderizado, qué CMS/page builder y
// qué librería de carrusel/slider usa la página (WordPress, Elementor, Divi, WPBakery,
// Slider Revolution, Swiper, Owl Carousel, Slick, Flickity). No depende de que el usuario
// sepa o indique la tecnología: revisa clases conocidas en el HTML, variables globales de
// JS que cada librería deja en "window", y la etiqueta <meta name="generator">.
async function detectPageTech(page) {
  return page.evaluate(() => {
    const html = document.documentElement.outerHTML.toLowerCase();
    const has = (s) => html.includes(s);
    const generator = (document.querySelector('meta[name="generator" i]') || {}).content || '';
    const genLower = generator.toLowerCase();
    const w = window;

    const isWordPress = has('wp-content') || has('wp-includes') || genLower.includes('wordpress');
    const isElementor = has('elementor') || !!w.elementorFrontend || genLower.includes('elementor');
    const isDivi = has('et_pb_') || has('et-db') || genLower.includes('divi');
    const isWpBakery = has('vc_row') || has('wpb_wrapper') || has('js-composer');

    const hasSliderRevolution = has('rev_slider') || has('tp-banner') || has('rs-module-cover')
      || !!w.revapi || !!w.RevSlider || genLower.includes('slider revolution');
    const hasSwiper = has('swiper-container') || has('class="swiper') || has(' swiper ') || !!w.Swiper;
    const hasOwlCarousel = has('owl-carousel') || !!(w.jQuery && w.jQuery.fn && w.jQuery.fn.owlCarousel);
    const hasSlick = has('slick-slider') || !!(w.jQuery && w.jQuery.fn && w.jQuery.fn.slick);
    const hasFlickity = has('flickity') || !!w.Flickity;

    const sliders = [];
    if (hasSliderRevolution) sliders.push('Slider Revolution');
    if (hasSwiper) sliders.push('Swiper');
    if (hasOwlCarousel) sliders.push('Owl Carousel');
    if (hasSlick) sliders.push('Slick');
    if (hasFlickity) sliders.push('Flickity');

    let pageBuilder = null;
    if (isElementor) pageBuilder = 'Elementor';
    else if (isDivi) pageBuilder = 'Divi';
    else if (isWpBakery) pageBuilder = 'WPBakery';

    return {
      isWordPress,
      isElementor,
      pageBuilder,
      sliders,
      needsExtendedFixes: isWordPress || !!pageBuilder || sliders.length > 0,
    };
  });
}


// slide por slide, para forzar que su sistema propio de lazy-loading cargue TODAS las
// imágenes, no solo la del slide visible al momento de la captura.
async function triggerCarousels(page) {
  return page.evaluate(async () => {
    const containers = Array.from(document.querySelectorAll('.swiper, .swiper-container'));
    let touched = 0;
    for (const el of containers) {
      const instance = el.swiper;
      if (!instance || !Array.isArray(instance.slides) && !instance.slides) continue;
      const total = instance.slides.length || (instance.slides && instance.slides.length) || 0;
      if (!total) continue;
      touched += 1;
      for (let i = 0; i < total; i++) {
        try { instance.slideTo(i, 0, false); } catch { /* versión de Swiper distinta; se ignora */ }
        await new Promise((r) => setTimeout(r, 120));
      }
      try { instance.slideTo(0, 0, false); } catch { /* vuelve al primer slide */ }
    }
    return touched;
  });
}

// Complemento genérico a triggerCarousels: en vez de conocer la librería exacta del carrusel
// (Slider Revolution, un carrusel propio del tema, etc.), hace clic de verdad en cualquier
// botón "siguiente" visible que encuentre, varias veces, para forzar que todos los slides se
// muestren al menos una vez antes de la captura (y así se disparen sus imágenes/lazy-load),
// sin depender de conocer la clase o el framework del carrusel.
async function clickThroughCarousels(page) {
  return page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nextSelectors = [
      '.owl-next', '.slick-next', '.swiper-button-next',
      '[class*="carousel"] [class*="next" i]', '[class*="slider"] [class*="next" i]',
      '.tp-rightarrow', '[class*="arrow-next" i]', '[class*="nav-next" i]', '[class*="next-arrow" i]',
      '[aria-label="Next" i]', '[aria-label*="siguiente" i]',
    ];
    const seen = new Set();
    let clicks = 0;
    for (const sel of nextSelectors) {
      let buttons;
      try { buttons = Array.from(document.querySelectorAll(sel)); } catch { continue; }
      for (const btn of buttons) {
        if (seen.has(btn)) continue;
        seen.add(btn);
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue; // no visible, se ignora
        for (let i = 0; i < 6; i++) {
          try { btn.click(); } catch { break; }
          clicks += 1;
          await sleep(200);
        }
      }
    }
    return clicks;
  });
}

// Trata cualquier atributo típico de lazy-loading (data-src, data-lazy-src, etc.) como si
// fuera la imagen real, sea que pertenezca a un carrusel Swiper o a cualquier otro plugin
// de carga diferida que nunca llegó a dispararse durante la captura.
const LAZY_ATTR_CANDIDATES = ['data-src', 'data-lazy-src', 'data-lazy', 'data-original', 'data-bg', 'data-background-image'];

function collectLazyAttrElements($) {
  const items = [];
  for (const attr of LAZY_ATTR_CANDIDATES) {
    $(`[${attr}]`).each((_, el) => {
      const val = $(el).attr(attr);
      if (val && !val.startsWith('data:')) items.push({ el, attr, val });
    });
  }
  return items;
}

function relativePathBetween(fromFile, toFile) {
  let rel = path.relative(path.dirname(fromFile), toFile);
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel.split(path.sep).join('/');
}

// ---------- Reconstrucción de carruseles con un motor propio, simple y confiable ----------
//
// En vez de intentar clonar el comportamiento exacto de cada librería de carrusel (Swiper,
// Slider Revolution, Owl Carousel, Slick — cada una con su propia forma de inicializarse,
// duplicar slides para el modo loop, calcular anchos, etc.), esto RECONOCE el contenido real
// de cada carrusel conocido y lo RECONSTRUYE con un carrusel minimalista escrito por nosotros:
// mismas imágenes y textos, pero con una sola pieza de HTML/CSS/JS simple que no depende de
// que el script original se re-inicialice correctamente sobre un HTML ya "usado".

const SIMPLE_CAROUSEL_CSS = `.wc-simple-carousel{position:relative;overflow:hidden}
.wc-simple-carousel .wc-track{display:flex;transition:transform .4s ease}
.wc-simple-carousel .wc-slide{flex:0 0 100%;max-width:100%;box-sizing:border-box}
.wc-simple-carousel .wc-arrow{position:absolute;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.5);color:#fff;border:none;width:36px;height:36px;border-radius:50%;cursor:pointer;font-size:16px;z-index:2;line-height:1}
.wc-simple-carousel .wc-prev{left:10px}
.wc-simple-carousel .wc-next{right:10px}
.wc-simple-carousel .wc-dots{display:flex;justify-content:center;gap:6px;margin-top:10px}
.wc-simple-carousel .wc-dot{width:8px;height:8px;border-radius:50%;background:#ccc;border:none;cursor:pointer;padding:0}
.wc-simple-carousel .wc-dot.active{background:#333}
.wc-simple-carousel .wc-caption{position:absolute;left:0;right:0;bottom:0;padding:16px;background:linear-gradient(transparent,rgba(0,0,0,.6));color:#fff}
`;

const SIMPLE_CAROUSEL_JS = `(function(){
  function initCarousel(root){
    var track = root.querySelector('.wc-track');
    var slides = Array.prototype.slice.call(root.querySelectorAll('.wc-slide'));
    var dots = Array.prototype.slice.call(root.querySelectorAll('.wc-dot'));
    var index = 0;
    function update(){
      track.style.transform = 'translateX(-' + (index * 100) + '%)';
      dots.forEach(function(d, i){ d.classList.toggle('active', i === index); });
    }
    function go(i){ index = (i + slides.length) % slides.length; update(); }
    var prev = root.querySelector('.wc-prev');
    var next = root.querySelector('.wc-next');
    if (prev) prev.addEventListener('click', function(){ go(index - 1); });
    if (next) next.addEventListener('click', function(){ go(index + 1); });
    dots.forEach(function(d, i){ d.addEventListener('click', function(){ go(i); }); });
    update();
  }
  function initAll(){
    Array.prototype.slice.call(document.querySelectorAll('.wc-simple-carousel')).forEach(initCarousel);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
`;

function buildSimpleCarouselHtml(innerHtmlArray) {
  const slidesHtml = innerHtmlArray.map((inner) => `<div class="wc-slide">${inner}</div>`).join('');
  const dotsHtml = innerHtmlArray.map((_, i) => `<button class="wc-dot${i === 0 ? ' active' : ''}" aria-label="Ir al slide ${i + 1}"></button>`).join('');
  return `<div class="wc-simple-carousel"><div class="wc-track">${slidesHtml}</div><button class="wc-arrow wc-prev" aria-label="Anterior">&#10094;</button><button class="wc-arrow wc-next" aria-label="Siguiente">&#10095;</button><div class="wc-dots">${dotsHtml}</div></div>`;
}

// Extrae la URL de fondo de un slide de Slider Revolution probando los lugares donde suele
// guardarla (atributo, estilo inline, o una <img> interna), y un texto de título si hay alguno.
function extractRevSlideContent($, slideEl) {
  const $slide = $(slideEl);
  let bg = $slide.attr('data-thumb') || $slide.attr('data-bgimage') || '';
  if (!bg) {
    const style = $slide.attr('style') || '';
    const m = style.match(/url\(['"]?([^'")]+)['"]?\)/i);
    if (m) bg = m[1];
  }
  if (!bg) {
    const img = $slide.find('img').first();
    bg = img.attr('src') || img.attr('data-src') || img.attr('data-lazyload') || '';
  }
  const captionText = $slide.find('h1, h2, h3, p').filter((_, el) => $(el).text().trim().length > 0).first().text().trim();
  return { bg, captionText };
}

function rebuildKnownCarousels($, logFn, pageUrl) {
  let rebuilt = 0;

  // Swiper (incluye los carruseles de Elementor)
  $('.swiper, .swiper-container').toArray().forEach((el) => {
    const $el = $(el);
    const slides = $el.find('.swiper-slide').filter((_, s) => !$(s).hasClass('swiper-slide-duplicate'));
    if (slides.length < 2) return;
    const inner = slides.map((_, s) => $(s).html() || '').get();
    $el.replaceWith(buildSimpleCarouselHtml(inner));
    rebuilt += 1;
  });

  // Owl Carousel
  $('.owl-carousel').toArray().forEach((el) => {
    const $el = $(el);
    let items = $el.find('.owl-item').filter((_, s) => !$(s).hasClass('cloned'));
    if (!items.length) items = $el.children();
    if (items.length < 2) return;
    const inner = items.map((_, s) => $(s).html() || '').get();
    $el.replaceWith(buildSimpleCarouselHtml(inner));
    rebuilt += 1;
  });

  // Slick
  $('.slick-slider').toArray().forEach((el) => {
    const $el = $(el);
    let items = $el.find('.slick-track > .slick-slide').filter((_, s) => !$(s).hasClass('slick-cloned'));
    if (!items.length) items = $el.children();
    if (items.length < 2) return;
    const inner = items.map((_, s) => $(s).html() || '').get();
    $el.replaceWith(buildSimpleCarouselHtml(inner));
    rebuilt += 1;
  });

  // Slider Revolution — estructura mucho más compleja (capas con animaciones propias);
  // reconstrucción best-effort: se rescata la imagen de fondo y un texto de título por slide.
  $('.rev_slider, .tp-banner').toArray().forEach((el) => {
    const $el = $(el);
    const slideEls = $el.find('> ul > li, .tp-revslider-slidesli').toArray();
    if (slideEls.length < 2) return;
    const inner = slideEls.map((s) => {
      const { bg, captionText } = extractRevSlideContent($, s);
      const bgStyle = bg ? `background-image:url('${bg}');background-size:cover;background-position:center;min-height:320px;` : 'min-height:320px;background:#111;';
      const caption = captionText ? `<div class="wc-caption"><h3>${captionText}</h3></div>` : '';
      return `<div style="${bgStyle}position:relative;">${caption}</div>`;
    });
    const container = $el.parent().is('.rev_slider_wrapper, .tp-banner-container') ? $el.parent() : $el;
    container.replaceWith(buildSimpleCarouselHtml(inner));
    rebuilt += 1;
  });

  if (rebuilt > 0) logFn(`Reconstruidos ${rebuilt} carrusel(es) con un motor propio simple (en vez de clonar el original) en ${pageUrl}`);
  return rebuilt;
}

// Busca URLs de imágenes/fuentes/video escondidas en cualquier parte del HTML final
// (atributos data-* con JSON, configuración inline de scripts, etc.) que las etiquetas
// normales no capturan. Muy común en WordPress/Elementor: los carruseles y fondos guardan
// las URLs de sus imágenes en "data-settings" en vez de un <img src="">.
const EMBEDDED_ASSET_REGEX = /https?:\/\/[^\s"'\\)<>]+?\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|ogg)(?:\?[^\s"'\\)<>]*)?/gi;

async function rewriteEmbeddedAssetUrls(html, pageLocalPath, outDir, assetMap, job, options) {
  const found = new Set(html.match(EMBEDDED_ASSET_REGEX) || []);
  let newHtml = html;
  for (const rawUrl of found) {
    try {
      if (!assetMap.has(rawUrl)) {
        const localPath = path.join(outDir, urlToLocalPath(rawUrl));
        await sleep(options.politeDelayMs);
        await downloadAsset(rawUrl, localPath);
        assetMap.set(rawUrl, localPath);
        log(job, `Recurso embebido (JSON/script) descargado: ${rawUrl}`);
      }
      const relPath = relativePathBetween(pageLocalPath, assetMap.get(rawUrl));
      newHtml = newHtml.split(rawUrl).join(relPath);
    } catch (e) {
      log(job, `No se pudo descargar recurso embebido ${rawUrl}: ${e.message}`);
    }
  }
  return newHtml;
}

// ---------- Estado del job ----------

function createJob() {
  return {
    status: 'idle',
    log: [],
    visitedPages: [],
    queuedCount: 0,
    doneCount: 0,
    tree: null,
    error: null,
    outDir: null,
    zipPath: null,
    reportData: null,
  };
}

function log(job, msg) {
  job.log.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (job.log.length > 500) job.log.shift();
}

// ---------- Descarga de un asset binario (css/js/img/font) ----------

async function downloadAsset(assetUrl, destPath) {
  const res = await axios.get(assetUrl, { responseType: 'arraybuffer', timeout: 15000 });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, res.data);
  return res.headers['content-type'] || '';
}

async function processCss(cssUrl, cssText, outDir, job, assetMap) {
  const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let match;
  let newCss = cssText;
  const replacements = [];

  while ((match = urlRegex.exec(cssText)) !== null) {
    const raw = match[2];
    if (raw.startsWith('data:')) continue;
    const abs = toAbsolute(cssUrl, raw);
    if (!abs) continue;
    replacements.push({ raw, abs });
  }

  const cssLocalPath = path.join(outDir, urlToLocalPath(cssUrl));

  for (const { raw, abs } of replacements) {
    if (!assetMap.has(abs)) {
      const localPath = path.join(outDir, urlToLocalPath(abs));
      try {
        await downloadAsset(abs, localPath);
        assetMap.set(abs, localPath);
        log(job, `Recurso CSS descargado: ${abs}`);
      } catch (e) {
        log(job, `No se pudo descargar recurso CSS ${abs}: ${e.message}`);
        continue;
      }
    }
    const localPath = assetMap.get(abs);
    const relPath = relativePathBetween(cssLocalPath, localPath);
    newCss = newCss.split(raw).join(relPath);
  }

  return newCss;
}

// ---------- Descarga y reescritura de una página HTML (renderizada con Puppeteer) ----------

// Baja lentamente hasta el fondo de la página para forzar que el contenido con
// lazy-loading (imágenes con IntersectionObserver, animaciones al hacer scroll, etc.)
// se dispare y quede capturado por el listener de red. Muy común en sitios Elementor/WordPress.
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 350;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight + 800) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
}

// Los carruseles (Swiper, Owl Carousel, Slick — Swiper es el que usa Elementor internamente)
// se capturan DESPUÉS de que ya se inicializaron una vez en el navegador. Eso deja en el HTML
// guardado slides clonados (modo "loop"), clases de "ya inicializado" y transformaciones de
// posición calculadas para ese momento. Si el mismo script intenta inicializar de nuevo sobre
// ese HTML "usado" al abrir el archivo, puede duplicar slides o desalinear todo. Esto limpia
// esas marcas para que el carrusel arranque limpio, como en el sitio original.
function resetCarouselWidgets($) {
  let changed = false;
  const removeIfPresent = (sel) => { if ($(sel).length) { $(sel).remove(); changed = true; } };
  const stripClasses = (sel, classesToRemove) => {
    $(sel).each((_, el) => {
      const cls = $(el).attr('class') || '';
      const parts = cls.split(/\s+/).filter(Boolean);
      const kept = parts.filter((c) => !classesToRemove.includes(c));
      if (kept.length !== parts.length) { $(el).attr('class', kept.join(' ')); changed = true; }
    });
  };
  const clearStyleIfMatches = (sel, regex) => {
    $(sel).each((_, el) => {
      const style = $(el).attr('style');
      if (style && regex.test(style)) { $(el).removeAttr('style'); changed = true; }
    });
  };

  // Swiper (usado por los widgets de carrusel de Elementor)
  removeIfPresent('.swiper-slide-duplicate');
  stripClasses('[class*="swiper"]', [
    'swiper-initialized', 'swiper-css-mode', 'swiper-backface-hidden', 'swiper-3d', 'swiper-watch-progress',
  ]);
  clearStyleIfMatches('.swiper-wrapper, .swiper-slide', /transform|width/i);
  if ($('.swiper-pagination, .swiper-scrollbar').length) { $('.swiper-pagination, .swiper-scrollbar').empty(); changed = true; }

  // Owl Carousel
  removeIfPresent('.owl-item.cloned');
  stripClasses('.owl-carousel, .owl-stage', ['owl-loaded', 'owl-drag']);
  clearStyleIfMatches('.owl-stage', /transform|width/i);

  // Slick
  removeIfPresent('.slick-cloned');
  stripClasses('[class*="slick-"]', ['slick-initialized']);
  clearStyleIfMatches('.slick-track, .slick-list', /transform|width/i);

  return changed;
}

// Elementor calcula el ancho de las secciones "stretched" (borde a borde) con JavaScript,
// basado en el ancho de pantalla que tenía el navegador en el momento de cargar la página,
// y lo deja fijo en píxeles dentro del HTML (inline style). Al abrir la copia en una ventana
// de otro tamaño, esa sección queda con un ancho fijo equivocado. Esto lo reemplaza por una
// técnica CSS "full-bleed" que se adapta a cualquier ancho de pantalla.
function fixElementorStretchedSections($) {
  const selector = '.elementor-section-stretched, .e-con.e-con-full, [data-elementor-stretch]';
  const found = $(selector);
  if (!found.length) return false;

  found.each((_, el) => {
    const style = $(el).attr('style') || '';
    const cleaned = style
      .replace(/(^|;)\s*width\s*:\s*[^;]+/gi, '')
      .replace(/(^|;)\s*margin-left\s*:\s*[^;]+/gi, '')
      .replace(/(^|;)\s*margin-right\s*:\s*[^;]+/gi, '')
      .replace(/(^|;)\s*left\s*:\s*[^;]+/gi, '')
      .replace(/(^|;)\s*right\s*:\s*[^;]+/gi, '')
      .replace(/;;+/g, ';')
      .trim();
    $(el).attr('style', cleaned);
  });

  $('head').append(`<style>
    .elementor-section-stretched, .e-con.e-con-full, [data-elementor-stretch] {
      width: 100vw !important;
      max-width: 100vw !important;
      margin-left: calc(-50vw + 50%) !important;
      margin-right: calc(-50vw + 50%) !important;
      left: auto !important;
      right: auto !important;
    }
    html { overflow-x: hidden; }
  </style>`);

  return true;
}

// Corre DENTRO del navegador (con la página ya renderizada) y busca elementos a los que
// algún script les dejó un ancho fijo en píxeles que coincide con el ancho de la ventana
// usada para la captura. Es el patrón típico de widgets "full width" calculados por JS
// (Elementor, Swiper, headers "sticky" de varios temas, etc.) que no se adaptan al abrir
// la copia en una pantalla de otro tamaño. No depende de conocer el nombre de la clase.
async function fixJsComputedFullWidthElements(page, viewportWidth) {
  return page.evaluate((vw) => {
    let count = 0;
    document.querySelectorAll('body *').forEach((el) => {
      const style = el.getAttribute('style');
      if (!style || !/width\s*:\s*\d+(\.\d+)?px/i.test(style)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      // Ancho fijo casi idéntico al de la ventana de captura Y pegado al borde izquierdo:
      // muy probablemente un "full width" calculado dinámicamente, no un diseño boxed real.
      if (Math.abs(rect.width - vw) <= 4 && rect.left <= 4) {
        el.style.setProperty('width', '100%', 'important');
        el.style.setProperty('max-width', '100%', 'important');
        el.style.removeProperty('margin-left');
        el.style.removeProperty('margin-right');
        el.style.removeProperty('left');
        el.style.removeProperty('right');
        count += 1;
      }
    });
    return count;
  }, viewportWidth);
}

async function processPage(browser, pageUrl, outDir, job, assetMap, rootHost, options) {
  const page = await browser.newPage();
  const viewportWidth = 1440;
  await page.setViewport({ width: viewportWidth, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (WebsiteCloner)');

  // Captura TODO lo que el navegador realmente pide al renderizar la página
  // (imágenes de fondo en CSS/inline, fuentes, video/audio, recursos inyectados por JS, etc.),
  // no solo lo que aparece en atributos src/href reconocidos del HTML.
  const pendingSaves = [];
  const capturedByNetwork = new Set();
  const CAPTURABLE_TYPES = ['image', 'stylesheet', 'script', 'font', 'media'];

  page.on('response', (response) => {
    const request = response.request();
    const resourceType = request.resourceType();
    const respUrl = response.url().split('#')[0];

    if (!CAPTURABLE_TYPES.includes(resourceType)) return;
    if (respUrl.startsWith('data:') || capturedByNetwork.has(respUrl)) return;
    if (response.status() >= 300) return; // evita guardar redirects/errores
    capturedByNetwork.add(respUrl);

    pendingSaves.push((async () => {
      try {
        const buffer = await response.buffer();
        const localPath = path.join(outDir, urlToLocalPath(respUrl));
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        fs.writeFileSync(localPath, buffer);
        if (!assetMap.has(respUrl)) assetMap.set(respUrl, localPath);
        log(job, `Recurso capturado por red: ${respUrl}`);

        if (resourceType === 'stylesheet' || respUrl.endsWith('.css')) {
          const cssText = buffer.toString('utf8');
          const newCss = await processCss(respUrl, cssText, outDir, job, assetMap);
          fs.writeFileSync(localPath, newCss);
        }
      } catch {
        // la respuesta puede haber quedado inaccesible (ya liberada, redirect, etc.); se ignora
      }
    })());
  });

  let html;
  let detected = { isWordPress: false, isElementor: false, pageBuilder: null, sliders: [], needsExtendedFixes: false };
  try {
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    try {
      detected = await detectPageTech(page);
      const techList = [detected.isWordPress ? 'WordPress' : null, detected.pageBuilder, ...detected.sliders].filter(Boolean);
      if (techList.length) {
        log(job, `Tecnología detectada en ${pageUrl}: ${techList.join(' · ')}`);
      }
    } catch (e) {
      log(job, `Aviso: no se pudo detectar la tecnología de ${pageUrl}: ${e.message}`);
    }

    // Fuerza la carga de contenido diferido (lazy-loaded) antes de capturar nada
    try {
      await autoScroll(page);
      await sleep(detected.needsExtendedFixes ? 1500 : 600); // los page builders suelen animar/inicializar widgets con más retraso
      await page.evaluate(() => window.scrollTo(0, 0));
      if (detected.needsExtendedFixes) {
        await sleep(500); // margen extra para que los widgets terminen de inicializarse
        try {
          const carouselsTouched = await triggerCarousels(page);
          if (carouselsTouched > 0) {
            log(job, `Recorridos ${carouselsTouched} carrusel(es) Swiper para forzar la carga de todos sus slides en ${pageUrl}`);
            await sleep(400); // margen para que terminen de descargarse las imágenes de los slides
          }
        } catch (e) {
          log(job, `Aviso: no se pudo recorrer carruseles en ${pageUrl}: ${e.message}`);
        }
        try {
          const navClicks = await clickThroughCarousels(page);
          if (navClicks > 0) {
            log(job, `Se hizo clic ${navClicks} vez/veces en botones "siguiente" de carruseles (Slider Revolution u otros) en ${pageUrl}`);
            await sleep(400);
            await page.evaluate(() => window.scrollTo(0, 0));
          }
        } catch (e) {
          log(job, `Aviso: no se pudo recorrer carruseles genéricos en ${pageUrl}: ${e.message}`);
        }
      }
      // Corrección de anchos fijos calculados por JS: siempre se intenta, cueste lo que
      // cueste detectar (es barata y no depende de ninguna tecnología en particular).
      try {
        const fixedCount = await fixJsComputedFullWidthElements(page, viewportWidth);
        if (fixedCount > 0) log(job, `Corregidos ${fixedCount} elemento(s) con ancho fijo calculado por JS en ${pageUrl}`);
      } catch (e) {
        log(job, `Aviso: no se pudo corregir anchos fijos en ${pageUrl}: ${e.message}`);
      }
    } catch (e) {
      log(job, `Aviso: no se pudo hacer scroll completo en ${pageUrl}: ${e.message}`);
    }

    await Promise.all(pendingSaves);
    html = await page.content();

    if (options.captureScreenshots) {
      const screenshotPath = path.join(outDir, urlToScreenshotPath(pageUrl));
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch (e) {
        log(job, `No se pudo capturar screenshot de ${pageUrl}: ${e.message}`);
      }
    }
  } finally {
    await page.close();
  }

  const $ = cheerio.load(html);
  const pageLocalPath = path.join(outDir, urlToLocalPath(pageUrl));
  const discoveredLinks = new Set();

  const tagsToProcess = [
    { sel: 'img[src]', attr: 'src' },
    { sel: 'script[src]', attr: 'src' },
    { sel: 'link[rel="stylesheet"]', attr: 'href' },
    { sel: 'link[rel="icon"]', attr: 'href' },
    { sel: 'source[src]', attr: 'src' },
    { sel: 'video[src]', attr: 'src' },
    { sel: 'audio[src]', attr: 'src' },
    { sel: 'video[poster]', attr: 'poster' },
  ];

  for (const { sel, attr } of tagsToProcess) {
    const elements = $(sel).toArray();
    for (const el of elements) {
      const raw = $(el).attr(attr);
      if (!raw || raw.startsWith('data:')) continue;
      const abs = toAbsolute(pageUrl, raw);
      if (!abs) continue;

      if (!assetMap.has(abs)) {
        const localPath = path.join(outDir, urlToLocalPath(abs));
        try {
          await sleep(options.politeDelayMs);
          const contentType = await downloadAsset(abs, localPath);
          assetMap.set(abs, localPath);
          log(job, `Descargado: ${abs}`);

          if (attr === 'href' && (contentType.includes('css') || abs.endsWith('.css'))) {
            const cssText = fs.readFileSync(localPath, 'utf8');
            const newCss = await processCss(abs, cssText, outDir, job, assetMap);
            fs.writeFileSync(localPath, newCss);
          }
        } catch (e) {
          log(job, `Error descargando ${abs}: ${e.message}`);
          continue;
        }
      }

      const localPath = assetMap.get(abs);
      const relPath = relativePathBetween(pageLocalPath, localPath);
      $(el).attr(attr, relPath);
    }
  }

  // Respaldo para lazy-loading que no llegó a dispararse (carruseles, plugins de lazy-load):
  // trata data-src/data-lazy-src/etc. como si fuera la imagen real.
  for (const { el, attr, val } of collectLazyAttrElements($)) {
    const abs = toAbsolute(pageUrl, val);
    if (!abs) continue;

    if (!assetMap.has(abs)) {
      const localPath = path.join(outDir, urlToLocalPath(abs));
      try {
        await sleep(options.politeDelayMs);
        await downloadAsset(abs, localPath);
        assetMap.set(abs, localPath);
        log(job, `Descargado (lazy-load ${attr}): ${abs}`);
      } catch (e) {
        log(job, `Error descargando ${attr} ${abs}: ${e.message}`);
        continue;
      }
    }
    const relPath = relativePathBetween(pageLocalPath, assetMap.get(abs));
    if (attr === 'data-bg' || attr === 'data-background-image') {
      const existingStyle = $(el).attr('style') || '';
      $(el).attr('style', `${existingStyle};background-image:url('${relPath}')`.replace(/^;/, ''));
    } else if (!$(el).attr('src')) {
      $(el).attr('src', relPath);
    }
  }

  // srcset: puede traer varias URLs con descriptor de tamaño ("foto.jpg 1x, foto@2x.jpg 2x")
  for (const el of $('img[srcset], source[srcset]').toArray()) {
    const raw = $(el).attr('srcset');
    if (!raw) continue;
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    const rewritten = [];
    for (const part of parts) {
      const [rawUrl, descriptor] = part.split(/\s+/, 2);
      if (!rawUrl || rawUrl.startsWith('data:')) { rewritten.push(part); continue; }
      const abs = toAbsolute(pageUrl, rawUrl);
      if (!abs) { rewritten.push(part); continue; }

      if (!assetMap.has(abs)) {
        const localPath = path.join(outDir, urlToLocalPath(abs));
        try {
          await sleep(options.politeDelayMs);
          await downloadAsset(abs, localPath);
          assetMap.set(abs, localPath);
          log(job, `Descargado (srcset): ${abs}`);
        } catch (e) {
          log(job, `Error descargando srcset ${abs}: ${e.message}`);
          rewritten.push(part);
          continue;
        }
      }
      const relPath = relativePathBetween(pageLocalPath, assetMap.get(abs));
      rewritten.push(descriptor ? `${relPath} ${descriptor}` : relPath);
    }
    $(el).attr('srcset', rewritten.join(', '));
  }

  // Imágenes de fondo puestas directamente como style="background-image:url(...)"
  for (const el of $('[style*="url("]').toArray()) {
    const styleAttr = $(el).attr('style');
    if (!styleAttr) continue;
    const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let newStyle = styleAttr;
    let match;
    while ((match = urlRegex.exec(styleAttr)) !== null) {
      const raw = match[2];
      if (raw.startsWith('data:')) continue;
      const abs = toAbsolute(pageUrl, raw);
      if (!abs) continue;

      if (!assetMap.has(abs)) {
        const localPath = path.join(outDir, urlToLocalPath(abs));
        try {
          await sleep(options.politeDelayMs);
          await downloadAsset(abs, localPath);
          assetMap.set(abs, localPath);
          log(job, `Descargado (style inline): ${abs}`);
        } catch (e) {
          log(job, `Error descargando ${abs}: ${e.message}`);
          continue;
        }
      }
      const relPath = relativePathBetween(pageLocalPath, assetMap.get(abs));
      newStyle = newStyle.split(raw).join(relPath);
    }
    $(el).attr('style', newStyle);
  }

  // iframes del mismo dominio: se reescribe el enlace (el contenido del iframe no se clona aparte)
  $('iframe[src]').each((_, el) => {
    const raw = $(el).attr('src');
    if (!raw) return;
    const abs = toAbsolute(pageUrl, raw);
    if (!abs) return;
    const cleaned = abs.split('#')[0];
    if (sameDomain(cleaned, rootHost)) {
      const targetLocal = path.join(outDir, urlToLocalPath(cleaned));
      const relPath = relativePathBetween(pageLocalPath, targetLocal);
      $(el).attr('src', relPath);
    }
  });

  $('a[href]').each((_, el) => {
    const raw = $(el).attr('href');
    if (!raw || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) return;
    const abs = toAbsolute(pageUrl, raw);
    if (!abs) return;
    const cleaned = abs.split('#')[0];
    if (sameDomain(cleaned, rootHost)) {
      discoveredLinks.add(cleaned);
      const targetLocal = path.join(outDir, urlToLocalPath(cleaned));
      const relPath = relativePathBetween(pageLocalPath, targetLocal);
      $(el).attr('href', relPath);
    }
  });

  const title = $('title').first().text().trim();
  const headings = $('h1, h2').slice(0, 6).map((_, el) => $(el).text().trim()).get().filter(Boolean);

  // Reconstruye carruseles conocidos (Swiper/Owl/Slick/Slider Revolution) con un motor propio
  // simple, en vez de depender de que el script original se re-inicialice bien al reabrir.
  const rebuiltCarousels = rebuildKnownCarousels($, (msg) => log(job, msg), pageUrl);
  if (rebuiltCarousels > 0) {
    const cssRel = relativePathBetween(pageLocalPath, path.join(outDir, '_cloner-assets', 'simple-carousel.css'));
    const jsRel = relativePathBetween(pageLocalPath, path.join(outDir, '_cloner-assets', 'simple-carousel.js'));
    if ($('head').length) $('head').append(`<link rel="stylesheet" href="${cssRel}">`);
    if ($('body').length) $('body').append(`<script src="${jsRel}"></script>`);
  }

  let finalHtml;
  if (detected.needsExtendedFixes) {
    if (detected.isElementor) {
      const fixed = fixElementorStretchedSections($);
      if (fixed) log(job, `Corregidas secciones "stretched" de Elementor en ${pageUrl}`);
    }
    const carouselsReset = resetCarouselWidgets($);
    if (carouselsReset) log(job, `Reiniciadas marcas de carrusel (Swiper/Owl/Slick) restante para que se re-inicialicen limpios en ${pageUrl}`);
    finalHtml = await rewriteEmbeddedAssetUrls($.html(), pageLocalPath, outDir, assetMap, job, options);
  } else {
    finalHtml = $.html();
  }

  fs.mkdirSync(path.dirname(pageLocalPath), { recursive: true });
  fs.writeFileSync(pageLocalPath, finalHtml);

  return { discoveredLinks, localPath: pageLocalPath, title, headings };
}

// ---------- Rastreo completo del sitio (BFS) ----------

async function crawlSite(job, startUrl, options) {
  const {
    maxPages = 20,
    maxDepth = 2,
    captureScreenshots = true,
    politeDelayMs: userDelay,
    respectRobots = true,
  } = options;

  const rootHost = new URL(startUrl).host;
  const outDir = path.join(__dirname, 'clones', job.id);
  fs.mkdirSync(outDir, { recursive: true });
  job.outDir = outDir;
  job.status = 'running';

  // Archivos compartidos del carrusel propio (se escriben una sola vez; las páginas que
  // reconstruyan algún carrusel enlazan a estos en vez de duplicar el CSS/JS en cada una).
  const carouselAssetsDir = path.join(outDir, '_cloner-assets');
  fs.mkdirSync(carouselAssetsDir, { recursive: true });
  fs.writeFileSync(path.join(carouselAssetsDir, 'simple-carousel.css'), SIMPLE_CAROUSEL_CSS);
  fs.writeFileSync(path.join(carouselAssetsDir, 'simple-carousel.js'), SIMPLE_CAROUSEL_JS);

  let robots = { disallow: [], crawlDelay: 0 };
  if (respectRobots) {
    log(job, `Revisando robots.txt...`);
    robots = await loadRobots(startUrl);
    if (robots.disallow.length) {
      log(job, `robots.txt encontrado, ${robots.disallow.length} regla(s) Disallow para User-agent: *`);
    }
  }
  const politeDelayMs = Math.max(userDelay || 300, robots.crawlDelay || 0);
  const runOptions = { ...options, captureScreenshots, politeDelayMs };

  log(job, `Lanzando navegador headless (Puppeteer)...`);
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  const assetMap = new Map();
  const visited = new Set();
  const queue = [{ url: startUrl.split('#')[0], depth: 0 }];
  const treeNodes = {};
  const pagesInfo = [];

  log(job, `Iniciando rastreo de ${startUrl} (máx. ${maxPages} páginas, profundidad ${maxDepth}, pausa ${politeDelayMs}ms)`);

  try {
    while (queue.length > 0 && visited.size < maxPages) {
      const { url, depth } = queue.shift();
      if (visited.has(url) || depth > maxDepth) continue;

      if (respectRobots && depth > 0 && !isAllowed(url, robots)) {
        log(job, `Omitida por robots.txt: ${url}`);
        continue;
      }
      if (respectRobots && depth === 0 && !isAllowed(url, robots)) {
        log(job, `Aviso: robots.txt no permite rastrear ${url}, pero se procesa igual por ser la página que pediste explícitamente.`);
      }

      visited.add(url);
      job.queuedCount = queue.length;

      try {
        log(job, `Procesando página (${visited.size}/${maxPages}, prof. ${depth}): ${url}`);
        await sleep(politeDelayMs);
        const { discoveredLinks, localPath, title, headings } = await processPage(
          browser, url, outDir, job, assetMap, rootHost, runOptions
        );
        job.doneCount = visited.size;
        treeNodes[url] = { url, localPath: path.relative(outDir, localPath), depth, children: [] };
        pagesInfo.push({ url, localPath, depth, title, headings });

        if (depth < maxDepth) {
          for (const link of discoveredLinks) {
            if (!visited.has(link) && !queue.some((q) => q.url === link)) {
              queue.push({ url: link, depth: depth + 1 });
              treeNodes[url].children.push(link);
            }
          }
        }
      } catch (e) {
        log(job, `Error procesando página ${url}: ${e.message}`);
      }
    }
  } finally {
    await browser.close();
    log(job, `Navegador cerrado.`);
  }

  job.tree = buildTree(treeNodes, startUrl.split('#')[0]);
  log(job, `Rastreo terminado. ${visited.size} páginas y ${assetMap.size} recursos descargados.`);

  log(job, `Analizando estilos, código y estructura para generar la documentación...`);
  try {
    const reportData = analyzeSite(outDir, assetMap, pagesInfo, startUrl.split('#')[0], options, job.tree);
    job.reportData = reportData;

    const md = renderMarkdown(reportData);
    const html = renderHtml(reportData);
    fs.writeFileSync(path.join(outDir, 'documentacion.md'), md);
    fs.writeFileSync(path.join(outDir, 'documentacion.html'), html);
    fs.writeFileSync(path.join(outDir, 'sitemap.svg'), renderSiteMapSvg(job.tree));
    job.reportPath = path.join(outDir, 'documentacion.html');
    log(job, `Documentación generada (documentacion.html / documentacion.md / sitemap.svg).`);

    log(job, `Generando versión en PDF...`);
    try {
      const pdfPath = path.join(outDir, 'documentacion.pdf');
      await renderPdf(html, pdfPath);
      job.pdfPath = pdfPath;
      log(job, `PDF generado (documentacion.pdf).`);
    } catch (e) {
      log(job, `No se pudo generar el PDF: ${e.message}`);
    }

    log(job, `Generando versión en Word (.docx)...`);
    try {
      const docxBuffer = await renderDocx(reportData);
      const docxPath = path.join(outDir, 'documentacion.docx');
      fs.writeFileSync(docxPath, docxBuffer);
      job.docxPath = docxPath;
      log(job, `Documento Word generado (documentacion.docx).`);
    } catch (e) {
      log(job, `No se pudo generar el Word: ${e.message}`);
    }
  } catch (e) {
    log(job, `No se pudo generar la documentación: ${e.message}`);
  }

  job.status = 'zipping';
  log(job, `Generando ZIP...`);

  return outDir;
}

function buildTree(nodes, rootUrl) {
  function build(url, seen) {
    const node = nodes[url];
    if (!node) return { url, missing: true };
    if (seen.has(url)) return { url, cycle: true };
    seen.add(url);
    return {
      url: node.url,
      path: node.localPath,
      children: node.children.map((childUrl) => build(childUrl, new Set(seen))),
    };
  }
  return build(rootUrl, new Set());
}

module.exports = { createJob, crawlSite, log, autoScroll, fixElementorStretchedSections, fixJsComputedFullWidthElements, triggerCarousels, clickThroughCarousels, resetCarouselWidgets, detectPageTech, rebuildKnownCarousels, SIMPLE_CAROUSEL_CSS, SIMPLE_CAROUSEL_JS };
