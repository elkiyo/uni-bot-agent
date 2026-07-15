# Cómo decide el agente cuándo rebalancear

Guía de referencia para explicarle a alguien cómo usar la plataforma — qué hace cada campo
al crear un vault, en qué orden decide el agente, y los 3 casos posibles con ejemplos
numéricos reales. También publicada como página en la app: `/recursos`.

## 1. Los 6 campos que configurás

Los que pedís al crear el vault, en el mismo orden en que aparecen en el formulario — cada
uno controla una cosa distinta, no hay valores por defecto.

| Campo | Qué controla | Ejemplo |
|---|---|---|
| Monto de inversión | El capital (USDT) con el que el agente arma la posición inicial. | 100 USDT |
| Precio mínimo | El piso del rango — no tiene que ser simétrico con el máximo. | $1720.32 |
| Precio máximo | El techo del rango. | $2102.61 |
| Tope de rebalanceos | Tu techo de gasto en fees — cuántos rebalanceos como máximo en toda la vida del vault. En `0`, el agente nunca actúa, ni por reloj ni por precio. | 10 |
| Tope de reinyección por ciclo | Máximo que el agente puede mover de la reserva por rebalanceo. En `0`, nunca reinyecta. | 10 USDT |
| Rebalanceo periódico | Cada cuántas horas se fuerza un rebalanceo aunque el precio siga en rango. En `0`, desactivado. | 24 horas |

Un séptimo valor, `minRebalanceInterval` (el cooldown piso — el tiempo mínimo entre dos
rebalanceos consecutivos, sin importar el disparador), no se tipea: el formulario de
creación lo deja fijo en `0` (sin piso) automáticamente, hardcodeado en `create/page.tsx`
al llamar `setRiskParams(500n, 0n, halfWidthTicks)`. Ni "Crear vault" ni "Reconfigurar
agente" lo exponen — hoy no hay forma de ponerle un cooldown real a un vault desde la
interfaz. Sigue siendo relevante para la decisión del agente (paso 2 de la sección
siguiente), simplemente no es algo que elijas vos.

## 2. El orden de decisión

Cada tick (cada 5 minutos), para cada vault, el agente corre esta secuencia — el orden
importa: el reloj periódico y la salida de rango son disparadores **independientes**, no
uno depende del otro.

1. **¿Hay posición y quedan rebalanceos disponibles?** `rebalanceCount < maxRebalances`.
   Si no → se detiene acá, no hace nada este tick.
2. **¿Pasó el cooldown mínimo desde el último rebalanceo?** `ahora ≥ últimoRebalanceo + minRebalanceInterval`.
   Si no → se detiene acá, aunque esté fuera de rango.
3. **¿Ya toca el rebalanceo periódico?** `ahora ≥ últimoRebalanceo + periodicRebalanceInterval`.
   Si sí → rebalancea por reloj (Caso 1) y termina acá.
4. **¿El precio actual sigue dentro del rango de la posición?** Compara el tick actual del
   pool contra los ticks de la posición abierta. Si rompió el piso → Caso 2. Si rompió el
   techo → Caso 3.

## 3. Los tres casos, con ejemplo

Mutuamente excluyentes — en un tick dado, el vault cae en uno solo de los tres.

### Caso periódico — en rango, toca el reloj

El precio sigue perfecto dentro del rango, pero ya pasó el intervalo periódico
configurado — el agente rearma la posición igual, para generar actividad real constante
(no solo reactiva). El piso del rango (`D1`) se mantiene exactamente donde estaba; solo el
techo se recentra al precio actual.

> D1 = $1710 (piso, sin cambios) + precio actual = $1800 → nueva posición [$1710 – $1800]

### Fuera de rango, abajo — rompió el piso

El precio cayó por debajo del piso de la posición — dejó de cobrar fees. El agente cierra,
consulta a uni-lab.xyz el nuevo split, y arma una posición nueva con un piso fresco 5% por
debajo del precio actual.

> posición vieja [$1710 – $1770] + precio cae a $1700 → D1 = $1700 × 0.95 = $1615

### Fuera de rango, arriba — rompió el techo

El precio subió por encima del techo — la posición ya quedó ~100% en stablecoin. Esto es
intencional: el diseño del rango deja cero margen arriba a propósito, para capturar la
ganancia apenas el precio sube. No consulta a uni-lab (no hay split que calcular con todo
en un solo token) — arma una posición nueva de cero, local.

> techo viejo = $1800, roto + precio actual = $1810 → [$1810 × 0.95, $1810 × 1.03] = [$1720 – $1864]

## 4. La vida de un vault, ciclo por ciclo

Una simulación con precio real moviéndose — mismo vault, distintos casos disparándose uno
tras otro. El piso (`D1`) solo cambia en un Caso 2 o 3; en el Caso periódico queda intacto.

| Evento | Precio | D1 (piso) | C1 (techo) | Ancho |
|---|---|---|---|---|
| Init | $1800.00 | $1710.00 | $1854.00 | 7.77% |
| Periódico | $1800.00 | $1710.00 → | $1854.00 → $1800.00 | 5.00% |
| Techo | $1808.00 | $1710.00 → $1717.60 | $1800.00 → $1862.24 | 7.77% |
| Periódico | $1830.00 | $1717.60 → | $1862.24 → $1830.00 | 6.14% |
| Techo | $1850.00 | $1717.60 → $1757.50 | $1830.00 → $1905.50 | 7.77% |
| Piso | $1770.00 | $1778.40 → $1681.50 | $1928.16 → $1770.00 | 5.00% |
| Periódico | $1735.00 | $1681.50 → | $1770.00 → $1735.00 | 3.08% |

## 5. El error más común

**Confirmado en producción — dos vaults reales quedaron así.**

- **Síntoma:** el vault muestra "Fuera de rango" en el panel, pero pasan los ticks y nunca rebalancea.
- **Causa real:** `maxRebalances = 0`. El paso 1 de la sección 2 se detiene ahí siempre —
  el agente ni siquiera llega a mirar el precio. No importa qué tan fuera de rango esté, ni
  cuánto falte para el reloj periódico.
- **Cómo pasa:** al desactivar "reinyección" y "periódico" poniendo `0` en esos campos, es
  fácil poner `0` por error en "tope de rebalanceos" también — son campos vecinos en el
  mismo formulario, pero significan cosas completamente distintas.
- **Arreglo:** "Reconfigurar agente" → subir el tope de rebalanceos por encima de 0. El
  agente lo agarra en el próximo tick, sin esperar el reloj periódico.

---

Fuente: `frontend/lib/keeper/monitor.ts` + `frontend/lib/keeper/rebalancer.ts`.
