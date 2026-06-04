/**
 * 计时器页面 v4 - 专业级速度融合
 * 
 * 设计原则：
 * 1. GPS = Absolute Truth（绝对真值）
 * 2. IMU 只负责 GPS 两帧之间的"补帧"（让UI连续）
 * 3. IMU 绝不长期积分，每次 GPS 强制重置
 * 4. GPS 丢失时速度衰减（不保持，不漂移）
 * 5. GPS 更新时不瞬间跳变（融合过渡）
 * 6. 最小位移阈值过滤低速 GPS 噪声
 * 7. 连续超过目标速度才判定完成（防跳点误判）
 */

const util = require('../../utils/util')

const STATE = {
  IDLE: 'idle',
  READY: 'ready',
  COUNTING: 'counting',
  FINISHED: 'finished'
}

// ===== 可调常量 =====
const MIN_GPS_DIST = 2              // GPS最小位移阈值（米），低于此忽略
const MAX_GPS_SPEED = 200           // GPS单帧最大可信速度 km/h（超过视为跳点）
const MAX_GPS_ACCEL = 30            // GPS两帧间最大加速度 km/h/s（超过视为跳点）
const MAX_GPS_ACCURACY = 50         // GPS精度阈值（米），accuracy超过此值视为不可信
const MIN_GPS_HDOP = 0              // 最小水平精度（废弃精度太差的点）
const MAX_IMU_PREDICT_MS = 1000     // IMU最大插值时间（毫秒）
const SPEED_DECAY = 0.98            // GPS丢失时速度衰减系数（每100ms）
const GPS_FUSION_WEIGHT = 0.35      // GPS更新时的融合权重（新值占比，Keep约0.3~0.4）
const IMU_OFFSET_LIMIT = 30         // IMU偏移限幅 km/h
const TARGET_CONFIRM_MS = 200       // 到达目标速度的确认时间（毫秒）
const SPEED_SMOOTH_WINDOW = 5       // 滑动平均窗口大小
const BASELINE_SAMPLES = 100        // 静止基准采样数（约2~3秒）
const BASELINE_ACCEL_TOLERANCE = 1.0 // 静止采样时 |a - G| 的容差
const MIN_GPS_DT = 0.3              // GPS最小时间间隔（秒），Keep/Strava用0.3~0.5s

Page({
  data: {
    mode: 'auto',
    state: STATE.IDLE,
    targetSpeed: 100,

    currentSpeed: 0,
    maxSpeed: 0,
    elapsedTime: 0,
    displayTime: '0.00',

    resultTime: null,
    resultTimeStr: '',

    statusText: '点击下方按钮开始',
    gpsStatus: '',
    speedSource: '',

    hasLocationAuth: false,
    locationAuthDenied: false
  },

  // ===== 内部变量 =====
  _startTime: 0,
  _timer: null,
  _accelHistory: [],
  _locationStarted: false,
  _accelStarted: false,
  _speedSamples: [],
  _onLocationChangeFn: null,
  _onAccelerometerChangeFn: null,

  // GPS
  _lastLocation: null,
  _lastGpsSpeed: 0,
  _lastGpsTime: 0,
  _gpsUpdateCount: 0,

  // IMU
  _accelBaseline: null,
  _baselineSamples: [],
  _baselineDone: false,
  _lastAccelTime: 0,
  _imuOffset: 0,

  // 融合
  _displaySpeed: 0,        // 当前显示的速度（融合/衰减后的值）
  _speedBuffer: [],

  // 目标速度确认
  _targetReachedTime: 0,    // 首次达到目标速度的时间
  _targetConfirming: false,

  onLoad(options) {
    const mode = options.mode || 'auto'
    const targetSpeed = Number(options.target) || 100
    this.setData({
      mode,
      targetSpeed,
      statusText: mode === 'auto'
        ? '点击"准备"后开始行驶，系统自动检测起步'
        : '点击"开始"在起步瞬间按下'
    })

    this._onLocationChangeFn = this._onLocationChange.bind(this)
    this._onAccelerometerChangeFn = this._onAccelerometerChange.bind(this)
  },

  onUnload() {
    this._cleanup()
  },

  // ========== 权限处理 ==========

  async _requestLocationAuth() {
    try {
      const setting = await wx.getSetting()
      if (setting.authSetting['scope.userLocation'] === false) {
        wx.showModal({
          title: '需要位置权限',
          content: '需要获取GPS来测量速度，请在设置中开启位置权限',
          confirmText: '去设置',
          success: async (modalRes) => {
            if (modalRes.confirm) {
              const setRes = await wx.openSetting()
              if (setRes.authSetting['scope.userLocation']) {
                this.setData({ hasLocationAuth: true })
              }
            }
          }
        })
        return false
      }
    } catch (e) {}

    try {
      await wx.authorize({ scope: 'scope.userLocation' })
      this.setData({ hasLocationAuth: true })
      return true
    } catch (err) {
      this.setData({ locationAuthDenied: true })
      wx.showModal({
        title: '需要位置权限',
        content: '需要获取GPS来测量速度，请在设置中开启位置权限',
        confirmText: '去设置',
        success: async (modalRes) => {
          if (modalRes.confirm) {
            const setRes = await wx.openSetting()
            if (setRes.authSetting['scope.userLocation']) {
              this.setData({ hasLocationAuth: true })
            }
          }
        }
      })
      return false
    }
  },

  // ========== GPS ==========

  async _startLocation() {
    if (this._locationStarted) return

    try {
      await wx.startLocationUpdate({
        type: 'gcj02',
        isHighAccuracy: true,
        highAccuracyExpireTime: 8000
      })

      wx.onLocationChange(this._onLocationChangeFn)
      this._locationStarted = true
      this.setData({ gpsStatus: 'GPS已启动，等待定位...' })
      console.log('[Timer] startLocationUpdate 成功')
    } catch (err) {
      console.error('[Timer] startLocationUpdate 失败:', err)
      this._cleanup()
      wx.showModal({
        title: '定位失败',
        content: '无法启动GPS定位，请确保：\n1. 手机GPS已开启\n2. 在室外空旷处\n3. 已授予位置权限',
        showCancel: false,
        confirmText: '知道了'
      })
      this.setData({ state: STATE.IDLE, gpsStatus: 'GPS启动失败' })
    }
  },

  /**
   * GPS 回调 — Absolute Truth
   * 
   * 对标 Keep/Strava 的过滤策略：
   * 0. 精度过滤（accuracy + horizontalAccuracy）
   * 1. 时间间隔过滤（< 0.3s 的帧丢弃，减少噪声）
   * 2. Haversine 自算速度（带最小位移阈值）
   * 3. 绝对速度上限 + 加速度上限
   * 4. 位移合理性校验（位移不能 > 速度*时间 + 误差范围）
   * 5. 系统speed辅助
   * 6. 加权融合（不瞬间跳变）
   * 7. 滑动窗口平滑
   * 8. 连续超过目标速度才判定完成
   */
  _onLocationChange(res) {
    const now = Date.now()
    this._gpsUpdateCount++

    // ===== 0. 精度过滤（Keep 的做法：双精度校验）=====
    const accuracy = res.accuracy || 999
    const hAccuracy = res.horizontalAccuracy || accuracy
    
    // accuracy 或 horizontalAccuracy 超标都丢弃
    if (accuracy > MAX_GPS_ACCURACY || hAccuracy > MAX_GPS_ACCURACY) {
      console.log(`[Timer] GPS精度不足: accuracy=${accuracy.toFixed(1)}m, hAcc=${hAccuracy.toFixed(1)}m, 跳过`)
      return
    }

    // ===== 1. 时间间隔过滤 =====
    // 两次 GPS 更新间隔 < 0.3秒的丢弃（Keep/Strava 做法）
    // 高频更新通常是噪声，真实GPS不会快于 ~1Hz
    if (this._lastLocation) {
      const dt = (now - this._lastLocation.time) / 1000
      if (dt < MIN_GPS_DT) {
        return
      }
    }

    // ===== 2. GPS坐标自算速度 =====
    let gpsCalcSpeed = 0
    let gpsValid = false
    let gpsDist = 0
    let gpsDt = 0

    if (this._lastLocation && res.latitude && res.longitude) {
      gpsDt = (now - this._lastLocation.time) / 1000
      if (gpsDt >= MIN_GPS_DT && gpsDt < 5) {
        gpsDist = this._calcDistance(
          this._lastLocation.latitude, this._lastLocation.longitude,
          res.latitude, res.longitude
        )

        // ⚠️ 最小位移阈值：低于2米忽略（过滤低速GPS抖动）
        if (gpsDist >= MIN_GPS_DIST) {
          gpsCalcSpeed = (gpsDist / gpsDt) * 3.6

          // ⚠️ 位移合理性校验（Strava 做法）
          // GPS 有误差，位移不应超过 理论最大距离 + GPS精度半径
          // 例如：上次速度100km/h，dt=1s，理论最大28m，加上GPS精度20m = 48m
          if (this._lastGpsSpeed > 0 && gpsDt > 0) {
            const theoreticalMaxDist = (this._lastGpsSpeed / 3.6) * gpsDt + hAccuracy
            if (gpsDist > theoreticalMaxDist * 1.5) {
              console.log(`[Timer] 位移不合理: dist=${gpsDist.toFixed(1)}m, 上限=${theoreticalMaxDist.toFixed(1)}m, 跳过`)
              // 这种点可能坐标漂移，不更新位置缓存
              return
            }
          }

          // ⚠️ 绝对速度上限
          if (gpsCalcSpeed > MAX_GPS_SPEED) {
            console.log(`[Timer] GPS速度跳变: ${gpsCalcSpeed.toFixed(1)}km/h, 跳过`)
            return
          }

          // ⚠️ 加速度上限
          if (this._lastGpsSpeed > 0 && gpsDt > 0) {
            const maxAllowedSpeed = this._lastGpsSpeed + MAX_GPS_ACCEL * gpsDt
            if (gpsCalcSpeed > maxAllowedSpeed) {
              console.log(`[Timer] GPS加速度异常: ${gpsCalcSpeed.toFixed(1)}km/h (上限${maxAllowedSpeed.toFixed(1)}), 跳过`)
              return
            }
          }

          if (gpsCalcSpeed > 3) {
            gpsValid = true
          }
        }
      }
    }

    // ===== 2. 系统speed =====
    const hasValidSysSpeed = typeof res.speed === 'number' && res.speed >= 0
    const sysSpeed = hasValidSysSpeed ? res.speed * 3.6 : 0

    // 更新位置缓存（存精度用于下次校验）
    this._lastLocation = {
      latitude: res.latitude,
      longitude: res.longitude,
      time: now,
      accuracy: accuracy
    }

    // ===== 3. 融合决策 =====
    let gpsSpeed = 0
    let source = ''

    if (gpsValid) {
      gpsSpeed = gpsCalcSpeed
      source = 'GPS'

      if (hasValidSysSpeed && sysSpeed > 3) {
        gpsSpeed = gpsCalcSpeed * 0.8 + sysSpeed * 0.2
        source = 'GPS+SYS'
      }
    } else if (hasValidSysSpeed && sysSpeed > 3) {
      gpsSpeed = sysSpeed
      source = 'SYS'
    } else {
      // GPS和系统都不可用，不更新
      return
    }

    // ===== 4. 不瞬间跳变：加权融合 =====
    // speed = displaySpeed * 0.7 + gpsSpeed * 0.3
    const fusedSpeed = this._displaySpeed * (1 - GPS_FUSION_WEIGHT) + gpsSpeed * GPS_FUSION_WEIGHT

    // 过滤异常
    if (fusedSpeed > 300 || fusedSpeed < 0) return

    // ===== 5. 滑动窗口平滑 =====
    this._speedBuffer.push(fusedSpeed)
    if (this._speedBuffer.length > SPEED_SMOOTH_WINDOW) this._speedBuffer.shift()
    const smoothSpeed = this._speedBuffer.reduce((a, b) => a + b, 0) / this._speedBuffer.length

    // ===== 6. 强制重置 IMU =====
    this._imuOffset = 0
    this._lastGpsSpeed = smoothSpeed
    this._lastGpsTime = now

    // 更新显示
    const displaySpeed = Math.round(smoothSpeed * 10) / 10
    this._displaySpeed = smoothSpeed

    this.setData({
      currentSpeed: displaySpeed,
      gpsStatus: `GPS #${this._gpsUpdateCount} · ${displaySpeed} km/h`,
      speedSource: source
    })

    if (smoothSpeed > this.data.maxSpeed) {
      this.setData({ maxSpeed: Math.round(smoothSpeed * 10) / 10 })
    }

    // ===== 7. 目标速度确认（连续 TARGET_CONFIRM_MS 才判定）=====
    if (this.data.state === STATE.COUNTING && this.data.mode === 'auto') {
      if (smoothSpeed >= this.data.targetSpeed - 3) {
        if (!this._targetConfirming) {
          this._targetConfirming = true
          this._targetReachedTime = now
        } else if (now - this._targetReachedTime >= TARGET_CONFIRM_MS) {
          this._finish()
          return
        }
      } else {
        // 速度回落，取消确认
        this._targetConfirming = false
      }
    }

    // 记录速度样本
    if (this.data.state === STATE.COUNTING) {
      const elapsed = (now - this._startTime) / 1000
      this._speedSamples.push({
        time: Math.round(elapsed * 100) / 100,
        speed: displaySpeed,
        source
      })
    }
  },

  _calcDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLon = (lon2 - lon1) * Math.PI / 180
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  },

  // ========== IMU ==========

  _startAccelerometer() {
    if (this._accelStarted) return

    wx.startAccelerometer({ interval: 'game' })
    wx.onAccelerometerChange(this._onAccelerometerChangeFn)
    this._accelStarted = true
    this._baselineDone = false
    this._accelBaseline = null
    this._baselineSamples = []
  },

  _onAccelerometerChange(res) {
    const now = Date.now()
    const x = res.x, y = res.y, z = res.z
    const magnitude = Math.sqrt(x * x + y * y + z * z)

    // ===== 静止基准校准 =====
    if (!this._baselineDone) {
      if (Math.abs(magnitude - 9.81) < BASELINE_ACCEL_TOLERANCE) {
        this._baselineSamples.push({ x, y, z, time: now })
      }
      if (this._baselineSamples.length >= BASELINE_SAMPLES) {
        const avg = this._baselineSamples.reduce((acc, s) => ({
          x: acc.x + s.x, y: acc.y + s.y, z: acc.z + s.z
        }), { x: 0, y: 0, z: 0 })
        const n = this._baselineSamples.length
        this._accelBaseline = {
          x: avg.x / n, y: avg.y / n, z: avg.z / n
        }
        this._baselineDone = true
        console.log('[Timer] 基准已建立:', this._accelBaseline)
      }
      return
    }

    // ===== IMU 短时插值（仅 GPS 间隙 < 1秒）=====
    const dt = this._lastAccelTime ? (now - this._lastAccelTime) / 1000 : 0
    const gpsAge = now - this._lastGpsTime

    if (dt > 0 && dt < 0.1 && gpsAge < MAX_IMU_PREDICT_MS) {
      const netAccel = x - this._accelBaseline.x // m/s²
      const deltaV = netAccel * dt * 3.6          // km/h

      this._imuOffset += deltaV
      this._imuOffset = Math.max(-IMU_OFFSET_LIMIT, Math.min(IMU_OFFSET_LIMIT, this._imuOffset))

      const imuSpeed = Math.max(0, this._lastGpsSpeed + this._imuOffset)
      const imuDisplay = Math.round(imuSpeed * 10) / 10
      this._displaySpeed = imuSpeed

      this.setData({
        currentSpeed: imuDisplay,
        gpsStatus: `IMU · ${imuDisplay} km/h`,
        speedSource: 'IMU'
      })
    }

    this._lastAccelTime = now

    // ===== 起步检测 =====
    this._accelHistory.push({ magnitude, time: now })
    const cutoff = now - 2000
    while (this._accelHistory.length > 0 && this._accelHistory[0].time < cutoff) {
      this._accelHistory.shift()
    }

    if (this.data.state === STATE.READY && this._lastGpsSpeed > 3) {
      if (util.detectLaunch(this._accelHistory)) {
        this._startCounting()
      }
    }
  },

  // ========== 速度衰减（50ms定时器） ==========

  _startSpeedDecay() {
    // 每100ms检查一次，如果GPS超时则衰减速度
    this._decayTimer = setInterval(() => {
      if (this.data.state !== STATE.COUNTING) return

      const gpsAge = Date.now() - this._lastGpsTime
      if (gpsAge > MAX_IMU_PREDICT_MS) {
        // GPS超过1秒没更新，且IMU也已过期 → 衰减
        this._displaySpeed *= SPEED_DECAY
        const displaySpeed = Math.round(this._displaySpeed * 10) / 10
        this.setData({
          currentSpeed: displaySpeed,
          speedSource: 'DECAY'
        })
      }
    }, 100)
  },

  // ========== 计时控制 ==========

  async onTapReady() {
    const authed = await this._requestLocationAuth()
    if (!authed) return

    wx.showLoading({ title: '启动GPS...' })

    await this._startLocation()
    if (this.data.mode === 'auto') {
      this._startAccelerometer()
    }

    wx.hideLoading()

    this.setData({
      state: STATE.READY,
      statusText: '准备就绪 - 请起步行驶',
      currentSpeed: 0,
      maxSpeed: 0,
      elapsedTime: 0,
      displayTime: '0.00',
      resultTime: null
    })

    this._resetState()
    wx.vibrateShort({ type: 'medium' })
  },

  async onTapStart() {
    const authed = await this._requestLocationAuth()
    if (!authed) return

    wx.showLoading({ title: '启动GPS...' })

    await this._startLocation()
    this._startAccelerometer()

    wx.hideLoading()

    this._startCounting()
    wx.vibrateShort({ type: 'heavy' })
  },

  _resetState() {
    this._speedSamples = []
    this._accelHistory = []
    this._speedBuffer = []
    this._lastLocation = null
    this._lastGpsSpeed = 0
    this._lastGpsTime = 0
    this._gpsUpdateCount = 0
    this._displaySpeed = 0
    this._imuOffset = 0
    this._accelBaseline = null
    this._baselineSamples = []
    this._baselineDone = false
    this._lastAccelTime = 0
    this._targetConfirming = false
    this._targetReachedTime = 0
  },

  _startCounting() {
    this._startTime = Date.now()
    this._speedSamples = [{ time: 0, speed: this.data.currentSpeed }]

    this.setData({
      state: STATE.COUNTING,
      statusText: '计时中...'
    })

    // 计时器：更新显示时间
    this._timer = setInterval(() => {
      if (this.data.state !== STATE.COUNTING) return
      const elapsed = (Date.now() - this._startTime) / 1000
      this.setData({
        elapsedTime: elapsed,
        displayTime: util.formatTime(elapsed)
      })
    }, 50)

    // 速度衰减定时器
    this._startSpeedDecay()
  },

  onTapStop() {
    this._finish()
    wx.vibrateShort({ type: 'heavy' })
  },

  _finish() {
    const endTime = Date.now()
    const resultTime = (endTime - this._startTime) / 1000

    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._decayTimer) {
      clearInterval(this._decayTimer)
      this._decayTimer = null
    }

    const resultTimeStr = util.formatTime(resultTime)

    this.setData({
      state: STATE.FINISHED,
      resultTime,
      resultTimeStr,
      displayTime: resultTimeStr,
      statusText: '完成！',
      elapsedTime: resultTime
    })

    const record = {
      id: endTime,
      time: resultTime,
      timeStr: resultTimeStr,
      mode: this.data.mode,
      target: this.data.targetSpeed,
      dateStr: util.formatDate(endTime),
      maxSpeed: Math.round(this.data.maxSpeed * 10) / 10,
      speedSamples: this._speedSamples
    }

    util.saveRecord(record)
    wx.vibrateLong()
  },

  onTapReset() {
    this._cleanup()
    this.setData({
      state: STATE.IDLE,
      currentSpeed: 0,
      maxSpeed: 0,
      elapsedTime: 0,
      displayTime: '0.00',
      resultTime: null,
      resultTimeStr: '',
      gpsStatus: '',
      speedSource: '',
      statusText: this.data.mode === 'auto'
        ? '点击"准备"后开始行驶'
        : '点击"开始"在起步瞬间按下'
    })
  },

  onTapBack() {
    wx.navigateBack()
  },

  _cleanup() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    if (this._decayTimer) {
      clearInterval(this._decayTimer)
      this._decayTimer = null
    }

    if (this._locationStarted) {
      try { wx.stopLocationUpdate() } catch (e) {}
      try { wx.offLocationChange(this._onLocationChangeFn) } catch (e) {}
      this._locationStarted = false
    }

    if (this._accelStarted) {
      try { wx.stopAccelerometer() } catch (e) {}
      try { wx.offAccelerometerChange(this._onAccelerometerChangeFn) } catch (e) {}
      this._accelStarted = false
    }

    this._resetState()
  },

  onShareAppMessage() {
    return {
      title: `我的0-${this.data.targetSpeed}成绩: ${this.data.resultTimeStr || '?'}秒！你能比我快吗？`,
      path: '/pages/index/index'
    }
  }
})
