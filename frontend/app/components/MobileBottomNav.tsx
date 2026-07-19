"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  {
    href: "/vaults",
    label: "Mis vaults",
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
    label: "Crear vault",
    icon: (active: boolean) => (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth={active ? 2 : 1.6} />
        <path d="M12 8V16M8 12H16" stroke="currentColor" strokeWidth={active ? 2 : 1.6} strokeLinecap="round" />
      </svg>
    ),
  },
  {
    href: "/dashboard",
    label: "Dashboard",
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

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-50 border-t border-hairline bg-background/90 backdrop-blur-xl md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="flex h-16 items-stretch justify-around">
        {items.map(({ href, label, icon }) => {
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
              <span className="text-[10.5px] font-medium leading-none">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
