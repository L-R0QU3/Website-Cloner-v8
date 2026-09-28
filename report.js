const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const {
  Document, Packer, Paragraph, HeadingLevel, TextRun,
} = require('docx');

const TECH_SIGNATURES = [
  { name: 'WordPress', needle: 'wp-content' },
  { name: 'Next.js', needle: '_next/static' },
  { name: 'React', needle: 'data-reactroot' },
  { name: 'Angular', needle: 'ng-version' },
  { name: 'Vue.js', needle: 'data-v-' },
  { name: 'jQuery', needle: 'jquery' },
  { name: 'Bootstrap', needle: 'bootstrap' },
  { name: 'Tailwind CSS', needle: 'tailwind' },
  { name: 'Shopify', needle: 'cdn.shopify.com' },
  { name: 'Wix', needle: 'wix.com' },
  { name: 'Squarespace', needle: 'squarespace' },
];

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function bytesToKb(bytes) {
  return (bytes / 1024).toFixed(1) + ' KB';
}

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

// ---------- Análisis ----------

function analyzeSite(outDir, assetMap, pagesInfo, startUrl, options, tree) {
  const cssFiles = [];
  const jsFiles = [];
  const imageFiles = [];
  const fontFiles = [];
  const allTextForDetection = [];

  for (const [remoteUrl, localPath] of assetMap.entries()) {
    let size = 0;
    try { size = fs.statSync(localPath).size; } catch { /* ignore */ }
    const rel = path.relative(outDir, localPath);
    const ext = path.extname(localPath).toLowerCase();

    if (ext === '.css') {
      const content = safeRead(localPath);
      cssFiles.push({ remoteUrl, rel, size, content });
      allTextForDetection.push(content);
    } else if (ext === '.js') {
      const content = safeRead(localPath);
      jsFiles.push({ remoteUrl, rel, size, content });
      allTextForDetection.push(content);
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'].includes(ext)) {
      imageFiles.push({ remoteUrl, rel, size });
    } else if (['.woff', '.woff2', '.ttf', '.otf'].includes(ext)) {
      fontFiles.push({ remoteUrl, rel, size });
    }
  }

  for (const p of pagesInfo) {
    allTextForDetection.push(safeRead(p.localPath));
  }

  const colorCounts = new Map();
  const fontCounts = new Map();
  for (const css of cssFiles) {
    const hexMatches = css.content.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    for (const hex of hexMatches) {
      const norm = hex.toLowerCase();
      colorCounts.set(norm, (colorCounts.get(norm) || 0) + 1);
    }
    const fontMatches = css.content.match(/font-family\s*:\s*([^;}{]+)/g) || [];
    for (const decl of fontMatches) {
      const value = decl.split(':')[1].trim();
      fontCounts.set(value, (fontCounts.get(value) || 0) + 1);
    }
  }

  const topColors = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topFonts = [...fontCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const combinedText = allTextForDetection.join('\n').toLowerCase();
  const detectedTech = TECH_SIGNATURES.filter((t) => combinedText.includes(t.needle.toLowerCase())).map((t) => t.name);

  const mainPage = pagesInfo.find((p) => p.url === startUrl) || pagesInfo[0];
  const mainHtml = mainPage ? safeRead(mainPage.localPath) : '';
  const largestCss = [...cssFiles].sort((a, b) => b.size - a.size)[0];
  const largestJs = [...jsFiles].sort((a, b) => b.size - a.size)[0];

  return {
    startUrl,
    generatedAt: new Date().toLocaleString(),
    options,
    tree,
    pagesInfo,
    cssFiles,
    jsFiles,
    imageFiles,
    fontFiles,
    topColors,
    topFonts,
    detectedTech,
    mainHtmlSnippet: truncate(mainHtml, 3500),
    largestCssSnippet: largestCss ? truncate(largestCss.content, 3500) : null,
    largestCssMeta: largestCss,
    largestJsSnippet: largestJs ? truncate(largestJs.content, 3500) : null,
    largestJsMeta: largestJs,
    totalSizeBytes: [...cssFiles, ...jsFiles, ...imageFiles, ...fontFiles].reduce((s, f) => s + (f.size || 0), 0),
  };
}

// ---------- Render Markdown ----------

function renderMarkdown(data) {
  const lines = [];
  lines.push(`# Documentación del sitio clonado`);
  lines.push(``);
  lines.push(`**URL analizada:** ${data.startUrl}`);
  lines.push(`**Fecha de generación:** ${data.generatedAt}`);
  lines.push(`**Páginas rastreadas:** ${data.pagesInfo.length} (máx. configurado: ${data.options.maxPages}, profundidad: ${data.options.maxDepth})`);
  lines.push(``);

  lines.push(`## 1. Resumen general`);
  lines.push(``);
  lines.push(`- Páginas HTML descargadas: **${data.pagesInfo.length}**`);
  lines.push(`- Hojas de estilo (CSS): **${data.cssFiles.length}**`);
  lines.push(`- Scripts (JS): **${data.jsFiles.length}**`);
  lines.push(`- Imágenes: **${data.imageFiles.length}**`);
  lines.push(`- Fuentes: **${data.fontFiles.length}**`);
  lines.push(`- Peso total de recursos: **${bytesToKb(data.totalSizeBytes)}**`);
  if (data.detectedTech.length) {
    lines.push(`- Tecnologías detectadas: **${data.detectedTech.join(', ')}**`);
  } else {
    lines.push(`- Tecnologías detectadas: no se identificaron firmas conocidas (posible HTML/CSS a medida).`);
  }
  lines.push(``);

  lines.push(`## 2. Estructura de páginas`);
  lines.push(``);
  for (const p of data.pagesInfo) {
    lines.push(`- **${p.title || '(sin título)'}** — \`${p.url}\` → \`${path.relative(process.cwd(), p.localPath)}\` (profundidad ${p.depth})`);
    if (p.headings && p.headings.length) {
      lines.push(`  - Encabezados: ${p.headings.join(' / ')}`);
    }
  }
  lines.push(``);

  lines.push(`## 3. Estilos (paleta y tipografías detectadas)`);
  lines.push(``);
  lines.push(`### Colores más usados`);
  if (data.topColors.length) {
    for (const [color, count] of data.topColors) {
      lines.push(`- \`${color}\` — usado ${count} veces`);
    }
  } else {
    lines.push(`- No se detectaron colores en formato hexadecimal.`);
  }
  lines.push(``);
  lines.push(`### Tipografías declaradas`);
  if (data.topFonts.length) {
    for (const [font, count] of data.topFonts) {
      lines.push(`- \`${font}\` — usado ${count} veces`);
    }
  } else {
    lines.push(`- No se detectaron declaraciones \`font-family\`.`);
  }
  lines.push(``);

  lines.push(`## 4. Archivos CSS encontrados`);
  lines.push(``);
  for (const css of data.cssFiles) {
    lines.push(`- \`${css.rel}\` (${bytesToKb(css.size)}) — origen: ${css.remoteUrl}`);
  }
  lines.push(``);

  lines.push(`## 5. Archivos JavaScript encontrados`);
  lines.push(``);
  for (const js of data.jsFiles) {
    lines.push(`- \`${js.rel}\` (${bytesToKb(js.size)}) — origen: ${js.remoteUrl}`);
  }
  lines.push(``);

  lines.push(`## 6. Cómo está armado (código de referencia)`);
  lines.push(``);
  lines.push(`### Estructura HTML de la página principal`);
  lines.push('```html');
  lines.push(data.mainHtmlSnippet.text);
  if (data.mainHtmlSnippet.truncated) lines.push('... (truncado, ver archivo completo en el ZIP) ...');
  lines.push('```');
  lines.push(``);

  if (data.largestCssMeta) {
    lines.push(`### Hoja de estilos principal (\`${data.largestCssMeta.rel}\`)`);
    lines.push('```css');
    lines.push(data.largestCssSnippet.text);
    if (data.largestCssSnippet.truncated) lines.push('... (truncado, ver archivo completo en el ZIP) ...');
    lines.push('```');
    lines.push(``);
  }

  if (data.largestJsMeta) {
    lines.push(`### Script principal (\`${data.largestJsMeta.rel}\`)`);
    lines.push('```js');
    lines.push(data.largestJsSnippet.text);
    if (data.largestJsSnippet.truncated) lines.push('... (truncado, ver archivo completo en el ZIP) ...');
    lines.push('```');
    lines.push(``);
  }

  lines.push(`## 7. Imágenes y fuentes`);
  lines.push(``);
  lines.push(`Total de imágenes descargadas: ${data.imageFiles.length} (${bytesToKb(data.imageFiles.reduce((s, f) => s + f.size, 0))})`);
  lines.push(`Total de fuentes descargadas: ${data.fontFiles.length}`);
  lines.push(``);

  lines.push(`## 8. Notas sobre reproducción`);
  lines.push(``);
  lines.push(`- Todos los enlaces internos y referencias a recursos fueron reescritos a rutas relativas dentro del ZIP.`);
  lines.push(`- Para ver el sitio localmente, abre el \`index.html\` correspondiente a la página que quieras revisar dentro de la carpeta del dominio.`);
  lines.push(`- Contenido generado dinámicamente por JavaScript en el navegador original puede no estar presente si dependía de peticiones \`fetch\`/XHR.`);
  lines.push(``);

  return lines.join('\n');
}

// ---------- Diagrama SVG del mapa del sitio ----------

function renderSiteMapSvg(tree) {
  if (!tree || tree.missing) {
    return '<svg viewBox="0 0 400 80" xmlns="http://www.w3.org/2000/svg"><text x="10" y="40" fill="#94a3b8" font-family="sans-serif" font-size="14">No hay estructura de páginas para mostrar.</text></svg>';
  }

  const boxW = 190;
  const boxH = 46;
  const colGap = 60;
  const rowGap = 20;
  const levels = [];

  function collect(node, depth, parent) {
    if (!levels[depth]) levels[depth] = [];
    const id = levels[depth].length;
    const entry = { node, depth, id, parent };
    levels[depth].push(entry);
    const children = (node.children || []).filter((c) => !c.missing && !c.cycle);
    for (const child of children) collect(child, depth + 1, entry);
    return entry;
  }
  collect(tree, 0, null);

  const positions = new Map();
  levels.forEach((row, depth) => {
    row.forEach((entry, i) => {
      const x = depth * (boxW + colGap) + 20;
      const y = i * (boxH + rowGap) + 20;
      positions.set(entry, { x, y });
    });
  });

  const maxRows = Math.max(...levels.map((r) => r.length));
  const width = levels.length * (boxW + colGap) + 40;
  const height = maxRows * (boxH + rowGap) + 40;

  let lines = '';
  let boxes = '';

  for (const row of levels) {
    for (const entry of row) {
      const { x, y } = positions.get(entry);
      const label = (entry.node.url ? new URL(entry.node.url).pathname : '/') || '/';
      const shortLabel = label.length > 26 ? label.slice(0, 24) + '…' : label;

      boxes += `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="8" fill="#1e293b" stroke="#6366f1" stroke-width="1.5"/>`;
      boxes += `<text x="${x + boxW / 2}" y="${y + boxH / 2 + 5}" fill="#e2e8f0" font-family="sans-serif" font-size="12" text-anchor="middle">${escapeHtml(shortLabel)}</text>`;

      if (entry.parent) {
        const p = positions.get(entry.parent);
        const startX = p.x + boxW;
        const startY = p.y + boxH / 2;
        const endX = x;
        const endY = y + boxH / 2;
        const midX = (startX + endX) / 2;
        lines += `<path d="M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}" stroke="#475569" stroke-width="1.5" fill="none"/>`;
      }
    }
  }

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif">
    <rect x="0" y="0" width="${width}" height="${height}" fill="#0f172a"/>
    ${lines}
    ${boxes}
  </svg>`;
}

// ---------- Render HTML ----------

function renderHtml(data) {
  const colorSwatches = data.topColors
    .map(([color, count]) => `<div class="swatch"><span class="chip" style="background:${escapeHtml(color)}"></span><code>${escapeHtml(color)}</code><small>${count}×</small></div>`)
    .join('');

  const fontsList = data.topFonts.map(([font, count]) => `<li><code>${escapeHtml(font)}</code> <small>(${count}×)</small></li>`).join('') || '<li>No detectadas</li>';

  const pagesList = data.pagesInfo
    .map((p) => `<li><strong>${escapeHtml(p.title || '(sin título)')}</strong><br><span class="muted">${escapeHtml(p.url)}</span> → <code>${escapeHtml(path.relative(process.cwd(), p.localPath))}</code>${p.headings && p.headings.length ? `<div class="muted">Encabezados: ${escapeHtml(p.headings.join(' / '))}</div>` : ''}</li>`)
    .join('');

  const cssList = data.cssFiles.map((c) => `<li><code>${escapeHtml(c.rel)}</code> — ${bytesToKb(c.size)} <span class="muted">(${escapeHtml(c.remoteUrl)})</span></li>`).join('') || '<li>Ninguno</li>';
  const jsList = data.jsFiles.map((j) => `<li><code>${escapeHtml(j.rel)}</code> — ${bytesToKb(j.size)} <span class="muted">(${escapeHtml(j.remoteUrl)})</span></li>`).join('') || '<li>Ninguno</li>';

  const techBadges = data.detectedTech.length
    ? data.detectedTech.map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join('')
    : '<span class="muted">No se identificaron firmas conocidas (posible HTML/CSS a medida)</span>';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>Documentación — ${escapeHtml(data.startUrl)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background:#0f172a; color:#e2e8f0; max-width: 860px; margin: 0 auto; padding: 40px 20px; line-height:1.5; }
  h1 { margin-bottom:4px; }
  h2 { margin-top:40px; border-bottom:1px solid #334155; padding-bottom:6px; }
  .muted { color:#94a3b8; font-size:13px; }
  code { background:#1e293b; padding:2px 6px; border-radius:4px; font-size:13px; }
  pre { background:#020617; border:1px solid #1e293b; border-radius:8px; padding:16px; overflow-x:auto; font-size:12.5px; }
  pre code { background:none; padding:0; }
  ul { padding-left: 20px; }
  li { margin-bottom: 8px; }
  .swatch { display:inline-flex; align-items:center; gap:6px; margin:4px 10px 4px 0; }
  .chip { width:16px; height:16px; border-radius:4px; display:inline-block; border:1px solid #334155; }
  .badge { display:inline-block; background:#312e81; color:#c7d2fe; padding:4px 10px; border-radius:999px; font-size:12px; margin:2px 4px 2px 0; }
  .stats { display:flex; flex-wrap:wrap; gap:12px; margin:16px 0; }
  .stat { background:#1e293b; border-radius:8px; padding:12px 16px; min-width:120px; }
  .stat b { font-size:20px; display:block; }
</style>
</head>
<body>
  <h1>📄 Documentación del sitio clonado</h1>
  <p class="muted">URL analizada: <strong>${escapeHtml(data.startUrl)}</strong> — generado el ${escapeHtml(data.generatedAt)}</p>

  <h2>1. Resumen general</h2>
  <div class="stats">
    <div class="stat"><b>${data.pagesInfo.length}</b>páginas</div>
    <div class="stat"><b>${data.cssFiles.length}</b>hojas CSS</div>
    <div class="stat"><b>${data.jsFiles.length}</b>scripts</div>
    <div class="stat"><b>${data.imageFiles.length}</b>imágenes</div>
    <div class="stat"><b>${bytesToKb(data.totalSizeBytes)}</b>peso total</div>
  </div>
  <p>Tecnologías detectadas: ${techBadges}</p>

  <h2>2. Estructura de páginas</h2>
  <ul>${pagesList}</ul>

  <h2>2.1 Mapa visual del sitio</h2>
  <div style="overflow-x:auto; background:#020617; border:1px solid #1e293b; border-radius:8px; padding:12px;">${renderSiteMapSvg(data.tree)}</div>

  <h2>3. Estilos: paleta de colores y tipografías</h2>
  <div>${colorSwatches || '<p class="muted">No se detectaron colores hexadecimales</p>'}</div>
  <p><strong>Tipografías declaradas:</strong></p>
  <ul>${fontsList}</ul>

  <h2>4. Archivos CSS</h2>
  <ul>${cssList}</ul>

  <h2>5. Archivos JavaScript</h2>
  <ul>${jsList}</ul>

  <h2>6. Cómo está armado (código de referencia)</h2>
  <p><strong>Estructura HTML de la página principal:</strong></p>
  <pre><code>${escapeHtml(data.mainHtmlSnippet.text)}${data.mainHtmlSnippet.truncated ? '\n... (truncado, ver archivo completo en el ZIP) ...' : ''}</code></pre>

  ${data.largestCssMeta ? `<p><strong>Hoja de estilos principal (${escapeHtml(data.largestCssMeta.rel)}):</strong></p>
  <pre><code>${escapeHtml(data.largestCssSnippet.text)}${data.largestCssSnippet.truncated ? '\n... (truncado) ...' : ''}</code></pre>` : ''}

  ${data.largestJsMeta ? `<p><strong>Script principal (${escapeHtml(data.largestJsMeta.rel)}):</strong></p>
  <pre><code>${escapeHtml(data.largestJsSnippet.text)}${data.largestJsSnippet.truncated ? '\n... (truncado) ...' : ''}</code></pre>` : ''}

  <h2>7. Notas sobre reproducción</h2>
  <ul>
    <li>Todos los enlaces internos y referencias a recursos fueron reescritos a rutas relativas dentro del ZIP.</li>
    <li>Abre el <code>index.html</code> de la página que quieras revisar dentro de la carpeta del dominio para verla localmente.</li>
    <li>Contenido generado dinámicamente por JavaScript en el sitio original puede no estar presente si dependía de peticiones fetch/XHR.</li>
  </ul>
</body>
</html>`;
}

// ---------- Exportar a Word (.docx) ----------

function codeParagraph(text) {
  const lines = text.split('\n').slice(0, 80);
  return new Paragraph({
    children: lines.map((line, i) => new TextRun({ text: line, font: 'Courier New', size: 18, break: i === 0 ? 0 : 1 })),
  });
}

async function renderDocx(data) {
  const children = [];

  children.push(new Paragraph({ text: 'Documentación del sitio clonado', heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({ text: `URL analizada: ${data.startUrl}` }));
  children.push(new Paragraph({ text: `Generado el: ${data.generatedAt}` }));

  children.push(new Paragraph({ text: '1. Resumen general', heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph({ text: `Páginas: ${data.pagesInfo.length}  |  CSS: ${data.cssFiles.length}  |  JS: ${data.jsFiles.length}  |  Imágenes: ${data.imageFiles.length}  |  Peso total: ${bytesToKb(data.totalSizeBytes)}` }));
  children.push(new Paragraph({ text: `Tecnologías detectadas: ${data.detectedTech.length ? data.detectedTech.join(', ') : 'ninguna firma conocida'}` }));

  children.push(new Paragraph({ text: '2. Estructura de páginas', heading: HeadingLevel.HEADING_1 }));
  for (const p of data.pagesInfo) {
    children.push(new Paragraph({ text: `${p.title || '(sin título)'} — ${p.url}`, bullet: { level: 0 } }));
    if (p.headings && p.headings.length) {
      children.push(new Paragraph({ text: `Encabezados: ${p.headings.join(' / ')}`, bullet: { level: 1 } }));
    }
  }

  children.push(new Paragraph({ text: '3. Estilos: colores y tipografías', heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph({ text: 'Colores más usados:' }));
  for (const [color, count] of data.topColors) {
    children.push(new Paragraph({ text: `${color} (usado ${count} veces)`, bullet: { level: 0 } }));
  }
  children.push(new Paragraph({ text: 'Tipografías declaradas:' }));
  for (const [font, count] of data.topFonts) {
    children.push(new Paragraph({ text: `${font} (usado ${count} veces)`, bullet: { level: 0 } }));
  }

  children.push(new Paragraph({ text: '4. Archivos CSS', heading: HeadingLevel.HEADING_1 }));
  for (const css of data.cssFiles) {
    children.push(new Paragraph({ text: `${css.rel} — ${bytesToKb(css.size)}`, bullet: { level: 0 } }));
  }

  children.push(new Paragraph({ text: '5. Archivos JavaScript', heading: HeadingLevel.HEADING_1 }));
  for (const js of data.jsFiles) {
    children.push(new Paragraph({ text: `${js.rel} — ${bytesToKb(js.size)}`, bullet: { level: 0 } }));
  }

  children.push(new Paragraph({ text: '6. Cómo está armado (código de referencia)', heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph({ text: 'HTML de la página principal:' }));
  children.push(codeParagraph(data.mainHtmlSnippet.text));

  if (data.largestCssMeta) {
    children.push(new Paragraph({ text: `Hoja de estilos principal (${data.largestCssMeta.rel}):` }));
    children.push(codeParagraph(data.largestCssSnippet.text));
  }
  if (data.largestJsMeta) {
    children.push(new Paragraph({ text: `Script principal (${data.largestJsMeta.rel}):` }));
    children.push(codeParagraph(data.largestJsSnippet.text));
  }

  children.push(new Paragraph({ text: '7. Notas sobre reproducción', heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph({ text: 'Los enlaces internos y recursos fueron reescritos a rutas relativas dentro del ZIP.', bullet: { level: 0 } }));
  children.push(new Paragraph({ text: 'Abre el index.html de la página deseada dentro de la carpeta del dominio para verla localmente.', bullet: { level: 0 } }));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ---------- Exportar a PDF (usando Puppeteer sobre el HTML ya generado) ----------

async function renderPdf(htmlContent, outPath) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, margin: { top: '20px', bottom: '20px' } });
  } finally {
    await browser.close();
  }
}

// ---------- Generador de prompt de IA para diseñar un sitio nuevo ----------

function buildAiPrompt(data, userContent) {
  const colors = data.topColors.slice(0, 6).map(([c]) => c).join(', ') || 'no se detectó una paleta clara';
  const fonts = data.topFonts.slice(0, 4).map(([f]) => f).join(', ') || 'tipografía del sistema, sin declaración explícita';
  const tech = data.detectedTech.length ? data.detectedTech.join(', ') : 'sin framework identificado (HTML/CSS a medida)';
  const pages = data.pagesInfo
    .map((p) => `- ${p.title || p.url}${p.headings && p.headings.length ? ' — secciones: ' + p.headings.join(', ') : ''}`)
    .join('\n');

  return `Quiero que diseñes un sitio web con una estructura y un estilo visual similares a los de referencia, pero usando exclusivamente MI PROPIO CONTENIDO (no copies textos, imágenes ni datos del sitio de referencia; úsalo solo como inspiración de estilo y organización).

ESTILO DE REFERENCIA:
- Paleta de colores principal: ${colors}
- Tipografías predominantes: ${fonts}
- Tecnología/framework de referencia: ${tech}

ESTRUCTURA DE PÁGINAS Y SECCIONES DE REFERENCIA:
${pages || '- (una sola página, sin subsecciones detectadas)'}

CONTENIDO REAL QUE QUIERO EN MI SITIO:
${userContent || '(sin especificar — pídeme el contenido antes de continuar)'}

Genera el HTML y CSS (o el stack que consideres mejor) de un sitio con una estructura de secciones equivalente a la de referencia, aplicando una paleta de colores y tipografía similares, pero desarrollado enteramente con mi contenido real indicado arriba.`;
}

module.exports = { analyzeSite, renderMarkdown, renderHtml, renderSiteMapSvg, renderDocx, renderPdf, buildAiPrompt };
