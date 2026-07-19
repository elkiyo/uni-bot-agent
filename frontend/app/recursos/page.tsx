import { Header } from "../components/Header";

const fields = [
  {
    name: "Monto de inversión",
    what: "El capital (USDT) con el que el agente arma la posición inicial.",
    example: "100 USDT",
  },
  {
    name: "Precio mínimo",
    what: "El piso del rango — no tiene que ser simétrico con el máximo.",
    example: "$1720.32",
  },
  {
    name: "Precio máximo",
    what: "El techo del rango.",
    example: "$2102.61",
  },
  {
    name: "Tope de rebalanceos",
    what: (
      <>
        Tu techo de gasto en fees — cuántos rebalanceos como máximo en toda la vida del vault. En{" "}
        <code>0</code>, el agente nunca actúa, ni por reloj ni por precio.
      </>
    ),
    example: "10",
  },
  {
    name: "Tope de reinyección por ciclo",
    what: (
      <>
        Máximo que el agente puede mover de la reserva por rebalanceo. En <code>0</code>, nunca reinyecta.
      </>
    ),
    example: "10 USDT",
  },
  {
    name: "Rebalanceo periódico",
    what: (
      <>
        Cada cuántas horas se fuerza un rebalanceo aunque el precio siga en rango. En <code>0</code>,
        desactivado.
      </>
    ),
    example: "24 horas",
  },
];

const steps = [
  {
    title: "¿Hay posición y quedan rebalanceos disponibles?",
    body: (
      <code className="font-mono text-[13px]">rebalanceCount &lt; maxRebalances</code>
    ),
    result: { kind: "no" as const, text: "Si no → se detiene acá, no hace nada este tick." },
  },
  {
    title: "¿Pasó el cooldown mínimo desde el último rebalanceo?",
    body: (
      <code className="font-mono text-[13px]">ahora ≥ últimoRebalanceo + minRebalanceInterval</code>
    ),
    result: { kind: "no" as const, text: "Si no → se detiene acá, aunque esté fuera de rango." },
  },
  {
    title: "¿Ya toca el rebalanceo periódico?",
    body: (
      <code className="font-mono text-[13px]">ahora ≥ últimoRebalanceo + periodicRebalanceInterval</code>
    ),
    result: { kind: "yes" as const, text: "Si sí → rebalancea por reloj (Caso 1) y termina acá." },
  },
  {
    title: "¿El precio actual sigue dentro del rango de la posición?",
    body: "Compara el tick actual del pool contra los ticks de la posición abierta.",
    result: { kind: "yes" as const, text: "Si rompió el piso → Caso 2. Si rompió el techo → Caso 3." },
  },
];

const cases = [
  {
    color: "sky",
    name: "En rango, toca el reloj",
    trigger: "Caso periódico",
    desc: "El precio sigue perfecto dentro del rango, pero ya pasó el intervalo periódico configurado — el agente rearma la posición igual, para generar actividad real constante (no solo reactiva). El piso del rango (D1) se mantiene exactamente donde estaba; solo el techo se recentra al precio actual.",
    example: "D1 = $1710 (piso, sin cambios) + precio actual = $1800 → nueva posición [$1710 – $1800]",
  },
  {
    color: "negative",
    name: "Rompió el piso",
    trigger: "Fuera de rango, abajo",
    desc: "El precio cayó por debajo del piso de la posición — dejó de cobrar fees. El agente cierra, consulta a uni-lab.xyz el nuevo split, y arma una posición nueva con un piso fresco 5% por debajo del precio actual.",
    example: "posición vieja [$1710 – $1770] + precio cae a $1700 → D1 = $1700 × 0.95 = $1615",
  },
  {
    color: "accent",
    name: "Rompió el techo",
    trigger: "Fuera de rango, arriba",
    desc: "El precio subió por encima del techo — la posición ya quedó ~100% en stablecoin. Esto es intencional: el diseño del rango deja cero margen arriba a propósito, para capturar la ganancia apenas el precio sube. No consulta a uni-lab (no hay split que calcular con todo en un solo token) — arma una posición nueva de cero, local.",
    example: "techo viejo = $1800, roto + precio actual = $1810 → [$1810 × 0.95, $1810 × 1.03] = [$1720 – $1864]",
  },
];

const timeline = [
  { evt: "Init", kind: "init", price: "$1800.00", d1: "$1710.00", c1: "$1854.00", width: "7.77%" },
  { evt: "Periódico", kind: "sky", price: "$1800.00", d1: "$1710.00 →", c1: "$1854.00 → $1800.00", width: "5.00%" },
  { evt: "Techo", kind: "accent", price: "$1808.00", d1: "$1710.00 → $1717.60", c1: "$1800.00 → $1862.24", width: "7.77%" },
  { evt: "Periódico", kind: "sky", price: "$1830.00", d1: "$1717.60 →", c1: "$1862.24 → $1830.00", width: "6.14%" },
  { evt: "Techo", kind: "accent", price: "$1850.00", d1: "$1717.60 → $1757.50", c1: "$1830.00 → $1905.50", width: "7.77%" },
  { evt: "Piso", kind: "negative", price: "$1770.00", d1: "$1778.40 → $1681.50", c1: "$1928.16 → $1770.00", width: "5.00%" },
  { evt: "Periódico", kind: "sky", price: "$1735.00", d1: "$1681.50 →", c1: "$1770.00 → $1735.00", width: "3.08%" },
];

const pillClass: Record<string, string> = {
  init: "!border-hairline !text-faint",
  sky: "!border-sky-400/40 !text-sky-400",
  accent: "!border-accent/40 !text-accent",
  negative: "!border-negative/40 !text-negative",
};

const caseBorder: Record<string, string> = {
  sky: "border-l-sky-400",
  negative: "border-l-negative",
  accent: "border-l-accent",
};

const caseTagColor: Record<string, string> = {
  sky: "!border-sky-400/45 !text-sky-400",
  negative: "!border-negative/45 !text-negative",
  accent: "!border-accent/45 !text-accent",
};

export default function RecursosPage() {
  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <span className="eyebrow">Recursos</span>
        <h1
          className="mt-5 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Cómo decide el <span className="text-accent">agente</span> cuándo rebalancear
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
          El agente revisa cada vault cada 5 minutos y decide entre tres caminos, siempre en el mismo orden.
          Esta guía explica los campos que configurás al crear un vault, la lógica de decisión paso a paso, y
          los tres casos con ejemplos numéricos reales.
        </p>

        {/* §1 fields */}
        <section className="mt-16">
          <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            1. Los 6 campos que configurás
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Los que pedís al crear el vault, en el mismo orden en que aparecen en el formulario — cada uno
            controla una cosa distinta, no hay valores por defecto.
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map((f) => (
              <div key={f.name} className="glass rounded-2xl p-5">
                <p className="font-mono text-xs text-accent">{f.name}</p>
                <p className="mt-2 text-sm leading-relaxed text-white/90">{f.what}</p>
                <p className="mt-3 border-t border-hairline pt-3 font-mono text-xs text-faint">
                  <b className="text-muted">Ej:</b> {f.example}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-5 max-w-2xl text-sm leading-relaxed text-muted">
            Un séptimo valor, <code className="text-white/80">minRebalanceInterval</code> (el cooldown piso),
            no se tipea — el formulario de creación lo deja fijo en <code className="text-white/80">0</code>{" "}
            (sin piso) automáticamente. Sigue siendo relevante para la decisión del agente (paso 2 de abajo),
            simplemente no es algo que elijas vos al crear el vault.
          </p>
        </section>

        {/* §2 decision order */}
        <section className="mt-16">
          <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            2. El orden de decisión
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Cada tick, para cada vault, el agente corre esta secuencia — y el orden importa: el reloj
            periódico y la salida de rango son disparadores independientes, no uno depende del otro.
          </p>
          <ol className="mt-6 flex flex-col gap-5">
            {steps.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-accent font-mono text-xs text-accent">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-medium text-white/90">{s.title}</p>
                  <p className="mt-1 text-sm text-muted">{s.body}</p>
                  <p
                    className={`mt-1.5 font-mono text-xs ${
                      s.result.kind === "no" ? "text-negative" : "text-positive"
                    }`}
                  >
                    {s.result.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* §3 cases */}
        <section className="mt-16">
          <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            3. Los tres casos, con ejemplo
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Mutuamente excluyentes — en un tick dado, el vault cae en uno solo de los tres.
          </p>
          <div className="mt-5 flex flex-col gap-4">
            {cases.map((c) => (
              <div key={c.name} className={`glass rounded-2xl border-l-4 ${caseBorder[c.color]} p-6`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-base font-semibold text-white/90">{c.name}</span>
                  <span className={`eyebrow !px-3 !py-1 ${caseTagColor[c.color]}`}>{c.trigger}</span>
                </div>
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">{c.desc}</p>
                <div className="mt-4 rounded-xl border border-hairline bg-white/[0.02] p-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-faint">Ejemplo</p>
                  <p className="mt-2 break-words font-mono text-xs text-white/80">{c.example}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* §4 timeline */}
        <section className="mt-16">
          <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            4. La vida de un vault, ciclo por ciclo
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Una simulación con precio real moviéndose — mismo vault, distintos casos disparándose uno tras
            otro. El piso (D1) solo cambia en un Caso 2 o 3; en el Caso periódico queda intacto.
          </p>
          <div className="mt-5 overflow-x-auto rounded-2xl border border-hairline">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-hairline bg-white/[0.02]">
                  {["Evento", "Precio", "D1 (piso)", "C1 (techo)", "Ancho"].map((h) => (
                    <th
                      key={h}
                      className="whitespace-nowrap px-4 py-3 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-faint"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {timeline.map((row, i) => (
                  <tr key={i} className="border-b border-hairline last:border-0">
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className={`eyebrow !px-2.5 !py-0.5 !text-[10px] ${pillClass[row.kind]}`}>
                        {row.evt}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">{row.price}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">{row.d1}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">{row.c1}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-muted">{row.width}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* §5 pitfall */}
        <section className="mt-16">
          <h2 className="text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
            5. El error más común
          </h2>
          <div className="mt-5 rounded-2xl border border-negative/35 bg-negative/[0.06] p-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-negative">
              Confirmado en producción — dos vaults reales quedaron así
            </p>
            <p className="mt-3 text-sm text-white/90">
              <b>Síntoma:</b> el vault muestra &quot;Fuera de rango&quot; en el panel, pero pasan los ticks y
              nunca rebalancea.
            </p>
            <p className="mt-2 text-sm text-white/90">
              <b>Causa real:</b> <code>maxRebalances = 0</code>. El paso 1 de la sección 2 se detiene ahí
              siempre — el agente ni siquiera llega a mirar el precio. No importa qué tan fuera de rango
              esté, ni cuánto falte para el reloj periódico.
            </p>
            <p className="mt-2 text-sm text-white/90">
              <b>Cómo pasa:</b> al desactivar &quot;reinyección&quot; y &quot;periódico&quot; poniendo{" "}
              <code>0</code> en esos campos, es fácil poner <code>0</code> por error en &quot;tope de
              rebalanceos&quot; también — son campos vecinos en el mismo formulario, pero significan cosas
              completamente distintas.
            </p>
            <p className="mt-2 text-sm text-white/90">
              <b>Arreglo:</b> &quot;Reconfigurar agente&quot; → subir el tope de rebalanceos por encima de 0.
              El agente lo agarra en el próximo tick, sin esperar el reloj periódico.
            </p>
          </div>
        </section>

        <p className="mt-16 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
          Fuente: frontend/lib/keeper/monitor.ts + frontend/lib/keeper/rebalancer.ts
        </p>
      </main>
    </>
  );
}
