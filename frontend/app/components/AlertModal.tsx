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
      {/* Solid, LIGHT background (accent-soft, the palette's pale yellow) —
          a dark panel here still read as barely distinct from the dark page
          behind it even fully opaque; see VaultDetail.tsx's withdraw-review
          modal for the same fix and reasoning. */}
      <div className="w-full max-w-md rounded-2xl bg-accent-soft p-6 shadow-2xl shadow-black/60 sm:p-8">
        <h3 className="text-xl font-semibold tracking-tight text-[#050505]" style={{ fontFamily: "var(--font-display)" }}>
          {title}
        </h3>
        <p className="mt-3 text-sm text-black/70">{message}</p>
        <button
          onClick={onClose}
          className="mt-6 rounded-full bg-[#050505] px-6 py-2.5 font-semibold text-accent-soft transition-opacity hover:opacity-90"
        >
          Entendido
        </button>
      </div>
    </div>
  );
}
