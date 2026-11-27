/**
 * 前端面板回归测试（1.5.1）—— 加载 client.js 的真实实现，用一个最小 hooks 运行时驱动组件。
 *
 * 覆盖审查报告中的前端问题：
 *  #1 已连接时修改主机地址：旧聊天入口与「已连接」状态必须清掉
 *  #4 连接断开后：卡片恢复「连接」按钮
 *  #6 认证失败但终端保留：不得显示「已连接」，也不展开文件浏览
 *  #8 加载中关闭文件预览：响应到达后预览不能自动重新打开
 * 以及：终端被手动接管时提供重新连接入口；心跳旧结果不能覆盖刚建立的连接。
 *
 * 运行时只实现本插件用到的 hooks（useState/useEffect/useRef/useMemo/useCallback），
 * 只渲染传入的顶层组件；子组件以元素形式留在树里，需要时单独渲染。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(HERE, '..', 'client.js'), 'utf8')

// ---------------- 最小 hooks 运行时 ----------------

function depsChanged(a, b) {
  if (a === undefined || b === undefined) return true
  if (a.length !== b.length) return true
  return a.some((value, i) => !Object.is(value, b[i]))
}

function createRuntime() {
  let current = null
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(init) {
      const inst = current
      const i = inst.index++
      if (!(i in inst.hooks)) inst.hooks[i] = { value: typeof init === 'function' ? init() : init }
      const slot = inst.hooks[i]
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        inst.dirty = true
      }
      return [slot.value, set]
    },
    useRef(init) {
      const inst = current
      const i = inst.index++
      if (!(i in inst.hooks)) inst.hooks[i] = { current: init }
      return inst.hooks[i]
    },
    useMemo(fn, deps) {
      const inst = current
      const i = inst.index++
      const slot = inst.hooks[i]
      if (slot === undefined || depsChanged(slot.deps, deps)) {
        inst.hooks[i] = { value: fn(), deps }
      }
      return inst.hooks[i].value
    },
    useCallback(fn, deps) {
      return React.useMemo(() => fn, deps)
    },
    useEffect(fn, deps) {
      const inst = current
      const i = inst.index++
      const slot = inst.hooks[i]
      if (slot === undefined || depsChanged(slot.deps, deps)) {
        inst.pending.push({ i, fn, deps })
      }
    },
  }

  function mount(Component, props) {
    const inst = { hooks: [], pending: [], index: 0, dirty: false, tree: null }
    const render = () => {
      current = inst
      inst.index = 0
      inst.dirty = false
      inst.tree = Component(props)
      current = null
      const effects = inst.pending.splice(0)
      for (const { i, fn, deps } of effects) {
        const previous = inst.hooks[i]
        if (typeof previous?.cleanup === 'function') previous.cleanup()
        inst.hooks[i] = { deps, cleanup: fn() }
      }
    }
    render()
    return {
      get tree() { return inst.tree },
      /** 让所有挂起的 Promise 跑完并重渲染，直到状态稳定。 */
      async flush() {
        for (let round = 0; round < 50; round++) {
          await new Promise((resolve) => setImmediate(resolve))
          if (!inst.dirty) {
            await new Promise((resolve) => setImmediate(resolve))
            if (!inst.dirty) return
          }
          render()
        }
        throw new Error('组件状态未在 50 轮内稳定')
      },
    }
  }
  return { React, mount }
}

// ---------------- 树查询 ----------------

function* walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  yield node
  for (const child of node.children ?? []) yield* walk(child)
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return (node.children ?? []).map(textOf).join('')
}

function buttons(tree) {
  return [...walk(tree)].filter((n) => n.type === 'button')
}

function buttonByText(tree, label) {
  return buttons(tree).find((b) => textOf(b).trim() === label)
}

function chipText(tree) {
  const chip = [...walk(tree)].find((n) => n.type === 'span' && String(n.props.className ?? '').startsWith('dsh-ssh-chip '))
  return chip === undefined ? '' : textOf(chip)
}

function findComponent(tree, name) {
  return [...walk(tree)].find((n) => typeof n.type === 'function' && n.type.name === name)
}

// ---------------- 加载 client.js ----------------

const PROFILE = {
  id: 'h-test1', name: '测试机', host: 'old.example.com', port: 22, username: 'root',
  authMode: 'key', keyPath: '/home/u/.ssh/id_ed25519', hostKeyPolicy: 'accept-new', addressMode: 'both',
}

/**
 * 加载插件并取出 HostsPanel。
 * routes：接口名 → (body) => 返回值（对象 = 200 成功；{ status, json } = 指定状态码；Promise 可延迟）。
 */
function loadPanel(routes, { sessionId = 'sess-panel01', lastSession, onUpload, dom, profile = PROFILE } = {}) {
  const runtime = createRuntime()
  const intervals = []
  const calls = []
  let HostsPanel
  let clientTest
  const storage = new Map([['dsh.ssh-servers.v1', JSON.stringify([profile])]])
  if (lastSession !== undefined) storage.set('dsh.ssh-servers.session-map.v1', JSON.stringify({ [PROFILE.id]: lastSession }))
  const sandbox = {
    console,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 5)),
    clearTimeout,
    setInterval: (fn) => { intervals.push(fn); return intervals.length },
    clearInterval: () => {},
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    document: {
      hidden: false,
      baseURI: 'http://127.0.0.1/',
      head: { appendChild() {} },
      body: { appendChild() {}, removeChild() {} },
      createElement: () => ({ setAttribute() {}, remove() {}, style: {} }),
    },
    URL,
    AbortSignal,
    XMLHttpRequest: class {
      headers = {}
      upload = {}
      open(method, url) { assert.equal(method, 'POST'); assert.match(url, /fs-upload$/u) }
      setRequestHeader(name, value) { this.headers[name] = value }
      send(file) {
        const meta = JSON.parse(decodeURIComponent(this.headers['x-dsh-ssh-upload']))
        this.upload.onprogress({ lengthComputable: true, loaded: file.size, total: file.size })
        const result = onUpload(meta, file)
        this.status = result.status
        this.response = result.body
        this.onload()
      }
    },
    async fetch(url, init) {
      const name = String(url).replace(/^.*ssh-servers\/api\//u, '')
      const body = JSON.parse(init.body)
      calls.push({ name, body })
      const handler = routes[name]
      const result = handler === undefined ? { status: 404, json: { ok: false } } : await handler(body)
      const isWrapped = result !== null && typeof result === 'object' && 'status' in result && 'json' in result
      const status = isWrapped ? result.status : 200
      const json = isWrapped ? result.json : result
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
        headers: { get: () => 'application/json' },
      }
    },
    ...dom,
  }
  sandbox.window = {
    ...dom?.window,
    __ModuleLoader__: {
      load({ factory }) {
        const mod = factory(() => runtime.React)
        clientTest = mod.__test__
        const effects = []
        const ctx = {
          effect: (fn) => effects.push(fn()),
          locale: {
            bind: () => (key) => key, // 返回 key 本身 → text() 使用中文兜底文案
            register: () => () => {},
            subscribe: () => () => {},
            getLocale: () => ({ active: 'zh' }),
          },
          sidebarRight: { openTab() {} },
          sidebarRightTabs: { register: () => () => {} },
          sessions: { create: async () => ({ sessionId: 'sess-abcdef12' }) },
          uiWorkspace: { openSession() {}, archiveSession: async () => {} },
          slots: {
            inject: (_name, fn) => fn(),
            register: (opts, Component) => {
              if (opts.name === 'sidebar.right.pane.tab') HostsPanel = Component
              return () => {}
            },
          },
        }
        mod.apply(ctx)
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const view = runtime.mount(HostsPanel, { sessionId, useWorkspaces: undefined })
  return {
    view,
    runtime,
    calls,
    clientTest,
    storage,
    /** 手动触发一次 30 秒心跳（先等几毫秒，模拟心跳晚于连接发出）。 */
    async poll() {
      await new Promise((resolve) => setTimeout(resolve, 5))
      for (const fn of intervals) fn()
      await view.flush()
    },
  }
}

const STATUS_OK = { ok: true, configured: true, bindingMatches: true, hasPassword: false, hasPassphrase: false }
const NOT_CONNECTED = { connected: false, alive: false, reason: 'not-connected' }
const ALIVE = { connected: true, alive: true, reason: 'alive', control: 'agent' }

function baseRoutes(overrides = {}) {
  let state = NOT_CONNECTED
  const routes = {
    'credentials/status': () => STATUS_OK,
    resolve: () => ({ ok: true, ipv4: ['203.0.113.10'], ipv6: [] }),
    'connection-state': () => ({ ok: true, states: { [PROFILE.id]: state } }),
    connect: () => { state = ALIVE; return { ok: true, status: 'connected', terminalId: 't1' } },
    'fs-list': () => ({ ok: true, path: '/', parent: null, entries: [] }),
    ...overrides,
  }
  return { routes, setState: (next) => { state = next } }
}

async function connectFirst(panel) {
  await panel.view.flush()
  buttonByText(panel.view.tree, '连接').props.onClick()
  await panel.view.flush()
}

// ---------------- 测试 ----------------

describe('HostsPanel 连接状态（真实 client.js）', () => {
  test('waits for idle and skips the resolver for IPv4 literals', async () => {
    let idle
    const panel = loadPanel(baseRoutes().routes, {
      profile: { ...PROFILE, host: '192.0.2.7' },
      dom: { window: { requestIdleCallback(fn) { idle = fn; return 1 }, cancelIdleCallback() {} } },
    })
    await panel.view.flush()
    assert.equal(panel.calls.length, 0)
    assert.ok(buttonByText(panel.view.tree, '连接'))
    idle()
    await panel.view.flush()
    assert.deepEqual(panel.calls.map(call => call.name).sort(), ['connection-state', 'credentials/status'])
    assert.match(textOf(panel.view.tree), /IPv4/u)
  })

  test('回到前台时立即查询连接状态', async () => {
    const listeners = new Map()
    const document = {
      baseURI: 'http://127.0.0.1/',
      hidden: true,
      head: { appendChild() {} },
      createElement: () => ({ setAttribute() {}, remove() {} }),
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name) => listeners.delete(name),
    }
    const panel = loadPanel(baseRoutes().routes, { dom: { document } })
    await panel.view.flush()
    assert.equal(panel.calls.some(call => call.name === 'connection-state'), false)
    document.hidden = false
    await listeners.get('visibilitychange')()
    await panel.view.flush()
    assert.equal(panel.calls.filter(call => call.name === 'connection-state').length, 1)
  })

  test('刷新后直接复用原聊天 ID 重连', async () => {
    const { routes } = baseRoutes()
    const lastSession = 'sess-original-4321'
    const panel = loadPanel(routes, { sessionId: lastSession, lastSession })
    await panel.view.flush()
    buttonByText(panel.view.tree, '在原聊天中重连').props.onClick()
    await panel.view.flush()
    assert.equal(panel.calls.find(call => call.name === 'connect').body.sessionId, lastSession)
    assert.match(textOf(panel.view.tree), /原聊天已重新连接/u)
    assert.equal(buttonByText(panel.view.tree, '打开新聊天'), undefined)
  })

  test('连接成功：显示「已连接」与「打开新聊天」', async () => {
    const { routes } = baseRoutes()
    const panel = loadPanel(routes)
    await connectFirst(panel)
    assert.equal(chipText(panel.view.tree), '已连接')
    assert.ok(buttonByText(panel.view.tree, '打开新聊天'))
    assert.equal(buttonByText(panel.view.tree, '连接'), undefined)
  })

  test('#4 回归：连接断开后卡片恢复「连接」按钮', async () => {
    const { routes, setState } = baseRoutes()
    const panel = loadPanel(routes)
    await connectFirst(panel)
    setState({ connected: false, alive: false, reason: 'terminal-exited', terminalState: 'exited' })
    await panel.poll()
    assert.ok(buttonByText(panel.view.tree, '连接'), '断线后应出现「连接」')
    assert.equal(buttonByText(panel.view.tree, '打开新聊天'), undefined, '不应再引导进入已断开的聊天')
    assert.notEqual(chipText(panel.view.tree), '已连接')
  })

  test('#6 回归：认证失败但终端保留时，不显示「已连接」、不展开文件浏览', async () => {
    const { routes } = baseRoutes({
      connect: () => ({
        status: 409,
        json: { ok: false, code: 'passphrase-required', message: '私钥需要口令', terminalId: 't9', terminalState: 'running' },
      }),
    })
    const panel = loadPanel(routes)
    await connectFirst(panel)
    const tree = panel.view.tree
    assert.equal(chipText(tree), '认证未完成')
    assert.equal(findComponent(tree, 'FileBrowserSection'), undefined, '未登录不应展开文件浏览')
    assert.equal([...walk(tree)].some((n) => String(n.props?.className ?? '').includes('dsh-ssh-fs-wrap')), false)
    assert.ok(buttonByText(tree, '打开新聊天'), '保留进入该聊天手动处理的入口')
    assert.ok(buttonByText(tree, '连接'), '同时允许修正后重新连接')
  })

  test('#1 回归：已连接时修改主机地址，旧聊天入口与已连接状态被清除', async () => {
    const stub = baseRoutes()
    // 与真实后端一致：目标变化时撤销旧连接，之后的心跳返回 not-connected
    stub.routes.credentials = (body) => {
      assert.equal(body.host, 'new.example.com')
      stub.setState(NOT_CONNECTED)
      return { ...STATUS_OK, invalidated: 1 }
    }
    const { routes } = stub
    const panel = loadPanel(routes)
    await connectFirst(panel)
    assert.equal(chipText(panel.view.tree), '已连接')

    buttonByText(panel.view.tree, '编辑').props.onClick()
    await panel.view.flush()
    const hostInput = [...walk(panel.view.tree)].find((n) => n.type === 'input' && n.props.id === 'dsh-ssh-host')
    hostInput.props.onChange({ target: { value: 'new.example.com' } })
    await panel.view.flush()
    buttonByText(panel.view.tree, '保存主机').props.onClick()
    await panel.view.flush()

    const tree = panel.view.tree
    assert.match(textOf(tree), /new\.example\.com|203\.\*\*\*/u)
    assert.notEqual(chipText(tree), '已连接', '新地址不应显示为已连接')
    assert.equal(buttonByText(tree, '打开新聊天'), undefined, '不应再进入绑定旧服务器的聊天')
    assert.ok(buttonByText(tree, '连接'))
    assert.match(textOf(tree), /旧连接已断开/u)
  })

  test('只改名称（目标不变）时保留连接', async () => {
    const { routes } = baseRoutes({ credentials: () => ({ ...STATUS_OK, invalidated: 0 }) })
    const panel = loadPanel(routes)
    await connectFirst(panel)
    buttonByText(panel.view.tree, '编辑').props.onClick()
    await panel.view.flush()
    const nameInput = [...walk(panel.view.tree)].find((n) => n.type === 'input' && n.props.id === 'dsh-ssh-name')
    nameInput.props.onChange({ target: { value: '改名后' } })
    await panel.view.flush()
    buttonByText(panel.view.tree, '保存主机').props.onClick()
    await panel.view.flush()
    assert.equal(chipText(panel.view.tree), '已连接')
    assert.ok(buttonByText(panel.view.tree, '打开新聊天'))
  })

  test('终端被手动接管：徽章提示并提供「连接」入口', async () => {
    const { routes, setState } = baseRoutes()
    const panel = loadPanel(routes)
    await connectFirst(panel)
    setState({ ...ALIVE, control: 'user' })
    await panel.poll()
    assert.equal(chipText(panel.view.tree), '已手动接管')
    assert.ok(buttonByText(panel.view.tree, '连接'))
    assert.ok(buttonByText(panel.view.tree, '打开新聊天'))
  })

  test('心跳在连接前发出、连接后才返回：旧结果不能覆盖新连接', async () => {
    let releasePoll
    let pollCount = 0
    const { routes } = baseRoutes()
    routes['connection-state'] = () => {
      pollCount++
      // 挂载时那一轮立即返回；第二轮故意挂起，模拟慢响应
      if (pollCount === 1) return { ok: true, states: { [PROFILE.id]: NOT_CONNECTED } }
      return new Promise((resolve) => { releasePoll = () => resolve({ ok: true, states: { [PROFILE.id]: NOT_CONNECTED } }) })
    }
    const panel = loadPanel(routes)
    await panel.view.flush()
    void panel.poll() // 发出第二轮心跳（挂起）
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(pollCount, 2, '第二轮心跳应已在连接前发出')
    await panel.view.flush()
    await new Promise((resolve) => setTimeout(resolve, 5))
    buttonByText(panel.view.tree, '连接').props.onClick()
    await panel.view.flush()
    assert.equal(chipText(panel.view.tree), '已连接')
    releasePoll()
    await panel.view.flush()
    assert.equal(chipText(panel.view.tree), '已连接', '早于连接发出的心跳结果应被忽略')
    assert.ok(buttonByText(panel.view.tree, '打开新聊天'))
  })
})

test('右栏只在手动拖动后保存宽度，重新打开 SSH 面板时恢复', () => {
  const listeners = new Map()
  const frame = {
    clientWidth: 1280,
    hasAttribute: name => fullscreen && name === 'data-rightbar-fullscreen',
    addEventListener: (type, callback) => listeners.set(type, callback),
    removeEventListener: type => listeners.delete(type),
  }
  let fullscreen = false
  let width = 570
  const column = { parentElement: frame, getBoundingClientRect: () => ({ width }) }
  const element = { closest: () => column, getBoundingClientRect: () => ({ width }) }
  const native = { panels: { setRightbar: value => { width = value } } }
  let onResize
  const dom = {
    ResizeObserver: class { constructor(callback) { onResize = callback } observe() {} disconnect() {} },
    window: {
      addEventListener: (type, callback) => listeners.set(type, callback),
      removeEventListener: type => listeners.delete(type),
    },
    requestAnimationFrame: callback => { callback(); return 1 },
    cancelAnimationFrame() {},
  }
  const { clientTest, storage } = loadPanel(baseRoutes().routes, { dom })
  const key = 'dsh.ssh-servers.dock-width.v1'
  const dispose = clientTest.rememberDockWidth(native, element)
  listeners.get('pointerdown')({ button: 0, pointerId: 1, target: { closest: () => ({}) } })
  width = 355
  listeners.get('pointerup')({ type: 'pointerup', pointerId: 1 })
  assert.equal(storage.get(key), '355')
  fullscreen = true
  listeners.get('pointerdown')({ button: 0, pointerId: 2, target: { closest: () => ({}) } })
  width = 1280
  listeners.get('pointerup')({ type: 'pointerup', pointerId: 2 })
  assert.equal(storage.get(key), '355')
  dispose()
  assert.equal(listeners.size, 0)
  fullscreen = false
  width = 570
  clientTest.rememberDockWidth(native, element)()
  assert.equal(width, 355)
  storage.set(key, '700')
  frame.clientWidth = 800
  const cleanup = clientTest.rememberDockWidth(native, element)
  assert.equal(width, 560)
  assert.equal(storage.get(key), '700')
  frame.clientWidth = 1200
  onResize()
  assert.equal(width, 700)
  cleanup()
})

describe('FileBrowserSection（真实 client.js）', () => {
  async function mountBrowser(previewHandler, options) {
    const { routes } = baseRoutes({
      'fs-list': options?.onList ?? (() => ({
        ok: true, path: '/', parent: null,
        entries: [{ name: 'a.txt', type: 'file', size: 3, mtimeMs: 0, mode: '644' }],
      })),
      'fs-preview': previewHandler,
      'fs-upload/check': options?.onCheck ?? (() => ({ ok: true, exists: false })),
    })
    const panel = loadPanel(routes, options)
    await connectFirst(panel)
    assert.equal(findComponent(panel.view.tree, 'FileBrowserSection'), undefined)
    buttons(panel.view.tree).find(button => button.props['aria-expanded'] === false && button.props.className === 'dsh-ssh-fs-toggle').props.onClick()
    await panel.view.flush()
    const element = findComponent(panel.view.tree, 'FileBrowserSection')
    assert.ok(element, '手动展开后应渲染文件浏览区块')
    if (options?.lastDirectory) panel.storage.set(`dsh.ssh-servers.last-directory.v1:${element.props.bindingKey}`, options.lastDirectory)
    const browser = panel.runtime.mount(element.type, element.props)
    await browser.flush()
    return browser
  }

  test('恢复上次目录，目录失效时回到根目录', async () => {
    const requested = []
    await mountBrowser(undefined, { lastDirectory: '/old', onList: ({ path }) => {
      requested.push(path)
      if (path === '/old') return { status: 404, json: { ok: false, code: 'dir-unreadable' } }
      return { ok: true, path, parent: null, entries: [] }
    } })
    assert.deepEqual(requested, ['/old', '/'])
  })

  test('#8 回归：加载中关闭预览，响应到达后不会重新打开', async () => {
    let release
    const browser = await mountBrowser(() => new Promise((resolve) => {
      release = () => resolve({ ok: true, name: 'a.txt', path: '/a.txt', size: 3, mode: '644', kind: 'text', text: 'abc', truncated: false })
    }))
    const label = [...walk(browser.tree)].find((n) => n.type === 'span' && textOf(n) === 'a.txt' && typeof n.props.onClick === 'function')
    label.props.onClick()
    await browser.flush()
    assert.ok([...walk(browser.tree)].some((n) => n.props?.className === 'dsh-fs-preview'), '点击后应显示加载中的预览')

    buttons(browser.tree).find((b) => textOf(b) === '关闭').props.onClick()
    await browser.flush()
    assert.equal([...walk(browser.tree)].some((n) => n.props?.className === 'dsh-fs-preview'), false)

    release()
    await browser.flush()
    assert.equal([...walk(browser.tree)].some((n) => n.props?.className === 'dsh-fs-preview'), false, '已关闭的预览不应被旧响应重新打开')
  })

  test('预览正常完成时仍能显示内容', async () => {
    const browser = await mountBrowser(() => ({ ok: true, name: 'a.txt', path: '/a.txt', size: 3, mode: '644', kind: 'text', text: 'abc', truncated: false }))
    const label = [...walk(browser.tree)].find((n) => n.type === 'span' && textOf(n) === 'a.txt' && typeof n.props.onClick === 'function')
    label.props.onClick()
    await browser.flush()
    const pre = [...walk(browser.tree)].find((n) => n.type === 'pre')
    assert.equal(textOf(pre), 'abc')
  })

  test('同名文件在传输前检查，取消后没有上传，确认后只传一次', async () => {
    const uploads = []
    const browser = await mountBrowser(undefined, { onCheck: () => ({ ok: true, exists: true, size: 456 }), onUpload(meta) {
      uploads.push(meta)
      return { status: 200, body: { ok: true, path: '/sample.txt' } }
    } })
    const drop = [...walk(browser.tree)].find(node => typeof node.props.onDrop === 'function')
    const dropFile = () => drop.props.onDrop({ preventDefault() {}, dataTransfer: { files: [{ name: 'sample.txt', size: 5 }] } })
    dropFile()
    await browser.flush()
    assert.equal(uploads.length, 0)
    assert.match(textOf(browser.tree), /456 B/u)
    buttonByText(browser.tree, '取消').props.onClick()
    await browser.flush()
    assert.equal(uploads.length, 0)
    dropFile()
    await browser.flush()
    buttonByText(browser.tree, '确认覆盖').props.onClick()
    await browser.flush()
    assert.deepEqual(uploads.map(meta => meta.overwrite), [true])
    assert.equal(uploads[0].directory, '/')
    assert.match(textOf(browser.tree), /写入完成 \/sample\.txt/u)
  })

  test('上传结果未知时需检查目标目录再操作', async () => {
    const browser = await mountBrowser(undefined, { onUpload: () => ({ status: 409, body: { ok: false, code: 'upload-result-unknown' } }) })
    const drop = [...walk(browser.tree)].find(node => typeof node.props.onDrop === 'function')
    drop.props.onDrop({ preventDefault() {}, dataTransfer: { files: [{ name: 'sample.txt', size: 5 }] } })
    await browser.flush()
    buttonByText(browser.tree, '上传').props.onClick()
    await browser.flush()
    assert.match(textOf(browser.tree), /上传结果待确认/u)
    assert.ok(buttonByText(browser.tree, '选择或拖入文件').props.disabled)
    await buttonByText(browser.tree, '核对目标文件').props.onClick()
    await browser.flush()
    assert.match(textOf(browser.tree), /目标文件未找到/u)
    assert.ok(!buttonByText(browser.tree, '选择或拖入文件').props.disabled)
  })
})

test('连续采集巡检快照后显示指标变化', async () => {
  let disk = 20
  const { routes } = baseRoutes({ snapshot: () => ({ ok: true, snapshot: {
    capturedAt: Date.now(), diskUsedPercent: disk += 10,
    memoryTotalKiB: 1024, memoryAvailableKiB: 512, load: [0.2, 0.3, 0.4], services: [],
  } }) })
  const panel = loadPanel(routes)
  await connectFirst(panel)
  const element = findComponent(panel.view.tree, 'SnapshotPanel')
  const section = panel.runtime.mount(element.type, element.props)
  for (let i = 0; i < 2; i++) {
    buttonByText(section.tree, '采集快照').props.onClick()
    await section.flush()
  }
  assert.match(textOf(section.tree), /30% → 40%/u)
})
