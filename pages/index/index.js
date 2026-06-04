const util = require('../../utils/util')

Page({
  data: {
    records: [],
    bestTime: null,
    recordCount: 0,
    targetSpeed: 100,
    targets: [50, 100]
  },

  onShow() {
    this.loadRecords()
  },

  loadRecords() {
    const records = util.getRecords()
    const bestTime = records.length > 0
      ? Math.min(...records.map(r => r.time))
      : null

    this.setData({
      records: records.slice(0, 5), // 首页只显示最近5条
      bestTime,
      recordCount: records.length
    })
  },

  // 选择目标速度
  onSelectTarget(e) {
    const speed = Number(e.currentTarget.dataset.speed)
    this.setData({ targetSpeed: speed })
  },

  // 选择自动模式
  onTapAuto() {
    wx.navigateTo({
      url: `/pages/timer/timer?mode=auto&target=${this.data.targetSpeed}`
    })
  },

  // 选择手动模式
  onTapManual() {
    wx.navigateTo({
      url: `/pages/timer/timer?mode=manual&target=${this.data.targetSpeed}`
    })
  },

  // 查看历史记录
  onTapHistory() {
    wx.navigateTo({
      url: '/pages/history/history'
    })
  },

  // 分享
  onShareAppMessage() {
    return {
      title: '百公里加速计时器 - 测测你的0-100！',
      path: '/pages/index/index'
    }
  }
})
