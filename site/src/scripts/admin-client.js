// 管理后台客户端。所有请求同源打 /api/admin/*(Access 在边缘拦截未登录)。
// 编辑走乐观并发(sha):被别处改过会 409,刷新重试,绝不静默覆盖。

const $ = (sel) => document.querySelector(sel);

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const resp = await fetch(`/api/admin/${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `请求失败(${resp.status})`);
  return data;
}

function esc(text) {
  const div = document.createElement('div');
  div.textContent = String(text ?? '');
  return div.innerHTML;
}

// ===== Tab 切换 =====
document.querySelectorAll('#tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach((p) => (p.hidden = true));
    $(`#tab-${btn.dataset.tab}`).hidden = false;
  });
});

// ===== 报表 =====
async function loadStats() {
  const box = $('#stats-body');
  try {
    const s = await api('stats');
    const refTable = (rows) => {
      const byRef = {};
      for (const r of rows) {
        byRef[r.ref] = byRef[r.ref] || { open: 0, copy: 0, copy_fallback: 0 };
        byRef[r.ref][r.type] = r.n;
      }
      const entries = Object.entries(byRef).sort((a, b) =>
        (b[1].copy + b[1].copy_fallback) - (a[1].copy + a[1].copy_fallback));
      if (!entries.length) return '<p>暂无数据</p>';
      return `<table><tr><th>码</th><th>打开</th><th>复制</th><th>降级复制</th></tr>` +
        entries.map(([ref, v]) =>
          `<tr><td>${esc(ref)}</td><td>${v.open}</td><td>${v.copy}</td><td>${v.copy_fallback}</td></tr>`
        ).join('') + '</table>';
    };
    box.innerHTML = `
      <h3>近 7 天(按码)</h3>${refTable(s.by_ref_7d)}
      <h3 style="margin-top:16px">近 28 天(按码)</h3>${refTable(s.by_ref_28d)}
      <h3 style="margin-top:16px">近 28 天(按期)</h3>
      <table><tr><th>期</th><th>类型</th><th>次数</th></tr>${
        s.by_issue_28d.map((r) => `<tr><td>${r.issue}</td><td>${esc(r.type)}</td><td>${r.n}</td></tr>`).join('')
      }</table>`;
  } catch (e) {
    box.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  }
}

// ===== 期刊 =====
async function loadIssues() {
  const box = $('#issues-list');
  try {
    const { issues } = await api('issues');
    if (!issues.length) {
      box.innerHTML = '<p>还没有期刊数据。新期在本地用 publish.py 生成。</p>';
      return;
    }
    box.innerHTML = issues.map((i) => `
      <div class="issue-row" data-issue="${i.issue}">
        <div>
          <b>${esc(i.title)}</b>
          <div class="sub">${esc(i.published_at)} 发布 · 锁价至 ${esc(i.lock_until)} · ${i.item_count} 件</div>
        </div>
        <span class="pill ${i.published ? 'on' : 'off'}">${i.published ? '已发布' : '未发布'}</span>
      </div>`).join('');
    box.querySelectorAll('.issue-row').forEach((row) =>
      row.addEventListener('click', () => openEditor(Number(row.dataset.issue))));
  } catch (e) {
    box.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  }
}

async function openEditor(n) {
  const editor = $('#issue-editor');
  editor.hidden = false;
  editor.innerHTML = '加载中…';
  $('#issues-list').hidden = true;
  try {
    const { data, sha } = await api(`issue?n=${n}`);
    editor.innerHTML = `
      <form class="editor">
        <div class="card-block">
          <b>${esc(data.title)}(${data.published ? '已发布' : '未发布'})</b>
          <label>卷首语<textarea name="greeting" rows="2">${esc(data.greeting || '')}</textarea></label>
          <label>锁价至(YYYY-MM-DD)<input name="lock_until" value="${esc(data.lock_until)}" /></label>
        </div>
        ${data.items.map((item, idx) => `
          <div class="card-block" data-idx="${idx}">
            <b>${esc(item.name)}</b>
            <label>商品名<input data-f="name" value="${esc(item.name)}" /></label>
            <label>参考价 ¥<input data-f="price_cny" type="number" inputmode="numeric" value="${item.price_cny}" /></label>
            <label>规格<input data-f="spec" value="${esc(item.spec || '')}" /></label>
            <label>预计时效<input data-f="eta" value="${esc(item.eta || '')}" /></label>
            <label>备注<input data-f="note" value="${esc(item.note || '')}" /></label>
            <label>角标(如:本周特价)<input data-f="deal" value="${esc(item.deal || '')}" /></label>
          </div>`).join('')}
        <div class="row-actions">
          <button type="button" class="btn-plain" id="ed-back">返回</button>
          <button type="submit" class="btn-primary">保存修改</button>
        </div>
        ${data.published ? `<button type="button" class="btn-danger" id="ed-unpublish">下架本期(上架须回本地过检查单)</button>` : ''}
        <p class="hint">保存 = 提交到仓库,站点约 1 分钟后自动重建生效。文案会先过药品关键词筛查。</p>
      </form>`;

    $('#ed-back').addEventListener('click', closeEditor);

    editor.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const changes = {
        greeting: form.greeting.value,
        lock_until: form.lock_until.value.trim(),
        items: data.items.map((item, idx) => {
          const block = editor.querySelector(`[data-idx="${idx}"]`);
          const get = (f) => block.querySelector(`[data-f="${f}"]`).value;
          return {
            id: item.id,
            name: get('name'),
            price_cny: Number(get('price_cny')),
            spec: get('spec'), eta: get('eta'), note: get('note'), deal: get('deal'),
          };
        }),
      };
      await submit(n, sha, changes, form.querySelector('.btn-primary'));
    });

    const unpub = $('#ed-unpublish');
    if (unpub) {
      unpub.addEventListener('click', async () => {
        if (!confirm(`确认下架第${n}期?客户打开链接将看不到本期。`)) return;
        await submit(n, sha, { published: false }, unpub);
      });
    }
  } catch (e) {
    editor.innerHTML = `<div class="error-box">${esc(e.message)}</div>
      <button type="button" class="btn-plain" id="ed-back" style="margin-top:10px">返回</button>`;
    $('#ed-back').addEventListener('click', closeEditor);
  }
}

async function submit(issue, sha, changes, btn) {
  btn.disabled = true;
  try {
    const result = await api('issue', {
      method: 'PUT',
      body: JSON.stringify({ issue, sha, changes }),
    });
    toast(result.note || '已提交');
    closeEditor();
    loadIssues();
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
  }
}

function closeEditor() {
  $('#issue-editor').hidden = true;
  $('#issue-editor').innerHTML = '';
  $('#issues-list').hidden = false;
}

// ===== 邀请码 =====
let refsSha = null;
let refsList = [];

async function loadRefs() {
  const box = $('#refs-body');
  try {
    const { refs, sha } = await api('refs');
    refsSha = sha;
    refsList = refs;
    renderRefs();
  } catch (e) {
    box.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  }
}

function renderRefs() {
  const box = $('#refs-body');
  box.innerHTML =
    refsList.map((ref) => `
      <div class="ref-row"><span>${esc(ref)}</span>
        <button type="button" data-del="${esc(ref)}">退役</button></div>`).join('') +
    `<div class="add-ref">
       <input id="new-ref" placeholder="新码(a-zA-Z0-9_-,≤24位)" maxlength="24" />
       <button type="button" id="add-ref-btn">发码</button>
     </div>`;

  box.querySelectorAll('[data-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const ref = btn.dataset.del;
      if (!confirm(`退役邀请码 ${ref}?其旧链接流量将计入 direct,不再归到这个码名下。`)) return;
      await saveRefs(refsList.filter((r) => r !== ref));
    }));
  $('#add-ref-btn').addEventListener('click', async () => {
    const value = $('#new-ref').value.trim();
    if (!value) return;
    await saveRefs([...refsList, value]);
  });
}

async function saveRefs(next) {
  try {
    const result = await api('refs', {
      method: 'PUT',
      body: JSON.stringify({ refs: next, sha: refsSha }),
    });
    toast(result.note || '已提交');
    loadRefs();
  } catch (e) {
    toast(e.message);
  }
}

loadStats();
loadIssues();
loadRefs();
