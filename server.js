// ═══════════════════════════════════════════════════════════════════════════
// SERVIDOR HTTP - LeGaXi Seguimiento de Fantasmas
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { detectarFantasmas } = require('./detector');

const app = express();
const PORT = process.env.PORT || 3010;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ───────────────────────────────────────────────────────────────────────────
// ENDPOINTS
// ───────────────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
    res.json({
        service: 'legaxi-seguimiento-fantasmas',
        status: 'running',
        version: '1.0.0',
        endpoints: [
            'GET  /health',
            'GET  /api/detectar       - Ejecuta deteccion y retorna fantasmas'
        ]
    });
});

app.get('/health', (req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Endpoint principal: ejecutar deteccion
app.get('/api/detectar', async (req, res) => {
    try {
        console.log(`[Server] /api/detectar solicitado desde ${req.ip}`);
        const resultado = await detectarFantasmas();
        res.json({ success: true, ...resultado });
    } catch (error) {
        console.error('[Server] Error en /api/detectar:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            stack: error.stack
        });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// ARRANQUE
// ───────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════════');
    console.log(`LeGaXi Seguimiento Fantasmas - puerto ${PORT}`);
    console.log(`Configuracion:`);
    console.log(`  DATABASE_URL: ${process.env.DATABASE_URL ? 'OK' : 'FALTA'}`);
    console.log(`  GOOGLE_SCRIPT_URL: ${process.env.GOOGLE_SCRIPT_URL ? 'OK' : 'FALTA'}`);
    console.log(`  DIAS_SIN_CONTACTO: ${process.env.DIAS_SIN_CONTACTO || 10}`);
    console.log('═══════════════════════════════════════════════════════');
});
