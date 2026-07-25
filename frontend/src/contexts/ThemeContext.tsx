import { createContext, ReactNode, useState, useEffect, useCallback, useMemo } from "react";

export type Theme = "dark" | "light" | "system";

export interface ThemeProviderState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

const initialState: ThemeProviderState = {
  theme: "dark",
  setTheme: () => null,
};

export const ThemeProviderContext =
  createContext<ThemeProviderState>(initialState);

interface ThemeProviderProps {
  children: ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

/** TrainMobile is dark-only (black background + green highlights). */
export function ThemeProvider({
  children,
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme] = useState<Theme>("dark");

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light");
    root.classList.add("dark");
    localStorage.setItem(storageKey, "dark");
  }, [storageKey]);

  const updateTheme = useCallback(() => {
    // Theme is locked to dark.
  }, []);

  const value = useMemo(
    () => ({ theme, setTheme: updateTheme as (theme: Theme) => void }),
    [theme, updateTheme]
  );

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}
