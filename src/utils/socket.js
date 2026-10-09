// 与 MacStroke 的 TCP 长连接。
//
// 三条来自微信侧的硬约束，决定了这里的写法：
// 1. 每 5 分钟最多创建 20 个 TCPSocket，所以重连必须退避，且失败到一定次数就停手
//    等人工点「重新连接」，不能无限快速重建。
// 2. 小程序切后台连接会被打断（onError 报 fail interrupted），所以回前台要主动重连。
// 3. onMessage 给的是 ArrayBuffer，一次回调可能是半条、也可能是两条拼在一起，
//    所以按换行切帧要在字节层面做，切出完整行之后再解码 UTF-8。
//
// 协议（对应 MacStroke 的 Sources/RemoteControl/RemoteCommand.swift）：一行一条 JSON。
//   发出 {"t":"hello","token":…,"name":…} / ping / move{dx,dy} / click{btn,double} / button{btn,down} / scroll{dx,dy}
//   收到 welcome / ack / error

const NEWLINE = 0x0a

// 退避到 20 秒为止：最坏情况 5 分钟内约 16 次重建，压在微信 20 个的额度里。
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 20000]

function decodeUTF8(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i += 1
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f))
      i += 2
    } else if (b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      )
      i += 3
    } else {
      let cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)
      cp -= 0x10000
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
      i += 4
    }
  }
  return out
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

function deviceName() {
  try {
    const info = uni.getSystemInfoSync()
    return [info.brand, info.model].filter(Boolean).join(' ') || 'Phone'
  } catch (e) {
    return 'Phone'
  }
}

/// uni 在微信小程序里就是把 wx 上的同名方法原样透出，包括 createTCPSocket；
/// 但基础库 2.18.0 之前没有这个方法，先探一下，免得报一个看不懂的错。
function createTCPSocket() {
  if (typeof uni === 'undefined' || typeof uni.createTCPSocket !== 'function') {
    throw new Error('当前微信基础库不支持 TCP（需要 2.18.0 及以上）')
  }
  return uni.createTCPSocket()
}

export class RemoteSocket {
  constructor() {
    this.target = null // { host, port, token }
    this.state = 'idle' // idle | connecting | open | closed
    this.lastError = ''
    this.welcome = null
    this.screen = null
    this.attempt = 0
    this.socket = null
    this.buffer = new Uint8Array(0)
    this.listeners = []
    this.reconnectTimer = null
    this.closingByHand = false
    this.refused = false
  }

  // MARK: - 订阅

  onChange(listener) {
    this.listeners.push(listener)
    listener(this.snapshot())
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index >= 0) this.listeners.splice(index, 1)
    }
  }

  snapshot() {
    return {
      state: this.state,
      lastError: this.lastError,
      target: this.target,
      welcome: this.welcome,
      screen: this.screen,
    }
  }

  emit() {
    const snapshot = this.snapshot()
    this.listeners.forEach((listener) => listener(snapshot))
  }

  // MARK: - 连接

  configure(target) {
    this.target = target
    this.save()
  }

  savedTarget() {
    const stored = uni.getStorageSync('macstroke.target')
    return stored && stored.host ? stored : null
  }

  save() {
    uni.setStorageSync('macstroke.target', this.target)
  }

  connect(target = this.target || this.savedTarget()) {
    if (!target || !target.host || !target.port || !target.token) {
      this.lastError = '还没有配对信息，请先扫码或手填地址'
      this.state = 'closed'
      this.emit()
      return
    }
    this.target = target
    this.closingByHand = false
    this.refused = false
    this.destroySocket()
    this.buffer = new Uint8Array(0)

    this.state = 'connecting'
    this.lastError = ''
    this.emit()

    let socket
    try {
      socket = createTCPSocket()
    } catch (error) {
      this.lastError = error.message
      this.state = 'closed'
      this.emit()
      return
    }
    this.socket = socket

    socket.onMessage(({ message }) => this.onBytes(message))
    socket.onConnect(() => {
      if (socket !== this.socket) return
      this.attempt = 0
      this.state = 'open'
      this.emit()
      this.sendRaw({ t: 'hello', token: this.target.token, name: deviceName() })
    })
    socket.onClose(() => this.onDropped(socket, '连接已被 Mac 关闭'))
    socket.onError((event) => {
      // onError 的载荷只有 errMsg（文档里没有 code），所以「连不上」只能靠这句话判。
      const msg = (event && event.errMsg) || ''
      const refused = /refused/i.test(msg)
      this.onDropped(socket, refused ? '连接被拒（Mac 上没开远程控制？）' : (msg || '网络中断'))
    })

    socket.connect({
      address: this.target.host,
      port: Number(this.target.port),
      timeout: 3000,
    })
  }

  reconnectNow() {
    this.attempt = 0
    this.connect()
  }

  close() {
    this.closingByHand = true
    this.clearTimer()
    this.destroySocket()
    this.state = 'closed'
    this.welcome = null
    this.screen = null
    this.emit()
  }

  /// 回到前台：微信这时已经把连接掐了，只有我们这边还显示 open。
  resume() {
    if (this.state === 'open') this.connect()
  }

  onDropped(socket, reason) {
    if (socket !== this.socket || this.closingByHand) return
    this.destroySocket()
    // Mac 拒过就用那句收尾，别再盖成「连接已被关闭」，也不要拿同一个错配对码
    // 反复重建连接——微信每 5 分钟只给 20 个 TCPSocket 额度。
    if (this.refused) {
      this.state = 'closed'
      this.emit()
      return
    }
    this.lastError = reason
    this.scheduleReconnect()
    this.emit()
  }

  scheduleReconnect() {
    const delays = RECONNECT_DELAYS
    if (this.attempt >= delays.length) {
      this.state = 'closed'
      this.lastError = '多次重连失败，请确认手机和 Mac 在同一个 Wi-Fi，然后手动重连'
      return
    }
    this.state = 'connecting'
    const delay = delays[this.attempt]
    this.attempt += 1
    this.clearTimer()
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  clearTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  destroySocket() {
    if (!this.socket) return
    const socket = this.socket
    this.socket = null
    try {
      socket.close()
    } catch (e) {
      // 已经断掉的连接再 close 会抛错，忽略即可。
    }
  }

  // MARK: - 收发

  onBytes(arrayBuffer) {
    this.buffer = concat(this.buffer, new Uint8Array(arrayBuffer))
    let index = this.buffer.indexOf(NEWLINE)
    while (index >= 0) {
      const line = this.buffer.subarray(0, index)
      this.buffer = this.buffer.subarray(index + 1)
      this.handleLine(decodeUTF8(line))
      index = this.buffer.indexOf(NEWLINE)
    }
  }

  handleLine(line) {
    if (!line) return
    let payload
    try {
      payload = JSON.parse(line)
    } catch (e) {
      return
    }
    if (payload.t === 'welcome') {
      this.welcome = payload
      this.screen = payload.screen || null
    } else if (payload.t === 'error') {
      this.lastError = payload.message || 'Mac 拒绝了这次请求'
      // 记下「Mac 明确拒过」：随后的关闭不该把这句盖掉，重连也只会重复同一个错误
      this.refused = true
    }
    this.emit()
  }

  sendRaw(payload) {
    if (!this.socket || this.state !== 'open') return false
    // write 收的是位置参数（string | ArrayBuffer），包成对象会被序列化成
    // "[object Object]" 发出去，Mac 那边只会当作非法行丢掉。
    this.socket.write(JSON.stringify(payload) + '\n')
    return true
  }

  move(dx, dy) {
    return this.sendRaw({ t: 'move', dx: Math.round(dx), dy: Math.round(dy) })
  }

  click(button, doubleClick = false) {
    return this.sendRaw({ t: 'click', btn: button, double: !!doubleClick })
  }

  hold(button, pressed) {
    return this.sendRaw({ t: 'button', btn: button, down: !!pressed })
  }

  // 双指滚动的位移按手指那侧的像素发，方向就是手指划的方向，翻不翻号由 Mac 定。
  scroll(dx, dy) {
    return this.sendRaw({ t: 'scroll', dx: Math.round(dx), dy: Math.round(dy) })
  }

  ping() {
    return this.sendRaw({ t: 'ping' })
  }
}

/// 全模块共享一条连接：页面来回切换不能各连各的，那既浪费额度也会互相抢鼠标。
export const remote = new RemoteSocket()
