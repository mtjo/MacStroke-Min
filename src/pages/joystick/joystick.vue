<template>
  <view class="screen" :style="{ paddingTop: headTop + 'px' }">
    <status-bar />
    <view class="card board">
      <control-pad class="pad-host" ref="pad" mode="pad" />
    </view>
    <view class="card">
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
      <text class="tip">摇杆只能移动光标，点击全靠上面的按键。</text>
    </view>
  </view>
</template>

<script>
import ControlPad from '@/components/ControlPad.vue'
import StatusBar from '@/components/StatusBar.vue'
import { remote } from '@/utils/socket.js'
import { measureHeadTop } from '@/utils/layout.js'

export default {
  components: { ControlPad, StatusBar },

  data() {
    return {
      headTop: 20,
      ready: false,
      held: false,
      unsubscribe: null,
    }
  },

  onLoad() {
    this.headTop = measureHeadTop()
    this.unsubscribe = remote.onChange((snapshot) => {
      this.ready = snapshot.state === 'open'
      // 掉线时 Mac 会自己补一个松开，按钮状态要跟着回落，否则重连后显示
      // 「按住中」而 Mac 其实早就松了，再点一下才会真的按下。
      if (!this.ready && this.held) this.held = false
    })
  },

  onHide() {
    this.$refs.pad.cancel()
  },

  beforeUnmount() {
    if (this.unsubscribe) this.unsubscribe()
  },

  methods: {
    click(button, doubleClick) {
      remote.click(button, doubleClick)
    },

    toggleHold() {
      this.held = !this.held
      remote.hold('left', this.held)
    },
  },
}
</script>

<style>
.board {
  flex: 1;
  min-height: 0;
  display: flex;
  margin-bottom: 24rpx;
}
</style>
