// ---------- Pestañas ----------
const tabBtns = document.querySelectorAll('.tab-btn');
const tabPanels = { site: document.getElementById('tab-site'), single: document.getElementById('tab-single') };

tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    Object.values(tabPanels).forEach((p) => p.classList.add('hidden'));
    tabPanels[btn.dataset.tab].classList.remove('hidden');
  });
});

// ---------- Extracción de página única ----------
const singleUrlInput = document.getElementById('singleUrl');
const singleExtractBtn = document.getElementById('singleExtractBtn');
const singleStatus = document.getElementById('singleStatus');

singleExtractBtn.addEventListener('click', async () => {
  const url = singleUrlInput.value.trim();
  if (!url) {
    showSingleStatus('Ingresa una URL válida.', 'error');
    return;
  }

  singleExtractBtn.disabled = true;
  singleExtractBtn.textContent = 'Extrayendo...';
  showSingleStatus('Cargando la página y descargando sus recursos, puede tardar unos segundos...', '');

  try {
    const res = await fetch('/api/single-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showSingleStatus(data.error || 'No se pudo extraer la página.', 'error');
      return;
    }

    const blob = await res.blob();
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = 'pagina-completa.html';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(downloadUrl);

    showSingleStatus('¡Listo! Se descargó el archivo HTML autocontenido.', 'success');
  } catch (err) {
    showSingleStatus('Error de conexión: ' + err.message, 'error');
  } finally {
    singleExtractBtn.disabled = false;
    singleExtractBtn.textContent = 'Extraer y descargar';
  }
});

function showSingleStatus(msg, type) {
  singleStatus.textContent = msg;
  singleStatus.className = 'muted-status' + (type ? ' ' + type : '');
  singleStatus.classList.remove('hidden');
}

// ---------- Clonado de sitio completo ----------
const form = document.getElementById('cloneForm');
const startBtn = document.getElementById('startBtn');
const progressSection = document.getElementById('progressSection');
const statusBadge = document.getElementById('statusBadge');
const logDiv = document.getElementById('log');
const downloadLink = document.getElementById('downloadLink');
const reportLink = document.getElementById('reportLink');
const pdfLink = document.getElementById('pdfLink');
const docxLink = document.getElementById('docxLink');
const treeSection = document.getElementById('treeSection');
const treeDiv = document.getElementById('tree');
const aiPromptSection = document.getElementById('aiPromptSection');
const generatePromptBtn = document.getElementById('generatePromptBtn');
const copyPromptBtn = document.getElementById('copyPromptBtn');
const promptResult = document.getElementById('promptResult');
const promptOutput = document.getElementById('promptOutput');
const userContentInput = document.getElementById('userContent');

let pollTimer = null;
let currentJobId = null;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = document.getElementById('url').value.trim();
  const maxPages = document.getElementById('maxPages').value;
  const maxDepth = document.getElementById('maxDepth').value;
  const captureScreenshots = document.getElementById('captureScreenshots').checked;
  const respectRobots = document.getElementById('respectRobots').checked;

  startBtn.disabled = true;
  startBtn.textContent = 'Clonando...';
  progressSection.classList.remove('hidden');
  treeSection.classList.add('hidden');
  aiPromptSection.classList.add('hidden');
  promptResult.classList.add('hidden');
  downloadLink.classList.add('hidden');
  reportLink.classList.add('hidden');
  pdfLink.classList.add('hidden');
  docxLink.classList.add('hidden');
  logDiv.textContent = '';

  try {
    const res = await fetch('/api/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, maxPages, maxDepth, captureScreenshots, respectRobots }),
    });
    const data = await res.json();

    if (!res.ok) {
      statusBadge.textContent = 'error';
      logDiv.textContent = data.error || 'Error desconocido';
      resetButton();
      return;
    }

    currentJobId = data.jobId;
    poll(data.jobId);
  } catch (err) {
    statusBadge.textContent = 'error';
    logDiv.textContent = 'No se pudo conectar con el servidor: ' + err.message;
    resetButton();
  }
});

function resetButton() {
  startBtn.disabled = false;
  startBtn.textContent = 'Iniciar clonado';
}

function poll(jobId) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/status/${jobId}`);
      const data = await res.json();

      // Validar si la respuesta HTTP no fue exitosa (ej. el servidor se reinició)
      if (!res.ok) {
        clearInterval(pollTimer);
        statusBadge.textContent = 'error';
        logDiv.textContent += `\n⚠️ Error del servidor: ${data.error || 'La tarea se perdió porque el servidor se reinició.'}`;
        logDiv.scrollTop = logDiv.scrollHeight;
        resetButton();
        return;
      }

      statusBadge.textContent = data.status;
      
      // Verificación defensiva para evitar el TypeError
      if (data.log && Array.isArray(data.log)) {
        logDiv.textContent = data.log.join('\n');
        logDiv.scrollTop = logDiv.scrollHeight;
      }

      if (data.status === 'done') {
        clearInterval(pollTimer);
        downloadLink.href = `/api/download/${jobId}`;
        downloadLink.classList.remove('hidden');

        if (data.reportReady) {
          reportLink.href = `/api/report/${jobId}`;
          reportLink.classList.remove('hidden');
        }
        if (data.pdfReady) {
          pdfLink.href = `/api/report/${jobId}/pdf`;
          pdfLink.classList.remove('hidden');
        }
        if (data.docxReady) {
          docxLink.href = `/api/report/${jobId}/docx`;
          docxLink.classList.remove('hidden');
        }
        if (data.aiPromptReady) {
          aiPromptSection.classList.remove('hidden');
        }

        resetButton();
        if (data.tree) renderTree(data.tree);
      }

      if (data.status === 'error') {
        clearInterval(pollTimer);
        resetButton();
      }
    } catch (err) {
      clearInterval(pollTimer);
      statusBadge.textContent = 'error';
      logDiv.textContent += `\n⚠️ Error de conexión con el servidor: ${err.message}`;
      resetButton();
    }
  }, 1200);
}

generatePromptBtn.addEventListener('click', async () => {
  if (!currentJobId) return;
  generatePromptBtn.disabled = true;
  generatePromptBtn.textContent = 'Generando...';

  try {
    const res = await fetch(`/api/ai-prompt/${currentJobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userContent: userContentInput.value }),
    });
    const data = await res.json();

    if (!res.ok) {
      alert(data.error || 'No se pudo generar el prompt');
      return;
    }

    promptOutput.value = data.prompt;
    promptResult.classList.remove('hidden');
  } catch (err) {
    alert('Error de conexión: ' + err.message);
  } finally {
    generatePromptBtn.disabled = false;
    generatePromptBtn.textContent = 'Generar prompt';
  }
});

copyPromptBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(promptOutput.value);
    const original = copyPromptBtn.textContent;
    copyPromptBtn.textContent = '¡Copiado!';
    setTimeout(() => { copyPromptBtn.textContent = original; }, 1500);
  } catch {
    promptOutput.select();
    document.execCommand('copy');
  }
});

function renderTree(node) {
  treeSection.classList.remove('hidden');
  treeDiv.innerHTML = '';
  treeDiv.appendChild(buildNodeEl(node));
}

function buildNodeEl(node) {
  const li = document.createElement('li');
  const urlSpan = document.createElement('span');
  urlSpan.className = 'node-url';
  urlSpan.textContent = node.url || '(desconocido)';
  li.appendChild(urlSpan);

  if (node.path) {
    const pathSpan = document.createElement('span');
    pathSpan.className = 'node-path';
    pathSpan.textContent = node.path;
    li.appendChild(pathSpan);
  }

  if (node.children && node.children.length) {
    const ul = document.createElement('ul');
    node.children.forEach((child) => ul.appendChild(buildNodeEl(child)));
    li.appendChild(ul);
  }

  const wrapper = document.createElement('ul');
  wrapper.appendChild(li);
  return wrapper;
}