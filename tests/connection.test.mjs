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
    assert.equal(result.code, 'ssh-failed')
    assert.match(result.message, /Connection refused/)
  })

  test('区分本地提示符与远端登录成功', () => {
    // 提示符检测本身会认出本地 PowerShell 提示符；必须结合登录标记才判定成功。
    assert.equal(hasShellPrompt('PS E:\\dsh file>'), true)
  })

  test('提取登录失败信息', () => {
    assert.equal(loginFailure('Connection refused'), 'Connection refused')
    assert.equal(loginFailure('Permission denied (password).'), 'Permission denied (password).')
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

  test('启用 -v 且以 ssh 开头', () => {
    assert.match(cmd, /^ssh -v /)
  })

  test('私钥路径不进命令', () => {
    assert.match(cmd, /-i "\$env:DSH_SSH_KEY_PATH"/)
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

describe('命令执行与输出捕获', () => {
  test('执行命令并捕获远端输出', async () => {
    let transcript = ''
    const terminal = {
      id: 'run-test',
      info: { state: 'running' },
      read() { return { text: transcript } },
      async drain() {},
      mark() {
        const base = transcript
        return {
          lines() { return { lines: transcript.slice(base.length).split('\n'), truncated: false } },
          dispose() {},
        }
      },
      async write(data) {
        assert.equal(data.endsWith('\r'), true, '命令应以回车结尾')
        transcript += `root@host:~# ${data.trim()}\nLinux dsh-test 6.1.0-test x86_64 GNU/Linux\nroot@host:~# `
      },
    }
    const output = await runAndCapture({ terminal }, 'uname -a', new AbortController().signal)
    assert.match(output, /Linux dsh-test 6\.1\.0-test/)
  })
})
