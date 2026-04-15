// ═══════════════════════════════════════════════════════════════════════════
// MODULO DE MENSAJERIA - LeGaXi Seguimiento
// 
// Tres modos de envio:
//   1. WhatsApp link (wa.me) - solo genera URL, lo abre el navegador
//   2. WhatsApp automatico via chatbot Baileys (HTTP a endpoint configurable)
//   3. Llamada IVR via Asterisk/Zadarma (HTTP a endpoint configurable)
//
// Cada metodo registra en seguimiento_log automaticamente.
// ═══════════════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// URLs configurables (vacias = modo deshabilitado, botones se ocultan en panel)
const CHATBOT_URL = process.env.CHATBOT_BAILEYS_URL || '';
const CHATBOT_TOKEN = process.env.CHATBOT_BAILEYS_TOKEN || '';
const IVR_URL = process.env.IVR_ZADARMA_URL || '';
const IVR_TOKEN = process.env.IVR_ZADARMA_TOKEN || '';

// Numero de empresa para wa.me (sin +, con codigo pais)
const NUMERO_EMPRESA = process.env.NUMERO_EMPRESA || '525544621100';

// ───────────────────────────────────────────────────────────────────────────
// PLANTILLAS DE MENSAJES (escalada gradual: cordial -> firme)
// ───────────────────────────────────────────────────────────────────────────

const PLANTILLAS_WHATSAPP = {
    paso1_cordial: (nombre, saldo) => 
`Hola ${nombre}, le saluda LMV CREDIA.

Le escribimos para recordarle amablemente que tiene un saldo pendiente de $${Math.round(saldo).toLocaleString('es-MX')} pesos con nosotros.

¿Podemos coordinar un pago o una visita esta semana? Sus datos están seguros y queremos apoyarle a regularizar su cuenta.

Gracias por su atención.`,

    paso3_firme: (nombre, saldo, dias) =>
`${nombre}, le contactamos nuevamente desde LMV CREDIA.

Su saldo pendiente es de $${Math.round(saldo).toLocaleString('es-MX')} pesos con ${dias} días de atraso.

Necesitamos su respuesta antes del fin de semana para evitar reportar su crédito a buró. Puede contestar a este mensaje o llamarnos al 5544621100.

Esperamos su pronta respuesta.`,

    paso5_urgente: (nombre, saldo, dias) =>
`${nombre}, este es nuestro último intento de contacto amistoso desde LMV CREDIA.

Saldo: $${Math.round(saldo).toLocaleString('es-MX')} pesos
Atraso: ${dias} días

Si no recibimos respuesta en 48 horas, su cuenta pasará a gestión legal y reporte a buró de crédito conforme a contrato firmado.

Para evitarlo, contáctenos hoy mismo: 5544621100`,

    convenio_recordatorio: (nombre, monto, fecha) =>
`Hola ${nombre}, le recordamos su próximo pago de convenio:

Monto: $${Math.round(monto).toLocaleString('es-MX')}
Fecha: ${fecha}

LMV CREDIA agradece su cumplimiento.`
};

// ───────────────────────────────────────────────────────────────────────────
// LOG HELPER
// ───────────────────────────────────────────────────────────────────────────

async function registrarLog({ seguimientoId, telefono, tipo, canal, paso, mensaje, exitoso = true, errorDetalle = null, apiResponse = null, disparadoPor = 'panel_manual' }) {
    try {
        await pool.query(`
            INSERT INTO seguimiento_log (
                seguimiento_id, telefono, tipo, canal, paso, mensaje, 
                exitoso, error_detalle, api_response, disparado_por
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
            seguimientoId || null,
            telefono,
            tipo,
            canal,
            paso || null,
            mensaje || null,
            exitoso,
            errorDetalle,
            apiResponse ? JSON.stringify(apiResponse) : null,
            disparadoPor
        ]);
    } catch (e) {
        console.error('[Mensajeria] Error registrando log:', e.message);
    }
}

async function actualizarSeguimientoTrasEnvio(seguimientoId, paso, canal) {
    try {
        const proximoToqueEn = new Date();
        proximoToqueEn.setDate(proximoToqueEn.getDate() + 2); // +2 dias para siguiente toque
        
        const nuevoEstado = paso >= 5 ? 'finalizado' : 'en_curso';
        const finalizadoMotivo = paso >= 5 ? 'completo_escalera' : null;
        
        await pool.query(`
            UPDATE seguimiento_clientes
            SET paso_actual = $2,
                ultimo_toque_en = CURRENT_TIMESTAMP,
                ultimo_toque_canal = $3,
                proximo_toque_en = CASE WHEN $4::text = 'finalizado' THEN NULL ELSE $5 END,
                estado = $4,
                finalizado_motivo = COALESCE($6, finalizado_motivo),
                finalizado_en = CASE WHEN $4::text = 'finalizado' THEN CURRENT_TIMESTAMP ELSE finalizado_en END
            WHERE id = $1
        `, [seguimientoId, paso, canal, nuevoEstado, proximoToqueEn, finalizadoMotivo]);
    } catch (e) {
        console.error('[Mensajeria] Error actualizando seguimiento:', e.message);
    }
}

// ───────────────────────────────────────────────────────────────────────────
// MODO 1: GENERAR LINK wa.me (no envia, solo retorna URL)
// ───────────────────────────────────────────────────────────────────────────

function generarLinkWhatsApp({ telefono, mensaje }) {
    const tel = String(telefono).replace(/\D/g, '');
    const telConPais = tel.length === 10 ? '52' + tel : tel;
    const mensajeEncoded = encodeURIComponent(mensaje);
    return `https://wa.me/${telConPais}?text=${mensajeEncoded}`;
}

async function registrarEnvioLink({ seguimientoId, telefono, paso, mensaje }) {
    await registrarLog({
        seguimientoId, telefono,
        tipo: 'toque_enviado',
        canal: 'whatsapp_link',
        paso, mensaje,
        exitoso: true,
        disparadoPor: 'panel_manual'
    });
    
    if (seguimientoId && paso) {
        await actualizarSeguimientoTrasEnvio(seguimientoId, paso, 'whatsapp_link');
    }
}

// ───────────────────────────────────────────────────────────────────────────
// MODO 2: ENVIO AUTOMATICO via chatbot Baileys
// ───────────────────────────────────────────────────────────────────────────

async function enviarPorBaileys({ seguimientoId, telefono, paso, mensaje }) {
    if (!CHATBOT_URL) {
        return { exitoso: false, error: 'CHATBOT_BAILEYS_URL no configurado' };
    }
    
    try {
        const tel = String(telefono).replace(/\D/g, '');
        const telConPais = tel.length === 10 ? '52' + tel : tel;
        
        const headers = { 'Content-Type': 'application/json' };
        if (CHATBOT_TOKEN) headers['Authorization'] = `Bearer ${CHATBOT_TOKEN}`;
        
        const res = await fetch(CHATBOT_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                telefono: telConPais,
                mensaje: mensaje
            }),
            timeout: 30000
        });
        
        const data = await res.json().catch(() => ({}));
        const exitoso = res.ok && (data.success !== false);
        
        await registrarLog({
            seguimientoId, telefono,
            tipo: 'toque_enviado',
            canal: 'whatsapp_baileys',
            paso, mensaje,
            exitoso,
            errorDetalle: exitoso ? null : (data.error || `HTTP ${res.status}`),
            apiResponse: data,
            disparadoPor: 'panel_manual'
        });
        
        if (exitoso && seguimientoId && paso) {
            await actualizarSeguimientoTrasEnvio(seguimientoId, paso, 'whatsapp_baileys');
        }
        
        return { exitoso, data, status: res.status };
        
    } catch (error) {
        await registrarLog({
            seguimientoId, telefono,
            tipo: 'toque_enviado',
            canal: 'whatsapp_baileys',
            paso, mensaje,
            exitoso: false,
            errorDetalle: error.message,
            disparadoPor: 'panel_manual'
        });
        return { exitoso: false, error: error.message };
    }
}

// ───────────────────────────────────────────────────────────────────────────
// MODO 3: LLAMADA IVR via Asterisk/Zadarma
// ───────────────────────────────────────────────────────────────────────────

async function llamarPorIVR({ seguimientoId, telefono, paso, cliente, saldo, diasAtraso }) {
    if (!IVR_URL) {
        return { exitoso: false, error: 'IVR_ZADARMA_URL no configurado' };
    }
    
    try {
        const tel = String(telefono).replace(/\D/g, '');
        const telConPais = tel.length === 10 ? '52' + tel : tel;
        
        const headers = { 'Content-Type': 'application/json' };
        if (IVR_TOKEN) headers['Authorization'] = `Bearer ${IVR_TOKEN}`;
        
        const res = await fetch(IVR_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                telefono: telConPais,
                cliente: cliente || '',
                saldo: saldo || 0,
                diasAtraso: diasAtraso || 0,
                tono: paso >= 4 ? 'firme' : 'cordial'
            }),
            timeout: 30000
        });
        
        const data = await res.json().catch(() => ({}));
        const exitoso = res.ok && (data.success !== false);
        
        await registrarLog({
            seguimientoId, telefono,
            tipo: 'toque_enviado',
            canal: 'llamada_ivr',
            paso,
            mensaje: `Llamada IVR a ${cliente || telefono}`,
            exitoso,
            errorDetalle: exitoso ? null : (data.error || `HTTP ${res.status}`),
            apiResponse: data,
            disparadoPor: 'panel_manual'
        });
        
        if (exitoso && seguimientoId && paso) {
            await actualizarSeguimientoTrasEnvio(seguimientoId, paso, 'llamada_ivr');
        }
        
        return { exitoso, data, status: res.status };
        
    } catch (error) {
        await registrarLog({
            seguimientoId, telefono,
            tipo: 'toque_enviado',
            canal: 'llamada_ivr',
            paso,
            mensaje: `Llamada IVR a ${cliente || telefono}`,
            exitoso: false,
            errorDetalle: error.message,
            disparadoPor: 'panel_manual'
        });
        return { exitoso: false, error: error.message };
    }
}

// ───────────────────────────────────────────────────────────────────────────
// HELPER: GENERAR MENSAJE SEGUN PASO
// ───────────────────────────────────────────────────────────────────────────

function generarMensajePorPaso(paso, cliente, saldo, diasAtraso) {
    const nombre = (cliente || 'Cliente').split(' ')[0]; // Primer nombre solo
    
    switch(paso) {
        case 1:
        case 2:
            return PLANTILLAS_WHATSAPP.paso1_cordial(nombre, saldo);
        case 3:
        case 4:
            return PLANTILLAS_WHATSAPP.paso3_firme(nombre, saldo, diasAtraso);
        case 5:
            return PLANTILLAS_WHATSAPP.paso5_urgente(nombre, saldo, diasAtraso);
        default:
            return PLANTILLAS_WHATSAPP.paso1_cordial(nombre, saldo);
    }
}

// ───────────────────────────────────────────────────────────────────────────
// CONFIGURACION DISPONIBLE (para que panel sepa que botones mostrar)
// ───────────────────────────────────────────────────────────────────────────

function getConfig() {
    return {
        whatsappLink: true,  // Siempre disponible
        whatsappBaileys: !!CHATBOT_URL,
        llamadaIVR: !!IVR_URL,
        numeroEmpresa: NUMERO_EMPRESA,
        plantillas: Object.keys(PLANTILLAS_WHATSAPP)
    };
}

module.exports = {
    generarLinkWhatsApp,
    registrarEnvioLink,
    enviarPorBaileys,
    llamarPorIVR,
    generarMensajePorPaso,
    getConfig,
    PLANTILLAS_WHATSAPP
};
