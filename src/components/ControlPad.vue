<template>
  <view
    class="pad"
    :class="{ live: padLive, dragging: tpDragging }"
    @touchstart="onPadStart"
    @touchmove="onPadMove"
    @touchend="onPadEnd"
    @touchcancel="onPadEnd"
  >
    <text class="pad-hint">{{ hint }}</text>
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

/**
 * 一块控制面：mode='track' 是触摸板手势，mode='pad' 是摇杆。
 * 手势自己直接发到 remote 上，页面只负责摆位置和在最下面放按键。
 */
export default {
  name: 'ControlPad',

  props: {
    mode: { type: String, default: 'track' },
  },

  data() {
    return {
      padLive: false,
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
    hint() {
      if (this.tpDragging) return '拖拽中，抬手即松开'
      if (this.mode === 'pad') return this.padLive ? '移动中' : '按住这里滑动'
      return this.padLive ? '操作中' : '单指滑动移动光标'
    },
  },

  created() {
    // 掉线时 Mac 会自己补一个松开，这边的手势状态要跟着清零，
    // 否则重连后还停在「拖拽中」，抬手就多发一次松开。
    this.unsubscribe = remote.onChange((snapshot) => {
      if (snapshot.state !== 'open') this.cancel()
    })
  },

  beforeUnmount() {
    this.cancel()
    if (this.unsubscribe) this.unsubscribe()
  },

  methods: {
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

    // 页面切走、断开连接时调用：手指可能还「按着」，不补松开 Mac 会一直停在拖拽里。
    cancel() {
      if (this.tpDragging) remote.hold('left', false)
      this.stopFlush()
      this.resetGesture()
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
        // 两指同时落下时 touchstart 里就是两根手指，不会再有「第二根手指落下」那次
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
</style>
