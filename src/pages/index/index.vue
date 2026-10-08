<template>
  <view class="page">
    <view class="card status">
      <view class="row">
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

    <view class="card">
      <text class="label">摇杆区（手指滑动即移动光标）</text>
      <view
        class="pad"
        :class="{ live: padLive }"
        @touchstart="padStart"
        @touchmove="padMove"
        @touchend="padEnd"
        @touchcancel="padEnd"
      >
        <text class="pad-hint">{{ padLive ? '移动中' : '按住这里滑动' }}</text>
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
      <text class="tip">拖文件/框选：先按「按住左键」，用摇杆移动，再按「松开」。</text>
    </view>
  </view>
</template>

<script>
import { remote } from '@/utils/socket.js'

// 手指位移到光标位移的倍率：1 倍太慢，5 倍一滑就飞出屏幕。
const PAD_GAIN = 2.6
// 摇杆发包间隔：再密也只是浪费带宽，Mac 那边按帧消费。
const PAD_INTERVAL = 60

export default {
  data() {
    return {
      state: 'idle',
      lastError: '',
      target: null,
      held: false,
      padLive: false,
      originX: 0,
      originY: 0,
      pendingX: 0,
      pendingY: 0,
      flushTimer: null,
      unsubscribe: null,
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
  },

  onLoad() {
    this.unsubscribe = remote.onChange((snapshot) => {
      this.state = snapshot.state
      this.lastError = snapshot.lastError
      this.target = snapshot.target
      // 掉线时 Mac 会自己补一个松开，按钮状态要跟着回落，否则重连后显示
      // 「按住中」而 Mac 其实早就松了，再点一下才会真的按下。
      if (snapshot.state !== 'open' && this.held) this.held = false
    })
    if (remote.savedTarget()) remote.connect()
  },

  onShow() {
    remote.resume()
  },

  onUnload() {
    if (this.unsubscribe) this.unsubscribe()
    this.stopFlush()
    // 连接本身不关：切到设置页再回来还要用同一条，重建连接要占微信的额度。
  },

  methods: {
    reconnect() {
      remote.reconnectNow()
    },

    disconnect() {
      this.held = false
      remote.close()
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
      this.pendingX += (touch.pageX - this.originX) * PAD_GAIN
      this.pendingY += (touch.pageY - this.originY) * PAD_GAIN
      this.originX = touch.pageX
      this.originY = touch.pageY
      this.scheduleFlush()
    },

    padEnd() {
      this.padLive = false
      this.flush()
      this.stopFlush()
    },

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

    flush() {
      const dx = Math.round(this.pendingX)
      const dy = Math.round(this.pendingY)
      this.pendingX -= dx
      this.pendingY -= dy
      if (dx || dy) remote.move(dx, dy)
    },
  },
}
</script>

<style>
.page {
  padding: 24rpx;
}

.card {
  background: #ffffff;
  border-radius: 20rpx;
  padding: 24rpx;
  margin-bottom: 24rpx;
}

.row {
  display: flex;
  align-items: center;
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
  height: 420rpx;
  border-radius: 20rpx;
  background: #f2f2f7;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pad.live {
  background: #e5f0ff;
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
