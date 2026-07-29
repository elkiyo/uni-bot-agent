"use client";

import { useTheme } from "@/lib/useTheme";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}
      title={isDark ? "Modo claro" : "Modo oscuro"}
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-hairline bg-surface-1 text-foreground/70 transition-colors duration-200 hover:border-accent-glow-border hover:text-foreground"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className={`absolute h-[18px] w-[18px] transition-all duration-200 ${
          isDark ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-50 opacity-0"
        }`}
      >
        <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.6" />
        <path
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"
        />
      </svg>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className={`absolute h-[18px] w-[18px] transition-all duration-200 ${
          isDark ? "rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100"
        }`}
      >
        <path
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          d="M20.5 14.2A8.5 8.5 0 1 1 9.8 3.5a7 7 0 0 0 10.7 10.7Z"
        />
      </svg>
    </button>
  );
}
