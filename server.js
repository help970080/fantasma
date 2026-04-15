// ═══════════════════════════════════════════════════════════════════════════
// SERVIDOR HTTP - LeGaXi Seguimiento de Fantasmas v1.2
// 
// NUEVO en v1.2:
//   - Endpoints de envio: WhatsApp link, Baileys, IVR
//   - Endpoint de plantillas (devuelve mensaje pre-armado por paso)
//   - Endpoint de configuracion (panel sabe que botones mostrar)
//   - Endpoint de logs por cliente
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const { detectarFantasmas } = require('./detector');
const mensajeria = require('./mensajeria');

const app = express();
const PORT = process.env.PORT || 3010;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ───────────────────────────────────────────────────────────────────────────
// API: Health & Config
// ───────────────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.get('/api/config', (req, res) => {
    res.json({
        success: true,
        ...mensajeria.getConfig()
    });
});

// ───────────────────────────────────────────────────────────────────────────
// API: Detector
// ───────────────────────────────────────────────────────────────────────────

app.get('/api/detectar', async (req, res) => {
    try {
        const resultado = await detectarFantasmas();
        res.json({ success: true, ...resultado });
    } catch (error) {
        console.error('[Server] Error en /api/detectar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Marcar para seguimiento
// ───────────────────────────────────────────────────────────────────────────

app.post('/api/marcar-seguimiento', async (req, res) => {
    try {
        const clientes = req.body.clientes || [];
        if (!Array.isArray(clientes) || clientes.length === 0) {
            return res.status(400).json({ success: false, error: 'Array clientes requerido' });
        }
        
        const inserted = [], skipped = [], errors = [];
        
        for (const c of clientes) {
            try {
                const existing = await pool.query(`
                    SELECT id FROM seguimiento_clientes
                    WHERE telefono = $1 AND estado IN ('pendiente', 'en_curso')
                `, [c.telefono]);
                
                if (existing.rows.length > 0) {
                    skipped.push({ telefono: c.telefono, motivo: 'ya_en_flujo', id: existing.rows[0].id });
                    continue;
                }
                
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
                
                inserted.push({ id: result.rows[0].id, telefono: c.telefono, cliente: c.cliente });
                
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
            inserted, skipped, errors
        });
    } catch (error) {
        console.error('[Server] Error en /api/marcar-seguimiento:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Generar mensaje (preview de plantilla por paso)
// ───────────────────────────────────────────────────────────────────────────

app.post('/api/generar-mensaje', (req, res) => {
    try {
        const { paso, cliente, saldo, diasAtraso } = req.body;
        const mensaje = mensajeria.generarMensajePorPaso(
            parseInt(paso) || 1,
            cliente || 'Cliente',
            parseFloat(saldo) || 0,
            parseInt(diasAtraso) || 0
        );
        res.json({ success: true, mensaje });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Generar link WhatsApp (modo manual)
// Retorna URL wa.me y registra el evento. El frontend abre la URL.
// ───────────────────────────────────────────────────────────────────────────

app.post('/api/enviar/whatsapp-link', async (req, res) => {
    try {
        const { telefono, cliente, saldo, diasAtraso, paso, mensajePersonalizado } = req.body;
        
        if (!telefono) {
            return res.status(400).json({ success: false, error: 'Telefono requerido' });
        }
        
        const mensaje = mensajePersonalizado || mensajeria.generarMensajePorPaso(
            parseInt(paso) || 1,
            cliente || 'Cliente',
            parseFloat(saldo) || 0,
            parseInt(diasAtraso) || 0
        );
        
        const link = mensajeria.generarLinkWhatsApp({ telefono, mensaje });
        
        // Buscar si esta en flujo activo para asociar el log
        const flujo = await pool.query(`
            SELECT id FROM seguimiento_clientes
            WHERE telefono = $1 AND estado IN ('pendiente', 'en_curso')
            LIMIT 1
        `, [telefono]);
        
        const seguimientoId = flujo.rows[0]?.id || null;
        
        // Registrar el evento (asume que el usuario va a enviar al abrir el link)
        await mensajeria.registrarEnvioLink({
            seguimientoId,
            telefono,
            paso: parseInt(paso) || 1,
            mensaje
        });
        
        res.json({ success: true, link, mensaje, seguimientoId });
        
    } catch (error) {
        console.error('[Server] Error en /api/enviar/whatsapp-link:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Enviar via Baileys (automatico)
// ───────────────────────────────────────────────────────────────────────────

app.post('/api/enviar/whatsapp-auto', async (req, res) => {
    try {
        const { telefono, cliente, saldo, diasAtraso, paso, mensajePersonalizado } = req.body;
        
        if (!telefono) {
            return res.status(400).json({ success: false, error: 'Telefono requerido' });
        }
        
        const mensaje = mensajePersonalizado || mensajeria.generarMensajePorPaso(
            parseInt(paso) || 1,
            cliente || 'Cliente',
            parseFloat(saldo) || 0,
            parseInt(diasAtraso) || 0
        );
        
        const flujo = await pool.query(`
            SELECT id FROM seguimiento_clientes
            WHERE telefono = $1 AND estado IN ('pendiente', 'en_curso')
            LIMIT 1
        `, [telefono]);
        
        const seguimientoId = flujo.rows[0]?.id || null;
        
        const result = await mensajeria.enviarPorBaileys({
            seguimientoId,
            telefono,
            paso: parseInt(paso) || 1,
            mensaje
        });
        
        res.json({ success: result.exitoso, ...result, mensaje });
        
    } catch (error) {
        console.error('[Server] Error en /api/enviar/whatsapp-auto:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Llamar via IVR
// ───────────────────────────────────────────────────────────────────────────

app.post('/api/enviar/llamada-ivr', async (req, res) => {
    try {
        const { telefono, cliente, saldo, diasAtraso, paso } = req.body;
        
        if (!telefono) {
            return res.status(400).json({ success: false, error: 'Telefono requerido' });
        }
        
        const flujo = await pool.query(`
            SELECT id FROM seguimiento_clientes
            WHERE telefono = $1 AND estado IN ('pendiente', 'en_curso')
            LIMIT 1
        `, [telefono]);
        
        const seguimientoId = flujo.rows[0]?.id || null;
        
        const result = await mensajeria.llamarPorIVR({
            seguimientoId,
            telefono,
            paso: parseInt(paso) || 1,
            cliente,
            saldo: parseFloat(saldo) || 0,
            diasAtraso: parseInt(diasAtraso) || 0
        });
        
        res.json({ success: result.exitoso, ...result });
        
    } catch (error) {
        console.error('[Server] Error en /api/enviar/llamada-ivr:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Estado de seguimiento (lista clientes en flujo)
// ───────────────────────────────────────────────────────────────────────────

app.get('/api/estado-seguimiento', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                id, telefono, cliente_nombre, saldo, dias_atraso, promotor,
                estado, paso_actual, proximo_toque_en, ultimo_toque_canal,
                ultimo_toque_en, creado_en
            FROM seguimiento_clientes
            WHERE estado IN ('pendiente', 'en_curso')
            ORDER BY 
                CASE WHEN proximo_toque_en IS NULL THEN 0 ELSE 1 END,
                proximo_toque_en ASC,
                creado_en DESC
        `);
        
        res.json({ success: true, total: result.rows.length, clientes: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Logs de un cliente especifico
// ───────────────────────────────────────────────────────────────────────────

app.get('/api/logs/:telefono', async (req, res) => {
    try {
        const tel = String(req.params.telefono).replace(/\D/g, '').slice(-10);
        const result = await pool.query(`
            SELECT id, tipo, canal, paso, mensaje, respuesta, exitoso, 
                   error_detalle, disparado_por, creado_en
            FROM seguimiento_log
            WHERE telefono = $1 OR telefono LIKE $2
            ORDER BY creado_en DESC
            LIMIT 100
        `, [tel, '%' + tel]);
        
        res.json({ success: true, total: result.rows.length, logs: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Excluir / desmarcar cliente del flujo
// ───────────────────────────────────────────────────────────────────────────

app.post('/api/desmarcar-seguimiento', async (req, res) => {
    try {
        const { telefono, motivo } = req.body;
        if (!telefono) return res.status(400).json({ success: false, error: 'Telefono requerido' });
        
        const result = await pool.query(`
            UPDATE seguimiento_clientes
            SET estado = 'excluido', 
                finalizado_motivo = $2,
                finalizado_en = CURRENT_TIMESTAMP
            WHERE telefono = $1 AND estado IN ('pendiente', 'en_curso')
            RETURNING id
        `, [telefono, motivo || 'excluido_manual']);
        
        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, error: 'No estaba en flujo activo' });
        }
        
        await pool.query(`
            INSERT INTO seguimiento_log (seguimiento_id, telefono, tipo, canal, mensaje, disparado_por)
            VALUES ($1, $2, 'excluido', 'manual', $3, 'panel_manual')
        `, [result.rows[0].id, telefono, `Excluido: ${motivo || 'manual'}`]);
        
        res.json({ success: true, id: result.rows[0].id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// ARRANQUE
// ───────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    const config = mensajeria.getConfig();
    console.log('═══════════════════════════════════════════════════════');
    console.log(`LeGaXi Seguimiento Fantasmas v1.2 - puerto ${PORT}`);
    console.log(`Configuracion:`);
    console.log(`  DATABASE_URL:        ${process.env.DATABASE_URL ? 'OK' : 'FALTA'}`);
    console.log(`  GOOGLE_SCRIPT_URL:   ${process.env.GOOGLE_SCRIPT_URL ? 'OK' : 'FALTA'}`);
    console.log(`  WhatsApp link:       ${config.whatsappLink ? 'ON' : 'OFF'}`);
    console.log(`  WhatsApp Baileys:    ${config.whatsappBaileys ? 'ON' : 'OFF (configurar CHATBOT_BAILEYS_URL)'}`);
    console.log(`  Llamada IVR:         ${config.llamadaIVR ? 'ON' : 'OFF (configurar IVR_ZADARMA_URL)'}`);
    console.log(`Endpoints principales:`);
    console.log(`  GET  /                          - Panel HTML`);
    console.log(`  GET  /api/detectar              - Ejecutar deteccion`);
    console.log(`  GET  /api/config                - Configuracion disponible`);
    console.log(`  POST /api/enviar/whatsapp-link  - Genera URL wa.me`);
    console.log(`  POST /api/enviar/whatsapp-auto  - Envia via Baileys`);
    console.log(`  POST /api/enviar/llamada-ivr    - Inicia llamada IVR`);
    console.log(`  GET  /api/logs/:telefono        - Historial de un cliente`);
    console.log('═══════════════════════════════════════════════════════');
});
