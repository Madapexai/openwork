import { useEffect } from "react";

/**
 * Keeps `--keyboard-inset` in sync with the software keyboard so sticky
 * composers can sit above it. iOS Safari does not shrink `100vh` / `dvh`
 * when the keyboard opens; `visualViewport` does.
 */
export function useVisualViewportInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const sync = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
    };

    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      window.removeEventListener("orientationchange", sync);
      document.documentElement.style.removeProperty("--keyboard-inset");
    };
  }, []);
}
