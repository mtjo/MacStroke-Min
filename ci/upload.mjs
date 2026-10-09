#!/usr/bin/env node
// 把 uni-app 编译好的 dist/build/mp-weixin 传到微信后台的「开发版本」。
//
// 本地跑：
//   WX_UPLOAD_KEY_FILE=~/Downloads/private.wx441afe8e18ebd358.key node ci/upload.mjs --version 1.0.1 --desc 手测
// CI 跑：由 .github/workflows/mp-weixin.yml 在打 v* tag 时调用，密钥从 WX_UPLOAD_KEY_B64 注入。
//
// 判据的顺序照 SpeedEvent-Min 那条 CNB 流水线（https://cnb.cool/mtjo/SpeedEvent-Min）的教训排：
// 先排除坏（版本号形状、产物完整性、密钥长度），最后才是「上传真的走完了」。
// 那边栽过的坑是「编译失败的运行也会先写出几十个产物文件」，所以产物有新增不等于包是完整的。
// 这边比它简单：miniprogram-ci 是纯 Node 库，失败会 throw，不用去 grep 中文话术。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import ci from 'miniprogram-ci'

const args = parseArgs(process.argv.slice(2))
const PROJECT = args.project || 'dist/build/mp-weixin'
const VERSION = (args.version || '').replace(/^v/, '')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'dry-run') out[key] = true
    else {
      out[key] = argv[i + 1] ?? ''
      i += 1
    }
  }
  return out
}

// 前置校验失败也走异常，最后统一由 main 决定退出码——直接 process.exit 会吞掉管道里还没冲出去的日志。
function die(msg, hint) {
  const error = new Error(msg)
  error.hint = hint ?? ''
  error.preflight = true
  throw error
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// manifest.json 带 /* */ 注释（uni-app 允许），只能先剥掉再解析。
function readManifestAppid() {
  const file = 'src/manifest.json'
  if (!existsSync(file)) return null
  const stripped = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  try {
    return JSON.parse(stripped)['mp-weixin']?.appid ?? null
  } catch {
    die(`${file} 解析不过，去掉注释后仍不是合法 JSON`)
  }
}

function listFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(dir)
  return out
}

function checkArtifacts() {
  if (!existsSync(PROJECT)) {
    die(`找不到产物目录 ${PROJECT}`, '先跑 npm run build:mp-weixin')
  }
  const missing = []
  for (const f of ['app.js', 'app.json', 'project.config.json']) {
    if (!existsSync(join(PROJECT, f))) missing.push(f)
  }
  let appJson = null
  try {
    appJson = readJson(join(PROJECT, 'app.json'))
  } catch (error) {
    missing.push(`app.json 解析不过（${error.message}）`)
  }
  if (appJson) {
    for (const page of appJson.pages ?? []) {
      if (!existsSync(join(PROJECT, `${page}.js`))) missing.push(`${page}.js`)
      if (!existsSync(join(PROJECT, `${page}.wxml`))) missing.push(`${page}.wxml`)
    }
    for (const item of appJson.tabBar?.list ?? []) {
      for (const icon of [item.iconPath, item.selectedIconPath]) {
        if (icon && !existsSync(join(PROJECT, icon))) missing.push(icon)
      }
    }
  }
  const files = listFiles(PROJECT)
  if (missing.length) {
    die(`产物不是一套完整的包（缺 ${missing.length} 项）：${missing.slice(0, 8).join(' ')}`,
      '编译器没走完，微信后台也不会有这个版本')
  }
  // 本机对照：三段式导航的产物 34 个文件。给个下限，掉一半说明编译被截断。
  if (files.length < 20) die(`产物只有 ${files.length} 个文件，不像完整包`)
  console.log(`产物完整：${files.length} 个文件，页面 ${(appJson.pages ?? []).length} 个`)
  return { appJson, config: readJson(join(PROJECT, 'project.config.json')) }
}

function loadKey() {
  const b64 = process.env.WX_UPLOAD_KEY_B64
  const file = process.env.WX_UPLOAD_KEY_FILE
  let key
  if (b64) {
    key = Buffer.from(b64.replace(/\s/g, ''), 'base64')
  } else if (file) {
    const path = file.replace(/^~/, process.env.HOME)
    if (!existsSync(path)) die(`私钥文件不存在：${path}`)
    key = readFileSync(path)
  } else {
    die('没有上传密钥', 'CI 上配 secret WX_UPLOAD_KEY_B64；本地设 WX_UPLOAD_KEY_FILE 指向后台下载的 private.<appid>.key')
  }
  const text = key.toString('utf8')
  // base64 在后台复制时被截断只能靠长度露出来，所以报长度、不报内容。
  if (key.length < 200 || !text.includes('PRIVATE KEY')) {
    die(`密钥解码后只有 ${key.length} 字节、或不含 PRIVATE KEY 头，多半是 base64 被截断`,
      '重新生成一次：base64 -i private.<appid>.key | tr -d \'\\n\'')
  }
  const path = `/tmp/private.${process.pid}.key`
  writeFileSync(path, text, { mode: 0o600 })
  console.log(`密钥已落盘 /tmp（长度=${key.length}，内容不打印）`)
  return path
}

async function main() {
  let code = 0
  try {
    await run()
  } catch (error) {
    reportError(error)
    code = 1
  }
  finish(code)
}

// miniprogram-ci 的 summer-compiler 会留下子进程和未关的句柄，事件循环不会自己空掉：
// 实测假密钥那次报错之后进程又活了 1 分钟不退，CI 上就是挂到 GitHub 的 6 小时超时。
// 所以必须显式退出，但先等 stdout 冲干净（管道写入是异步的，直接 exit 会吞掉日志）。
function finish(code) {
  let done = false
  const bye = () => {
    if (done) return
    done = true
    process.exit(code)
  }
  process.stdout.write('', bye)
  setTimeout(bye, 5000)
}

async function run() {
  if (!/^\d+\.\d+\.\d+$/.test(VERSION)) {
    die(`版本号形状要是 X.Y.Z，当前是「${VERSION || '（空）'}」`, '这个号会原样传到微信后台')
  }
  const { config } = checkArtifacts()
  const appid = config.appid
  if (!/^wx[0-9a-f]{16}$/.test(appid ?? '')) die(`产物里的 appid 不合法：${appid}`)
  const manifestAppid = readManifestAppid()
  if (manifestAppid && manifestAppid !== appid) {
    die(`manifest.json 的 appid（${manifestAppid}）与产物 project.config.json（${appid}）不一致`,
      '产物是旧的，重新编译')
  }
  console.log(`appid=${appid} 版本=${VERSION}`)

  const keyPath = loadKey()
  try {
    const project = new ci.Project({
      appid,
      type: 'miniProgram',
      projectPath: PROJECT,
      privateKeyPath: keyPath,
      ignores: ['node_modules/**/*'],
    })
    if (args['dry-run']) {
      console.log('dry-run：校验全过，没有上传')
      return
    }
    const desc = args.desc || process.env.MP_DESC || defaultDesc()
    const t0 = Date.now()
    const result = await ci.upload({
      project,
      version: VERSION,
      desc,
      onProgressUpdate: (task) => {
        const line = typeof task === 'string' ? task : task?._msg ?? task?.message ?? ''
        if (line) console.log(`  ${String(line).slice(0, 120)}`)
      },
    })
    const size = result?.subPackageInfo?.reduce((sum, p) => sum + (p.size ?? 0), 0)
    console.log(`✓ 已上传到微信后台：版本=${VERSION} 包体=${size ? (size / 1024).toFixed(1) : '?'}KB 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s`)
    console.log('  体验版要在小程序后台手点「选为体验版」，流水线到不了那一步。')
  } finally {
    rmSync(keyPath, { force: true })
  }
}

function defaultDesc() {
  const ref = process.env.GITHUB_REF_NAME
  const sha = (process.env.GITHUB_SHA ?? '').slice(0, 8)
  if (ref) return `GitHub Actions ${ref}${sha ? ` (${sha})` : ''}`
  return '本地上传'
}

function reportError(error) {
  // 自己那批前置校验：话已经写好了，原样打出来
  if (error?.hint !== undefined || error?.preflight) {
    console.error(`✗ ${error.message}`)
    if (error.hint) console.error(`  → ${error.hint}`)
    return
  }
  const msg = [error?.errMsg, error?.message, error?.msg].filter(Boolean).join(' | ')
  const code = error?.errCode ?? error?.code ?? ''
  console.error(`✗ 上传失败${code ? `（code=${code}）` : ''}：${msg || JSON.stringify(error)?.slice(0, 300)}`)
  if (/invalid ip|-10008/i.test(msg)) {
    console.error('  → 小程序后台「开发管理 → 开发设置 → 小程序代码上传」里的 IP 白名单要保持关闭：CI 出口 IP 不固定')
  } else if (/private key|密钥|invalid appid|40125|86002/i.test(msg)) {
    console.error('  → 密钥与 appid 不匹配，或后台没开启「小程序代码上传」；重新下载密钥再 base64 一次')
  }
}

await main()
