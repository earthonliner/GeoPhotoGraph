const config = require('../../utils/config');
const membership = require('../../utils/membership');
const payment = require('../../utils/payment');
const platform = require('../../utils/platform');
const { MAX_BATCH } = require('../../utils/batch');

function steps() {
  return [
    { title: '选择照片', text: `从相册选择带定位的原图，一次最多 ${MAX_BATCH} 张，自动读取拍摄地点与日期。` },
    { title: '挑选模板', text: '按分类浏览模板。多张照片可以统一使用一款模板，也可以随机分配。' },
    { title: '调整细节', text: '修改地名和日期，拖动或双指缩放调整取景，定制地图配色与不透明度。' },
    { title: '保存海报', text: '把高清海报保存到相册。品牌底栏可以在「海报」一栏关闭。' }
  ];
}

// canPurchase 为 false（iOS）时不出现价格与购买引导；cloud 模式下权益在云端，换机不丢
function faqs(canPurchase, cloud) {
  const { freeQuota, plans, single } = config.membership;
  const list = [
    {
      q: '为什么读取不到拍摄地点？',
      a: '地点来自照片自带的定位信息。拍摄时相机未开启定位，或照片经过聊天转发、截图、编辑后，定位信息通常会丢失。可以点「坐标」搜索地点，或在微信地图上选点。'
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
        `每位用户有 ${freeQuota} 张免费额度，每保存一张无水印高清海报消耗 1 张，同一张照片再次保存不重复消耗。` +
        `额度用完后，预览会带上水印${canPurchase ? '，开通会员后可继续保存' : ''}。`
    }
  ];
  if (canPurchase) {
    const planText = plans
      .map((p) => `${p.name} ${membership.formatPrice(p.price)}，${p.days} 天内可保存 ${p.quota} 张`)
      .join('；');
    list.push({
      q: '会员怎么收费？',
      a: `${planText}；也可以 ${membership.formatPrice(single.price)} 单独解锁当前这张。会员可以重复购买，额度叠加使用，到期后未用完的额度失效。`
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
      faqs: faqs(platform.canPurchase(), cloud),
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
