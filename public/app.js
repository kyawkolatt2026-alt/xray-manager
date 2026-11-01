
const $ = id => document.getElementById(id);
let users = [];

async function api(url, options = {}) {
  const response = await fetch('/api' + url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || 'Request failed');
  return data;
}

function showPanel() {
  $('loginPage').hidden = true;
  $('panel').hidden = false;
  loadDashboard();
}

function showLogin() {
  $('loginPage').hidden = false;
  $('panel').hidden = true;
}

function navigate(page) {
  document.querySelectorAll('.page').forEach(el => el.hidden = true);
  $(page + 'Page').hidden = false;

  document.querySelectorAll('.nav').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  $('pageTitle').textContent =
    page.charAt(0).toUpperCase() + page.slice(1);

  if (page === 'users') loadUsers();
  if (page === 'dashboard') loadDashboard();
  $('sidebar').classList.remove('open');
}

document.querySelectorAll('.nav').forEach(button => {
  button.addEventListener('click', () => navigate(button.dataset.page));
});

$('menuBtn').addEventListener('click', () => {
  $('sidebar').classList.toggle('open');
});

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  $('loginError').textContent = '';

  try {
    await api('/login', {
      method: 'POST',
      body: JSON.stringify({
        username: form.get('username'),
        password: form.get('password')
      })
    });
    showPanel();
  } catch (error) {
    $('loginError').textContent = error.message;
  }
});

$('logout').addEventListener('click', async () => {
  try { await api('/logout', { method: 'POST' }); } catch {}
  showLogin();
});

async function checkLogin() {
  try {
    await api('/me');
    showPanel();
  } catch {
    showLogin();
  }
}

async function loadDashboard() {
  try {
    const data = await api('/dashboard');
    const stats = data.stats || data;

    $('totalUsers').textContent = stats.totalUsers ?? 0;
    $('enabledUsers').textContent = stats.enabledUsers ?? 0;
    $('disabledUsers').textContent = stats.disabledUsers ?? 0;

    const system = data.system || {};
    $('cpuCores').textContent = system.cpuCores ?? system.cpus ?? '-';
    $('hostname').textContent = system.hostname ?? '-';
    $('platform').textContent = system.platform ?? '-';
    $('uptime').textContent = system.uptime
      ? Math.floor(system.uptime / 3600) + ' hours'
      : '-';

    $('memory').textContent = system.memory
      ? JSON.stringify(system.memory)
      : '-';

    $('xrayStatus').textContent =
      data.xray?.status || 'Not Connected';

    $('xrayMessage').textContent =
      data.xray?.message ||
      'Xray Core integration is not configured yet.';

    $('panelAddress').textContent = location.host;
    $('connectionType').textContent = location.protocol.replace(':', '').toUpperCase();

  } catch (error) {
    console.error('Dashboard:', error);
  }
}

async function loadUsers() {
  $('userRows').innerHTML =
    '<tr><td colspan="6">Loading...</td></tr>';

  try {
    const result = await api('/users');
    users = Array.isArray(result) ? result : result.users || [];
    renderUsers();
  } catch (error) {
    $('userRows').innerHTML =
      `<tr><td colspan="6">${escapeHTML(error.message)}</td></tr>`;
  }
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;',
    '"':'&quot;', "'":'&#39;'
  })[char]);
}

function renderUsers() {
  if (!users.length) {
    $('userRows').innerHTML =
      '<tr><td colspan="6">No users found.</td></tr>';
    return;
  }

  $('userRows').innerHTML = users.map(user => `
    <tr>
      <td>${escapeHTML(user.username)}</td>
      <td>${escapeHTML(user.protocol)}</td>
      <td>${escapeHTML(user.uuid || user.id)}</td>
      <td>${escapeHTML(user.expiresAt || 'Unlimited')}</td>
      <td><span class="badge ${user.enabled === false ? 'off' : ''}">
        ${user.enabled === false ? 'Disabled' : 'Enabled'}
      </span></td>
      <td>
        <button class="action-btn"
          data-action="toggle" data-id="${escapeHTML(user.id)}">
          ${user.enabled === false ? 'Enable' : 'Disable'}
        </button>
        <button class="action-btn delete"
          data-action="delete" data-id="${escapeHTML(user.id)}">
          Delete
        </button>
      </td>
    </tr>
  `).join('');
}

$('userRows').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;

  const id = button.dataset.id;
  const user = users.find(item => String(item.id) === id);
  if (!user) return;

  try {
    if (button.dataset.action === 'delete') {
      if (!confirm('Delete this user record?')) return;
      await api('/users/' + encodeURIComponent(id), {
        method: 'DELETE'
      });
    }

    if (button.dataset.action === 'toggle') {
      await api('/users/' + encodeURIComponent(id), {
        method: 'PATCH',
        body: JSON.stringify({ enabled: user.enabled === false })
      });
    }

    await loadUsers();
    await loadDashboard();
  } catch (error) {
    alert(error.message);
  }
});

$('showCreate').addEventListener('click', () => {
  $('createBox').hidden = false;
});

$('cancelCreate').addEventListener('click', () => {
  $('createBox').hidden = true;
  $('userForm').reset();
});

$('userForm').addEventListener('submit', async event => {
  event.preventDefault();

  const form = new FormData(event.target);
  const date = form.get('expiresAt');

  try {
    await api('/users', {
      method: 'POST',
      body: JSON.stringify({
        username: form.get('username'),
        protocol: form.get('protocol'),
        trafficLimitGb: Number(form.get('trafficLimitGb') || 0),
        expiresAt: date || null
      })
    });

    event.target.reset();
    $('createBox').hidden = true;
    await loadUsers();
    await loadDashboard();
    alert('User record created.');
  } catch (error) {
    alert(error.message);
  }
});

$('refreshBtn').addEventListener('click', loadDashboard);
$('reloadUsers').addEventListener('click', loadUsers);

checkLogin();
