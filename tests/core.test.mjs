/**
 * 核心纯函数测试：主机/端口/密钥路径规范化、SSH 命令构造、提示符识别。
 *
 * 运行：node --test tests/  或  npm test
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { __test__, apply } from '../index.js'

const {
  buildSshCommand,
  bindingOf,
  sameBinding,
  normalizeHost,
  normalizePort,
  normalizeKeyPath,
  hasShellPrompt,
  loginFailure,
  recordKey,
} = __test__

describe('主机规范化', () => {
  test('IPv6 原样保留', () => {
    assert.equal(normalizeHost('2001:db8::1'), '2001:db8::1')
  })

  test('域名原样保留', () => {
    assert.equal(normalizeHost('server.example.com'), 'server.example.com')
  })

  test('拒绝注入与非法主机', () => {
    assert.equal(normalizeHost('bad host; rm -rf /'), undefined)
    assert.equal(normalizeHost(''), undefined)
  })
})

describe('端口规范化', () => {
  test('合法端口', () => {
    assert.equal(normalizePort('22'), 22)
    assert.equal(normalizePort('65535'), 65535)
  })

  test('越界与非法端口被拒绝', () => {
    assert.equal(normalizePort('0'), undefined)
    assert.equal(normalizePort('65536'), undefined)
    assert.equal(normalizePort('abc'), undefined)
  })
})

describe('私钥路径规范化', () => {
  test('绝对路径通过', () => {
    assert.ok(normalizeKeyPath('C:\\Users\\me\\.ssh\\id_ed25519'))
  })

  test('相对路径被拒绝', () => {
    assert.equal(normalizeKeyPath('relative/key'), undefined)
  })
})

describe('SSH 命令构造', () => {
  const params = {
    shellName: 'Windows PowerShell',
    host: 'server.example.com',
    port: 22,
    username: 'root',
    authMode: 'key',
    hostKeyPolicy: 'accept-new',
  }

  test('以 ssh 开头', () => {
    assert.match(buildSshCommand(params), /^ssh /)
  })

  test('私钥通过环境变量传递，不出现在命令中', () => {
    const cmd = buildSshCommand(params)
    // Windows 的 PowerShell 用 $env:，POSIX 直接用 $
    const expected = process.platform === 'win32'
      ? /-i "\$env:DSH_SSH_KEY_PATH"/
      : /-i "\$DSH_SSH_KEY_PATH"/
    assert.match(cmd, expected)
    assert.doesNotMatch(cmd, /id_ed25519/)
  })

  test('末尾包含 exit 以关闭本地 shell', () => {
    assert.match(buildSshCommand(params), /'server\.example\.com'; exit$/)
  })
})

describe('Shell 提示符识别', () => {
  test('识别常见提示符', () => {
    assert.equal(hasShellPrompt('Welcome\nroot@host:~# '), true)
    assert.equal(hasShellPrompt('root@host:~$ '), true)
  })

  test('不把密码提示和错误当提示符', () => {
    assert.equal(hasShellPrompt("root@host's password:"), false)
    assert.equal(hasShellPrompt('Permission denied (publickey).'), false)
  })
})

describe('登录失败识别', () => {
  test('提取失败信息', () => {
    assert.equal(loginFailure('Permission denied (publickey).'), 'Permission denied (publickey).')
  })
})

describe('凭据绑定', () => {
  test('记录键格式正确', () => {
    assert.equal(recordKey('h-123'), 'ssh-servers/h-123')
  })

  test('端口字符串与数字视为同一绑定', () => {
    const a = bindingOf({ host: 'server.example.com', port: '22', username: 'root', authMode: 'key' })
    const b = bindingOf({ host: 'server.example.com', port: 22, username: 'root', authMode: 'key' })
    assert.equal(sameBinding(a, b), true)
  })

  test('目标不同则绑定不匹配', () => {
    const a = bindingOf({ host: 'server.example.com', port: '22', username: 'root', authMode: 'key' })
    const b = bindingOf({ host: 'server.example.com', port: 22, username: 'root', authMode: 'key' })
    assert.equal(sameBinding(a, { ...b, host: 'other.example.com' }), false)
  })
})

describe('插件入口', () => {
  test('apply 是函数', () => {
    assert.equal(typeof apply, 'function')
  })
})
