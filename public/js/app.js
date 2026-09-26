import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';

const $ = (s) => document.querySelector(s);
const app = $('#app');
let auth = null;
let firebaseUser = null;
let user = null;
let authReady = false;
let profileLoading = false;

const imageUrls = new Set();
const blobCache = new Map();
const clientApiCache = new Map();
const CLIENT_CACHE_TTL = 15000;

function invalidateClientCache() {
  clientApiCache.clear();
}

function initAmbientEffects() {
  if (document.querySelector('.ambient-dots')) return;
  const dots = document.createElement('div');
  dots.className = 'ambient-dots';
  dots.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 34; i += 1) {
    const dot = document.createElement('i');
    dot.style.setProperty('--x', `${Math.random() * 100}%`);
    dot.style.setProperty('--y', `${Math.random() * 100}%`);
    dot.style.setProperty('--delay', `${Math.random() * -8}s`);
    dot.style.setProperty('--duration', `${7 + Math.random() * 9}s`);
    dot.style.setProperty('--drift-x', `${-28 + Math.random() * 56}px`);
    dot.style.setProperty('--drift-y', `${-28 + Math.random() * 56}px`);
    dot.style.setProperty('--drift-rotate', `${-180 + Math.random() * 360}deg`);
    dot.style.setProperty('--size', `${2 + Math.random() * 4}px`);
    dots.append(dot);
  }
  document.body.append(dots);

  const scrollTop = document.createElement('button');
  scrollTop.className = 'scroll-top';
  scrollTop.type = 'button';
  scrollTop.setAttribute('aria-label', 'Scroll to top');
  scrollTop.innerHTML = '&#8593;';
  scrollTop.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  document.body.append(scrollTop);

  let rafPointer = null;
  window.addEventListener('pointermove', (event) => {
    if (rafPointer) return;
    rafPointer = requestAnimationFrame(() => {
      document.documentElement.style.setProperty('--cursor-x', `${event.clientX}px`);
      document.documentElement.style.setProperty('--cursor-y', `${event.clientY}px`);
      rafPointer = null;
    });
  }, { passive: true });
  window.addEventListener('scroll', () => scrollTop.classList.toggle('visible', window.scrollY > 280), { passive: true });
}

function initAssistant() {
  if (document.querySelector('.assistant')) return;
  const assistant = document.createElement('aside');
  assistant.className = 'assistant';
  assistant.innerHTML = '<button class="assistant-toggle" type="button" aria-label="Open FindBack assistant"><img src="/assets/ai-robot-transparent.png" alt="AI Assistant" class="assistant-bot-icon"></button><div class="assistant-panel"><div class="assistant-head"><strong><img src="/assets/ai-robot-transparent.png" alt="" class="assistant-head-icon"> FindBack assistant</strong><button class="assistant-close" type="button" aria-label="Close assistant">&times;</button></div><div class="assistant-messages"><div class="assistant-message">Ask me how to use FindBack.</div></div><form class="assistant-form"><input name="question" placeholder="Ask about FindBack" autocomplete="off" required><button class="btn primary" type="submit">Ask</button></form></div>';
  document.body.append(assistant);
  const panel = assistant.querySelector('.assistant-panel');
  const messages = assistant.querySelector('.assistant-messages');
  const addMessage = (text, className = '') => {
    const message = document.createElement('div');
    message.className = `assistant-message ${className}`.trim();
    message.textContent = text;
    messages.append(message);
    return message;
  };
  assistant.querySelector('.assistant-toggle').onclick = () => panel.classList.toggle('open');
  assistant.querySelector('.assistant-close').onclick = () => panel.classList.remove('open');
  assistant.querySelector('.assistant-form').onsubmit = async (event) => {
    event.preventDefault();
    const input = event.currentTarget.question;
    const question = input.value.trim();
    if (!question) return;
    addMessage(question, 'user-message');
    input.value = '';
    const loading = addMessage('Thinking...', 'assistant-loading');
    messages.scrollTop = messages.scrollHeight;
    try {
      const result = await apiFetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
      loading.remove();
      addMessage(result.answer);
    } catch (error) {
      loading.remove();
      addMessage(friendly(error));
    }
    messages.scrollTop = messages.scrollHeight;
  };
}

function toast(message) {
  const x = document.createElement('div');
  x.className = 'toast';
  x.textContent = message;
  document.body.append(x);
  setTimeout(() => x.remove(), 3200);
}

function friendly(error) {
  const msg = String(error?.message || error || 'Something went wrong.');
  if (msg.includes('auth/invalid-credential')) return 'Email or password is incorrect.';
  if (msg.includes('auth/email-already-in-use')) return 'That email is already registered.';
  if (msg.includes('auth/weak-password')) return 'Use a password with at least 6 characters.';
  if (msg.includes('auth/configuration-not-found')) return 'Firebase email/password sign-in is not enabled for this project.';
  return msg.replace(/^Firebase:\s*/i, '').replace(/\s*\(auth\/[^)]+\)\.?$/, '.');
}

function cleanupObjectUrls() {
  for (const url of imageUrls) URL.revokeObjectURL(url);
  imageUrls.clear();
  blobCache.clear();
  clientApiCache.clear();
}

async function boot() {
  initAmbientEffects();
  const configResponse = await fetch('/api/config');
  const config = await configResponse.json();
  if (!config.firebaseClient?.apiKey || !config.firebaseClient?.projectId) {
    app.innerHTML = `<div class="auth"><section class="authbox"><div class="brand"><span class="mark">F</span>FindBack</div><h1>Firebase setup needed</h1><p class="muted">Add Firebase web app settings to <code>.env</code>, then restart the server.</p></section></div>`;
    return;
  }

  initializeApp(config.firebaseClient);
  auth = getAuth();
  onAuthStateChanged(auth, async (currentUser) => {
    authReady = true;
    firebaseUser = currentUser;
    user = null;
    profileLoading = !!currentUser;
    cleanupObjectUrls();
    if (currentUser) initAssistant();

    if (currentUser) {
      try {
        const profile = await apiFetch('/api/profile');
        user = profile.isAdmin || profile.profileComplete || (profile.fullName && ['Student', 'Staff', 'Worker'].includes(profile.role)) ? profile : null;
        if (user) {
          const sessionKey = `fb_login_audited_${currentUser.uid}`;
          if (!sessionStorage.getItem(sessionKey)) {
            apiFetch('/api/audit/login', { method: 'POST' })
              .then(() => sessionStorage.setItem(sessionKey, '1'))
              .catch((err) => console.warn('Login audit recording failed:', err));
          }
        }
      } catch (error) {
        console.error('Profile initialization failed:', error);
        if (location.hash !== '#/login' && location.hash !== '#/register') toast(friendly(error));
      } finally {
        profileLoading = false;
      }
    }

    route();
  });
}

async function getToken(forceRefresh = false) {
  if (!firebaseUser) return null;
  return firebaseUser.getIdToken(forceRefresh);
}

async function apiFetch(path, options = {}, retry = true) {
  if (!authReady) await new Promise((resolve) => {
    const off = onAuthStateChanged(auth, () => {
      off();
      resolve();
    });
  });

  if (!firebaseUser) {
    location.hash = '#/login';
    throw new Error('Please sign in to continue.');
  }

  const method = (options.method || 'GET').toUpperCase();
  const isGet = method === 'GET';

  if (!isGet) {
    invalidateClientCache();
  } else if (!options.skipCache && !path.includes('/api/notifications') && !path.includes('/api/assistant')) {
    const cached = clientApiCache.get(path);
    if (cached && Date.now() < cached.expiry) {
      return (typeof structuredClone === 'function') ? structuredClone(cached.data) : JSON.parse(JSON.stringify(cached.data));
    }
  }

  const token = await getToken(false);
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401 && retry) {
    const fresh = await getToken(true);
    const retryResponse = await fetch(path, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${fresh}`,
      },
    });
    const result = await parseResponse(retryResponse);
    if (isGet && !options.skipCache && !path.includes('/api/notifications') && !path.includes('/api/assistant') && result && !(result instanceof Blob)) {
      clientApiCache.set(path, { data: result, expiry: Date.now() + CLIENT_CACHE_TTL });
    }
    return result;
  }

  const result = await parseResponse(response);
  if (isGet && !options.skipCache && !path.includes('/api/notifications') && !path.includes('/api/assistant') && result && !(result instanceof Blob)) {
    clientApiCache.set(path, { data: result, expiry: Date.now() + CLIENT_CACHE_TTL });
  }
  return result;
}

async function parseResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.blob();
  if (!response.ok) {
    if (response.status === 401) location.hash = '#/login';
    throw new Error(data?.error || `Request failed with status ${response.status}.`);
  }
  return data;
}

async function fetchPrivateBlob(path) {
  const token = await getToken(false);
  let response = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401) {
    const fresh = await getToken(true);
    response = await fetch(path, { headers: { Authorization: `Bearer ${fresh}` } });
  }
  if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
  return response.blob();
}

async function resolveImage(report) {
  if (!report?.imageUrl) return report;
  if (blobCache.has(report.imageUrl)) {
    return { ...report, imageUrl: blobCache.get(report.imageUrl) };
  }
  try {
    const blob = await fetchPrivateBlob(report.imageUrl);
    const objectUrl = URL.createObjectURL(blob);
    imageUrls.add(objectUrl);
    blobCache.set(report.imageUrl, objectUrl);
    return { ...report, imageUrl: objectUrl };
  } catch (error) {
    console.error('Image loading failed:', error);
    return { ...report, imageUrl: null, imageUnavailable: true };
  }
}

async function resolveImages(reports) {
  return Promise.all((reports || []).map(resolveImage));
}

function loadPendingImages(container = document) {
  const pending = container.querySelectorAll('img[data-img-src]');
  pending.forEach(async (img) => {
    const src = img.getAttribute('data-img-src');
    if (!src) return;
    if (blobCache.has(src)) {
      img.src = blobCache.get(src);
      img.removeAttribute('data-img-src');
      return;
    }
    try {
      const blob = await fetchPrivateBlob(src);
      const objectUrl = URL.createObjectURL(blob);
      imageUrls.add(objectUrl);
      blobCache.set(src, objectUrl);
      img.src = objectUrl;
      img.removeAttribute('data-img-src');
    } catch {
      img.replaceWith(Object.assign(document.createElement('div'), {
        className: img.className.includes('tall') ? 'image-placeholder tall' : 'image-placeholder',
        textContent: 'Image unavailable',
      }));
    }
  });
}

async function downloadPdf(id) {
  const blob = await fetchPrivateBlob(`/api/reports/${encodeURIComponent(id)}/pdf`);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `FindBack_Report_${id}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function statusLabel(status = 'active') {
  return status.replace(/_/g, ' ');
}

function passwordIcon(visible) {
  return visible
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.7 10.7 0 0 1 12 4c5 0 8.7 4 10 8-.5 1.5-1.4 2.9-2.6 4.1M6.7 6.7C4.8 8 3.5 10 2 12c1.3 4 5 8 10 8 1.1 0 2.2-.2 3.2-.6"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
}

function layout(title, body, active = 'dashboard') {
  const isAdmin = !!user?.isAdmin;
  const nav = isAdmin
    ? [['dashboard', 'Dashboard'], ['admin', 'Admin Panel'], ['search', 'Search Items'], ['notifications', 'Notifications']]
    : [['dashboard', 'Dashboard'], ['report-lost', 'Report Lost'], ['report-found', 'Report Found'], ['reports', 'My Reports'], ['search', 'Search'], ['notifications', 'Notifications']];
  const notificationMark = (k) => k === 'notifications' ? '<span class="notification-badge" hidden></span>' : '';
  const backDashboard = active === 'dashboard' ? '' : '<a class="back-dashboard" href="#/dashboard">&larr; Back</a>';
  setTimeout(refreshNotificationBadge, 0);
  return `<div class="shell"><aside class="side"><div class="brand"><span class="mark">F</span>FindBack</div><nav class="nav">${nav.map(([k, t]) => `<a class="${active === k ? 'active' : ''}" href="#/${k}">${t}${notificationMark(k)}</a>`).join('')}</nav><div class="account"><div class="muted small">${user?.fullName || firebaseUser?.email || 'User'} · ${user?.role || (isAdmin ? 'Admin' : 'Profile needed')}</div><button class="btn" id="logout">Sign out</button></div></aside><main class="main"><div class="mobile-nav">${nav.map(([k, t]) => `<a class="btn" href="#/${k}">${t}${notificationMark(k)}</a>`).join('')}</div><div class="top"><div>${backDashboard}<div class="eyebrow">Campus Lost & Found</div><h1>${title}</h1></div></div>${body}</main></div>`;
}

async function refreshNotificationBadge() {
  if (!firebaseUser) return;
  try {
    const notifications = await apiFetch('/api/notifications');
    const unread = notifications.filter((notification) => !notification.read).length;
    document.querySelectorAll('.notification-badge').forEach((badge) => {
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.hidden = unread === 0;
    });
  } catch (error) {
    console.error('Notification badge failed:', error);
  }
}

function bindLogout() {
  const b = $('#logout');
  if (b) b.onclick = async () => {
    if (firebaseUser) sessionStorage.removeItem(`fb_login_audited_${firebaseUser.uid}`);
    await signOut(auth);
    location.hash = '#/login';
  };
}

function authPage(mode = 'login') {
  app.innerHTML = `<div class="auth"><section class="authbox"><div class="brand"><span class="mark">F</span>FindBack</div><div class="eyebrow">Secure campus recovery</div><h1>${mode === 'login' ? 'Welcome back' : 'Create your account'}</h1><p class="muted">${mode === 'login' ? 'Sign in with your campus email and password.' : 'Create your Firebase account and FindBack profile.'}</p><form id="auth-form" class="fields"><div class="field full"><label>Email</label><input id="email" type="email" autocomplete="email" required></div><div class="field full"><label>Password</label><div class="password-field"><input id="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required><button class="password-toggle" id="password-toggle" type="button" aria-label="Show password">Show</button></div></div>${mode === 'register' ? '<div class="field"><label>Full name</label><input id="name" required></div><div class="field"><label>Role</label><select id="role"><option>Student</option><option>Staff</option><option>Worker</option></select></div><div class="field"><label>Mobile number</label><input id="phone" type="tel"></div><div class="field"><label>Department</label><input id="department"></div><div class="field full"><label>Campus ID</label><input id="campusId"></div>' : ''}<button class="btn primary full-button" type="submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button></form><p class="muted center">${mode === 'login' ? 'Need an account? <a href="#/register">Register</a>' : 'Already registered? <a href="#/login">Login</a>'}</p></section></div>`;

  const authSurface = $('.auth');
  authSurface.classList.add('auth-page');
  const doodles = document.createElement('div');
  doodles.className = 'auth-doodles';
  doodles.setAttribute('aria-hidden', 'true');
  doodles.innerHTML = '<i class="doodle pencil pencil-one"></i><i class="doodle pencil pencil-two"></i><i class="doodle ruler"></i><i class="doodle notebook"></i><i class="doodle calculator"></i><i class="doodle paperclip"></i><i class="doodle eraser"></i><i class="doodle book"></i><i class="doodle pen"></i><i class="doodle scissors"></i><i class="doodle sticky sticky-one"></i><i class="doodle sticky sticky-two"></i><i class="doodle star star-one">✦</i><i class="doodle star star-two">✧</i><i class="doodle circle circle-one"></i><i class="doodle circle circle-two"></i><i class="doodle circle circle-three"></i><i class="doodle line line-one"></i><i class="doodle line line-two"></i><i class="doodle line line-three"></i>';
  authSurface.prepend(doodles);

  $('#password-toggle').innerHTML = passwordIcon(false);
  $('#password-toggle').onclick = () => {
    const password = $('#password');
    const visible = password.type === 'text';
    password.type = visible ? 'password' : 'text';
    $('#password-toggle').innerHTML = passwordIcon(visible);
    $('#password-toggle').setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
  };

  if (mode === 'login') {
    $('.full-button').classList.add('auth-signin-button');
    const reset = document.createElement('button');
    reset.className = 'password-reset';
    reset.type = 'button';
    reset.textContent = 'Forgot password?';
    $('#password').closest('.field').append(reset);
    reset.onclick = async () => {
      const email = $('#email').value.trim();
      if (!email) return toast('Enter your email first.');
      try {
        await sendPasswordResetEmail(auth, email);
        toast('Password reset email sent.');
      } catch (error) {
        toast(friendly(error));
      }
    };
  }

  $('#auth-form').onsubmit = async (event) => {
    event.preventDefault();
    try {
      const email = $('#email').value.trim();
      const password = $('#password').value;
      if (mode === 'login') {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        sessionStorage.removeItem(`fb_login_audited_${cred.user.uid}`);
      } else {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        firebaseUser = cred.user;
        user = await apiFetch('/api/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullName: $('#name').value.trim(),
            role: $('#role').value,
            phoneNumber: $('#phone').value.trim(),
            department: $('#department').value.trim(),
            campusId: $('#campusId').value.trim(),
          }),
        });
      }
      location.hash = '#/dashboard';
    } catch (error) {
      toast(friendly(error));
    }
  };
}

function profilePage() {
  app.innerHTML = layout('Complete Profile', `<form class="card form" id="profile-form"><p class="muted">Finish your FindBack profile before using protected workflows.</p><div class="fields"><div class="field"><label>Full name</label><input id="name" value="${user?.fullName || ''}" required></div><div class="field"><label>Role</label><select id="role"><option>Student</option><option>Staff</option><option>Worker</option></select></div><div class="field"><label>Mobile number</label><input id="phone" type="tel" value="${user?.phoneNumber || ''}"></div><div class="field"><label>Department</label><input id="department" value="${user?.department || ''}"></div><div class="field full"><label>Campus ID</label><input id="campusId" value="${user?.campusId || ''}"></div></div><button class="btn primary" type="submit">Save profile</button></form>`);
  $('#role').value = user?.role || 'Student';
  $('#profile-form').onsubmit = async (event) => {
    event.preventDefault();
    try {
      const savedProfile = await apiFetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: $('#name').value.trim(),
          role: $('#role').value,
          phoneNumber: $('#phone').value.trim(),
          department: $('#department').value.trim(),
          campusId: $('#campusId').value.trim(),
        }),
      });
      user = savedProfile.profileComplete || (savedProfile.fullName && ['Student', 'Staff', 'Worker'].includes(savedProfile.role)) ? savedProfile : null;
      toast(user ? 'Profile saved.' : 'Please add your full name to continue.');
      if (!user) return;
      location.hash = '#/dashboard';
    } catch (error) {
      toast(friendly(error));
    }
  };
  bindLogout();
}

function profileLoadingPage() {
  app.innerHTML = '<div class="auth"><section class="authbox loading-box"><div class="brand"><span class="mark">F</span>FindBack</div><div class="eyebrow">Secure campus recovery</div><h1>Loading your dashboard</h1><p class="muted">Checking your profile...</p><div class="loading-line" aria-hidden="true"></div></section></div>';
}

function card(r) {
  const cachedUrl = r.imageUrl ? (blobCache.get(r.imageUrl) || (r.imageUrl.startsWith('blob:') ? r.imageUrl : null)) : null;
  const imgHtml = cachedUrl
    ? `<img src="${cachedUrl}" alt="${r.itemName}" loading="lazy">`
    : (r.imageUrl
        ? `<img data-img-src="${r.imageUrl}" alt="${r.itemName}" class="lazy-image" loading="lazy">`
        : '<div class="image-placeholder">Image unavailable</div>');
  return `<article class="report row-card"><div>${imgHtml}</div><div><div class="split"><b>${r.itemName}</b><span class="badge ${r.status}">${statusLabel(r.status)}</span></div><div class="muted">${r.type} · ${r.category || 'Uncategorized'} · ${r.location || 'Location not set'}</div><div class="muted small">${r.brand || 'No brand'} · ${r.color || 'No color'} · ${r.date || 'No date'}</div><p class="report-description">${r.description || 'No description provided.'}</p><div class="muted small">${r.matchScore || 0}% match</div><a href="#/detail?id=${r.id}" class="btn compact">View</a></div></article>`;
}

async function dashboard() {
  if (user?.isAdmin) {
    let stats = { users: 0, lost: 0, found: 0, active: 0, possibleMatch: 0, confirmed: 0, returned: 0, resolved: 0, removed: 0 };
    let notifications = [];
    try {
      [stats, notifications] = await Promise.all([
        apiFetch('/api/admin/stats'),
        apiFetch('/api/notifications'),
      ]);
    } catch (error) {
      console.error('Admin dashboard stats failed:', error);
    }

    app.innerHTML = layout('Administrator Dashboard', `
      <div class="hero">
        <div class="eyebrow">Campus Control Center 🛡️</div>
        <h2>Administrator Overview</h2>
        <p class="muted">System status, user management, item moderation, and login audits at a glance.</p>
        <div class="actions">
          <a class="btn primary" href="#/admin?tab=items">Moderate Items</a>
          <a class="btn" href="#/admin?tab=users">Manage Users</a>
          <a class="btn" href="#/admin?tab=audits">View Login Audits</a>
          <a class="btn" href="#/search">Search All Items</a>
        </div>
      </div>
      <div class="grid stats personal-stats">
        <div class="card stat"><span>Registered Users</span><b>${stats.users}</b></div>
        <div class="card stat"><span>Lost Items</span><b>${stats.lost}</b></div>
        <div class="card stat"><span>Found Items</span><b>${stats.found}</b></div>
        <div class="card stat"><span>Active Listings</span><b>${stats.active}</b></div>
        <div class="card stat"><span>Possible Matches</span><b>${stats.possibleMatch}</b></div>
        <div class="card stat"><span>Items Resolved</span><b>${stats.resolved}</b></div>
        <div class="card stat"><span>Removed Items</span><b>${stats.removed}</b></div>
      </div>
      <section class="card section-gap">
        <div class="section-heading">
          <div>
            <div class="eyebrow">${notifications.length} updates</div>
            <h2>Admin Notifications Feed</h2>
          </div>
          <a class="btn compact" href="#/notifications">Open All</a>
        </div>
        ${notifications.slice(0, 6).map((x) => `
          <a class="notice" href="${x.reportId ? `#/detail?id=${x.reportId}` : '#/notifications'}">
            <b>${x.title}</b>
            <div class="muted">${x.message}</div>
            <div class="muted small">${x.createdAt ? new Date(x.createdAt).toLocaleString() : ''}</div>
          </a>
        `).join('') || '<div class="empty">No administrative alerts yet.</div>'}
      </section>
    `, 'dashboard');
    bindLogout();
    return;
  }

  const [mine, notifications] = await Promise.all([
    apiFetch('/api/reports?mine=true').catch(() => []),
    apiFetch('/api/notifications').catch((error) => {
      console.error('Dashboard notifications failed:', error);
      return [];
    }),
  ]);
  const mineLost = mine.filter((x) => x.type === 'lost');
  const mineFound = mine.filter((x) => x.type === 'found');
  const mineActive = mine.filter((x) => x.status === 'active');
  const minePossible = mine.filter((x) => x.status === 'possible_match');
  const mineConfirmed = mine.filter((x) => x.status === 'confirmed_match');
  const mineReturned = mine.filter((x) => ['return_pending', 'resolved'].includes(x.status));
  const mineResolved = mine.filter((x) => x.status === 'resolved');
  app.innerHTML = layout('Dashboard', `<div class="hero"><div class="eyebrow">Hi ${user?.fullName || 'there'} 👋</div><h2>Recover what matters.</h2><p class="muted">Your reports, matches, and returns at a glance.</p><div class="actions"><a class="btn primary" href="#/report?type=lost">Report Lost</a><a class="btn" href="#/report?type=found">Report Found</a><a class="btn" href="#/search">Search</a></div></div><div class="grid stats personal-stats"><div class="card stat"><span>Total lost</span><b>${mineLost.length}</b></div><div class="card stat"><span>Total found</span><b>${mineFound.length}</b></div><div class="card stat"><span>Active reports</span><b>${mineActive.length}</b></div><div class="card stat"><span>Possible matches</span><b>${minePossible.length}</b></div><div class="card stat"><span>Confirmed matches</span><b>${mineConfirmed.length}</b></div><div class="card stat"><span>Returned</span><b>${mineReturned.length}</b></div><div class="card stat"><span>Items resolved</span><b>${mineResolved.length}</b></div></div><div class="grid two section-gap dashboard-sections"><section class="card report-section"><div class="section-heading"><div><div class="eyebrow">${mineLost.length} total</div><h2>Lost items</h2></div><a class="btn compact" href="#/reports">View all</a></div>${mineLost.slice(0, 4).map(card).join('') || '<div class="empty">No lost items reported.</div>'}</section><section class="card report-section"><div class="section-heading"><div><div class="eyebrow">${mineFound.length} total</div><h2>Found items</h2></div><a class="btn compact" href="#/reports">View all</a></div>${mineFound.slice(0, 4).map(card).join('') || '<div class="empty">No found items reported.</div>'}</section></div><section class="card section-gap recent-reports"><div class="section-heading"><div><div class="eyebrow">${mine.length} total</div><h2>Recent reports</h2></div><a class="btn compact" href="#/reports">View all</a></div>${mine.slice(0, 8).map(card).join('') || '<div class="empty">No reports yet.</div>'}</section><section class="card section-gap"><div class="section-heading"><div><div class="eyebrow">${notifications.length} updates</div><h2>Notifications</h2></div><a class="btn compact" href="#/notifications">Open</a></div>${notifications.slice(0, 4).map((x) => `<a class="notice" href="#/detail?id=${x.reportId || ''}"><b>${x.title}</b><div class="muted">${x.message}</div></a>`).join('') || '<div class="empty">You are all caught up.</div>'}</section>`);
  loadPendingImages();
  bindLogout();
}

async function report(typeOverride = null) {
  if (user?.isAdmin) {
    toast('Administrators cannot report lost or found items.');
    location.hash = '#/admin';
    return;
  }
  const type = typeOverride || new URLSearchParams(location.hash.split('?')[1] || '').get('type') || 'lost';
  const active = type === 'lost' ? 'report-lost' : 'report-found';
  app.innerHTML = layout(type === 'lost' ? 'Report Lost Item' : 'Report Found Item', `<form class="card form" id="form"><div class="fields"><div class="field"><label>Item name *</label><input name="itemName" required placeholder="e.g. Blue water bottle"></div><div class="field"><label>Category</label><select name="category"><option>Electronics</option><option>Documents</option><option>Accessories</option><option>Stationery</option><option>Clothing</option><option>Other</option></select></div><div class="field"><label>Brand</label><input name="brand"></div><div class="field"><label>Color</label><input name="color"></div><div class="field full"><label>Description</label><textarea name="description" rows="4" placeholder="Describe visible and distinctive details"></textarea></div><div class="field"><label>Location</label><select id="location-type" name="locationType"><option value="Main Gate">Main Gate</option><option value="Library">Library</option><option value="Cafeteria">Cafeteria</option><option value="Classroom Block">Classroom Block</option><option value="Hostel">Hostel</option><option value="Parking Area">Parking Area</option><option value="Sports Ground">Sports Ground</option><option value="Other">Other</option></select><input id="custom-location" class="location-custom" name="customLocation" placeholder="Enter location" hidden></div><div class="field"><label>Date</label><input type="date" name="date"></div><div class="field"><label>Approximate time</label><input type="time" name="approxTime"></div><div class="field"><label>Additional information</label><input name="additionalInfo"></div><div class="field full"><label>Image (JPG, PNG, WEBP)</label><div class="drop"><input id="image" type="file" name="image" accept="image/jpeg,image/png,image/webp"><div class="muted">Images stay private and load through the authenticated image proxy.</div><img id="preview" hidden alt="Image preview"></div></div></div><button class="btn primary" type="submit">Submit ${type} report</button></form>`, active);
  document.querySelector('input[name="approxTime"]')?.closest('.field')?.remove();
  document.querySelector('input[name="additionalInfo"]')?.closest('.field')?.remove();
  document.querySelector('.drop .muted')?.remove();
  const locationType = $('#location-type');
  ['OAT', 'IT Block', 'Auditorium'].forEach((location) => {
    const option = document.createElement('option');
    option.value = location;
    option.textContent = location;
    locationType.insertBefore(option, locationType.lastElementChild);
  });
  $('#location-type').onchange = (event) => {
    const customLocation = $('#custom-location');
    customLocation.hidden = event.target.value !== 'Other';
    customLocation.required = event.target.value === 'Other';
    if (!customLocation.required) customLocation.value = '';
  };
  $('#image').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
      toast('Please upload a JPG, PNG, or WEBP image.');
      e.target.value = '';
      return;
    }
    const p = $('#preview');
    p.src = URL.createObjectURL(f);
    p.hidden = false;
  };
  $('#form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const selectedLocation = fd.get('locationType');
    fd.set('location', selectedLocation === 'Other' ? String(fd.get('customLocation') || '').trim() : selectedLocation);
    fd.append('type', type);
    try {
      await apiFetch('/api/reports', { method: 'POST', body: fd });
      toast('Report submitted and matching started.');
      setTimeout(() => { location.hash = '#/reports'; }, 500);
    } catch (error) {
      toast(friendly(error));
    }
  };
  bindLogout();
}

async function reports() {
  if (user?.isAdmin) {
    location.hash = '#/admin?tab=items';
    return;
  }
  const reportsWithImages = await apiFetch('/api/reports?mine=true');
  app.innerHTML = layout('My Reports', `<div class="toolbar"><a class="btn primary" href="#/report?type=lost">Report Lost</a><a class="btn" href="#/report?type=found">Report Found</a><select id="filter"><option value="all">All</option><option value="lost">Lost</option><option value="found">Found</option><option value="active">Active</option><option value="possible_match">Possible Match</option><option value="confirmed_match">Confirmed</option><option value="return_pending">Return Pending</option><option value="resolved">Resolved</option><option value="removed">Removed</option></select></div><div id="report-list" class="grid reports"></div>`, 'reports');
  const render = () => {
    const f = $('#filter').value;
    const visible = reportsWithImages.filter((x) => f === 'all' || x.type === f || x.status === f);
    $('#report-list').innerHTML = visible.map((x) => {
      const cachedUrl = x.imageUrl ? (blobCache.get(x.imageUrl) || (x.imageUrl.startsWith('blob:') ? x.imageUrl : null)) : null;
      const imgHtml = cachedUrl
        ? `<img src="${cachedUrl}" alt="${x.itemName}" loading="lazy">`
        : (x.imageUrl
            ? `<img data-img-src="${x.imageUrl}" alt="${x.itemName}" class="lazy-image tall" loading="lazy">`
            : '<div class="image-placeholder tall">Image unavailable</div>');
      return `<div class="card report-card">${imgHtml}<div class="split"><b>${x.itemName}</b><span class="badge ${x.status}">${statusLabel(x.status)}</span></div><p class="muted">${x.type} · ${x.category || 'Uncategorized'} · ${x.location || 'Location not set'}</p><p class="muted">Match: ${x.matchScore || 0}%</p><div class="actions"><a class="btn" href="#/detail?id=${x.id}">View</a><button class="btn" onclick="removeReport('${x.id}')">Remove</button><button class="btn" onclick="downloadPdf('${x.id}').catch(e=>toast(e.message))">Download</button></div></div>`;
    }).join('') || '<div class="empty">No reports in this filter.</div>';
    loadPendingImages($('#report-list'));
  };
  $('#filter').onchange = render;
  render();
  bindLogout();
}

let currentSearchRun = null;

async function removeReport(id, callback) {
  if (!confirm('Are you sure you want to remove this report? This will hide it from public listings and safely cancel any active matches.')) return;
  try {
    await apiFetch(`/api/reports/${id}/remove`, { method: 'POST' });
    toast('Report removed.');
    if (typeof callback === 'function') {
      callback();
    } else if (typeof callback === 'string' && typeof window[callback] === 'function') {
      window[callback]();
    } else if (location.hash.includes('detail')) {
      detail();
    } else if (location.hash.includes('admin')) {
      admin();
    } else if (location.hash.includes('search')) {
      if (typeof currentSearchRun === 'function') currentSearchRun();
      else search();
    } else {
      reports();
    }
  } catch (error) {
    toast(friendly(error));
  }
}

window.removeReport = removeReport;
window.downloadPdf = downloadPdf;
window.toast = toast;

async function detail() {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  const r = await resolveImage(await apiFetch(`/api/reports/${id}`));
  const contact = r.contact;
  const isAdm = !!user?.isAdmin;

  const ownerHtml = isAdm && r.owner ? `
    <div class="section-gap" style="border-top: 1px solid var(--line); padding-top: 14px;">
      <h3 style="margin-bottom: 8px;">Item Submitter Details</h3>
      <div style="font-size: 13px; display: grid; gap: 4px;">
        <div><b>Name:</b> ${r.owner.fullName || 'Not provided'}</div>
        <div><b>Email:</b> ${r.owner.email || 'Not provided'}</div>
        <div><b>Phone:</b> ${r.owner.phoneNumber || 'Not provided'}</div>
        <div><b>Role:</b> <span class="badge ${r.owner.role === 'Admin' ? 'active' : 'possible_match'}">${r.owner.role}</span></div>
        <div><b>Department:</b> ${r.owner.department || 'Not provided'}</div>
        <div><b>Campus ID:</b> ${r.owner.campusId || 'Not provided'}</div>
        <div><b>Account:</b> <span class="badge ${r.owner.accountStatus === 'removed' ? 'removed' : 'active'}">${r.owner.accountStatus || 'active'}</span></div>
      </div>
    </div>
  ` : '';

  const adminRemoveBtn = (isAdm || r.ownerUid === user?.uid)
    ? (r.status !== 'removed'
        ? `<button class="btn danger" id="detail-remove-btn" type="button" onclick="removeReport('${r.id}')">Remove Item</button>`
        : '<span class="badge removed">Item Removed</span>')
    : '';

  app.innerHTML = layout('Report Details', `
    <div class="grid two">
      <section class="card">
        ${r.imageUrl ? `<img src="${r.imageUrl}" alt="${r.itemName}" class="detail-img" onerror="this.outerHTML='<div class=empty>Image unavailable</div>'">` : '<div class="empty">Image unavailable</div>'}
        <div class="split detail-title">
          <h2>${r.itemName}</h2>
          <span class="badge ${r.status}">${statusLabel(r.status)}</span>
        </div>
        <p class="muted">${r.type} · ${r.category || 'Uncategorized'} · ${r.brand || 'No brand'} · ${r.color || 'No color'}</p>
        <p>${r.description || 'No description.'}</p>
        <p class="muted">${r.location || 'Location not provided'} · ${r.date || 'Date not provided'} · ${r.approxTime || ''}</p>
        <p>${r.additionalInfo || ''}</p>
        <div class="actions">
          <button class="btn" onclick="downloadPdf('${r.id}').catch(e=>toast(e.message))">Download PDF</button>
          <button class="btn" onclick="window.print()">Print</button>
          ${adminRemoveBtn}
        </div>
        ${ownerHtml}
      </section>
      <section class="card">
        <h2>Match analysis</h2>
        <div class="score">${r.matchScore || 0}%</div>
        <p class="muted">${r.matchExplanation || 'No possible match currently.'}</p>
        <div>${(r.matchingFactors || []).map((x) => `<span class="badge active factor">${x}</span>`).join('')}</div>
        ${!isAdm && r.status === 'possible_match' ? '<div class="actions section-gap"><button class="btn success" id="confirm">Confirm match</button><button class="btn danger" id="reject">Not a match</button></div>' : ''}
        ${['confirmed_match', 'return_pending'].includes(r.status) ? `
          <div class="contact section-gap">
            ${contact ? `<b>${contact.fullName || 'Matched user'}</b><div class="muted">${contact.phoneNumber || 'No mobile number on profile.'}</div>${contact.phoneNumber ? `<div class="actions small-gap"><button class="btn" onclick="navigator.clipboard.writeText('${contact.phoneNumber}');toast('Phone copied')">Copy</button><a class="btn" href="tel:${contact.phoneNumber}">Call</a></div>` : '<div class="muted">No phone number available.</div>'}` : 'Contact unlocks only after both confirmations.'}
          </div>
          ${!isAdm ? '<div class="actions section-gap"><button class="btn primary" id="returned">Mark Item Returned</button></div>' : ''}
        ` : ''}
        <h2 class="section-gap">Timeline</h2>
        <div class="timeline">${['Report submitted', r.imageKey ? 'Image uploaded' : null, r.status === 'possible_match' ? 'Possible match' : null, ['confirmed_match', 'return_pending', 'resolved'].includes(r.status) ? 'Match confirmed' : null, r.status === 'return_pending' ? 'Return pending' : null, r.status === 'resolved' ? 'Resolved' : null, r.status === 'removed' ? 'Removed' : null].filter(Boolean).map((x) => `<div class="event"><b>${x}</b><span class="muted">Recorded in FindBack workflow</span></div>`).join('')}</div>
      </section>
    </div>
  `, isAdm ? 'admin' : 'reports');

  if ($('#confirm')) $('#confirm').onclick = () => confirmMatch(id, true);
  if ($('#reject')) $('#reject').onclick = () => confirmMatch(id, false);
  if ($('#returned')) $('#returned').onclick = () => markReturned(id);
  const removeBtn = $('#detail-remove-btn');
  if (removeBtn) removeBtn.onclick = () => removeReport(id);
  bindLogout();
}

async function confirmMatch(id, confirmed) {
  try {
    await apiFetch(`/api/reports/${id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed }) });
    toast(confirmed ? 'Match confirmation recorded.' : 'Match rejected.');
    detail();
  } catch (error) {
    toast(friendly(error));
  }
}

async function markReturned(id) {
  try {
    await apiFetch(`/api/reports/${id}/return`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnDate: new Date().toISOString().slice(0, 10) }) });
    toast('Return confirmation recorded.');
    detail();
  } catch (error) {
    toast(friendly(error));
  }
}

async function search() {
  const isAdm = !!user?.isAdmin;
  const statusOptions = isAdm ? '<option value="removed">Removed</option>' : '';
  app.innerHTML = layout('Search Reports', `<div class="toolbar"><input id="q" placeholder="Keyword"><select id="category"><option value="">All categories</option><option>Electronics</option><option>Documents</option><option>Accessories</option><option>Stationery</option><option>Clothing</option><option>Other</option></select><input id="brand" placeholder="Brand"><input id="color" placeholder="Color"><input id="location" placeholder="Location"><input id="dateFrom" type="date"><input id="dateTo" type="date"><select id="type"><option value="">All types</option><option value="lost">Lost</option><option value="found">Found</option></select><select id="status"><option value="">All statuses</option><option value="active">Active</option><option value="possible_match">Possible Match</option><option value="confirmed_match">Confirmed</option><option value="return_pending">Return Pending</option><option value="resolved">Resolved</option>${statusOptions}</select><select id="sort"><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="relevance">Relevance</option></select><button class="btn primary" id="go">Search</button></div><div id="results" class="grid reports"></div>`, 'search');
  const run = async () => {
    currentSearchRun = run;
    const qs = new URLSearchParams({ keyword: $('#q').value, category: $('#category').value, brand: $('#brand').value, color: $('#color').value, location: $('#location').value, dateFrom: $('#dateFrom').value, dateTo: $('#dateTo').value, type: $('#type').value, status: $('#status').value, sort: $('#sort').value });
    const results = await apiFetch(`/api/search?${qs}`);
    $('#results').innerHTML = results.map((x) => {
      const cachedUrl = x.imageUrl ? (blobCache.get(x.imageUrl) || (x.imageUrl.startsWith('blob:') ? x.imageUrl : null)) : null;
      const imgHtml = cachedUrl
        ? `<img src="${cachedUrl}" alt="${x.itemName}" loading="lazy">`
        : (x.imageUrl
            ? `<img data-img-src="${x.imageUrl}" alt="${x.itemName}" class="lazy-image tall" loading="lazy">`
            : '<div class="image-placeholder tall">Image unavailable</div>');
      return `
        <div class="card report-card">
          ${imgHtml}
          <h3>${x.itemName}</h3>
          <p class="muted">${x.type} · ${x.category || 'Uncategorized'} · ${x.location || 'Location not set'}</p>
          <span class="badge ${x.status}">${statusLabel(x.status)}</span>
          <div class="actions" style="margin-top: 10px;">
            <a class="btn" href="#/detail?id=${x.id}">View</a>
            ${isAdm && x.status !== 'removed' ? `<button class="btn danger" onclick="removeReport('${x.id}')">Remove</button>` : ''}
          </div>
        </div>
      `;
    }).join('') || '<div class="empty">No matching reports.</div>';
    loadPendingImages($('#results'));
  };
  $('#go').onclick = () => run().catch((error) => toast(friendly(error)));
  run().catch((error) => toast(friendly(error)));
  bindLogout();
}

async function notifications() {
  let n = [];
  try {
    n = await apiFetch('/api/notifications');
  } catch (error) {
    console.error('Notifications failed:', error);
    toast(friendly(error));
  }
  app.innerHTML = layout('Notifications', `<div class="toolbar"><button class="btn primary" id="all-read">Mark all read</button></div><div class="card">${n.map((x) => `<div class="notice-row"><div class="split"><b>${x.title}</b><span class="badge ${x.read ? 'active' : 'possible_match'}">${x.read ? 'Read' : 'New'}</span></div><p class="muted">${x.message}</p><div class="muted small">${x.createdAt ? new Date(x.createdAt).toLocaleString() : ''}</div><div class="actions" style="margin-top: 6px;"><button class="btn compact" onclick="readN('${x.id}')">Mark read</button>${x.reportId ? `<a class="btn compact" href="#/detail?id=${x.reportId}">Open report</a>` : ''}</div></div>`).join('') || '<div class="empty">No notifications.</div>'}</div>`, 'notifications');
  $('#all-read').onclick = async () => {
    await apiFetch('/api/notifications/read-all', { method: 'POST' });
    notifications();
  };
  bindLogout();
}

window.readN = async (id) => {
  await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
  notifications();
};

window.showUserModal = (data) => {
  const existing = document.querySelector('.user-modal-overlay');
  if (existing) existing.remove();

  const u = data.user;
  const reports = data.reports || [];
  const logins = data.loginHistory || [];

  const overlay = document.createElement('div');
  overlay.className = 'user-modal-overlay';
  overlay.innerHTML = `
    <div class="card user-modal">
      <div class="split">
        <div>
          <h2>${u.fullName || 'User Details'}</h2>
          <div class="muted">${u.email} · <span class="badge ${u.isAdmin ? 'active' : 'possible_match'}">${u.role}</span></div>
        </div>
        <button class="btn compact" id="close-user-modal">&times; Close</button>
      </div>
      <div class="fields section-gap" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));">
        <div><b>Phone:</b> ${u.phoneNumber || 'Not provided'}</div>
        <div><b>Campus ID:</b> ${u.campusId || 'Not provided'}</div>
        <div><b>Department:</b> ${u.department || 'Not provided'}</div>
        <div><b>Account Status:</b> <span class="badge ${u.accountStatus === 'removed' ? 'removed' : 'active'}">${u.accountStatus || 'active'}</span></div>
        <div><b>Joined Date:</b> ${u.createdAt ? new Date(u.createdAt).toLocaleString() : 'N/A'}</div>
        <div><b>Total Reports:</b> ${reports.length}</div>
      </div>
      <h3 class="section-gap" style="margin-top: 20px;">Submitted Items (${reports.length})</h3>
      <div class="user-reports-list" style="max-height: 200px; overflow-y: auto;">
        ${reports.map((r) => `
          <div class="notice-row split" style="padding: 8px 0;">
            <div>
              <b>${r.itemName}</b> (${r.type})
              <div class="muted small">${r.location || 'Location not set'} · ${r.date || 'No date'}</div>
            </div>
            <div class="actions">
              <span class="badge ${r.status}">${statusLabel(r.status)}</span>
              <a class="btn compact" href="#/detail?id=${r.id}" onclick="document.querySelector('.user-modal-overlay')?.remove()">View</a>
              ${r.status !== 'removed' ? `<button class="btn compact danger" onclick="removeReport('${r.id}', () => { document.querySelector('.user-modal-overlay')?.remove(); admin(); })">Remove</button>` : ''}
            </div>
          </div>
        `).join('') || '<div class="muted">No reports submitted by this user.</div>'}
      </div>
      <h3 class="section-gap" style="margin-top: 20px;">Recent Login History</h3>
      <div class="user-logins-list" style="max-height: 180px; overflow-y: auto;">
        ${logins.slice(0, 10).map((l) => `
          <div class="notice-row split" style="padding: 8px 0;">
            <div>
              <b>${new Date(l.timestamp).toLocaleString()}</b>
              <div class="muted small">IP: <code>${l.ip || 'Unknown'}</code> · ${l.userAgent || ''}</div>
            </div>
          </div>
        `).join('') || '<div class="muted">No login history recorded yet.</div>'}
      </div>
    </div>
  `;
  document.body.append(overlay);
  overlay.querySelector('#close-user-modal').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
};

window.viewUserDetails = async (uid) => {
  try {
    const data = await apiFetch(`/api/admin/users/${uid}`);
    showUserModal(data);
  } catch (error) {
    toast(friendly(error));
  }
};

window.removeUser = async (uid, name) => {
  if (!confirm(`Are you sure you want to remove user "${name}"?\nThis will disable their account and deactivate all their active reports.`)) return;
  try {
    const res = await apiFetch(`/api/admin/users/${uid}/remove`, { method: 'POST' });
    toast(`User removed successfully (${res.reportsRemoved} reports deactivated).`);
    admin();
  } catch (error) {
    toast(friendly(error));
  }
};

async function admin() {
  const tab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'overview';
  const s = await apiFetch('/api/admin/stats');

  const tabsNav = `
    <div class="admin-tabs" style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px;">
      <a class="btn ${tab === 'overview' ? 'primary' : ''}" href="#/admin?tab=overview">Overview</a>
      <a class="btn ${tab === 'items' ? 'primary' : ''}" href="#/admin?tab=items">Items Moderation</a>
      <a class="btn ${tab === 'users' ? 'primary' : ''}" href="#/admin?tab=users">Users Details</a>
      <a class="btn ${tab === 'audits' ? 'primary' : ''}" href="#/admin?tab=audits">Login Audits</a>
    </div>
  `;

  if (tab === 'overview') {
    app.innerHTML = layout('Admin Overview', `
      ${tabsNav}
      <div class="grid stats section-gap">
        <div class="card stat"><span>Total Users</span><b>${s.users}</b></div>
        <div class="card stat"><span>Lost Items</span><b>${s.lost}</b></div>
        <div class="card stat"><span>Found Items</span><b>${s.found}</b></div>
        <div class="card stat"><span>Active</span><b>${s.active}</b></div>
        <div class="card stat"><span>Possible Matches</span><b>${s.possibleMatch}</b></div>
        <div class="card stat"><span>Confirmed</span><b>${s.confirmed}</b></div>
        <div class="card stat"><span>Pending Return</span><b>${s.returned}</b></div>
        <div class="card stat"><span>Resolved</span><b>${s.resolved}</b></div>
        <div class="card stat"><span>Removed</span><b>${s.removed}</b></div>
      </div>
      <div class="grid two section-gap">
        <div class="card">
          <h2>Moderation Actions</h2>
          <p class="muted">Administrators can view all items, inspect user details, remove items (even if unresolved), and remove users.</p>
          <div class="actions" style="margin-top: 14px;">
            <a class="btn primary" href="#/admin?tab=items">Moderate Items (${s.active + s.possibleMatch + s.confirmed + s.returned} active)</a>
            <a class="btn" href="#/admin?tab=users">Manage Users (${s.users})</a>
            <a class="btn" href="#/admin?tab=audits">User Login Audits</a>
          </div>
        </div>
        <div class="card">
          <h2>Security & Compliance</h2>
          <p class="muted">Admin operations are authorized by ADMIN_UID. Uploading lost or found items is disabled for administrators to maintain moderation integrity.</p>
        </div>
      </div>
    `, 'admin');
    bindLogout();
    return;
  }

  if (tab === 'items') {
    app.innerHTML = layout('Items Moderation', `
      ${tabsNav}
      <div class="toolbar section-gap">
        <input id="item-search" placeholder="Search by item name, location, brand...">
        <select id="item-type-filter">
          <option value="all">All Types</option>
          <option value="lost">Lost</option>
          <option value="found">Found</option>
        </select>
        <select id="item-status-filter">
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="possible_match">Possible Match</option>
          <option value="confirmed_match">Confirmed</option>
          <option value="return_pending">Return Pending</option>
          <option value="resolved">Resolved</option>
          <option value="removed">Removed</option>
        </select>
      </div>
      <div id="admin-items-list" class="grid reports">Loading items...</div>
    `, 'admin');

    const allReports = await apiFetch('/api/reports');
    const renderItems = () => {
      const q = $('#item-search')?.value?.toLowerCase().trim() || '';
      const typeFilter = $('#item-type-filter')?.value || 'all';
      const statusFilter = $('#item-status-filter')?.value || 'all';

      const filtered = allReports.filter((r) => {
        const matchesQ = !q || (r.itemName && r.itemName.toLowerCase().includes(q)) || (r.category && r.category.toLowerCase().includes(q)) || (r.location && r.location.toLowerCase().includes(q)) || (r.brand && r.brand.toLowerCase().includes(q));
        const matchesType = typeFilter === 'all' || r.type === typeFilter;
        const matchesStatus = statusFilter === 'all' || r.status === statusFilter;
        return matchesQ && matchesType && matchesStatus;
      });

      $('#admin-items-list').innerHTML = filtered.map((x) => {
        const cachedUrl = x.imageUrl ? (blobCache.get(x.imageUrl) || (x.imageUrl.startsWith('blob:') ? x.imageUrl : null)) : null;
        const imgHtml = cachedUrl
          ? `<img src="${cachedUrl}" alt="${x.itemName}" loading="lazy">`
          : (x.imageUrl
              ? `<img data-img-src="${x.imageUrl}" alt="${x.itemName}" class="lazy-image tall" loading="lazy">`
              : '<div class="image-placeholder tall">Image unavailable</div>');
        return `
          <div class="card report-card">
            ${imgHtml}
            <div class="split">
              <b>${x.itemName}</b>
              <span class="badge ${x.status}">${statusLabel(x.status)}</span>
            </div>
            <p class="muted">${x.type.toUpperCase()} · ${x.category || 'Uncategorized'} · ${x.location || 'Location not set'}</p>
            <p class="muted small">${x.date || 'No date'} · Submitter: ${x.ownerUid ? x.ownerUid.slice(0, 8) + '...' : 'Unknown'}</p>
            <div class="actions" style="margin-top: 10px;">
              <a class="btn compact" href="#/detail?id=${x.id}">View Details</a>
              ${x.status !== 'removed' ? `<button class="btn compact danger" onclick="removeReport('${x.id}')">Remove Item</button>` : '<span class="badge removed">Removed</span>'}
            </div>
          </div>
        `;
      }).join('') || '<div class="empty">No items found matching filter.</div>';
      loadPendingImages($('#admin-items-list'));
    };

    $('#item-search').oninput = renderItems;
    $('#item-type-filter').onchange = renderItems;
    $('#item-status-filter').onchange = renderItems;
    renderItems();
    bindLogout();
    return;
  }

  if (tab === 'users') {
    app.innerHTML = layout('Users Details & Moderation', `
      ${tabsNav}
      <div class="toolbar section-gap">
        <input id="user-search" placeholder="Search by name, email, department, role...">
        <select id="user-status-filter">
          <option value="all">All Accounts</option>
          <option value="active">Active</option>
          <option value="removed">Removed</option>
        </select>
      </div>
      <div id="admin-users-list">Loading users...</div>
    `, 'admin');

    const users = await apiFetch('/api/admin/users');
    const renderUsers = () => {
      const q = $('#user-search')?.value?.toLowerCase().trim() || '';
      const statusFilter = $('#user-status-filter')?.value || 'all';

      const filtered = users.filter((u) => {
        const matchesQ = !q || (u.fullName && u.fullName.toLowerCase().includes(q)) || (u.email && u.email.toLowerCase().includes(q)) || (u.department && u.department.toLowerCase().includes(q)) || (u.campusId && u.campusId.toLowerCase().includes(q));
        const matchesStatus = statusFilter === 'all' || u.accountStatus === statusFilter;
        return matchesQ && matchesStatus;
      });

      $('#admin-users-list').innerHTML = `
        <div class="card table-container" style="overflow-x: auto;">
          <table class="admin-table" style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead>
              <tr style="text-align: left; border-bottom: 1px solid var(--line);">
                <th style="padding: 10px;">User</th>
                <th style="padding: 10px;">Role</th>
                <th style="padding: 10px;">Phone</th>
                <th style="padding: 10px;">Campus ID</th>
                <th style="padding: 10px;">Department</th>
                <th style="padding: 10px;">Reports</th>
                <th style="padding: 10px;">Last Login</th>
                <th style="padding: 10px;">Status</th>
                <th style="padding: 10px;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${filtered.map((u) => `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.06);">
                  <td style="padding: 10px;">
                    <b>${u.fullName || 'Anonymous'}</b>
                    <div class="muted small">${u.email}</div>
                  </td>
                  <td style="padding: 10px;"><span class="badge ${u.isAdmin ? 'active' : 'possible_match'}">${u.role}</span></td>
                  <td style="padding: 10px;">${u.phoneNumber || '<span class="muted">-</span>'}</td>
                  <td style="padding: 10px;">${u.campusId || '<span class="muted">-</span>'}</td>
                  <td style="padding: 10px;">${u.department || '<span class="muted">-</span>'}</td>
                  <td style="padding: 10px;">
                    <span>${u.reportsCount} total</span>
                    <div class="muted small">${u.activeReportsCount} active · ${u.resolvedReportsCount} resolved</div>
                  </td>
                  <td style="padding: 10px;">${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '<span class="muted">Never</span>'}</td>
                  <td style="padding: 10px;"><span class="badge ${u.accountStatus === 'removed' ? 'removed' : 'active'}">${u.accountStatus || 'active'}</span></td>
                  <td style="padding: 10px;">
                    <div class="actions">
                      <button class="btn compact" onclick="viewUserDetails('${u.uid}')">Details</button>
                      ${!u.isAdmin && u.accountStatus !== 'removed' ? `<button class="btn compact danger" onclick="removeUser('${u.uid}', '${(u.fullName || u.email).replace(/'/g, "\\'")}')">Remove</button>` : ''}
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          ${filtered.length === 0 ? '<div class="empty">No users found.</div>' : ''}
        </div>
      `;
    };

    $('#user-search').oninput = renderUsers;
    $('#user-status-filter').onchange = renderUsers;
    renderUsers();
    bindLogout();
    return;
  }

  if (tab === 'audits') {
    app.innerHTML = layout('User Login Audits', `
      ${tabsNav}
      <div class="toolbar section-gap">
        <input id="audit-search" placeholder="Search by email, name, IP address, role...">
        <button class="btn primary" id="audit-refresh">Refresh</button>
      </div>
      <div id="admin-audits-list">Loading login audits...</div>
    `, 'admin');

    const loadAudits = async () => {
      const q = $('#audit-search')?.value?.trim() || '';
      const qs = q ? `?search=${encodeURIComponent(q)}` : '';
      const audits = await apiFetch(`/api/admin/audit/logins${qs}`);

      $('#admin-audits-list').innerHTML = `
        <div class="card table-container" style="overflow-x: auto;">
          <table class="admin-table" style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead>
              <tr style="text-align: left; border-bottom: 1px solid var(--line);">
                <th style="padding: 10px;">Date & Time</th>
                <th style="padding: 10px;">User</th>
                <th style="padding: 10px;">Role</th>
                <th style="padding: 10px;">IP Address</th>
                <th style="padding: 10px;">Browser / Device</th>
              </tr>
            </thead>
            <tbody>
              ${audits.map((a) => `
                <tr style="border-bottom: 1px solid rgba(255,255,255,0.06);">
                  <td style="padding: 10px;"><b>${new Date(a.timestamp).toLocaleString()}</b></td>
                  <td style="padding: 10px;">
                    <div>${a.fullName || 'User'}</div>
                    <div class="muted small">${a.email || a.userId}</div>
                  </td>
                  <td style="padding: 10px;"><span class="badge ${a.role === 'Admin' ? 'active' : 'possible_match'}">${a.role || 'Student'}</span></td>
                  <td style="padding: 10px;"><code>${a.ip || 'Unknown'}</code></td>
                  <td style="padding: 10px;" class="muted small">${a.userAgent || '-'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          ${audits.length === 0 ? '<div class="empty">No login audit records found.</div>' : ''}
        </div>
      `;
    };

    $('#audit-search').oninput = () => {
      clearTimeout(window._auditSearchTimeout);
      window._auditSearchTimeout = setTimeout(loadAudits, 300);
    };
    $('#audit-refresh').onclick = loadAudits;
    loadAudits();
    bindLogout();
    return;
  }
}

async function route() {
  if (!authReady) return;
  cleanupObjectUrls();
  const [name] = (location.hash.replace(/^#\//, '') || 'dashboard').split('?');
  try {
    if (!firebaseUser && !['login', 'register'].includes(name)) return authPage('login');
    if (name === 'login') return authPage('login');
    if (name === 'register') return authPage('register');
    if (firebaseUser && profileLoading) return profileLoadingPage();
    if (firebaseUser && !user && name !== 'profile') return profilePage();
    if (name === 'profile') return profilePage();

    // Admin role restrictions: admins cannot report items or see user personal reports
    if (user?.isAdmin) {
      if (['report', 'report-lost', 'report-found', 'reports'].includes(name)) {
        toast('Administrators cannot report lost or found items.');
        location.hash = '#/admin';
        return;
      }
    }

    if (name === 'dashboard') return await dashboard();
    if (name === 'report') return await report();
    if (name === 'report-lost') return await report('lost');
    if (name === 'report-found') return await report('found');
    if (name === 'reports') return await reports();
    if (name === 'detail') return await detail();
    if (name === 'search') return await search();
    if (name === 'notifications') return await notifications();
    if (name === 'admin') return await admin();
    return await dashboard();
  } catch (error) {
    console.error(error);
    toast(friendly(error));
  }
}

window.detail = detail;
window.search = search;
window.admin = admin;
window.reports = reports;
window.dashboard = dashboard;
window.route = route;
window.removeReport = removeReport;

window.addEventListener('hashchange', route);
boot().catch((error) => {
  console.error(error);
  app.innerHTML = `<div class="auth"><section class="authbox"><h1>FindBack could not start</h1><p class="muted">${friendly(error)}</p></section></div>`;
});
