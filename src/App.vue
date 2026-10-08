<script>
import { remote } from '@/utils/socket.js'

export default {
  onLaunch() {
    // 换网（Wi-Fi ↔ 流量、切 SSID）后旧连接必然不通，立刻重连一次，
    // 不等退避计时器慢慢爬。这里用 reconnectNow 而不是 resume：网络真的变了，
    // 就算之前已经放弃重试也该再试一次。
    uni.onNetworkStatusChange(({ isConnected }) => {
      if (isConnected && remote.savedTarget()) remote.reconnectNow()
    })
  },

  onShow() {
    // 切后台时微信会掐掉 TCP，回前台时这边状态还是 open，得自己发现。
    remote.resume()
  },
}
</script>

<style>
/* 每个页面公共 css */
page {
  background: #f2f2f7;
}
</style>
