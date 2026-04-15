// ═══════════════════════════════════════════════════════════════════════════
// DETECTOR DE FANTASMAS - LeGaXi Cobranza v1.1
// 
// NUEVO en v1.1:
//   - Calcula montoPagado = SaldoOriginal - Saldo
//   - Calcula porcentajeAvance
//   - Clasifica en 3 categorias: ACTIVO (>50% pagado), TIBIO (1-50%), FRIO (0%)
//   - Ordena: Activos primero (por saldo desc), luego Tibios, luego Frios
//   - Si Saldo < SaldoOriginal sin fecha de pago, cuenta como contacto historico
//
// IMPORTANTE: Sigue siendo SOLO LECTURA. No envia nada, no modifica nada.
// ═══════════════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');
const { Pool } = require('pg');

const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const DIAS_SIN_CONTACTO = parseInt(process.env.DIAS_SIN_CONTACTO) || 10;
const SALDO_MINIMO = parseFloat(process.env.SALDO_MINIMO) || 1;
const INCLUIR_LIQUIDADOS = process.env.INCLUIR_LIQUIDADOS === 'true';

// Umbrales de clasificacion
const UMBRAL_ACTIVO = 0.50;  // 50%+ pagado = ACTIVO
const UMBRAL_TIBIO = 0.01;   // 1-50% pagado = TIBIO
                             // 0% = FRIO

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

function clasificarPorAvance(porcentaje) {
    if (porcentaje >= UMBRAL_ACTIVO) return 'ACTIVO';
    if (porcentaje >= UMBRAL_TIBIO) return 'TIBIO';
    return 'FRIO';
}

const RESULTADOS_CONTACTO_REAL = new Set([
    'promesa_pago',
    'pago',
    'ya_pago',
    'asesor',
    'transferencia'
]);

// ───────────────────────────────────────────────────────────────────────────
// CARGA DE DATOS
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
// INDICES DE CONTACTO
// ───────────────────────────────────────────────────────────────────────────

function construirIndicesContacto(datos) {
    const ultimoPago = {};
    const ultimoConvenio = {};
    const ultimaPromesaCumplida = {};
    
    datos.pagos.forEach(p => {
        const tel = normalizarTelefono(p['Teléfono'] || p.telefono || p.clienteId);
        if (!tel) return;
        const fecha = new Date(p.date || p.fecha || p.timestamp);
        if (isNaN(fecha.getTime())) return;
        if (!ultimoPago[tel] || fecha > ultimoPago[tel]) {
            ultimoPago[tel] = fecha;
        }
    });
    
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
    
    return {
        ultimoPago,
        ultimoConvenio,
        ultimaPromesaCumplida
    };
}

// ───────────────────────────────────────────────────────────────────────────
// EVALUAR CLIENTE
// ───────────────────────────────────────────────────────────────────────────

function evaluarFantasma(cliente, indices, yaEnFlujo) {
    const tel = normalizarTelefono(cliente['Teléfono']);
    
    if (!tel || tel.length !== 10) {
        return { fantasma: false, motivo: 'sin_telefono' };
    }
    
    const saldo = parseFloat(cliente.Saldo) || 0;
    const saldoOriginal = parseFloat(cliente.SaldoOriginal) || saldo;
    
    if (!INCLUIR_LIQUIDADOS && saldo < SALDO_MINIMO) {
        return { fantasma: false, motivo: 'liquidado' };
    }
    
    if (yaEnFlujo[tel]) {
        return { fantasma: false, motivo: 'ya_en_flujo', estado: yaEnFlujo[tel].estado };
    }
    
    // Calcular avance del cliente
    const montoPagado = Math.max(0, saldoOriginal - saldo);
    const porcentajeAvance = saldoOriginal > 0 ? montoPagado / saldoOriginal : 0;
    const categoria = clasificarPorAvance(porcentajeAvance);
    
    // Buscar contacto reciente
    const senales = [
        { tipo: 'pago', fecha: indices.ultimoPago[tel] },
        { tipo: 'convenio', fecha: indices.ultimoConvenio[tel] },
        { tipo: 'promesa_cumplida', fecha: indices.ultimaPromesaCumplida[tel] }
    ].filter(s => s.fecha);
    
    if (senales.length > 0) {
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
        
        // ES FANTASMA pero con historial de contacto
        return {
            fantasma: true,
            telefono: tel,
            cliente: cliente.Cliente || '',
            saldo: saldo,
            saldoOriginal: saldoOriginal,
            montoPagado: montoPagado,
            porcentajeAvance: Math.round(porcentajeAvance * 100),
            categoria: categoria,
            diasAtraso: parseInt(cliente['Días Atraso']) || 0,
            promotor: cliente.Promotor || '',
            riesgo: cliente.Riesgo || '',
            ultimoContacto: { 
                tipo: masReciente.tipo, 
                dias: diasDesde(masReciente.fecha) 
            }
        };
    }
    
    // Sin contacto registrado en hojas, pero ¿pago histórico (Saldo < SaldoOriginal)?
    const ultimoContacto = montoPagado > 0
        ? { tipo: 'pago_historico', dias: null }  // Sabemos que pagó pero no cuándo
        : { tipo: 'nunca', dias: null };
    
    return {
        fantasma: true,
        telefono: tel,
        cliente: cliente.Cliente || '',
        saldo: saldo,
        saldoOriginal: saldoOriginal,
        montoPagado: montoPagado,
        porcentajeAvance: Math.round(porcentajeAvance * 100),
        categoria: categoria,
        diasAtraso: parseInt(cliente['Días Atraso']) || 0,
        promotor: cliente.Promotor || '',
        riesgo: cliente.Riesgo || '',
        ultimoContacto: ultimoContacto
    };
}

// ───────────────────────────────────────────────────────────────────────────
// FUNCION PRINCIPAL
// ───────────────────────────────────────────────────────────────────────────

async function detectarFantasmas() {
    const inicio = Date.now();
    console.log('═══════════════════════════════════════════════════════');
    console.log('DETECTOR DE FANTASMAS v1.1 - LeGaXi');
    console.log(`Configuracion: ${DIAS_SIN_CONTACTO} dias, saldo>=${SALDO_MINIMO}, liquidados=${INCLUIR_LIQUIDADOS}`);
    console.log(`Umbrales: ACTIVO>=${UMBRAL_ACTIVO*100}%, TIBIO>=${UMBRAL_TIBIO*100}%, FRIO=0%`);
    console.log('═══════════════════════════════════════════════════════');
    
    const [datos, yaEnFlujo] = await Promise.all([
        cargarDatosSheets(),
        cargarYaEnFlujo()
    ]);
    
    const indices = construirIndicesContacto(datos);
    
    const stats = {
        totalClientes: datos.clientes.length,
        sinTelefono: 0,
        liquidados: 0,
        contactoReciente: 0,
        yaEnFlujo: 0,
        fantasmas: 0,
        porCategoria: {
            ACTIVO: 0,
            TIBIO: 0,
            FRIO: 0
        }
    };
    
    const fantasmas = [];
    const desglose = {
        contactoPorPago: 0,
        contactoPorConvenio: 0,
        contactoPorPromesa: 0
    };
    
    let montoTotalActivo = 0;
    let montoTotalTibio = 0;
    let montoTotalFrio = 0;
    
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
        } else if (eval_.fantasma) {
            stats.fantasmas++;
            stats.porCategoria[eval_.categoria]++;
            
            if (eval_.categoria === 'ACTIVO') montoTotalActivo += eval_.saldo;
            else if (eval_.categoria === 'TIBIO') montoTotalTibio += eval_.saldo;
            else montoTotalFrio += eval_.saldo;
            
            fantasmas.push(eval_);
        }
    });
    
    // Ordenamiento principal: ACTIVO > TIBIO > FRIO, dentro de cada uno por saldo desc
    const ordenCategoria = { ACTIVO: 1, TIBIO: 2, FRIO: 3 };
    fantasmas.sort((a, b) => {
        const diffCat = ordenCategoria[a.categoria] - ordenCategoria[b.categoria];
        if (diffCat !== 0) return diffCat;
        return b.saldo - a.saldo;
    });
    
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
    console.log(`  Excluidos ya en flujo:            ${stats.yaEnFlujo}`);
    console.log(`  ─────────────────────────────────────`);
    console.log(`  FANTASMAS DETECTADOS:             ${stats.fantasmas}`);
    console.log(`    ACTIVOS  (>50% pagado):         ${stats.porCategoria.ACTIVO} ($${montoTotalActivo.toLocaleString()})`);
    console.log(`    TIBIOS   (1-50% pagado):        ${stats.porCategoria.TIBIO} ($${montoTotalTibio.toLocaleString()})`);
    console.log(`    FRIOS    (0% pagado):           ${stats.porCategoria.FRIO} ($${montoTotalFrio.toLocaleString()})`);
    console.log(`  Tiempo: ${tiempo}s`);
    console.log('═══════════════════════════════════════════════════════');
    
    return {
        stats,
        desglose,
        montosPorCategoria: {
            ACTIVO: montoTotalActivo,
            TIBIO: montoTotalTibio,
            FRIO: montoTotalFrio
        },
        fantasmas,
        config: {
            diasSinContacto: DIAS_SIN_CONTACTO,
            saldoMinimo: SALDO_MINIMO,
            incluirLiquidados: INCLUIR_LIQUIDADOS,
            umbralActivo: UMBRAL_ACTIVO,
            umbralTibio: UMBRAL_TIBIO
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
            const top = resultado.fantasmas.slice(0, 30);
            console.log('\n=== TOP 30 FANTASMAS (priorizados ACTIVO > TIBIO > FRIO) ===');
            top.forEach((f, i) => {
                const ult = f.ultimoContacto.dias !== null 
                    ? `${f.ultimoContacto.dias}d (${f.ultimoContacto.tipo})`
                    : f.ultimoContacto.tipo;
                console.log(`${(i+1).toString().padStart(3)}. [${f.categoria}] ${f.telefono} | $${f.saldo.toString().padStart(8)} | pag ${f.porcentajeAvance}% | ${f.diasAtraso}d atraso | ult: ${ult.padEnd(20)} | ${f.cliente.substring(0, 30)}`);
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
