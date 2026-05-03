// ═══════════════════════════════════════════════════════════════════════════
// AUTO-RUNNER - LeGaXi Persecución Automática v1.0
//
// Convierte Fantasma de panel manual a perseguidor automático.
// Estrategia: cobranza por agotamiento psicológico (no por días).
//
// Cadencia diaria por cliente:
//   Llamada → 2h → WhatsApp → 1h → Llamada → 2h → WhatsApp
//   = 2 ciclos completos al día (4 toques mínimo)
//
// Reglas:
//   - Horario: 9 AM a 8 PM, lunes a sábado (zona horaria CDMX)
//   - Si cliente responde lo que sea → pausa total automática
//   - 3 días sin respuesta → declara "agotado" y notifica al admin
//   - Respeta cooldown si tiene_whatsapp = false (solo llamadas)
//
// Se monta dentro de server.js sin tocar nada existente.
// ═══════════════════════════════════════════════════════════════════════════

const mensajeria = require('./mensajeria');

// ───────────────────────────────────────────────────────────────────────────
// CONFIGURACIÓN (editable sin tocar lógica)
// ───────────────────────────────────────────────────────────────────────────

const CONFIG = {
    // Horario laboral (zona horaria CDMX = UTC-6)
    HORA_INICIO: 9,           // 9 AM
    HORA_FIN: 20,             // 8 PM
    DIAS_HABILES: [1, 2, 3, 4, 5, 6],  // 1=lunes ... 6=sábado (0=domingo NO)
    
    // Secuencia de canales (cíclica)
    SECUENCIA: [
        { canal: 'llamada', esperaHoras: 2 },   // toque 1: llamada → +2h
        { canal: 'whatsapp', esperaHoras: 1 },  // toque 2: WhatsApp → +1h
        { canal: 'llamada', esperaHoras: 2 },   // toque 3: llamada → +2h
        { canal: 'whatsapp', esperaHoras: 14 }, // toque 4: WhatsApp → +14h (siguiente día)
    ],
    
    // Política de agotamiento
    DIAS_MAX_PERSECUCION: 3,
    
    // Frecuencia del cron interno
    INTERVALO_CRON_MINUTOS: 15,
    
    // Notificación al admin cuando alguien se agota
    ADMIN_TELEFONO: process.env.ADMIN_TELEFONO || '5215512345678',
    
    // Activar/desactivar el motor
    ACTIVO: process.env.AUTO_RUNNER_ACTIVO !== 'false',  // ON por default
    
    // Modo simulación (no envía nada, solo logea qué haría)
    DRY_RUN: process.env.AUTO_RUNNER_DRY_RUN === 'true',
};

// ───────────────────────────────────────────────────────────────────────────
// HELPERS DE TIEMPO
// ───────────────────────────────────────────────────────────────────────────

/**
 * Obtiene fecha actual en zona CDMX (UTC-6 sin DST simplificado)
 */
function ahoraCDMX() {
    const d = new Date();
    // Ajuste a CDMX: UTC-6
    return new Date(d.getTime() - (6 * 60 * 60 * 1000));
}

/**
 * Verifica si ahora estamos en horario laboral
 */
function enHorarioLaboral(fecha = ahoraCDMX()) {
    const dia = fecha.getUTCDay();      // 0=domingo
    const hora = fecha.getUTCHours();
    
    if (!CONFIG.DIAS_HABILES.includes(dia)) return false;
    if (hora < CONFIG.HORA_INICIO || hora >= CONFIG.HORA_FIN) return false;
    return true;
}

/**
 * Calcula próximo toque sumando horas, saltando si cae fuera de horario
 */
function calcularProximoToque(esperaHoras) {
    const ahora = new Date();  // usamos UTC para guardar en DB
    let proximo = new Date(ahora.getTime() + (esperaHoras * 60 * 60 * 1000));
    
    // Convertir a CDMX para validar horario
    let proximoCDMX = new Date(proximo.getTime() - (6 * 60 * 60 * 1000));
    
    // Si cae fuera de horario o en domingo, mover al siguiente día hábil 9 AM
    let intentos = 0;
    while (!enHorarioLaboral(proximoCDMX) && intentos < 7) {
        // Avanzar al día siguiente 9 AM CDMX
        proximoCDMX.setUTCDate(proximoCDMX.getUTCDate() + 1);
        proximoCDMX.setUTCHours(CONFIG.HORA_INICIO, 0, 0, 0);
        intentos++;
    }
    
    // Convertir de vuelta a UTC para guardar en DB
    proximo = new Date(proximoCDMX.getTime() + (6 * 60 * 60 * 1000));
    return proximo;
}

// ───────────────────────────────────────────────────────────────────────────
// LÓGICA PRINCIPAL
// ───────────────────────────────────────────────────────────────────────────

/**
 * Procesa un cliente vencido: dispara canal correspondiente y agenda siguiente
 */
async function procesarCliente(pool, cliente) {
    const { id, telefono, cliente_nombre, saldo, dias_atraso, paso_actual } = cliente;
    const pasoSiguiente = (paso_actual || 0);  // empieza en 0, primer toque es índice 0
    const indice = pasoSiguiente % CONFIG.SECUENCIA.length;
    const toque = CONFIG.SECUENCIA[indice];
    
    console.log(`[AutoRunner] ⚡ Procesando ${telefono} (${cliente_nombre}) → toque ${pasoSiguiente + 1} canal=${toque.canal}`);
    
    let resultado = { exitoso: false, error: null };
    
    if (CONFIG.DRY_RUN) {
        console.log(`[AutoRunner] 🧪 DRY_RUN: simularía ${toque.canal} a ${telefono}`);
        resultado.exitoso = true;
    } else {
        try {
            if (toque.canal === 'whatsapp') {
                resultado = await mensajeria.enviarPorBaileys({
                    seguimientoId: id,
                    telefono,
                    paso: pasoSiguiente + 1,
                    mensaje: mensajeria.generarMensajePorPaso(
                        pasoSiguiente + 1,
                        cliente_nombre || 'Cliente',
                        parseFloat(saldo) || 0,
                        parseInt(dias_atraso) || 0
                    )
                });
            } else if (toque.canal === 'llamada') {
                resultado = await mensajeria.llamarPorIVR({
                    seguimientoId: id,
                    telefono,
                    paso: pasoSiguiente + 1,
                    cliente: cliente_nombre,
                    saldo: parseFloat(saldo) || 0,
                    diasAtraso: parseInt(dias_atraso) || 0
                });
            }
        } catch (err) {
            resultado = { exitoso: false, error: err.message };
            console.error(`[AutoRunner] ❌ Error enviando a ${telefono}:`, err.message);
        }
    }
    
    // Calcular próximo toque (incluso si falló, reintentamos)
    const proximoToque = calcularProximoToque(toque.esperaHoras);
    
    // Actualizar cliente: avanza paso, agenda siguiente
    await pool.query(`
        UPDATE seguimiento_clientes
        SET paso_actual = $1,
            ultimo_toque_canal = $2,
            ultimo_toque_en = CURRENT_TIMESTAMP,
            proximo_toque_en = $3,
            estado = 'en_curso'
        WHERE id = $4
    `, [pasoSiguiente + 1, toque.canal, proximoToque, id]);
    
    // Log del toque automático
    await pool.query(`
        INSERT INTO seguimiento_log (
            seguimiento_id, telefono, tipo, canal, paso, exitoso, error_detalle, disparado_por
        ) VALUES ($1, $2, 'toque_enviado', $3, $4, $5, $6, 'auto_runner')
    `, [
        id,
        telefono,
        toque.canal === 'whatsapp' ? 'whatsapp_auto' : 'llamada_ivr',
        pasoSiguiente + 1,
        resultado.exitoso || false,
        resultado.error || null
    ]);
    
    return resultado;
}

/**
 * Detecta clientes con respuesta y los pausa
 */
async function pausarRespondidos(pool) {
    // Busca clientes en flujo activo que tengan respuesta más reciente que su último toque
    const result = await pool.query(`
        UPDATE seguimiento_clientes sc
        SET estado = 'respondido',
            finalizado_motivo = 'cliente_respondio',
            finalizado_en = CURRENT_TIMESTAMP,
            proximo_toque_en = NULL
        FROM (
            SELECT DISTINCT telefono, MAX(creado_en) AS ultima_respuesta
            FROM seguimiento_log
            WHERE tipo = 'respuesta_recibida'
            GROUP BY telefono
        ) r
        WHERE sc.telefono = r.telefono
          AND sc.estado IN ('pendiente', 'en_curso')
          AND (sc.ultimo_toque_en IS NULL OR r.ultima_respuesta > sc.ultimo_toque_en - INTERVAL '5 minutes')
        RETURNING sc.id, sc.telefono, sc.cliente_nombre
    `);
    
    if (result.rows.length > 0) {
        console.log(`[AutoRunner] 🟢 ${result.rows.length} cliente(s) RESPONDIERON → pausados:`);
        result.rows.forEach(c => console.log(`              ${c.telefono} (${c.cliente_nombre})`));
        
        // Log por cliente
        for (const c of result.rows) {
            await pool.query(`
                INSERT INTO seguimiento_log (seguimiento_id, telefono, tipo, canal, mensaje, exitoso, disparado_por)
                VALUES ($1, $2, 'pausado_por_respuesta', 'sistema', 'Persecución pausada: cliente respondió', true, 'auto_runner')
            `, [c.id, c.telefono]);
        }
    }
    
    return result.rows.length;
}

/**
 * Detecta clientes que llevan 3+ días sin respuesta y los marca como agotados
 */
async function marcarAgotados(pool) {
    const result = await pool.query(`
        UPDATE seguimiento_clientes
        SET estado = 'agotado',
            finalizado_motivo = 'sin_respuesta_3_dias',
            finalizado_en = CURRENT_TIMESTAMP,
            proximo_toque_en = NULL
        WHERE estado IN ('pendiente', 'en_curso')
          AND creado_en < NOW() - INTERVAL '${CONFIG.DIAS_MAX_PERSECUCION} days'
        RETURNING id, telefono, cliente_nombre, saldo, dias_atraso, paso_actual
    `);
    
    if (result.rows.length > 0) {
        console.log(`[AutoRunner] 🔴 ${result.rows.length} cliente(s) AGOTADOS (${CONFIG.DIAS_MAX_PERSECUCION}d sin respuesta):`);
        result.rows.forEach(c => console.log(`              ${c.telefono} (${c.cliente_nombre}) - ${c.paso_actual} toques`));
        
        // Log por cliente
        for (const c of result.rows) {
            await pool.query(`
                INSERT INTO seguimiento_log (seguimiento_id, telefono, tipo, canal, mensaje, exitoso, disparado_por)
                VALUES ($1, $2, 'agotado', 'sistema', $3, true, 'auto_runner')
            `, [c.id, c.telefono, `Agotado tras ${c.paso_actual} toques en ${CONFIG.DIAS_MAX_PERSECUCION} días`]);
        }
        
        // Notificar al admin (resumen único)
        if (!CONFIG.DRY_RUN && CONFIG.ADMIN_TELEFONO) {
            try {
                const lista = result.rows
                    .slice(0, 20)
                    .map(c => `• ${c.cliente_nombre || c.telefono} - $${parseFloat(c.saldo).toLocaleString('es-MX')} (${c.dias_atraso}d)`)
                    .join('\n');
                
                const totalSaldo = result.rows.reduce((s, c) => s + (parseFloat(c.saldo) || 0), 0);
                
                const mensajeAdmin = `🔴 LeGaXi AutoRunner\n\n` +
                    `${result.rows.length} cliente(s) agotaron persecución (${CONFIG.DIAS_MAX_PERSECUCION}d sin respuesta).\n\n` +
                    `Saldo total agotado: $${totalSaldo.toLocaleString('es-MX')}\n\n` +
                    `${lista}` +
                    (result.rows.length > 20 ? `\n\n...y ${result.rows.length - 20} más` : '') +
                    `\n\nRevisa el panel para decidir siguiente paso.`;
                
                await mensajeria.enviarPorBaileys({
                    seguimientoId: null,
                    telefono: CONFIG.ADMIN_TELEFONO,
                    paso: 0,
                    mensaje: mensajeAdmin
                });
                console.log('[AutoRunner] 📧 Notificación enviada al admin');
            } catch (err) {
                console.error('[AutoRunner] ⚠️ No se pudo notificar al admin:', err.message);
            }
        }
    }
    
    return result.rows.length;
}

/**
 * Tick principal del cron: ejecuta toques pendientes
 */
async function ejecutarCiclo(pool) {
    if (!CONFIG.ACTIVO) {
        console.log('[AutoRunner] ⏸️  Motor desactivado (AUTO_RUNNER_ACTIVO=false)');
        return;
    }
    
    if (!enHorarioLaboral()) {
        console.log('[AutoRunner] 🌙 Fuera de horario laboral, no se ejecuta nada');
        return;
    }
    
    const inicioCiclo = Date.now();
    console.log(`\n[AutoRunner] ════════ CICLO ${new Date().toISOString()} ════════`);
    if (CONFIG.DRY_RUN) console.log('[AutoRunner] 🧪 MODO DRY_RUN ACTIVO (no se envía nada real)');
    
    try {
        // 1. Pausar clientes que respondieron
        const pausados = await pausarRespondidos(pool);
        
        // 2. Marcar agotados
        const agotados = await marcarAgotados(pool);
        
        // 3. Buscar clientes con toque vencido
        const vencidos = await pool.query(`
            SELECT id, telefono, cliente_nombre, saldo, dias_atraso, paso_actual
            FROM seguimiento_clientes
            WHERE estado IN ('pendiente', 'en_curso')
              AND (proximo_toque_en IS NULL OR proximo_toque_en <= NOW())
            ORDER BY 
                CASE WHEN proximo_toque_en IS NULL THEN 0 ELSE 1 END,
                proximo_toque_en ASC
            LIMIT 50
        `);
        
        console.log(`[AutoRunner] 📋 ${vencidos.rows.length} cliente(s) con toque vencido`);
        
        let exitosos = 0, fallidos = 0;
        
        for (const cliente of vencidos.rows) {
            try {
                const r = await procesarCliente(pool, cliente);
                if (r.exitoso) exitosos++;
                else fallidos++;
                
                // Pequeña pausa entre clientes para no saturar APIs
                await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (err) {
                console.error(`[AutoRunner] ❌ Error procesando cliente ${cliente.telefono}:`, err.message);
                fallidos++;
            }
        }
        
        const duracion = Math.round((Date.now() - inicioCiclo) / 1000);
        console.log(`[AutoRunner] ✅ Ciclo completado en ${duracion}s — ` +
                    `procesados:${vencidos.rows.length} exitosos:${exitosos} fallidos:${fallidos} ` +
                    `pausados:${pausados} agotados:${agotados}`);
        
    } catch (error) {
        console.error('[AutoRunner] 💥 Error en ciclo:', error);
    }
}

// ───────────────────────────────────────────────────────────────────────────
// MIGRACIÓN: asegura columnas necesarias
// ───────────────────────────────────────────────────────────────────────────

async function migracion(pool) {
    try {
        await pool.query(`
            ALTER TABLE seguimiento_clientes 
            ADD COLUMN IF NOT EXISTS finalizado_motivo TEXT
        `);
        await pool.query(`
            ALTER TABLE seguimiento_clientes 
            ADD COLUMN IF NOT EXISTS finalizado_en TIMESTAMP
        `);
        console.log('[AutoRunner] ✓ Migración OK');
    } catch (err) {
        console.warn('[AutoRunner] ⚠️ Migración:', err.message);
    }
}

// ───────────────────────────────────────────────────────────────────────────
// MONTAJE: se llama desde server.js
// ───────────────────────────────────────────────────────────────────────────

function montar(app, pool) {
    // 1. Migración inicial
    migracion(pool);
    
    // 2. Endpoints de control para el panel admin
    app.get('/api/auto-runner/estado', async (req, res) => {
        try {
            const stats = await pool.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE estado IN ('pendiente', 'en_curso')) AS activos,
                    COUNT(*) FILTER (WHERE estado = 'respondido') AS respondieron,
                    COUNT(*) FILTER (WHERE estado = 'agotado') AS agotados,
                    COUNT(*) FILTER (WHERE estado = 'excluido') AS excluidos
                FROM seguimiento_clientes
            `);
            
            const proximos = await pool.query(`
                SELECT telefono, cliente_nombre, paso_actual, ultimo_toque_canal, proximo_toque_en
                FROM seguimiento_clientes
                WHERE estado IN ('pendiente', 'en_curso')
                  AND proximo_toque_en IS NOT NULL
                ORDER BY proximo_toque_en ASC
                LIMIT 10
            `);
            
            res.json({
                success: true,
                config: {
                    activo: CONFIG.ACTIVO,
                    dryRun: CONFIG.DRY_RUN,
                    horario: `${CONFIG.HORA_INICIO}-${CONFIG.HORA_FIN}h Lun-Sáb`,
                    enHorarioLaboral: enHorarioLaboral(),
                    intervaloMinutos: CONFIG.INTERVALO_CRON_MINUTOS,
                    diasMaxPersecucion: CONFIG.DIAS_MAX_PERSECUCION,
                    secuencia: CONFIG.SECUENCIA
                },
                stats: stats.rows[0],
                proximos: proximos.rows
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
    
    // Endpoint manual: forzar ciclo (útil para debugging)
    app.post('/api/auto-runner/ejecutar-ahora', async (req, res) => {
        try {
            console.log('[AutoRunner] 🔧 Ciclo forzado vía API');
            ejecutarCiclo(pool).catch(err => console.error('[AutoRunner] Error:', err));
            res.json({ success: true, mensaje: 'Ciclo lanzado en background, revisa logs' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
    
    // Endpoint: pausar/reactivar el motor
    app.post('/api/auto-runner/toggle', (req, res) => {
        CONFIG.ACTIVO = !CONFIG.ACTIVO;
        console.log(`[AutoRunner] Motor ${CONFIG.ACTIVO ? 'ACTIVADO' : 'PAUSADO'} vía API`);
        res.json({ success: true, activo: CONFIG.ACTIVO });
    });
    
    // 3. Cron interno: ejecuta cada N minutos
    const intervalMs = CONFIG.INTERVALO_CRON_MINUTOS * 60 * 1000;
    setInterval(() => {
        ejecutarCiclo(pool).catch(err => console.error('[AutoRunner] Ciclo falló:', err));
    }, intervalMs);
    
    // 4. Ejecutar inmediato al arranque (después de 30s para que server esté listo)
    setTimeout(() => {
        ejecutarCiclo(pool).catch(err => console.error('[AutoRunner] Ciclo inicial:', err));
    }, 30000);
    
    console.log('═══════════════════════════════════════════════════════');
    console.log(`🤖 AutoRunner v1.0 montado`);
    console.log(`   Activo:        ${CONFIG.ACTIVO ? 'SÍ' : 'NO'}`);
    console.log(`   Dry-run:       ${CONFIG.DRY_RUN ? 'SÍ (no envía)' : 'NO (real)'}`);
    console.log(`   Horario:       ${CONFIG.HORA_INICIO}h-${CONFIG.HORA_FIN}h Lun-Sáb`);
    console.log(`   Intervalo:     cada ${CONFIG.INTERVALO_CRON_MINUTOS} min`);
    console.log(`   Días máx:      ${CONFIG.DIAS_MAX_PERSECUCION} días sin respuesta`);
    console.log(`   Secuencia:     ${CONFIG.SECUENCIA.map(s => `${s.canal}+${s.esperaHoras}h`).join(' → ')}`);
    console.log(`   Admin:         ${CONFIG.ADMIN_TELEFONO}`);
    console.log('═══════════════════════════════════════════════════════');
}

module.exports = { montar, CONFIG, ejecutarCiclo };
