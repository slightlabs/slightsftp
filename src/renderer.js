const { ipcRenderer } = require('electron');

let currentEditingUser = null;
let currentUserVirtualPaths = [];
let currentFileBrowserUser = null;
let currentFileBrowserPath = '/';
let authenticatedUser = null;
let sessionsRefreshInterval = null;
let dashboardRefreshInterval = null;

// Activity chart data (15 minutes of data, one point per 1 second = 900 data points)
let activityChartData = [];
let activityChartInterval = null;
const CHART_DATA_POINTS = 900; // 15 minutes at 1 second intervals
const CHART_UPDATE_INTERVAL = 1000; // 1 second

// Escape untrusted text (usernames, file names, paths from FTP/SFTP clients) before
// it goes into innerHTML. With nodeIntegration enabled, injected markup would be code execution.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// "FTP", "FTPS (TLS required)", "SFTP", ...
function protocolLabel(listener) {
  if (listener.protocol !== 'FTP' || !listener.tlsMode || listener.tlsMode === 'none') return listener.protocol;
  return listener.tlsMode === 'required' ? 'FTPS (TLS required)' : 'FTP / FTPS (TLS optional)';
}

// Encode a value as a JS literal for use inside an inline onclick="..." attribute
function jsArg(value) {
  return escapeHtml(JSON.stringify(value));
}

// Load authenticated user on startup
async function loadAuthenticatedUser() {
  try {
    console.log('Loading authenticated user...');
    authenticatedUser = await ipcRenderer.invoke('get-authenticated-user');
    console.log('Authenticated user:', authenticatedUser);
    
    const userElement = document.getElementById('currentUser');
    if (userElement) {
      if (authenticatedUser) {
        userElement.textContent = authenticatedUser.username;
      } else {
        userElement.textContent = 'Unknown';
      }
    } else {
      console.error('currentUser element not found');
    }
  } catch (error) {
    console.error('Error loading authenticated user:', error);
    const userElement = document.getElementById('currentUser');
    if (userElement) {
      userElement.textContent = 'Error';
    }
  }
}

// Logout function
async function logout() {
  const confirmed = confirm('Are you sure you want to logout?');
  if (confirmed) {
    try {
      await ipcRenderer.invoke('logout');
    } catch (error) {
      console.error('Error during logout:', error);
    }
  }
}

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
  loadAuthenticatedUser();
  initializeActivityChart();
  loadDashboard();
  
  // Set up WebSocket event listeners for real-time updates
  if (typeof ipcRenderer !== 'undefined' && ipcRenderer.on) {
    // Listen for activity updates
    ipcRenderer.on('activity', (event, activity) => {
      console.log('Received activity update:', activity);
      
      // Refresh dashboard to show new activity
      const currentPanel = document.querySelector('.panel.active');
      if (currentPanel && currentPanel.id === 'dashboard') {
        loadDashboard();
      }
      
      // Refresh activity log if on that tab
      if (currentPanel && currentPanel.id === 'activity') {
        loadActivityLog();
      }
    });
    
    // Listen for listener status changes
    ipcRenderer.on('listener-started', (event, listenerId) => {
      console.log('Listener started:', listenerId);
      const currentPanel = document.querySelector('.panel.active');
      if (currentPanel && (currentPanel.id === 'dashboard' || currentPanel.id === 'listeners')) {
        loadDashboard();
        loadListeners();
      }
    });
    
    ipcRenderer.on('listener-stopped', (event, listenerId) => {
      console.log('Listener stopped:', listenerId);
      const currentPanel = document.querySelector('.panel.active');
      if (currentPanel && (currentPanel.id === 'dashboard' || currentPanel.id === 'listeners')) {
        loadDashboard();
        loadListeners();
      }
    });
  }
});

// Navigation
document.querySelectorAll('.sidebar-item').forEach(item => {
  item.addEventListener('click', () => {
    const panelId = item.dataset.panel;
    
    // Update sidebar
    document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    
    // Update panels
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById(panelId).classList.add('active');
    
    // Load panel data
    loadPanelData(panelId);
  });
});

function loadPanelData(panelId) {
  switch(panelId) {
    case 'dashboard':
      loadDashboard();
      // Auto-refresh dashboard every 5 seconds
      if (dashboardRefreshInterval) clearInterval(dashboardRefreshInterval);
      dashboardRefreshInterval = setInterval(loadDashboard, 5000);
      break;
    case 'listeners':
      loadListeners();
      if (dashboardRefreshInterval) clearInterval(dashboardRefreshInterval);
      break;
    case 'sessions':
      loadActiveSessions();
      break;
    case 'users':
      loadUsers();
      break;
    case 'files':
      loadFileBrowser();
      break;
    case 'activity':
      loadActivityLog();
      break;
  }
}

// Dashboard
async function loadDashboard() {
  const statuses = await ipcRenderer.invoke('get-all-listener-statuses');
  const activities = await ipcRenderer.invoke('get-recent-activities', undefined, 200);
  const allUsers = await ipcRenderer.invoke('get-all-users');
  const activeSessions = await ipcRenderer.invoke('get-active-sessions');
  
  // Filter activities to only show past 1 hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recentActivities = activities.filter(a => {
    const activityTime = new Date(a.timestamp + 'Z');
    return activityTime >= oneHourAgo;
  });
  
  const running = statuses.filter(s => s.running).length;
  const total = statuses.length;
  
  // Update system statistics
  document.getElementById('totalUsersCount').textContent = allUsers.length;
  document.getElementById('activeSessionsCount').textContent = activeSessions.length;
  
  // Calculate unique active users from sessions
  const uniqueActiveUsers = new Set(activeSessions.map(s => s.username)).size;
  document.getElementById('activeUsersCount').textContent = uniqueActiveUsers;
  
  document.getElementById('server-overview').innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;">
      <div style="text-align: center;">
        <div style="font-size: 32px; font-weight: bold; color: #3498db;">${total}</div>
        <div style="color: #666; margin-top: 5px;">Total Listeners</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 32px; font-weight: bold; color: #27ae60;">${running}</div>
        <div style="color: #666; margin-top: 5px;">Running</div>
      </div>
      <div style="text-align: center;">
        <div style="font-size: 32px; font-weight: bold; color: #e74c3c;">${total - running}</div>
        <div style="color: #666; margin-top: 5px;">Stopped</div>
      </div>
    </div>
  `;
  
  const activeListeners = statuses.filter(s => s.running);
  const activeListenersHtml = activeListeners.length > 0
    ? activeListeners.map(s => `
        <div class="listener-card">
          <h3>${escapeHtml(s.listener.name)}</h3>
          <div class="listener-info">
            <div><strong>Protocol:</strong> ${escapeHtml(s.listener.protocol)}</div>
            <div><strong>Address:</strong> ${escapeHtml(s.listener.bindingIp)}:${escapeHtml(s.listener.port)}</div>
            <div><span class="status-indicator status-running"></span>Running</div>
          </div>
        </div>
      `).join('')
    : '<div class="empty-state">No active listeners</div>';
  
  document.getElementById('active-listeners').innerHTML = activeListenersHtml;
  
  displayActivities('dashboard-activity', recentActivities);
}

async function editWebGUIListener(id) {
  try {
    // Check if we're in Electron mode
    if (typeof ipcRenderer === 'undefined') {
      alert('Changing the web server port from the web interface is not supported.\n\nPlease restart the server with the WEB_PORT environment variable set to your desired port.');
      return;
    }
    
    const status = await ipcRenderer.invoke('get-web-server-status');
    const currentPort = status.port || 3000;
    
    // Get the port input element
    const portInput = document.getElementById('webServerPort');
    
    // Reset the input to ensure it's editable
    portInput.removeAttribute('readonly');
    portInput.removeAttribute('disabled');
    portInput.value = '';
    
    // Show the modal first
    document.getElementById('editWebPortModal').classList.add('active');
    
    // Set the current port in the form
    portInput.value = currentPort;
    document.getElementById('webServerHttps').checked = !!status.https;
    
    // Focus and select the text after a short delay to ensure modal is visible
    setTimeout(() => {
      portInput.removeAttribute('readonly');
      portInput.removeAttribute('disabled');
      portInput.focus();
      portInput.select();
    }, 100);
  } catch (err) {
    alert(`Error opening port editor: ${err.message}`);
  }
}

// Listeners
let serverIdentity = null;

async function loadListeners() {
  const statuses = await ipcRenderer.invoke('get-all-listener-statuses');
  if (!serverIdentity) {
    serverIdentity = await ipcRenderer.invoke('get-server-identity').catch(() => null);
  }
  const normalizedStatuses = Array.isArray(statuses) ? [...statuses] : [];

  // Backward-compatible fallback: if backend omits Web GUI status, show it in stopped state.
  const hasWebGuiStatus = normalizedStatuses.some(s => s?.listener?.id === -1);
  if (!hasWebGuiStatus) {
    normalizedStatuses.push({
      listener: {
        id: -1,
        name: 'Web GUI Server',
        protocol: 'HTTP',
        bindingIp: '0.0.0.0',
        port: 3000,
        enabled: true,
        maxConnections: 100
      },
      running: false
    });
  }
  
  // Check if we're in web mode
  const isWebMode = typeof require === 'undefined' || (() => {
    try {
      require('electron');
      return false;
    } catch (e) {
      return true;
    }
  })();
  
  const listenersHtml = normalizedStatuses.map(s => {
    const isWebGUI = s.listener.id === -1;
    
    // Determine what buttons to show for Web GUI Server
    let webGuiButtons = '';
    if (isWebGUI) {
      if (isWebMode) {
        // In web mode: No stop button, just edit port
        webGuiButtons = `<button class="btn btn-warning" onclick="editWebGUIListener(${s.listener.id})">Edit Port</button>`;
      } else {
        // In Electron mode: Show start/stop buttons
        webGuiButtons = s.running 
          ? `<button class="btn btn-danger" onclick="stopWebGUIServer()">Stop</button>
             <button class="btn btn-warning" onclick="editWebGUIListener(${s.listener.id})">Edit Port</button>`
          : `<button class="btn btn-success" onclick="startWebGUIServer()">Start</button>
             <button class="btn btn-warning" onclick="editWebGUIListener(${s.listener.id})">Edit Port</button>`;
      }
    }
    
    const securityNote = isWebGUI ? `
      ${s.listener.protocol === 'HTTPS' ? `
      <div style="background: #e8f5e9; border-left: 4px solid #27ae60; padding: 10px; margin-top: 10px; font-size: 12px;">
        <strong>🔒 HTTPS enabled.</strong> Connections are encrypted. With the generated self-signed certificate browsers show a warning the first time; install your own certificate to avoid it.
      </div>` : `
      <div style="background: #fff3cd; border-left: 4px solid #ffc107; padding: 10px; margin-top: 10px; font-size: 12px;">
        <strong>⚠️ Security Note:</strong> The web server uses HTTP, so passwords travel unencrypted. Turn on HTTPS with <em>Edit Port → Use HTTPS</em>.
      </div>`}
      <div style="background: #f8f9fa; padding: 10px; margin-top: 10px; font-size: 12px; border-radius: 4px;">
        <p style="margin: 0 0 6px 0;"><strong>About Web GUI:</strong></p>
        <ul style="margin: 0; padding-left: 18px;">
          <li>Allows remote management through a web browser</li>
          <li>Only users with GUI access enabled can login</li>
          <li>All actions are logged to the activity log</li>
          <li>Sessions expire after 24 hours of inactivity</li>
        </ul>
      </div>
    ` : '';
    
    return `
      <div class="listener-card">
        <h3>${escapeHtml(s.listener.name)}</h3>
        <div class="listener-info">
          <div><strong>Protocol:</strong> ${escapeHtml(protocolLabel(s.listener))}</div>
          <div><strong>Address:</strong> ${escapeHtml(s.listener.bindingIp)}:${escapeHtml(s.listener.port)}</div>
          ${!isWebGUI ? `<div><strong>Enabled:</strong> ${s.listener.enabled ? 'Yes' : 'No'}</div>` : ''}
          ${s.listener.protocol === 'SFTP' && serverIdentity?.sshHostKeyFingerprint ? `<div title="Give this to users so their SFTP client can verify the server"><strong>Host key:</strong> <code style="font-size: 11px;">${escapeHtml(serverIdentity.sshHostKeyFingerprint)}</code></div>` : ''}
          <div>
            <span class="status-indicator ${s.running ? 'status-running' : 'status-stopped'}"></span>
            ${s.running ? 'Running' : 'Stopped'}
          </div>
          ${isWebGUI && s.running ? (() => {
            const url = `${s.listener.protocol === 'HTTPS' ? 'https' : 'http'}://localhost:${s.listener.port}`;
            return `<div><strong>URL:</strong> <a href="${escapeHtml(url)}" target="_blank" style="color: #3498db; text-decoration: none;">${escapeHtml(url)}</a></div>`;
          })() : ''}
        </div>
        ${securityNote}
        <div class="listener-actions">
          ${isWebGUI ? webGuiButtons : `
            ${s.running 
              ? `<button class="btn btn-danger" onclick="stopListener(${s.listener.id})">Stop</button>`
              : `<button class="btn btn-success" onclick="startListener(${s.listener.id})">Start</button>`
            }
            <button class="btn btn-warning" onclick="editListener(${s.listener.id})">Edit Port</button>
            <button class="btn btn-danger" onclick="deleteListener(${s.listener.id})">Delete</button>
          `}
        </div>
      </div>
    `;
  }).join('');
  
  document.getElementById('listeners-list').innerHTML = listenersHtml || '<div class="empty-state">No listeners configured</div>';
}

async function startWebGUIServer() {
  try {
    const result = await ipcRenderer.invoke('start-web-server');
    if (result.success) {
      alert(`Web server started successfully on port ${result.port}!\n\nYou can now access the web GUI at ${result.url || `http://localhost:${result.port}`}`);
      loadListeners();
    } else {
      alert(`Failed to start web server: ${result.error}`);
    }
  } catch (err) {
    alert(`Error starting web server: ${err.message}`);
  }
}

async function stopWebGUIServer() {
  if (!confirm('Are you sure you want to stop the web server? All active web sessions will be disconnected.')) {
    return;
  }
  
  try {
    const result = await ipcRenderer.invoke('stop-web-server');
    if (result.success) {
      alert('Web server stopped successfully.');
      loadListeners();
    } else {
      alert(`Failed to stop web server: ${result.error}`);
    }
  } catch (err) {
    alert(`Error stopping web server: ${err.message}`);
  }
}

async function startListener(id) {
  try {
    await ipcRenderer.invoke('start-listener', id);
    loadListeners();
    loadDashboard();
  } catch (err) {
    alert(`Failed to start listener: ${err.message}`);
  }
}

async function stopListener(id) {
  try {
    await ipcRenderer.invoke('stop-listener', id);
    loadListeners();
    loadDashboard();
  } catch (err) {
    alert(`Failed to stop listener: ${err.message}`);
  }
}

async function deleteListener(id) {
  if (!confirm('Are you sure you want to delete this listener?')) return;
  
  try {
    await ipcRenderer.invoke('delete-listener', id);
    loadListeners();
    loadDashboard();
  } catch (err) {
    alert(`Failed to delete listener: ${err.message}`);
  }
}

async function editListener(id) {
  try {
    const listener = await ipcRenderer.invoke('get-listener', id);
    // Use elements.namedItem: form.id / form.name are the form's own attributes,
    // not the inputs called "id" / "name"
    const fields = document.getElementById('editListenerForm').elements;
    fields.namedItem('id').value = listener.id;
    fields.namedItem('name').value = listener.name;
    fields.namedItem('protocol').value = listener.protocol;
    fields.namedItem('bindingIp').value = listener.bindingIp;
    fields.namedItem('port').value = listener.port;
    fields.namedItem('enabled').checked = listener.enabled;
    fields.namedItem('tlsMode').value = listener.tlsMode || 'none';
    // Encryption choice only applies to FTP listeners (SFTP is always encrypted)
    fields.namedItem('tlsMode').closest('[data-ftp-only]').style.display = listener.protocol === 'FTP' ? '' : 'none';
    
    showModal('editListenerModal');
  } catch (err) {
    alert(`Failed to load listener: ${err.message}`);
  }
}


// Active Sessions
async function loadActiveSessions() {
  console.log('Loading active sessions...');
  const sessions = await ipcRenderer.invoke('get-active-sessions');
  console.log('Active sessions:', sessions);
  
  const tbody = document.getElementById('sessions-table');
  
  if (sessions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No active sessions</td></tr>';
  } else {
    tbody.innerHTML = sessions.map(session => {
      const connectedAt = new Date(session.connectedAt);
      const duration = formatDuration(Date.now() - connectedAt.getTime());
      
      return `
        <tr>
          <td><strong>${escapeHtml(session.username)}</strong></td>
          <td>${escapeHtml(session.protocol)}</td>
          <td>${escapeHtml(session.listenerName)}</td>
          <td>${escapeHtml(session.ipAddress)}</td>
          <td>${connectedAt.toLocaleString()}</td>
          <td>${duration}</td>
          <td>
            <button class="btn btn-danger" onclick="disconnectSession(${jsArg(session.sessionId)}, ${jsArg(session.username)})">
              Disconnect
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }
  
  // Auto-refresh every 5 seconds
  if (sessionsRefreshInterval) {
    clearInterval(sessionsRefreshInterval);
  }
  sessionsRefreshInterval = setInterval(() => {
    const activePanel = document.querySelector('.panel.active');
    if (activePanel && activePanel.id === 'sessions') {
      loadActiveSessions();
    }
  }, 5000);
}

async function disconnectSession(sessionId, username) {
  if (!confirm(`Are you sure you want to disconnect user "${username}"?`)) return;
  
  try {
    const success = await ipcRenderer.invoke('disconnect-session', sessionId);
    if (success) {
      alert(`User "${username}" has been disconnected.`);
      loadActiveSessions();
    } else {
      alert('Failed to disconnect session. It may have already disconnected.');
    }
  } catch (err) {
    alert(`Failed to disconnect session: ${err.message}`);
  }
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}


// Users
async function loadUsers() {
  const users = await ipcRenderer.invoke('get-all-users');
  
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = users.map(user => `
    <tr>
      <td>${escapeHtml(user.username)}${user.portalEnabled ? ' <span title="Web file portal enabled">🌐</span>' : ''}</td>
      <td>${user.passwordEnabled ? '✓' : '✗'}</td>
      <td>${user.publicKey ? '✓' : '✗'}</td>
      <td>${user.guiEnabled ? '✓' : '✗'}</td>
      <td>
        <button class="btn btn-primary" onclick="editUser(${jsArg(user.username)})">Edit</button>
        ${user.username !== 'admin' ? `<button class="btn btn-danger" onclick="deleteUser(${jsArg(user.username)})">Delete</button>` : ''}
      </td>
    </tr>
  `).join('');
}

async function editUser(username) {
  const user = await ipcRenderer.invoke('get-user', username);
  const listeners = await ipcRenderer.invoke('get-all-listeners');
  const userListeners = await ipcRenderer.invoke('get-user-listeners', user.id);
  const virtualPaths = await ipcRenderer.invoke('get-virtual-paths', user.id);
  
  currentEditingUser = user;
  currentUserVirtualPaths = virtualPaths;
  
  const fields = document.getElementById('editUserForm').elements;
  fields.namedItem('username').value = username;
  fields.namedItem('password').value = '';
  fields.namedItem('passwordEnabled').checked = user.passwordEnabled;
  fields.namedItem('publicKey').value = user.publicKey || '';
  fields.namedItem('guiEnabled').checked = user.guiEnabled;
  fields.namedItem('mustChangePassword').checked = !!user.mustChangePassword;
  fields.namedItem('portalEnabled').checked = !!user.portalEnabled;
  
  // Populate listeners with permissions
  let listenersHtml = '';
  for (const listener of listeners) {
    const isSubscribed = userListeners.includes(listener.id);
    const permission = await ipcRenderer.invoke('get-permission', user.id, listener.id);
    
    listenersHtml += `
      <div class="card" style="margin-bottom: 15px; background: ${isSubscribed ? '#f8f9fa' : '#fff'};">
        <div class="checkbox-group" style="margin-bottom: 10px;">
          <input type="checkbox" id="listener-${listener.id}" value="${listener.id}" ${isSubscribed ? 'checked' : ''} onchange="toggleListenerPermissions(${listener.id})">
          <label for="listener-${listener.id}" style="font-weight: 600; font-size: 16px;">${escapeHtml(listener.name)} (${escapeHtml(listener.protocol)}:${escapeHtml(listener.port)})</label>
        </div>
        <div id="permissions-${listener.id}" style="display: ${isSubscribed ? 'block' : 'none'}; margin-left: 25px;">
          <div style="font-weight: 500; margin-bottom: 8px; color: #555;">Permissions:</div>
          <div class="permissions-grid">
            <div class="checkbox-group">
              <input type="checkbox" id="perm-${listener.id}-canRead" ${permission?.canRead !== false ? 'checked' : ''}>
              <label for="perm-${listener.id}-canRead">Read Files</label>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="perm-${listener.id}-canCreate" ${permission?.canCreate ? 'checked' : ''}>
              <label for="perm-${listener.id}-canCreate">Create Files</label>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="perm-${listener.id}-canEdit" ${permission?.canEdit ? 'checked' : ''}>
              <label for="perm-${listener.id}-canEdit">Edit Files</label>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="perm-${listener.id}-canAppend" ${permission?.canAppend ? 'checked' : ''}>
              <label for="perm-${listener.id}-canAppend">Append to Files</label>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="perm-${listener.id}-canDelete" ${permission?.canDelete ? 'checked' : ''}>
              <label for="perm-${listener.id}-canDelete">Delete Files</label>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="perm-${listener.id}-canList" ${permission?.canList !== false ? 'checked' : ''}>
              <label for="perm-${listener.id}-canList">List Directories</label>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="perm-${listener.id}-canCreateDir" ${permission?.canCreateDir ? 'checked' : ''}>
              <label for="perm-${listener.id}-canCreateDir">Create Directories</label>
            </div>
            <div class="checkbox-group">
              <input type="checkbox" id="perm-${listener.id}-canRename" ${permission?.canRename ? 'checked' : ''}>
              <label for="perm-${listener.id}-canRename">Rename Files</label>
            </div>
          </div>
          <div style="margin-top: 10px;">
            <button type="button" class="btn" style="background: #95a5a6; color: white; font-size: 12px;" onclick="setAllPermissions(${listener.id}, true)">Select All</button>
            <button type="button" class="btn" style="background: #7f8c8d; color: white; font-size: 12px;" onclick="setAllPermissions(${listener.id}, false)">Clear All</button>
            <button type="button" class="btn" style="background: #3498db; color: white; font-size: 12px;" onclick="setReadOnlyPermissions(${listener.id})">Read Only</button>
          </div>
        </div>
      </div>
    `;
  }
  
  document.getElementById('userListenersCheckboxes').innerHTML = listenersHtml;
  
  // Display virtual paths
  renderVirtualPaths();
  
  showModal('editUserModal');
}

function toggleListenerPermissions(listenerId) {
  const checkbox = document.getElementById(`listener-${listenerId}`);
  const permissionsDiv = document.getElementById(`permissions-${listenerId}`);
  permissionsDiv.style.display = checkbox.checked ? 'block' : 'none';
}

function setAllPermissions(listenerId, value) {
  const permissions = ['canRead', 'canCreate', 'canEdit', 'canAppend', 'canDelete', 'canList', 'canCreateDir', 'canRename'];
  permissions.forEach(perm => {
    document.getElementById(`perm-${listenerId}-${perm}`).checked = value;
  });
}

function setReadOnlyPermissions(listenerId) {
  const permissions = ['canRead', 'canCreate', 'canEdit', 'canAppend', 'canDelete', 'canList', 'canCreateDir', 'canRename'];
  permissions.forEach(perm => {
    document.getElementById(`perm-${listenerId}-${perm}`).checked = (perm === 'canList' || perm === 'canRead');
  });
}

function renderVirtualPaths() {
  const html = currentUserVirtualPaths.map((vp, index) => `
    <div class="virtual-path-item">
      <div>
        <strong>${escapeHtml(vp.virtualPath)}</strong> → ${escapeHtml(vp.localPath)}
        <div style="font-size: 0.85em; color: #666; margin-top: 5px;">
          Permissions: ${[
            vp.canRead ? 'Read' : null,
            vp.canWrite ? 'Write' : null,
            vp.canAppend ? 'Append' : null,
            vp.canList ? 'List' : null,
            vp.canDelete ? 'Delete' : null,
            vp.canCreateDir ? 'CreateDir' : null,
            vp.canRename ? 'Rename' : null
          ].filter(Boolean).join(', ') || 'None'}
          ${vp.applyToSubdirs ? '(applies to subdirs)' : ''}
        </div>
      </div>
      <div>
        <button class="btn" onclick="editVirtualPath(${index})">Edit</button>
        <button class="btn btn-danger" onclick="removeVirtualPath(${index})">Remove</button>
      </div>
    </div>
  `).join('');
  
  document.getElementById('virtualPathsList').innerHTML = html || '<p>No virtual paths configured</p>';
}

function addVirtualPath() {
  document.getElementById('virtualPathModalTitle').textContent = 'Add Virtual Path';
  document.getElementById('vpIndex').value = '-1';
  document.getElementById('vpVirtualPath').value = '';
  document.getElementById('vpRealPath').value = '';
  document.getElementById('vpCanRead').checked = true;
  document.getElementById('vpCanWrite').checked = true;
  document.getElementById('vpCanAppend').checked = true;
  document.getElementById('vpCanDelete').checked = false;
  document.getElementById('vpCanList').checked = true;
  document.getElementById('vpCanCreateDir').checked = false;
  document.getElementById('vpCanRename').checked = false;
  document.getElementById('vpApplyToSubdirs').checked = true;
  showModal('virtualPathModal');
}

function editVirtualPath(index) {
  const vp = currentUserVirtualPaths[index];
  document.getElementById('virtualPathModalTitle').textContent = 'Edit Virtual Path';
  document.getElementById('vpIndex').value = index;
  document.getElementById('vpVirtualPath').value = vp.virtualPath;
  document.getElementById('vpRealPath').value = vp.localPath;
  document.getElementById('vpCanRead').checked = vp.canRead !== false;
  document.getElementById('vpCanWrite').checked = vp.canWrite !== false;
  document.getElementById('vpCanAppend').checked = vp.canAppend !== false;
  document.getElementById('vpCanDelete').checked = vp.canDelete || false;
  document.getElementById('vpCanList').checked = vp.canList !== false;
  document.getElementById('vpCanCreateDir').checked = vp.canCreateDir || false;
  document.getElementById('vpCanRename').checked = vp.canRename || false;
  document.getElementById('vpApplyToSubdirs').checked = vp.applyToSubdirs !== false;
  showModal('virtualPathModal');
}

async function browseFolderForVirtualPath() {
  const result = await ipcRenderer.invoke('select-directory');
  if (result) {
    document.getElementById('vpRealPath').value = result;
  }
}

function removeVirtualPath(index) {
  currentUserVirtualPaths.splice(index, 1);
  renderVirtualPaths();
}

async function deleteUser(username) {
  if (!confirm(`Are you sure you want to delete user "${username}"?`)) return;
  
  try {
    await ipcRenderer.invoke('delete-user', username);
    loadUsers();
  } catch (err) {
    alert(`Failed to delete user: ${err.message}`);
  }
}

// Activity Chart Functions
function initializeActivityChart() {
  // Initialize with zeros
  activityChartData = Array(CHART_DATA_POINTS).fill(null).map(() => ({ success: 0, error: 0, timestamp: Date.now() }));
  
  // Draw initial empty chart
  drawActivityChart();
  
  // Start update interval
  if (activityChartInterval) clearInterval(activityChartInterval);
  activityChartInterval = setInterval(updateActivityChart, CHART_UPDATE_INTERVAL);
}

async function updateActivityChart() {
  try {
    // Get activities from the last 1 second
    const allActivities = await ipcRenderer.invoke('get-recent-activities', undefined, 500);
    const oneSecondAgo = new Date(Date.now() - 1000);
    
    const recentActivities = allActivities.filter(a => {
      const activityTime = new Date(a.timestamp + 'Z');
      return activityTime >= oneSecondAgo;
    });
    
    // Count successes and errors
    const successCount = recentActivities.filter(a => a.success).length;
    const errorCount = recentActivities.filter(a => !a.success).length;
    
    // Add new data point
    activityChartData.push({ success: successCount, error: errorCount, timestamp: Date.now() });
    
    // Remove old data point
    if (activityChartData.length > CHART_DATA_POINTS) {
      activityChartData.shift();
    }
    
    // Redraw chart
    drawActivityChart();
  } catch (err) {
    console.error('Error updating activity chart:', err);
  }
}

function drawActivityChart() {
  const canvas = document.getElementById('activityChart');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  
  // Set canvas size to match display size
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  
  const width = rect.width;
  const height = rect.height;
  const padding = 5;
  const chartWidth = width - padding * 2;
  const chartHeight = height - padding * 2;
  
  // Clear canvas
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(0, 0, width, height);
  
  // Find max value for scaling
  let maxValue = 10; // Minimum scale
  activityChartData.forEach(point => {
    const total = point.success + point.error;
    if (total > maxValue) maxValue = total;
  });
  
  // Update max value display
  const maxDisplay = document.getElementById('chartMaxValue');
  if (maxDisplay) {
    maxDisplay.textContent = `${maxValue} events/s`;
  }
  
  // Draw grid lines
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding + (chartHeight / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
  }
  
  if (activityChartData.length < 2) return;
  
  const pointWidth = chartWidth / (CHART_DATA_POINTS - 1);
  
  // Draw error area (stacked on top)
  ctx.beginPath();
  activityChartData.forEach((point, i) => {
    const x = padding + (i * pointWidth);
    const successHeight = (point.success / maxValue) * chartHeight;
    const errorHeight = (point.error / maxValue) * chartHeight;
    const totalHeight = successHeight + errorHeight;
    const y = padding + chartHeight - totalHeight;
    
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  
  // Complete the error area
  for (let i = activityChartData.length - 1; i >= 0; i--) {
    const x = padding + (i * pointWidth);
    const successHeight = (activityChartData[i].success / maxValue) * chartHeight;
    const y = padding + chartHeight - successHeight;
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(231, 76, 60, 0.4)';
  ctx.fill();
  
  // Draw error line
  ctx.beginPath();
  activityChartData.forEach((point, i) => {
    const x = padding + (i * pointWidth);
    const successHeight = (point.success / maxValue) * chartHeight;
    const errorHeight = (point.error / maxValue) * chartHeight;
    const totalHeight = successHeight + errorHeight;
    const y = padding + chartHeight - totalHeight;
    
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.strokeStyle = '#e74c3c';
  ctx.lineWidth = 2;
  ctx.stroke();
  
  // Draw success area
  ctx.beginPath();
  activityChartData.forEach((point, i) => {
    const x = padding + (i * pointWidth);
    const successHeight = (point.success / maxValue) * chartHeight;
    const y = padding + chartHeight - successHeight;
    
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  
  // Complete the success area
  ctx.lineTo(padding + chartWidth, padding + chartHeight);
  ctx.lineTo(padding, padding + chartHeight);
  ctx.closePath();
  ctx.fillStyle = 'rgba(39, 174, 96, 0.4)';
  ctx.fill();
  
  // Draw success line
  ctx.beginPath();
  activityChartData.forEach((point, i) => {
    const x = padding + (i * pointWidth);
    const successHeight = (point.success / maxValue) * chartHeight;
    const y = padding + chartHeight - successHeight;
    
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.strokeStyle = '#27ae60';
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Activity Log
let listenerNamesCache = {};

async function loadActivityLog() {
  // Load listener names for mapping
  const statuses = await ipcRenderer.invoke('get-all-listener-statuses');
  listenerNamesCache = {};
  statuses.forEach(s => {
    if (s && s.listener && s.listener.id) {
      listenerNamesCache[s.listener.id] = s.listener.name;
    }
  });
  
  const activities = await ipcRenderer.invoke('get-recent-activities', undefined, 200);
  displayActivities('full-activity-log', activities);
  
  // Update activity count
  const count = await ipcRenderer.invoke('get-activity-count');
  document.getElementById('activityCount').textContent = count;
  
  // Update retention display
  const settings = await ipcRenderer.invoke('get-all-settings');
  document.getElementById('logRetentionDisplay').textContent = settings.logRetentionDays || '30';
}

async function copyActivityLog() {
  try {
    const statuses = await ipcRenderer.invoke('get-all-listener-statuses');
    const tempCache = {};
    statuses.forEach(s => {
      tempCache[s.listener.id] = s.listener.name;
    });
    
    const activities = await ipcRenderer.invoke('get-recent-activities', undefined, 10000);
    const logText = activities.map(a => {
      const date = new Date(a.timestamp + 'Z');
      const timestamp = date.toLocaleString('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
      
      let listenerName = 'Admin GUI';
      if (a.listenerId !== null && tempCache[a.listenerId]) {
        listenerName = tempCache[a.listenerId];
      }
      
      return `[${timestamp}] [${listenerName}] ${a.username}: ${a.action} ${a.path}`;
    }).join('\n');
    
    await navigator.clipboard.writeText(logText);
    alert('Activity log copied to clipboard!');
  } catch (err) {
    alert('Failed to copy activity log: ' + err.message);
  }
}

async function saveActivityLog() {
  try {
    const statuses = await ipcRenderer.invoke('get-all-listener-statuses');
    const tempCache = {};
    statuses.forEach(s => {
      tempCache[s.listener.id] = s.listener.name;
    });
    
    const activities = await ipcRenderer.invoke('get-recent-activities', undefined, 10000);
    
    // Create CSV content
    const csvHeader = 'Timestamp,Listener,Username,Action,Path,Success\n';
    const csvRows = activities.map(a => {
      const date = new Date(a.timestamp + 'Z');
      const timestamp = date.toLocaleString('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
      
      let listenerName = 'Admin GUI';
      if (a.listenerId !== null && tempCache[a.listenerId]) {
        listenerName = tempCache[a.listenerId];
      }
      
      // Escape CSV values
      const escapeCSV = (val) => `"${String(val).replace(/"/g, '""')}"`;
      
      return `${escapeCSV(timestamp)},${escapeCSV(listenerName)},${escapeCSV(a.username)},${escapeCSV(a.action)},${escapeCSV(a.path)},${a.success}`;
    }).join('\n');
    
    const csvContent = csvHeader + csvRows;
    
    // Use Electron's dialog to save file
    const result = await ipcRenderer.invoke('save-activity-log', csvContent);
    
    if (result.success) {
      alert('Activity log saved successfully!');
    } else if (result.cancelled) {
      // User cancelled, do nothing
    } else {
      alert('Failed to save activity log: ' + result.error);
    }
  } catch (err) {
    alert('Failed to save activity log: ' + err.message);
  }
}

function displayActivities(elementId, activities) {
  const html = activities.map(a => {
    // Parse UTC timestamp and convert to local time
    const date = new Date(a.timestamp + 'Z'); // Add 'Z' to ensure it's treated as UTC
    const timestamp = date.toLocaleString('en-US', {
      month: '2-digit',
      day: '2-digit', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
    const cssClass = a.success ? 'activity-success' : 'activity-error';
    
    // Get friendly name for listener
    let listenerName = 'Admin GUI';
    if (a.listenerId !== null && a.listenerId !== undefined) {
      // Try to get from cache, fallback to listener ID if not found
      listenerName = listenerNamesCache[a.listenerId] || `Listener ${a.listenerId}`;
    }
    
    return `<div class="activity-item ${cssClass}">[${timestamp}] [${escapeHtml(listenerName)}] ${escapeHtml(a.username)}: ${escapeHtml(a.action)} ${escapeHtml(a.path)}</div>`;
  }).join('');
  
  document.getElementById(elementId).innerHTML = html || '<div class="empty-state">No activity yet</div>';
}

function showClearActivityModal() {
  // Set default to 30 days ago
  const date = new Date();
  date.setDate(date.getDate() - 30);
  document.getElementById('clearBeforeDate').value = date.toISOString().slice(0, 16);
  showModal('clearActivityModal');
}

async function clearAllActivities() {
  if (!confirm('Are you sure you want to delete ALL activity logs? This cannot be undone.')) return;
  
  try {
    const result = await ipcRenderer.invoke('clear-all-activities');
    alert(`Deleted ${result.count} activity log entries.`);
    loadActivityLog();
  } catch (err) {
    alert(`Failed to clear activities: ${err.message}`);
  }
}

async function showLogSettingsModal() {
  const settings = await ipcRenderer.invoke('get-all-settings');
  document.getElementById('logRetentionDays').value = settings.logRetentionDays || '30';
  
  // Check for old logs
  const stats = await ipcRenderer.invoke('get-old-logs-stats', parseInt(settings.logRetentionDays || '30'));
  document.getElementById('oldLogsStatus').innerHTML = 
    `Found <strong>${stats.count}</strong> log(s) older than ${settings.logRetentionDays || '30'} days` +
    (stats.count > 0 ? ' (will be cleaned up automatically on next startup)' : '');
  
  showModal('logSettingsModal');
}

async function cleanupOldLogsNow() {
  if (!confirm('Clean up old logs now based on current retention settings?')) return;
  
  try {
    const result = await ipcRenderer.invoke('cleanup-old-activities');
    alert(`Deleted ${result.count} old activity log entries.`);
    closeModal('logSettingsModal');
    loadActivityLog();
  } catch (err) {
    alert(`Failed to cleanup old logs: ${err.message}`);
  }
}

// Modals
function showModal(modalId) {
  document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

function showAddListenerModal() {
  showModal('addListenerModal');
}

function showAddUserModal() {
  showModal('addUserModal');
}

// Encryption choice only applies to FTP listeners (SFTP is always encrypted)
document.querySelector('#addListenerForm [name=protocol]').addEventListener('change', (e) => {
  document.querySelector('#addListenerForm [data-ftp-only]').style.display = e.target.value === 'FTP' ? '' : 'none';
});

// Form submissions
document.getElementById('addListenerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const data = {
    name: formData.get('name'),
    protocol: formData.get('protocol'),
    bindingIp: formData.get('bindingIp'),
    port: parseInt(formData.get('port')),
    enabled: formData.get('enabled') === 'on',
    tlsMode: formData.get('protocol') === 'FTP' ? (formData.get('tlsMode') || 'none') : 'none'
  };
  
  try {
    await ipcRenderer.invoke('create-listener', data);
    closeModal('addListenerModal');
    e.target.reset();
    loadListeners();
    loadDashboard();
  } catch (err) {
    alert(`Failed to create listener: ${err.message}`);
  }
});

document.getElementById('editListenerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const id = parseInt(formData.get('id'));
  const updates = {
    name: formData.get('name'),
    bindingIp: formData.get('bindingIp'),
    port: parseInt(formData.get('port')),
    enabled: formData.get('enabled') === 'on',
    tlsMode: formData.get('tlsMode') || 'none'
  };
  
  try {
    await ipcRenderer.invoke('update-listener', id, updates);
    closeModal('editListenerModal');
    loadListeners();
    loadDashboard();
  } catch (err) {
    alert(`Failed to update listener: ${err.message}`);
  }
});

document.getElementById('addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const data = {
    username: formData.get('username'),
    password: formData.get('password') || undefined,
    passwordEnabled: formData.get('passwordEnabled') === 'on',
    publicKey: formData.get('publicKey') || undefined,
    guiEnabled: formData.get('guiEnabled') === 'on',
    mustChangePassword: formData.get('mustChangePassword') === 'on',
    portalEnabled: formData.get('portalEnabled') === 'on'
  };
  
  try {
    await ipcRenderer.invoke('create-user', data);
    closeModal('addUserModal');
    e.target.reset();
    loadUsers();
  } catch (err) {
    alert(`Failed to create user: ${err.message}`);
  }
});

document.getElementById('virtualPathForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const index = parseInt(document.getElementById('vpIndex').value);
  const vp = {
    virtualPath: document.getElementById('vpVirtualPath').value,
    localPath: document.getElementById('vpRealPath').value,
    userId: currentEditingUser.id,
    canRead: document.getElementById('vpCanRead').checked,
    canWrite: document.getElementById('vpCanWrite').checked,
    canAppend: document.getElementById('vpCanAppend').checked,
    canDelete: document.getElementById('vpCanDelete').checked,
    canList: document.getElementById('vpCanList').checked,
    canCreateDir: document.getElementById('vpCanCreateDir').checked,
    canRename: document.getElementById('vpCanRename').checked,
    applyToSubdirs: document.getElementById('vpApplyToSubdirs').checked
  };
  
  if (index === -1) {
    currentUserVirtualPaths.push(vp);
  } else {
    currentUserVirtualPaths[index] = { ...currentUserVirtualPaths[index], ...vp };
  }
  
  renderVirtualPaths();
  closeModal('virtualPathModal');
});

document.getElementById('editUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const username = formData.get('username');
  
  const data = {
    password: formData.get('password') || undefined,
    passwordEnabled: formData.get('passwordEnabled') === 'on',
    publicKey: formData.get('publicKey') || undefined,
    guiEnabled: formData.get('guiEnabled') === 'on',
    mustChangePassword: formData.get('mustChangePassword') === 'on',
    portalEnabled: formData.get('portalEnabled') === 'on'
  };
  
  // Get selected listeners and their permissions
  const listeners = await ipcRenderer.invoke('get-all-listeners');
  const selectedListeners = [];
  const permissions = [];
  
  for (const listener of listeners) {
    const checkbox = document.getElementById(`listener-${listener.id}`);
    if (checkbox && checkbox.checked) {
      selectedListeners.push(listener.id);
      
      // Get permissions for this listener
      const permission = {
        userId: currentEditingUser.id,
        listenerId: listener.id,
        canRead: document.getElementById(`perm-${listener.id}-canRead`)?.checked ?? true,
        canCreate: document.getElementById(`perm-${listener.id}-canCreate`)?.checked || false,
        canEdit: document.getElementById(`perm-${listener.id}-canEdit`)?.checked || false,
        canAppend: document.getElementById(`perm-${listener.id}-canAppend`)?.checked || false,
        canDelete: document.getElementById(`perm-${listener.id}-canDelete`)?.checked || false,
        canList: document.getElementById(`perm-${listener.id}-canList`)?.checked ?? true,
        canCreateDir: document.getElementById(`perm-${listener.id}-canCreateDir`)?.checked || false,
        canRename: document.getElementById(`perm-${listener.id}-canRename`)?.checked || false
      };
      permissions.push(permission);
    }
  }
  
  try {
    await ipcRenderer.invoke('update-user', username, data, selectedListeners, currentUserVirtualPaths, permissions);
    closeModal('editUserModal');
    loadUsers();
  } catch (err) {
    alert(`Failed to update user: ${err.message}`);
  }
});

document.getElementById('clearActivityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const beforeDate = document.getElementById('clearBeforeDate').value;
  
  if (!confirm(`Delete all logs before ${new Date(beforeDate).toLocaleString()}? This cannot be undone.`)) return;
  
  try {
    const result = await ipcRenderer.invoke('clear-activities-by-date', new Date(beforeDate).toISOString());
    alert(`Deleted ${result.count} activity log entries.`);
    closeModal('clearActivityModal');
    loadActivityLog();
  } catch (err) {
    alert(`Failed to clear activities: ${err.message}`);
  }
});

document.getElementById('logSettingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const retentionDays = document.getElementById('logRetentionDays').value;
  
  try {
    await ipcRenderer.invoke('set-setting', 'logRetentionDays', retentionDays);
    alert(`Log retention period updated to ${retentionDays} days.`);
    closeModal('logSettingsModal');
    loadActivityLog();
  } catch (err) {
    alert(`Failed to save settings: ${err.message}`);
  }
});

document.getElementById('editWebPortForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const newPort = parseInt(document.getElementById('webServerPort').value);
  
  if (isNaN(newPort) || newPort < 1 || newPort > 65535) {
    alert('Invalid port number. Please enter a number between 1 and 65535.');
    return;
  }
  
  try {
    await ipcRenderer.invoke('set-setting', 'webHttps', document.getElementById('webServerHttps').checked ? 'true' : 'false');
    const status = await ipcRenderer.invoke('get-web-server-status');
    
    // If web server is running, stop it first
    if (status.running) {
      const stopResult = await ipcRenderer.invoke('stop-web-server');
      if (!stopResult.success) {
        alert(`Failed to stop web server: ${stopResult.error}`);
        closeModal('editWebPortModal');
        return;
      }
    }
    
    // Start web server on new port
    const startResult = await ipcRenderer.invoke('start-web-server', newPort);
    if (startResult.success) {
      alert(`Web server ${status.running ? 'restarted' : 'started'} successfully on port ${newPort}!\n\nYou can now access the web GUI at ${startResult.url || `http://localhost:${newPort}`}`);
      closeModal('editWebPortModal');
      loadDashboard();
      loadListeners();
    } else {
      alert(`Failed to start web server on port ${newPort}: ${startResult.error}`);
      closeModal('editWebPortModal');
    }
  } catch (err) {
    alert(`Error changing web server port: ${err.message}`);
    closeModal('editWebPortModal');
  }
});

// Listen for activity updates
ipcRenderer.on('activity-update', () => {
  const activePanel = document.querySelector('.panel.active').id;
  if (activePanel === 'dashboard') {
    loadDashboard();
  } else if (activePanel === 'activity') {
    loadActivityLog();
  }
});

// File Browser
async function loadFileBrowser() {
  const users = await ipcRenderer.invoke('get-all-users');
  const select = document.getElementById('fileBrowserUser');
  select.innerHTML = '<option value="">Select a user...</option>' +
    users.map(u => `<option value="${escapeHtml(u.username)}">${escapeHtml(u.username)}</option>`).join('');
  
  // Reset state
  currentFileBrowserUser = null;
  currentFileBrowserPath = '/';
  document.getElementById('fileBrowserContent').style.display = 'none';
  document.getElementById('fileBrowserEmpty').style.display = 'block';
}

async function loadUserFiles() {
  const username = document.getElementById('fileBrowserUser').value;
  if (!username) {
    document.getElementById('fileBrowserContent').style.display = 'none';
    document.getElementById('fileBrowserEmpty').style.display = 'block';
    return;
  }
  
  currentFileBrowserUser = username;
  currentFileBrowserPath = '/';
  await browsePath('/');
}

async function browsePath(path) {
  try {
    currentFileBrowserPath = path;
    const result = await ipcRenderer.invoke('browse-files', currentFileBrowserUser, path);
    
    document.getElementById('fileBrowserContent').style.display = 'block';
    document.getElementById('fileBrowserEmpty').style.display = 'none';
    
    renderBreadcrumb(path);
    renderFileList(result.files);
  } catch (err) {
    alert(`Failed to browse path: ${err.message}`);
  }
}

function renderBreadcrumb(path) {
  const parts = path.split('/').filter(p => p);
  let html = `<span class="breadcrumb-item" onclick="browsePath(${jsArg('/')})">🏠 Root</span>`;
  
  let currentPath = '';
  for (const part of parts) {
    currentPath += '/' + part;
    const pathForClick = currentPath; // Capture for onclick
    html += '<span class="breadcrumb-separator">/</span>';
    html += `<span class="breadcrumb-item" onclick="browsePath(${jsArg(pathForClick)})">${escapeHtml(part)}</span>`;
  }
  
  document.getElementById('fileBreadcrumb').innerHTML = html;
}

function renderFileList(files) {
  if (files.length === 0) {
    document.getElementById('fileList').innerHTML = '<div class="empty-state">No files in this directory</div>';
    return;
  }
  
  const html = files.map(file => {
    const isDirectory = file.type === 'directory' || file.isDirectory;
    const icon = isDirectory ? '📁' : '📄';
    const size = isDirectory ? '' : formatBytes(file.size);
    const date = new Date(file.modified || file.mtime).toLocaleString();
    
    return `
      <div class="file-item">
        <div class="file-icon">${icon}</div>
        <div class="file-info">
          <div class="file-name">${escapeHtml(file.name)}</div>
          <div class="file-meta">${size} ${size ? '•' : ''} ${date}</div>
        </div>
        <div class="file-actions">
          ${isDirectory ? 
            `<button class="btn btn-primary" onclick="browsePath(${jsArg(currentFileBrowserPath === '/' ? '/' + file.name : currentFileBrowserPath + '/' + file.name)})">Open</button>` :
            `<button class="btn btn-success" onclick="downloadFile(${jsArg(file.name)})">Download</button>`
          }
        </div>
      </div>
    `;
  }).join('');
  
  document.getElementById('fileList').innerHTML = html;
}

async function downloadFile(filename) {
  try {
    const filePath = currentFileBrowserPath === '/' ? '/' + filename : currentFileBrowserPath + '/' + filename;
    const result = await ipcRenderer.invoke('download-file', currentFileBrowserUser, filePath);
    if (result.success) {
      alert(`File downloaded to: ${result.savedPath}`);
    }
  } catch (err) {
    alert(`Failed to download file: ${err.message}`);
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Initial load
loadDashboard();
