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
2. 小程序「配对设置」→ 扫描二维码 → 自动填好并连接；控制页顶部会显示「已连接」。
3. 控制页：
   - 上方大方块是摇杆区，手指滑动即移动光标（约 2.6 倍速）。
   - 左键 / 右键 / 中键 / 双击 各一个按钮。
   - 「按住左键」用于拖拽：按住 → 摇杆移动 → 再点一次松开。

## 已知限制（都来自微信侧，不是这里能绕的）

- **每 5 分钟最多创建 20 个 TCPSocket**，所以断线重连是退避的（1/2/4/8/15/20 秒），
  连续 6 次连不上就停手，等你在控制页点「重新连接」。
- **切后台连接会被掐断**（`fail interrupted`），回前台会自动重连。
- 端口不能选 1024 以下、8000–8100、3306/6379/3389/5432/8443/8888/9200/9300/27017 等，
  MacStroke 的偏好页已经把这些挡掉了。
- iPhone 上微信 7.0.18 之后 mDNS 发现不可用，所以地址要么扫码来、要么手填。

## 目录

- `src/utils/socket.js` — 长连接、字节层面按换行切帧、UTF-8 解码、退避重连。
- `src/utils/pairing.js` — 解析配对二维码。
- `src/pages/index/index.vue` — 控制页。
- `src/pages/settings/settings.vue` — 扫码 / 手填配对信息。

协议的服务端实现在 MacStroke-Swift 的 `Sources/RemoteControl/`。
