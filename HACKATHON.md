# Agentic Payments & DeFAI Hackathon — guía y checklist

Fuente: https://celoplatform.notion.site/Agentic-Payments-DeFAI-Hackathon-364d5cb803de800c9502d8a384716324
(extraído directo de la API interna de Notion el 2026-07-14, porque la página no renderiza vía fetch normal — ver nota al final sobre cómo se hizo).

## Próximos pasos inmediatos (pendiente, en orden)

1. **Registrar en celobuilders.xyz** (`npx skills add https://celobuilders.xyz`) — obtiene el Attribution Tag real. Es el bloqueante de todo lo demás: sin esto, ninguna transacción del keeper cuenta para el leaderboard de Track 1, sin importar cuánto volumen genere el vault.
2. Cargar el tag obtenido como `ATTRIBUTION_TAG` en Vercel (env var del proyecto `uni-lab/uni-bot-agent`) — el código ya lo usa automáticamente en cuanto tenga valor (`frontend/lib/keeper/attribution.ts`), no requiere otro deploy.
3. Registrar el agente en ERC-8004 vía 8004scan.io.
4. Grabar demo (mostrar: crear vault → depósito → el agente arma la posición → rebalanceo real con swap → panel admin cobrando fees) — explicar explícitamente el rebalanceo periódico forzado como gestión activa real (no actividad artificial), dado que es justo lo que la revisión manual anti-sybil de los jueces va a mirar.
5. Post en X etiquetando @CeloDevs y @Celo con el link del registro ERC-8004.
6. Submission final vía Celo Builders Skill (`Help me submit my project to the Celo Agentic Payments & DEFAI Hackathon`).

**Nota clave de la conversación:** el tag no está atado a un vault ni a una wallet — se agrega al calldata de *cada* transacción que manda el keeper operador, sin importar de qué vault sea. Esto significa que la actividad de **todos** los vaults de la plataforma suma al mismo total del leaderboard — cuantos más usuarios depositen, más alto sube el volumen tageado, sin necesidad de "gamear" nada.

## ⚠️ Contradicción real encontrada en la página — resolver antes de dar nada por sentado

- **Sección "🗓️ Timeline" (la fuente más explícita):** Kick-off 7 jul → **Submission Deadline: 3 de agosto, 9am GMT** → Ganadores anunciados 6 de agosto.
- **Sección "Cómo participar" (más abajo, contradice lo anterior):** *"The rest of your submission (description, demo, X post, 8004 ID) can wait until July 20, 09:00 GMT. Your tag can't."*

No se puede resolver la ambigüedad solo leyendo la página — probablemente es texto viejo de una versión anterior que no se actualizó al extender el plazo. **Confirmar en el Telegram del hackathon antes de asumir cualquiera de las dos fechas como definitiva.** Mientras tanto, tratar el **20 de julio como el objetivo real** (el escenario más conservador) y el 3 de agosto como margen extra si se confirma.

## Qué gana plata (prize pool total: $5,000 en $CELO)

| Track | Premio | Condición de victoria |
|---|---|---|
| **1. Most Revenue Generated** (la nuestra) | $3,000 ($2000 / $1000) | El agente que genera **más volumen on-chain en Celo** durante el hackathon (7 jul – 3 ago), medido por transacciones con el Attribution Tag propio |
| 2. Most x402 Payments | $1,000 ($700 / $300) | Más pagos x402 liquidados en Celo durante el período — no aplica a este proyecto |
| 3. Askbots | $500 (bounties) | Rating más alto en askbots.ai — no aplica |
| 4. Best Feedback for Aigora | $500 (bounties) | Top 10 feedbacks en aigora.org — no aplica |

## Track 1 — lo que hay que entregar, textual

> - Win condition: the agent that generates the most on-chain volume on Celo during the hackathon (Jul 7–Aug 3).
> - How to submit/get tracked: integrate Attribution Tags (you will get the code when registering for the hackathon) so your agent's transactions are tagged on-chain, and submit a link to your agent's on-chain wallet address / tagged transactions.
> - Ideas: build any revenue-generating agent, like a DeFi product or an FX trading agent.

`uni-bot-agent` encaja exactamente en esta descripción — "DeFi product" con volumen real y verificable.

## Cómo registrarse (día 1, no al final — ver más abajo por qué)

1. `npx skills add https://celobuilders.xyz`
2. Pedirle al skill que te registre: solo necesita **nombre del proyecto, repo público de GitHub, y handle de Telegram**.
3. Devuelve el **Attribution Tag** (ERC-8021, formato `celo_...`) al instante.
4. Cada transacción del agente debe llevar ese tag — ya implementado en `agent/src/attribution.ts` / `frontend/lib/keeper/attribution.ts` vía `@celo/attribution-tags` (`toDataSuffix([PROJECT_CODE, tag])`), solo falta que `ATTRIBUTION_TAG` tenga un valor real en vez de estar vacío.

**Cita textual de por qué registrar temprano importa:**
> "Why register on day one: For the first track, Most Revenue Generated, the leaderboard only counts transactions that carry your tag. Register first, add the tag to every transaction, and watch your numbers climb on the live leaderboard."

## Cómo entregar (al final, con el tag ya puesto)

1. `npx skills add https://celobuilders.xyz` (si no está ya instalado)
2. Pedirle al agente: *"Help me submit my project to the Celo Agentic Payments & DEFAI Hackathon"*
3. El flujo pide:
   - Elegir el hackathon
   - Conectar con la plataforma de submission
   - Responder preguntas sobre el proyecto
   - Publicar un post en X (o quote-tweet del anuncio oficial) etiquetando **@CeloDevs** y **@Celo**, mencionando qué se construyó, con el link del registro ERC-8004. Ejemplo dado por la página:
     > I am building for the @CeloDevs Agent Hackathon 🟡
     > Working on: [agent name + one-line description]
     > Registered onchain → [ERC-8004 link]
     > Let's go! @celo
   - Revisar el borrador
   - Publicar solo cuando esté todo bien

## FAQ (respuestas reales de la página)

**¿Cómo se eligen los ganadores?**
> The winner will be selected according to the focus of each track considering a combination of project's alignment with the ecosystem mission, delivery of consistent transactions and onchain activity, and real-world utility. Our incredible judges will conduct an additional manual review to ensure fair judgment and identify any attempts at sybil attacks.

→ Esto confirma lo que ya está documentado en `PLAN.md` sección "Riesgos": el rebalanceo periódico forzado es defendible (mismo patrón que Gamma/Arrakis) pero va a pasar por revisión manual anti-sybil — el ciclo de reinyección (movimiento de capital real, fees reales pagados) es justamente lo que le da sustancia económica genuina y hay que dejarlo explícito en la demo.

**¿Qué son los Attribution Tags?**
> Attribution Codes are built on ERC-8021 and shipped as a free, open-source SDK (@celo/attribution-tags on npm), added with one line of code. It doesn't change what a transaction does, it just tags it as coming from your project so it's visible on a public dashboard.

**¿Hay que usar un framework de agente específico?**
> You can use any agent framework.

## Checklist contra lo que ya construimos

| Requisito | Estado |
|---|---|
| Agente que genera volumen on-chain real en Celo | ✅ Vault no-custodial + keeper operando en producción (Vercel + GitHub Actions), rebalanceos reales confirmados |
| Repo público de GitHub | ✅ `github.com/elkiyo/uni-bot-agent` |
| Código de Attribution Tags integrado | ✅ `@celo/attribution-tags`, `toDataSuffix()` en cada tx del keeper — falta solo el valor real de `ATTRIBUTION_TAG` |
| **Registro en celobuilders.xyz (obtener el tag)** | ❌ **Pendiente — es el paso más urgente, cada día sin esto es volumen que no cuenta para el leaderboard** |
| Lógica económica real, no wash-trading aparente | ✅ Documentado explícitamente en `PLAN.md` (ciclo de reinyección alternada, mismo patrón que gestores reales) |
| Registro ERC-8004 (8004scan.io) | ❌ Pendiente |
| Demo grabado | ❌ Pendiente |
| Post en X con @CeloDevs @Celo + link ERC-8004 | ❌ Pendiente |
| Submission final vía Celo Builders Skill | ❌ Pendiente |

## Recomendación

El registro (paso 1, obtener el tag) es independiente de la submission final (paso 2) — se puede hacer **ya mismo** sin comprometerse a nada más, y cada rebalanceo real que ocurra después de tener el tag empieza a contar para el leaderboard de Track 1. Dado que el proyecto ya está operando en producción con transacciones reales, no tiene sentido seguir esperando al final para registrar — la única razón para demorarlo (que era "no exponer el proyecto antes de tiempo") ya no aplica tanto como al principio, dado que el código ya es público en GitHub.

## Nota técnica: cómo se extrajo esta página

El fetch normal (`WebFetch`) no renderiza esta página de Notion — devuelve el shell vacío de la SPA. Se extrajo el contenido real pegándole directo a la API interna de Notion:
1. `POST https://celoplatform.notion.site/api/v3/loadPageChunk` con el UUID de la página (sacado del HTML crudo) para el árbol de bloques de primer nivel.
2. Los bloques `toggle` (FAQ, detalles por track, ideas) no vienen expandidos en esa respuesta — hubo que juntar los IDs de bloques hijos faltantes y pedirlos aparte vía `POST .../api/v3/getRecordValues`.
3. Recorrido recursivo del árbol de bloques (`content` → hijos) reconstruyendo el texto desde `properties.title`.
