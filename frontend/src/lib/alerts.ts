import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Attention for new incidents in a control room: a short chime (on by default, remembered per
 * browser) and, while the tab is in the background, a flashing tab title. Browsers only allow
 * sound after the user has interacted with the page, so the audio is unlocked on the first click
 * or key press after sign-in.
 */

const KEY = "ppe-alert-sound";
const MIN_GAP_MS = 10_000; // one chime per 10 s at most, however many incidents arrive

const readOn = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
};

let ctx: AudioContext | null = null;
let pending = false; // one chime waiting for the browser to allow sound, never a backlog
const listeners = new Set<() => void>();

function audio(): AudioContext | null {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    ctx.onstatechange = () => listeners.forEach((fn) => fn());
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
  return ctx;
}

/** True while the browser lets this page make sound (after a click or key press on it). */
export function useSoundAllowed(): boolean {
  const [allowed, setAllowed] = useState(() => audio()?.state === "running");
  useEffect(() => {
    const update = () => setAllowed(ctx?.state === "running");
    listeners.add(update);
    update();
    return () => { listeners.delete(update); };
  }, []);
  return allowed;
}

/** Two falling tones, ~0.4 s: noticeable without being a siren. While the browser still blocks
 * sound, it waits for it to be allowed (resume) instead of being dropped. */
export function playChime(): void {
  const ac = audio();
  if (!ac) return;
  if (ac.state !== "running") {
    if (!pending) {
      pending = true;
      void ac.resume().then(() => { pending = false; if (ac.state === "running") playChime(); }).catch(() => { pending = false; });
    }
    return;
  }
  const t0 = ac.currentTime;
  [[880, 0], [660, 0.18]].forEach(([freq, at]) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(0.25, t0 + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.2);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.22);
  });
}

/** The user's sound choice, remembered in this browser. */
export function useAlertSound(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readOn);
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      if (next) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, "off");
    } catch { /* private mode: this tab only */ }
    if (next) { audio(); playChime(); } // the click unlocks audio, and the chime confirms it works
  }, []);
  // unlock audio on the first interaction, so a later incident can sound
  useEffect(() => {
    const unlock = () => { audio(); window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => { window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
  }, []);
  return [on, set];
}

/**
 * Call `alert()` for every new incident: chimes (if on, rate-limited) and, when the tab is hidden,
 * flashes the tab title with the count of incidents missed until the tab is looked at again.
 */
export function useIncidentAlert(soundOn: boolean): () => void {
  const lastChime = useRef(0);
  const missed = useRef(0);
  const timer = useRef<number | null>(null);
  const base = useRef(document.title);

  const stopFlash = useCallback(() => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    missed.current = 0;
    document.title = base.current;
  }, []);

  useEffect(() => {
    const onVisible = () => { if (!document.hidden) stopFlash(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { document.removeEventListener("visibilitychange", onVisible); stopFlash(); };
  }, [stopFlash]);

  return useCallback(() => {
    const now = Date.now();
    if (soundOn && now - lastChime.current >= MIN_GAP_MS) {
      lastChime.current = now;
      playChime();
    }
    if (!document.hidden) return;
    missed.current += 1;
    if (timer.current === null) {
      base.current = document.title;
      let on = false;
      timer.current = window.setInterval(() => {
        on = !on;
        document.title = on ? `(${missed.current}) Unsafe worker - PPE` : base.current;
      }, 1000);
    }
  }, [soundOn]);
}
