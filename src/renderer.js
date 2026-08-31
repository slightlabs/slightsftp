// Admin interface functionality
const ipcRenderer = window.api || window.ipcRenderer;

let currentEditingUser = null;
let currentUserVirtualPaths = [];
let authenticatedUser = null;
let sessionsRefreshInterval = null;

// Load authenticated user on startup
async function loadAuthenticatedUser() {
  try {
    authenticatedUser = await ipcRenderer.invoke('get-authenticated-user');
    
    const userElement = document.getElementById('currentUser');
    if (userElement) {
      if (authenticatedUser) {
        userElement.textContent = authenticatedUser.username;
      } else {
        userElement.textContent = 'Unknown';
      }
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
  loadDashboard();
  
  // Set up sidebar navigation
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      const panel = item.dataset.panel;
      switchPanel(panel);
    });
  });
  
  // Set up form handlers
  setupFormHandlers();
  
  // Set up WebSocket event listeners for real-time updates
  if (typeof ipcRenderer !== 'undefined' && ipcRenderer.on) {
    ipcRenderer.on('activity', (event, activity) => {
      const currentPanel = document.querySelector('.panel.active');
      if (currentPanel && currentPanel.id === 'dashboard') {
        loadDashboard();
      }
      if (currentPanel && currentPanel.id === 'activity') {
        loadActivityLog();
      }
    });
    
    ipcRenderer.on('listener-started', (event, listenerId) => {
      const currentPanel = document.querySelector('.panel.active');
      if (currentPanel && (currentPanel.id === 'dashboard' || currentPanel.id === 'listeners')) {
        loadDashboard();
        loadListeners();
      }
    });
    
    ipcRenderer.on('listener-stopped', (event, listenerId) => {
      const currentPanel = document.querySelector('.panel.active');
      if (currentPanel && (currentPanel.id === 'dashboard' || currentPanel.id === 'listeners')) {
        loadDashboard();
        loadListeners();
      }
    });
  }
});

// Panel switching
function switchPanel(panelName) {
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.classList.remove('active');
    if (item.dataset.panel === panelName) {
      item.classList.add('active');
    }
  });
  
  document.querySelectorAll('.panel').forEach(panel => {
    panel.classList.remove('active');
  });
  
  const targetPanel = document.getElementById(panelName);
  if (targetPanel) {
    targetPanel.classList.add('active');
  }
  
  // Load content for the panel
  switch(panelName) {
    case 'dashboard':
      loadDashboard();
      break;
    case 'listeners':
      loadListeners();
      break;
    case 'users':
      loadUsers();
      break;
    case 'sessions':
      loadSessions();
      startSessionsRefresh();
      break;
    case 'activity':
      loadActivityLog();
      break;
    default:
      stopSessionsRefresh();
  }
}

// Dashboard
async function loadDashboard() {
  try {
    const [users, listeners, sessions, activity] = await Promise.all([
      ipcRenderer.invoke('get-all-users'),
      ipcRenderer.invoke('get-all-listeners'),
      ipcRenderer.invoke('get-active-sessions'),
      ipcRenderer.invoke('get-activity', 50)
    ]);
    
    // Update stats
    document.getElementById('totalUsersCount').textContent = users.length;
    document.getElementById('activeListenersCount').textContent = listeners.filter(l => l.enabled).length;
    document.getElementById('activeSessionsCount').textContent = sessions.length;
    
    // Display active listeners
    const listenersContainer = document.getElementById('active-listeners');
    if (listeners.length === 0) {
      listenersContainer.innerHTML = '<div class="empty-state">No listeners configured</div>';
    } else {
      listenersContainer.innerHTML = listeners.map(listener => `
        <div class="listener-card ${listener.enabled ? '' : 'stopped'}">
          <h3>${listener.name}</h3>
          <div class="listener-info">
            <span class="status-indicator ${listener.enabled ? 'status-running' : 'status-stopped'}"></span>
            ${listener.protocol}://${listener.bindingIp}:${listener.port}
          </div>
          <div class="listener-actions">
            <button class="btn btn-success" onclick="startListener(${listener.id})">Start</button>
            <button class="btn btn-warning" onclick="stopListener(${listener.id})">Stop</button>
            <button class="btn btn-primary" onclick="editListener(${listener.id})">Edit</button>
            <button class="btn btn-danger" onclick="deleteListener(${listener.id})">Delete</button>
          </div>
        </div>
      `).join('');
    }
    
    // Display recent activity
    const activityContainer = document.getElementById('dashboard-activity');
    if (activity.length === 0) {
      activityContainer.innerHTML = '<div class="empty-state">No recent activity</div>';
    } else {
      activityContainer.innerHTML = activity.map(a => `
        <div class="activity-item ${a.success ? 'activity-success' : 'activity-error'}">
          [${new Date(a.timestamp).toLocaleString()}] ${a.username}: ${a.action} ${a.path} - ${a.success ? 'Success' : 'Failed'}
        </div>
      `).join('');
    }
  } catch (error) {
    console.error('Error loading dashboard:', error);
  }
}

// Listeners
async function loadListeners() {
  try {
    const listeners = await ipcRenderer.invoke('get-all-listeners');
    const container = document.getElementById('listeners-list');
    
    if (listeners.length === 0) {
      container.innerHTML = '<div class="card"><div class="empty-state">No listeners configured</div></div>';
    } else {
      container.innerHTML = listeners.map(listener => `
        <div class="card">
          <h3>${listener.name}</h3>
          <p><strong>Protocol:</strong> ${listener.protocol}</p>
          <p><strong>Address:</strong> ${listener.bindingIp}:${listener.port}</p>
          <p><strong>Status:</strong> ${listener.enabled ? '<span class="tag tag-success">Enabled</span>' : '<span class="tag tag-danger">Disabled</span>'}</p>
          <div style="margin-top: 15px;">
            <button class="btn btn-success" onclick="startListener(${listener.id})">Start</button>
            <button class="btn btn-warning" onclick="stopListener(${listener.id})">Stop</button>
            <button class="btn btn-primary" onclick="editListener(${listener.id})">Edit</button>
            <button class="btn btn-danger" onclick="deleteListener(${listener.id})">Delete</button>
          </div>
        </div>
      `).join('');
    }
  } catch (error) {
    console.error('Error loading listeners:', error);
  }
}

// Users
async function loadUsers() {
  try {
    const users = await ipcRenderer.invoke('get-all-users');
    const tbody = document.querySelector('#users-table tbody');
    
    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No users configured</td></tr>';
    } else {
      tbody.innerHTML = users.map(user => `
        <tr>
          <td>${user.username}</td>
          <td>${user.passwordEnabled ? '<span class="tag tag-success">Enabled</span>' : '<span class="tag tag-danger">Disabled</span>'}</td>
          <td>${user.publicKey ? '<span class="tag tag-success">Enabled</span>' : '<span class="tag tag-danger">Disabled</span>'}</td>
          <td>${user.guiEnabled ? '<span class="tag tag-success">Enabled</span>' : '<span class="tag tag-danger">Disabled</span>'}</td>
          <td>
            <button class="btn btn-primary" onclick="editUser('${user.username}')">Edit</button>
            <button class="btn btn-primary" onclick="showUserSubscriptions('${user.username}')">Subscriptions</button>
            <button class="btn btn-primary" onclick="showUserVirtualPaths('${user.username}')">Virtual Paths</button>
            <button class="btn btn-danger" onclick="deleteUser('${user.username}')">Delete</button>
          </td>
        </tr>
      `).join('');
    }
  } catch (error) {
    console.error('Error loading users:', error);
  }
}

// Sessions
async function loadSessions() {
  try {
    const sessions = await ipcRenderer.invoke('get-active-sessions');
    const tbody = document.getElementById('sessions-table-body');
    
    if (sessions.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No active sessions</td></tr>';
    } else {
      tbody.innerHTML = sessions.map(session => `
        <tr>
          <td>${session.username}</td>
          <td>${session.protocol}</td>
          <td>${session.listenerName || 'Unknown'}</td>
          <td>${session.ipAddress}</td>
          <td>${new Date(session.connectedSince).toLocaleString()}</td>
          <td>
            <button class="btn btn-danger" onclick="disconnectSession('${session.sessionId}')">Disconnect</button>
          </td>
        </tr>
      `).join('');
    }
  } catch (error) {
    console.error('Error loading sessions:', error);
  }
}

function startSessionsRefresh() {
  stopSessionsRefresh();
  sessionsRefreshInterval = setInterval(loadSessions, 5000);
}

function stopSessionsRefresh() {
  if (sessionsRefreshInterval) {
    clearInterval(sessionsRefreshInterval);
    sessionsRefreshInterval = null;
  }
}

// Activity Log
async function loadActivityLog() {
  try {
    const activity = await ipcRenderer.invoke('get-activity', 100);
    const container = document.getElementById('full-activity-log');
    document.getElementById('activityCount').textContent = activity.length;
    
    if (activity.length === 0) {
      container.innerHTML = '<div class="empty-state">No activity logged</div>';
    } else {
      container.innerHTML = activity.map(a => `
        <div class="activity-item ${a.success ? 'activity-success' : 'activity-error'}">
          [${new Date(a.timestamp).toLocaleString()}] ${a.username}: ${a.action} ${a.path} - ${a.success ? 'Success' : 'Failed'}
        </div>
      `).join('');
    }
  } catch (error) {
    console.error('Error loading activity log:', error);
  }
}

async function clearAllActivities() {
  if (confirm('Are you sure you want to clear all activity logs?')) {
    try {
      await ipcRenderer.invoke('clear-activity');
      loadActivityLog();
    } catch (error) {
      console.error('Error clearing activity log:', error);
      alert('Failed to clear activity log');
    }
  }
}

// Modal functions
function showModal(modalId) {
  document.getElementById(modalId).classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

// Listener actions
function showAddListenerModal() {
  document.getElementById('addListenerForm').reset();
  showModal('addListenerModal');
}

async function editListener(id) {
  try {
    const listener = await ipcRenderer.invoke('get-listener', id);
    if (listener) {
      const form = document.getElementById('editListenerForm');
      form.elements['id'].value = listener.id;
      form.elements['name'].value = listener.name;
      form.elements['protocol'].value = listener.protocol;
      form.elements['bindingIp'].value = listener.bindingIp;
      form.elements['port'].value = listener.port;
      form.elements['enabled'].checked = listener.enabled;
      showModal('editListenerModal');
    }
  } catch (error) {
    console.error('Error loading listener:', error);
    alert('Failed to load listener details');
  }
}

async function startListener(id) {
  try {
    await ipcRenderer.invoke('start-listener', id);
    loadListeners();
    loadDashboard();
  } catch (error) {
    console.error('Error starting listener:', error);
    alert('Failed to start listener');
  }
}

async function stopListener(id) {
  try {
    await ipcRenderer.invoke('stop-listener', id);
    loadListeners();
    loadDashboard();
  } catch (error) {
    console.error('Error stopping listener:', error);
    alert('Failed to stop listener');
  }
}

async function deleteListener(id) {
  if (confirm('Are you sure you want to delete this listener?')) {
    try {
      await ipcRenderer.invoke('delete-listener', id);
      loadListeners();
      loadDashboard();
    } catch (error) {
      console.error('Error deleting listener:', error);
      alert('Failed to delete listener');
    }
  }
}

// User actions
function showAddUserModal() {
  document.getElementById('addUserForm').reset();
  showModal('addUserModal');
}

async function editUser(username) {
  try {
    const user = await ipcRenderer.invoke('get-user', username);
    if (user) {
      const form = document.getElementById('editUserForm');
      form.elements['originalUsername'].value = user.username;
      form.elements['username'].value = user.username;
      form.elements['password'].value = '';
      form.elements['publicKey'].value = user.publicKey || '';
      form.elements['guiEnabled'].checked = user.guiEnabled;
      showModal('editUserModal');
    }
  } catch (error) {
    console.error('Error loading user:', error);
    alert('Failed to load user details');
  }
}

async function deleteUser(username) {
  if (confirm(`Are you sure you want to delete user "${username}"?`)) {
    try {
      await ipcRenderer.invoke('delete-user', username);
      loadUsers();
      loadDashboard();
    } catch (error) {
      console.error('Error deleting user:', error);
      alert('Failed to delete user');
    }
  }
}

async function showUserSubscriptions(username) {
  try {
    const subscriptions = await ipcRenderer.invoke('get-user-subscriptions', username);
    const listeners = await ipcRenderer.invoke('get-all-listeners');
    
    const content = document.getElementById('userSubscriptionsContent');
    content.innerHTML = `
      <h3>Subscriptions for ${username}</h3>
      <div style="margin-bottom: 20px;">
        <label><strong>Add subscription:</strong></label>
        <select id="subscriptionListener" style="width: 100%; padding: 8px; margin-top: 5px;">
          ${listeners.filter(l => !subscriptions.includes(l.id)).map(l => `<option value="${l.id}">${l.name}</option>`).join('')}
        </select>
        <button class="btn btn-primary" onclick="addUserSubscription('${username}')" style="margin-top: 10px;">Add</button>
      </div>
      <div>
        <strong>Current subscriptions:</strong>
        ${subscriptions.length === 0 ? '<p class="empty-state">No subscriptions</p>' : 
          subscriptions.map(subId => {
            const listener = listeners.find(l => l.id === subId);
            return listener ? `
              <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: #f8f9fa; border-radius: 4px; margin-bottom: 8px;">
                <span>${listener.name}</span>
                <button class="btn btn-danger" onclick="removeUserSubscription('${username}', ${subId})">Remove</button>
              </div>
            ` : '';
          }).join('')}
      </div>
    `;
    showModal('userSubscriptionsModal');
  } catch (error) {
    console.error('Error loading user subscriptions:', error);
    alert('Failed to load user subscriptions');
  }
}

async function addUserSubscription(username) {
  try {
    const listenerId = parseInt(document.getElementById('subscriptionListener').value);
    await ipcRenderer.invoke('add-user-subscription', username, listenerId);
    showUserSubscriptions(username);
  } catch (error) {
    console.error('Error adding user subscription:', error);
    alert('Failed to add subscription');
  }
}

async function removeUserSubscription(username, listenerId) {
  try {
    await ipcRenderer.invoke('remove-user-subscription', username, listenerId);
    showUserSubscriptions(username);
  } catch (error) {
    console.error('Error removing user subscription:', error);
    alert('Failed to remove subscription');
  }
}

async function showUserVirtualPaths(username) {
  try {
    const virtualPaths = await ipcRenderer.invoke('get-user-virtual-paths', username);
    
    const content = document.getElementById('userVirtualPathsContent');
    content.innerHTML = `
      <h3>Virtual Paths for ${username}</h3>
      <div style="margin-bottom: 20px;">
        <label><strong>Add virtual path:</strong></label>
        <div style="margin-top: 10px;">
          <input type="text" id="virtualPath" placeholder="/remote/path" style="width: 100%; padding: 8px; margin-bottom: 10px;">
          <input type="text" id="localPath" placeholder="/local/path" style="width: 100%; padding: 8px; margin-bottom: 10px;">
          <button class="btn btn-primary" onclick="addUserVirtualPath('${username}')">Add</button>
        </div>
      </div>
      <div>
        <strong>Current virtual paths:</strong>
        ${virtualPaths.length === 0 ? '<p class="empty-state">No virtual paths</p>' : 
          virtualPaths.map(vp => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: #f8f9fa; border-radius: 4px; margin-bottom: 8px;">
              <div>
                <div><strong>Virtual:</strong> ${vp.virtualPath}</div>
                <div><strong>Local:</strong> ${vp.localPath}</div>
              </div>
              <button class="btn btn-danger" onclick="removeUserVirtualPath('${username}', ${vp.id})">Remove</button>
            </div>
          `).join('')}
      </div>
    `;
    showModal('userVirtualPathsModal');
  } catch (error) {
    console.error('Error loading user virtual paths:', error);
    alert('Failed to load user virtual paths');
  }
}

async function addUserVirtualPath(username) {
  try {
    const virtualPath = document.getElementById('virtualPath').value;
    const localPath = document.getElementById('localPath').value;
    
    if (!virtualPath || !localPath) {
      alert('Please fill in both virtual and local paths');
      return;
    }
    
    await ipcRenderer.invoke('add-user-virtual-path', username, virtualPath, localPath);
    showUserVirtualPaths(username);
  } catch (error) {
    console.error('Error adding user virtual path:', error);
    alert('Failed to add virtual path');
  }
}

async function removeUserVirtualPath(username, id) {
  try {
    await ipcRenderer.invoke('remove-user-virtual-path', username, id);
    showUserVirtualPaths(username);
  } catch (error) {
    console.error('Error removing user virtual path:', error);
    alert('Failed to remove virtual path');
  }
}

async function disconnectSession(sessionId) {
  if (confirm('Are you sure you want to disconnect this session?')) {
    try {
      await ipcRenderer.invoke('disconnect-session', sessionId);
      loadSessions();
    } catch (error) {
      console.error('Error disconnecting session:', error);
      alert('Failed to disconnect session');
    }
  }
}

// Form handlers
function setupFormHandlers() {
  // Add listener form
  document.getElementById('addListenerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const listener = {
      name: form.elements['name'].value,
      protocol: form.elements['protocol'].value,
      bindingIp: form.elements['bindingIp'].value,
      port: parseInt(form.elements['port'].value),
      enabled: form.elements['enabled'].checked
    };
    
    try {
      await ipcRenderer.invoke('create-listener', listener);
      closeModal('addListenerModal');
      loadListeners();
      loadDashboard();
    } catch (error) {
      console.error('Error creating listener:', error);
      alert('Failed to create listener');
    }
  });
  
  // Edit listener form
  document.getElementById('editListenerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const listener = {
      id: parseInt(form.elements['id'].value),
      name: form.elements['name'].value,
      protocol: form.elements['protocol'].value,
      bindingIp: form.elements['bindingIp'].value,
      port: parseInt(form.elements['port'].value),
      enabled: form.elements['enabled'].checked
    };
    
    try {
      await ipcRenderer.invoke('update-listener', listener);
      closeModal('editListenerModal');
      loadListeners();
      loadDashboard();
    } catch (error) {
      console.error('Error updating listener:', error);
      alert('Failed to update listener');
    }
  });
  
  // Add user form
  document.getElementById('addUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const user = {
      username: form.elements['username'].value,
      password: form.elements['password'].value,
      publicKey: form.elements['publicKey'].value,
      guiEnabled: form.elements['guiEnabled'].checked
    };
    
    try {
      await ipcRenderer.invoke('create-user', user);
      closeModal('addUserModal');
      loadUsers();
      loadDashboard();
    } catch (error) {
      console.error('Error creating user:', error);
      alert('Failed to create user');
    }
  });
  
  // Edit user form
  document.getElementById('editUserForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const user = {
      originalUsername: form.elements['originalUsername'].value,
      username: form.elements['username'].value,
      password: form.elements['password'].value,
      publicKey: form.elements['publicKey'].value,
      guiEnabled: form.elements['guiEnabled'].checked
    };
    
    try {
      await ipcRenderer.invoke('update-user', user);
      closeModal('editUserModal');
      loadUsers();
      loadDashboard();
    } catch (error) {
      console.error('Error updating user:', error);
      alert('Failed to update user');
    }
  });
}