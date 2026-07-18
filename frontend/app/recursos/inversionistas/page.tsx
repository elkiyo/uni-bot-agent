import Link from "next/link";
import { Header } from "../../components/Header";

export const metadata = {
  title: "AutoRange — Para inversionistas",
  description:
    "Cómo opera AutoRange explicado sin jerga técnica: qué DEX y qué pools usa, seguridad a nivel protocolo y usuario, y de dónde sale el ingreso de la plataforma.",
};

export default function InversionistasPage() {
  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <span className="eyebrow">Recursos · Para inversionistas</span>
        <h1
          className="mt-5 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Cómo opera AutoRange, explicado sin jerga técnica
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">
          Una presentación completa para inversionistas: qué DEX y qué pools usamos, cómo se reparten las
          comisiones ganadas (con un ejemplo numérico real), la arquitectura de contratos aislados por
          usuario, y por qué nadie más que vos puede tocar tus fondos.
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <a href="/inversionistas/presentacion.html" target="_blank" rel="noopener noreferrer" className="btn-primary !px-5 !py-2.5 !text-sm">
            Ver la presentación
          </a>
          <a href="/inversionistas/presentacion-movil.html" target="_blank" rel="noopener noreferrer" className="btn-secondary !px-5 !py-2.5 !text-sm">
            Versión para leer en el celular
          </a>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5">
          <a
            href="/inversionistas/AutoRange-Presentacion-Inversionistas.pdf"
            className="text-xs text-muted underline-offset-4 hover:text-accent hover:underline"
          >
            Descargar PDF (horizontal, para proyectar) ↓
          </a>
          <a
            href="/inversionistas/AutoRange-Presentacion-Inversionistas-Movil.pdf"
            className="text-xs text-muted underline-offset-4 hover:text-accent hover:underline"
          >
            Descargar PDF (vertical, para el celular) ↓
          </a>
        </div>

        <div className="mt-10 overflow-hidden rounded-2xl border border-hairline bg-black">
          <iframe
            src="/inversionistas/presentacion.html"
            title="AutoRange — Presentación para inversionistas"
            className="aspect-video w-full"
            style={{ border: "none" }}
          />
        </div>

        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted">
          ¿Buscás el detalle técnico de cómo decide el agente cuándo rebalancear, con ejemplos numéricos
          ciclo por ciclo?{" "}
          <Link href="/recursos" className="text-accent underline-offset-4 hover:underline">
            Esa guía está acá →
          </Link>
        </p>
      </main>
    </>
  );
}
