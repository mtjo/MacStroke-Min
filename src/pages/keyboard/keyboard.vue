<template>
  <view class="screen" :style="{ paddingTop: headTop + 'px' }">
    <status-bar />
    <input-keypad v-if="canType" ref="keypad" :closable="false" />
    <view class="card" v-else>
      <text class="label">{{ blocked }}</text>
    </view>
    <text class="tip" v-if="canType">中文、emoji 走上面那行文本框（整串注入，不经过按键）；⌘C 这类快捷键要勾修饰键再点键帽，修饰键按完不清空，可以连着按。</text>
  </view>
</template>

<script>
import InputKeypad from '@/components/InputKeypad.vue'
import StatusBar from '@/components/StatusBar.vue'
import { remote } from '@/utils/socket.js'
import { measureHeadTop } from '@/utils/layout.js'

/**
 * 键盘模式的竖屏页（tab 之一）：纯输入，不放回显。
 *
 * 触屏页里那个「键盘」面板会把回显画布挤矮一截，这一页没有画布，
 * 所以键帽能按自身需要铺开；两边共用同一个 InputKeypad，手感不会分叉。
 */
export default {
  components: { InputKeypad, StatusBar },

  data() {
    return {
      headTop: 20,
      state: 'idle',
      proto: 0,
      unsubscribe: null,
    }
  },

  computed: {
    /// 文本注入与快捷键是协议 v3 才有的：旧版 Mac 会回「不认识这条指令」，
    /// 所以没连上、或者连上了但版本不够时，键帽干脆不铺出来。
    canType() {
      return this.state === 'open' && this.proto >= 3
    },

    blocked() {
      if (this.state !== 'open') return '连上 Mac 之后才能输入（还没配对的话去「我的」里扫码）'
      return `这台 Mac 的协议是 v${this.proto}，文本注入与快捷键要 MacStroke 3.1.0 以上`
    },
  },

  onLoad() {
    this.headTop = measureHeadTop()
    this.unsubscribe = remote.onChange((snapshot) => {
      this.state = snapshot.state
      this.proto = remote.proto
    })
    if (remote.savedTarget()) remote.connect()
  },

  beforeUnmount() {
    if (this.unsubscribe) this.unsubscribe()
  },
}
</script>
