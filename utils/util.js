/**
 * 加速计时器核心工具
 * 
 * 速度获取：wx.onLocationChange (GPS速度)
 * 起步检测：wx.onAccelerometerChange (加速度突变)
 * 
 * 精度说明：GPS速度采样约1Hz，综合精度约±0.3-0.5秒
 */

/**
 * 将 m/s 转为 km/h
 */
function msToKmh(ms) {
  return ms * 3.6
}

/**
 * 格式化秒数为 x.xx 格式
 */
function formatTime(seconds) {
  if (seconds == null || isNaN(seconds)) return '--'
  return seconds.toFixed(2)
}

/**
 * 格式化日期
 */
function formatDate(timestamp) {
  const d = new Date(timestamp)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 保存记录到本地
 */
function saveRecord(record) {
  const records = wx.getStorageSync('records') || []
  records.unshift(record)
  // 最多保存100条
  if (records.length > 100) records.length = 100
  wx.setStorageSync('records', records)
  return records
}

/**
 * 获取所有记录
 */
function getRecords() {
  return wx.getStorageSync('records') || []
}

/**
 * 清空记录
 */
function clearRecords() {
  wx.setStorageSync('records', [])
}

/**
 * 计算加速度变化量（用于起步检测）
 * 返回加速度合向量
 */
function calcAccelMagnitude(x, y, z) {
  // 减去重力加速度 (设备竖持时 y ≈ 9.8)
  // 这里只关注变化，不需要精确减重力
  return Math.sqrt(x * x + y * y + z * z)
}

/**
 * 检测起步（加速度突变）
 * @param {Array} accelHistory 最近的加速度历史 [{magnitude, time}, ...]
 * @param {number} threshold 加速度变化阈值 m/s²，默认 2.5
 * @returns {boolean}
 */
function detectLaunch(accelHistory, threshold = 2.5) {
  if (accelHistory.length < 5) return false
  
  const recent = accelHistory.slice(-5)
  const older = accelHistory.slice(-10, -5)
  
  if (older.length < 3) return false
  
  const avgRecent = recent.reduce((s, a) => s + a.magnitude, 0) / recent.length
  const avgOlder = older.reduce((s, a) => s + a.magnitude, 0) / older.length
  
  return (avgRecent - avgOlder) > threshold
}

/**
 * 检测是否已到达目标速度
 * @param {number} currentSpeedKmh 当前速度 km/h
 * @param {number} targetKmh 目标速度，默认 100
 * @param {number} tolerance 容差 km/h，默认 2
 * @returns {boolean}
 */
function detectTargetReached(currentSpeedKmh, targetKmh = 100, tolerance = 2) {
  return currentSpeedKmh >= (targetKmh - tolerance)
}

module.exports = {
  msToKmh,
  formatTime,
  formatDate,
  saveRecord,
  getRecords,
  clearRecords,
  calcAccelMagnitude,
  detectLaunch,
  detectTargetReached
}
