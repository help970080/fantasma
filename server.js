// ═══════════════════════════════════════════════════════════════════════════
// SERVIDOR HTTP - LeGaXi Seguimiento de Fantasmas v1.4
// 
// NUEVO en v1.4:
//   - AUTO-RUNNER: persecución automática por horas (no por días)
//   - Cron interno cada 15 min, horario 9-20h Lun-Sáb
//   - Pausa automática al recibir respuesta del cliente
//   - Notificación al admin cuando alguien se agota (3 días)
//   - Endpoints /api/auto-runner/estado, /toggle, /ejecutar-ahora
//
// HISTÓRICO v1.2:
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
const autoRunner = require('./auto-runner');

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

// Helper: cargar convenios del GAS via fullSync (ya existente, no requiere cambios al GAS)
async function cargarConveniosGAS() {
    const url = process.env.GOOGLE_SCRIPT_URL;
    if (!url) return [];
    try {
        const sep = url.includes('?') ? '&' : '?';
        const r = await fetch(`${url}${sep}action=fullSync`, {
            method: 'GET',
            redirect: 'follow'
        });
        const txt = await r.text();
        let data;
        try { data = JSON.parse(txt); }
        catch(e) { 
            console.error('[Convenios] GAS no devolvio JSON:', txt.substring(0, 200));
            return []; 
        }
        // fullSync devuelve { success, data: { clientes, pagos, convenios, promesas, ... } }
        const arr = (data.data && data.data.convenios) || data.convenios || [];
        console.log(`[Convenios] Cargados ${arr.length} convenios via fullSync`);
        return arr;
    } catch(e) {
        console.error('[Convenios] Error cargando del GAS:', e.message);
        return [];
    }
}

// Helper: indexar convenios por telefono (10 ultimos digitos)
function indexarConveniosPorTel(convenios) {
    const mapa = {};
    for (const c of convenios) {
        const tel = String(c.Teléfono || c.telefono || c.Telefono || '').replace(/\D/g, '').slice(-10);
        if (!tel) continue;
        const estado = String(c.estado || c.Estado || '').toLowerCase();
        // Saltar convenios cancelados
        if (estado === 'cancelado') continue;
        // Si hay varios para el mismo cliente, preferir el activo
        const existente = mapa[tel];
        if (!existente || estado === 'activo' || estado === 'vigente') {
            mapa[tel] = c;
        }
    }
    return mapa;
}

// Helper: calcular proximo pago a partir de fechaInicio + semanas y pagos reales
function calcularProximoPago(convenio) {
    try {
        const fechaInicioRaw = convenio.fechaInicio || convenio.FechaInicio;
        if (!fechaInicioRaw) return null;
        const fechaInicio = new Date(fechaInicioRaw);
        if (isNaN(fechaInicio.getTime())) return null;
        
        const pagoSemanal = parseFloat(convenio.pagoSemanal || 0);
        const semanas = parseInt(convenio.semanas || 0);
        if (pagoSemanal <= 0) return null;
        
        const ahora = new Date();
        const diasDesdeInicio = Math.floor((ahora - fechaInicio) / 86400000);
        const semanasTranscurridas = Math.floor(diasDesdeInicio / 7);
        
        // Proximo pago programado = inicio + (semanasTranscurridas+1)*7 dias
        const proximo = new Date(fechaInicio);
        proximo.setDate(proximo.getDate() + (semanasTranscurridas + 1) * 7);
        
        const diasAlProximo = Math.floor((proximo - ahora) / 86400000);
        return {
            fecha: proximo.toISOString().slice(0, 10),
            diasAlProximo,
            vencido: diasAlProximo < 0,
            esHoy: diasAlProximo === 0,
            semanasTranscurridas,
            semanasTotal: semanas
        };
    } catch(e) {
        return null;
    }
}

app.get('/api/detectar', async (req, res) => {
    try {
        const resultado = await detectarFantasmas();
        
        // ═══ Cargar convenios y mergearlos a fantasmas ═══
        try {
            const convenios = await cargarConveniosGAS();
            const mapaConvenios = indexarConveniosPorTel(convenios);
            const fantasmasArrTmp = resultado.fantasmas || [];
            let conveniosAplicados = 0;
            
            for (const f of fantasmasArrTmp) {
                const tel10 = String(f.telefono).replace(/\D/g, '').slice(-10);
                const conv = mapaConvenios[tel10];
                if (conv) {
                    const proxPago = calcularProximoPago(conv);
                    f.convenio = {
                        id: conv.id || conv.ID || '',
                        pagoSemanal: parseFloat(conv.pagoSemanal || 0),
                        semanas: parseInt(conv.semanas || 0),
                        fechaInicio: conv.fechaInicio || '',
                        fechaFin: conv.fechaFin || '',
                        estado: conv.estado || 'activo',
                        notas: conv.notas || '',
                        proximoPago: proxPago
                    };
                    conveniosAplicados++;
                }
            }
            resultado.totalConvenios = convenios.length;
            resultado.conveniosAplicados = conveniosAplicados;
            console.log(`[Server] Convenios aplicados a ${conveniosAplicados} fantasmas (de ${convenios.length} convenios totales)`);
        } catch(convErr) {
            console.error('[Server] Error mergeando convenios (no critico):', convErr.message);
        }
        
        // Mejora: incluir clientes que estan en flujo activo del AutoRunner
        // El detector los excluye por defecto. Los recuperamos para que aparezcan
        // en el panel principal con la info de seguimiento.
        try {
            const enFlujo = await pool.query(`
                SELECT 
                    telefono, cliente_nombre, saldo, dias_atraso, promotor,
                    estado, paso_actual, ultimo_toque_canal, ultimo_toque_en, 
                    proximo_toque_en, tiene_whatsapp
                FROM seguimiento_clientes
                WHERE estado IN ('pendiente', 'en_curso', 'respondido', 'agotado')
            `);
            
            // Indexar fantasmas existentes por telefono para no duplicar
            const fantasmasArr = resultado.fantasmas || [];
            const indiceTel = new Set(fantasmasArr.map(f => f.telefono));
            
            // Por cada cliente en flujo:
            //  - Si ya esta en fantasmas: enriquecerlo con info de seguimiento
            //  - Si no esta: agregarlo (fue excluido por estar en flujo)
            const flujoStats = { enriquecidos: 0, agregados: 0 };
            
            for (const c of enFlujo.rows) {
                const flujoInfo = {
                    en_flujo: true,
                    estado_seguimiento: c.estado,
                    paso_actual: c.paso_actual || 0,
                    ultimo_toque_canal: c.ultimo_toque_canal,
                    ultimo_toque_en: c.ultimo_toque_en,
                    proximo_toque_en: c.proximo_toque_en,
                    tiene_whatsapp: c.tiene_whatsapp
                };
                
                if (indiceTel.has(c.telefono)) {
                    // Enriquecer fantasma existente
                    const f = fantasmasArr.find(x => x.telefono === c.telefono);
                    Object.assign(f, flujoInfo);
                    flujoStats.enriquecidos++;
                } else {
                    // Agregar cliente que el detector excluyo
                    fantasmasArr.push({
                        telefono: c.telefono,
                        cliente: c.cliente_nombre || '',
                        saldo: parseFloat(c.saldo) || 0,
                        diasAtraso: c.dias_atraso || 0,
                        promotor: c.promotor || '',
                        categoria: 'FRIO',  // default seguro
                        porcentajeAvance: 0,
                        ultimoContacto: { tipo: 'en_flujo', dias: null },
                        ...flujoInfo
                    });
                    flujoStats.agregados++;
                }
            }
            
            resultado.fantasmas = fantasmasArr;
            resultado.flujoMerge = {
                totalEnFlujo: enFlujo.rows.length,
                ...flujoStats
            };
            
            console.log(`[Server] Merge flujo: ${flujoStats.enriquecidos} enriquecidos, ${flujoStats.agregados} agregados (${enFlujo.rows.length} total en flujo)`);
        } catch (mergeErr) {
            console.error('[Server] Error mergeando flujo (no critico):', mergeErr.message);
            // Si el merge falla, devolvemos el resultado original sin merge
        }
        
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
                        estado, paso_actual, proximo_toque_en
                    ) VALUES ($1, $2, $3, $4, $5, 'pendiente', 0, NOW())
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
// API: Respuesta de cliente (recibida desde el bot WhatsApp)
// ───────────────────────────────────────────────────────────────────────────

app.post('/api/respuesta-cliente', async (req, res) => {
    try {
        const { telefono, mensaje, nombre, timestamp } = req.body;
        if (!telefono) return res.status(400).json({ success: false, error: 'telefono requerido' });
        
        const tel10 = String(telefono).replace(/\D/g, '').slice(-10);
        
        await pool.query(`
            INSERT INTO seguimiento_log (telefono, tipo, canal, mensaje, exitoso, disparado_por)
            VALUES ($1, 'respuesta_recibida', 'whatsapp_auto', $2, true, 'bot_baileys')
        `, [tel10, `[${nombre || telefono}]: ${(mensaje || '').substring(0, 500)}`]);
        
        console.log(`📩 Respuesta guardada de ${tel10}: ${(mensaje || '').substring(0, 50)}`);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Resultado de llamada (recibido desde el bridge IVR / Zadarma webhook)
// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// API: Gestion manual del usuario (nota libre sobre un cliente)
// ───────────────────────────────────────────────────────────────────────────

app.post('/api/gestion-manual', async (req, res) => {
    try {
        const { telefono, nota, usuario } = req.body || {};
        if (!telefono || !nota || nota.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'telefono y nota son requeridos' });
        }
        const tel10 = String(telefono).replace(/\D/g, '').slice(-10);
        const notaLimpia = String(nota).trim().substring(0, 500);
        const usr = String(usuario || 'manual').substring(0, 50);
        
        // Buscar seguimiento_id activo si existe
        const flujo = await pool.query(`
            SELECT id FROM seguimiento_clientes
            WHERE telefono = $1 AND estado IN ('pendiente', 'en_curso', 'respondido')
            LIMIT 1
        `, [tel10]);
        const seguimientoId = flujo.rows[0]?.id || null;
        
        await pool.query(`
            INSERT INTO seguimiento_log
                (seguimiento_id, telefono, tipo, canal, mensaje, exitoso, disparado_por)
            VALUES ($1, $2, 'gestion_manual', 'manual', $3, true, $4)
        `, [seguimientoId, tel10, `✏️ ${notaLimpia}`, usr]);
        
        console.log(`✏️ Gestion manual ${tel10}: ${notaLimpia.substring(0, 60)}`);
        res.json({ success: true, mensaje: notaLimpia });
    } catch(e) {
        console.error('[Server] Error en /api/gestion-manual:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Resultado de llamada (recibido desde el bridge IVR / Zadarma webhook)
// ───────────────────────────────────────────────────────────────────────────

app.post('/api/resultado-llamada', async (req, res) => {
    try {
        // Validar Bearer token (mismo que IVR_ZADARMA_TOKEN)
        const auth = req.headers.authorization || '';
        const token = auth.replace(/^Bearer\s+/i, '').trim();
        const expected = process.env.IVR_ZADARMA_TOKEN || '';
        if (expected && token !== expected) {
            return res.status(401).json({ success: false, error: 'Token invalido' });
        }
        
        const {
            telefono, disposition, duration, statusCode,
            pbxCallId, event, entrante, grabacionUrl, fecha
        } = req.body;
        
        if (!telefono) {
            return res.status(400).json({ success: false, error: 'telefono requerido' });
        }
        
        const tel10 = String(telefono).replace(/\D/g, '').slice(-10);
        
        // ─── Caso 1: NOTIFY_RECORD (solo link de grabacion) ───
        // Buscamos la fila reciente de esta llamada por pbxCallId y le añadimos el link
        if (event === 'NOTIFY_RECORD' && grabacionUrl) {
            // Buscar log mas reciente de esta llamada (ultima hora) y agregar grabacion
            const updated = await pool.query(`
                UPDATE seguimiento_log
                SET mensaje = COALESCE(mensaje, '') || ' | 🎙️ ' || $2
                WHERE telefono = $1
                  AND tipo = 'llamada_resultado'
                  AND creado_en > NOW() - INTERVAL '2 hours'
                  AND (mensaje IS NULL OR mensaje NOT LIKE '%🎙️%')
                  AND id = (
                      SELECT id FROM seguimiento_log
                      WHERE telefono = $1 AND tipo = 'llamada_resultado'
                        AND creado_en > NOW() - INTERVAL '2 hours'
                      ORDER BY creado_en DESC LIMIT 1
                  )
                RETURNING id
            `, [tel10, grabacionUrl]);
            
            // Si no encontramos llamada previa, insertamos registro nuevo
            if (updated.rowCount === 0) {
                await pool.query(`
                    INSERT INTO seguimiento_log
                        (telefono, tipo, canal, mensaje, exitoso, disparado_por)
                    VALUES ($1, 'llamada_resultado', 'llamada_ivr', $2, true, 'zadarma_webhook')
                `, [tel10, `🎙️ ${grabacionUrl}`]);
            }
            
            console.log(`🎙️ Grabacion guardada para ${tel10}`);
            return res.json({ success: true, grabacion: true });
        }
        
        // ─── Caso 2: NOTIFY_OUT_END / NOTIFY_END (resultado de la llamada) ───
        const dur = parseInt(duration) || 0;
        const disp = (disposition || 'unknown').toLowerCase();
        
        // Determinar resultado legible (lo que se muestra al usuario)
        let resultado = 'desconocido';
        let exitoso = false;
        if (disp === 'answered' && dur >= 5) {
            resultado = `✅ Contestó (${dur}s)`;
            exitoso = true;
        } else if (disp === 'answered' && dur < 5) {
            resultado = `⚠️ Colgó rápido (${dur}s)`;
            exitoso = false;
        } else if (disp === 'busy') {
            resultado = '⏰ Ocupado';
            exitoso = false;
        } else if (disp === 'no-answer' || disp === 'noanswer') {
            resultado = '❌ Sin respuesta';
            exitoso = false;
        } else if (disp === 'cancel' || disp === 'cancelled') {
            resultado = '🚫 Cancelada';
            exitoso = false;
        } else if (disp === 'failed') {
            resultado = '⚠️ Falló (número inválido)';
            exitoso = false;
        } else {
            resultado = `${disp} (${dur}s)`;
            exitoso = dur > 5;
        }
        
        // Buscar seguimiento_id activo
        const flujo = await pool.query(`
            SELECT id FROM seguimiento_clientes
            WHERE telefono = $1 AND estado IN ('pendiente', 'en_curso')
            LIMIT 1
        `, [tel10]);
        const seguimientoId = flujo.rows[0]?.id || null;
        
        // Insertar log de resultado
        await pool.query(`
            INSERT INTO seguimiento_log
                (seguimiento_id, telefono, tipo, canal, mensaje, exitoso, disparado_por)
            VALUES ($1, $2, 'llamada_resultado', 'llamada_ivr', $3, $4, 'zadarma_webhook')
        `, [seguimientoId, tel10, `${resultado} | disp=${disp} dur=${dur}s pbx=${pbxCallId || 'n/a'}`, exitoso]);
        
        // Si contestó, marcar como "respondió" en seguimiento_clientes
        if (exitoso && seguimientoId) {
            try {
                await pool.query(`
                    UPDATE seguimiento_clientes
                    SET estado = 'respondido',
                        respondio_en = NOW()
                    WHERE id = $1 AND estado IN ('pendiente', 'en_curso')
                `, [seguimientoId]);
                console.log(`✅ Cliente ${tel10} marcado como respondió (llamada contestada)`);
            } catch(e) {
                // Si la columna respondio_en no existe, solo cambiamos estado
                await pool.query(`UPDATE seguimiento_clientes SET estado = 'respondido' WHERE id = $1`, [seguimientoId]);
            }
        }
        
        console.log(`📞 Resultado llamada ${tel10}: ${resultado}`);
        res.json({ success: true, resultado, exitoso });
        
    } catch (error) {
        console.error('[Server] Error en /api/resultado-llamada:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Sincronizar Zadarma (pull de estadisticas via API)
// Util para recuperar llamadas hechas antes de configurar el webhook
// ───────────────────────────────────────────────────────────────────────────

app.post('/api/sincronizar-zadarma', async (req, res) => {
    try {
        // .trim() critico: elimina espacios/saltos invisibles que rompen la firma HMAC
        const ZADARMA_KEY = (process.env.ZADARMA_KEY || '').trim();
        const ZADARMA_SECRET = (process.env.ZADARMA_SECRET || '').trim();
        
        if (!ZADARMA_KEY || !ZADARMA_SECRET) {
            return res.status(400).json({
                success: false,
                error: 'ZADARMA_KEY y ZADARMA_SECRET no configurados en env vars'
            });
        }
        
        // ═════ PRE-TEST: validar credenciales con endpoint mas simple ═════
        // Si /v1/info/balance/ funciona pero /v1/statistics/pbx/ no, es problema del segundo
        // Si /v1/info/balance/ tambien falla, es problema de credenciales
        // FORMATO OFICIAL ZADARMA (doc PHP):
        //   sign = base64(hmac_sha1(metodo + paramsStr + md5(paramsStr), secret))
        //   Authorization: KEY:sign
        const crypto = require('crypto');
        const testMd5 = crypto.createHash('md5').update('').digest('hex');
        const testToSign = '/v1/info/balance/' + testMd5;
        // hmac BINARY (sin .toString('hex')) -> luego base64
        const testHmacBinary = crypto.createHmac('sha1', ZADARMA_SECRET).update(testToSign).digest();
        const testSignBase64 = testHmacBinary.toString('base64');
        const testAuth = `${ZADARMA_KEY}:${testSignBase64}`;
        
        console.log(`🧪 [Pre-test] Probando /v1/info/balance/...`);
        console.log(`   Test auth: ${testAuth.substring(0, 30)}...`);
        const testResp = await fetch('https://api.zadarma.com/v1/info/balance/', {
            method: 'GET',
            headers: { 'Authorization': testAuth }
        });
        const testText = await testResp.text();
        console.log(`   Balance HTTP ${testResp.status}: ${testText.substring(0, 200)}`);
        
        if (testResp.status === 401) {
            return res.status(500).json({
                success: false,
                error: 'Credenciales Zadarma invalidas',
                message: `El endpoint /v1/info/balance/ tambien rechaza las claves. ` +
                         `Esto indica copy/paste con error, o cuenta sin API REST habilitada. ` +
                         `Detalle: ${testText.substring(0, 200)}`
            });
        }
        
        // Si balance OK, continuamos con stats
        if (testResp.status !== 200) {
            console.log(`⚠️ Balance dio HTTP ${testResp.status}, pero seguimos probando stats...`);
        }
        
        // ═════ Periodo a sincronizar (default: ultimas 24h) ═════
        const horas = parseInt(req.body?.horas) || 24;
        const ahora = new Date();
        const desde = new Date(ahora.getTime() - horas * 60 * 60 * 1000);
        
        const fmt = (d) => {
            const pad = n => String(n).padStart(2, '0');
            return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
        };
        
        // Parametros segun spec Zadarma /v1/statistics/pbx/
        // SOLO start, end, version, skip - NO usar 'type' (es de otro endpoint)
        const params = {
            start: fmt(desde),
            end: fmt(ahora),
            version: 2  // version 2 incluye disposition y duration
        };
        
        // ═════ FIRMA SEGUN SPEC OFICIAL ZADARMA ═════
        // Doc oficial (PHP):
        //   ksort($params);
        //   $paramsStr = http_build_query($params);
        //   $sign = base64_encode(hash_hmac('sha1', $method . $paramsStr . md5($paramsStr), $secret));
        //   Authorization: KEY:sign
        // 
        // CRITICO:
        //   - hash_hmac SIN 4to parametro = devuelve BINARY raw
        //   - base64_encode del BINARY (NO del hex)
        //   - http_build_query usa URL-encoding RFC1738 (espacios -> +, : -> %3A)
        //   - md5() devuelve hex
        const keys = Object.keys(params).sort();
        // Equivalente a http_build_query de PHP (URL-encoded con RFC1738: espacios -> +)
        const paramsStr = keys.map(k => 
            `${encodeURIComponent(k).replace(/%20/g, '+')}=${encodeURIComponent(params[k]).replace(/%20/g, '+')}`
        ).join('&');
        const md5 = crypto.createHash('md5').update(paramsStr).digest('hex');
        const metodo = '/v1/statistics/pbx/';
        const toSign = metodo + paramsStr + md5;
        // hmac BINARY (sin .digest('hex')) -> luego toString('base64')
        const hmacBinary = crypto.createHmac('sha1', ZADARMA_SECRET).update(toSign).digest();
        const sign = hmacBinary.toString('base64');
        
        // URL final: mismos params URL-encoded (con + para espacios)
        const url = `https://api.zadarma.com${metodo}?${paramsStr}`;
        
        // ═════ LOGS DEBUG (visibles en Render Troncos) ═════
        console.log(`🔄 [Zadarma Sync] Iniciando...`);
        console.log(`   Periodo: ${params.start} -> ${params.end}`);
        console.log(`   Key len: ${ZADARMA_KEY.length}, Secret len: ${ZADARMA_SECRET.length}`);
        console.log(`   paramsStr: ${paramsStr}`);
        console.log(`   md5: ${md5}`);
        console.log(`   toSign: ${toSign}`);
        console.log(`   sign (base64): ${sign}`);
        console.log(`   URL: ${url}`);
        
        // Header oficial Zadarma: Authorization: KEY:base64(hmac_binary)
        const authHeader = `${ZADARMA_KEY}:${sign}`;
        console.log(`   Auth header: ${authHeader.substring(0, 30)}...`);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': authHeader }
        });
        const responseText = await response.text();
        console.log(`   HTTP status: ${response.status}`);
        console.log(`   Response: ${responseText.substring(0, 500)}`);
        
        let json;
        try {
            json = JSON.parse(responseText);
        } catch(e) {
            return res.status(500).json({
                success: false,
                error: 'Respuesta no es JSON',
                message: responseText.substring(0, 300)
            });
        }
        
        if (json.status !== 'success') {
            return res.status(500).json({
                success: false,
                error: 'Zadarma API error',
                message: json.message || JSON.stringify(json),
                detalle: 'Revisa logs de Render para ver firma y respuesta'
            });
        }
        
        const stats = json.stats || [];
        let insertados = 0;
        let actualizados = 0;
        
        for (const call of stats) {
            // Filtrar solo salientes (out) y entrantes con duracion
            const tipoLlamada = call.calltype || '';
            if (tipoLlamada !== 'outgoing' && tipoLlamada !== 'incoming') continue;
            
            const dest = String(call.to || call.destination || '').replace(/\D/g, '').slice(-10);
            if (!dest || dest.length !== 10) continue;
            
            const dur = parseInt(call.billseconds || call.seconds || 0);
            const disp = (call.disposition || 'unknown').toLowerCase();
            
            let resultado = disp;
            let exitoso = false;
            if (disp === 'answered' && dur >= 5) {
                resultado = `✅ Contestó (${dur}s)`;
                exitoso = true;
            } else if (disp === 'busy') resultado = '⏰ Ocupado';
            else if (disp === 'no-answer' || disp === 'noanswer') resultado = '❌ Sin respuesta';
            else if (disp === 'cancel') resultado = '🚫 Cancelada';
            else if (disp === 'failed') resultado = '⚠️ Falló';
            
            // Verificar si ya existe para no duplicar (usar callstart como llave secundaria)
            const existe = await pool.query(`
                SELECT id FROM seguimiento_log
                WHERE telefono = $1 AND tipo = 'llamada_resultado'
                  AND mensaje LIKE '%' || $2 || '%'
                LIMIT 1
            `, [dest, call.callstart || '']);
            
            if (existe.rows.length === 0) {
                await pool.query(`
                    INSERT INTO seguimiento_log
                        (telefono, tipo, canal, mensaje, exitoso, disparado_por, creado_en)
                    VALUES ($1, 'llamada_resultado', 'llamada_ivr', $2, $3, 'zadarma_sync', $4)
                `, [
                    dest,
                    `${resultado} | sync ${call.callstart} | disp=${disp} dur=${dur}s`,
                    exitoso,
                    call.callstart || new Date()
                ]);
                insertados++;
            } else {
                actualizados++;
            }
        }
        
        console.log(`🔄 Sincronizacion Zadarma: ${insertados} nuevas, ${actualizados} ya existian, total recibidas ${stats.length}`);
        
        res.json({
            success: true,
            total: stats.length,
            insertados,
            ya_existian: actualizados,
            periodo_horas: horas
        });
        
    } catch (error) {
        console.error('[Server] Error en /api/sincronizar-zadarma:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Llamadas de un telefono especifico (con grabaciones)
// ───────────────────────────────────────────────────────────────────────────

app.get('/api/llamadas/:telefono', async (req, res) => {
    try {
        const tel10 = String(req.params.telefono).replace(/\D/g, '').slice(-10);
        
        const result = await pool.query(`
            SELECT id, mensaje, exitoso, disparado_por, creado_en
            FROM seguimiento_log
            WHERE telefono = $1 AND tipo = 'llamada_resultado'
            ORDER BY creado_en DESC
            LIMIT 50
        `, [tel10]);
        
        // Extraer link de grabacion si existe (formato: "🎙️ https://...")
        const llamadas = result.rows.map(row => {
            const msg = row.mensaje || '';
            const matchGrab = msg.match(/🎙️\s*(https:\/\/\S+)/);
            return {
                id: row.id,
                resultado: msg.split('|')[0].trim(),
                grabacionUrl: matchGrab ? matchGrab[1] : null,
                detalle: msg,
                exitoso: row.exitoso,
                fuente: row.disparado_por,
                fecha: row.creado_en
            };
        });
        
        res.json({ success: true, telefono: tel10, total: llamadas.length, llamadas });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// API: Logs de un cliente especifico
// ───────────────────────────────────────────────────────────────────────────

// GET /api/toques/mapa - Devuelve ultimo toque + respuesta + resultado llamada
app.get('/api/toques/mapa', async (req, res) => {
    try {
        // Ultimo envio exitoso por telefono
        const envios = await pool.query(`
            SELECT DISTINCT ON (telefono)
                telefono, canal, tipo, paso, exitoso, creado_en
            FROM seguimiento_log
            WHERE tipo = 'toque_enviado' AND exitoso = true
            ORDER BY telefono, creado_en DESC
        `);
        
        // Ultima respuesta recibida por telefono (WhatsApp)
        const respuestas = await pool.query(`
            SELECT DISTINCT ON (telefono)
                telefono, mensaje, creado_en
            FROM seguimiento_log
            WHERE tipo = 'respuesta_recibida'
            ORDER BY telefono, creado_en DESC
        `);
        
        // Ultimo resultado de llamada por telefono
        const llamadas = await pool.query(`
            SELECT DISTINCT ON (telefono)
                telefono, mensaje, exitoso, creado_en
            FROM seguimiento_log
            WHERE tipo = 'llamada_resultado'
            ORDER BY telefono, creado_en DESC
        `);
        
        // Ultima gestion manual por telefono
        const manuales = await pool.query(`
            SELECT DISTINCT ON (telefono)
                telefono, mensaje, creado_en, disparado_por
            FROM seguimiento_log
            WHERE tipo = 'gestion_manual'
            ORDER BY telefono, creado_en DESC
        `);
        
        const mapa = {};
        envios.rows.forEach(row => {
            const tel10 = row.telefono.slice(-10);
            mapa[tel10] = {
                canal: row.canal,
                paso: row.paso,
                fecha: row.creado_en,
                exitoso: row.exitoso,
                respondio: false,
                respuesta: null,
                llamadaResultado: null,
                llamadaExitosa: null,
                llamadaFecha: null,
                grabacionUrl: null
            };
            mapa[row.telefono] = mapa[tel10];
        });
        
        // Agregar respuestas WhatsApp
        respuestas.rows.forEach(row => {
            const tel10 = row.telefono.slice(-10);
            if (mapa[tel10]) {
                mapa[tel10].respondio = true;
                mapa[tel10].respuesta = (row.mensaje || '').substring(0, 100);
                mapa[tel10].fechaRespuesta = row.creado_en;
            } else {
                mapa[tel10] = {
                    canal: 'whatsapp_auto',
                    fecha: null,
                    respondio: true,
                    respuesta: (row.mensaje || '').substring(0, 100),
                    fechaRespuesta: row.creado_en,
                    llamadaResultado: null,
                    llamadaExitosa: null,
                    grabacionUrl: null
                };
                mapa[row.telefono] = mapa[tel10];
            }
        });
        
        // Agregar resultado de llamadas (con grabacion)
        llamadas.rows.forEach(row => {
            const tel10 = row.telefono.slice(-10);
            const msg = row.mensaje || '';
            const resultado = msg.split('|')[0].trim();
            const matchGrab = msg.match(/🎙️\s*(https:\/\/\S+)/);
            const grabacionUrl = matchGrab ? matchGrab[1] : null;
            
            if (!mapa[tel10]) {
                mapa[tel10] = {
                    canal: 'llamada_ivr',
                    fecha: row.creado_en,
                    respondio: false,
                    respuesta: null,
                    llamadaResultado: resultado,
                    llamadaExitosa: row.exitoso,
                    llamadaFecha: row.creado_en,
                    grabacionUrl
                };
                mapa[row.telefono] = mapa[tel10];
            } else {
                mapa[tel10].llamadaResultado = resultado;
                mapa[tel10].llamadaExitosa = row.exitoso;
                mapa[tel10].llamadaFecha = row.creado_en;
                mapa[tel10].grabacionUrl = grabacionUrl;
                // Si la llamada fue exitosa, contarla como "respondio"
                if (row.exitoso && !mapa[tel10].respondio) {
                    mapa[tel10].respondio = true;
                    mapa[tel10].respuesta = resultado;
                    mapa[tel10].fechaRespuesta = row.creado_en;
                }
            }
        });
        
        // Agregar gestiones manuales (notas libres del usuario)
        manuales.rows.forEach(row => {
            const tel10 = row.telefono.slice(-10);
            const nota = (row.mensaje || '').replace(/^✏️\s*/, '');
            if (!mapa[tel10]) {
                mapa[tel10] = {
                    canal: 'manual',
                    fecha: row.creado_en,
                    respondio: false,
                    respuesta: null,
                    llamadaResultado: null,
                    llamadaExitosa: null,
                    grabacionUrl: null,
                    gestionManual: nota,
                    gestionManualFecha: row.creado_en,
                    gestionManualUsuario: row.disparado_por
                };
                mapa[row.telefono] = mapa[tel10];
            } else {
                mapa[tel10].gestionManual = nota;
                mapa[tel10].gestionManualFecha = row.creado_en;
                mapa[tel10].gestionManualUsuario = row.disparado_por;
            }
        });
        
        res.json({ success: true, mapa, total: envios.rows.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/respuestas/mapa - Consulta respuestas del bot y devuelve mapa de quién respondió
app.get('/api/respuestas/mapa', async (req, res) => {
    try {
        const BAILEYS_URL = process.env.CHATBOT_BAILEYS_URL || '';
        const BAILEYS_TOKEN = process.env.CHATBOT_BAILEYS_TOKEN || '';
        
        if (!BAILEYS_URL) {
            return res.json({ success: true, mapa: {}, total: 0 });
        }
        
        const interUrl = BAILEYS_URL.replace('/api/enviar-individual', '/api/chatbot/interacciones?limite=500');
        const headers = {};
        if (BAILEYS_TOKEN) headers['Authorization'] = `Bearer ${BAILEYS_TOKEN}`;
        
        const response = await fetch(interUrl, { headers });
        const interacciones = await response.json();
        
        if (!Array.isArray(interacciones)) {
            return res.json({ success: true, mapa: {}, total: 0 });
        }
        
        // Filtrar solo respuestas recibidas de clientes
        const mapa = {};
        interacciones
            .filter(i => i.tipo === 'recibido')
            .forEach(i => {
                const tel10 = String(i.telefono).slice(-10);
                if (!mapa[tel10] || new Date(i.timestamp) > new Date(mapa[tel10].fecha)) {
                    mapa[tel10] = {
                        mensaje: i.detalle || '',
                        fecha: i.timestamp
                    };
                }
            });
        
        res.json({ success: true, mapa, total: Object.keys(mapa).length });
    } catch (error) {
        res.json({ success: true, mapa: {}, total: 0 });
    }
});

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
// VERIFICACION WHATSAPP - Pre-filtrado masivo
// ───────────────────────────────────────────────────────────────────────────

// Crear columna si no existe
(async () => {
    try {
        await pool.query(`ALTER TABLE seguimiento_clientes ADD COLUMN IF NOT EXISTS tiene_whatsapp BOOLEAN DEFAULT NULL`);
    } catch(e) { /* ya existe */ }
})();

// GET /api/verificar-whatsapp/estado - ¿Cuántos ya verificados?
app.get('/api/verificar-whatsapp/estado', async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT 
                COUNT(*) AS total,
                COUNT(CASE WHEN tiene_whatsapp = true THEN 1 END) AS con_wa,
                COUNT(CASE WHEN tiene_whatsapp = false THEN 1 END) AS sin_wa,
                COUNT(CASE WHEN tiene_whatsapp IS NULL THEN 1 END) AS no_verificados
            FROM seguimiento_clientes
        `);
        res.json({ success: true, ...r.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// GET /api/verificar-whatsapp/mapa - Devuelve {telefono: true/false} para cruzar con detector
app.get('/api/verificar-whatsapp/mapa', async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT telefono, tiene_whatsapp FROM seguimiento_clientes 
            WHERE tiene_whatsapp IS NOT NULL
        `);
        const mapa = {};
        r.rows.forEach(row => { mapa[row.telefono] = row.tiene_whatsapp; });
        res.json({ success: true, mapa, total: r.rows.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST /api/verificar-whatsapp/lote - Verifica lote de 50 y guarda resultado
app.post('/api/verificar-whatsapp/lote', async (req, res) => {
    try {
        const BAILEYS_URL = process.env.CHATBOT_BAILEYS_URL || '';
        const BAILEYS_TOKEN = process.env.CHATBOT_BAILEYS_TOKEN || '';
        
        if (!BAILEYS_URL) {
            return res.status(400).json({ success: false, error: 'CHATBOT_BAILEYS_URL no configurado' });
        }
        
        // Si se envian fantasmas en el body, insertarlos primero en seguimiento_clientes
        const { fantasmas } = req.body || {};
        if (fantasmas && Array.isArray(fantasmas) && fantasmas.length > 0) {
            for (const f of fantasmas) {
                try {
                    // Verificar si ya existe con estado pendiente o en_curso
                    const existe = await pool.query(
                        `SELECT id FROM seguimiento_clientes WHERE telefono = $1 AND estado IN ('pendiente','en_curso') LIMIT 1`,
                        [f.telefono]
                    );
                    if (existe.rows.length === 0) {
                        await pool.query(`
                            INSERT INTO seguimiento_clientes (telefono, cliente, saldo, dias_atraso, promotor, categoria, estado)
                            VALUES ($1, $2, $3, $4, $5, $6, 'pendiente')
                        `, [f.telefono, f.cliente || '', f.saldo || 0, f.diasAtraso || 0, f.promotor || '', f.categoria || 'FRIO']);
                    }
                } catch(e) { /* skip */ }
            }
        }
        
        // Obtener 50 numeros NO verificados
        const pendientes = await pool.query(`
            SELECT id, telefono FROM seguimiento_clientes 
            WHERE tiene_whatsapp IS NULL
            ORDER BY saldo DESC
            LIMIT 50
        `);
        
        if (pendientes.rows.length === 0) {
            return res.json({ success: true, mensaje: 'Todos ya verificados', procesados: 0 });
        }
        
        const telefonos = pendientes.rows.map(r => r.telefono);
        
        // Llamar al bot para verificar el lote
        const verificarUrl = BAILEYS_URL.replace('/api/enviar-individual', '/api/verificar-lote');
        const headers = { 'Content-Type': 'application/json' };
        if (BAILEYS_TOKEN) headers['Authorization'] = `Bearer ${BAILEYS_TOKEN}`;
        
        const response = await fetch(verificarUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ telefonos })
        });
        
        const data = await response.json();
        
        if (!data.success || !data.resultados) {
            return res.status(500).json({ success: false, error: data.error || 'Error del bot' });
        }
        
        // Guardar resultados en PostgreSQL
        let actualizados = 0;
        for (const r of data.resultados) {
            try {
                await pool.query(
                    `UPDATE seguimiento_clientes SET tiene_whatsapp = $1 WHERE telefono = $2`,
                    [r.existe, r.telefono]
                );
                actualizados++;
            } catch(e) { /* skip */ }
        }
        
        res.json({
            success: true,
            procesados: data.resultados.length,
            conWhatsApp: data.conWhatsApp,
            sinWhatsApp: data.sinWhatsApp,
            actualizados,
            quedanPendientes: pendientes.rows.length < 50 ? 0 : 'más'
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// AUTO-RUNNER: Persecución automática por horas
// ───────────────────────────────────────────────────────────────────────────

autoRunner.montar(app, pool);

// ───────────────────────────────────────────────────────────────────────────
// ARRANQUE
// ───────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    const config = mensajeria.getConfig();
    console.log('═══════════════════════════════════════════════════════');
    console.log(`LeGaXi Seguimiento Fantasmas v1.4 - puerto ${PORT}`);
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
    console.log(`  GET  /api/verificar-whatsapp/estado - Estado verificacion`);
    console.log(`  POST /api/verificar-whatsapp/lote   - Verificar lote de 50`);
    console.log(`  GET  /api/logs/:telefono        - Historial de un cliente`);
    console.log(`  GET  /api/auto-runner/estado    - 🤖 Estado del AutoRunner`);
    console.log(`  POST /api/auto-runner/toggle    - 🤖 Activar/pausar AutoRunner`);
    console.log(`  POST /api/auto-runner/ejecutar-ahora - 🤖 Forzar ciclo`);
    console.log(`  POST /api/resultado-llamada     - 📞 Webhook Zadarma (desde bridge)`);
    console.log(`  POST /api/sincronizar-zadarma   - 🔄 Pull manual estadisticas`);
    console.log(`  GET  /api/llamadas/:telefono    - 📞 Historial llamadas + grabaciones`);
    console.log(`Variables Zadarma (opcionales):`);
    console.log(`  ZADARMA_KEY:         ${process.env.ZADARMA_KEY ? 'OK' : 'FALTA (sin grabaciones/sync)'}`);
    console.log(`  ZADARMA_SECRET:      ${process.env.ZADARMA_SECRET ? 'OK' : 'FALTA'}`);
    console.log(`  IVR_ZADARMA_TOKEN:   ${process.env.IVR_ZADARMA_TOKEN ? 'OK' : 'FALTA (auth webhook)'}`);
    console.log('═══════════════════════════════════════════════════════');
});
