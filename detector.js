// ═══════════════════════════════════════════════════════════════════════════
// DETECTOR DE FANTASMAS - LeGaXi Cobranza
// 
// Lee Google Sheets + PostgreSQL y devuelve la lista de clientes
// que necesitan seguimiento (sin contacto humano real en X dias).
//
// IMPORTANTE: Este modulo es SOLO LECTURA. No envia nada, no modifica nada.
// Solo retorna la lista para que el panel decida que hacer.
// ═══════════════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');
const { Pool } = require('pg');

const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const DIAS_SIN_CONTACTO = parseInt(process.env.DIAS_SIN_CONTACTO) || 10;
const SALDO_MINIMO = parseFloat(process.env.SALDO_MINIMO) || 1;
const INCLUIR_LIQUIDADOS = process.env.INCLUIR_LIQUIDADOS === 'true';

// Pool global de PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ───────────────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────────────

function normalizarTelefono(tel) {
    const limpio = String(tel || '').replace(/[^0-9]/g, '');
    return limpio.length > 10 ? limpio.slice(-10) : limpio;
}

function diasDesde(fecha) {
    if (!fecha) return Infinity;
    const f = new Date(fecha);
    if (isNaN(f.getTime())) return Infinity;
    const diff = (Date.now() - f.getTime()) / (1000 * 60 * 60 * 24);
    return Math.floor(diff);
}

// Resultados IVR que cuentan como CONTACTO HUMANO REAL
// (cliente presiono tecla DTMF, no buzon ni grabadora)
const RESULTADOS_CONTACTO_REAL = new Set([
    'promesa_pago',
    'pago',
    'ya_pago',
    'asesor',
    'transferencia'
]);

// ───────────────────────────────────────────────────────────────────────────
// 1. CARGAR DATOS DE GOOGLE SHEETS (un solo fetch para todo)
// ───────────────────────────────────────────────────────────────────────────

async function cargarDatosSheets() {
    console.log('[Detector] Cargando datos de Google Sheets...');
    
    const url = `${GOOGLE_SCRIPT_URL}?action=fullSync`;
    const res = await fetch(url, { 
        method: 'GET',
        timeout: 60000 
    });
    
    if (!res.ok) {
        throw new Error(`Error fullSync HTTP ${res.status}`);
    }
    
    const json = await res.json();
    
    if (json.error) {
        throw new Error(`Error GAS: ${json.error}`);
    }
    
    const data = json.data || {};
    console.log(`[Detector] Cargados: ${(data.clientes||[]).length} clientes, ${(data.pagos||[]).length} pagos, ${(data.convenios||[]).length} convenios, ${(data.promesas||[]).length} promesas`);
    
    return {
        clientes: data.clientes || [],
        pagos: data.pagos || [],
        convenios: data.convenios || [],
        promesas: data.promesas || [],
        ubicaciones: data.ubicaciones || []
    };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. CARGAR LLAMADAS IVR (separado porque puede ser hoja grande)
// ───────────────────────────────────────────────────────────────────────────

async function cargarLlamadasIVR() {
    console.log('[Detector] Cargando hoja LlamadasIVR via fullSync (se incluye en data)...');
    // Nota: fullSync NO trae LlamadasIVR. Hay que extender el GAS o leer aparte.
    // Por ahora, retornamos vacio y manejamos contacto IVR como ausente.
    // TODO: Agregar endpoint getLlamadasIVR al GAS si quieres usar esta senal.
    return [];
}

// ───────────────────────────────────────────────────────────────────────────
// 3. CARGAR TRACKING (visitas de cobradores)
// ───────────────────────────────────────────────────────────────────────────

async function cargarTracking() {
    console.log('[Detector] Tracking se incluiria via getTracking si existiera endpoint...');
    // Mismo caso: fullSync no incluye Tracking. Por ahora ausente.
    // TODO: Agregar endpoint getTracking al GAS si quieres usar esta senal.
    return [];
}

// ───────────────────────────────────────────────────────────────────────────
// 4. CARGAR CLIENTES YA EN FLUJO (de PostgreSQL)
// ───────────────────────────────────────────────────────────────────────────

async function cargarYaEnFlujo() {
    console.log('[Detector] Cargando clientes ya en flujo de PostgreSQL...');
    
    const result = await pool.query(`
        SELECT telefono, estado, paso_actual, proximo_toque_en
        FROM seguimiento_clientes
        WHERE estado IN ('pendiente', 'en_curso')
    `);
    
    console.log(`[Detector] ${result.rows.length} clientes ya en flujo`);
    
    const map = {};
    result.rows.forEach(r => {
        map[normalizarTelefono(r.telefono)] = r;
    });
    return map;
}

// ───────────────────────────────────────────────────────────────────────────
// 5. CONSTRUIR INDICES DE CONTACTO (para busqueda rapida)
// ───────────────────────────────────────────────────────────────────────────

function construirIndicesContacto(datos, llamadas, tracking) {
    const ahora = Date.now();
    const cutoffMs = DIAS_SIN_CONTACTO * 24 * 60 * 60 * 1000;
    
    // Telefono → fecha del ultimo evento de contacto real
    const ultimoPago = {};
    const ultimoConvenio = {};
    const ultimaPromesaCumplida = {};
    const ultimaLlamadaReal = {};
    const ultimaVisita = {};
    
    // Pagos
    datos.pagos.forEach(p => {
        const tel = normalizarTelefono(p['Teléfono'] || p.telefono || p.clienteId);
        if (!tel) return;
        const fecha = new Date(p.date || p.fecha || p.timestamp);
        if (isNaN(fecha.getTime())) return;
        if (!ultimoPago[tel] || fecha > ultimoPago[tel]) {
            ultimoPago[tel] = fecha;
        }
    });
    
    // Convenios activos
    datos.convenios.forEach(c => {
        if (String(c.estado || '').toLowerCase() === 'cancelado') return;
        const tel = normalizarTelefono(c['Teléfono'] || c.telefono);
        if (!tel) return;
        const fecha = new Date(c.creadoEn || c.fechaInicio);
        if (isNaN(fecha.getTime())) return;
        if (!ultimoConvenio[tel] || fecha > ultimoConvenio[tel]) {
            ultimoConvenio[tel] = fecha;
        }
    });
    
    // Promesas cumplidas
    datos.promesas.forEach(p => {
        if (String(p.Estado || '').toLowerCase() !== 'cumplida') return;
        const tel = normalizarTelefono(p['Teléfono'] || p.telefono);
        if (!tel) return;
        const fecha = new Date(p.FechaCumplida || p.Registrada);
        if (isNaN(fecha.getTime())) return;
        if (!ultimaPromesaCumplida[tel] || fecha > ultimaPromesaCumplida[tel]) {
            ultimaPromesaCumplida[tel] = fecha;
        }
    });
    
    // Llamadas IVR (SOLO con DTMF real)
    llamadas.forEach(l => {
        const resultado = String(l.Resultado || '').toLowerCase();
        if (!RESULTADOS_CONTACTO_REAL.has(resultado)) return;
        const tel = normalizarTelefono(l['Teléfono'] || l.telefono);
        if (!tel) return;
        const fecha = new Date(l.Fecha);
        if (isNaN(fecha.getTime())) return;
        if (!ultimaLlamadaReal[tel] || fecha > ultimaLlamadaReal[tel]) {
            ultimaLlamadaReal[tel] = fecha;
        }
    });
    
    // Tracking de visitas
    tracking.forEach(t => {
        if (String(t.TipoActividad || '') !== 'cliente_visitado') return;
        const tel = normalizarTelefono(t.ClienteId || t.telefono);
        if (!tel) return;
        const fecha = new Date(t.Timestamp);
        if (isNaN(fecha.getTime())) return;
        if (!ultimaVisita[tel] || fecha > ultimaVisita[tel]) {
            ultimaVisita[tel] = fecha;
        }
    });
    
    return {
        ultimoPago,
        ultimoConvenio,
        ultimaPromesaCumplida,
        ultimaLlamadaReal,
        ultimaVisita
    };
}

// ───────────────────────────────────────────────────────────────────────────
// 6. EVALUAR SI UN CLIENTE ES FANTASMA
// ───────────────────────────────────────────────────────────────────────────

function evaluarFantasma(cliente, indices, yaEnFlujo) {
    const tel = normalizarTelefono(cliente['Teléfono']);
    
    // Filtro 1: telefono valido
    if (!tel || tel.length !== 10) {
        return { fantasma: false, motivo: 'sin_telefono' };
    }
    
    // Filtro 2: saldo
    const saldo = parseFloat(cliente.Saldo) || 0;
    if (!INCLUIR_LIQUIDADOS && saldo < SALDO_MINIMO) {
        return { fantasma: false, motivo: 'liquidado' };
    }
    
    // Filtro 3: ya en flujo
    if (yaEnFlujo[tel]) {
        return { fantasma: false, motivo: 'ya_en_flujo', estado: yaEnFlujo[tel].estado };
    }
    
    // Filtro 4: contacto reciente (cualquiera de las 5 senales)
    const senales = [
        { tipo: 'pago', fecha: indices.ultimoPago[tel] },
        { tipo: 'convenio', fecha: indices.ultimoConvenio[tel] },
        { tipo: 'promesa_cumplida', fecha: indices.ultimaPromesaCumplida[tel] },
        { tipo: 'llamada_real', fecha: indices.ultimaLlamadaReal[tel] },
        { tipo: 'visita', fecha: indices.ultimaVisita[tel] }
    ].filter(s => s.fecha);
    
    if (senales.length > 0) {
        // Encontrar la mas reciente
        senales.sort((a, b) => b.fecha - a.fecha);
        const masReciente = senales[0];
        const dias = diasDesde(masReciente.fecha);
        
        if (dias < DIAS_SIN_CONTACTO) {
            return { 
                fantasma: false, 
                motivo: 'contacto_reciente',
                ultimoContacto: masReciente.tipo,
                diasDesdeContacto: dias
            };
        }
    }
    
    // ES FANTASMA
    const ultimoContactoConocido = senales.length > 0 
        ? { tipo: senales[0].tipo, dias: diasDesde(senales[0].fecha) }
        : { tipo: 'nunca', dias: null };
    
    return {
        fantasma: true,
        telefono: tel,
        cliente: cliente.Cliente || '',
        saldo: saldo,
        diasAtraso: parseInt(cliente['Días Atraso']) || 0,
        promotor: cliente.Promotor || '',
        riesgo: cliente.Riesgo || '',
        ultimoContacto: ultimoContactoConocido
    };
}

// ───────────────────────────────────────────────────────────────────────────
// 7. FUNCION PRINCIPAL DEL DETECTOR
// ───────────────────────────────────────────────────────────────────────────

async function detectarFantasmas() {
    const inicio = Date.now();
    console.log('═══════════════════════════════════════════════════════');
    console.log('DETECTOR DE FANTASMAS - LeGaXi');
    console.log(`Configuracion: ${DIAS_SIN_CONTACTO} dias, saldo>=${SALDO_MINIMO}, liquidados=${INCLUIR_LIQUIDADOS}`);
    console.log('═══════════════════════════════════════════════════════');
    
    // Cargar todo en paralelo
    const [datos, llamadas, tracking, yaEnFlujo] = await Promise.all([
        cargarDatosSheets(),
        cargarLlamadasIVR(),
        cargarTracking(),
        cargarYaEnFlujo()
    ]);
    
    // Construir indices de contacto
    const indices = construirIndicesContacto(datos, llamadas, tracking);
    
    // Evaluar cada cliente
    const stats = {
        totalClientes: datos.clientes.length,
        sinTelefono: 0,
        liquidados: 0,
        contactoReciente: 0,
        yaEnFlujo: 0,
        fantasmas: 0
    };
    
    const fantasmas = [];
    const desglose = {
        contactoPorPago: 0,
        contactoPorConvenio: 0,
        contactoPorPromesa: 0,
        contactoPorLlamada: 0,
        contactoPorVisita: 0
    };
    
    datos.clientes.forEach(cliente => {
        const eval_ = evaluarFantasma(cliente, indices, yaEnFlujo);
        
        if (eval_.motivo === 'sin_telefono') stats.sinTelefono++;
        else if (eval_.motivo === 'liquidado') stats.liquidados++;
        else if (eval_.motivo === 'ya_en_flujo') stats.yaEnFlujo++;
        else if (eval_.motivo === 'contacto_reciente') {
            stats.contactoReciente++;
            const tipo = eval_.ultimoContacto;
            if (tipo === 'pago') desglose.contactoPorPago++;
            else if (tipo === 'convenio') desglose.contactoPorConvenio++;
            else if (tipo === 'promesa_cumplida') desglose.contactoPorPromesa++;
            else if (tipo === 'llamada_real') desglose.contactoPorLlamada++;
            else if (tipo === 'visita') desglose.contactoPorVisita++;
        } else if (eval_.fantasma) {
            stats.fantasmas++;
            fantasmas.push(eval_);
        }
    });
    
    // Ordenar fantasmas por saldo descendente (los de mas dinero primero)
    fantasmas.sort((a, b) => b.saldo - a.saldo);
    
    const tiempo = ((Date.now() - inicio) / 1000).toFixed(2);
    
    console.log('───────────────────────────────────────────────────────');
    console.log('RESULTADOS:');
    console.log(`  Total clientes en cartera:        ${stats.totalClientes}`);
    console.log(`  Excluidos sin telefono:           ${stats.sinTelefono}`);
    console.log(`  Excluidos liquidados:             ${stats.liquidados}`);
    console.log(`  Excluidos contacto reciente:      ${stats.contactoReciente}`);
    console.log(`    - por pago:                     ${desglose.contactoPorPago}`);
    console.log(`    - por convenio:                 ${desglose.contactoPorConvenio}`);
    console.log(`    - por promesa cumplida:         ${desglose.contactoPorPromesa}`);
    console.log(`    - por llamada real (DTMF):      ${desglose.contactoPorLlamada}`);
    console.log(`    - por visita gestor:            ${desglose.contactoPorVisita}`);
    console.log(`  Excluidos ya en flujo:            ${stats.yaEnFlujo}`);
    console.log(`  ─────────────────────────────────────`);
    console.log(`  FANTASMAS DETECTADOS:             ${stats.fantasmas}`);
    console.log(`  Tiempo: ${tiempo}s`);
    console.log('═══════════════════════════════════════════════════════');
    
    return {
        stats,
        desglose,
        fantasmas,
        config: {
            diasSinContacto: DIAS_SIN_CONTACTO,
            saldoMinimo: SALDO_MINIMO,
            incluirLiquidados: INCLUIR_LIQUIDADOS
        },
        timestamp: new Date().toISOString(),
        tiempoMs: Date.now() - inicio
    };
}

// ───────────────────────────────────────────────────────────────────────────
// EJECUCION DIRECTA (node detector.js)
// ───────────────────────────────────────────────────────────────────────────

if (require.main === module) {
    require('dotenv').config();
    detectarFantasmas()
        .then(resultado => {
            console.log('\n═══ TOP 20 FANTASMAS POR SALDO ═══');
            resultado.fantasmas.slice(0, 20).forEach((f, i) => {
                const ult = f.ultimoContacto.dias !== null 
                    ? `${f.ultimoContacto.dias}d (${f.ultimoContacto.tipo})`
                    : 'nunca';
                console.log(`${(i+1).toString().padStart(3)}. ${f.telefono} | $${f.saldo.toString().padStart(10)} | ${f.diasAtraso}d atraso | ult: ${ult.padEnd(20)} | ${f.cliente.substring(0, 30)}`);
            });
            process.exit(0);
        })
        .catch(err => {
            console.error('ERROR:', err.message);
            console.error(err.stack);
            process.exit(1);
        });
}

module.exports = { detectarFantasmas };
