// ═══════════════════════════════════════════════════════════════════════════
// SERVIDOR HTTP - LeGaXi Seguimiento de Fantasmas v1.1
// 
// NUEVO en v1.1:
//   - Sirve el panel HTML desde /public
//   - Endpoint POST /api/marcar-seguimiento (registra seleccionados en DB)
//   - Endpoint POST /api/desmarcar-seguimiento (saca un cliente del flujo)
//   - Endpoint GET /api/estado-seguimiento (lista clientes en flujo activo)
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const { detectarFantasmas } = require('./detector');

const app = express();
const PORT = process.env.PORT || 3010;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Servir archivos estaticos del panel
app.use(express.static(path.join(__dirname, 'public')));

// ───────────────────────────────────────────────────────────────────────────
// API ENDPOINTS
// ───────────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Detectar fantasmas
app.get('/api/detectar', async (req, res) => {
    try {
        console.log(`[Server] /api/detectar solicitado desde ${req.ip}`);
        const resultado = await detectarFantasmas();
        res.json({ success: true, ...resultado });
    } catch (error) {
        console.error('[Server] Error en /api/detectar:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message
        });
    }
});

// Marcar uno o varios clientes para seguimiento
app.post('/api/marcar-seguimiento', async (req, res) => {
    try {
        const clientes = req.body.clientes || [];
        
        if (!Array.isArray(clientes) || clientes.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Se requiere un array "clientes" con al menos uno' 
            });
        }
        
        console.log(`[Server] Marcando ${clientes.length} clientes para seguimiento`);
        
        const inserted = [];
        const skipped = [];
        const errors = [];
        
        for (const c of clientes) {
            try {
                // Verificar que no este ya en flujo activo
                const existing = await pool.query(`
                    SELECT id, estado FROM seguimiento_clientes
                    WHERE telefono = $1 AND estado IN ('pendiente', 'en_curso')
                `, [c.telefono]);
                
                if (existing.rows.length > 0) {
                    skipped.push({ telefono: c.telefono, motivo: 'ya_en_flujo' });
                    continue;
                }
                
                // Insertar nuevo
                const result = await pool.query(`
                    INSERT INTO seguimiento_clientes (
                        telefono, cliente_nombre, saldo, dias_atraso, promotor,
                        estado, paso_actual
                    ) VALUES ($1, $2, $3, $4, $5, 'pendiente', 0)
                    RETURNING id
                `, [
                    c.telefono,
                    c.cliente || '',
                    parseFloat(c.saldo) || 0,
                    parseInt(c.diasAtraso) || 0,
                    c.promotor || ''
                ]);
                
                inserted.push({ 
                    id: result.rows[0].id, 
                    telefono: c.telefono,
                    cliente: c.cliente
                });
                
                // Log del evento
                await pool.query(`
                    INSERT INTO seguimiento_log (
                        seguimiento_id, telefono, tipo, canal, mensaje, disparado_por
                    ) VALUES ($1, $2, 'marcado_para_seguimiento', 'manual', 
                              'Cliente marcado desde panel manual', 'panel_manual')
                `, [result.rows[0].id, c.telefono]);
                
            } catch (err) {
                errors.push({ telefono: c.telefono, error: err.message });
            }
        }
        
        res.json({
            success: true,
            total: clientes.length,
            insertados: inserted.length,
            saltados: skipped.length,
            errores: errors.length,
            inserted,
            skipped,
            errors
        });
        
    } catch (error) {
        console.error('[Server] Error en /api/marcar-seguimiento:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Desmarcar un cliente del seguimiento
app.post('/api/desmarcar-seguimiento', async (req, res) => {
    try {
        const { telefono, motivo } = req.body;
        
        if (!telefono) {
            return res.status(400).json({ success: false, error: 'Telefono requerido' });
        }
        
        const result = await pool.query(`
            UPDATE seguimiento_clientes
            SET estado = 'excluido', 
                finalizado_motivo = $2,
                finalizado_en = CURRENT_TIMESTAMP
            WHERE telefono = $1 AND estado IN ('pendiente', 'en_curso')
            RETURNING id
        `, [telefono, motivo || 'excluido_manual']);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ 
                success: false, 
                error: 'Cliente no estaba en flujo activo' 
            });
        }
        
        // Log
        await pool.query(`
            INSERT INTO seguimiento_log (
                seguimiento_id, telefono, tipo, canal, mensaje, disparado_por
            ) VALUES ($1, $2, 'excluido', 'manual', $3, 'panel_manual')
        `, [result.rows[0].id, telefono, `Excluido del seguimiento: ${motivo || 'manual'}`]);
        
        res.json({ success: true, id: result.rows[0].id });
        
    } catch (error) {
        console.error('[Server] Error en /api/desmarcar-seguimiento:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Listar clientes actualmente en flujo
app.get('/api/estado-seguimiento', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                id, telefono, cliente_nombre, saldo, dias_atraso, promotor,
                estado, paso_actual, proximo_toque_en, ultimo_toque_canal,
                ultimo_toque_en, creado_en
            FROM seguimiento_clientes
            WHERE estado IN ('pendiente', 'en_curso')
            ORDER BY creado_en DESC
        `);
        
        res.json({ 
            success: true, 
            total: result.rows.length,
            clientes: result.rows 
        });
    } catch (error) {
        console.error('[Server] Error en /api/estado-seguimiento:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// ARRANQUE
// ───────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════════');
    console.log(`LeGaXi Seguimiento Fantasmas v1.1 - puerto ${PORT}`);
    console.log(`Configuracion:`);
    console.log(`  DATABASE_URL:      ${process.env.DATABASE_URL ? 'OK' : 'FALTA'}`);
    console.log(`  GOOGLE_SCRIPT_URL: ${process.env.GOOGLE_SCRIPT_URL ? 'OK' : 'FALTA'}`);
    console.log(`  DIAS_SIN_CONTACTO: ${process.env.DIAS_SIN_CONTACTO || 10}`);
    console.log(`Endpoints:`);
    console.log(`  GET  /                        - Panel HTML`);
    console.log(`  GET  /api/health              - Health check`);
    console.log(`  GET  /api/detectar            - Ejecuta deteccion`);
    console.log(`  GET  /api/estado-seguimiento  - Lista clientes en flujo`);
    console.log(`  POST /api/marcar-seguimiento  - Registra clientes en flujo`);
    console.log(`  POST /api/desmarcar-seguimiento - Saca cliente del flujo`);
    console.log('═══════════════════════════════════════════════════════');
});
