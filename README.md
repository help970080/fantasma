# LeGaXi Seguimiento de Fantasmas - Bloque 2

## Que hace este servicio

Detecta clientes "fantasma": los que tienen saldo pendiente pero **no han tenido
contacto humano real** en los ultimos N dias (default: 10).

**Es solo lectura.** No envia mensajes ni llamadas. Solo retorna la lista para
que tu panel decida que hacer en bloques siguientes.

## Senales de contacto que reconoce

- Pago registrado en Google Sheets
- Convenio activo creado/actualizado
- Promesa marcada como cumplida
- **Llamada IVR con DTMF presionado** (NO buzon, NO sin respuesta)
- Visita marcada por gestor en campo

Especificamente para llamadas IVR, cuenta como contacto solo si el resultado es:
`promesa_pago`, `pago`, `ya_pago`, `asesor`, `transferencia`. Cualquier otro
resultado (incluido `contactado` generico) se IGNORA porque tu sistema actual
marca buzones de voz como contactados (falsos positivos).

## Como probarlo en local primero (recomendado)

```bash
cd seguimiento-fantasmas
npm install
cp .env.example .env
# Editar .env con tus credenciales reales de PostgreSQL
node detector.js
```

Esto ejecuta SOLO el detector y te muestra:
- Estadisticas de filtrado
- Top 20 fantasmas por saldo

## Como deployar en Render

1. Crear nuevo repositorio en GitHub con estos archivos
2. En Render: New → Web Service → conectar el repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. En Environment Variables, agregar:
   - `DATABASE_URL` (la misma de tus otros servicios)
   - `GOOGLE_SCRIPT_URL` (la del deployment v2.3 actual)
   - `DIAS_SIN_CONTACTO` = 10
   - `SALDO_MINIMO` = 1
   - `INCLUIR_LIQUIDADOS` = false

Una vez deployado, prueba: `https://tu-servicio.onrender.com/api/detectar`

## Endpoints

- `GET /` - Info del servicio
- `GET /health` - Health check
- `GET /api/detectar` - Ejecuta deteccion completa, retorna JSON con fantasmas

## Limitaciones conocidas (por resolver en bloques siguientes)

1. **No lee LlamadasIVR de Google Sheets**. El GAS actual no expone esa hoja
   en `fullSync`. Para usarla, hay que agregar endpoint `getLlamadasIVR` al GAS.
   Por ahora, las llamadas no cuentan como senal de contacto.

2. **No lee Tracking de Google Sheets**. Mismo caso que arriba. Las visitas
   de gestores no cuentan como senal de contacto.

3. Estas 2 limitaciones hacen el detector **mas conservador** (puede marcar
   como fantasma a alguien que SI fue contactado por llamada o visita reciente).
   Es seguro pero genera mas falsos fantasmas. Para resolverlo, ampliamos el
   GAS en el siguiente bloque si quieres.

## Output esperado

Al ejecutar `node detector.js` deberias ver algo como:

```
═══════════════════════════════════════════════════════
DETECTOR DE FANTASMAS - LeGaXi
Configuracion: 10 dias, saldo>=1, liquidados=false
═══════════════════════════════════════════════════════
[Detector] Cargando datos de Google Sheets...
[Detector] Cargados: 523 clientes, 1247 pagos, 45 convenios, 89 promesas
[Detector] Cargando clientes ya en flujo de PostgreSQL...
[Detector] 0 clientes ya en flujo
───────────────────────────────────────────────────────
RESULTADOS:
  Total clientes en cartera:        523
  Excluidos sin telefono:           12
  Excluidos liquidados:             187
  Excluidos contacto reciente:      198
    - por pago:                     145
    - por convenio:                 23
    - por promesa cumplida:         18
    - por llamada real (DTMF):      0
    - por visita gestor:            0
  Excluidos ya en flujo:            0
  ─────────────────────────────────────
  FANTASMAS DETECTADOS:             126
  Tiempo: 4.32s
═══════════════════════════════════════════════════════

═══ TOP 20 FANTASMAS POR SALDO ═══
  1. 5527167697 | $    15000 | 45d atraso | ult: 23d (pago)         | ABEL OLIVER TORRES
  2. ...
```
