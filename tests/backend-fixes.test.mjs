/**
 * 后端回归测试（1.5.1）—— 对照审查报告逐项验证修复。
 *
 *  #1 已连接时修改/删除主机：旧连接被作废，连接状态不再报告 alive
 *  #3 普通日志里的 "Broken pipe" 等字样不再被判为断线
 *  #5 非 GNU 系统的 ls -la 传统日期格式能正确解析（含在本机真实 sh 中执行回退命令）
 *  #9 body.lang 在 await 之后仍然生效
 *  以及：Windows 下 ssh.exe 绝对路径与 PowerShell/cmd 转义、旧版 OpenSSH 兼容、
 *        登录后 MOTD 不触发误判、预览命令在 BSD/macOS 风格 wc 下可用、远端命令由 sh 执行。
 *
 * 远端 POSIX 命令在本机 /bin/sh 里真实执行；BSD/BusyBox 差异用 PATH 垫片模拟，不连接任何服务器。
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { __test__ as T } from '../index.js'

const IS_WIN = process.platform === 'win32'

// ---------------- 假请求/响应/上下文 ----------------

function fakeReq(body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:8080', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield payload },
  }
}

function fakeRes() {
  const res = {
    status: undefined,
    body: undefined,
    writeHead(status) { res.status = status },
    end(text) { res.body = text === undefined ? undefined : JSON.parse(String(text)) },
  }
  return res
}

function fakeCtx(records = new Map(), overrides = {}) {
  const credentials = {
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, fn) { records.set(key, await fn(records.get(key))) },
    async deleteRecord(key) { records.delete(key) },
  }
  const services = {
    credentials,
    connection: { requestRejection: () => undefined },
    ...overrides,
  }
  return { get: (name) => services[name], records }
}

function fakeConnection({ hostId, host, control = 'agent', connectedAt = Date.now(), screen = '' }) {
  const terminal = {
    id: `term-${host}`,
    closed: false,
    info: { state: 'running', control },
    read: () => ({ text: screen }),
    async close() { terminal.closed = true },
  }
  return { terminal, hostId, host, port: 22, username: 'root', authMode: 'key', connectedAt, monitor: null }
}

afterEach(() => { T.connections.clear() })

test('认证期间删除或改址会废弃尚未登记的 SSH 终端', async () => {
  for (const action of ['delete', 'edit']) {
    const hostId = `h-pending-${action}`
    const binding = { host: 'old.example.invalid', port: 22, username: 'tester', authMode: 'password' }
    const records = new Map([[T.recordKey(hostId), { kind: 'grant', payload: { ...binding, password: 'test-only' } }]])
    let startAuth
    let releaseAuth
    const started = new Promise(resolve => { startAuth = resolve })
    const auth = new Promise(resolve => { releaseAuth = resolve })
    const terminal = {
      id: 'test-terminal', info: { state: 'running', control: 'agent', shell: { name: IS_WIN ? 'powershell' : 'bash' } },
      async write() { startAuth(); await auth },
      async close() { terminal.info.state = 'exited' },
      async drain() {},
      mark: () => ({ lines: () => ({ lines: ['Authenticated to test.'] }), dispose() {} }),
    }
    const ctx = fakeCtx(records, {
      sessionController: { resolveAgent: async () => ({ agent: { id: 'test-agent' } }) },
      terminalController: { openForAgent: async () => terminal },
    })
    const output = fakeRes()
    const connecting = T.connectHandler(ctx, fakeReq({ hostId, sessionId: 'session-test', ...binding }), output)
    await started
    const change = fakeRes()
    if (action === 'delete') await T.deleteCredentialHandler(ctx, fakeReq({ hostId }), change)
    else await T.saveCredentialHandler(ctx, fakeReq({ hostId, ...binding, host: 'new.example.invalid', password: 'test-new' }), change)
    releaseAuth()
    await connecting
    assert.equal(change.status, 200)
    assert.equal(output.body.code, 'connection-changed')
    assert.equal(terminal.info.state, 'exited')
    assert.equal(T.connections.size, 0)
  }
})

test('SFTP 上传保留字面文件名，拒绝跨目录和超限请求', async () => {
  assert.equal(T.uploadDestination('/var/www', '测试 [1].txt'), '/var/www/测试 [1].txt')
  assert.equal(T.sftpPath('/var/www/测试 [1].txt'), '"/var/www/测试 [1].txt"')
  for (const [dir, name] of [['/var/../tmp', 'a'], ['/tmp', '../a'], ['/tmp', 'a\r\nb']]) {
    assert.equal(T.uploadDestination(dir, name), undefined)
  }
  const response = fakeRes()
  const metadata = encodeURIComponent(JSON.stringify({ hostId: 'h-test', directory: '/', name: 'a' }))
  await T.fsUploadHandler(fakeCtx(), fakeReq({}, {
    'content-type': 'application/octet-stream', 'content-length': '33554433', 'x-dsh-ssh-upload': metadata,
  }), response)
  assert.equal(response.status, 413)
})

test('快照只保留可解析指标和已请求的服务', () => {
  const snapshot = T.parseSnapshot('disk 24\nmemory 1024 512\nload 0.15 0.25 0.30\nservice nginx.service active\nservice other.service failed\n', ['nginx.service', 'missing.service'])
  assert.equal(snapshot.diskUsedPercent, 24)
  assert.equal(snapshot.memoryAvailableKiB, 512)
  assert.deepEqual(snapshot.load, [0.15, 0.25, 0.30])
  assert.deepEqual(snapshot.services, [{ name: 'nginx.service', state: 'active' }, { name: 'missing.service', state: 'unknown' }])
  assert.equal(T.parseSnapshot('disk 24', []), undefined)
})

test('解析上传预检的当前文件大小以及目标不可用状态', () => {
  assert.deepEqual(T.parseUploadCheck('banner\n__DSH_UPLOAD_NEW__\n'), { exists: false })
  assert.deepEqual(T.parseUploadCheck('__DSH_UPLOAD_FILE__ 321\r\n'), { exists: true, size: 321 })
  assert.deepEqual(T.parseUploadCheck('__DSH_UPLOAD_TARGET_UNSUPPORTED__\n'), { code: 'upload-target-unsupported' })
  assert.equal(T.parseUploadCheck('unrelated'), undefined)
  const digest = 'a'.repeat(64)
  assert.deepEqual(T.parseUploadCheck('__DSH_UPLOAD_FILE__ 321\n__DSH_UPLOAD_SHA256__ ' + digest), { exists: true, size: 321, digest })
})

// ---------------- #1 ----------------

describe('#1 修改/删除主机后旧连接失效', () => {
  const HOST = 'h-abc'
  const oldRecord = {
    kind: 'grant',
    payload: { name: 'srv', host: 'old.example.com', port: 22, username: 'root', authMode: 'key', keyPath: '/k/id', hostKeyPolicy: 'accept-new' },
  }

  test('保存新地址：作废旧连接、关闭插件控制的终端，状态不再是 alive', async () => {
    const ctx = fakeCtx(new Map([[`ssh-servers/${HOST}`, oldRecord]]))
    const conn = fakeConnection({ hostId: HOST, host: 'old.example.com' })
    T.connections.set('agent-1', conn)
    assert.equal(T.connectionStateOf(HOST).alive, true)

    const res = fakeRes()
    await T.saveCredentialHandler(ctx, fakeReq({ hostId: HOST, name: 'srv', host: 'new.example.com', port: 22, username: 'root', authMode: 'key', keyPath: '/k/id' }), res)
    assert.equal(res.status, 200)
    assert.equal(res.body.invalidated, 1)
    assert.equal(T.connections.size, 0)
    assert.equal(conn.terminal.closed, true)
    assert.equal(T.connectionStateOf(HOST).reason, 'not-connected')
  })

  test('只改名称（目标不变）：连接保留', async () => {
    const ctx = fakeCtx(new Map([[`ssh-servers/${HOST}`, oldRecord]]))
    const conn = fakeConnection({ hostId: HOST, host: 'old.example.com' })
    T.connections.set('agent-1', conn)
    const res = fakeRes()
    await T.saveCredentialHandler(ctx, fakeReq({ hostId: HOST, name: '新名字', host: 'old.example.com', port: 22, username: 'root', authMode: 'key', keyPath: '/k/id' }), res)
    assert.equal(res.body.invalidated, 0)
    assert.equal(T.connections.get('agent-1'), conn)
    assert.equal(conn.terminal.closed, false)
  })

  test('用户已接管的终端不被关闭，但插件连接仍被撤销', async () => {
    const ctx = fakeCtx(new Map([[`ssh-servers/${HOST}`, oldRecord]]))
    const conn = fakeConnection({ hostId: HOST, host: 'old.example.com', control: 'user' })
    T.connections.set('agent-1', conn)
    await T.saveCredentialHandler(ctx, fakeReq({ hostId: HOST, name: 'srv', host: 'other.example.com', port: 2222, username: 'root', authMode: 'key', keyPath: '/k/id' }), fakeRes())
    assert.equal(T.connections.size, 0)
    assert.equal(conn.terminal.closed, false)
  })

  test('删除主机：连接作废', async () => {
    const ctx = fakeCtx(new Map([[`ssh-servers/${HOST}`, oldRecord]]))
    T.connections.set('agent-1', fakeConnection({ hostId: HOST, host: 'old.example.com' }))
    const res = fakeRes()
    await T.deleteCredentialHandler(ctx, fakeReq({ hostId: HOST }), res)
    assert.equal(res.body.invalidated, 1)
    assert.equal(T.connectionStateOf(HOST).reason, 'not-connected')
  })

  test('其他主机的连接不受影响', async () => {
    const ctx = fakeCtx(new Map([[`ssh-servers/${HOST}`, oldRecord]]))
    const other = fakeConnection({ hostId: 'h-other', host: 'keep.example.com' })
    T.connections.set('agent-1', fakeConnection({ hostId: HOST, host: 'old.example.com' }))
    T.connections.set('agent-2', other)
    await T.saveCredentialHandler(ctx, fakeReq({ hostId: HOST, name: 'srv', host: 'new.example.com', port: 22, username: 'root', authMode: 'key', keyPath: '/k/id' }), fakeRes())
    assert.deepEqual([...T.connections.keys()], ['agent-2'])
    assert.equal(other.terminal.closed, false)
  })

  test('连接状态：同一主机多条连接时取最新，并返回终端控制权', () => {
    T.connections.set('a', fakeConnection({ hostId: HOST, host: 'x', connectedAt: 1000, control: 'agent' }))
    T.connections.set('b', fakeConnection({ hostId: HOST, host: 'x', connectedAt: 2000, control: 'user' }))
    const state = T.connectionStateOf(HOST)
    assert.equal(state.connectedAt, 2000)
    assert.equal(state.control, 'user')
  })
})

// ---------------- #3 ----------------

describe('#3 断线判定不误伤普通日志', () => {
  test('远端日志中的 Broken pipe / Connection reset by 不算断线', () => {
    const screens = [
      'root@vm:~# tail app.log\n2026-11-18 ERROR write: Broken pipe\n2026-11-18 WARN Connection reset by peer\nroot@vm:~# ',
      'nginx: [error] recv() failed (104: Connection reset by peer)\nroot@vm:~# ',
      'curl: (56) Recv failure: Connection reset by peer\n',
      'Broken pipe\nroot@vm:~# ',
      'client_loop: send disconnect: Broken pipe\nroot@vm:~# ls\nREADME',
    ]
    for (const s of screens) assert.equal(T.looksDisconnected(s), false, `不应误判: ${JSON.stringify(s)}`)
  })

  test('ssh 客户端断线提示位于屏幕末尾时识别为断线', () => {
    const screens = [
      'root@vm:~# \nclient_loop: send disconnect: Broken pipe',
      'top - 12:00\nConnection to 1.2.3.4 closed by remote host.\nConnection to 1.2.3.4 closed.',
      'packet_write_wait: Connection to 1.2.3.4 port 22: Broken pipe\n',
      'Timeout, server 1.2.3.4 not responding.',
      'Connection to example.com closed.\nPS C:\\Users\\张三> ',
      'Connection reset by 2001:db8::1 port 22\nC:\\Users\\u>',
    ]
    for (const s of screens) assert.equal(T.looksDisconnected(s), true, `应识别: ${JSON.stringify(s)}`)
  })

  test('连接状态接口使用同一判据：日志字样不再让存活连接显示为断开', () => {
    T.connections.set('a', fakeConnection({ hostId: 'h-log', host: 'x', screen: 'ERROR write: Broken pipe\nroot@vm:~# ' }))
    assert.equal(T.connectionStateOf('h-log').alive, true)
    T.connections.set('a', fakeConnection({ hostId: 'h-log', host: 'x', screen: 'root@vm:~# \nConnection to x closed by remote host.' }))
    assert.equal(T.connectionStateOf('h-log').reason, 'disconnected')
  })
})

// ---------------- #5 ----------------

describe('#5 非 GNU ls -la 传统日期格式', () => {
  const NOW = new Date(2026, 10, 18, 18, 0).getTime()

  test('BusyBox / macOS 风格输出能解析出条目', () => {
    const raw = [
      '__DSH_FS_BEGIN__',
      'total 12',
      'drwxr-xr-x    2 root     root          4096 Nov 18 12:00 .',
      'drwxr-xr-x   20 root     root          4096 Nov 18 12:00 ..',
      '-rw-r--r--    1 root     root            42 Nov 17 09:15 hello.txt',
      'lrwxrwxrwx    1 root     root             9 Mar  3  2024 link -> hello.txt',
      'crw-rw-rw-    1 root     root        1,   3 Nov 18 12:00 null',
      '-rw-r--r--@   1 user  staff  10 Jan  5  2023 mac file.txt',
      'drwxr-xr-x+   3 user  staff  96 Oct  1 08:00 中文目录',
      '__DSH_FS_END__',
    ].join('\n')
    const out = T.parseLsOutput(raw, NOW)
    assert.deepEqual(out.map((e) => e.name), ['hello.txt', 'link', 'null', 'mac file.txt', '中文目录'])
    assert.deepEqual(out.map((e) => e.type), ['file', 'link', 'file', 'file', 'dir'])
    assert.equal(out[0].size, 42)
    assert.equal(out[0].mtimeMs, new Date(2026, 10, 17, 9, 15).getTime())
    assert.equal(out[1].mtimeMs, new Date(2024, 2, 3).getTime())
    assert.equal(out[2].size, 0, '设备文件按 0 字节')
  })

  test('不带年份的日期若落在未来，按去年处理', () => {
    const jan = new Date(2026, 0, 10, 12, 0).getTime()
    assert.equal(T.lsDateToMs('Dec', '31', '23:00', jan), new Date(2025, 11, 31, 23, 0).getTime())
    assert.equal(T.lsDateToMs('Jan', '9', '08:00', jan), new Date(2026, 0, 9, 8, 0).getTime())
  })

  test('原有的纯数字时间戳格式仍兼容', () => {
    const out = T.parseLsOutput('__DSH_FS_BEGIN__\n-rw-r--r-- 1 root root 10 1700000000 a\n__DSH_FS_END__')
    assert.equal(out[0].mtimeMs, 1700000000000)
  })
})

// ---------------- 远端命令在本机 sh 中真实执行 ----------------

describe('远端 POSIX 命令（本机 sh 实测）', { skip: IS_WIN ? '需要 POSIX sh' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ssh-'))
  const nested = path.join(dir, "中文 it's dir")
  fs.mkdirSync(nested)
  const file = path.join(nested, '文件 a.txt')
  fs.writeFileSync(file, 'hello')
  fs.writeFileSync(path.join(nested, 'no-newline'), 'abc')

  /** 用 bash 充当「远端登录 shell」，执行经 sh -c 包装后的命令（与 ssh 远端的处理方式一致）。 */
  function runRemote(command, env = {}) {
    return execFileSync('bash', ['-c', T.remotePosixCommand(command)], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
  }

  /** PATH 垫片：模拟 BSD/BusyBox 的工具差异。 */
  function shim(scripts) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shim-'))
    for (const [name, body] of Object.entries(scripts)) {
      const p = path.join(bin, name)
      fs.writeFileSync(p, `#!/bin/sh\n${body}\n`)
      fs.chmodSync(p, 0o755)
    }
    return { PATH: `${bin}:${process.env.PATH}` }
  }

  test('ls 回退命令：真实 ls（LC_ALL=C 传统日期）输出能被解析，含中文与单引号路径', () => {
    const raw = runRemote(T.fsLsListCommand(nested))
    const out = T.parseLsOutput(raw)
    assert.deepEqual(out.map((e) => e.name).sort(), ['no-newline', '文件 a.txt'])
    const entry = out.find((e) => e.name === '文件 a.txt')
    assert.equal(entry.size, 5)
    assert.ok(Math.abs(entry.mtimeMs - fs.statSync(file).mtimeMs) < 120_000, '传统日期精确到分钟')
  })

  test('一次远端调用完成目录探测与列表，兼容 GNU find 和 ls 回退', () => {
    const mode = raw => T.extractMarkedLines(raw, '__DSH_FS_MODE_BEGIN__', '__DSH_FS_MODE_END__')
    const gnu = runRemote(T.fsListCommand(nested))
    assert.deepEqual(mode(gnu), ['__GNU__'])
    assert.deepEqual(T.parseFindOutput(gnu).map(entry => entry.name).sort(), ['no-newline', '文件 a.txt'])
    const busybox = shim({ find: 'exit 1' })
    const plain = runRemote(T.fsListCommand(nested), busybox)
    assert.deepEqual(mode(plain), ['__LS__'])
    assert.deepEqual(T.parseLsOutput(plain).map(entry => entry.name).sort(), ['no-newline', '文件 a.txt'])
    assert.deepEqual(mode(runRemote(T.fsListCommand(path.join(dir, 'nope')))), ['__ERR__'])
  })

  test('预览命令：BSD/macOS 的 stat 不支持 -c、wc -c 带前导空格时仍能得到大小与内容', () => {
    const bsd = shim({ stat: 'exit 1', wc: 'n=$(cat | /usr/bin/wc -c); printf "%8s\\n" "$n"' })
    const raw = runRemote(T.fsPreviewCommand(file), bsd)
    const m = /(?:^|\n)STAT (-?\d+) (\S+)/u.exec(raw)
    assert.ok(m, `应输出 STAT 行，实际: ${JSON.stringify(raw)}`)
    assert.equal(m[1], '5')
    assert.equal(Buffer.from(raw.slice(m.index + m[0].length).trim(), 'base64').toString(), 'hello')
  })

  test('预览命令：GNU 环境返回大小与权限；文件不存在返回 -1', () => {
    assert.match(runRemote(T.fsPreviewCommand(file)), /^STAT 5 6\d\d\n/u)
    assert.match(runRemote(T.fsPreviewCommand(path.join(dir, 'missing'))), /STAT -1 -/u)
  })

  test('下载命令：大小 + base64 往返一致（base64 从标准输入读取）', () => {
    assert.equal(runRemote(T.fsSizeCommand(file)).trim(), '5')
    assert.equal(Buffer.from(runRemote(T.fsBase64Command(file)), 'base64').toString(), 'hello')
  })

  test('sh -c 包装：含单引号、$、反引号的命令按字面传递', () => {
    assert.equal(runRemote("printf '%s' \"it's \\$HOME \\`x\\`\""), "it's $HOME `x`")
  })
})

// ---------------- #2（真实 bash 执行插件写入的整行） ----------------

describe('#2 命令完成判定（真实 bash）', { skip: IS_WIN ? '需要 bash' : false }, () => {
  /** 假终端：把插件写入的整行交给真实 bash 执行，输出追加到屏幕，模拟交互 shell 的回显与输出。 */
  function bashTerminal() {
    let transcript = 'u@vm:~$ '
    return {
      id: 't-bash',
      info: { state: 'running', control: 'agent' },
      async drain() {},
      mark() {
        const base = transcript.length
        return { lines: () => ({ lines: transcript.slice(base).split('\n') }), dispose() {} }
      },
      async write(data) {
        if (data === '\x03') return
        const line = data.replace(/\r$/u, '')
        let out = ''
        try {
          out = execFileSync('bash', ['-c', line], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        } catch (error) {
          out = String(error.stdout ?? '')
        }
        transcript += `${line}\n${out}u@vm:~$ `
      },
    }
  }

  const cases = [
    ['printf abc', /abc/u, 0],
    ['echo hello', /hello/u, 0],
    ['false', /^false\n/u, 1],
    ['sh -c "exit 3"', /exit 3/u, 3],
    ['sleep 0.1 &', /sleep 0\.1 &/u, 0],
    ['cd /tmp;', /^cd \/tmp/u, 0],
    ["printf '中文\\n两行\\n'", /中文\n两行/u, 0],
  ]
  for (const [command, expected, code] of cases) {
    test(`${command} → 退出码 ${code}，立即结束`, async () => {
      const started = Date.now()
      const out = await T.runAndCapture({ terminal: bashTerminal() }, command, new AbortController().signal, { pollMs: 5, timeoutMs: 3000 })
      assert.equal(out.exitCode, code)
      assert.match(out.text, expected)
      assert.equal(out.text.includes('__DSH_DONE_'), false)
      assert.ok(Date.now() - started < 2000, '不应等到超时')
    })
  }
})

// ---------------- #9 ----------------

describe('#9 请求体语言在 await 之后仍生效', () => {
  test('header=zh、body.lang=en：读取 body 后 msg 返回英文', async () => {
    await T.langStore.run({ lang: 'zh' }, async () => {
      const parsed = await T.readPostBody(fakeCtx(), fakeReq({ lang: 'en', x: 1 }, { 'accept-language': 'zh-CN' }), fakeRes())
      assert.equal(parsed.ok, true)
      assert.equal(T.msg('中文', 'English'), 'English')
    })
  })

  test('并发请求各自的 body.lang 互不串扰', async () => {
    const one = (lang) => T.langStore.run({ lang: 'zh' }, async () => {
      await T.readPostBody(fakeCtx(), fakeReq({ lang }), fakeRes())
      await new Promise((r) => setTimeout(r, lang === 'en' ? 15 : 1))
      return T.msg('中文', 'English')
    })
    assert.deepEqual(await Promise.all([one('en'), one('zh')]), ['English', '中文'])
  })

  test('真实 handler：英文请求的报错是英文', async () => {
    await T.langStore.run({ lang: 'zh' }, async () => {
      const res = fakeRes()
      await T.saveCredentialHandler(fakeCtx(), fakeReq({ lang: 'en', hostId: 'h-x', host: 'a', port: 22, username: 'bad user', authMode: 'key' }), res)
      assert.equal(res.status, 400)
      assert.match(res.body.message, /Usernames may contain/u)
    })
  })
})

// ---------------- Windows / OpenSSH 兼容 ----------------

describe('Windows 与 OpenSSH 兼容', () => {
  function withPlatform(platform, fn) {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platform })
    try { return fn() } finally { Object.defineProperty(process, 'platform', original) }
  }
  const BIN = path.resolve('/OpenSSH/ssh.exe')

  test('Windows 下终端用 ssh.exe 绝对路径（防当前目录劫持），PowerShell 与 cmd 写法各自正确', () => {
    withPlatform('win32', () => {
      assert.equal(T.sshInvocation('powershell', BIN), `& '${BIN}'`)
      assert.equal(T.sshInvocation('pwsh', BIN), `& '${BIN}'`)
      assert.equal(T.sshInvocation('cmd', BIN), `"${BIN}"`)
      assert.equal(T.sshInvocation('C:\\Windows\\System32\\cmd.exe', BIN), `"${BIN}"`)
      // 找不到绝对路径时不再静默回退到裸 ssh：那会把「当前目录劫持」和
      // 「PATH 里金 Git ssh」两个风险原样带回来，必须明确报错让用户装 OpenSSH。
      assert.throws(
        () => T.sshInvocation('cmd', 'ssh'),
        /找不到 Windows 自带的 ssh\.exe/u,
        '未找到绝对路径时应报错而不是回退',
      )
    })
    withPlatform('linux', () => {
      assert.equal(T.sshInvocation('bash', BIN), 'ssh')
    })
  })

  test('cmd 下的完整命令：环境变量取私钥路径、以 & exit 结束', () => {
    withPlatform('win32', () => {
      const cmd = T.buildSshCommand({ shellName: 'cmd', host: 'h.example.com', port: 22, username: 'root', authMode: 'key', hostKeyPolicy: 'strict' })
      assert.match(cmd, /-i "%DSH_SSH_KEY_PATH%"/u)
      assert.match(cmd, /"StrictHostKeyChecking=yes"/u)
      assert.match(cmd, /"h\.example\.com" & exit$/u)
    })
  })

  test('PowerShell 引号：弯单引号同样成对转义', () => {
    assert.equal(T.psQuote("a'b"), "'a''b'")
    assert.equal(T.psQuote('C:\\Users\\O\u2019Brien\\ssh.exe'), "'C:\\Users\\O\u2019\u2019Brien\\ssh.exe'")
  })

  test('不再传 OpenSSH 8.5 才支持的 KnownHostsCommand（旧版 ssh 遇未知选项直接退出）', () => {
    for (const platform of ['win32', 'linux']) {
      withPlatform(platform, () => {
        const cmd = T.buildSshCommand({ shellName: 'powershell', host: 'h', port: 22, username: 'u', authMode: 'password', hostKeyPolicy: 'accept-new' })
        assert.doesNotMatch(cmd, /KnownHostsCommand/u)
        assert.match(cmd, /ProxyCommand=none/u)
        assert.match(cmd, /-F (?:NUL|\/dev\/null)/u)
      })
    }
  })

  test('远端非 POSIX（Windows OpenSSH 服务端）的报错可识别', () => {
    assert.equal(T.looksNonPosixRemote("'sh' is not recognized as an internal or external command,"), true)
    assert.equal(T.looksNonPosixRemote("'sh' 不是内部或外部命令，也不是可运行的程序"), true)
    assert.equal(T.looksNonPosixRemote('ls: cannot access'), false)
  })
})

// ---------------- 登录判定 ----------------

describe('登录判定', () => {
  function loginTerminal(transcript) {
    const writes = []
    return {
      writes,
      terminal: {
        id: 't-login',
        info: { state: 'running' },
        async drain() {},
        async write(data) { writes.push(data) },
      },
      mark: { lines: () => ({ lines: transcript.split('\n') }) },
    }
  }

  test('已认证后 MOTD 末行恰好是 "Password:" 时：判定成功，不写入任何凭据', async () => {
    const { terminal, mark, writes } = loginTerminal('Authenticated to h ([1.2.3.4]:22) using "publickey".\nWelcome\nReset your Password:')
    const out = await T.waitForConnection(terminal, { password: 'secret' }, mark)
    assert.equal(out.ok, true)
    assert.deepEqual(writes, [])
  })

  test('已认证后 Banner 含 "Permission denied" 字样不误报失败', async () => {
    const { terminal, mark } = loginTerminal('Authenticated to h ([1.2.3.4]:22) using "password".\nNotice: Permission denied for guests\n$ ')
    assert.equal((await T.waitForConnection(terminal, {}, mark)).ok, true)
  })

  test('未认证时的密码提示仍正常提交密码', async () => {
    const lines = ["root@h's password: "]
    const writes = []
    const terminal = {
      id: 't', info: { state: 'running' }, async drain() {},
      async write(data) { writes.push(data); lines.push('Authenticated to h ([1.2.3.4]:22) using "password".') },
    }
    const out = await T.waitForConnection(terminal, { password: 'pw' }, { lines: () => ({ lines }) })
    assert.equal(out.ok, true)
    assert.deepEqual(writes, ['pw\r'])
  })
})
