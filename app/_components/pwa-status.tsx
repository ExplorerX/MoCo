"use client";

import { useEffect, useState } from "react";

export default function PwaStatus({ hasActiveSession }: { hasActiveSession: boolean }) {
  const [online, setOnline] = useState(true);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    if (!("serviceWorker" in navigator)) return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };

    let disposed = false;
    const watch = (registration: ServiceWorkerRegistration) => {
      if (registration.waiting) setWaiting(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (!disposed && worker.state === "installed" && navigator.serviceWorker.controller) setWaiting(worker);
        });
      });
    };
    navigator.serviceWorker.register("/sw.js").then(watch).catch(() => undefined);
    const onControllerChange = () => window.location.reload();
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      disposed = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  const activateUpdate = () => {
    if (hasActiveSession || !waiting) return;
    waiting.postMessage({ type: "SKIP_WAITING" });
  };

  if (online && !waiting) return null;
  return (
    <aside className="pwa-status" aria-live="polite">
      {!online && <span>当前离线 · 训练与本地记录仍可使用</span>}
      {waiting && (
        <span>
          新版本已就绪
          <button onClick={activateUpdate} disabled={hasActiveSession}>
            {hasActiveSession ? "练习结束后更新" : "立即更新"}
          </button>
        </span>
      )}
    </aside>
  );
}
