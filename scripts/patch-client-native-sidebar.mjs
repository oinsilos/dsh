/**
 * client.js 改造：自绘浮动 dock → DSH 原生右侧栏 tab；去掉右下角自绘入口；
 * 应用成功后按钮显示「已应用」；侧栏内排版收紧。
 *
 * 用法：node scripts/patch-client-native-sidebar.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "client.js");
let src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const before = src;

/* ---------------------------------------------------------------- 1. 文案 */
src = src.replace(
  '\t\t\t"btn.apply": "应用",\n\t\t\t"btn.apply.busy": "处理中…",',
  '\t\t\t"btn.apply": "应用",\n\t\t\t"btn.apply.done": "已应用",\n\t\t\t"btn.apply.busy": "处理中…",',
);
src = src.replace(
  '\t\t\t"btn.apply": "Apply",\n\t\t\t"btn.apply.busy": "Working…",',
  '\t\t\t"btn.apply": "Apply",\n\t\t\t"btn.apply.done": "Applied",\n\t\t\t"btn.apply.busy": "Working…",',
);

/* ---------------------------------------------------------------- 2. CSS */
const dropSelectors = [
  /^\.dshp-dock\{position:fixed[^\n]*$/,
  /^\.dshp-dock\[data-open="0"\][^\n]*$/,
  /^\.dshp-dock\{font-family[^\n]*$/,
  /^\.dshp-dock\[data-theme="(white|dusk)"\],\.dshp-dock\[data-theme[^\n]*$/,
  /^\.dshp-dock \.dshp-dock-head[^\n]*$/,
  /^\.dshp-dock \.dshp-dock-tab[^\n]*$/,
  /^\.dshp-launch[^\n]*$/,
  /^\.dshp-dock-head[^\n]*$/,
  /^\.dshp-dock-tabs[^\n]*$/,
  /^\.dshp-dock-tab[^\n]*$/,
  /^\.dshp-dock-resize[^\n]*$/,
  /^\.dshp-hero-chip[^\n]*$/,
  /^\.dshp-tab-chip[^\n]*$/,
  /^\.dshp-tab-btn[^\n]*$/,
];
src = src
  .split("\n")
  .filter((line) => !dropSelectors.some((re) => re.test(line)))
  .join("\n");

/* 主题作用域从 .dshp-dock 改到 .dshp-side */
src = src.replace(/\.dshp-dock\[data-theme="(white|dusk)"\]/g, '.dshp-side[data-theme="$1"]');
/* 面板正文作用域：.dshp-dock-body → .dshp-side */
src = src.split(".dshp-dock-body").join(".dshp-side");

/* 新增侧栏容器样式，插在 .dshp-root 第一条规则之前 */
const SIDE_CSS = `.dshp-side{display:flex;flex-direction:column;height:100%;min-height:0;background:transparent;color:var(--dshp-ink);font-family:var(--dshp-sans)}
.dshp-side-scroll{overflow:auto}
.dshp-side-fill{overflow:hidden}
.dshp-side .dshp-root{max-width:none;height:auto;padding:12px;gap:14px;border-radius:0;background:transparent}
.dshp-side-empty{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:16px}
.dshp-side-entry{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,currentColor);cursor:pointer;font:12px/1 inherit}
.dshp-side-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,currentColor)}
.dshp-side-entry-mark{font-size:13px;line-height:1}
`;
src = src.replace(
  '\t\t.dshp-root{--dshp-display:',
  `\t\t${SIDE_CSS}\n.dshp-root{--dshp-display:`,
);

/* 侧栏变窄后的排版 */
src = src.replace(
  ".dshp-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:14px}",
  ".dshp-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px;margin-bottom:14px}",
);
src = src.replace(
  ".dshp-panel{border:1px solid var(--dshp-line);background:var(--dshp-paper);border-radius:10px;padding:18px 18px 16px}",
  ".dshp-panel{border:1px solid var(--dshp-line);background:var(--dshp-paper);border-radius:10px;padding:14px 14px 12px}",
);
src = src.replace(
  ".dshp-title{font-family:var(--dshp-display);font-size:20px;",
  ".dshp-title{font-family:var(--dshp-display);font-size:17px;",
);
src = src.replace(
  ".dshp-table{width:100%;border-collapse:collapse;font-size:12.5px}",
  ".dshp-table{width:100%;border-collapse:collapse;font-size:12px}",
);
src = src.replace(
  ".dshp-table td{padding:8px 12px;",
  ".dshp-table td{padding:6px 10px;",
);
src = src.replace(".dshp-area{min-height:220px;resize:vertical}", ".dshp-area{min-height:170px;resize:vertical}");

/* ---------------------------------------------------------------- 3. 组件 */
const START = "\t\tfunction PurgeDock() {";
const END = "\t\tfunction installRewindUi(ctx) {";
const from = src.indexOf(START);
const to = src.indexOf(END);
if (from < 0 || to < 0 || to <= from) throw new Error("PurgeDock region anchors not found");

const NEW = `\t\t/* ── 原生右侧栏接入：不再自绘浮动面板与右下角按钮 ─────────────── */
\t\tlet sidebarRightRef = null;
\t\tconst PURGE_TAB_KIND = "dshPurge";
\t\tconst PURGE_TAB_ID = "@local/dsh-purge/clean";
\t\tconst DRILL_TAB_KIND = "dshDrill";
\t\tconst DRILL_TAB_ID = "@local/dsh-purge/drill";

\t\tfunction openNativeTab(kind) {
\t\t\tconst right = sidebarRightRef;
\t\t\tif (!right || typeof right.openTab !== "function") return false;
\t\t\ttry { right.openTab(kind); return true; } catch { /* 没有已挂载的会话面 */ }
\t\t\treturn false;
\t\t}

\t\t/** 清洗页：补丁 / 提示词 / 规则集 / 技能，直接铺在原生侧栏里。 */
\t\tfunction CleanTab() {
\t\t\tconst t = useT();
\t\t\treturn h("div", { className: "dshp-side dshp-side-scroll" }, h(SettingsRoot, { t: t }));
\t\t}

\t\t/** 演练台页：未授权时给一句说明 + 授权入口，其余交给内嵌 Panel。 */
\t\tfunction DrillTab() {
\t\t\tconst t = useT();
\t\t\tconst st = useDock();
\t\t\tconst [granted, setGranted] = useState(() => readDrillAuth());
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
\t\t\treturn h(react.Fragment, null, side, authPortal || authNode);
\t\t}

\t\t/** 原生侧栏底部入口（与红队控制台同一套 sidebar.footer.action 席）。 */
\t\tfunction SidebarEntry(props) {
\t\t\treturn h("button", {
\t\t\t\ttype: "button",
\t\t\t\tclassName: "dshp-side-entry",
\t\t\t\ttitle: "dsh-purge",
\t\t\t\tonClick: () => openNativeTab(PURGE_TAB_KIND),
\t\t\t},
\t\t\t\th("span", { className: "dshp-side-entry-mark", "aria-hidden": "true" }, "◈"),
\t\t\t\tprops && props.wide ? h("span", null, "dsh-purge") : null);
\t\t}

\t\t/** 两个 tab 类型 + 正文席位 + 侧栏入口，全部走原生服务。 */
\t\tfunction installSidebarTabs(ctx) {
\t\t\tsidebarRightRef = ctx.sidebarRight || null;
\t\t\tconst tabs = ctx.sidebarRightTabs;
\t\t\tif (!tabs || typeof tabs.register !== "function") return;
\t\t\tctx.effect(() => tabs.register({
\t\t\t\tid: PURGE_TAB_ID,
\t\t\t\tkind: PURGE_TAB_KIND,
\t\t\t\tpriority: "extension",
\t\t\t\ttitle: () => "dsh-purge",
\t\t\t\tguide: [{
\t\t\t\t\tid: "dsh-purge-clean",
\t\t\t\t\torder: 60,
\t\t\t\t\ttitle: () => "dsh-purge 清洗",
\t\t\t\t\tdescription: () => "补丁状态、提示词与规则集、技能库",
\t\t\t\t}],
\t\t\t}), "dsh-purge: clean tab type");
\t\t\tctx.effect(() => tabs.register({
\t\t\t\tid: DRILL_TAB_ID,
\t\t\t\tkind: DRILL_TAB_KIND,
\t\t\t\tpriority: "extension",
\t\t\t\ttitle: () => "演练台",
\t\t\t\tguide: [{
\t\t\t\t\tid: "dsh-purge-drill",
\t\t\t\t\torder: 61,
\t\t\t\t\ttitle: () => "红队演练台",
\t\t\t\t\tdescription: () => "资产测绘、会话隧道、漏洞战果、得分与报告",
\t\t\t\t}],
\t\t\t}), "dsh-purge: drill tab type");
\t\t\tctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
\t\t\t\tname: "sidebar.right.pane.tab", key: PURGE_TAB_ID, locale: NS,
\t\t\t}, CleanTab));
\t\t\tctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
\t\t\t\tname: "sidebar.right.pane.tab", key: DRILL_TAB_ID, locale: NS,
\t\t\t}, DrillTab));
\t\t\tctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
\t\t\t\tname: "sidebar.footer.action", id: "dsh-purge-entry", order: 40, label: "dsh-purge",
\t\t\t}, SidebarEntry));
\t\t}

`;

src = src.slice(0, from) + NEW + src.slice(to);

/* ---------------------------------------------------------------- 4. 入口路由 */
src = src.replace(
  `\t\tfunction requestDrill(kind) {
\t\t\tconst pending = kind || "tab";
\t\t\tconst openEnv = () => {
\t\t\t\ttry {
\t\t\t\t\tif (__dshPurgeDrill && __dshPurgeDrill.setUI) {
\t\t\t\t\t\t__dshPurgeDrill.setUI({ open: true, tab: "env" });
\t\t\t\t\t}
\t\t\t\t} catch { /* ignore */ }
\t\t\t};
\t\t\tif (readDrillAuth()) {
\t\t\t\tsetDock({ open: true, tab: "drill", authOpen: false, pending: "tab" });`,
  `\t\tfunction requestDrill(kind) {
\t\t\tconst pending = kind || "tab";
\t\t\tconst openEnv = () => {
\t\t\t\ttry {
\t\t\t\t\tif (__dshPurgeDrill && __dshPurgeDrill.setUI) {
\t\t\t\t\t\t__dshPurgeDrill.setUI({ open: true, tab: "env" });
\t\t\t\t\t}
\t\t\t\t} catch { /* ignore */ }
\t\t\t};
\t\t\tif (readDrillAuth()) {
\t\t\t\tsetDock({ open: true, tab: "drill", authOpen: false, pending: "tab" });
\t\t\t\topenNativeTab(DRILL_TAB_KIND);`,
);
src = src.replace(
  `\t\t\tsetDock({ open: true, tab: "drill", authOpen: true, pending: pending });
\t\t}

\t\tfunction requestDrillEnv() {`,
  `\t\t\tsetDock({ open: true, tab: "drill", authOpen: true, pending: pending });
\t\t\topenNativeTab(DRILL_TAB_KIND);
\t\t}

\t\tfunction requestDrillEnv() {`,
);
src = src.replace(
  `\t\tfunction openDockClean() {
\t\t\tsetDock({ open: true, tab: "clean", authOpen: false, pending: "tab" });
\t\t}
\t\tfunction toggleDock() {
\t\t\tif (dockBus.open) setDock({ open: false, authOpen: false, pending: "tab" });
\t\t\telse openDockClean();
\t\t}`,
  `\t\tfunction openDockClean() {
\t\t\tsetDock({ open: true, tab: "clean", authOpen: false, pending: "tab" });
\t\t\topenNativeTab(PURGE_TAB_KIND);
\t\t}`,
);

/* 授权通过后打开原生演练台 tab */
src = src.replace(
  `\t\t\t\t\t\t\t\twriteDrillAuth(true);
\t\t\t\t\t\t\t\tconst kind = props.pending || "tab";
\t\t\t\t\t\t\t\tsetDock({ authOpen: false, open: true, tab: "drill", pending: "tab" });`,
  `\t\t\t\t\t\t\t\twriteDrillAuth(true);
\t\t\t\t\t\t\t\tconst kind = props.pending || "tab";
\t\t\t\t\t\t\t\tsetDock({ authOpen: false, open: true, tab: "drill", pending: "tab" });
\t\t\t\t\t\t\t\topenNativeTab(DRILL_TAB_KIND);`,
);

/* ---------------------------------------------------------------- 5. overlay 只留全局弹窗与发送闸门 */
src = src.replace(
  '\t\t\t}, () => h(react.Fragment, null, h(WelcomeNotice), h(PurgeLauncher), h(PurgeDock), h(HeroNewSessionMount), h(TabRowPurgeMount), h(EnvAdaptSendGate))));',
  '\t\t\t}, () => h(react.Fragment, null, h(WelcomeNotice), h(EnvAdaptSendGate))));',
);

/* 注册原生侧栏 tab（软注入：宿主没有该服务时静默跳过） */
src = src.replace(
  `\t\t\t\ttry { console.warn("[dsh-purge] rewind ui skipped:", e2 || e); } catch { /* ignore */ }
\t\t\t}
\t\t}
\t}`,
  `\t\t\t\ttry { console.warn("[dsh-purge] rewind ui skipped:", e2 || e); } catch { /* ignore */ }
\t\t\t}
\t\t}
\t\ttry {
\t\t\tif (typeof ctx.inject === "function") {
\t\t\t\tctx.inject(["sidebarRightTabs", "sidebarRight", "slots"], (host) => installSidebarTabs(host));
\t\t\t} else if (ctx.sidebarRightTabs) {
\t\t\t\tinstallSidebarTabs(ctx);
\t\t\t}
\t\t} catch (e) {
\t\t\ttry { console.warn("[dsh-purge] sidebar tab skipped:", e); } catch { /* ignore */ }
\t\t}
\t}`,
);

/* ---------------------------------------------------------------- 6. 应用后按钮显示「已应用」 */
src = src.replace(
  "\t\t\tconst [patchBusy, setPatchBusy] = useState(false);",
  "\t\t\tconst [patchBusy, setPatchBusy] = useState(false);\n\t\t\tconst [justApplied, setJustApplied] = useState(false);",
);
src = src.replace(
  `\t\t\t\t\t\t\tif (action === "apply") {
\t\t\t\t\t\t\t\tsetNotice({ kind: "ok", text: tr("ok.done") });`,
  `\t\t\t\t\t\t\tif (action === "apply") {
\t\t\t\t\t\t\t\tsetJustApplied(true);
\t\t\t\t\t\t\t\tsetNotice({ kind: "ok", text: tr("ok.done") });`,
);
src = src.replace(
  `\t\t\t\t\t\tif (d && d.ok) {
\t\t\t\t\t\t\tsetState(d);
\t\t\t\t\t\t\tif (d.channel) setChannel(d.channel);`,
  `\t\t\t\t\t\tif (d && d.ok) {
\t\t\t\t\t\t\tsetState(d);
\t\t\t\t\t\t\tif ((Number(d.patches_pending) || 0) > 0) setJustApplied(false);
\t\t\t\t\t\t\tif (d.channel) setChannel(d.channel);`,
);
src = src.replace(
  '\t\t\t\t\th(Btn, { kind: "primary", disabled: patchBusy || uninstallBusy || !overrideLoaded, onClick: () => doAction("apply", "action.apply") }, patchBusy ? t("btn.apply.busy") : t("btn.apply")),',
  '\t\t\t\t\th(Btn, { kind: "primary", disabled: patchBusy || uninstallBusy || !overrideLoaded, onClick: () => doAction("apply", "action.apply") }, patchBusy ? t("btn.apply.busy") : ((justApplied || (s && s.ai_base && (Number(s.patches_pending) || 0) === 0 && (Number(s.patches_applied) || 0) > 0)) ? t("btn.apply.done") : t("btn.apply"))),',
);

if (src === before) throw new Error("no change applied");
writeFileSync(file, src);
console.log("patched client.js for native sidebar");