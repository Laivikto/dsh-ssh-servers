/**
 * 新增功能测试：密钥文件识别、目录过滤排序、连接状态判定。
 * 直接测试 index.js 导出的真实实现，不复制逻辑。
 *
 * 运行：node --test tests/  或  npm test
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __test__ } from '../index.js'

const {
  classifyKeyFile,
  skipHiddenFile,
  sortKeyCandidates,
  looksDisconnected,
  mapConnectionState,
} = __test__

describe('密钥文件识别', () => {
  test('常见私钥文件名被识别', () => {
    for (const name of ['id_rsa', 'id_ed25519', 'id_ecdsa', 'laivikto.pem', 'server.key', 'my.ppk']) {
      assert.equal(classifyKeyFile(name), true, `${name} 应识别为私钥`)
    }
  })

  test('大小写不敏感', () => {
    assert.equal(classifyKeyFile('KEY.PEM'), true)
    assert.equal(classifyKeyFile('Id_RSA'), true)
  })

  test('公钥和普通文件不被识别', () => {
    for (const name of ['id_ed25519.pub', 'README.md', 'notes.txt', 'nginx.conf', '']) {
      assert.equal(classifyKeyFile(name), false, `${name} 不应识别为私钥`)
    }
  })

  test('含空格和括号的文件名正常处理', () => {
    assert.equal(classifyKeyFile('my key (1).pem'), true)
  })

  test('超长文件名不崩溃', () => {
    assert.equal(classifyKeyFile('a'.repeat(500) + '.pem'), true)
  })
})

describe('隐藏文件过滤', () => {
  test('普通隐藏文件被跳过', () => {
    for (const name of ['.git', '.env', '.bashrc', '.DS_Store']) {
      assert.equal(skipHiddenFile(name), true, `${name} 应被跳过`)
    }
  })

  test('形似私钥的隐藏文件被保留', () => {
    for (const name of ['.id_rsa', '.id_ed25519', '.key']) {
      assert.equal(skipHiddenFile(name), false, `${name} 应被保留`)
    }
  })

  test('非隐藏文件一律不过滤', () => {
    for (const name of ['laivikto.pem', 'notes.txt', 'id_rsa']) {
      assert.equal(skipHiddenFile(name), false)
    }
  })
})

describe('候选文件排序', () => {
  test('疑似私钥排在前面', () => {
    const input = [
      { name: 'notes.txt', likelyKey: false },
      { name: 'server.pem', likelyKey: true },
      { name: 'a.txt', likelyKey: false },
    ]
    assert.deepEqual(
      sortKeyCandidates(input).map((f) => f.name),
      ['server.pem', 'a.txt', 'notes.txt'],
    )
  })

  test('同类之间按名称排序', () => {
    const input = [
      { name: 'z.pem', likelyKey: true },
      { name: 'a.pem', likelyKey: true },
    ]
    assert.deepEqual(sortKeyCandidates(input).map((f) => f.name), ['a.pem', 'z.pem'])
  })

  test('不修改入参数组', () => {
    const input = [
      { name: 'b.txt', likelyKey: false },
      { name: 'a.pem', likelyKey: true },
    ]
    const before = input.map((f) => f.name)
    sortKeyCandidates(input)
    assert.deepEqual(input.map((f) => f.name), before)
  })
})

describe('SSH 断线文本判定', () => {
  test('识别各类断线信息', () => {
    const screens = [
      'Connection to 1.2.3.4 closed by remote host.',
      'Connection reset by 1.2.3.4 port 22',
      'client_loop: send disconnect: Broken pipe',
      'write: Broken pipe',
      'Disconnected from remote host',
    ]
    for (const s of screens) {
      assert.equal(looksDisconnected(s), true, `应识别: ${s}`)
    }
  })

  test('正常输出不误判', () => {
    const screens = [
      'root@VM:~# ',
      'total 48\ndrwxr-xr-x 2 root root 4096',
      '',
      'Welcome to Debian GNU/Linux 12',
    ]
    for (const s of screens) {
      assert.equal(looksDisconnected(s), false, `不应误判: ${s}`)
    }
  })
})

describe('连接状态映射', () => {
  test('alive 判定', () => {
    assert.equal(mapConnectionState({ alive: true, reason: 'alive' }), 'alive')
  })

  test('从未连接 / 终端已退出 -> idle', () => {
    assert.equal(mapConnectionState({ alive: false, reason: 'not-connected' }), 'idle')
    assert.equal(mapConnectionState({ alive: false, reason: 'terminal-exited' }), 'idle')
  })

  test('断线 / 未知原因 -> unresponsive', () => {
    assert.equal(mapConnectionState({ alive: false, reason: 'disconnected' }), 'unresponsive')
    assert.equal(mapConnectionState({ alive: false, reason: 'probe-failed' }), 'unresponsive')
    assert.equal(mapConnectionState({ alive: false, reason: 'weird' }), 'unresponsive')
  })

  test('异常输入安全降级', () => {
    assert.equal(mapConnectionState(null), 'unresponsive')
    assert.equal(mapConnectionState(undefined), 'unresponsive')
    assert.equal(mapConnectionState({}), 'unresponsive')
    assert.equal(mapConnectionState({ reason: 'disconnected' }), 'unresponsive')
  })
})

describe('真实文件系统：目录列举流程', () => {
  test('过滤隐藏文件、跳过子目录、私钥优先', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-test-'))
    try {
      writeFileSync(join(dir, 'laivikto.pem'), 'dummy')
      writeFileSync(join(dir, 'notes.txt'), 'dummy')
      writeFileSync(join(dir, 'id_rsa'), 'dummy')
      writeFileSync(join(dir, '.hidden'), 'dummy')
      mkdirSync(join(dir, 'subdir'))

      // 用真实的纯函数跑一遍分类流程（与 listKeyCandidates 内部一致）
      const files = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) continue
        if (skipHiddenFile(entry.name)) continue
        const full = join(dir, entry.name)
        files.push({
          name: entry.name,
          path: full,
          size: statSync(full).size,
          likelyKey: classifyKeyFile(entry.name),
        })
      }
      const names = sortKeyCandidates(files).map((f) => f.name)

      assert.ok(names.includes('laivikto.pem'))
      assert.ok(names.includes('notes.txt'))
      assert.ok(names.includes('id_rsa'))
      assert.ok(!names.includes('.hidden'), '.hidden 应被过滤')
      assert.ok(!names.includes('subdir'), 'subdir 应被跳过')
      assert.ok(
        names.indexOf('laivikto.pem') < names.indexOf('notes.txt'),
        '私钥应排在普通文件之前',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
