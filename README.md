# Website Cloner

App web local (Node.js + Express) para descargar el HTML, CSS, JS e imágenes de un sitio,
visualizar su estructura, generar documentación detallada y, si quieres, un solo archivo
HTML autocontenido para abrir una página localmente.

## ⚠️ Antes de usarla

Solo debes clonar sitios propios o para los que tengas permiso explícito. Copiar el
diseño, contenido o código de un sitio ajeno sin autorización puede infringir derechos
de autor o los términos de servicio del sitio. Esta herramienta es para backups
personales, aprendizaje o migraciones de tus propios proyectos.

## Instalación

```bash
cd website-cloner
npm install
npm start
```

Luego abre `http://localhost:3000` en tu navegador. La app tiene dos pestañas:

## Pestaña "Una sola página (archivo único)"

Pega la URL de una página y presiona "Extraer y descargar". La app:
- Carga la página con un navegador real (Puppeteer), incluyendo contenido generado por JavaScript.
- Descarga su CSS, JS e imágenes y los **incrusta directamente dentro del HTML**
  (CSS y JS como texto, imágenes como `data:` base64).
- Te entrega un único archivo `.html` que puedes abrir con doble clic, sin carpetas
  ni dependencias externas.

Ideal para guardar una página puntual rápido. Para clonar un sitio completo con varias
páginas enlazadas, usa la otra pestaña.

## Pestaña "Sitio completo"

1. Pega la URL del sitio y define:
   - **Máx. páginas**: cuántas páginas distintas seguirá el rastreador (por defecto 10).
   - **Profundidad de enlaces**: cuántos "saltos" de enlaces internos seguirá desde la
     página inicial (0 = solo esa página).
   - **Capturar screenshots**: guarda una imagen de cada página tal como se ve renderizada.
   - **Respetar robots.txt**: evita rastrear rutas que el propio sitio marca como no permitidas.
2. El servidor usa un navegador real (Puppeteer/Chromium) para cargar cada página como lo
   haría un visitante normal (incluyendo contenido generado por JavaScript). Además de leer
   el HTML, **intercepta directamente el tráfico de red del navegador** para capturar
   absolutamente todos los recursos que la página pide al cargar (imágenes, CSS, JS,
   fuentes, video/audio) — incluyendo los que no aparecen en atributos `src`/`href`
   reconocidos, como imágenes de fondo en `style="..."`, `srcset` con varias resoluciones,
   o recursos inyectados dinámicamente por JavaScript. Descarga todo, reescribe los enlaces
   para que funcionen en local, y sigue los enlaces internos del mismo dominio hasta llegar
   al límite indicado. Aplica una pequeña pausa entre peticiones (rate limiting) para no
   saturar el sitio de origen.
3. Verás el progreso en vivo y, al terminar, el árbol de páginas encontradas.
4. Puedes descargar todo como un `.zip` listo para abrir con doble clic en `index.html`
   de cualquier carpeta de dominio dentro del zip.
5. Además del zip, se genera automáticamente un **documento de documentación** en
   varios formatos (HTML, Markdown, PDF y Word — todos incluidos también dentro del zip) con:
   - Resumen general (número de páginas, CSS, JS, imágenes, peso total).
   - Tecnologías detectadas (WordPress, React, Bootstrap, Tailwind, etc., si aplica).
   - Estructura de páginas encontradas, con títulos y encabezados.
   - **Diagrama visual del mapa del sitio** (SVG con las páginas y sus enlaces).
   - Paleta de colores y tipografías extraídas del CSS.
   - Listado de archivos CSS y JS con su tamaño y origen.
   - Fragmentos de código reales (HTML de la página principal, CSS y JS más
     relevantes) para entender cómo está armado el sitio.
   - Notas sobre cómo reproducir la copia localmente.
6. **Generador de prompt de IA**: escribe en el cuadro de texto el contenido real que
   quieres en tu propio sitio (secciones, textos, servicios, etc.) y la app arma un
   prompt combinando ese contenido con el estilo, la paleta de colores y la estructura
   detectados en el sitio analizado. Puedes copiar ese prompt y pegarlo en cualquier IA
   (Claude, ChatGPT, etc.) para generar un sitio nuevo con tu propio contenido, inspirado
   en el diseño del sitio de referencia — sin copiar su texto ni sus imágenes.
7. **Detección automática de tecnología**: la app no necesita que le digas qué usa el
   sitio. En cada página, detecta por sí sola (revisando el HTML, las variables globales
   de JavaScript y la etiqueta `<meta name="generator">` ya renderizados en el navegador):
   - CMS/page builder: WordPress, Elementor, Divi, WPBakery.
   - Librerías de carrusel/slider: Swiper, Slider Revolution, LayerSlider, Owl Carousel, Slick, Flickity.

   Según lo que detecte, aplica automáticamente lo que haga falta:
   - Más tiempo de espera para que los widgets terminen de inicializarse.
   - Recorre carruseles Swiper slide por slide para forzar la carga de todas sus imágenes.
   - Hace clic en cualquier botón "siguiente" visible (sirve para Slider Revolution y
     carruseles a medida de temas, sin necesitar conocer su clase exacta).
   - Corrige anchos fijos en píxeles que algún script calculó según el tamaño de ventana
     usado para la captura (típico de secciones "stretched" de Elementor y de headers
     "full width" de otros temas).
   - **Reconstruye los carruseles conocidos (Swiper, Owl Carousel, Slick, Slider Revolution,
     LayerSlider) con un motor de carrusel propio, simple y dependiente solo de nuestro código** —
     en vez de intentar clonar el comportamiento exacto de la librería original (que se re-inicializa
     de forma distinta según el plugin y es prácticamente imposible de garantizar al 100%),
     la app extrae las imágenes y el contenido real de cada slide y arma un carrusel nuevo,
     minimalista, con sus propios botones de siguiente/anterior y puntos de navegación. Mismo
     contenido visual, cero dependencia del script original. Además hay un respaldo heurístico
     para carruseles a medida sin librería reconocida.
   - Escanea todo el HTML final en busca de URLs de imagen/fuente/video escondidas en JSON
     de atributos `data-settings` o en scripts inline (típico de Elementor), y las descarga
     y reescribe también aunque no estén en una etiqueta reconocida.

   Todo esto queda registrado en el log en vivo (por ejemplo: "Tecnología detectada:
   WordPress · Elementor · Swiper" y "Reconstruidos 2 carrusel(es) con un motor propio
   simple") para que sepas qué encontró y qué hizo en cada página.

## Limitaciones actuales

- Puppeteer descarga automáticamente una versión de Chromium (~200 MB) la primera vez
  que ejecutas `npm install`. Necesitas conexión a internet estable para ese paso; si
  estás detrás de un firewall corporativo que lo bloquea, puedes configurar
  `PUPPETEER_SKIP_DOWNLOAD=true` y apuntar `PUPPETEER_EXECUTABLE_PATH` a un Chrome ya
  instalado en tu equipo.
- El parser de `robots.txt` es simplificado (solo bloque `User-agent: *`, reglas
  `Disallow` por prefijo); no implementa el spec completo.
- Solo sigue enlaces `<a href>` dentro del mismo dominio (no subdominios distintos).
- Los recursos cargados dinámicamente después de la carga inicial (ej. scroll infinito)
  pueden no capturarse.
- El modo "página única" no sigue enlaces a otras páginas; solo incrusta lo que carga
  esa página concreta.
- La reconstrucción de carruseles reconoce Swiper, Owl Carousel, Slick, Slider Revolution y
  LayerSlider. Slider Revolution y LayerSlider tienen estructuras muy complejas (capas con
  animaciones, efectos Ken Burns, etc.) — la reconstrucción rescata la imagen de fondo y un
  título por slide, pero no replica animaciones ni capas adicionales. LayerSlider se lee además
  desde el HTML crudo del servidor, porque su JavaScript elimina las capas de texto durante la
  inicialización. Si un carrusel no usa ninguna librería conocida, se intenta un respaldo
  heurístico genérico (contenedor con clase de slider/carrusel y varios hijos con imágenes); si
  tampoco aplica, queda como estaba, con las correcciones generales de ancho/clics igual.

## Estructura del proyecto

```
website-cloner/
├── server.js       # Endpoints: clonado de sitio, página única, estado, descargas, prompt de IA
├── crawler.js      # Rastreo con Puppeteer, robots.txt, rate limiting, screenshots
├── report.js       # Análisis del sitio + documentación (HTML/MD/PDF/DOCX) + prompt de IA
├── robots.js       # Parser simplificado de robots.txt
├── singlepage.js   # Extracción de una sola página como HTML autocontenido
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── package.json
```
