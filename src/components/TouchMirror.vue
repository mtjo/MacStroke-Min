<template>
  <view class="mirror-wrap">
    <view class="card board" :class="{ flush: landscape }">
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
      <button class="key mini" size="mini" @tap="turn">{{ landscape ? '竖屏' : '横屏' }}</button>
    </view>

    <!-- 横屏时竖向空间金贵：说明只在竖屏页给，横屏是从竖屏跳进来的。 -->
    <text class="tip" v-if="!landscape">轻点=左键，快速两下=双击，双指轻点=右键，单指拖=滚动，按住不动再拖=拖窗口，双指捏合=放大。</text>
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

const MODES = { SMOOTH: { width: 640, fps: 4, quality: 40 }, SHARP: { width: 1280, fps: 2, quality: 62 } }

function dist(a, b) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
}

function mid(a, b) {
  return { clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2 }
}

/**
 * 桌面回显 + 手指点按，竖屏 tab 页和横屏页共用这一份。
 *
 * 定位一律走 warp（主屏归一化坐标），所以这里只关心「手指这个点在画面上对应桌面的
 * 几分之几」，跟 Mac 的分辨率、帧图缩放比都没关系。
 *
 * 页面的显示/隐藏由外面转发进来（pageShow/pageHide）：自定义组件收不到页面的
 * onShow/onHide，而画面必须在离开时停掉，不然两台设备抢着推流。
 */
export default {
  name: 'TouchMirror',

  props: {
    landscape: { type: Boolean, default: false },
  },

  data() {
    return {
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

    /// 手指点 → 主屏归一化坐标（0…1），Mac 那边按自己的分辨率换算。
    /// 竖屏里桌面只占画布中间一条，上下都是黑边：点黑边不该算点到桌面边缘，
    /// 所以画面外直接返回 null，由调用方当成「没按」。
    normalized(touch) {
      const board = this.board
      const box = this.layout()
      const x = (touch.clientX - board.rect.left - box.x) / box.w
      const y = (touch.clientY - board.rect.top - box.y) / box.h
      if (x < 0 || x > 1 || y < 0 || y > 1) return null
      return { x, y }
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

    /// 微信没有运行时转屏的 API（pageOrientation 只能写在页面 json 里），所以「横屏」
    /// 是跳到那张声明了 landscape 的同款页面，「竖屏」再跳回来。
    turn() {
      if (this.landscape) {
        uni.navigateBack()
        return
      }
      uni.navigateTo({ url: '/pages/touch-land/touch-land' })
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

/* 横屏：竖向只有那么三两百像素，卡片内边距和圆角全去掉，画面直接铺到屏幕边。 */
.board.flush {
  padding: 0;
  margin-bottom: 0;
  border-radius: 0;
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
