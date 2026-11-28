/**
 * 前端纯函数测试 —— 加载 client.js 的**真实实现**。
 *
 * 早期版本在测试里复制了一份 humanSize 等函数来验证，实现改了测试照样通过。
 * 这里用一个假的 window.__ModuleLoader__ 把 client.js 跑起来，
 * 从 factory 返回的 __test__ 出口拿到真实函数。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

/** 用最小桩把 client.js 载入 vm，返回模块导出对象。 */
function loadClient() {
  let captured
  const noop = () => {}
  const fakeReact = {
    createElement: () => null,
    useState: (init) => [typeof init === 'function' ? init() : init, noop],
    useEffect: noop,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    Fragment: 'Fragment',
  }
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { hidden: false, head: { appendChild: noop }, createElement: () => ({ setAttribute: noop, remove: noop }), body: { appendChild: noop, removeChild: noop } },
    URL: { createObjectURL: () => 'blob:', revokeObjectURL: noop },
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  }
  sandbox.window = {
    __ModuleLoader__: {
      load({ factory }) {
        captured = factory(() => fakeReact)
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return captured
}

const mod = loadClient()
const fns = mod?.__test__ ?? {}

describe('client.js 真实实现', () => {
  test('模块加载后暴露 __test__ 出口', () => {
    assert.equal(typeof mod.apply, 'function', '应导出 apply')
    assert.ok(fns.humanSize, '__test__ 应暴露 humanSize')
  })

  test('humanSize 按量级四舍五入', () => {
    assert.equal(fns.humanSize(0), '0 B')
    assert.equal(fns.humanSize(512), '512 B')
    assert.equal(fns.humanSize(1024), '1.0 KB')
    assert.equal(fns.humanSize(1536), '1.5 KB')
    assert.equal(fns.humanSize(1024 * 1024), '1.0 MB')
    assert.equal(fns.humanSize(1024 * 1024 * 1024), '1.00 GB')
    // 无效输入不产生 '0 B' 这类误导性文本
    assert.equal(fns.humanSize(null), '')
    assert.equal(fns.humanSize(-1), '')
    assert.equal(fns.humanSize(NaN), '')
    assert.equal(fns.humanSize(undefined), '')
    assert.equal(fns.humanSize(-1), '')
    assert.equal(fns.humanSize('x'), '')
  })

  test('formatTime 输出 YYYY-MM-DD HH:mm', () => {
    const sample = new Date(2026, 10, 17, 9, 5, 0).getTime()
    assert.equal(fns.formatTime(sample), '2026-11-17 09:05')
    assert.equal(fns.formatTime(0), '')
    assert.equal(fns.formatTime(new Date(2026, 11, 3, 7, 8).getTime()), '2026-12-03 07:08')
    assert.equal(fns.formatTime(undefined), '')
    assert.equal(fns.formatTime(-5), '')
    assert.equal(fns.formatTime(null), '')
  })

  test('fileKindLabel 支持目录/链接/扩展名', () => {
    assert.equal(fns.fileKindLabel({ type: 'dir', name: 'var' }), '目录')
    assert.equal(fns.fileKindLabel({ type: 'link', name: 'x' }), '链接')
    assert.equal(fns.fileKindLabel({ type: 'file', name: 'nginx.conf' }), 'conf')
    assert.equal(fns.fileKindLabel({ type: 'file', name: 'README' }), '文件')
    assert.equal(fns.fileKindLabel({ type: 'file', name: 'photo.JPG' }), 'jpg')
    assert.equal(fns.fileKindLabel({ type: 'file', name: 'a.tar.gz' }), 'gz')
    assert.equal(fns.fileKindLabel({ type: 'file', name: '.bashrc' }), '文件')
    assert.equal(fns.fileKindLabel({ type: 'file', name: 'trailing.' }), '文件')
    assert.equal(fns.fileKindLabel({ type: 'file' }), '文件')
    // 英文环境走字典
    const enT = (k) => ({ kindDir: 'Folder', kindLink: 'Link', kindFile: 'File' }[k] ?? k)
    assert.equal(fns.fileKindLabel({ type: 'dir', name: 'var' }, enT), 'Folder')
  })

  test('maskAddress 保留 IPv4 首段、IPv6 前两组', () => {
    assert.equal(fns.maskAddress('182.254.228.115'), '182.***.***.***')
    assert.ok(fns.maskAddress('2001:db8::1').startsWith('2001:db8'))
    assert.equal(fns.maskAddress(''), '')
  })
})
