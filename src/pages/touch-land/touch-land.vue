<template>
  <view class="land">
    <view class="head">
      <status-bar compact />
    </view>
    <touch-mirror ref="mirror" class="pad-host" landscape />
  </view>
</template>

<script>
import StatusBar from '@/components/StatusBar.vue'
import TouchMirror from '@/components/TouchMirror.vue'
import { remote } from '@/utils/socket.js'

/**
 * 触屏模式的横屏页：桌面本来就是横的，竖屏里只能缩成画布中间一条，
 * 这一页让回显铺满整个横向屏幕，点起来准得多。
 *
 * 微信没有运行时转屏的 API，横屏只能靠 pages.json 里那句 pageOrientation
 * = landscape 静态声明，所以它必须是独立的一页，由竖屏页的「横屏」按钮跳进来。
 *
 * 竖向只有三百来像素，能省的全省了：状态行只留状态点（地址在竖屏页看得到），
 * 卡片内边距和说明文字去掉。控件不敢浮到画面上——canvas 是原生组件，盖得住普通节点。
 */
export default {
  components: { StatusBar, TouchMirror },

  onLoad() {
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

  onUnload() {
    if (this.$refs.mirror) this.$refs.mirror.pageHide()
  },
}
</script>

<style>
/* 刘海在左右两边，要让开的是横向安全区，不是底部。 */
.land {
  box-sizing: border-box;
  height: 100vh;
  display: flex;
  flex-direction: column;
  padding-left: calc(16rpx + env(safe-area-inset-left));
  padding-right: calc(16rpx + env(safe-area-inset-right));
  padding-bottom: 8rpx;
}

/* 状态行压成一行高：右上角是胶囊按钮的地盘，这边只放左边一小条。 */
.head {
  width: 45%;
}
</style>
