/**
 * 连接流程测试：认证等待、失败识别、工具守卫、命令捕获。
 *
 * 运行：node --test tests/  或  npm test
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { __test__ } from '../index.js'

const {
  waitForConnection,
  buildSshCommand,
  hasShellPrompt,
  loginFailure,
  runAndCapture,
  installToolGuard,
} = __test__

/** 构造一个可控的假终端，用于模拟 SSH 会话输出。 */
function fakeTerminal(initial, onWrite) {
  let transcript = initial
  let screen = initial
  return {
    id: 'terminal-test',
    info: { state: 'running', title: 'test' },
    get transcript() { return transcript },
    read() { return { text: screen } },
    async drain() {},
    mark() {
      return {
        lines() { return { lines: transcript.split('\n'), truncated: false } },
        dispose() {},
      }
    },
    async write(data) {
      if (onWrite) onWrite(data, (next) => { transcript += next; screen = transcript })
    },
    async close() {},
  }
}

describe('密码认证等待', () => {
  test('识别密码提示并写入密码，随后确认登录成功', async () => {
    const writes = []
    const terminal = fakeTerminal("root@host's password:", (data, append) => {
      writes.push(data)
      append('\nAuthenticated to host ([10.0.0.1]:22) using "password".\ndebug1: Entering interactive session.\nroot@host:~# ')
    })
    const result = await waitForConnection(terminal, { password: 'secret-not-logged' }, terminal.mark())

    assert.equal(result.ok, true)
    assert.equal(writes.length, 1)
    assert.equal(writes[0], 'secret-not-logged\r', '密码应原样写入终端')
  })

  test('缺少密码时给出明确要求，且不发送任何内容', async () => {
    let writes = 0
    const terminal = fakeTerminal("root@host's password:", () => { writes += 1 })
    const result = await waitForConnection(terminal, {}, terminal.mark())

    assert.equal(result.ok, false)
    assert.equal(result.code, 'password-required')
    assert.equal(writes, 0, '不应向终端写入任何内容')
  })
})

describe('连接失败识别', () => {
  test('连接被拒绝时不得误报成功', async () => {
    const terminal = fakeTerminal('debug1: Connecting...\nConnection refused\n')
    const result = await waitForConnection(terminal, { password: 'x' }, terminal.mark())

    assert.equal(result.ok, false)
    assert.equal(result.code, 'connection-refused')
    assert.match(result.message, /端口/u)
  })

  test('区分本地提示符与远端登录成功', () => {
    // 提示符检测本身会认出本地 PowerShell 提示符；必须结合登录标记才判定成功。
    assert.equal(hasShellPrompt('PS E:\\dsh file>'), true)
  })

  test('提取登录失败信息', () => {
    assert.equal(loginFailure('Connection refused'), 'Connection refused')
    assert.equal(loginFailure('Permission denied (password).'), 'Permission denied (password).')
  })

  test('SSH 退出后仍根据终端输出识别指纹变化', async () => {
    const terminal = fakeTerminal('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.')
    terminal.info.state = 'exited'
    const result = await waitForConnection(terminal, {}, terminal.mark())
    assert.equal(result.code, 'host-key-changed')
    assert.match(result.message, /核对新指纹/u)
  })

  test('严格校验缺少记录时提示核对并添加密钥', async () => {
    const terminal = fakeTerminal('No ED25519 host key is known for example.test and you have requested strict checking.\nHost key verification failed.')
    terminal.info.state = 'exited'
    const result = await waitForConnection(terminal, {}, terminal.mark())
    assert.equal(result.code, 'host-key-unknown')
    assert.match(result.message, /核对指纹/u)
  })

  test('命令发出后 SSH 断开会立即报告结果未知', async () => {
    const terminal = fakeTerminal('', (_data, append) => {
      append('\nConnection to test.example closed by remote host.\n')
      terminal.info.state = 'exited'
    })
    await assert.rejects(runAndCapture({ terminal }, 'pwd', undefined, { pollMs: 5 }), /命令结果未知/u)
  })
})

describe('SSH 命令构造（详细）', () => {
  const cmd = buildSshCommand({
    shellName: 'Windows PowerShell',
    host: 'server.example.com',
    port: 22,
    username: 'root',
    authMode: 'key',
    hostKeyPolicy: 'accept-new',
  })

  test('使用 VERBOSE 日志级别且以 ssh 开头', () => {
    // VERBOSE 保留 "Authenticated to" 供登录判定，但不打印私钥路径（debug1: Will attempt key）
    assert.match(cmd, /^(?:ssh|& '[^']+ssh\.exe'|"[^"]+ssh\.exe") -o LogLevel=VERBOSE /)
  })

  test('私钥路径不进命令', () => {
    // Windows 的 PowerShell 用 $env:，POSIX 直接用 $（这个断言以前只按 Windows 写，CI 的 Linux 任务因此一直失败）
    const expected = process.platform === 'win32'
      ? /-i "\$env:DSH_SSH_KEY_PATH"/
      : /-i "\$DSH_SSH_KEY_PATH"/
    assert.match(cmd, expected)
    assert.doesNotMatch(cmd, /id_ed25519/)
  })

  test('条件退出关闭本地 shell', () => {
    assert.match(cmd, /'server\.example\.com'; exit$/)
  })
})

describe('工具守卫', () => {
  test('允许 SSH 工具与联网，拦截本地工具', () => {
    let guard
    const result = installToolGuard({
      ctx: {
        tools: {
          guard(callback) { guard = callback; return () => { guard = undefined } },
        },
      },
    })

    assert.equal(typeof result, 'function')
    assert.equal(guard({ name: 'ssh_terminal_run' }), undefined, 'SSH 工具应放行')
    assert.equal(guard({ name: 'web_search' }), undefined, '联网工具应放行')
    assert.equal(guard({ name: 'ops_bash' }).info.code, 'local-tool-blocked', '本地 bash 应拦截')
    assert.equal(guard({ name: 'ops_read_files' }).info.code, 'local-tool-blocked', '本地读文件应拦截')

    result()
    assert.equal(guard, undefined, '卸载后守卫应清除')
  })
})

/**
 * 模拟交互式 POSIX shell：回显整行输入，执行用户命令，再按 printf '\n%s %s\n' 输出哨兵。
 * output 为用户命令的原始输出（可不以换行结尾，例如 printf abc）。
 */
function fakeShell({ output, exitCode = 0 }) {
  let transcript = 'root@host:~# '
  const writes = []
  const terminal = {
    id: 'run-test',
    info: { state: 'running', control: 'agent' },
    read() { return { text: transcript } },
    async drain() {},
    mark() {
      const base = transcript.length
      return {
        lines() { return { lines: transcript.slice(base).split('\n'), truncated: false } },
        dispose() {},
      }
    },
    async write(data) {
      writes.push(data)
      if (data === '\x03') { transcript += '^C\nroot@host:~# '; return }
      assert.equal(data.endsWith('\r'), true, '命令应以回车结尾')
      const line = data.replace(/\r$/, '')
      const m = /printf '\\n%s %s\\n' (__DSH_DONE_[0-9a-z_]+__) "\$\?"$/.exec(line)
      transcript += `${line}\n`
      if (m === null || output === null) return // 不认识的写法：模拟命令永不结束
      transcript += output
      transcript += `\n${m[1]} ${exitCode}\n`
      transcript += 'root@host:~# '
    },
  }
  return { terminal, writes }
}

describe('命令执行与输出捕获', () => {
  test('执行命令并通过哨兵行判定结束', async () => {
    const { terminal, writes } = fakeShell({ output: 'Linux dsh-test 6.1.0-test x86_64 GNU/Linux\n' })
    const output = await runAndCapture({ terminal }, 'uname -a', new AbortController().signal, { pollMs: 5 })
    assert.match(output.text, /Linux dsh-test 6\.1\.0-test/)
    assert.equal(output.exitCode, 0)
    // 哨兵（包括回显命令行里的哨兵后缀）不应出现在返回给模型的文本里
    assert.equal(output.text.includes('__DSH_DONE_'), false, '哨兵必须被剥离')
    assert.equal(output.text.includes('printf'), false, '回显中的哨兵后缀必须被剥离')
    assert.match(output.text, /^uname -a\n/, '保留用户命令本身的回显（不含哨兵后缀）')
    assert.match(writes[0], /^uname -a; printf '\\n%s %s\\n' __DSH_DONE_[0-9a-f]{8}_/, '命令应附带唯一哨兵')
  })

  test('非零退出码会体现在返回值里', async () => {
    const { terminal } = fakeShell({ output: 'ls: cannot access: No such file\n', exitCode: 2 })
    const output = await runAndCapture({ terminal }, 'ls /no/such/dir', new AbortController().signal, { pollMs: 5 })
    assert.equal(output.exitCode, 2)
  })

  test('回归：输出末尾没有换行（printf abc）也能立即判定完成', async () => {
    const { terminal } = fakeShell({ output: 'abc' })
    const started = Date.now()
    const output = await runAndCapture({ terminal }, 'printf abc', new AbortController().signal, { pollMs: 5, timeoutMs: 2000 })
    assert.equal(output.exitCode, 0)
    assert.match(output.text, /abc/)
    assert.ok(Date.now() - started < 1000, '不应等到超时')
  })

  test('回归：以 & 或 ; 结尾的命令不会拼出 "&;" / ";;" 语法错误', () => {
    const s = '__DSH_DONE_x__'
    assert.equal(__test__.buildRunLine('sleep 5 &', s), `sleep 5 & ${__test__.sentinelSuffix(s)}`)
    assert.equal(__test__.buildRunLine('cd /tmp;', s), `cd /tmp; ${__test__.sentinelSuffix(s)}`)
    assert.equal(__test__.buildRunLine('a && b', s), `a && b; ${__test__.sentinelSuffix(s)}`)
    assert.equal(__test__.buildRunLine('uptime   ', s), `uptime; ${__test__.sentinelSuffix(s)}`)
  })

  test('回归：超时后向远端发送 Ctrl+C，避免下一条命令被敲进仍在运行的程序', async () => {
    const { terminal, writes } = fakeShell({ output: null })
    await assert.rejects(
      runAndCapture({ terminal }, 'top', new AbortController().signal, { pollMs: 5, timeoutMs: 60 }),
      /Ctrl\+C/,
    )
    assert.equal(writes.at(-1), '\x03')
  })

  test('回归：取消时同样发送 Ctrl+C', async () => {
    const { terminal, writes } = fakeShell({ output: null })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    await assert.rejects(runAndCapture({ terminal }, 'sleep 100', controller.signal, { pollMs: 5, timeoutMs: 5000 }))
    assert.equal(writes.at(-1), '\x03')
  })

  test('回归：终端已由用户接管时给出重新连接的恢复方式，且不写入', async () => {
    const { terminal, writes } = fakeShell({ output: '' })
    terminal.info.control = 'user'
    await assert.rejects(runAndCapture({ terminal }, 'uptime', new AbortController().signal), /连接|Connect/)
    assert.equal(writes.length, 0)
  })
})
