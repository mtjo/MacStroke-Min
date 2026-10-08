// 解析 MacStroke 偏好页二维码里的配对串：
//   macstroke://pair?host=192.168.1.20&port=8848&token=AB23CD
// 扫码结果可能被相机加上首尾空白，也允许用户手输成纯 query 串，所以这里放宽：
// 只认 host / port / token 三个参数，其余一律忽略。

export function parsePairing(raw) {
  if (!raw) return null
  const text = String(raw).trim()
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text
  const params = {}
  query.split('&').forEach((pair) => {
    const index = pair.indexOf('=')
    if (index <= 0) return
    const key = pair.slice(0, index).trim().toLowerCase()
    let value = pair.slice(index + 1).trim()
    try {
      value = decodeURIComponent(value)
    } catch (e) {
      // 手输时可能带个裸的 %，按原文用就行。
    }
    if (key) params[key] = value
  })

  const host = params.host || params.address || params.ip
  const port = Number(params.port)
  const token = (params.token || params.code || '').toUpperCase()
  if (!host || !port || !token) return null
  return { host, port, token }
}

export function formatTarget(target) {
  if (!target) return ''
  return `${target.host}:${target.port}`
}
