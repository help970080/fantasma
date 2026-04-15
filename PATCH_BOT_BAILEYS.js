// ═══════════════════════════════════════════════════════════════════════════
// PATCH PARA bot-9wrn (chatbot Baileys de LeGaXi)
// 
// Agrega un endpoint POST /api/enviar-individual que permite a otros
// servicios (como fantasma-rpgh) enviar mensajes via tu bot Baileys.
//
// COMO INSTALAR:
// 1. Abre tu repo de bot-9wrn en GitHub
// 2. Encuentra tu archivo principal (probablemente server.js o index.js)
// 3. Pega este bloque ANTES de la linea "app.listen(PORT, ...)"
// 4. Asegurate de que la variable que tiene tu instancia de Baileys se llame
//    'sock' o 'whatsappService'. Si se llama distinto, cambia la referencia.
// 5. Agrega variable de entorno BOT_API_TOKEN en Render con un string secreto
//    Ejemplo: BOT_API_TOKEN=legaxi_2026_secreto_xyz
// 6. Commit + push, Render redeploya solo
//
// COMO PROBAR:
// curl -X POST https://bot-9wrn.onrender.com/api/enviar-individual \
//   -H "Content-Type: application/json" \
//   -H "Authorization: Bearer TU_TOKEN" \
//   -d '{"telefono":"525512345678","mensaje":"Hola desde API"}'
// ═══════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────
// Health check del bot (para que fantasma-rpgh sepa si esta conectado)
// ───────────────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
    // Asume que tienes una variable global 'sock' con la conexion Baileys
    // Si tu variable se llama distinto, ajustala aqui
    let conectado = false;
    try {
        if (typeof sock !== 'undefined' && sock && sock.user) {
            conectado = true;
        }
    } catch(e) {}
    
    res.json({
        ok: true,
        conectado: conectado,
        timestamp: new Date().toISOString()
    });
});

// ───────────────────────────────────────────────────────────────────────────
// Endpoint principal: enviar mensaje individual via Baileys
// Autenticado con Bearer token (variable BOT_API_TOKEN)
// ───────────────────────────────────────────────────────────────────────────
app.post('/api/enviar-individual', express.json(), async (req, res) => {
    try {
        // 1. Validar token
        const tokenEsperado = process.env.BOT_API_TOKEN;
        if (!tokenEsperado) {
            return res.status(500).json({ 
                success: false, 
                error: 'BOT_API_TOKEN no configurado en variables de entorno' 
            });
        }
        
        const authHeader = req.headers.authorization || '';
        const tokenRecibido = authHeader.replace(/^Bearer\s+/i, '').trim();
        
        if (tokenRecibido !== tokenEsperado) {
            return res.status(401).json({ 
                success: false, 
                error: 'Token invalido' 
            });
        }
        
        // 2. Validar parametros
        const { telefono, mensaje } = req.body;
        
        if (!telefono || !mensaje) {
            return res.status(400).json({ 
                success: false, 
                error: 'telefono y mensaje son requeridos' 
            });
        }
        
        // 3. Verificar que Baileys este conectado
        if (typeof sock === 'undefined' || !sock || !sock.user) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp no conectado. Escanea el QR primero.' 
            });
        }
        
        // 4. Normalizar telefono (asegurar formato 52XXXXXXXXXX)
        let tel = String(telefono).replace(/\D/g, '');
        if (tel.length === 10) tel = '52' + tel;
        if (!tel.startsWith('52')) tel = '52' + tel.slice(-10);
        
        const jid = tel + '@s.whatsapp.net';
        
        // 5. Enviar mensaje via Baileys
        console.log(`[API] Enviando a ${jid}: ${mensaje.substring(0, 50)}...`);
        
        const result = await sock.sendMessage(jid, { text: mensaje });
        
        // 6. Respuesta exitosa
        res.json({
            success: true,
            message: 'Mensaje enviado',
            jid: jid,
            telefono: tel,
            messageId: result?.key?.id || null,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('[API] Error en /api/enviar-individual:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// ───────────────────────────────────────────────────────────────────────────
// Endpoint opcional: enviar imagen + caption (para futuro)
// ───────────────────────────────────────────────────────────────────────────
app.post('/api/enviar-imagen', express.json(), async (req, res) => {
    try {
        const tokenEsperado = process.env.BOT_API_TOKEN;
        const authHeader = req.headers.authorization || '';
        const tokenRecibido = authHeader.replace(/^Bearer\s+/i, '').trim();
        
        if (!tokenEsperado || tokenRecibido !== tokenEsperado) {
            return res.status(401).json({ success: false, error: 'Token invalido' });
        }
        
        const { telefono, imagenUrl, caption } = req.body;
        
        if (!telefono || !imagenUrl) {
            return res.status(400).json({ 
                success: false, 
                error: 'telefono e imagenUrl son requeridos' 
            });
        }
        
        if (typeof sock === 'undefined' || !sock || !sock.user) {
            return res.status(503).json({ 
                success: false, 
                error: 'WhatsApp no conectado' 
            });
        }
        
        let tel = String(telefono).replace(/\D/g, '');
        if (tel.length === 10) tel = '52' + tel;
        if (!tel.startsWith('52')) tel = '52' + tel.slice(-10);
        
        const jid = tel + '@s.whatsapp.net';
        
        const result = await sock.sendMessage(jid, { 
            image: { url: imagenUrl },
            caption: caption || ''
        });
        
        res.json({
            success: true,
            message: 'Imagen enviada',
            jid: jid,
            messageId: result?.key?.id || null
        });
        
    } catch (error) {
        console.error('[API] Error en /api/enviar-imagen:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// FIN DEL PATCH
// 
// IMPORTANTE: Si tu app.listen() ya existe, NO lo dupliques. Solo asegurate
// de pegar este patch ANTES de esa linea.
// ═══════════════════════════════════════════════════════════════════════════
