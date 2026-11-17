/**
 * 双语与文案一致性测试。
 *
 * 1. 后端 msg() 按请求语言返回对应文案，且并发请求互不串扰（AsyncLocalStorage）。
 * 2. client.js 内联的 zh/en 字典与 locale/*.json 的键集合保持同步，防止再次漂移。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { __test__ } from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const clientSrc = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

describe('后端双语消息', () => {
  test('中文上下文返回中文', async () => {
    await __test__.langStore.run('zh', async () => {
      assert.equal(__test__.msg('目录无效。', 'Invalid directory.'), '目录无效。')
    })
  })

  test('英文上下文返回英文', async () => {
    await __test__.langStore.run('en', async () => {
      assert.equal(__test__.msg('目录无效。', 'Invalid directory.'), 'Invalid directory.')
    })
  })

  test('没有语言上下文时回退中文', () => {
    assert.equal(__test__.msg('中文', 'English'), '中文')
  })

  test('并发请求的语言互不串扰', async () => {
    const results = await Promise.all([
      __test__.langStore.run('en', async () => {
        await new Promise((r) => setTimeout(r, 20))
        return __test__.msg('中文', 'English')
      }),
      __test__.langStore.run('zh', async () => {
        await new Promise((r) => setTimeout(r, 5))
        return __test__.msg('中文', 'English')
      }),
    ])
    assert.deepEqual(results, ['English', '中文'])
  })

  test('langOf 优先 body.lang，其次请求头', () => {
    assert.equal(__test__.langOf({ lang: 'en' }, { headers: {} }), 'en')
    assert.equal(__test__.langOf({}, { headers: { 'accept-language': 'en-US,en;q=0.9' } }), 'en')
    assert.equal(__test__.langOf({ lang: 'zh' }, { headers: { 'accept-language': 'en' } }), 'zh')
    assert.equal(__test__.langOf(null, { headers: {} }), 'zh')
  })
})

describe('文案三源一致性', () => {
  /** 从 client.js 里取出某个内联字典对象的键集合。 */
  function inlineKeys(name) {
    const lines = clientSrc.split('\n')
    const start = lines.findIndex((l) => new RegExp(`const ${name} = \\{`).test(l))
    assert.notEqual(start, -1, `client.js 里应有 const ${name} = {`)
    const keys = new Set()
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s{0,6}\}\s*$/.test(lines[i])) break
      const m = lines[i].match(/^\s+(\w+):/)
      if (m) keys.add(m[1])
    }
    return keys
  }

  const zhInline = inlineKeys('zh')
  const enInline = inlineKeys('en')
  const zhJson = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'locale/zh.json'), 'utf8'))))
  const enJson = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'locale/en.json'), 'utf8'))))

  test('内联 zh 与 en 的键完全一致', () => {
    assert.deepEqual([...zhInline].sort(), [...enInline].sort())
  })

  test('内联字典与 locale/zh.json 的键一致（meta 为 JSON 独有元信息）', () => {
    const jsonOnly = [...zhJson].filter((k) => !zhInline.has(k) && k !== 'meta')
    const inlineOnly = [...zhInline].filter((k) => !zhJson.has(k))
    assert.deepEqual(jsonOnly, [], `locale/zh.json 多出的键: ${jsonOnly.join(', ')}`)
    assert.deepEqual(inlineOnly, [], `内联 zh 多出的键: ${inlineOnly.join(', ')}`)
  })

  test('内联字典与 locale/en.json 的键一致（meta 为 JSON 独有元信息）', () => {
    const jsonOnly = [...enJson].filter((k) => !enInline.has(k) && k !== 'meta')
    const inlineOnly = [...enInline].filter((k) => !enJson.has(k))
    assert.deepEqual(jsonOnly, [], `locale/en.json 多出的键: ${jsonOnly.join(', ')}`)
    assert.deepEqual(inlineOnly, [], `内联 en 多出的键: ${inlineOnly.join(', ')}`)
  })
})
