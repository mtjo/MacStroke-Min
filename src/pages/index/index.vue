<template>
  <view class="page" :style="{ paddingTop: headTop + 'px' }">
    <view class="card status">
      <view class="row head">
        <text class="dot" :class="stateClass"></text>
        <text class="state">{{ stateText }}</text>
        <text class="addr" v-if="target">{{ target.host }}:{{ target.port }}</text>
      </view>
      <text class="error" v-if="lastError">{{ lastError }}</text>
      <view class="row actions">
        <button class="mini" size="mini" @tap="reconnect">重新连接</button>
        <button class="mini" size="mini" @tap="disconnect">断开</button>
        <button class="mini" size="mini" @tap="goSettings">配对设置</button>
      </view>
    </view>

    <view class="card pad-card">
      <view class="modes">
        <text class="mode" :class="{ on: mode === 'track' }" @tap="switchMode('track')">触摸板</text>
        <text class="mode" :class="{ on: mode === 'pad' }" @tap="switchMode('pad')">摇杆</text>
      </view>
      <text class="label">{{ padLabel }}</text>
      <view
        class="pad"
        :class="{ live: padLive, dragging: tpDragging }"
        @touchstart="onPadStart"
        @touchmove="onPadMove"
        @touchend="onPadEnd"
        @touchcancel="onPadEnd"
      >
        <text class="pad-hint">{{ padHint }}</text>
      </view>
    </view>

    <view class="card">
      <text class="label">按键</text>
      <view class="keys">
        <button class="key" :disabled="!ready" @tap="click('left')">左键</button>
        <button class="key" :disabled="!ready" @tap="click('right')">右键</button>
        <button class="key" :disabled="!ready" @tap="click('middle')">中键</button>
        <button class="key" :disabled="!ready" @tap="click('left', true)">双击</button>
      </view>
      <view class="keys">
        <button class="key wide" :disabled="!ready" :class="{ held }" @tap="toggleHold">
          {{ held ? '松开左键（结束拖拽）' : '按住左键（开始拖拽）' }}
        </button>
      </view>
      <text class="tip">{{ modeTip }}</text>
    </view>
  </view>
</template>

<script>
import { remote } from '@/utils/socket.js'

// 手指位移到光标位移的倍率：1 倍太慢，5 倍一滑就飞出屏幕。
const PAD_GAIN = 2.6
// 双指滚动的倍率：滚动按像素算，1 倍时一指划到底只挪一小段，看着发涩。
const SCROLL_GAIN = 1.6
// 摇杆发包间隔：再密也只是浪费带宽，Mac 那边按帧消费。
const PAD_INTERVAL = 60

// 触摸板的手势门槛：划出这么多点就算「拖」而不是「点」，单位是 rpx 换算前的点。
const TAP_SLOP = 10
// 轻点的最长时长：超过它就不当点击（那是用户在犹豫，不是要点）。
const TAP_MAX = 300
// 按住不动到判定为拖拽的等待：比手指自然抬起慢，又足够快能接住「按住再拖」。
const HOLD_DELAY = 450
// 两次单指轻点间隔小于它就当双击：第一次的点击已经发出去了，这跟真触摸板一致。
const DOUBLE_TAP_WINDOW = 400

// 多点手势按手指中点算位移：两根手指各走各的，中点才是用户眼里的「滑动方向」。
function midOf(touches) {
  let x = 0
  let y = 0
  for (let i = 0; i < touches.length; i += 1) {
    x += touches[i].pageX
    y += touches[i].pageY
  }
  return { x: x / touches.length, y: y / touches.length }
}

// 自定义导航后页面顶到屏幕最上沿，第一张卡要让开状态栏和右上角那颗胶囊；
// 胶囊位置各机型差很多，只能问系统要，拿不到就退回状态栏高度。
function measureHeadTop() {
  const statusBar = uni.getSystemInfoSync().statusBarHeight || 20
  const capsule =
    typeof uni.getMenuButtonBoundingClientRect === 'function' ? uni.getMenuButtonBoundingClientRect() : null
  return capsule && capsule.top ? capsule.top : statusBar
}

export default {
  data() {
    return {
      state: 'idle',
      lastError: '',
      target: null,
      mode: 'track',
      held: false,
      padLive: false,
      headTop: 20,
      originX: 0,
      originY: 0,
      pendingMoveX: 0,
      pendingMoveY: 0,
      pendingScrollX: 0,
      pendingScrollY: 0,
      flushTimer: null,
      unsubscribe: null,
      // 触摸板手势的进行状态：'' | pending | pointer | scroll | drag
      tpMode: '',
      tpFingers: 0,
      tpMoved: 0,
      tpStartAt: 0,
      tpLastX: 0,
      tpLastY: 0,
      tpDragging: false,
      dragTimer: null,
      lastTapAt: 0,
    }
  },

  computed: {
    ready() {
      return this.state === 'open'
    },
    stateText() {
      if (this.state === 'open') return '已连接'
      if (this.state === 'connecting') return '连接中…'
      return '未连接'
    },
    stateClass() {
      return this.state === 'open' ? 'on' : this.state === 'connecting' ? 'wait' : 'off'
    },
    padLabel() {
      return this.mode === 'pad' ? '摇杆区（手指滑动即移动光标）' : '触摸板区'
    },
    padHint() {
      if (this.tpDragging) return '拖拽中，抬手即松开'
      if (this.mode === 'pad') return this.padLive ? '移动中' : '按住这里滑动'
      return this.padLive ? '操作中' : '单指滑动移动光标'
    },
    modeTip() {
      return this.mode === 'pad'
        ? '拖文件/框选：先按「按住左键」，用摇杆移动，再按「松开」。'
        : '单指轻点=左键，快速两下=双击，双指轻点=右键，双指滑动=滚动，按住不动再拖=拖拽。'
    },
  },

  onLoad() {
    this.headTop = measureHeadTop()
    const saved = uni.getStorageSync('macstroke.padMode')
    if (saved === 'pad' || saved === 'track') this.mode = saved
    this.unsubscribe = remote.onChange((snapshot) => {
      this.state = snapshot.state
      this.lastError = snapshot.lastError
      this.target = snapshot.target
      // 掉线时 Mac 会自己补一个松开，按钮状态要跟着回落，否则重连后显示
      // 「按住中」而 Mac 其实早就松了，再点一下才会真的按下。
      if (snapshot.state !== 'open' && this.held) this.held = false
      if (snapshot.state !== 'open') this.resetGesture()
    })
    if (remote.savedTarget()) remote.connect()
  },

  onShow() {
    remote.resume()
  },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe()
    this.stopFlush()
    this.clearDragTimer()
    // 页面切走时手指可能还「按着」，不补松开 Mac 会一直停在拖拽里。
    if (this.tpDragging) remote.hold('left', false)
    // 连接本身不关：切到设置页再回来还要用同一条，重建连接要占微信的额度。
  },

  methods: {
    reconnect() {
      remote.reconnectNow()
    },

    disconnect() {
      this.held = false
      if (this.tpDragging) remote.hold('left', false)
      this.resetGesture()
      remote.close()
    },

    switchMode(mode) {
      if (this.mode === mode) return
      this.resetGesture()
      this.mode = mode
      uni.setStorageSync('macstroke.padMode', mode)
    },

    goSettings() {
      uni.navigateTo({ url: '/pages/settings/settings' })
    },

    click(button, doubleClick) {
      remote.click(button, doubleClick)
    },

    toggleHold() {
      this.held = !this.held
      remote.hold('left', this.held)
    },

    onPadStart(event) {
      if (this.mode === 'pad') this.padStart(event)
      else this.trackStart(event)
    },

    onPadMove(event) {
      if (this.mode === 'pad') this.padMove(event)
      else this.trackMove(event)
    },

    onPadEnd(event) {
      if (this.mode === 'pad') this.padEnd(event)
      else this.trackEnd(event)
    },

    // MARK: - 摇杆

    padStart(event) {
      const touch = event.touches[0]
      if (!touch) return
      this.originX = touch.pageX
      this.originY = touch.pageY
      this.padLive = true
    },

    padMove(event) {
      const touch = event.touches[0]
      if (!touch) return
      this.pendingMoveX += (touch.pageX - this.originX) * PAD_GAIN
      this.pendingMoveY += (touch.pageY - this.originY) * PAD_GAIN
      this.originX = touch.pageX
      this.originY = touch.pageY
      this.scheduleFlush()
    },

    padEnd() {
      this.padLive = false
      this.flush()
      this.stopFlush()
    },

    // MARK: - 触摸板

    trackStart(event) {
      const count = event.touches.length
      if (!count) return
      this.padLive = true
      if (!this.tpMode) {
        this.tpMode = 'pending'
        this.tpStartAt = Date.now()
        this.tpMoved = 0
        this.tpFingers = count
        this.armDragTimer()
      } else {
        this.tpFingers = Math.max(this.tpFingers, count)
        this.clearDragTimer()
        if (this.tpFingers >= 2 && this.tpMode !== 'drag') {
          // 第二根手指落下就是双指意图：先把刚才那段移动发出去，免得混进滚动。
          this.flush()
          this.tpMode = 'scroll'
        }
      }
      const mid = midOf(event.touches)
      this.tpLastX = mid.x
      this.tpLastY = mid.y
    },

    trackMove(event) {
      if (!this.tpMode || !event.touches.length) return
      const mid = midOf(event.touches)
      const dx = mid.x - this.tpLastX
      const dy = mid.y - this.tpLastY
      this.tpLastX = mid.x
      this.tpLastY = mid.y
      this.tpMoved += Math.abs(dx) + Math.abs(dy)

      if (this.tpMode === 'pending' && this.tpMoved > TAP_SLOP) {
        // 两指同时落下时 touchstart 里就是两根手指，不会再有「第二根手指抬起」那次
        // 事件，所以滚动意图要在这里认，不能只等 trackStart 的加分支。
        this.tpMode = this.tpFingers >= 2 ? 'scroll' : 'pointer'
        this.clearDragTimer()
      }
      if (this.tpMode === 'scroll') {
        this.pendingScrollX += dx * SCROLL_GAIN
        this.pendingScrollY += dy * SCROLL_GAIN
      } else if (this.tpMode === 'pointer' || this.tpMode === 'drag') {
        this.pendingMoveX += dx * PAD_GAIN
        this.pendingMoveY += dy * PAD_GAIN
      }
      this.scheduleFlush()
    },

    trackEnd(event) {
      const remaining = event.touches ? event.touches.length : 0
      if (remaining > 0) {
        // 双指里先抬一根：剩下的手指继续当同一个手势，中点要重新锚定。
        const mid = midOf(event.touches)
        this.tpLastX = mid.x
        this.tpLastY = mid.y
        this.tpFingers = remaining
        if (this.tpMode === 'scroll') this.tpMode = 'pointer'
        return
      }
      this.flush()
      this.stopFlush()
      this.clearDragTimer()
      this.padLive = false

      const mode = this.tpMode
      const fingers = this.tpFingers
      const duration = Date.now() - this.tpStartAt
      const isTap = (mode === 'pending' || mode === 'scroll') &&
        this.tpMoved <= TAP_SLOP && duration <= TAP_MAX
      this.tpMode = ''
      this.tpFingers = 0

      if (mode === 'drag') {
        this.tpDragging = false
        remote.hold('left', false)
        return
      }
      if (!isTap) return
      if (fingers >= 2) {
        remote.click('right')
        return
      }
      const now = Date.now()
      const doubleTap = now - this.lastTapAt < DOUBLE_TAP_WINDOW
      this.lastTapAt = now
      remote.click('left', doubleTap)
    },

    armDragTimer() {
      this.clearDragTimer()
      this.dragTimer = setTimeout(() => {
        this.dragTimer = null
        // 一根手指按着不动到点了：当作要拖拽，先把左键按住，之后的移动就是拖。
        if (this.tpMode === 'pending' && this.tpFingers === 1) {
          this.tpMode = 'drag'
          this.tpDragging = true
          remote.hold('left', true)
        }
      }, HOLD_DELAY)
    },

    clearDragTimer() {
      if (this.dragTimer) {
        clearTimeout(this.dragTimer)
        this.dragTimer = null
      }
    },

    resetGesture() {
      this.clearDragTimer()
      this.tpMode = ''
      this.tpFingers = 0
      this.tpMoved = 0
      this.tpDragging = false
      this.padLive = false
    },

    // MARK: - 发包

    scheduleFlush() {
      if (this.flushTimer) return
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.flush()
      }, PAD_INTERVAL)
    },

    stopFlush() {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer)
        this.flushTimer = null
      }
    },

    // 取整发出，零头留在累加器里：每次都四舍五入会把小位移一点点吃掉。
    flush() {
      const moveX = Math.round(this.pendingMoveX)
      const moveY = Math.round(this.pendingMoveY)
      this.pendingMoveX -= moveX
      this.pendingMoveY -= moveY
      if (moveX || moveY) remote.move(moveX, moveY)

      const scrollX = Math.round(this.pendingScrollX)
      const scrollY = Math.round(this.pendingScrollY)
      this.pendingScrollX -= scrollX
      this.pendingScrollY -= scrollY
      if (scrollX || scrollY) remote.scroll(scrollX, scrollY)
    },
  },
}
</script>

<style>
.page {
  box-sizing: border-box;
  height: 100vh;
  padding: 24rpx;
  padding-bottom: calc(24rpx + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
}

.card {
  background: #ffffff;
  border-radius: 20rpx;
  padding: 24rpx;
  margin-bottom: 24rpx;
}

.card:last-child {
  margin-bottom: 0;
}

.pad-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 触摸板/摇杆二选一：两种手感各有各的场合，记住上次选的那个。 */
.modes {
  display: flex;
  margin-bottom: 16rpx;
}

.mode {
  padding: 8rpx 28rpx;
  margin-right: 16rpx;
  border-radius: 30rpx;
  background: #f2f2f7;
  font-size: 26rpx;
  color: #6b6b70;
}

.mode.on {
  background: #1c7ff2;
  color: #ffffff;
}

.row {
  display: flex;
  align-items: center;
}

/* 右上角那颗胶囊是微信自己的、永远盖在页面上，状态行别伸进它那块。 */
.head {
  padding-right: 200rpx;
}

.dot {
  width: 20rpx;
  height: 20rpx;
  border-radius: 50%;
  margin-right: 12rpx;
}

.dot.on {
  background: #34c759;
}

.dot.wait {
  background: #ff9500;
}

.dot.off {
  background: #c7c7cc;
}

.state {
  font-size: 30rpx;
  font-weight: 600;
}

.addr {
  margin-left: 16rpx;
  font-size: 24rpx;
  color: #8e8e93;
}

.error {
  display: block;
  margin-top: 10rpx;
  font-size: 24rpx;
  color: #ff3b30;
}

.actions {
  margin-top: 18rpx;
}

.mini {
  margin-right: 16rpx;
}

.label {
  display: block;
  font-size: 24rpx;
  color: #8e8e93;
  margin-bottom: 16rpx;
}

.pad {
  flex: 1;
  min-height: 260rpx;
  border-radius: 20rpx;
  background: #f2f2f7;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pad.live {
  background: #e5f0ff;
}

/* 拖拽中要一眼看得出来：这时候手指抬起来就是松键。 */
.pad.dragging {
  background: #fff1dc;
}

.pad-hint {
  font-size: 26rpx;
  color: #8e8e93;
}

.keys {
  display: flex;
  margin-top: 16rpx;
}

.key {
  flex: 1;
  margin-right: 16rpx;
  font-size: 28rpx;
}

.key:last-child {
  margin-right: 0;
}

.key.wide {
  flex: none;
  width: 100%;
}

.key.held {
  background: #ff9500;
  color: #ffffff;
}

.tip {
  display: block;
  margin-top: 14rpx;
  font-size: 22rpx;
  color: #8e8e93;
}
</style>
