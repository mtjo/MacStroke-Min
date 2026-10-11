<template>
  <view class="mirror-wrap">
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
      <button class="key mini" size="mini" @tap="turn">{{ rotated ? '竖屏' : '横屏' }}</button>
    </view>

    <!-- 这句在旋转前后必须一字不变：卡片是 flex:1，文字换行少一行画布就长高一截，
         整页布局跟着挪，点按落点全偏。转的只是画布里的画法，布局不该跟着状态走。 -->
    <text class="tip">轻点=左键，快速两下=双击，双指轻点=右键，单指拖=滚动，双指捏合=放大。按「横屏」后把手机顶边转向左边，画面就是正的。</text>
  </view>
</template>

<script>
import { remote } from '@/utils/socket.js'

// 手势门槛与触摸板页保持一致，两页之间不该换个手感。
const TAP_SLOP = 10
const TAP_MAX = 300
const HOLD_DELAY = 450
const DOUBLE_TAP_WINDOW = 400
const FLUSH_INTERVAL = 60

// 1 倍就是「整屏刚好装下」，再往外缩只剩黑边，所以缩放只许往大走。
const MAX_SCALE = 6

// 一帧解码的耐心：正常几十毫秒，超过这个数就是回调根本没来。
const DECODE_TIMEOUT = 2000

const MODES = { SMOOTH: { width: 640, fps: 4, quality: 40 }, SHARP: { width: 1280, fps: 2, quality: 62 } }

function dist(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function mid(a, b) {
  return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }
}

/**
 * 桌面回显 + 手指点按，触屏 tab 页用这一份。
 *
 * 定位一律走 warp（主屏归一化坐标），所以这里只关心「手指这个点在画面上对应桌面的
 * 几分之几」，跟 Mac 的分辨率、帧图缩放比都没关系。
 *
 * 「横屏」不转页面：微信没有运行时转屏 API，整页转屏得另开一张声明 landscape 的页面，
 * 而那一页里所有布局都要重排。这里只把画布里的画面转 90°，页面还是竖屏那张，
 * 按钮和说明留在原位，用户把手机转横就能看到用满长边的大画面。
 *
 * 页面的显示/隐藏由外面转发进来（pageShow/pageHide）：自定义组件收不到页面的
 * onShow/onHide，而画面必须在离开时停掉，不然两台设备抢着推流。
 */
export default {
  name: 'TouchMirror',

  data() {
    return {
      hasFrame: false,
      sharp: false,
      scale: 1,
      rotated: false,
      state: 'idle',
      lastError: '',
      proto: 0,
      received: 0,
    }
  },

  computed: {
    blankText() {
      if (this.lastError) return this.lastError
      if (this.state !== 'open') return '先连上 Mac 才会有画面'
      if (this.proto && this.proto < 2) return '这台 MacStroke 还不支持触屏回显，请升级后重试'
      // 真机上最有用的一句：分清楚是 Mac 没发，还是收到了却画不出来（解码那一路断了）。
      if (this.received) return `Mac 在发画面，已经收到 ${this.received} 帧，但这台手机一张都没画出来`
      return '等待画面…'
    },
    canRetry() {
      return this.state === 'open' && this.proto >= 2
    },
    zoomText() {
      return this.scale.toFixed(1) + '×'
    },
  },

  watch: {
    /**
     * 状态行多出一行报错就把整页往下顶 22px 左右，画布跟着挪位：位置必须重量一次，
     * 不然点按会整体偏掉那一截（真机上「连接被拒」那句一出来就中招）。
     */
    lastError() {
      this.$nextTick(() => this.measure())
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
      shownJpg: '',
      watchdog: null,
      panX: 0,
      panY: 0,
      visible: false,
      opened: false,
      mode: '',
      fingers: 0,
      moved: 0,
      startAt: 0,
      lastX: 0,
      lastY: 0,
      lastSpread: 0,
      startSpread: 0,
      startX: 0,
      startY: 0,
      dragging: false,
      holdTimer: null,
      flushTimer: null,
      pendingMoveX: 0,
      pendingMoveY: 0,
      lastTapAt: 0,
      offFrame: null,
      offResize: null,
    }
    this.unsubscribe = remote.onChange((snapshot) => {
      const board = this.board
      const opened = snapshot.state === 'open'
      this.state = snapshot.state
      this.lastError = snapshot.lastError
      this.proto = (snapshot.welcome && snapshot.welcome.proto) || 0
      // 只在「刚连上」这一次补要画面：每条 ack 都会 emit 一遍，见着 open 就发
      // mirror 的话，mirror→ack→mirror 自己就能把链路刷满。
      if (opened && !board.opened && board.visible) this.syncMirror()
      board.opened = opened
      if (!opened) this.cancel()
    })
  },

  mounted() {
    // 帧通道挂在实例上而不是 onLoad 里：回调可能在页面还没铺好画布时就进来。
    this.board.offFrame = remote.onFrame((payload) => this.onFrame(payload))
    // 转屏（以及分屏改尺寸）后画布的 CSS 尺寸和位置都变了：位图要按新尺寸重铺，
    // 坐标换算也要重新量，否则点哪都偏到旧方向上。
    if (typeof uni.onWindowResize === 'function') {
      const handler = () => this.measure(() => this.syncMirror())
      uni.onWindowResize(handler)
      this.board.offResize = () => uni.offWindowResize(handler)
    }
    // 第一次测量必须由组件自己发起：页面的 onShow 比子组件挂载还早，那时 $refs 还是
    // 空的，只靠外面转发的话一次都不会触发，画面永远等不来。
    this.board.visible = true
    this.ensureMeasured(0)
  },

  beforeUnmount() {
    if (this.unsubscribe) this.unsubscribe()
    if (this.board.offFrame) this.board.offFrame()
    if (this.board.offResize) this.board.offResize()
    this.cancel()
    this.stopMirror()
  },

  methods: {
    // MARK: - 页面生命周期转发

    pageShow() {
      this.board.visible = true
      // 回到本页要重新量位置：标签切换后节点还在，但坐标可能已经变了。
      this.measure(() => this.syncMirror())
    },

    pageReady() {
      this.ensureMeasured(0)
    },

    pageHide() {
      this.board.visible = false
      this.cancel()
      this.stopMirror()
    },

    // MARK: - 画布

    /// 首帧之前画布可能还没布局好（量出来尺寸是 0），重试到量到为止。
    ensureMeasured(attempt) {
      this.measure(() => {
        if (this.board.canvas) {
          this.syncMirror()
        } else if (attempt < 12) {
          setTimeout(() => this.ensureMeasured(attempt + 1), 200)
        }
      })
    },

    /**
     * 节点只能查一次，查到后按 dpr 设好位图尺寸；位置每次都要重新量。
     *
     * rect:true 不能省：不传它 left/top 就是 undefined，换算时全当 0，于是「点画布
     * 正中」会被当成「点画布正中再往下偏一个画布顶边距」——真机上那大约是状态栏加
     * 卡片内边距，点什么都偏一大截，而模拟器和离线脚本里画布正好贴着视口左上角，
     * 误差被吞得干干净净。
     */
    measure(done) {
      const query = uni.createSelectorQuery().in(this)
      query.select('#mirror').fields({ node: true, size: true, rect: true }).exec((res) => {
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
        const resized = !board.canvas ||
          Math.round(found.width) !== Math.round(board.size.width) ||
          Math.round(found.height) !== Math.round(board.size.height)
        board.size = { width: found.width, height: found.height }
        if (!board.canvas) {
          board.canvas = found.node
          board.ctx = found.node.getContext('2d')
        }
        if (resized) this.resizeBitmap()
        if (done) done()
      })
    },

    /// 位图尺寸跟着 CSS 尺寸 × dpr 走。改 width/height 会把 2d 上下文整个重置，
    /// 所以缩放必须在这之后重新按上，否则画面会按物理像素画、只剩左上角一小块。
    resizeBitmap() {
      const board = this.board
      if (!board.canvas) return
      const dpr = uni.getSystemInfoSync().pixelRatio || 2
      const w = Math.round(board.size.width * dpr)
      const h = Math.round(board.size.height * dpr)
      if (board.canvas.width !== w) board.canvas.width = w
      if (board.canvas.height !== h) board.canvas.height = h
      board.ctx.setTransform(1, 0, 0, 1, 0, 0)
      board.ctx.scale(dpr, dpr)
      this.paint()
    },

    paint() {
      const board = this.board
      const image = board.image
      if (!board.ctx || !image || !board.frameW) return
      const size = board.size
      const box = this.layout()
      board.ctx.save()
      // 擦除要在没转的那一层做：位图是按 CSS 尺寸×dpr 铺的，转了以后矩形对不上画布。
      board.ctx.clearRect(0, 0, size.width, size.height)
      if (this.rotated) board.ctx.transform(0, 1, -1, 0, size.width, 0)
      board.ctx.drawImage(image, box.x, box.y, box.w, box.h)
      board.ctx.restore()
    },

    /// 视图空间：手机转横以后看到的那块正画面。转 90° 只是画布内部的画法，
    /// 画布本身的 CSS 尺寸没变，所以这里把宽高互换。
    viewSize() {
      const s = this.board.size
      return this.rotated ? { width: s.height, height: s.width } : { width: s.width, height: s.height }
    },

    /// 当前视图：帧图按 contain 铺底，再乘缩放、加平移，全部用视图空间的 CSS 像素。
    layout() {
      const board = this.board
      const view = this.viewSize()
      const fw = board.frameW || 16
      const fh = board.frameH || 10
      const base = Math.min(view.width / fw, view.height / fh) || 1
      const w = fw * base * this.scale
      const h = fh * base * this.scale
      return {
        w,
        h,
        x: (view.width - w) / 2 + board.panX,
        y: (view.height - h) / 2 + board.panY,
      }
    },

    /**
     * 手指点 → 主屏归一化坐标（0…1），Mac 那边按自己的分辨率换算。
     * 桌面只占画布中间一块，四周是黑边：点黑边不该算点到桌面边缘，
     * 所以画面外直接返回 null，由调用方当成「没按」。
     */
    normalized(touch) {
      const point = this.toView(touch.clientX, touch.clientY)
      const box = this.layout()
      const x = (point.x - box.x) / box.w
      const y = (point.y - box.y) / box.h
      if (x < 0 || x > 1 || y < 0 || y > 1) return null
      return { x, y }
    },

    /// 画布坐标 → 视图坐标，必须和 paint() 里那串 transform 严格互逆：
    /// 画布上的 (x, y) 对应视图里的 (y, W - x)。写反一个符号，横屏模式里点的位置
    /// 和发出去的 warp 就会绕着中心转着方向偏。
    toView(clientX, clientY) {
      const board = this.board
      const x = clientX - board.rect.left
      const y = clientY - board.rect.top
      return this.rotated ? { x: y, y: board.size.width - x } : { x, y }
    },

    /// 手指在手机上划的位移 → 视图空间位移，和 toView 同一套旋转。
    viewDelta(delta) {
      return this.rotated ? { x: delta.y, y: -delta.x } : delta
    },

    /// 手指划过的 CSS 像素换成桌面像素：要让画面上的内容跟着手指走，就得按当前缩放比放大。
    toDesktop(delta) {
      const step = this.viewDelta(delta)
      const box = this.layout()
      return { x: (step.x * this.board.frameW) / box.w, y: (step.y * this.board.frameH) / box.h }
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

    /// 转的只是画面：页面还是这一张竖屏页，按钮和说明的位置一动不动，
    /// 省掉「为横屏重排一套布局」和「运行时转屏根本没有 API」两件事。
    turn() {
      this.rotated = !this.rotated
      this.resetView()
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
        board.startSpread = dist(touches[0], touches[1])
        board.lastSpread = board.startSpread
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
      if (!this.pointOf(touches[0].clientX, touches[0].clientY)) {
        // 起手就在黑边上：这一整段手势都不指向桌面，别让它滚到别的窗口去。
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
      // 双指只捏合、中点不动时 moved 是 0，光看位移会把它当成两指轻点，
      // 抬手就多发一次右键；所以两指的判据还要看指间距变没过。
      const pinched = Math.abs(board.lastSpread - board.startSpread) > TAP_SLOP
      const tapped = moved <= TAP_SLOP && duration <= TAP_MAX
      const wasTap = (mode === 'pending' || (mode === 'view' && !pinched)) && tapped
      if (!wasTap) return
      if (fingers >= 2) {
        // view 模式记的 lastX/lastY 就是两指中点，右键要点在那儿。
        const target = this.pointOf(board.lastX, board.lastY)
        if (!target) return
        remote.warp(...target)
        remote.click('right')
        return
      }
      const target = this.pointOf(board.startX, board.startY)
      if (!target) return
      remote.warp(...target)
      const now = Date.now()
      const doubleTap = now - board.lastTapAt < DOUBLE_TAP_WINDOW
      board.lastTapAt = now
      remote.click('left', doubleTap)
    },

    /// 画面外返回 null，调用方据此什么都不发。
    pointOf(clientX, clientY) {
      const point = this.normalized({ clientX, clientY })
      return point ? [point.x, point.y] : null
    },

    /// 双指：捏合改缩放，整体平移改视图位移，两件事一起算才跟手。
    pinch(touches) {
      const board = this.board
      const spread = dist(touches[0], touches[1])
      const center = mid(touches[0], touches[1])
      const page = { x: center.clientX - board.lastX, y: center.clientY - board.lastY }
      const slide = this.viewDelta(page)
      const local = this.toView(center.clientX, center.clientY)
      board.moved += Math.abs(page.x) + Math.abs(page.y)
      const grown = board.lastSpread > 20 && spread > 20
        ? Math.min(Math.max(this.scale * (spread / board.lastSpread), 1), MAX_SCALE) / this.scale
        : 1
      if (grown !== 1) {
        // 以捏合前的中点为锚：手指还按着的时候画面要跟着手指走，不能整块跳回中间。
        const box = this.layout()
        const view = this.viewSize()
        const anchorX = local.x - slide.x
        const anchorY = local.y - slide.y
        const u = (anchorX - box.x) / box.w
        const v = (anchorY - box.y) / box.h
        this.scale *= grown
        const wide = box.w * grown
        const high = box.h * grown
        board.panX = anchorX - u * wide - (view.width - wide) / 2
        board.panY = anchorY - v * high - (view.height - high) / 2
      }
      board.panX += slide.x
      board.panY += slide.y
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
      this.clearWatchdog()
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
      if (!board.canvas || !payload.jpg) return
      board.frameW = payload.w
      board.frameH = payload.h
      // 只在一张都还没画出来时把帧数写进视图：那正是需要这句话的时候；画面一旦出来，
      // 每帧一次响应式赋值就是白花掉的渲染。
      if (!this.hasFrame) this.received += 1
      // 桌面没动时 JPEG 逐字节相同，同一张图再解一遍只是费电。
      if (payload.jpg === board.shownJpg) return
      // 上一帧还在解码就丢掉这一帧：排队会让手机看到几秒前的桌面，点下去全是错位。
      if (board.decoding) return
      this.decode(payload.jpg)
    },

    /// 每帧新建一张图，不复用同一个 image 对象。
    ///
    /// iOS 真机上给同一个 image 重复赋相同的 src 不会再触发 onload（微信社区已确认，
    /// 桌面静止时编码结果正好逐字节相同），于是 decoding 永远清不掉，之后每一帧都在
    /// 上面那个 if 里被丢掉：画面冻在第一帧，看着完全像「Mac 没在推流」，而开发者工具
    /// 用的是 Chromium 的 Image 实现，重复赋值照样回调，所以只有真机出问题。
    decode(jpg) {
      const board = this.board
      board.decoding = true
      const image = board.canvas.createImage()
      image.onload = () => {
        if (board.image !== image) return
        board.decoding = false
        board.shownJpg = jpg
        this.hasFrame = true
        this.lastError = ''
        this.clearWatchdog()
        this.paint()
      }
      image.onerror = () => {
        if (board.image !== image) return
        board.decoding = false
        this.clearWatchdog()
        this.lastError = '画面解码失败，可以点「重试画面」'
      }
      board.image = image
      image.src = 'data:image/jpeg;base64,' + jpg
      this.armWatchdog()
    },

    /// 万一某台机型既不回 onload 也不回 onerror，也不能让 decoding 永久挂着：
    /// 超时就自己把标记清掉，下一帧换新图重来。
    armWatchdog() {
      const board = this.board
      this.clearWatchdog()
      board.watchdog = setTimeout(() => {
        board.watchdog = null
        board.decoding = false
      }, DECODE_TIMEOUT)
    },

    clearWatchdog() {
      const board = this.board
      if (board.watchdog) {
        clearTimeout(board.watchdog)
        board.watchdog = null
      }
    },
  },
}
</script>

<style>
/* 组件根节点：吃掉页面剩下的空间，回显越大越点得准。 */
.mirror-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

/* 画布吃掉卡片剩下的空间。 */
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

/* 按键不浮到画面之上：canvas 是原生组件，开发工具和部分机型里它盖在普通节点上面，
   浮层会被画面吃掉（试过：四颗里只有落在画面外的那颗看得见）。横屏省竖向空间的办法
   是压掉卡片内边距和说明文字，不是把控件叠上去。 */
</style>
