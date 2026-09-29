import type { ReactNode } from "react";

/** Shared page body: max-width container with consistent 24px spacing. */
export function PageBody({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="mx-auto w-full max-w-[1440px] p-3 sm:p-6">
      {children}
    </main>
  );
}
