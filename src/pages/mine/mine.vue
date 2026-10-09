<template>
  <view class="page">
    <view class="card">
      <text class="h1">连接</text>
      <status-bar />
      <view class="row">
        <button class="mini" size="mini" @tap="reconnect">重新连接</button>
        <button class="mini" size="mini" @tap="disconnect">断开</button>
      </view>
    </view>

    <view class="card">
      <text class="h1">扫码配对</text>
      <text class="tip">在 MacStroke 的「偏好设置 → 远程控制」里打开开关，手机和这台 Mac 连同一个 Wi-Fi，再扫下面的二维码。</text>
      <button class="primary" @tap="scan">扫描二维码</button>
      <text class="tip">iPhone 的微信扫不了？用相机扫码后点弹出的链接，或直接在下面手填。</text>
    </view>

    <view class="card">
      <text class="h1">手动填写</text>
      <view class="field">
        <text class="name">Mac 地址</text>
        <input class="input" v-model="host" placeholder="192.168.1.20" />
      </view>
      <view class="field">
        <text class="name">端口</text>
        <input class="input" v-model="port" type="number" placeholder="8848" />
      </view>
      <view class="field">
        <text class="name">配对码</text>
        <input class="input" v-model="token" placeholder="6 位字母数字" />
      </view>
      <button class="primary" @tap="saveAndConnect">保存并连接</button>
      <text class="error" v-if="message">{{ message }}</text>
    </view>
  </view>
</template>

<script>
import StatusBar from '@/components/StatusBar.vue'
import { remote } from '@/utils/socket.js'
import { parsePairing } from '@/utils/pairing.js'

export default {
  components: { StatusBar },

  data() {
    return {
      host: '',
      port: '8848',
      token: '',
      message: '',
    }
  },

  onLoad() {
    const saved = remote.savedTarget()
    if (saved) {
      this.host = saved.host
      this.port = String(saved.port)
      this.token = saved.token
    }
  },

  methods: {
    reconnect() {
      remote.reconnectNow()
    },

    disconnect() {
      remote.close()
    },

    scan() {
      uni.scanCode({
        onlyFromCamera: false,
        success: ({ result }) => {
          const target = parsePairing(result)
          if (!target) {
            this.message = '这不是 MacStroke 的配对二维码'
            return
          }
          this.host = target.host
          this.port = String(target.port)
          this.token = target.token
          this.apply(target)
        },
        fail: () => {
          this.message = '扫码失败，可以手填地址'
        },
      })
    },

    saveAndConnect() {
      const host = this.host.trim()
      const port = Number(String(this.port).trim())
      const token = this.token.trim().toUpperCase()
      if (!host || !port || !token) {
        this.message = '地址、端口、配对码都要填'
        return
      }
      this.apply({ host, port, token })
    },

    apply(target) {
      this.message = ''
      remote.configure(target)
      remote.connect(target)
    },
  },
}
</script>
