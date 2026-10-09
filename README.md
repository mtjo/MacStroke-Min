# MacStroke 遥控（微信小程序端）

配合 [MacStroke-Swift](https://github.com/mtjo/MacStroke) 的「偏好设置 → 远程控制」页使用：
手机通过局域网 TCP 直连 Mac，控制光标移动与鼠标按键。

## 它是怎么连上的

MacStroke 在 Mac 上监听一个 TCP 端口（默认 8848），偏好页把「地址 + 端口 + 配对码」
编码成 `macstroke://pair?host=…&port=…&token=…` 的二维码。小程序扫码后拿到这三样，
用 `wx.createTCPSocket` 直连，第一包发 `hello` 验配对码，之后一行一条 JSON 发命令。

局域网内微信不要求合法域名、不要求 TLS —— 但**只允许连同网段地址**，所以这个小程序
没有服务器，也不需要部署任何东西。

## 运行到微信开发者工具

1. 装 [HBuilderX](https://www.dcloud.io/hbuilderx.html)（推荐，自带 uni-app 编译链），
   或用命令行：`npm install` 后 `npm run dev:mp-weixin`。
2. 导入本目录（HBuilderX：文件 → 导入 → 从本地目录）。
3. `src/manifest.json` → 微信小程序配置 → 填入自己的 AppID（没有就点「测试号」由工具生成）。
4. 运行 → 运行到小程序模拟器 → 微信开发者工具。
5. 开发者工具里务必勾选「详情 → 本地设置 → 不校验合法域名…」，否则连不上局域网地址。

真机预览要用**自己的** AppID（测试号不能真机预览），并且手机和 Mac 在同一个 Wi-Fi。

## 使用

1. Mac 上：偏好设置 → 远程控制 → 打开开关（会自动生成 6 位配对码），页面出现二维码。
2. 底部导航「我的」→ 扫描二维码 → 自动填好并连接；同一页还能手填地址、重新连接、断开。
3. 底部导航两个控制页：
   - **触摸板**：整块板子只有手势，不放按钮。单指滑=移动光标，单指轻点=左键，
     快速两下=双击，双指轻点=右键，双指滑动=滚动，按住不动再拖=拖拽。
   - **摇杆**：板上滑动只移动光标，点击靠下面的 左键 / 右键 / 中键 / 双击 按钮，
     「按住左键」用于拖拽：按住 → 移动 → 再点一次松开。

## 发布：打 tag 就自动传到微信后台

流水线在 `.github/workflows/mp-weixin.yml`：`npm run build:mp-weixin` 出产物，
再用官方 `miniprogram-ci` 传到小程序后台的「开发版本」。判据都在 `ci/upload.mjs` 里
（版本号形状、产物按 app.json 逐页点名、密钥长度、上传异常）。

一次性准备（都要在微信后台手点，只有管理员能做）：

1. https://mp.weixin.qq.com → 开发管理 → 开发设置 → 小程序代码上传：
   - 开启「小程序代码上传」，下载 `private.wx441afe8e18ebd358.key`。
   - **「IP 白名单」保持关闭** —— GitHub 构建机出口 IP 不固定，开了必被
     `-10008 invalid ip` 挡掉（本机实测命中过）。
2. 把密钥 base64 成一行，存进仓库 secret（名称必须是 `WX_UPLOAD_KEY_B64`）：
   ```bash
   base64 < ~/Downloads/private.wx441afe8e18ebd358.key | tr -d '\n' | pbcopy
   ```
   GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret。
3. 发版：
   ```bash
   git tag v1.0.1 && git push origin v1.0.1
   ```
   版本号会原样传到微信后台，所以形状必须是 `X.Y.Z`。手动补传在 Actions 页
   「Run workflow」，同一个入口可以填自定义描述。
4. 体验版仍要手点：后台 版本管理 → 开发版本 → 选为体验版（流水线到不了这一步）。

本地直接上传（不经过 CI）：

```bash
npm run build:mp-weixin
WX_UPLOAD_KEY_FILE=~/Downloads/private.wx441afe8e18ebd358.key \
  node ci/upload.mjs --version 1.0.1 --desc 手测
```

## 目录

- `src/utils/socket.js` — 长连接、字节层面按换行切帧、UTF-8 解码、退避重连。
- `src/utils/pairing.js` — 解析配对二维码。
- `src/utils/layout.js` — 自定义导航下第一块内容的顶部留白（按胶囊位置算）。
- `src/components/ControlPad.vue` — 手势引擎（`mode="track"` 触摸板 / `mode="pad"` 摇杆）。
- `src/components/StatusBar.vue` — 只读的连接状态行。
- `src/pages/index/index.vue` — 触摸板页（tab 1）。
- `src/pages/joystick/joystick.vue` — 摇杆页（tab 2）。
- `src/pages/mine/mine.vue` — 我的：连接状态 + 扫码/手填配对（tab 3）。
- `ci/upload.mjs` — 产物校验 + 上传微信后台，CI 和本地共用同一条路径。

## 已知限制（都来自微信侧，不是这里能绕的）

- **每 5 分钟最多创建 20 个 TCPSocket**，所以断线重连是退避的（1/2/4/8/15/20 秒），
  连续 6 次连不上就停手，等你在「我的」页点「重新连接」。
- **切后台连接会被掐断**（`fail interrupted`），回前台会自动重连。
- 端口不能选 1024 以下、8000–8100、3306/6379/3389/5432/8443/8888/9200/9300/27017 等，
  MacStroke 的偏好页已经把这些挡掉了。
- iPhone 上微信 7.0.18 之后 mDNS 发现不可用，所以地址要么扫码来、要么手填。

协议的服务端实现在 MacStroke-Swift 的 `Sources/RemoteControl/`。
