// ref 透传:码只来自 URL,多层转发靠链接自带。
// 单一实现——改归因参数名/透传规则只改这里,漏改任何一页都会静默断归因链。

// 码是我们自己发的短标识;URL 上的任意字符串会被原样嵌进
// 客户粘贴给创始人的订单文本,所以先过字符集闸(防伪造链接夹带话术)。
// 语法与后台发码校验共用 isValidRef,松一边就会出现前端静默丢弃的码。
import { isValidRef } from './blacklist.js';

export function currentRef() {
  const ref = new URLSearchParams(location.search).get('ref') || '';
  return isValidRef(ref) ? ref : '';
}

// 把当前 ref 写进页面上所有 data-ref-link 站内链接
export function applyRefPassthrough(ref = currentRef()) {
  if (!ref) return ref;
  document.querySelectorAll('a[data-ref-link]').forEach((a) => {
    const url = new URL(a.getAttribute('href'), location.origin);
    url.searchParams.set('ref', ref);
    a.setAttribute('href', url.pathname + url.search);
  });
  return ref;
}
