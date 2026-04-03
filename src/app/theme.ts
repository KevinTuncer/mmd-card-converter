export type AppTheme = "light" | "dark";

export const APP_THEME_STORAGE_KEY = "mmd-convert.theme";

function normalizeTheme(value: string | null): AppTheme | null {
  if (value === "light" || value === "dark") return value;
  return null;
}

export function detectSystemTheme(): AppTheme {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }

  return "light";
}

export function getStoredTheme(): AppTheme | null {
  try {
    return normalizeTheme(localStorage.getItem(APP_THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeTheme(theme: AppTheme): void {
  try {
    localStorage.setItem(APP_THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures (private mode, disabled storage).
  }
}

export function getInitialTheme(): AppTheme {
  return getStoredTheme() ?? detectSystemTheme();
}

export function applyDocumentTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function watchSystemTheme(
  onChange: (theme: AppTheme) => void,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return () => {};
  }

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const handleChange = (event: MediaQueryListEvent): void => {
    onChange(event.matches ? "dark" : "light");
  };

  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }

  mediaQuery.addListener(handleChange);
  return () => mediaQuery.removeListener(handleChange);
}
