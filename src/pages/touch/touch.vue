<template>
  <view class="screen" :style="{ paddingTop: headTop + 'px' }">
    <status-bar />
    <view class="card board">
      <canvas
        type="2d"
        id="mirror"
        class="mirror"
        @touchstart="onStart"
        @touchmove="onMove"
        @touchend="onEnd"
        @touchcancel="onEnd"
      ></canvas>
      <view class="blank" v-if="!hasFrame">
        <text class="blank-text">{{ blankText }}</text>
        <button class="mini" size="mini" v-if="canRetry" @tap="retry">重试画面</button>
      </view>
      <text class="zoom" v-if="hasFrame && scale > 1.01">{{ zoomText }}</text>
    </view>

    <view class="tools">
      <button class="key mini" size="mini" :class="{ held: !sharp }" @tap="pick(false)">流畅</button>
      <button class="key mini" size="mini" :class="{ held: sharp }" @tap="pick(true)">清晰</button>
      <button class="key mini" size="mini" @tap="resetView">还原视图</button>
    </view>

    <text class="tip">轻点=左键，快速两下=双击，双指轻点=右键，单指拖=滚动，按住不动再拖=拖窗口，双指捏合=放大。</text>
  </view>
</template>

<script>
import StatusBar from '@/components/StatusBar.vue'
import { remote } from '@/utils/socket.js'
import { measureHeadTop } from '@/utils/layout.js'

// 手势门槛与触摸板页保持一致，两页之间不该换个手感。
const TAP_SLOP = 10
const TAP_MAX = 300
const HOLD_DELAY = 450
const DOUBLE_TAP_WINDOW = 400
const FLUSH_INTERVAL = 60

// 1 倍就是「整屏刚好装下」，再往外缩只剩黑边，所以缩放只许往大走。
const MAX_SCALE = 6

const MODES = { SMOOTH: { width: 640, fps: 4, quality: 40 }, SHARP: { width: 1280, fps: 2, quality: 62 } }

function dist(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function mid(a, b) {
  return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }
}

/**
 * 触屏页：Mac 桌面回显在画布上，手指直接点在哪就是哪。
 *
 * 定位一律走 warp（主屏归一化坐标），所以这里只关心「手指这个点在画面上对应桌面的
 * 几分之几」，跟 Mac 的分辨率、帧图缩放比都没关系。
 */
export default {
  components: { StatusBar },

  data() {
    return {
      headTop: 20,
      hasFrame: false,
      sharp: false,
      scale: 1,
      state: 'idle',
      lastError: '',
      proto: 0,
    }
  },

  computed: {
    blankText() {
      if (this.lastError) return this.lastError
      if (this.state !== 'open') return '先连上 Mac 才会有画面'
      if (this.proto && this.proto < 2) return '这台 MacStroke 还不支持触屏回显，请升级后重试'
      return '等待画面…'
    },
    canRetry() {
      return this.state === 'open' && this.proto >= 2
    },
    zoomText() {
      return this.scale.toFixed(1) + '×'
    },
  },

  created() {
    // 画布节点、解码中的图、视图位移这些都不该进 data：Vue 的响应式代理套上原生
    // canvas 节点会让小程序端的绘制调用失效，而且每帧重渲染也没意义。
    this.board = {
      canvas: null,
      ctx: null,
      image: null,
      size: { width: 0, height: 0 },
      rect: { left: 0, top: 0 },
      frameW: 0,
      frameH: 0,
      decoding: false,
      panX: 0,
      panY: 0,
      visible: false,
      mode: '',
      fingers: 0,
      moved: 0,
      startAt: 0,
      lastX: 0,
      lastY: 0,
      lastSpread: 0,
      startX: 0,
      startY: 0,
      dragging: false,
      holdTimer: null,
      flushTimer: null,
      pendingMoveX: 0,
      pendingMoveY: 0,
      lastTapAt: 0,
      offFrame: null,
    }
    this.unsubscribe = remote.onChange((snapshot) => {
      this.state = snapshot.state
      this.lastError = snapshot.lastError
      this.proto = (snapshot.welcome && snapshot.welcome.proto) || 0
      // 连接一活过来就把回显要回来：页面开着却没有画面，比什么都像坏了。
      if (snapshot.state === 'open' && this.board.visible) this.syncMirror()
      if (snapshot.state !== 'open') this.cancel()
    })
  },

  onLoad() {
    this.headTop = measureHeadTop()
    if (remote.savedTarget()) remote.connect()
  },

  onShow() {
    this.board.visible = true
    // 首次进来画布还没布局好（onShow 早于 onReady），那一次交给 onReady 量；
    // 之后每次回到本页只重新量位置——标签切换后回来，节点还在但坐标可能变。
    if (this.board.canvas) this.measure(() => this.syncMirror())
  },

  onReady() {
    this.measure(() => this.syncMirror())
  },

  onHide() {
    this.board.visible = false
    this.cancel()
    this.stopMirror()
  },

  mounted() {
    // 帧通道挂在实例上而不是 onLoad 里：回调可能在页面还没铺好画布时就进来。
    this.board.offFrame = remote.onFrame((payload) => this.onFrame(payload))
  },

  beforeUnmount() {
    if (this.unsubscribe) this.unsubscribe()
    if (this.board && this.board.offFrame) this.board.offFrame()
    this.cancel()
    this.stopMirror()
  },

  methods: {
    // MARK: - 画布

    /// 节点只能查一次，查到后按 dpr 设好位图尺寸；回调里再量一次位置给坐标换算用。
    measure(done) {
      const query = uni.createSelectorQuery().in(this)
      query.select('#mirror').fields({ node: true, size: true }).exec((res) => {
        const found = res && res[0]
        if (!found || !found.node) {
          if (done) done()
          return
        }
        const board = this.board
        if (!found.width || !found.height) {
          // 还没布局好：别把 0 写进尺寸，否则换算全是 NaN。
          if (done) done()
          return
        }
        board.rect = { left: found.left || 0, top: found.top || 0 }
        board.size = { width: found.width, height: found.height }
        if (!board.canvas) {
          board.canvas = found.node
          board.ctx = found.node.getContext('2d')
          const dpr = uni.getSystemInfoSync().pixelRatio || 2
          found.node.width = Math.round(found.width * dpr)
          found.node.height = Math.round(found.height * dpr)
          board.ctx.scale(dpr, dpr)
          board.image = found.node.createImage()
          board.image.onload = () => {
            board.decoding = false
            this.hasFrame = true
            this.lastError = ''
            this.paint()
          }
          board.image.onerror = () => {
            board.decoding = false
            this.lastError = '画面解码失败，可以点「重试画面」'
          }
        }
        if (done) done()
      })
    },

    paint() {
      const board = this.board
      const image = board.image
      if (!board.ctx || !image || !board.frameW) return
      const box = this.layout()
      board.ctx.clearRect(0, 0, board.size.width, board.size.height)
      board.ctx.drawImage(image, box.x, box.y, box.w, box.h)
    },

    /// 当前视图：帧图按 contain 铺底，再乘缩放、加平移，全部用 CSS 像素。
    layout() {
      const board = this.board
      const fw = board.frameW || 16
      const fh = board.frameH || 10
      const base = Math.min(board.size.width / fw, board.size.height / fh) || 1
      const w = fw * base * this.scale
      const h = fh * base * this.scale
      return {
        w,
        h,
        x: (board.size.width - w) / 2 + board.panX,
        y: (board.size.height - h) / 2 + board.panY,
      }
    },

    /// 手指点 → 主屏归一化坐标（0…1）：Mac 那边按自己的分辨率换算。
    normalized(touch) {
      const board = this.board
      const box = this.layout()
      const x = (touch.clientX - board.rect.left - box.x) / box.w
      const y = (touch.clientY - board.rect.top - box.y) / box.h
      return { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) }
    },

    /// 手指划过的 CSS 像素换成桌面像素：要让画面上的内容跟着手指走，就得按当前缩放比放大。
    toDesktop(delta) {
      const box = this.layout()
      return { x: (delta.x * this.board.frameW) / box.w, y: (delta.y * this.board.frameH) / box.h }
    },

    // MARK: - 回显开关

    syncMirror() {
      if (this.proto && this.proto < 2) return
      remote.mirror(true, this.sharp ? MODES.SHARP : MODES.SMOOTH)
    },

    stopMirror() {
      remote.mirror(false)
    },

    retry() {
      this.lastError = ''
      this.measure(() => this.syncMirror())
    },

    pick(sharp) {
      this.sharp = sharp
      this.syncMirror()
    },

    resetView() {
      this.board.panX = 0
      this.board.panY = 0
      this.scale = 1
      this.paint()
    },

    // MARK: - 手势

    onStart(event) {
      const touches = event.touches
      const board = this.board
      if (!touches || !touches.length) return
      board.startAt = Date.now()
      board.moved = 0
      if (touches.length >= 2) {
        // 第二根手指落下就只是本地视图的事（捏合、平移）：先把按住的键放开，
        // 不然拖到一半变缩放，Mac 那边还按着左键跟着手指跑。
        this.releaseHold()
        this.clearHoldTimer()
        board.mode = 'view'
        board.fingers = 2
        const center = mid(touches[0], touches[1])
        board.lastSpread = dist(touches[0], touches[1])
        board.lastX = center.clientX
        board.lastY = center.clientY
        return
      }
      board.lastX = touches[0].clientX
      board.lastY = touches[0].clientY
      if (board.mode) {
        board.fingers = touches.length
        return
      }
      board.mode = 'pending'
      board.fingers = 1
      board.startX = touches[0].clientX
      board.startY = touches[0].clientY
      this.armHoldTimer()
    },

    onMove(event) {
      const touches = event.touches
      const board = this.board
      if (!board.mode || !touches || !touches.length) return

      if (board.mode === 'view') {
        if (touches.length >= 2) this.pinch(touches)
        return
      }

      const dx = touches[0].clientX - board.lastX
      const dy = touches[0].clientY - board.lastY
      board.lastX = touches[0].clientX
      board.lastY = touches[0].clientY
      board.moved += Math.abs(dx) + Math.abs(dy)

      if (board.mode === 'pending' && board.moved > TAP_SLOP) {
        // 单指拖动是「滚这台 Mac 的内容」：先把指针挪到起手那个点，
        // 滚轮事件只作用于指针底下的窗口，不 warp 就会滚到别家窗口上。
        board.mode = 'scroll'
        this.clearHoldTimer()
        remote.warp(...this.pointOf(board.startX, board.startY))
      }
      if (board.mode === 'scroll' || board.mode === 'drag') {
        const step = this.toDesktop({ x: dx, y: dy })
        board.pendingMoveX += step.x
        board.pendingMoveY += step.y
        this.scheduleFlush()
      }
    },

    onEnd(event) {
      const board = this.board
      const remaining = event.touches ? event.touches.length : 0
      if (remaining > 0) {
        board.fingers = remaining
        if (board.mode === 'view' && remaining >= 2) {
          board.lastSpread = dist(event.touches[0], event.touches[1])
        }
        return
      }
      const mode = board.mode
      const fingers = board.fingers
      const moved = board.moved
      const duration = Date.now() - board.startAt
      this.clearHoldTimer()
      this.stopFlush()
      this.flush()
      board.mode = ''
      board.fingers = 0
      board.moved = 0

      if (mode === 'drag') {
        this.releaseHold()
        return
      }
      const wasTap = (mode === 'pending' || mode === 'view') &&
        moved <= TAP_SLOP && duration <= TAP_MAX
      if (!wasTap) return
      if (fingers >= 2) {
        // view 模式记的 lastX/lastY 就是两指中点，右键要点在那儿。
        remote.warp(...this.pointOf(board.lastX, board.lastY))
        remote.click('right')
        return
      }
      remote.warp(...this.pointOf(board.startX, board.startY))
      const now = Date.now()
      const doubleTap = now - board.lastTapAt < DOUBLE_TAP_WINDOW
      board.lastTapAt = now
      remote.click('left', doubleTap)
    },

    pointOf(clientX, clientY) {
      const point = this.normalized({ clientX, clientY })
      return [point.x, point.y]
    },

    /// 双指：捏合改缩放，整体平移改视图位移，两件事一起算才跟手。
    pinch(touches) {
      const board = this.board
      const spread = dist(touches[0], touches[1])
      const center = mid(touches[0], touches[1])
      const dx = center.clientX - board.lastX
      const dy = center.clientY - board.lastY
      board.moved += Math.abs(dx) + Math.abs(dy)
      const grown = board.lastSpread > 20 && spread > 20
        ? Math.min(Math.max(this.scale * (spread / board.lastSpread), 1), MAX_SCALE) / this.scale
        : 1
      if (grown !== 1) {
        // 以捏合前的中点为锚：手指还按着的时候画面要跟着手指走，不能整块跳回中间。
        const box = this.layout()
        const localX = center.clientX - dx - board.rect.left
        const localY = center.clientY - dy - board.rect.top
        const u = (localX - box.x) / box.w
        const v = (localY - box.y) / box.h
        this.scale *= grown
        const wide = box.w * grown
        const high = box.h * grown
        board.panX = localX - u * wide - (board.size.width - wide) / 2
        board.panY = localY - v * high - (board.size.height - high) / 2
      }
      board.panX += dx
      board.panY += dy
      board.lastSpread = spread
      board.lastX = center.clientX
      board.lastY = center.clientY
      this.paint()
    },

    armHoldTimer() {
      this.clearHoldTimer()
      this.board.holdTimer = setTimeout(() => {
        this.board.holdTimer = null
        const board = this.board
        if (board.mode !== 'pending' || board.fingers !== 1) return
        // 按着不动到点了：这就是要拖窗口，先把左键按住，之后的移动就是拖。
        board.mode = 'drag'
        board.dragging = true
        remote.warp(...this.pointOf(board.startX, board.startY))
        remote.hold('left', true)
      }, HOLD_DELAY)
    },

    clearHoldTimer() {
      if (this.board.holdTimer) {
        clearTimeout(this.board.holdTimer)
        this.board.holdTimer = null
      }
    },

    releaseHold() {
      if (!this.board.dragging) return
      this.board.dragging = false
      remote.hold('left', false)
    },

    /// 页面切走、掉线时调用：手指可能还「按着」，不补松开 Mac 会一直停在拖拽里。
    cancel() {
      this.releaseHold()
      this.clearHoldTimer()
      this.stopFlush()
      this.board.mode = ''
      this.board.fingers = 0
      this.board.moved = 0
    },

    // MARK: - 发包

    scheduleFlush() {
      if (this.board.flushTimer) return
      this.board.flushTimer = setTimeout(() => {
        this.board.flushTimer = null
        this.flush()
      }, FLUSH_INTERVAL)
    },

    stopFlush() {
      if (this.board.flushTimer) {
        clearTimeout(this.board.flushTimer)
        this.board.flushTimer = null
      }
    },

    /// 取整发出，零头留在累加器里：每次都四舍五入会把小位移一点点吃掉。
    flush() {
      const board = this.board
      const x = Math.round(board.pendingMoveX)
      const y = Math.round(board.pendingMoveY)
      board.pendingMoveX -= x
      board.pendingMoveY -= y
      if (!x && !y) return
      if (board.mode === 'drag') remote.move(x, y)
      else remote.scroll(x, y)
    },

    // MARK: - 帧

    onFrame(payload) {
      const board = this.board
      if (!board.image || !payload.jpg) return
      board.frameW = payload.w
      board.frameH = payload.h
      // 上一帧还在解码就丢掉这一帧：排队会让手机看到几秒前的桌面，点下去全是错位。
      if (board.decoding) return
      board.decoding = true
      board.image.src = 'data:image/jpeg;base64,' + payload.jpg
    },
  },
}
</script>

<style>
/* 画布吃掉整屏剩下的空间：回显越大越点得准。 */
.board {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
}

.mirror {
  width: 100%;
  height: 100%;
}

.blank {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.blank-text {
  font-size: 26rpx;
  color: #8e8e93;
  text-align: center;
  padding: 0 40rpx;
  margin-bottom: 20rpx;
}

/* 缩放倍数只在放大时出现，1× 时不该占地方。 */
.zoom {
  position: absolute;
  right: 16rpx;
  top: 16rpx;
  font-size: 22rpx;
  color: #ffffff;
  background: rgba(0, 0, 0, 0.45);
  border-radius: 10rpx;
  padding: 4rpx 12rpx;
}

.tools {
  display: flex;
  margin-bottom: 8rpx;
}
</style>
