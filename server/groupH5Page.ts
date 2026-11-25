import type express from 'express';
import type { GachaDatabase } from './db';

function escapeHtmlAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function registerGroupH5Route(app: express.Express, db: GachaDatabase): void {
  app.get('/g/:shareCode', (req, res) => {
    const rawCode = String(req.params.shareCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(rawCode)) {
      res.status(400).type('html').send('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>无效拼团链接</title></head><body>无效的拼团分享码</body></html>');
      return;
    }

    const bundle = db.getGroupOrderByShareCode(rawCode);
    const pageTitle = bundle
      ? `${bundle.order.title}${bundle.order.ip_name ? ` · ${bundle.order.ip_name}` : ''} | 在线排谷`
      : `拼团 ${rawCode} | Gacha Pricer 在线排谷`;

    const safeTitle = escapeHtmlAttr(pageTitle);
    const safeCodeJson = JSON.stringify(rawCode);

    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${safeTitle}</title>
  <meta name="description" content="在线实时查看谷子拼团余量、自助排谷认领与退补核算" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700&family=Plus+Jakarta+Sans:wght@500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #F6F7F9;
      --surface: #FFFFFF;
      --border: #E4E7EC;
      --text: #0F172A;
      --muted: #64748B;
      --accent: #0F172A;
      --hot: #E11D48;
      --ok: #15803D;
      --warn: #B45309;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      max-width: 100%;
      overflow-x: hidden;
    }
    body {
      font-family: "Plus Jakarta Sans", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
      padding-bottom: 48px;
    }
    .mono {
      font-family: "JetBrains Mono", monospace;
      font-variant-numeric: tabular-nums;
    }
    header.topbar {
      position: sticky;
      top: 0;
      z-index: 30;
      height: 54px;
      background: rgba(255, 255, 255, 0.92);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
      padding: 0 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .brand {
      font-size: 15px;
      font-weight: 700;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .meta-line {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .hint-text {
      font-size: 12px;
      color: var(--muted);
      line-height: 1.45;
      word-break: break-word;
    }
    .container {
      max-width: 1120px;
      margin: 0 auto;
      padding: 16px;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 20px;
    }
    @media (min-width: 960px) {
      .container {
        padding: 24px;
        grid-template-columns: minmax(0, 1.12fr) minmax(0, 1fr);
        align-items: start;
      }
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      overflow: hidden;
    }
    .panel-pad { padding: 16px; }
    .hero-img-wrap {
      background: #0F172A;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 200px;
    }
    .hero-img {
      display: block;
      width: 100%;
      max-height: 70vh;
      object-fit: contain;
    }
    .summary-strip {
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px;
      font-size: 13px;
      color: var(--muted);
    }
    .buyer-form {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 14px;
    }
    @media (max-width: 480px) {
      .buyer-form { grid-template-columns: 1fr; }
    }
    label.field-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      margin-bottom: 4px;
    }
    input.text-input {
      width: 100%;
      min-height: 44px;
      padding: 0 12px;
      border: 1px solid #CBD5E1;
      border-radius: 10px;
      font-size: 14px;
      color: var(--text);
      background: #FFFFFF;
    }
    input.text-input:focus {
      outline: none;
      border-color: var(--accent);
    }
    .notice-bar {
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 12px;
      display: none;
    }
    .notice-bar.error { display: block; background: #FFF1F2; color: #BE123C; border: 1px solid #FECDD3; }
    .notice-bar.success { display: block; background: #F0FDF4; color: #15803D; border: 1px solid #BBF7D0; }
    .item-list {
      border-top: 1px solid var(--border);
    }
    .item-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid #F1F5F9;
      min-height: 64px;
    }
    .item-row:last-child { border-bottom: none; }
    .item-row.soldout { opacity: 0.56; background: #F8FAFC; }
    .item-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
    }
    .item-sub {
      font-size: 12px;
      color: var(--muted);
      margin-top: 2px;
    }
    .item-right {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .price-text {
      font-size: 15px;
      font-weight: 700;
      color: var(--text);
    }
    button.claim-btn {
      min-width: 82px;
      min-height: 44px;
      padding: 0 14px;
      border-radius: 10px;
      border: none;
      background: var(--accent);
      color: #FFFFFF;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.15s ease, transform 0.12s ease;
    }
    button.claim-btn:active { transform: scale(0.98); }
    button.claim-btn:disabled {
      background: #E2E8F0;
      color: #94A3B8;
      cursor: not-allowed;
    }
    button.cancel-btn {
      min-height: 36px;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid #FECDD3;
      background: #FFF1F2;
      color: #BE123C;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .section-head {
      font-size: 14px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .claim-feed {
      font-size: 13px;
      color: var(--muted);
    }
    .claim-feed-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 0;
      border-bottom: 1px solid #F1F5F9;
    }
    .claim-feed-row:last-child { border-bottom: none; }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand" id="hdr-title">正在加载拼团...</div>
    <div class="meta-line mono" id="hdr-status">连接中</div>
  </header>

  <main class="container">
    <section class="panel" aria-label="拼团标注图">
      <div class="hero-img-wrap" id="img-wrap">
        <span class="meta-line" id="img-placeholder">正在加载开团标注图...</span>
      </div>
      <div class="summary-strip" id="summary-strip">
        <span id="stock-summary">—</span>
        <span class="mono" id="code-label"></span>
      </div>
    </section>

    <section style="display: flex; flex-direction: column; gap: 16px;">
      <div class="panel">
        <div class="panel-pad">
          <div class="section-head">填写排谷信息（一键认领防撞车）</div>
          <div id="notice-box" class="notice-bar" role="status" aria-live="polite"></div>
          <div class="buyer-form">
            <div>
              <label class="field-label" for="buyer-name">群昵称 / CN</label>
              <input id="buyer-name" class="text-input" type="text" maxlength="32" placeholder="例如：研磨猫猫" />
            </div>
            <div>
              <label class="field-label" for="buyer-contact">QQ 或微信号（公开脱敏）</label>
              <input id="buyer-contact" class="text-input" type="text" maxlength="48" placeholder="例如：QQ 12345678" />
            </div>
          </div>
          <p class="hint-text">提示：点击下方「排 1 个」立即锁定余量；完整联系方式仅团长可见。</p>
        </div>
        <div class="item-list" id="item-list" aria-label="可认领角色列表"></div>
      </div>

      <div class="panel panel-pad" id="my-bill-panel" style="display: none;">
        <div class="section-head">本次我的认领小结</div>
        <div id="my-bill-list" class="claim-feed"></div>
      </div>

      <div class="panel panel-pad">
        <div class="section-head">实时排表动态</div>
        <div id="public-claims" class="claim-feed">暂无排谷记录，快来抢先认领吧。</div>
      </div>
    </section>
  </main>

  <script>
    (function () {
      var SHARE_CODE = ${safeCodeJson};
      // Session-scoped claim tokens kept strictly in JS memory (never written to localStorage)
      var myClaimTokens = new Map();
      var currentOrder = null;
      var submittingItemId = null;

      var hdrTitle = document.getElementById('hdr-title');
      var hdrStatus = document.getElementById('hdr-status');
      var imgWrap = document.getElementById('img-wrap');
      var stockSummary = document.getElementById('stock-summary');
      var codeLabel = document.getElementById('code-label');
      var noticeBox = document.getElementById('notice-box');
      var buyerNameInput = document.getElementById('buyer-name');
      var buyerContactInput = document.getElementById('buyer-contact');
      var itemListEl = document.getElementById('item-list');
      var myBillPanel = document.getElementById('my-bill-panel');
      var myBillList = document.getElementById('my-bill-list');
      var publicClaimsEl = document.getElementById('public-claims');

      codeLabel.textContent = '分享码 ' + SHARE_CODE;

      function showNotice(msg, tone) {
        noticeBox.textContent = msg;
        noticeBox.className = 'notice-bar ' + (tone === 'error' ? 'error' : 'success');
      }

      function formatMoney(v) {
        var r = Math.round((Number(v) || 0) * 100) / 100;
        return Number.isInteger(r) ? String(r) : r.toFixed(1).replace(/\\.0$/, '');
      }

      function statusText(status) {
        if (status === 'locked') return '已锁单核账';
        if (status === 'settled') return '二调已结清';
        return '开放排谷中';
      }

      function renderOrder(order) {
        currentOrder = order;
        var titleStr = order.title + (order.ip_name ? ' · ' + order.ip_name : '');
        hdrTitle.textContent = titleStr;
        hdrStatus.textContent = statusText(order.status);

        // Safe image rendering
        while (imgWrap.firstChild) imgWrap.removeChild(imgWrap.firstChild);
        var src = String(order.annotated_image_data_url || '');
        if (src && (src.indexOf('data:image/') === 0 || src.indexOf('/') === 0)) {
          var img = document.createElement('img');
          img.className = 'hero-img';
          img.alt = titleStr;
          img.referrerPolicy = 'no-referrer';
          img.src = src;
          imgWrap.appendChild(img);
        } else {
          var fallback = document.createElement('div');
          fallback.className = 'meta-line';
          fallback.style.padding = '32px';
          fallback.style.color = '#CBD5E1';
          fallback.textContent = titleStr;
          imgWrap.appendChild(fallback);
        }

        var totalStock = 0;
        var remStock = 0;
        for (var i = 0; i < order.items.length; i++) {
          totalStock += order.items[i].total_qty;
          remStock += order.items[i].remaining_qty;
        }
        stockSummary.textContent =
          '共 ' + order.items.length + ' 款 · 剩余可排 ' + remStock + ' / ' + totalStock + ' 件';

        // Render items
        while (itemListEl.firstChild) itemListEl.removeChild(itemListEl.firstChild);
        order.items.forEach(function (it) {
          var row = document.createElement('div');
          row.className = 'item-row' + (it.remaining_qty <= 0 ? ' soldout' : '');

          var left = document.createElement('div');
          var titleEl = document.createElement('div');
          titleEl.className = 'item-title';
          titleEl.textContent = it.label + (it.tag ? ' · ' + it.tag : '');

          var subEl = document.createElement('div');
          subEl.className = 'item-sub mono';
          subEl.textContent = '余量 ' + it.remaining_qty + ' / ' + it.total_qty + ' 件';
          left.appendChild(titleEl);
          left.appendChild(subEl);

          var right = document.createElement('div');
          right.className = 'item-right';

          var priceEl = document.createElement('span');
          priceEl.className = 'price-text mono';
          priceEl.textContent = '¥' + formatMoney(it.price);

          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'claim-btn';
          var disabled = order.status !== 'open' || it.remaining_qty <= 0 || submittingItemId === it.id;
          btn.disabled = disabled;
          btn.setAttribute('aria-label', '认领 ' + it.label);
          btn.textContent =
            order.status !== 'open'
              ? '已锁单'
              : it.remaining_qty <= 0
                ? '已排满'
                : submittingItemId === it.id
                  ? '提交中...'
                  : '排 1 个';

          btn.addEventListener('click', function () {
            submitClaim(it.id, it.label);
          });

          right.appendChild(priceEl);
          right.appendChild(btn);
          row.appendChild(left);
          row.appendChild(right);
          itemListEl.appendChild(row);
        });

        // Render buyer's own claims in this session + matching nickname
        var currentName = buyerNameInput.value.trim().toLowerCase();
        var mine = order.claims.filter(function (c) {
          return myClaimTokens.has(c.id) || (currentName && c.buyer_name.toLowerCase() === currentName);
        });

        if (mine.length > 0) {
          myBillPanel.style.display = 'block';
          while (myBillList.firstChild) myBillList.removeChild(myBillList.firstChild);
          var sumPay = 0;
          mine.forEach(function (c) {
            sumPay += c.unit_price * c.qty;
            var r = document.createElement('div');
            r.className = 'claim-feed-row';
            var txt = document.createElement('span');
            txt.className = 'mono';
            txt.textContent = c.item_label + ' ×' + c.qty + ' · ¥' + formatMoney(c.unit_price * c.qty);
            r.appendChild(txt);

            if (myClaimTokens.has(c.id) && order.status === 'open') {
              var cbtn = document.createElement('button');
              cbtn.type = 'button';
              cbtn.className = 'cancel-btn';
              cbtn.textContent = '撤销';
              cbtn.addEventListener('click', function () {
                cancelMyClaim(c.id);
              });
              r.appendChild(cbtn);
            }
            myBillList.appendChild(r);
          });
          var totalLine = document.createElement('div');
          totalLine.style.paddingTop = '10px';
          totalLine.style.fontWeight = '700';
          totalLine.style.color = '#0F172A';
          totalLine.className = 'mono';
          totalLine.textContent = '预计应付合计：¥' + formatMoney(sumPay);
          myBillList.appendChild(totalLine);
        } else {
          myBillPanel.style.display = 'none';
        }

        // Render public claims feed
        while (publicClaimsEl.firstChild) publicClaimsEl.removeChild(publicClaimsEl.firstChild);
        if (order.claims.length === 0) {
          publicClaimsEl.textContent = '暂无排谷记录，快来抢先认领吧。';
        } else {
          order.claims.slice().reverse().forEach(function (c) {
            var crow = document.createElement('div');
            crow.className = 'claim-feed-row';
            var leftSpan = document.createElement('span');
            leftSpan.textContent = c.buyer_name + '（' + c.buyer_contact + '）排了 ' + c.item_label + ' ×' + c.qty;
            var rightSpan = document.createElement('span');
            rightSpan.className = 'mono';
            rightSpan.textContent = '¥' + formatMoney(c.unit_price * c.qty);
            crow.appendChild(leftSpan);
            crow.appendChild(rightSpan);
            publicClaimsEl.appendChild(crow);
          });
        }
      }

      function submitClaim(itemId, itemLabel) {
        var bName = buyerNameInput.value.trim();
        var bContact = buyerContactInput.value.trim();
        if (!bName) {
          showNotice('请先填写您的群昵称 / CN 再排谷。', 'error');
          buyerNameInput.focus();
          return;
        }
        if (!bContact) {
          showNotice('请填写 QQ 或微信号，方便团长核对肾表。', 'error');
          buyerContactInput.focus();
          return;
        }

        submittingItemId = itemId;
        if (currentOrder) renderOrder(currentOrder);

        fetch('/api/v1/groups/' + encodeURIComponent(SHARE_CODE) + '/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item_id: itemId,
            buyer_name: bName,
            buyer_contact: bContact,
            qty: 1
          })
        })
          .then(function (res) {
            return res.json().then(function (data) {
              return { ok: res.ok, status: res.status, data: data };
            });
          })
          .then(function (out) {
            submittingItemId = null;
            if (!out.ok) {
              showNotice(out.data && out.data.detail ? out.data.detail : '排谷失败，请刷新重试', 'error');
              loadInitial();
              return;
            }
            if (out.data.claim_id && out.data.claim_token) {
              myClaimTokens.set(out.data.claim_id, out.data.claim_token);
            }
            showNotice('已成功排下「' + itemLabel + '」×1！', 'success');
            if (out.data.order) renderOrder(out.data.order);
          })
          .catch(function () {
            submittingItemId = null;
            showNotice('网络异常，请稍后重试。', 'error');
            if (currentOrder) renderOrder(currentOrder);
          });
      }

      function cancelMyClaim(claimId) {
        var token = myClaimTokens.get(claimId);
        if (!token) return;
        fetch('/api/v1/groups/' + encodeURIComponent(SHARE_CODE) + '/claims/' + encodeURIComponent(claimId), {
          method: 'DELETE',
          headers: { 'X-Claim-Token': token }
        })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            myClaimTokens.delete(claimId);
            showNotice('已撤销该条认领并释放库存。', 'success');
            if (data && data.order) renderOrder(data.order);
          })
          .catch(function () {
            showNotice('撤销失败，请稍后重试。', 'error');
          });
      }

      function loadInitial() {
        fetch('/api/v1/groups/' + encodeURIComponent(SHARE_CODE))
          .then(function (res) {
            if (!res.ok) throw new Error('未找到该拼团链接');
            return res.json();
          })
          .then(function (data) {
            if (data && data.order) renderOrder(data.order);
          })
          .catch(function (err) {
            hdrTitle.textContent = '拼团不存在或已失效';
            hdrStatus.textContent = '404';
            showNotice(err.message || '加载失败', 'error');
          });
      }

      buyerNameInput.addEventListener('input', function () {
        if (currentOrder) renderOrder(currentOrder);
      });

      loadInitial();

      if (typeof EventSource !== 'undefined') {
        var es = new EventSource('/api/v1/groups/' + encodeURIComponent(SHARE_CODE) + '/events');
        es.addEventListener('snapshot', function (ev) {
          try { renderOrder(JSON.parse(ev.data)); } catch (_e) {}
        });
        es.addEventListener('update', function (ev) {
          try { renderOrder(JSON.parse(ev.data)); } catch (_e) {}
        });
      }
    })();
  </script>
</body>
</html>`;

    res.status(bundle ? 200 : 404).type('html').send(html);
  });
}
