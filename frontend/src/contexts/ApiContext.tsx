import React, { createContext, useContext, ReactNode, useState, useCallback, useMemo } from "react";

interface ApiContextType {
  baseUrl: string;
  wsBaseUrl: string;
  fetchWithHeaders: (url: string, options?: RequestInit) => Promise<Response>;
}

const ApiContext = createContext<ApiContextType | undefined>(undefined);

const STORAGE_KEY = "trainmobile.apiBaseUrl";
const LEGACY_STORAGE_KEY = "lelab.apiBaseUrl";

const httpToWs = (url: string): string => {
  if (!url) {
    if (typeof window === "undefined") return "ws://localhost:8000";
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}`;
  }
  return url.replace(/^http(s?):/, "ws$1:");
};

/** Empty string = same-origin (Vite proxy in --dev, or single-origin prod/tunnel). */
const resolveInitialBaseUrl = (): string => {
  if (typeof window === "undefined") return "";

  const fromQuery = new URLSearchParams(window.location.search).get("api");
  if (fromQuery) {
    try {
      new URL(fromQuery);
      const clean = fromQuery.replace(/\/$/, "");
      window.localStorage.setItem(STORAGE_KEY, clean);
      return clean;
    } catch {
      console.warn("Invalid `api` query param, ignoring:", fromQuery);
    }
  }

  const stored =
    window.localStorage.getItem(STORAGE_KEY) ||
    window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (stored) {
    // Ignore stale loopback overrides when opened from another device / tunnel.
    try {
      const host = new URL(stored).hostname;
      const here = window.location.hostname;
      const storedIsLoopback = host === "localhost" || host === "127.0.0.1";
      const hereIsLoopback = here === "localhost" || here === "127.0.0.1";
      if (!(storedIsLoopback && !hereIsLoopback)) {
        return stored;
      }
      window.localStorage.removeItem(STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      return stored;
    }
  }

  // Always same-origin in browser (dev Vite proxies API; prod shares :8000).
  return "";
};

export const ApiProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [baseUrl] = useState<string>(resolveInitialBaseUrl);
  const wsBaseUrl = httpToWs(baseUrl);

  const fetchWithHeaders = useCallback(async (url: string, options: RequestInit = {}): Promise<Response> => {
    return fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
  }, []);

  const value = useMemo(
    () => ({ baseUrl, wsBaseUrl, fetchWithHeaders }),
    [baseUrl, wsBaseUrl, fetchWithHeaders]
  );

  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
};

export const useApi = (): ApiContextType => {
  const context = useContext(ApiContext);
  if (context === undefined) {
    throw new Error("useApi must be used within an ApiProvider");
  }
  return context;
};
