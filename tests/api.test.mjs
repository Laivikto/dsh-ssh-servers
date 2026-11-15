/**
 * 端到端 API 测试（需要 DSH 正在运行且插件已加载）。
 *
 * 运行：node --test tests/api.test.mjs
 *      或设置 DSH_PORT 环境变量指定端口
 *
 * 未检测到运行中的 DSH 时自动跳过。
 */
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// DSH 端口每次启动可能不同，因此优先读环境变量，其次扫描本地监听端口。
import { execSync } from 'node:child_process'

/** 从系统监听列表中猜出所有本地端口（尽力而为，失败返回空）。 */
function discoverLocalPorts() {
  try {
    const out = execSync(
      process.platform === 'win32'
        ? 'netstat -ano -p TCP'
        : 'ss -tln 2>/dev/null || netstat -tln 2>/dev/null || true',
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const ports = new Set()
    for (const line of out.split('\n')) {
      const m = line.match(/127\.0\.0\.1:(\d+)\s+.*LISTENING/i) || line.match(/127\.0\.0\.1:(\d+)/i)
      if (m) ports.add(Number(m[1]))
    }
    return [...ports]
  } catch {
    return []
  }
}

const CANDIDATE_PORTS = [
  Number(process.env.DSH_PORT) || 0,
  ...discoverLocalPorts(),
].filter(Boolean)

/** 向指定端口发送 POST，返回 { code, body } 或 null（不可达）。 */
function post(port, path, payload, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(payload)
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(buf) } catch { /* 非 JSON */ }
        resolve({ code: res.statusCode, body: parsed, raw: buf })
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
    req.end(data)
  })
}

/** 探测出一个插件 API 可达的端口。 */
/** 响应是否确实来自本插件的 API（而不是恰好占用了该端口的其他服务）。 */
function looksLikePluginApi(r) {
  if (r === null) return false
  if (r.code !== 200 && r.code !== 400) return false
  const body = r.body
  if (body === null || typeof body !== 'object') return false
  // 本插件的响应必定是 { ok: boolean, ... }
  return typeof body.ok === 'boolean'
}

async function findApiPort() {
  // 并行探测，缩短等待时间
  const results = await Promise.all(
    CANDIDATE_PORTS.map(async (port) => {
      const r = await post(port, '/ssh-servers/api/list-keys', { dir: 'C:/' }, 1500)
      return looksLikePluginApi(r) ? port : null
    }),
  )
  return results.find((p) => p !== null) ?? null
}

let PORT = null

before(async () => {
  PORT = await findApiPort()
  if (PORT !== null) console.log(`  → 检测到插件 API 端口: ${PORT}`)
})

function requirePort() {
  if (PORT === null) return false
  return true
}

describe('目录列举 API', () => {
  test('不存在的目录返回 dir-missing', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await post(PORT, '/ssh-servers/api/list-keys', { dir: 'Z:/definitely-not-exist' })
    assert.equal(r.code, 400)
    assert.equal(r.body.code, 'dir-missing')
  })

  test('相对路径被拒绝', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await post(PORT, '/ssh-servers/api/list-keys', { dir: 'relative/path' })
    assert.equal(r.body.code, 'invalid-dir')
  })

  test('指向文件而非目录被拒绝', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await post(PORT, '/ssh-servers/api/list-keys', { dir: 'C:/Windows/System32/drivers/etc/hosts' })
    // 某些环境 hosts 不存在；只要求不返回 ok:true
    assert.notEqual(r.body?.ok, true)
  })

  test('换行注入被拒绝', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await post(PORT, '/ssh-servers/api/list-keys', { dir: 'C:/tmp\nrm -rf /' })
    assert.equal(r.body.code, 'invalid-dir')
  })

  test('null 类型被拒绝', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await post(PORT, '/ssh-servers/api/list-keys', { dir: null })
    assert.equal(r.body.ok, false)
  })

  test('数组类型被拒绝', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await post(PORT, '/ssh-servers/api/list-keys', { dir: ['C:/', 'D:/'] })
    assert.equal(r.body.ok, false)
  })

  test('只返回元数据，不泄露文件内容', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await post(PORT, '/ssh-servers/api/list-keys', { dir: 'C:/' })
    if (r.body?.ok !== true) return t.skip('根目录不可读')
    for (const f of r.body.files ?? []) {
      const keys = Object.keys(f).sort()
      assert.deepEqual(keys, ['likelyKey', 'name', 'path', 'size'], '文件对象字段应固定')
    }
  })

  test('GET 方法返回 405', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/ssh-servers/api/list-keys', method: 'GET' }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', () => resolve(null))
      req.end()
    })
    assert.equal(r, 405)
  })
})

describe('连接状态 API', () => {
  test('未连接的服务器返回 not-connected', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await post(PORT, '/ssh-servers/api/connection-state', { hostId: 'h-nonexistent' })
    assert.equal(r.body.connected, false)
    assert.equal(r.body.alive, false)
    assert.equal(r.body.reason, 'not-connected')
  })

  test('非法 hostId 被拒绝', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await post(PORT, '/ssh-servers/api/connection-state', { hostId: '../etc/passwd' })
    assert.equal(r.body.ok, false)
  })

  test('数字 hostId 被拒绝', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await post(PORT, '/ssh-servers/api/connection-state', { hostId: 12345 })
    assert.equal(r.body.ok, false)
  })

  test('诊断模式返回连接列表', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await post(PORT, '/ssh-servers/api/connection-state', { list: true })
    assert.equal(r.body.ok, true)
    assert.equal(typeof r.body.count, 'number')
    assert.ok(Array.isArray(r.body.items))
  })

  test('非法 JSON 返回 400', async (t) => {
    if (!requirePort()) return t.skip('未检测到运行中的 DSH')
    const r = await new Promise((resolve) => {
      const data = 'not-json'
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: '/ssh-servers/api/connection-state', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length },
      }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', () => resolve(null))
      req.end(data)
    })
    assert.equal(r, 400)
  })
})
