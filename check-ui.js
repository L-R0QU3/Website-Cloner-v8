const cheerio = require('cheerio');
const fs = require('fs');

const $ = cheerio.load(fs.readFileSync('public/index.html', 'utf8'));
const ids = ['singleUrl','singleExtractBtn','singleStatus','cloneForm','startBtn','url','maxPages','maxDepth','captureScreenshots','respectRobots','progressSection','statusBadge','log','downloadLink','reportLink','pdfLink','docxLink','treeSection','tree','aiPromptSection','generatePromptBtn','copyPromptBtn','promptResult','promptOutput','userContent','tab-site','tab-single'];
const missing = ids.filter((id) => $('#' + id).length === 0);
console.log('IDs faltantes:', missing.length ? missing.join(', ') : '(ninguno)');
console.log('tab-btns:', $('.tab-btn').length, '| data-tab:', $('.tab-btn').map((_, e) => $(e).attr('data-tab')).get().join(','));
console.log('tab-site hidden:', $('#tab-site').hasClass('hidden'), '| tab-single hidden:', $('#tab-single').hasClass('hidden'));
console.log('card-spotlight:', $('.card-spotlight').length);
console.log('Tailwind CDN presente:', !!$('script[src*="tailwindcss"]').length);
console.log('Google Fonts Inter:', !!$('link[href*="Inter"]').length);

const css = fs.readFileSync('public/style.css', 'utf8');
const o = (css.match(/\{/g) || []).length;
const c = (css.match(/\}/g) || []).length;
console.log('style.css llaves:', o, '/', c, o === c ? '(OK)' : '(DESBALANCEADO)');
console.log('blobs:', (css.match(/\.blob--/g) || []).length, '| keyframes blob:', (css.match(/@keyframes blob-/g) || []).length);
console.log('spotlight:', css.includes('card-spotlight') && css.includes('--mx'), '| accent #5E6AD2:', css.includes('#5E6AD2'));
