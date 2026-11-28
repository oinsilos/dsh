/**
 * Our Free Model — browser half.
 *
 * Contributes three things to the web shell:
 *   1. a settings section (`settings.section` id `our-free-model`) holding the
 *      model roster with live availability, the usage dashboard, the OpenAI
 *      forward listener and the plugin's own switches;
 *   2. a first-run announcement (`settings.onboarding`) that is versioned, so
 *      bumping the copy re-announces once and never nags again;
 *   3. nothing else — no shadowing of the stock model picker, whose grouping by
 *      provider route is exactly the mechanism this plugin uses for its tag.
 *
 * Data is read over the plugin's own same-origin `/api/our-free-model/*` routes
 * rather than a typed Remote binding, because those routes are served by the same
 * host process on every kernel line this plugin targets.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: '@oinsilos/dsh-model-manager',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback } = React
    // `react-dom` is a platform seed word in the DSH shell (its boot graph maps
    // react, react/jsx-runtime, react-dom and react-dom/client), which is what
    // lets a plugin put a surface outside `#root` without a build step. Resolved
    // defensively: an older shell — or the headless lint harness — may not offer
    // it, and every surface below falls back to rendering in place.
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (typeof reactDom?.createPortal === 'function') createPortal = reactDom.createPortal
    } catch { createPortal = null }

    const NS = 'settings.ourFreeModel'
    const inject = ['slots', 'locale']

    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        'meta.title': 'Model Manager',
        'meta.description': '在 DeepSeek Harness 内直连免密免费模型：清单随上游更新、地区可用性自动探测、思考强度真实生效，并附 Token 看板与 OpenAI 兼容转发端口。',
        'ann.pitch': '你只需在 dsh 里装上这个插件，无需登录、注册、填 API Key 或任何其它操作，就能用上包括 Muse Spark 1.3、MiMo V2.6 在内的前沿模型——完全免费，不限量。',
        nav: 'Model Manager',
        'nav.panel': '模型',
        'panel.open': '模型面板',
        'panel.title': '模型面板',
        'panel.providers': '提供商',
        'panel.allModels': '免费模型',
        'panel.laneFree': '免费车道',
        'panel.laneAggregate': '聚合渠道',
        'panel.providerModels': '这个渠道共有 {n} 个模型',
        'panel.searchProvider': '搜索提供商',
        'panel.searchModel': '搜索模型名称或 ID',
        'panel.noProvider': '没有匹配的提供商',
        'panel.noMatch': '没有匹配的模型',
        'panel.noModel': '这个渠道还没有模型',
        'panel.noModelHint': '可以在设置页的「账号渠道」里登录或刷新目录。',
        'panel.selectModel': '选择模型',
        'panel.noModels': '该提供商暂无可用模型。',
        'panel.tab.models': '模型',
        'panel.tab.routes': '路由分组',
        'panel.tab.failed': '失败模型',
        'panel.routes.empty': '还没有路由分组。到「模型路由」页签新建一个，它就会出现在这里，也能在模型列表里当模型选。',
        'panel.routes.use': '用这个分组',
        'panel.routes.edit': '编辑',
        'panel.routes.failedMark': '失败',
        'panel.routes.groups': '分组',
        'panel.routes.nameHint': '新分组名',
        'panel.routes.create': '新建',
        'panel.routes.delete': '删除分组',
        'panel.routes.remap': '修复失效成员',
        'panel.routes.remapDone': '已修复 {n} 个成员的模型坐标。',
        'panel.routes.remapLeft': '仍有 {n} 个成员在本机目录里找不到，已保留原样。',
        'panel.routes.noMembers': '这个分组还没有成员。',
        'panel.routes.addHint': '点右下角「添加模型」从当前目录里挑。',
        'panel.routes.add': '添加模型',
        'panel.routes.addClose': '收起添加',
        'panel.routes.addSearch': '搜索模型名称或 ID',
        'panel.routes.added': '已加入',
        'panel.routes.pickAll': '全选',
        'panel.routes.pickNone': '取消全选',
        'panel.routes.pickClear': '清空',
        'panel.routes.bulkAdd': '添加 {n} 个',
        'panel.routes.bulkHint': '勾选多个一次加入；新成员排在组末（优先级 = 现有最大值 + 10）',
        'panel.routes.missing': '目录缺失',
        'panel.routes.priority': '优先级（越小越先）',
        'panel.routes.enable': '启用',
        'panel.routes.disable': '停用',
        'panel.routes.members': '{n} 个成员',
        'panel.failed.empty': '今天没有被熔断的模型。',
        'panel.failed.why': '{code} · {reason}',
        'panel.failed.reset': '恢复',
        'panel.failed.resetAll': '全部恢复',
        'panel.failed.cooldown': '清冷却',
        'panel.failed.hint': '路由分组里的成员失败会被记在这里，当天内不再重试；恢复后立刻可以再被选中。',
        'panel.tab.dashboard': '数据看板',
        'panel.settingsTitle': '模型设置',
        'panel.close': '关闭',
        'panel.current': '当前',
        'panel.sessionRequired': '先打开一个会话，再选择模型。',
        'panel.settingsLink': '完整设置',
        'panel.failedProviders': '有 {n} 个提供商的目录没加载出来，其余照常可用。',
        'panel.hiddenUnavailable': '已按设置折叠 {n} 个不可用模型（可在「免费模型 → 偏好」里改）。',
        'panel.unavailableDropped': '{n} 个模型探测为不可用，宿主选择器里不再列出；到「免费模型 → 重新探测可用性」可以复测。',
        'panel.hiddenAll': '这一家的模型都被折叠了',
        'panel.hiddenAllHint': '探测结论都不是「可用」。关掉「偏好」里的「模型面板里隐藏不可用的模型」就能看到它们。',
        'panel.dockOpen': '模型面板',
        'compact.chip': '自动压缩',
        'compact.quickHint': '上下文占用达到窗口的这个比例时自动压缩；松手即保存并立即生效。',
        'compact.restore': '恢复默认',
        'compact.openPanel': '在管线中调整',
        'compact.saved': '阈值已保存',
        'compact.saveFailed': '阈值保存失败',
        'ann.openPanel': '打开模型面板',
        'llmretry.title': '请求重试',
        'llmretry.hint': '命中规则后休眠再重发。规则支持 HTTP 状态码、机器码、field=value 和 msg~片段。',
        'llmretry.rules': '规则',
        'llmretry.code': '匹配表达式',
        'llmretry.delay': '休眠（秒）',
        'llmretry.maxRetries': '最多重试',
        'llmretry.add': '新增规则',
        'llmretry.save': '保存',
        'llmretry.saved': '已保存并立即生效',
        'llmretry.saveFailed': '保存失败',
        'llmretry.source': '来源',
        'llmretry.waiting': '休眠中',
        'llmretry.events': '最近活动',
        'llmretry.noEvents': '还没有事件',
        'llmretry.honor': 'Retry-After 采信上限（秒）',
        'llmretry.honorHint': '0 = 忽略服务端提示；默认 10 秒。',
        'llmretry.firstToken': '首字超时',
        'llmretry.firstTokenHint': '请求发出后多久没有第一个输出就中断。',
        'llmretry.enabled': '启用',
        'llmretry.seconds': '秒',
        'llmretry.notMultimodal': '不支持多模态时',
        'llmretry.offload': '自动省略图片',
        'llmretry.maxNotices': '每轮最多提示',
        'llmretry.emptyRules': '没有规则：所有失败直接上报。',
        'llmretry.badNumber': '请输入有效数字。',
        title: 'Model Manager',
        refresh: '刷新清单',
        reprobe: '重新探测可用性',
        probing: '探测中…',
        loading: '正在加载…',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        'state.available': '可用',
        'state.region-blocked': '地区受限',
        'state.unavailable': '暂不可用',
        'state.throttled': '限流中',
        'state.unknown': '未探测',
        'hint.region': '该模型按出口地区放行。开启网络代理后，插件会在下一次探测自动把它移入可用分组。',
        'hint.throttled': '上游正在限流（额度或速率），属于可恢复的临时状态；插件会在下一轮探测自动复测，限流期间选中它大概率失败。',
        'hint.unknown': '尚未探测，默认保持可达。',
        'hint.hidden': '探测显示网关点名了它却不路由它，因此已从模型选择器中移除；某一次探测重新通过，它会自己回来。',
        'hint.sharedBudget': '该模型思考不可关闭：思考与可见回答共用同一份额度，档位越低留给正文的越少。',
        'tag.vision': '视觉',
        'tag.text': '纯文本',
        'tag.thinking': '可调思考',
        'tag.thinkingShared': '思考不可关',
        'tag.rung': '默认档上限',
        'tag.rungTitle': '各档位实际发出的输出上限：{ladder}。档位是思考与回答共用的额度，且不会超过上面的最长输出与设置里的单次上限。',
        'tag.context': '上下文',
        'tag.output': '最长输出',
        'tag.latency': '首字',
        'tag.eacChannel': 'EAC 渠道 · 协付',
        'tag.kiloChannel': 'Kilo 渠道 · 免费池（prompt 可能被上游记录用于改进服务，勿发送敏感内容）',
        'roster.noLane': 'EAC 协付模型在当前运行环境不可用：宿主未提供可识别的桌面 / Web 配置，因此不加载该渠道。',
        'section.models': '模型清单',
        'section.modelsHint': '名称与能力来自上游清单与公开能力表，可用性由本机出口实测得出。',
        'section.dash': '用量看板',
        'section.dashHint': '数据只写入本机，不会上传。',
        'pool.levelOk': '畅通',
        'pool.levelBusy': '繁忙',
        'pool.capacity': '号池容量',
        'pool.levelOver': '过载',
        'pool.reach': '容量占用',
        'pool.formula': 'Star {stars} × 1.5',
        'pool.configured': '按实际配号数',
        'pool.active': '24h 活跃',
        'pool.live': '进行中',
        'pool.unavailable': '号池数据暂不可用 · {reason}',
        'pool.reasonNoLane': '当前运行环境未解锁协付车道',
        'pool.reasonGateway': '网关应答异常',
        'pool.reasonMalformed': '网关数据异常',
        'pool.reasonUnreachable': '网关暂不可达',
        'pool.reasonUnknown': '原因未知',
        'pool.capacityUnknown': 'Star 数据暂不可用',
        'section.eac': 'EAC 渠道授权',
        'section.eacHint': 'EAC（协付）模型需要 GitHub 登录并 star 仓库；免费车道的模型不受影响。',
        'eac.pillOk': '已授权',
        'eac.pillLocked': '未授权',
        'eac.pillRequired': '已开启强制',
        'eac.pillCompat': '兼容期',
        'eac.pillUnknown': '授权策略未确认',
        'eac.pollFailed': '领取授权失败（{reason}），正在自动重试；无需重新授权。',
        'eac.saveFailed': '授权已完成，但本机无法保存登录记录。请检查 DSH_HOME 目录权限；修复后将自动重试。',
        'eac.cancel': '取消此次登录',
        'eac.cancelFailed': '无法确认取消登录，请稍后重试。',
        'eac.pillUnverified': '网关暂不可达',
        'eac.intro': 'EAC 渠道的对话在服务器侧校验授权：用 GitHub 登录，并给 {repo} 点一个 Star，即可解锁。登录在浏览器里完成，无需复制粘贴；取消 Star 后授权会自动失效。',
        'eac.login': '使用 GitHub 登录',
        'eac.starting': '正在打开浏览器…',
        'eac.waiting': '已打开浏览器授权页；若没有自动打开，请手动访问下面的地址完成授权。完成后本页会自动确认。',
        'eac.copy': '复制链接',
        'eac.copied': '已复制',
        'eac.done': '授权成功：@{login}，现在可以使用 EAC 模型了。',
        'eac.needStar': '已用 @{login} 登录，但还没有 star 仓库；请先 Star，再在授权页点「我已 star，重新检查」。',
        'eac.expired': '这次登录等待超时了，请重新发起。',
        'eac.sessionExpired': '登录链接已失效（服务器不再认识它），请重新发起 GitHub 登录。',
        'eac.openManually': '浏览器没有自动打开，请手动访问下面的地址完成授权。',
        'eac.startFailed': '无法发起登录（{reason}）。',
        'eac.gatewayGone': 'EAC 网关已不提供登录接口（服务端下线或改版），车道暂不可用；客户端无法修复，等网关恢复后再试。',
        'eac.browserSpawned': '已尝试打开系统浏览器；没弹出来的话，直接复制下方链接到浏览器打开。',
        'eac.loggedIn': '已授权：@{login} · 上次复查 {when}',
        'eac.recheck': '重新检查',
        'eac.logout': '退出登录',
        'eac.noLane': '当前运行环境未解锁 EAC 协付车道，无法进行 GitHub 授权。',
        'eac.lockedTitle': '需要 GitHub 授权并 star 仓库后使用',
        'eac.lockedNote': '未授权：点下方按钮用 GitHub 登录并 star 仓库，或到「EAC 渠道授权」区完成。',
        'section.forward': '本地转发（OpenAI 兼容）',
        'section.forwardHint': '让其它本地工具用一个 base URL 调用这些模型。',
        'section.pool': '对外入口（一个名字，自动重试与切换）',
        'section.poolHint': '勾选一批模型合成一个入口名给网关：外部只填这一个，内部自动挑最快可用的、失败原地重试、无法重试就换下一个。',
        'pool.name': '入口名',
        'pool.nameHint': '客户端里 `model` 就填这个名字。当前目录 id：{id}',
        'pool.enabled': '启用对外入口',
        'pool.strategy': '挑人顺序',
        'pool.strategySmart': '智能排序',
        'pool.strategyFallback': '固定顺序',
        'pool.strategyRoundRobin': '轮询',
        'pool.stickyLimit': '轮询粘滞（连续几次）',
        'pool.memberRetries': '每个模型原地重试次数',
        'pool.hideOthers': '网关只暴露这个入口名',
        'pool.hideOthersHint': '开启后客户端 `/v1/models` 只看到这一个名字；想精确指定某模型时关掉。只影响网关，不影响本机选择器。',
        'pool.membersTitle': '候选模型（共 {n} 个，顺序即优先级）',
        'pool.membersEmpty': '尚未勾选模型。从下方列表点选，至少一个才会在网关生效。',
        'pool.testMember': '测',
        'pool.testMemberHint': '真实调用一次（最多 32 tokens），确认这个成员现在能不能用',
        'pool.probing': '测试中…',
        'pool.probeOk': '可用',
        'pool.probeFail': '不可用',
        'pool.addMember': '勾选模型',
        'pool.searchModel': '搜索模型名或 id',
        'pool.noModel': '没有匹配的模型。',
        'pool.todayStats': '今日 {calls} 次 · 失败 {failed} · 首字 {ttft}',
        'pool.selectedCount': '已选 {n} 个',
        'pool.groupCount': '{n} 个',
        'pool.refreshCatalog': '刷新目录',
        'pool.sourceRegistry': '预置',
        'pool.sourceRegistryHint': '来自该提供商的注册表模板，不一定真实可用；点「发现模型」拉取真实清单后再勾选。',
        'pool.sourceDiscovered': '已发现',
        'pool.todayShort': '今日 {calls} 次 / 失败 {failed}',
        'pool.unavailable': '当前不可用',
        'pool.unavailableHint': '这个模型此刻不在目录里，保存后会被剔除。',
        'pool.unresolvedHint': '{n} 个勾选的模型此刻不可用，保存后它们会被剔除。',
        'pool.exampleTitle': '客户端怎么填',
        'pool.exampleHint': '外部工具只改 base URL 和这一个模型名，其余照常。',
        'pool.unsaved': '有未保存的改动。',
        'pool.saved': '已保存。',
        'pool.savedRenamed': '已保存。入口名从「{from}」改为「{to}」，旧配置里的名字已失效，需要同步修改。',
        'common.loading': '加载中…',
        'common.saving': '保存中…',
        'common.save': '保存',
        'section.egress': '出口代理（订阅分流）',
        'section.egressHint': '把推理与探测请求从代理出口发出，缓解按 IP 的频率限制。',
        'egress.enabled': '启用出口',
        'egress.modeSubscription': '订阅模式（本地 mihomo 自动测速分流）',
        'egress.url': '订阅 / 代理 URL',
        'egress.urlNew': '替换订阅地址',
        'egress.urlPlaceholder': '粘贴新的订阅 / 代理地址（留空则保持当前不变）',
        'egress.urlNone': '未设置',
        'egress.urlClear': '清除',
        'egress.urlClearWarn': '清除本机保存的订阅 / 代理地址，并关闭出口',
        'egress.mihomoPath': 'mihomo 路径',
        'egress.mihomoHint': '订阅模式留空则自动查找本机 mihomo（如 Clash Verge）。',
        'egress.apply': '应用',
        'egress.active': '出口生效中',
        'egress.inactive': '未启用',
        'egress.outlet': '当前出口',
        'egress.node': '当前最佳节点',
        'egress.latency': '访问 opencode',
        'egress.measuring': '测量中…',
        'egress.direct': '关闭时请求直连发出；订阅地址按密钥对待——只存在本机设置里，不随常规接口数据下发，仅点「显示」时读取，面板默认打码。',
        'egress.error': '出口启动失败：{message}',
        'section.prefs': '插件设置',
        'section.prefsHint': '改动在下一次加载完全生效。',
        'heat.title': 'Token 热力图',
        'heat.legend': '少',
        'heat.legendMore': '多',
        'heat.empty': '还没有用量记录。用一次对话后回来看看。',
        'curve.title': '总量曲线',
        'curve.tokens': 'Token',
        'curve.requests': '请求数',
        'curve.total': '总计',
        'stat.output': '输出 Token',
        'stat.reasoning': '推理 Token',
        'col.reason': '推理',
        'col.output': '输出',
        'last.title': '最近一回合',
        'last.justNow': '刚刚',
        'last.minAgo': '{n} 分钟前',
        'last.hourAgo': '{n} 小时前',
        'last.dayAgo': '{n} 天前',
        'last.input': '输入',
        'last.originChat': '对话',
        'last.originHarness': '桌面',
        'last.originForward': '转发',
        'last.originBench': '测速',
        'speed.title': '速度',
        'speed.tps': '输出速度',
        'speed.ttft': '首帧延迟',
        'speed.model': '模型',
        'speed.calls': '上游请求',
        'speed.failed': '请求失败',
        'speed.turns': '对话回合',
        'speed.turnFailed': '回合失败',
        'speed.recovered': '已恢复',
        'speed.estimated': '升级前历史按上游请求估算；升级后回合按最终结果精确记录。',
        'speed.scope': '请求、回合和 Token 为累计；速度和首帧按最近 40 次调用计算，热力图按天汇总。',
        'speed.none': '暂无样本',
        'speed.note': '输出速度只统计 {n}/{total} 次可测的调用：那些没流式送出的思考 token 不计入分子，解码窗口短到测不出的也不算。',
        'unit.tokPerSec': 'tok/s',
        'unit.ms': 'ms',
        'forward.enabled': '启用转发端口',
        'forward.host': '监听地址',
        'forward.port': '端口',
        'forward.apply': '应用',
        'settings.failed': '设置未保存',
        'forward.running': '正在监听',
        'forward.stopped': '未启用',
        'forward.baseUrl': 'Base URL',
        'forward.key': 'API Key',
        'forward.show': '显示',
        'forward.hide': '隐藏',
        'forward.rotate': '重新生成',
        'forward.rotateWarn': '重新生成后，所有使用旧 Key 的工具都会失效。',
        'forward.copy': '复制',
        'forward.copied': '已复制',
        'forward.example': '调用示例',
        'forward.error': '启动失败：{message}',
        'forward.notice': '端口提示：{message}',
        'forward.lanTitle': '局域网访问',
        'forward.lanHint': '让同一网络里的其它设备也用这个转发端口。默认关闭；开启后中继需要一把单独的 Key。',
        'forward.lanEnabled': '允许局域网访问',
        'forward.lanPort': '局域网端口',
        'forward.lanAuto': '0 = 自动分配',
        'forward.lanApply': '应用局域网设置',
        'forward.lanRunning': '局域网中继已监听',
        'forward.lanStopped': '局域网中继未启用',
        'forward.lanError': '局域网中继启动失败：{message}',
        'forward.lanKey': '局域网 Key',
        'forward.lanRotateWarn': '重新生成后，局域网里的设备都要换新 Key；本机工具不受影响。',
        'forward.lanWarn': '开启后，能连到这台机器的任何人都可以用这个 Key 花掉本机的免费额度。请只在信任的网络里开启，必要时用防火墙限制来源。',
        'forward.lanUrl': '局域网地址',
        'forward.lanNoAddress': '没有检测到局域网 IPv4 地址',
        'forward.lanAlso': '其它地址：{list}',
        'pref.enabled': '启用免费模型',
        'pref.exposeRegion': '展示地区受限模型',
        'pref.hideChannels': '隐藏渠道模型分组',
        'pref.hideUnavailable': '模型面板里隐藏不可用的模型',
        'pref.hideUnavailableHint': '开启后，探测为不可用、地区受限或限流的模型仍留在宿主选择器里，只是不在本插件的模型面板里列出；页脚会注明折叠了几行。',
        'pref.interval': '自动探测间隔（分钟）',
        'pref.maxTokens': '单次输出上限（token）',
        'pref.egress': '当前出口',
        'pref.probedAt': '最近探测',
        'bench.run': '测一次',
        'bench.running': '测量中…',
        'bench.result': '首帧 {ttft}ms · 输出 {tps} tok/s · 推理 {reasoning} tok',
        'ann.preamble': '前言',
        'ann.models': '模型清单',
        'ann.steps': '使用步骤',
        'ann.features': '功能介绍',
        'ann.later': '稍后再说',
        'ann.page': '第 {n} / {total} 页',
        'ann.openSettings': '打开设置页',
        'ann.p1': '免密：安装即可用，不需要注册、不需要填任何 API Key。',
        'ann.p2': '清单跟随上游：模型集合、上下文长度与能力每次刷新都重新拉取。',
        'ann.p3': '诚实的能力声明：探测不出来的能力不会显示，思考强度档位是真实生效的输出预算上限。',
        'ann.s1': '在输入框的模型选择器里选 “Model Manager” 分组下的任意模型。',
        'ann.s2': '需要更强推理时点开 Effort 档位；它是真实下发的输出预算，不是提示词。',
        'ann.s3': '想被其它本地工具调用：设置页 → 本地转发 → 启用，把 Base URL 和 Key 填进去。',
        'ann.s4': '地区受限模型会在你切换网络出口后自动重新归类，无需手动操作。',
        'ann.f1': '模型清单：可用性、上下文长度、是否支持视觉、是否可调思考。',
        'ann.f2': 'Token 热力图与总量曲线，支持总计与按模型分别查看。',
        'ann.f3': '输出速度（tok/s）与首字延迟（TTFT）逐次采样。',
        'ann.f4': 'OpenAI 兼容转发端口 + 可生成的 API Key。',
        'ann.f5': '全部数据留在本机，不上传任何遥测。',
        'ann.updates': '公告与升级',
        'ann.u1': '重要公告：urgent 级别的公告会全屏弹窗提醒（其余走系统通知）。',
        'ann.u2': '系统通知：开启后，新公告与插件更新会弹出系统级通知。',
        'news.urgentTitle': '重要公告',
        'news.gotIt': '知道了',
        'level.info': '通知',
        'level.update': '更新',
        'level.warn': '注意',
        'level.urgent': '紧急',
        'upgrade.current': '运行版本',
        'upgrade.installed': '磁盘版本',
        'upgrade.mismatch': '运行版本与磁盘版本不一致，请先确认安装状态，再重载或重启。',
        'upgrade.recovery': '上次升级未完整恢复。请关闭应用，使用保留的备份恢复安装目录，重新启动后检查更新。',
        'upgrade.backup': '恢复备份',
        'upgrade.latest': '最新版本',
        'upgrade.checkedAt': '上次检查',
        'upgrade.never': '从未检查',
        'upgrade.check': '检查更新',
        'upgrade.checking': '检查中…',
        'upgrade.upToDate': '已是最新版本',
        'upgrade.available': '可升级到 {version}',
        'upgrade.apply': '立即升级',
        'upgrade.applying': '升级中…',
        'upgrade.phase.download': '正在下载新版本…',
        'upgrade.phase.install': '正在安装文件…',
        'upgrade.phase.reload': '正在热重载…',
        'upgrade.done': '已升级到 {version}，插件已热重载生效。',
        'upgrade.doneRefresh': '已升级到 {version}。点击刷新页面加载新界面。',
        'upgrade.failed': '升级失败：{message}',
        'upgrade.history': '最近一次升级',
        'upgrade.from': '由 {from} 升级',
        'upgrade.notes': '更新说明',
        'upgrade.auto': '自动检查：每 {n} 小时',
        'upgrade.autoOff': '自动检查已关闭',
        'reload.now': '热重载插件',
        'reload.reloading': '重载中…',
        'reload.done': '插件已热重载（第 {n} 次）。',
        'reload.refresh': '刷新页面',
        'reload.auto': '文件变化自动热重载',
        'toast.annTitle': '新公告',
        'toast.updateTitle': '插件可升级',
        'toast.updateBody': '发现新版本 {latest}（当前 {current}），可到设置页升级。',
        'nav.tab.pipeline': '压缩与省流',
        'nav.tab.routing': '模型路由',
        'nav.tab.observe': '数据看板',
        'nav.tab.retry': '请求重试',
        'nav.tab.free': '免费模型',
        'nav.tab.eac': 'EAC 模型',
        'nav.tab.channels': '账号渠道',
        'star.cta': '点个 Star',
        'star.title': '在 GitHub 上给本仓库点 Star',
        'free.title': '免费模型',
        'free.sub': '免登录、免 Key、免配置：模型清单跟随上游刷新，可用性由这台机器实测。',
        'free.tankLabel': '免费模型可用度',
        'free.tankNote': '水位 = 当前可用模型占比（{ok}/{total}），含 Kilo 免费池',
        'free.tankEmpty': '尚未探测，水位按已声明模型占位。',
        'free.noneUsable': '本机当前没有任何免费模型探测为「可用」',
        'free.noneUsableHint': '上游额度耗尽 / 限流、出口地区不放行、或探测还没跑完都会这样 —— 这不是渲染问题：下面列表每一行都带着自己的探测结论。检查「出口」后点「重新探测可用性」即可复测。',
        'roster.showDead': '显示限流与暂不可用的模型（{n}）',
        'roster.collapseDead': '收起限流与暂不可用的模型（{n}）',
        'roster.kiloNote': 'Kilo 免费池：未单独探测，选中后由上游直接应答。',
        'roster.throttledHint': '上游主动限流，属于可恢复的临时状态，不等同于不可用。',
        'roster.deadHint': '探测判定不可用或尚未探测；仍可手动选择，失败会如实报错。',
        'eac.title': 'EAC 模型',
        'eac.sub': '桌面端协付渠道：GitHub 登录并 star 本仓库后解锁，与免费车道互不影响。',
        'eac.tankLabel': '协付池压力',
        'chan.title': '账号渠道',
        'chan.sub': '把各家账号的免费额度接进来：登录一次，模型就出现在对话框的模型选择器里。凭据只写入本机凭据库，页面永远拿不到明文。',
        'chan.pack.failed': '渠道包未挂载：{reason}（免费车道与 EAC 不受影响）',
        'chan.pack.hint': '渠道包由本插件内置（vendor/channel-pack），随插件一起升级。',
        'chan.state.on': '已接入',
        'chan.state.off': '未接入',
        'chan.state.closed': '已关闭',
        'chan.meta.accounts': '账号',
        'chan.meta.models': '模型',
        'chan.act.add': '添加账号',
        'chan.act.refresh': '续期',
        'chan.act.refreshed': '已续期「{name}」：{state}',
        'chan.act.refreshedYes': '拿到新凭据',
        'chan.act.refreshedNo': '凭据仍在有效期内',
        'chan.act.test': '测试',
        'chan.act.delete': '移除',
        'chan.act.claim': '一键领取',
        'chan.catalog.live': '实时目录',
        'chan.catalog.preset': '预制目录',
        'chan.catalog.liveHint': '已从上游取到最新模型列表（{time}）',
        'chan.catalog.presetHint': '暂时取不到最新列表，先显示预制表；取到后会自动替换',
        'chan.fold.accounts': '账号',
        'chan.fold.models': '模型',
        'chan.noAccount': '还没有账号——点「添加账号」开始登录。',
        'chan.enabled': '启用',
        'chan.expires.never': '长效',
        'chan.disabled': '已关闭',
        'chan.login.title': '登录 {name}',
        'chan.login.step1': '在浏览器中完成登录（若没有自动打开，点下面的按钮）。',
        'chan.login.step2': '登录成功后本页会自动完成，无需复制任何东西。',
        'chan.login.stepScan': '用微信扇扫下面的二维码完成登录。',
        'chan.login.qrAlt': '微信扫码登录二维码',
        'chan.manifest.stale': '宿主侧插件还是旧代码：它不认识 {missing} —— 这些卡片的「添加账号」点了不会有反应。',
        'chan.manifest.staleHint': '重启 DSH（或重载插件）后这几张卡片才会生效；面板每次打开都读磁盘上的新界面，宿主进程不会。',
        'chan.manifest.missing': '宿主侧插件是旧代码：它连「渠道清单」这条接口都没有 —— 这个面板比它新。',
        'chan.reload.done': '已请求热重载：宿主正在加载磁盘上的新代码。',
        'chan.reload.refresh': '页面会在几秒后自动刷新；没刷新就手动刷新一次。',
        'chan.reload.failed': '热重载失败：{reason}',
        'chan.login.open': '打开登录页',
        'chan.login.cancel': '取消',
        'chan.login.waiting': '已打开登录页，等待授权…（最长等待 10 分钟）',
        'chan.login.code': '在浏览器里确认代码：{code}',
        'chan.login.smsPhone': '填入手机号（AutoClaw 账号）',
        'chan.login.smsPhonePlaceholder': '11 位手机号',
        'chan.login.smsSend': '发送验证码',
        'chan.login.smsSent': '验证码已发送至 {phone}',
        'chan.login.smsCode': '填入收到的短信验证码',
        'chan.login.smsCodePlaceholder': '6 位数字',
        'chan.login.smsSubmit': '登录',
        'chan.login.expired': '等待超时，请重新发起登录。',
        'chan.login.done': '已接入：{login}',
        'chan.login.failed': '登录未完成：{reason}',
        'chan.test.ok': '连接正常（{ms} ms）',
        'chan.test.failed': '测试失败：{reason}',
        'chan.claim.result': '已领取 {count} 个账号：{amounts}。',
        'chan.claim.withAlready': '已领取 {count} 个账号：{amounts}；另有 {already} 个今天已领。',
        'chan.claim.alreadyOnly': '今天已领过（{already} 个账号），无需重复领取。',
        'chan.claim.inactive': '；{count} 个账号的签到活动未开启。',
        'chan.claim.none': '今天没有可领取的积分。',
        'chan.unit.credit': '积分',
        'chan.unit.tokens': 'Token',
        'chan.unit.dollars': 'USD',
        'chan.unit.quota': '配额',
        'chan.credits.expired': '已作废 {amount}',
        'chan.credits.tier': '档位 {tier}',
        'chan.fold.tasks': '任务',
        'chan.fold.subscription': '订阅额度',
        'chan.task.loading': '任务状态查询中…',
        'chan.task.earned': '已领 {earned} / {total}',
        'chan.task.all': '任务已全部完成',
        'chan.task.claim': '领取任务奖励',
        'chan.task.claimed': '已领取：{list}',
        'chan.task.skipped': '{count} 项此前已领',
        'chan.task.ownDone': '{count} 项新人任务',
        'chan.task.ownFailed': '{count} 项暂不可领（需在客户端手动完成）',
        'chan.task.none': '没有可领取的任务。',
        'chan.lock.on': '已锁定永久积分',
        'chan.lock.off': '锁定永久积分',
        'chan.lock.hint': '锁定后选号只消耗 {days} 天内到期的积分，永久积分不参与。',
        'chan.quota.window': '{type} 已用 {percent}%',
        'chan.provider.hint': '关闭整个渠道 = 关闭它的全部模型 + 停用全部账号（与逐模型开关不同）。',
        'chan.provider.off': '关闭整个渠道',
        'chan.provider.on': '打开整个渠道',
        'chan.provider.confirm': '关闭「{name}」会关闭它的全部模型并停用全部账号，继续？',
        'chan.provider.doneOff': '已关闭「{name}」：{models} 个模型、{accounts} 个账号',
        'chan.provider.doneOn': '已打开「{name}」：清空 {models} 个模型黑名单、启用 {accounts} 个账号',
        'chan.claim.all': '全部渠道领取',
        'chan.claim.all.running': '领取中…',
        'chan.claim.all.already': '{already} 个账号今天已领',
        'chan.claim.all.failed': '{failed} 个账号领取失败',
        'chan.fold.extra': '活动',
        'chan.extra.balance': '积分 {remain} / {total}',
        'chan.extra.expiring': '即将到期 {amount}',
        'chan.extra.claimable': '可领取',
        'chan.extra.notClaimable': '不可领取',
        'chan.extra.claim': '领取',
        'chan.extra.claimed': '已领取{title} +{amount} 积分',
        'chan.extra.already': '今天已领取',
        'chan.extra.inactiveMsg': '当前不可领取：{reason}',
        'chan.extra.failed': '领取失败：{reason}',
        'chan.extra.none': '没有活动',
        'chan.extra.unsupported': '该渠道没有权益扩展：{reason}',
        'chan.extra.ratioTitle': '上游积分倍率（含低峰时不显示）',
        'chan.auto.defaultOn': '渠道包默认开启每日自动签到（每次启动时执行一次，可在上面关闭）。',
        'chan.credit.today': '今日已领 {credit}',
        'chan.model.free': '免费额度',
        'chan.model.accountScoped': '该渠道的模型随账号下发，登录后自动获取',
        'chan.model.needsLogin': '登录后可用',
        'chan.diag.host': '宿主目录：{rows}',
        'chan.diag.own': '自有渠道 {count} 条',
        'chan.diag.hint': '这一行是宿主 llm.listModels() 过滤后的真实条数 —— 改模型表后看它，区分「宿主没给」与「界面没刷」',
        'chan.model.dead': '已下架',
        'chan.model.off': '关闭',
        'chan.model.on': '开启',
        'chan.model.enableAll': '全部开启',
        'chan.model.disableAll': '全部关闭',
        'chan.model.enabledCount': '已开启 {enabled}/{total}',
        'chan.model.allScope': '仅操作当前渠道的全部模型',
        'chan.error': '操作失败：{reason}',
        'chan.confirm.delete': '移除账号 {name}？该账号的凭据会一并删除。',
        'chan.rpc.unavailable': '宿主未提供 connection 服务，渠道操作暂不可用。',
        'nav.tab.gateway': '对外服务',
        'chan.titleSingle': '渠道',
        'dash.title': '数据看板',
        'dash.sub': '渠道模型的 Token 消耗与推理指标：输入/输出/思考/缓存逐项统计，账号与模型双维度透视。',
        'dash.today': '今日数据',
        'dash.all': '全部历史',
        'dash.refresh': '刷新',
        'dash.kpiToday': '今日消耗 Token',
        'dash.kpiScopeAll': '范围内消耗 Token',
        'dash.kpiCumulative': '累计消耗 Token',
        'dash.kpiSpeed': '平均生成速度',
        'dash.kpiCache': '上下文缓存命中率',
        'dash.kpiRequests': '请求数 & 成功率',
        'dash.input': '输入',
        'dash.output': '输出',
        'dash.reasoning': '思考',
        'dash.ttft': '首字',
        'dash.cacheTokens': '缓存命中',
        'dash.successRate': '成功率',
        'dash.failed': '失败',
        'dash.recentTitle': '总览 · 最近请求',
        'dash.recentHint': '来自渠道包的逐请求账本：时间、账号、首字延迟、生成速度与 Token 细分。',
        'dash.empty': '暂无数据——通过渠道模型发起一次对话后，这里就会开始记录。',
        'dash.accountsTitle': '各账号用量透视与模型消耗分布',
        'dash.accountsHint': '按账号汇总请求数与 Token 细分，附调用量最高的模型。',
        'dash.modelsTitle': '模型性能指标与用量一览',
        'dash.modelsHint': '融合首字延迟、生成速度与 Token 统计 · 用量占比按消耗 Token 计算。',
        'log.time': '时间',
        'log.model': '模型',
        'log.account': '账号',
        'log.via': '通道',
        'log.viaDirect': '对话',
        'log.viaGateway': '网关',
        'log.result': '结果',
        'log.ok': '成功',
        'log.failed': '失败',
        'log.duration': '耗时',
        'log.ttft': '首字',
        'log.speed': '速度',
        'log.input': '输入',
        'log.output': '输出',
        'log.reasoning': '思考',
        'log.cache': '缓存',
        'log.total': '总 token',
        'log.requests': '请求数',
        'log.inputSlash': '输入 / 输出 / 思考',
        'log.cacheHit': '缓存命中率',
        'log.share': '用量占比',
        'log.modelMix': '调用的模型分布',
        'log.unattributed': '未归属',
        'logs.title': '运行日志',
        'logs.sub': '逐条请求明细：结果、耗时、首字、速度与 Token 细分；悬停失败行可看原因。',
        'logs.auto': '每 10 秒自动刷新',
        'logs.count': '共 {total} 条 · 本页 {shown} 条',
        'logs.empty': '还没有请求记录。',
        'logs.page': '第 {page} 页 / 共 {pages} 页',
        'logs.windowNote': '逐条日志保留最近窗口；历史只保留按日聚合（约 90 天），数据看板的「全部历史」即来源于此。',
        'gw.title': '网关设置',
        'gw.sub': '把渠道模型以 OpenAI 兼容接口发给本机与局域网工具：端点、密钥与转发端口都在这里。',
        'gw.gatewayTitle': '渠道模型网关（宿主，全部渠道，OpenAI 兼容）',
        'gw.gatewayHint': '覆盖全部已接入渠道（含渠道包与其它 provider）；Chat Completions 与 Responses 两套接口同时可用。它由宿主提供、与本插件转发各自独立监听。',
        'gw.compatTitle': '兼容：宿主网关与其中继',
        'gw.compatClosed': '推荐用上面的本地转发；自动路由只在那里生效。展开看宿主网关',
        'gw.running': '运行中',
        'gw.stopped': '未运行',
        'gw.envBlocked': '已被环境变量停用',
        'gw.switch': '启用网关',
        'gw.endpoint': '端点',
        'gw.key': 'API Key',
        'gw.show': '显示',
        'gw.hide': '隐藏',
        'gw.keyNote': '明文凭据：只用于客户端配置，请勿外发。',
        'gw.keyNone': '尚未生成',
        'gw.keyNoneHint': '启用一次网关即会自动生成密钥。',
        'gw.models': '可转发模型',
        'gw.portNote': '端口可用环境变量 DSH_OPENAI_GATEWAY_PORT 调整。',
        'gw.relayTitle': '局域网转发（把上面的宿主网关暴露出去）',
        'gw.relayHint': '这不是另一套网关，只是把上面的宿主网关再暴露到一个可选的地址与端口：调用方用下面的中继密钥，网关自身仍只监听本机。',
        'gw.relaySwitch': '启用局域网转发',
        'gw.relayBind': '监听地址',
        'gw.bindLocal': '仅本机（127.0.0.1）',
        'gw.bindLan': '局域网（0.0.0.0）',
        'gw.relayPort': '端口',
        'gw.relayUrl': 'Base URL',
        'gw.relayKey': '中继密钥',
        'gw.rotate': '轮换',
        'gw.relayNote': '中继只放行模型接口（/v1/*），并要求携带中继密钥；局域网绑定意味着同网段的设备都能访问到这个端口。',
        'gw.freeLaneNote': '免费车道（Model Manager）自己的转发端口在「免费模型」页的「本地转发」分区。',
        'gw.rpcOff': '宿主未提供 connection RPC，网关控制不可用',
        'gw.rpcOffHint': '网关的开关与端点由宿主的 channel-pack 服务提供，本机这一版宿主没有暴露它（常见于精简化/headless 启动，或插件不是经宿主渠道包加载的）。本插件自身的中继与免费车道转发不依赖它，下面照常可用。',
        'gw.rpcOffWhy': '这不是密钥或端口问题，也不是插件坏了：缺少的是宿主侧的一个服务。',
        'gw.retry': '重新检测',
        'gw.notRunning': '网关开关是开的，但没有在监听',
        'gw.notRunningHint': '多半是端口被占用或初始化失败；下面这行是宿主给出的原因。点「重启网关」会再执行一次启动。',
        'gw.portReserved': 'EACCES 表示这段端口被 Windows 保留了（Hyper-V / WinNAT 的排除段），不是被别的程序占用，换程序、杀进程都没用。插件下次启动会自动挑一个能绑的端口，重启 DSH 即可恢复。',
        'gw.restart': '重启网关',
        'chan.credits.left': '剩余积分',
        'chan.credits.tokens': '剩余 Token',
        'chan.credits.dollars': '剩余余额（USD）',
        'chan.credits.quota': '剩余配额',
        'chan.credits.loaded': '已查询 {count} 个账号',
        'chan.credits.refresh': '刷新余额',
        'chan.credits.loading': '余额查询中…',
        'chan.credits.failed': '余额查询失败：{reason}',
        'chan.credits.partial': '{count} 个账号未能查询余额，请展开账号查看原因并重试。',
        'chan.credits.unavailable': '未返回余额数据',
        'chan.credits.pending': '待登录',
        'chan.claim.failed': '领取失败：{reason}',
        'chan.auto.title': '每日自动签到',
        'chan.auto.running': '签到进行中…',
        'chan.auto.ran': '今日已自动签到',
        'chan.auto.off': '今日尚未签到',
        'chan.auto.last': '上次结果：{result}',
        'nav.tab.aggregate': '聚合渠道',
        'agg.title': '聚合渠道',
        'agg.sub': '把第三方 OpenAI 兼容端点接进同一条模型清单：写入本机的 Key 只以指纹回显，保存后清单与模型选择器一起更新。',
        'agg.registryCount': '注册表 {n} 家',
        'agg.configuredCount': '已配置 {n} 家',
        'agg.addProvider': '添加提供商',
        'agg.addTitle': '选择提供商',
        'agg.addHint': '可按分类、协议与认证方式筛选。标了「不可驱动」的提供商需要交互式登录或云侧凭据，本车道不会调用它们。',
        'agg.search': '搜索名称或 ID',
        'agg.filterCategory': '分类',
        'agg.filterFormat': '协议',
        'agg.filterAuth': '认证',
        'agg.filterAll': '全部',
        'agg.showing': '显示 {shown} / {total} 家',
        'agg.noMatch': '没有匹配的提供商。',
        'agg.notUsable': '不可驱动',
        'agg.notUsableWhy': '本车道不会调用它：认证方式是「{kind}」，需要交互式登录或云侧凭据，只能由宿主自己接管。',
        'agg.credential': '获取 Key',
        'agg.modelCount': '{n} 个模型',
        'agg.select': '配置',
        'agg.configuredTitle': '已配置的提供商',
        'agg.configuredHint': '保存后立即生效：清单与模型选择器一起更新。',
        'agg.empty': '还没有接入任何聚合提供商',
        'agg.emptyHint': '这一页把第三方端点接进模型清单：聚合站、免费额度池、本机推理服务都行。填入 Key 与可选的 Base URL，它们的模型就会出现在模型选择器里，也能成为降级链的一环。',
        'agg.filterEmpty': '没有符合筛选条件的已配置提供商。',
        'agg.contributes': '当前贡献 {n} 个模型',
        'agg.contributesNone': '当前未贡献任何模型',
        'agg.hasKey': '已存 Key {hint}',
        'agg.noKey': '未存 Key',
        'agg.enabled': '启用',
        'agg.disabled': '已停用',
        'agg.key': 'API Key',
        'agg.keyPlaceholder': '粘贴新的 API Key（留空则保持不变）',
        'agg.keyKeep': '留空保持当前 Key 不变；要删除请用下面的清除按钮。',
        'agg.keyClear': '清除已保存的 Key',
        'agg.keyClearWarn': '清除后该提供商立即停止贡献模型，直到重新填入 Key。',
        'agg.baseUrl': 'Base URL',
        'agg.baseUrlHint': '留空则使用注册表默认值。',
        'agg.baseUrlDefault': '注册表默认：{url}',
        'agg.baseUrlEnv': '也可用环境变量 {env} 覆盖',
        'agg.models': '模型覆盖',
        'agg.modelsHint': '逗号或换行分隔的模型 ID；留空则用它自己声明的清单。',
        'agg.modelsPlaceholder': 'model-a, model-b',
        'agg.test': '测试',
        'agg.testing': '测试中…',
        'agg.testOk': '验证通过',
        'agg.testFailed': '验证失败',
        'agg.testUnverified': '无法验证',
        'agg.testUnverifiedWhy': '该提供商不提供模型列表接口，验证它要花掉一次真实生成——这里不做。',
        'agg.testAt': '最近测试 {when}',
        'agg.neverTested': '尚未测试',
        'agg.discover': '发现模型',
        'agg.discovering': '发现中…',
        'agg.discovered': '发现 {n} 个模型',
        'agg.discoveredNone': '该提供商不提供模型列表。',
        'agg.discoveredEmpty': '列表返回 0 个模型。',
        'agg.discoveredUse': '填入模型覆盖',
        'agg.discoveredTick': '已发现 {n} 个，点名称加入或移出',
        'agg.discoveredClear': '清空覆盖',
        'agg.discoverFailed': '发现失败',
        'agg.testModel': '测',
        'agg.testModelHint': '真实调用一次（最多 64 tokens），验证这个模型本身能不能用',
        'agg.save': '保存',
        'agg.saving': '保存中…',
        'agg.add': '添加',
        'agg.remove': '移除',
        'agg.removeConfirm': '确认移除',
        'agg.removeWarn': '移除后它贡献的模型立即从清单消失，已保存的 Key 一并删除。',
        'agg.cancel': '取消',
        'agg.saved': '已保存',
        'agg.savedBody': '{name} 的配置已保存。',
        'agg.removedBody': '{name} 已移除。',
        'agg.failed': '操作失败',
        'agg.loadFailed': '无法读取提供商注册表',
        'agg.category.apikey': 'API Key',
        'agg.category.free': '完全免费',
        'agg.category.freeTier': '免费额度',
        'agg.category.local': '本机',
        'agg.category.oauth': 'OAuth',
        'agg.auth.apiKey': 'API Key',
        'agg.auth.none': '免认证',
        'agg.auth.oauth': 'OAuth 登录',
        'agg.auth.adc': '云侧凭据',
        'saver.title': '省 Token',
        'saver.sub': '在请求离开本机之前压缩它：工具输出重编码、提示词瘦身，以及五个不占用上游请求的本地应答。',
        'saver.master': '启用 Token 压缩',
        'saver.masterHint': '关掉后所有压缩立即停止，请求按原样发出；下面的设置保留。',
        'saver.rtk': 'RTK 工具输出压缩',
        'saver.rtkWhat': '压缩的是工具结果：git diff / status / log、grep、find、ls、tree、构建日志、带行号的文件转储，以及重复的日志行。',
        'saver.rtkSafety': '安全边界：报错的工具结果原样保留，小体积内容不碰，替换只在新文本更小且非空时发生——压缩结果永远不会比原文更大。',
        'saver.promptTitle': '提示词压缩',
        'saver.promptHint': '在系统提示里追加一条写作指令。这是唯一能减少输出 Token 的压缩，因为它改变的是模型怎么写。',
        'saver.caveman': 'Caveman',
        'saver.cavemanWhat': '电报体回复：去掉客套与重复解释，只留结论与代码。',
        'saver.ponytail': 'Ponytail',
        'saver.ponytailWhat': 'YAGNI 最小实现：只写被要求的那一件事，不主动加抽象、配置与兜底。',
        'saver.voiceWarn': '注意：这两族会改变助手的说话方式，并且会留在你的对话记录里。默认关闭。',
        'saver.localTitle': '本地应答',
        'saver.localHint': '这五类请求的答案就在请求体里，转发出去只是白花一次上游额度与一个来回。',
        'saver.local.enabled': '启用本地应答',
        'saver.local.quota': '额度探测',
        'saver.local.quotaHint': '回答「额度检查」这类探针，返回一句固定答复。',
        'saver.local.prefix': '命令前缀',
        'saver.local.prefixHint': '回答权限提示要的命令前缀，从 shell 命令里解析。',
        'saver.local.title': '会话标题',
        'saver.local.titleHint': '回答标题生成请求，返回固定标题。',
        'saver.local.suggestion': '建议模式',
        'saver.local.suggestionHint': '回答建议模式的空转回合，不产生上游请求。',
        'saver.local.filepath': '文件路径提取',
        'saver.local.filepathHint': '从命令与输出里解析出文件路径，返回结构化结果。',
        'saver.dashTitle': '节省统计',
        'saver.dashHint': '按字节统计本机实际发生的压缩，只写入本机。',
        'saver.bytesBefore': '压缩前',
        'saver.bytesAfter': '压缩后',
        'saver.bytesSaved': '节省字节',
        'saver.percent': '节省比例',
        'saver.blocks': '压缩块数',
        'saver.calls': '统计调用',
        'saver.promptCalls': '提示词注入',
        'saver.noData': '还没有可统计的请求。发起一次对话后，这里显示的是真实压缩字节数，不是估算。',
        'saver.report': '统计口径',
        'saver.saved': '已保存',
        'saver.savedBody': 'Token 压缩设置已保存。',
        'saver.failed': '保存失败',
        'saver.loadFailed': '无法读取 Token 压缩设置',
        'saver.level.off': '关闭',
        'saver.level.lite': '轻',
        'saver.level.full': '全',
        'saver.level.ultra': '极',
        'saver.level.wenyanLite': '文言·轻',
        'saver.level.wenyan': '文言',
        'saver.level.wenyanUltra': '文言·极',
        'routing.title': '路由',
        'routing.sub': '把若干模型串成一条降级链：链上第一个失败就换下一个，对调用方始终只有一个模型 ID。',
        'routing.chains': '已存链路',
        'routing.chainsHint': '链路按输入顺序保存；引用当前不可用模型的链路会原样保留，车道恢复后自己回来。',
        'routing.empty': '还没有降级链',
        'routing.emptyHint': '一条链就是一个虚拟模型：在模型选择器里选它，请求按顺序尝试链上的每个真实模型。用来兜住某个车道临时不可用的时段。',
        'routing.newChain': '新建链路',
        'routing.name': '名称',
        'routing.namePlaceholder': '例如：先免费后协付',
        'routing.strategy': '策略',
        'routing.strategy.fallback': '顺序降级',
        'routing.strategy.roundRobin': '轮询',
        'routing.stickyLimit': '轮询粘滞次数',
        'routing.stickyHint': '轮询时同一个模型连续用多少次再换下一个。',
        'routing.members': '成员（按顺序）',
        'routing.addMember': '添加成员',
        'routing.memberEmpty': '还没有成员——点「添加成员」从清单里挑一个。',
        'routing.moveUp': '上移',
        'routing.moveDown': '下移',
        'routing.removeMember': '移除',
        'routing.pickModel': '选择模型',
        'routing.searchModel': '搜索模型 ID 或名称',
        'routing.noModel': '没有匹配的模型。',
        'routing.usable': '可用',
        'routing.notUsable': '当前不可用',
        'routing.missing': '不在清单中的成员：{ids}',
        'routing.notUsableWhy': '链路原样保存，不会因为某条车道今天关闭而被改写；这些 ID 回到清单里它就自己恢复。如果是拼写错误，编辑链路改正即可。',
        'routing.resolved': '解析为',
        'routing.memberCount': '{n} 个成员',
        'routing.save': '保存链路',
        'routing.saved': '已保存',
        'routing.savedBody': '链路已保存。',
        'routing.failed': '保存失败',
        'routing.loadFailed': '无法读取链路设置',
        'routing.cancel': '取消',
        'routing.edit': '编辑',
        'routing.delete': '删除',
        'routing.deleteConfirm': '确认删除',
        'routing.deleteWarn': '删除后这个模型 ID 立即从清单消失，正在引用它的客户端会拿到 404。',
        'route.title': '路由分组',
        'route.sub': '优先级、时段、当日熔断与并发闸门：失败只切换一次，切换发生在链内，不再挂第二层拦截。',
        'route.groups': '分组',
        'route.groupsHint': '每个分组是一个可选中的虚拟模型；成员按优先级从小到大尝试。',
        'route.gateTitle': '并发与冷却',
        'route.gateHint': '这两个值是全局默认；单模型可在 route.concurrencyByModel 里覆盖。',
        'route.newGroup': '新建分组',
        'route.name': '分组名',
        'route.namePlaceholder': '主力',
        'route.enabled': '启用',
        'route.memberCount': '{n} 个成员',
        'route.memberEmpty': '还没有成员；至少加一个模型，分组才会出现在选择器里。',
        'route.addMember': '添加模型',
        'route.priority': '优先级',
        'route.priorityHint': '数字越小越先尝试；迁移过来的值保持原样。',
        'route.effort': '档位',
        'route.effortPlaceholder': '跟随',
        'route.effortFollow': '跟随会话',
        'route.effortNone': '该模型没有思考档位',
        'route.windows': '时段',
        'route.windowsPlaceholder': '18-8,12-14',
        'route.windowsHint': '24 小时制，逗号分隔；跨零点写成 18-8，0-24 表示全天。',
        'route.removeMember': '移除',
        'route.enable': '启用',
        'route.disable': '停用',
        'route.unavailable': '目录缺失',
        'route.save': '保存',
        'route.saved': '分组已保存',
        'route.savedBody': '选择器已更新，下一轮请求就按新顺序走。',
        'route.failed': '保存失败',
        'route.cancel': '取消',
        'route.edit': '编辑',
        'route.delete': '删除',
        'route.deleteConfirm': '再点一次删除',
        'route.deleteWarn': '删除后这个分组 ID 立即从选择器消失；绑在它上面的会话要重新选模型。',
        'route.usable': '可选',
        'route.notUsable': '无可用成员',
        'route.legacyTag': '迁移',
        'route.bindings': '{n} 个旧会话绑定',
        'route.missingHint': '{n} 个成员在目录里找不到；渠道启用后自动恢复。',
        'route.todayFailed': '今日熔断 {n} 个',
        'route.resetFailed': '重置熔断',
        'route.resetFailedHint': '成功一次会自动解除，也可以手动重置。',
        'route.resetAll': '重置全部熔断',
        'route.resetDone': '熔断已重置',
        'route.resetDoneBody': '所有成员回到候选池。',
        'route.concurrency': '默认并发',
        'route.cooldown': '限流冷却（秒）',
        'route.concurrencyHint': '每个模型同时进行的请求上限；0 = 不限。满了不排队，直接换组内下一个。',
        'route.saveSettings': '保存并发设置',
        'route.settingsSaved': '并发设置已保存',
        'route.settingsSavedBody': '下一轮请求开始生效。',
        'route.import': '从旧插件导入',
        'route.importConfirm': '确认覆盖现有分组',
        'route.importHint': '读取 model-failover-manager 的 groups / session-bindings / failed；优先级保持原值。导入前会先备份现有分组。',
        'route.legacyMissing': '旧插件的数据目录不存在；没有可导入的配置。',
        'route.imported': '已导入旧配置',
        'route.importedBody': '导入 {groups} 个分组、{members} 个成员。',
        'route.importSkip': '没有导入',
        'route.importFailed': '导入失败',
        'route.bindingNote': '有 {n} 个历史会话仍绑定在这个分组上；在会话里重新选择「分组」即可更新绑定。',
        'route.loadFailed': '读取分组失败',
        'route.modelsCount': '可加入的模型 {n}',

        'effort.label': '插件档位',
        'effort.follow': '跟随会话',
        'effort.hint': '选定后优先于会话里的档位；「跟随会话」= 不干预。',
        'effort.light': '精简',
        'effort.balanced': '均衡',
        'effort.deep': '深思',

        'compaction.title': '上下文压缩',
        'compaction.hint': '对话越长，发给模型的内容越大。开启后，上下文用到阈值就先把旧内容压成摘要再继续，避免撞上限报错；阈值越低越早压缩、越省额度，但细节丢得越早。',
        'compaction.enabled': '自动压缩',
        'compaction.threshold': '触发阈值',
        'compaction.engines': '检测到 {n} 个压缩引擎',
        'compaction.effective': '当前生效 {n}%',
        'compaction.followDefault': '跟随宿主默认',
        'compaction.floor': '下限 {n}%：引擎要保留一段余量，低于它压不出内容。',
        'compaction.advice': '建议 75%：留四分之一给工具输出和下一轮回复。想更省额度可降到 65%，重要长任务建议 85%。',
        'compaction.unsupported': '当前 preset 里没有压缩引擎（compaction 隔离组未挂载），滑块不会生效。',
        'compaction.apply': '应用',
        'compaction.restoreDefault': '恢复默认',
        'compaction.legacy': '已从 dsh-compaction-threshold 导入 {n}%。',
        'compaction.saveFailed': '保存压缩阈值失败',
        'routing.enabled': '启用',
        'routing.channel.free': '免费车道',
        'routing.channel.eac': 'EAC 协付',
        'routing.channel.kilo': 'Kilo',
        'routing.channel.aggregate': '聚合',
        'routing.channel.combo': '链路',
        'routing.channel.host': '宿主渠道',
        'routing.channel.own': '自有渠道',
        'gw.clientsTitle': '接入客户端',
        'gw.clientsHint': '本插件转发（在「模型」页的「本地转发」里开关）的接入配方：地址与 Key 按实际绑定的端口与真实密钥生成。想用刚做的「对外入口」自动切换，连的是这个端口。',
        'gw.clientsOff': '转发端口未启用',
        'gw.clientsOffHint': '先到「免费模型」页的「本地转发」打开端口，这里才会给出可用的地址与配方。',
        'gw.clientsModels': '可转发模型 {n} 个',
      },
      en: {
        'meta.title': 'Model Manager',
        'meta.description': 'Free no-key models inside DeepSeek Harness: a roster that follows upstream, live regional availability, genuinely enforced thinking levels, a token dashboard and an OpenAI-compatible local forward port.',
        'ann.pitch': 'All you do is install this plugin in dsh — no login, no sign-up, no API key, no other step of any kind. The frontier models are simply there, Muse Spark 1.3 and MiMo V2.6 among them. Completely free, with no usage cap.',
        nav: 'Model Manager',
        'nav.panel': 'Models',
        'panel.open': 'Model panel',
        'panel.title': 'Model panel',
        'panel.providers': 'Providers',
        'panel.allModels': 'Free models',
        'panel.laneFree': 'Free lane',
        'panel.laneAggregate': 'Aggregate',
        'panel.providerModels': '{n} models in this channel',
        'panel.searchProvider': 'Search providers',
        'panel.searchModel': 'Search model name or ID',
        'panel.noProvider': 'No matching provider',
        'panel.noMatch': 'No matching model',
        'panel.noModel': 'No models in this channel yet',
        'panel.noModelHint': 'Sign in or refresh the catalog from Settings → Account channels.',
        'panel.selectModel': 'Select a model',
        'panel.noModels': 'No models for this provider.',
        'panel.tab.models': 'Models',
        'panel.tab.routes': 'Route groups',
        'panel.tab.failed': 'Failed models',
        'panel.routes.empty': 'No route groups yet. Create one on the Routing tab; it will appear here and in the model list.',
        'panel.routes.use': 'Use this group',
        'panel.routes.edit': 'Edit',
        'panel.routes.failedMark': 'failed',
        'panel.routes.groups': 'Groups',
        'panel.routes.nameHint': 'New group name',
        'panel.routes.create': 'Create',
        'panel.routes.delete': 'Delete group',
        'panel.routes.remap': 'Repair stale members',
        'panel.routes.remapDone': 'Rewrote the co-ordinates of {n} member(s).',
        'panel.routes.remapLeft': '{n} member(s) are not in the local catalog; they were kept as-is.',
        'panel.routes.noMembers': 'This group has no members yet.',
        'panel.routes.addHint': 'Use “Add model” at the bottom right to pick from the catalog.',
        'panel.routes.add': 'Add model',
        'panel.routes.addClose': 'Close add',
        'panel.routes.addSearch': 'Search model name or ID',
        'panel.routes.added': 'Added',
        'panel.routes.pickAll': 'Select all',
        'panel.routes.pickNone': 'Clear all',
        'panel.routes.pickClear': 'Clear',
        'panel.routes.bulkAdd': 'Add {n}',
        'panel.routes.bulkHint': 'Tick several to add at once; new members go last (priority = current max + 10)',
        'panel.routes.missing': 'not in catalog',
        'panel.routes.priority': 'Priority (lower runs first)',
        'panel.routes.enable': 'Enable',
        'panel.routes.disable': 'Disable',
        'panel.routes.members': '{n} members',
        'panel.failed.empty': 'No model is benched today.',
        'panel.failed.why': '{code} · {reason}',
        'panel.failed.reset': 'Recover',
        'panel.failed.resetAll': 'Recover all',
        'panel.failed.cooldown': 'Clear cooldowns',
        'panel.failed.hint': 'A member that fails inside a route group is benched for the rest of the day; recovering it makes it selectable again.',
        'panel.tab.dashboard': 'Dashboard',
        'panel.settingsTitle': 'Model settings',
        'panel.close': 'Close',
        'panel.current': 'Current',
        'panel.sessionRequired': 'Open a conversation first, then pick a model.',
        'panel.settingsLink': 'All settings',
        'panel.failedProviders': '{n} provider catalog(s) failed to load; the rest still work.',
        'panel.hiddenUnavailable': '{n} unavailable model(s) folded away by your setting (change it under Free models → Preferences).',
        'panel.unavailableDropped': '{n} model(s) probed as unavailable are no longer listed by the host picker; re-probe under Free models → Re-probe availability to re-check them.',
        'panel.hiddenAll': 'Every model here was folded away',
        'panel.hiddenAllHint': 'None of them probed as available. Turn off “Hide unavailable models in the panel” under Preferences to see them.',
        'panel.dockOpen': 'Models',
        'compact.chip': 'Auto compact',
        'compact.quickHint': 'Compact when context use reaches this share of the window. Releasing the slider saves and applies immediately.',
        'compact.restore': 'Restore default',
        'compact.openPanel': 'Adjust in pipeline',
        'compact.saved': 'Threshold saved',
        'compact.saveFailed': 'Could not save threshold',
        'ann.openPanel': 'Open model panel',
        'llmretry.title': 'Request retry',
        'llmretry.hint': 'Sleep and resend when a rule matches. Rules accept HTTP status, machine code, field=value and msg~fragments.',
        'llmretry.rules': 'Rules',
        'llmretry.code': 'Match expression',
        'llmretry.delay': 'Sleep (s)',
        'llmretry.maxRetries': 'Max retries',
        'llmretry.add': 'Add rule',
        'llmretry.save': 'Save',
        'llmretry.saved': 'Saved and active',
        'llmretry.saveFailed': 'Save failed',
        'llmretry.source': 'Source',
        'llmretry.waiting': 'Sleeping',
        'llmretry.events': 'Recent activity',
        'llmretry.noEvents': 'No events yet',
        'llmretry.honor': 'Retry-After cap (s)',
        'llmretry.honorHint': '0 ignores upstream hints; default 10s.',
        'llmretry.firstToken': 'First-token timeout',
        'llmretry.firstTokenHint': 'Abort when no first output arrives within this time.',
        'llmretry.enabled': 'Enabled',
        'llmretry.seconds': 'sec',
        'llmretry.notMultimodal': 'When the model rejects multimodal input',
        'llmretry.offload': 'Offload images automatically',
        'llmretry.maxNotices': 'Max notices per turn',
        'llmretry.emptyRules': 'No rules: every failure is reported directly.',
        'llmretry.badNumber': 'Enter a valid number.',
        title: 'Model Manager',
        refresh: 'Refresh roster',
        reprobe: 'Re-probe availability',
        probing: 'Probing…',
        loading: 'Loading…',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',
        'state.available': 'Available',
        'state.region-blocked': 'Region-limited',
        'state.unavailable': 'Unavailable',
        'state.throttled': 'Throttled',
        'state.unknown': 'Not probed',
        'hint.region': 'This model is gated by egress country. Once a proxy changes your egress, the next probe moves it into the available group by itself.',
        'hint.throttled': 'The upstream is throttling (quota or rate) — a recoverable, temporary state. The next probe re-tests it automatically; picking it while throttled will most likely fail.',
        'hint.unknown': 'Not probed yet, so it stays reachable.',
        'hint.hidden': 'The gateway names it but refuses to route it, so it is out of the model picker. It returns by itself as soon as a probe gets through.',
        'hint.sharedBudget': 'Thinking cannot be switched off on this model, so thinking and the visible answer share one ceiling — a lower rung leaves the answer less room.',
        'tag.vision': 'Vision',
        'tag.text': 'Text only',
        'tag.thinking': 'Tunable thinking',
        'tag.thinkingShared': 'Thinking always on',
        'tag.rung': 'Default ceiling',
        'tag.rungTitle': 'What each rung actually sends: {ladder}. A rung is one ceiling shared by thinking and the answer, and it never exceeds the max output above or the per-call ceiling in settings.',
        'tag.context': 'Context',
        'tag.output': 'Max output',
        'tag.latency': 'First token',
        'tag.eacChannel': 'EAC lane · co-paid',
        'tag.kiloChannel': 'Kilo channel · free pool (prompts may be logged by the upstream provider — never send sensitive content)',
        'roster.noLane': 'The co-paid EAC models are unavailable in this composition: the host did not present a recognized desktop or web profile, so the lane is not loaded.',
        'section.models': 'Model roster',
        'section.modelsHint': 'Names and capacities come from the upstream roster and published capability tables; availability is measured from this machine.',
        'section.dash': 'Usage dashboard',
        'section.dashHint': 'Written to this machine only; nothing is uploaded.',
        'section.forward': 'Local forward (OpenAI compatible)',
        'section.forwardHint': 'Let other local tools reach these models through one base URL.',
        'section.pool': 'Forward entry (one name, auto-retry and failover)',
        'section.poolHint': 'Tick a set of models into a single entry name for the gateway: clients dial that one name; inside, the fastest usable member answers, transient failures retry in place, and unfixable ones fail over.',
        'pool.name': 'Entry name',
        'pool.nameHint': 'Clients put this in `model`. Catalog id: {id}',
        'pool.enabled': 'Enable forward entry',
        'pool.strategy': 'Pick order',
        'pool.strategySmart': 'Smart',
        'pool.strategyFallback': 'Declared order',
        'pool.strategyRoundRobin': 'Round-robin',
        'pool.stickyLimit': 'Round-robin sticky turns',
        'pool.memberRetries': 'In-place retries per model',
        'pool.hideOthers': 'Gateway exposes only this entry',
        'pool.hideOthersHint': 'When on, clients see just this name in `/v1/models`; turn it off to pick a specific model. Gateway only — the local picker is unaffected.',
        'pool.membersTitle': 'Candidates ({n}, order is priority)',
        'pool.membersEmpty': 'No models ticked yet. Pick from the list below; at least one is needed before the gateway uses it.',
        'pool.testMember': 'Test',
        'pool.testMemberHint': 'One real call (32 tokens max) to prove this member works right now',
        'pool.probing': 'Testing…',
        'pool.probeOk': 'OK',
        'pool.probeFail': 'Failed',
        'pool.addMember': 'Tick models',
        'pool.searchModel': 'Search name or id',
        'pool.noModel': 'No matching model.',
        'pool.todayStats': 'Today {calls} calls · {failed} failed · first token {ttft}',
        'pool.todayShort': 'Today {calls} calls / {failed} failed',
        'pool.selectedCount': '{n} selected',
        'pool.groupCount': '{n}',
        'pool.refreshCatalog': 'Refresh catalog',
        'pool.sourceRegistry': 'Preset',
        'pool.sourceRegistryHint': 'A registry template for this provider, not necessarily live; run "Discover models" and tick the real ids.',
        'pool.sourceDiscovered': 'Discovered',
        'pool.unavailable': 'Unavailable now',
        'pool.unavailableHint': 'This model is not in the catalog right now; it will be dropped on save.',
        'pool.unresolvedHint': '{n} ticked models are unavailable now; they will be dropped on save.',
        'pool.exampleTitle': 'How a client configures it',
        'pool.exampleHint': 'External tools set the base URL and this one model name; nothing else changes.',
        'pool.unsaved': 'Unsaved changes.',
        'pool.saved': 'Saved.',
        'pool.savedRenamed': 'Saved. Entry name changed from "{from}" to "{to}" — configs pinning the old name need updating.',
        'common.loading': 'Loading…',
        'common.saving': 'Saving…',
        'common.save': 'Save',
        'section.egress': 'Egress outlet (subscription routing)',
        'section.egressHint': 'Send inference and probe traffic through a proxy outlet to ease per-IP rate limits.',
        'egress.enabled': 'Enable outlet',
        'egress.modeSubscription': 'Subscription mode (local mihomo picks the fastest node)',
        'egress.url': 'Subscription / proxy URL',
        'egress.urlNew': 'Replace the address',
        'egress.urlPlaceholder': 'Paste a new subscription / proxy URL (leave empty to keep the current one)',
        'egress.urlNone': 'not set',
        'egress.urlClear': 'Clear',
        'egress.urlClearWarn': 'Clear the stored subscription / proxy address and turn the outlet off',
        'egress.mihomoPath': 'mihomo path',
        'egress.mihomoHint': 'Leave empty in subscription mode to auto-locate a local mihomo (e.g. Clash Verge).',
        'egress.apply': 'Apply',
        'egress.active': 'Outlet active',
        'egress.inactive': 'Not enabled',
        'egress.outlet': 'Current outlet',
        'egress.node': 'Best node',
        'egress.latency': 'opencode access',
        'egress.measuring': 'measuring…',
        'egress.direct': 'While off, requests go direct; the address is treated as a credential — kept in this machine\'s settings only, never sent down with the regular API payloads, readable only through the reveal button, masked here by default.',
        'egress.error': 'The outlet failed to start: {message}',
        'section.prefs': 'Plugin settings',
        'section.prefsHint': 'Changes take full effect on the next load.',
        'pool.levelOk': 'Healthy',
        'pool.levelBusy': 'Busy',
        'pool.capacity': 'Pool capacity',
        'pool.levelOver': 'Overloaded',
        'pool.reach': 'Capacity in use',
        'pool.formula': '{stars} stars × 1.5',
        'pool.configured': 'configured count',
        'pool.active': '24h active',
        'pool.live': 'in flight',
        'pool.unavailable': 'Pool data unavailable · {reason}',
        'pool.reasonNoLane': 'no co-paid lane in this composition',
        'pool.reasonGateway': 'gateway answered an error',
        'pool.reasonMalformed': 'gateway data malformed',
        'pool.reasonUnreachable': 'gateway unreachable',
        'pool.reasonUnknown': 'unknown cause',
        'pool.capacityUnknown': 'star data unavailable',
        'section.eac': 'EAC lane authorization',
        'section.eacHint': 'EAC (co-paid) models need a GitHub login and a star; the free lane is unaffected.',
        'eac.pillOk': 'authorized',
        'eac.pillLocked': 'not authorized',
        'eac.pillRequired': 'enforced',
        'eac.pillCompat': 'grace period',
        'eac.pillUnknown': 'authorization policy unverified',
        'eac.pollFailed': 'Could not collect authorization ({reason}); retrying automatically. No new sign-in is needed.',
        'eac.saveFailed': 'Authorization completed, but this machine could not save it. Check DSH_HOME permissions; collection will retry automatically.',
        'eac.cancel': 'Cancel this sign-in',
        'eac.cancelFailed': 'Could not confirm cancellation. Please try again.',
        'eac.pillUnverified': 'gateway unreachable',
        'eac.intro': 'EAC turns are checked server-side: sign in with GitHub and star {repo} to unlock them. The browser does the work — nothing to paste — and removing the star revokes access automatically.',
        'eac.login': 'Sign in with GitHub',
        'eac.starting': 'Opening the browser…',
        'eac.waiting': 'The authorization page is open; if the browser did not come up, visit the address below to finish. This page confirms automatically.',
        'eac.copy': 'Copy link',
        'eac.copied': 'Copied',
        'eac.done': 'Authorized as @{login} — EAC models are unlocked.',
        'eac.needStar': 'Signed in as @{login}, but the repository is not starred yet. Star it, then press "I starred it — check again" on the authorization page.',
        'eac.expired': 'This login attempt timed out; please start again.',
        'eac.sessionExpired': 'The login link is no longer valid (the server does not know it) — please start the GitHub login again.',
        'eac.openManually': 'The browser did not open automatically — visit the address below to finish.',
        'eac.startFailed': 'Could not start the login ({reason}).',
        'eac.gatewayGone': 'The EAC gateway no longer serves the login endpoint (server taken down or redesigned); this lane is unavailable until it returns. Not fixable client-side.',
        'eac.browserSpawned': 'Tried to open your browser; if nothing appeared, copy the link below into a browser manually.',
        'eac.loggedIn': 'Authorized: @{login} · last checked {when}',
        'eac.recheck': 'Check again',
        'eac.logout': 'Sign out',
        'eac.noLane': 'The EAC co-paid lane is not unlocked in this composition, so GitHub authorization is unavailable.',
        'eac.lockedTitle': 'Needs GitHub authorization and a star',
        'eac.lockedNote': 'Not authorized: sign in with GitHub and star the repository with the button below, or from the EAC authorization section.',
        'heat.title': 'Token heatmap',
        'heat.legend': 'Less',
        'heat.legendMore': 'More',
        'heat.empty': 'No usage yet. Have one conversation and come back.',
        'curve.title': 'Cumulative tokens',
        'curve.tokens': 'Tokens',
        'curve.requests': 'Requests',
        'curve.total': 'Total',
        'stat.output': 'Output tokens',
        'stat.reasoning': 'Reasoning tokens',
        'col.reason': 'reason',
        'col.output': 'output',
        'last.title': 'Last turn',
        'last.justNow': 'just now',
        'last.minAgo': '{n} min ago',
        'last.hourAgo': '{n} h ago',
        'last.dayAgo': '{n} d ago',
        'last.input': 'input',
        'last.originChat': 'chat',
        'last.originHarness': 'desktop',
        'last.originForward': 'forward',
        'last.originBench': 'bench',
        'speed.title': 'Speed',
        'speed.tps': 'Output speed',
        'speed.ttft': 'First frame',
        'speed.model': 'Model',
        'speed.calls': 'Upstream requests',
        'speed.failed': 'Request failures',
        'speed.turns': 'Conversation turns',
        'speed.turnFailed': 'Turn failures',
        'speed.recovered': 'Recovered',
        'speed.estimated': 'Pre-upgrade history is estimated from upstream requests; turns are exact after upgrade.',
        'speed.scope': 'Requests, turns and tokens are lifetime totals; speed and first frame use the last 40 calls, the heatmap is daily.',
        'speed.none': 'No samples yet',
        'speed.note': 'Output speed covers the {n}/{total} calls it could measure: tokens never streamed out are left out of the numerator, and windows too short to time are dropped.',
        'unit.tokPerSec': 'tok/s',
        'unit.ms': 'ms',
        'forward.enabled': 'Enable the forward port',
        'forward.host': 'Bind address',
        'forward.port': 'Port',
        'forward.apply': 'Apply',
        'settings.failed': 'Settings not saved',
        'forward.running': 'Listening',
        'forward.stopped': 'Off',
        'forward.baseUrl': 'Base URL',
        'forward.key': 'API key',
        'forward.show': 'Show',
        'forward.hide': 'Hide',
        'forward.rotate': 'Regenerate',
        'forward.rotateWarn': 'Regenerating invalidates the old key for every tool using it.',
        'forward.copy': 'Copy',
        'forward.copied': 'Copied',
        'forward.example': 'Example',
        'forward.error': 'Could not start: {message}',
        'forward.notice': 'Port notice: {message}',
        'forward.lanTitle': 'Network access',
        'forward.lanHint': 'Let other devices on the same network use this forward port too. Off by default; the relay demands a key of its own.',
        'forward.lanEnabled': 'Allow network access',
        'forward.lanPort': 'Network port',
        'forward.lanAuto': '0 = pick one automatically',
        'forward.lanApply': 'Apply network settings',
        'forward.lanRunning': 'Network relay listening',
        'forward.lanStopped': 'Network relay off',
        'forward.lanError': 'Could not start the network relay: {message}',
        'forward.lanKey': 'Network key',
        'forward.lanRotateWarn': 'Regenerating makes every device on the network switch keys; tools on this machine are unaffected.',
        'forward.lanWarn': 'While this is on, anyone who can reach this machine can spend its free quota with that key. Enable it only on a network you trust, and narrow the sources with a firewall if you can.',
        'forward.lanUrl': 'Network URL',
        'forward.lanNoAddress': 'No network IPv4 address was detected',
        'forward.lanAlso': 'Also reachable at {list}',
        'pref.enabled': 'Enable free models',
        'pref.exposeRegion': 'Show region-limited models',
        'pref.hideChannels': 'Hide channel model groups',
        'pref.hideUnavailable': 'Hide unavailable models in the panel',
        'pref.hideUnavailableHint': 'When on, models probed as unavailable, region-limited or throttled stay in the host picker but are left out of this plugin\'s model panel; the footer says how many were folded away.',
        'pref.interval': 'Auto-probe interval (minutes)',
        'pref.maxTokens': 'Output ceiling per call (tokens)',
        'pref.egress': 'Current egress',
        'pref.probedAt': 'Last probe',
        'bench.run': 'Run once',
        'bench.running': 'Measuring…',
        'bench.result': 'first frame {ttft}ms · {tps} tok/s · {reasoning} reasoning tokens',
        'ann.preamble': 'Preamble',
        'ann.models': 'Model roster',
        'ann.steps': 'How to use',
        'ann.features': 'What it does',
        'ann.later': 'Later',
        'ann.page': 'Page {n} of {total}',
        'ann.openSettings': 'Open settings',
        'ann.p1': 'No credentials: install and use it — no sign-up, no API key to paste.',
        'ann.p2': 'The roster follows upstream: models, context lengths and capabilities are re-fetched on every refresh.',
        'ann.p3': 'Honest capability claims: anything a probe cannot confirm stays hidden, and each effort level is a real output budget.',
        'ann.s1': 'Pick any model under the “Model Manager” group in the composer’s model selector.',
        'ann.s2': 'For harder reasoning, open the Effort menu — it sends a real budget, not a prompt hint.',
        'ann.s3': 'To serve other local tools: Settings → Local forward → enable, then copy the base URL and key.',
        'ann.s4': 'Region-limited models reclassify themselves once your network egress changes.',
        'ann.f1': 'Model roster: availability, context length, vision, tunable thinking.',
        'ann.f2': 'Token heatmap and cumulative curve, per total or per model.',
        'ann.f3': 'Per-call samples of output speed (tok/s) and time to first token.',
        'ann.f4': 'OpenAI-compatible forward port with a generated API key.',
        'ann.f5': 'Everything stays on this machine — no telemetry.',
        'ann.updates': 'News & upgrades',
        'ann.u1': 'Urgent announcements surface as a full-screen dialog (the rest ride OS notifications).',
        'ann.u2': 'OS notifications: once enabled, new announcements and plugin updates raise system-level toasts.',
        'news.urgentTitle': 'Important announcement',
        'news.gotIt': 'Got it',
        'level.info': 'Notice',
        'level.update': 'Update',
        'level.warn': 'Heads-up',
        'level.urgent': 'Urgent',
        'upgrade.current': 'Running',
        'upgrade.installed': 'On disk',
        'upgrade.mismatch': 'The running and on-disk versions differ. Check the installation before reloading or restarting.',
        'upgrade.recovery': 'The last upgrade was not fully restored. Close the app, restore the installation from the retained backup, restart, then check for updates.',
        'upgrade.backup': 'Recovery backup',
        'upgrade.latest': 'Latest',
        'upgrade.checkedAt': 'Last check',
        'upgrade.never': 'never',
        'upgrade.check': 'Check for updates',
        'upgrade.checking': 'Checking…',
        'upgrade.upToDate': 'Up to date',
        'upgrade.available': 'Upgrade to {version} available',
        'upgrade.apply': 'Upgrade now',
        'upgrade.applying': 'Upgrading…',
        'upgrade.phase.download': 'Downloading the new version…',
        'upgrade.phase.install': 'Installing files…',
        'upgrade.phase.reload': 'Hot-reloading…',
        'upgrade.done': 'Upgraded to {version}; the plugin hot-reloaded into place.',
        'upgrade.doneRefresh': 'Upgraded to {version}. Reload the page to load the new UI.',
        'upgrade.failed': 'Upgrade failed: {message}',
        'upgrade.history': 'Last upgrade',
        'upgrade.from': 'from {from}',
        'upgrade.notes': 'Release notes',
        'upgrade.auto': 'Auto-check: every {n} h',
        'upgrade.autoOff': 'Auto-check off',
        'reload.now': 'Hot-reload plugin',
        'reload.reloading': 'Reloading…',
        'reload.done': 'Plugin hot-reloaded (#{n}).',
        'reload.refresh': 'Reload page',
        'reload.auto': 'Hot-reload on file change',
        'toast.annTitle': 'New announcement',
        'toast.updateTitle': 'Plugin update available',
        'toast.updateBody': 'Version {latest} is out (installed {current}). Upgrade from the settings page.',
        'nav.tab.pipeline': 'Compaction & saving',
        'nav.tab.routing': 'Model routing',
        'nav.tab.observe': 'Dashboard',
        'nav.tab.retry': 'Request retry',
        'nav.tab.free': 'Free models',
        'nav.tab.eac': 'EAC models',
        'nav.tab.channels': 'Account channels',
        'star.cta': 'Star',
        'star.title': 'Star this repository on GitHub',
        'free.title': 'Free models',
        'free.sub': 'No login, no key, no setup: the roster follows upstream, availability is measured from this machine.',
        'free.tankLabel': 'Free-model availability',
        'free.tankNote': 'Water level = share of reachable models ({ok}/{total}), Kilo free pool included',
        'free.tankEmpty': 'Not probed yet; the level stands at the declared roster.',
        'free.noneUsable': 'No free model is currently probed as available on this machine',
        'free.noneUsableHint': 'Upstream quota exhaustion / throttling, an egress-blocked region, or an unfinished probe all look like this — it is not a rendering bug: every row below carries its own probe verdict. Check "Egress", then hit "Re-probe availability" to retest.',
        'roster.showDead': 'Show throttled and unavailable models ({n})',
        'roster.collapseDead': 'Collapse throttled and unavailable models ({n})',
        'roster.kiloNote': 'Kilo free pool: not probed locally; the upstream answers directly.',
        'roster.throttledHint': 'Throttled by upstream: a recoverable, temporary state — not the same as unavailable.',
        'roster.deadHint': 'Probed as unavailable, or not probed yet; still selectable, failures surface as real errors.',
        'eac.title': 'EAC models',
        'eac.sub': 'The desktop co-paid lane: unlocked by a GitHub login plus a star, independent of the free lane.',
        'eac.tankLabel': 'Co-paid pool pressure',
        'chan.title': 'Account channels',
        'chan.sub': 'Bring each account\'s free quota in: sign in once and its models appear in the composer\'s model picker. Credentials are written to the local credential store only — this page never sees them.',
        'chan.pack.failed': 'Channel pack not mounted: {reason} (the free and EAC lanes are unaffected)',
        'chan.pack.hint': 'The pack ships inside this plugin (vendor/channel-pack) and upgrades with it.',
        'chan.state.on': 'Connected',
        'chan.state.off': 'Not connected',
        'chan.state.closed': 'Turned off',
        'chan.meta.accounts': 'Accounts',
        'chan.meta.models': 'Models',
        'chan.act.add': 'Add account',
        'chan.act.refresh': 'Refresh',
        'chan.act.refreshed': 'Refreshed "{name}": {state}',
        'chan.act.refreshedYes': 'new credential stored',
        'chan.act.refreshedNo': 'credential still valid',
        'chan.act.test': 'Test',
        'chan.act.delete': 'Remove',
        'chan.act.claim': 'Claim daily',
        'chan.catalog.live': 'Live catalog',
        'chan.catalog.preset': 'Preset list',
        'chan.catalog.liveHint': 'Latest model list fetched from upstream ({time})',
        'chan.catalog.presetHint': 'Latest list unavailable; showing the preset list and will replace it automatically',
        'chan.fold.accounts': 'Accounts',
        'chan.fold.models': 'Models',
        'chan.noAccount': 'No account yet — press “Add account” to sign in.',
        'chan.enabled': 'Enabled',
        'chan.expires.never': 'Long-lived',
        'chan.disabled': 'Disabled',
        'chan.login.title': 'Sign in to {name}',
        'chan.login.step1': 'Finish the sign-in in your browser (if it did not open, use the button below).',
        'chan.login.step2': 'This page completes by itself once the browser flow does — nothing to copy.',
        'chan.login.stepScan': 'Scan the QR code below with WeChat to finish signing in.',
        'chan.login.qrAlt': 'WeChat sign-in QR code',
        'chan.manifest.stale': 'The host still runs older plugin code: it does not know {missing}, so “add account” on those cards does nothing.',
        'chan.manifest.staleHint': 'Restart DSH (or reload the plugin) to load the new host code; this page always reads the new UI from disk, the host process does not.',
        'chan.manifest.missing': 'The host runs older plugin code: it does not even expose the channel manifest — this page is newer than the host.',
        'chan.reload.done': 'Hot reload requested: the host is loading the code on disk.',
        'chan.reload.refresh': 'This page refreshes itself in a few seconds; refresh manually if it does not.',
        'chan.reload.failed': 'Hot reload failed: {reason}',
        'chan.login.open': 'Open sign-in page',
        'chan.login.cancel': 'Cancel',
        'chan.login.waiting': 'Sign-in page opened; waiting for authorization… (up to 10 minutes)',
        'chan.login.code': 'Confirm this code in the browser: {code}',
        'chan.login.smsPhone': 'Enter your phone number (AutoClaw account)',
        'chan.login.smsPhonePlaceholder': '11-digit phone number',
        'chan.login.smsSend': 'Send code',
        'chan.login.smsSent': 'Verification code sent to {phone}',
        'chan.login.smsCode': 'Enter the SMS code you received',
        'chan.login.smsCodePlaceholder': '6 digits',
        'chan.login.smsSubmit': 'Sign in',
        'chan.login.expired': 'Timed out — please start the sign-in again.',
        'chan.login.done': 'Connected: {login}',
        'chan.login.failed': 'Sign-in did not complete: {reason}',
        'chan.test.ok': 'Connection healthy ({ms} ms)',
        'chan.test.failed': 'Test failed: {reason}',
        'chan.claim.result': 'Claimed on {count} account(s): {amounts}.',
        'chan.claim.withAlready': 'Claimed on {count} account(s): {amounts}; {already} more already claimed today.',
        'chan.claim.alreadyOnly': 'Already claimed today on {already} account(s) — nothing to re-claim.',
        'chan.claim.inactive': '; the check-in campaign is closed on {count} account(s).',
        'chan.claim.none': 'Nothing to claim today.',
        'chan.unit.credit': 'credits',
        'chan.unit.tokens': 'tokens',
        'chan.unit.dollars': 'USD',
        'chan.unit.quota': 'quota',
        'chan.credits.expired': '{amount} expired',
        'chan.credits.tier': 'tier {tier}',
        'chan.fold.tasks': 'Tasks',
        'chan.fold.subscription': 'Quota windows',
        'chan.task.loading': 'Querying task state…',
        'chan.task.earned': 'Earned {earned} / {total}',
        'chan.task.all': 'All tasks done',
        'chan.task.claim': 'Claim task rewards',
        'chan.task.claimed': 'Claimed: {list}',
        'chan.task.skipped': '{count} already claimed',
        'chan.task.ownDone': '{count} onboarding task(s)',
        'chan.task.ownFailed': '{count} need manual completion in the client',
        'chan.task.none': 'No task rewards to claim.',
        'chan.lock.on': 'Permanent credits locked',
        'chan.lock.off': 'Lock permanent credits',
        'chan.lock.hint': 'When locked, account selection only spends credits expiring within {days} days.',
        'chan.quota.window': '{type} {percent}% used',
        'chan.provider.hint': 'Turning a channel off hides all of its models and disables all of its accounts (unlike the per-model switches).',
        'chan.provider.off': 'Turn channel off',
        'chan.provider.on': 'Turn channel on',
        'chan.provider.confirm': 'Turning "{name}" off hides every model and disables every account. Continue?',
        'chan.provider.doneOff': '"{name}" turned off: {models} models hidden, {accounts} accounts disabled',
        'chan.provider.doneOn': '"{name}" turned on: {models} models cleared, {accounts} accounts enabled',
        'chan.claim.all': 'Claim every channel',
        'chan.claim.all.running': 'Claiming…',
        'chan.claim.all.already': '{already} account(s) already claimed today',
        'chan.claim.all.failed': '{failed} account(s) failed to claim',
        'chan.fold.extra': 'Campaigns',
        'chan.extra.balance': '{remain} / {total} credits',
        'chan.extra.expiring': '{amount} expiring',
        'chan.extra.claimable': 'Claimable',
        'chan.extra.notClaimable': 'Not claimable',
        'chan.extra.claim': 'Claim',
        'chan.extra.claimed': 'Claimed {title} +{amount} credits',
        'chan.extra.already': 'Already claimed today',
        'chan.extra.inactiveMsg': 'Not claimable now: {reason}',
        'chan.extra.failed': 'Claim failed: {reason}',
        'chan.extra.none': 'No campaigns',
        'chan.extra.unsupported': 'No entitlement extension for this channel: {reason}',
        'chan.extra.ratioTitle': 'Upstream credit ratio',
        'chan.auto.defaultOn': 'The channel pack enables daily auto check-in by default (runs once per launch; switch it off above).',
        'chan.credit.today': '{credit} claimed today',
        'chan.model.free': 'Free quota',
        'chan.model.accountScoped': 'Models are issued per account; sign in to discover them',
        'chan.model.needsLogin': 'Sign in to use',
        'chan.diag.host': 'Host catalog: {rows}',
        'chan.diag.own': '{count} own-channel rows',
        'chan.diag.hint': "Live counts from the host's llm.listModels() — tells 'host never offered it' apart from 'UI never refreshed'",
        'chan.model.dead': 'Retired',
        'chan.model.off': 'Hide',
        'chan.model.on': 'Show',
        'chan.model.enableAll': 'Show all',
        'chan.model.disableAll': 'Hide all',
        'chan.model.enabledCount': 'Shown {enabled}/{total}',
        'chan.model.allScope': 'Apply to all models in this channel only',
        'chan.error': 'Action failed: {reason}',
        'chan.confirm.delete': 'Remove account {name}? Its credential is deleted with it.',
        'chan.rpc.unavailable': 'This host exposes no connection service, so channel actions are unavailable.',
        'nav.tab.gateway': 'Services',
        'chan.titleSingle': 'Channel',
        'dash.title': 'Usage dashboard',
        'dash.sub': 'Token spend and inference metrics for the channel models: input/output/reasoning/cache, pivoted by account and by model.',
        'dash.today': 'Today',
        'dash.all': 'All time',
        'dash.refresh': 'Refresh',
        'dash.kpiToday': 'Tokens today',
        'dash.kpiScopeAll': 'Tokens in scope',
        'dash.kpiCumulative': 'Tokens all time',
        'dash.kpiSpeed': 'Average speed',
        'dash.kpiCache': 'Context cache hit rate',
        'dash.kpiRequests': 'Requests & success rate',
        'dash.input': 'Input',
        'dash.output': 'Output',
        'dash.reasoning': 'Reasoning',
        'dash.ttft': 'TTFT',
        'dash.cacheTokens': 'Cache hits',
        'dash.successRate': 'Success',
        'dash.failed': 'Failed',
        'dash.recentTitle': 'Overview · Recent requests',
        'dash.recentHint': 'From the pack\'s per-request ledger: time, account, TTFT, speed and the token breakdown.',
        'dash.empty': 'Nothing yet — one conversation through a channel model starts the record.',
        'dash.accountsTitle': 'Per-account usage & model mix',
        'dash.accountsHint': 'Requests and token breakdown per account, with the most-used models.',
        'dash.modelsTitle': 'Model performance & usage',
        'dash.modelsHint': 'TTFT, speed and token statistics per model · usage share is by tokens spent.',
        'log.time': 'Time',
        'log.model': 'Model',
        'log.account': 'Account',
        'log.via': 'Via',
        'log.viaDirect': 'Chat',
        'log.viaGateway': 'Gateway',
        'log.result': 'Result',
        'log.ok': 'OK',
        'log.failed': 'Failed',
        'log.duration': 'Duration',
        'log.ttft': 'TTFT',
        'log.speed': 'Speed',
        'log.input': 'Input',
        'log.output': 'Output',
        'log.reasoning': 'Reasoning',
        'log.cache': 'Cache',
        'log.total': 'Total tok',
        'log.requests': 'Requests',
        'log.inputSlash': 'Input / Output / Reasoning',
        'log.cacheHit': 'Cache hit',
        'log.share': 'Share',
        'log.modelMix': 'Model mix',
        'log.unattributed': 'Unattributed',
        'logs.title': 'Request log',
        'logs.sub': 'Every request in detail: result, duration, TTFT, speed and the token breakdown; hover a failed row for the reason.',
        'logs.auto': 'Refresh every 10 s',
        'logs.count': '{total} entries · {shown} on this page',
        'logs.empty': 'No requests recorded yet.',
        'logs.page': 'Page {page} of {pages}',
        'logs.windowNote': 'Per-request rows cover a recent window only; history is kept as daily aggregates (~90 days) — the dashboard\'s "All time" reads those.',
        'gw.title': 'Gateway settings',
        'gw.sub': 'Serve the channel models over an OpenAI-compatible API to this machine and the LAN: endpoint, key and relay port live here.',
        'gw.gatewayTitle': 'Channel gateway (host, all channels, OpenAI compatible)',
        'gw.gatewayHint': 'Covers every connected channel (incl. channel packs and other providers); Chat Completions and Responses are both served. Provided by the host, on its own listener separate from this plugin\'s forward port.',
        'gw.compatTitle': 'Compatibility: host gateway and its relay',
        'gw.compatClosed': 'Prefer the local forward above; the auto pool only works there. Expand for the host gateway',
        'gw.running': 'Running',
        'gw.stopped': 'Not running',
        'gw.envBlocked': 'Disabled by environment',
        'gw.switch': 'Enable gateway',
        'gw.endpoint': 'Endpoint',
        'gw.key': 'API Key',
        'gw.show': 'Show',
        'gw.hide': 'Hide',
        'gw.keyNote': 'A plaintext credential for client configuration — handle with care.',
        'gw.keyNone': 'Not generated yet',
        'gw.keyNoneHint': 'Enabling the gateway once mints a key automatically.',
        'gw.models': 'Servable models',
        'gw.portNote': 'The port can be moved with the DSH_OPENAI_GATEWAY_PORT environment variable.',
        'gw.relayTitle': 'LAN relay (re-exposes the host gateway above)',
        'gw.relayHint': 'This is not a second gateway — it re-exposes the host gateway above on an address and port you choose: callers use the relay key below, and the gateway itself stays on the loopback.',
        'gw.relaySwitch': 'Enable LAN relay',
        'gw.relayBind': 'Bind address',
        'gw.bindLocal': 'This machine only (127.0.0.1)',
        'gw.bindLan': 'LAN (0.0.0.0)',
        'gw.relayPort': 'Port',
        'gw.relayUrl': 'Base URL',
        'gw.relayKey': 'Relay key',
        'gw.rotate': 'Rotate',
        'gw.relayNote': 'The relay forwards only the model routes (/v1/*) and demands the relay key; binding to the LAN means every device on the network can reach that port.',
        'gw.freeLaneNote': 'The free lane (Model Manager) has its own forward port under "Local forward" on the Free models page.',
        'gw.rpcOff': 'The host does not expose the connection RPC, so gateway control is unavailable',
        'gw.rpcOffHint': 'The gateway switch and endpoint are served by the host\'s channel-pack service, and this build of the host does not expose it (typical of a trimmed/headless launch, or a plugin not loaded through the host channel pack). This plugin\'s own relay and free-lane forward do not depend on it and keep working below.',
        'gw.rpcOffWhy': 'This is not a key or port problem, and not a broken plugin: what is missing is a host-side service.',
        'gw.retry': 'Re-check',
        'gw.notRunning': 'The gateway switch is on, but nothing is listening',
        'gw.notRunningHint': 'Usually a port conflict or a failed initialisation; the line below is the reason the host reported. "Restart gateway" runs the start sequence again.',
        'gw.portReserved': 'EACCES means Windows reserved this range (a Hyper-V / WinNAT exclusion) — no other program holds it, so killing processes will not help. The plugin picks a bindable port on its next start; restart DSH to recover.',
        'gw.restart': 'Restart gateway',
        'chan.credits.left': 'Credits left',
        'chan.credits.tokens': 'Tokens left',
        'chan.credits.dollars': 'Balance left (USD)',
        'chan.credits.quota': 'Quota left',
        'chan.credits.loaded': '{count} accounts queried',
        'chan.credits.refresh': 'Refresh balance',
        'chan.credits.loading': 'Querying balance…',
        'chan.credits.failed': 'Balance query failed: {reason}',
        'chan.credits.partial': 'Could not query {count} accounts. Expand accounts to see the reasons and retry.',
        'chan.credits.unavailable': 'No balance data returned',
        'chan.credits.pending': 'Not signed in yet',
        'chan.claim.failed': 'Claim failed: {reason}',
        'chan.auto.title': 'Daily auto check-in',
        'chan.auto.running': 'Check-in running…',
        'chan.auto.ran': 'Checked in today',
        'chan.auto.off': 'Not checked in today',
        'chan.auto.last': 'Last result: {result}',
        'nav.tab.aggregate': 'Aggregate',
        'agg.title': 'Aggregate providers',
        'agg.sub': 'Bring third-party OpenAI-compatible endpoints into the same model roster: a key written here is echoed back as a fingerprint only, and saving updates the roster and the model picker together.',
        'agg.registryCount': '{n} in the registry',
        'agg.configuredCount': '{n} configured',
        'agg.addProvider': 'Add provider',
        'agg.addTitle': 'Choose a provider',
        'agg.addHint': 'Filter by category, wire format and auth kind. A provider marked "not drivable" needs an interactive login or cloud credentials, and this lane never calls it.',
        'agg.search': 'Search name or id',
        'agg.filterCategory': 'Category',
        'agg.filterFormat': 'Format',
        'agg.filterAuth': 'Auth',
        'agg.filterAll': 'All',
        'agg.showing': 'Showing {shown} of {total}',
        'agg.noMatch': 'No provider matches.',
        'agg.notUsable': 'Not drivable',
        'agg.notUsableWhy': 'This lane never calls it: its auth kind is "{kind}", which needs an interactive login or cloud-side credentials, so only the host can take it over.',
        'agg.credential': 'Get a key',
        'agg.modelCount': '{n} models',
        'agg.select': 'Configure',
        'agg.configuredTitle': 'Configured providers',
        'agg.configuredHint': 'Changes take effect immediately: saving updates the roster and the model picker together.',
        'agg.empty': 'No aggregate provider is connected yet',
        'agg.emptyHint': 'This page brings third-party endpoints into the model roster: an aggregator, a free-tier pool, a local inference server. Fill in a key and an optional base URL and their models appear in the model picker — and can become a link in a fallback chain.',
        'agg.filterEmpty': 'No configured provider matches the filter.',
        'agg.contributes': 'Contributes {n} models',
        'agg.contributesNone': 'Contributes no model right now',
        'agg.hasKey': 'Key {hint}',
        'agg.noKey': 'No key stored',
        'agg.enabled': 'Enabled',
        'agg.disabled': 'Disabled',
        'agg.key': 'API key',
        'agg.keyPlaceholder': 'Paste a new API key (leave empty to keep the current one)',
        'agg.keyKeep': 'Empty keeps the stored key; use the clear button below to delete it.',
        'agg.keyClear': 'Clear the stored key',
        'agg.keyClearWarn': 'Clearing it stops this provider from contributing models until a key is entered again.',
        'agg.baseUrl': 'Base URL',
        'agg.baseUrlHint': 'Empty uses the registry default.',
        'agg.baseUrlDefault': 'Registry default: {url}',
        'agg.baseUrlEnv': 'Can also be overridden by the {env} environment variable',
        'agg.models': 'Model override',
        'agg.modelsHint': 'Model ids separated by commas or newlines; empty uses the list the provider declares.',
        'agg.modelsPlaceholder': 'model-a, model-b',
        'agg.test': 'Test',
        'agg.testing': 'Testing…',
        'agg.testOk': 'Verified',
        'agg.testFailed': 'Failed',
        'agg.testUnverified': 'Not verifiable',
        'agg.testUnverifiedWhy': 'This provider declares no model listing, so verifying it would cost one real generation — not done here.',
        'agg.testAt': 'Last test {when}',
        'agg.neverTested': 'Not tested yet',
        'agg.discover': 'Discover models',
        'agg.discovering': 'Discovering…',
        'agg.discovered': 'Found {n} models',
        'agg.discoveredNone': 'This provider declares no model listing.',
        'agg.discoveredEmpty': 'The listing answered with 0 models.',
        'agg.discoveredUse': 'Use these as the override',
        'agg.discoveredTick': 'Found {n}; click a name to add or remove it',
        'agg.discoveredClear': 'Clear override',
        'agg.discoverFailed': 'Discovery failed',
        'agg.testModel': 'Test',
        'agg.testModelHint': 'One real call (64 tokens max) to prove this model itself answers',
        'agg.save': 'Save',
        'agg.saving': 'Saving…',
        'agg.add': 'Add',
        'agg.remove': 'Remove',
        'agg.removeConfirm': 'Confirm removal',
        'agg.removeWarn': 'Removing it drops its models from the roster immediately and deletes the stored key.',
        'agg.cancel': 'Cancel',
        'agg.saved': 'Saved',
        'agg.savedBody': 'The configuration for {name} is saved.',
        'agg.removedBody': '{name} was removed.',
        'agg.failed': 'Action failed',
        'agg.loadFailed': 'Cannot read the provider registry',
        'agg.category.apikey': 'API key',
        'agg.category.free': 'Fully free',
        'agg.category.freeTier': 'Free tier',
        'agg.category.local': 'Local',
        'agg.category.oauth': 'OAuth',
        'agg.auth.apiKey': 'API key',
        'agg.auth.none': 'No auth',
        'agg.auth.oauth': 'OAuth login',
        'agg.auth.adc': 'Cloud credentials',
        'saver.title': 'Token savers',
        'saver.sub': 'Compact a request before it leaves this machine: tool output re-encoded, the prompt slimmed, and five answers produced locally without an upstream call.',
        'saver.master': 'Enable token compaction',
        'saver.masterHint': 'Turning this off stops every saver at once and sends requests as written; the settings below are kept.',
        'saver.rtk': 'RTK tool-output compaction',
        'saver.rtkWhat': 'What it compacts: tool results — git diff / status / log, grep, find, ls, tree, build logs, numbered file dumps and duplicate log lines.',
        'saver.rtkSafety': 'Safety rules: an error result is left untouched, small bodies are not touched, and a blob is replaced only when the new text is non-empty and strictly smaller — a compacted result is never larger than the original.',
        'saver.promptTitle': 'Prompt shaping',
        'saver.promptHint': 'Appends a writing instruction to the system prompt. It is the only saver that can cut output tokens, because it changes what the model writes.',
        'saver.caveman': 'Caveman',
        'saver.cavemanWhat': 'Terse replies: pleasantries and repeated explanation dropped, conclusions and code kept.',
        'saver.ponytail': 'Ponytail',
        'saver.ponytailWhat': 'YAGNI-minimal replies: only the one thing that was asked for, no unrequested abstraction, config or fallback.',
        'saver.voiceWarn': 'Heads-up: both families change how the assistant talks, and that lands in your transcript. Off by default.',
        'saver.localTitle': 'Local answers',
        'saver.localHint': 'The answer to these five requests is already in the request body; forwarding one spends a round trip and upstream quota on a question with one right answer.',
        'saver.local.enabled': 'Enable local answers',
        'saver.local.quota': 'Quota probe',
        'saver.local.quotaHint': 'Answers a "quota check" probe with a fixed line.',
        'saver.local.prefix': 'Command prefix',
        'saver.local.prefixHint': 'Answers the command prefix behind a permission prompt, parsed from the shell command.',
        'saver.local.title': 'Session title',
        'saver.local.titleHint': 'Answers a title-generation request with a fixed title.',
        'saver.local.suggestion': 'Suggestion mode',
        'saver.local.suggestionHint': 'Answers a suggestion-mode turn without producing an upstream request.',
        'saver.local.filepath': 'Filepath extraction',
        'saver.local.filepathHint': 'Parses the file paths out of a command and its output, and returns them structured.',
        'saver.dashTitle': 'Savings',
        'saver.dashHint': 'Bytes actually compacted on this machine, written locally only.',
        'saver.bytesBefore': 'Before',
        'saver.bytesAfter': 'After',
        'saver.bytesSaved': 'Bytes saved',
        'saver.percent': 'Saved',
        'saver.blocks': 'Blocks compacted',
        'saver.calls': 'Calls measured',
        'saver.promptCalls': 'Prompts shaped',
        'saver.noData': 'No request measured yet. One conversation later, this shows real compacted bytes rather than an estimate.',
        'saver.report': 'Reported as',
        'saver.saved': 'Saved',
        'saver.savedBody': 'The token-saver settings are saved.',
        'saver.failed': 'Not saved',
        'saver.loadFailed': 'Cannot read the token-saver settings',
        'saver.level.off': 'Off',
        'saver.level.lite': 'Lite',
        'saver.level.full': 'Full',
        'saver.level.ultra': 'Ultra',
        'saver.level.wenyanLite': 'Classical · lite',
        'saver.level.wenyan': 'Classical',
        'saver.level.wenyanUltra': 'Classical · ultra',
        'routing.title': 'Routing',
        'routing.sub': 'Chain several models into one fallback chain: when a link refuses, the next one answers, and the caller still sees a single model id.',
        'routing.chains': 'Stored chains',
        'routing.chainsHint': 'Chains are stored in the order you entered them; a chain that references a model which is unavailable right now is kept as written and comes back by itself when the lane does.',
        'routing.empty': 'No fallback chain yet',
        'routing.emptyHint': 'A chain is a virtual model: pick it in the model picker and the request tries each real model on the chain in order. Use one to cover the hours when a lane is down.',
        'routing.newChain': 'New chain',
        'routing.name': 'Name',
        'routing.namePlaceholder': 'e.g. free first, co-paid second',
        'routing.strategy': 'Strategy',
        'routing.strategy.fallback': 'Fallback',
        'routing.strategy.roundRobin': 'Round-robin',
        'routing.stickyLimit': 'Round-robin sticky limit',
        'routing.stickyHint': 'How many calls in a row one model serves before the rotation moves on.',
        'routing.members': 'Members (in order)',
        'routing.addMember': 'Add member',
        'routing.memberEmpty': 'No member yet — press "Add member" to pick one from the roster.',
        'routing.moveUp': 'Move up',
        'routing.moveDown': 'Move down',
        'routing.removeMember': 'Remove',
        'routing.pickModel': 'Pick a model',
        'routing.searchModel': 'Search model id or name',
        'routing.noModel': 'No model matches.',
        'routing.usable': 'Usable',
        'routing.notUsable': 'Not usable now',
        'routing.missing': 'Members not in the roster: {ids}',
        'routing.notUsableWhy': 'The chain is stored as written and is never rewritten because a lane is closed today; it comes back by itself once those ids are in the roster again. If an id is a typo, edit the chain and fix it.',
        'routing.resolved': 'Resolves to',
        'routing.memberCount': '{n} members',
        'routing.save': 'Save chain',
        'routing.saved': 'Saved',
        'routing.savedBody': 'The chain is saved.',
        'routing.failed': 'Not saved',
        'routing.loadFailed': 'Cannot read the chain settings',
        'routing.cancel': 'Cancel',
        'routing.edit': 'Edit',
        'routing.delete': 'Delete',
        'routing.deleteConfirm': 'Confirm delete',
        'routing.deleteWarn': 'Deleting it drops this model id from the roster immediately; a client still pointing at it gets a 404.',
        'route.title': 'Route groups',
        'route.sub': 'Priority, time windows, a daily circuit-breaker and a concurrency gate — one hop per failure, inside the chain, never a second interceptor.',
        'route.groups': 'Groups',
        'route.groupsHint': 'Each group is a selectable virtual model; members are tried by ascending priority.',
        'route.gateTitle': 'Concurrency and cooldown',
        'route.gateHint': 'These two are global defaults; a single model can override them in route.concurrencyByModel.',
        'route.newGroup': 'New group',
        'route.name': 'Group name',
        'route.namePlaceholder': 'primary',
        'route.enabled': 'Enabled',
        'route.memberCount': '{n} members',
        'route.memberEmpty': 'No members yet. Add at least one model or the group will not appear in the picker.',
        'route.addMember': 'Add model',
        'route.priority': 'Priority',
        'route.priorityHint': 'Lower is tried first; imported values are kept as they were.',
        'route.effort': 'Effort',
        'route.effortPlaceholder': 'follow',
        'route.effortFollow': 'Follow session',
        'route.effortNone': 'This model has no effort levels',
        'route.windows': 'Window',
        'route.windowsPlaceholder': '18-8,12-14',
        'route.windowsHint': '24-hour clock, comma separated. Crossing midnight is 18-8; 0-24 means all day.',
        'route.removeMember': 'Remove',
        'route.enable': 'Enable',
        'route.disable': 'Disable',
        'route.unavailable': 'not in roster',
        'route.save': 'Save',
        'route.saved': 'Group saved',
        'route.savedBody': 'The picker is updated; the next request follows the new order.',
        'route.failed': 'Could not save',
        'route.cancel': 'Cancel',
        'route.edit': 'Edit',
        'route.delete': 'Delete',
        'route.deleteConfirm': 'Click again to delete',
        'route.deleteWarn': 'Deleting it drops this group id from the picker immediately; a session pinned to it must pick another model.',
        'route.usable': 'Usable',
        'route.notUsable': 'No usable member',
        'route.legacyTag': 'migrated',
        'route.bindings': '{n} legacy bindings',
        'route.missingHint': '{n} members are not in the roster; they come back when the channel is enabled.',
        'route.todayFailed': '{n} tripped today',
        'route.resetFailed': 'Reset breaker',
        'route.resetFailedHint': 'One success clears it automatically; this is the manual reset.',
        'route.resetAll': 'Reset all breakers',
        'route.resetDone': 'Breakers reset',
        'route.resetDoneBody': 'Every member is back in the candidate pool.',
        'route.concurrency': 'Default concurrency',
        'route.cooldown': 'Rate-limit cooldown (s)',
        'route.concurrencyHint': 'In-flight requests per model; 0 = unlimited. When full it does not queue — it moves to the next member.',
        'route.saveSettings': 'Save concurrency',
        'route.settingsSaved': 'Concurrency saved',
        'route.settingsSavedBody': 'Takes effect from the next request.',
        'route.import': 'Import from old plugin',
        'route.importConfirm': 'Confirm replacing the groups',
        'route.importHint': 'Reads model-failover-manager groups / session-bindings / failed; priorities are kept as-is. Existing groups are backed up first.',
        'route.legacyMissing': 'The old plugin data directory is missing; nothing to import.',
        'route.imported': 'Legacy config imported',
        'route.importedBody': '{groups} groups, {members} members.',
        'route.importSkip': 'Nothing imported',
        'route.importFailed': 'Import failed',
        'route.bindingNote': '{n} historical sessions are still bound to this group; reselect the group in those sessions to update the binding.',
        'route.loadFailed': 'Could not load groups',
        'route.modelsCount': '{n} models available',

        'effort.label': 'Plugin effort',
        'effort.follow': 'Follow session',
        'effort.hint': 'A value here overrides the session effort; "Follow session" writes nothing.',
        'effort.light': 'Light',
        'effort.balanced': 'Balanced',
        'effort.deep': 'Deep',

        'compaction.title': 'Context compaction',
        'compaction.hint': 'The longer the chat, the bigger the prompt. When on, the old turns are summarized once context crosses the threshold, so the next request does not hit the window limit. Lower thresholds compact earlier and save more quota, but lose detail sooner.',
        'compaction.enabled': 'Auto-compact',
        'compaction.threshold': 'Trigger threshold',
        'compaction.engines': '{n} compaction engines found',
        'compaction.effective': 'effective {n}%',
        'compaction.followDefault': 'following host default',
        'compaction.floor': 'Floor {n}%: the engine keeps a reserve, and below it there is nothing to compact.',
        'compaction.advice': '75% is a good default: a quarter stays for tool output and the next reply. 65% saves more quota; 85% is safer for long tasks.',
        'compaction.unsupported': 'No compaction engine in the current preset (compaction realm not mounted); the slider has no effect.',
        'compaction.apply': 'Apply',
        'compaction.restoreDefault': 'Restore default',
        'compaction.legacy': 'Imported {n}% from dsh-compaction-threshold.',
        'compaction.saveFailed': 'Could not save the compaction threshold',
        'routing.enabled': 'Enabled',
        'routing.channel.free': 'Free lane',
        'routing.channel.eac': 'EAC co-paid',
        'routing.channel.kilo': 'Kilo',
        'routing.channel.aggregate': 'Aggregate',
        'routing.channel.combo': 'Chain',
        'routing.channel.host': 'Host channel',
        'routing.channel.own': 'Own channel',
        'gw.clientsTitle': 'Connect a client',
        'gw.clientsHint': 'How this plugin\'s forward port (enabled under "Local forward" on the Model page) plugs into each client: addresses and keys below are generated from the port that actually bound and the real key. To use the new "forward entry" with auto-failover, connect to this port.',
        'gw.clientsOff': 'The forward port is off',
        'gw.clientsOffHint': 'Enable it under "Local forward" on the Free models page first; only then does this section have a usable address and recipes.',
        'gw.clientsModels': '{n} servable models',
      },
    }

    // ── styles ────────────────────────────────────────────────────────────────
    // Two theme variables are not defined by every shell — measured in the web
    // shell this plugin ships against, `--dsw-alias-state-warning-primary` and
    // `--dsw-alias-label-on-accent` resolve to nothing. A declaration whose
    // var() is invalid at computed-value time is dropped *whole*, so without a
    // fallback every warning-coloured surface disappears: the pool tank's water
    // (level "busy") rendered as an empty box, the region-limited badge lost its
    // colour, callouts lost their border. Every use of those two names carries a
    // fallback for exactly that reason.
    const CSS = `
/* ═══════════════════════════════════════════════════════════════════════
   Our Free Model — visual system
   统一令牌：所有色值取自宿主 --dsw-alias-* 变量，昼夜由宿主切换。
   层级约定：layer-3 凹槽/页面底 · layer-2 面板 · layer-1 浮起元素。
   动效约定：transform/opacity 优先；常规 150–300ms、覆盖层 300–400ms。
   ═══════════════════════════════════════════════════════════════════════ */
.ofm_root{--ease-instrument:cubic-bezier(.16,1,.3,1);--ease-settle:cubic-bezier(.34,1.4,.4,1);--gap:14px;display:flex;flex-direction:column;gap:calc(var(--gap)*1.4);max-width:1080px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
.ofm_root::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.022;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E")}
.ofm_root>*{position:relative;z-index:1}
.ofm_root *{box-sizing:border-box}
.ofm_root ::-webkit-scrollbar{width:10px;height:10px}
.ofm_root ::-webkit-scrollbar-track{background:transparent}
.ofm_root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 32%,transparent);border-radius:99px;border:2.5px solid transparent;background-clip:padding-box}
.ofm_root ::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 52%,transparent);background-clip:padding-box;border:2.5px solid transparent}
.ofm_root{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 32%,transparent) transparent}

.ofm_root ::selection{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent)}
/* ── 键盘可达性：只给键盘聚焦画聚焦环，鼠标点击不出现 ─────────────────── */
.ofm_root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,transparent);outline-offset:2px;box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent)}
/* ══ 页头 hero ═════════════════════════════════════════════════════════ */
.ofm_hero{position:relative;display:flex;flex-direction:column;gap:14px;padding:22px 24px;border-radius:20px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent));overflow:hidden}
.ofm_hero::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 150% at 12% -20%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 58%),radial-gradient(90% 120% at 88% 130%,color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent),transparent 60%)}
.ofm_hero>*{position:relative}
.ofm_pagehead{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.ofm_pagetitle{display:flex;flex-direction:column;gap:6px;min-width:0}
.ofm_pagetitle h2{margin:0;font-size:23px;font-weight:760;letter-spacing:-.6px;line-height:1.2;background:linear-gradient(120deg,var(--dsw-alias-label-primary) 20%,color-mix(in srgb,var(--dsw-alias-label-primary) 55%,var(--dsw-alias-state-business-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ofm_pagesub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:70ch}
.ofm_pagehead .ofm_pills{margin-left:auto}
.ofm_pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.ofm_pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;transition:border-color .16s ease,color .16s ease}
.ofm_pill.strong{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ofm_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
@keyframes ofm-dot-breathe{0%,100%{opacity:1}50%{opacity:.55}}
.ofm_dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);animation:ofm-dot-breathe 2.6s ease-in-out infinite}
.ofm_dot.warn{background:var(--dsw-alias-state-warning-primary,#f0a441);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 18%,transparent)}
.ofm_dot.err{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}
/* ══ 区块与分节 ════════════════════════════════════════════════════════ */
.ofm_sec{display:flex;flex-direction:column;gap:10px}
.ofm_sechead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ofm_sec_title{font-size:14px;font-weight:680;letter-spacing:-.2px}
.ofm_sec_hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto;flex:1 1 340px;min-width:0;max-width:100%;text-align:right;line-height:1.5}
.ofm_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:10px}
/* ══ 卡片（双层 bezel：hairline 边框 + 顶部内高光 + 柔和外阴影） ═══════ */
.ofm_card{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px 13px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 1px 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent),0 3px 10px color-mix(in srgb,var(--dsw-alias-state-business-primary) 4%,transparent);transition:transform .2s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .18s ease}
.ofm_card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 66%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 9%),0 16px 34px color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.ofm_card.dim{opacity:.68}
.ofm_cardhead{display:flex;align-items:center;gap:8px}
.ofm_cardname{font-size:13.5px;font-weight:650;letter-spacing:-.1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_badge{margin-left:auto;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);white-space:nowrap}
.ofm_badge.available{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.ofm_badge.region-blocked{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 10%,transparent)}
.ofm_badge.throttled{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 10%,transparent)}
.ofm_badge.unavailable{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.ofm_badge.unknown{color:var(--dsw-alias-label-tertiary)}
.ofm_id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_tags{display:flex;gap:5px;flex-wrap:wrap}
.ofm_tag{font-size:10.5px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.ofm_chantag{font-size:10px;font-weight:650;padding:2px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);color:var(--dsw-alias-state-business-primary);white-space:nowrap}
.ofm_metrics{display:flex;gap:12px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.ofm_metrics b{color:var(--dsw-alias-label-secondary);font-weight:600;font-variant-numeric:tabular-nums}
.ofm_note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
/* ══ 面板 ══════════════════════════════════════════════════════════════ */
.ofm_panel{padding:16px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 2px 6px rgb(0 0 0 / 4%);display:flex;flex-direction:column;gap:12px}
.ofm_paneltitle{font-size:12px;font-weight:680;letter-spacing:.2px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.ofm_paneltitle .ofm_sec_hint{font-weight:400;letter-spacing:0}
/* 兼容折叠区（宿主网关 A + 中继 C）：整条是按钮，视觉上比主路径的 Section 轻。 */
.ofm_compat-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;padding:10px 14px;margin:0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;text-align:left}
.ofm_compat-toggle:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent)}
.ofm_compat-toggle .ofm_note{display:block;margin-top:2px}
.ofm_compat-body{display:flex;flex-direction:column;gap:14px;margin-top:12px}
.ofm_row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
/* ══ 请求热度图 ════════════════════════════════════════════════════════ */
.ofm_heat{display:grid;grid-auto-flow:column;grid-auto-columns:12px;grid-template-rows:repeat(7,12px);justify-content:start;gap:2px;overflow-x:auto;padding:2px 0 6px}
.ofm_cell{width:12px;height:12px;border-radius:3.5px;background:var(--dsw-alias-bg-layer-1);outline:1px solid var(--dsw-alias-border-l1);outline-offset:-1px;transition:transform .14s ease,background .3s ease}
.ofm_cell:hover{transform:scale(1.25)}
.ofm_cell.l1{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent);outline-color:transparent}
.ofm_cell.l2{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);outline-color:transparent}
.ofm_cell.l3{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 68%,transparent);outline-color:transparent}
.ofm_cell.l4{background:var(--dsw-alias-state-business-primary);outline-color:transparent}
.ofm_scale{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.ofm_scale .ofm_cell{width:10px;height:10px}
/* ══ 分段选择器 ════════════════════════════════════════════════════════ */
.ofm_seg{display:inline-flex;padding:3px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);gap:2px;box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%)}
.ofm_seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:550;padding:3px 11px;border-radius:8px;cursor:pointer;transition:color .16s ease,background .16s ease,box-shadow .16s ease}
.ofm_seg button:hover{color:var(--dsw-alias-label-primary)}
.ofm_seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px rgb(0 0 0 / 12%),inset 0 1px 0 rgb(255 255 255 / 6%)}
.ofm_svg{display:block;width:100%;height:auto;overflow:visible}
/* ══ 筛选 chips ════════════════════════════════════════════════════════ */
.ofm_chips{display:flex;gap:6px;flex-wrap:wrap}
.ofm_chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);cursor:pointer;color:var(--dsw-alias-label-secondary);transition:border-color .16s ease,color .16s ease,background .16s ease}
.ofm_chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ofm_chip[aria-pressed="true"]{border-color:color-mix(in srgb,currentColor 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent)}
.ofm_swatch{width:8px;height:8px;border-radius:3px;flex:none}
/* ══ 数据表格 ══════════════════════════════════════════════════════════ */
.ofm_table{width:100%;min-width:760px;border-collapse:collapse;font-size:11.5px}
.ofm_tablewrap{overflow-x:auto;max-width:100%}
.ofm_table th{text-align:left;font-weight:560;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);padding:0 10px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.ofm_table td{padding:7px 10px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 62%,transparent);font-variant-numeric:tabular-nums}
.ofm_table td:first-child{font-weight:600}
.ofm_table tbody tr{transition:background .15s ease}
.ofm_table tbody tr:hover td{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 5%,transparent)}
.ofm_table tr:last-child td{border-bottom:0}
.ofm_num{text-align:right}
/* ══ 按钮（分层状态） ══════════════════════════════════════════════════ */
.ofm_btn{font:inherit;font-size:12px;font-weight:580;padding:6px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 84%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 6%);color:var(--dsw-alias-label-primary);cursor:pointer;transition:transform .18s var(--ease-instrument),border-color .2s var(--ease-instrument),background .2s var(--ease-instrument),box-shadow .22s var(--ease-instrument),opacity .16s ease}
.ofm_btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-bg-layer-3));transform:translateY(-1px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 3px 8px rgb(0 0 0 / 9%)}
.ofm_btn:active:not(:disabled){transform:scale(.985);transition-duration:.1s;box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%)}
.ofm_btn:disabled{opacity:.45;cursor:default;box-shadow:none;transform:none}
.ofm_btn.primary{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#fff),var(--dsw-alias-state-business-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,#000);color:var(--dsw-alias-label-on-accent,#fff);box-shadow:inset 0 1px 0 rgb(255 255 255 / 18%),0 2px 8px color-mix(in srgb,var(--dsw-alias-state-business-primary) 32%,transparent)}
.ofm_btn.primary:hover:not(:disabled){background:linear-gradient(180deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#000));border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 1px 0 rgb(255 255 255 / 20%),0 4px 14px color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,transparent)}
.ofm_btn.ghost{background:transparent;box-shadow:none;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.ofm_btn.ghost:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.ofm_minibtn{font:inherit;font-size:11px;font-weight:540;padding:3px 9px;border-radius:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 85%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 70%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:transform .12s ease,border-color .16s ease,color .16s ease,background .16s ease,opacity .16s ease}
.ofm_minibtn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 60%,transparent);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent);transform:translateY(-1px)}
.ofm_minibtn:active:not(:disabled){transform:scale(.96)}
.ofm_minibtn:disabled{opacity:.45;cursor:default;transform:none}
.ofm_minibtn.danger:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
/* ══ 表单 ══════════════════════════════════════════════════════════════ */
.ofm_field{display:flex;flex-direction:column;gap:4px;min-width:120px}
.ofm_field>span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ofm_input{font:inherit;font-size:12px;padding:6px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%);color:var(--dsw-alias-label-primary);min-width:0;width:100%;transition:border-color .16s ease,box-shadow .16s ease}
.ofm_input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ofm_input:hover{border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 60%,var(--dsw-alias-label-tertiary))}
.ofm_input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
/* ══ 开关（spring 滑块） ═══════════════════════════════════════════════ */
.ofm_switch{display:inline-flex;align-items:center;gap:9px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent}
.ofm_switch i{width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:inset 0 1px 3px rgb(0 0 0 / 8%);position:relative;transition:background .2s ease,border-color .2s ease,box-shadow .2s ease;flex:none}
.ofm_switch:hover i{filter:brightness(1.05)}
.ofm_switch[aria-checked="true"]:hover i{filter:brightness(1.08)}
.ofm_switch i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);box-shadow:0 1px 3px rgb(0 0 0 / 22%);transition:transform .26s cubic-bezier(.34,1.3,.64,1),background .2s ease,width .16s ease}
.ofm_switch:active i::after{width:17px}
.ofm_switch[aria-checked="true"] i{background:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,#000);box-shadow:inset 0 1px 3px rgb(0 0 0 / 12%)}
.ofm_switch[aria-checked="true"] i::after{transform:translateX(16px);background:#fff}
.ofm_switch[aria-checked="true"]:active i::after{transform:translateX(13px)}
.ofm_switch:focus-visible i{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.ofm_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;padding:7px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow-x:auto;white-space:pre;color:var(--dsw-alias-label-secondary)}
/* ══ 提示条 ════════════════════════════════════════════════════════════ */
.ofm_callout{display:flex;gap:9px;padding:10px 12px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent);font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.ofm_error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
.ofm_callout p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px}
.ofm_callout b{font-weight:650}
/* ══ 小组件统计 ════════════════════════════════════════════════════════ */
.ofm_stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px}
.ofm_stat{padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 78%,transparent);border:1px solid var(--dsw-alias-border-l1);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%)}
.ofm_stat b{display:block;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.ofm_stat span{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
/* ══ 公告（首次引导） ══════════════════════════════════════════════════ */
/* The onboarding slot is mounted inside the collapsed sidebar foot of the shell,
   so a card that stays in flow inherits a 55 px-wide, overflow-hidden column. The
   scrim is therefore fixed to the viewport; the shell sets no transform, filter
   or contain on any ancestor, so nothing re-anchors it. Mask colour, blur and
   z-index mirror the Modal layer of the shell so this reads as first-party. */
.ofm_scrim{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 32%));backdrop-filter:var(--dsw-mask-blur, blur(8px)) saturate(140%);-webkit-backdrop-filter:var(--dsw-mask-blur, blur(8px)) saturate(140%);animation:ofm-fadein .24s ease}
@keyframes ofm-fadein{from{opacity:0}to{opacity:1}}
.ofm_ann{width:min(620px,92vw);max-height:min(86vh,640px);border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 94%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 28px 80px rgb(0 0 0 / 40%);overflow:hidden;display:flex;flex-direction:column;animation:ofm-popin .36s cubic-bezier(.16,1,.3,1)}
@keyframes ofm-popin{from{opacity:0;transform:translateY(16px) scale(.965)}to{opacity:1;transform:none}}
.ofm_annhead{padding:18px 22px 12px;display:flex;flex-direction:column;gap:8px;background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent),transparent 75%)}
.ofm_anntitle{margin:0;font-size:18px;font-weight:730;letter-spacing:-.4px}
.ofm_annsub{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ofm_steps{display:flex;gap:6px;padding:0 22px 14px}
.ofm_step{height:3px;flex:1;border-radius:99px;background:var(--dsw-alias-border-l2);transition:background .3s ease}
.ofm_step[data-on="true"]{background:var(--dsw-alias-state-business-primary);box-shadow:0 0 6px color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}
.ofm_annbody{padding:2px 22px 18px;max-height:min(48vh,420px);overflow:auto;display:flex;flex-direction:column;gap:12px}
.ofm_annbody h3{margin:0;font-size:13.5px;font-weight:660}
.ofm_annbody p,.ofm_annbody li{font-size:12.5px;line-height:1.72;color:var(--dsw-alias-label-secondary);margin:0}
.ofm_annbody ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px}
.ofm_annfoot{display:flex;align-items:center;gap:10px;padding:13px 22px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}
.ofm_annfoot .spacer{margin-left:auto}
.ofm_kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.ofm_kvc{padding:9px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 74%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);display:flex;flex-direction:column;gap:3px}
.ofm_kvc b{font-size:12.5px;font-variant-numeric:tabular-nums}
.ofm_kvc span{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ofm_two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
/* ══ 公告中心 ══════════════════════════════════════════════════════════ */
.ofm_news{display:flex;flex-direction:column;gap:10px}
.ofm_newsitem{display:flex;flex-direction:column;gap:7px;padding:13px 15px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);position:relative;transition:border-color .18s ease,transform .2s cubic-bezier(.32,.72,0,1),box-shadow .22s ease}
.ofm_newsitem:hover{transform:translateY(-1px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 8px 22px rgb(0 0 0 / 10%)}
.ofm_newsitem.unread{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}
.ofm_newsdot{position:absolute;top:14px;right:14px;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.ofm_newshead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-right:16px}
.ofm_newstitle{font-size:13px;font-weight:650;letter-spacing:-.1px}
.ofm_level{font-size:10.5px;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ofm_level.info{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent)}
.ofm_level.update{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
.ofm_level.warn{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent)}
.ofm_level.urgent{color:#fff;background:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,#000)}
.ofm_newsmeta{display:flex;gap:10px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.ofm_newsbody{font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ofm_newsbody p{margin:0 0 6px}
.ofm_newsbody p:last-child{margin-bottom:0}
.ofm_newsbody h1,.ofm_newsbody h2,.ofm_newsbody h3,.ofm_newsbody h4{margin:6px 0 4px;font-size:13px;line-height:1.4}
.ofm_newsbody ul,.ofm_newsbody ol{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px}
.ofm_newsbody code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 5px}
.ofm_newsbody pre{margin:4px 0;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow-x:auto}
.ofm_newsbody pre code{background:transparent;border:0;padding:0}
.ofm_newsbody blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);color:var(--dsw-alias-label-tertiary)}
.ofm_newsbody img{max-width:100%;border-radius:8px}
.ofm_newsbody a{color:var(--dsw-alias-state-business-primary);text-decoration:none}
.ofm_newsbody a:hover{text-decoration:underline}
.ofm_newsbody table{border-collapse:collapse;font-size:12px}
.ofm_newsbody th,.ofm_newsbody td{border:1px solid var(--dsw-alias-border-l1);padding:3px 8px}
.ofm_newsbody hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0}
.ofm_newsbody mark{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 30%,transparent);border-radius:2px;padding:0 2px}
.ofm_upgradecards{display:flex;gap:8px;flex-wrap:wrap}
.ofm_upnotes{max-height:220px;overflow:auto;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
/* ══ 进度条 ════════════════════════════════════════════════════════════ */
.ofm_prog{height:4px;border-radius:99px;background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 2px rgb(0 0 0 / 6%);overflow:hidden}
.ofm_prog i{display:block;height:100%;width:40%;border-radius:99px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent),var(--dsw-alias-state-business-primary));animation:ofm-prog-slide 1.1s ease-in-out infinite}
.ofm_prog i{position:relative;overflow:hidden}
.ofm_prog i::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent) 50%,transparent 70%);transform:translateX(-100%);animation:ofm-prog-shine 1.6s ease-in-out infinite}
@keyframes ofm-prog-shine{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
@keyframes ofm-prog-slide{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
/* ══ Toast（fixed 到视口，浮在所有层之上） ════════════════════════════ */
.ofm_toasts{position:fixed;right:18px;bottom:18px;z-index:1200;display:flex;flex-direction:column;gap:10px;max-width:min(380px,calc(100vw - 36px));font-family:inherit}
.ofm_toast{position:relative;display:flex;flex-direction:column;gap:6px;padding:12px 14px 12px 16px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 94%,transparent);backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 14px 40px rgb(0 0 0 / 26%);font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);animation:ofm-toast-rise .32s cubic-bezier(.16,1,.3,1);overflow:hidden}
.ofm_toast{transform-origin:bottom right;will-change:transform}
.ofm_toast::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dsw-alias-state-business-primary)}
.ofm_toast.warn::before{background:var(--dsw-alias-state-warning-primary,#f0a441)}
.ofm_toast.urgent::before{background:var(--dsw-alias-state-error-primary)}
.ofm_toast.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 42%,var(--dsw-alias-border-l2))}
.ofm_toast.urgent{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,var(--dsw-alias-border-l2))}
.ofm_toast .ofm_toasttitle{font-weight:660;font-size:12.5px;display:flex;align-items:center;gap:7px}
.ofm_toast .ofm_toastbody{color:var(--dsw-alias-label-secondary);max-height:180px;overflow:auto;overflow-wrap:anywhere}
.ofm_toast .ofm_toastbody p{margin:0 0 5px}
.ofm_toast .ofm_toastbody p:last-child{margin-bottom:0}
.ofm_toast .ofm_toastbody img{max-width:100%}
.ofm_toastactions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.ofm_toastclose{margin-left:auto;background:transparent;border:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:13px;padding:0 2px;transition:color .14s ease}
.ofm_toastclose:hover{color:var(--dsw-alias-label-primary)}
@keyframes ofm-toast-rise{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
/* ══ 模态 ══════════════════════════════════════════════════════════════ */
.ofm_modal{width:min(520px,92vw);max-height:min(80vh,600px);border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 95%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 28px 80px rgb(0 0 0 / 42%);display:flex;flex-direction:column;overflow:hidden;animation:ofm-popin .34s cubic-bezier(.16,1,.3,1)}
/* ══ 模型面板对话框与输入栏快捷条 ══════════════════════════════════════ */
.ofm_panelscrim{z-index:1400;padding:16px}
.ofm_panelmodal{width:min(1120px,96vw);height:min(90vh,900px);max-height:calc(100vh - 32px);border-radius:20px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 30px 90px rgb(0 0 0 / 44%);overflow:hidden;animation:ofm-popin .34s cubic-bezier(.16,1,.3,1)}
.ofm_panelmodal .ofm_shell{max-width:none;height:100%;overflow:hidden;padding:16px 18px 22px;box-sizing:border-box}
.ofm_dlgtabbar{padding:2px 2px 10px}
.ofm_dlghead{display:flex;align-items:center;gap:10px;min-height:34px;padding:0 2px 8px}
.ofm_dlgspacer{flex:1}
.ofm_dlgbody{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:18px;padding:0 2px 4px}
.ofm_dlgbody::-webkit-scrollbar{width:9px}
.ofm_dlgbody::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:8px}
/* ── 模型选择器（对话框）：左提供商、右模型行，点一行即切换 ─────────────── */
.ofm_mpicker{display:flex;flex-direction:column;width:min(94vw,880px);height:min(84vh,640px);max-height:calc(100vh - 32px);border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 30px 90px rgb(0 0 0 / 44%);overflow:hidden;animation:ofm-popin .3s cubic-bezier(.16,1,.3,1)}
.ofm_mpickerhead{display:flex;align-items:center;gap:10px;padding:12px 14px 10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ofm_mpickertitle{font-size:14px;font-weight:700;letter-spacing:-.2px}
.ofm_mpickerspacer{flex:1}
.ofm_mpickerbody{display:flex;flex:1;min-height:0}
.ofm_mpickerrail{flex:none;width:196px;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 46%,transparent)}
.ofm_mpickerrailtitle{padding:12px 14px 6px;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.ofm_mpickerraillist{flex:1;min-height:0;overflow:auto;padding:0 8px 10px;display:flex;flex-direction:column;gap:2px}
.ofm_mpickerraillist::-webkit-scrollbar{width:7px}
.ofm_mpickerraillist::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:8px}
.ofm_mpickerrailrow{display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;font:inherit;font-size:12.5px;text-align:left;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .16s ease,background .16s ease}
.ofm_mpickerrailrow:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 55%,transparent)}
.ofm_mpickerrailrow[data-on="true"]{color:var(--dsw-alias-label-primary);font-weight:600;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,var(--dsw-alias-bg-layer-3));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 32%,transparent)}
.ofm_mpickerrailname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_mpickerrailcount{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.ofm_mpickerpane{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.ofm_mpickertools{padding:10px 14px 4px}
.ofm_mpickerlist{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:2px 10px 12px}
.ofm_mpickerlist::-webkit-scrollbar{width:8px}
.ofm_mpickerlist::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:8px}
.ofm_mpickgroup{display:flex;align-items:center;gap:8px;padding:10px 8px 4px;font-size:10.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.ofm_mpickgroupcount{font-weight:500;letter-spacing:0;text-transform:none;color:var(--dsw-alias-label-dimmed)}
.ofm_mpickitem{display:flex;flex-direction:column}
.ofm_mpickrow{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;font:inherit;border-radius:9px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;transition:background .14s ease,border-color .14s ease}
.ofm_mpickrow:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 66%,transparent)}
.ofm_mpickrow[data-current="true"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 26%,transparent)}
.ofm_mpickrow:disabled{opacity:.55;cursor:default}
.ofm_mpickmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.ofm_mpicknamerow{display:flex;align-items:center;gap:7px;min-width:0}
.ofm_mpickname{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_mpickbadge{flex:none;font-size:9.5px;font-weight:650;padding:1px 6px;border-radius:999px;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent)}
.ofm_mpickdesc{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_mpickid{flex:none;max-width:38%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary);opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_mpickcurrent{flex:none;font-size:10px;font-weight:650;padding:1px 7px;border-radius:999px;color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.ofm_mpickspinner{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ofm_mpickefforts{display:flex;gap:5px;flex-wrap:wrap;padding:0 10px 6px 34px}
.ofm_minibtn[data-on="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}
.ofm_mpickerfoot{display:flex;align-items:center;gap:8px;padding:9px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.ofm_mpickerfoot .ofm_note{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_mpickempty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.ofm_mpickempty b{font-size:13px;color:var(--dsw-alias-label-secondary)}
/* 面板顶部三个页签：模型 / 路由分组 / 失败模型 */
.ofm_mpicktabs{display:flex;gap:2px;padding:3px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 80%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent)}
.ofm_mpicktab{display:inline-flex;align-items:center;gap:5px;padding:5px 11px;font:inherit;font-size:12px;font-weight:600;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}
.ofm_mpicktab:hover{color:var(--dsw-alias-label-primary)}
.ofm_mpicktab[data-on="true"]{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent)}
.ofm_mpicktabnum{font-size:10.5px;font-weight:550;color:var(--dsw-alias-label-tertiary)}
.ofm_mpickgrouprow{display:flex;flex-direction:column;gap:4px;padding:9px 11px;border-radius:10px;border:1px solid transparent;min-width:0;width:100%;box-sizing:border-box;overflow:hidden}
.ofm_mpickgrouprow:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 55%,transparent)}
.ofm_mpickgrouprow[data-current="true"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 26%,transparent)}
.ofm_mpickgrouptop{display:flex;align-items:center;gap:8px;min-width:0}
.ofm_mpickgroupname{font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:0 1 auto}
.ofm_mpickgroupmeta{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ofm_mpickgroupmembers{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;width:100%;box-sizing:border-box}
.ofm_mpickfailedrow{display:flex;align-items:center;gap:10px;padding:8px 11px;border-radius:10px}
.ofm_mpickfailedrow:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 55%,transparent)}
.ofm_mpickfailedmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.ofm_mpickfailedname{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_mpickfailedwhy{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 分组编辑（模型面板内）：一条成员一行，优先级/档位/启停/移出都在右手边 */
.ofm_mpickerrailnew{display:flex;gap:6px;padding:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.ofm_mpickerrailnew .ofm_input{flex:1;min-width:0;font-size:11.5px;padding:5px 8px}
.ofm_mpickmember{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:9px;border:1px solid transparent}
.ofm_mpickmember:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 55%,transparent)}
.ofm_mpickmember[data-off="true"]{opacity:.5}
.ofm_mpickmembermain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.ofm_mpickmembertools{flex:none;display:flex;align-items:center;gap:6px}
.ofm_mpicknum{width:62px;padding:4px 6px;font-size:11.5px;text-align:center}
.ofm_mpickeffort{width:104px;padding:4px 6px;font-size:11px}
.ofm_mpickbadge[data-tone="warn"]{color:var(--dsw-alias-state-error-primary,#c0392b);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 32%,transparent)}
.ofm_mpickbadge[data-tone="region"]{color:var(--dsw-alias-state-warning-primary,#f0a441);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 32%,transparent)}
.ofm_mpickbadge[data-tone="dim"]{color:var(--dsw-alias-label-tertiary);background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 28%,transparent)}
.ofm_mpickrow[data-dead="true"] .ofm_mpickname{color:var(--dsw-alias-label-secondary)}
.ofm_mpickadd{padding:10px 4px 2px;display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--dsw-alias-border-l1);margin-top:8px}
.ofm_mpickaddbar{display:flex;align-items:center;gap:8px}
.ofm_mpickaddbar .ofm_panelsearch{flex:1;max-width:none;margin:0}
.ofm_mpickaddlist{max-height:236px;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;gap:1px;padding:2px 2px 4px 0}
.ofm_mpickaddgroup{display:flex;flex-direction:column;gap:1px}
.ofm_mpickaddgrouphead{display:flex;align-items:center;gap:8px;padding:7px 8px 3px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-caption);position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:1}
.ofm_mpickaddgrouphead .ofm_mpickgroupcount{font-weight:400}
.ofm_mpickaddgrouphead .ofm_minibtn{margin-left:auto;font-size:10px;padding:1px 6px}
.ofm_mpickaddrow{display:flex;align-items:center;gap:10px;padding:5px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.ofm_mpickaddrow:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 55%,transparent)}
.ofm_mpickaddrow[data-picked="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a6cf7) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a6cf7) 32%,transparent)}
.ofm_mpickaddrow[data-added="true"]{opacity:.42;cursor:default;background:none}
.ofm_mpickaddrow input[type="checkbox"]{flex:none;width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary,#4a6cf7);margin:0}
.ofm_mpickaddmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.ofm_mpickaddfoot{display:flex;align-items:center;gap:8px;padding-top:2px}
.ofm_mpickaddfoot .ofm_note{flex:1;min-width:0}
.ofm_chiplabel{display:inline-flex;align-items:center;white-space:nowrap;max-width:100%;min-width:0}
.ofm_chiplabelprovider{opacity:.62;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ofm_chiplabelname{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ofm_chiplabelbadge{flex:none;margin-left:4px;font-size:10px;line-height:14px;padding:0 4px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a6cf7) 14%,transparent);color:inherit}
/* 输入框右侧的余额读数。宿主按「整行需求宽度」二选一：要么全名，要么只剩图标
   （observeControlRow，没有中间档），所以这一行里多出来的每段宽度都直接决定模型名
   能活多久。让位按级进行：读数里的渠道名 → 读数本身 → 芯片的渠道前缀，模型名最后
   消失。容器是宿主 .row 的匿名 inline-size 容器。 */
.ofm_composercredits{display:inline-flex;align-items:center;min-width:0;flex:0 1 auto;overflow:hidden;font-size:12px;line-height:20px;opacity:.72;white-space:nowrap;font-variant-numeric:tabular-nums;margin-right:8px;user-select:none}
.ofm_composercreditlabel,.ofm_composercreditsep,.ofm_composercreditvalue{flex:none}
/* 让位顺序：读数里的渠道名 → 读数整块 → 芯片的渠道前缀，模型名最后消失。
   阈值刻意取在「宿主开始嫌挤」之前：一旦它判定超宽就没有中间档，会直接把
   模型名换成图标，回头再靠 CSS 抢回来只会和它的测量来回抖动。 */
@container (max-width: 860px){.ofm_composercreditlabel,.ofm_composercreditsep{display:none}}
@container (max-width: 700px){.ofm_composercredits{display:none}}
@container (max-width: 680px){.ofm_chiplabelprovider,.ofm_chiplabelsep{display:none}}
@container (max-width: 520px){.ofm_chiplabelbadge{display:none}}
.ofm_panelsearch{width:100%;max-width:360px;box-sizing:border-box;margin:0 0 10px;padding:8px 10px;font:inherit;font-size:12px;border-radius:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 80%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);color:var(--dsw-alias-label-primary);outline:none}
.ofm_panelsearch::placeholder{color:var(--dsw-alias-label-caption)}
.ofm_panelsearch:focus{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 48%,transparent);background:var(--dsw-alias-bg-layer-1)}
.ofm_skeleton{display:flex;flex-direction:column;gap:6px;padding:4px 0}
.ofm_skeletonrow{height:34px;border-radius:9px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 85%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent));background-size:200% 100%;animation:ofm_shimmer 1.4s ease-in-out infinite}
@keyframes ofm_shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.ofm_empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:38px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
.ofm_empty b{font-size:13px;color:var(--dsw-alias-label-secondary)}
.ofm_modellaunch:focus-visible,.ofm_mpickerrailrow:focus-visible,.ofm_mpickrow:focus-visible,.ofm_panelsearch:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);outline-offset:1px}
@media (prefers-reduced-motion: reduce){.ofm_skeletonrow{animation:none}.ofm_mpickerrailrow,.ofm_mpickrow,.ofm_modellaunch{transition:none}}
.ofm_nav .ofm_navact{grid-column:2;grid-row:1;justify-self:end;display:flex;align-items:center;gap:6px}
.ofm_close{width:28px;height:28px;display:grid;place-items:center;font:inherit;font-size:17px;line-height:1;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 66%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:color .16s ease,border-color .16s ease,background .16s ease}
.ofm_close:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 76%,transparent)}
.ofm_dock{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:24px}
.ofm_autochip,.ofm_dockbtn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:11.5px;font-weight:540;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 72%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:color .16s ease,border-color .16s ease,background .16s ease}
.ofm_autochip:hover,.ofm_dockbtn:hover{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-bg-layer-2))}
.ofm_autochip .ofm_dot{width:5px;height:5px}
.ofm_autochipcaret{font-size:9px;opacity:.55;margin-left:1px}
.ofm_dockbtn{border-color:transparent;background:transparent;padding-inline:6px}
.ofm_modelseat{position:relative;display:flex;align-items:center}
.ofm_modellaunch{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;font:inherit;font-size:12px;font-weight:500;white-space:nowrap;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l1));background:var(--dsw-alias-bg-module-platform,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;line-height:1;transition:color .16s ease,border-color .16s ease}
.ofm_modellaunch:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ofm_quickpop{position:fixed;z-index:1500;width:308px;padding:13px 14px;display:flex;flex-direction:column;gap:10px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 96%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 22px 60px rgb(0 0 0 / 38%);animation:ofm-popin .24s cubic-bezier(.16,1,.3,1)}
.ofm_quickpophead{display:flex;flex-direction:column;gap:3px}
.ofm_quickpophead b{font-size:13px;font-weight:680;letter-spacing:-.1px}
.ofm_quickval{display:flex;align-items:baseline;gap:2px;font-variant-numeric:tabular-nums}
.ofm_quickval b{font-size:28px;font-weight:740;letter-spacing:-1px;line-height:1}
.ofm_quickval span{font-size:12px;color:var(--dsw-alias-label-secondary)}
.ofm_quickslider{width:100%;margin:2px 0;accent-color:var(--dsw-alias-state-business-primary)}
.ofm_quickpopfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px}
.ofm_retryevents{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}
.ofm_retryevent{display:flex;align-items:center;gap:8px;min-width:0;padding:4px 0;border-bottom:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}
.ofm_retryevent b{font-size:11.5px;font-weight:620;white-space:nowrap}
.ofm_retryevent .ofm_note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_modalhead{padding:17px 20px 11px;display:flex;align-items:center;gap:10px;font-size:15px;font-weight:720;letter-spacing:-.2px}
.ofm_modalbody{padding:4px 20px 16px;overflow:auto;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.ofm_modalbody p{margin:0 0 6px}
.ofm_modalfoot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}
@media (max-width:720px){.ofm_sec_hint{margin-left:0;width:100%}.ofm_pills{margin-left:0;width:100%}}
/* ══ GitHub star 按钮 ══════════════════════════════════════════════════ */
.ofm_starbtn{position:relative;display:inline-flex;gap:7px;align-items:center;padding:7px 15px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);background:linear-gradient(140deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent),transparent 70%);color:var(--dsw-alias-state-business-primary);text-decoration:none;font-weight:650;font-size:12.5px;transition:transform .18s ease,box-shadow .22s ease,color .22s ease,background .22s ease;white-space:nowrap;overflow:hidden}
.ofm_starbtn svg{transition:transform .5s cubic-bezier(.34,1.56,.64,1)}
.ofm_starbtn:hover svg{transform:rotate(72deg) scale(1.12)}
.ofm_starbtn:hover{box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent),0 6px 16px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.ofm_starbtn:active svg{transform:rotate(72deg) scale(.94)}
.ofm_starbtn svg{width:14px;height:14px;fill:currentColor;transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
.ofm_starbtn:hover{transform:translateY(-1px);box-shadow:0 8px 22px color-mix(in srgb,var(--dsw-alias-state-business-primary) 34%,transparent);background:linear-gradient(140deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,#3ECFA0));color:#fff}
.ofm_starbtn:active{transform:scale(.97)}
.ofm_starbtn:hover svg{transform:rotate(-72deg) scale(1.12)}
.ofm_starbtn::after{content:"";position:absolute;top:0;bottom:0;width:38%;left:-45%;background:linear-gradient(100deg,transparent,rgb(255 255 255 / 34%),transparent);transform:skewX(-18deg);transition:left .55s ease}
.ofm_starbtn:hover::after{left:112%}
.ofm_starlink{display:inline-flex;align-items:center;gap:6px;text-decoration:none}
/* ══ 鱼缸（品牌装饰：玻璃缸 + 水位 + 波光 + 鱼群） ════════════════════ */
.ofm_tank{position:relative;width:206px;height:128px;border-radius:16px;overflow:hidden;flex:none;background:linear-gradient(180deg,rgba(127,166,255,.10),rgba(127,166,255,.03));box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.ofm_tankwater{position:absolute;left:0;right:0;bottom:0;height:var(--lvl,0%);transition:height 1.4s cubic-bezier(.22,.61,.36,1)}
.ofm_tank.ok .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,transparent),var(--dsw-alias-state-business-primary))}
.ofm_tank.busy .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 72%,transparent),var(--dsw-alias-state-warning-primary,#f0a441))}
.ofm_tank.over .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-error-primary) 72%,transparent),var(--dsw-alias-state-error-primary))}
.ofm_tankdeep{position:absolute;inset:0;overflow:hidden}
.ofm_wave{position:absolute;left:0;top:-6px;width:200%;height:7px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 8' preserveAspectRatio='none'%3E%3Cpath d='M0 4 Q15 0 30 4 T60 4 T90 4 T120 4 V8 H0Z' fill='rgba(255,255,255,.45)'/%3E%3C/svg%3E") repeat-x;background-size:60px 7px;animation:ofmwave 5.5s linear infinite}
.ofm_wave.w2{top:-4px;opacity:.45;animation-duration:8.5s;animation-direction:reverse}
@keyframes ofmwave{to{transform:translateX(60px)}}
.ofm_bubble{position:absolute;bottom:-8px;width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.5);opacity:0;animation:ofmbub 7s ease-in infinite}
.ofm_bubble.b1{left:14%;animation-delay:0s}
.ofm_bubble.b2{left:32%;width:3px;height:3px;animation-delay:2.2s;animation-duration:9s}
.ofm_bubble.b3{left:55%;animation-delay:4.1s}
.ofm_bubble.b4{left:71%;width:7px;height:7px;animation-delay:1.3s;animation-duration:8s}
.ofm_bubble.b5{left:86%;width:4px;height:4px;animation-delay:5.4s;animation-duration:10s}
@keyframes ofmbub{0%{transform:translateY(0);opacity:0}12%{opacity:.75}100%{transform:translateY(-136px);opacity:0}}
.ofm_fish{position:absolute;left:-34px;width:26px;height:13px;animation:ofmswim 12s linear infinite;will-change:transform;filter:drop-shadow(0 1px 2px rgb(0 0 0 / 18%))}
.ofm_fish.f1{bottom:14px}
.ofm_fish.f1 svg,.ofm_fish.f3 svg{transform:scaleX(-1)}
.ofm_fish.f2{bottom:44px;animation-duration:16s;animation-delay:-7s;animation-name:ofmswimrev}
.ofm_fish.f3{bottom:68px;width:19px;height:10px;animation-duration:9.5s;animation-delay:-3.5s}
.ofm_fish svg{display:block;width:100%;height:100%;fill:rgba(255,255,255,.82)}
@keyframes ofmswim{0%{transform:translateX(0)}100%{transform:translateX(270px)}}
@keyframes ofmswimrev{0%{transform:translateX(270px)}100%{transform:translateX(0)}}
.ofm_tankglass{position:absolute;inset:0;pointer-events:none;border-radius:16px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.16),inset 0 18px 32px rgba(255,255,255,.06),inset 0 -12px 24px rgba(0,0,0,.10)}
.ofm_tankrays{position:absolute;inset:-30% -12%;pointer-events:none;opacity:.5;background:repeating-linear-gradient(104deg,rgb(255 255 255 / 7%) 0 9px,transparent 9px 30px);mix-blend-mode:soft-light;animation:ofmrays 11s ease-in-out infinite alternate}
@keyframes ofmrays{from{transform:translateX(-14px) rotate(-.4deg)}to{transform:translateX(14px) rotate(.4deg)}}
.ofm_tankshine{position:absolute;inset:0;pointer-events:none;background:linear-gradient(196deg,rgb(255 255 255 / 13%) 0%,transparent 32%)}
.ofm_tankempty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:560;letter-spacing:.04em;color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 80%,transparent)}
@media (prefers-reduced-motion:reduce){.ofm_wave,.ofm_bubble,.ofm_fish,.ofm_tankrays{animation:none}}
/* ══ 三页外壳：极光底 · 毛玻璃导航 · 页过渡 ═════════════════════════════
   The aurora is a fixed layer *inside* our root: a flat shell background gives
   backdrop-filter nothing to sample, so every glass surface would read as a
   plain translucent box. It sits at z-index:-1 with isolation:isolate on the
   shell, which keeps it behind our content and above the app background without
   ever escaping into the shell's own stacking order. */
.ofm_shell{position:relative;display:flex;flex-direction:column;gap:18px;max-width:1120px;width:100%;height:100%;overflow-y:auto;overflow-x:hidden;margin:0 auto;padding:10px 26px 34px;box-sizing:border-box;isolation:isolate}
.ofm_shell::-webkit-scrollbar{width:10px}
.ofm_shell::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:8px}
.ofm_shell::-webkit-scrollbar-track{background:transparent}
.ofm_aurora{position:fixed;inset:0;z-index:-1;pointer-events:none;overflow:hidden}
.ofm_aurora i{position:absolute;display:block;border-radius:50%;filter:blur(70px);opacity:.42;animation:ofmdrift 44s ease-in-out infinite alternate}
.ofm_aurora i:nth-child(1){width:46vw;height:46vw;left:-12vw;top:-14vw;background:radial-gradient(circle,color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,transparent),transparent 68%)}
.ofm_aurora i:nth-child(2){width:38vw;height:38vw;right:-10vw;top:4vh;background:radial-gradient(circle,rgba(62,207,160,.42),transparent 70%);animation-duration:56s;animation-delay:-12s}
.ofm_aurora i:nth-child(3){width:42vw;height:42vw;left:22vw;bottom:-18vw;background:radial-gradient(circle,rgba(227,106,166,.34),transparent 70%);animation-duration:64s;animation-delay:-26s}
@keyframes ofmdrift{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(3vw,2vh,0) scale(1.09)}100%{transform:translate3d(-3vw,-2vh,0) scale(.96)}}
.ofm_nav{position:sticky;top:0;z-index:30;display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px 12px;padding:10px 12px;border-radius:16px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 82%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 62%,transparent);backdrop-filter:blur(20px) saturate(160%);-webkit-backdrop-filter:blur(20px) saturate(160%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 8px 26px rgb(0 0 0 / 10%)}
.ofm_navbrand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:14px;letter-spacing:-.2px;white-space:nowrap}
.ofm_navmark{width:26px;height:26px;border-radius:9px;display:grid;place-items:center;flex:none;background:linear-gradient(145deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,#3ECFA0));box-shadow:0 4px 12px color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent),inset 0 1px 0 rgb(255 255 255 / 22%)}
.ofm_navmark svg{width:16px;height:16px;fill:#fff}
.ofm_tabs{position:relative;grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:13px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 80%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);box-shadow:inset 0 1px 2px rgb(0 0 0 / 4%)}
.ofm_tabglider{position:absolute;top:0;left:0;border-radius:10px;background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 92%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent));box-shadow:0 3px 10px rgb(0 0 0 / 14%),inset 0 1px 0 rgb(255 255 255 / 9%);transition:transform .34s cubic-bezier(.22,.61,.36,1),width .34s cubic-bezier(.22,.61,.36,1),height .34s cubic-bezier(.22,.61,.36,1);pointer-events:none}
.ofm_tab{position:relative;z-index:1;font:inherit;font-size:12px;font-weight:600;padding:6px 13px;border-radius:10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:color .2s ease}
.ofm_tab[data-on="true"]{color:var(--dsw-alias-label-primary)}
.ofm_tab:hover{color:var(--dsw-alias-label-primary)}
.ofm_tab .ofm_tabnum{font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-label-tertiary);margin-left:6px;font-size:11px}
.ofm_navspacer{display:none}
/* The star belongs beside the brand: grid auto-placement would push it below
   the tabs row (they come first in the DOM) and stretch it across the row. */
.ofm_nav .ofm_starbtn{grid-column:2;grid-row:1;justify-self:end}
.ofm_page{display:flex;flex-direction:column;gap:20px;animation:ofmpagein .4s cubic-bezier(.16,1,.3,1)}
@keyframes ofmpagein{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
/* ── 毛玻璃表面：只给大块面用 backdrop-filter，小卡片用半透明叠层，滚动更顺 */
.ofm_glass{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 68%,transparent);backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 12px 34px rgb(0 0 0 / 9%)}
.ofm_root .ofm_hero,.ofm_root .ofm_panel,.ofm_root .ofm_ann,.ofm_root .ofm_modal{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent);backdrop-filter:blur(18px) saturate(155%);-webkit-backdrop-filter:blur(18px) saturate(155%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 14px 40px rgb(0 0 0 / 10%)}
/* ══ 鱼缸加大版（页头） ════════════════════════════════════════════════ */
.ofm_tankrow{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.ofm_tankside{flex:1;min-width:236px;display:flex;flex-direction:column;gap:11px;justify-content:center}
.ofm_tank.xl{width:264px;height:148px;border-radius:20px;box-shadow:inset 0 0 0 1px rgb(255 255 255 / 12%),0 16px 40px rgb(0 0 0 / 14%)}
.ofm_tank.xl .ofm_tankglass{border-radius:20px}
/* ══ 渠道接入页 ════════════════════════════════════════════════════════ */
.ofm_chanwrap{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px;align-items:start}
.ofm_chan{position:relative;display:flex;flex-direction:column;gap:12px;padding:16px 17px 15px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 5%);overflow:hidden;transition:transform .22s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .2s ease}
.ofm_chan::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,var(--chan-accent,var(--dsw-alias-state-business-primary)),transparent 78%);opacity:.95}
.ofm_chan:hover{transform:translateY(-3px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 18px 40px rgb(0 0 0 / 15%);border-color:color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 55%,transparent)}
.ofm_chan.off{opacity:.62}
.ofm_chanhead{display:flex;align-items:center;gap:11px}
.ofm_chanlogo{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;flex:none;font-weight:800;font-size:13px;color:#fff;letter-spacing:-.3px;background:linear-gradient(150deg,var(--chan-accent,var(--dsw-alias-state-business-primary)),color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 45%,#101828));box-shadow:0 6px 16px color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 34%,transparent),inset 0 1px 0 rgb(255 255 255 / 22%)}
.ofm_chan:hover .ofm_chanlogo{transform:scale(1.06) rotate(-3deg);transition:transform .35s cubic-bezier(.34,1.56,.64,1)}
.ofm_chanlogo{transition:transform .35s cubic-bezier(.34,1.56,.64,1)}
.ofm_chanid{display:flex;flex-direction:column;gap:2px;min-width:0}
.ofm_chanid b{font-size:14px;font-weight:700;letter-spacing:-.2px}
.ofm_chanid span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ofm_chanstate{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);padding:3px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);white-space:nowrap}
.ofm_chanmeta{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.ofm_chanmeta b{color:var(--dsw-alias-label-secondary);font-weight:650;font-variant-numeric:tabular-nums}
.ofm_chanacts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ofm_acctlist{display:flex;flex-direction:column;gap:6px}
.ofm_acct{display:flex;align-items:center;flex-wrap:wrap;gap:9px;padding:7px 10px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 82%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);font-size:12px;transition:border-color .16s ease,background .16s ease}
.ofm_acct:hover{border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent)}
.ofm_acct.pending{border-style:dashed}
.ofm_acctname{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.ofm_acctmeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ofm_balanceerror{flex-basis:100%;overflow-wrap:anywhere;color:var(--dsw-alias-state-error-primary);font-size:11px}
.ofm_acctacts{margin-left:auto;display:flex;gap:5px;flex-wrap:wrap}
.ofm_modellist{display:flex;flex-direction:column;gap:4px;max-height:238px;overflow:auto;padding-right:2px}
.ofm_modellist.tall{max-height:none}
.ofm_cataloghero{padding:14px 18px !important}
.ofm_cataloghead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ofm_cataloghead h2{margin:0;font-size:19px;letter-spacing:-.02em}
.ofm_catalogsub{margin:2px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.ofm_cataloglist{display:grid;grid-template-columns:repeat(auto-fill,minmax(236px,1fr));gap:8px;max-height:none}
.ofm_catalogrow{display:flex;flex-direction:column;gap:7px;padding:10px 11px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 62%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 48%,transparent);transition:border-color .15s ease,background .15s ease}
.ofm_catalogrow:hover{border-color:color-mix(in srgb,var(--dsw-alias-border-l1) 92%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 75%,transparent)}
.ofm_catalogrow.off{opacity:.55}
.ofm_catalogmain{min-width:0}
.ofm_catalogname{font-size:12.5px;font-weight:560;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ofm_catalogid{margin-top:1px;font-size:10px;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ofm_catalogtags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.ofm_catalogrow .ofm_badge{margin-left:0}
.ofm_catalogtools{display:flex}
.ofm_cataloghead .ofm_btn{padding:7px 13px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 80%,transparent);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}
.ofm_cataloghead .ofm_btn:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent)}
.ofm_modelrow{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);font-size:11.5px;transition:background .15s ease}
.ofm_modelrow:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 85%,transparent)}
.ofm_modelrow.off{opacity:.5}
.ofm_modelrow .ofm_id{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.ofm_tagpill{font-size:10px;font-weight:560;padding:1px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ofm_tagpill.free{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.ofm_tagpill.dead{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.ofm_chanfold{border-top:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 85%,transparent);padding-top:10px;display:flex;flex-direction:column;gap:8px}
.ofm_foldtoggle{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;cursor:pointer;font-family:inherit;padding:0;transition:color .15s ease}
.ofm_foldtoggle svg{transition:transform .3s cubic-bezier(.32,.72,0,1)}
.ofm_foldtoggle:hover svg{transform:translateY(1px)}
.ofm_foldtoggle:hover{color:var(--dsw-alias-label-primary)}
.ofm_foldtoggle svg{width:10px;height:10px;fill:currentColor;transition:transform .22s ease}
.ofm_foldtoggle[data-open="true"] svg{transform:rotate(90deg)}
/* ══ 骨架屏 ════════════════════════════════════════════════════════════ */
.ofm_skel{position:relative;overflow:hidden;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent);min-height:96px;animation:ofmpulse 1.8s ease-in-out infinite}
.ofm_skel::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent) 50%,transparent 70%);transform:translateX(-100%);animation:ofm-skel-shine 1.8s ease-in-out infinite}
@keyframes ofm-skel-shine{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
.ofm_skel::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent,rgb(255 255 255 / 8%) 42%,transparent 74%);animation:ofmshine 1.5s ease-in-out infinite}
@keyframes ofmshine{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes ofmpulse{0%,100%{opacity:1}50%{opacity:.55}}
/* ══ 登录引导 ══════════════════════════════════════════════════════════ */
.ofm_loginbody{display:flex;flex-direction:column;gap:14px}
.ofm_loginstep{display:flex;gap:11px;align-items:flex-start;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ofm_loginstep b{flex:none;width:21px;height:21px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:650;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);color:var(--dsw-alias-state-business-primary)}
.ofm_scanline{animation:ofmscan 2.2s ease-in-out infinite}
@keyframes ofmscan{0%,100%{opacity:.35}50%{opacity:.85}}
/* ══ 数据看板 KPI ══════════════════════════════════════════════════════ */
.ofm_kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.ofm_kpi{display:flex;flex-direction:column;gap:6px;padding:15px 17px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 5%);transition:transform .22s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .2s ease}
.ofm_kpi:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 16px 36px rgb(0 0 0 / 13%)}
.ofm_kpilabel{font-size:11px;font-weight:560;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.ofm_kpivalue{font-size:25px;font-weight:760;letter-spacing:-.7px;line-height:1.15;font-variant-numeric:tabular-nums;background:linear-gradient(120deg,var(--dsw-alias-label-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-label-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ofm_kpi:hover .ofm_kpivalue{transform:translateY(-1px);transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
.ofm_kpivalue{transition:transform .3s cubic-bezier(.34,1.56,.64,1);display:inline-block}
.ofm_kpisub{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ofm_kpi.warn .ofm_kpivalue{-webkit-text-fill-color:var(--dsw-alias-state-warning-primary,#f0a441);background:none}
.ofm_logfailed td{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,transparent)}
/* ══ 真实图标与积分展示 ════════════════════════════════════════════════ */
.ofm_navmark img,.ofm_chanlogo img{width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block}
.ofm_chanlogo{padding:0;overflow:hidden}
.ofm_credittotal b{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}
.ofm_creditbadge{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent);color:var(--dsw-alias-state-warning-primary,#f0a441);white-space:nowrap}
.ofm_creditbadge.strong{max-width:100%;white-space:normal;overflow-wrap:anywhere;color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
/* ══ 账号池状态 ════════════════════════════════════════════════════════ */
.ofm_pooltop{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ofm_poolbadge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);font-size:12.5px;font-weight:650;white-space:nowrap}
.ofm_pooldot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.ofm_poolbadge.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.ofm_poolbadge.ok .ofm_pooldot{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.ofm_poolbadge.busy{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 40%,transparent)}
.ofm_poolbadge.busy .ofm_pooldot{background:var(--dsw-alias-state-warning-primary,#f0a441);animation:ofmpulse 1.4s ease-in-out infinite}
.ofm_poolbadge.over{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.ofm_poolbadge.over .ofm_pooldot{background:var(--dsw-alias-state-error-primary);animation:ofmpulse .8s ease-in-out infinite}
.ofm_poolstats{display:flex;gap:22px;flex-wrap:wrap}
.ofm_poolstats .ofm_stat b{font-size:19px}
.ofm_poolstats .ofm_stat.hot b{color:var(--dsw-alias-state-error-primary)}
.ofm_poolstats .ofm_stat.warn b{color:var(--dsw-alias-state-warning-primary,#f0a441)}
.ofm_poolmeta{display:flex;gap:8px 18px;align-items:baseline;flex-wrap:wrap;justify-content:space-between}
@media (max-width:760px){.ofm_tank.xl{width:100%;max-width:340px}.ofm_tab{flex:1 1 auto;text-align:center}}
/* ══ 动效降级：用户系统开启"减少动态效果"时全部收敛 ═══════════════════ */
/* —— 交互锚点增强：激活态 / 状态色 / 加载态（additive，不改既有规则） —— */
/* tab：激活项在滑块底衬之上再补一道品牌下划线，选中更明确 */
.ofm_tab[aria-selected="true"]{color:var(--dsw-alias-label-primary)}
.ofm_tab[aria-selected="true"]::after{content:"";position:absolute;left:12px;right:12px;bottom:3px;height:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary);opacity:.85;transition:opacity .18s cubic-bezier(.32,.72,0,1)}
/* 渠道卡：随接入状态着色顶部 hairline 与外发光（已接入=品牌色、关闭=灰、待接入=琥珀弱化） */
.ofm_chan[data-state="on"]::before{background:linear-gradient(90deg,var(--chan-accent,var(--dsw-alias-state-business-primary)),color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 30%,transparent));opacity:1}
.ofm_chan[data-state="on"]{border-color:color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 34%,var(--dsw-alias-border-l2))}
.ofm_chan[data-state="idle"]::before{background:linear-gradient(90deg,var(--dsw-alias-state-warning-primary,#f0a441),transparent);opacity:.6}
.ofm_chan[data-state="off"]::before{background:linear-gradient(90deg,var(--dsw-alias-label-tertiary),transparent);opacity:.5}
/* 按钮：异步进行中显示内联 spinner（aria-busy 锚点，文字仍保留占位避免布局跳动） */
.ofm_btn[aria-busy="true"]{position:relative;color:transparent !important;pointer-events:none}
.ofm_btn[aria-busy="true"]::after{content:"";position:absolute;left:50%;top:50%;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 30%,var(--dsw-alias-label-secondary));border-top-color:var(--dsw-alias-label-primary);animation:ofm-btn-spin .7s linear infinite}
@keyframes ofm-btn-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ofm_root *,.ofm_root *::before,.ofm_root *::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}}
/* ═══ 精密仪器精修层（世界观：原厂仪器手感）：颜色听宿主，质感在阻尼。曲线 --ease-instrument 冲得快落得稳，--ease-settle 极轻过冲。退场比进场快。 ═══ */
.ofm_glass{transition:border-color .22s var(--ease-instrument),box-shadow .26s var(--ease-instrument),transform .22s var(--ease-instrument),background .22s var(--ease-instrument)}
.ofm_glass:hover{border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 92%,var(--dsw-alias-state-business-primary));box-shadow:0 1px 2px rgb(0 0 0 / 5%),0 10px 28px -14px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.ofm_kpi{transition:border-color .22s var(--ease-instrument),transform .22s var(--ease-instrument),box-shadow .26s var(--ease-instrument)}
.ofm_kpi:hover{transform:translateY(-1px)}
.ofm_kpivalue{transition:transform .3s var(--ease-settle),color .2s var(--ease-instrument);display:inline-block}
.ofm_kpi:hover .ofm_kpivalue{transform:translateY(-1px) scale(1.015);color:var(--dsw-alias-label-primary)}
.ofm_table tbody tr{transition:background .14s var(--ease-instrument)}
.ofm_seg button,.ofm_chip{transition:background .2s var(--ease-instrument),color .2s var(--ease-instrument),border-color .2s var(--ease-instrument),box-shadow .22s var(--ease-settle)}
.ofm_prog i{transition:width .5s var(--ease-instrument)}
.ofm_minibtn{transition:transform .14s var(--ease-instrument),border-color .18s var(--ease-instrument),color .18s var(--ease-instrument),background .18s var(--ease-instrument)}
.ofm_minibtn:active:not(:disabled){transform:scale(.98);transition-duration:.09s}
.ofm_root input,.ofm_root select,.ofm_root textarea{transition:border-color .18s var(--ease-instrument),box-shadow .2s var(--ease-instrument),background .18s var(--ease-instrument)}
@media (prefers-reduced-motion:reduce){.ofm_glass,.ofm_kpi,.ofm_kpivalue,.ofm_minibtn,.ofm_prog i{transition:none!important}.ofm_kpi:hover,.ofm_kpi:hover .ofm_kpivalue{transform:none}}

/* ==== V5 INSTRUMENT START ==== */
/* 精密仪器·样板间覆盖层：1px细边+内高光，无外投影；颜色全部听宿主 var(--dsw-alias-*)。
   夜(暗)高光更刃、纹理更显；昼(亮)高光收敛、纹理近乎哑。reduced-motion 去位移留状态。 */

/* ── ① 面板卡片 .ofm_panel / .ofm_card ─────────────────────────── */
/* 双基底：拉丝细纹(repeating-linear-gradient)垫底，实体色覆盖在上，从边缘隐约透出拉丝感 */
.ofm_root .ofm_panel{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%), inset 0 -14px 28px -18px rgb(0 0 0 / 16%) !important;
  transition: border-color .22s var(--ease-instrument), box-shadow .26s var(--ease-instrument), transform .22s var(--ease-instrument) !important;
}
.ofm_root .ofm_card{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-3) 84%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%), inset 0 -12px 24px -16px rgb(0 0 0 / 14%) !important;
  transition: transform .22s var(--ease-instrument), box-shadow .26s var(--ease-instrument), border-color .2s var(--ease-instrument) !important;
}
/* hover：kinetic tension —— 位移压浅(-1px)，去掉外投影，靠边色提亮+高光增强传递"浮起" */
.ofm_root .ofm_card:hover{
  transform: translateY(-1px) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 58%, var(--dsw-alias-border-l2)) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 11%), inset 0 -12px 24px -16px rgb(0 0 0 / 10%) !important;
}

/* ── ② 按钮 .ofm_btn ─────────────────────────── */
/* kinetic tension：外壳 active 陷落(scale .985)，内部 ::after 扫光条反向滑过形成"外陷内顶" */
.ofm_root .ofm_btn{
  position: relative !important;
  overflow: hidden !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%) !important;
  transition: transform .16s var(--ease-settle), border-color .2s var(--ease-instrument), background .2s var(--ease-instrument), box-shadow .2s var(--ease-instrument), opacity .16s var(--ease-instrument) !important;
}
.ofm_root .ofm_btn::after{
  content: "" !important;
  position: absolute !important;
  top: 0 !important; bottom: 0 !important;
  left: -60% !important; width: 42% !important;
  background: linear-gradient(100deg, transparent, rgb(255 255 255 / 14%), transparent) !important;
  transform: skewX(-18deg) !important;
  transition: left .5s var(--ease-instrument) !important;
  pointer-events: none !important;
}
/* hover：扫光滑过（exit slower than press）；去掉原外投影，仅留顶部高光 */
.ofm_root .ofm_btn:hover:not(:disabled){
  transform: translateY(-1px) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 10%) !important;
}
.ofm_root .ofm_btn:hover:not(:disabled)::after{
  left: 118% !important;
}
/* active：快速陷落(.09s) + 内阴影加深=物理按压；松开靠 --ease-settle 回弹 */
.ofm_root .ofm_btn:active:not(:disabled){
  transform: scale(.985) !important;
  transition-duration: .09s !important;
  box-shadow: inset 0 2px 5px rgb(0 0 0 / 14%), inset 0 1px 0 rgb(255 255 255 / 3%) !important;
}
/* primary 按钮保留主色渐变，仅把外投影换成更克制的内高光+轻凹槽 */
.ofm_root .ofm_btn.primary{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 22%), inset 0 -10px 18px -12px rgb(0 0 0 / 24%) !important;
}
.ofm_root .ofm_btn.primary:hover:not(:disabled){
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 26%), inset 0 -10px 18px -12px rgb(0 0 0 / 18%) !important;
}

/* ── ③ 表格行 hover .ofm_table tbody tr ─────────────────────────── */
/* 行首 2px 主色竖条用 transform:scaleY 展开(不触发布局)；exit(.12s) 比 entrance(.16s) 快 */
.ofm_root .ofm_table tbody tr{
  transition: background .16s var(--ease-instrument) !important;
}
.ofm_root .ofm_table tbody tr td:first-child{
  position: relative !important;
}
.ofm_root .ofm_table tbody tr td:first-child::before{
  content: "" !important;
  position: absolute !important;
  left: 0 !important; top: 6px !important; bottom: 6px !important;
  width: 2px !important; border-radius: 2px !important;
  background: var(--dsw-alias-state-business-primary) !important;
  transform: scaleY(0) !important;
  transform-origin: center !important;
  opacity: 0 !important;
  transition: transform .16s var(--ease-instrument), opacity .12s var(--ease-instrument) !important;
  pointer-events: none !important;
}
.ofm_root .ofm_table tbody tr:hover td:first-child::before{
  transform: scaleY(1) !important;
  opacity: 1 !important;
}
/* 数字列表针走格感：tabular-nums + pl5-tick 机械顿挫(steps) */
.ofm_root .ofm_table td{
  font-variant-numeric: tabular-nums !important;
}
/* 表针走格：离散百分比快照模拟 steps 顿挫——同值连帧=停格，瞬间跳格=机械感；@keyframes 里用不了 steps() 函数，用帧堆出来 */
@keyframes pl5-tick{
  0%,24%{ transform: translateY(0); }
  25%,54%{ transform: translateY(-1.5px); }
  55%,79%{ transform: translateY(-.75px); }
  80%,100%{ transform: translateY(0); }
}

/* ── 昼(not-dark)收敛：高光更哑、拉丝更隐、回弹更小 ─────────────── */
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel,
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent) !important;
  }
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-3) 88%, transparent) !important;
  }
  .ofm_root .ofm_panel{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 45%), inset 0 -14px 28px -18px rgb(0 0 0 / 7%) !important;
  }
  .ofm_root .ofm_card{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 50%), inset 0 -12px 24px -16px rgb(0 0 0 / 6%) !important;
  }
  .ofm_root .ofm_card:hover{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 60%), inset 0 -12px 24px -16px rgb(0 0 0 / 5%) !important;
  }
  .ofm_root .ofm_btn{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 50%) !important;
  }
  .ofm_root .ofm_btn:hover:not(:disabled){
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 62%) !important;
  }
}

/* ── reduced-motion 降级：去位移/回弹/扫光/顿挫，保留颜色与不透明度反馈 ── */
@media (prefers-reduced-motion: reduce){
  /* 统一过渡降级：所有交互件只留颜色/不透明度反馈，去位移 */
  .ofm_root .ofm_card,
  .ofm_root .ofm_panel,
  .ofm_root .ofm_btn,
  .ofm_root .ofm_table tbody tr,
  .ofm_root .ofm_table tbody tr td:first-child::before,
  .ofm_root .ofm_switch i,
  .ofm_root .ofm_switch i::after,
  .ofm_root .ofm_seg button,
  .ofm_root .ofm_stat,
  .ofm_root .ofm_kvc,
  .ofm_root .ofm_input,
  .ofm_root .ofm_starbtn,
  .ofm_root .ofm_chanlogo{
    transition: border-color .12s ease, background .12s ease, box-shadow .12s ease, opacity .12s ease, color .12s ease !important;
  }
  /* 去位移/回弹/陷落 */
  .ofm_root .ofm_card:hover,
  .ofm_root .ofm_btn:hover:not(:disabled),
  .ofm_root .ofm_btn:active:not(:disabled),
  .ofm_root .ofm_stat:hover,
  .ofm_root .ofm_kvc:hover,
  .ofm_root .ofm_seg button:active:not([aria-pressed="true"]),
  .ofm_root .ofm_starbtn:active,
  .ofm_root .ofm_chan:hover .ofm_chanlogo{
    transform: none !important;
  }
  /* 开关捏扁还原 */
  .ofm_root .ofm_switch:active i::after{
    width: 14px !important;
  }
  /* 扫光条砍掉 */
  .ofm_root .ofm_btn::after,
  .ofm_root .ofm_starbtn::after{
    content: none !important;
  }
  /* 呼吸灯停跳，但保留颜色状态 */
  .ofm_root .ofm_dot.ok{
    animation: none !important;
    opacity: 1 !important;
  }
  /* 表针走格动画停走，但保留数字本身 */
  .ofm_root .ofm_kpi:hover .ofm_kpivalue,
  .ofm_root .ofm_stat:hover b{
    animation: none !important;
  }
}

/* ── ④ 输入框 .ofm_input：仪器凹槽手感 ─────────────────────────── */
/* 常态凹槽(inset 顶高光+底内阴影)；focus 时凹槽不动，只换边色+外发光，像仪器被点亮 */
.ofm_root .ofm_input{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), inset 0 2px 6px -2px rgb(0 0 0 / 10%) !important;
  transition: border-color .18s var(--ease-instrument), box-shadow .2s var(--ease-instrument), background .18s var(--ease-instrument) !important;
}
.ofm_root .ofm_input:hover{
  border-color: color-mix(in srgb, var(--dsw-alias-border-l2) 55%, var(--dsw-alias-state-business-primary)) !important;
}
.ofm_root .ofm_input:focus{
  border-color: var(--dsw-alias-state-business-primary) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), inset 0 2px 6px -2px rgb(0 0 0 / 8%), 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent) !important;
}

/* ── ⑤ 开关 .ofm_switch：spring 滑块阻尼 ─────────────────────────── */
/* 滑块用 --ease-settle 带回弹；按下时滑块变宽=被"捏扁"，松开回弹归位 */
.ofm_root .ofm_switch i{
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 10%), inset 0 -1px 0 rgb(255 255 255 / 4%) !important;
  transition: background .22s var(--ease-instrument), border-color .22s var(--ease-instrument), box-shadow .22s var(--ease-instrument) !important;
}
.ofm_root .ofm_switch i::after{
  background: var(--dsw-alias-label-primary) !important;
  box-shadow: 0 1px 3px rgb(0 0 0 / 28%), inset 0 1px 0 rgb(255 255 255 / 20%) !important;
  transition: transform .28s var(--ease-settle), background .2s var(--ease-instrument), width .14s var(--ease-instrument) !important;
}
.ofm_root .ofm_switch[aria-checked="true"] i{
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 14%), inset 0 -1px 0 rgb(255 255 255 / 8%) !important;
}
.ofm_root .ofm_switch[aria-checked="true"] i::after{
  background: var(--dsw-alias-label-on-accent, #fff) !important;
}
.ofm_root .ofm_switch:active i::after{
  width: 17px !important;
}

/* ── ⑥ 徽章/药丸/标签 .ofm_badge/.ofm_pill/.ofm_tag/.ofm_chantag/.ofm_chip ── */
/* 统一加顶部发丝高光；状态色只用 color-mix 调透明度，不换色相 */
.ofm_root .ofm_pill,
.ofm_root .ofm_tag,
.ofm_root .ofm_chip,
.ofm_root .ofm_chantag{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 5%) !important;
  transition: border-color .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument), transform .18s var(--ease-settle) !important;
}
.ofm_root .ofm_badge{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%) !important;
  transition: border-color .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument) !important;
}
/* 状态点呼吸灯保留，但改成 pl5- 前缀、机械顿挫更明显的两拍节奏 */
@keyframes pl5-dot-breathe{
  0%,100%{ opacity:1; }
  50%{ opacity:.45; }
}
.ofm_root .ofm_dot.ok{
  animation: pl5-dot-breathe 2.4s cubic-bezier(.4,0,.6,1) infinite !important;
}
/* 分段控件选中块：加顶部高光，按下时微微陷落 */
.ofm_root .ofm_seg button[aria-pressed="true"]{
  box-shadow: 0 1px 3px rgb(0 0 0 / 10%), inset 0 1px 0 rgb(255 255 255 / 8%) !important;
  transition: color .18s var(--ease-instrument), background .18s var(--ease-instrument), box-shadow .2s var(--ease-settle) !important;
}
.ofm_root .ofm_seg button:active:not([aria-pressed="true"]){
  transform: scale(.97) !important;
}

/* ── ⑦ 原生件接管：滚动条 / selection / caret / 聚焦环 ─────────────── */
/* 滚动条：仪器滑轨——thumb 加顶部高光与底部凹槽，hover 时轻微增亮 */
.ofm_root ::-webkit-scrollbar-thumb{
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 30%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%), inset 0 -1px 0 rgb(0 0 0 / 10%) !important;
  transition: background .2s var(--ease-instrument) !important;
}
.ofm_root ::-webkit-scrollbar-thumb:hover{
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 48%, transparent) !important;
}
/* 文本选择：主色薄涂，昼模式再淡一点避免刺眼 */
.ofm_root ::selection{
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent) !important;
}
/* 光标：跟随主色 */
.ofm_root input, .ofm_root textarea{
  caret-color: var(--dsw-alias-state-business-primary) !important;
}
/* 聚焦环：仪器刻度环——细环+外晕，用 --ease-instrument 淡入 */
.ofm_root :focus-visible{
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 72%, transparent) !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent) !important;
  transition: box-shadow .18s var(--ease-instrument), outline-color .18s var(--ease-instrument) !important;
}

/* ── ⑧【师傅批改①】拉丝纹理增强：金属感要真的能摸到 ─────────────── */
/* 夜模式 3% → 4.5%，昼模式 1.5% → 2.8%，纹理间隔收紧让拉丝更密 */
.ofm_root .ofm_panel{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent) !important;
}
.ofm_root .ofm_card{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-3) 84%, transparent) !important;
}
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel,
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent) !important;
  }
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-3) 88%, transparent) !important;
  }
}

/* ── ⑧【师傅批改②】昼模式高光压暗：45-62% → 30-38%，更克制 ─────────── */
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 34%), inset 0 -14px 28px -18px rgb(0 0 0 / 6%) !important;
  }
  .ofm_root .ofm_card{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 38%), inset 0 -12px 24px -16px rgb(0 0 0 / 5%) !important;
  }
  .ofm_root .ofm_card:hover{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 42%), inset 0 -12px 24px -16px rgb(0 0 0 / 4%) !important;
  }
  .ofm_root .ofm_btn{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 36%) !important;
  }
  .ofm_root .ofm_btn:hover:not(:disabled){
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 44%) !important;
  }
  .ofm_root .ofm_pill,
  .ofm_root .ofm_tag,
  .ofm_root .ofm_chip,
  .ofm_root .ofm_chantag,
  .ofm_root .ofm_badge{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 30%) !important;
  }
  .ofm_root .ofm_input{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 34%), inset 0 2px 6px -2px rgb(0 0 0 / 6%) !important;
  }
}

/* ── ⑧【师傅批改③】表格竖条语言统一：所有表格行 hover 都带主色竖条 ── */
/* .ofm_newsbody table 是内容型表格，保持朴素；仅给数据表 .ofm_table 统一竖条。
   同时把 .ofm_kvc / .ofm_stat 等"类表格"卡片也纳入 hover 微提亮，保持语言一致 */
.ofm_root .ofm_stat,
.ofm_root .ofm_kvc{
  transition: border-color .2s var(--ease-instrument), box-shadow .22s var(--ease-instrument), transform .2s var(--ease-settle) !important;
}
.ofm_root .ofm_stat:hover,
.ofm_root .ofm_kvc:hover{
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 38%, var(--dsw-alias-border-l1)) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%) !important;
  transform: translateY(-1px) !important;
}

/* ── ⑩【返工·收编租界】星按钮/导航标/渠道标 全部听宿主变量 ─────────────── */
/* L1130 .ofm_starbtn:hover 混 #3ECFA0、L1181 .ofm_navmark 混 #3ECFA0 —— 统一改混 label-primary，零品牌色 */
.ofm_root .ofm_starbtn{
  transition: transform .16s var(--ease-settle), box-shadow .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument) !important;
}
.ofm_root .ofm_starbtn:hover{
  background: linear-gradient(140deg, var(--dsw-alias-state-business-primary), color-mix(in srgb, var(--dsw-alias-state-business-primary) 76%, var(--dsw-alias-label-primary))) !important;
  color: var(--dsw-alias-label-on-accent, #fff) !important;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent), 0 6px 16px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent) !important;
}
.ofm_root .ofm_starbtn:active{
  transform: scale(.97) !important;
}
/* 扫光条改走 --ease-instrument，与 .ofm_btn 同语言 */
.ofm_root .ofm_starbtn::after{
  transition: left .5s var(--ease-instrument) !important;
}
/* 导航标：去掉 #3ECFA0 混色，改混 label-primary；外投影换成内高光+轻凹槽 */
.ofm_root .ofm_navmark{
  background: linear-gradient(145deg, var(--dsw-alias-state-business-primary), color-mix(in srgb, var(--dsw-alias-state-business-primary) 58%, var(--dsw-alias-label-primary))) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 26%), inset 0 -6px 12px -8px rgb(0 0 0 / 20%) !important;
}
.ofm_root .ofm_navmark svg{
  fill: var(--dsw-alias-label-on-accent, #fff) !important;
}
/* 渠道标：--chan-accent 兜底本来就是宿主变量，收编写死的 #fff / #101828，外投影换内高光 */
.ofm_root .ofm_chanlogo{
  color: var(--dsw-alias-label-on-accent, #fff) !important;
  background: linear-gradient(150deg, var(--chan-accent, var(--dsw-alias-state-business-primary)), color-mix(in srgb, var(--chan-accent, var(--dsw-alias-state-business-primary)) 52%, var(--dsw-alias-bg-layer-3))) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 24%), inset 0 -8px 14px -10px rgb(0 0 0 / 22%) !important;
  transition: transform .3s var(--ease-settle) !important;
}
.ofm_root .ofm_chan:hover .ofm_chanlogo{
  transform: scale(1.05) rotate(-2deg) !important;
}

/* ── ⑩【返工·收编 SEASON 落地件】色板/选中 chip/渠道卡顶条 ─────────────── */
/* SEASON 数组在 JS(L1663) 里、靠内联 style 注入，CSS 改不了值；
   收编它落地的元素，让质感听宿主：色板加高光、chip 选中不再花、渠道卡顶条收敛 */
.ofm_root .ofm_swatch{
  border-radius: 3px !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 30%), inset 0 -1px 0 rgb(0 0 0 / 16%) !important;
}
/* chip 选中态：JS 注入彩色背景，这里压回宿主语言——主色薄涂+主色边，去掉杂色 */
.ofm_root .ofm_chip[aria-pressed="true"]{
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent) !important;
  color: var(--dsw-alias-state-business-primary) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%) !important;
}
/* 渠道卡顶条(::before 用 --chan-accent)：收敛高度与发光，听宿主凹槽语言 */
.ofm_root .ofm_chan::before{
  height: 2px !important;
  box-shadow: 0 1px 0 rgb(255 255 255 / 6%) !important;
}
.ofm_root .ofm_chan[data-state="on"]{
  border-color: color-mix(in srgb, var(--chan-accent, var(--dsw-alias-state-business-primary)) 30%, var(--dsw-alias-border-l2)) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%) !important;
}

/* ── ⑩【返工·接上 pl5-tick】KPI/统计数字获得表针走格感 ─────────────── */
/* 挂到 KPI 大数字与统计卡数字：hover 时数字以机械顿挫走一格，模拟仪表指针跳动 */
.ofm_root .ofm_kpivalue,
.ofm_root .ofm_stat b{
  display: inline-block !important;
}
.ofm_root .ofm_kpi:hover .ofm_kpivalue,
.ofm_root .ofm_stat:hover b{
  animation: pl5-tick .34s var(--ease-instrument) 1 !important;
}
/* ==== V5 INSTRUMENT END ==== */
/* ── 聚合渠道 / 省 Token / 路由：新页面的表面 ─────────────────────────────
   动效一律走 150–250ms 的短过渡，不弹跳；reduced-motion 下由文件末尾的
   媒体查询整体关掉。ofm_rise 用 backwards 而不是 both：动画结束后元素回到
   样式表里的 transform，卡片的 hover 抬升才不会被动画的终态钉死。 */
.ofm_rise{animation:ofmrisein .22s cubic-bezier(.22,.61,.36,1) backwards}
@keyframes ofmrisein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ofm_duo{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(272px,100%),1fr));gap:12px;align-items:start}
.ofm_duo>*{min-width:0}
.ofm_picklist{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));gap:8px;max-height:330px;overflow:auto;padding:2px}
/* 候选池按渠道分组：每组一个标题（渠道名 + 数量），组内仍是卡片网格。 */
.ofm_pickgroups{display:flex;flex-direction:column;gap:14px;max-height:460px;overflow:auto;padding:2px 2px 8px}
.ofm_pickgroup{display:flex;flex-direction:column;gap:8px}
.ofm_pickgrouphead{display:flex;align-items:baseline;gap:8px;padding:2px 2px 0;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:6px}
.ofm_pickgrouphead b{font-size:12px;font-weight:700;letter-spacing:.3px}
.ofm_pickgroup .ofm_picklist{max-height:none;overflow:visible;padding:0}
.ofm_pickmark{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ofm_pickrow[aria-pressed="true"] .ofm_pickmark{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:#fff}
.ofm_tagwarn{border-color:color-mix(in srgb,var(--warn) 45%,transparent);color:var(--warn)}
/* 发现结果的可点标签：点一下加入/移出模型覆盖，选中态用主题主色。 */
.ofm_foundchip{font:inherit;font-size:10.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ofm_foundchip:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.ofm_foundchip[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}
/* 折叠后的发现结果：一模型一行（名称可点加入，右侧单独实测）。 */
.ofm_foundlist{display:flex;flex-direction:column;gap:4px;margin-top:6px;max-height:230px;overflow:auto;padding:6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}
.ofm_foundrow{display:flex;align-items:center;gap:6px;min-width:0}
.ofm_foundrow .ofm_foundchip{flex:1;min-width:0;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:8px}
.ofm_foundtest{font:inherit;font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.ofm_foundtest:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.ofm_foundtest:disabled{opacity:.5;cursor:default}
.ofm_foundpill{font-size:9.5px;font-weight:700;letter-spacing:.04em;padding:1px 6px;border-radius:999px;border:1px solid transparent}
.ofm_foundpill[data-ok="true"]{color:var(--ok, #2f9e6b);border-color:color-mix(in srgb,var(--ok, #2f9e6b) 45%,transparent)}
.ofm_foundpill[data-ok="false"]{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,transparent)}
/* 模型面板里把聚合渠道的行从免费车道里分出来的小标题。 */
.ofm_mpicklane{display:flex;align-items:center;gap:8px;padding:8px 8px 2px;font-size:10px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.ofm_pickrow{display:flex;flex-direction:column;gap:5px;align-items:stretch;text-align:left;font:inherit;padding:9px 11px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;transition:border-color .16s ease,background .16s ease,transform .16s ease}
.ofm_pickrow:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);transform:translateY(-1px)}
.ofm_pickrow[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.ofm_pickrow:disabled{opacity:.55;cursor:default}
.ofm_pickhead{display:flex;align-items:center;gap:7px;min-width:0}
.ofm_pickhead b{font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_pickmeta{display:flex;gap:7px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary);min-width:0}
.ofm_picknote{font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.ofm_meter{height:9px;border-radius:99px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow:hidden}
.ofm_meter i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,transparent),var(--dsw-alias-state-business-primary));transition:width .55s cubic-bezier(.22,.61,.36,1)}
.ofm_member{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 82%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 58%,transparent);font-size:11.5px;transition:border-color .16s ease,background .16s ease}
.ofm_member .ofm_id{flex:1;min-width:0}
.ofm_snippet{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:pre;overflow:auto;max-height:230px}
@media (max-width:600px){.ofm_duo{grid-template-columns:1fr}.ofm_picklist{grid-template-columns:1fr}.ofm_member{flex-wrap:wrap}}
@media (prefers-reduced-motion:reduce){.ofm_rise,.ofm_page{animation:none}.ofm_pickrow,.ofm_member,.ofm_meter i,.ofm_card,.ofm_kpi,.ofm_chan{transition:none}.ofm_root .ofm_card:hover,.ofm_pickrow:hover:not(:disabled){transform:none}}
`

    // ── helpers ───────────────────────────────────────────────────────────────
    // 用页面 base 解析，而不是 origin-absolute 的「/api/...」：DSH 挂在反向代理
    // 子路径下（https://<host>/<prefix>/）时，前导斜杠会把 <prefix> 丢掉，请求
    // 直接打到站点根被前置网关 404，设置面板报「无法连接插件后端」（#54）。
    // 相对路径随页面 base 走，根路径部署下与原值完全一致。解析不了（无 document
    // 的宿主、非常规 base）就退回根路径原值——行为不比修复前差。
    const API = (() => {
      try { return new URL('api/our-free-model', document.baseURI).pathname } catch { return '/api/our-free-model' }
    })()
    const SEASON = ['#4C8DFF', '#3ECFA0', '#F2A65A', '#E36AA6', '#8B7BF0', '#39B8C4', '#D9743E', '#7BB24A']

    async function api(path, options) {
      // 8 秒超时兜底：后端路由未注册/挂起时 fetch 不再永久挂起——此前全部 api 调用
      // （onboarding /announcement、设置页 /announcements /update/status、面板 /summary /stats
      // /forward/key 等）无任何超时，一个不响应端点即可阻塞 settings.onboarding 协调流程
      // 并长期占用同源连接池。超时按 AbortError 抛给调用方，走各自 .catch 降级路径。
      // 慢路由按需放宽（options.timeout，毫秒）：/bench 要等一整段真实生成（本车道
      // 首帧动辄数十秒），/update/apply 要下载+校验+安装整包，/refresh /reprobe 要
      // 跑完一整轮探测——8 秒兜底套在它们身上只会“前端报失败、后端继续烧”，
      // 测速按钮因此几乎必失败而配额照付。
      const { timeout = 8000, ...fetchOptions } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...fetchOptions, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body, timeout) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      ...timeout === undefined ? {} : { timeout },
    })

    /**
     * The merged retry engine keeps the old package's own route.
     *
     * It is not nested under `/api/our-free-model` on purpose: a user who tuned
     * rules under the old plugin can still open its fallback HTML page and the
     * same rules file is served. This helper only prefixes with the host's base
     * so a reverse-proxied DSH still resolves it.
     */
    const RETRY_API = (() => {
      try { return new URL('llm-error-retry/api/config', document.baseURI).pathname } catch { return '/llm-error-retry/api/config' }
    })()

    async function retryApi(options) {
      const { timeout = 8000, ...fetchOptions } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(RETRY_API, { ...fetchOptions, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok || payload?.ok === false) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * Whether the shell is showing `#root` to the user right now.
     *
     * A slot step lives inside `#root`, so the desktop shell's own first-run
     * surface — which portals to `document.body` and, while it is up, sets
     * `#root { opacity: 0 }` plus `#root.inert` — makes every descendant
     * invisible and unclickable regardless of the descendant's own
     * `position: fixed; z-index`. Anything this plugin gates on "is the user
     * actually looking at us" reads that state here. Absent a `#root` (a
     * non-shell host) or any reading error, the host counts as shown: the
     * fallback must never be "stay silent forever".
     *
     * @returns {boolean} false while the shell is covering or hiding the app root.
     */
    function hostShown() {
      try {
        if (typeof document === 'undefined' || document === null) return true
        const root = typeof document.getElementById === 'function' ? document.getElementById('root') : null
        if (root !== null && root !== undefined) {
          if (root.inert === true) return false
          const inline = root.style?.opacity
          if (typeof inline === 'string' && inline !== '' && Number(inline) === 0) return false
          const view = root.ownerDocument?.defaultView ?? (typeof window === 'undefined' ? undefined : window)
          if (typeof view?.getComputedStyle === 'function') {
            const computed = view.getComputedStyle(root)
            if (computed !== null && computed !== undefined) {
              const opacity = computed.opacity
              if (typeof opacity === 'string' && opacity !== '' && Number(opacity) === 0) return false
              if (computed.visibility === 'hidden' || computed.display === 'none') return false
            }
          }
        }
        // The covering surface itself: present means the app behind it is hidden,
        // even if a shell version forgets the opacity/inert pair above.
        if (typeof document.querySelector === 'function' && document.querySelector('[data-desktop-onboarding-surface]') !== null) return false
        return true
      } catch { return true }
    }

    /**
     * `hostShown()` as reactive state.
     *
     * Watches the two things the shell changes (`#root`'s attributes, and the
     * body-level surface being added or removed) and polls as a safety net, so a
     * shell that animates its surface away without a mutation we can observe
     * still unblocks the caller within a second.
     *
     * @returns {boolean} the current host visibility.
     */
    function useHostShown() {
      const [shown, setShown] = useState(() => hostShown())
      useEffect(() => {
        let alive = true
        const sync = () => { if (alive) setShown(current => { const next = hostShown(); return next === current ? current : next }) }
        sync()
        let observer
        try {
          observer = new MutationObserver(sync)
          const root = typeof document?.getElementById === 'function' ? document.getElementById('root') : null
          if (root !== null && root !== undefined) observer.observe(root, { attributes: true, attributeFilter: ['style', 'inert', 'class'] })
          observer.observe(document.body, { childList: true, subtree: false })
        } catch { /* no MutationObserver: the poll below still covers it */ }
        const poll = setInterval(sync, 1000)
        poll?.unref?.()
        return () => {
          alive = false
          try { observer?.disconnect() } catch { /* already disconnected */ }
          clearInterval(poll)
        }
      }, [])
      return shown
    }

    function useAsync(loader, deps) {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const run = useCallback(() => {
        let alive = true
        setState(current => ({ ...current, status: 'loading' }))
        loader().then(data => { if (alive) setState({ status: 'ready', data, error: '' }) })
          .catch(error => { if (alive) setState({ status: 'error', data: undefined, error: String(error?.message ?? error) }) })
        return () => { alive = false }
      }, deps)
      useEffect(() => run(), [run])
      return { ...state, reload: run }
    }

    function kilo(value) {
      const n = Math.round(Number(value) || 0)
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
      if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`
      return String(n)
    }

    function ago(ts, locale) {
      if (!ts) return '—'
      const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000))
      const zh = String(locale ?? '').toLowerCase().startsWith('zh')
      if (seconds < 60) return zh ? `${seconds} 秒前` : `${seconds}s ago`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`
      return zh ? `${Math.round(hours / 24)} 天前` : `${Math.round(hours / 24)}d ago`
    }

    function copy(text, done) {
      const finish = ok => done(ok)
      if (navigator?.clipboard?.writeText !== undefined) {
        navigator.clipboard.writeText(text).then(() => finish(true), () => finish(legacy(text)))
        return
      }
      finish(legacy(text))
    }
    function legacy(text) {
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch { return false }
    }

    // ── announcement HTML: strict allowlist, no innerHTML sink ───────────────
    // Rendering is a trust boundary of its own: the feed URL can be pointed
    // anywhere, and a compromised feed source must never become script
    // execution. Nothing here hands a string to the HTML engine — the tokenizer
    // walks the text, drops everything off the allowlist, and builds a virtual
    // tree that both React and plain DOM can materialize. The same parser is
    // exercised headlessly by scripts/sanitize-test.mjs.
    const ALLOWED_TAGS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'])
    /** Everything these elements contain is dropped, closing tag included. */
    const DROP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'textarea', 'title', 'svg', 'math', 'form', 'input', 'button', 'select', 'option', 'video', 'audio', 'canvas', 'link', 'meta', 'base'])
    const VOID_TAGS = new Set(['br', 'hr', 'img'])
    const MAX_HTML_NODES = 4000
    const ALLOWED_STYLE_PROPS = new Set(['color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration'])
    const STYLE_CAMEL = { 'background-color': 'backgroundColor', 'text-align': 'textAlign', 'font-weight': 'fontWeight', 'font-style': 'fontStyle', 'text-decoration': 'textDecoration', color: 'color' }

    /** http(s), mailto and in-page fragments only; images additionally accept inline PNG/JPEG/GIF/WebP. */
    function safeUrl(raw, isImage) {
      const value = String(raw ?? '').trim()
      if (value === '' || value.length > 2000) return undefined
      const lower = value.toLowerCase()
      if (/^https?:\/\//.test(lower)) return value
      if (lower.startsWith('mailto:') && /^[^@\s]+@[^@\s]+$/.test(value.slice(7))) return value
      if (lower.startsWith('#')) return value
      if (isImage && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value
      return undefined
    }

    function sanitizeStyle(raw) {
      const out = {}
      for (const decl of String(raw ?? '').split(';')) {
        const idx = decl.indexOf(':')
        if (idx === -1) continue
        const prop = decl.slice(0, idx).trim().toLowerCase()
        const value = decl.slice(idx + 1).trim()
        if (!ALLOWED_STYLE_PROPS.has(prop) || value === '' || value.length > 120) continue
        if (/url\(|expression|javascript:|@|<|>/.test(value.toLowerCase())) continue
        out[STYLE_CAMEL[prop]] = value
      }
      return out
    }

    function sanitizeAttrs(tag, attrText) {
      const props = {}
      const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
      let match
      while ((match = attrRe.exec(attrText ?? '')) !== null) {
        const key = match[1].toLowerCase()
        const value = match[3] ?? match[4] ?? match[5] ?? ''
        if (key === 'style') {
          const style = sanitizeStyle(value)
          if (Object.keys(style).length > 0) props.style = style
          continue
        }
        if (tag === 'a' && key === 'href') {
          const url = safeUrl(value)
          if (url !== undefined) {
            props.href = url
            props.target = '_blank'
            props.rel = 'noopener noreferrer'
          }
          continue
        }
        if (tag === 'img' && key === 'src') {
          const url = safeUrl(value, true)
          if (url !== undefined) props.src = url
          continue
        }
        if ((tag === 'img' || tag === 'a') && key === 'title') { props.title = value.slice(0, 300); continue }
        if (tag === 'img' && key === 'alt') { props.alt = value.slice(0, 300); continue }
        if ((key === 'width' || key === 'height') && /^\d{1,4}$/.test(value)) { props[key] = Number(value); continue }
      }
      return props
    }

    /**
     * Tokenize announcement HTML into a virtual tree of
     * `{type:'el', tag, props, children}` and `{type:'text', text}` nodes.
     * Disallowed elements are unwrapped (their children survive); the content
     * of raw-text elements such as `<script>` is dropped entirely.
     */
    function parseSafeHtml(html) {
      if (typeof html !== 'string' || html.trim() === '') return []
      const root = { type: 'root', children: [] }
      const stack = [root]
      const top = () => stack[stack.length - 1]
      let nodes = 0
      let skipUntil = null
      const tokenRe = /<!--[\s\S]*?-->|<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>|<\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g
      let match
      while ((match = tokenRe.exec(html)) !== null) {
        if (nodes >= MAX_HTML_NODES) break
        if (match[0].startsWith('<!--')) continue
        if (match[4] !== undefined) {
          if (skipUntil === null) {
            const text = match[4]
            if (text.trim() !== '' || (top().children.length > 0 && typeof top().children[top().children.length - 1] !== 'string')) {
              top().children.push(text)
            }
          }
          continue
        }
        const name = (match[1] ?? match[2] ?? '').toLowerCase()
        if (name === '') continue
        if (match[1] !== undefined) {
          // closing tag
          if (skipUntil !== null) {
            if (name === skipUntil) skipUntil = null
            continue
          }
          if (!ALLOWED_TAGS.has(name)) continue
          let depth = stack.length - 1
          while (depth > 0 && stack[depth].tag !== name) depth -= 1
          if (depth === 0) continue
          while (stack.length - 1 > depth) {
            const dropped = stack.pop()
            top().children.push(...dropped.children)
          }
          const frame = stack.pop()
          top().children.push({ type: 'el', tag: frame.tag, props: frame.props, children: frame.children })
          nodes += 1
          continue
        }
        // opening tag
        if (skipUntil !== null) continue
        if (DROP_CONTENT_TAGS.has(name)) { skipUntil = name; continue }
        if (!ALLOWED_TAGS.has(name)) continue
        const props = sanitizeAttrs(name, match[3])
        if (name === 'img' && props.src === undefined) continue
        if (VOID_TAGS.has(name)) {
          top().children.push({ type: 'el', tag: name, props, children: [] })
          nodes += 1
          continue
        }
        stack.push({ tag: name, props, children: [] })
      }
      while (stack.length > 1) {
        const frame = stack.pop()
        top().children.push(...frame.children)
      }
      return root.children
    }

    /** Materialize the virtual tree as React elements (keys are positional). */
    function htmlToReact(nodes) {
      return nodes.map((node, index) => typeof node === 'string'
        ? node
        : h(node.tag, { key: index, ...node.props }, ...htmlToReact(node.children ?? [])))
    }

    /** Materialize the virtual tree as DOM nodes (for toasts and modals). */
    function htmlToDom(nodes) {
      return nodes.map(node => {
        if (typeof node === 'string') return document.createTextNode(node)
        const el = document.createElement(node.tag)
        for (const [key, value] of Object.entries(node.props ?? {})) {
          if (key === 'style') { Object.assign(el.style, value); continue }
          el.setAttribute(key, String(value))
        }
        for (const child of htmlToDom(node.children ?? [])) el.appendChild(child)
        return el
      })
    }

    // ── toasts: a vanilla-DOM host so pushes surface on every page ───────────
    // Slot content only exists where the shell mounts it; a toast that lived
    // inside the settings section would be invisible everywhere else. This
    // host attaches to document.body, outside the app root, and needs no
    // react-dom — the body renders through the same allowlist parser.
    function toastHost() {
      let host = document.querySelector('.ofm_toasts')
      if (host === null) {
        host = document.createElement('div')
        host.className = 'ofm_toasts'
        document.body.appendChild(host)
      }
      return host
    }

    function showToast({ title, body, html, tone, actions = [], holdMs = 10000 }) {
      try {
        const host = toastHost()
        const card = document.createElement('div')
        card.className = 'ofm_toast' + (tone === undefined ? '' : ` ${tone}`)
        const head = document.createElement('div')
        head.className = 'ofm_toasttitle'
        head.appendChild(document.createTextNode(title ?? ''))
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'ofm_toastclose'
        // No locale lookup in here on purpose: showToast also runs from the
        // push subscription before any `t` binding is in scope, and a throw
        // inside this try/catch would silently swallow the whole toast.
        close.setAttribute('aria-label', 'close')
        close.title = '✕'
        close.textContent = '✕'
        close.addEventListener('click', () => card.remove())
        head.appendChild(close)
        card.appendChild(head)
        if (body !== undefined && body !== '') {
          const area = document.createElement('div')
          area.className = 'ofm_toastbody'
          area.textContent = String(body)
          card.appendChild(area)
        } else if (html !== undefined) {
          const area = document.createElement('div')
          area.className = 'ofm_toastbody'
          for (const node of htmlToDom(parseSafeHtml(html))) area.appendChild(node)
          card.appendChild(area)
        }
        if (actions.length > 0) {
          const row = document.createElement('div')
          row.className = 'ofm_toastactions'
          for (const action of actions) {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'ofm_btn'
            btn.textContent = action.label
            btn.addEventListener('click', () => { card.remove(); action.onClick?.() })
            row.appendChild(btn)
          }
          card.appendChild(row)
        }
        host.appendChild(card)
        while (host.children.length > 4) host.firstElementChild?.remove()
        if (holdMs > 0) {
          const timer = setTimeout(() => card.remove(), holdMs)
          timer.unref?.()
        }
        return card
      } catch { /* a toast must never break its caller */ }
      return undefined
    }

    /** Modal surface for `urgent` announcements; dismiss runs the ack callback. */
    function showUrgentModal({ title, html, confirmLabel, onClose }) {
      try {
        document.querySelector('.ofm_scrim[data-ofm-urgent]')?.remove()
        const scrim = document.createElement('div')
        scrim.className = 'ofm_scrim'
        scrim.setAttribute('data-ofm-urgent', 'true')
        const modal = document.createElement('div')
        modal.className = 'ofm_modal'
        modal.setAttribute('role', 'alertdialog')
        modal.setAttribute('aria-modal', 'true')
        const head = document.createElement('div')
        head.className = 'ofm_modalhead'
        head.textContent = title ?? ''
        const body = document.createElement('div')
        body.className = 'ofm_modalbody'
        for (const node of htmlToDom(parseSafeHtml(html ?? ''))) body.appendChild(node)
        const foot = document.createElement('div')
        foot.className = 'ofm_modalfoot'
        const ok = document.createElement('button')
        ok.type = 'button'
        ok.className = 'ofm_btn primary'
        ok.textContent = confirmLabel ?? 'OK'
        // One dismissal path: confirm, Escape, and the listener teardown stay in
        // step, so a keyboard user is not trapped in a dialog that says it is modal.
        const dismiss = () => {
          document.removeEventListener('keydown', onKeyDown, true)
          scrim.remove()
          onClose?.()
        }
        const onKeyDown = event => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          dismiss()
        }
        ok.addEventListener('click', dismiss)
        document.addEventListener('keydown', onKeyDown, true)
        foot.appendChild(ok)
        modal.appendChild(head)
        modal.appendChild(body)
        modal.appendChild(foot)
        scrim.appendChild(modal)
        document.body.appendChild(scrim)
        try { ok.focus() } catch { /* focus is best effort */ }
      } catch { /* a modal must never break its caller */ }
    }

    /** OS-level notification, only when the user both opted in and granted. */
    function osNotify(title, body) {
      try {
        if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
        new Notification(title, { body: String(body ?? '').slice(0, 200) })
      } catch { /* the in-app toast still fires */ }
    }

    const Switch = (props) => h('button', {
      type: 'button',
      className: 'ofm_switch',
      role: 'switch',
      'aria-checked': props.checked ? 'true' : 'false',
      // Several call sites already pass `disabled` (the gateway switch does, while
      // its RPC is in flight) and it was silently dropped, so a switch stayed
      // clickable through a write it could not survive. Passing it through is what
      // those call sites meant.
      disabled: props.disabled === true,
      onClick: props.onChange,
    }, h('i'), props.label === undefined ? null : h('span', null, props.label))

    const Pill = (props) => h('span', { className: `ofm_pill${props.strong ? ' strong' : ''}` },
      props.tone === undefined ? null : h('span', { className: `ofm_dot ${props.tone}` }),
      props.children)

    const Button = props => h('button', {
      type: 'button',
      className: 'ofm_btn' + (props.kind === undefined ? '' : ' ' + props.kind),
      disabled: props.disabled,
      onClick: props.onClick,
      title: props.title,
    }, props.children)

    function Section(props) {
      return h('section', { className: 'ofm_sec' },
        h('div', { className: 'ofm_sechead' },
          h('span', { className: 'ofm_sec_title' }, props.title),
          props.hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, props.hint)),
        props.children)
    }

    function Panel(props) {
      return h('div', { className: 'ofm_panel' },
        props.title === undefined ? null : h('div', { className: 'ofm_paneltitle' }, props.title, props.hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, props.hint)),
        props.children)
    }

    // ── charts (hand-drawn SVG; the shell ships no plotting primitive) ────────
    function Heatmap(props) {
      const { days, t } = props
      const cells = useMemo(() => buildHeatCells(days), [days])
      const peak = cells.reduce((max, cell) => Math.max(max, cell.total), 0)
      if (cells.length === 0) return h('p', { className: 'ofm_note' }, t('heat.empty'))
      const level = value => value === 0 ? '' : peak === 0 ? '' : value / peak > 0.66 ? 'l4' : value / peak > 0.4 ? 'l3' : value / peak > 0.16 ? 'l2' : 'l1'
      return h(Fragment, null,
        h('div', { className: 'ofm_heat', role: 'img', 'aria-label': t('heat.title') },
          cells.map((cell, index) => h('div', {
            key: `${cell.day}-${index}`,
            className: 'ofm_cell ' + level(cell.total),
            title: `${cell.day} · ${cell.total.toLocaleString()} tokens${cell.models.length ? ` · ${cell.models.join(', ')}` : ''}`,
          }))),
        h('div', { className: 'ofm_scale' }, t('heat.legend'),
          ['l1', 'l2', 'l3', 'l4'].map(cls => h('span', { key: cls, className: `ofm_cell ${cls}` })),
          t('heat.legendMore')))
    }

    /** Column-major local-calendar weeks, from Sunday through today (17 weeks by default). */
    function buildHeatCells(days, span = 119) {
      if (days.length === 0) return []
      const byDay = new Map(days.map(row => [row.day, row]))
      const end = new Date()
      // Noon avoids midnight DST transitions shifting subsequent dates to 01:00.
      end.setHours(12, 0, 0, 0)
      const cells = []
      const start = new Date(end)
      start.setDate(start.getDate() - end.getDay() - (Math.ceil(span / 7) - 1) * 7)
      for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
        const row = byDay.get(key)
        cells.push({ day: key, total: row?.total ?? 0, models: (row?.models ?? []).filter(m => m.output > 0).map(m => m.model) })
      }
      return cells
    }

    function TrendChart(props) {
      const { series, metric, mode } = props
      const width = 900
      const height = 168
      const pad = { top: 12, right: 8, bottom: 18, left: 40 }
      const rows = series.length === 0 ? [{ day: '', total: 0 }] : series
      const valueOf = row => mode === 'requests'
        ? row.models.reduce((sum, m) => sum + m.calls, 0)
        : metric === 'total' ? row.total : (row.models.find(m => m.model === metric)?.output ?? 0)
      const points = rows.map((row, index) => ({ x: rows.length === 1 ? width / 2 : pad.left + (index / (rows.length - 1)) * (width - pad.left - pad.right), y: 0, value: valueOf(row), day: row.day }))
      const peak = Math.max(1, ...points.map(p => p.value))
      for (const point of points) point.y = pad.top + (1 - point.value / peak) * (height - pad.top - pad.bottom)
      const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
      const area = `${line} L${points[points.length - 1].x.toFixed(1)},${height - pad.bottom} L${points[0].x.toFixed(1)},${height - pad.bottom} Z`
      const color = metric === 'total' ? 'var(--dsw-alias-state-business-primary)' : (props.color ?? 'var(--dsw-alias-state-business-primary)')
      const ticks = [0, 0.5, 1].map(frac => ({ y: pad.top + frac * (height - pad.top - pad.bottom), label: kilo(peak * (1 - frac)) }))
      return h('svg', { className: 'ofm_svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' },
        h('defs', null, h('linearGradient', { id: 'ofmFill', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '0%', 'stop-color': color, 'stopOpacity': '0.32' }),
          h('stop', { offset: '100%', 'stop-color': color, 'stopOpacity': '0.02' }))),
        ticks.map(tick => h('g', { key: tick.y },
          h('line', { x1: pad.left, x2: width - pad.right, y1: tick.y, y2: tick.y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1, strokeDasharray: tick.label === '0' ? undefined : '3 4' }),
          h('text', { x: pad.left - 6, y: tick.y + 3.5, textAnchor: 'end', fontSize: 9.5, fill: 'var(--dsw-alias-label-tertiary)' }, tick.label))),
        h('path', { d: area, fill: 'url(#ofmFill)' }),
        h('path', { d: line, fill: 'none', stroke: color, strokeWidth: 1.9, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' }),
        rows.length > 1 ? [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].map((row, i) => h('text', {
          key: `x${i}`,
          x: points[Math.min(points.length - 1, Math.round((i === 0 ? 0 : i === 1 ? (rows.length - 1) / 2 : rows.length - 1)))].x,
          y: height - 4, textAnchor: i === 0 ? 'start' : i === 2 ? 'end' : 'middle', fontSize: 9.5, fill: 'var(--dsw-alias-label-tertiary)',
        }, row.day.slice(5))) : null)
    }

    function Sparkline(props) {
      const values = props.values
      if (values.length < 2) return h('span', { className: 'ofm_note' }, props.t('speed.none'))
      const width = 150
      const height = 30
      const peak = Math.max(...values, 1)
      const floor = Math.min(...values, 0)
      const span = Math.max(1e-6, peak - floor)
      const line = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${(index / (values.length - 1) * width).toFixed(1)},${(height - ((value - floor) / span) * (height - 4) - 2).toFixed(1)}`).join(' ')
      return h('svg', { className: 'ofm_svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', style: { height } },
        h('path', { d: line, fill: 'none', stroke: props.color ?? 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.6, strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' }))
    }

    // ── model roster ──────────────────────────────────────────────────────────
    /** 档位 id → 文案；未知 id（上游自定义档）原样显示，不编造翻译。 */
    const EFFORT_TEXT = { light: 'effort.light', balanced: 'effort.balanced', deep: 'effort.deep' }
    const effortLabel = (t, id) => typeof EFFORT_TEXT[id] === 'string' ? t(EFFORT_TEXT[id]) : String(id)

    function ModelCard(props) {
      const { model: m, t, onBench, bench, effort, onEffort, busy } = props
      const stateKey = `state.${m.availability}`
      const dim = m.availability !== 'available'
      const rung = (m.budgets ?? []).find(row => row.isDefault === true)
      // 档位菜单的两个来源：显式 efforts 清单（真菜单，行可能是 `{id,name}`），
      // 或预算阶梯（真阶梯）。两者都没有的模型不渲染下拉。
      const declared = Array.isArray(m.efforts)
        ? m.efforts.map(row => typeof row === 'string' ? row : row?.id).filter(id => typeof id === 'string' && id !== '')
        : []
      const effortIds = declared.length > 0
        ? declared
        : (m.budgets ?? []).map(row => row.id).filter(id => typeof id === 'string' && id !== '')
      return h('article', { className: 'ofm_card' + (dim ? ' dim' : '') },
        h('div', { className: 'ofm_cardhead' },
          m.channel === 'kilo' ? h('span', { className: 'ofm_chantag', title: t('tag.kiloChannel') }, 'Kilo') : null,
          h('span', { className: 'ofm_cardname', title: m.name }, m.name),
          h('span', { className: 'ofm_badge ' + m.availability }, t(stateKey))),
        h('div', { className: 'ofm_id', title: m.id }, m.id),
        h('div', { className: 'ofm_tags' },
          h('span', { className: 'ofm_tag' }, m.vision ? t('tag.vision') : t('tag.text')),
          m.reasoning ? h('span', { className: 'ofm_tag' }, m.canDisableThinking === false ? t('tag.thinkingShared') : t('tag.thinking')) : null,
          h('span', { className: 'ofm_tag' }, `${t('tag.context')} ${kilo(m.contextWindow)}`),
          h('span', { className: 'ofm_tag' }, `${t('tag.output')} ${kilo(m.maxOutput)}`),
          rung === undefined ? null : h('span', { className: 'ofm_tag', title: t('tag.rungTitle').replace('{ladder}', m.budgets.map(row => `${row.name} ${kilo(row.tokens)}`).join(' · ')) },
            `${t('tag.rung')} ${kilo(rung.tokens)}`)),
        m.channel === 'kilo' ? h('p', { className: 'ofm_note', title: t('tag.kiloChannel') }, t('roster.kiloNote'))
          : m.availability === 'region-blocked' ? h('p', { className: 'ofm_note' }, t('hint.region'))
          : m.availability === 'throttled' ? h('p', { className: 'ofm_note', title: m.detail ?? '' }, t('hint.throttled'))
            : m.availability === 'unknown' ? h('p', { className: 'ofm_note' }, t('hint.unknown'))
              : m.availability === 'unavailable' ? h('p', { className: 'ofm_note', title: m.detail ?? '' }, t('hint.hidden'))
                : h('div', { className: 'ofm_metrics' },
                m.ttftMs === undefined || m.ttftMs === 0 ? null : h('span', null, t('tag.latency'), ' ', h('b', null, Math.round(m.ttftMs)), ' ms'),
                h('span', null, t('pref.probedAt'), ' ', h('b', null, ago(m.probedAt, t.locale)))),
        // 档位下拉：面板里选的档优先于会话里的 reasoningEffort（adapter 里的
        // `modelEffort[entry.id]` 覆盖），空值 = 跟随会话，不写任何东西。
        effortIds.length === 0 || onEffort === undefined ? null : h('div', { className: 'ofm_row', style: { marginTop: 4 } },
          h('span', { className: 'ofm_note', title: t('effort.hint') }, t('effort.label')),
          h('select', {
            className: 'ofm_input', style: { maxWidth: 150 }, value: effort ?? '', disabled: busy === true,
            'aria-label': t('effort.label'),
            onChange: event => onEffort(m, event.target.value),
          },
            h('option', { value: '' }, t('effort.follow')),
            effortIds.map(id => h('option', { key: id, value: id }, effortLabel(t, id)))),
          h('span', { className: 'ofm_note' }, t('effort.hint'))),
        m.canDisableThinking === false ? h('p', { className: 'ofm_note' }, t('hint.sharedBudget')) : null,
        onBench === undefined ? null : h('div', { className: 'ofm_row' },
          h(Button, { disabled: bench?.running === true, onClick: () => onBench(m) }, bench?.running === true ? t('bench.running') : t('bench.run')),
          bench?.result === undefined ? null : h('span', { className: 'ofm_note' }, bench.result)))
    }

    /**
     * 「免费模型」到底包含哪些行 —— 设置页与模型面板必须用同一个答案。
     *
     * 面板的那一组来自宿主的 `ROUTE_MAIN` membership，它除了免费车道自己的行，
     * 还包含 **Kilo 渠道**的行：Kilo 走同一条 adapter 路由，所以在选择器里和
     * 免费车道共用一个「免费模型」标题。设置页过去只按 `!m.channel` 过滤，
     * 于是面板里能选的 13 个 Kilo 模型在设置页一个都看不到 —— 用户看到的就是
     * 「面板有、设置里没有」，而免费车道那 10 行恰好全在限流，整页像空的。
     *
     * 这里把 Kilo 一并算进免费模型页；自有渠道（channel 'own'）、聚合、组合链、
     * 路由分组各有自己的页签，仍然排除。
     */
    const isFreeRosterRow = row => row.channel === undefined || row.channel === 'kilo'

    function Roster(props) {
      const { summary, t, onBench, benches, effortTable, onEffort, busy } = props
      const [showDead, setShowDead] = useState(true)
      // 与模型面板的「免费模型」组同源：免费车道 + Kilo 渠道。
      // Kilo 走同一条 adapter 路由，在选择器里与免费车道共用一个标题，因此
      // 也必须算进这一页；否则面板里能用的十几个 Kilo 模型在设置里会消失，
      // 而免费车道那十行恰好全在限流，整页看起来就像空的。
      const roster = summary.catalog.filter(isFreeRosterRow)
      const available = roster.filter(m => m.availability === 'available')
      const limited = roster.filter(m => m.availability === 'region-blocked')
      // 默认展示全部：这里曾经用 showDead=false 折叠「不可用」行，结果整条
      // 车道都没探通时设置页只剩一片空白，看起来像插件坏了。开关只用来主动
      // 收起，不用来隐藏真相。
      //
      // 限流单独成组：它是上游主动限速、会自己恢复的临时状态；和「探测判定
      // 不可用」混在一起，恰好把这个最有用的结论抹掉了。
      const throttled = roster.filter(m => m.availability === 'throttled')
      const dead = roster.filter(m => m.availability !== 'available'
        && m.availability !== 'region-blocked' && m.availability !== 'throttled')
      const foldable = throttled.length + dead.length
      const group = (title, list, hint) => list.length === 0 ? null
        : h('div', { className: 'ofm_sec', style: { gap: 8 } },
          h('div', { className: 'ofm_row' }, h('span', { className: 'ofm_sec_title', style: { fontSize: 12.5 } }, title),
            hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, hint)),
          h('div', { className: 'ofm_grid' }, list.map(m => h(ModelCard, {
            key: m.id, model: m, t, onBench,
            effort: (effortTable ?? {})[m.id] ?? '',
            onEffort, busy,
            bench: { running: benches[m.id]?.running === true, ...benches[m.id]?.result === undefined ? {} : { result: benches[m.id].result } },
          }))))
      return h(Fragment, null,
        group(t('state.available'), available),
        group(t('state.region-blocked'), limited, t('hint.region')),
        foldable === 0 ? null : h('div', { className: 'ofm_row', style: { marginTop: 10 } },
          h(Switch, {
            checked: !showDead,
            label: t(showDead ? 'roster.collapseDead' : 'roster.showDead').replace('{n}', String(foldable)),
            onChange: () => setShowDead(value => !value),
          })),
        showDead ? h(Fragment, null,
          group(t('state.throttled'), throttled, t('roster.throttledHint')),
          group(t('state.unavailable'), dead, t('roster.deadHint'))) : null)
    }

    // ── dashboard ─────────────────────────────────────────────────────────────
    // ── pool panel (co-paid lane capacity & live pressure) ────────────────────
    // Numbers come from the gateway through the plugin backend (/pool), which
    // is the only place the sealed gateway URL exists. All of them are real:
    // capacity is the operator's actual provisioning rule (stars × 1.5, or a
    // configured count), and the load verdict — 畅通 / 繁忙 / 过载 — is computed
    // by the gateway process itself from its in-flight streams and event-loop
    // saturation, so the panel and the server can never disagree about the
    // color. The panel renders nothing at all when the host has no lane or the
    // gateway is dark — a gauge that lies would be worse than no gauge.
    const POOL_REPO_URL = ''
    const FISH_PATH = 'M1 7c2.5-3.5 7-5 11-3.2L18.5 1v12L12 10.2C8 12 3.5 10.5 1 7zm16.4 0l5.1-3.4v6.8L17.4 7zM8.4 5.6a1 1 0 11-2 0 1 1 0 012 0z'

    /**
     * The aquarium itself: water level, waves, bubbles, three fish and a glass
     * frame. It is deliberately a *pure* visual — every page that shows one
     * decides what the level means (free lane: share of models reachable;
     * EAC lane: the co-paid pool's 24h pressure), because a tank whose meaning
     * changes with the caller is the only way to put the same object at the top
     * of two pages without either one lying about its numbers.
     */
    function Tank(props) {
      const { pct, level = 'ok', size, label } = props
      const fish = ['f1', 'f2', 'f3'].map(name => h('i', { className: `ofm_fish ${name}`, key: name },
        h('svg', { viewBox: '0 0 24 14' }, h('path', { d: FISH_PATH }))))
      const bubbles = ['b1', 'b2', 'b3', 'b4', 'b5'].map(name => h('i', { className: `ofm_bubble ${name}`, key: name }))
      if (pct === null || pct === undefined) return null
      return h('div', {
        className: `ofm_tank ${level}${size === 'xl' ? ' xl' : ''}`,
        role: 'img',
        'aria-label': label ?? `${pct}%`,
        style: { '--lvl': `${Math.max(0, Math.min(100, pct))}%` },
      },
        h('div', { className: 'ofm_tankwater' },
          h('div', { className: 'ofm_tankdeep' }, ...bubbles, ...fish),
          h('i', { className: 'ofm_wave w1' }),
          h('i', { className: 'ofm_wave w2' })),
        h('i', { className: 'ofm_tankrays' }),
        h('i', { className: 'ofm_tankshine' }),
        pct <= 0 ? h('span', { className: 'ofm_tankempty' }, `${pct}%`) : null,
        h('div', { className: 'ofm_tankglass' }))
    }

    /**
     * The co-paid pool snapshot, shared by the EAC page's tank and its detail
     * panel. One hook so the page and the panel never disagree: both read the
     * same 30-second poll. `pool === undefined` means "still loading", `null`
     * means "the host has no lane or the gateway is dark" — the caller decides
     * whether that is a muted line or nothing at all.
     */
    function usePool() {
      const [pool, setPool] = useState(undefined)
      const [poolError, setPoolError] = useState('')
      useEffect(() => {
        let alive = true
        // The gateway can be slow under exactly the load this panel reports;
        // the 8s api() default would abort while the backend is still waiting.
        const load = () => api('/pool', { timeout: 25_000 })
          .then(data => {
            if (!alive) return
            setPool(data?.pool != null ? data : null)
            setPoolError('')
          })
          .catch(error => {
            if (!alive) return
            setPool(null)
            // The backend tags the failure with a fixed reason code; map it to
            // readable text instead of hiding the panel in silence.
            const code = /\(([^)]+)\)\s*$/.exec(String(error?.message ?? ''))?.[1] ?? ''
            setPoolError(code)
          })
        load()
        const timer = setInterval(load, 30_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      return { pool, poolError }
    }

    /** The pool's load verdict and the numbers behind it, from one snapshot. */
    function poolReading(pool) {
      const active = Number.isFinite(pool.active24h) ? pool.active24h : null
      const capacityKnown = Number.isFinite(pool.pool) && pool.pool > 0
      // Two readings, on purpose: the tank cannot hold more than full, but the
      // page must not round a pool running at 147% of its provisioned capacity
      // down to "100%" — that reads as "exactly at capacity", which is a
      // different, calmer sentence than what the gateway is saying.
      const rawPct = capacityKnown && active !== null ? Math.round(100 * active / pool.pool) : null
      const pct = rawPct === null ? null : Math.max(0, Math.min(100, rawPct))
      // A gateway build that predates the level verdict answers without one.
      // The plugin then applies the same default thresholds locally, so an
      // upgraded panel never reads a calm color off an unupgraded server —
      // and once the gateway does send its verdict, that one wins.
      const level = pool.level === 'over' || (pool.level === undefined && pool.inflight >= 80) ? 'over'
        : pool.level === 'busy' || (pool.level === undefined && pool.inflight >= 30) ? 'busy' : 'ok'
      return { active, capacityKnown, pct, rawPct, level }
    }

    /** The repository a page's star button points at, opened in a new tab. No
     *  repository is baked into this build: without one the button renders
     *  nothing. */
    function StarButton(props) {
      const { t, repo = POOL_REPO_URL } = props
      if (repo === '' || repo === undefined || repo === null) return null
      const label = t('star.cta')
      return h('a', {
        className: 'ofm_starbtn',
        href: `https://github.com/${String(repo).replace(/^https?:\/\/github\.com\//, '')}`,
        target: '_blank',
        rel: 'noreferrer noopener',
        title: `${t('star.title')} · ${repo}`,
      }, h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: 'M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z' })),
        label)
    }
    /** Where the pool's capacity number comes from, in one sentence. */
    function capacityText(pool, t) {
      if (pool.poolSource === 'formula') return t('pool.formula').replace('{stars}', String(pool.stars ?? '—'))
      if (pool.poolSource === 'configured') return t('pool.configured')
      return t('pool.capacityUnknown')
    }

    // ── EAC 渠道授权（GitHub 登录 + Star） ────────────────────────────────────
    // 闸门在服务器：网关拒绝没有用户令牌的对话，而这个面板是取得令牌的唯一入口。
    // 三种状态如实呈现——未登录 / 已登录但未 star / 已授权——并且登录全程无需
    // 复制粘贴：后端把授权页交给系统浏览器，前端轮询网关领取令牌。令牌本身从不
    // 到达浏览器，这里只显示登录名与判定结果。
    //
    // 登录流（发起、轮询、busy/notice）住在 SettingsPage 级的 hook 里：页头的
    // 未授权按钮、上锁模型卡的「去授权」和这个面板必须共享同一个进行中的会话，
    // 各挂一份轮询会互相抢令牌的领取权。
    const EAC_LOGIN_TTL = 10 * 60_000
    const EAC_LOGIN_KEY = `ofm.eac.pending:${API}`
    function rememberEacLogin(pending) {
      try {
        if (pending === null) sessionStorage.removeItem(EAC_LOGIN_KEY)
        else sessionStorage.setItem(EAC_LOGIN_KEY, JSON.stringify(pending))
      } catch { /* restricted browser storage: this mounted page can still log in */ }
    }
    function restoreEacLogin() {
      try {
        const value = JSON.parse(sessionStorage.getItem(EAC_LOGIN_KEY))
        if (value !== null && /^[A-Za-z0-9_-]{16,64}$/.test(value.link)
          && typeof value.url === 'string' && /^https?:\/\//.test(value.url)
          && Number.isFinite(value.startedAt) && value.startedAt <= Date.now()
          && Date.now() - value.startedAt < EAC_LOGIN_TTL) return value
      } catch { /* absent or malformed */ }
      rememberEacLogin(null)
      return null
    }
    function Dashboard(props) {
      const { stats, t } = props
      const days = useMemo(() => [...stats.days].sort((a, b) => a.day.localeCompare(b.day)), [stats.days])
      const recent = [...(stats.samples ?? [])].slice(-40)
      // 「最近一回合」跟着一个轻量轮询走（#26）：看板其余部分仍是页面加载时的
      // 快照，这一行单独刷新，让「刚发完一条消息」的用户不用整页重载就能看到
      // 这一回合的 token 去向。聊天窗属于宿主内核，插件无法在对话流里注入，
      // 这是插件表面能做到的最接近实时的位置。
      const [fresh, setFresh] = useState(null)
      useEffect(() => {
        let alive = true
        const timer = setInterval(() => api('/stats').then(data => { if (alive) setFresh(data) }).catch(() => {}), 60_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      // The host already dropped the windows it could not measure and took out of
      // the numerator the tokens it never streamed. Averaging per-call rates
      // instead let one 1 ms window publish 63 000 tok/s and carry the whole card
      // to 2 493.
      const streamed = recent.filter(sample => sample.decodeMs > 0 && sample.tps !== null)
      const streamMs = streamed.reduce((sum, sample) => sum + sample.decodeMs, 0)
      const weightedTps = streamMs > 0
        ? streamed.reduce((sum, sample) => sum + (sample.decodeTokens ?? 0), 0) / (streamMs / 1000)
        : null
      const latencies = recent.filter(sample => sample.ttftMs !== null && sample.ttftMs !== undefined)
      const models = stats.models ?? []
      const [mode, setMode] = useState('tokens')
      const [metric, setMetric] = useState('total')

      const cumulative = useMemo(() => {
        let tokenRun = 0
        let requestRun = 0
        return days.map(row => {
          tokenRun += row.total
          requestRun += row.models.reduce((sum, m) => sum + m.calls, 0)
          return { ...row, total: mode === 'requests' ? requestRun : tokenRun }
        })
      }, [days, mode])

      const active = metric === 'total' ? undefined : models.find(m => m.model === metric)
      const color = metric === 'total'
        ? 'var(--dsw-alias-state-business-primary)'
        : SEASON[Math.max(0, models.findIndex(m => m.model === metric)) % SEASON.length]

      const headline = h('div', { className: 'ofm_stats' },
        stat(kilo(stats.grand.input + stats.grand.output), t('curve.tokens')),
        stat(kilo(stats.grand.output), t('stat.output')),
        stat(kilo(stats.grand.reasoning), t('stat.reasoning')),
        stat(String(stats.requests ?? 0), t('speed.calls')),
        stat(String(stats.requestFailures ?? stats.grand.failed ?? 0), t('speed.failed')),
        stat(String(stats.turns ?? stats.grand.turns ?? 0), t('speed.turns')),
        stat(String(stats.failedTurns ?? stats.grand.failedTurns ?? 0), t('speed.turnFailed')),
        stat(String(stats.recoveredTurns ?? stats.grand.recoveredTurns ?? 0), t('speed.recovered')))

      const heatmap = h(Panel, { title: t('heat.title') }, h(Heatmap, { days, t }))

      const legend = h('div', { className: 'ofm_chips' },
        chip(t('curve.total'), metric === 'total', SEASON[0], () => setMetric('total')),
        models.map((m, index) => chip(m.name, metric === m.model, SEASON[index % SEASON.length], () => setMetric(m.model))))

      const curve = h(Panel, { title: t('curve.title') },
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_seg' },
            segButton(t('curve.tokens'), mode === 'tokens', () => setMode('tokens')),
            segButton(t('curve.requests'), mode === 'requests', () => setMode('requests'))),
          legend),
        h(TrendChart, { series: cumulative, mode, metric, color }),
        active === undefined ? null : h('p', { className: 'ofm_note' },
          active.name, ' · ', String(active.calls), ' ', t('speed.calls'),
          active.tps === null || active.tps === undefined ? null : ' · ',
          active.tps === null || active.tps === undefined ? null : `${active.tps} ${t('unit.tokPerSec')}`))

      // 最近一回合（#26）：取最新一条调用样本，输入/输出 token、首帧、速度，
      // 失败的调用也如实标出。数据源优先用轮询到的新快照，退回页面加载时的。
      const lastSample = (fresh?.samples ?? stats.samples ?? []).slice(-1)[0] ?? null
      const nameOfModel = id => models.find(m => m.model === id)?.name ?? id
      const agoOf = at => {
        const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
        if (seconds < 60) return t('last.justNow')
        if (seconds < 3600) return t('last.minAgo').replace('{n}', String(Math.floor(seconds / 60)))
        if (seconds < 86400) return t('last.hourAgo').replace('{n}', String(Math.floor(seconds / 3600)))
        return t('last.dayAgo').replace('{n}', String(Math.floor(seconds / 86400)))
      }
      const originOf = value => ({ chat: t('last.originChat'), harness: t('last.originHarness'), forward: t('last.originForward'), bench: t('last.originBench') })[value] ?? String(value ?? '')
      const lastTurnStrip = lastSample === null ? null : h('div',
        { className: 'ofm_row', style: { flexWrap: 'wrap', gap: 14, alignItems: 'baseline', paddingBottom: 10, marginBottom: 12, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h('b', { style: { fontSize: 13 } }, t('last.title')),
        h('b', { style: { fontSize: 13 } }, nameOfModel(lastSample.model)),
        h('span', { className: 'ofm_note' },
          `${originOf(lastSample.origin)} · ${t('last.input')} ${kilo(lastSample.input)} · ${t('col.output')} ${kilo(lastSample.output)} tok`
          + (lastSample.ttftMs != null ? ` · ${t('speed.ttft')} ${Math.round(lastSample.ttftMs)} ${t('unit.ms')}` : '')
          + (lastSample.tps != null ? ` · ${t('speed.tps')} ${Math.round(lastSample.tps)} ${t('unit.tokPerSec')}` : '')
          + (lastSample.ok === false ? ` · ${t('speed.failed')}` : '')),
        h('span', { className: 'ofm_note', style: { marginLeft: 'auto' } }, agoOf(lastSample.at)))

      const speed = h(Panel, { title: t('speed.title'), hint: recent.length + ' ' + t('speed.calls') },
        recent.length === 0
          ? h('p', { className: 'ofm_note' }, t('speed.none'))
          : h(Fragment, null,
            lastTurnStrip,
            h('div', { className: 'ofm_row', style: { gap: 24 } },
              sparkCell(t('speed.tps'), streamed.map(s => s.tps), SEASON[0], value => Math.round(value) + ' ' + t('unit.tokPerSec'), t, weightedTps),
              sparkCell(t('speed.ttft'), latencies.map(s => s.ttftMs), SEASON[2], value => Math.round(value) + ' ' + t('unit.ms'), t),
              sparkCell(t('stat.output'), recent.map(s => s.output), SEASON[1], value => kilo(value) + ' tok', t)),
            h('p', { className: 'ofm_note' }, t('speed.note')
              .replace('{n}', String(streamed.length))
              .replace('{total}', String(recent.length)))))

      const table = models.length === 0 ? null : h(Panel, { title: t('speed.model') },
        h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
          h('thead', null, h('tr', null,
            h('th', null, t('speed.model')),
            num(t('speed.calls')), num(t('speed.turns')), num(t('speed.recovered')),
            num(t('speed.tps')), num(t('speed.ttft')), num(t('col.reason')),
            num(t('col.output')), num(t('speed.failed')), num(t('speed.turnFailed')))),
          h('tbody', null, [...models].sort((a, b) => b.output - a.output).map(m => h('tr', { key: m.model },
            h('td', { title: m.model }, m.name),
            numTd(m.calls),
            numTd(m.turns),
            numTd(m.recoveredTurns === 0 ? '—' : m.recoveredTurns),
            numTd(m.tps),
            numTd(m.avgTtftMs === null || m.avgTtftMs === undefined ? null : Math.round(m.avgTtftMs)),
            numTd(kilo(m.reasoning)),
            numTd(kilo(m.output)),
            numTd(m.failed === 0 ? '—' : m.failed),
            numTd(m.failedTurns === 0 ? '—' : m.failedTurns)))))))

      const historyNote = stats.logicalEstimated || stats.requestFailuresEstimated
        ? h('p', { className: 'ofm_note' }, t('speed.estimated'))
        : null
      return h(Fragment, null, headline, h('p', { className: 'ofm_note' }, t('speed.scope')), historyNote,
        h('div', { className: 'ofm_two' }, heatmap, curve), speed, table)
    }

    const sparkCell = (label, values, color, format, t, summary) => {
      const shown = summary !== undefined ? summary : values.length < 2 ? null : avg(values)
      return h('div', { className: 'ofm_sec', style: { gap: 2 } },
        h('span', { className: 'ofm_note' }, label),
        h(Sparkline, { values, color, t }),
        h('b', { style: { fontSize: 15 } }, shown === null ? '—' : format(shown)))
    }

    const stat = (value, label) => h('div', { className: 'ofm_stat' }, h('b', null, value), h('span', null, label))
    const num = label => h('th', { className: 'ofm_num' }, label)
    const numTd = value => h('td', { className: 'ofm_num' }, value === null || value === undefined ? '—' : value)
    const avg = list => list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length
    const segButton = (label, on, onClick) => h('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false', onClick }, label)
    const chip = (label, on, color, onClick) => h('button', { type: 'button', className: 'ofm_chip', 'aria-pressed': on ? 'true' : 'false', onClick, style: on ? { color } : undefined },
      h('span', { className: 'ofm_swatch', style: { background: color } }), label)

    // ── forward listener ──────────────────────────────────────────────────────
    function Forward(props) {
      const { settings, t, onApply, busy } = props
      const [draft, setDraft] = useState(settings.forward)
      useEffect(() => setDraft(settings.forward), [settings.forward?.enabled, settings.forward?.host, settings.forward?.port, settings.forward?.lan?.enabled, settings.forward?.lan?.port, settings.forward?.lan?.running])
      const [key, setKey] = useState('')
      const [shown, setShown] = useState(false)
      const [copied, setCopied] = useState('')
      useEffect(() => {
        if (draft?.running !== true) return
        let alive = true
        api('/forward/key').then(payload => { if (alive) setKey(payload.key ?? '') }).catch(() => {})
        return () => { alive = false }
      }, [draft?.running])
      const port = draft?.actualPort ?? draft?.port ?? 0
      const base = `http://${draft?.host || '127.0.0.1'}:${port}/v1`
      const doCopy = (label, value) => copy(value, ok => {
        if (!ok) return
        setCopied(label)
        setTimeout(() => setCopied(''), 1600)
      })
      const curl = `curl ${base}/chat/completions \\\n  -H "authorization: Bearer ${shown && key !== '' ? key : '<API KEY>'}" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"<model id>","messages":[{"role":"user","content":"hi"}]}'`

      // The relay is a door of its own: its own key, its own liveness, and an
      // address that only exists while it is listening.
      const lan = draft?.lan
      const [lanKey, setLanKey] = useState('')
      const [lanShown, setLanShown] = useState(false)
      useEffect(() => {
        if (lan?.running !== true) return
        let alive = true
        api('/forward/lan/key').then(payload => { if (alive) setLanKey(payload.key ?? '') }).catch(() => {})
        return () => { alive = false }
      }, [lan?.running])
      const lanPort = lan?.actualPort ?? lan?.port ?? 0
      // Which address a peer should dial is a property of this machine's
      // interfaces, and they move under the panel: a laptop that changed networks,
      // woke from sleep, or brought a VPN up holds a different set than it did a
      // minute ago — and the stale one is exactly the one the user copies to the
      // other machine. So while the relay is on this polls the addresses
      // themselves, at the same 15 s cadence the outlet's node reading uses,
      // instead of trusting the snapshot that shipped with the settings.
      const lanLive = useAsync(() => api('/forward/lan/addresses'), [lan?.running])
      const reloadLanAddresses = lanLive.reload
      useEffect(() => {
        if (lan?.running !== true) return undefined
        const timer = setInterval(() => reloadLanAddresses(), 15_000)
        return () => clearInterval(timer)
      }, [lan?.running, reloadLanAddresses])
      const lanHosts = lanLive.data?.addresses ?? lan?.addresses ?? []
      const lanHost = lanHosts[0] ?? ''
      const lanUrl = lanHost === '' ? t('forward.lanNoAddress') : `http://${lanHost}:${lanPort}/v1`
      const lanToggle = current => ({ ...current, lan: { ...(current?.lan ?? {}), enabled: !(current?.lan?.enabled === true) } })

      return h(Panel, null,
        h('div', { className: 'ofm_row' },
          h(Switch, { checked: draft?.enabled === true, label: t('forward.enabled'), onChange: () => setDraft(current => ({ ...current, enabled: !(current?.enabled === true) })) }),
          h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${draft?.running === true ? 'ok' : draft?.error ? 'err' : ''}` }), draft?.running === true ? t('forward.running') : t('forward.stopped'))),
        h('div', { className: 'ofm_row' },
          field(t('forward.host'), h('input', { className: 'ofm_input', style: { maxWidth: 150 }, value: draft?.host ?? '127.0.0.1', onChange: e => setDraft(c => ({ ...c, host: e.target.value })) })),
          field(t('forward.port'), h('input', { className: 'ofm_input', style: { maxWidth: 110 }, inputMode: 'numeric', value: draft?.port ?? '', onChange: e => setDraft(c => ({ ...c, port: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
          h(Button, { kind: 'primary', disabled: busy || draft?.enabled === undefined, onClick: () => onApply({ forward: { enabled: draft.enabled === true, host: draft.host, port: draft.port } }) }, t('forward.apply'))),
        draft?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('forward.error').replace('{message}', draft.error)) : null,
        draft?.notice ? h('div', { className: 'ofm_callout' }, t('forward.notice').replace('{message}', draft.notice)) : null,
        draft?.running === true ? h(Fragment, null,
          h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('forward.baseUrl')),
            h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, base),
            h(Button, { kind: 'ghost', onClick: () => doCopy('base', base) }, copied === 'base' ? t('forward.copied') : t('forward.copy'))),
          h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('forward.key')),
            h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: shown ? 0 : 1 } }, key === '' ? '…' : shown ? key : '•'.repeat(24)),
            h(Button, { kind: 'ghost', onClick: () => setShown(value => !value) }, shown ? t('forward.hide') : t('forward.show')),
            h(Button, { kind: 'ghost', onClick: () => doCopy('key', key) }, copied === 'key' ? t('forward.copied') : t('forward.copy')),
            h(Button, { kind: 'ghost', title: t('forward.rotateWarn'), onClick: async () => { const payload = await post('/forward/rotate'); setKey(payload.key ?? ''); setShown(true) } }, t('forward.rotate'))),
          h('div', { className: 'ofm_sec', style: { gap: 4 } }, h('span', { className: 'ofm_note' }, t('forward.example')),
            h('pre', { className: 'ofm_mono' }, curl),
            h('div', null, h(Button, { kind: 'ghost', onClick: () => doCopy('curl', curl) }, copied === 'curl' ? t('forward.copied') : t('forward.copy'))))) : null,
        h('div', { className: 'ofm_sec', style: { gap: 6, marginTop: 12 } },
          h('div', { className: 'ofm_note' }, t('forward.lanTitle')),
          h('div', { className: 'ofm_row' },
            h(Switch, { checked: lan?.enabled === true, label: t('forward.lanEnabled'), onChange: () => setDraft(lanToggle) }),
            h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${lan?.running === true ? 'ok' : lan?.error ? 'err' : ''}` }), lan?.running === true ? t('forward.lanRunning') : t('forward.lanStopped'))),
          h('div', { className: 'ofm_row' },
            field(t('forward.lanPort'), h('input', { className: 'ofm_input', style: { maxWidth: 110 }, inputMode: 'numeric', value: lan?.port ?? 0, onChange: e => setDraft(c => ({ ...c, lan: { ...(c?.lan ?? {}), port: Number(e.target.value.replace(/\D/g, '')) || 0 } })) })),
            h('span', { className: 'ofm_note' }, t('forward.lanAuto')),
            h(Button, { kind: 'primary', disabled: busy, onClick: () => onApply({ forward: { enabled: draft?.enabled === true, host: draft?.host, port: draft?.port, lan: { enabled: lan?.enabled === true, port: lan?.port ?? 0 } } }) }, t('forward.lanApply'))),
          h('div', { className: 'ofm_callout' }, t('forward.lanWarn')),
          h('div', { className: 'ofm_note' }, t('forward.lanHint')),
          lan?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('forward.lanError').replace('{message}', lan.error)) : null,
          lan?.running === true ? h(Fragment, null,
            h('div', { className: 'ofm_row' },
              h('span', { className: 'ofm_note' }, t('forward.lanUrl')),
              h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, lanUrl),
              h(Button, { kind: 'ghost', onClick: () => doCopy('lanUrl', lanUrl) }, copied === 'lanUrl' ? t('forward.copied') : t('forward.copy'))),
            lanHosts.length > 1 ? h('div', { className: 'ofm_note' }, t('forward.lanAlso').replace('{list}', lanHosts.slice(1).join('    '))) : null,
            h('div', { className: 'ofm_row' },
              h('span', { className: 'ofm_note' }, t('forward.lanKey')),
              h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: lanShown ? 0 : 1 } }, lanKey === '' ? '…' : lanShown ? lanKey : '•'.repeat(24)),
              h(Button, { kind: 'ghost', onClick: () => setLanShown(value => !value) }, lanShown ? t('forward.hide') : t('forward.show')),
              h(Button, { kind: 'ghost', onClick: () => doCopy('lanKey', lanKey) }, copied === 'lanKey' ? t('forward.copied') : t('forward.copy')),
              h(Button, { kind: 'ghost', title: t('forward.lanRotateWarn'), onClick: async () => { const payload = await post('/forward/lan/rotate'); setLanKey(payload.key ?? ''); setLanShown(true) } }, t('forward.rotate')))) : null))
    }

    // ── egress outlet ─────────────────────────────────────────────────────────
    // Two ways out: a Clash subscription load-balanced by a spawned mihomo, or
    // one hand-written http/https/socks5 URL. Until this is on AND started,
    // egressFetch sends every request direct — nothing here is load-bearing for
    // plain use. The address is a credential, so it never rides along in the
    // settings payload: this panel shows the masked host and pulls the value
    // itself (`/egress/url`) only when the owner asks to see or copy it.
    function Egress(props) {
      const { settings, t, onApply, busy } = props
      const [draft, setDraft] = useState(settings.egress ?? {})
      useEffect(() => setDraft(settings.egress ?? {}), [settings.egress?.enabled, settings.egress?.mode, settings.egress?.urlLabel, settings.egress?.hasUrl, settings.egress?.active, settings.egress?.error])
      const [urlShown, setUrlShown] = useState(false)
      const [urlValue, setUrlValue] = useState('')
      const [copied, setCopied] = useState('')
      const readUrl = () => api('/egress/url').then(payload => String(payload?.url ?? '')).catch(() => '')
      // Which node url-test is carrying traffic on, and what the last gateway
      // round trip cost. mihomo re-ranks on its own schedule, so while the outlet
      // is on this polls instead of trusting the snapshot that shipped with the
      // settings. `/outlet` reads the controller, so it is only worth calling
      // when an outlet is actually running.
      const live = useAsync(() => api('/outlet'), [settings.egress?.enabled, settings.egress?.active])
      const reloadOutlet = live.reload
      const running = settings.egress?.active === true
      useEffect(() => {
        if (!running) return undefined
        const timer = setInterval(() => reloadOutlet(), 15_000)
        return () => clearInterval(timer)
      }, [running, reloadOutlet])
      const status = running && live.data ? live.data : draft
      const node = typeof status?.node === 'string' ? status.node : ''
      const nodeDelayMs = Number(status?.nodeDelayMs ?? 0)
      const latencyMs = Number(status?.latencyMs ?? 0)
      const subscription = draft?.mode !== 'client'
      const statusLine = text => h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, text)
      // The stored address is never in the payload this panel was rendered
      // from, so "see it" and "copy it" both cost one on-demand fetch, and the
      // masked form is all this page holds the rest of the time.
      const revealUrl = async () => {
        if (urlShown) { setUrlShown(false); return }
        setUrlValue(await readUrl())
        setUrlShown(true)
      }
      const copyUrl = async () => {
        const value = await readUrl()
        if (value === '') return
        copy(value, ok => {
          if (!ok) return
          setCopied('egressUrl')
          setTimeout(() => setCopied(''), 1600)
        })
      }
      const urlMask = draft?.hasUrl === true ? `${draft?.urlLabel ?? ''}/…` : t('egress.urlNone')
      const apply = () => {
        const patch = { enabled: draft?.enabled === true, mode: subscription ? 'subscription' : 'client', mihomoPath: String(draft?.mihomoPath ?? '') }
        // Empty means "keep the stored address": this panel never received it,
        // so it has nothing to send back, and an empty string would read as
        // "clear it" on the receiving end.
        if (String(draft?.url ?? '') !== '') patch.url = String(draft.url)
        onApply({ egress: patch })
      }
      return h(Panel, null,
        h('div', { className: 'ofm_row' },
          h(Switch, { checked: draft?.enabled === true, label: t('egress.enabled'), onChange: () => setDraft(c => ({ ...c, enabled: !(c?.enabled === true) })) }),
          h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${draft?.active === true ? 'ok' : draft?.error ? 'err' : ''}` }), draft?.active === true ? t('egress.active') : t('egress.inactive'))),
        h('div', { className: 'ofm_row' },
          h(Switch, { checked: subscription, label: t('egress.modeSubscription'), onChange: () => setDraft(c => ({ ...c, mode: subscription ? 'client' : 'subscription' })) })),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.url')),
          h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: urlShown ? 0 : 1 } },
            urlShown ? (urlValue === '' ? t('egress.urlNone') : urlValue) : urlMask),
          h(Button, { kind: 'ghost', onClick: revealUrl }, urlShown ? t('forward.hide') : t('forward.show')),
          h(Button, { kind: 'ghost', onClick: copyUrl }, copied === 'egressUrl' ? t('forward.copied') : t('forward.copy')),
          // Deleting the address is still a thing the owner may want, and the
          // panel cannot express it by sending back a field it never held — so
          // it says so outright, and the outlet goes down with the credential.
          h(Button, { kind: 'ghost', title: t('egress.urlClearWarn'), disabled: draft?.hasUrl !== true || busy, onClick: () => {
            setUrlShown(false)
            setUrlValue('')
            onApply({ egress: { enabled: false, mode: subscription ? 'subscription' : 'client', mihomoPath: String(draft?.mihomoPath ?? ''), url: '' } })
          } }, t('egress.urlClear'))),
        h('div', { className: 'ofm_row' },
          field(t('egress.urlNew'), h('input', { className: 'ofm_input', style: { flex: 1, minWidth: 260 }, value: draft?.url ?? '', placeholder: t('egress.urlPlaceholder'), onChange: e => setDraft(c => ({ ...c, url: e.target.value })) })),
          h(Button, { kind: 'primary', disabled: busy, onClick: apply }, t('egress.apply'))),
        subscription ? h('div', { className: 'ofm_row' },
          field(t('egress.mihomoPath'), h('input', { className: 'ofm_input', style: { flex: 1, minWidth: 260 }, value: draft?.mihomoPath ?? '', placeholder: 'auto', onChange: e => setDraft(c => ({ ...c, mihomoPath: e.target.value })) })),
          h('span', { className: 'ofm_note' }, t('egress.mihomoHint'))) : null,
        draft?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('egress.error').replace('{message}', draft.error)) : null,
        h('div', { className: 'ofm_note' }, t('egress.direct')),
        running ? h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.outlet')),
          statusLine(`${draft.outlet ?? ''} · ${draft.mode ?? ''}`)) : null,
        running ? h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.node')),
          statusLine(node === '' ? t('egress.measuring') : nodeDelayMs > 0 ? `${node} · ${nodeDelayMs}ms` : node)) : null,
        running ? h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.latency')),
          statusLine(latencyMs > 0 ? `${(latencyMs / 1000).toFixed(2)}s` : t('egress.measuring'))) : null)
    }

    const field = (label, control) => h('label', { className: 'ofm_field' }, h('span', null, label), control)

    // ── preferences ───────────────────────────────────────────────────────────
    function Preferences(props) {
      const { summary, t, onApply, busy } = props
      const settings = summary.settings
      const [draft, setDraft] = useState(settings)
      useEffect(() => setDraft(settings), [summary])
      return h(Panel, null,
        h('div', { className: 'ofm_row', style: { gap: 20 } },
          h(Switch, { checked: settings.enabled !== false, label: t('pref.enabled'), onChange: () => onApply({ enabled: !(settings.enabled !== false) }) }),
          h(Switch, { checked: settings.exposeRegionModels !== false, label: t('pref.exposeRegion'), onChange: () => onApply({ exposeRegionModels: !(settings.exposeRegionModels !== false) }) }),
          h(Switch, { checked: settings.hideChannelModels === true, label: t('pref.hideChannels'), onChange: () => onApply({ hideChannelModels: !(settings.hideChannelModels === true) }) })),
        h('div', { className: 'ofm_row', style: { gap: 10 } },
          h(Switch, { checked: settings.hideUnavailableModels === true, label: t('pref.hideUnavailable'), onChange: () => onApply({ hideUnavailableModels: !(settings.hideUnavailableModels === true) }) }),
          h('span', { className: 'ofm_note' }, t('pref.hideUnavailableHint'))),
        h('div', { className: 'ofm_row' },
          field(t('pref.interval'), h('input', { className: 'ofm_input', style: { maxWidth: 100 }, value: draft?.probeIntervalMinutes ?? 15, onChange: e => setDraft(c => ({ ...c, probeIntervalMinutes: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
          field(t('pref.maxTokens'), h('input', { className: 'ofm_input', style: { maxWidth: 120 }, value: draft?.defaultMaxTokens ?? 32768, onChange: e => setDraft(c => ({ ...c, defaultMaxTokens: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
          h(Button, { kind: 'primary', disabled: busy, onClick: () => onApply({ probeIntervalMinutes: draft.probeIntervalMinutes, defaultMaxTokens: draft.defaultMaxTokens }) }, t('forward.apply'))),
        h('div', { className: 'ofm_row', style: { gap: 8 } },
          h('span', { className: 'ofm_pill' }, `${t('pref.egress')}: ${summary.egress?.ip ?? '—'}${summary.egress?.country ? ` (${summary.egress.country})` : ''}`),
          h('span', { className: 'ofm_pill' }, `${t('pref.probedAt')}: ${ago(summary.probedAt, t.locale)}`)))
    }

    // ── 白嫖模型接入页 ────────────────────────────────────────────────────────
    // Real channel logos carried over from the upstream Channel Pack client (see
    // vendor/channel-pack/NOTICE.md) — the same artwork users know from those
    // products, embedded so no network fetch is involved. Channels without an
    // entry fall back to their two-letter tile.
    const CHANNEL_ICONS = {
      'codearts': 'data:image/png;base64,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',
      'buddy': 'data:image/png;base64,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',
      'workbuddy': 'data:image/png;base64,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',
      'qodercn': 'data:image/png;base64,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',
      'qoder': 'data:image/png;base64,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',
      'cline': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAL60lEQVR42u1Za4xU1R3/nXPvnZmd2YUd9jG7dBcFEbTsqgtatInBjVAsrW19IG1iiLYFUyqhNvGbH+on0uoXpSFBEiVEMEpsbIiv0BSFRCNRYbMrC7JL9zG4sCywM+zszp17zzntOfcx984szPpIkzbcZOY+zzn/3//9/x8d/+OHfg3ANQD/RQC7dwssWIBYoYBWxlCfzyPBOaIC0AQHMQyQQgEgFIAAqOacOQdAnGsjAlgFCEIhCMAohRmLIUcIxqqqMNzfj/z69eS7BXDggD17aEhsGhubXJtO2+1TU0wXQqBQ4JBneciTbhDYlvDHabpDNGOBBQPfECJ/BJEoBQFBVZVmx2J698svW/ta55Htq1bqmW8F4OBBgcFB8/6jxyZ3nh3JpTjncOmFrhPYtigZQWAFAEjOyzvOSr/xROIcjMm5OLJZohOCjnSadoyNJbbs2pXfcN110f2dneTrA5DEnzo1uWlgYGqbaRYoY2FixTRjgs+kZCYnx9V1NFrr6xAXZJpRxAckxzHGcW50IjU+HnnLstnmgwfF9iuBuCKAL764fH86nd9m2TZVOu2TR3zxFxcPIhBIpz/F6dMfoFCYUI8jkWrMn38PWlvvcMeREPHiCjQUCgXa38e3mXk2DGD/jAHs2nVh9sBAYadl2Yp0qaOennuraRqBEDRIPjSdoK//Q/T3HQQhFIsWtYJSoK/vDE6dehuMT+KmxZ0+7cRBA6qRIiRB1BgjSlHIc0gaxi4Udu7adWHxY4/VZWYEIJ3mmzIZK8W5S22eu7oqfKMFKFiJDZhmBqf7P0QsFsELL/wOty9bpDh+4sQQfv/kX3G6/wO0fK8Duj4rID0BA1TZgLyX31NKUDC5/ywzXkilNWPTf7Rxa0UAu3d3obeXrfWJdzkviZcehNnO/XQqNHahTz1bs+YOLL1tIWzLsd4bF7Zg3boV2LHjXVy40IdUamlgHHEdg0O8dA7SyHWDBpyBQC7H1u7e3bV1/fpbrw7ANGfFLIu3h/yGu5Z0fw4IAcvKI5MZBQ+4mGx2RJ2rE9UKMOeO5KThRgxNSS97eQSRyEBgbg2zZzeC0qhSQceLEQiOEHMkTZI2qQ9XBXDxot3KWFQv9y7Ov1Vg6Os7gOHhTyCcVUqAEpw+PaK4pugXDhnHe4eUzg8PHcHQ4JGScRrmzVuOG25Yqa6DTCu6WuiSNgCnrgpgyizU63qN4p5wJ5I6SUDVfU/P3zHy1TFEoxEsW7YQiUQ04OGlRxGYM2eWYy9uHJAjU6kkVq3qKLO3yUkTR4/2Y2joYzBm4vtLfq4AS2nIC8GFAk4pxVS+UF8RQG7CTsgAFbQB3YAKWhMTo/jqzDHU1ibw0ktPIdVY59uDXMTjmmczxShN8MTGB0Lv5Ttv7KVLGfzmt88jnf4cLS13IZGoV7CLgVKAUmkHdqKiEXMhoqVBRrj+fXx8QC24auUyzEkmMZmzVeJDSRgEIeUhzgEUJt75cSQS1bj33g7s23cY4+NDSCQayiSl5qVB2q4EgNtaMOwHdZtzW93H4zFYBQ6bEUW8kIRTdxE/xymB4BLsrEF8INLApdo1pZLuO6vE7og/3swHabsCgELBJrFIOXpKi0QJL8/hACdO9knd9EZMA8Aj3BWkD0bNIc9SRTTHS8FdS6OAoMVJ5LOCaZOKAGybERINE1vqFdSiLgEKnOShtxhxCeYI6Txc6RSJF/7ZGSN8mRfVsRjs5D2TWV8lAMy2VPrrGDHx0UsdZsz2UUnvID+hIL4ud/f0obmpDo2N9dKW1Hv5UnkRQnBu9DzOnbuIJUsWSpIUAzwmeJySa8j1CRVuGu7kLxKgZVmYgQqxkP57BOdyYxgc/EjdLrxxrppcqZASN8GbfzuIPXsPoarKwEs7tiARr/a5K2NqJpvFlj/swNSUhUcfXYEHftGpQAq3XliwoAW6rmFg4DDq6xdjdm1jWaZqWawyAJ/LIVA5HDu2B7Y9hV8/vhpLO5Ygn5dsJ4o4yd3BwfMqXuTzNs6fv4T4vGpXAoCMTaPnx2GatvLng4OjSipKitxh//zr5+GPTz2E555/Q611110bQWm81MFUBiCEDUOmC9zJEOWgTz/dC9Mcx49WLcWDD67EZI6Dy0zUF71U2qK+yhdKrbxARkPyDLps35Cn8gJ3330H0mfGsHfvP/HZZ3tx552Pg2oOiZJJAjMAYFm2yke8QNbb+zay2TTa26/Hk0+uw8QEVxWU52mIKlKCxlY0csbDlVkoMXEBcnV2pDExwfCrX96HM2fGcOhQN3p63sHNN/9UzS0DmZTgDACwkPucnBxT101NKQXMtpzkjAb8vkqJAiC8Qp4zxwY8vx+0Lfme8aI79tyqaTI01Ne4acZouPS0Z2ADuq6H3OWiRT/G55+/gvfe+wgNDXPwkzV3g7kS8gOcopmEApbnYRSxtOj/PbUrfiMU9wU4dI3jwD8+wutvHEI0GseiRWtCtGm6XhmAYeihFKCmpgnt7Q+jq+s1vPrqO2hsTGLZ0jbYthKsSuA4DwY94nPfUyHKROAboZTIcdVeMOPQNIHe3hPYsWM/DMPALbc8jJqa5hBtEWMGAGIxQxUVjhE7XG2eexPy5n040fsutm17Hc/+qRYtLa1Ot4EIpVptbfPx8ccnkUwm0NRUDyltpUIgkPGzubkByWQ1xscn0LZkPryEUX4jA9bo+bN47vk9qhRdvPg+taZK5lzNlK46GjMqAyBEF87kQbZSzG1ejvFLX+Hs2S50dZ1ES0uL48cZUf2hznuW47ZbF6KmphpCGKocdMoFAWELRKMxvPjiZlzOTiCZrJMVlhNLhIBGBU6ePK30f+7cDsyd+wNVPHklpaOGEowuKgLQNO+jYufAM8Dq6pQbmd0WiWsHVkHgMmOIRJIwTclVHlIrmVZMcSbnRiRSi2yWKc5zN6JLDyPjg1yzurqpmHeUON8ibVc3YlbaryHTOHEvj5Hi58oOBGCL8vaLp/Ucbn5P/O6GfK4MWIiSzpITJEvnikR0VhmAQcyy3k1JM0q43PfzGPmEBJbysjZSnpIIhJsFwvVEIZUNFPxeLiTXMQxiVgRQVWXkpHF6xYmspqRRC191VMbq5PKuBOCZexmIkn6dCPBYwE/S5Dmbzak1NY2qxoGukWIwEs7akZiRq+yFopGxzDgPi5Q4PaBYbI66PXr0S/zs/k7ostMgvVVAx8gMGst+fSCcNMMwBI4cOe62IZNO81cgVFJKRsUTkbGKAJK1xvDEZWHLLkCxVHeOurqFiMeT6O9P489/eQUrVtyOaCRWwvpw4zAkjFIUBMjn8zh8+BP094+gpqYBdXULHCaQsB1SKuxZs4zhGRQ0g3ldb+tmDB2htaQORnS0ta1DV9ceHD/+L/T09AcM8JsdXsehqqoWbW2PqEDq+/8AKzSNdHM2mK8I4OmnV+OZZ0b2WZbo8AxLLqI6ZgWu3Nzy5ZswOtqFTGZERVEPg9RTx7BFiUGKEMFeUe+MkY2tZjQ23gpdj6qgKLPhIF8kwGiU7JO0zag32joP24eHjS1TU1bKa+6aeafdpzYy9DjmL/ih4hQJSEj2crx+qaqTXWIZD6Yq4U0Qryms2vcu4+V8qqFMnDS2Km6ca221t8+4O/3ExubM1q0XNxRM/hbnjEriyzYz5P6QzUs0noaiJ9WcMV5K4Rl5eC6h0NpWYB/KqUS84MUTcW3DExsbMl9rfyCf79rf3Lxs89mz+W22bdOyDQlR3ucv9fvTXYWtWYSau9MEVZ5qim3uuO2z/V97h+bZZzvlLs327m5tOJOxdl66NJVijE+zkMD09ZZQMaTsO4Iy+yChh45R1yarzs2qMTZcvHhkf2dn5zfbI3O3dfa/+WZhcTod25TLWWsti7WbJtNlFqpZziafF69kAArut2huMApuTwW/8SK+EaGIyg52VLMjhtadSBj7mpvp9kceiXy7TT7veOghNdHW998XWxtSIpbNoHUih/rJHGSvMso5NMZAdANEVmxeWSmDlPzJ2oHS4s6l3GaVfSxpRpoOM1aFXDyOsXgcw1+eIN/9Nqt3rF6tJs67HeJT13bqrwH4PwDwbwJjg43iwEFOAAAAAElFTkSuQmCC',
      'raccoon': 'data:image/png;base64,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',
      'zcode': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAgklEQVR42u3XsRGAIAyF4UxgYe0g7j+FpZtgRwN36stLAhruqP+v4ICIdNaybsViy92yCj+CeMW7CO94gwgFRMUrIgFTAPbzgPe/Aa5nAInTAGicAtDE1QBtXAVgxGEAeuIpAFYYArDj81xEoQDLd+A1ID8k3wTkXDDEaDbEcBo1nl/XXoK4yMqvMgAAAABJRU5ErkJggg==',
    }

    /** The plugin's own brand mark (user-supplied artwork, 128px JPEG). */
    const BRAND_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAUOSURBVFhHpZdZqJZVFIafMqibsIuiSb2zESyyMipQL5o1Ky+aMSKo1AopM9KIsnmwSStCKaig0agMtTI1U7MZm0caKctsFG2O5+fdh83XOf1/fws+zn/2t/faa3jXu9YHncmmwG7AWcDDwHvAz8CPwGfA18Ay4AFgIrBrzvxv2QQYBtwOfAqsB74Fvge+AK4DzgMuz+V/AH9l7205q46uZHvgmlz4HfAQcBNwcy4+HjgcOArYERgBjANmAc/GkG+Aq6PrP8k+lRJDe0iisA74HfgFeDQe7gvcAEwDzgVmAnOAJ4DfKh3q7EhGJsce/Ao4Oop/zVr96KH5b677LAfuz3vx8m6i9K+ilW7cmEPvAM/HY5XqvflfEwC69ifwOvBJL0a8CkxJWtSpY3s3Ly1ingyVis3z9cD8hkKNei5hngBMAp5OJdwI3Bsj6zOCcUbO+v9SYLvm5SJVsLjhS+AC4I5EwzXD/z7wFPAYsBhYAVwLDAHOBN4EzgBuScQ+zlnX58X7tVm7qlkdgsl8epF581AJ7yvAxcBJwJikSdTvBJyaEBu9UcDC6FqS329UkXghleNfDekBpYQhwr3sceDF6tBHCbFG6PWtIZq9Kg/6A1vn98nAicCxwEvAZRU36Nz5wDHAT0lNi6xkOHP4DHBPI38CZwFwZPLWjt22AA4ABgZPRq0Gp2VpiYot13fxkPTqS0Hky7LZPIoLQ3oKsH8HBij9gM2ia3RAKwBLJOQS320AxntAChW55ueiygA3adyTCenmzZvaiBVinj0vJxj2EoXZqbYH3SjjacSBwBXZ9EHQLBgPamruUGTIQblc7EjpJbLyglF5240y1aVBtmB00+o0G1Hu+jZN7R2IIN09RHZ2xQNzo9eqMwotAEq1NhajYI7cKFD2AC4Etmxq71BOT+MS/erUWdNyRJz9wU1aYTM5NFwt1brZchOYArAb2SoNSifkhWKAqTkYmAx87kbBYbhtpTKdGzVChK4K4XTT07dN+qRsL7KvqFtndwCmp9m1KNILpd7C474QOPL2gFjdjViGAllAm2p1m1I7rvOF+lsjlgi9M2zoJgcQ61cO9/JzmprbiIQkK1qC9on7qvJ2gjKt8oLrrVyL0FKbbjISpkZ2lAWNjgTj004kIbHkJfuls9Yd0hI0uv7WuNYAKS0+AtxVTTE+H4ZO5QrzKc22IySNdO/YONAcZHRUmrZb7uyB0owM+2FBbrFYYy7JYKFCgXpcLpIbSnl6qYOG0VSXufWMjay0ZR8vdlTztzNFD7jNsy3SDScAr1WH/K2iRQmpeXVGFJwCSqMGx2v12LKNmobXel5Oq9e5wgc9Ug8kjlsOHwKwzAV6IYVaQnrp+mnAnllbmXbtsKKxpq6k0nHNKpCMZD/XruyttB0qDJ0bBKVjlD27zp9K7w6QrG2HDmlWzjCkRrBQbnl0RCAKPN/1OpIVMY+OYaVhaLW5rBWWiLxV/S+lyh3iqOBH8Elk8owfNOqUjIY2L22KJeRGrTVXdko7WtMIH9+XsNaPl1vvAlfDXNOx4c3L+hIjYTg9aNhFrvOBYbZxTU2KBJIDix8pXqr3NjN5w95SdBj2PsfxvkRMCMzioVxgWkS9URL1fpbZRR1mNEiw+UizpsPKcgLuM+ftpHycCkY/ODVECjUtfpAaZtutzcx+IqWbb4nNM5blP9DejUhWMqYl6OWG1sjYYKRvaVuw2Vfc47DZyfzI37iV37V7h+RzAAAAAElFTkSuQmCC'

    /**
     * The thirteen account channels enabled by OFM. Identity is static (it is
     * the product, not a reading), so the grid renders instantly and only the
     * *state* comes from the pack over RPC. `accent` drives each card's stripe
     * and logo tile; `login` picks the flow the card offers.
     */
    const CHANNEL_PROVIDERS = [
      { id: 'codearts', name: 'CodeArts', org: '华为云', accent: '#C7000B', note: 'DeepSeek · GLM · openPangu，每日免费额度', login: 'browser' },
      { id: 'buddy', name: 'WorkBuddy 国内版', org: '腾讯 · copilot.tencent.com', accent: '#0A7AFF', note: 'CodeBuddy 同一端点：DeepSeek · Kimi · GLM 免费线，每日积分', login: 'browser' },
      { id: 'workbuddy', name: 'WorkBuddy 国际版', org: '腾讯 · workbuddy.ai', accent: '#0B63CE', note: '国际版端点：独立账号与积分体系', login: 'browser' },
      { id: 'lobsterai', name: 'LobsterAI', org: '有道', accent: '#FF6A00', note: '龙虾 · 每日签到积分', login: 'browser' },
      { id: 'qoder', name: 'Qoder', org: '阿里系', accent: '#615CED', note: '每日 100 Credits，加密推理端点', login: 'browser' },
      { id: 'qodercn', name: 'Qoder 中国版', org: '阿里系', accent: '#7A6CF0', note: '中国版端点与模型池', login: 'browser' },
      { id: 'trae', name: 'TRAE', org: '字节', accent: '#00BFA6', note: '手机号登录', login: 'browser' },
      { id: 'cline', name: 'Cline', org: 'Cline', accent: '#5B5BD6', note: 'Cline 账号免费额度', login: 'browser' },
      { id: 'loomy', name: 'Loomy', org: '讯飞', accent: '#2F6BFF', note: '微信扫码，或短信验证码备用', login: 'browser+sms' },
      { id: 'raccoon', name: 'Raccoon', org: '商汤', accent: '#00A6A6', note: '手机号登录', login: 'browser' },
      { id: 'minimax', name: 'MiniMax Code', org: 'MiniMax', accent: '#E4007F', note: '设备码 + PKCE，每日签到', login: 'browser' },
      { id: 'zcode', name: 'ZCode', org: '智谱', accent: '#3B6EF6', note: '浏览器登录（需本机可开浏览器）', login: 'browser' },
      { id: 'gemini', name: 'Gemini', org: 'Google Code Assist', accent: '#4285F4', note: '本地回调 OAuth 免费线', login: 'browser' },
      // 本插件自己实现的渠道（渠道包不认识）：账号由本插件登录、自己存。
      // `own: true` 让卡片走 `/channels/own/*` 那套路由，而不是渠道包 RPC。
      { id: 'codely', name: 'Codely', org: 'Unity 团结引擎', accent: '#000000', note: '设备码登录，每日签到', login: 'device', own: true },
      { id: 'autoclaw', name: 'AutoClaw', org: '智谱 · autoclaw', accent: '#3B6EF6', note: '手机验证码登录，每日签到', login: 'sms', own: true },
      { id: 'autoclawintl', name: 'AutoClaw 国际版', org: '智谱 · autoglm.ai', accent: '#2C5FD8', note: '国际站独立账号体系', login: 'sms', own: true },
      { id: 'accio', name: 'Accio', org: '阿里 · accio.com', accent: '#FF6A00', note: '浏览器授权（PKCE），无签到端点', login: 'browser', own: true },
      // MiniMax 国际版与渠道包里的 `minimax`（国内站）是**两套账号体系**：
      // 独立主机（minimax.io）、独立凭据、独立签到，故占一个自己的 id。
      { id: 'minimaxintl', name: 'MiniMax 国际版', org: 'MiniMax · minimax.io', accent: '#E4007F', note: '设备码 + PKCE，每日签到', login: 'device', own: true },
      // Marvis 走**隔离浏览器 + 回调拦截**：宿主自己起 Chromium，面板不再另开窗口。
      { id: 'marvis', name: '腾讯 Marvis', org: '腾讯 · 3g.qq.com', accent: '#00A4FF', note: '浏览器登录（QQ / 微信），令牌额度每日发放', login: 'device', own: true },
      // 超级麦吉 / MagiCrew：网页登录后在页面里读 JWT，再签 `mgw_` 网关密钥。
      { id: 'magicrew', name: '超级麦吉', org: 'Magicrew · letsmagic.cn', accent: '#7C4DFF', note: '浏览器登录（手机号 / 短信），每日登录积分', login: 'device', own: true },
      { id: 'magicrewintl', name: 'MagiCrew 国际版', org: 'Magicrew · magicrew.ai', accent: '#5E35B1', note: '浏览器登录（邮箱 / OAuth），每日登录积分', login: 'device', own: true },
      // MonkeyCode：会话是 HttpOnly cookie，只能由宿主起的浏览器读；签到还要过人机验证。
      { id: 'monkeycode', name: 'MonkeyCode', org: 'MonkeyCode · monkeycode-ai.com', accent: '#0EA5E9', note: '浏览器登录（网页会话），每日签到', login: 'device', own: true },
      { id: 'monkeycodeintl', name: 'MonkeyCode 国际版', org: 'MonkeyCode · monkeycode-ai.net', accent: '#0284C7', note: '浏览器登录（网页会话），每日签到', login: 'device', own: true },
      // 百智云：控制台 cookie 换 `sk-` Key；每日临时积分要过人机验证。
      { id: 'baizhi', name: '百智云', org: 'baizhi.cloud', accent: '#10B981', note: '浏览器登录（控制台），每日领 100 积分', login: 'device', own: true },
      // OfficeAce：PKCE + DPoP，回调在上游主机（由宿主浏览器截停）。
      { id: 'officeace', name: 'OfficeAce', org: '华为云 AgentArts', accent: '#C7000B', note: '浏览器登录（OAuth + DPoP），无签到', login: 'device', own: true },
      // 豆包：登录是页面内的二维码模态框；签到要页面里的 `bdms` 签名 ⇒ 浏览器由宿主起。
      { id: 'doubao', name: '豆包', org: '字节跳动 · doubao.com', accent: '#3370FF', note: '浏览器登录（页面扫码），每日签到 + 活动额度', login: 'device', own: true },
      // AStudio：微信扫码（SSO 三段，无需浏览器），凭据是四字段 Cookie，推理走 Responses 线。
      { id: 'astudio', name: 'AStudio', org: '讯飞 · AstronStudio', accent: '#1F6FEB', note: '微信扫码登录，每日登录积分（推理走 Responses）', login: 'device', own: true },
      // AgnesCode：登录只存在于桌面客户端（Chromium v10 + DPAPI）⇒「添加账号」=
      // 读一次客户端会话；目录按订阅档下发，没有静态兜底。
      { id: 'agnescode', name: 'AgnesCode', org: 'Agnes AI · 桌面客户端', accent: '#6E56CF', note: '读取客户端登录态（免二次登录），目录按订阅档下发', login: 'import', own: true, noCredits: true },
      { id: 'agnescodeintl', name: 'AgnesCode 国际版', org: 'Agnes AI · 国际站', accent: '#8B5CF6', note: '读取国际版客户端登录态，目录按订阅档下发', login: 'import', own: true, noCredits: true },
    ]

    /**
     * 走「宿主起浏览器」那条腿的渠道（CDP 会话）。
     *
     * ⚠️ **起点与轮询必须读同一份集合**：上一版是两处手写数组，起点那份有百智云/
     * MonkeyCode/OfficeAce、轮询那份没有 ⇒ 浏览器起来了，面板却一直在问设备码端点
     * （`/channels/own/login/poll`），表现为「扫完码一直转圈」。
     */
    const BROWSER_CDP = new Set(['marvis', 'magicrew', 'magicrewintl', 'monkeycode', 'monkeycodeintl', 'baizhi', 'officeace', 'doubao'])

    /**
     * 每个渠道的积分能力，逐条对准渠道包 RPC 的真实分支
     * （`credits.balances` / `credits.status` / `credits.claimAll`）：
     *
     * - `unit` 决定数字怎么读：积分、Token、美元、配额百分比。**不能混写**
     *   ——`zcode` 领的是 token、`cline` 是美元、`gemini` 是百分比，把它们统称
     *   「积分」是把三种量纲加在一起（旧版就是这样，ZCode 的 200000 token 会
     *   显示成 `200000 积分`）。
     * - `claim` 只有 `credits.claimAll` 真支持的渠道才置位（pack 里对
     *   `cline` / `workbuddy` / `raccoon` 明确回「不支持每日签到」，故不给按钮）。
     * - `status` 只有 `credits.status` 会返回真正签到状态的渠道才置位。
     */
    const CHANNEL_CREDITS = {
      codearts: { claim: true, unit: 'credit' },
      buddy: { claim: true, status: true, unit: 'credit' },
      workbuddy: { unit: 'credit' },
      lobsterai: { claim: true, unit: 'credit' },
      qoder: { claim: true, unit: 'credit' },
      qodercn: { claim: true, unit: 'credit' },
      trae: { claim: true, unit: 'credit' },
      cline: { unit: 'dollars' },
      loomy: { claim: true, unit: 'credit' },
      raccoon: { unit: 'credit' },
      minimax: { claim: true, status: true, unit: 'credit' },
      // 自有渠道（本插件自己的签到腿，走 `/channels/extra`）
      minimaxintl: { claim: true, status: true, unit: 'credit' },
      // Marvis 没有签到端点：只显示令牌余额，不给领取按钮。
      marvis: { unit: 'token' },
      // 超级麦吉 / MagiCrew：每日登录积分（+200 / +50），走自有签到腿。
      magicrew: { claim: true, unit: 'point' },
      magicrewintl: { claim: true, unit: 'point' },
      // MonkeyCode：签到过人机验证，奖励按「签到前后余额差」实测。
      monkeycode: { claim: true, unit: 'credit' },
      monkeycodeintl: { claim: true, unit: 'credit' },
      baizhi: { claim: true, unit: 'credit' },
      officeace: { unit: 'credit' },
      // ⚠️ 豆包**刻意不在这张表里**：它的额度读数走本插件自己的 `/channels/extra`
      //（活动折叠里的「积分 x / y」+ 每日签到入口）。渠道包的 `credits.balances`
      // 不认识这个 provider（回 `unsupported provider: doubao`），挂上去只会在
      // 卡片上留一行红字，而那一行读不到任何真数字。
      zcode: { claim: true, unit: 'tokens' },
      gemini: { unit: 'quota', quota: true },
    }

    /**
     * 自有渠道里**真的有签到/领取端点**的那些。
     *
     * 以前用 `CHANNEL_EXTRAS` 当判据，于是 Marvis / OfficeAce / Accio 也渲染
     * 「一键领取」，点了只回「没有签到接口」。这三个不该出现在领取入口里。
     */
    const OWN_CLAIMABLE = new Set([
      'codely', 'autoclaw', 'autoclawintl', 'minimaxintl',
      'magicrew', 'magicrewintl', 'monkeycode', 'monkeycodeintl',
      'baizhi', 'astudio', 'doubao',
    ])

    /**
     * 新手任务 / 一次性奖励：
     * - `pack`：渠道包的 `onboarding.status` / `onboarding.claim`（loomy / raccoon）；
     * - `own`：本插件自己的 `/channels/extra`（超级麦吉的 8 项新人任务；
     *   任务状态随 `statusOf` 的 `tasks` 一起回来，领取走 `campaignId=task:<code>`）。
     */
    const CHANNEL_TASKS = { loomy: 'pack', raccoon: 'pack', magicrew: 'own', magicrewintl: 'own' }

    /** 「锁定永久积分」（`credits.permanentLock`）：三家支持，语义相同、判据不同。 */
    const CHANNEL_LOCK = new Set(['buddy', 'workbuddy', 'loomy'])

    /** 订阅额度窗口（`cline.quota`）：只有 Cline 有。 */
    const CHANNEL_SUBSCRIPTION = new Set(['cline'])

    /**
     * 本插件**自己实现**的权益扩展（`src/channels/*`，走本插件 HTTP 路由而不是
     * 渠道包 RPC）：余额明细、运营活动列表与领取、模型倍率。
     *
     * 与渠道包的关系：账号池与凭据都来自宿主，两边读同一份；渠道包没有出口的
     * 那几项在这里补。加一个渠道 = `src/channels/index.js` 注册一行 + 这里加一个 id。
     */
    const CHANNEL_EXTRAS = new Set(['codearts', 'qoder', 'qodercn', 'codely', 'autoclaw', 'autoclawintl', 'accio', 'minimaxintl', 'marvis', 'magicrew', 'magicrewintl', 'monkeycode', 'monkeycodeintl', 'baizhi', 'officeace', 'doubao', 'astudio', 'agnescode', 'agnescodeintl'])

    /**
     * 一个数按它的量纲写出来。
     *
     * 旧版统一走 `kilo()`（`Math.round`）——Cline 的 `$0.42` 会显示成 `0`、
     * `$12.50` 变成 `13`，免费额度的 `0.5` 积分直接变 `1`。美元固定两位，
     * 其余保留一位小数而不是抹平。
     */
    function amountText(value, unit) {
      // `Number(null) === 0`：不过这一关，未知余额会被画成「0」——
      // 在积分场景里 0 是「已用光」的语义，不能拿它表示未知。
      if (value === undefined || value === null || value === '') return '—'
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      if (unit === 'dollars') return `$${n.toFixed(2)}`
      if (unit === 'quota') return `${Math.round(n)}%`
      const abs = Math.abs(n)
      if (abs > 0 && abs < 1) return String(Number(n.toFixed(2)))
      if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`
      if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`
      const rounded = Math.round(n * 10) / 10
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
    }

    /** 量纲的显示名（`unit` 缺省按积分）。 */
    function unitLabel(unit, t) {
      const key = unit === 'tokens' ? 'chan.unit.tokens' : unit === 'dollars' ? 'chan.unit.dollars' : unit === 'quota' ? 'chan.unit.quota' : 'chan.unit.credit'
      return t(key)
    }

    /**
     * 领取结果的金额部分。
     *
     * `credits.claimAll` 的 `summary` 里除 `totalCredit` 外还有 `totalByUnit`
     * （`{credit, token}`）——同一次领取可能既有积分又有 Token（例如 ZCode 的
     * 每日 token 包）。按单位分别写出来，才是那份数据本来的意思。
     */
    function claimAmountText(summary, fallbackUnit, t) {
      const byUnit = summary?.totalByUnit
      const parts = []
      if (byUnit !== undefined && byUnit !== null) {
        const credit = Number(byUnit.credit)
        const token = Number(byUnit.token)
        if (Number.isFinite(credit) && credit > 0) parts.push(`+${amountText(credit, 'credit')} ${t('chan.unit.credit')}`)
        if (Number.isFinite(token) && token > 0) parts.push(`+${amountText(token, 'tokens')} ${t('chan.unit.tokens')}`)
      }
      if (parts.length === 0) {
        const total = Number(summary?.totalCredit)
        if (Number.isFinite(total) && total > 0) parts.push(`+${amountText(total, fallbackUnit)} ${unitLabel(fallbackUnit, t)}`)
      }
      return parts.join(' · ')
    }

    /**
     * The host RPC the pack registered at `/api/channel-pack`.
     *
     * The pack's own browser half used the shell's connection service; this page
     * does the same instead of proxying through our JSON API, so channel traffic
     * keeps the connection's admission and the credential store stays the only
     * place a token exists. `connection` is read opportunistically: a shell that
     * does not offer it still renders the free and EAC pages, with this one
     * explaining itself instead of breaking.
     */
    function useChannelRpc(ctx) {
      return useMemo(() => {
        let connection
        try { connection = ctx?.connection } catch { connection = undefined }
        if (connection === undefined && typeof ctx?.get === 'function') {
          try { connection = ctx.get('connection') } catch { connection = undefined }
        }
        const rpc = async (method, payload, timeoutMs = 60_000) => {
          if (connection?.rpc?.call === undefined) throw new Error('no-connection')
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          try {
            const result = await connection.rpc.call('/api', 'channel-pack', { method, payload }, controller.signal)
            if (result?.ok === true) return result.value
            if (result?.ok === false) throw new Error(result.error?.message ?? result.error?.code ?? 'rpc-failed')
            return result
          } finally { clearTimeout(timer) }
        }
        return { available: connection?.rpc?.call !== undefined, rpc }
      }, [ctx])
    }

    /** Human text for a millisecond timestamp, or the long-lived marker. */
    function expiryText(entry, t) {
      if (!Number.isFinite(entry?.expiresAt) || entry.expiresAt <= 0) return t('chan.expires.never')
      return ago(entry.expiresAt, t.locale)
    }

    function ChannelCard(props) {
      const { channel, status, rpc, t, onError, onChanged } = props
      const [open, setOpen] = useState(null)
      const [accounts, setAccounts] = useState(undefined)
      const [models, setModels] = useState(undefined)
      // 目录来源：`live` = 已取到最新列表；`preset` = 正在显示预制表。
      const [modelMeta, setModelMeta] = useState(undefined)
      const [credits, setCredits] = useState(undefined)
      // 实时积分：每个账号的剩余余额（credits.balances），卡片汇总 + 账号行
      // 逐条展示；随账号列表与领积分动作刷新，另有一个慢轮询兜底。
      const [balances, setBalances] = useState(undefined)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [login, setLogin] = useState(null)
      // 短信验证码渠道要用户先填手机号（设备码渠道不需要）。
      const [smsPhone, setSmsPhone] = useState('')
      const [smsCode, setSmsCode] = useState('')
      const modelBatchPending = useRef(false)
      const [balanceError, setBalanceError] = useState('')
      const [balanceLoading, setBalanceLoading] = useState(false)
      // 新手任务 / 一次性奖励：`onboarding.status` 是**只读**的（pack 明确要求
      // 面板挂载时不得触发 claim），故只在展开「任务」折叠时查询。
      const [tasks, setTasks] = useState({})
      const [tasksLoading, setTasksLoading] = useState(false)
      // 锁定永久积分（buddy / workbuddy / loomy）：`{locked, windowDays?}`。
      const [lock, setLock] = useState(undefined)
      // Cline 的订阅额度窗口：`{accountId, ok, windows[], error?}[]`。
      const [subscription, setSubscription] = useState(undefined)
      // 权益扩展（CodeArts 的活动/倍率）：来自本插件自己的
      // `/api/our-free-model/channels/extra`，不是渠道包 RPC。
      const [extra, setExtra] = useState(undefined)
      const [extraLoading, setExtraLoading] = useState(false)
      const [extraNotice, setExtraNotice] = useState('')
      const balancePending = useRef(null)
      const balanceGeneration = useRef(0)
      const balanceFetchedAt = useRef(0)
      const claimPending = useRef(false)
      /**
       * 这个渠道的「积分读数」从哪来。
       *
       * ⚠️ 渠道包的 `credits.balances` / `credits.claimAll` **只认识它自己那 13 家**：
       * 对自有渠道它会回 `unsupported provider: xxx`，以前这行红字会直接画在没有账号的
       * 卡片上（「都没登账号还提示余额查询失败」）。所以自有渠道改走本插件自己的
       * `/channels/extra`，渠道包那套原样留给 pack 渠道（qoder/qodercn 虽然也在
       * `CHANNEL_EXTRAS` 里，但它们**是** pack 渠道，必须继续走 RPC）。
       */
      const ownCredited = channel.own === true && CHANNEL_EXTRAS.has(channel.id)
      const creditCapability = CHANNEL_CREDITS[channel.id]
      // 自有渠道没有 `CHANNEL_CREDITS` 条目时，用 extras 回报的单位（marvis 是 token）。
      const creditUnit = creditCapability?.unit ?? 'credit'
      // AgnesCode 没有余额/用量端点：整列隐藏，而不是给一个「未返回余额数据」的红字。
      const showCredits = (creditCapability !== undefined || ownCredited) && channel.noCredits !== true
      const balanceLabel = creditUnit === 'tokens' ? t('chan.credits.tokens')
        : creditUnit === 'dollars' ? t('chan.credits.dollars')
          : creditCapability?.quota ? t('chan.credits.quota') : t('chan.credits.left')

      const accountsCount = status?.accounts?.total ?? 0
      const enabledCount = status?.accounts?.enabled ?? 0
      const modelsTotal = status?.models?.total ?? 0
      const modelsOff = status?.models?.disabled ?? 0
      const connected = enabledCount > 0
      const chanState = status?.closed === true ? 'off' : connected ? 'on' : 'idle'
      const stateText = status?.closed === true ? t('chan.state.closed') : connected ? t('chan.state.on') : t('chan.state.off')

      const loadAccounts = useCallback(async () => {
        try {
          // 自有渠道的账号表在**本插件自己的** `channels.json` 里（渠道包的 account.list
          // 不认识这些 provider ⇒ 回空数组，于是账号折叠永远「没有账号」）。
          const value = channel.own === true
            ? await api(`/channels/own?provider=${encodeURIComponent(channel.id)}`, { timeout: 15_000 })
            : await rpc('account.list', { provider: channel.id })
          setAccounts(value?.accounts ?? [])
        } catch (error) { setAccounts([]); onError(channel, error) }
      }, [rpc, channel.id, onError, api, channel.own])
      const loadModels = useCallback(async () => {
        try {
          // 自有渠道：渠道包的 model.list 不认识这些 provider id，读自己的路由。
          // 两边读的是同一份目录；面板这份**包含被关掉的行**（否则关掉后无处点回来）。
          const value = channel.own === true
            ? await api(`/channels/own/models?provider=${encodeURIComponent(channel.id)}`, { timeout: 15_000 })
            : await rpc('model.list', { provider: channel.id })
          setModels(value?.models ?? [])
          // 渠道包没有「实时/预制」概念；自有渠道由宿主给。
          setModelMeta(channel.own === true ? (value?.catalog ?? { source: 'preset' }) : null)
        } catch (error) { setModels([]); setModelMeta(null); onError(channel, error) }
      }, [rpc, channel.id, onError])
      const loadCredits = useCallback(async () => {
        if (channel.own === true || !CHANNEL_CREDITS[channel.id]?.status) return
        try {
          const value = await rpc('credits.status', { provider: channel.id })
          setCredits(value?.accounts ?? [])
        } catch { setCredits([]) }
      }, [rpc, channel.id])
      /** `/channels/extra` 的一行 → 渠道包 `credits.balances` 的行形状（面板只认这一种）。 */
      const balanceRowOf = row => {
        // `pending` = 账号建好了但还没登录（凭据库为空）⇒ 既不是 0，也不是错误。
        if (row?.pending === true) {
          return { accountId: typeof row.accountId === 'string' ? row.accountId : '', nickname: row?.nickname ?? '', balance: null, pending: true }
        }
        const total = Number.isFinite(row?.balance?.total) ? row.balance.total
          : Number.isFinite(row?.info?.total?.remain) ? row.info.total.remain
            : undefined
        return {
          accountId: typeof row?.accountId === 'string' ? row.accountId : '',
          nickname: typeof row?.nickname === 'string' ? row.nickname : '',
          balance: Number.isFinite(total) ? { total, unit: row?.balance?.unit ?? 'credit' } : null,
          error: row?.error ?? row?.balanceError ?? row?.infoError ?? undefined,
        }
      }
      const loadBalances = useCallback((afterWrite = false) => {
        // 自有渠道没有账号时**不发任何请求**（以前会去打 pack 的 `credits.balances`，
        // 换回 `unsupported provider` 并在空卡片上画一行红字）。
        // 自有渠道读自己的 HTTP 路由，不依赖渠道包的 RPC（`rpc` 可能为 null）。
        if (!showCredits || (!ownCredited && !rpc)) return Promise.resolve()
        const pending = balancePending.current
        if (!afterWrite && pending?.provider === channel.id && pending.rpc === rpc) return pending.promise
        // 前端 TTL：渠道包对 buddy/loomy/gemini 有 60 秒缓存，但 codearts 没有，
        // 而这一页会同时给 12 个渠道各发一轮（每轮再逐账号串行请求）。没有
        // 下限的话，切回页面就会把上游打一遍 —— 那也是触发风控的形状。
        const ttlMs = channel.id === 'codearts' ? 180_000 : 60_000
        if (!afterWrite && balanceFetchedAt.current > 0 && Date.now() - balanceFetchedAt.current < ttlMs) return Promise.resolve()
        const generation = ++balanceGeneration.current
        const request = { provider: channel.id, rpc }
        balancePending.current = request
        setBalanceLoading(true); setBalanceError('')
        request.promise = (async () => {
          try {
            if (ownCredited) {
              // 自有渠道：本插件自己的权益路由（余额/额度/签到状态都在那一份里）。
              const value = await api(`/channels/extra?provider=${encodeURIComponent(channel.id)}`, { timeout: 30_000 })
              if (generation === balanceGeneration.current) {
                setExtra(value ?? undefined)
                setBalances((value?.accounts ?? []).map(balanceRowOf))
                balanceFetchedAt.current = Date.now()
                // 「没有账号」不是错误：extras 对空账号池回的是空数组。
                setBalanceError(value?.supported === false ? String(value?.reason ?? value?.error ?? '') : '')
              }
              return
            }
            const value = await rpc('credits.balances', { provider: channel.id, ...afterWrite ? { force: true } : {} }, 90_000)
            if (generation === balanceGeneration.current) {
              setBalances(value?.accounts ?? [])
              balanceFetchedAt.current = Date.now()
            }
          } catch (error) {
            if (generation === balanceGeneration.current) {
              setBalances([])
              setBalanceError(String(error?.message ?? error))
            }
          } finally {
            if (generation === balanceGeneration.current) setBalanceLoading(false)
            if (balancePending.current === request) balancePending.current = null
          }
        })()
        return request.promise
      }, [rpc, channel.id, ownCredited, showCredits, api])

      /**
       * 新手任务状态（`onboarding.status`，**只读**）。
       *
       * pack 的这个端点是按账号查询的（`{provider, accountId}`），故逐账号拉。
       * 它明确要求面板挂载时不得触发 claim —— 这里只在展开折叠时调用。
       */
      const loadTasks = useCallback(async () => {
        const kind = CHANNEL_TASKS[channel.id]
        if (kind === undefined) return
        // `own` 的任务状态随 `/channels/extra` 一起回来，不需要渠道包 RPC。
        if (kind === 'pack' && !rpc) return
        setTasksLoading(true)
        try {
          if (kind === 'own') {
            const value = await api(`/channels/extra?provider=${encodeURIComponent(channel.id)}`, { timeout: 30_000 })
            const out = {}
            for (const row of Array.isArray(value?.accounts) ? value.accounts : []) {
              const list = Array.isArray(row.tasks) ? row.tasks : []
              const map = {}
              const titles = {}
              const points = {}
              let earned = 0
              let total = 0
              for (const task of list) {
                const code = String(task?.code ?? '')
                if (code === '') continue
                // 上游两个判据是**独立**字段：实测存在 COMPLETED 但 reward_status
                // 为空的样本 ⇒ 任一成立都算完成。
                const done = task?.status === 'COMPLETED' || task?.rewardStatus === 'GRANTED'
                const point = Number(task?.points) || 0
                map[code] = done
                titles[code] = typeof task?.title === 'string' && task.title !== '' ? task.title : code
                points[code] = point
                total += point
                if (done) earned += point
              }
              out[row?.accountId ?? ''] = { tasks: map, titles, points, earned, total }
            }
            setTasks(out)
            return
          }
          const list = accounts ?? await rpc('account.list', { provider: channel.id }).then(value => value?.accounts ?? [])
          const out = {}
          for (const row of list) {
            try {
              const value = await rpc('onboarding.status', { provider: channel.id, accountId: row.id })
              out[row.id] = value ?? null
            } catch (error) {
              out[row.id] = { error: String(error?.message ?? error) }
            }
          }
          setTasks(out)
        } catch (error) {
          setTasks({ '': { error: String(error?.message ?? error) } })
        } finally {
          setTasksLoading(false)
        }
      }, [rpc, channel.id, accounts, api])

      /** 锁定永久积分：省略 `locked` 即只读，给出布尔值才写入。 */
      const loadLock = useCallback(async () => {
        if (!CHANNEL_LOCK.has(channel.id) || !rpc) return
        try {
          const value = await rpc('credits.permanentLock', { provider: channel.id }, 30_000)
          setLock(value ?? null)
        } catch { setLock(null) }
      }, [rpc, channel.id])

      /** Cline 订阅额度窗口（`cline.quota`），与「余额」是三份不同读数。 */
      const loadSubscription = useCallback(async () => {
        if (!CHANNEL_SUBSCRIPTION.has(channel.id) || !rpc) return
        try {
          const value = await rpc('cline.quota', { provider: channel.id }, 90_000)
          setSubscription(value?.accounts ?? [])
        } catch (error) {
          setSubscription([{ accountId: '', ok: false, windows: [], error: String(error?.message ?? error) }])
        }
      }, [rpc, channel.id])

      /**
       * 权益扩展：本插件自己的路由（余额明细 / 活动 / 倍率）。
       *
       * 30 秒超时：CodeArts 一次要打三个签名端点，8 秒兜底会把正常的慢请求
       * 判成失败，而失败在这个面板上会被读成「没有活动」。
       */
      const loadExtra = useCallback(async () => {
        if (!CHANNEL_EXTRAS.has(channel.id)) return
        setExtraLoading(true)
        try {
          setExtra(await api(`/channels/extra?provider=${encodeURIComponent(channel.id)}`, { timeout: 30_000 }))
        } catch (error) {
          setExtra({ accounts: [], supported: false, error: String(error?.message ?? error) })
        } finally {
          setExtraLoading(false)
        }
      }, [channel.id])

      // 只按**渠道身份**重置：依赖里放 loader 的 useCallback 会把它变成
      // 「任何一次重渲染都可能清空任务/订阅状态」——这是真实踩到的坑（展开
      // 任务折叠后刚拿到的状态被这里的 setTasks({}) 当场抹掉）。
      useEffect(() => {
        setBalances(undefined); setBalanceError(''); balanceFetchedAt.current = 0
        // `models` 不在这里清：卡片按 channel.id 挂载，换渠道本来就是新实例；
        // 清它会在「点击模型折叠 → 数据落地」之间与 loadModels 抢时序（替身
        // 渲染里表现为刚拿到的 2 条又被清成 skeleton）。
        setTasks({}); setSubscription(undefined); setLock(undefined)
        setExtra(undefined); setExtraNotice('')
        return () => { balanceGeneration.current++; balancePending.current = null }
      }, [channel.id])
      useEffect(() => {
        void loadBalances()
        void loadLock()
      }, [loadBalances, loadLock])
      // A slow heartbeat keeps the numbers honest while the page sits open:
      // balances move whenever a model is used elsewhere, and a stale credit
      // count reads as "I have more quota than I do". 后台标签页里不发请求：
      // 这一页一次就是十几个渠道的串联请求。
      useEffect(() => {
        if (!CHANNEL_CREDITS[channel.id] && !(channel.own === true && CHANNEL_EXTRAS.has(channel.id))) return undefined
        const period = channel.id === 'codearts' ? 180_000 : 60_000
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          void loadBalances()
        }, period)
        return () => clearInterval(timer)
      }, [channel.id, loadBalances])
      const balanceOf = accountId => {
        const row = (balances ?? []).find(entry => entry.accountId === accountId)
        return row?.balance === null || row?.balance === undefined ? null : row.balance
      }
      const balancesTotal = (balances ?? []).reduce((sum, row) => sum + (Number.isFinite(row.balance?.total) ? row.balance.total : 0), 0)
      const balancesKnown = (balances ?? []).some(row => Number.isFinite(row.balance?.total))
      const balanceFailures = (balances ?? []).filter(row => row.error || !Number.isFinite(row.balance?.total)).length
      /**
       * 目录提示：`live` = 已用上游最新列表；`preset` = 正在显示预制表（附原因）。
       * 用户要求「取到最新就换最新，否则在模型列表旁提示」——这就是那句提示。
       */
      const catalogHint = modelMeta === undefined || modelMeta === null
        ? ''
        : modelMeta.source === 'live'
          ? t('chan.catalog.liveHint').replace('{time}', modelMeta.at > 0 ? new Date(modelMeta.at).toLocaleString(t.locale) : '—')
          : (modelMeta.error ?? modelMeta.note ?? t('chan.catalog.presetHint'))

      // Refetch what is on screen whenever the pack reports a change for this
      // channel: an account added in another tab, a completed background login,
      // a claim that moved the numbers.
      useEffect(() => {
        const onEvent = () => {
          if (open === 'accounts') { void loadAccounts(); void loadCredits() }
          if (open === 'models') void loadModels()
          if (open === 'tasks') void loadTasks()
          if (open === 'subscription') void loadSubscription()
          if (open === 'extra') void loadExtra()
          void loadBalances()
        }
        window.addEventListener('ofm:channels', onEvent)
        return () => window.removeEventListener('ofm:channels', onEvent)
      }, [open, loadAccounts, loadModels, loadCredits, loadBalances, loadTasks, loadSubscription, loadExtra])

      const toggle = async fold => {
        if (open === fold) { setOpen(null); return }
        setOpen(fold)
        if (fold === 'accounts') { setAccounts(undefined); await loadAccounts(); void loadCredits(); void loadBalances() }
        if (fold === 'models') { setModels(undefined); await loadModels() }
        if (fold === 'tasks') { await loadAccounts(); await loadTasks() }
        if (fold === 'subscription') { await loadSubscription() }
        if (fold === 'extra') { await loadExtra() }
      }

      // The pack's login is two-phase: `account.create` returns the URL to open
      // *immediately* (a popup opened after a 30-second await is blocked), then
      // the browser flow finishes in the background and `login.poll` sees the
      // credential appear. The placeholder account is real from the first
      // moment, so the card can poll against it.
      const startLogin = async () => {
        setBusy('add'); setNotice('')
        try {
          // 渠道包认识的渠道走 `account.create`（它回 `loginUrl`）；
          // 本插件自己实现的渠道走自己的路由，回的是**用户码 + 验证地址**。
          // ⚠️ 必须同时判 own：CHANNEL_EXTRAS 里有 qoder/qodercn（那是为了
          // 倍率折叠加的），但它们的登录在**渠道包**里 —— 只判 CHANNEL_EXTRAS
          // 会把 Qoder 的「添加账号」路由到只认识 Codely 的设备码端点，登录整个
          // 坏掉（用户 2026-11-24 报障「qoder 还不能登录了，咋还退化了」）。
          if (channel.login === 'import') {
            // AgnesCode：没有登录端点，服务端读客户端加密会话并落凭据。
            const value = await post('/channels/own/import', { provider: channel.id }, 60_000)
            if (value?.error !== undefined) throw new Error(value.error)
            setNotice(t('chan.login.done').replace('{login}', value?.nickname !== undefined && value.nickname !== '' ? value.nickname : channel.name))
            onChanged()
            void loadExtra()
            void loadAccounts()
            void loadBalances()
            // 目录是**异步重编**的（导入 → 写凭据 → 拉 /models → 喂运行时），
            // 立即回读只会拿到空目录；1.5 秒后再补一次，卡片才会出现「模型 9/9」。
            setTimeout(() => {
              void loadAccounts()
              void loadBalances()
              void loadExtra()
            }, 1500)
            return
          }
          if (CHANNEL_EXTRAS.has(channel.id) && channel.own === true) {
            // 短信验证码渠道（AutoClaw）：先发码，用户在弹窗里填码，再登录。
            // 与设备码不同，这里没有「等浏览器授权」那一段，所以是单步的。
            if (channel.login === 'sms') {
              // 短信渠道先要手机号：弹窗第一步让用户填，提交时才真发码。
              // （设备码渠道不需要，它是「点一下 → 拿码去浏览器确认」。）
              setLogin({ own: true, sms: true, stage: 'phone', phone: '', accountId: '', url: '', startedAt: Date.now() })
              return
            }
            // Accio 是浏览器 PKCE：起点是 oauth/start（它回授权地址），
            // 不是设备码的 login/start（那条回的是用户码）。
            // Marvis 是 CDP 拦截回调：起点 browser/start，浏览器由**宿主**起，
            // 这里不能再 window.open（会多开一个没有调试端口的窗口）。
            const isBrowserCdp = BROWSER_CDP.has(channel.id)
            const started = await post(
              channel.id === 'accio'
                ? '/channels/own/oauth/start'
                : isBrowserCdp
                  ? '/channels/own/browser/start'
                  : '/channels/own/login/start',
              isBrowserCdp ? { provider: channel.id, loginType: '1' } : { provider: channel.id },
              60_000,
            )
            const accountId = started?.accountId
            if (typeof accountId !== 'string' || accountId === '') throw new Error('bad-answer')
            const url = typeof started?.verificationUriComplete === 'string' && started.verificationUriComplete !== ''
              ? started.verificationUriComplete
              : String(started?.verificationUri ?? started?.loginUrl ?? '')
            if (url !== '' && !isBrowserCdp) {
              try { window.open(url, '_blank', 'noopener') } catch { /* the modal offers the link too */ }
            }
            setLogin({
              accountId,
              url,
              code: typeof started?.userCode === 'string' ? started.userCode : '',
              qr: started?.qr === true,
              startedAt: Date.now(),
              own: true,
            })
            setOpen('accounts')
            return
          }
          const value = await rpc('account.create', { provider: channel.id }, 90_000)
          const accountId = value?.accountId
          const url = value?.loginUrl
          if (typeof accountId !== 'string' || accountId === '') throw new Error('bad-answer')
          if (typeof url === 'string' && url !== '') {
            try { window.open(url, '_blank', 'noopener') } catch { /* the modal offers the link too */ }
          }
          setLogin({ accountId, url: typeof url === 'string' ? url : '', startedAt: Date.now() })
          setOpen('accounts')
        } catch (error) { onError(channel, error) } finally { setBusy('') }
      }

      /** 手机号 → 发码（校验放在服务端，本地只挡空值）。 */
      const sendSmsCode = async () => {
        if (busy !== '') return
        setBusy('sms:send')
        setNotice('')
        try {
          const sent = await post('/channels/own/sms/send', { provider: channel.id, phone: smsPhone }, 60_000)
          if (sent?.error !== undefined) throw new Error(sent.error)
          setLogin(current => current === null ? null : { ...current, stage: 'code', phone: smsPhone })
        } catch (error) {
          setNotice(t('chan.login.failed').replace('{reason}', String(error?.message ?? error)))
        } finally {
          setBusy('')
        }
      }

      /**
       * 短信登录提交：一次请求换凭据（没有「等授权」那一段）。
       *
       * 成功后关弹窗并刷新自己的账号清单；失败把原因留在弹窗里 —— 手机号/验证码错了
       * 是用户马上要改的，不该用 toast 一闪而过。
       */
      const submitSmsLogin = async () => {
        if (busy !== '') return
        setBusy('sms')
        setNotice('')
        try {
          const value = await post('/channels/own/sms/login', {
            provider: channel.id, phone: login.phone, code: smsCode,
          }, 90_000)
          setLogin(null)
          setSmsCode('')
          setNotice(t('chan.login.done').replace('{login}', value?.nickname ?? login.phone))
          onChanged()
          void loadExtra()
          void loadAccounts()
        } catch (error) {
          setNotice(t('chan.login.failed').replace('{reason}', String(error?.message ?? error)))
        } finally {
          setBusy('')
        }
      }

      // Poll the placeholder until its credential lands. Ten minutes matches the
      // window the pack keeps a pending login link alive for.
      useEffect(() => {
        if (login === null) return undefined
        // 短信渠道没有「等授权」这一段：提交走 sms/login 一次请求换凭据，
        // 不需要轮询（轮了也只会拿到 accountId 为空的报错）。
        if (login.sms === true) return undefined
        let alive = true
        const timer = setInterval(async () => {
          if (Date.now() - login.startedAt > 10 * 60_000) {
            if (alive) { setLogin(null); setNotice(t('chan.login.expired')) }
            return
          }
          try {
            // 本插件自己的渠道：走自己的轮询路由，`done/success/error` 同形。
            // Accio 是浏览器 PKCE（等自己的 loopback 回调），Marvis 是 CDP 拦截回调，
            // 其余是设备码（等上游）。
            const pollPath = channel.id === 'accio'
              ? '/channels/own/oauth/poll'
              : BROWSER_CDP.has(channel.id)
                ? '/channels/own/browser/poll'
                : '/channels/own/login/poll'
            const value = login.own === true
              ? await api(`${pollPath}?account=${encodeURIComponent(login.accountId)}`, { timeout: 30_000 })
              : await rpc('login.poll', { accountId: login.accountId, provider: channel.id })
            if (!alive) return
            if (value?.done === true) {
              setLogin(null)
              if (value.success === false) {
                setNotice(t('chan.login.failed').replace('{reason}', value.error ?? '未知原因'))
              } else {
                setNotice(t('chan.login.done').replace('{login}', value.login ?? value.nickname ?? ''))
                onChanged()
                if (login.own === true) void loadExtra()
                void loadAccounts()
                void loadCredits()
                void loadBalances(true)
              }
            } else if (typeof value?.error === 'string' && value.error !== '' && login.own !== true) {
              setLogin(null)
              setNotice(t('chan.login.failed').replace('{reason}', value.error))
            }
          } catch (error) {
            // 自己的渠道：轮询路由本身报错就是真错误（渠道包的「链接可能还在完成」那条
            // 宽容只适用于第三方页面的回调时序）。
            if (login.own === true) {
              setLogin(null)
              setNotice(t('chan.login.failed').replace('{reason}', String(error?.message ?? error)))
            }
          }
        }, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [login, rpc, channel.id, t, onChanged, loadAccounts, loadCredits, loadBalances, loadExtra])

      const accountAction = async (key, accountId, fn) => {
        setBusy(key); setNotice('')
        try { await fn() } catch (error) { onError(channel, error) } finally { setBusy('') }
      }

      const setAllModels = async disabled => {
        // 自有渠道：渠道包的 `model.setAllDisabled` 不认识这些 id（回
        // `unsupported provider`），走自己的路由。
        if (busy !== '' || modelBatchPending.current || !models?.length) return
        if (channel.own !== true && !rpc) return
        modelBatchPending.current = true
        try {
          await accountAction(disabled ? 'models:hide' : 'models:show', '', async () => {
            if (channel.own === true) await post('/channels/own/models/update', { provider: channel.id, disabled }, 30_000)
            else await rpc('model.setAllDisabled', { provider: channel.id, disabled })
            await loadModels()
            onChanged()
          })
        } finally { modelBatchPending.current = false }
      }

      const removeAccount = async accountId => {
        const entry = (accounts ?? []).find(row => row.id === accountId)
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(t('chan.confirm.delete').replace('{name}', entry?.nickname ?? accountId))) return
        await accountAction('del:' + accountId, accountId, async () => {
          // 自有渠道走自己的路由（同理：`account.delete` 是渠道包的账号池，删不到我们的表）。
          if (channel.own === true) await post('/channels/own/remove', { accountId }, 20_000)
          else await rpc('account.delete', { accountId })
          onChanged(); await loadAccounts(); void loadBalances(true)
        })
      }

      /** 启用/停用：自有渠道走 `/channels/own/update`，渠道包走 `account.update`。 */
      const toggleAccount = async row => {
        if (channel.own === true) {
          await post('/channels/own/update', { accountId: row.id, enabled: row.enabled === false }, 20_000)
        } else {
          await rpc('account.update', { accountId: row.id, patch: { enabled: row.enabled === false } })
        }
        onChanged(); await loadAccounts()
      }

      /**
       * 这个渠道的「领取」走哪条腿。
       *
       * - 渠道包渠道：`credits.claimAll`（按 provider 一次领完所有账号）；
       * - **自有渠道**：渠道包不认识它们（回 `unsupported provider`），改走本插件自己的
       *   `/channels/extra/claim`，**逐账号**领。以前自有渠道的「领取」按钮点了只会
       *   弹一句 `unsupported provider` —— 与「余额查询失败」同一个根因。
       */
      const ownClaimable = ownCredited && OWN_CLAIMABLE.has(channel.id)
      const claimSupported = creditCapability?.claim === true || ownClaimable
      const claim = async () => {
        if (!claimSupported || busy !== '' || claimPending.current) return
        claimPending.current = true
        setBusy('claim'); setNotice('')
        try {
          if (ownClaimable) {
            const rows = await api(`/channels/own?provider=${encodeURIComponent(channel.id)}`, { timeout: 20_000 })
            const list = (Array.isArray(rows?.accounts) ? rows.accounts : []).filter(row => row.enabled !== false)
            if (list.length === 0) { setNotice(t('chan.claim.none')); return }
            let claimed = 0
            let already = 0
            let inactive = 0
            const failures = []
            let amount = 0
            for (const row of list) {
              try {
                const value = await post('/channels/extra/claim', { provider: channel.id, accountId: row.id }, 180_000)
                if (value?.kind === 'claimed') { claimed += 1; amount += Number(value.credit ?? 0) || 0 }
                else if (value?.kind === 'already-claimed') already += 1
                else if (value?.kind === 'inactive') inactive += 1
                else failures.push(value?.message ?? '—')
              } catch (error) {
                failures.push(String(error?.message ?? error))
              }
            }
            const amounts = amount > 0 ? `+${amountText(amount, creditUnit)} ${unitLabel(creditUnit, t)}` : ''
            let text = claimed > 0
              ? t('chan.claim.result').replace('{count}', String(claimed)).replace('{amounts}', amounts)
              : already > 0 && failures.length === 0 ? t('chan.claim.alreadyOnly').replace('{already}', String(already))
                : failures.length === 0 ? t('chan.claim.none') : ''
            if (inactive > 0) text += t('chan.claim.inactive').replace('{count}', String(inactive))
            if (failures.length > 0) {
              const failure = t('chan.claim.failed').replace('{reason}', failures.join('；'))
              text = text === '' ? failure : `${text}；${failure}`
            }
            setNotice(text)
            void loadBalances(true); void loadExtra(); onChanged()
            return
          }
          const value = await rpc('credits.claimAll', { provider: channel.id }, 180_000)
          // `credits.claimAll` 的返回是 `{results, summary}`，summary 里除
          // `claimed/totalCredit` 还有 `totalByUnit`、`alreadyClaimed`、
          // `inactive`、`coversToday`。旧版只读 claimed/totalCredit，于是
          // 「今天已领过」被显示成「没有可领取的积分」、ZCode 的 token 被写成积分。
          const summary = value?.summary ?? {}
          const results = Array.isArray(value?.results) ? value.results : []
          const claimed = Number(summary?.claimed ?? 0)
          const already = Number(summary?.alreadyClaimed ?? 0)
          const inactive = Number(summary?.inactive ?? 0)
          const failed = results.filter(row => row.outcome?.kind === 'failed')
          const amounts = claimAmountText(summary, creditUnit, t)
          let text = ''
          if (claimed > 0) {
            text = already > 0
              ? t('chan.claim.withAlready').replace('{count}', String(claimed)).replace('{amounts}', amounts).replace('{already}', String(already))
              : t('chan.claim.result').replace('{count}', String(claimed)).replace('{amounts}', amounts)
          } else if (already > 0 && failed.length === 0) {
            text = t('chan.claim.alreadyOnly').replace('{already}', String(already))
          } else if (failed.length === 0) {
            text = t('chan.claim.none')
          }
          if (inactive > 0) text += t('chan.claim.inactive').replace('{count}', String(inactive))
          if (failed.length > 0) {
            const failure = t('chan.claim.failed').replace('{reason}', failed.map(row => row.outcome?.message ?? '—').join('；'))
            text = text === '' ? failure : `${text}；${failure}`
          }
          setNotice(text)
          void loadCredits(); void loadBalances(true)
        } catch (error) { onError(channel, error) } finally { claimPending.current = false; setBusy('') }
      }

      /**
       * 领取新手任务 / 一次性奖励（`onboarding.claim`）。
       *
       * 与每日签到是两件事：那个按天幂等，这个是**每号一次**的独立写操作，
       * pack 因此把它放在独立端点上。渠道包里只有 Loomy 的新手任务与
       * Raccoon 的桌面端登录奖励走这条路径。
       */
      const claimTask = async accountId => {
        const kind = CHANNEL_TASKS[channel.id]
        if (busy !== '' || kind === undefined) return
        if (kind === 'pack' && !rpc) return
        await accountAction('task:' + accountId, accountId, async () => {
          const parts = []
          if (kind === 'own') {
            // 自有渠道（超级麦吉）：逐项 `task:<code>` 领取；已完成/不可手动的
            // 项由上游如实回 `inactive`，不再拿 `skipped` 冒充成功。
            const known = tasks[accountId]?.tasks ?? {}
            const codes = Object.keys(known).filter(code => known[code] !== true)
            if (codes.length === 0) {
              setNotice(t('chan.task.none'))
              void loadTasks(); return
            }
            let claimed = 0
            let failed = 0
            for (const code of codes) {
              try {
                const value = await post('/channels/extra/claim', {
                  provider: channel.id,
                  accountId,
                  campaignId: 'task:' + code,
                }, 120_000)
                if (value?.kind === 'claimed') claimed += 1
                else if (value?.kind !== 'already-claimed') failed += 1
              } catch { failed += 1 }
            }
            if (claimed > 0) parts.push(t('chan.task.claimed').replace('{list}', t('chan.task.ownDone').replace('{count}', String(claimed))))
            if (failed > 0) parts.push(t('chan.task.ownFailed').replace('{count}', String(failed)))
          } else {
            const value = await rpc('onboarding.claim', { provider: channel.id, accountId }, 120_000)
            const claimed = Array.isArray(value?.claimed) ? value.claimed : []
            const skipped = Array.isArray(value?.skipped) ? value.skipped : []
            if (claimed.length > 0) parts.push(t('chan.task.claimed').replace('{list}', claimed.map(row => `${row.title} +${amountText(row.points)}`).join('、')))
            if (skipped.length > 0) parts.push(t('chan.task.skipped').replace('{count}', String(skipped.length)))
          }
          if (parts.length === 0) parts.push(t('chan.task.none'))
          setNotice(parts.join('；'))
          void loadTasks(); void loadBalances(true); onChanged()
        })
      }

      /**
       * 领取一个运营活动（本插件自己的 `/channels/extra/claim`）。
       *
       * 这是**写**操作。三种结论分开显示：领到了多少、今天已领、不可领 ——
       * 与渠道包 `credits.claimAll` 的那套语义一致，只是这里按**活动**粒度。
       */
      const claimActivity = async (accountId, campaignId, title) => {
        setExtraNotice('')
        setBusy('extra:' + campaignId)
        try {
          const value = await post('/channels/extra/claim', { provider: channel.id, accountId, campaignId }, 60_000)
          if (value?.kind === 'claimed') {
            setExtraNotice(t('chan.extra.claimed').replace('{title}', title ?? '').replace('{amount}', amountText(value.credit, 'credit')))
          } else if (value?.kind === 'already-claimed') {
            setExtraNotice(t('chan.extra.already'))
          } else if (value?.kind === 'inactive') {
            setExtraNotice(t('chan.extra.inactiveMsg').replace('{reason}', value?.message ?? ''))
          }
          await loadExtra(); void loadBalances(true); onChanged()
        } catch (error) {
          setExtraNotice(t('chan.extra.failed').replace('{reason}', String(error?.message ?? error)))
        } finally {
          setBusy('')
        }
      }

      /** 锁定/解锁永久积分（`credits.permanentLock`，provider 级开关）。 */
      const toggleLock = async () => {
        if (!rpc || busy !== '' || lock === undefined || lock === null) return
        await accountAction('lock', '', async () => {
          const value = await rpc('credits.permanentLock', { provider: channel.id, locked: lock.locked !== true }, 30_000)
          setLock(value ?? null)
          setNotice(value?.locked === true ? t('chan.lock.on') : t('chan.lock.off'))
          void loadBalances(true)
        })
      }

      /**
       * 渠道级总开关（`provider.setEnabled`）：关闭 = 关掉全部模型 + 停用全部
       * 账号，打开 = 清空模型黑名单 + 启用全部账号。这与「逐模型开关」不是
       * 同一件事，pack 的 `provider.status.closed` 判据是「模型是否全关」。
       */
      const toggleProvider = async () => {
        const close = status?.closed !== true
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && close && !window.confirm(t('chan.provider.confirm').replace('{name}', channel.name))) return
        if (channel.own !== true && !rpc) return
        await accountAction(close ? 'provider:off' : 'provider:on', '', async () => {
          // 自有渠道走自己的路由（渠道包的 `provider.setEnabled` 不认识这些 id）。
          const value = channel.own === true
            ? await post('/channels/own/provider/update', { provider: channel.id, enabled: !close }, 90_000)
            : await rpc('provider.setEnabled', { provider: channel.id, enabled: !close }, 90_000)
          const modelsCount = Number(value?.models?.total ?? value?.models ?? 0)
          const accountsCount = Number(value?.accounts?.total ?? value?.accounts ?? 0)
          setNotice(t(close ? 'chan.provider.doneOff' : 'chan.provider.doneOn')
            .replace('{name}', channel.name)
            .replace('{models}', String(modelsCount))
            .replace('{accounts}', String(accountsCount)))
          if (open === 'models') await loadModels()
          if (channel.own === true) {
            await loadAccounts()
            void loadBalances(true)
          }
          onChanged()
        })
      }

      const creditFor = accountId => (credits ?? []).find(row => row.accountId === accountId)?.status ?? null

      /**
       * 「活动」折叠的内容（本插件自己的权益扩展）。
       *
       * 先算成变量再挂进 children：这一块每层都要 `h(...)` 包 map，写在一行
       * 三元里括号数会失控（第一版就是这么错的）。分步之后每层只剩一个括号。
       */
      const extraFold = !CHANNEL_EXTRAS.has(channel.id) ? null : h('div', { className: 'ofm_chanfold' },
        extraLoading || extra === undefined
          ? h('div', { className: 'ofm_skel', style: { minHeight: 44 } })
          : extra?.supported === false
            ? h('p', { className: 'ofm_note' }, t('chan.extra.unsupported').replace('{reason}', extra?.reason ?? extra?.error ?? ''))
            : h(Fragment, null,
              extraNotice === '' ? null : h('p', { className: 'ofm_note', role: 'status' }, extraNotice),
              (extra?.accounts ?? []).length === 0
                ? h('p', { className: 'ofm_note' }, t('chan.noAccount'))
                : h('div', { className: 'ofm_acctlist' }, (extra?.accounts ?? []).map(row => {
                  const activities = (row.activities ?? []).map(activity => {
                    const claimable = activity.claimable === true
                    const label = claimable
                      ? t('chan.extra.claimable')
                      : (activity.status === '' ? t('chan.extra.notClaimable') : activity.status)
                    // 奖励额度**可以未知**：豆包的签到奖励只有领完才从响应里读到
                    //（活动侧不下发预告），此时不画「+0 积分」——0 在积分语境里
                    // 是「用光了」，不是「还不知道」。
                    const reward = Number(activity.amount)
                    const title = Number.isFinite(reward) && reward > 0
                      ? `${activity.title || activity.type} · +${amountText(reward, 'credit')}`
                      : (activity.title || activity.type)
                    return h('div', {
                      className: 'ofm_modelrow' + (claimable ? '' : ' off'),
                      key: `${activity.campaignId}|${activity.type}`,
                    },
                      h('span', { className: 'ofm_id', title: activity.campaignId }, title),
                      h('span', { className: 'ofm_tagpill' + (claimable ? ' free' : '') }, label),
                      claimable && activity.campaignId !== ''
                        ? h('button', {
                          type: 'button', className: 'ofm_minibtn', disabled: busy !== '',
                          onClick: () => void claimActivity(row.accountId, activity.campaignId, activity.title),
                        }, busy === 'extra:' + activity.campaignId ? '…' : t('chan.extra.claim'))
                        : null)
                  })
                  const badge = row.info !== undefined && row.info !== null
                    ? h('span', { className: 'ofm_creditbadge strong', title: row.info.planName ?? '' },
                      t('chan.extra.balance')
                        .replace('{remain}', amountText(row.info.total?.remain, 'credit'))
                        .replace('{total}', amountText(row.info.total?.total, 'credit')))
                    : h('span', { className: 'ofm_balanceerror' }, row.infoError ?? t('chan.credits.unavailable'))
                  return h('div', { className: 'ofm_acct', key: row.accountId || row.nickname },
                    h('span', { className: 'ofm_acctname', title: row.nickname || row.accountId }, row.nickname || row.accountId || '—'),
                    badge,
                    row.info !== undefined && Number(row.info?.total?.expiring) > 0
                      ? h('span', { className: 'ofm_note' }, t('chan.extra.expiring').replace('{amount}', amountText(row.info.total.expiring, 'credit')))
                      : null,
                    activities.length === 0
                      ? h('span', { className: 'ofm_note' }, row.activitiesError ?? t('chan.extra.none'))
                      : h('div', { className: 'ofm_modellist' }, activities))
                }))))

      const card = h('article', {
        className: `ofm_chan ofm_glass${status?.closed === true ? ' off' : ''}`,
        'data-state': chanState,
        style: { '--chan-accent': channel.accent },
      },
        h('div', { className: 'ofm_chanhead' },
          h('span', { className: 'ofm_chanlogo', 'aria-hidden': 'true' },
            CHANNEL_ICONS[channel.id] !== undefined
              ? h('img', { src: CHANNEL_ICONS[channel.id], alt: '' })
              : channel.name.slice(0, 2).toUpperCase()),
          h('span', { className: 'ofm_chanid' },
            h('b', null, channel.name),
            h('span', null, channel.org)),
          h('span', { className: 'ofm_chanstate' },
            h('span', { className: `ofm_dot ${connected ? 'ok' : status?.closed === true ? 'err' : ''}` }),
            stateText)),
        h('p', { className: 'ofm_note' }, channel.note),
        h('div', { className: 'ofm_chanmeta' },
          h('span', null, `${t('chan.meta.accounts')} `, h('b', null, `${enabledCount}/${accountsCount}`)),
          h('span', null, `${t('chan.meta.models')} `, h('b', null, modelsTotal === 0 ? '—' : `${modelsTotal - modelsOff}/${modelsTotal}`)),
          showCredits ? h('span', { className: 'ofm_credittotal' },
            `${balanceLabel} `,
            h('b', null, balanceLoading ? '…' : balancesKnown
              ? creditCapability?.quota === true
                ? t('chan.credits.loaded').replace('{count}', String((balances ?? []).filter(row => Number.isFinite(row.balance?.total)).length))
                : amountText(balancesTotal, creditUnit)
              : balances === undefined ? '…' : '—')) : null),
        h('div', { className: 'ofm_chanacts' },
          h('button', { type: 'button', className: 'ofm_btn', disabled: busy !== '' || (channel.own !== true && !rpc), 'aria-busy': busy === 'add' ? 'true' : undefined, onClick: startLogin }, busy === 'add' ? '…' : t('chan.act.add')),
          // 自有渠道只有登记了续期实现的才给按钮（`status.refreshable` 来自宿主）。
          accountsCount > 0 && (channel.own !== true || status?.refreshable === true) ? h('button', {
            type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || (channel.own !== true && !rpc), 'aria-busy': busy === 'refreshAll' ? 'true' : undefined,
            onClick: () => accountAction('refreshAll', '', async () => {
              // 自有渠道：`account.refresh` 是渠道包的账号池；自己的账号改走
              // `/channels/own/refresh`（逐账号串行，与「领取」同款）。
              const rows = channel.own === true
                ? ((await api(`/channels/own?provider=${encodeURIComponent(channel.id)}`, { timeout: 20_000 }))?.accounts ?? [])
                  .filter(row => row.refreshable === true)
                : (accounts ?? await rpc('account.list', { provider: channel.id }).then(v => v?.accounts ?? []))
              for (const row of rows) {
                try {
                  if (channel.own === true) await post('/channels/own/refresh', { accountId: row.id }, 90_000)
                  else await rpc('account.refresh', { accountId: row.id }, 90_000)
                } catch (error) { onError(channel, error) }
              }
              onChanged(); await loadAccounts(); void loadBalances(true)
            }),
          }, busy === 'refreshAll' ? '…' : t('chan.act.refresh')) : null,
          showCredits ? h('button', {
            type: 'button', className: 'ofm_btn ghost', disabled: balanceLoading || busy !== '',
            'aria-busy': balanceLoading ? 'true' : undefined, onClick: () => void loadBalances(true),
          }, balanceLoading ? t('chan.credits.loading') : t('chan.credits.refresh')) : null,
          claimSupported ? h('button', {
            type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || (channel.own !== true && !rpc), 'aria-busy': busy === 'claim' ? 'true' : undefined,
            onClick: claim,
          }, busy === 'claim' ? '…' : t('chan.act.claim')) : null,
          // 锁定永久积分：两档语义（锁/不锁）用同一个按钮，状态写在标签上。
          CHANNEL_LOCK.has(channel.id) && lock !== undefined && lock !== null ? h('button', {
            type: 'button', className: 'ofm_btn ghost' + (lock.locked === true ? ' primary' : ''),
            disabled: busy !== '' || !rpc, 'aria-busy': busy === 'lock' ? 'true' : undefined,
            title: t('chan.lock.hint').replace('{days}', String(lock.windowDays ?? 15)),
            onClick: () => void toggleLock(),
          }, lock.locked === true ? t('chan.lock.on') : t('chan.lock.off')) : null,
          h('button', { type: 'button', className: 'ofm_foldtoggle', 'data-open': open === 'accounts' ? 'true' : 'false', onClick: () => void toggle('accounts') },
            h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 1.5l6 4.5-6 4.5z' })),
            t('chan.fold.accounts'), accounts === undefined ? null : ` (${accounts.length})`),
          CHANNEL_TASKS[channel.id] ? h('button', { type: 'button', className: 'ofm_foldtoggle', 'data-open': open === 'tasks' ? 'true' : 'false', onClick: () => void toggle('tasks') },
            h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 1.5l6 4.5-6 4.5z' })),
            t('chan.fold.tasks')) : null,
          CHANNEL_SUBSCRIPTION.has(channel.id) ? h('button', { type: 'button', className: 'ofm_foldtoggle', 'data-open': open === 'subscription' ? 'true' : 'false', onClick: () => void toggle('subscription') },
            h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 1.5l6 4.5-6 4.5z' })),
            t('chan.fold.subscription')) : null,
          CHANNEL_EXTRAS.has(channel.id) ? h('button', { type: 'button', className: 'ofm_foldtoggle', 'data-open': open === 'extra' ? 'true' : 'false', onClick: () => void toggle('extra') },
            h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 1.5l6 4.5-6 4.5z' })),
            t('chan.fold.extra')) : null,
          h('button', { type: 'button', className: 'ofm_foldtoggle', 'data-open': open === 'models' ? 'true' : 'false', onClick: () => void toggle('models') },
            h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 1.5l6 4.5-6 4.5z' })),
            t('chan.fold.models'), models === undefined ? null : ` (${models.length})`)),
        notice !== '' ? h('p', { className: 'ofm_note' }, notice) : null,
        // 没有启用账号时**不显示任何余额错误**：这不是「查询失败」，而是「还没登录」。
        // 旧宿主缺路由 / 旧渠道包不认识 provider 时，这里以前会画一行红字
        //（用户报障「都没登账号还提示余额查询失败」）。
        enabledCount > 0 && balanceError !== '' ? h('p', { className: 'ofm_balanceerror', role: 'alert' },
          t('chan.credits.failed').replace('{reason}', balanceError))
          : enabledCount > 0 && balanceFailures > 0 ? h('p', { className: 'ofm_balanceerror', role: 'status' },
            t('chan.credits.partial').replace('{count}', String(balanceFailures))) : null,
        open === 'accounts' ? h('div', { className: 'ofm_chanfold' },
          accounts === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 44 } })
            : accounts.length === 0 ? h('p', { className: 'ofm_note' }, t('chan.noAccount'))
              : h('div', { className: 'ofm_acctlist' }, accounts.map(row => {
                const credit = creditFor(row.id)
                // 「待登录」的判据：
                // - 渠道包账号：没有续期材料、也没有到期时间（占位行）；
                // - 自有渠道：看权益查询回的 `pending`（账号表里的行 + 凭据库里没有
                //   本体）。上一版对自有账号恒为 true —— 已登录的号也画成虚线。
                const balanceRow = (balances ?? []).find(entry => entry.accountId === row.id)
                const pending = channel.own === true
                  ? balanceRow?.pending === true
                  : row.refreshable !== true && !Number.isFinite(row.expiresAt)
                return h('div', { className: 'ofm_acct' + (pending ? ' pending' : ''), key: row.id },
                  h('span', { className: 'ofm_acctname', title: row.nickname ?? row.id }, row.nickname ?? row.id),
                  h('span', { className: 'ofm_acctmeta' }, row.enabled === false ? t('chan.disabled') : t('chan.enabled'), ' · ', expiryText(row, t)),
                  credit?.todayCheckedIn === true && Number.isFinite(credit.todayCredit) ? h('span', { className: 'ofm_creditbadge' },
                    t('chan.credit.today').replace('{credit}', amountText(credit.todayCredit, creditUnit))) : null,
                  (() => {
                    const balance = balanceOf(row.id)
                    if (!showCredits) return null
                    if (balanceLoading) return h('span', { className: 'ofm_note' }, t('chan.credits.loading'))
                    const result = (balances ?? []).find(entry => entry.accountId === row.id)
                    // 待登录（建了账号但没登完）：既不是「余额 0」也不是「查询失败」。
                    if (result?.pending === true) return h('span', { className: 'ofm_note' }, t('chan.credits.pending'))
                    if (balance === null || !Number.isFinite(balance.total)) return h('span', { className: 'ofm_balanceerror' },
                      balanceError ? t('chan.credits.failed').replace('{reason}', balanceError)
                        : result?.error || t('chan.credits.unavailable'))
                    // 账号档位（`extra.accountTier`，Gemini 的 Free/Pro 之类）两条分支都要带，
                    // 否则配额渠道永远看不到它 —— 上一版就是被 `if (quota)` 提前 return 掉了。
                    const tier = typeof result?.extra?.accountTier?.title === 'string' && result.extra.accountTier.title !== ''
                      ? h('span', { className: 'ofm_note' }, t('chan.credits.tier').replace('{tier}', result.extra.accountTier.title))
                      : null
                    // 配额渠道的 total 是百分比均值，真正要看的是两个窗口各自剩多少。
                    if (creditCapability?.quota === true) {
                      const windows = (balance.packages ?? []).map(pkg => `${pkg.name} ${amountText(pkg.remaining, 'quota')}`)
                      return h(Fragment, null,
                        h('span', { className: 'ofm_creditbadge strong', title: balanceLabel },
                          `${balanceLabel} ${windows.join(' · ') || '—'}`),
                        tier)
                    }
                    // `packages` 是积分口径的明细（总/基础/按需/赠送），`expiredTotal`
                    // 是已作废的部分 —— 只显示一个 total 会让「总额/已用/即将到期」
                    // 全都看不见，而 pack 已经把这些算好了。
                    const packages = Array.isArray(balance.packages) ? balance.packages.filter(pkg => pkg.active !== false) : []
                    const detail = packages.length > 1
                      ? packages.map(pkg => `${pkg.name} ${amountText(pkg.remaining, creditUnit)}`).join(' · ')
                      : null
                    return h(Fragment, null,
                      h('span', { className: 'ofm_creditbadge strong', title: balanceLabel },
                        `${balanceLabel} ${amountText(balance.total, creditUnit)}`),
                      detail === null ? null : h('span', { className: 'ofm_note', title: detail }, detail),
                      Number.isFinite(balance.expiredTotal) && balance.expiredTotal > 0
                        ? h('span', { className: 'ofm_note' }, t('chan.credits.expired').replace('{amount}', amountText(balance.expiredTotal, creditUnit)))
                        : null,
                      tier)
                  })(),
                  h('span', { className: 'ofm_acctacts' },
                    // 「测速 / 刷新凭据」是渠道包账号池的能力（它读自己的凭据引用）；
                    // 自有渠道没有这两条腿 ⇒ 不渲染按钮，而不是给一个点了没反应的。
                    channel.own === true ? null : h('button', {
                      type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                      onClick: () => accountAction('test:' + row.id, row.id, async () => {
                        const value = await rpc('account.test', { accountId: row.id }, 90_000)
                        setNotice(value?.ok === false
                          ? t('chan.test.failed').replace('{reason}', value?.error ?? '')
                          : t('chan.test.ok').replace('{ms}', String(value?.ms ?? value?.latencyMs ?? '—')))
                      }),
                    }, t('chan.act.test')),
                    // 自有渠道只有登记了续期实现、且凭据本体存在时才给按钮
                    // （`refreshable` 由宿主按凭据材料算，不是面板猜的）。
                    channel.own === true
                      ? (row.refreshable === true ? h('button', {
                        type: 'button', className: 'ofm_minibtn', disabled: busy !== '',
                        onClick: () => accountAction('refresh:' + row.id, row.id, async () => {
                          const value = await post('/channels/own/refresh', { accountId: row.id }, 90_000)
                          setNotice(t('chan.act.refreshed').replace('{name}', row.nickname ?? row.id)
                            .replace('{state}', value?.refreshed === true ? t('chan.act.refreshedYes') : t('chan.act.refreshedNo')))
                          onChanged(); await loadAccounts(); void loadBalances(true)
                        }),
                      }, t('chan.act.refresh')) : null)
                      : h('button', {
                        type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                        onClick: () => accountAction('refresh:' + row.id, row.id, async () => {
                          await rpc('account.refresh', { accountId: row.id }, 90_000)
                          onChanged(); await loadAccounts(); void loadBalances(true)
                        }),
                      }, t('chan.act.refresh')),
                    h('button', {
                      type: 'button', className: 'ofm_minibtn', disabled: busy !== '',
                      onClick: () => accountAction('toggle:' + row.id, row.id, async () => { await toggleAccount(row) }),
                    }, row.enabled === false ? t('chan.enabled') : t('chan.disabled')),
                    h('button', {
                      type: 'button', className: 'ofm_minibtn danger', disabled: busy !== '',
                      onClick: () => void removeAccount(row.id),
                    }, t('chan.act.delete'))))
              }))) : null,
        extraFold,
        open === 'models' ? h('div', { className: 'ofm_chanfold' },
          models === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 44 } })
            : h(Fragment, null,
              models.length === 0
                ? h('p', { className: 'ofm_note' }, channel.id === 'accio' ? t('chan.model.accountScoped') : '—')
                : h(Fragment, null,
                  h('div', { className: 'ofm_row' },
                    h('span', { className: 'ofm_note' }, t('chan.model.enabledCount')
                      .replace('{enabled}', String(models.filter(model => model.disabled !== true).length))
                      .replace('{total}', String(models.length))),
                    // 「实时 / 预制」：取到最新列表就写实时；否则写预制并把原因写在悬停里。
                    modelMeta === undefined || modelMeta === null ? null : h('span', {
                      className: 'ofm_tagpill' + (modelMeta.source === 'live' ? ' free' : ''),
                      title: catalogHint,
                    }, modelMeta.source === 'live' ? t('chan.catalog.live') : t('chan.catalog.preset')),
                    h('button', {
                      type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || status?.closed === true || (channel.own !== true && !rpc),
                      title: t('chan.model.allScope'), 'aria-busy': busy === 'models:show' ? 'true' : undefined,
                      onClick: () => void setAllModels(false),
                    }, t('chan.model.enableAll')),
                    h('button', {
                      type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || status?.closed === true || (channel.own !== true && !rpc),
                      title: t('chan.model.allScope'), 'aria-busy': busy === 'models:hide' ? 'true' : undefined,
                      onClick: () => void setAllModels(true),
                    }, t('chan.model.disableAll'))),
                  h('div', { className: 'ofm_modellist' }, models.map(model => h('div', {
                    className: 'ofm_modelrow' + (model.disabled === true ? ' off' : ''),
                    key: model.id,
                  },
                    h('span', { className: 'ofm_id', title: model.id }, model.name ?? model.id),
                    // 倍率：渠道包把 CodeArts 的 `credit[]` 丢了，所以它的模型名里没有
                    // ` · x0.18`；这里的数字来自本插件自己的发现（`/channels/extra`）。
                    // ⚠️ 只在名字里**没有**倍率时补标签：Qoder 的渠道包展示名已经带
                    // ` · x0.5`，再挂一个 pill 就是同一行两个倍率（两个来源还可能不一致）。
                    (() => {
                      // 倍率**就在模型行里**：宿主把 `statusOf` 的 ratios 随目录一起
                      // 回给面板（`model.ratio`），不再要求用户先展开「活动」折叠。
                      const ratio = model.ratio ?? model.rate ?? extra?.ratios?.[model.id]
                      if (ratio === undefined || ratio === null || String(ratio) === '') return null
                      // 展示名里已经带了同一个倍率（豆包/ Qoder 的 `· 0.65x`）就不重复挂。
                      if (String(model.name ?? '').includes(String(ratio))) return null
                      return h('span', { className: 'ofm_tagpill', title: t('chan.extra.ratioTitle') }, ratio)
                    })(),
                    model.needsLogin === true ? h('span', { className: 'ofm_tagpill' }, t('chan.model.needsLogin')) : null,
                    model.isFree === true ? h('span', { className: 'ofm_tagpill free' }, t('chan.model.free')) : null,
                    model.dead === true ? h('span', { className: 'ofm_tagpill dead' }, t('chan.model.dead')) : null,
                    h('button', {
                      type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || status?.closed === true || (channel.own !== true && !rpc),
                      onClick: () => accountAction('model:' + model.id, '', async () => {
                        if (channel.own === true) {
                          // 自有渠道的模型开关：宿主设置（选择器/网关下一次 sync 生效）。
                          await post('/channels/own/models/update', {
                            provider: channel.id,
                            modelId: model.modelId ?? model.id,
                            disabled: model.disabled !== true,
                          }, 30_000)
                        } else {
                          await rpc('model.setDisabled', { provider: channel.id, modelId: model.id, disabled: model.disabled !== true })
                        }
                        await loadModels(); onChanged()
                      }),
                    }, model.disabled === true ? t('chan.model.on') : t('chan.model.off')))))),
              // 渠道级总开关：语义是「模型全关 + 账号全停」，与逐模型开关不同。
              // ⚠️ 必须放在 `models.length === 0` 之外：关掉整个渠道后模型列表为空，
              // 若按钮也在那个分支里，用户就再也点不到「打开整个渠道」。
              h('div', { className: 'ofm_row' },
                h('span', { className: 'ofm_note' }, t('chan.provider.hint')),
                h('button', {
                  type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || (channel.own !== true && !rpc),
                  'aria-busy': busy === 'provider:off' || busy === 'provider:on' ? 'true' : undefined,
                  onClick: () => void toggleProvider(),
                }, status?.closed === true ? t('chan.provider.on') : t('chan.provider.off'))))) : null,
        open === 'tasks' && CHANNEL_TASKS[channel.id] ? h('div', { className: 'ofm_chanfold' },
          tasksLoading ? h('div', { className: 'ofm_skel', style: { minHeight: 44 } })
            : (accounts ?? []).length === 0 ? h('p', { className: 'ofm_note' }, t('chan.noAccount'))
              : h('div', { className: 'ofm_acctlist' }, (accounts ?? []).map(row => {
                const state = tasks[row.id]
                const taskKeys = state?.tasks !== undefined && state.tasks !== null ? Object.keys(state.tasks) : []
                const done = taskKeys.filter(key => state.tasks[key] === true)
                const titles = state?.titles ?? {}
                const points = state?.points ?? {}
                return h('div', { className: 'ofm_acct', key: row.id },
                  h('span', { className: 'ofm_acctname', title: row.nickname ?? row.id }, row.nickname ?? row.id),
                  state === undefined ? h('span', { className: 'ofm_note' }, t('chan.task.loading'))
                    : state?.error !== undefined ? h('span', { className: 'ofm_balanceerror' }, state.error)
                      : h('span', { className: 'ofm_acctmeta' }, t('chan.task.earned')
                        .replace('{earned}', amountText(state?.earned ?? 0, creditUnit))
                        .replace('{total}', amountText(state?.total ?? 0, creditUnit))),
                  taskKeys.length === 0 ? null : h('span', { className: 'ofm_note', title: taskKeys.map(key => `${titles[key] ?? key} +${amountText(points[key] ?? 0)}`).join('、') },
                    done.length === taskKeys.length ? t('chan.task.all') : `${done.length}/${taskKeys.length}`),
                  h('span', { className: 'ofm_acctacts' },
                    h('button', {
                      type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                      onClick: () => void claimTask(row.id),
                    }, busy === 'task:' + row.id ? '…' : t('chan.task.claim'))))
              }))) : null,
        open === 'subscription' && CHANNEL_SUBSCRIPTION.has(channel.id) ? h('div', { className: 'ofm_chanfold' },
          subscription === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 44 } })
            : h('div', { className: 'ofm_acctlist' }, subscription.map((row, index) => {
              const account = (accounts ?? []).find(entry => entry.id === row.accountId)
              return h('div', { className: 'ofm_acct', key: row.accountId || `quota-${index}` },
                h('span', { className: 'ofm_acctname', title: account?.nickname ?? row.accountId }, account?.nickname ?? row.accountId ?? '—'),
                row.ok === false || row.error !== undefined
                  ? h('span', { className: 'ofm_balanceerror' }, row.error ?? t('chan.credits.unavailable'))
                  : (row.windows ?? []).length === 0 ? h('span', { className: 'ofm_note' }, '—')
                    : h('span', { className: 'ofm_acctmeta' }, (row.windows ?? []).map(window => t('chan.quota.window')
                      .replace('{type}', window.type ?? '—')
                      .replace('{percent}', String(Math.round(Number(window.percentUsed) || 0)))).join(' · ')))
            }))) : null)

      // 弹窗有两种形状：短信验证码（用户填码）与设备码/浏览器授权（等回调）。
      // 两者共用一个壳，但**内容与动作完全不同** —— 混在一处会让「等待授权」的
      // 那套文案出现在需要填码的渠道上。
      // 弹窗有两种形状：短信验证码（用户先填手机号、再填码）与设备码/浏览器授权
      // （等第三方回调）。**先算成变量再挂进 children** —— 三层嵌套三元写在 children 里
      // 第一版就是这么把括号写坏的。
      const smsPhoneStep = h(Fragment, null,
        h('div', { className: 'ofm_loginstep' }, h('b', null, '1'), h('span', null, t('chan.login.smsPhone'))),
        h('input', {
          className: 'ofm_input', type: 'tel', inputMode: 'tel', value: smsPhone,
          placeholder: t('chan.login.smsPhonePlaceholder'),
          onChange: event => setSmsPhone(event.target.value.replace(/\D/g, '').slice(0, 11)),
        }))
      const smsCodeStep = h(Fragment, null,
        h('div', { className: 'ofm_loginstep' }, h('b', null, '1'),
          h('span', null, t('chan.login.smsSent').replace('{phone}', login?.phone ?? smsPhone))),
        h('div', { className: 'ofm_loginstep' }, h('b', null, '2'), h('span', null, t('chan.login.smsCode'))),
        h('input', {
          className: 'ofm_input', type: 'text', inputMode: 'numeric', value: smsCode,
          placeholder: t('chan.login.smsCodePlaceholder'),
          onChange: event => setSmsCode(event.target.value.replace(/\D/g, '').slice(0, 8)),
        }))
      // 第 1 步的文案按登录形状分叉：扫码渠道（AStudio）是「用微信扫这个码」，
      // 其余是「在浏览器里完成登录」。**先算成变量**：`t()` 里放三元会让
      // `tests/i18n-keys.mjs` 的静态扫描看不到 `stepScan`（键漏定义也不报警）。
      const stepOneText = login?.qr === true ? t('chan.login.stepScan') : t('chan.login.step1')
      const deviceStep = h(Fragment, null,
        // 扫码型渠道（AStudio）：URL 本身是二维码图片，画出来比给一串链接有用得多。
        login?.qr === true && typeof login?.url === 'string' && login.url !== ''
          ? h('img', {
            src: login.url, alt: t('chan.login.qrAlt'), width: 180, height: 180,
            style: { display: 'block', margin: '4px auto 8px', background: '#fff', borderRadius: 8 },
          })
          : null,
        h('div', { className: 'ofm_loginstep' }, h('b', null, '1'), h('span', null, stepOneText)),
        h('div', { className: 'ofm_loginstep' }, h('b', null, '2'), h('span', null, t('chan.login.step2'))),
        // 设备码类渠道：用户码要**看得见**，用户拿它去浏览器里确认。
        typeof login?.code === 'string' && login.code !== ''
          ? h('div', { className: 'ofm_loginstep' }, h('b', null, '3'),
            h('span', null, t('chan.login.code').replace('{code}', login.code)))
          : null,
        // 扫码型渠道的 URL 已经画成图片，再贴一遍长链接是噪音。
        login?.url === '' || login?.url === undefined || login.qr === true
          ? null
          : h('code', { className: 'ofm_mono', style: { wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }, login.url),
        h('p', { className: 'ofm_note ofm_scanline' }, t('chan.login.waiting')))
      const modalBody = login === null
        ? null
        : login.sms === true ? (login.stage === 'phone' ? smsPhoneStep : smsCodeStep) : deviceStep
      const modalFoot = login === null
        ? null
        : login.sms === true
          ? h('button', {
            type: 'button', className: 'ofm_btn primary',
            disabled: busy !== '' || (login.stage === 'phone' ? smsPhone.length < 11 : smsCode.length < 4),
            'aria-busy': busy === 'sms' || busy === 'sms:send' ? 'true' : undefined,
            onClick: () => void (login.stage === 'phone' ? sendSmsCode() : submitSmsLogin()),
          }, busy === 'sms' || busy === 'sms:send' ? '…' : t(login.stage === 'phone' ? 'chan.login.smsSend' : 'chan.login.smsSubmit'))
          : login.url === '' || login.qr === true ? null : h('a', { className: 'ofm_btn primary', href: login.url, target: '_blank', rel: 'noreferrer noopener' }, t('chan.login.open'))
      const modal = login === null ? null : h('div', { className: 'ofm_scrim' },
        h('div', { className: 'ofm_modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('chan.login.title').replace('{name}', channel.name) },
          h('div', { className: 'ofm_modalhead' }, t('chan.login.title').replace('{name}', channel.name)),
          h('div', { className: 'ofm_modalbody ofm_loginbody' }, modalBody),
          h('div', { className: 'ofm_modalfoot' },
            modalFoot,
            h('button', { type: 'button', className: 'ofm_btn ghost', onClick: () => { setLogin(null); setSmsCode('') } }, t('chan.login.cancel')))))

      return h(Fragment, null, card, modal)
    }

    function ChannelsPage(props) {
      const { t, ctx, summary } = props
      const { available, rpc } = useChannelRpc(ctx)
      // The pack runs a daily auto check-in engine across the credit channels;
      // this page is where it is switched and watched (usage.autoCheckin).
      const [auto, setAuto] = useState(undefined)
      const loadAuto = useCallback(async () => {
        if (!available) return
        try { const value = await rpc('usage.autoCheckin', {}, 30_000); setAuto(value?.autoCheckin ?? null) } catch { setAuto(null) }
      }, [available, rpc])
      useEffect(() => { void loadAuto() }, [loadAuto])
      const toggleAuto = async () => {
        try { const value = await rpc('usage.autoCheckin', { enabled: auto?.enabled !== true }, 60_000); setAuto(value?.autoCheckin ?? null) } catch { /* the status refresh tells */ }
      }
      const [statuses, setStatuses] = useState(undefined)
      const [error, setError] = useState('')
      // 宿主目录诊断（`/diag/models`）：页面底部一行，用来判断「宿主到底给了几条」。
      // 改了模型表却看不到变化时，这行能区分「宿主没给」与「界面没刷」。
      const [diag, setDiag] = useState(null)
      const pack = summary?.channels ?? { state: 'pending', error: '' }
      // The pack is what answers this page's RPC, so *the RPC answering* is the
      // readiness signal — the summary's `channels` bit can be a step behind:
      // it is read when the page mounts, while the pack's dynamic import may
      // still be in flight, and a page that trusted it would show an empty grid
      // for as long as that stale read lasted. The summary state is then only
      // the failure *reason* when the probes never come back.
      const [ready, setReady] = useState(pack.state === 'ready')

      const loadStatus = useCallback(async (attempt = 0) => {
        if (!available) return
        try {
          // 本插件自己的渠道不进渠道包的 provider.status（它不认识这些 id）。
          // 它们的状态由自己的账号表决定：有账号即「已接入」，没有即「待接入」。
          const value = await rpc('provider.status', { providers: CHANNEL_PROVIDERS.filter(row => row.own !== true).map(row => row.id) })
          const statuses = { ...(value?.statuses ?? {}) }
          // 自己的渠道：状态来自本插件自己的账号表（渠道包不认识这些 id）。
          await Promise.all(CHANNEL_PROVIDERS.filter(row => row.own === true).map(async row => {
            try {
              const own = await api(`/channels/own?provider=${encodeURIComponent(row.id)}`, { timeout: 15_000 })
              const accounts = Array.isArray(own?.accounts) ? own.accounts : []
              statuses[row.id] = {
                accounts: { total: accounts.length, enabled: accounts.filter(entry => entry.enabled !== false).length },
                // 模型数由宿主按**同一份目录**算好（含被关掉的行）；以前这里写死
                // 0，卡片上永远是「模型 —」，用户以为没模型。
                models: own?.models ?? { total: 0, disabled: 0 },
                closed: own?.closed === true,
                own: true,
                // 有续期实现的渠道才渲染「刷新凭据」。
                refreshable: own?.refreshable === true,
              }
            } catch {
              statuses[row.id] = { accounts: { total: 0, enabled: 0 }, models: { total: 0, disabled: 0 }, closed: false, own: true }
            }
          }))
          setStatuses(statuses)
          setReady(true)
          setError('')
        } catch (err) {
          // The pack imports asynchronously on a cold start; retry a bounded
          // few times before believing the failure and surfacing the reason.
          if (attempt < 4) { setTimeout(() => { void loadStatus(attempt + 1) }, 4000); return }
          setError(String(err?.message ?? err))
        }
      }, [available, rpc])

      useEffect(() => { void loadStatus() }, [loadStatus])
      useEffect(() => {
        if (!ready) return undefined
        let alive = true
        const loadDiag = async () => {
          try {
            const value = await api('/diag/models', { timeout: 30_000 })
            if (alive) setDiag(value ?? null)
          } catch { /* 诊断失败不影响页面 */ }
        }
        void loadDiag()
        return () => { alive = false }
      }, [ready])
      // A second poll loop, slow: the pack pushes nothing for accounts changed
      // in another window, and a stale count on this page is the kind of quiet
      // wrongness that reads as a bug. Local actions refresh immediately.
      useEffect(() => {
        if (!available) return undefined
        const timer = setInterval(() => { void loadStatus() }, 45_000)
        return () => clearInterval(timer)
      }, [available, loadStatus])

      // 全渠道一键领取：渠道包的 `credits.claimAll` 是**按 provider** 的接口，
      // 没有这个入口时用户要逐张卡片点 8 次。串起来之后按 `totalByUnit` 把
      // 积分与 Token 分开汇总 —— 那份数据本来就是分单位的，合写会把两种
      // 量纲加成一个数。放在 `loadStatus` 之后：依赖数组在渲染期求值，
      // 引用 TDZ 里的 const 会直接抛错。
      const [bulkClaim, setBulkClaim] = useState(undefined)
      const [bulkBusy, setBulkBusy] = useState(false)
      const claimEveryChannel = useCallback(async () => {
        if (!available || bulkBusy) return
        setBulkBusy(true); setBulkClaim(undefined)
        const totals = { providers: 0, claimed: 0, already: 0, inactive: 0, failed: 0, byUnit: { credit: 0, token: 0 }, errors: [] }
        try {
          for (const channel of CHANNEL_PROVIDERS) {
            const own = channel.own === true
            const capability = CHANNEL_CREDITS[channel.id]
            // 自有渠道不走渠道包的 `credits.claimAll`（它不认识这些 id），改逐账号打自己的路由。
            const ownClaimable = own && OWN_CLAIMABLE.has(channel.id)
            if (!capability?.claim && !ownClaimable) continue
            totals.providers += 1
            try {
              if (ownClaimable) {
                const rows = await api(`/channels/own?provider=${encodeURIComponent(channel.id)}`, { timeout: 20_000 })
                const list = (Array.isArray(rows?.accounts) ? rows.accounts : []).filter(row => row.enabled !== false)
                for (const row of list) {
                  try {
                    const value = await post('/channels/extra/claim', { provider: channel.id, accountId: row.id }, 240_000)
                    if (value?.kind === 'claimed') {
                      totals.claimed += 1
                      totals.byUnit.credit += Number(value.credit ?? 0) || 0
                    } else if (value?.kind === 'already-claimed') totals.already += 1
                    else if (value?.kind === 'inactive') totals.inactive += 1
                    else { totals.failed += 1; totals.errors.push(`${channel.name}: ${value?.message ?? '—'}`) }
                  } catch (failure) {
                    totals.failed += 1
                    totals.errors.push(`${channel.name}: ${String(failure?.message ?? failure)}`)
                  }
                }
                continue
              }
              const value = await rpc('credits.claimAll', { provider: channel.id }, 240_000)
              const summary = value?.summary ?? {}
              totals.claimed += Number(summary.claimed ?? 0) || 0
              totals.already += Number(summary.alreadyClaimed ?? 0) || 0
              totals.inactive += Number(summary.inactive ?? 0) || 0
              totals.failed += Number(summary.failed ?? 0) || 0
              const byUnit = summary.totalByUnit ?? {}
              totals.byUnit.credit += Number(byUnit.credit ?? 0) || 0
              totals.byUnit.token += Number(byUnit.token ?? 0) || 0
            } catch (failure) {
              totals.failed += 1
              totals.errors.push(`${channel.name}: ${String(failure?.message ?? failure)}`)
            }
          }
          setBulkClaim(totals)
          void loadStatus()
        } finally { setBulkBusy(false) }
      }, [available, bulkBusy, rpc, loadStatus, api])
      const bulkText = useMemo(() => {
        if (bulkClaim === undefined) return ''
        const parts = []
        if (bulkClaim.claimed > 0) {
          const amounts = claimAmountText({ totalByUnit: bulkClaim.byUnit }, 'credit', t)
          parts.push(t('chan.claim.result').replace('{count}', String(bulkClaim.claimed)).replace('{amounts}', amounts))
        }
        if (bulkClaim.already > 0) parts.push(t('chan.claim.all.already').replace('{already}', String(bulkClaim.already)))
        if (bulkClaim.inactive > 0) parts.push(t('chan.claim.inactive').replace('{count}', String(bulkClaim.inactive)).replace('；', ''))
        if (bulkClaim.failed > 0) parts.push(t('chan.claim.all.failed').replace('{failed}', String(bulkClaim.failed)))
        if (parts.length === 0) parts.push(t('chan.claim.none'))
        return parts.join('；')
      }, [bulkClaim, t])

      const onChanged = useCallback(() => {
        void loadStatus()
        try { window.dispatchEvent(new CustomEvent('ofm:channels')) } catch { /* no window */ }
      }, [loadStatus])

      const onError = useCallback((channel, err) => {
        const reason = String(err?.message ?? err)
        showToast({ title: t('chan.error').replace('{reason}', reason).slice(0, 120), body: channel.name, tone: 'warn' })
      }, [t])

      /**
       * 宿主清单对账：**这个面板渲染的卡片，宿主到底认不认**。
       *
       * 插件更新后没重启时，面板是新的（client.js 每次加载都从磁盘读）、宿主进程却
       * 还是旧的 —— 表现就是「新加的卡片点添加账号没反应」。判据由宿主算
       * （`/channels/manifest?expect=…` 回 `missing`），面板只负责显示，不自己抄一遍规则。
       */
      const [manifest, setManifest] = useState(undefined)
      // 取不到清单本身就是证据：**旧代码没有这条路由**（`GET /channels/manifest` 是本次
      // 新增的）。所以「请求失败」也要走同一条提示 —— 否则最需要它的那台机器恰好
      // 看不到提示（正是「宿主是旧代码」把提示藏了）。
      const [manifestMissingRoute, setManifestMissingRoute] = useState(false)
      useEffect(() => {
        if (!available) return undefined
        let alive = true
        const expect = CHANNEL_PROVIDERS.filter(row => row.own === true).map(row => row.id).join(',')
        void (async () => {
          try {
            const value = await api(`/channels/manifest?expect=${encodeURIComponent(expect)}`, { timeout: 15_000 })
            if (alive) { setManifest(value ?? null); setManifestMissingRoute(false) }
          } catch {
            if (alive) { setManifest(null); setManifestMissingRoute(true) }
          }
        })()
        return () => { alive = false }
      }, [available])
      const staleChannels = Array.isArray(manifest?.missing) ? manifest.missing : []

      /**
       * 热重载宿主（`POST /reload`）。
       *
       * 为什么放在这个页面上：插件更新后**宿主进程仍是旧代码**，而面板每次打开都
       * 从磁盘读新界面 —— 症状就是「新加的卡片点添加账号没反应」。这里给一次
       * 自助重载的机会（不用关掉整个 DSH），重载完自动刷新页面。
       */
      const [reloading, setReloading] = useState(false)
      const reloadHost = useCallback(async () => {
        if (reloading) return
        setReloading(true)
        try {
          await post('/reload', {}, 30_000)
          showToast({ title: t('chan.reload.done'), body: t('chan.reload.refresh'), tone: 'ok' })
          setTimeout(() => {
            try {
              if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') window.location.reload()
            } catch { /* 没有 location 的宿主就靠用户自己刷新 */ }
          }, 2500)
        } catch (error) {
          showToast({ title: t('chan.reload.failed').replace('{reason}', String(error?.message ?? error)), tone: 'warn' })
        } finally {
          setReloading(false)
        }
      }, [reloading, t, showToast])

      const connected = statuses === undefined ? 0 : CHANNEL_PROVIDERS.filter(row => (statuses[row.id]?.accounts?.enabled ?? 0) > 0).length
      /**
       * 已登录账号的渠道排前面（用户 2026-11-24 要求）。
       *
       * 只影响渲染顺序：状态来自同一份 `statuses`，未登录渠道保持原有相对顺序
       * （稳定排序 + 下标兜底），路由、账号与计数一概不动。
       */
      const orderedChannels = statuses === undefined
        ? CHANNEL_PROVIDERS
        : CHANNEL_PROVIDERS
          .map((channel, index) => ({
            channel,
            index,
            rank: (statuses[channel.id]?.accounts?.enabled ?? 0) > 0 ? 0 : 1,
          }))
          .sort((left, right) => left.rank - right.rank || left.index - right.index)
          .map(entry => entry.channel)
      const failed = !ready && pack.state === 'failed'

      return h('div', { className: 'ofm_page' },
        h('header', { className: 'ofm_hero ofm_glass' },
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' },
              h('h2', null, t('chan.title')),
              h('p', { className: 'ofm_pagesub' }, t('chan.sub'))),
            h('div', { className: 'ofm_pills' },
              h(Pill, { strong: true, tone: ready ? 'ok' : failed ? 'err' : 'warn' },
                ready ? `${connected}/${CHANNEL_PROVIDERS.length} ${t('chan.state.on')}` : t('chan.state.off')),
              h(Pill, null, `${t('chan.meta.accounts')} ${statuses === undefined ? '—' : CHANNEL_PROVIDERS.reduce((sum, row) => sum + (statuses[row.id]?.accounts?.enabled ?? 0), 0)}`))),
          auto == null ? null : h('div', { className: 'ofm_row' },
            h(Switch, { checked: auto.enabled === true, label: t('chan.auto.title'), onChange: () => void toggleAuto() }),
            h(Pill, { tone: auto.running === true ? 'warn' : auto.ranToday === true ? 'ok' : '' },
              auto.running === true ? t('chan.auto.running') : auto.ranToday === true ? t('chan.auto.ran') : t('chan.auto.off')),
            typeof auto.lastResult === 'string' && auto.lastResult !== '' ? h('span', { className: 'ofm_note', title: auto.lastResult }, t('chan.auto.last').replace('{result}', auto.lastResult.length > 60 ? `${auto.lastResult.slice(0, 60)}…` : auto.lastResult)) : null,
            // 默认值来自渠道包（`enabled: true`），不是本插件的选择 —— 用户有权
            // 在第一次看到它时就知道自己在被动领取。
            h('span', { className: 'ofm_note' }, t('chan.auto.defaultOn')),
            h('button', {
              type: 'button', className: 'ofm_btn ghost', disabled: !available || bulkBusy || !ready,
              'aria-busy': bulkBusy ? 'true' : undefined,
              onClick: () => void claimEveryChannel(),
            }, bulkBusy ? t('chan.claim.all.running') : t('chan.claim.all')))),
        bulkText !== '' ? h('p', { className: 'ofm_note', role: 'status' }, bulkText) : null,
        // 宿主是旧代码：面板渲染的渠道它不认识。**说清动作**（重启 DSH），
        // 而不是让用户对着「按钮没反应」猜。
        // 宿主是旧代码：面板渲染的渠道它不认识（或它连清单接口都没有）。**说清动作**
        // （热重载 / 重启），而不是让用户对着「按钮没反应」猜。
        staleChannels.length === 0 && manifestMissingRoute === false ? null : h('div', { className: 'ofm_callout ofm_error', role: 'alert' },
          h('div', null,
            manifestMissingRoute
              ? t('chan.manifest.missing')
              : t('chan.manifest.stale').replace('{missing}', staleChannels.join('、')),
            h('div', { className: 'ofm_note' }, t('chan.manifest.staleHint')),
            h('button', {
              type: 'button', className: 'ofm_btn primary', disabled: reloading || !available,
              'aria-busy': reloading ? 'true' : undefined, onClick: () => void reloadHost(),
            }, reloading ? t('reload.reloading') : t('reload.now')))),
        failed ? h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, t('chan.pack.failed').replace('{reason}', pack.error ?? ''), h('div', { className: 'ofm_note' }, t('chan.pack.hint')))) : null,
        !available ? h('div', { className: 'ofm_callout' }, h('div', null, t('chan.rpc.unavailable'))) : null,
        !ready ? h('div', { className: 'ofm_chanwrap' },
          [0, 1, 2].map(index => h('div', { className: 'ofm_skel', key: index, style: { minHeight: 168 } }))) : null,
        ready ? h('div', { className: 'ofm_chanwrap' }, orderedChannels.map(channel => h(ChannelCard, {
          key: channel.id,
          channel,
          status: statuses?.[channel.id],
          rpc: available ? rpc : null,
          t,
          onError,
          onChanged,
        }))) : null,
        error !== '' && !failed ? h('p', { className: 'ofm_note' }, `${t('chan.error').replace('{reason}', error)}`) : null,
        // 链路诊断一行：宿主 `llm.listModels()` 过滤后的真实条数。
        // 「改了表看不到变化」这类问题，看一眼这行就知道是宿主没给、还是界面没刷。
        ready && diag !== null && Array.isArray(diag?.packProviders)
          ? h('p', { className: 'ofm_note ofm_scanline', title: t('chan.diag.hint') },
            t('chan.diag.host').replace('{rows}', diag.packProviders.filter(row => row.count > 0).map(row => `${row.provider} ${row.count}`).join(' · ') || '—'),
            ' · ',
            t('chan.diag.own').replace('{count}', String(diag.ownRows ?? 0)))
          : null)
    }

    // ── 数据看板 / 运行日志 / 网关设置 ────────────────────────────────────────
    // The absorbed pack keeps a per-request token ledger (channel → provider →
    // account → model trees, plus a ring of individual requests). These three
    // pages are its reading surface, modelled on the standalone gateway
    // consoles users already know: KPI cards, an account pivot, a model
    // performance table, a paginated request log and the gateway's switches.
    const LEDGER_EMPTY = () => ({ requests: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, errors: 0 })

    /** Weighted merge of tree rows: averages are re-weighted by request count
     *  so a cross-day or cross-account merge never pretends a heavy day and a
     *  light day average to their mean. */
    function mergeLedgerRows(rows) {
      const out = LEDGER_EMPTY()
      let ttftSum = 0; let ttftN = 0; let tpsSum = 0; let tpsN = 0
      for (const row of rows) {
        out.requests += row.requests ?? 0
        out.reportedRequests += row.reportedRequests ?? 0
        out.inputTokens += row.inputTokens ?? 0
        out.outputTokens += row.outputTokens ?? 0
        out.cacheReadTokens += row.cacheReadTokens ?? 0
        out.cacheWriteTokens += row.cacheWriteTokens ?? 0
        out.reasoningTokens += row.reasoningTokens ?? 0
        out.errors += row.errors ?? 0
        if (Number.isFinite(row.avgTtftMs) && (row.requests ?? 0) > 0) { ttftSum += row.avgTtftMs * row.requests; ttftN += row.requests }
        if (Number.isFinite(row.avgTps) && (row.requests ?? 0) > 0) { tpsSum += row.avgTps * row.requests; tpsN += row.requests }
      }
      out.avgTtftMs = ttftN > 0 ? Math.round(ttftSum / ttftN) : null
      out.avgTps = tpsN > 0 ? Math.round((tpsSum / tpsN) * 10) / 10 : null
      return out
    }

    /** Flatten the channel→provider→account tree into account rows. */
    function ledgerAccountRows(channels) {
      const rows = []
      for (const ch of channels ?? []) {
        for (const provider of ch.providers ?? []) {
          for (const account of provider.accounts ?? []) {
            rows.push({ channel: ch.channel, provider: provider.provider, accountId: account.accountId, ...mergeLedgerRows([account.totals ?? {}]), models: account.models ?? [] })
          }
        }
      }
      return rows
    }

    /** Aggregate the same tree into per-model rows (across accounts). */
    function ledgerModelRows(channels) {
      const map = new Map()
      for (const ch of channels ?? []) {
        for (const provider of ch.providers ?? []) {
          for (const account of provider.accounts ?? []) {
            for (const model of account.models ?? []) {
              const key = model.model
              const row = map.get(key) ?? { model: key, providers: new Set(), rows: [] }
              row.providers.add(provider.provider)
              row.rows.push(model)
              map.set(key, row)
            }
          }
        }
      }
      return [...map.values()].map(row => ({ model: row.model, providers: [...row.providers], ...mergeLedgerRows(row.rows) }))
    }

    /** Flatten history days into one merged tree (the 全部历史 view). */
    function mergedHistoryChannels(days) {
      const map = new Map()
      for (const day of days ?? []) {
        for (const ch of day.channels ?? []) {
          const slot = map.get(ch.channel) ?? { channel: ch.channel, providers: [] }
          for (const provider of ch.providers ?? []) {
            let pslot = slot.providers.find(row => row.provider === provider.provider)
            if (pslot === undefined) { pslot = { provider: provider.provider, accounts: [] }; slot.providers.push(pslot) }
            for (const account of provider.accounts ?? []) {
              let aslot = pslot.accounts.find(row => row.accountId === account.accountId)
              if (aslot === undefined) { aslot = { accountId: account.accountId, models: [] }; pslot.accounts.push(aslot) }
              aslot.models.push(...(account.models ?? []))
            }
          }
          map.set(ch.channel, slot)
        }
      }
      // Re-aggregate the piled-up model lists into proper totals per account.
      for (const ch of map.values()) {
        for (const provider of ch.providers) {
          for (const account of provider.accounts) {
            const byModel = new Map()
            for (const model of account.models) {
              const row = byModel.get(model.model) ?? { model: model.model, rows: [] }
              row.rows.push(model); byModel.set(model.model, row)
            }
            account.models = [...byModel.values()].map(row => ({ model: row.model, ...mergeLedgerRows(row.rows) }))
            account.totals = mergeLedgerRows(account.models)
          }
        }
      }
      return [...map.values()]
    }

    function todayKey() {
      const now = new Date()
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    }

    const fmtInt = value => Number.isFinite(value) ? value.toLocaleString() : '—'
    const fmtPct = (part, whole) => whole > 0 ? `${Math.round(100 * part / whole)}%` : '—'
    const fmtMs = value => Number.isFinite(value) && value > 0 ? `${value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`}` : '—'
    const fmtTps = value => Number.isFinite(value) && value > 0 ? `${value.toFixed(1)} tok/s` : '—'

    function useLedger(props) {
      const { available, rpc } = useChannelRpc(props.ctx)
      const [state, setState] = useState({ status: 'loading', history: [], snapshot: null, error: '' })
      const load = useCallback(async () => {
        if (!available) { setState(current => ({ ...current, status: 'unavailable', error: 'no-connection' })); return }
        try {
          const [ledger, history] = await Promise.all([
            rpc('usage.tokenLedger', { limit: 400 }, 60_000),
            rpc('usage.tokenLedgerHistory', { sinceDays: 90 }, 60_000),
          ])
          setState({ status: 'ready', snapshot: ledger?.snapshot ?? null, history: history?.history ?? [], totals: history?.totals ?? null, error: '' })
        } catch (error) { setState(current => ({ ...current, status: 'error', error: String(error?.message ?? error) })) }
      }, [available, rpc])
      useEffect(() => { void load() }, [load])
      return { ...state, reload: load }
    }

    /** KPI cards: one reading per card, exactly like the gateway consoles. */
    function KpiCard(props) {
      const { label, value, sub, tone } = props
      return h('div', { className: `ofm_kpi ofm_glass${tone ? ` ${tone}` : ''}` },
        h('span', { className: 'ofm_kpilabel' }, label),
        h('b', { className: 'ofm_kpivalue' }, value),
        sub === undefined ? null : h('span', { className: 'ofm_kpisub' }, sub))
    }

    function LedgerPage(props) {
      const { t, ctx } = props
      const ledger = useLedger(props)
      const [scope, setScope] = useState('today')
      const loaded = ledger.status === 'ready'
      // 今日 = the pack's live snapshot (its in-memory day tree); 全部 = the
      // persisted day aggregation, merged back into one tree. The grand
      // cumulative number always reads the history total — even on 今日 —
      // because "累计" that resets at midnight is a lie.
      const channels = scope === 'today'
        ? (ledger.snapshot?.channels ?? [])
        : mergedHistoryChannels(ledger.history)
      const totals = scope === 'today'
        ? mergeLedgerRows([ledger.snapshot?.totals ?? {}])
        : mergeLedgerRows((ledger.history ?? []).map(day => day.totals ?? {}))
      const cumulative = ledger.totals ?? ledger.snapshot?.totals ?? {}
      const accounts = ledgerAccountRows(channels)
      const models = ledgerModelRows(channels).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
      // The pack's ring is already newest-first (`token-ledger.ts`: "最近明细
      // （最新在前）", built with `unshift`), so it is used as served. Reversing it
      // here put the oldest request at the top of the table — and, behind the log
      // page's pagination, the request the user just made on the last page.
      const entries = ledger.snapshot?.entries ?? []
      const tokenTotal = totals.inputTokens + totals.outputTokens
      const cacheBase = totals.inputTokens + totals.cacheReadTokens

      if (ledger.status === 'unavailable') {
        return h('div', { className: 'ofm_page' },
          h(PageHero, { title: t('dash.title'), sub: t('dash.sub') }),
          h('div', { className: 'ofm_callout' }, h('div', null, t('chan.rpc.unavailable'))))
      }
      return h('div', { className: 'ofm_page' },
        h(PageHero, { t, titleKey: 'dash.title', subKey: 'dash.sub' },
          h('div', { className: 'ofm_seg', role: 'tablist' },
            ['today', 'all'].map(key => h('button', {
              key, type: 'button', 'aria-pressed': scope === key ? 'true' : 'false',
              onClick: () => setScope(key),
            }, key === 'today' ? t('dash.today') : t('dash.all')))),
          h(Button, { onClick: () => void ledger.reload() }, t('dash.refresh'))),
        !loaded ? h('div', { className: 'ofm_chanwrap' }, [0, 1, 2].map(i => h('div', { className: 'ofm_skel', key: i, style: { minHeight: 120 } }))) : null,
        loaded ? h('div', { className: 'ofm_kpis' },
          h(KpiCard, { label: scope === 'today' ? t('dash.kpiToday') : t('dash.kpiScopeAll'), value: fmtInt(tokenTotal), sub: `${t('dash.input')} ${fmtInt(totals.inputTokens)} · ${t('dash.output')} ${fmtInt(totals.outputTokens)} · ${t('dash.reasoning')} ${fmtInt(totals.reasoningTokens)}` }),
          h(KpiCard, { label: t('dash.kpiCumulative'), value: fmtInt((cumulative.inputTokens ?? 0) + (cumulative.outputTokens ?? 0)), sub: `${t('dash.input')} ${fmtInt(cumulative.inputTokens)} · ${t('dash.output')} ${fmtInt(cumulative.outputTokens)} · ${t('dash.reasoning')} ${fmtInt(cumulative.reasoningTokens)}` }),
          h(KpiCard, { label: t('dash.kpiSpeed'), value: fmtTps(totals.avgTps), sub: `${t('dash.ttft')} ${fmtMs(totals.avgTtftMs)}` }),
          h(KpiCard, { label: t('dash.kpiCache'), value: fmtPct(totals.cacheReadTokens, cacheBase), sub: `${t('dash.cacheTokens')} ${fmtInt(totals.cacheReadTokens)}` }),
          h(KpiCard, { label: t('dash.kpiRequests'), value: fmtInt(totals.requests), sub: `${t('dash.successRate')} ${fmtPct(totals.requests - totals.errors, totals.requests)} · ${t('dash.failed')} ${fmtInt(totals.errors)}`, tone: totals.errors > 0 ? 'warn' : '' })) : null,
        loaded ? h(Section, { title: t('dash.recentTitle'), hint: t('dash.recentHint') },
          entries.length === 0 ? h('p', { className: 'ofm_note' }, t('dash.empty'))
            : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
                h('thead', null, h('tr', null,
                h('th', { key: 'time' }, t('log.time')),
                h('th', { key: 'chan' }, t('chan.titleSingle')),
                h('th', { key: 'model' }, t('log.model')),
                h('th', { key: 'account' }, t('log.account')),
                h('th', { key: 'via' }, t('log.via')),
                h('th', { key: 'result' }, t('log.result')),
                h('th', { key: 'duration' }, t('log.duration')),
                h('th', { key: 'ttft' }, t('log.ttft')),
                h('th', { key: 'speed' }, t('log.speed')),
                h('th', { key: 'input' }, t('log.input')),
                h('th', { key: 'output' }, t('log.output')),
                h('th', { key: 'reasoning' }, t('log.reasoning')),
                h('th', { key: 'cache' }, t('log.cache')),
                h('th', { key: 'total' }, t('log.total')))),
              h('tbody', null, entries.slice(0, 12).map((entry, index) => h('tr', { key: index },
                h('td', null, new Date(entry.ts).toLocaleString()),
                h('td', null, entry.provider),
                h('td', null, entry.model),
                h('td', null, entry.accountId || '—'),
                h('td', null, entry.channel === 'gateway' ? t('log.viaGateway') : t('log.viaDirect')),
                h('td', null, entry.error ? h('span', { className: 'ofm_badge unavailable', title: entry.error }, t('log.failed')) : h('span', { className: 'ofm_badge available' }, t('log.ok'))),
                h('td', { className: 'ofm_num' }, fmtMs(entry.durationMs)),
                h('td', { className: 'ofm_num' }, fmtMs(entry.ttftMs)),
                h('td', { className: 'ofm_num' }, fmtTps(entry.tps)),
                h('td', { className: 'ofm_num' }, fmtInt(entry.inputTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(entry.outputTokens)),
                h('td', { className: 'ofm_num' }, Number.isFinite(entry.reasoningTokens) ? fmtInt(entry.reasoningTokens) : '—'),
                h('td', { className: 'ofm_num' }, Number.isFinite(entry.cacheReadTokens) ? fmtInt(entry.cacheReadTokens) : '—'),
                h('td', { className: 'ofm_num' }, h('b', null, fmtInt(entry.inputTokens + entry.outputTokens))))))))) : null,
        loaded ? h(Section, { title: t('dash.accountsTitle'), hint: t('dash.accountsHint') },
          accounts.length === 0 ? h('p', { className: 'ofm_note' }, t('dash.empty'))
            : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
              h('thead', null, h('tr', null,
                h('th', { key: 'account' }, t('log.account')),
                h('th', { key: 'chan' }, t('chan.titleSingle')),
                h('th', { key: 'requests' }, t('log.requests')),
                h('th', { key: 'total' }, t('log.total')),
                h('th', { key: 'input' }, t('log.input')),
                h('th', { key: 'output' }, t('log.output')),
                h('th', { key: 'reasoning' }, t('log.reasoning')),
                h('th', { key: 'cache' }, t('log.cache')),
                h('th', { key: 'mix' }, t('log.modelMix')))),
              h('tbody', null, accounts.sort((a, b) => b.requests - a.requests).map((row, index) => h('tr', { key: index },
                h('td', null, h('b', null, row.accountId || t('log.unattributed'))),
                h('td', null, row.provider),
                h('td', { className: 'ofm_num' }, fmtInt(row.requests)),
                h('td', { className: 'ofm_num' }, fmtInt(row.inputTokens + row.outputTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(row.inputTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(row.outputTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(row.reasoningTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(row.cacheReadTokens)),
                h('td', null, (row.models ?? []).slice().sort((a, b) => ((b.inputTokens ?? 0) + (b.outputTokens ?? 0)) - ((a.inputTokens ?? 0) + (a.outputTokens ?? 0))).slice(0, 2).map(model => `${model.model} · ${fmtInt((model.inputTokens ?? 0) + (model.outputTokens ?? 0))}`).join('，') || '—'))))))) : null,
        loaded ? h(Section, { title: t('dash.modelsTitle'), hint: t('dash.modelsHint') },
          models.length === 0 ? h('p', { className: 'ofm_note' }, t('dash.empty'))
            : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
              h('thead', null, h('tr', null,
                h('th', { key: 'model' }, t('log.model')),
                h('th', { key: 'chan' }, t('chan.titleSingle')),
                h('th', { key: 'requests' }, t('log.requests')),
                h('th', { key: 'failed' }, t('log.failed')),
                h('th', { key: 'total' }, t('log.total')),
                h('th', { key: 'slash' }, t('log.inputSlash')),
                h('th', { key: 'ttft' }, t('log.ttft')),
                h('th', { key: 'speed' }, t('log.speed')),
                h('th', { key: 'hit' }, t('log.cacheHit')),
                h('th', { key: 'share' }, t('log.share')))),
              h('tbody', null, models.map(row => h('tr', { key: row.model },
                h('td', null, h('b', null, row.model)),
                h('td', null, row.providers.join('，')),
                h('td', { className: 'ofm_num' }, fmtInt(row.requests)),
                h('td', { className: 'ofm_num' }, row.errors > 0 ? h('span', { className: 'ofm_badge unavailable' }, fmtInt(row.errors)) : fmtInt(0)),
                h('td', { className: 'ofm_num' }, fmtInt(row.inputTokens + row.outputTokens)),
                h('td', { className: 'ofm_num' }, `${fmtInt(row.inputTokens)} / ${fmtInt(row.outputTokens)} / ${fmtInt(row.reasoningTokens)}`),
                h('td', { className: 'ofm_num' }, fmtMs(row.avgTtftMs)),
                h('td', { className: 'ofm_num' }, fmtTps(row.avgTps)),
                h('td', { className: 'ofm_num' }, fmtPct(row.cacheReadTokens, row.inputTokens + row.cacheReadTokens)),
                h('td', { className: 'ofm_num' }, `${fmtPct(row.inputTokens + row.outputTokens, tokenTotal)}`))))))) : null)
    }

    /** The log page: the same request ring, at full width and full detail. */
    function LogsPage(props) {
      const { t, ctx } = props
      const ledger = useLedger(props)
      const [pageSize, setPageSize] = useState(20)
      const [auto, setAuto] = useState(false)
      const reload = ledger.reload
      useEffect(() => {
        if (auto !== true) return undefined
        const timer = setInterval(() => { void reload() }, 10_000)
        return () => clearInterval(timer)
      }, [auto, reload])
      // Newest first, as the pack serves it — see the note in LedgerPage.
      const entries = ledger.snapshot?.entries ?? []
      const pages = Math.max(1, Math.ceil(entries.length / pageSize))
      const [page, setPage] = useState(1)
      const safePage = Math.min(page, pages)
      const rows = entries.slice((safePage - 1) * pageSize, safePage * pageSize)
      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('logs.title'), sub: t('logs.sub') },
          h('div', { className: 'ofm_seg' }, [10, 20, 50, 100].map(size => h('button', {
            key: size, type: 'button', 'aria-pressed': pageSize === size ? 'true' : 'false',
            onClick: () => { setPageSize(size); setPage(1) },
          }, String(size)))),
          h(Switch, { checked: auto, label: t('logs.auto'), onChange: () => setAuto(value => !value) }),
          h(Button, { onClick: () => void reload() }, t('dash.refresh'))),
        ledger.status === 'unavailable' ? h('div', { className: 'ofm_callout' }, h('div', null, t('chan.rpc.unavailable'))) : null,
        ledger.status === 'loading' ? h('div', { className: 'ofm_skel', style: { minHeight: 200 } }) : null,
        ledger.status === 'ready' ? h(Section, {
          title: t('logs.title'),
          hint: t('logs.count').replace('{shown}', String(rows.length)).replace('{total}', String(entries.length)),
        },
          entries.length === 0 ? h('p', { className: 'ofm_note' }, t('logs.empty'))
            : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
              h('thead', null, h('tr', null,
                h('th', { key: 'time' }, t('log.time')),
                h('th', { key: 'chan' }, t('chan.titleSingle')),
                h('th', { key: 'model' }, t('log.model')),
                h('th', { key: 'account' }, t('log.account')),
                h('th', { key: 'via' }, t('log.via')),
                h('th', { key: 'result' }, t('log.result')),
                h('th', { key: 'duration' }, t('log.duration')),
                h('th', { key: 'ttft' }, t('log.ttft')),
                h('th', { key: 'speed' }, t('log.speed')),
                h('th', { key: 'input' }, t('log.input')),
                h('th', { key: 'output' }, t('log.output')),
                h('th', { key: 'reasoning' }, t('log.reasoning')),
                h('th', { key: 'cache' }, t('log.cache')),
                h('th', { key: 'total' }, t('log.total')))),
              h('tbody', null, rows.map((entry, index) => h('tr', { key: index, className: entry.error ? 'ofm_logfailed' : '' },
                h('td', null, new Date(entry.ts).toLocaleString()),
                h('td', null, entry.provider),
                h('td', null, entry.model),
                h('td', null, entry.accountId || '—'),
                h('td', null, entry.channel === 'gateway' ? t('log.viaGateway') : t('log.viaDirect')),
                h('td', null, entry.error ? h('span', { className: 'ofm_badge unavailable', title: entry.error }, t('log.failed')) : h('span', { className: 'ofm_badge available' }, t('log.ok'))),
                h('td', { className: 'ofm_num' }, fmtMs(entry.durationMs)),
                h('td', { className: 'ofm_num' }, fmtMs(entry.ttftMs)),
                h('td', { className: 'ofm_num' }, fmtTps(entry.tps)),
                h('td', { className: 'ofm_num' }, fmtInt(entry.inputTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(entry.outputTokens)),
                h('td', { className: 'ofm_num' }, Number.isFinite(entry.reasoningTokens) ? fmtInt(entry.reasoningTokens) : '—'),
                h('td', { className: 'ofm_num' }, Number.isFinite(entry.cacheReadTokens) ? fmtInt(entry.cacheReadTokens) : '—'),
                h('td', { className: 'ofm_num' }, h('b', null, fmtInt(entry.inputTokens + entry.outputTokens)))))))),
          pages > 1 ? h('div', { className: 'ofm_row' },
            h(Button, { kind: 'ghost', disabled: safePage <= 1, onClick: () => setPage(value => Math.max(1, value - 1)) }, '‹'),
            h('span', { className: 'ofm_note' }, t('logs.page').replace('{page}', String(safePage)).replace('{pages}', String(pages))),
            h(Button, { kind: 'ghost', disabled: safePage >= pages, onClick: () => setPage(value => Math.min(pages, value + 1)) }, '›')) : null,
          h('p', { className: 'ofm_note' }, t('logs.windowNote'))) : null)
    }

    /**
     * 「对外入口」面板 —— 网关只暴露一个名字，内部自动挑人、重试、换人。
     *
     * 表单不自动保存：改名会把客户端已写死的 `model` 变成 404，所以保存是一次显式
     * 动作，保存后由 `renamed` 回执提醒旧名字已失效。其余开关（策略、隐藏、重试
     * 次数）同样走保存，避免半改状态下网关行为与面板显示不一致。
     */
    function ForwardPoolPage(props) {
      const { t } = props
      const panel = usePanel(() => api('/forward-pool'), [])
      const pool = panel.data?.pool ?? { enabled: false, name: 'auto', members: [], strategy: 'smart', stickyLimit: 1, memberRetries: 0, hideOthers: true }
      const members = panel.data?.members ?? []
      const resolved = panel.data?.resolved ?? []
      const example = panel.data?.example ?? { model: pool.name, endpoint: '/v1/chat/completions' }
      const [draft, setDraft] = useState(null)
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      // Per-member live probe: id -> {busy, ok, message, ttftMs}
      const [memberProbes, setMemberProbes] = useState({})
      useEffect(() => { if (panel.data !== undefined) setDraft({ ...pool, members: [...pool.members] }) }, [
        panel.data?.pool?.name, panel.data?.pool?.enabled, panel.data?.pool?.strategy,
        panel.data?.pool?.hideOthers, panel.data?.pool?.memberRetries, panel.data?.pool?.stickyLimit,
        JSON.stringify(panel.data?.pool?.members),
      ])
      const lanes = LANE_LABEL(t)
      const byId = new Map(members.map(row => [row.id, row]))
      const chosen = draft?.members ?? []
      const needle = query.trim().toLowerCase()
      // No truncation: the host-lane rows live past the first few dozen entries,
      // and slicing at 80 made them unreachable by search (the filter ran first,
      // then the cut, so a 300-model host still only showed 80 matches).
      const rows = members.filter(row => needle === ''
        || `${row.id} ${row.name ?? ''} ${row.provider ?? ''}`.toLowerCase().includes(needle))
      // 分组展示：模型列表现在混着免费/聚合/自有/宿主四类，平铺时同名模型
      // 无法分辨、勾选也容易点错。按渠道分组后每组有标题和计数，行内只剩
      // 真正用于区分的字段（provider / 预置 vs 已发现 / 今日统计）。
      const groupRank = channel => {
        const index = ['free', 'aggregate', 'own', 'host'].indexOf(channel)
        return index < 0 ? 99 : index
      }
      const grouped = (() => {
        const map = new Map()
        for (const row of rows) {
          const key = row.channel ?? 'free'
          if (!map.has(key)) map.set(key, [])
          map.get(key).push(row)
        }
        return [...map.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]) || a[0].localeCompare(b[0]))
      })()
      // 一行一张卡：勾选标记 + 名称，第二行只放用于区分的信息。
      const pickRow = row => h('button', {
        key: row.id, type: 'button', className: 'ofm_pickrow', disabled: busy,
        'aria-pressed': chosen.includes(row.id) ? 'true' : 'false',
        onClick: () => toggle(row.id),
      },
      h('span', { className: 'ofm_pickhead' },
        h('span', { className: 'ofm_pickmark', 'aria-hidden': 'true' }, chosen.includes(row.id) ? '✓' : '＋'),
        h('b', { title: row.name }, row.name ?? row.id)),
      h('span', { className: 'ofm_pickmeta' },
        h('span', { className: 'ofm_id' }, row.id),
        row.provider ? h('span', { className: 'ofm_tag' }, row.provider) : null,
        row.vision === true ? h('span', { className: 'ofm_tag' }, t('tag.vision')) : null,
        row.source === 'registry' ? h('span', { className: 'ofm_tag ofm_tagwarn', title: t('pool.sourceRegistryHint') }, t('pool.sourceRegistry')) : null,
        row.source === 'discovered' ? h('span', { className: 'ofm_tag' }, t('pool.sourceDiscovered')) : null,
        row.today === null || row.today === undefined ? null
          : h('span', { className: 'ofm_note' }, t('pool.todayShort')
            .replace('{calls}', String(row.today.calls)).replace('{failed}', String(row.today.failed)))))
      const picker = rows.length === 0
        ? h('p', { className: 'ofm_note' }, t('pool.noModel'))
        : h('div', { className: 'ofm_pickgroups' }, grouped.map(([channel, list]) => h('div', {
            key: channel, className: 'ofm_pickgroup',
          },
          h('div', { className: 'ofm_pickgrouphead' },
            h('b', null, lanes[channel] ?? channel),
            h('span', { className: 'ofm_note' }, t('pool.groupCount').replace('{n}', String(list.length)))),
          h('div', { className: 'ofm_picklist' }, list.map(pickRow)))))
      const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify({ ...pool, members: pool.members })

      const toggle = id => setDraft(current => current === null ? current : {
        ...current,
        members: current.members.includes(id) ? current.members.filter(item => item !== id) : [...current.members, id],
      })
      const move = (index, delta) => setDraft(current => {
        if (current === null) return current
        const next = [...current.members]
        const target = index + delta
        if (target < 0 || target >= next.length) return current
        const [row] = next.splice(index, 1)
        next.splice(target, 0, row)
        return { ...current, members: next }
      })
      // 真实调用一次这个成员：池能否用，取决于成员本身是活的。空流成员和
      // 永不响应的成员会把一次正常请求拖到客户端超时，而用户只看到「流为空」。
      const probeMember = async id => {
        setMemberProbes(current => ({ ...current, [id]: { busy: true, message: '' } }))
        try {
          const answer = await post('/forward-pool/test', { memberId: id }, 130_000)
          setMemberProbes(current => ({
            ...current,
            [id]: { busy: false, ok: answer.ok === true, message: String(answer.message ?? ''), ttftMs: Number(answer.ttftMs) || 0 },
          }))
        } catch (failure) {
          setMemberProbes(current => ({ ...current, [id]: { busy: false, ok: false, message: String(failure?.message ?? failure), ttftMs: 0 } }))
        }
      }
      const submit = async () => {
        if (draft === null) return
        setBusy(true); setError(''); setNotice('')
        try {
          // `post()` (not `api()` with a raw object body): fetch would stringify
          // the object to "[object Object]", the host's readJson would reject it
          // with 400 and nothing would ever be written to disk.
          const result = await post('/forward-pool', {
            enabled: draft.enabled === true,
            name: draft.name,
            members: draft.members,
            strategy: draft.strategy,
            stickyLimit: Number(draft.stickyLimit) || 1,
            memberRetries: Number(draft.memberRetries) || 0,
            hideOthers: draft.hideOthers !== false,
          })
          // Merge the host's authoritative answer first: if the follow-up GET
          // fails (route error, dropped connection), the panel still shows what
          // was actually written instead of snapping back to the old draft.
          if (result?.pool !== undefined) panel.patch({ pool: result.pool, resolved: result.resolved ?? [] })
          panel.reload()
          setNotice(result?.renamed
            ? t('pool.savedRenamed').replace('{from}', result.renamed.from).replace('{to}', result.renamed.to)
            : t('pool.saved'))
        } catch (failure) { setError(String(failure?.message ?? failure)) } finally { setBusy(false) }
      }

      return h(Section, { title: t('section.pool'), hint: t('section.poolHint') },
        panel.status === 'loading'
          ? h('p', { className: 'ofm_note' }, t('common.loading'))
          : h(Fragment, null,
            draft === null ? null : h(Fragment, null,
              h('div', { className: 'ofm_row' },
                h('div', { className: 'ofm_field', style: { flex: '1 1 180px' } },
                  h('span', null, t('pool.name')),
                  h('input', {
                    className: 'ofm_input', value: draft.name, placeholder: 'auto', disabled: busy,
                    onChange: event => setDraft({ ...draft, name: event.target.value }),
                  }),
                  h('span', { className: 'ofm_note' }, t('pool.nameHint').replace('{id}', `pool:${String(draft.name || 'auto').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`))),
                h(Switch, {
                  checked: draft.enabled === true, label: t('pool.enabled'), disabled: busy,
                  onChange: () => { if (!busy) setDraft({ ...draft, enabled: draft.enabled !== true }) },
                })),
              h('div', { className: 'ofm_row' },
                h('div', { className: 'ofm_field' },
                  h('span', null, t('pool.strategy')),
                  h('div', { className: 'ofm_seg', role: 'group' },
                    [['smart', 'pool.strategySmart'], ['fallback', 'pool.strategyFallback'], ['round-robin', 'pool.strategyRoundRobin']].map(([id, key]) => h('button', {
                      key: id, type: 'button', disabled: busy,
                      'aria-pressed': draft.strategy === id ? 'true' : 'false',
                      onClick: () => setDraft({ ...draft, strategy: id }),
                    }, t(key))))),
                draft.strategy === 'round-robin' ? h('div', { className: 'ofm_field' },
                  h('span', null, t('pool.stickyLimit')),
                  h('input', {
                    className: 'ofm_input', type: 'number', min: '1', value: String(draft.stickyLimit ?? 1), disabled: busy,
                    onChange: event => setDraft({ ...draft, stickyLimit: event.target.value }),
                  })) : null,
                h('div', { className: 'ofm_field' },
                  h('span', null, t('pool.memberRetries')),
                  h('input', {
                    className: 'ofm_input', type: 'number', min: '0', max: '5', value: String(draft.memberRetries ?? 0), disabled: busy,
                    onChange: event => setDraft({ ...draft, memberRetries: event.target.value }),
                  }))),
              h('div', { className: 'ofm_field' },
                h(Switch, {
                  checked: draft.hideOthers !== false, label: t('pool.hideOthers'), disabled: busy,
                  onChange: () => { if (!busy) setDraft({ ...draft, hideOthers: draft.hideOthers === false }) },
                }),
                h('span', null, t('pool.hideOthersHint'))),

              h('div', { className: 'ofm_paneltitle' }, t('pool.membersTitle').replace('{n}', String(chosen.length))),
              chosen.length === 0
                ? h('p', { className: 'ofm_note' }, t('pool.membersEmpty'))
                : h('div', { className: 'ofm_chainlist' }, chosen.map((id, index) => {
                  const row = byId.get(id)
                  const usable = resolved.includes(id)
                  const probe = memberProbes[id] ?? {}
                  return h('div', { key: id, className: 'ofm_chainrow', style: usable ? undefined : { opacity: 0.55 } },
                    h('span', { className: 'ofm_chainno' }, String(index + 1)),
                    h('span', { className: 'ofm_pickhead' }, h('b', { title: row?.name ?? id }, row?.name ?? id),
                      h('span', { className: 'ofm_id' }, id)),
                    h('span', { className: 'ofm_pickmeta' },
                      h('span', { className: 'ofm_tag' }, lanes[row?.channel] ?? row?.channel ?? ''),
                      row?.provider ? h('span', { className: 'ofm_tag' }, row.provider) : null,
                      row?.today === null || row?.today === undefined ? null
                        : h('span', { className: 'ofm_note' }, t('pool.todayStats')
                          .replace('{calls}', String(row.today.calls))
                          .replace('{failed}', String(row.today.failed))
                          .replace('{ttft}', row.today.meanTtftMs === null ? '—' : `${row.today.meanTtftMs}ms`)),
                      usable ? null : h('span', { className: 'ofm_tag', title: t('pool.unavailableHint') }, t('pool.unavailable')),
                      probe.busy === true
                        ? h('span', { className: 'ofm_note' }, t('pool.probing'))
                        : probe.ok === true
                          ? h('span', { className: 'ofm_tag', title: probe.message }, `${t('pool.probeOk')} ${probe.ttftMs}ms`)
                          : probe.ok === false
                            ? h('span', { className: 'ofm_tag ofm_tagwarn', title: probe.message }, t('pool.probeFail'))
                            : null),
                    h('span', { className: 'ofm_row', style: { marginLeft: 'auto' } },
                      miniBtn(t('pool.testMember'), () => void probeMember(id), { disabled: probe.busy === true || busy, title: t('pool.testMemberHint') }),
                      miniBtn('↑', () => move(index, -1), { disabled: index === 0 || busy }),
                      miniBtn('↓', () => move(index, 1), { disabled: index === chosen.length - 1 || busy }),
                      miniBtn('×', () => toggle(id), { danger: true, disabled: busy })))
                })),

              h('div', { className: 'ofm_row' },
                h('div', { className: 'ofm_field', style: { flex: '1 1 200px' } },
                  h('span', null, t('pool.addMember')),
                  h('input', {
                    className: 'ofm_input', value: query, placeholder: t('pool.searchModel'), disabled: busy,
                    onChange: event => setQuery(event.target.value),
                  })),
                h('span', { className: 'ofm_note', style: { marginLeft: 'auto' } },
                  t('pool.selectedCount').replace('{n}', String(chosen.length))),
                // 目录可能是缓存的（聚合车道的注册表清单尤其如此）。给一个显式
                // 刷新入口，而不是让面板看起来像在展示一份预制清单。
                miniBtn(t('pool.refreshCatalog'), async () => {
                  setBusy(true); setError('')
                  try { await post('/refresh', undefined, 600_000); panel.reload() }
                  catch (failure) { setError(String(failure?.message ?? failure)) }
                  finally { setBusy(false) }
                }, { disabled: busy })),
              picker,

              h('div', { className: 'ofm_row' },
                h(Button, { disabled: busy || dirty !== true, onClick: submit }, busy ? t('common.saving') : t('common.save')),
                dirty === true ? h('span', { className: 'ofm_note' }, t('pool.unsaved')) : null),
              error === '' ? null : h('p', { className: 'ofm_note', style: { color: 'var(--warn)' } }, error),
              notice === '' ? null : h('p', { className: 'ofm_note' }, notice),

              h('div', { className: 'ofm_panel' },
                h('div', { className: 'ofm_paneltitle' }, t('pool.exampleTitle')),
                h('p', { className: 'ofm_note' }, t('pool.exampleHint')),
                h('pre', { className: 'ofm_code' },
                  `POST ${example.endpoint}\n{\n  "model": "${example.model}",\n  "messages": [...]\n}`)),
              resolved.length !== chosen.length && chosen.length > 0
                ? h('p', { className: 'ofm_note', style: { color: 'var(--warn)' } },
                  t('pool.unresolvedHint').replace('{n}', String(chosen.length - resolved.length)))
                : null)))
    }

    /** 接入客户端：本插件转发端口的地址、密钥与代码配方。
     *
     * 宿主渠道网关（A）与它的局域网中继（C）已删除。它们曾经是独立监听，
     * 但自动路由池只活在本插件自己的转发端口上——外部工具无论如何都应该
     * 连这里，另开一套网关只在「到底该填哪个地址」上制造歧义。 */
    function GatewayPage(props) {
      const { t } = props
      const clients = usePanel(() => api('/clients'), [])
      return h(Section, { title: t('gw.clientsTitle'), hint: t('gw.clientsHint') },
        clients.status === 'loading' ? h('div', { className: 'ofm_skel', style: { minHeight: 96 } })
          : clients.status === 'error'
            ? h(PanelError, { t, title: t('gw.clientsTitle'), message: clients.error, onRetry: clients.reload })
            // 配方由真实绑定的端口生成：没在监听时给一句说明，而不是一堆
            // 占位端口/占位 Key 的假配方（粘过去只会静默失败）。
            : clients.data?.running !== true
              ? h('div', { className: 'ofm_callout ofm_rise' },
                h('div', null, h('b', null, t('gw.clientsOff')), h('div', null, t('gw.clientsOffHint'))))
              : h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_row' },
                  h('span', { className: 'ofm_note' }, t('forward.baseUrl')),
                  h('code', { className: 'ofm_mono' }, clients.data.baseUrl),
                  h(CopyButton, { t, text: clients.data.baseUrl }),
                  h('span', { className: 'ofm_note' }, t('gw.clientsModels').replace('{n}', String((clients.data.models ?? []).length)))),
                clients.data.lanUrl === '' ? null
                  : h('div', { className: 'ofm_row' },
                    h('span', { className: 'ofm_note' }, t('forward.lanUrl')),
                    h('code', { className: 'ofm_mono' }, clients.data.lanUrl),
                    h(CopyButton, { t, text: clients.data.lanUrl })),
                h('div', { className: 'ofm_duo' }, (clients.data.snippets ?? []).map((snippet, index) => h('div', {
                  key: snippet.id, className: 'ofm_card ofm_rise',
                  style: { animationDelay: `${Math.min(index, 8) * 22}ms` },
                },
                h('div', { className: 'ofm_cardhead' },
                  h('span', { className: 'ofm_cardname' }, snippet.name),
                  h('span', { className: 'ofm_tag' }, snippet.language)),
                h('pre', { className: 'ofm_snippet' }, snippet.body),
                h('div', { className: 'ofm_row' }, h(CopyButton, { t, text: snippet.body })))))))
    }

    /** Shared page hero for the three gateway-console pages. The caller
     *  renders the copy: literal t() calls stay visible to the copy lint. */
    function PageHero(props) {
      const { title, sub, children } = props
      return h('header', { className: 'ofm_hero ofm_glass' },
        h('div', { className: 'ofm_pagehead' },
          h('div', { className: 'ofm_pagetitle' },
            h('h2', null, title),
            h('p', { className: 'ofm_pagesub' }, sub)),
          children))
    }

    // ── 聚合渠道 / 省 Token / 路由 ─────────────────────────────────────────────
    /**
     * One panel fetch per page, plus the merge for what a write answers with.
     *
     * `useAsync` above re-reads the whole payload after a write. These three
     * pages must not do that: every control's POST already answers with the state
     * the host stored, and a re-read would either double the round trips or open a
     * window where a switch shows what was *clicked* rather than what was saved.
     * So the payload lives here and the caller merges the POST answer in through
     * `patch`. The shimmer is for the first answer only — a reload after a write
     * keeps the current panel on screen instead of collapsing it back.
     */
    function usePanel(loader, deps) {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const run = useCallback(() => {
        let alive = true
        setState(current => ({ status: current.data === undefined ? 'loading' : 'ready', data: current.data, error: '' }))
        loader()
          .then(data => { if (alive) setState({ status: 'ready', data, error: '' }) })
          .catch(error => {
            if (!alive) return
            setState(current => current.data === undefined
              ? { status: 'error', data: undefined, error: String(error?.message ?? error) }
              : { status: 'ready', data: current.data, error: String(error?.message ?? error) })
          })
        return () => { alive = false }
      }, deps)
      useEffect(() => run(), [run])
      const patch = useCallback(update => setState(current => current.data === undefined
        ? current
        : { ...current, data: typeof update === 'function' ? update(current.data) : { ...current.data, ...update } }), [])
      return { ...state, reload: run, patch }
    }

    /** First-fetch placeholder: three shimmering cards, not one grey line. */
    function PanelSkeleton() {
      return h('div', { className: 'ofm_grid', 'aria-hidden': 'true' },
        h('div', { className: 'ofm_skel' }), h('div', { className: 'ofm_skel' }), h('div', { className: 'ofm_skel' }))
    }

    /**
     * A load failure that names what failed and offers the retry.
     *
     * The older pages render nothing at all when a route refuses, which reads as
     * "this plugin has no such feature". Each of the three new pages passes its
     * own title, because "cannot read the provider registry" and "cannot read the
     * chain settings" are different sentences to act on.
     */
    function PanelError(props) {
      const { t, title, message, onRetry } = props
      return h('div', { className: 'ofm_callout ofm_error ofm_rise' },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('b', null, title),
          h('div', null, message)),
        h(Button, { kind: 'ghost', onClick: onRetry }, t('retry')))
    }

    /** Copy-to-clipboard that answers the click, so a copy is never silent. */
    function CopyButton(props) {
      const { t, text } = props
      const [done, setDone] = useState(false)
      useEffect(() => {
        if (!done) return
        const timer = setTimeout(() => setDone(false), 1400)
        return () => clearTimeout(timer)
      }, [done])
      return h(Button, {
        kind: 'ghost',
        onClick: () => copy(text, ok => { if (ok) setDone(true) }),
      }, done ? t('eac.copied') : t('eac.copy'))
    }

    /** A switch with its one-line explanation underneath. */
    function ToggleRow(props) {
      const { label, hint, checked, disabled, onChange } = props
      return h('div', { className: 'ofm_field' },
        h(Switch, { checked, label, disabled, onChange }),
        hint === undefined ? null : h('span', null, hint))
    }

    // Labels for the ids the host serves. Literal t() calls inside an object
    // literal rather than a key table, because a key the copy lint cannot see is
    // a key it reports as unused (the same shape the pool-reason table uses).
    const AGG_CATEGORY = t => ({
      apikey: t('agg.category.apikey'),
      free: t('agg.category.free'),
      'free-tier': t('agg.category.freeTier'),
      local: t('agg.category.local'),
      oauth: t('agg.category.oauth'),
    })
    const AGG_AUTH = t => ({
      apiKey: t('agg.auth.apiKey'),
      none: t('agg.auth.none'),
      oauth: t('agg.auth.oauth'),
      adc: t('agg.auth.adc'),
    })
    const SAVER_LEVEL = t => ({
      off: t('saver.level.off'),
      lite: t('saver.level.lite'),
      full: t('saver.level.full'),
      ultra: t('saver.level.ultra'),
      'wenyan-lite': t('saver.level.wenyanLite'),
      wenyan: t('saver.level.wenyan'),
      'wenyan-ultra': t('saver.level.wenyanUltra'),
    })
    const LANE_LABEL = t => ({
      free: t('routing.channel.free'),
      eac: t('routing.channel.eac'),
      kilo: t('routing.channel.kilo'),
      aggregate: t('routing.channel.aggregate'),
      combo: t('routing.channel.combo'),
      host: t('routing.channel.host'),
      own: t('routing.channel.own'),
    })

    /**
     * Auth kinds this lane cannot drive.
     *
     * `oauth` needs an interactive login and `adc` a cloud-side credential, so
     * the aggregate lane skips them when it builds the catalog. Offering one in
     * the picker would be offering a provider whose key field can never work, so
     * they are shown and marked instead of hidden — "this exists and this lane
     * will not call it" is the honest sentence.
     */
    const AGG_UNUSABLE = new Set(['oauth', 'adc'])

    /** `a, b` / `a\nb` -> `['a','b']`, the shape POST /providers stores. */
    const parseModelIds = value => String(value ?? '').split(/[\n,]+/).map(part => part.trim()).filter(part => part !== '')

    /** How many catalog rows one provider contributes right now, read from
     *  /summary: "configured" must never imply "in the model picker". */
    const contributedBy = (catalog, providerId) => (catalog ?? [])
      .filter(row => row.channel === 'aggregate' && row.providerId === providerId).length

    const miniBtn = (label, onClick, options = {}) => h('button', {
      type: 'button',
      className: 'ofm_minibtn' + (options.danger === true ? ' danger' : ''),
      disabled: options.disabled === true,
      title: options.title,
      onClick,
    }, label)

    /**
     * The add-provider picker: the whole registry, filtered.
     *
     * Every row carries what the decision needs — category, wire format, auth
     * kind, how many models ship with it, where to get a key and the free-tier
     * note — because "which of these 76 is worth a key" is the actual question.
     * Rows are capped; the counts say how many matched.
     */
    function ProviderPicker(props) {
      const { t, registry, onPick } = props
      const [query, setQuery] = useState('')
      const [category, setCategory] = useState('')
      const [format, setFormat] = useState('')
      const [auth, setAuth] = useState('')
      const categories = AGG_CATEGORY(t)
      const auths = AGG_AUTH(t)
      const needle = query.trim().toLowerCase()
      const matched = registry.filter(row => {
        if (category !== '' && row.category !== category) return false
        if (format !== '' && row.format !== format) return false
        if (auth !== '' && row.authKind !== auth) return false
        if (needle === '') return true
        return `${row.id} ${row.name}`.toLowerCase().includes(needle)
      })
      const shown = matched.slice(0, 48)
      const formats = [...new Set(registry.map(row => row.format))].sort()
      return h('div', { className: 'ofm_panel ofm_rise' },
        h('div', { className: 'ofm_paneltitle' }, t('agg.addTitle'),
          h('span', { className: 'ofm_sec_hint' }, t('agg.showing').replace('{shown}', String(shown.length)).replace('{total}', String(matched.length)))),
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_field', style: { flex: '1 1 180px' } },
            h('span', null, t('agg.search')),
            h('input', { className: 'ofm_input', value: query, placeholder: t('agg.search'), onChange: event => setQuery(event.target.value) })),
          h('div', { className: 'ofm_field' }, h('span', null, t('agg.filterCategory')),
            h('select', { className: 'ofm_input', value: category, onChange: event => setCategory(event.target.value) },
              h('option', { value: '' }, t('agg.filterAll')),
              Object.keys(categories).map(id => h('option', { key: id, value: id }, categories[id])))),
          h('div', { className: 'ofm_field' }, h('span', null, t('agg.filterFormat')),
            h('select', { className: 'ofm_input', value: format, onChange: event => setFormat(event.target.value) },
              h('option', { value: '' }, t('agg.filterAll')),
              formats.map(id => h('option', { key: id, value: id }, id)))),
          h('div', { className: 'ofm_field' }, h('span', null, t('agg.filterAuth')),
            h('select', { className: 'ofm_input', value: auth, onChange: event => setAuth(event.target.value) },
              h('option', { value: '' }, t('agg.filterAll')),
              Object.keys(auths).map(id => h('option', { key: id, value: id }, auths[id]))))),
        h('p', { className: 'ofm_note' }, t('agg.addHint')),
        shown.length === 0
          ? h('p', { className: 'ofm_note' }, t('agg.noMatch'))
          : h('div', { className: 'ofm_picklist' }, shown.map((row, index) => {
            const blocked = AGG_UNUSABLE.has(row.authKind)
            return h('div', {
              key: row.id, className: 'ofm_pickrow ofm_rise',
              style: { animationDelay: `${Math.min(index, 12) * 18}ms` },
            },
            h('span', { className: 'ofm_pickhead' },
              h('b', { title: row.name }, row.name),
              blocked ? h('span', { className: 'ofm_tagpill dead' }, t('agg.notUsable')) : null),
            h('span', { className: 'ofm_pickmeta' },
              h('span', { className: 'ofm_tag' }, categories[row.category] ?? row.category),
              h('span', { className: 'ofm_tag' }, row.format),
              h('span', { className: 'ofm_tag' }, auths[row.authKind] ?? row.authKind),
              h('span', null, t('agg.modelCount').replace('{n}', String(row.modelCount)))),
            blocked
              ? h('span', { className: 'ofm_picknote' }, t('agg.notUsableWhy').replace('{kind}', auths[row.authKind] ?? row.authKind))
              : h('span', { className: 'ofm_row' },
                row.credentialUrl === '' ? null
                  : h('a', { className: 'ofm_starlink', href: row.credentialUrl, target: '_blank', rel: 'noreferrer' }, t('agg.credential')),
                miniBtn(t('agg.select'), () => onPick(row))),
            row.notes === '' ? null : h('span', { className: 'ofm_picknote' }, row.notes))
          })))
    }

    /**
     * One provider's editor, shared by "configure" and "add".
     *
     * The key box starts empty on purpose and an empty box means *keep*: the host
     * distinguishes an absent field from an empty string, and conflating them is
     * what silently kept a key the user believed they had deleted. Deleting one
     * is therefore its own button, and it says what it does.
     */
    function ProviderEditor(props) {
      const { t, provider, state, contributions, onSaved, onRemoved, onChanged, showContributions = true } = props
      const fresh = state === undefined
      const [enabled, setEnabled] = useState(state?.enabled !== false)
      const [baseUrl, setBaseUrl] = useState(state?.baseUrl ?? '')
      const [key, setKey] = useState('')
      const [models, setModels] = useState((state?.models ?? []).join(', '))
      const [verdict, setVerdict] = useState(state?.lastTest ?? null)
      // `null` = never discovered; otherwise the probe's honest verdict. The
      // list starts folded, because a 200-model answer printed inline buried
      // every control under it.
      const [found, setFound] = useState(null)
      const [foundOpen, setFoundOpen] = useState(false)
      // Per-model probes: id -> {busy:boolean, ok:boolean|undefined, message:string}
      const [probes, setProbes] = useState({})
      const [confirm, setConfirm] = useState(false)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')

      const run = async (kind, action) => {
        setBusy(kind)
        setError('')
        try { await action() } catch (failure) { setError(String(failure?.message ?? failure)) } finally { setBusy('') }
      }
      const save = () => run('save', async () => {
        const body = { providerId: provider.id, enabled, baseUrl, models: parseModelIds(models) }
        if (key !== '') body.apiKey = key
        const answer = await post('/providers', body)
        setKey('')
        onSaved(answer.aggregate, provider, fresh)
      })
      const clearKey = () => run('clear', async () => {
        const answer = await post('/providers', { providerId: provider.id, apiKey: '' })
        setKey('')
        onSaved(answer.aggregate, provider, false)
      })
      const test = () => run('test', async () => {
        // A listing probe, not a generation: the host verifies the key by asking
        // for the model list, so this costs no tokens. `status: 0` with ok:false
        // is its own verdict — "cannot be verified without spending a
        // generation" — and reads as a warning, not as a rejected key.
        const answer = await post('/providers/test', { providerId: provider.id }, 60_000)
        setVerdict({ at: Date.now(), ok: answer.ok === true, status: Number(answer.status) || 0, message: String(answer.message ?? '') })
      })
      const discover = () => run('discover', async () => {
        const answer = await post('/providers/discover', { providerId: provider.id }, 60_000)
        const models = Array.isArray(answer.models) ? answer.models : []
        setFound({ ok: answer.ok === true, models, message: String(answer.message ?? '') })
        // A failed probe keeps the previous list visible but folded: reopening it
        // is optional, and the message beside it says why the round failed.
        setFoundOpen(false)
        // The host persisted the ids and rebuilt the catalog; re-read both views
        // so the contribution counts and the key fingerprint stay true.
        onChanged?.()
      })
      const testOne = async id => {
        setProbes(current => ({ ...current, [id]: { busy: true, message: '' } }))
        try {
          const answer = await post('/providers/test-model', { providerId: provider.id, modelId: id }, 135_000)
          setProbes(current => ({
            ...current,
            [id]: {
              busy: false, ok: answer.ok === true,
              message: String(answer.message ?? ''),
              elapsedMs: Number(answer.elapsedMs) || 0,
            },
          }))
        } catch (failure) {
          setProbes(current => ({ ...current, [id]: { busy: false, ok: false, message: String(failure?.message ?? failure) } }))
        }
      }

      return h('div', { className: 'ofm_rise', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'ofm_pickmeta' },
          h('span', { className: 'ofm_tag' }, AGG_CATEGORY(t)[provider.category] ?? provider.category),
          h('span', { className: 'ofm_tag' }, provider.format),
          h('span', { className: 'ofm_tag' }, AGG_AUTH(t)[provider.authKind] ?? provider.authKind),
          // The card prints this one line above the editor, so it is suppressed
          // there; the add-provider flow renders the editor alone and keeps it.
          showContributions === false ? null : h('span', null, t('agg.contributes').replace('{n}', String(contributions)))),
        h('div', { className: 'ofm_duo' },
          ToggleRow({
            label: t('agg.enabled'), checked: enabled, disabled: busy !== '',
            onChange: () => { if (busy === '') setEnabled(value => !value) },
          }),
          field(t('agg.key'),
            h('input', {
              className: 'ofm_input', type: 'password', value: key, placeholder: t('agg.keyPlaceholder'),
              autoComplete: 'off', disabled: busy !== '',
              onChange: event => setKey(event.target.value),
            })),
          field(t('agg.baseUrl'),
            h('input', {
              className: 'ofm_input', value: baseUrl, placeholder: provider.baseUrl, disabled: busy !== '',
              onChange: event => setBaseUrl(event.target.value),
            })),
          field(t('agg.models'),
            h('textarea', {
              className: 'ofm_input', rows: 2, value: models, placeholder: t('agg.modelsPlaceholder'),
              disabled: busy !== '',
              onChange: event => setModels(event.target.value),
            }))),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('agg.keyKeep')),
          state?.hasKey === true ? h('span', { className: 'ofm_note' }, t('agg.hasKey').replace('{hint}', state.keyHint)) : h('span', { className: 'ofm_note' }, t('agg.noKey')),
          state?.hasKey === true ? miniBtn(t('agg.keyClear'), clearKey, { danger: true, disabled: busy !== '', title: t('agg.keyClearWarn') }) : null),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('agg.baseUrlHint')),
          provider.baseUrl === '' ? null : h('span', { className: 'ofm_note' }, t('agg.baseUrlDefault').replace('{url}', provider.baseUrl)),
          provider.baseUrlOverrideEnv === '' ? null : h('span', { className: 'ofm_note' }, t('agg.baseUrlEnv').replace('{env}', provider.baseUrlOverrideEnv))),
        h('p', { className: 'ofm_note' }, t('agg.modelsHint')),
        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'primary', disabled: busy !== '', onClick: save }, busy === 'save' ? t('agg.saving') : fresh ? t('agg.add') : t('agg.save')),
          miniBtn(t('agg.test'), test, { disabled: busy !== '' }),
          miniBtn(t('agg.discover'), discover, { disabled: busy !== '' }),
          h('span', { className: 'spacer', style: { marginLeft: 'auto' } }),
          fresh ? null : (confirm
            ? h(Fragment, null,
              miniBtn(t('agg.removeConfirm'), () => run('remove', async () => {
                const answer = await post('/providers/remove', { providerId: provider.id })
                onRemoved(answer.aggregate, provider)
              }), { danger: true, disabled: busy !== '' }),
              miniBtn(t('agg.cancel'), () => setConfirm(false), { disabled: busy !== '' }))
            : miniBtn(t('agg.remove'), () => setConfirm(true), { danger: true, disabled: busy !== '' }))),
        confirm ? h('p', { className: 'ofm_note' }, t('agg.removeWarn')) : null,
        h('div', { className: 'ofm_row' },
          verdict === null ? h('span', { className: 'ofm_note' }, t('agg.neverTested'))
            : h(Fragment, null,
              h(Pill, { tone: verdict.ok === true ? 'ok' : verdict.status === 0 ? 'warn' : 'err' },
                verdict.ok === true ? t('agg.testOk') : verdict.status === 0 ? t('agg.testUnverified') : t('agg.testFailed')),
              h('span', { className: 'ofm_note' }, t('agg.testAt').replace('{when}', ago(verdict.at, t.locale)))),
          busy === 'test' ? h('span', { className: 'ofm_note' }, t('agg.testing')) : null,
          busy === 'discover' ? h('span', { className: 'ofm_note' }, t('agg.discovering')) : null),
        // 只有「这家不提供模型列表」才配这句话；status 0 也覆盖网络不通/超时，
        // 那些情况下面那行已经给出真实原因，再挂一句「不提供列表」会误导。
        verdict !== null && verdict.ok !== true && verdict.status === 0 && /declares no model listing/i.test(String(verdict.message ?? ''))
          ? h('p', { className: 'ofm_note' }, t('agg.testUnverifiedWhy')) : null,
        verdict !== null && verdict.message !== '' ? h('p', { className: 'ofm_note' }, verdict.message) : null,
        found === null
          ? null
          // One folded row: the count and the verdict, with the list itself one
          // click away. The old block printed every discovered id inline and
          // auto-opened on every round, which is why the page felt like it was
          // showing a pre-made清单 rather than an answer.
          : h('div', { className: 'ofm_field' },
            h('div', { className: 'ofm_row' },
              h('button', {
                type: 'button', className: 'ofm_minibtn',
                'aria-expanded': foundOpen ? 'true' : 'false',
                disabled: busy !== '' || found.models.length === 0,
                onClick: () => setFoundOpen(value => !value),
              }, `${foundOpen ? '▾' : '▸'} ${found.models.length === 0
                ? (found.ok === true ? t('agg.discoveredEmpty') : t('agg.discoveredNone'))
                : t('agg.discoveredTick').replace('{n}', String(found.models.length))}`),
              found.ok === true && found.models.length > 0 ? miniBtn(t('agg.discoveredUse'), () => setModels(found.models.join(', '))) : null,
              found.ok === true && found.models.length > 0 ? miniBtn(t('agg.discoveredClear'), () => setModels('')) : null,
              found.ok === true ? null : h('span', { className: 'ofm_tag ofm_tagwarn' }, t('agg.discoverFailed'))),
            found.message === '' ? null
              : h('p', { className: 'ofm_note', style: found.ok === true ? undefined : { color: 'var(--warn)' } }, found.message),
            foundOpen && found.models.length > 0
              ? h('div', { className: 'ofm_foundlist' },
                found.models.map(id => {
                  const probe = probes[id] ?? {}
                  const picked = parseModelIds(models).includes(id)
                  return h('span', { key: id, className: 'ofm_foundrow' },
                    h('button', {
                      type: 'button', className: 'ofm_foundchip',
                      'aria-pressed': picked ? 'true' : 'false',
                      title: id,
                      disabled: busy !== '' || probe.busy === true,
                      onClick: () => setModels(current => {
                        const list = parseModelIds(current)
                        return (list.includes(id) ? list.filter(item => item !== id) : [...list, id]).join(', ')
                      }),
                    }, id),
                    // Each model gets its own real call: the listing proves the
                    // key, only a turn proves *this* model is entitled.
                    h('button', {
                      type: 'button', className: 'ofm_foundtest',
                      disabled: busy !== '' || probe.busy === true,
                      title: t('agg.testModelHint'),
                      onClick: () => void testOne(id),
                    }, probe.busy === true ? '…' : t('agg.testModel')),
                    probe.busy === true || probe.ok === undefined
                      ? null
                      : h('span', {
                        className: 'ofm_foundpill',
                        'data-ok': probe.ok === true ? 'true' : 'false',
                        title: probe.message,
                      }, probe.ok === true
                        ? `OK ${(Number(probe.elapsedMs) || 0) / 1000 > 0.1 ? `${((Number(probe.elapsedMs) || 0) / 1000).toFixed(1)}s` : ''}`.trim()
                        : 'FAIL'))
                }))
              : null),
        error === '' ? null : h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, h('b', null, t('agg.failed')), h('div', null, error))))
    }

    /** A configured provider as one card: identity, what it contributes, and its
     *  editor. The editor is inline rather than behind a fold because every field
     *  on it is something the card's own state can disagree with. */
    function ProviderCard(props) {
      const { t, provider, state, contributions, onSaved, onRemoved, onChanged, index } = props
      return h('div', { className: 'ofm_card ofm_rise', style: { animationDelay: `${Math.min(index, 8) * 22}ms` } },
        h('div', { className: 'ofm_cardhead' },
          h('span', { className: 'ofm_cardname', title: provider.name }, provider.name),
          state.enabled === false ? h('span', { className: 'ofm_tagpill dead' }, t('agg.disabled')) : null),
        h('div', { className: 'ofm_id' }, provider.id),
        h('div', { className: 'ofm_metrics' },
          h('span', null, contributions > 0 ? t('agg.contributes').replace('{n}', String(contributions)) : t('agg.contributesNone')),
          h('span', null, state.hasKey === true ? t('agg.hasKey').replace('{hint}', state.keyHint) : t('agg.noKey'))),
        h(ProviderEditor, { t, provider, state, contributions, onSaved, onRemoved, onChanged, showContributions: false }))
    }

    /**
     * 聚合渠道: the registry, the configured providers and their editors.
     *
     * The catalog is read from the summary the shell already holds, so the
     * "contributes N models" line is the picker's own view rather than a second
     * derivation — and every write asks the shell to re-read it, because saving a
     * provider changes what the model picker offers.
     */
    function AggregatePage(props) {
      const { t, summary } = props
      const panel = usePanel(() => api('/providers'), [])
      const [adding, setAdding] = useState(false)
      const [draft, setDraft] = useState(null)
      const [query, setQuery] = useState('')
      const [category, setCategory] = useState('')
      const catalog = summary?.data?.catalog ?? []
      const registry = panel.data?.registry ?? []
      const configured = panel.data?.configured?.providers ?? {}
      const categories = AGG_CATEGORY(t)

      const afterWrite = (aggregate, provider, isNew) => {
        if (aggregate !== undefined && aggregate !== null) panel.patch({ configured: aggregate })
        if (isNew) { setAdding(false); setDraft(null) }
        summary?.reload?.()
        showToast({ title: t('agg.saved'), body: t('agg.savedBody').replace('{name}', provider.name), holdMs: 3600 })
      }
      const afterRemove = (aggregate, provider) => {
        if (aggregate !== undefined && aggregate !== null) panel.patch({ configured: aggregate })
        summary?.reload?.()
        showToast({ title: t('agg.saved'), body: t('agg.removedBody').replace('{name}', provider.name), holdMs: 3600 })
      }
      const afterDiscover = () => { panel.reload(); summary?.reload?.() }

      const needle = query.trim().toLowerCase()
      const rows = Object.keys(configured)
        .map(id => ({ id, provider: registry.find(entry => entry.id === id) ?? null, state: configured[id] }))
        .filter(row => row.provider !== null)
        .filter(row => category === '' || row.provider.category === category)
        .filter(row => needle === '' || `${row.id} ${row.provider.name}`.toLowerCase().includes(needle))

      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('agg.title'), sub: t('agg.sub') },
          h('div', { className: 'ofm_pills' },
            h(Pill, null, t('agg.registryCount').replace('{n}', String(registry.length))),
            h(Pill, { strong: true }, t('agg.configuredCount').replace('{n}', String(Object.keys(configured).length)))),
          h(Button, {
            kind: adding ? 'ghost' : 'primary',
            onClick: () => { setAdding(value => !value); setDraft(null) },
          }, adding ? t('agg.cancel') : t('agg.addProvider'))),
        panel.status === 'loading' ? h(PanelSkeleton) : null,
        panel.status === 'error'
          ? h(PanelError, { t, title: t('agg.loadFailed'), message: panel.error, onRetry: panel.reload })
          : null,
        panel.status === 'ready'
          ? h(Fragment, null,
            draft !== null
              ? h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_paneltitle' }, draft.name, h('span', { className: 'ofm_sec_hint' }, draft.id)),
                h(ProviderEditor, {
                  t, provider: draft, state: undefined, contributions: 0,
                  onSaved: afterWrite, onRemoved: afterRemove, onChanged: afterDiscover,
                }))
              : adding
                ? h(ProviderPicker, { t, registry, onPick: setDraft })
                : null,
            h(Section, { title: t('agg.configuredTitle'), hint: t('agg.configuredHint') },
              h('div', { className: 'ofm_row' },
                h('div', { className: 'ofm_field', style: { flex: '1 1 180px' } },
                  h('span', null, t('agg.search')),
                  h('input', { className: 'ofm_input', value: query, placeholder: t('agg.search'), onChange: event => setQuery(event.target.value) })),
                h('div', { className: 'ofm_field' }, h('span', null, t('agg.filterCategory')),
                  h('select', { className: 'ofm_input', value: category, onChange: event => setCategory(event.target.value) },
                    h('option', { value: '' }, t('agg.filterAll')),
                    Object.keys(categories).map(id => h('option', { key: id, value: id }, categories[id]))))),
              Object.keys(configured).length === 0
                ? h('div', { className: 'ofm_panel' },
                  h('div', { className: 'ofm_paneltitle' }, t('agg.empty')),
                  h('p', { className: 'ofm_note' }, t('agg.emptyHint')))
                : rows.length === 0
                  ? h('p', { className: 'ofm_note' }, t('agg.filterEmpty'))
                  : h('div', { className: 'ofm_grid' }, rows.map((row, index) => h(ProviderCard, {
                    key: row.id, t, index, provider: row.provider, state: row.state,
                    contributions: contributedBy(catalog, row.id),
                    onSaved: afterWrite, onRemoved: afterRemove, onChanged: afterDiscover,
                  })))))
          : null)
    }

    /** The segmented level picker the two prompt savers share. */
    function LevelPicker(props) {
      const { t, levels, value, disabled, onChange } = props
      const labels = SAVER_LEVEL(t)
      return h('div', { className: 'ofm_seg', role: 'group' },
        levels.map(level => h('button', {
          key: level, type: 'button', disabled, 'aria-pressed': level === value ? 'true' : 'false',
          onClick: () => { if (!disabled && level !== value) onChange(level) },
        }, labels[level] ?? level)))
    }

    /** The savings bar: it grows into place once the first measurement lands, so
     *  the number reads as a measurement rather than as decoration. */
    function SavingsMeter(props) {
      const { t, percent } = props
      const [live, setLive] = useState(0)
      useEffect(() => {
        const timer = setTimeout(() => setLive(Math.max(0, Math.min(100, percent))), 60)
        return () => clearTimeout(timer)
      }, [percent])
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('saver.percent')),
          h('b', { className: 'ofm_kpivalue', style: { fontSize: 20 } }, `${percent}%`)),
        h('div', {
          className: 'ofm_meter', role: 'progressbar',
          'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': t('saver.percent'),
        }, h('i', { style: { width: `${live}%` } })))
    }

    /**
     * 省 Token: the three savers and what they have actually saved.
     *
     * Every control posts and then renders the host's own answer; nothing here
     * shows a switch state the settings file does not have. The dashboard reads
     * the measurement the host keeps, and says so explicitly when there is none —
     * an empty meter is not a claim that nothing was saved, it is the absence of a
     * measurement.
     */
    function SaverPage(props) {
      const { t } = props
      const panel = usePanel(() => Promise.all([api('/token-saver'), api('/local-optimize')])
        .then(([saver, local]) => ({ saver, local })), [])
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const saver = panel.data?.saver
      const local = panel.data?.local
      const savings = saver?.savings ?? null

      const write = async (kind, action) => {
        setBusy(kind)
        setError('')
        try { await action() } catch (failure) {
          // The route refuses an unknown level with a 400 and a sentence naming
          // the legal ones; showing it is more useful than swallowing it.
          setError(String(failure?.message ?? failure))
          showToast({ title: t('saver.failed'), body: String(failure?.message ?? failure), tone: 'warn', holdMs: 6000 })
        } finally { setBusy('') }
      }
      const saveSaver = patch => write('saver', async () => {
        const answer = await post('/token-saver', patch)
        // The POST answer carries the stored switches; the measurement is the
        // host's own tally and is only served by the GET, so it is kept as-is.
        panel.patch(current => ({ ...current, saver: { ...answer.tokenSaver, savings: current.saver?.savings } }))
        showToast({ title: t('saver.saved'), body: t('saver.savedBody'), holdMs: 3200 })
      })
      const saveLocal = patch => write('local', async () => {
        const answer = await post('/local-optimize', patch)
        panel.patch(current => ({ ...current, local: answer.localOptimize }))
        showToast({ title: t('saver.saved'), body: t('saver.savedBody'), holdMs: 3200 })
      })

      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('saver.title'), sub: t('saver.sub') },
          h('div', { className: 'ofm_pills' },
            h(Pill, { strong: true, tone: saver?.enabled === false ? 'warn' : 'ok' },
              saver?.enabled === false ? t('agg.disabled') : t('agg.enabled')))),
        panel.status === 'loading' ? h(PanelSkeleton) : null,
        panel.status === 'error'
          ? h(PanelError, { t, title: t('saver.loadFailed'), message: panel.error, onRetry: panel.reload })
          : null,
        error === '' ? null : h('div', { className: 'ofm_callout ofm_error ofm_rise' }, h('div', null, error)),
        panel.status === 'ready'
          ? h(Fragment, null,
            // The master switch governs all three savers, so it stands on its own
            // above them: inside the prompt-shaping section it read as that
            // section's switch, which is the one thing it is not.
            h('div', { className: 'ofm_panel ofm_rise' },
              h('div', { className: 'ofm_row' },
                h(Switch, {
                  checked: saver.enabled !== false, label: t('saver.master'), disabled: busy !== '',
                  onChange: () => { if (busy === '') saveSaver({ enabled: saver.enabled === false }) },
                }),
                h('span', { className: 'ofm_note' }, t('saver.masterHint')))),
            h(Section, { title: t('saver.dashTitle'), hint: t('saver.dashHint') },
              savings === null
                ? h('p', { className: 'ofm_note' }, t('saver.noData'))
                : h('div', { className: 'ofm_panel ofm_rise' },
                  h('div', { className: 'ofm_stats' },
                    stat(`${fmtInt(savings.bytesBefore)} B`, t('saver.bytesBefore')),
                    stat(`${fmtInt(savings.bytesAfter)} B`, t('saver.bytesAfter')),
                    stat(`${fmtInt(savings.saved)} B`, t('saver.bytesSaved')),
                    stat(String(savings.blocks), t('saver.blocks')),
                    stat(String(savings.calls), t('saver.calls')),
                    stat(String(savings.promptCalls), t('saver.promptCalls'))),
                  savings.bytesBefore > 0
                    ? h(SavingsMeter, { t, percent: savings.percent })
                    : h('p', { className: 'ofm_note' }, t('saver.noData')),
                  savings.summary === undefined || savings.summary === ''
                    ? null
                    : h('p', { className: 'ofm_note' }, `${t('saver.report')} · ${savings.summary}`))),
            h(Section, { title: t('saver.promptTitle'), hint: t('saver.promptHint') },
              h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_duo' },
                  h('div', { className: 'ofm_field' },
                    h('span', null, t('saver.caveman')),
                    h(LevelPicker, {
                      t, levels: saver.cavemanLevels ?? [], value: saver.prompts?.caveman, disabled: busy !== '',
                      onChange: level => saveSaver({ prompts: { caveman: level } }),
                    }),
                    h('span', null, t('saver.cavemanWhat'))),
                  h('div', { className: 'ofm_field' },
                    h('span', null, t('saver.ponytail')),
                    h(LevelPicker, {
                      t, levels: saver.ponytailLevels ?? [], value: saver.prompts?.ponytail, disabled: busy !== '',
                      onChange: level => saveSaver({ prompts: { ponytail: level } }),
                    }),
                    h('span', null, t('saver.ponytailWhat')))),
                h('p', { className: 'ofm_note' }, t('saver.voiceWarn')))),
            h(Section, { title: t('saver.rtk'), hint: t('saver.rtkWhat') },
              h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_row' },
                  h(Switch, {
                    checked: saver.rtk === true, label: t('saver.rtk'), disabled: busy !== '',
                    onChange: () => { if (busy === '') saveSaver({ rtk: saver.rtk !== true }) },
                  })),
                h('p', { className: 'ofm_note' }, t('saver.rtkSafety')))),
            h(Section, { title: t('saver.localTitle'), hint: t('saver.localHint') },
              h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_row' },
                  h(Switch, {
                    checked: local.enabled !== false, label: t('saver.local.enabled'), disabled: busy !== '',
                    onChange: () => { if (busy === '') saveLocal({ enabled: local.enabled === false }) },
                  })),
                h('div', { className: 'ofm_duo' },
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.quota !== false, label: t('saver.local.quota'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ quota: local.quota === false }) },
                    }),
                    h('span', null, t('saver.local.quotaHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.prefix !== false, label: t('saver.local.prefix'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ prefix: local.prefix === false }) },
                    }),
                    h('span', null, t('saver.local.prefixHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.title !== false, label: t('saver.local.title'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ title: local.title === false }) },
                    }),
                    h('span', null, t('saver.local.titleHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.suggestion !== false, label: t('saver.local.suggestion'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ suggestion: local.suggestion === false }) },
                    }),
                    h('span', null, t('saver.local.suggestionHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.filepath !== false, label: t('saver.local.filepath'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ filepath: local.filepath === false }) },
                    }),
                    h('span', null, t('saver.local.filepathHint')))))))
          : null)
    }

    /** The chain editor's member picker: searchable, and it shows the lane and
     *  the vision flag, because those are what decide a chain's order. */
    function ModelPicker(props) {
      const { t, models, chosen, onPick } = props
      const [query, setQuery] = useState('')
      const lanes = LANE_LABEL(t)
      const needle = query.trim().toLowerCase()
      const rows = models
        .filter(row => needle === '' || `${row.id} ${row.name}`.toLowerCase().includes(needle))
        .slice(0, 60)
      return h('div', { className: 'ofm_panel' },
        h('div', { className: 'ofm_paneltitle' }, t('routing.pickModel')),
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_field', style: { flex: '1 1 200px' } },
            h('span', null, t('routing.pickModel')),
            h('input', { className: 'ofm_input', value: query, placeholder: t('routing.searchModel'), onChange: event => setQuery(event.target.value) }))),
        rows.length === 0
          ? h('p', { className: 'ofm_note' }, t('routing.noModel'))
          : h('div', { className: 'ofm_picklist' }, rows.map(row => h('button', {
            key: row.id, type: 'button', className: 'ofm_pickrow',
            'aria-pressed': chosen.includes(row.id) ? 'true' : 'false',
            onClick: () => onPick(row.id),
          },
          h('span', { className: 'ofm_pickhead' }, h('b', { title: row.name }, row.name ?? row.id)),
          h('span', { className: 'ofm_pickmeta' },
            h('span', { className: 'ofm_id' }, row.id),
            h('span', { className: 'ofm_tag' }, lanes[row.channel] ?? row.channel),
            row.vision === true ? h('span', { className: 'ofm_tag' }, t('tag.vision')) : null)))))
    }

    /**
     * The chain editor.
     *
     * The member list is ordered and the order is the chain, so it is edited in
     * place (add / remove / move) rather than through a free-text field: a typo in
     * a text field is a link that silently never resolves, and the host has no way
     * to tell "you meant this model" from "this model is gone".
     */
    function ChainEditor(props) {
      const { t, chain, models, onSave, onCancel } = props
      const [name, setName] = useState(chain.name ?? '')
      const [strategy, setStrategy] = useState(chain.strategy === 'round-robin' ? 'round-robin' : 'fallback')
      const [stickyLimit, setStickyLimit] = useState(String(chain.stickyLimit ?? 1))
      const [enabled, setEnabled] = useState(chain.enabled !== false)
      const [members, setMembers] = useState(Array.isArray(chain.models) ? chain.models : [])
      const [picking, setPicking] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const byId = new Map(models.map(row => [row.id, row]))
      const lanes = LANE_LABEL(t)

      const move = (index, delta) => setMembers(current => {
        const next = [...current]
        const target = index + delta
        if (target < 0 || target >= next.length) return current
        const [row] = next.splice(index, 1)
        next.splice(target, 0, row)
        return next
      })
      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          const limit = Number(stickyLimit)
          await onSave({
            ...chain.id === undefined ? {} : { id: chain.id },
            name,
            models: members,
            strategy,
            stickyLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1,
            enabled,
          })
        } catch (failure) { setError(String(failure?.message ?? failure)) } finally { setBusy(false) }
      }

      return h('div', { className: 'ofm_panel ofm_rise' },
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_field', style: { flex: '1 1 180px' } },
            h('span', null, t('routing.name')),
            h('input', {
              className: 'ofm_input', value: name, placeholder: t('routing.namePlaceholder'), disabled: busy,
              onChange: event => setName(event.target.value),
            })),
          h('div', { className: 'ofm_field' },
            h('span', null, t('routing.strategy')),
            h('div', { className: 'ofm_seg', role: 'group' },
              h('button', {
                type: 'button', disabled: busy, 'aria-pressed': strategy === 'fallback' ? 'true' : 'false',
                onClick: () => { if (!busy) setStrategy('fallback') },
              }, t('routing.strategy.fallback')),
              h('button', {
                type: 'button', disabled: busy, 'aria-pressed': strategy === 'round-robin' ? 'true' : 'false',
                onClick: () => { if (!busy) setStrategy('round-robin') },
              }, t('routing.strategy.roundRobin')))),
          strategy === 'round-robin'
            ? h('div', { className: 'ofm_field' },
              h('span', null, t('routing.stickyLimit')),
              h('input', {
                className: 'ofm_input', type: 'number', min: 1, max: 100, style: { width: 96 },
                value: stickyLimit, disabled: busy,
                onChange: event => setStickyLimit(event.target.value),
              }))
            : null,
          h(Switch, {
            checked: enabled, label: t('routing.enabled'), disabled: busy,
            onChange: () => { if (!busy) setEnabled(value => !value) },
          })),
        strategy === 'round-robin' ? h('p', { className: 'ofm_note' }, t('routing.stickyHint')) : null,
        h('div', { className: 'ofm_paneltitle' }, t('routing.members'),
          h('span', { className: 'ofm_sec_hint' }, t('routing.memberCount').replace('{n}', String(members.length)))),
        members.length === 0
          ? h('p', { className: 'ofm_note' }, t('routing.memberEmpty'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, members.map((id, index) => {
            const row = byId.get(id)
            return h('div', { key: `${id}#${index}`, className: 'ofm_member' },
              h('span', { className: 'ofm_id', title: id }, row?.name ?? id),
              h('span', { className: 'ofm_tag' }, lanes[row?.channel] ?? ''),
              miniBtn('↑', () => move(index, -1), { disabled: busy || index === 0, title: t('routing.moveUp') }),
              miniBtn('↓', () => move(index, 1), { disabled: busy || index === members.length - 1, title: t('routing.moveDown') }),
              miniBtn(t('routing.removeMember'), () => setMembers(current => current.filter((_, at) => at !== index)), { danger: true, disabled: busy }))
          })),
        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'ghost', disabled: busy, onClick: () => setPicking(value => !value) }, picking ? t('routing.cancel') : t('routing.addMember'))),
        picking ? h(ModelPicker, { t, models, chosen: members, onPick: id => setMembers(current => [...current, id]) }) : null,
        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'primary', disabled: busy || name.trim() === '' || members.length === 0, onClick: submit }, t('routing.save')),
          h(Button, { kind: 'ghost', disabled: busy, onClick: onCancel }, t('routing.cancel'))),
        error === '' ? null : h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, h('b', null, t('routing.failed')), h('div', null, error))))
    }

    /**
     * One stored chain.
     *
     * A chain that resolves to nothing right now is *not* an error state: the host
     * keeps such a chain on purpose, because a link that reaches an EAC model is
     * still correct on a day that lane is closed, and rewriting the user's chain
     * for them is worse than showing it as unavailable. So the card names the
     * members that are not in the roster and says the chain is kept as written —
     * which is the difference between "your chain is fine" and "your chain is
     * broken", and the user is the only one who can tell which one it is.
     */
    function ChainCard(props) {
      const { t, chain, resolved, missing, lookup, onEdit, onDelete, confirming, index } = props
      const lanes = LANE_LABEL(t)
      const usable = chain.enabled !== false && resolved.length > 0
      return h('div', { className: 'ofm_card ofm_rise', style: { animationDelay: `${Math.min(index, 8) * 22}ms` } },
        h('div', { className: 'ofm_cardhead' },
          h('span', { className: 'ofm_cardname', title: chain.name }, chain.name),
          h(Pill, { tone: usable ? 'ok' : 'warn' }, usable ? t('routing.usable') : t('routing.notUsable'))),
        h('div', { className: 'ofm_metrics' },
          h('span', null, chain.id),
          h('span', null, chain.strategy === 'round-robin' ? t('routing.strategy.roundRobin') : t('routing.strategy.fallback')),
          h('span', null, t('routing.memberCount').replace('{n}', String((chain.models ?? []).length)))),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('routing.resolved')),
          resolved.length === 0
            ? h('span', { className: 'ofm_note' }, '—')
            : resolved.map(id => h('span', { key: id, className: 'ofm_tag' }, `${lookup.get(id)?.name ?? id} · ${lanes[lookup.get(id)?.channel] ?? ''}`))),
        missing.length === 0
          ? null
          : h(Fragment, null,
            h('p', { className: 'ofm_note' }, t('routing.missing').replace('{ids}', missing.join(', '))),
            h('p', { className: 'ofm_note' }, t('routing.notUsableWhy'))),
        h('div', { className: 'ofm_row' },
          miniBtn(t('routing.edit'), onEdit),
          onDelete === undefined ? null : miniBtn(confirming === true ? t('routing.deleteConfirm') : t('routing.delete'), onDelete, { danger: true })))
    }

    /**
     * 路由: the stored fallback chains and their editor.
     *
     * The resolution shown per chain is derived from the model list this page
     * already holds — the same intersection the host uses to build the virtual
     * catalog row — so it survives a reload, and the `usable` array a save answers
     * with is preferred when it is there.
     */
    function RoutingPage(props) {
      const { t, bare = false } = props
      const panel = usePanel(() => api('/combos'), [])
      const [editing, setEditing] = useState(null)
      const [confirm, setConfirm] = useState('')
      const chains = panel.data?.combos ?? []
      const models = panel.data?.models ?? []
      const lookup = useMemo(() => new Map(models.map(row => [row.id, row])), [models])

      const resolvedOf = chain => {
        const answered = (panel.data?.usable ?? []).find(row => row.id === chain.id)
        if (answered !== undefined) return answered.models
        return (chain.models ?? []).filter(id => lookup.has(id))
      }
      const missingOf = chain => (chain.models ?? []).filter(id => !lookup.has(id))
      const save = async row => {
        // The whole list is written back, because that is the route's shape: it
        // normalizes and replaces. An edit keeps its id, so a rename never changes
        // the model id a client may already be pinned to.
        const known = chains.some(chain => chain.id === row.id)
        const rows = known ? chains.map(chain => chain.id === row.id ? row : chain) : [...chains, row]
        const answer = await post('/combos', { combos: rows })
        panel.patch({ combos: answer.combos, usable: answer.usable })
        panel.reload()
        setEditing(null)
        showToast({ title: t('routing.saved'), body: t('routing.savedBody'), holdMs: 3200 })
      }
      const remove = async id => {
        const answer = await post('/combos', { combos: chains.filter(chain => chain.id !== id) })
        panel.patch({ combos: answer.combos, usable: answer.usable })
        panel.reload()
        setConfirm('')
        showToast({ title: t('routing.saved'), body: t('routing.savedBody'), holdMs: 3200 })
      }
      // A fresh chain is the same editor with an empty draft: the fields, the
      // member list and the validation are identical, only the id is absent.
      const blank = { name: '', models: [], strategy: 'fallback', stickyLimit: 1, enabled: true }

      const body = [
        panel.status === 'loading' ? h(PanelSkeleton, { key: 'loading' }) : null,
        panel.status === 'error'
          ? h(PanelError, { key: 'error', t, title: t('routing.loadFailed'), message: panel.error, onRetry: panel.reload })
          : null,
        panel.status === 'ready'
          ? h(Section, { key: 'ready', title: t('routing.chains'), hint: t('routing.chainsHint') },
            // The editor renders full width above the list rather than inside a
            // grid cell: a chain's member list and its picker need the room, and a
            // form squeezed into a 252 px column is a form nobody can order.
            editing !== null
              ? h(ChainEditor, {
                t, models, chain: editing.chain,
                onSave: save, onCancel: () => setEditing(null),
              })
              : chains.length === 0
                ? h('div', { className: 'ofm_panel' },
                  h('div', { className: 'ofm_paneltitle' }, t('routing.empty')),
                  h('p', { className: 'ofm_note' }, t('routing.emptyHint')),
                  h('div', { className: 'ofm_row' },
                    h(Button, { kind: 'primary', onClick: () => setEditing({ chain: blank }) }, t('routing.newChain'))))
                : h('div', { className: 'ofm_row' },
                  h(Button, { kind: 'primary', onClick: () => setEditing({ chain: blank }) }, t('routing.newChain'))),
            chains.length === 0 ? null : h('div', { className: 'ofm_grid' }, chains.map((chain, index) => h(ChainCard, {
              key: chain.id, t, index, chain, lookup,
              resolved: resolvedOf(chain), missing: missingOf(chain),
              confirming: confirm === chain.id,
              onEdit: () => setEditing({ chain }),
              onDelete: () => { if (confirm === chain.id) void remove(chain.id); else setConfirm(chain.id) },
            }))),
            confirm === '' ? null : h('p', { className: 'ofm_note' }, t('routing.deleteWarn')))
          : null,
      ]
      // `bare`：作为「路由」页签的第二段渲染，页头与大标题由 RoutesPage 出。
      return bare
        ? h(Fragment, null, ...body)
        : h('div', { className: 'ofm_page' },
          h(PageHero, { title: t('routing.title'), sub: t('routing.sub') },
            h('div', { className: 'ofm_pills' },
              h(Pill, null, t('routing.chains') + ' ' + String(chains.length)))),
          ...body)
    }

    // ── 路由分组（原 model-failover-manager 的面板部分）──────────────────────
    /** `[{from,to}]` → 「18-8,12-14」；空数组 → 空串。 */
    function windowsTextOf(windows) {
      return Array.isArray(windows) ? windows.map(item => `${item.from}-${item.to}`).join(',') : ''
    }
    /** 「18-8,12-14」→ `[{from,to}]`。无法解析的片段直接丢弃，不阻塞保存。 */
    function parseWindowsText(text) {
      const rows = []
      for (const raw of String(text ?? '').split(/[,，;；\s]+/)) {
        if (raw === '') continue
        const match = /^(\d{1,2})\s*[-~—－]\s*(\d{1,2})$/.exec(raw)
        if (match === null) continue
        rows.push({ from: Math.max(0, Math.min(23, Number(match[1]))), to: Math.max(0, Math.min(24, Number(match[2]))) })
      }
      return rows
    }

    /**
     * 分组编辑器。成员一行四个字段：优先级 / 档位 / 时段 / 启停。
     *
     * 优先级是「越小越先试」，和旧插件一致：迁移过来的 15 就是 15，不会被面板
     * 按顺序悄悄改写——慢模型留在原位是用户明确要求的行为。
     */
    function GroupEditor(props) {
      const { t, group, models, onSave, onCancel } = props
      const [name, setName] = useState(group.name ?? '')
      const [enabled, setEnabled] = useState(group.enabled !== false)
      const [members, setMembers] = useState(() => (group.models ?? []).map(member => ({
        model: member.model,
        provider: member.provider ?? '',
        // 服务端 `describeGroup` 已经把可解析的成员折成目录 id：`member.id` 是
        // 目录里真正命中的行，`available` 是解析结论。面板直接用它渲染，
        // 不要再拿 `member.model` 精确查一次目录 —— 旧坐标（带 adapter 路由前缀、
        // 双前缀、裸名 + provider）会被误画成「目录缺失」。
        resolved: member.id ?? member.model,
        displayName: member.name ?? member.model,
        available: member.available !== false,
        priority: String(member.priority ?? 99),
        effort: member.effort ?? '',
        windowsText: windowsTextOf(member.windows),
        disabled: member.disabled === true,
        note: member.note ?? '',
      })))
      const [picking, setPicking] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const byId = new Map(models.map(row => [row.id, row]))
      const patchMember = (index, patch) => setMembers(current => current.map((row, at) => at === index ? { ...row, ...patch } : row))
      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          const priorityOf = value => {
            if (String(value ?? '').trim() === '') return '99'
            const number = Number(value)
            return Number.isFinite(number) ? Math.max(0, Math.min(999, Math.trunc(number))).toString() : '99'
          }
          await onSave({
            ...group.id === undefined ? {} : { id: group.id },
            name: name.trim(),
            enabled,
            models: members.map(row => {
              // 优先级统一成字符串再回写：`normalizeGroups` 只认有限数字，
              // 而输入框里永远是文本，这里不做转换会在保存时被静默改成 99。
              const priority = priorityOf(row.priority)
              const windows = parseWindowsText(row.windowsText)
              return {
                // 解析得到目录 id 时按它存：旧坐标（带 adapter 路由前缀等）会在
                // 保存时被就地修正，下次打开就不再显示「目录缺失」。
                model: row.resolved !== undefined && byId.has(row.resolved) ? row.resolved : row.model,
                ...row.provider === '' ? {} : { provider: row.provider },
                priority: Number(priority),
                ...row.effort.trim() === '' ? {} : { effort: row.effort.trim() },
                ...windows.length === 0 ? {} : { windows },
                ...row.disabled === true ? { disabled: true } : {},
                ...row.note === '' ? {} : { note: row.note },
              }
            }),
          })
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally { setBusy(false) }
      }

      return h('div', { className: 'ofm_panel ofm_rise' },
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_field', style: { flex: '1 1 180px' } },
            h('span', null, t('route.name')),
            h('input', {
              className: 'ofm_input', value: name, placeholder: t('route.namePlaceholder'), disabled: busy,
              onChange: event => setName(event.target.value),
            })),
          h(Switch, {
            checked: enabled, label: t('route.enabled'), disabled: busy,
            onChange: () => { if (!busy) setEnabled(value => !value) },
          }),
          h('span', { className: 'ofm_note', style: { marginLeft: 'auto' } },
            t('route.memberCount').replace('{n}', String(members.length))),
          h(Button, { kind: 'ghost', disabled: busy, onClick: () => setPicking(value => !value) },
            picking ? t('route.cancel') : t('route.addMember'))),
        members.length === 0
          ? h('p', { className: 'ofm_note' }, t('route.memberEmpty'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, members.map((row, index) => {
            const known = byId.get(row.resolved) ?? byId.get(row.model)
            // 只有服务端也解析不到（`available === false`）且本地目录里没有时才标缺失。
            const missing = row.available === false && known === undefined
            return h('div', { key: `${row.model}#${index}`, className: 'ofm_member' },
              h('span', { className: 'ofm_id', title: row.resolved, style: { flex: '1 1 180px' } },
                known?.name ?? row.displayName ?? row.model,
                missing ? h('span', { className: 'ofm_tag', style: { marginLeft: 6, opacity: 0.65 } }, t('route.unavailable')) : null),
              h('input', {
                className: 'ofm_input', type: 'number', min: 0, max: 999, title: t('route.priority'),
                style: { width: 64 }, value: row.priority, disabled: busy,
                onChange: event => patchMember(index, { priority: event.target.value }),
              }),
              (() => {
                // 档位下拉只列这个模型真认的 id：旧插件迁来的 xhigh / Extra High /
                // 默认（高）这类词汇在下拉里没有对应项时单独留一行，避免静默降级。
                const levels = Array.isArray(known?.efforts) && known.efforts.length > 0
                  ? known.efforts.map(level => String(level))
                  : known?.reasoning === true ? ['light', 'balanced', 'deep'] : []
                if (levels.length === 0) {
                  return h('span', { className: 'ofm_tag', title: t('route.effortNone'), style: { opacity: 0.6 } }, t('route.effortFollow'))
                }
                const stale = row.effort !== '' && !levels.includes(row.effort)
                return h('select', {
                  className: 'ofm_input', title: t('route.effort'), style: { width: 118 }, value: row.effort, disabled: busy,
                  onChange: event => patchMember(index, { effort: event.target.value }),
                },
                  h('option', { value: '' }, t('route.effortFollow')),
                  levels.map(level => h('option', { key: level, value: level }, level)),
                  stale ? h('option', { value: row.effort }, `${row.effort} (?)`) : null)
              })(),
              h('input', {
                className: 'ofm_input', placeholder: t('route.windowsPlaceholder'), title: t('route.windowsHint'),
                style: { width: 118 }, value: row.windowsText, disabled: busy,
                onChange: event => patchMember(index, { windowsText: event.target.value }),
              }),
              miniBtn(row.disabled === true ? t('route.enable') : t('route.disable'), () => patchMember(index, { disabled: !row.disabled }), { disabled: busy }),
              miniBtn(t('route.removeMember'), () => setMembers(current => current.filter((_, at) => at !== index)), { danger: true, disabled: busy }))
          })),
        h('p', { className: 'ofm_note' }, t('route.windowsHint')),
        picking ? h(ModelPicker, {
          t, models,
          chosen: members.map(row => row.model),
          onPick: id => setMembers(current => [...current, {
            model: id, provider: '', priority: '99', effort: '', windowsText: '', disabled: false, note: '',
          }]),
        }) : null,
        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'primary', disabled: busy || name.trim() === '' || members.length === 0, onClick: submit }, t('route.save')),
          h(Button, { kind: 'ghost', disabled: busy, onClick: onCancel }, t('route.cancel'))),
        error === '' ? null : h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, h('b', null, t('route.failed')), h('div', null, error))))
    }

    /** 一张分组卡：成员按优先级列出，标出今日熔断与目录缺失。 */
    function GroupCard(props) {
      const { t, group, index, onEdit, onDelete, confirming } = props
      const usable = group.enabled !== false && group.models.some(member => member.available && member.failed !== true && member.disabled !== true)
      const failed = group.models.filter(member => member.failed === true).length
      const missing = group.models.filter(member => member.available !== true).length
      return h('div', { className: 'ofm_card ofm_rise', style: { animationDelay: `${Math.min(index, 8) * 22}ms` } },
        h('div', { className: 'ofm_cardhead' },
          h('span', { className: 'ofm_cardname', title: group.name }, group.name),
          h(Pill, { tone: usable ? 'ok' : 'warn' }, usable ? t('route.usable') : t('route.notUsable'))),
        h('div', { className: 'ofm_metrics' },
          h('span', null, group.id),
          h('span', null, `${t('route.memberCount').replace('{n}', String(group.models.length))}${group.bindings === 0 ? '' : ` · ${t('route.bindings').replace('{n}', String(group.bindings))}`}`)),
        h('div', { className: 'ofm_row' },
          group.models.map(member => h('span', {
            key: member.model + member.priority,
            className: 'ofm_tag',
            title: member.model,
            style: member.disabled === true || member.available !== true || member.failed === true ? { opacity: 0.55 } : undefined,
          }, `${member.name} · ${member.priority}${member.windows !== undefined && member.windows.length > 0 ? ` · ${windowsTextOf(member.windows)}` : ''}${member.failed === true ? ' · 熔断' : ''}`))),
        missing === 0 ? null : h('p', { className: 'ofm_note' }, t('route.missingHint').replace('{n}', String(missing))),
        failed === 0 ? null : h('p', { className: 'ofm_note' },
          t('route.todayFailed').replace('{n}', String(failed)) + ' — ' + t('route.resetFailedHint')),
        h('div', { className: 'ofm_row' },
          miniBtn(t('route.edit'), onEdit),
          failed === 0 ? null : miniBtn(t('route.resetFailed'), () => props.onResetFailed(group), { disabled: props.busy === true }),
          miniBtn(confirming === true ? t('route.deleteConfirm') : t('route.delete'), onDelete, { danger: true })))
    }

    /**
     * 「路由」页：分组优先于组合链。
     *
     * 这里是 failover 的能力落点——优先级、时段、当日熔断、并发闸门——但读写走
     * 本插件自己的 `/routes`，旧插件的 JSON 只作为导入源，不再被两边同时写。
     */
    function RoutesPage(props) {
      const { t } = props
      const panel = usePanel(() => api('/routes'), [])
      const [editing, setEditing] = useState(null)
      const [confirm, setConfirm] = useState('')
      const [confirmImport, setConfirmImport] = useState(false)
      const [busy, setBusy] = useState(false)
      const [draft, setDraft] = useState(null)
      const groups = panel.data?.groups ?? []
      const models = panel.data?.models ?? []
      const routeSettings = panel.data?.settings ?? { defaultConcurrency: 0, capacityCooldownMs: 30_000, concurrencyByModel: {} }
      const bindingCount = (panel.data?.bindings ?? []).length
      useEffect(() => {
        setDraft({
          concurrency: String(routeSettings.defaultConcurrency ?? 0),
          cooldown: String(Math.round((routeSettings.capacityCooldownMs ?? 30_000) / 1000)),
        })
      }, [routeSettings.defaultConcurrency, routeSettings.capacityCooldownMs])

      const save = async row => {
        const raw = group => ({
          id: group.id,
          name: group.name,
          enabled: group.enabled !== false,
          models: (group.models ?? []).map(member => ({
            model: member.model,
            ...member.provider === '' || member.provider === undefined ? {} : { provider: member.provider },
            priority: member.priority,
            ...member.effort === undefined || member.effort === '' ? {} : { effort: member.effort },
            ...Array.isArray(member.windows) && member.windows.length > 0 ? { windows: member.windows } : {},
            ...member.disabled === true ? { disabled: true } : {},
            ...member.note === undefined || member.note === '' ? {} : { note: member.note },
            ...member.legacy === undefined || member.legacy === null ? {} : { legacy: member.legacy },
          })),
          ...group.legacyId === undefined || group.legacyId === '' ? {} : { legacyId: group.legacyId },
          ...group.importedFrom === undefined || group.importedFrom === '' ? {} : { importedFrom: group.importedFrom },
        })
        const known = groups.some(group => group.id === row.id)
        const rows = known ? groups.map(group => group.id === row.id ? row : group) : [...groups, row]
        await post('/routes', { groups: rows.map(raw) })
        panel.reload()
        setEditing(null)
        showToast({ title: t('route.saved'), body: t('route.savedBody'), holdMs: 3200 })
      }
      const remove = async id => {
        await post('/routes', { groups: groups.filter(group => group.id !== id) })
        panel.reload()
        setConfirm('')
        showToast({ title: t('route.saved'), body: t('route.savedBody'), holdMs: 3200 })
      }
      const saveSettings = async () => {
        setBusy(true)
        try {
          const seconds = Number(draft?.cooldown)
          await post('/settings', {
            route: {
              defaultConcurrency: Number(draft?.concurrency) || 0,
              capacityCooldownMs: Number.isFinite(seconds) ? Math.max(0, Math.min(600, Math.round(seconds))) * 1000 : 30_000,
            },
          })
          panel.reload()
          showToast({ title: t('route.settingsSaved'), body: t('route.settingsSavedBody'), holdMs: 3000 })
        } catch (error) {
          showToast({ title: t('route.failed'), body: String(error?.message ?? error), tone: 'warn' })
        } finally { setBusy(false) }
      }
      const runImport = async () => {
        setBusy(true)
        try {
          const answer = await post('/routes/import', { force: true })
          const result = answer.result ?? {}
          panel.reload()
          setConfirmImport(false)
          showToast({ title: result.imported === true ? t('route.imported') : t('route.importSkip'), body: result.imported === true ? t('route.importedBody').replace('{groups}', String(result.groups ?? 0)).replace('{members}', String(result.members ?? 0)) : String(result.reason ?? ''), holdMs: 4000 })
        } catch (error) {
          showToast({ title: t('route.importFailed'), body: String(error?.message ?? error), tone: 'warn' })
        } finally { setBusy(false) }
      }
      const resetAll = async () => {
        setBusy(true)
        try {
          const answer = await post('/routes/failed/reset', {})
          panel.patch({ groups: answer.groups, failed: answer.failed })
          showToast({ title: t('route.resetDone'), body: t('route.resetDoneBody'), holdMs: 3000 })
        } catch (error) {
          showToast({ title: t('route.failed'), body: String(error?.message ?? error), tone: 'warn' })
        } finally { setBusy(false) }
      }
      const blank = { name: '', models: [], enabled: true }

      const hero = h(PageHero, { title: t('route.title'), sub: t('route.sub') },
        h('div', { className: 'ofm_pills' },
          h(Pill, null, t('route.groups') + ' ' + String(groups.length)),
          h(Pill, null, `${t('route.modelsCount').replace('{n}', String(models.length))}${bindingCount === 0 ? '' : ` · ${t('route.bindings').replace('{n}', String(bindingCount))}`}`)))

      const gateSection = h(Section, { title: t('route.gateTitle'), hint: t('route.gateHint') },
        h('div', { className: 'ofm_panel' },
          h('div', { className: 'ofm_row' },
            h('div', { className: 'ofm_field' },
              h('span', null, t('route.concurrency')),
              h('input', {
                className: 'ofm_input', type: 'number', min: 0, max: 64, style: { width: 96 },
                value: draft?.concurrency ?? '0', disabled: busy,
                onChange: event => setDraft(current => ({ ...current, concurrency: event.target.value })),
              })),
            h('div', { className: 'ofm_field' },
              h('span', null, t('route.cooldown')),
              h('input', {
                className: 'ofm_input', type: 'number', min: 0, max: 600, style: { width: 96 },
                value: draft?.cooldown ?? '30', disabled: busy,
                onChange: event => setDraft(current => ({ ...current, cooldown: event.target.value })),
              })),
            h(Button, { kind: 'primary', disabled: busy || draft === null, onClick: saveSettings }, t('route.saveSettings')),
            h(Button, { kind: 'ghost', disabled: busy, onClick: resetAll }, t('route.resetAll')),
            // 旧插件的导入只在它还装着时才有意义：卸载后数据目录仍会留在
            // `~/.dsh`，只看目录存在会一直挂着一个「从旧插件导入」按钮。
            panel.data?.legacy?.available === true && panel.data?.legacy?.installed === true
              ? h(Button, {
                kind: 'ghost', disabled: busy,
                onClick: () => {
                  if (confirmImport || groups.length === 0) void runImport()
                  else setConfirmImport(true)
                },
              }, confirmImport ? t('route.importConfirm') : t('route.import'))
              : null,
            confirmImport ? h(Button, { kind: 'ghost', onClick: () => setConfirmImport(false) }, t('route.cancel')) : null),
          h('p', { className: 'ofm_note' }, t('route.concurrencyHint')),
          panel.data?.legacy?.available === true && panel.data?.legacy?.installed === true ? h('p', { className: 'ofm_note' }, t('route.importHint')) : null,
          bindingCount === 0 ? null : h('p', { className: 'ofm_note' }, t('route.bindingNote').replace('{n}', String(bindingCount)))))

      const groupCards = groups.length === 0 ? null : h('div', { className: 'ofm_grid' }, groups.map((group, index) => h(GroupCard, {
        key: group.id, t, index, group, busy,
        confirming: confirm === group.id,
        onEdit: () => setEditing({ group }),
        onResetFailed: async target => {
          setBusy(true)
          try {
            const ids = target.models.filter(member => member.failed === true).map(member => member.id ?? member.model)
            for (const id of ids) await post('/routes/failed/reset', { key: id })
            panel.reload()
          } catch (error) {
            showToast({ title: t('route.failed'), body: String(error?.message ?? error), tone: 'warn' })
          } finally { setBusy(false) }
        },
        onDelete: () => { if (confirm === group.id) void remove(group.id); else setConfirm(group.id) },
      })))

      const groupsSection = h(Section, { title: t('route.groups'), hint: t('route.groupsHint') },
        editing !== null
          ? h(GroupEditor, { t, models, group: editing.group, onSave: save, onCancel: () => setEditing(null) })
          : h('div', { className: 'ofm_row' },
            h(Button, { kind: 'primary', onClick: () => setEditing({ group: blank }) }, t('route.newGroup')),
            h('span', { className: 'ofm_note' }, t('route.priorityHint'))),
        groupCards,
        confirm === '' ? null : h('p', { className: 'ofm_note' }, t('route.deleteWarn')))

      return h(Fragment, null,
        hero,
        panel.status === 'loading' ? h(PanelSkeleton) : null,
        panel.status === 'error'
          ? h(PanelError, { t, title: t('route.loadFailed'), message: panel.error, onRetry: panel.reload })
          : null,
        panel.status === 'ready' ? h(Fragment, null, gateSection, groupsSection) : null)
    }

    // ── 上下文压缩阈值（原 dsh-compaction-threshold 的滑块）──────────────────
    /**
     * 压缩阈值卡。
     *
     * 数字有三个来源，界面必须分清：配置值（本插件存的）、下限（引擎保留比例
     * 推出来的）、实际值（引擎里现在真的在用的）。三个不一致时，只有最后一个
     * 能解释"为什么没压"。
     */
    function CompactionCard(props) {
      const { t } = props
      const panel = usePanel(() => api('/compaction'), [])
      const data = panel.data
      const [ratio, setRatio] = useState(75)
      const [busy, setBusy] = useState(false)
      useEffect(() => {
        if (data === undefined) return
        setRatio(Math.round((data.thresholdRatio ?? 0.75) * 100))
      }, [data?.thresholdRatio])
      const save = async patch => {
        setBusy(true)
        try {
          const answer = await post('/compaction', patch)
          panel.patch(answer)
        } catch (error) {
          showToast({ title: t('compaction.saveFailed'), body: String(error?.message ?? error), tone: 'warn' })
        } finally { setBusy(false) }
      }
      if (panel.status === 'error') {
        return h(Section, { title: t('compaction.title') },
          h(PanelError, { t, title: t('compaction.title'), message: panel.error, onRetry: panel.reload }))
      }
      if (data === undefined) return h(PanelSkeleton)
      const floor = Math.round((data.floor ?? 0.2) * 100)
      const max = Math.round((data.max ?? 0.95) * 100)
      return h(Section, { title: t('compaction.title'), hint: t('compaction.hint') },
        h('div', { className: 'ofm_panel' },
          h('div', { className: 'ofm_row' },
            h(Switch, {
              checked: data.enabled === true, label: t('compaction.enabled'), disabled: busy,
              onChange: () => { if (!busy) void save({ enabled: data.enabled !== true }) },
            }),
            h('span', { className: 'ofm_note' }, t('compaction.engines').replace('{n}', String(data.engineCount ?? 0)),
            data.effectiveRatio === null || data.effectiveRatio === undefined ? null : h('span', { className: 'ofm_note' }, ' · ' + t('compaction.effective').replace('{n}', String(Math.round(data.effectiveRatio * 100))))),
            data.followDefault === true ? h('Pill', null, t('compaction.followDefault')) : null),
          h('div', { className: 'ofm_row' },
            h('input', {
              type: 'range', min: floor, max, step: 1, value: ratio, disabled: busy,
              style: { flex: '1 1 220px' }, 'aria-label': t('compaction.threshold'),
              onChange: event => setRatio(Number(event.target.value)),
            }),
            h('span', { className: 'ofm_mono', style: { width: 52, textAlign: 'right' } }, `${ratio}%`)),
          h('p', { className: 'ofm_note' }, t('compaction.floor').replace('{n}', String(floor))),
          h('p', { className: 'ofm_note' }, t('compaction.advice')),
          data.supported === false ? h('div', { className: 'ofm_callout ofm_error' }, h('div', null, t('compaction.unsupported'))) : null,
          h('div', { className: 'ofm_row' },
            h(Button, { kind: 'primary', disabled: busy, onClick: () => void save({ thresholdRatio: ratio / 100 }) }, t('compaction.apply')),
            h(Button, { kind: 'ghost', disabled: busy, onClick: () => void save({ thresholdRatio: null }) }, t('compaction.restoreDefault'))),
          data.legacy === null || data.legacy === undefined ? null : h('p', { className: 'ofm_note' }, t('compaction.legacy').replace('{n}', String(Math.round(data.legacy.thresholdRatio * 100)))))
      )
    }

    // ── request retry (merged dsh-llm-error-retry) ───────────────────────────
    /**
     * 重试设置页。
     *
     * 旧插件只有一张设置卡；合并后放在模型面板里，位置仍然显眼。规则表沿用旧
     * 插件的四类匹配写法，但数值校验交给宿主（`host.js`），浏览器只负责把
     * 输入整理成它认识的结构，避免两套校验规则打架。
     */
    function RetryPage(props) {
      const { t } = props
      const panel = usePanel(() => retryApi(), [])
      const [rules, setRules] = useState([])
      const [honorSec, setHonorSec] = useState(10)
      const [firstEnabled, setFirstEnabled] = useState(true)
      const [firstSec, setFirstSec] = useState(90)
      const [nmEnabled, setNmEnabled] = useState(true)
      const [nmOffload, setNmOffload] = useState(true)
      const [nmMax, setNmMax] = useState(3)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState({ tone: '', text: '' })

      useEffect(() => {
        const data = panel.data
        if (data === undefined) return
        setRules((data.rules ?? []).map(rule => ({ code: rule.code, delaySec: Math.round((Number(rule.delayMs) || 0) / 1000), maxRetries: Number(rule.maxRetries) || 0 })))
        setHonorSec(Math.round((Number(data.honorRetryAfterMaxMs) || 0) / 1000))
        const first = data.firstTokenTimeout ?? {}
        setFirstEnabled(first.enabled !== false)
        setFirstSec(Math.max(1, Math.round((Number(first.timeoutMs) || 90_000) / 1000)))
        const nm = data.notMultimodal ?? {}
        setNmEnabled(nm.enabled !== false)
        setNmOffload(nm.offloadImages !== false)
        setNmMax(Math.max(1, Number(nm.maxNotices) || 3))
      }, [panel.data])

      const save = async () => {
        const number = (value, label) => {
          const parsed = Number(value)
          if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label}: ${t('llmretry.badNumber')}`)
          return parsed
        }
        setBusy(true); setNotice({ tone: '', text: '' })
        try {
          const payload = {
            rules: rules
              .filter(rule => String(rule.code).trim() !== '')
              .map(rule => ({
                code: String(rule.code).trim(),
                delayMs: Math.round(number(rule.delaySec, t('llmretry.delay')) * 1000),
                maxRetries: Math.round(number(rule.maxRetries, t('llmretry.maxRetries'))),
              })),
            honorRetryAfterMaxMs: Math.round(number(honorSec, t('llmretry.honor')) * 1000),
            firstTokenTimeout: { enabled: firstEnabled, timeoutMs: Math.round(number(firstSec, t('llmretry.firstToken')) * 1000) },
            notMultimodal: { enabled: nmEnabled, offloadImages: nmOffload, maxNotices: Math.round(number(nmMax, t('llmretry.maxNotices'))) },
          }
          await retryApi({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
          panel.reload()
          setNotice({ tone: 'ok', text: t('llmretry.saved') })
          showToast({ title: t('llmretry.title'), body: t('llmretry.saved') })
        } catch (error) {
          const message = String(error?.message ?? error)
          setNotice({ tone: 'err', text: message })
          showToast({ title: t('llmretry.saveFailed'), body: message, tone: 'warn' })
        } finally { setBusy(false) }
      }

      const patchRule = (index, key, value) => setRules(current => current.map((rule, cursor) => cursor === index ? { ...rule, [key]: value } : rule))

      if (panel.status === 'error') {
        return h('div', { className: 'ofm_page' },
          h(PanelError, { t, title: t('llmretry.title'), message: panel.error, onRetry: panel.reload }))
      }
      if (panel.data === undefined) return h('div', { className: 'ofm_page' }, h(PanelSkeleton))

      const data = panel.data
      const events = data.lastEvents ?? []
      return h('div', { className: 'ofm_page' },
        h('header', { className: 'ofm_hero ofm_glass' },
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' },
              h('h2', null, t('llmretry.title')),
              h('p', { className: 'ofm_pagesub' }, t('llmretry.hint')))),
          h('div', { className: 'ofm_pills' },
            h(Pill, { strong: true, tone: 'ok' }, `${t('llmretry.rules')} ${rules.length}`),
            h(Pill, null, `${t('llmretry.source')} ${data.source ?? '—'}`),
            h(Pill, null, `${t('llmretry.waiting')} ${data.waiting ?? 0}`))),

        h(Section, { title: t('llmretry.rules'), hint: t('llmretry.hint') },
          h('div', { className: 'ofm_panel' },
            h('div', { className: 'ofm_tablewrap' },
              h('table', { className: 'ofm_table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('llmretry.code')),
                  h('th', { className: 'ofm_num' }, t('llmretry.delay')),
                  h('th', { className: 'ofm_num' }, t('llmretry.maxRetries')),
                  h('th', null, ''))),
                h('tbody', null,
                  rules.length === 0
                    ? h('tr', null, h('td', { colSpan: 4 }, t('llmretry.emptyRules')))
                    : rules.map((rule, index) => h('tr', { key: index },
                      h('td', null, h('input', {
                        className: 'ofm_input', value: rule.code, spellCheck: false,
                        placeholder: '429 / TRANSPORT / msg~…',
                        onChange: event => patchRule(index, 'code', event.target.value),
                      })),
                      h('td', { className: 'ofm_num' }, h('input', {
                        className: 'ofm_input', type: 'number', min: 0, step: 1, value: rule.delaySec,
                        style: { width: 92, textAlign: 'right' },
                        onChange: event => patchRule(index, 'delaySec', event.target.value),
                      })),
                      h('td', { className: 'ofm_num' }, h('input', {
                        className: 'ofm_input', type: 'number', min: 0, step: 1, value: rule.maxRetries,
                        style: { width: 92, textAlign: 'right' },
                        onChange: event => patchRule(index, 'maxRetries', event.target.value),
                      })),
                      h('td', { className: 'ofm_num' },
                        h('button', {
                          type: 'button', className: 'ofm_minibtn danger',
                          onClick: () => setRules(current => current.filter((_, cursor) => cursor !== index)),
                        }, '×')))))),
            h('div', { className: 'ofm_row' },
              h(Button, { onClick: () => setRules(current => [...current, { code: '', delaySec: 5, maxRetries: 5 }]) }, t('llmretry.add'))))),

        h(Section, { title: t('llmretry.firstToken'), hint: t('llmretry.firstTokenHint') },
          h('div', { className: 'ofm_panel' },
            h('div', { className: 'ofm_row' },
              h(Switch, { checked: firstEnabled, label: t('llmretry.enabled'), onChange: () => setFirstEnabled(value => !value) }),
              h('label', { className: 'ofm_field', style: { maxWidth: 180 } },
                h('span', null, t('llmretry.seconds')),
                h('input', { className: 'ofm_input', type: 'number', min: 1, step: 1, value: firstSec, disabled: !firstEnabled, onChange: event => setFirstSec(event.target.value) }))),
            h('div', { className: 'ofm_row' },
              h('label', { className: 'ofm_field', style: { maxWidth: 220 } },
                h('span', null, t('llmretry.honor')),
                h('input', { className: 'ofm_input', type: 'number', min: 0, step: 1, value: honorSec, onChange: event => setHonorSec(event.target.value) })),
              h('span', { className: 'ofm_note' }, t('llmretry.honorHint'))))),

        h(Section, { title: t('llmretry.notMultimodal') },
          h('div', { className: 'ofm_panel' },
            h('div', { className: 'ofm_row' },
              h(Switch, { checked: nmEnabled, label: t('llmretry.enabled'), onChange: () => setNmEnabled(value => !value) }),
              h(Switch, { checked: nmOffload, label: t('llmretry.offload'), disabled: !nmEnabled, onChange: () => setNmOffload(value => !value) })),
            h('label', { className: 'ofm_field', style: { maxWidth: 220 } },
              h('span', null, t('llmretry.maxNotices')),
              h('input', { className: 'ofm_input', type: 'number', min: 1, step: 1, value: nmMax, disabled: !nmEnabled, onChange: event => setNmMax(event.target.value) })))),

        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'primary', disabled: busy, onClick: save }, busy ? t('loading') : t('llmretry.save')),
          notice.text === '' ? null : h('span', { className: notice.tone === 'err' ? 'ofm_note' : 'ofm_note', style: notice.tone === 'err' ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined }, notice.text)),

        h(Section, { title: t('llmretry.events') },
          h('div', { className: 'ofm_panel' },
            events.length === 0
              ? h('p', { className: 'ofm_note' }, t('llmretry.noEvents'))
              : h('div', { className: 'ofm_retryevents' },
                events.map((event, index) => h('div', { key: index, className: 'ofm_retryevent' },
                  h('span', { className: 'ofm_note' }, event.at === undefined ? '' : new Date(event.at).toLocaleTimeString()),
                  h('b', null, event.type ?? 'event'),
                  event.rule === undefined ? null : h('span', { className: 'ofm_id' }, event.rule),
                  event.failure === undefined ? null : h('span', { className: 'ofm_note' }, String(event.failure).slice(0, 90)))))))))
    }

    // ── model panel: a working, session-scoped picker ────────────────────────
    /** Sidebar glyph: a small sparkle, drawn inline so no asset is required. */
    function ModelSidebarIcon(props) {
      const size = Number(props.size) || 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L6 12.5l5.1-1.9z' }),
        h('path', { d: 'M18.5 3.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z' }))
    }

    /**
     * 聊天框的闪光按钮打开「模型面板」；侧栏「模型」打开完整设置。
     *
     * 模型选择是**会话级**状态，唯一可靠来源是宿主的 `modelDirectories`
     * 服务（原生选择器与 model-failover-manager 的模型位共用它），所以面板
     * 必须带着 `sessionId` 打开：`conversation.input.right` 的标准 props 里
     * 就有 sessionId，点按钮时一并带进事件。从公告等没有会话的入口打开时，
     * 面板会明确说「先打开一个会话」，而不是画一个点了没反应的列表。
     */
    function openModelPanel(tab, sessionId) {
      try {
        window.dispatchEvent(new CustomEvent('ofm:open-panel', { detail: { tab: tab ?? 'models', scope: 'model', sessionId } }))
      } catch { /* a host without window events is already unusable */ }
    }

    /** 设置页里的压缩/重试入口仍走完整设置面，不进模型面板。 */
    function openSettingsPanel(tab) {
      try {
        window.dispatchEvent(new CustomEvent('ofm:open-panel', { detail: { tab: tab ?? 'pipeline', scope: 'settings' } }))
      } catch { /* a host without window events is already unusable */ }
    }

    /** The directory's pre-load shape, so the first paint is a loading state, not a crash. */
    const EMPTY_DIRECTORY = { current: null, routable: null, groups: [], failures: [], status: 'idle', pending: null, error: null }

    /**
     * 会话的模型目录 —— 宿主 model-selection 的同一份状态。
     *
     * `ctx.get` 是可选查找：宿主没有该服务、或这个会话还没有 binding 时，
     * 面板显示具体原因（服务缺失 / 会话未就绪），而不是空白或假选项。
     */
    function useModelDirectory(ctx, sessionId) {
      const [directory, setDirectory] = useState(undefined)
      const [state, setState] = useState(EMPTY_DIRECTORY)
      const [error, setError] = useState('')
      useEffect(() => {
        setDirectory(undefined)
        setState(EMPTY_DIRECTORY)
        setError('')
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        const service = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('modelDirectories') : undefined
        if (service === undefined || typeof service.directoryFor !== 'function') {
          setError('model-selection service is unavailable in this shell')
          return undefined
        }
        let found
        try { found = service.directoryFor(sessionId) } catch (cause) {
          setError(String(cause?.message ?? cause))
          return undefined
        }
        setDirectory(found)
        const sync = () => setState(found.store.getSnapshot())
        sync()
        const off = found.store.subscribe(sync)
        found.load().catch(cause => { setError(String(cause?.message ?? cause)) })
        return off
      }, [ctx, sessionId])
      return { directory, state, error }
    }

    /** 徽章文案可能是字符串，也可能是按语言分键的对象（LocalizedText）。 */
    function badgeTextOf(badge) {
      const text = badge?.text
      if (typeof text === 'string') return text
      if (text === null || typeof text !== 'object') return ''
      return text.zh ?? text['zh-CN'] ?? text.en ?? Object.values(text)[0] ?? ''
    }

    /**
     * 模型选择器。
     *
     * 目录、当前选择与提交全部走宿主 `modelDirectories`：这里只负责把
     * provider 组、模型行与思考档渲染出来，点一行就真的切过去 —— 旧版只画
     * 列表、点了没反应，正是「对话框模型面板做的不好」的根源。
     */
    /**
     * 路由分组编辑器（模型面板内）。
     *
     * 设置页那张表太宽、加模型还要来回滚动；这里按 failover 的同款结构做成
     * 「左边分组、右边成员」，成员行直接带优先级、档位、失败/启停与移出，
     * 加模型在同一个面板里搜索 + 一键加入。每次改动都整表 POST /routes，
     * 服务端是唯一权威，面板跟着 reload。
     */
    function RouteGroupPanel(props) {
      const { t, routes, catalogGroups, current, busy, setBusy, setNotice, notice, onUse } = props
      const groups = routes.data?.groups ?? []
      const [selected, setSelected] = useState(null)
      const [adding, setAdding] = useState(false)
      const [query, setQuery] = useState('')
      const [picked, setPicked] = useState([])
      const [newName, setNewName] = useState('')
      const active = groups.find(group => group.id === selected) ?? groups[0]
      const shape = group => ({
        id: group.id,
        name: group.name,
        enabled: group.enabled !== false,
        models: (group.models ?? []).map(member => ({
          model: member.model,
          provider: member.provider,
          priority: member.priority,
          effort: member.effort,
          windows: member.windows,
          legacy: member.legacy,
          disabled: member.disabled === true ? true : undefined,
        })),
      })
      const save = async nextGroups => {
        if (busy !== '') return
        setBusy('routes')
        setNotice('')
        try {
          await post('/routes', { groups: nextGroups.map(shape) })
          routes.reload()
        } catch (cause) {
          setNotice(String(cause?.message ?? cause))
        } finally {
          setBusy('')
        }
      }
      const patchMember = (group, index, patch) => save(groups.map(item => item.id !== group.id
        ? shape(item)
        : { ...shape(item), models: shape(item).models.map((member, at) => at === index ? { ...member, ...patch } : member) }))
      const removeMember = (group, index) => save(groups.map(item => item.id !== group.id
        ? shape(item)
        : { ...shape(item), models: shape(item).models.filter((member, at) => at !== index) }))
      /** 新成员一律排到组末：优先级 = 现有最大值 + 10（0 是最高优先）。 */
      const nextPriority = list => Math.min(999, (list ?? []).reduce((max, member) => Math.max(max, Number(member?.priority) || 0), 0) + 10)
      const addMember = (group, entry) => {
        if ((group.models ?? []).some(member => member.model === entry.id)) return
        save(groups.map(item => item.id !== group.id
          ? shape(item)
          : { ...shape(item), models: [...shape(item).models, { model: entry.id, provider: entry.provider, priority: nextPriority(item.models) }] }))
      }
      const createGroup = () => {
        const name = newName.trim()
        if (name === '') return
        setNewName('')
        save([...groups.map(shape), { name, models: [] }])
      }
      const deleteGroup = group => {
        if (groups.length <= 1) return
        setSelected(null)
        save(groups.filter(item => item.id !== group.id).map(shape))
      }
      const remap = async () => {
        if (busy !== '') return
        setBusy('remap')
        setNotice('')
        try {
          const result = await post('/routes/remap', {})
          const unresolved = result?.unresolved ?? []
          setNotice(unresolved.length === 0
            ? t('panel.routes.remapDone').replace('{n}', String(result?.changed ?? 0))
            : t('panel.routes.remapLeft').replace('{n}', String(unresolved.length)))
          routes.reload()
        } catch (cause) {
          setNotice(String(cause?.message ?? cause))
        } finally {
          setBusy('')
        }
      }
      // 「添加模型」的候选：按宿主目录的渠道分组，跨渠道搜索；已加入的置灰。
      // 多选 + 底部一次提交，加十几个模型只发一趟 POST（原来一个模型一趟）。
      //
      // ⚠️ 成员坐标必须是**本插件 `/routes` 目录里的 id**，不能拼「路由名/裸 id」：
      // 免费车道的目录 id 是裸名（`deepseek-v4.1-flash-free`），Kilo 是
      // `org/model:free`，聚合渠道已经是 `provider/model`。以前无条件拼
      // `${group.id}/${model.id}`，于是免费车道与 Kilo 的成员变成
      // `our-free-model/...`，`memberEntry` 精确匹配不到 ⇒ 面板显示「目录缺失」。
      // `/routes` 返回的 `models[]` 就是权威目录，这里用它判断裸 id 是否已可用。
      const canonical = new Set((routes.data?.models ?? []).map(row => String(row.id ?? '')))
      const memberIdOf = rawId => {
        const id = String(rawId ?? '')
        return canonical.has(id) ? id : id
      }
      const needle = query.trim().toLowerCase()
      const addGroups = catalogGroups.map(group => ({
        id: group.id,
        name: group.name ?? group.id,
        models: (group.models ?? [])
          // 虚拟行（路由分组 / 组合链）不能当另一个分组的成员：服务端会跳过，
          // 列出来只会让人白点一次。
          .filter(model => !String(model.id).startsWith('route:') && !String(model.id).startsWith('combo:'))
          .map(model => ({
            // 目录 id 原样使用，和 `/routes` 的 `models[].id` 同一套；
            // 拼前缀会让免费车道/Kilo 的成员永远解析不到。
            id: memberIdOf(model.id),
            modelId: model.id,
            name: model.name ?? model.id,
            description: model.description ?? '',
            provider: group.id,
          }))
          .filter(row => needle === '' || `${row.name} ${row.id} ${row.provider}`.toLowerCase().includes(needle)),
      })).filter(group => group.models.length > 0)
      const rowOf = new Map()
      for (const group of catalogGroups) {
        for (const model of group.models ?? []) {
          const id = memberIdOf(model.id)
          if (!rowOf.has(id)) rowOf.set(id, { id, provider: group.id })
        }
      }
      if (routes.status === 'error') {
        return h('div', { className: 'ofm_mpickempty' }, h('b', null, t('loadFailed')), h('span', null, routes.error))
      }
      if (routes.status !== 'ready') {
        return h('div', { className: 'ofm_mpickempty' }, h('b', null, t('loading')))
      }
      if (groups.length === 0) {
        return h('div', { className: 'ofm_mpickempty' },
          h('b', null, t('panel.tab.routes')),
          h('span', null, t('panel.routes.empty')),
          h('div', { className: 'ofm_row' },
            h('input', {
              className: 'ofm_input', placeholder: t('panel.routes.nameHint'), value: newName,
              onChange: event => setNewName(event.currentTarget.value),
            }),
            h('button', { type: 'button', className: 'ofm_btn ofm_btn--primary', disabled: busy !== '', onClick: createGroup }, t('panel.routes.create'))))
      }
      const members = active?.models ?? []
      // 成员坐标可能有两种写法（目录 id，或迁移数据里的「裸名 + provider」），
      // 统一折算成目录 id 再比对，否则「已加入」判不出来、批量加会出现重复。
      //
      // 服务端 `describeGroup` 已经用 `memberEntry` 把可解析的成员折成了目录 id
      // （`member.id`）—— 优先级最高。旧数据里 `our-free-model/<裸 id>` 这种带
      // adapter 路由前缀的坐标，只有服务端知道该剥哪一层。
      const memberKeys = new Set()
      for (const member of members) {
        if (typeof member.id === 'string' && member.id !== '') {
          memberKeys.add(member.id)
          continue
        }
        if (typeof member.model !== 'string' || member.model === '') continue
        if (member.model.includes('/') || typeof member.provider !== 'string' || member.provider === '') memberKeys.add(member.model)
        else memberKeys.add(`${member.provider}/${member.model}`)
      }
      const isMember = row => memberKeys.has(row.id)
      const togglePicked = id => setPicked(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
      /** 一次加入所有勾选的成员（跳过已存在的），只发一趟 POST。 */
      const addPicked = () => {
        if (busy !== '' || active === undefined) return
        const fresh = picked.filter(id => !memberKeys.has(id))
        if (fresh.length === 0) { setPicked([]); return }
        let priority = nextPriority(members)
        const additions = fresh.map(id => {
          const row = rowOf.get(id)
          const member = { model: id, priority }
          if (row?.provider !== undefined) member.provider = row.provider
          priority = Math.min(999, priority + 10)
          return member
        })
        setPicked([])
        save(groups.map(item => item.id !== active.id
          ? shape(item)
          : { ...shape(item), models: [...shape(item).models, ...additions] }))
      }
      const pickProvider = group => {
        const ids = group.models.map(row => row.id).filter(id => !memberKeys.has(id))
        const all = ids.length > 0 && ids.every(id => picked.includes(id))
        setPicked(current => all
          ? current.filter(id => !ids.includes(id))
          : [...new Set([...current, ...ids])])
      }
      return h('div', { className: 'ofm_mpickerbody' },
        h('aside', { className: 'ofm_mpickerrail' },
          h('div', { className: 'ofm_mpickerrailtitle' }, t('panel.routes.groups')),
          h('div', { className: 'ofm_mpickerraillist' }, groups.map(group => h('button', {
            key: group.id, type: 'button', className: 'ofm_mpickerrailrow',
            'data-on': active?.id === group.id ? 'true' : 'false',
            onClick: () => { setSelected(group.id); setAdding(false); setPicked([]); setQuery('') },
          },
            h('span', { className: 'ofm_mpickerrailname', title: group.name }, group.name),
            h('span', { className: 'ofm_mpickerrailcount' }, String((group.models ?? []).length))))),
          h('div', { className: 'ofm_mpickerrailnew' },
            h('input', {
              className: 'ofm_input', placeholder: t('panel.routes.nameHint'), value: newName,
              onChange: event => setNewName(event.currentTarget.value),
              onKeyDown: event => { if (event.key === 'Enter') createGroup() },
            }),
            h('button', { type: 'button', className: 'ofm_minibtn', disabled: busy !== '', onClick: createGroup }, t('panel.routes.create')))),
        h('div', { className: 'ofm_mpickerpane' },
          h('div', { className: 'ofm_mpickertools ofm_row' },
            h('b', { className: 'ofm_pickertitle' }, active?.name ?? ''),
            current !== null && current.model === active?.id
              ? h('span', { className: 'ofm_mpickcurrent' }, t('panel.current'))
              : null,
            h('span', { className: 'ofm_mpickerspacer' }),
            h('button', { type: 'button', className: 'ofm_btn ofm_btn--primary', disabled: busy !== '', onClick: () => onUse(active) }, t('panel.routes.use')),
            h('button', { type: 'button', className: 'ofm_minibtn', disabled: busy !== '', onClick: remap }, t('panel.routes.remap')),
            h('button', { type: 'button', className: 'ofm_minibtn', disabled: busy !== '', onClick: () => deleteGroup(active) }, t('panel.routes.delete'))),
          h('div', { className: 'ofm_mpickerlist' },
            members.length === 0
              ? h('div', { className: 'ofm_mpickempty' }, h('b', null, t('panel.routes.noMembers')), h('span', null, t('panel.routes.addHint')))
              : members.map((member, index) => h('div', { key: `${member.model}-${index}`, className: 'ofm_mpickmember', 'data-off': member.disabled === true ? 'true' : 'false' },
                h('span', { className: 'ofm_mpickmembermain' },
                  h('span', { className: 'ofm_mpicknamerow' },
                    h('span', { className: 'ofm_mpickname' }, member.name ?? member.model),
                    member.available === false
                      ? h('span', { className: 'ofm_mpickbadge', title: member.model }, t('panel.routes.missing'))
                      : null,
                    member.failed === true ? h('span', { className: 'ofm_mpickbadge', 'data-tone': 'warn' }, t('panel.routes.failedMark')) : null),
                  h('span', { className: 'ofm_mpickdesc' }, member.model)),
                h('span', { className: 'ofm_mpickmembertools' },
                  h('input', {
                    className: 'ofm_input ofm_mpicknum', type: 'number', min: 0, max: 999, title: t('panel.routes.priority'),
                    defaultValue: member.priority ?? 50,
                    onBlur: event => {
                      const value = Number(event.currentTarget.value)
                      if (!Number.isFinite(value) || value === (member.priority ?? 50)) return
                      patchMember(active, index, { priority: value })
                    },
                  }),
                  (member.efforts ?? []).length === 0
                    ? h('span', { className: 'ofm_note' }, t('route.effortFollow'))
                    : h('select', {
                      className: 'ofm_input ofm_mpickeffort', title: t('route.effort'),
                      value: member.effort ?? '',
                      onChange: event => patchMember(active, index, { effort: event.currentTarget.value }),
                    },
                      h('option', { value: '' }, t('route.effortFollow')),
                      (member.efforts ?? []).map(level => h('option', { key: level, value: level }, level)),
                      member.effort !== undefined && member.effort !== '' && !(member.efforts ?? []).includes(member.effort)
                        ? h('option', { value: member.effort }, `${member.effort} (?)`)
                        : null),
                  member.failed === true
                    ? h('button', {
                      type: 'button', className: 'ofm_minibtn', disabled: busy !== '',
                      onClick: async () => {
                        try { await post('/routes/failed/reset', { key: member.id ?? member.model }); routes.reload() } catch (cause) { setNotice(String(cause?.message ?? cause)) }
                      },
                    }, t('panel.failed.reset'))
                    : null,
                  h('button', {
                    type: 'button', className: 'ofm_minibtn', disabled: busy !== '',
                    onClick: () => patchMember(active, index, { disabled: member.disabled === true ? undefined : true }),
                  }, member.disabled === true ? t('panel.routes.enable') : t('panel.routes.disable')),
                  h('button', {
                    type: 'button', className: 'ofm_minibtn', disabled: busy !== '',
                    onClick: () => removeMember(active, index),
                  }, '×'))))),
          // 添加面单独一块，而不是塞进成员列表：成员列表是滚动容器，
          // 塞进去会把「添加 N 个」一起卷到看不见的地方。
          adding
            ? h('div', { className: 'ofm_mpickadd' },
                h('div', { className: 'ofm_mpickaddbar' },
                  h('input', {
                    className: 'ofm_panelsearch', type: 'search', value: query,
                    placeholder: t('panel.routes.addSearch'), autoFocus: true,
                    onChange: event => setQuery(event.currentTarget.value),
                  }),
                  picked.length === 0
                    ? null
                    : h('button', { type: 'button', className: 'ofm_minibtn', onClick: () => setPicked([]) }, t('panel.routes.pickClear'))),
                h('div', { className: 'ofm_mpickaddlist' },
                  addGroups.length === 0
                    ? h('div', { className: 'ofm_mpickempty' }, h('b', null, t('panel.noMatch')))
                    : addGroups.map(group => {
                      const addable = group.models.filter(row => !isMember(row)).map(row => row.id)
                      const allPicked = addable.length > 0 && addable.every(id => picked.includes(id))
                      return h('div', { key: group.id, className: 'ofm_mpickaddgroup' },
                        h('div', { className: 'ofm_mpickaddgrouphead' },
                          h('span', null, group.name),
                          h('span', { className: 'ofm_mpickgroupcount' }, String(group.models.length)),
                          addable.length === 0
                            ? null
                            : h('button', {
                              type: 'button', className: 'ofm_minibtn',
                              onClick: () => pickProvider(group),
                            }, allPicked ? t('panel.routes.pickNone') : t('panel.routes.pickAll'))),
                        group.models.map(row => {
                          const added = isMember(row)
                          const on = picked.includes(row.id)
                          return h('label', {
                            key: row.id, className: 'ofm_mpickaddrow', title: row.id,
                            'data-picked': on ? 'true' : 'false',
                            'data-added': added ? 'true' : 'false',
                          },
                            h('input', {
                              type: 'checkbox', checked: added || on, disabled: added,
                              onChange: () => { if (!added) togglePicked(row.id) },
                            }),
                            h('span', { className: 'ofm_mpickaddmain' },
                              h('span', { className: 'ofm_mpickname' }, row.name),
                              h('span', { className: 'ofm_mpickdesc' }, added ? t('panel.routes.added') : row.id)),
                            added
                              ? null
                              : h('button', {
                                type: 'button', className: 'ofm_minibtn', disabled: busy !== '',
                                onClick: event => { event.preventDefault(); event.stopPropagation(); addMember(active, row) },
                              }, '+'))
                        }))
                    })),
                h('div', { className: 'ofm_mpickaddfoot' },
                  h('button', {
                    type: 'button', className: 'ofm_btn ofm_btn--primary',
                    disabled: busy !== '' || picked.length === 0, onClick: addPicked,
                  }, t('panel.routes.bulkAdd').replace('{n}', String(picked.length))),
                  h('span', { className: 'ofm_note' }, t('panel.routes.bulkHint'))))
            : null,
          h('div', { className: 'ofm_mpickerfoot' },
            h('button', { type: 'button', className: 'ofm_minibtn', onClick: () => { setAdding(!adding); setQuery(''); setPicked([]) } }, adding ? t('panel.routes.addClose') : t('panel.routes.add')),
            h('span', { className: 'ofm_note' }, notice !== '' ? notice : t('panel.failed.hint')))))
    }

    function ModelPickerDialog(props) {
      const { t, ctx, sessionId, onClose } = props
      const { directory, state, error } = useModelDirectory(ctx, sessionId)
      const [mode, setMode] = useState('models')
      const [query, setQuery] = useState('')
      const [provider, setProvider] = useState(undefined)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      // 路由分组与失败名单来自本插件自己的宿主路由（`/routes`），与设置页同一个
      // 数据源；模型页只读宿主会话目录。两者都不用轮询。
      const routes = usePanel(() => api('/routes'), [])
      // 可用性结论来自本插件的 `/summary`（探测结果 + 设置）。宿主目录只报
      // 「有哪些模型」，不报「这台机器能不能用」——没有这份数据，面板就只能
      // 把探测失败的模型画成和可用模型一模一样的一行。
      const summary = usePanel(() => api('/summary'), [])
      const verdicts = useMemo(() => {
        const table = new Map()
        for (const row of summary.data?.catalog ?? []) table.set(String(row.id ?? ''), row)
        return table
      }, [summary.data])
      const hideUnavailable = summary.data?.settings?.hideUnavailableModels === true
      const routeGroups = routes.data?.groups ?? []
      const failed = routes.data?.failed ?? []
      const current = state.pending ?? state.current
      const groups = state.groups ?? []
      const needle = query.trim().toLowerCase()
      /**
       * 只有**免费车道自己**的行才有可用性结论：`channel` 字段标着别的车道
       * （own / kilo / aggregate / combo / route）时，宿主目录里的「能不能选」
       * 由登录态、Key、成员解析决定，不是探测结论。给它们贴「未探测」只会误导，
       * 所以角标与隐藏都只管没有 `channel` 的行。
       */
      const verdictOf = model => {
        const row = verdicts.get(String(model.id ?? ''))
        return row === undefined || row.channel !== undefined ? undefined : row
      }
      /**
       * 有**明确负面结论**的行：地区受限 / 探测不可用 / 限流。
       *
       * 「未探测」不算：它什么都还没证明，藏起来会让一次刷新后的新模型凭空
       * 消失。这类行留着，挂一个灰色「未探测」角标，等下一轮探测给结论。
       */
      const isDead = model => {
        const availability = verdictOf(model)?.availability
        return availability === 'unavailable' || availability === 'region-blocked' || availability === 'throttled'
      }
      const keepModel = model => !hideUnavailable || !isDead(model)
      // 被开关折叠掉的行数：页脚如实说明「少了几行」，而不是让列表悄悄变短。
      const hiddenCount = hideUnavailable
        ? groups.reduce((sum, group) => sum + group.models.filter(model => !keepModel(model)).length, 0)
        : 0
      /**
       * 宿主目录里根本没有的免费车道行：`membership` 会把探测为 unavailable 的
       * 行剔除，于是它们连「可切换」都做不到。既然列表里看不到，就在页脚说明
       * 有几个、去哪儿处理（重探测），而不是让用户以为模型清单本来就那么短。
       */
      const droppedCount = (summary.data?.catalog ?? []).filter(row => row.channel === undefined
        && row.route === null
        && row.availability === 'unavailable').length
      // 搜索框一有内容就跨全部提供商（否则要先去左边点一家才能搜别家）；空搜索时
      // 只看左侧选中的那一家。左栏不再放「免费模型 / 全部」这一行——它和「所有
      // 提供商」是同义重复，默认跟随当前模型所属的那家即可。
      const searchAll = needle !== ''
      const matches = (group, model) => `${model.name ?? ''} ${model.id ?? ''} ${model.description ?? ''} ${group.name ?? ''}`.toLowerCase().includes(needle)
      const followed = provider === undefined ? (current?.provider ?? null) : provider
      const activeProvider = followed !== null && groups.some(group => group.id === followed) ? followed : null
      const visible = searchAll
        ? groups.map(group => ({ group, models: group.models.filter(model => keepModel(model) && matches(group, model)) })).filter(entry => entry.models.length > 0)
        : groups.filter(group => group.id === activeProvider).map(group => ({ group, models: group.models.filter(keepModel) }))
      /**
       * 聚合渠道的行和免费车道的行车在同一个提供商组里（都挂在本插件的路由上），
       * 平铺时外观一模一样。按 `summary.catalog` 的 `channel` 把一组再拆成两段，
       * 中间加一条小标题；只有聚合行时才拆，免费车道保持原样。
       */
      const laneOfModel = model => verdicts.get(String(model.id ?? ''))?.channel === 'aggregate' ? 'aggregate' : 'free'
      const splitLanes = list => {
        const free = list.filter(model => laneOfModel(model) !== 'aggregate')
        const aggregate = list.filter(model => laneOfModel(model) === 'aggregate')
        return [['free', free], ['aggregate', aggregate]].filter(([, rows]) => rows.length > 0)
      }
      // 当前视图（同一家提供商 / 同一次搜索）里被折叠掉的行数。页脚的 hiddenCount
      // 说的是整份清单，空状态要说的是"你眼前这一屏为什么是空的"。
      const viewHidden = (searchAll ? groups : groups.filter(group => group.id === activeProvider))
        .reduce((sum, group) => sum + group.models.filter(model => !keepModel(model) && (!searchAll || matches(group, model))).length, 0)
      const loading = (state.status === 'loading' || state.status === 'idle') && groups.length === 0 && error === ''
      const choose = async (providerId, modelId, effort) => {
        if (directory === undefined || busy !== '') return false
        const key = `${providerId}/${modelId}`
        setBusy(key)
        setNotice('')
        const selection = { provider: providerId, model: modelId }
        if (effort !== undefined) selection.reasoningEffort = effort
        try {
          const result = await directory.select(selection)
          if (result !== undefined && result.ok === false) {
            setNotice(`${result.error?.code ?? 'error'}: ${result.error?.message ?? ''}`)
            return false
          }
          onClose()
          return true
        } catch (cause) {
          setNotice(String(cause?.message ?? cause))
          return false
        } finally {
          setBusy('')
        }
      }
      // `route:*` 也是模型：在会话目录里找到它所属的提供商，走同一条 select。
      const useRouteGroup = group => {
        const owner = groups.find(entry => entry.models.some(model => model.id === group.id))
        if (owner === undefined) {
          setNotice(t('panel.routes.empty'))
          return
        }
        void choose(owner.id, group.id)
      }
      const resetFailed = async key => {
        if (routes.status === 'loading') return
        setBusy(`failed:${key ?? 'all'}`)
        setNotice('')
        try {
          await post('/routes/failed/reset', key === undefined ? {} : { key })
          routes.reload()
        } catch (cause) {
          setNotice(String(cause?.message ?? cause))
        } finally {
          setBusy('')
        }
      }
      const resetCooldown = async () => {
        setBusy('cooldown')
        setNotice('')
        try {
          await post('/routes/cooldown/reset', {})
          routes.reload()
        } catch (cause) {
          setNotice(String(cause?.message ?? cause))
        } finally {
          setBusy('')
        }
      }
      const tab = (id, label, count) => h('button', {
        key: id, type: 'button', className: 'ofm_mpicktab',
        'data-on': mode === id ? 'true' : 'false',
        'aria-selected': mode === id ? 'true' : 'false', role: 'tab',
        onClick: () => setMode(id),
      }, label, count === null || count === undefined || count === 0 ? null : h('span', { className: 'ofm_mpicktabnum' }, String(count)))
      const head = h('div', { className: 'ofm_mpickerhead' },
        h('span', { className: 'ofm_mpickertitle' }, t('panel.selectModel')),
        h('div', { className: 'ofm_mpicktabs', role: 'tablist' },
          tab('models', t('panel.tab.models'), null),
          tab('routes', t('panel.tab.routes'), routeGroups.length),
          tab('failed', t('panel.tab.failed'), failed.length)),
        h('span', { className: 'ofm_mpickerspacer' }),
        h('button', {
          type: 'button', className: 'ofm_close',
          'aria-label': t('panel.close'), title: t('panel.close'), onClick: onClose,
        }, '×'))
      if (typeof sessionId !== 'string' || sessionId === '') {
        return h('div', { className: 'ofm_mpicker', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('panel.selectModel') },
          head,
          h('div', { className: 'ofm_mpickempty' },
            h('b', null, t('panel.sessionRequired')),
            h('button', { type: 'button', className: 'ofm_minibtn', onClick: () => { onClose(); openSettingsPanel('free') } }, t('panel.settingsLink'))))
      }
      /** One provider group, split into the free lane and the aggregate lane.
       *  Returns a flat keyed array, so the caller can `flatMap` without another
       *  level of fragments per group. */
      const laneSections = entry => {
        const lanes = splitLanes(entry.models)
        const nodes = []
        if (activeProvider === null || searchAll) {
          nodes.push(h('div', { key: `${entry.group.id}:head`, className: 'ofm_mpickgroup' },
            entry.group.name,
            h('span', { className: 'ofm_mpickgroupcount' }, String(entry.models.length))))
        }
        for (const [lane, rows] of lanes) {
          if (lanes.length > 1) {
            nodes.push(h('div', { key: `${entry.group.id}:${lane}:head`, className: 'ofm_mpicklane' },
              t(lane === 'aggregate' ? 'panel.laneAggregate' : 'panel.laneFree'),
              h('span', { className: 'ofm_mpickgroupcount' }, String(rows.length))))
          }
          for (const model of rows) nodes.push(modelRow(entry.group, model))
        }
        return nodes
      }
      /** One selectable model row (plus its effort shortcuts). */
      const modelRow = (group, model) => {
        const isCurrent = current !== null && current.provider === group.id && current.model === model.id
        const key = `${group.id}/${model.id}`
        const efforts = Array.isArray(model.reasoning?.efforts) ? model.reasoning.efforts : []
        const activeEffort = current?.reasoningEffort ?? model.reasoning?.defaultEffort
        const badge = badgeTextOf(model.badge)
        // 可用性角标：有结论且不是「可用」才画，可用行保持干净。
        // 未探测的行同样要标出来——否则它和刚探测通过的行长得一样，
        // 用户点下去才发现要等一次失败。
        const verdict = verdictOf(model)
        const availability = verdict?.availability
        const dead = isDead(model)
        const stateBadge = availability === undefined || availability === 'available'
          ? null
          : availability === 'unknown'
            // 一次探测都还没跑（probedAt 为 0）时全目录都是 unknown，
            // 给每一行都挂「未探测」只是噪音；已经有探测时间戳却不
            // 是可用/不可用，才是值得标出来的「这一行没结论」。
            ? ((summary.data?.probedAt ?? 0) > 0 ? { text: t('state.unknown'), tone: 'dim' } : null)
            : availability === 'region-blocked'
              ? { text: t('state.region-blocked'), tone: 'region' }
              : availability === 'throttled'
                ? { text: t('state.throttled'), tone: 'warn' }
                : { text: t('state.unavailable'), tone: 'warn' }
        return h('div', { key, className: 'ofm_mpickitem' },
          h('button', {
            type: 'button', className: 'ofm_mpickrow',
            'data-current': isCurrent ? 'true' : 'false',
            'data-dead': dead ? 'true' : 'false',
            disabled: busy !== '',
            title: verdict?.detail === undefined || verdict.detail === '' ? model.id : `${model.id}\n${verdict.detail}`,
            onClick: () => void choose(group.id, model.id),
          },
            h('span', { className: 'ofm_mpickmain' },
              h('span', { className: 'ofm_mpicknamerow' },
                h('span', { className: 'ofm_mpickname' }, model.name ?? model.id),
                badge === '' ? null : h('span', { className: 'ofm_mpickbadge' }, badge),
                stateBadge === null
                  ? null
                  : h('span', { className: 'ofm_mpickbadge', 'data-tone': stateBadge.tone }, stateBadge.text)),
              model.description === undefined || model.description === ''
                ? null
                : h('span', { className: 'ofm_mpickdesc' }, model.description)),
            h('span', { className: 'ofm_mpickid' }, model.id),
            isCurrent ? h('span', { className: 'ofm_mpickcurrent' }, t('panel.current')) : null,
            busy === key ? h('span', { className: 'ofm_mpickspinner' }, '…') : null),
          // 档位跟着模型走：不先把模型切过去也能直接「这个模型 + 这一档」。
          // 当前模型的档位高亮，其余模型只做入口，点一下即切换。
          efforts.length > 1
            ? h('div', { className: 'ofm_mpickefforts' }, efforts.map(effort => h('button', {
              key: effort.id, type: 'button', className: 'ofm_minibtn',
              'data-on': isCurrent && activeEffort === effort.id ? 'true' : 'false',
              disabled: busy !== '',
              title: effort.description ?? '',
              onClick: () => void choose(group.id, model.id, effort.id),
            }, effort.name)))
            : null)
      }
      const modelBody = h('div', { className: 'ofm_mpickerbody' },
        h('aside', { className: 'ofm_mpickerrail' },
          h('div', { className: 'ofm_mpickerrailtitle' }, t('panel.providers')),
          h('div', { className: 'ofm_mpickerraillist' }, groups.map(group => h('button', {
            key: group.id, type: 'button', className: 'ofm_mpickerrailrow',
            'data-on': activeProvider === group.id ? 'true' : 'false',
            onClick: () => setProvider(group.id),
          },
            h('span', { className: 'ofm_mpickerrailname', title: group.name }, group.name),
            h('span', { className: 'ofm_mpickerrailcount' }, String(group.models.filter(keepModel).length)))))),
        h('div', { className: 'ofm_mpickerpane' },
          h('div', { className: 'ofm_mpickertools' },
            h('input', {
              className: 'ofm_panelsearch', type: 'search', value: query,
              placeholder: t('panel.searchModel'), 'aria-label': t('panel.searchModel'),
              onChange: event => setQuery(event.currentTarget.value),
            })),
          h('div', { className: 'ofm_mpickerlist' },
            error !== ''
              ? h('div', { className: 'ofm_mpickempty' }, h('b', null, t('loadFailed')), h('span', null, error))
              : loading
                ? h('div', { className: 'ofm_mpickempty' }, h('b', null, t('loading')))
                : visible.length === 0
                  ? (viewHidden > 0
                    ? h('div', { className: 'ofm_mpickempty' }, h('b', null, t('panel.hiddenAll')), h('span', null, t('panel.hiddenAllHint')))
                    : h('div', { className: 'ofm_mpickempty' }, h('b', null, t('panel.noMatch'))))
                  : visible.flatMap(laneSections))))
      const routeBody = h(RouteGroupPanel, {
        t, routes, catalogGroups: groups, current, busy, setBusy, setNotice, notice, onUse: useRouteGroup,
      })

      const failedBody = h('div', { className: 'ofm_mpickerbody' },
        h('div', { className: 'ofm_mpickerpane' },
          routes.status === 'error'
            ? h('div', { className: 'ofm_mpickempty' }, h('b', null, t('loadFailed')), h('span', null, routes.error))
            : routes.status !== 'ready'
              ? h('div', { className: 'ofm_mpickempty' }, h('b', null, t('loading')))
              : failed.length === 0
                ? h('div', { className: 'ofm_mpickempty' }, h('b', null, t('panel.failed.empty')), h('span', null, t('panel.failed.hint')))
                : h('div', { className: 'ofm_mpickerlist' }, failed.map(item => h('div', {
                  key: item.key, className: 'ofm_mpickfailedrow',
                },
                  h('div', { className: 'ofm_mpickfailedmain' },
                    h('span', { className: 'ofm_mpickfailedname' }, item.provider === undefined || item.provider === '' ? (item.model ?? item.key) : `${item.provider} · ${item.model}`),
                    h('span', { className: 'ofm_mpickfailedwhy' }, t('panel.failed.why')
                      .replace('{code}', item.code ?? 'error')
                      .replace('{reason}', item.reason ?? ''))),
                  h('button', {
                    type: 'button', className: 'ofm_minibtn',
                    disabled: busy !== '',
                    onClick: () => void resetFailed(item.key),
                  }, t('panel.failed.reset'))))),
          h('div', { className: 'ofm_mpickerfoot' },
            h('span', { className: 'ofm_note' }, notice !== '' ? notice : t('panel.failed.hint')),
            failed.length === 0
              ? null
              : h('button', { type: 'button', className: 'ofm_minibtn', disabled: busy !== '', onClick: () => void resetFailed() }, t('panel.failed.resetAll')),
            h('button', { type: 'button', className: 'ofm_minibtn', disabled: busy !== '', onClick: () => void resetCooldown() }, t('panel.failed.cooldown')))))
      return h('div', { className: 'ofm_mpicker', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('panel.selectModel') },
        head,
        mode === 'routes' ? routeBody : mode === 'failed' ? failedBody : modelBody,
        mode === 'models'
          ? h('div', { className: 'ofm_mpickerfoot' },
            h('span', { className: 'ofm_note' }, notice !== ''
              ? notice
              : (state.failures ?? []).length > 0
                ? t('panel.failedProviders').replace('{n}', String(state.failures.length))
                : hiddenCount > 0
                  ? t('panel.hiddenUnavailable').replace('{n}', String(hiddenCount))
                  : droppedCount > 0
                    ? t('panel.unavailableDropped').replace('{n}', String(droppedCount))
                    : ''))
          : null)
    }

    function ModelPanelOverlay(props) {
      const { t, ctx, locale } = props
      const [state, setState] = useState({ open: false, tab: undefined, scope: 'model', sessionId: undefined })
      // 面板由「指针按下」打开，同一次点击的 mouseup/click 会落在刚挂载的遮罩上。
      // 记录打开时刻，250ms 内的遮罩点击一律忽略，否则面板会开完立刻被自己关掉。
      const openedAt = useRef(0)
      useEffect(() => {
        const onOpen = event => {
          const detail = event?.detail ?? {}
          openedAt.current = Date.now()
          setState({
            open: true,
            tab: detail.tab,
            scope: detail.scope === 'settings' ? 'settings' : 'model',
            sessionId: typeof detail.sessionId === 'string' ? detail.sessionId : undefined,
          })
        }
        window.addEventListener('ofm:open-panel', onOpen)
        return () => window.removeEventListener('ofm:open-panel', onOpen)
      }, [])
      useEffect(() => {
        if (!state.open) return undefined
        const onKey = event => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setState(current => ({ ...current, open: false }))
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [state.open])
      if (!state.open) return null
      const close = () => setState(current => ({ ...current, open: false }))
      return h('div', {
        className: 'ofm_scrim ofm_panelscrim',
        onClick: event => {
          if (event.target !== event.currentTarget) return
          if (Date.now() - openedAt.current < 250) return
          close()
        },
      },
        state.scope === 'model'
          ? h(ModelPickerDialog, { t, ctx, sessionId: state.sessionId, onClose: close })
          : h('div', { className: 'ofm_panelmodal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('panel.open') },
            h(SettingsPage, { t, locale, ctx, onClose: close, initialTab: state.tab })))
    }


    /**
     * Composer dock: threshold chip plus the panel launcher.
     *
     * `conversation.composer.dock` is the closest documented seat in front of the
     * native context meter. The chip's popover portals to `body` because the
     * dock sits inside the composer's overflow context.
     */
    function CompactionQuick(props) {
      const { t } = props
      const panel = usePanel(() => api('/compaction'), [])
      const [open, setOpen] = useState(false)
      const [ratio, setRatio] = useState(75)
      const [busy, setBusy] = useState(false)
      const [anchor, setAnchor] = useState(undefined)
      const chipRef = useRef(null)
      const popRef = useRef(null)
      useEffect(() => {
        if (panel.data === undefined) return
        setRatio(Math.round((panel.data.thresholdRatio ?? 0.75) * 100))
      }, [panel.data?.thresholdRatio])
      useEffect(() => {
        if (!open) return undefined
        const onDown = event => {
          if (popRef.current?.contains(event.target) === true) return
          if (chipRef.current?.contains(event.target) === true) return
          setOpen(false)
        }
        const onScroll = () => setOpen(false)
        document.addEventListener('pointerdown', onDown, true)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          document.removeEventListener('pointerdown', onDown, true)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [open])
      const place = () => {
        const node = chipRef.current
        if (node === null || node === undefined) return
        const rect = node.getBoundingClientRect()
        setAnchor({
          left: Math.max(12, Math.min(rect.left, window.innerWidth - 324)),
          bottom: Math.max(12, window.innerHeight - rect.top + 8),
        })
      }
      const toggle = () => {
        if (!open) place()
        setOpen(value => !value)
      }
      const save = async value => {
        const next = Math.max(1, Math.min(100, Math.round(Number(value) || 0)))
        setRatio(next); setBusy(true)
        try {
          const answer = await post('/compaction', { thresholdRatio: next / 100 })
          panel.patch(answer)
        } catch (error) {
          showToast({ title: t('compact.saveFailed'), body: String(error?.message ?? error), tone: 'warn' })
        } finally { setBusy(false) }
      }
      const restore = async () => {
        setBusy(true)
        try {
          const answer = await post('/compaction', { thresholdRatio: null })
          panel.patch(answer)
          setRatio(Math.round((answer.thresholdRatio ?? 0.75) * 100))
        } catch (error) {
          showToast({ title: t('compact.saveFailed'), body: String(error?.message ?? error), tone: 'warn' })
        } finally { setBusy(false) }
      }
      const data = panel.data
      const disabled = busy || (data !== undefined && data.supported === false)
      const popNode = open && anchor !== undefined ? h('div', {
        className: 'ofm_quickpop', ref: popRef, style: { left: `${anchor.left}px`, bottom: `${anchor.bottom}px` },
        role: 'dialog', 'aria-label': t('compact.chip'),
      },
        h('div', { className: 'ofm_quickpophead' },
          h('b', null, t('compact.chip')),
          h('span', { className: 'ofm_note' }, t('compact.quickHint'))),
        h('div', { className: 'ofm_quickval' }, h('b', null, String(ratio)), h('span', null, '%')),
        h('input', {
          type: 'range', min: 20, max: 95, step: 1, value: ratio, disabled,
          'aria-label': t('compact.chip'), className: 'ofm_quickslider',
          onChange: event => setRatio(Number(event.target.value)),
          onPointerUp: event => { if (!disabled) void save(event.currentTarget.value) },
          onKeyUp: event => { if (!disabled && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void save(event.currentTarget.value) },
        }),
        h('div', { className: 'ofm_row' },
          [50, 65, 75, 85].map(value => h('button', {
            key: value, type: 'button', className: 'ofm_minibtn', disabled,
            onClick: () => void save(value),
          }, `${value}%`))),
        h('div', { className: 'ofm_quickpopfoot' },
          h('button', { type: 'button', className: 'ofm_minibtn', disabled, onClick: restore }, t('compact.restore')),
          h('button', { type: 'button', className: 'ofm_minibtn', onClick: () => { setOpen(false); openSettingsPanel('pipeline') } }, t('compact.openPanel')))) : null
      // The composer dock is mounted by a slot-level React root. A portal to
      // `body` can paint correctly while its events still bubble through that
      // root's container, not the body, which made the first version's buttons
      // look alive but ignore clicks. Keep the node inside the slot root; fixed
      // positioning already escapes the composer's normal flow.
      const pop = popNode
      return h(Fragment, null,
        h('div', { className: 'ofm_dock' },
          h('button', {
            type: 'button', ref: chipRef, className: 'ofm_autochip', 'aria-expanded': open ? 'true' : 'false',
            title: t('compact.quickHint'), onClick: toggle,
          },
            h('span', { className: 'ofm_dot ok' }),
            `${t('compact.chip')} ${ratio}%`,
            h('span', { className: 'ofm_autochipcaret', 'aria-hidden': 'true' }, '▴'))),
        pop)
    }

    /**
     * 原生选择器旁边只加一个入口，不动宿主自己的模型选择器。
     *
     * 旧 `model-failover-manager` 的做法是直接接管 `conversation.input.model`
     * （priority -1），把原生模型选择器整个换掉。那会让我们被迫重做目录、搜索、
     * 推理档和子代理选择，成本高且容易和宿主版本打架。
     * `conversation.input.activity` 是单值槽，已被语音输入占用；再抢会让麦克风
     * 消失，所以改用右侧的 `conversation.input.right` 列表，把入口排到模型选择器
     * 左侧：原生选择器继续选模型，本插件只负责打开路由 / 管线 / 重试面板。
     */
    function ModelLauncherButton(props) {
      const { t, sessionId } = props
      const open = () => openModelPanel('models', sessionId)
      return h('div', { className: 'ofm_modelseat' },
        h('button', {
          type: 'button', className: 'ofm_modellaunch', title: t('panel.open'),
          'aria-label': t('panel.open'),
          // 指针按下就打开：宿主输入框在 blur 时会重排右侧 seat，只靠 onClick
          // 时 mousedown → blur 可能先把按钮换掉，mouseup 落不到同一个节点。
          onPointerDown: e => {
            if (e.button !== 0) return
            e.preventDefault()
            open()
          },
          onClick: open,
        },
        h(ModelSidebarIcon, { size: 14 })))
    }

    function SettingsPage(props) {
      const tagged = props.locale === undefined ? props.t : Object.assign(x => props.t(x), { locale: props.locale })
      const t = tagged
      const [busy, setBusy] = useState(false)
      const [benches, setBenches] = useState({})
      const summary = useAsync(() => api('/summary'), [])
      const stats = useAsync(() => api('/stats'), [])

      const apply = async patch => {
        setBusy(true)
        try {
          await post('/settings', patch)
          summary.reload(); stats.reload()
        } catch (error) {
          // The route can refuse a patch — a routable forward bind, for one — and a
          // rejection nobody shows is a button that appears to do nothing.
          showToast({ title: t('settings.failed'), body: String(error?.message ?? error), tone: 'warn' })
        } finally { setBusy(false) }
      }
      const bench = async model => {
        setBenches(current => ({ ...current, [model.id]: { running: true } }))
        try {
          // 默认档（balanced）而不是 deep：测速要回答的是“这个模型日常多快”，
          // 默认档就是日常档；deep 每次最多烧 32K 输出 token，且经常把固定
          // bench 会话自己打到 429。
          const result = await post('/bench', { model: model.id }, 240_000)
          setBenches(current => ({ ...current, [model.id]: { running: false, result: t('bench.result').replace('{ttft}', result.ttftMs).replace('{tps}', result.tokensPerSecond ?? '—').replace('{reasoning}', result.reasoningTokens) } }))
        } catch (error) {
          setBenches(current => ({ ...current, [model.id]: { running: false, result: String(error?.message ?? error) } }))
        }
      }

      if (summary.status === 'loading' && summary.data === undefined) return h('div', { className: 'ofm_root' }, h('p', { className: 'ofm_note' }, t('loading')))
      if (summary.status === 'error') {
        return h('div', { className: 'ofm_root' },
          h('div', { className: 'ofm_callout ofm_error' }, h('div', null, h('b', null, t('loadFailed')), h('div', null, summary.error))),
          h('div', null, h(Button, { onClick: () => summary.reload() }, t('retry'))))
      }
      const data = summary.data
      // The tank and the stat chips describe the free lane's health, so the
      // absorbed channels stay out of the tally — their cards carry their own
      // availability badge, and a lane that is never probed would otherwise
      // read as a permanently green slice of this gauge.
      const counts = data.catalog.filter(isFreeRosterRow).reduce((acc, m) => ({ ...acc, [m.availability]: (acc[m.availability] ?? 0) + 1 }), {})
      return h(Shell, {
        t: tagged, data, counts, summary, stats,
        busy, setBusy, apply, bench, benches, ctx: props.ctx,
        onClose: props.onClose, initialTab: props.initialTab,
      })
    }

    // ── the six-page shell ────────────────────────────────────────────────────
    // EAC 协付车道已从面板移除（网关服务端不再提供登录与模型接口，车道不可用，
    // 保留代码只会让用户反复撞 404）。页签按用户问题组织：
    //   免费模型   免密车道（本插件自带网关），单页；
    //   聚合渠道   自备 API Key 直连服务商，单页；
    //   白嫖模型接入   13 个账号渠道与登录，单页；
    //   管线       省 Token + 路由（combo 链）；
    //   观测       数据看板 + 运行日志；
    //   对外服务   本地转发、出口代理与渠道网关中继。
    // The active page lives in localStorage so a reload — or the hot reload the
    // upgrader triggers — comes back to the page the user was reading.
    const TAB_KEY = 'ofm.tab'
    const TABS = ['free', 'aggregate', 'channels', 'pipeline', 'routing', 'observe', 'retry', 'gateway']
    /** 旧页签 → 新页：读回旧值时迁移，避免升级后落到默认页。 */
    const TAB_MIGRATION = {
      free: 'free', models: 'free',
      eac: 'aggregate', eacagg: 'aggregate', aggregate: 'aggregate',
      channels: 'channels',
      saver: 'pipeline', routing: 'routing',
      ledger: 'observe', logs: 'observe', retry: 'retry',
      gateway: 'gateway',
    }

    function Shell(props) {
      const { t, data, counts, summary, stats, busy, setBusy, apply, bench, benches, ctx, onClose, initialTab } = props
      const [tab, setTab] = useState(() => {
        if (initialTab !== undefined && TABS.includes(initialTab)) return initialTab
        try {
          const saved = window.localStorage?.getItem(TAB_KEY)
          return TABS.includes(saved) ? saved : (TABS.includes(TAB_MIGRATION[saved]) ? TAB_MIGRATION[saved] : 'free')
        } catch { return 'free' }
      })
      const tabRefs = useRef({})
      const [glider, setGlider] = useState({ left: 0, top: 0, width: 0, height: 0 })
      useEffect(() => {
        try { window.localStorage?.setItem(TAB_KEY, tab) } catch { /* storage unavailable */ }
        let alive = true
        let frame = 0
        const node = () => tabRefs.current[tab]
        const measure = () => {
          if (!alive) return
          const target = node()
          if (target === undefined || target === null) return
          setGlider(current => current.left === target.offsetLeft
            && current.top === target.offsetTop
            && current.width === target.offsetWidth
            && current.height === target.offsetHeight
            ? current
            : { left: target.offsetLeft, top: target.offsetTop, width: target.offsetWidth, height: target.offsetHeight })
        }
        const schedule = () => {
          cancelAnimationFrame(frame)
          frame = requestAnimationFrame(measure)
        }
        // Tabs may wrap onto a second row inside the group, so the glider is
        // placed on both axes: translate alone would put it at the right
        // height and the wrong row.
        //
        // 首帧量出来的宽度是「字体还没就绪、侧栏/弹窗还在播入场动画」时的宽度，
        // 游标会停在旧尺寸上（左边多出一截、右边盖住下一个页签）。字体就绪
        // 与容器尺寸变化时各补量一次。
        schedule()
        try { document.fonts?.ready?.then(schedule, () => {}) } catch { /* no font API */ }
        let observer
        const host = node()?.parentElement
        if (host !== undefined && host !== null && typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(schedule)
          observer.observe(host)
        }
        return () => {
          alive = false
          cancelAnimationFrame(frame)
          observer?.disconnect()
        }
      }, [tab, t.locale])

      const refresh = async () => {
        setBusy(true)
        try { await post('/refresh', undefined, 600_000); summary.reload(); stats.reload() } finally { setBusy(false) }
      }
      const reprobe = async () => {
        setBusy(true)
        try { await post('/reprobe', undefined, 600_000); summary.reload() } finally { setBusy(false) }
      }

      const tabs = [
        // 徽章数的是「这条车道有几行模型」，不是「有几行探测为可用」：探测
        // 尚未出结果（unknown）时按可用数显示会让页签写着 0，看着像车道空了。
        ['free', t('nav.tab.free'), data.catalog.filter(isFreeRosterRow).length],
        ['aggregate', t('nav.tab.aggregate'), data.catalog.filter(m => m.channel === 'aggregate').length],
        ['channels', t('nav.tab.channels'), CHANNEL_PROVIDERS.length],
        ['pipeline', t('nav.tab.pipeline'), null],
        ['routing', t('nav.tab.routing'), data.catalog.filter(m => m.channel === 'combo' || m.channel === 'route').length],
        ['observe', t('nav.tab.observe'), null],
        ['retry', t('nav.tab.retry'), null],
        ['gateway', t('nav.tab.gateway'), null],
      ]
      // 聊天框的模型面板已经是独立的选择器（ModelPickerDialog），这里只剩完整设置页；
      // 页签集合不再按入口裁剪，两个入口共用同一份 TABS。
      const stepTab = delta => {
        if (tabs.length === 0) return
        const at = tabs.findIndex(([id]) => id === tab)
        const next = tabs[(at + delta + tabs.length) % tabs.length]
        if (!next) return
        setTab(next[0])
        requestAnimationFrame(() => tabRefs.current[next[0]]?.focus())
      }
      const tabKeyDown = event => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
        event.preventDefault()
        stepTab(event.key === 'ArrowRight' ? 1 : -1)
      }
      const tabsBar = h('div', { className: 'ofm_tabs', role: 'tablist' },
        h('span', { className: 'ofm_tabglider', style: { transform: `translate(${glider.left}px, ${glider.top}px)`, width: `${glider.width}px`, height: `${glider.height}px` } }),
        tabs.map(([id, label, num]) => h('button', {
          key: id, type: 'button', role: 'tab', 'aria-selected': tab === id ? 'true' : 'false', className: 'ofm_tab', 'data-on': tab === id ? 'true' : 'false',
          tabIndex: tab === id ? 0 : -1,
          ref: node => { tabRefs.current[id] = node },
          onKeyDown: tabKeyDown,
          onClick: () => setTab(id),
        }, label, num === null ? null : h('span', { className: 'ofm_tabnum' }, String(num)))))
      const nav = h('nav', { className: 'ofm_nav' },
        h('span', { className: 'ofm_navbrand' },
          h('span', { className: 'ofm_navmark', 'aria-hidden': 'true' },
            h('img', { src: BRAND_ICON, alt: '' })),
          onClose === undefined ? t('title') : t('panel.title')),
        tabsBar,
        h('span', { className: 'ofm_navspacer' }),
        h('div', { className: 'ofm_navact' },
          h(StarButton, { t }),
          onClose === undefined ? null : h('button', {
            type: 'button', className: 'ofm_close', 'aria-label': t('panel.close'), title: t('panel.close'),
            onClick: onClose,
          }, '×')))

      const page = tab === 'aggregate'
        ? h(AggregatePage, { t, summary })
        : tab === 'channels'
          ? h(ChannelsPage, { t, ctx, summary })
          : tab === 'pipeline'
            // 两段都是 Section 根节点：直接并列，外层不再套 .ofm_page（旧版双层
            // page 会多出一圈内边距与入场动画，看着像排版错位）。
            ? h(Fragment, null, h(CompactionCard, { t }), h(SaverPage, { t }))
            : tab === 'routing'
              ? h('div', { className: 'ofm_page' }, h(RoutesPage, { t }), h(RoutingPage, { t, bare: true }))
            : tab === 'observe'
              ? h(Fragment, null, h(LedgerPage, { t, ctx }), h(LogsPage, { t, ctx }))
              : tab === 'retry'
                ? h(RetryPage, { t })
                : tab === 'gateway'
                // 网关只剩一条路：对外入口（池）→ 本地转发（含局域网）→ 出口代理
                // → 接入客户端。宿主渠道网关与它的中继已删除。
                ? h('div', { className: 'ofm_page' },
                  h(ForwardPoolPage, { t }),
                  h(Section, { title: t('section.forward'), hint: t('section.forwardHint') }, h(Forward, { settings: data.settings, t, onApply: apply, busy })),
                  h(Section, { title: t('section.egress'), hint: t('section.egressHint') }, h(Egress, { settings: data.settings, t, onApply: apply, busy })),
                  h(GatewayPage, { t }))
                : h(FreePage, { t, data, counts, summary, stats, busy, apply, bench, benches, refresh, reprobe })

      const dialogNav = h('header', { className: 'ofm_dlghead' },
        h('span', { className: 'ofm_navbrand' },
          h('span', { className: 'ofm_navmark', 'aria-hidden': 'true' },
            h('img', { src: BRAND_ICON, alt: '' })),
          t('panel.settingsTitle')),
        h('span', { className: 'ofm_dlgspacer' }),
        h('button', {
          type: 'button', className: 'ofm_close', 'aria-label': t('panel.close'), title: t('panel.close'),
          onClick: onClose,
        }, '×'))

      return h('div', { className: 'ofm_root ofm_shell', 'data-dialog': onClose === undefined ? 'false' : 'true' },
        h('div', { className: 'ofm_aurora', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        onClose === undefined
          ? h(Fragment, null, nav, page)
          : h(Fragment, null, dialogNav, h('div', { className: 'ofm_dlgtabbar' }, tabsBar), h('div', { className: 'ofm_dlgbody' }, page)))
    }

    function FreePage(props) {
      const { t, data, counts, summary, stats, busy, apply, bench, benches, refresh, reprobe } = props
      // 档位表的写回是整表替换：`modelEffort` 是字典，不是单个开关。空档 = 删键。
      const setEffort = async (model, level) => {
        const table = { ...(data.settings?.modelEffort ?? {}) }
        if (level === '') delete table[model.id]
        else table[model.id] = level
        await apply({ modelEffort: table })
      }
      // The denominator is the free lane's own roster — the only slice the
      // verdicts describe. Dividing by the whole catalog (which also carries
      // the never-probed EAC and Kilo entries) read a 6-of-10 lane as ~17%.
      const total = data.catalog.filter(isFreeRosterRow).length
      const ok = counts.available ?? 0
      // The tank reads the free lane's own health: the share of the declared
      // roster this machine can actually reach. Same thresholds as the pool
      // gauge, so the two pages' tanks never disagree about what "busy" looks
      // like — only about what the water is measuring.
      const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(100 * ok / total))) : null
      const ratio = total > 0 ? ok / total : 0
      // Thresholds for *availability* (not load): most of a frontier roster being
      // reachable is the healthy case, so "busy" starts below 60% rather than
      // below two thirds — the pool gauge's own cut-offs measure queue pressure
      // and would paint a perfectly usable lane amber.
      const level = ratio >= 0.6 ? 'ok' : ratio >= 0.3 ? 'busy' : 'over'
      // 全线不可用是数据面的真实结论，不是渲染异常：必须在页面最上方点名，
      // 否则用户只会看到一屏 0% 和一个空列表，误以为插件坏了。
      const throttled = counts.throttled ?? 0
      const regionBlocked = counts['region-blocked'] ?? 0
      const dead = counts.unavailable ?? 0
      const unknown = counts.unknown ?? 0
      const noneUsable = total > 0 && ok === 0
      return h('div', { className: 'ofm_page' },
        noneUsable ? h('div', {
          className: 'ofm_callout ofm_error', role: 'status', style: { marginBottom: 12 },
        },
        h('span', { 'aria-hidden': 'true' }, '⚠'),
        h('div', null,
          h('b', null, t('free.noneUsable')),
          h('p', null, t('free.noneUsableHint')),
          h('div', { style: { marginTop: 8 } },
            h(Button, { disabled: busy, onClick: reprobe }, t('reprobe'))))) : null,
        h('header', { className: 'ofm_hero ofm_glass' },
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' },
              h('h2', null, t('free.title')),
              h('p', { className: 'ofm_pagesub' }, t('free.sub'))),
            h('div', { className: 'ofm_pills' },
              h(Pill, { strong: true, tone: data.settings.enabled !== false ? 'ok' : 'err' }, data.settings.enabled !== false ? t('pref.enabled') : 'off'),
              h(Pill, null, `${t('pref.egress')} ${data.egress?.country ?? data.egress?.ip ?? '—'}`),
              h(Pill, null, `${t('pref.probedAt')} ${ago(data.probedAt, t.locale)}`))),
          h('div', { className: 'ofm_tankrow' },
            h(Tank, { pct, level, size: 'xl', label: `${t('free.tankLabel')} ${pct ?? '—'}%` }),
            h('div', { className: 'ofm_tankside' },
              h('div', { className: 'ofm_pooltop' },
                h('span', { className: `ofm_poolbadge ${level}` },
                  h('span', { className: 'ofm_pooldot' }),
                  `${t('free.tankLabel')} ${pct ?? '—'}%`),
                h(StarButton, { t })),
              // 五格状态：可用 / 地区受限 / 限流 / 不可用 / 未探测。
              // 只报三项会把限流和未探测混进「不可用」，恰好抹掉「临时状态」
              // 和「还没结论」这两种最有用的区别。
              h('div', { className: 'ofm_poolstats' },
                h('div', { className: 'ofm_stat' }, h('b', null, String(ok)), h('span', null, t('state.available'))),
                h('div', { className: `ofm_stat${regionBlocked > 0 ? ' hot' : ''}` },
                  h('b', null, String(regionBlocked)), h('span', null, t('state.region-blocked'))),
                throttled === 0 ? null : h('div', { className: 'ofm_stat warn' },
                  h('b', null, String(throttled)), h('span', null, t('state.throttled'))),
                h('div', { className: `ofm_stat${ok === 0 && dead > 0 ? ' hot' : ''}` },
                  h('b', null, String(dead)), h('span', null, t('state.unavailable'))),
                unknown === 0 ? null : h('div', { className: 'ofm_stat' },
                  h('b', null, String(unknown)), h('span', null, t('state.unknown')))),
              h('div', { className: 'ofm_poolmeta' },
                h('span', { className: 'ofm_note' }, total > 0
                  ? t('free.tankNote').replace('{ok}', String(ok)).replace('{total}', String(total))
                  : t('free.tankEmpty')),
                h('span', { className: 'ofm_note' }, t('meta.description'))),
              h('div', { className: 'ofm_row' },
                h(Button, { disabled: busy, onClick: refresh }, summary.status === 'loading' ? t('probing') : t('refresh')),
                h(Button, { disabled: busy, onClick: reprobe }, t('reprobe')))))),
        h(Section, { title: t('section.models'), hint: t('section.modelsHint') }, h(Roster, {
          summary: data, t, onBench: bench, benches,
          effortTable: data.settings?.modelEffort ?? {}, onEffort: setEffort, busy,
        })),
        h(Section, { title: t('section.prefs'), hint: t('section.prefsHint') }, h(Preferences, { summary: data, t, onApply: apply, busy })))
    }

    // ── announcement ──────────────────────────────────────────────────────────
    const PAGES = ['ann.preamble', 'ann.models', 'ann.steps', 'ann.features', 'ann.updates']

    function Announcement(props) {
      const { t, complete, openSection, page, setPage, summary, acknowledged } = props
      const dialog = useRef(null)
      const finishRef = useRef(null)
      useEffect(() => { if (acknowledged) complete() }, [acknowledged, complete])
      /* Not `#root.inert`, even though the shell does that for its own onboarding
         modals: those portal out of `#root`, while a slot-mounted step stays
         inside it, and inert has no opt-out for descendants. Measured with it on,
         `document.elementFromPoint` over the next-page button returned BODY — the
         dialog could not be clicked at all. The full-viewport scrim already
         swallows every pointer event aimed at the app behind it. This dialog now
         portals to `document.body` (see `createPortal` above), i.e. it leaves
         `#root` exactly like the shell's own modals do. */
      const last = page === PAGES.length - 1
      const finish = async () => {
        try { await post(`/announcement/ack?version=${encodeURIComponent(summary?.announcementVersion ?? '')}`) } catch { /* ack is best effort */ }
        complete()
      }
      useEffect(() => { finishRef.current = finish })
      // Escape dismisses — the same outcome as "later" — and Tab cycles inside the
      // dialog. `aria-modal="true"` promises both; without them a keyboard user
      // reaches the app behind a surface that claims to be modal.
      useEffect(() => {
        const node = dialog.current
        if (node === null || node === undefined) return undefined
        try { node.focus() } catch { /* focus is best effort */ }
        const onKeyDown = event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            void finishRef.current?.()
            return
          }
          if (event.key !== 'Tab') return
          let focusables = []
          try {
            focusables = Array.from(node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
          } catch { focusables = [] }
          if (focusables.length === 0) return
          const first = focusables[0]
          const final = focusables[focusables.length - 1]
          const active = document.activeElement
          if (event.shiftKey && (active === first || !node.contains(active))) {
            event.preventDefault()
            final.focus()
          } else if (!event.shiftKey && active === final) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [])
      if (acknowledged) return null
      const scrim = h('div', { className: 'ofm_scrim' },
        h('div', { className: 'ofm_ann', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('title'), tabIndex: -1, ref: dialog },
          h('div', { className: 'ofm_annhead' },
            h('h2', { className: 'ofm_anntitle' }, t('title')),
            h('p', { className: 'ofm_annsub' }, t(PAGES[page]))),
          h('div', {
            className: 'ofm_steps',
            role: 'progressbar',
            'aria-valuemin': 1,
            'aria-valuemax': PAGES.length,
            'aria-valuenow': page + 1,
            'aria-label': t('ann.page').replace('{n}', page + 1).replace('{total}', PAGES.length),
          },
            PAGES.map((key, index) => h('span', { key, className: 'ofm_step', 'data-on': index <= page ? 'true' : 'false' }))),
          h('div', { className: 'ofm_annbody' }, h(PageBody, { page, t, summary })),
          h('div', { className: 'ofm_annfoot' },
            h('span', { className: 'ofm_note' }, t('ann.page').replace('{n}', page + 1).replace('{total}', PAGES.length)),
            h('span', { className: 'spacer' }),
            page === 0 ? h(Button, { kind: 'ghost', onClick: finish }, t('ann.later')) : h(Button, { kind: 'ghost', onClick: () => setPage(p => Math.max(0, p - 1)) }, '‹'),
            last
              ? h(Button, { kind: 'primary', onClick: async () => { await finish(); openModelPanel() } }, t('ann.openPanel'))
              : h(Button, { kind: 'primary', onClick: () => setPage(p => Math.min(PAGES.length - 1, p + 1)) }, '›'))))
      // Out of `#root` and onto the body: the shell hides `#root` (opacity/inert)
      // while its own first-run surface is up, and no descendant escapes that.
      return createPortal === null ? scrim : createPortal(scrim, document.body)
    }

    const list = (t, keys) => keys.map(key => h('li', { key }, t(key)))

    function PageBody(props) {
      const { page, t, summary } = props
      if (page === 0) return h(Fragment, null,
        h('h3', null, t('ann.preamble')),
        h('p', null, t('ann.pitch')),
        h('ul', null, list(t, ['ann.p1', 'ann.p2', 'ann.p3'])))
      if (page === 1) {
        // Advertised models first: this page is the tour a new user reads before
        // they pick anything, and a refused id at the top of it is a bad first
        // impression of a lane that is actually working.
        const rows = (summary?.catalog ?? []).slice().sort((a, b) => (a.route === null ? 1 : 0) - (b.route === null ? 1 : 0))
        if (rows.length === 0) return h('p', null, t('loading'))
        return h(Fragment, null,
          h('h3', null, t('ann.models')),
          h('div', { className: 'ofm_kv' }, rows.slice(0, 8).map(m => h('div', { key: m.id, className: 'ofm_kvc' },
            h('b', null, m.name),
            h('span', null, `${t(`state.${m.availability}`)} · ${m.vision ? t('tag.vision') : t('tag.text')} · ${kilo(m.contextWindow)}`)))),
          rows.some(m => m.availability === 'region-blocked') ? h('p', { className: 'ofm_note' }, t('hint.region')) : null)
      }
      if (page === 2) return h(Fragment, null,
        h('h3', null, t('ann.steps')),
        h('ul', null, list(t, ['ann.s1', 'ann.s2', 'ann.s3', 'ann.s4'])))
      if (page === 3) return h(Fragment, null,
        h('h3', null, t('ann.features')),
        h('ul', null, list(t, ['ann.f1', 'ann.f2', 'ann.f3', 'ann.f4', 'ann.f5'])))
      return h(Fragment, null,
        h('h3', null, t('ann.updates')),
        h('ul', null, list(t, ['ann.u1', 'ann.u2'])))
    }

    // ── registration ──────────────────────────────────────────────────────────
    // The shell mirrors the active language onto <html lang>, so a render-time
    // read survives a language switch without owning a subscription.
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        return typeof value === 'string' ? value : document.documentElement.lang || 'en'
      } catch { return 'en' }
    }

    /** 这些渠道在宿主侧实现了 credits.balances；其余 provider 不渲染读数。 */
    const CREDITS_CHIP_PROVIDERS = {
      codearts: true, buddy: true, workbuddy: true, lobsterai: true, qoder: true, qodercn: true,
      trae: true, cline: true, loomy: true, raccoon: true, minimax: true, zcode: true, gemini: true,
    };
    /**
     * 自有渠道：**不走** `credits.balances` RPC（渠道包不认识这些 provider，
     * 会回 `unsupported provider`），而是走本插件自己的 `/channels/extra`。
     *
     * 这份清单必须与本插件面板的判据同源：`channel.own === true` 且
     * `CHANNEL_EXTRAS.has(id)` 且 `noCredits !== true`。少一家就会重现
     * 「新加的渠道在模型切换旁边没有积分」（2026-11-25 报障：AgnesCode / 豆包
     * 等自有渠道全部缺席 —— 白名单里只有渠道包那 13 家）。
     *
     * ⚠️ 不写 `agnescode` / `agnescodeintl`：它们 `noCredits: true`（没有额度
     * 读数端点），挂上去只会画一行空。
     */
    const CREDITS_CHIP_OWN = new Set([
      'codely', 'autoclaw', 'autoclawintl', 'accio', 'minimaxintl', 'marvis',
      'magicrew', 'magicrewintl', 'monkeycode', 'monkeycodeintl', 'baizhi',
      'officeace', 'doubao', 'astudio',
    ]);
    const CHIP_LABELS = {
      codearts: "CA", buddy: "WB", workbuddy: "WB·AI", lobsterai: "Lobster", qoder: "Qoder", qodercn: "Qoder·CN",
      trae: "TRAE", cline: "Cline", loomy: "Loomy", raccoon: "Raccoon", minimax: "MiniMax", zcode: "ZCode", gemini: "Gemini",
      codely: "Codely", autoclaw: "AutoClaw", autoclawintl: "AutoClaw·Intl", accio: "Accio",
      minimaxintl: "MiniMax·Intl", marvis: "Marvis", magicrew: "MagiCrew", magicrewintl: "MagiCrew·Intl",
      monkeycode: "MonkeyCode", monkeycodeintl: "MonkeyCode·Intl", baizhi: "百智云", officeace: "OfficeAce",
      doubao: "豆包", astudio: "AStudio",
    };
    /**
     * 输入框右侧、模型选择器旁边的积分读数（`conversation.input.right`）。
     * 参照 dsh-connect-workbuddy 的 ComposerCredits 与 dsh-codearts 的 CodeArtsCreditDock：
     *   - 会话选中本插件渠道的模型时只显示该渠道的余额；
     *   - 拿不到模型选择投影（useProjection）时退而显示所有有余额的渠道；
     *   - 取不到数就不渲染（绝不把「不知道」画成 0）；
     *   - 挂载/取数失败经 chip.debug RPC 回传宿主日志，便于排查「读数不显示」。
     */
    /**
     * 聊天框模型芯片的标签（`conversation.input.model.label`）。
     *
     * 宿主默认只画模型名：路由分组在芯片上就只剩一个「主力」，看不出这是
     * 一条分组、更看不出它由谁供给（旧插件在时是它补的「渠道 · 模型」）。
     * 这里在 trigger 上补回渠道名，并在菜单/列表里保留目录自带的徽章——
     * 徽章是宿主的 fallback 的一部分，自定义标签必须自己画，否则会被吞掉。
     */
    function ModelChipLabel(props) {
      const provider = props?.provider ?? {}
      const model = props?.model ?? {}
      const placement = props?.placement ?? 'menu'
      const badge = badgeTextOf(model.badge)
      const name = model.name ?? model.id ?? ''
      const providerName = typeof provider.name === 'string' ? provider.name : ''
      const prefix = placement === 'trigger' && providerName !== ''
      return h('span', { className: 'ofm_chiplabel', 'data-placement': placement },
        prefix ? h('span', { className: 'ofm_chiplabelprovider', title: provider.id ?? '' }, providerName) : null,
        prefix ? h('span', { className: 'ofm_chiplabelsep' }, ' · ') : null,
        h('span', { className: 'ofm_chiplabelname' }, name),
        badge === '' ? null : h('span', { className: 'ofm_chiplabelbadge' }, badge))
    }

    function ComposerChannelCredits(props) {
      const { ctx } = props;
      const t = typeof props.t === "function" ? props.t : (key => key);
      const useProjection = typeof props.useProjection === "function" ? props.useProjection : undefined;
      const { rpc, available } = useChannelRpc(ctx);
      const [segments, setSegments] = useState(undefined);
      const report = useCallback((data) => { try { void rpc("chip.debug", data, 15000); } catch { } }, [rpc]);
      const projection = useProjection ? useProjection("modelSelection") : undefined;
      const candidate = projection?.next ?? projection?.lastUsed;
      const provider = typeof candidate?.provider === "string" && candidate.provider !== "" ? candidate.provider : "";
      // 自有渠道与渠道包渠道是**两条取数腿**：前者走 `/channels/extra`，后者走
      // `credits.balances` RPC。混在一张表里会拿渠道包去问 `unsupported provider`。
      const known = provider !== "" && (CREDITS_CHIP_PROVIDERS[provider] !== undefined || CREDITS_CHIP_OWN.has(provider));
      const scope = known
        ? [provider]
        : useProjection ? [] : [...Object.keys(CREDITS_CHIP_PROVIDERS), ...CREDITS_CHIP_OWN];
      useEffect(() => {
        report({ kind: "mount", hasUseProjection: useProjection !== undefined, provider, scope, rpcAvailable: available });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      // 自有渠道**不需要** RPC 连接（它打自家 HTTP 路由）；渠道包渠道必须有。
      const canLoad = scope.length > 0 && (available || scope.some(p => CREDITS_CHIP_OWN.has(p)));
      useEffect(() => {
        if (!canLoad) { setSegments(undefined); return undefined; }
        let cancelled = false;
        const load = async () => {
          const out = [];
          await Promise.allSettled(scope.map(async (p) => {
            try {
              let total
              if (CREDITS_CHIP_OWN.has(p)) {
                // 自有渠道：`/channels/extra` 的 `accounts[].balance.total` 或
                // `info.total.remain`（与面板 `balanceRowOf` 同口径）。
                const value = await api(`/channels/extra?provider=${encodeURIComponent(p)}`, { timeout: 30_000 })
                const rows = Array.isArray(value?.accounts) ? value.accounts : []
                const known2 = rows
                  .map(row => Number.isFinite(row?.balance?.total) ? row.balance.total
                    : Number.isFinite(row?.info?.total?.remain) ? row.info.total.remain
                      : NaN)
                  .filter(n => Number.isFinite(n))
                if (known2.length > 0) total = known2.reduce((sum, n) => sum + n, 0)
              } else {
                const value = await rpc("credits.balances", { provider: p }, 90000);
                const rows = Array.isArray(value?.accounts) ? value.accounts : [];
                const known2 = rows.filter((row) => Number.isFinite(row?.balance?.total));
                if (known2.length > 0) total = known2.reduce((sum, row) => sum + row.balance.total, 0)
              }
              if (Number.isFinite(total)) out.push([p, total])
            } catch (error) {
              report({ kind: "balances-error", provider: p, error: String(error?.message ?? error).slice(0, 140) });
            }
          }));
          if (!cancelled) setSegments(out);
        };
        void load();
        const timer = setInterval(() => { void load(); }, 90000);
        return () => { cancelled = true; clearInterval(timer); };
      }, [scope.join("|"), canLoad, rpc]);
      if (!canLoad || segments === undefined || segments.length === 0) return null;
      // 宿主用 `data-model-compact` 把模型名整块折叠成图标：它按"整行需求宽度"
      // 判断，所以本插件往这一行多放一个像素，模型名就更早消失。读数的渠道名
      // 与整个读数分别由容器查询按行宽让位（见 CSS），模型名永远优先。
      const title = segments.map(([providerId, amount]) => `${CHIP_LABELS[providerId] ?? providerId} ${amount}`).join(" · ");
      return h("span", { className: "ofm_composercredits", title },
        segments.map(([providerId, amount], index) => h(Fragment, { key: providerId },
          index === 0 ? null : h("span", { className: "ofm_composercreditsep" }, " · "),
          h("span", { className: "ofm_composercreditlabel" }, CHIP_LABELS[providerId] ?? providerId),
          " ",
          h("span", { className: "ofm_composercreditvalue" }, kilo(amount)))));
    }
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'our-free-model: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-model-manager')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'our-free-model: styles')

      // ── push subscription ───────────────────────────────────────────────────
      // One EventSource for the whole app surface: new announcements become
      // toasts (and OS notifications when opted in), urgent ones open a modal,
      // update availability and completed upgrades broadcast onto window so
      // whichever panel is mounted can refresh itself. EventSource reconnects
      // by itself; the hot reload closes every stream server-side, so a swap
      // simply shows up as a fresh `hello` a second later.
      ctx.effect(() => {
        if (typeof EventSource !== 'function') return
        let osEnabled = false
        let disposed = false
        let source
        let retryTimer
        // 重连轮次必须活在 open() 之外：open() 每次重连都会重入，计数器若在里面
        // 会被清零，退避就永远是第一档而不是 30s 翻倍到 5 分钟。
        let retries = 0
        api('/announcements').then(payload => { osEnabled = payload?.notifyOs === true }).catch(() => {})
        const open = () => {
          if (disposed) return
          source = new EventSource(`${API}/events`)
          // 断连保护：服务端不可达时 EventSource 默认无限自动重连（持续占连接池）。
          // 连续失败达到上限先关闭让出连接，但按退避（30s 翻倍、封顶 5 分钟）定时
          // 重新打开——永久关闭让公告/更新/升级推送在宿主重启或休眠后整体静默失效，
          // 只有刷新页面才能恢复；退避重连在恢复连接性的同时保住连接池。
          let errCount = 0
          source.onopen = () => { errCount = 0; retries = 0 }
          source.onerror = () => {
            errCount += 1
            if (errCount < 5) return
            try { source.close() } catch { /* 已关闭 */ }
            if (disposed || retryTimer !== undefined) return
            retryTimer = setTimeout(() => {
              retryTimer = undefined
              open()
            }, Math.min(30_000 * 2 ** retries, 300_000))
            retries += 1
          }
          source.addEventListener('announcements', event => {
            errCount = 0
            let data
            try { data = JSON.parse(event.data) } catch { return }
            for (const item of data.items ?? []) {
              osNotify(t('toast.annTitle'), item.title)
              if (item.level === 'urgent') {
                showUrgentModal({
                  title: `${t('news.urgentTitle')} · ${item.title}`,
                  html: item.html ?? '',
                  confirmLabel: t('news.gotIt'),
                  onClose: () => { void post('/announcements/ack', { id: item.id }).catch(() => {}) },
                })
              } else {
                showToast({ title: t('toast.annTitle'), body: item.title, tone: item.level === 'warn' ? 'warn' : undefined })
              }
            }
            window.dispatchEvent(new CustomEvent('ofm:announcements', { detail: data }))
          })
          source.addEventListener('update', event => {
            let data
            try { data = JSON.parse(event.data) } catch { return }
            osNotify(t('toast.updateTitle'), t('toast.updateBody').replace('{latest}', data.latest ?? '').replace('{current}', data.current ?? ''))
            showToast({
              title: t('toast.updateTitle'),
              body: t('toast.updateBody').replace('{latest}', data.latest ?? '').replace('{current}', data.current ?? ''),
              tone: 'warn', holdMs: 14000,
            })
            window.dispatchEvent(new CustomEvent('ofm:update', { detail: data }))
          })
          source.addEventListener('upgraded', event => {
            let data
            try { data = JSON.parse(event.data) } catch { data = {} }
            window.dispatchEvent(new CustomEvent('ofm:upgraded', { detail: data }))
          })
          source.addEventListener('hello', event => {
            let data
            try { data = JSON.parse(event.data) } catch { data = {} }
            window.dispatchEvent(new CustomEvent('ofm:hello', { detail: data }))
          })
        }
        open()
        return () => {
          disposed = true
          if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined }
          try { source?.close() } catch { /* already closed */ }
        }
      }, 'our-free-model: push subscription')

      // A hot reload or in-app upgrade swaps this bundle while the page stays
      // open. The only durable marker across that swap is localStorage, so the
      // successor announces what happened exactly once.
      ctx.effect(() => {
        void (async () => {
          try {
            const meta = await api('/meta')
            const at = Number(meta?.reloadedAt ?? 0)
            if (at <= 0) return
            let seen = ''
            try { seen = window.localStorage?.getItem('ofm.reloadedAt') ?? '' } catch { /* storage unavailable */ }
            if (String(at) === seen) return
            try { window.localStorage?.setItem('ofm.reloadedAt', String(at)) } catch { /* ignore */ }
            showToast({
              title: meta.version !== '' ? `Model Manager ${meta.version}` : 'Model Manager',
              body: t('reload.done').replace('{n}', String(meta.reloadCount ?? 0)),
              actions: [{ label: t('reload.refresh'), onClick: () => { try { window.location.reload() } catch { /* top-level navigation refused */ } } }],
              holdMs: 12000,
            })
          } catch { /* backend absent */ }
        })()
        return () => {}
      }, 'our-free-model: reload notice')

      // 侧栏一级入口：与「插件」同一层级，order 5 插在 plugins(0) 和
      // schedules(10) 之间。主面板用同一个 SettingsPage，不再把设置页当容器。
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'our-free-model',
          order: 5,
          label: () => t('nav.panel'),
          locale: NS,
        }, ModelSidebarIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'our-free-model',
          locale: NS,
        }, props => h(SettingsPage, { ...props, locale: localeTag(ctx), ctx })))
      } catch { /* older shells without a panel registry keep the composer entry */ }

      // 真正的对话框：聊天框按钮通过 window 事件打开，shell.overlay 负责挂载。
      // 用 portal 到 body，避免侧栏/会话布局的 overflow 把浮层裁掉。
      try {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'our-free-model-panel',
          order: 40,
          locale: NS,
        }, props => h(ModelPanelOverlay, { ...props, locale: localeTag(ctx), ctx })))
      } catch { /* 没有 overlay 槽位的宿主仍可从侧栏进入 */ }

      // 输入卡下方只保留压缩阈值，不再把「模型」和它挤在同一排。
      try {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'our-free-model-dock',
          order: 0,
          locale: NS,
        }, props => h(CompactionQuick, { ...props, t: Object.assign(x => t(x), { locale: localeTag(ctx) }) })))
      } catch { /* 宿主没有该槽位：快捷条缺席，侧栏入口仍在 */ }

      // 与 `dsh-model-failover` 的 seat 同一个槽位：conversation.input.right，
      // 用同样的 order 50 排到官方模型选择器紧左边，而不是跑到「回退」前面。
      // 点击才打开本插件自己的面板。
      try {
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'our-free-model-launcher',
          order: 1000,
          locale: NS,
        }, props => h(ModelLauncherButton, { ...props, t: Object.assign(x => t(x), { locale: localeTag(ctx) }) })))
      } catch { /* 宿主没有 input.right 槽位：侧栏「模型」入口仍可用 */ }

      // 芯片标签：把「渠道 · 模型」补回来，分组与自有渠道在聊天框里才可辨认。
      // 宿主没有这个槽位时忽略，芯片退回默认的模型名。
      try {
        ctx.slots.inject('conversation.input.model.label', () => ctx.slots.register({
          name: 'conversation.input.model.label',
          order: 100,
          locale: NS,
        }, props => h(ModelChipLabel, props)))
      } catch { /* 宿主没有 model.label 槽位：保持宿主默认标签 */ }

      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding',
        id: 'our-free-model-announcement',
        order: -50,
        locale: NS,
      }, props => h(AnnouncementGate, { ...props, t: Object.assign(x => t(x), { locale: localeTag(ctx) }) })))

      // 输入框右侧、模型选择器旁边的积分读数。槽位是共享 LIST seat：
      // provider 不属于本插件渠道时组件返回 null。包 try/catch：宿主没有
      // 该槽位时读数缺席，其余功能不受影响。
      try {
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'our-free-model-composer-credits',
          order: 6,
          locale: NS,
        }, props => h(ComposerChannelCredits, { ...props, ctx, t: Object.assign(x => t(x), { locale: localeTag(ctx) }) })))
      } catch { /* 宿主没有该槽位：读数缺席，其余功能不受影响 */ }
    }
    /**
     * Owns the announcement's readiness.
     *
     * The onboarding coordinator mounts one ordered step at a time and waits for
     * the registrant to either show something or call `complete`. This renders
     * null until the ack state is known — a step that paints a skeleton then
     * removes it is worse than one that waits — and completes immediately when
     * the user already acknowledged the current copy version.
     *
     * It also owns the one thing a slot step cannot assume: that the user can see
     * it. The desktop shell mounts its own first-run surface over the app and
     * hides `#root` (opacity 0 + inert) for as long as it is up; a step inside
     * `#root` is then neither visible nor clickable. Completing on the old
     * unconditional 3-second fallback in that window marked this step done, so
     * the announcement was skipped without ever having been shown. While the host
     * is hidden the gate therefore stays pending: no fallback timer, no ack, no
     * render — and it shows the dialog for real once the shell hands the screen
     * back.
     */
    function AnnouncementGate(props) {
      const { t, complete, openSection, explicit } = props
      const [ack, setAck] = useState(undefined)
      const [summary, setSummary] = useState(undefined)
      const [page, setPage] = useState(0)
      const shown = useHostShown()
      useEffect(() => {
        let alive = true
        api('/announcement')
          .then(payload => { if (alive) setAck(payload) })
          // 拿不到 ack：只有宿主看得见时才按「已确认」放行。被壳引导遮住时放行
          // 等于把这一步静默标记完成——用户一次都看不到公告。
          .catch(() => { if (alive && hostShown()) setAck({ acknowledged: true, version: '' }) })
        api('/summary').then(payload => { if (alive) setSummary(payload) }).catch(() => {})
        return () => { alive = false }
      }, [])
      // 超时兜底：3 秒拿不到 ack（后端挂起/超时/异常）→ 当作已 ack 主动放行——
      // 本组件是 settings.onboarding 协调器最先执行的 step（order:-50），complete 依赖 ack；
      // ack 永远 undefined 会永久卡住 onboarding 流程（连带阻塞后续 step 与主题启动画面）。
      // 计时只在宿主可见时进行：壳把 #root 设成 opacity:0 + inert 期间本来就没有 UI
      // 可看，此时放行只会让协调器以为这一步已经展示过。
      useEffect(() => {
        if (!shown || ack !== undefined) return undefined
        const timer = setTimeout(() => {
          setAck(current => current ?? { acknowledged: true, version: '' })
        }, 3000)
        return () => clearTimeout(timer)
      }, [shown, ack])
      const acknowledged = ack?.acknowledged === true && explicit !== true
      useEffect(() => {
        if (ack === undefined) return
        if (acknowledged) complete?.()
      }, [ack, acknowledged, complete])
      if (!shown || ack === undefined || acknowledged) return null
      return h(Announcement, { t, complete, openSection, page, setPage, summary, acknowledged: false })
    }
    exports.apply = apply
    exports.inject = inject
    exports.name = 'our-free-model'
    // Headless test seams use the same stub React as scripts/client-lint.mjs.
    exports.__test = {
      parseSafeHtml, safeUrl, sanitizeStyle, htmlToDom, buildHeatCells, Heatmap, ChannelsPage,
      hostShown, Announcement, AnnouncementGate,
    }
    return module.exports
  },
})
