const config = require('../../utils/config');
const membership = require('../../utils/membership');
const payment = require('../../utils/payment');
const platform = require('../../utils/platform');
const { MAX_BATCH } = require('../../utils/batch');

function steps() {
  return [
    { title: '选择照片', text: `从相册选择带定位的原图（读不到位置时可从聊天选原图），一次最多 ${MAX_BATCH} 张，自动读取拍摄地点与日期。` },
    { title: '挑选模板', text: '按分类浏览模板。多张照片可以统一使用一款模板，也可以随机分配。' },
    { title: '调整细节', text: '修改地名和日期，拖动或双指缩放调整取景，定制地图配色与不透明度。' },
    { title: '保存海报', text: '把高清海报保存到相册。品牌底栏可以在「海报」一栏关闭。' }
  ];
}

// canPurchase 为 false（购买未开放，或 iOS 未开通购买）时不出现价格与购买引导；cloud 模式下权益在云端，换机不丢
function faqs(canPurchase, cloud, ios) {
  const { free, plans, lifetime, single } = config.membership;
  const list = [
    {
      q: '为什么读取不到拍摄地点？',
      a: '地点来自照片自带的定位信息。拍摄时相机未开启定位，或照片经过截图、编辑后，定位信息会丢失；另外微信从相册选图时，部分手机（尤其是 iPhone）会把位置去掉。这时请把原图用「文件传输助手」以“文件”形式发给自己，回到首页点「从聊天选原图」导入。也可以点「坐标」搜索地点，或在微信地图上选点。'
    },
    {
      q: '地名不准确，或想换个写法？',
      a: '「地点」可以直接编辑，也可以切换地名语言（English / 中文）和范围（城市 / 含区域）。改过之后点「恢复自动地名」即可还原。'
    },
    {
      q: '地图没有加载出来？',
      a: '网络不佳或地图服务暂时不可用时，海报会使用内置的简约底图，照片和文字不受影响。网络恢复后调整一次地图缩放或切换模板，即可重新加载。'
    },
    {
      q: '保存到相册失败？',
      a: '首次保存需要同意隐私保护指引，并允许保存到相册。如果之前拒绝过，可以点右上角「···」→「设置」，打开「添加到相册」后重试。'
    },
    {
      q: '免费额度怎么计算？',
      a:
        `免费版只有「拍立得」模板每月有 ${free.monthly} 张免费额度，每保存一张无水印高清海报消耗 1 张，` +
        '同一张照片用同一模板再次保存不重复消耗，每月 1 日重置。' +
        `其余模板的预览带水印、不能下载${canPurchase ? '，付费后可去水印并下载' : ''}。`
    },
    {
      q: '批量导入和批量下载怎么用？',
      a: canPurchase
        ? `一次最多导入 ${MAX_BATCH} 张。批量导入和批量下载只对月度、年度、买断会员和邀请码开放，单张解锁不含批量。`
        : `一次最多导入 ${MAX_BATCH} 张。批量导入和批量下载为会员功能，已有会员权益或邀请码的用户可以使用。`
    }
  ];
  if (canPurchase) {
    const planText = plans
      .map((p) => `${p.name} ${membership.formatPrice(p.price)}，${p.days} 天内可保存 ${p.quota} 张`)
      .join('；');
    list.push({
      q: '会员怎么收费？',
      a:
        `${planText}；${lifetime.name} ${membership.formatPrice(lifetime.price)}，一次买断、永久有效，每月可保存 ${lifetime.monthly} 张，次月 1 日重置、不累计；` +
        `也可以 ${membership.formatPrice(single.price)} 单独解锁一张（不含批量）。月度和年度会员可以重复购买，额度叠加使用，到期后未用完的额度失效。`
    });
  }
  if (canPurchase && ios) {
    list.push({
      q: 'iOS 上购买后如何退款？',
      a: 'iOS 上的购买由 Apple 收款并结算，退款需要在 Apple 的「报告问题」页面（reportaproblem.apple.com）申请。Apple 批准退款后，对应的会员额度会自动收回。'
    });
  }
  if (cloud) {
    list.push({
      q: '换手机后额度还在吗？',
      a: '会员权益与额度保存在云端，和微信账号绑定。在其他手机上登录同一个微信即可继续使用。'
    });
  }
  return list.map((it) => Object.assign({ open: false }, it));
}

function privacyNotes(cloud) {
  const list = [
    { title: '照片只在手机上处理', text: '读取拍摄地点与日期、绘制和导出海报都在手机上完成，照片不会上传。' },
    {
      title: '位置与地名',
      text: '为绘制地图和显示地名，照片的经纬度会发送给地图服务商 Mapbox；搜索地点时会发送输入的关键词。地图选点使用微信提供的位置服务。'
    }
  ];
  if (cloud) {
    list.push({ title: '会员与额度', text: '额度、订单与兑换记录保存在云端，只与微信账号标识关联，用于核验额度。' });
  }
  return list;
}

function versionText() {
  const env = platform.envVersion();
  if (env === 'develop') return '开发版';
  if (env === 'trial') return '体验版';
  const v = platform.version();
  return v ? `版本 ${v}` : '';
}

Page({
  data: {
    steps: [],
    faqs: [],
    privacy: [],
    privacyContract: false,
    version: ''
  },

  onLoad() {
    const cloud = !payment.isMock();
    this.setData({
      steps: steps(),
      faqs: faqs(platform.canPurchase(), cloud, platform.platform() === 'ios'),
      privacy: privacyNotes(cloud),
      privacyContract: typeof wx.openPrivacyContract === 'function',
      version: versionText()
    });
  },

  onToggleFaq(e) {
    const i = e.currentTarget.dataset.index;
    this.setData({ [`faqs[${i}].open`]: !this.data.faqs[i].open });
  },

  onOpenPrivacyContract() {
    wx.openPrivacyContract({
      fail: () => wx.showToast({ title: '暂时无法打开，请稍后重试', icon: 'none' })
    });
  }
});
