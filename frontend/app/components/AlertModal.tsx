"use client";

/** Blocking alert — used where a user action must be stopped before any wallet
 * signature is requested (e.g. platform deposit cap), not just flagged after
 * the fact via the inline error banner most forms already use. */
export function AlertModal({
  title,
  message,
  onClose,
}: {
  title: string;
  message: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4">
      {/* Solid background, not .glass — a translucent card here let whatever
          busy page sits behind it bleed through and become unreadable. Same
          solid-fill pattern NetworkSelector's own dropdown already uses. */}
      <div
        className="w-full max-w-md rounded-2xl border border-hairline p-6 shadow-2xl shadow-black/60 sm:p-8"
        style={{ backgroundColor: "#0a0a0a" }}
      >
        <h3 className="text-xl font-semibold tracking-tight text-white" style={{ fontFamily: "var(--font-display)" }}>
          {title}
        </h3>
        <p className="mt-3 text-sm text-muted">{message}</p>
        <button onClick={onClose} className="btn-primary mt-6 !py-2.5">
          Entendido
        </button>
      </div>
    </div>
  );
}
