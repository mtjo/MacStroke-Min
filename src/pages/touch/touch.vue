<template>
  <view class="screen" :style="{ paddingTop: headTop + 'px' }">
    <status-bar />
    <touch-mirror ref="mirror" class="pad-host" />
  </view>
</template>

<script>
import StatusBar from '@/components/StatusBar.vue'
import TouchMirror from '@/components/TouchMirror.vue'
import { remote } from '@/utils/socket.js'
import { measureHeadTop } from '@/utils/layout.js'

/**
 * 触屏模式的竖屏页（tab 之一）：回显与手势都在 TouchMirror 里，
 * 这一页只负责让开状态栏、把页面生命周期转给组件。
 */
export default {
  components: { StatusBar, TouchMirror },

  data() {
    return {
      headTop: 20,
    }
  },

  onLoad() {
    this.headTop = measureHeadTop()
    if (remote.savedTarget()) remote.connect()
  },

  onShow() {
    if (this.$refs.mirror) this.$refs.mirror.pageShow()
  },

  onReady() {
    if (this.$refs.mirror) this.$refs.mirror.pageReady()
  },

  onHide() {
    if (this.$refs.mirror) this.$refs.mirror.pageHide()
  },
}
</script>
