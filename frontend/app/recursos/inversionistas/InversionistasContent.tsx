"use client";

import Link from "next/link";
import { Header } from "../../components/Header";
import { useTranslation } from "@/lib/i18n/useTranslation";

export function InversionistasContent() {
  const { t } = useTranslation();

  return (
    <>
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <span className="eyebrow">{t("investors.eyebrow")}</span>
        <h1
          className="mt-5 text-balance text-3xl font-semibold leading-[1.1] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("investors.title")}
        </h1>
        <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-muted">{t("investors.subtitle")}</p>

        <div className="mt-6 flex flex-wrap gap-3">
          <a href="/inversionistas/presentacion.html" target="_blank" rel="noopener noreferrer" className="btn-primary !px-5 !py-2.5 !text-sm">
            {t("investors.viewPresentation")}
          </a>
          <a href="/inversionistas/presentacion-movil.html" target="_blank" rel="noopener noreferrer" className="btn-secondary !px-5 !py-2.5 !text-sm">
            {t("investors.mobileVersion")}
          </a>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5">
          <a
            href="/inversionistas/AutoRange-Presentacion-Inversionistas.pdf"
            className="text-xs text-muted underline-offset-4 hover:text-accent hover:underline"
          >
            {t("investors.downloadPdfHorizontal")}
          </a>
          <a
            href="/inversionistas/AutoRange-Presentacion-Inversionistas-Movil.pdf"
            className="text-xs text-muted underline-offset-4 hover:text-accent hover:underline"
          >
            {t("investors.downloadPdfVertical")}
          </a>
        </div>

        <div className="mt-10 overflow-hidden rounded-2xl border border-hairline bg-black">
          <iframe
            src="/inversionistas/presentacion.html"
            title={t("investors.iframeTitle")}
            className="aspect-video w-full"
            style={{ border: "none" }}
          />
        </div>

        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted">
          {t("investors.footerPre")}
          <Link href="/recursos" className="text-accent underline-offset-4 hover:underline">
            {t("investors.footerLink")}
          </Link>
        </p>
      </main>
    </>
  );
}
