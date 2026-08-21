// Shared nav and footer. Kept in JS so the pages share identical chrome
// without a build system. Each page calls renderChrome(activePage).

function renderChrome(active) {
  const nav = `
    <nav class="nav">
      <div class="nav-inner">
        <a href="/" class="logo">Tickr<span>Drop</span></a>
        <div class="nav-links">
          <a href="/" class="nav-link ${active === 'home' ? 'active' : ''}">Home</a>
          <a href="/activate.html" class="nav-link ${active === 'activate' ? 'active' : ''}">Activate</a>
        </div>
        <div class="nav-right">
          <span class="nav-user">Closed Beta</span>
          <a href="/activate.html" class="btn btn-primary" style="padding:10px 16px;">Set an alert</a>
        </div>
      </div>
    </nav>
  `;
  const footer = `
    <footer class="footer">
      <div class="footer-inner">
        <div>TickrDrop · Closed Beta · Summer 2026</div>
        <div>
          <a href="/privacy.html" style="margin-right: 18px;">Privacy</a>
          <a href="/terms.html">Terms</a>
        </div>
      </div>
    </footer>
  `;
  const navMount = document.getElementById('nav-mount');
  const footMount = document.getElementById('footer-mount');
  if (navMount) navMount.outerHTML = nav;
  if (footMount) footMount.outerHTML = footer;
}
