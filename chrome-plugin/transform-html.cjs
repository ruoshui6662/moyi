const fs = require('fs');
const file = 'src/entrypoints/options/index.html';
let s = fs.readFileSync(file, 'utf8');
const rep = (o, n, tag) => { const b = s; s = s.replace(o, n); if (s === b) throw new Error('anchor failed: ' + tag); console.log('ok:', tag); };

/* 1. API Key 眼睛按钮 */
rep(
`                <div class="field">
                  <label for="apiKey">API KEY</label>
                  <input id="apiKey" type="password" placeholder="sk-…" />
                </div>`,
`                <div class="field">
                  <label for="apiKey">API KEY</label>
                  <div class="key-wrap">
                    <input id="apiKey" type="password" placeholder="sk-…" />
                    <button id="toggleKeyVisibility" class="eye-btn" type="button" aria-label="显示或隐藏 API Key">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.6"/></svg>
                    </button>
                  </div>
                </div>`,
'eye-button');

/* 2. 保存并使用 → 保存并启用 */
rep(`>保存并使用</button>`, `>保存并启用</button>`, 'save-label');

/* 3. textarea 计数 */
rep(
`                  <textarea id="customPrompt" rows="5" placeholder="例如：保持原文的口语感；人名保留英文；句子尽量简短……"></textarea>`,
`                  <textarea id="customPrompt" rows="5" maxlength="500" placeholder="例如：保持原文的口语感；人名保留英文；句子尽量简短……"></textarea>
                  <div class="char-counter"><span id="promptCharCount">0</span> / 500</div>`,
'char-counter');

/* 4. About 重构 */
rep(
`        <section id="sec-about" class="group">
          <div class="group-head">
            <h2>关于</h2>
            <p>墨译 · AI 网页双语翻译</p>
          </div>
          <div class="card">
            <div class="setting-row">
              <div class="row-main">
                <div class="row-label">版本</div>
                <div class="row-desc">当前安装的扩展版本</div>
              </div>
              <span class="row-static">v0.1.0</span>
            </div>
            <div class="setting-row no-border">
              <div class="row-main">
                <div class="row-label">简介</div>
                <div class="row-desc">基于大模型的沉浸式网页双语翻译：流式渲染、视口优先、上下文感知。</div>
              </div>
            </div>
          </div>
        </section>`,
`        <section id="sec-about" class="group narrow">
          <div class="group-head">
            <h2>关于</h2>
            <p>墨译 · AI 网页双语翻译</p>
          </div>
          <div class="card">
            <div class="about-brand">
              <span class="about-brand-icon">译</span>
              <div>
                <div class="about-brand-name">墨译</div>
                <div class="about-brand-sub">网页双语翻译</div>
              </div>
            </div>
            <div class="setting-row">
              <div class="row-main">
                <div class="row-label">版本</div>
                <div class="row-desc">当前安装的扩展版本</div>
              </div>
              <span class="row-static">v0.1.0</span>
            </div>
            <div class="setting-row">
              <div class="row-main">
                <div class="row-label">产品简介</div>
                <div class="row-desc">基于大模型的沉浸式网页双语翻译：流式渲染、视口优先、上下文感知，支持多家 OpenAI 兼容服务商。</div>
              </div>
            </div>
            <div class="setting-row no-border">
              <div class="row-main">
                <div class="row-label">运行状态</div>
                <div class="row-desc status-ok-line"><span class="status-dot"></span>插件正常运行</div>
              </div>
            </div>
          </div>
        </section>`,
'about');

/* 5. Settings 危险文案 */
rep(
`                <div class="row-label">恢复全部默认配置</div>
                <div class="row-desc">清空服务配置与所有个性化项，恢复出厂状态（API Key 将被清除）</div>`,
`                <div class="row-label">恢复全部默认配置</div>
                <div class="row-desc">将清除服务配置、API Key 和所有个性化设置。此操作不可撤销。</div>`,
'danger-copy');

/* 6. 新组件 CSS（插在响应式之前） */
rep(
`      /* ── 响应式 ── */`,
`      /* ── API Key 可见性 ── */
      .key-wrap { position: relative; }
      .key-wrap input { padding-right: 42px; }
      .eye-btn {
        position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
        width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
        background: none; border: none; border-radius: 6px; color: var(--text-3); cursor: pointer;
      }
      .eye-btn:hover { color: var(--text); background: var(--surface-tertiary); }
      .eye-btn svg { width: 16px; height: 16px; }
      .char-counter { margin-top: 6px; font-size: 12px; color: var(--text-3); text-align: right; font-variant-numeric: tabular-nums; }

      /* ── About ── */
      .narrow .card { max-width: 720px; }
      .about-brand { display: flex; align-items: center; gap: 12px; padding: 20px 0 16px; border-bottom: 1px solid var(--separator); }
      .about-brand-icon {
        width: 36px; height: 36px; flex: none; background: #007aff; color: #fff;
        font-size: 16px; font-weight: 600; border-radius: 9px;
        display: flex; align-items: center; justify-content: center; user-select: none;
      }
      .about-brand-name { font-size: 16px; font-weight: 600; }
      .about-brand-sub { font-size: 13px; color: var(--text-3); }
      .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--green); margin-right: 6px; }
      .status-ok-line { color: var(--green-text); }

      /* ── Toast ── */
      .toast-host { position: fixed; top: 24px; left: 50%; transform: translateX(-50%); z-index: 1000; display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
      .toast {
        height: 36px; display: flex; align-items: center; padding: 0 14px;
        background: var(--text); color: var(--card);
        border-radius: 8px; font-size: 13px; box-shadow: 0 8px 32px rgba(0, 0, 0, .18);
        animation: toast-in .2s cubic-bezier(.25, .1, .25, 1);
      }
      .toast.ok::before { content: '✓  '; color: var(--green); font-weight: 700; }
      .toast.error::before { content: '×  '; color: var(--red); font-weight: 700; }
      .toast.leaving { opacity: 0; transition: opacity .25s ease-out; }
      @keyframes toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }

      /* ── Confirm Modal ── */
      .modal-overlay {
        position: fixed; inset: 0; z-index: 900;
        background: rgba(0, 0, 0, .25);
        display: flex; align-items: center; justify-content: center;
        animation: toast-in .18s ease-out;
      }
      .modal {
        width: min(420px, calc(100vw - 48px)); background: var(--card);
        border-radius: 12px; padding: 24px; box-shadow: 0 8px 32px rgba(0, 0, 0, .18);
      }
      .modal h3 { margin: 0 0 12px; font-size: 18px; font-weight: 600; }
      .modal-body { font-size: 14px; line-height: 22px; color: var(--text-2); }
      .modal-body ul { margin: 8px 0; padding-left: 18px; }
      .modal-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; }
      .btn-danger {
        height: 36px; padding: 0 16px; background: var(--red); color: #fff;
        border: none; border-radius: 8px; font-size: 14px; font-weight: 500;
      }
      .btn-danger:hover { filter: brightness(1.08); }

      /* ── 响应式 ── */`,
'components-css');

/* 7. Toast + Modal 宿主 */
rep(
`    <script type="module" src="./main.ts"></script>`,
`    <div id="toastHost" class="toast-host"></div>

    <div id="confirmModal" class="modal-overlay" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <h3 id="modalTitle">恢复全部默认配置？</h3>
        <div class="modal-body">
          此操作将：
          <ul>
            <li>清除所有 API Key</li>
            <li>删除服务配置</li>
            <li>恢复提示词设置</li>
            <li>恢复译文样式</li>
          </ul>
          此操作无法撤销。
        </div>
        <div class="modal-actions">
          <button id="modalCancel" class="btn-secondary-s" type="button">取消</button>
          <button id="modalConfirm" class="btn-danger" type="button">恢复默认配置</button>
        </div>
      </div>
    </div>

    <script type="module" src="./main.ts"></script>`,
'toast-modal-markup');

fs.writeFileSync(file, s);
console.log('ALL HTML TRANSFORMS APPLIED');
