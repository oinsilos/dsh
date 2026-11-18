import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";

export function restartNote() {
  return "正在重启 dsh web…";
}

export function portFromRequest(request) {
  const host = String(request?.headers?.host || "");
  const m = host.match(/:(\d+)$/);
  if (m) return Number(m[1]);
  return Number(process.env.PORT) || 3080;
}

export function hostFromRequest(request) {
  const hostHeader = String(request?.headers?.host || "127.0.0.1");
  return hostHeader.replace(/:\d+$/, "") || "127.0.0.1";
}

/**
 * 0.2.2-rc.3+ 的 CLI 由 dsh.cmd 经
 *   DeepSeek Harness.exe --expose-internals <…>/dsh-desktop-host/lib/cli.js <app args>
 * 启动。重启必须原样复刻这条命令行；直连 bin.js 是 0.2.0/0.2.1 的旧布局，
 * 在新 CLI 上会把 --expose-internals 和入口路径当成 profile 参数，起不来。
 */
function cliEntryOf(argv) {
  const list = Array.isArray(argv) ? argv : [];
  const at = list.findIndex((arg) => {
    const n = String(arg || "").replace(/\\/g, "/");
    return n.endsWith("/dsh-desktop-host/lib/cli.js");
  });
  return at >= 0 ? { entry: list[at], at } : null;
}

export function restartArgv({
  argv = process.argv,
  findBinRoot = core.findDshBinRoot,
} = {}) {
  const list = Array.isArray(argv) ? argv : [];
  const cli = cliEntryOf(list);
  if (cli) {
    const rest = list.slice(cli.at + 1).filter((arg) => arg !== "--no-open");
    if (!rest.includes("web") && !rest.includes("desktop")) {
      const port = Number(process.env.PORT) || 3080;
      rest.unshift("web", "--port", String(port));
    }
    rest.push("--no-open");
    return ["--expose-internals", cli.entry, ...rest];
  }
  const root = findBinRoot();
  const binJs = root ? path.join(root, "lib", "bin.js") : null;
  if (binJs && fs.existsSync(binJs)) {
    const rest = list.slice(2).filter((arg) => arg !== "--no-open");
    if (!rest.includes("web") && !rest.includes("desktop")) {
      const port = Number(process.env.PORT) || 3080;
      rest.unshift("web", "--port", String(port));
    }
    rest.push("--no-open");
    return [binJs, ...rest];
  }
  const next = list.slice(1).filter((arg) => arg !== "--no-open");
  if (next[0] && /\.(cmd|bat)$/i.test(next[0])) {
    const dir = path.dirname(next[0]);
    const candidates = [
      path.resolve(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      path.resolve(dir, "..", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    ];
    const hit = candidates.find((p) => fs.existsSync(p));
    if (hit) next[0] = hit;
  }
  next.push("--no-open");
  return next;
}

function spawnRestartHelper(helper, payload, exitAfter = 250) {
  try {
    core.silenceCmdFlash();
  } catch {}
  const child = spawn(process.execPath, [helper], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
    env: {
      ...core.envForDetachedSpawn(),
      // 0.2.2+ 的 process.execPath 是 Electron exe；helper 是 node 脚本，
      // 必须以 node 模式拉起。真实 node 进程会忽略这个变量，不影响旧布局。
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || "1",
      DSH_PURGE_RESTART: JSON.stringify(payload),
    },
  });
  child.unref();
  setTimeout(() => process.exit(0), exitAfter);
}

/**
 * @param {object} [request]
 * @param {unknown} [_ctx]
 * @param {{ openBrowser?: boolean }} [options]
 * settle / 自愈重启传 request=null → 默认不弹浏览器，避免关窗后仍被反复拉起新窗口（#59/#61）。
 */
export function scheduleRestart(request, _ctx, options = {}) {
  const openBrowser = options.openBrowser ?? (request != null);
  const helper = fileURLToPath(new URL("./restart-web.js", import.meta.url));
  spawnRestartHelper(helper, {
    kind: "web",
    execPath: process.execPath,
    argv: restartArgv(),
    cwd: process.cwd(),
    host: hostFromRequest(request),
    port: portFromRequest(request),
    pid: process.pid,
    openBrowser: openBrowser !== false,
  });
}

export function scheduleCleanupRestart({ request, restartArgv: argv, cleanup = [] } = {}) {
  const src = fileURLToPath(new URL("./uninstall-restart.js", import.meta.url));
  const dest = path.join(os.tmpdir(), `dsh-purge-uninst-${process.pid}.mjs`);
  fs.copyFileSync(src, dest);
  spawnRestartHelper(dest, {
    kind: "web",
    execPath: process.execPath,
    argv: argv || restartArgv(),
    cwd: process.cwd(),
    host: hostFromRequest(request),
    port: portFromRequest(request),
    cleanup,
    helper: dest,
    openBrowser: request != null,
  }, 400);
}
