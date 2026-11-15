/**
 * 回归测试：本次审计修复的缺陷。
 *
 * 覆盖点：
 * - find/ls 命令必须带起止标记（否则 parseFindOutput 永远返回 null）
 * - 空目录必须返回 []，不能当成解析失败
 * - ls 的 ACL/SELinux 权限标记（+ . ?）不能导致条目被丢弃
 * - 二进制/文本判定与 hex 视图
 * - 归一化路径的拒绝规则
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const mod = await import('../index.js')
const T = mod.__test__

// ============ 标记机制（P0-2 回归）============

test('parseFindOutput: 无标记时返回 null（命令未执行）', () => {
  const raw = 'f\t123\t1700000000.5\t644\tsomefile\n'
  assert.equal(T.parseFindOutput(raw), null)
})

test('parseFindOutput: 有标记的空结果 = 空目录', () => {
  const raw = '__DSH_FS_BEGIN__\n__DSH_FS_END__\n'
  const out = T.parseFindOutput(raw)
  assert.deepEqual(out, [])
})

test('parseFindOutput: 正常解析 5 列', () => {
  const raw = '__DSH_FS_BEGIN__\nf\t123\t1700000000.5\t644\ta.txt\nd\t4096\t1700000001\t755\tsub\n__DSH_FS_END__\n'
  const out = T.parseFindOutput(raw)
  assert.equal(out.length, 2)
  assert.equal(out[0].name, 'a.txt')
  assert.equal(out[0].type, 'file')
  assert.equal(out[1].type, 'dir')
})

test('parseLsOutput: 有标记的空目录返回 [] 而不是 null', () => {
  const raw = '__DSH_FS_BEGIN__\ntotal 0\n__DSH_FS_END__\n'
  const out = T.parseLsOutput(raw)
  assert.deepEqual(out, [])
})

test('parseLsOutput: 无标记且无条目返回 null', () => {
  assert.equal(T.parseLsOutput('total 0\n'), null)
})

test('parseLsOutput: 权限串带 ACL 标记 + 的条目不能被丢弃', () => {
  const raw = '__DSH_FS_BEGIN__\n-rw-r--r--+ 1 root root 10 1700000000 aclfile\n__DSH_FS_END__\n'
  const out = T.parseLsOutput(raw)
  assert.ok(out !== null, '应能解析')
  assert.equal(out.length, 1)
  assert.equal(out[0].name, 'aclfile')
})

test('parseLsOutput: SELinux . 标记同样可解析', () => {
  const raw = '__DSH_FS_BEGIN__\n-rw-r--r--. 1 root root 10 1700000000 selinuxfile\n__DSH_FS_END__\n'
  const out = T.parseLsOutput(raw)
  assert.equal(out?.[0]?.name, 'selinuxfile')
})

// ============ 预览内容判定 ============

test('looksTextual: 纯文本为真', () => {
  assert.equal(T.looksTextual(Buffer.from('hello world\n')), true)
})

test('looksTextual: 空文件视为文本', () => {
  assert.equal(T.looksTextual(Buffer.alloc(0)), true)
})

test('looksTextual: 含 NUL 判为二进制', () => {
  assert.equal(T.looksTextual(Buffer.from([0x7f, 0x45, 0x4c, 0x00, 0x01])), false)
})

test('looksTextual: 二进制 ELF 头判为二进制', () => {
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00])
  assert.equal(T.looksTextual(elf), false)
})

test('hexView: 输出偏移、十六进制与 ASCII 三栏', () => {
  const view = T.hexView(Buffer.from('ABC'), 16)
  assert.match(view, /^00000000\s/)
  assert.match(view, /\|ABC\|$/)
})

test('hexView: 遵守 maxBytes 上限', () => {
  const big = Buffer.alloc(100, 0x41)
  const view = T.hexView(big, 16)
  const lines = view.split('\n').filter((l) => l !== '')
  assert.equal(lines.length, 1, '16 字节只应产生一行')
})

test('hexView: 非打印字节显示为点', () => {
  const view = T.hexView(Buffer.from([0x00, 0xff]), 16)
  assert.match(view, /\|\.\.\|/)
})

// ============ 路径归一化（安全相关）============

test('normalizeRemotePath: 接受绝对路径', () => {
  assert.equal(T.normalizeRemotePath('/etc/passwd'), '/etc/passwd')
})

test('normalizeRemotePath: 折叠重复斜杠', () => {
  assert.equal(T.normalizeRemotePath('/a//b///c'), '/a/b/c')
})

test('normalizeRemotePath: 拒绝相对路径', () => {
  assert.equal(T.normalizeRemotePath('etc/passwd'), undefined)
})

test('normalizeRemotePath: 拒绝含换行/NUL 的路径', () => {
  assert.equal(T.normalizeRemotePath('/a\nb'), undefined)
  assert.equal(T.normalizeRemotePath('/a\0b'), undefined)
})

test('normalizeRemotePath: 去掉尾部斜杠', () => {
  assert.equal(T.normalizeRemotePath('/var/log/'), '/var/log')
})

// ============ 类型映射 ============

test('typeToKind: find 的 f 与 ls 的 - 都映射为 file', () => {
  assert.equal(T.typeToKind('f'), 'file')
  assert.equal(T.typeToKind('-'), 'file')
})

test('typeToKind: d/l 分别映射目录与链接', () => {
  assert.equal(T.typeToKind('d'), 'dir')
  assert.equal(T.typeToKind('l'), 'link')
})
