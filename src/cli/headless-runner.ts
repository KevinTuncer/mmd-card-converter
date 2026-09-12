/**
 * Headless browser runner for browser-only CLI conversions.
 *
 * When a conversion requires browser APIs (WebCodecs AudioEncoder, VideoEncoder, etc.),
 * this module:
 *   1. Starts the Vite dev server
 *   2. Starts a tiny result HTTP server
 *   3. Launches a headless Chromium-based browser that loads a runner page
 *   4. The runner page imports converters via Vite, converts the file, and
 *      POSTs the result back to the result server
 *   5. Cleans up and returns the result
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { requireBrowser, type BrowserCandidate } from "./find-browser";

const isWindows = process.platform === "win32";

// ── Types ────────────────────────────────────────────────────────────────────

export interface HeadlessConversionRequest {
  command: string;
  inputFile: string; // base64-encoded file content
  inputFileName: string;
  inputMimeType: string;
  options: Record<string, string>;
  flags: string[];
}

export interface HeadlessConversionResult {
  success: boolean;
  outputFileName: string;
  outputFile: string; // base64-encoded output content
  summary?: unknown;
  error?: string;
}

// ── Combined server (runner HTML + result endpoint + Vite proxy) ──────────────

function startServer(
  vitePortPromise: Promise<number>,
  verbose: boolean,
): {
  server: http.Server;
  port: Promise<number>;
  result: Promise<HeadlessConversionResult>;
  setRunnerHtml: (html: string) => void;
  close: () => void;
} {
  let resolveResult!: (result: HeadlessConversionResult) => void;
  const resultPromise = new Promise<HeadlessConversionResult>((resolve) => {
    resolveResult = resolve;
  });

  let runnerHtml = ""; // Will be set via setRunnerHtml() after ports are known

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/runner") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(runnerHtml);
      return;
    }

    if (url.pathname === "/result" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const result = JSON.parse(body) as HeadlessConversionResult;
          if (verbose) {
            console.log(
              `  Received result from browser (success=${result.success})`,
            );
          }
          resolveResult(result);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid JSON");
          resolveResult({
            success: false,
            outputFileName: "",
            outputFile: "",
            error: `Server received invalid result: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
      return;
    }

    // Proxy everything else to Vite dev server
    vitePortPromise
      .then((vitePort) => {
        const proxyReq = http.request(
          {
            hostname: "127.0.0.1",
            port: vitePort,
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              host: `127.0.0.1:${vitePort}`,
            },
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on("error", (err) => {
          if (verbose) {
            console.error(`  Proxy error for ${req.url}: ${err.message}`);
          }
          res.writeHead(502);
          res.end(`Proxy error: ${err.message}`);
        });
        req.pipe(proxyReq);
      })
      .catch((err) => {
        res.writeHead(500);
        res.end(`Server error: ${err.message}`);
      });
  });

  const port = new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve(addr.port);
      } else {
        reject(new Error("Failed to bind server"));
      }
    });
    server.on("error", reject);
  });

  return {
    server,
    port,
    result: resultPromise,
    setRunnerHtml: (html: string) => {
      runnerHtml = html;
    },
    close: () => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
  };
}

// ── Vite dev server ──────────────────────────────────────────────────────────

async function startVite(
  verbose: boolean,
): Promise<{ process: ChildProcess; port: number }> {
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );

  // Resolve vite executable
  let viteBin: string;
  try {
    const localBin = path.join(projectRoot, "node_modules", ".bin", "vite");
    if (fs.existsSync(localBin) || fs.existsSync(localBin + ".cmd")) {
      viteBin = localBin;
    } else {
      throw new Error("local bin not found");
    }
  } catch {
    viteBin = "npx";
  }

  const viteArgs = viteBin === "npx" ? ["vite"] : [];

  const viteProcess = spawn(viteBin, viteArgs, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
    shell: isWindows,
  });

  // Detect Vite port from its stdout/stderr output
  const vitePort = await new Promise<number>((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for Vite dev server to start.\nVite output so far: ${output.slice(-500)}`,
        ),
      );
    }, 30_000);

    const check = (chunk: Buffer | string) => {
      const text = chunk.toString();
      output += text;
      if (verbose) {
        process.stderr.write(text);
      }
      // Strip ANSI escape codes (Vite wraps port in bold)
      // eslint-disable-next-line no-control-regex -- intentionally matches ANSI escape sequences
      const clean = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
      const match = clean.match(/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(parseInt(match[1]!, 10));
      }
    };

    viteProcess.stdout?.on("data", check);
    viteProcess.stderr?.on("data", check);
    viteProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    viteProcess.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== null && code !== 0) {
        reject(
          new Error(
            `Vite exited with code ${code}.\nOutput: ${output.slice(-500)}`,
          ),
        );
      }
    });
  });

  if (verbose) {
    console.log(`  Vite dev server started on port ${vitePort}`);
  }

  return { process: viteProcess, port: vitePort };
}

// ── Runner HTML generation ───────────────────────────────────────────────────

function generateRunnerHtml(request: HeadlessConversionRequest): string {
  const requestJson = JSON.stringify(request);
  // Since the server proxies to Vite, imports are same-origin (relative URLs).
  // The result endpoint is also on the same origin.
  const resultUrl = "/result";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>CLI Headless Runner</title>
</head>
<body>
<p id="status">Starting conversion...</p>
<script type="module">
  const request = ${requestJson};
  const resultUrl = "${resultUrl}";

  const statusEl = document.getElementById("status");
  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
    console.log("[runner]", msg);
  }

  async function postResult(result) {
    for (let i = 0; i < 3; i++) {
      try {
        await fetch(resultUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(result),
        });
        return;
      } catch (err) {
        if (i < 2) await new Promise(r => setTimeout(r, 1000));
        else console.error("[runner] Failed to post result:", err);
      }
    }
  }

  async function run() {
    try {
      setStatus("Loading converter modules...");
      const { convertAudioFileToWebm } = await import("/app/converter/AudioToWebmConverter.ts");

      setStatus("Decoding input file...");
      const inputBytes = Uint8Array.from(atob(request.inputFile), c => c.charCodeAt(0));
      const inputFile = new File([inputBytes], request.inputFileName, {
        type: request.inputMimeType,
      });

      setStatus("Converting " + request.inputFileName + "...");

      let result;
      switch (request.command) {
        case "audio-to-webm": {
          const conv = await convertAudioFileToWebm(inputFile);
          let binary = "";
          const bytes = new Uint8Array(conv.buffer);
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const outputBase64 = btoa(binary);
          result = {
            success: true,
            outputFileName: conv.outputFileName,
            outputFile: outputBase64,
            summary: conv.summary,
          };
          break;
        }
        default:
          throw new Error("Unknown headless command: " + request.command);
      }

      setStatus("Conversion complete, sending result...");
      await postResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus("Error: " + msg);
      console.error("[runner] Conversion error:", err);
      await postResult({
        success: false,
        outputFileName: "",
        outputFile: "",
        error: msg,
      });
    }
  }

  run();
</script>
</body>
</html>`;
}

// ── Browser launch ───────────────────────────────────────────────────────────

function launchHeadlessBrowser(
  browser: BrowserCandidate,
  url: string,
  verbose: boolean,
): ChildProcess {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,720",
    "--enable-features=WebAssembly,WebCodecs",
    url,
  ];

  if (verbose) {
    console.log(`  Launching ${browser.name}: ${browser.path}`);
    console.log(`  URL: ${url}`);
  }

  const proc = spawn(browser.path, args, {
    stdio: "pipe",
    windowsHide: true,
    detached: false,
  });

  proc.on("error", (err) => {
    console.error(`Failed to launch browser: ${err.message}`);
  });

  return proc;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function killProcess(proc: ChildProcess | null): void {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  if (isWindows) {
    setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, 2000);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run a browser-only conversion by launching a headless Chromium-based browser.
 *
 * Strategy:
 * 1. Start Vite dev server (provides module transformation)
 * 2. Start a combined HTTP server that:
 *    - Serves the runner HTML on GET /runner
 *    - Accepts conversion results on POST /result
 *    - Proxies all other requests to Vite (module imports are same-origin)
 * 3. Generate runner HTML that imports converters (via proxy → Vite), converts
 *    the file, and POSTs the result back to /result
 * 4. Launch headless browser → load runner page → convert → POST result back
 * 5. Return the result
 */
export async function runHeadlessConversion(
  command: string,
  inputBuffer: ArrayBuffer,
  inputFileName: string,
  inputMimeType: string,
  options: Record<string, string>,
  flags: string[],
  verbose: boolean,
): Promise<HeadlessConversionResult> {
  const browser = requireBrowser();
  if (verbose) {
    console.log(`  Using browser: ${browser.name} (${browser.path})`);
  }

  // Encode input as base64 for transport to the browser
  const inputBase64 = Buffer.from(inputBuffer).toString("base64");

  const request: HeadlessConversionRequest = {
    command,
    inputFile: inputBase64,
    inputFileName,
    inputMimeType,
    options,
    flags,
  };

  // Start Vite dev server first (we need its port for the proxy)
  const vite = await startVite(verbose);

  // Start combined server with Vite proxy
  const srv = startServer(Promise.resolve(vite.port), verbose);
  const srvPort = await srv.port;

  // Generate runner HTML (same-origin: no explicit host/port needed)
  const runnerHtml = generateRunnerHtml(request);
  srv.setRunnerHtml(runnerHtml);

  if (verbose) {
    console.log(
      `  Server on port ${srvPort} (Vite proxy on port ${vite.port})`,
    );
  }

  // Launch browser
  const runnerUrl = `http://127.0.0.1:${srvPort}/runner`;
  const browserProcess = launchHeadlessBrowser(browser, runnerUrl, verbose);

  try {
    const result = await withTimeout(
      srv.result,
      120_000,
      "Headless conversion timed out after 120s",
    );
    return result;
  } finally {
    killProcess(browserProcess);
    killProcess(vite.process);
    srv.close();
  }
}

/**
 * Check whether a given CLI command requires browser APIs
 * and should be delegated to the headless runner.
 */
export function isBrowserOnlyCommand(command: string): boolean {
  return BROWSER_ONLY_COMMANDS.has(command);
}

const BROWSER_ONLY_COMMANDS = new Set(["audio-to-webm"]);
