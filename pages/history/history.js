const util = require('../../utils/util')

Page({
  data: {
    records: [],
    hasRecords: false,
    bestTime: null,
    avgTime: null,
    autoCount: 0,
    manualCount: 0
  },

  onShow() {
    this.loadRecords()
  },

  loadRecords() {
    const records = util.getRecords()
    
    if (records.length === 0) {
      this.setData({ records: [], hasRecords: false })
      return
    }

    // 统计数据
    const times = records.map(r => r.time)
    const bestTime = Math.min(...times)
    const avgTime = times.reduce((a, b) => a + b, 0) / times.length
    const autoCount = records.filter(r => r.mode === 'auto').length
    const manualCount = records.filter(r => r.mode === 'manual').length

    // 格式化显示
    const formattedRecords = records.map(r => ({
      ...r,
      timeStr: r.time.toFixed(2),
      isBest: r.time === bestTime,
      targetStr: r.target ? `0-${r.target}` : '0-100'
    }))

    this.setData({
      records: formattedRecords,
      hasRecords: true,
      bestTime: bestTime.toFixed(2),
      avgTime: avgTime.toFixed(2),
      autoCount,
      manualCount
    })
  },

  // 清空记录
  onTapClear() {
    wx.showModal({
      title: '确认删除',
      content: '确定要清空所有记录吗？删除后不可恢复。',
      confirmColor: '#e94560',
      success: (res) => {
        if (res.confirm) {
          util.clearRecords()
          this.loadRecords()
          wx.showToast({ title: '已清空', icon: 'success' })
        }
      }
    })
  },

  // 删除单条记录
  onDeleteItem(e) {
    const id = e.currentTarget.dataset.id
    const records = util.getRecords()
    const newRecords = records.filter(r => r.id !== id)
    wx.setStorageSync('records', newRecords)
    this.loadRecords()
    wx.showToast({ title: '已删除', icon: 'success' })
  },

  // 返回
  onTapBack() {
    wx.navigateBack()
  },

  // 分享
  onShareAppMessage() {
    return {
      title: '百公里加速计时器 - 测测你的0-100！',
      path: '/pages/index/index'
    }
  }
})
