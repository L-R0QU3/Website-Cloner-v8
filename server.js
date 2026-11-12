const express = require('express');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const { createJob, crawlSite, log } = require('./crawler');
const { buildAiPrompt } = require('./report');
const { extractSinglePageInline } = require('./singlepage');

<<<<<<< HEAD
const app = express();
=======
// --- PASO 2a: Importar las reglas de seguridad ---
const { basicAuth, assertPublicUrl } = require('./security');

const app = express();

// --- PASO 2b: Configurar el health check y la contraseña ---
// Health check para Render (debe ir ANTES de la contraseña)
app.get('/healthz', (req, res) => res.send('ok'));

// Pide usuario y contraseña a toda la app
app.use(basicAuth);
// -----------------------------------------------------------

>>>>>>> 127069db377c0b66916fba3188d45060eef2f870
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const jobs = new Map();

<<<<<<< HEAD
app.post('/api/clone', (req, res) => {
=======
// --- PASO 2c: Convertir a async y agregar validación de URL pública ---
app.post('/api/clone', async (req, res) => {
>>>>>>> 127069db377c0b66916fba3188d45060eef2f870
  const { url, maxPages, maxDepth, captureScreenshots, respectRobots, politeDelayMs } = req.body;

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Debes indicar una URL válida que empiece con http:// o https://' });
  }

<<<<<<< HEAD
=======
  // --- Validación anti-hackers ---
  try {
    await assertPublicUrl(url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // -------------------------------

>>>>>>> 127069db377c0b66916fba3188d45060eef2f870
  const jobId = uuidv4();
  const job = createJob();
  job.id = jobId;
  jobs.set(jobId, job);

  const options = {
    maxPages: Math.min(Math.max(parseInt(maxPages) || 10, 1), 200),
    maxDepth: Math.min(Math.max(parseInt(maxDepth) || 1, 0), 5),
    captureScreenshots: captureScreenshots !== false,
    respectRobots: respectRobots !== false,
    politeDelayMs: Math.min(Math.max(parseInt(politeDelayMs) || 300, 0), 5000),
  };

  crawlSite(job, url, options)
    .then((outDir) => {
      const zipPath = path.join(__dirname, 'clones', `${jobId}.zip`);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        job.zipPath = zipPath;
        job.status = 'done';
        log(job, `ZIP listo (${(archive.pointer() / 1024).toFixed(1)} KB).`);
      });

      archive.on('error', (err) => {
        job.status = 'error';
        job.error = err.message;
      });

      archive.pipe(output);
      archive.directory(outDir, false);
      archive.finalize();
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err.message;
      log(job, `Error fatal: ${err.message}`);
    });

  res.json({ jobId });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
<<<<<<< HEAD
  
  // Si el servidor se reinició (Render Sleep), la tarea se pierde.
  // Devolvemos un JSON válido en lugar de un 404 para que el frontend no se rompa.
  if (!job) {
    return res.json({ 
      status: 'error', 
      log: ['❌ Error: La tarea no se encontró. El servidor probablemente se reinició o la sesión expiró.'],
      error: 'Job no encontrado en la memoria del servidor'
    });
  }

  res.json({
    status: job.status,
    log: job.log || [],
=======
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });

  res.json({
    status: job.status,
    log: job.log,
>>>>>>> 127069db377c0b66916fba3188d45060eef2f870
    doneCount: job.doneCount,
    queuedCount: job.queuedCount,
    tree: job.tree,
    downloadReady: job.status === 'done',
    reportReady: !!job.reportPath,
    pdfReady: !!job.pdfPath,
    docxReady: !!job.docxPath,
    aiPromptReady: !!job.reportData,
    error: job.error,
  });
});

app.get('/api/report/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.reportPath || !fs.existsSync(job.reportPath)) {
    return res.status(404).send('La documentación aún no está lista o el job no existe.');
  }
  try {
    const html = fs.readFileSync(job.reportPath, 'utf8');
    res.type('html').send(html);
  } catch (e) {
    res.status(500).send('No se pudo leer el documento: ' + e.message);
  }
});

app.get('/api/report/:jobId/pdf', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.pdfPath || !fs.existsSync(job.pdfPath)) {
    return res.status(404).send('El PDF aún no está listo o el job no existe.');
  }
  res.download(job.pdfPath, 'documentacion.pdf');
});

app.get('/api/report/:jobId/docx', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.docxPath || !fs.existsSync(job.docxPath)) {
    return res.status(404).send('El documento Word aún no está listo o el job no existe.');
  }
  res.download(job.docxPath, 'documentacion.docx');
});

app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.zipPath || !fs.existsSync(job.zipPath)) {
    return res.status(404).send('El archivo aún no está listo o el job no existe.');
  }
  res.download(job.zipPath, 'sitio-clonado.zip');
});

app.post('/api/ai-prompt/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.reportData) {
    return res.status(404).json({ error: 'Todavía no hay análisis disponible para este job.' });
  }
  const { userContent } = req.body;
  try {
    const prompt = buildAiPrompt(job.reportData, (userContent || '').trim());
    res.json({ prompt });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo generar el prompt: ' + e.message });
  }
});

// Extrae UNA sola página como archivo HTML autocontenido (CSS/JS/imágenes incrustados)
app.post('/api/single-page', async (req, res) => {
  const { url } = req.body;
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Debes indicar una URL válida que empiece con http:// o https://' });
  }
<<<<<<< HEAD
=======

  // --- PASO 2c: Validación anti-hackers también aquí ---
  try {
    await assertPublicUrl(url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  // ------------------------------------------------------

>>>>>>> 127069db377c0b66916fba3188d45060eef2f870
  try {
    const html = await extractSinglePageInline(url);
    res.setHeader('Content-Disposition', 'attachment; filename="pagina-completa.html"');
    res.type('html').send(html);
  } catch (e) {
    res.status(500).json({ error: 'No se pudo extraer la página: ' + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Website Cloner corriendo en http://localhost:${PORT}`);
});