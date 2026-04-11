/**
 * Browser discovery for headless CLI mode.
 *
 * Searches for a suitable Chromium-based browser to delegate browser-only
 * conversions (WebCodecs, etc.). Priority order:
 *
 *   1. System default browser (if Chromium-based)
 *   2. Brave
 *   3. Chromium
 *   4. Google Chrome
 *   5. Microsoft Edge
 *   6. Opera
 *   7. Vivaldi
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

export interface BrowserCandidate {
  name: string;
  path: string;
}

// ── Platform helpers ─────────────────────────────────────────────────────────

const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";

function localAppData(): string {
  const base = process.env.LOCALAPPDATA;
  if (base) return base;
  return path.join(os.homedir(), "AppData", "Local");
}

function programFiles(...segments: string[]): string {
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  return path.join(pf, ...segments);
}

function programFilesX86(...segments: string[]): string {
  const pf = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  return path.join(pf, ...segments);
}

function macApp(name: string): string {
  return `/Applications/${name}.app/Contents/MacOS/${name}`;
}

function linuxBin(name: string): string {
  return `/usr/bin/${name}`;
}

function linuxLocalBin(name: string): string {
  return path.join(os.homedir(), ".local", "bin", name);
}

// ── Windows: check if a path is a file ───────────────────────────────────────

function winExists(p: string): boolean {
  try {
    return fs.existsSync(p) || fs.existsSync(p + "\\");
  } catch {
    return false;
  }
}

// ── POSIX: check if a path is executable ─────────────────────────────────────

function posixExists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const exists = isWindows ? winExists : posixExists;

// ── Registry-based default browser query (Windows) ──────────────────────────

function getDefaultBrowserWindows(): BrowserCandidate | null {
  try {
    // Query the UserChoice for http protocol
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId',
      { encoding: "utf-8", timeout: 5000 },
    );
    const match = out.match(/ProgId\s+REG_SZ\s+(\S+)/);
    if (!match) return null;
    const progId = match[1]!.toLowerCase();

    // Map common ProgIds to browser names
    const chromiumBrowsers: Record<string, string[]> = {
      brave: ["Brave"],
      chrome: ["ChromeHTML", "GoogleChrome"],
      edge: ["MSEdgeHTM", "MSEdge"],
      vivaldi: ["Vivaldi"],
      opera: ["OperaStable", "Opera"],
    };

    for (const [browser, progIds] of Object.entries(chromiumBrowsers)) {
      if (progIds.some((id) => progId.includes(id.toLowerCase()))) {
        const found = findSpecificBrowser(browser);
        if (found) return found;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ── macOS: use LaunchServices to find default browser ────────────────────────

function getDefaultBrowserMac(): BrowserCandidate | null {
  try {
    const out = execSync(
      "plutil -convert json -o - ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist 2>/dev/null",
      { encoding: "utf-8", timeout: 5000 },
    );
    const plist = JSON.parse(out);
    const handlers: Array<{
      LSHandlerURLScheme?: string;
      LSHandlerRoleAll?: string;
    }> = plist?.LSHandlers ?? [];

    let browserBundle: string | undefined;
    for (const h of handlers) {
      if (h.LSHandlerURLScheme === "https" && h.LSHandlerRoleAll) {
        browserBundle = h.LSHandlerRoleAll;
        break;
      }
    }

    if (!browserBundle) return null;

    const lower = browserBundle.toLowerCase();
    if (lower.includes("brave")) return findSpecificBrowser("brave");
    if (lower.includes("chromium")) return findSpecificBrowser("chromium");
    if (lower.includes("google") || lower.includes("chrome"))
      return findSpecificBrowser("chrome");
    if (lower.includes("edge") || lower.includes("microsoft"))
      return findSpecificBrowser("edge");
    if (lower.includes("vivaldi")) return findSpecificBrowser("vivaldi");
    if (lower.includes("opera")) return findSpecificBrowser("opera");

    return null;
  } catch {
    return null;
  }
}

// ── Linux: xdg-settings ─────────────────────────────────────────────────────

function getDefaultBrowserLinux(): BrowserCandidate | null {
  try {
    const out = execSync("xdg-settings get default-web-browser 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    });
    const desktopFile = out.trim().toLowerCase();

    if (desktopFile.includes("brave")) return findSpecificBrowser("brave");
    if (desktopFile.includes("chromium"))
      return findSpecificBrowser("chromium");
    if (desktopFile.includes("google-chrome") || desktopFile.includes("chrome"))
      return findSpecificBrowser("chrome");
    if (desktopFile.includes("edge") || desktopFile.includes("microsoft"))
      return findSpecificBrowser("edge");
    if (desktopFile.includes("vivaldi")) return findSpecificBrowser("vivaldi");
    if (desktopFile.includes("opera")) return findSpecificBrowser("opera");

    return null;
  } catch {
    return null;
  }
}

// ── Specific browser search paths ────────────────────────────────────────────

type CandidateList = Array<{ name: string; paths: string[] }>;

function getCandidates(): CandidateList {
  if (isWindows) {
    return [
      {
        name: "Brave",
        paths: [
          path.join(
            localAppData(),
            "BraveSoftware",
            "Brave-Browser",
            "Application",
            "brave.exe",
          ),
          programFiles(
            "BraveSoftware",
            "Brave-Browser",
            "Application",
            "brave.exe",
          ),
          programFilesX86(
            "BraveSoftware",
            "Brave-Browser",
            "Application",
            "brave.exe",
          ),
        ],
      },
      {
        name: "Chromium",
        paths: [
          path.join(localAppData(), "Chromium", "Application", "chrome.exe"),
          programFiles("Chromium", "Application", "chrome.exe"),
          programFilesX86("Chromium", "Application", "chrome.exe"),
        ],
      },
      {
        name: "Google Chrome",
        paths: [
          path.join(
            localAppData(),
            "Google",
            "Chrome",
            "Application",
            "chrome.exe",
          ),
          programFiles("Google", "Chrome", "Application", "chrome.exe"),
          programFilesX86("Google", "Chrome", "Application", "chrome.exe"),
        ],
      },
      {
        name: "Microsoft Edge",
        paths: [
          path.join(
            localAppData(),
            "Microsoft",
            "Edge",
            "Application",
            "msedge.exe",
          ),
          programFiles("Microsoft", "Edge", "Application", "msedge.exe"),
          programFilesX86("Microsoft", "Edge", "Application", "msedge.exe"),
        ],
      },
      {
        name: "Opera",
        paths: [
          path.join(localAppData(), "Programs", "Opera", "opera.exe"),
          programFiles("Opera", "opera.exe"),
          programFilesX86("Opera", "opera.exe"),
        ],
      },
      {
        name: "Vivaldi",
        paths: [
          path.join(localAppData(), "Vivaldi", "Application", "vivaldi.exe"),
          programFiles("Vivaldi", "Application", "vivaldi.exe"),
          programFilesX86("Vivaldi", "Application", "vivaldi.exe"),
        ],
      },
    ];
  }

  if (isMac) {
    return [
      { name: "Brave", paths: [macApp("Brave Browser")] },
      { name: "Chromium", paths: [macApp("Chromium")] },
      { name: "Google Chrome", paths: [macApp("Google Chrome")] },
      { name: "Microsoft Edge", paths: [macApp("Microsoft Edge")] },
      { name: "Opera", paths: [macApp("Opera")] },
      { name: "Vivaldi", paths: [macApp("Vivaldi")] },
    ];
  }

  // Linux
  return [
    {
      name: "Brave",
      paths: [
        linuxBin("brave-browser"),
        linuxBin("brave"),
        linuxLocalBin("brave-browser"),
      ],
    },
    {
      name: "Chromium",
      paths: [
        linuxBin("chromium-browser"),
        linuxBin("chromium"),
        linuxLocalBin("chromium-browser"),
      ],
    },
    {
      name: "Google Chrome",
      paths: [
        linuxBin("google-chrome-stable"),
        linuxBin("google-chrome"),
        linuxLocalBin("google-chrome"),
      ],
    },
    {
      name: "Microsoft Edge",
      paths: [
        linuxBin("microsoft-edge-stable"),
        linuxBin("microsoft-edge"),
        linuxLocalBin("microsoft-edge"),
      ],
    },
    { name: "Opera", paths: [linuxBin("opera"), linuxLocalBin("opera")] },
    {
      name: "Vivaldi",
      paths: [
        linuxBin("vivaldi-stable"),
        linuxBin("vivaldi"),
        linuxLocalBin("vivaldi"),
      ],
    },
  ];
}

function findSpecificBrowser(name: string): BrowserCandidate | null {
  const lower = name.toLowerCase();
  for (const candidate of getCandidates()) {
    if (candidate.name.toLowerCase().includes(lower)) {
      for (const p of candidate.paths) {
        if (exists(p)) {
          return { name: candidate.name, path: p };
        }
      }
    }
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Find a suitable Chromium-based browser for headless mode.
 *
 * Checks the system default browser first, then falls back to the
 * priority order: Brave → Chromium → Chrome → Edge → Opera → Vivaldi.
 */
export function findBrowser(): BrowserCandidate | null {
  // 1. Try system default browser
  let defaultCandidate: BrowserCandidate | null = null;
  if (isWindows) defaultCandidate = getDefaultBrowserWindows();
  else if (isMac) defaultCandidate = getDefaultBrowserMac();
  else defaultCandidate = getDefaultBrowserLinux();

  if (defaultCandidate) return defaultCandidate;

  // 2. Fall back to priority order
  for (const candidate of getCandidates()) {
    for (const p of candidate.paths) {
      if (exists(p)) {
        return { name: candidate.name, path: p };
      }
    }
  }

  return null;
}

/**
 * Get the headless browser executable path, or throw with a helpful message.
 */
export function requireBrowser(): BrowserCandidate {
  const browser = findBrowser();
  if (browser) return browser;

  const platform = isWindows ? "Windows" : isMac ? "macOS" : "Linux";
  throw new Error(
    `No Chromium-based browser found for headless CLI mode.\n` +
      `Please install one of: Brave, Chromium, Google Chrome, Microsoft Edge, Opera, or Vivaldi.\n` +
      `Detected platform: ${platform}`,
  );
}
