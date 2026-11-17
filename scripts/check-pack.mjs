/**
 * 发布内容检查：确认 npm 打包里必须有的文件都在、不该有的都没混进来。
 *
 * 为什么不用 shell：CI 在 ubuntu 与 windows 两种 runner 上跑，
 * bash 语法（for / grep）在 windows-latest 的 PowerShell 下会直接失败。
 * 这个脚本用 Node 实现，两个平台行为一致。
 *
 * 运行：node scripts/check-pack.mjs
 */
import { execFileSync } from 'node:child_process'

const REQUIRED = ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'package.json', 'LICENSE']
const FORBIDDEN = [
  { pattern: /^tests\//, reason: '测试目录' },
  { pattern: /^\.github\//, reason: 'CI 配置' },
  { pattern: /\.(pem|key|ppk)$/i, reason: '疑似私钥' },
  { pattern: /(^|\/)id_(rsa|ed25519|ecdsa)$/, reason: '疑似私钥' },
]

// Windows 上 npm 是 .cmd，需要经 cmd.exe 解析；POSIX 直接调用。
const isWindows = process.platform === 'win32'
const exec = isWindows
  ? [process.env.ComSpec ?? 'cmd.exe', ['/c', 'npm', 'pack', '--dry-run', '--json']]
  : ['npm', ['pack', '--dry-run', '--json']]
const raw = execFileSync(exec[0], exec[1], { encoding: 'utf8' })

// npm 12 的 `pack --json` 以包名为 key 返回对象；早期版本返回数组。两种都兼容。
const parsed = JSON.parse(raw)
const meta = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
if (!meta || !Array.isArray(meta.files)) {
  console.error('错误：无法解析 npm pack --json 的输出')
  process.exit(1)
}
const files = meta.files.map((f) => f.path.replace(/\\/g, '/')).sort()

console.log(`打包文件（${files.length} 个）：`)
for (const f of files) console.log('  ' + f)

const missing = REQUIRED.filter((f) => !files.includes(f))
if (missing.length > 0) {
  console.error(`\n错误：打包内容缺少必需文件：${missing.join(', ')}`)
  process.exit(1)
}

const bad = []
for (const f of files) {
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(f)) bad.push(`${f}（${rule.reason}）`)
  }
}
if (bad.length > 0) {
  console.error(`\n错误：打包内容包含不应发布的文件：${bad.join(', ')}`)
  process.exit(1)
}

console.log(`\n打包内容符合预期：${files.length} 个文件，${(meta.size / 1024).toFixed(1)} KB`)
