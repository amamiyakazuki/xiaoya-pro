(function (root) {
  'use strict';
  const schema = root.XiaoyaQuestion;
  const fail = message => { throw Error(message); };
  function safeURL(value, base) {
    let url;
    try { url = new URL(value, base); } catch { fail('图片地址无法读取。'); }
    if (url.protocol === 'data:') return schema.imageData(url.href);
    if (url.protocol === 'blob:' && url.origin === new URL(base).origin) return url.href;
    if (url.protocol !== 'https:' || url.username || url.password) fail('图片来源不安全或不能直接读取，请检查图片。');
    return url.href;
  }
  async function readImage(response, signal) {
    if (!response.ok) fail('题目图片读取失败，请确认图片可以正常打开。');
    const mime = response.headers.get('content-type')?.split(';')[0].toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) fail('图片不是 PNG/JPEG/WebP/GIF，无法发送给当前接口。');
    const reader = response.body?.getReader();
    if (!reader) fail('无法读取图片内容。');
    const chunks = []; let size = 0;
    try {
      while (true) {
        if (signal?.aborted) fail('已取消图片读取。');
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > schema.LIMITS.imageBytes) { await reader.cancel(); fail('单张图片超过 4 MB，请缩小图片后重试。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return schema.imageData(`data:${mime};base64,${btoa(binary)}`);
  }
  async function raster(resource, signal, document = root.document) {
    if (signal?.aborted) fail('已取消图片读取。');
    const element = resource.node;
    if (resource.kind === 'canvas') {
      if (!element.width || !element.height || element.width * element.height > 16000000) fail('图片尺寸过大或尚未加载。');
      try { return schema.imageData(element.toDataURL('image/png')); } catch { fail('浏览器不允许读取此图像，请提供可读取的题目图片。'); }
    }
    // SVG rendered as an image cannot run scripts. Also reject external references.
    if (element.querySelector('script,foreignObject,image') || [...element.querySelectorAll('*'), element].some(el => [...el.attributes].some(a => /^on/i.test(a.name) || (/href$/i.test(a.name) && !a.value.startsWith('#')) || /url\(\s*[^#]/i.test(a.value)))) fail('此公式图包含外部资源，请提供公式原文或普通图片。');
    const image = new Image();
    const source = /\sxmlns=/.test(resource.source) ? resource.source : resource.source.replace(/^<svg(?=[ >])/, '<svg xmlns="http://www.w3.org/2000/svg"');
    const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
    try {
      await new Promise((resolve, reject) => {
        const abort = () => { image.src = ''; reject(Error('已取消图片读取。')); };
        const finish = fn => () => { signal?.removeEventListener('abort', abort); fn(); };
        image.onload = finish(resolve); image.onerror = finish(() => reject(Error('公式图片无法解码。')));
        signal?.addEventListener('abort', abort, { once: true }); image.src = url;
      });
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16000000) fail('公式图片尺寸过大或为空。');
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return schema.imageData(canvas.toDataURL('image/png'));
    } finally { URL.revokeObjectURL(url); }
  }
  async function prepare(extracted, { signal, fetchImpl = fetch, base = root.location?.href, document = root.document } = {}) {
    const images = []; let total = 0;
    for (const resource of extracted.resources || []) {
      if (signal?.aborted) fail('已取消图片读取。');
      let data;
      if (resource.kind !== 'url') data = await raster(resource, signal, document);
      else {
        const url = safeURL(resource.source, base);
        if (url.startsWith('data:')) data = url;
        else {
          try {
            const response = await fetchImpl(url, { signal, credentials: new URL(url).origin === new URL(base).origin ? 'same-origin' : 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
            data = await readImage(response, signal);
          } catch (error) {
            if (signal?.aborted) fail('已取消图片读取。');
            if (error instanceof TypeError) fail('浏览器无法读取题目图片（网络或跨域限制），未向 AI 发送不完整题目。');
            throw error;
          }
        }
      }
      total += data.length;
      if (total > schema.LIMITS.totalImageChars) fail('题目图片总量过大，请缩小图片后重试。');
      images.push(data);
    }
    return images.length ? { ...extracted.question, images } : extracted.question;
  }
  root.XiaoyaAnswerMedia = { safeURL, readImage, prepare };
  if (typeof module !== 'undefined') module.exports = root.XiaoyaAnswerMedia;
})(globalThis);
