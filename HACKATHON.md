# Agentic Payments & DeFAI Hackathon — guía y checklist

Fuente: https://celoplatform.notion.site/Agentic-Payments-DeFAI-Hackathon-364d5cb803de800c9502d8a384716324
(extraído directo de la API interna de Notion el 2026-07-14, porque la página no renderiza vía fetch normal — ver nota al final sobre cómo se hizo).

## ✅ Registrado (2026-07-14)

- **Attribution Tag real: `celo_e38cdd3210a6`** — obtenido de `PUT https://celobuilders.xyz/submissions/me` (proyecto `uni-bot-agent`, track `most-revenue-generated`, repo `github.com/elkiyo/uni-bot-agent`). Ya cargado como `ATTRIBUTION_TAG` en Vercel y redeployado — desde ahora, toda transacción real del keeper suma al leaderboard.
- **`projectName` renombrado a "UniAgent" (2026-07-15)** — el nombre del repo (`uni-bot-agent`) y por lo tanto el attribution tag no cambian (el tag queda fijo al primer `githubUrl` guardado, no al `projectName`). Se evaluaron varias opciones antes de elegir esta — se descartó cualquier nombre con "Uniswap" completo por riesgo de marca (ej. "UniswapRebalancerVault"), y se buscó algo corto que conecte con el tema "agentic" del hackathon.
- **Deadline confirmado, sin ambigüedad:** la API real de submission (no la página de marketing de Notion) dice `submissionDeadline: 2026-08-03T09:00:00.000Z` — **3 de agosto, 9am GMT**. La frase suelta que mencionaba 20 de julio era efectivamente texto viejo desactualizado (ver sección de abajo, dejada como registro histórico).
- Slug real del hackathon: `agentic-payments-defai` (no `celo-onchain-agents`, que es un hackathon distinto y ya cerrado — el skill genérico usa ese como ejemplo).

## Re-verificado (2026-07-16)

Repetí la extracción vía API interna de Notion contra la misma página. Cambios encontrados: ninguno relevante.
- **Timeline sin contradicción esta vez:** ambas secciones de la página ("🗓️ Timeline" y "📝 How to Participate") dicen ahora **August 3rd, 9am GMT** para todo — incluido el texto que antes decía 20 de julio para el tag. Coincide con `submissionDeadline: 2026-08-03T09:00:00.000Z` de la API de `celobuilders.xyz`. Kick-off 7 jul, ganadores anunciados **6 de agosto**.
- Único detalle nuevo notado en el texto: *"If you are applying for the x402 track, add your agent/payTo wallet to your submission"* — ya cumplido (`agentWalletAddress` cargado 2026-07-15, ver arriba).
- No pude releer el contenido expandido de los toggles (detalle por track, FAQ) — `getRecordValues` de la API de Notion devolvió `MemcachedCrossCellError` (500) de forma consistente, en varios reintentos; parece un problema transitorio del lado de Notion, no algo corregible desde acá. El contenido de esos toggles ya extraído el 2026-07-14 (más abajo en este archivo) sigue siendo la referencia.

## Próximos pasos inmediatos (pendiente, en orden)

1. ~~Registrar en celobuilders.xyz~~ ✅ hecho.
2. ~~Cargar el tag en Vercel~~ ✅ hecho.
3. ~~Agregar `agentWalletAddress` a la submission~~ ✅ hecho (2026-07-15) — `0xAe3921825fEC520cADa98EB0790BC91a61d4286b`, la wallet del operador. También se sumó el track `most-x402-payments` a `trackIds`. Ver sección "Track 2 — x402" más abajo, dejó de ser "no aplica".
4. Registrar el agente en ERC-8004 vía 8004scan.io (campo `erc8004Url`, requerido para publicar).
5. Integrar x402 (uni-lab.xyz lado servidor + keeper de uni-bot-agent lado cliente) — ver sección de abajo.
6. Grabar demo (mostrar: crear vault → depósito → el agente arma la posición → rebalanceo real con swap → panel admin cobrando fees) — explicar explícitamente el rebalanceo periódico forzado como gestión activa real (no actividad artificial), dado que es justo lo que la revisión manual anti-sybil de los jueces va a mirar.
7. Post en X etiquetando @CeloDevs y @Celo con el link del registro ERC-8004 → va en el campo `socialLink` de la submission.
8. Publicar (`POST /submissions/me/publish`) — se puede actualizar hasta el cierre del hackathon, no hay que apurarlo.

**Reconexión con celobuilders.xyz:** el flujo de login (Google OAuth + código corto) se puede rehacer en cualquier momento vía `POST /auth/google/start` + `POST /auth/google/claim` (ver `.agents/skills/celo-builders/SKILL.md`) — el `apiKey`/bearer que devuelve `claim` es un secreto de sesión, no se guarda en este repo ni en ningún archivo versionado.

**Nota clave de la conversación:** el tag no está atado a un vault ni a una wallet — se agrega al calldata de *cada* transacción que manda el keeper operador, sin importar de qué vault sea. Esto significa que la actividad de **todos** los vaults de la plataforma suma al mismo total del leaderboard — cuantos más usuarios depositen, más alto sube el volumen tageado, sin necesidad de "gamear" nada.

## ⚠️ Contradicción hallada en la página de Notion (ya resuelta, dejado como registro)

- **Sección "🗓️ Timeline" de la página de Notion:** Kick-off 7 jul → **Submission Deadline: 3 de agosto, 9am GMT** → Ganadores anunciados 6 de agosto.
- **Sección "Cómo participar" (más abajo, contradecía lo anterior):** *"The rest of your submission (description, demo, X post, 8004 ID) can wait until July 20, 09:00 GMT. Your tag can't."*

**Resuelto:** la API real de `celobuilders.xyz` (la plataforma de submission en sí, no la página de marketing) confirma `2026-08-03T09:00:00.000Z` sin ambigüedad — era texto viejo en Notion.

## Qué gana plata (prize pool total: $5,000 en $CELO)

| Track | Premio | Condición de victoria |
|---|---|---|
| **1. Most Revenue Generated** (la nuestra) | $3,000 ($2000 / $1000) | El agente que genera **más volumen on-chain en Celo** durante el hackathon (7 jul – 3 ago), medido por transacciones con el Attribution Tag propio |
| **2. Most x402 Payments** (sumada 2026-07-15) | $1,000 ($700 / $300) | Más pagos x402 liquidados en Celo durante el período (conteo crudo de settlements exitosos) |
| 3. Askbots | $500 (bounties) | Rating más alto en askbots.ai — no aplica |
| 4. Best Feedback for Aigora | $500 (bounties) | Top 10 feedbacks en aigora.org — no aplica |

## Track 2 — Most x402 Payments (por qué dejó de ser "no aplica")

Se descartó al principio porque uni-bot-agent no usa el protocolo x402 en ningún lado — le paga a uni-lab.xyz con una transferencia ERC20 directa, no con el flujo HTTP 402 + `X-PAYMENT`. Retomado el 2026-07-15 después de ver en el dashboard de Dune que la query de **Track 1** también trae columnas `x402_volume_usd`/`x402_settlements` por código — evidencia de que x402 aporta al menos al panorama general, y de que dos proyectos competidores (`spagero763/bureau`, `oojae/remitroute`) ya construyeron soporte x402 real.

**Hallazgo clave, textual del `SKILL.md` de celo-builders instalado** (`.agents/skills/celo-builders/SKILL.md`):

> "x402 facilitator settlements are attributed to that wallet [`agentWalletAddress`], and the leaderboard shows them as soon as it is on file (attribution is retroactive across the whole hackathon window, but the leaderboard reads zero until the wallet is added)."

Es decir: la atribución de x402 **no es por el data suffix de calldata** (ERC-8021) que usamos para transacciones normales — no podríamos inyectarlo de todas formas, porque el `transferWithAuthorization` (EIP-3009) de la settlement lo manda el *facilitator*, no nuestro keeper. Es por **wallet registrada en la submission**, y es retroactiva a toda la ventana del hackathon. Confirmado también contra `/hackathons/agentic-payments-defai/submission-fields`: el campo `agentWalletAddress` dice explícitamente *"used for on-chain tracking of x402 payments and revenue volume"*.

**Plan de integración (dos repos):**
1. **`uni-lab.xyz`** (repo separado, `/Users/elkiyo.eth/Desktop/uni-lab.xyz`, también del usuario) — agregar soporte x402 del lado servidor a las rutas pagas (`/v1/rc-rlp-rebalance`, `/v1/pool-setup-initial`) **además de**, no en reemplazo de, el flujo actual de `tx_hash` on-chain (esas rutas ya sirven a otros agentes registrados, no solo a nosotros — no romper el flujo existente). Con `@x402/express` + `x402ResourceServer`, siguiendo el patrón de `bureau/src/x402.ts`.
2. **`uni-bot-agent`** (este repo) — el keeper (`frontend/lib/keeper/unilab.ts`) paga vía `wrapFetchWithPayment` (de `@x402/fetch` o `thirdweb/x402`) usando la wallet del operador, en vez de (o adicional a) `payUniLabFee()` on-chain.

### ✅ Funcionando de punta a punta (2026-07-15)

Confirmado con un pago real: `tx_hash` `0x7b41fa69e0a153d8d26490447ed83151af17e193e2ae0dcc7ce7239baf2b2d67` — `transferWithAuthorization` (EIP-3009, selector `0xe3ee160e`) en el contrato USDC de Celo (`0xcebA9300f2b948710d2653dD7B07f33A8B32118C`), broadcasteado por el facilitator (`0x0d74D5Cefd2e7F24E623330ebE3d8D4cB45fFB48`, paga su propio gas), transfiere 0.20 USDC de la wallet del operador (`0xAe3921825fEC520cADa98EB0790BC91a61d4286b`) a la wallet de pago de uni-lab (`0x4B53D27c81f9E842D50a1940E27B8009B64c615B`). `status: 1`. El keeper de producción recibió la respuesta del cálculo real (`200`, no `402`).

Tres bugs reales encontrados y corregidos en el camino, en orden:
1. **Payer binding:** el flujo `tx_hash` exige que el pago venga de la wallet `agent_wallet` registrada (anti-replay de un tx_hash público de otro agente) — x402 no lo necesita (la autorización EIP-712 está firmada específicamente para esa request), y de hecho x402 nunca podría cumplirlo: lo paga la wallet del operador, no la wallet de cada vault individual. Se dejó sin ese requisito para x402.
2. **Falta el desafío `402` inicial:** el gate solo entraba al camino x402 si `X-PAYMENT` ya venía en el request — pero el protocolo funciona al revés (el cliente prueba primero sin pagar, necesita que el servidor le conteste `402` con los requisitos). Se cambió la rama a decidirse por si `tx_hash` está presente o no, no por si `X-PAYMENT` está presente.
3. **Facilitator sin API key:** `api.x402.celo.org` exige su propio API key para liquidar pagos (registro en `x402.celo.org`, iniciando sesión con la wallet de pago de uni-lab, créditos prepago para el gas que el facilitator adelanta) — sin eso, el `/settle` devolvía 401 "Missing X-API-Key". Cargado como `X402_FACILITATOR_API_KEY` en Vercel.
3. Referencia de patrón client/server: repos clonados en `/tmp/competitor-check/{bureau,remitroute}` (públicos, ya en GitHub).

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
| Agente que genera volumen on-chain real en Celo | ✅ Vault no-custodial + keeper operando en producción (Vercel + GitHub Actions + cron-job.org), rebalanceos reales confirmados |
| Repo público de GitHub | ✅ `github.com/elkiyo/uni-bot-agent` |
| Código de Attribution Tags integrado | ✅ `@celo/attribution-tags`, `toDataSuffix()` en cada tx del keeper |
| **Registro en celobuilders.xyz (obtener el tag)** | ✅ Hecho — `celo_e38cdd3210a6`, cargado en Vercel |
| Lógica económica real, no wash-trading aparente | ✅ Documentado explícitamente en `PLAN.md` (ciclo de reinyección alternada, mismo patrón que gestores reales) |
| Registro ERC-8004 (8004scan.io) | ❌ Pendiente |
| `agentWalletAddress` en la submission | ✅ Hecho (2026-07-15) — `0xAe3921825fEC520cADa98EB0790BC91a61d4286b` |
| Soporte x402 (uni-lab.xyz servidor + keeper cliente) | ✅ Hecho (2026-07-15) — pago real confirmado on-chain, ver sección "Track 2" arriba |
| Demo grabado | ❌ Pendiente |
| Post en X con @CeloDevs @Celo + link ERC-8004 | ❌ Pendiente |
| Submission final (publicar) vía Celo Builders Skill | ❌ Pendiente — se puede dejar para el final, se puede editar hasta el cierre |

## Recomendación

El registro (paso 1, obtener el tag) es independiente de la submission final (paso 2) — se puede hacer **ya mismo** sin comprometerse a nada más, y cada rebalanceo real que ocurra después de tener el tag empieza a contar para el leaderboard de Track 1. Dado que el proyecto ya está operando en producción con transacciones reales, no tiene sentido seguir esperando al final para registrar — la única razón para demorarlo (que era "no exponer el proyecto antes de tiempo") ya no aplica tanto como al principio, dado que el código ya es público en GitHub.

## Nota técnica: cómo se extrajo esta página

El fetch normal (`WebFetch`) no renderiza esta página de Notion — devuelve el shell vacío de la SPA. Se extrajo el contenido real pegándole directo a la API interna de Notion:
1. `POST https://celoplatform.notion.site/api/v3/loadPageChunk` con el UUID de la página (sacado del HTML crudo) para el árbol de bloques de primer nivel.
2. Los bloques `toggle` (FAQ, detalles por track, ideas) no vienen expandidos en esa respuesta — hubo que juntar los IDs de bloques hijos faltantes y pedirlos aparte vía `POST .../api/v3/getRecordValues`.
3. Recorrido recursivo del árbol de bloques (`content` → hijos) reconstruyendo el texto desde `properties.title`.
