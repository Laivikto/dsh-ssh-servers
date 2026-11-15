/**
 * 文件浏览器测试：远端路径校验、find/ls 输出解析、类型映射。
 *
 * 运行：node --test tests/*.test.mjs
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { __test__ } from '../index.js'

const {
  normalizeRemotePath,
  parseFindOutput,
  parseLsOutput,
  typeToKind,
} = __test__

describe('远端路径校验', () => {
  test('合法的绝对路径', () => {
    assert.equal(normalizeRemotePath('/'), '/')
    assert.equal(normalizeRemotePath('/var/log'), '/var/log')
    assert.equal(normalizeRemotePath('/home/user/file.txt'), '/home/user/file.txt')
  })

  test('折叠重复斜杠', () => {
    assert.equal(normalizeRemotePath('/var//log///syslog'), '/var/log/syslog')
  })

  test('去掉结尾斜杠', () => {
    assert.equal(normalizeRemotePath('/var/log/'), '/var/log')
    assert.equal(normalizeRemotePath('///'), '/')
  })

  test('拒绝相对路径', () => {
    assert.equal(normalizeRemotePath('var/log'), undefined)
    assert.equal(normalizeRemotePath('./file'), undefined)
    assert.equal(normalizeRemotePath('../etc/passwd'), undefined)
  })

  test('拒绝注入字符', () => {
    assert.equal(normalizeRemotePath('/tmp\nrm -rf /'), undefined)
    assert.equal(normalizeRemotePath('/tmp\u0000etc'), undefined)
    assert.equal(normalizeRemotePath('/tmp\rfile'), undefined)
  })

  test('拒绝非字符串与超长路径', () => {
    assert.equal(normalizeRemotePath(null), undefined)
    assert.equal(normalizeRemotePath(123), undefined)
    assert.equal(normalizeRemotePath(''), undefined)
    assert.equal(normalizeRemotePath('/' + 'a'.repeat(5000)), undefined)
  })
})

describe('find 输出解析', () => {
  test('解析普通文件与目录', () => {
    const raw = ['__DSH_FS_BEGIN__', 'f\t1024\t1700000000\t644\tsyslog', 'd\t4096\t1699999999\t755\tnginx', 'l\t11\t1699999998\t777\taccess.log', '__DSH_FS_END__'].join('\n')
    const out = parseFindOutput(raw)
    assert.ok(Array.isArray(out))
    assert.equal(out.length, 3)
    assert.deepEqual(out[0], { name: 'syslog', type: 'file', size: 1024, mtimeMs: 1700000000000, mode: '644' })
    assert.equal(out[1].type, 'dir')
    assert.equal(out[2].type, 'link')
  })

  test('文件名含空格与制表符可还原', () => {
    const out = parseFindOutput(['__DSH_FS_BEGIN__', 'f\t10\t1700000000\t644\tmy file.txt', '__DSH_FS_END__'].join('\n'))
    assert.equal(out[0].name, 'my file.txt')
  })

  test('标记之间无内容返回空数组', () => {
    assert.deepEqual(parseFindOutput(['__DSH_FS_BEGIN__', '__DSH_FS_END__'].join('\n')), [])
  })

  test('没有标记时返回 null（命令未执行或输出被截断）', () => {
    assert.equal(parseFindOutput(''), null)
    assert.equal(parseFindOutput('total 48\ndrwxr-xr-x root root 4096'), null)
  })

  test('格式不符返回 null（触发回退）', () => {
    assert.equal(parseFindOutput('total 48\ndrwxr-xr-x 2 root root 4096'), null)
    assert.equal(parseFindOutput('garbage line'), null)
  })
})

describe('ls 输出解析', () => {
  test('解析标准 ls -la 输出', () => {
    const raw = [
      '__DSH_FS_BEGIN__',
      'total 48',
      '-rw-r--r-- 1 root root 1024 1700000000 syslog',
      'drwxr-xr-x 2 root root 4096 1699999999 nginx',
      'lrwxrwxrwx 1 root root 11 1699999998 access.log',
      '__DSH_FS_END__',
    ].join('\n')
    const out = parseLsOutput(raw)
    assert.ok(Array.isArray(out))
    assert.equal(out.length, 3)
    assert.equal(out[0].name, 'syslog')
    assert.equal(out[0].size, 1024)
    assert.equal(out[1].type, 'dir')
    assert.equal(out[2].type, 'link')
  })

  test('跳过 total 行', () => {
    const out = parseLsOutput('total 12')
    assert.equal(out, null)
  })

  test('无法解析时返回 null', () => {
    assert.equal(parseLsOutput('garbage'), null)
  })
})

describe('类型映射', () => {
  test('find 类型字符', () => {
    assert.equal(typeToKind('d'), 'dir')
    assert.equal(typeToKind('l'), 'link')
    assert.equal(typeToKind('-'), 'file')
    assert.equal(typeToKind('s'), 'other')
  })
})
