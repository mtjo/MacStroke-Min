<template>
  <view class="screen" :style="{ paddingTop: headTop + 'px' }">
    <status-bar />
    <view class="card board">
      <control-pad class="pad-host" ref="pad" mode="track" />
    </view>
    <text class="tip">单指轻点=左键，快速两下=双击，双指轻点=右键，双指滑动=滚动，按住不动再拖=拖拽。</text>
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
    }
  },

  onLoad() {
    this.headTop = measureHeadTop()
    if (remote.savedTarget()) remote.connect()
  },

  onHide() {
    // 切走时手指可能还「按着」，交给板子自己补松开。
    this.$refs.pad.cancel()
  },
}
</script>

<style>
/* 板子吃掉整屏剩下的空间：触摸板就该越大越好，别的什么都不放。 */
.board {
  flex: 1;
  min-height: 0;
  display: flex;
}
</style>
