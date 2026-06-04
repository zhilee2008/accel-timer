App({
  onLaunch() {
    // 初始化本地存储
    if (!wx.getStorageSync('records')) {
      wx.setStorageSync('records', [])
    }
  },
  globalData: {
    // 广告位ID - 后期成为流量主后填入
    bannerAdId: '',
    interstitialAdId: '',
    rewardedAdId: ''
  }
})
