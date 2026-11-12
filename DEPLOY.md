# Subir Website Cloner a GitHub y ponerlo online en Render

## Por qué Render y no Vercel

Vercel ejecuta funciones serverless de corta duración: no mantiene un servidor vivo, no
guarda el estado de los trabajos en memoria entre peticiones y no está pensado para correr
Chromium completo durante minutos. Esta app necesita justo eso. **Render** (con Docker)
sí ejecuta un servidor Node normal y permite instalar Chromium.

## Paso 1 — Copiar el kit a tu proyecto

Copia estos archivos a la **raíz** de tu carpeta `Website Cloner v8` (junto a `server.js`):

- `Dockerfile`
- `.dockerignore`
- `.gitignore`
- `render.yaml`
- `security.js`

No pisan nada tuyo: son archivos nuevos.

## Paso 2 — Conectar la seguridad en `server.js` (3 cambios pequeños)

Sin esto, cualquier persona que encuentre tu URL podría usar tu servidor para clonar
sitios o hacer que lea direcciones internas. Es imprescindible antes de publicarlo.

**a)** Arriba del archivo, junto a los otros `require`:

```js
const { basicAuth, assertPublicUrl } = require('./security');
```

**b)** Justo después de `const app = express();`, **antes** de `app.use(express.static(...))`:

```js
// Health check para Render (debe ir ANTES de la contraseña)
app.get('/healthz', (req, res) => res.send('ok'));

// Pide usuario y contraseña a toda la app
app.use(basicAuth);
```

**c)** En los dos endpoints que reciben una URL (`POST /api/clone` y `POST /api/single-page`),
conviértelos en `async (req, res)` y agrega esto justo después de validar `url`:

```js
try {
  await assertPublicUrl(url);
} catch (e) {
  return res.status(400).json({ error: e.message });
}
```

En local no cambia nada: sin las variables `APP_USER`/`APP_PASSWORD` y fuera de producción,
la app sigue abierta como siempre.

## Paso 3 — Subir a GitHub

1. Crea un repositorio nuevo en https://github.com/new. **Ponlo Privado**: es una
   herramienta personal y no hay motivo para publicar el código.
2. Sin crear README ni .gitignore desde GitHub (ya tienes los tuyos).
3. En PowerShell, dentro de la carpeta del proyecto:

```powershell
git init
git add .
git commit -m "Website Cloner v8"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

El `.gitignore` evita subir `node_modules/` y `clones/` (que pueden pesar cientos de MB).
Comprueba con `git status` antes del commit que no aparezcan.

## Paso 4 — Desplegar en Render

1. Crea una cuenta en https://render.com e inicia sesión con GitHub.
2. **New +** → **Blueprint** → elige tu repositorio (usa el `render.yaml`).
   Alternativa manual: **New +** → **Web Service** → tu repo → Runtime **Docker**.
3. Cuando te lo pida, define las variables:
   - `APP_USER` → el usuario que quieras
   - `APP_PASSWORD` → una contraseña larga y única
4. Pulsa **Deploy**. La primera construcción tarda varios minutos (instala Chromium).
5. Render te da una URL tipo `https://website-cloner-xxxx.onrender.com`. Al abrirla, el
   navegador te pedirá el usuario y la contraseña.

## Qué esperar del plan gratuito

Verifica las condiciones vigentes en la página de precios de Render, pero en general:

- **Se duerme por inactividad**: la primera visita tras un rato tarda en despertar.
- **Poca memoria**: Chromium consume bastante. Sitios muy pesados o muchas páginas pueden
  hacer que el proceso se reinicie. Empieza con pocas páginas (5–10) y sin screenshots
  si ves cierres.
- **Disco temporal**: los ZIP generados se pierden al reiniciar o redesplegar. Descarga el
  resultado apenas termine.
- **Los trabajos viven en memoria**: si el servicio se reinicia a mitad de un clonado, ese
  trabajo se pierde y hay que repetirlo.

Si con el tiempo necesitas más estabilidad, sube a un plan de pago con más memoria, o
mueve la misma imagen Docker a otro proveedor (Railway, Fly.io) o a un VPS pequeño.

## Uso responsable

Al ser público en internet, mantén la contraseña privada y usa la herramienta solo en
sitios propios o con permiso del titular, respetando derechos de autor y términos de uso.
