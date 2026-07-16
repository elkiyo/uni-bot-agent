import Link from "next/link";
import { Header } from "../components/Header";
import {
  USDT,
  WETH,
  POOL,
  FEE_TIER,
  POSITION_MANAGER,
  SWAP_ROUTER02,
  UNILAB_PAYMENT_WALLET,
} from "@/lib/addresses";

const toc = [
  { id: "que-es", label: "Qué es UniAgent" },
  { id: "roles", label: "Los 3 roles" },
  { id: "ciclo-de-vida", label: "Ciclo de vida de un vault" },
  { id: "contratos", label: "Los contratos" },
  { id: "decision", label: "Cómo decide el agente" },
  { id: "pagos", label: "Pagos: x402 y uni-lab.xyz" },
  { id: "seguridad", label: "Seguridad y guardrails" },
  { id: "direcciones", label: "Direcciones de referencia" },
  { id: "glosario", label: "Glosario" },
];

export default function Docs() {
  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <span className="eyebrow">Documentación</span>
        <h1
          className="mt-5 max-w-2xl text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Cómo funciona UniAgent, de punta a punta
        </h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Todo el protocolo explicado desde cero: los roles, el ciclo de vida de un vault,
          cada contrato y sus funciones, cómo decide el agente, y cómo se paga todo. Para el
          detalle numérico de las reglas de rebalanceo, con ejemplos, ver{" "}
          <Link href="/recursos" className="text-accent underline-offset-4 hover:underline">
            Recursos
          </Link>
          .
        </p>

        <div className="mt-12 grid gap-10 lg:grid-cols-[200px_1fr]">
          {/* TOC */}
          <nav className="hidden lg:block">
            <div className="sticky top-32 flex flex-col gap-1 border-l border-hairline pl-4">
              {toc.map((t) => (
                <a
                  key={t.id}
                  href={`#${t.id}`}
                  className="py-1 text-xs text-muted transition-colors hover:text-accent"
                >
                  {t.label}
                </a>
              ))}
            </div>
          </nav>

          <div className="flex flex-col gap-20 overflow-hidden">
            {/* Qué es */}
            <Section id="que-es" eyebrow="01" title="Qué es UniAgent">
              <p>
                UniAgent es una plataforma no-custodial de vaults de liquidez concentrada
                para Uniswap V3, corriendo en Celo mainnet. Cualquiera puede crear su propio
                vault, depositar <strong className="text-white/85">USDT</strong> — un solo
                token, sin necesidad de tener WETH de antemano —, y un agente automatizado
                (el <em>keeper</em>) arma y rebalancea la posición por vos, dentro de los
                límites que vos mismo configurás.
              </p>
              <p>
                La garantía central del diseño: el agente puede operar la posición
                (rebalancear, sumar liquidez), pero <strong className="text-white/85">nunca
                puede retirar capital a otro destino que no seas vos</strong>. Cada función
                que mueve fondos hacia afuera del vault está codeada para pagar siempre al{" "}
                <code>owner</code> — no hay ningún parámetro que lo redirija.
              </p>
              <p>
                Construido para el <em>Agentic Payments &amp; DeFAI Hackathon</em> de Celo —
                Track 1 (volumen generado) y Track 2 (pagos x402) — pero operando con fondos
                reales, no una demo: cada vault mintea una posición real en un pool público
                de Uniswap V3 con liquidez de terceros.
              </p>
            </Section>

            {/* Los 3 roles */}
            <Section id="roles" eyebrow="02" title="Los 3 roles">
              <p>
                Tres actores distintos, cada uno con permisos acotados a lo que le
                corresponde — nadie tiene más poder del que necesita.
              </p>

              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <RoleCard
                  title="Plataforma"
                  subtitle="PlatformConfig.sol · dueño del equipo"
                  points={[
                    "Fija el precio por rebalanceo (rebalanceFee)",
                    "Fija el operador por defecto de vaults nuevos",
                    "Fija el tope de depósito por vault, mientras no esté auditado",
                  ]}
                />
                <RoleCard
                  title="Owner (LP)"
                  subtitle="Cualquier wallet · vos"
                  points={[
                    "Crea el vault y deposita USDT",
                    "Define el rango, tope de rebalanceos y periodicidad",
                    "Es el único destino posible de cualquier retiro",
                    "Puede pausar, revocar al operador, o forzar un retiro de emergencia",
                  ]}
                  accent
                />
                <RoleCard
                  title="Operador (keeper)"
                  subtitle="Wallet de la plataforma · el agente"
                  points={[
                    "Arma la posición inicial y cada rebalanceo",
                    "Nunca puede ser destino de un retiro de principal",
                    "Cobra el rebalanceFee, fijado por la plataforma, tope de uso fijado por el owner",
                  ]}
                />
              </div>

              <div className="mt-6 rounded-2xl border border-hairline bg-white/[0.02] p-5">
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
                  Por qué se puede confiar en esto
                </p>
                <ul className="mt-3 flex flex-col gap-2 text-sm text-muted">
                  <li>
                    <code>withdraw()</code>/<code>withdrawAll()</code> transfieren siempre a{" "}
                    <code>owner</code> — dirección fija en el contrato, nunca un parámetro.
                  </li>
                  <li>
                    <code>initPosition()</code>/<code>rebalance()</code> solo el operador
                    puede llamarlas, pero el NFT de la posición y los fondos siempre quedan
                    dentro del vault — el operador nunca es <code>recipient</code>.
                  </li>
                  <li>
                    Cualquier rango que proponga el operador se valida on-chain contra el
                    precio de mercado (<code>maxRangeDeviationBps</code>) — no puede inventar
                    un rango arbitrario.
                  </li>
                  <li>
                    El owner puede revocar al operador (<code>setOperator(0x0)</code>) o
                    forzar el cierre de la posición (<code>emergencyWithdrawPosition()</code>
                    ) en cualquier momento, sin depender de que el operador coopere.
                  </li>
                </ul>
              </div>
            </Section>

            {/* Ciclo de vida */}
            <Section id="ciclo-de-vida" eyebrow="03" title="Ciclo de vida de un vault">
              <p>Desde que se crea hasta que se retira todo, en orden:</p>

              <FlowDiagram
                steps={[
                  { who: "Owner", what: "createVault()", detail: "clona RangeVault vía el factory" },
                  { who: "Owner", what: "configureTarget()", detail: "rango, tope de rebalanceos, periodicidad" },
                  { who: "Owner", what: "deposit()", detail: "USDT únicamente" },
                  { who: "Agente", what: "initPosition()", detail: "swapea lo necesario y mintea la posición" },
                ]}
              />

              <div className="my-6 rounded-2xl border border-accent/30 bg-accent/[0.04] p-5">
                <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
                  Ciclo continuo, cada ~5 minutos
                </p>
                <p className="mt-2 text-sm text-muted">
                  El keeper chequea cada vault. Si corresponde, cierra la posición vieja,
                  consulta a uni-lab.xyz (vía x402), swapea, y mintea una posición nueva —
                  ver{" "}
                  <a href="#decision" className="text-accent underline-offset-4 hover:underline">
                    cómo decide el agente
                  </a>{" "}
                  más abajo.
                </p>
              </div>

              <FlowDiagram
                steps={[
                  { who: "Owner", what: "withdraw() / withdrawAll()", detail: "en cualquier momento, parcial o total" },
                  { who: "Owner", what: "closeVault()", detail: "opcional, una vez vacío — desactiva el vault para siempre" },
                ]}
              />
            </Section>

            {/* Contratos */}
            <Section id="contratos" eyebrow="04" title="Los contratos">
              <p>
                Tres contratos, cada uno con una responsabilidad acotada. Uno configura,
                uno fabrica, uno sostiene los fondos — así se ve la relación entre los tres:
              </p>

              <ArchitectureDiagram />

              <ContractBlock
                name="PlatformConfig.sol"
                desc="Configuración central que todos los vaults leen en vivo, no al crearse — un cambio de fee aplica al instante a todos."
                rows={[
                  ["rebalanceFee", "Precio (USDT) que cobra el operador por cada rebalanceo exitoso."],
                  ["feeToken", "USDT — el token en que se paga rebalanceFee y se mide maxDepositUsd."],
                  ["defaultOperator", "Operador que se asigna a cada vault nuevo por defecto."],
                  ["maxDepositUsd", "Tope global de depósito por vault, mientras el contrato no esté auditado."],
                ]}
              />

              <ContractBlock
                name="VaultFactory.sol"
                desc="Deploya vaults nuevos como clones mínimos (EIP-1167) del RangeVault — mucho más barato en gas que desplegar el contrato completo cada vez."
                rows={[
                  ["createVault(pool, token0, token1, fee)", "Clona RangeVault e inicializa el vault para msg.sender."],
                  ["getVaultsByOwner(address)", "Lista los vaults de una wallet."],
                  ["allVaults(i) / vaultCount()", "Enumeración global, usada para stats de la plataforma."],
                ]}
              />

              <ContractBlock
                name="RangeVault.sol"
                desc="Un vault = una posición en un pool. Sostiene los fondos, el NFT de la posición, y aplica todos los guardrails."
              >
                <p className="mt-4 text-sm font-medium text-white/80">A dónde va cada peso</p>
                <p className="mt-1 text-sm text-muted">
                  El único flujo de salida de principal posible es hacia el owner. El
                  operador solo puede cobrar su fee fijo por rebalanceo — nunca el capital.
                </p>
                <FundFlowDiagram />

                <p className="mt-6 text-sm font-medium text-white/80">Ledgers internos</p>
                <p className="mt-1 text-sm text-muted">
                  Todo llega como USDT, pero se reparte en dos ledgers separados que ninguna
                  función puede mezclar: <code>investableUsdt</code> (capital sin invertir
                  todavía) y <code>reserveBalance</code> (reserva para reinyectar en
                  rebalanceos futuros).
                </p>

                <p className="mt-5 text-sm font-medium text-white/80">Funciones del owner</p>
                <FunctionTable
                  rows={[
                    ["deposit(reserve, investable)", "Deposita USDT, lo reparte entre los dos ledgers."],
                    ["configureTarget(...)", "Rango objetivo, tope de rebalanceos, reinyección, periodicidad."],
                    ["setRiskParams(...)", "Slippage máximo, cooldown mínimo, tolerancia de desviación de rango."],
                    ["increasePosition(swapIx, usdtAmount, ...)", "Suma capital a la posición abierta al instante, sin esperar al próximo rebalanceo."],
                    ["withdraw(positionShareBps, fundsShareBps)", "Retiro parcial — posición y fondos idle, de forma independiente."],
                    ["withdrawAll()", "Cierra la posición (si hay) y devuelve todo."],
                    ["setOperator(address)", "Cambia o revoca (0x0) al operador — kill switch."],
                    ["pause() / unpause()", "Bloquea initPosition()/rebalance() sin tocar los fondos."],
                    ["emergencyWithdrawPosition()", "Fuerza el cierre de la posición, sin depender del operador."],
                    ["closeVault()", "Desactiva el vault para siempre — requiere que ya esté vacío."],
                  ]}
                />

                <p className="mt-5 text-sm font-medium text-white/80">Funciones del operador (agente)</p>
                <FunctionTable
                  rows={[
                    ["initPosition(swapIx, ...)", "Arma la posición inicial según el rango que configuró el owner."],
                    ["rebalance(newTickLower, newTickUpper, swapIx, ...)", "Cierra la posición vigente y arma una nueva."],
                    ["reinjectIntoPosition(swapIx, amount, ...)", "Suma reserva a la posición abierta, sin cerrarla."],
                    ["sweepIdleDust(swapIx, ...)", "Swap correctivo sobre lo que haya quedado suelto, y lo suma a la posición."],
                  ]}
                />

                <p className="mt-5 text-sm font-medium text-white/80">Eventos principales</p>
                <p className="mt-1 text-sm leading-relaxed text-muted">
                  <code>PositionInitialized</code>, <code>Rebalanced</code>,{" "}
                  <code>LpFeesPaidToOwner</code>, <code>Withdrawn</code>,{" "}
                  <code>PositionIncreased</code>, <code>ReinjectedIntoPosition</code>,{" "}
                  <code>IdleDustSwept</code> — la{" "}
                  <Link href="/vaults" className="text-accent underline-offset-4 hover:underline">
                    página de cada vault
                  </Link>{" "}
                  reconstruye su historial completo leyendo directo estos eventos, sin backend.
                </p>
              </ContractBlock>
            </Section>

            {/* Cómo decide el agente */}
            <Section id="decision" eyebrow="05" title="Cómo decide el agente">
              <p>
                Cada ~5 minutos, para cada vault, el keeper corre la misma secuencia — sin
                discreción humana:
              </p>
              <ol className="mt-4 flex flex-col gap-2 text-sm text-muted">
                <li>
                  <strong className="text-white/80">1.</strong> ¿Quedan rebalanceos?{" "}
                  <code>rebalanceCount &lt; maxRebalances</code>
                </li>
                <li>
                  <strong className="text-white/80">2.</strong> ¿Pasó el cooldown mínimo desde
                  el último rebalanceo?
                </li>
                <li>
                  <strong className="text-white/80">3.</strong> ¿Toca el rebalanceo periódico,
                  aunque el precio siga en rango?
                </li>
                <li>
                  <strong className="text-white/80">4.</strong> ¿El precio rompió el rango de
                  la posición — por arriba o por abajo?
                </li>
              </ol>
              <p className="mt-4">
                Cada caso arma un rango nuevo con una lógica distinta (el periódico mantiene
                el piso y recentra el techo; romper el piso arma un rango 5% por debajo del
                precio; romper el techo reconstruye desde cero, 100% en stablecoin). La guía
                completa, con la matemática y ejemplos numéricos ciclo por ciclo, está en{" "}
                <Link href="/recursos" className="text-accent underline-offset-4 hover:underline">
                  Recursos
                </Link>
                .
              </p>
            </Section>

            {/* Pagos */}
            <Section id="pagos" eyebrow="06" title="Pagos: x402 y uni-lab.xyz">
              <p>
                Para saber cómo recentrar el techo de un rango en cada rebalanceo, el keeper
                consulta a{" "}
                <a
                  href="https://uni-lab-xyz.vercel.app/api-docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent underline-offset-4 hover:underline"
                >
                  uni-lab.xyz
                </a>
                , una API de cálculo pay-per-query. El pago se hace vía{" "}
                <strong className="text-white/85">x402</strong> — el protocolo HTTP 402
                &quot;Payment Required&quot;, resuelto con una autorización EIP-3009 firmada
                (gasless), liquidada en USDC por el facilitator de Celo (
                <code>api.x402.celo.org</code>).
              </p>
              <p>
                Un detalle estructural importante: el vault, al ser un contrato inteligente,{" "}
                <strong className="text-white/85">no puede firmar una autorización EIP-712</strong>{" "}
                (no tiene clave privada). Por eso el pago sale siempre de la wallet propia del{" "}
                <strong className="text-white/85">operador</strong> (en USDC), nunca del
                vault — el vault nunca necesitó tener USDC ni pagar nada directamente.
              </p>

              <FlowDiagram
                steps={[
                  { who: "Keeper", what: "arma la consulta", detail: "A1, B1, C1, D1, E1 — ver Recursos" },
                  { who: "Keeper", what: "paga vía x402", detail: "USDC del operador, autorización EIP-3009" },
                  { who: "Facilitator", what: "liquida on-chain", detail: "api.x402.celo.org, gas propio" },
                  { who: "uni-lab.xyz", what: "responde", detail: "el nuevo techo del rango (C1)" },
                ]}
              />
            </Section>

            {/* Seguridad */}
            <Section id="seguridad" eyebrow="07" title="Seguridad y guardrails">
              <div className="grid gap-4 sm:grid-cols-2">
                <GuardCard
                  title="Rango validado contra el mercado"
                  desc="_checkRangeNearMarket exige que el precio actual caiga dentro de [tickLower, tickUpper] (con un margen configurable) — no un centro derivado, sino los límites reales que calcula uni-lab."
                />
                <GuardCard
                  title="Cooldown + tope duro"
                  desc="minRebalanceInterval evita thrashing; maxRebalances es un techo de gasto en fees que el owner fija una sola vez, para toda la vida del vault."
                />
                <GuardCard
                  title="Chequeo de gas antes de actuar"
                  desc="El keeper estima el gas real de cada transacción y no la manda si el operador no tiene con qué pagarla — evita perder un pago a uni-lab en una tx que iba a fallar."
                />
                <GuardCard
                  title="Barrido de capital suelto"
                  desc="Tras cada mint, el contrato reintenta sumar cualquier sobrante a la posición. Si queda un sobrante de un solo token, el keeper detecta el capital ocioso en cada ciclo y dispara sweepIdleDust() con un swap correctivo real."
                />
              </div>
            </Section>

            {/* Direcciones */}
            <Section id="direcciones" eyebrow="08" title="Direcciones de referencia">
              <AddrTable
                rows={[
                  ["Pool (USDT/WETH)", POOL, `Fee tier ${FEE_TIER / 10_000}%`],
                  ["USDT (token0)", USDT, "6 decimales"],
                  ["WETH (token1)", WETH, "18 decimales"],
                  ["NonfungiblePositionManager", POSITION_MANAGER, "Uniswap V3 oficial en Celo"],
                  ["SwapRouter02", SWAP_ROUTER02, "Uniswap V3 oficial en Celo"],
                  ["Wallet de pago de uni-lab.xyz", UNILAB_PAYMENT_WALLET, "Recibe el settlement x402"],
                ]}
              />
              <p className="mt-4 text-sm text-muted">
                Los contratos propios (PlatformConfig, VaultFactory, RangeVault) y su
                historial de redeploys están documentados en detalle en{" "}
                <code className="text-xs">PLAN.md</code> del repositorio — todos verificados
                en Celoscan, código fuente público.
              </p>
            </Section>

            {/* Glosario */}
            <Section id="glosario" eyebrow="09" title="Glosario">
              <dl className="grid gap-4 sm:grid-cols-2">
                {[
                  ["Tick", "Unidad de precio de Uniswap V3. En este pool, un tick MÁS ALTO significa un precio de ETH MÁS BAJO (token1/token0 invertido)."],
                  ["Liquidez concentrada", "En vez de proveer liquidez en todo el rango de precios posibles, se concentra en un rango específico — más eficiente, pero deja de cobrar fees si el precio sale de ese rango."],
                  ["Rebalanceo", "Cerrar la posición actual y abrir una nueva con un rango distinto, siguiendo al precio."],
                  ["Rebalanceo periódico", "Un rebalanceo forzado por tiempo, no por precio — genera actividad real aunque el precio siga en rango."],
                  ["Dust / capital suelto", "Token0 o token1 que quedó sin invertir en la posición tras un swap imperfecto."],
                  ["EIP-1167 (clone)", "Patrón de proxy mínimo — cada vault nuevo es una copia barata en gas del mismo contrato base."],
                  ["x402", "Protocolo de pago HTTP 402, resuelto con una autorización EIP-3009 firmada, sin gas para quien paga."],
                  ["Non-custodial", "El operador nunca puede retirar el principal — solo el owner puede."],
                ].map(([term, def]) => (
                  <div key={term} className="rounded-xl border border-hairline bg-white/[0.02] p-4">
                    <dt className="text-sm font-semibold text-white/85">{term}</dt>
                    <dd className="mt-1.5 text-xs leading-relaxed text-muted">{def}</dd>
                  </div>
                ))}
              </dl>
            </Section>

            <div className="flex flex-wrap gap-3 border-t border-hairline pt-10">
              <Link href="/create" className="btn-primary !px-6 !py-3">
                Crear vault
              </Link>
              <Link href="/recursos" className="btn-secondary !px-6 !py-3">
                Ver reglas de rebalanceo con ejemplos
              </Link>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28">
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">{eyebrow}</span>
      <h2
        className="mt-2 text-2xl font-semibold tracking-tight sm:text-[28px]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        {title}
      </h2>
      <div className="mt-4 flex flex-col gap-4 text-[15px] leading-relaxed text-muted [&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-white/80">
        {children}
      </div>
    </section>
  );
}

function RoleCard({
  title,
  subtitle,
  points,
  accent,
}: {
  title: string;
  subtitle: string;
  points: string[];
  accent?: boolean;
}) {
  return (
    <div className={accent ? "glass rounded-2xl border-accent/35 bg-accent/[0.06] p-5" : "glass rounded-2xl p-5"}>
      <h3 className="text-base font-semibold text-white/90">{title}</h3>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.12em] text-faint">{subtitle}</p>
      <ul className="mt-3 flex flex-col gap-1.5 text-xs leading-relaxed text-muted">
        {points.map((p) => (
          <li key={p}>· {p}</li>
        ))}
      </ul>
    </div>
  );
}

function FlowDiagram({ steps }: { steps: { who: string; what: string; detail: string }[] }) {
  return (
    <div className="my-6 flex flex-col gap-0 overflow-x-auto sm:flex-row sm:items-stretch sm:gap-0">
      {steps.map((s, i) => (
        <div key={s.what} className="flex flex-1 items-center sm:flex-row">
          <div className="glass w-full shrink-0 rounded-2xl p-4 sm:min-w-[180px]">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">{s.who}</span>
            <p className="mt-1.5 font-mono text-xs text-white/90">{s.what}</p>
            <p className="mt-1 text-[11px] leading-snug text-muted">{s.detail}</p>
          </div>
          {i < steps.length - 1 && (
            <span className="mx-2 my-2 shrink-0 text-lg text-faint sm:mx-3 sm:my-0" aria-hidden>
              <span className="hidden sm:inline">→</span>
              <span className="sm:hidden">↓</span>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function ArchitectureDiagram() {
  return (
    <div className="my-6 overflow-x-auto">
      <div className="flex min-w-[560px] flex-col items-center gap-0">
        <DiagramBox
          label="Plataforma"
          name="PlatformConfig.sol"
          detail="rebalanceFee · defaultOperator · maxDepositUsd"
        />
        <Connector label="configura, en vivo, a" />
        <DiagramBox
          label="Fábrica"
          name="VaultFactory.sol"
          detail="createVault() → clona (EIP-1167)"
        />
        <Connector label="deploya N instancias de" />
        <div className="flex w-full items-start justify-center gap-3">
          {["Vault de Ana", "Vault de Bruno", "Vault de Cami"].map((v, i) => (
            <div
              key={v}
              className={
                "glass flex-1 rounded-2xl p-3 text-center " + (i === 1 ? "border-accent/35 bg-accent/[0.05]" : "")
              }
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">RangeVault.sol</p>
              <p className="mt-1 text-xs font-medium text-white/85">{v}</p>
              <p className="mt-1 text-[10px] text-muted">1 vault = 1 posición</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function DiagramBox({ label, name, detail }: { label: string; name: string; detail: string }) {
  return (
    <div className="glass w-full max-w-sm rounded-2xl p-4 text-center">
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent">{label}</span>
      <p className="mt-1 font-mono text-sm text-white/90">{name}</p>
      <p className="mt-1 text-[11px] text-muted">{detail}</p>
    </div>
  );
}

function Connector({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center py-1.5 text-faint">
      <span className="h-4 w-px bg-hairline" aria-hidden />
      <span className="my-0.5 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.1em]">{label}</span>
      <span className="h-4 w-px bg-hairline" aria-hidden />
      <span aria-hidden>↓</span>
    </div>
  );
}

function FundFlowDiagram() {
  return (
    <div className="my-5 overflow-x-auto">
      <div className="grid min-w-[640px] grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2">
        {/* Row 1: Owner -> Vault */}
        <FlowNode label="Owner" detail="deposita USDT" />
        <Arrow text="deposit()" />
        <FlowNode label="RangeVault" detail="investableUsdt + reserveBalance" highlight />
        <Arrow text="swap + mint" />
        <FlowNode label="Posición Uniswap V3" detail="NFT queda en el vault" />

        {/* Row 2: return paths */}
        <FlowNode label="Owner" detail="único destino de withdraw()" />
        <Arrow text="withdraw()" reverse />
        <FlowNode label="RangeVault" detail="fees LP + principal" highlight />
        <Arrow text="collect()" reverse />
        <FlowNode label="Posición Uniswap V3" detail="fees acumuladas" />

        {/* Row 3: operator fee, off to the side */}
        <div />
        <div />
        <FlowNode label="Operador" detail="cobra solo rebalanceFee" small />
        <Arrow text="fee fijo" small />
        <FlowNode label="RangeVault" detail="nunca el principal" highlight small />
      </div>
    </div>
  );
}

function FlowNode({
  label,
  detail,
  highlight,
  small,
}: {
  label: string;
  detail: string;
  highlight?: boolean;
  small?: boolean;
}) {
  return (
    <div
      className={
        (highlight ? "border-accent/35 bg-accent/[0.05] " : "") +
        "glass rounded-xl p-3 text-center " +
        (small ? "opacity-80" : "")
      }
    >
      <p className="text-xs font-medium text-white/85">{label}</p>
      <p className="mt-0.5 text-[10px] leading-snug text-muted">{detail}</p>
    </div>
  );
}

function Arrow({ text, reverse, small }: { text: string; reverse?: boolean; small?: boolean }) {
  return (
    <div className={"flex flex-col items-center " + (small ? "opacity-80" : "")}>
      <span className="text-base text-faint" aria-hidden>
        {reverse ? "←" : "→"}
      </span>
      <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.08em] text-faint">{text}</span>
    </div>
  );
}

function ContractBlock({
  name,
  desc,
  rows,
  children,
}: {
  name: string;
  desc: string;
  rows?: [string, string][];
  children?: React.ReactNode;
}) {
  return (
    <div className="glass mt-6 rounded-2xl p-5 sm:p-6">
      <h3 className="font-mono text-sm text-accent">{name}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{desc}</p>
      {rows && <FunctionTable rows={rows} />}
      {children}
    </div>
  );
}

function FunctionTable({ rows }: { rows: [string, string][] }) {
  return (
    <div className="mt-3 flex flex-col gap-2">
      {rows.map(([fn, desc]) => (
        <div key={fn} className="grid gap-1 sm:grid-cols-[minmax(0,280px)_1fr] sm:gap-4">
          <code className="break-all font-mono text-[12px] text-white/80">{fn}</code>
          <p className="text-xs leading-relaxed text-muted">{desc}</p>
        </div>
      ))}
    </div>
  );
}

function GuardCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="glass rounded-2xl p-5">
      <h3 className="text-sm font-semibold text-white/90">{title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-muted">{desc}</p>
    </div>
  );
}

function AddrTable({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="mt-4 flex flex-col divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline">
      {rows.map(([label, address, note]) => (
        <div key={label} className="grid gap-1 bg-white/[0.01] p-4 sm:grid-cols-[160px_1fr_auto] sm:items-center sm:gap-4">
          <span className="text-xs font-medium text-white/80">{label}</span>
          <a
            href={`https://celoscan.io/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all font-mono text-xs text-muted underline-offset-4 hover:text-accent hover:underline"
          >
            {address} ↗
          </a>
          <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-faint">{note}</span>
        </div>
      ))}
    </div>
  );
}
