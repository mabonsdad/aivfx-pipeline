import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter } from "react-router-dom";

import App from "./App";
import { ApiError } from "./api/client";
import { assertConfig } from "./lib/config";
import "./index.css";

assertConfig();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status === 429) {
          return false;
        }
        return failureCount < 1;
      },
      retryDelay: (attempt) => Math.min(1500 * (2 ** attempt), 15000),
      staleTime: 3000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <App />
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
