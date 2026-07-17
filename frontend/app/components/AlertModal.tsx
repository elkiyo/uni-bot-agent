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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="glass max-w-md rounded-2xl p-6 sm:p-8">
        <h3 className="text-lg font-semibold tracking-tight" style={{ fontFamily: "var(--font-display)" }}>
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
