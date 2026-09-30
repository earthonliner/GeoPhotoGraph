/**
 * wx-server-sdk 的内存替身，只实现 cloudfunctions/api 用到的部分：
 * database().collection().doc().get/set/update、add、where().orderBy().limit().get、runTransaction，
 * 以及 cloudPay.unifiedOrder / queryOrder、getWXContext。
 * 微信侧的“已支付流水”用 ledger（商户订单号 -> 金额，分）表示：云支付 queryOrder 默认按它返回。
 * runTransaction 在快照上执行，回调成功才提交，抛错则整体回滚。
 */
function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function createFakeCloud(options = {}) {
  let store = {};
  const ledger = options.ledger || {};
  const calls = { unifiedOrder: [], queryOrder: [] };
  const pay = {
    unifiedOrder: options.unifiedOrder || null,
    queryOrder: options.queryOrder || null
  };
  let openid = options.openid || 'openid-a';

  function api(getStore, setStore) {
    const coll = (name) => {
      const docs = () => {
        const st = getStore();
        st[name] = st[name] || {};
        return st[name];
      };
      const docRef = (id) => ({
        async get() {
          const d = docs()[id];
          if (!d) throw { errCode: -1, errMsg: 'document.get:fail document does not exist' };
          return { data: clone(d) };
        },
        async set({ data }) {
          docs()[id] = Object.assign({}, clone(data), { _id: id });
          setStore();
        },
        async update({ data }) {
          const d = docs()[id];
          if (!d) throw { errCode: -1, errMsg: 'document.update:fail document does not exist' };
          Object.assign(d, clone(data));
          setStore();
        }
      });
      const query = (filter, order, max) => ({
        orderBy: (field, dir) => query(filter, { field, dir }, max),
        limit: (n) => query(filter, order, n),
        async get() {
          let list = Object.values(docs()).filter((d) => Object.keys(filter).every((k) => d[k] === filter[k]));
          if (order) list = list.sort((x, y) => (order.dir === 'desc' ? y[order.field] - x[order.field] : x[order.field] - y[order.field]));
          if (max) list = list.slice(0, max);
          return { data: clone(list) };
        }
      });
      return {
        doc: docRef,
        where: (filter) => query(filter, null, 0),
        async add({ data }) {
          if (docs()[data._id]) throw { errCode: -502002, errMsg: 'duplicate key' };
          docs()[data._id] = clone(data);
          setStore();
          return { _id: data._id };
        }
      };
    };
    return { collection: coll };
  }

  let queue = Promise.resolve();
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'env-test',
    getWXContext: () => ({ OPENID: openid }),
    database() {
      const main = api(() => store, () => {});
      return Object.assign(main, {
        runTransaction(fn) {
          const run = async () => {
            const draft = clone(store);
            const t = api(() => draft, () => {});
            const result = await fn(t);
            store = draft;
            return result;
          };
          const p = queue.then(run, run);
          queue = p.catch(() => {});
          return p;
        }
      });
    },
    cloudPay: {
      async unifiedOrder(params) {
        calls.unifiedOrder.push(params);
        if (pay.unifiedOrder) return pay.unifiedOrder(params);
        return {
          returnCode: 'SUCCESS',
          resultCode: 'SUCCESS',
          payment: { timeStamp: '1700000000', nonceStr: params.nonceStr, package: `prepay_id=${params.outTradeNo}`, signType: 'MD5', paySign: 'sig' }
        };
      },
      async queryOrder(params) {
        calls.queryOrder.push(params);
        if (pay.queryOrder) return pay.queryOrder(params);
        const fee = ledger[params.out_trade_no];
        if (fee !== undefined) {
          return { returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'SUCCESS', totalFee: fee, transactionId: `wx-${params.out_trade_no}` };
        }
        return { returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'NOTPAY' };
      }
    }
  };

  return {
    cloud,
    calls,
    ledger,
    setOpenid: (id) => { openid = id; },
    setQueryOrder: (fn) => { pay.queryOrder = fn; },
    setUnifiedOrder: (fn) => { pay.unifiedOrder = fn; },
    dump: () => clone(store),
    // 直接改库，用于构造测试场景
    patch(collection, id, data) {
      store[collection] = store[collection] || {};
      store[collection][id] = Object.assign(store[collection][id] || { _id: id }, clone(data));
    }
  };
}

module.exports = { createFakeCloud };
