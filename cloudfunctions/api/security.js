/**
 * 内容安全：文本用 security.msgSecCheck，图片用 security.mediaCheckAsync（2.0，异步，结果由消息推送 wxa_media_check 送达）。
 *
 * 图片流程：小程序把缩小后的副本上传到云存储 seccheck/ 下 -> checkImage 换取临时链接并提交检测，
 * 返回 traceId 并在 seccheck 集合记一条 pending -> 微信推送检测结果，onMediaCheck 更新状态并删除云存储里的副本
 * -> 小程序用 imageResult 轮询。副本只为检测而存在，结果返回后立即删除；一直没有结果的副本在之后的调用里清理。
 *
 * 云函数需要在 config.json 声明 openapi 权限（见同目录 config.json）并重新上传。
 * 检测服务本身出错（频率限制、网络等）时放行，只记日志：不能因为检测服务不可用让所有用户用不了。
 * 微信返回 suggest = risky 才视为违规。
 */
const SCENE = 4;
const TEXT_MAX = 200;
const PENDING_TTL = 24 * 60 * 60 * 1000;
const CLEAN_BATCH = 20;
const FILE_PREFIX = 'seccheck/';

function errorInfo(e) {
  return `${(e && (e.errCode !== undefined ? e.errCode : e.code)) || ''} ${(e && (e.errMsg || e.message)) || e}`.trim();
}

function suggestOf(res) {
  if (!res) return '';
  if (res.result && res.result.suggest) return res.result.suggest;
  if (Array.isArray(res.detail) && res.detail.some((d) => d && d.suggest === 'risky')) return 'risky';
  return '';
}

function createSecurity({ cloud, db, now }) {
  const checks = db.collection('seccheck');

  async function removeFile(fileID) {
    if (!fileID) return;
    try {
      await cloud.deleteFile({ fileList: [fileID] });
    } catch (e) {
      console.error('seccheck delete file failed', errorInfo(e));
    }
  }

  async function cleanup() {
    try {
      const { data } = await checks.where({ status: 'pending' }).limit(CLEAN_BATCH).get();
      const expired = data.filter((d) => now() - d.createdAt > PENDING_TTL);
      await Promise.all(
        expired.map(async (d) => {
          await removeFile(d.fileID);
          await checks.doc(d._id).update({ data: { status: 'expired', fileID: '' } });
        })
      );
    } catch (e) {
      console.error('seccheck cleanup failed', errorInfo(e));
    }
  }

  async function checkText(openid, text) {
    const content = String(text || '').trim().slice(0, TEXT_MAX);
    if (!content) return { ok: true, safe: true };
    try {
      const res = await cloud.openapi.security.msgSecCheck({ openid, scene: SCENE, version: 2, content });
      return { ok: true, safe: suggestOf(res) !== 'risky' };
    } catch (e) {
      // 1.0 版本的“内容违规”错误码；2.0 违规通过 suggest 返回，不会走到这里
      if (e && Number(e.errCode) === 87014) return { ok: true, safe: false };
      console.error('msgSecCheck failed', errorInfo(e));
      return { ok: true, safe: true, skipped: true };
    }
  }

  async function checkImage(openid, fileID) {
    const id = String(fileID || '');
    if (!id.startsWith('cloud://') || !id.includes(`/${FILE_PREFIX}`)) return { ok: false, code: 'bad_request' };
    cleanup();
    try {
      const { fileList } = await cloud.getTempFileURL({ fileList: [id] });
      const url = fileList && fileList[0] && fileList[0].tempFileURL;
      if (!url) throw new Error('no temp url');
      const res = await cloud.openapi.security.mediaCheckAsync({
        openid,
        scene: SCENE,
        version: 2,
        media_type: 2,
        media_url: url
      });
      const traceId = res && (res.traceId || res.trace_id);
      if (!traceId) throw new Error('no trace id');
      try {
        await checks.add({ data: { _id: traceId, openid, fileID: id, status: 'pending', createdAt: now() } });
      } catch (e) {
        // 推送比这次写入更早到达：结果已经记下，副本现在可以删了
        const { data } = await checks.doc(traceId).get();
        if (data.status !== 'pending') await removeFile(id);
        else throw e;
      }
      return { ok: true, traceId };
    } catch (e) {
      console.error('mediaCheckAsync failed', errorInfo(e));
      await removeFile(id);
      return { ok: true, skipped: true };
    }
  }

  async function imageResult(openid, traceId) {
    try {
      const { data } = await checks.doc(String(traceId || '')).get();
      if (data.openid !== openid) return { ok: true, status: 'unknown' };
      return { ok: true, status: data.status === 'risky' ? 'risky' : data.status === 'pass' ? 'pass' : 'pending' };
    } catch (e) {
      return { ok: true, status: 'unknown' };
    }
  }

  // 消息推送 wxa_media_check：{ ToUserName, FromUserName, CreateTime, MsgType: 'event', Event: 'wxa_media_check', appid, trace_id, version, detail, result: { suggest, label } }
  async function onMediaCheck(ev) {
    const traceId = String(ev.trace_id || '');
    if (!traceId) return 'success';
    const status = suggestOf(ev) === 'risky' ? 'risky' : 'pass';
    try {
      let fileID = '';
      try {
        const { data } = await checks.doc(traceId).get();
        fileID = data.fileID;
        await checks.doc(traceId).update({ data: { status, fileID: '', checkedAt: now() } });
      } catch (e) {
        await checks.doc(traceId).set({ data: { status, fileID: '', createdAt: now(), checkedAt: now() } });
      }
      await removeFile(fileID);
    } catch (e) {
      console.error('media check notify failed', traceId, errorInfo(e));
      return 'retry';
    }
    return 'success';
  }

  return { checkText, checkImage, imageResult, onMediaCheck };
}

module.exports = { createSecurity };
