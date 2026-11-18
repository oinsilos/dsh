/**
 * 砍掉两个用户须知弹窗（WelcomeNotice / AuthGate）与更新面板残留。
 * 用法：node scripts/cut-notices.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'client.js')
let src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

const before = src
const log = []

/** 从 startMarker 所在行起，删到下一个 marker（不含）为止。 */
function cutUntil(startMarker, stopMarker, note) {
  const lines = src.split('\n')
  const a = lines.findIndex((l) => l.includes(startMarker))
  if (a < 0) throw new Error(`start not found: ${startMarker}`)
  let b = -1
  for (let i = a + 1; i < lines.length; i += 1) {
    if (lines[i].includes(stopMarker)) { b = i; break }
  }
  if (b < 0) throw new Error(`stop not found after ${startMarker}: ${stopMarker}`)
  lines.splice(a, b - a)
  src = lines.join('\n')
  log.push(`${note}: lines ${a + 1}-${b}`)
}

/* 1. 授权常量 + 巨型法律声明 + welcome/drill 存取函数 + syncDrillGrant（整块到 dockBus 前） */
cutUntil('const AUTH_KEY = "dsh-purge-drill-auth";', 'let dockBus = {', 'drop auth/welcome state')

/* 2. requestDrill：不再看授权，直接开 tab */
src = src.replace(
  `\t\t\tif (readDrillAuth()) {
\t\t\t\tsetDock({ open: true, tab: "drill", authOpen: false, pending: "tab" });
\t\t\t\topenNativeTab(DRILL_TAB_KIND);
\t\t\t\ttry { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
\t\t\t\tif (pending === "env") openEnv();
\t\t\t\tif (pending === "full") {
\t\t\t\t\ttry { window.open(window.location.href.split("#")[0] + "#redteam-full", "_blank", "noopener"); } catch { /* ignore */ }
\t\t\t\t}
\t\t\t\treturn;
\t\t\t}
\t\t\t/* 未授权：直接切到演练台页签并弹出授权窗（不再停在清洗页，避免像「没触发」） */
\t\t\tsetDock({ open: true, tab: "drill", authOpen: true, pending: pending });
\t\t\topenNativeTab(DRILL_TAB_KIND);`,
  `\t\t\tsetDock({ open: true, tab: "drill", authOpen: false, pending: "tab" });
\t\t\topenNativeTab(DRILL_TAB_KIND);
\t\t\ttry { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
\t\t\tif (pending === "env") openEnv();
\t\t\tif (pending === "full") {
\t\t\t\ttry { window.open(window.location.href.split("#")[0] + "#redteam-full", "_blank", "noopener"); } catch { /* ignore */ }
\t\t\t}`,
)
log.push('requestDrill simplified')

/* 3. 去掉 syncDrillGrant() 启动调用 */
src = src.replace('\t\t\tsyncDrillGrant();\n', '')
log.push('syncDrillGrant() call removed')

/* 4. 删 WelcomeNotice 整个组件 */
cutUntil('\t\tfunction WelcomeNotice() {', '\t\tfunction AuthGate(props) {', 'drop WelcomeNotice')
/* 4b. AuthGate 直接删到下一个函数 */
cutUntil('\t\tfunction AuthGate(props) {', '\t\tfunction isRedteamPresetId(', 'drop AuthGate')

/* 6. overlay 里不再挂 WelcomeNotice */
src = src.replace('h(react.Fragment, null, h(WelcomeNotice), h(EnvAdaptSendGate))', 'h(EnvAdaptSendGate)')
log.push('overlay simplified')

/* 7. DrillTab：不再看授权，直接渲染 Panel */
src = src.replace(
  `\t\t\tconst [granted, setGranted] = useState(() => readDrillAuth());
\t\t\tuseEffect(() => {
\t\t\t\tconst iv = window.setInterval(() => setGranted(readDrillAuth()), 1200);
\t\t\t\treturn () => window.clearInterval(iv);
\t\t\t}, []);
\t\t\tuseEffect(() => {
\t\t\t\tif (!granted) return;
\t\t\t\ttry { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
\t\t\t}, [granted]);
\t\t\tconst authNode = st.authOpen ? h(AuthGate, { pending: st.pending }) : null;
\t\t\tlet authPortal = null;
\t\t\ttry {
\t\t\t\tconst rd = require("react-dom");
\t\t\t\tif (rd && typeof rd.createPortal === "function" && typeof document !== "undefined" && document.body) {
\t\t\t\t\tauthPortal = rd.createPortal(authNode, document.body);
\t\t\t\t}
\t\t\t} catch { /* host 可能没暴露 react-dom */ }
\t\t\tlet side = null;
\t\t\tif (!granted) {
\t\t\t\tside = h("div", { className: "dshp-side dshp-side-empty" },
\t\t\t\t\th("p", { className: "dshp-mute", style: { margin: 0 } }, t("dock.unauthorized")),
\t\t\t\t\th(Btn, { kind: "primary", onClick: () => setDock({ authOpen: true, pending: "tab" }) }, t("auth.ok")));
\t\t\t} else if (__dshPurgeDrill && __dshPurgeDrill.Panel) {
\t\t\t\tside = h("div", { className: "dshp-side dshp-side-fill" }, h(__dshPurgeDrill.Panel, { embedded: true }));
\t\t\t} else {
\t\t\t\tside = h("div", { className: "dshp-side dshp-side-empty" }, t("dock.unauthorized"));
\t\t\t}
\t\t\treturn h(react.Fragment, null, side, authPortal || authNode);`,
  `\t\t\tuseEffect(() => {
\t\t\t\ttry { if (__dshPurgeDrill && __dshPurgeDrill.setUI) __dshPurgeDrill.setUI({ open: true }); } catch { /* ignore */ }
\t\t\t}, []);
\t\t\tconst side = (__dshPurgeDrill && __dshPurgeDrill.Panel)
\t\t\t\t? h("div", { className: "dshp-side dshp-side-fill" }, h(__dshPurgeDrill.Panel, { embedded: true }))
\t\t\t\t: h("div", { className: "dshp-side dshp-side-empty" }, t("dock.unauthorized"));
\t\t\treturn side;`,
)
log.push('DrillTab simplified')

/* 8. EnvAdaptSendGate 里 readDrillAuth() 一律放行 */
src = src.replace(/\t\t\t\tif \(!readDrillAuth\(\)\) \{\n/g, '\t\t\t\tif (false) {\n')
log.push('EnvAdaptSendGate gate removed')

writeFileSync(file, src)
console.log(log.join('\n'))
console.log('changed:', before !== src)