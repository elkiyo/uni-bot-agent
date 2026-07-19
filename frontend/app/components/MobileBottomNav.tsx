"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslation } from "@/lib/i18n/useTranslation";

const items = [
  {
    href: "/vaults",
    labelKey: "mobileNav.vaults" as const,
    icon: (active: boolean) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <rect
          x="3.5"
          y="6.5"
          width="17"
          height="13"
          rx="2.5"
          stroke="currentColor"
          strokeWidth={active ? 2 : 1.6}
        />
        <path d="M3.5 10.5H20.5" stroke="currentColor" strokeWidth={active ? 2 : 1.6} />
        <circle cx="16" cy="14.5" r="1.3" fill="currentColor" />
      </svg>
    ),
  },
  {
    href: "/create",
    labelKey: "mobileNav.create" as const,
    icon: (active: boolean) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth={active ? 2 : 1.6} />
        <path d="M12 8V16M8 12H16" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: "/dashboard",
    labelKey: "mobileNav.dashboard" as const,
    icon: (active: boolean) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 20V13M12 20V4M20 20V9"
          stroke="currentColor"
          strokeWidth={active ? 2 : 1.6}
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

export function MobileBottomNav() {
  const pathname = usePathname();
  const { t } = useTranslation();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-hairline bg-background/90 backdrop-blur-xl md:hidden"
      style={{
        paddingBottom: "env(safe-area-inset-bottom)",
        // iOS Safari can visibly jitter/reposition backdrop-blur + fixed
        // elements during scroll (compositor repaints the layer instead of
        // treating it as pinned); forcing its own GPU layer keeps it pinned.
        transform: "translateZ(0)",
        WebkitTransform: "translateZ(0)",
      }}
    >
      <div className="flex h-16 items-stretch justify-around">
        {items.map(({ href, labelKey, icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={
                active
                  ? "flex flex-1 flex-col items-center justify-center gap-1 text-accent"
                  : "flex flex-1 flex-col items-center justify-center gap-1 text-white/50 transition-colors hover:text-white"
              }
            >
              {icon(active)}
              <span className="text-[10.5px] font-medium leading-none">{t(labelKey)}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
