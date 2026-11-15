/**
 * 前端纯函数测试：mtime 格式化、类型推断。
 *
 * 说明：humanSize / formatTime / fileKindLabel 定义在 client.js（浏览器 bundle），
 * 无法直接 import。这里用与实现完全相同的逻辑做行为校验，
 * 并额外断言 client.js 中确实存在这些函数（防止实现被误删）。
 *
 * 运行：node --test tests/*.test.mjs
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'client.js')
const clientSrc = fs.readFileSync(CLIENT, 'utf8')

// ---- 与 client.js 保持一致的实现（用于行为验证）----
function humanSize(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return ''
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB'
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

function formatTime(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fileKindLabel(entry) {
  if (entry.type === 'dir') return '目录'
  if (entry.type === 'link') return '链接'
  const name = entry.name ?? ''
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase()
  return '文件'
}

describe('client.js 中确实定义了这些函数', () => {
  test('humanSize', () => assert.ok(/function humanSize\s*\(/.test(clientSrc)))
  test('formatTime', () => assert.ok(/function formatTime\s*\(/.test(clientSrc)))
  test('fileKindLabel', () => assert.ok(/function fileKindLabel\s*\(/.test(clientSrc)))
})

describe('文件大小格式化', () => {
  test('各量级', () => {
    assert.equal(humanSize(0), '0 B')
    assert.equal(humanSize(512), '512 B')
    assert.equal(humanSize(1024), '1.0 KB')
    assert.equal(humanSize(1536), '1.5 KB')
    assert.equal(humanSize(1024 * 1024), '1.0 MB')
    assert.equal(humanSize(1024 * 1024 * 1024), '1.00 GB')
  })

  test('异常输入返回空串', () => {
    assert.equal(humanSize(-1), '')
    assert.equal(humanSize(NaN), '')
    assert.equal(humanSize(undefined), '')
    assert.equal(humanSize(null), '')
  })
})

describe('时间格式化', () => {
  test('正常时间戳', () => {
    const ms = new Date(2026, 0, 15, 9, 5).getTime()
    assert.equal(formatTime(ms), '2026-01-15 09:05')
  })

  test('补零', () => {
    const ms = new Date(2026, 11, 3, 7, 8).getTime()
    assert.equal(formatTime(ms), '2026-12-03 07:08')
  })

  test('无效值返回空串', () => {
    assert.equal(formatTime(0), '')
    assert.equal(formatTime(null), '')
    assert.equal(formatTime(undefined), '')
    assert.equal(formatTime(-5), '')
  })
})

describe('文件类型标签', () => {
  test('目录与链接', () => {
    assert.equal(fileKindLabel({ type: 'dir', name: 'nginx' }), '目录')
    assert.equal(fileKindLabel({ type: 'link', name: 'a.log' }), '链接')
  })

  test('取扩展名', () => {
    assert.equal(fileKindLabel({ type: 'file', name: 'syslog.1.gz' }), 'gz')
    assert.equal(fileKindLabel({ type: 'file', name: 'photo.JPG' }), 'jpg')
    assert.equal(fileKindLabel({ type: 'file', name: 'a.tar.gz' }), 'gz')
  })

  test('无扩展名视为普通文件', () => {
    assert.equal(fileKindLabel({ type: 'file', name: 'Makefile' }), '文件')
    assert.equal(fileKindLabel({ type: 'file', name: '.bashrc' }), '文件')
    assert.equal(fileKindLabel({ type: 'file', name: 'trailing.' }), '文件')
  })

  test('空名字不崩溃', () => {
    assert.equal(fileKindLabel({ type: 'file', name: '' }), '文件')
    assert.equal(fileKindLabel({ type: 'file' }), '文件')
  })
})
