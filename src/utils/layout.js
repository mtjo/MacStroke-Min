// 自定义导航后页面顶到屏幕最上沿，第一块内容要让开状态栏和右上角那颗胶囊；
// 胶囊位置各机型差很多，只能问系统要，拿不到就退回状态栏高度。
export function measureHeadTop() {
  const statusBar = uni.getSystemInfoSync().statusBarHeight || 20
  const capsule =
    typeof uni.getMenuButtonBoundingClientRect === 'function' ? uni.getMenuButtonBoundingClientRect() : null
  return capsule && capsule.top ? capsule.top : statusBar
}
