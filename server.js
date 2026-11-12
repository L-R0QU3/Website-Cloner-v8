const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

// Ruta raíz
app.get('/', (req, res) => {
  res.status(200).send('Servidor funcionando correctamente');
});

// Ruta de Health Check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor mínimo corriendo en el puerto ${PORT}`);
});