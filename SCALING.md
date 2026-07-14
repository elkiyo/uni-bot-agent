# Escalado — estado actual y roadmap

Qué está en producción hoy, qué es el eslabón débil, y en qué orden escalar. Ver
`PLAN.md` para el diseño de base.

## Estado actual (hackathon)

| Pieza | Dónde corre | Estado |
|---|---|---|
| Contratos (`PlatformConfig`, `VaultFactory`, `RangeVault`) | Celo mainnet | ✅ Inmutables, no requieren infra |
| Frontend | Vercel (`uni-bot-agent-gules.vercel.app`) | ✅ Serverless, escala solo |
| Keeper (`agent/`) | **Mac del operador** | ⚠️ Punto único de falla |
| Estado del keeper (`agent/data/store.json`) | Disco local | ⚠️ Las api_keys de uni-lab no son recuperables si se pierde |
| uni-lab.xyz API | Vercel (infra propia, aparte) | ✅ |

## El orden correcto para escalar

### 1. Keeper resiliente (ahora)
- **Local (puente):** `agent/deploy/xyz.unilab.uni-bot-agent.plist` — servicio
  launchd que arranca el keeper al bootear la Mac y lo reinicia si crashea:
  ```bash
  cp agent/deploy/xyz.unilab.uni-bot-agent.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/xyz.unilab.uni-bot-agent.plist
  ```
  **⚠️ Gotcha real, ya lo pisamos:** si el repo vive bajo `~/Desktop` (como
  ahora), el proceso lanzado por `launchd` revienta con
  `EPERM: operation not permitted` al leer `node_modules/tsx/...` — macOS
  protege Desktop/Documents/Downloads con TCC, y un proceso arrancado por
  `launchd` (a diferencia de uno interactivo desde Terminal, que ya heredó el
  permiso de Terminal.app) no tiene ese acceso por defecto. Dos soluciones
  reales, no probamos ninguna todavía:
  1. **Mover el proyecto fuera de Desktop** (ej. `~/dev/DEFAI`) — la forma más
     simple, esas carpetas no están protegidas por TCC.
  2. **Dar Full Disk Access** a `/usr/local/bin/node` (o al binario que
     invoque `launchd`) en System Settings → Privacy & Security → Full Disk
     Access — requiere click manual del usuario, no se puede automatizar.
  Mientras tanto, el keeper sigue corriendo como proceso de Bash manual
  (`npm run start &` en `agent/`) — funciona, pero no sobrevive un reinicio o
  que se cierre la sesión de Terminal.
- **VPS (siguiente):** `agent/Dockerfile` ya está listo — `docker build` + un
  volumen en `/app/data` + las env vars de `agent/.env.example`. Cualquier VPS
  chico alcanza (el keeper es I/O-bound: lecturas RPC cada 5 min). Este camino
  además evita el problema de TCC de arriba por completo.
- Respaldar `agent/data/store.json` (contiene las api_keys de uni-lab, que se
  muestran una sola vez; se pueden regenerar vía `/regenerate-api-key` pero es
  fricción operativa).

### 2. Estado durable (cuando haya >5-10 vaults)
- Migrar `store.json` a Postgres/SQLite gestionado (el `Store` ya es una clase
  con interfaz chica — cambiar la implementación no toca el resto del keeper).
- El escaneo de eventos puede reconstruirse desde chain en cualquier momento;
  lo único irrecuperable son las api_keys → eso es lo que importa persistir.

### 3. Observabilidad (antes de promocionar públicamente)
- `logger.ts` ya emite JSON por línea — apuntarlo a un colector (Axiom/Grafana
  Cloud tienen tiers gratis) y alertar sobre `level: error` recurrente.
- Alerta de saldo: si el CELO del operador baja de ~0.5, avisar (sin gas, el
  keeper queda ciego operativamente aunque siga corriendo).
- El leaderboard de Dune del hackathon + `agent-stats` de uni-lab ya dan
  métricas de negocio gratis.

### 4. Límites de la plataforma (a medida que entra plata real)
- `maxDepositUsd` (hoy 1,000 USDT/vault) es el freno de mano mientras el
  contrato no esté auditado — **no subirlo por demanda; subirlo después de
  auditar**. Es ajustable en vivo desde el panel admin.
- El fee de plataforma también es ajustable en vivo; recordar que aplica a
  todos los vaults existentes al instante (trade-off documentado en PLAN.md).

### 5. Multi-pool y multi-chain (post-hackathon)
- `VaultFactory.createVault(pool, token0, token1, fee)` ya acepta cualquier
  pool — la restricción a USDT/WETH es solo del frontend (un selector de pool
  y validación `factory.getPool` la levanta).
- Ojo: `RangeVault` asume token0 = stablecoin de 6 decimales para su
  contabilidad interna — generalizar eso ANTES de abrir otros pares.
- El keeper ya es multi-vault por diseño; multi-pool solo requiere que
  `monitor.ts`/`rebalancer.ts` lean el pool del vault en vez de la constante.

### 6. Redundancia del keeper (cuando el revenue lo justifique)
- Dos keepers con la misma clave compiten por nonce — no duplicar sin más.
- Camino correcto: un keeper primario + un watchdog que alerte si
  `lastRebalanceTimestamp` de algún vault se atrasa demasiado; failover manual
  o con lock distribuido.
- Alternativa on-chain: permitir a los owners setear su propio operador de
  respaldo (ya soportado: `setOperator`).

## Qué NO hacer
- No subir `maxDepositUsd` sin auditoría del contrato.
- No correr dos keepers con la misma wallet a la vez.
- No perder `agent/data/` sin respaldo (api_keys).
- No commitear jamás `agent/.env` (clave del operador).
