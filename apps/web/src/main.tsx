import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { registerSW } from "virtual:pwa-register";

import { App } from "./App";
import { clientPerformance } from "./lib/client-performance";
import "./styles.css";
import "./styles/system.css";
import "./styles/motion.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

let updateServiceWorker:
  | ReturnType<typeof registerSW>
  | undefined;

updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() {
    void updateServiceWorker?.(true);
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);

requestAnimationFrame(() => {
  clientPerformance.record("client.app_shell.ready", performance.now());
});
