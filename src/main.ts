import "./style.css";
import {
  applyDocumentTheme,
  getInitialTheme,
  getStoredTheme,
  storeTheme,
  watchSystemTheme,
  type AppTheme,
} from "@/app/theme";
import { mountConverterView } from "@/app/ui/ConverterView";
import {
  getInitialLocale,
  setCurrentLocale,
  storeLocale,
  type AppLocale,
} from "@/i18n/localization";

const appRootElement = document.querySelector<HTMLDivElement>("#app");

if (!appRootElement) {
  throw new Error("#app element not found");
}

const appRoot: HTMLElement = appRootElement;

function applyDocumentLocale(locale: AppLocale): void {
  document.documentElement.lang = locale;
}

function render(locale: AppLocale, theme: AppTheme): void {
  currentLocale = locale;
  currentTheme = theme;
  setCurrentLocale(locale);
  applyDocumentLocale(locale);
  applyDocumentTheme(theme);
  mountConverterView(appRoot, {
    locale,
    theme,
    onLocaleChange(nextLocale) {
      storeLocale(nextLocale);
      render(nextLocale, theme);
    },
    onThemeToggle(nextTheme) {
      storeTheme(nextTheme);
      render(locale, nextTheme);
    },
  });
}

let currentLocale = getInitialLocale();
let currentTheme = getInitialTheme();

watchSystemTheme((nextTheme) => {
  if (getStoredTheme() !== null) return;
  currentTheme = nextTheme;
  render(currentLocale, currentTheme);
});

render(currentLocale, currentTheme);
