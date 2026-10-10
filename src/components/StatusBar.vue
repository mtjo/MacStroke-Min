<template>
  <view class="status">
    <view class="row">
      <text class="dot" :class="stateClass"></text>
      <text class="state">{{ stateText }}</text>
      <text class="addr" v-if="target && !compact">{{ target.host }}:{{ target.port }}</text>
    </view>
    <text class="error" v-if="lastError">{{ lastError }}</text>
  </view>
</template>

<script>
import { remote } from '@/utils/socket.js'

/** 控制页顶部的连接状态行：只读，操作都在「我的」里。 */
export default {
  name: 'StatusBar',

  props: {
    // 横屏页竖向只有三百来像素，地址那串不值得占一行：只留状态点。
    compact: { type: Boolean, default: false },
  },

  data() {
    return {
      state: 'idle',
      lastError: '',
      target: null,
      unsubscribe: null,
    }
  },

  computed: {
    stateText() {
      if (this.state === 'open') return '已连接'
      if (this.state === 'connecting') return '连接中…'
      return '未连接'
    },
    stateClass() {
      return this.state === 'open' ? 'on' : this.state === 'connecting' ? 'wait' : 'off'
    },
  },

  created() {
    // onChange 订阅时先推一次当前快照，不用自己再取一遍。
    this.unsubscribe = remote.onChange((next) => {
      this.state = next.state
      this.lastError = next.lastError
      this.target = next.target
    })
  },

  beforeUnmount() {
    if (this.unsubscribe) this.unsubscribe()
  },
}
</script>

<style>
.status {
  padding: 4rpx 0 14rpx;
}

.dot {
  width: 16rpx;
  height: 16rpx;
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
  font-size: 28rpx;
  color: #1c1c1e;
}

.addr {
  margin-left: 16rpx;
  font-size: 24rpx;
  color: #8e8e93;
}
</style>
