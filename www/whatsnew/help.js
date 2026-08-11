(() => {
  const menuToggle = document.querySelector('.header-menu-toggle');
  const viewTabs = document.querySelector('.header-view-tabs');
  const mobileMenu = window.matchMedia('(max-width: 700px)');

  function closeMenu({restoreFocus = false} = {}) {
    if (!menuToggle || !viewTabs) return;
    viewTabs.classList.remove('is-open');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', '画面メニューを開く');
    if (restoreFocus) menuToggle.focus();
  }

  if (menuToggle && viewTabs) {
    menuToggle.addEventListener('click', () => {
      const open = menuToggle.getAttribute('aria-expanded') !== 'true';
      viewTabs.classList.toggle('is-open', open);
      menuToggle.setAttribute('aria-expanded', String(open));
      menuToggle.setAttribute('aria-label', open ? '画面メニューを閉じる' : '画面メニューを開く');
    });
    viewTabs.addEventListener('click', event => {
      if (event.target.closest('a')) closeMenu();
    });
    document.addEventListener('click', event => {
      if (!event.target.closest('header')) closeMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && viewTabs.classList.contains('is-open')) {
        closeMenu({restoreFocus: true});
      }
    });
    mobileMenu.addEventListener('change', closeMenu);
  }

  const trigger = document.querySelector('#map-guide-open');
  if (!trigger) return;

  const STORAGE_KEY = 'osm-whatsnew-guide-v1';
  const dialog = document.createElement('dialog');
  dialog.id = 'map-guide-dialog';
  dialog.className = 'map-guide-dialog';
  dialog.setAttribute('aria-labelledby', 'map-guide-title');
  dialog.setAttribute('aria-describedby', 'map-guide-intro');
  dialog.innerHTML = `
    <div class="map-guide-panel">
      <div class="map-guide-header">
        <div class="map-guide-title">
          <img src="image/site.png" width="480" height="480" alt="">
          <h2 id="map-guide-title">OSM What’s New Japanについて</h2>
        </div>
        <button class="map-guide-close" type="button" aria-label="ガイドを閉じる" title="閉じる">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
      <div class="map-guide-body">
        <p id="map-guide-intro" class="map-guide-intro">OpenStreetMapで日本国内に追加・編集された地物を、地図・分析・密度の画面とマッパー別プロフィールで確認できるWebアプリケーションです。</p>
        <ul class="map-guide-list">
          <li><img class="map-guide-image" src="image/map.png" width="1254" height="1254" alt=""><span><strong>地図</strong>新規作成（緑）・更新（オレンジ）の地物を表示し、時刻に沿って再生</span></li>
          <li><img class="map-guide-image" src="image/report.png" width="1254" height="1254" alt=""><span><strong>分析</strong>都道府県、タグ、編集者、日付、変更セット別に集計</span></li>
          <li><span class="map-guide-symbol" aria-hidden="true">▦</span><span><strong>密度</strong>選択期間に更新された地物を約1kmメッシュ単位で表示</span></li>
          <li><span class="map-guide-symbol" aria-hidden="true">♙</span><span><strong>個人</strong>直近1年間の活動、継続レベル、獲得バッジをマッパー別に表示</span></li>
        </ul>
        <p class="map-guide-scope">タグ付きノードに加え、対象タグを持つwayとmultipolygon relationを対象としています。</p>
        <p class="map-guide-note"><strong>時刻について</strong>OSMへの登録・更新時刻を示すもので、施設の開業日や現実世界での変更日を示すものではありません。</p>
        <section class="map-guide-about" aria-label="運営情報、APIとライセンス">
          <p class="map-guide-about-description">地物を取得するAPIの使い方、利用できるクエリパラメーター、セットアップ方法、ソースコードをGitHubで公開しています。</p>
          <a class="site-info-repository map-guide-repository" href="https://github.com/K-Sakanoshita/osm-whatsnew-japan" target="_blank" rel="noopener noreferrer">
            <span>GitHubでAPIの使い方とソースコードを見る</span>
            <small>K-Sakanoshita/osm-whatsnew-japan ↗</small>
          </a>
          <p class="map-guide-license">OpenStreetMapのデータはOpen Database License（ODbL）の下で提供されています。利用時は© OpenStreetMap contributorsの表示が必要です。</p>
          <p class="map-guide-operator"><a href="https://k-sakanoshita.github.io/MyPortfolio/" target="_blank" rel="noopener noreferrer">制作・運営：坂ノ下 勝幸<span class="visually-hidden">（ポートフォリオを新しいタブで開く）</span></a><br>本サイトは個人が開発・運営しています。OpenStreetMap FoundationおよびOpenStreetMap Foundation Japanの公式サービスではありません。</p>
        </section>
      </div>
      <div class="map-guide-actions"><button class="map-guide-start" type="button">閉じる</button></div>
    </div>
  `;
  document.body.append(dialog);

  let openMode = '';
  let returnFocus = trigger;

  function hasSeen() {
    try {
      return window.localStorage.getItem(STORAGE_KEY) !== null;
    } catch {
      return false;
    }
  }

  function rememberSeen() {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Storage may be unavailable in private or restricted browsing contexts.
    }
  }

  function open({mode = 'manual', focusTarget = trigger} = {}) {
    if (dialog.open) return;
    openMode = mode;
    returnFocus = focusTarget || trigger;
    dialog.dispatchEvent(new CustomEvent('osm-guide-before-open', {detail: {mode}}));
    dialog.showModal();
    dialog.querySelector('.map-guide-close').focus();
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  trigger.addEventListener('click', () => open());
  dialog.querySelector('.map-guide-close').addEventListener('click', close);
  dialog.querySelector('.map-guide-start').addEventListener('click', close);
  dialog.addEventListener('close', () => {
    const closedMode = openMode;
    const focusTarget = returnFocus;
    openMode = '';
    returnFocus = trigger;
    if (closedMode === 'automatic') rememberSeen();
    dialog.dispatchEvent(new CustomEvent('osm-guide-closed', {detail: {mode: closedMode}}));
    requestAnimationFrame(() => focusTarget?.focus());
  });

  window.osmWhatsNewGuide = {dialog, hasSeen, open, close};
})();
