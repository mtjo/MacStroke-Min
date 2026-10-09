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

/* 表单页：内容可以超出一屏，靠 padding 留白 */
.page {
  padding: 24rpx;
}

/* 控制页：铺满一屏，手指在板上滑不该把页面推动 */
.screen {
  box-sizing: border-box;
  height: 100vh;
  padding: 24rpx;
  padding-bottom: calc(24rpx + env(safe-area-inset-bottom));
  display: flex;
  flex-direction: column;
}

/* 组件标签本身才是 .board 的 flex 子项：不给它 flex，板子会缩成内容大小的一小块。 */
.pad-host {
  flex: 1;
  display: flex;
  min-height: 0;
}

.card {
  background: #ffffff;
  border-radius: 20rpx;
  padding: 24rpx;
  margin-bottom: 24rpx;
}

.card:last-child {
  margin-bottom: 0;
}

.row {
  display: flex;
  align-items: center;
}

.h1 {
  display: block;
  font-size: 30rpx;
  font-weight: 600;
  margin-bottom: 12rpx;
}

.label {
  display: block;
  font-size: 24rpx;
  color: #8e8e93;
  margin-bottom: 16rpx;
}

.tip {
  display: block;
  font-size: 22rpx;
  color: #8e8e93;
  margin-top: 14rpx;
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

/* 微信的 button 基础样式自带左右 auto 外边距，不压掉的话两个小按钮会被推到两端 */
.mini {
  margin-right: 16rpx;
  margin-left: 0;
}

.primary {
  margin-top: 24rpx;
  background: #1c7ff2;
  color: #ffffff;
  font-size: 30rpx;
}

.field {
  display: flex;
  align-items: center;
  border-bottom: 1rpx solid #ebebf0;
  padding: 16rpx 0;
}

.name {
  width: 160rpx;
  font-size: 28rpx;
}

.input {
  flex: 1;
  font-size: 28rpx;
}

.error {
  display: block;
  margin-top: 10rpx;
  font-size: 24rpx;
  color: #ff3b30;
}
</style>
