import "./style.css";
import { AudioEngine } from "./audio/AudioEngine.ts";
import { App } from "./ui/App.ts";
import { el } from "./ui/dom.ts";

const root = document.getElementById("app")!;

// AudioContext must be created/resumed from a user gesture, so we gate the
// whole app behind a tap-to-start overlay (required on iOS in particular).
function showStartOverlay() {
  const startBtn = el("button", {}, ["TAP TO START"]);
  const overlay = el("div", { class: "overlay" }, [
    el("h1", {}, ["POCKET SAMPLER"]),
    el("p", {}, ["Sampler · drum machine · sequencer"]),
    startBtn,
  ]);
  document.body.append(overlay);

  startBtn.addEventListener(
    "click",
    async () => {
      startBtn.textContent = "loading…";
      const engine = new AudioEngine({ trackCount: 16, steps: 16 });
      engine.bpm = 120;
      try {
        await engine.init();
      } catch (err) {
        console.error(err);
        startBtn.textContent = "audio failed — tap to retry";
        return;
      }
      overlay.remove();
      const app = new App(engine, root);
      app.mount();
    },
    { once: false },
  );
}

showStartOverlay();

// Register the service worker for offline / installable PWA (production only).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(new URL("sw.js", document.baseURI).href)
      .catch((err) => console.warn("SW registration failed", err));
  });
}
