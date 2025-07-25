const ws = new WebSocket('ws://' + window.location.hostname + ':9123');
const logBox = document.getElementById('logs');
const filterInput = document.getElementById('filter');
const statusEl = document.getElementById('status');
const logCountEl = document.getElementById('log-count');
const pauseButton = document.getElementById('pause-button');

let allLogs = [];
let filteredLogs = [];
let pendingMessages = [];
let renderTimeout = null;
let filterTimeout = null;
let connectionStartTime = null;
let messagesReceived = 0;
let totalBytesReceived = 0;
let userHasScrolledUp = false;
let manuallyPaused = false; // New variable for manual pause state
const MAX_LOGS = 500; // Increased from 1000 for more log history
const BATCH_SIZE = 50; // Increased from 10 to 50 for faster processing 
const RENDER_DELAY = 25; // Reduced from 100ms to 25ms for faster response

// Client-side logging utility
const ClientLogger = {
  log: function(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...data
    };
    console.log(`[${level.toUpperCase()}] ${timestamp} - ${message}`, data);
  },
  
  info: function(message, data) { this.log('info', message, data); },
  warn: function(message, data) { this.log('warn', message, data); },
  error: function(message, data) { this.log('error', message, data); },
  debug: function(message, data) { this.log('debug', message, data); }
};

// Connection status management
ws.onopen = () => {
  connectionStartTime = Date.now();
  statusEl.textContent = 'Connected';
  statusEl.className = 'status-connected';
  
  // Initialize log count display
  updateScrollStatus();
  
  ClientLogger.info('WebSocket connection established', {
    url: ws.url,
    protocol: ws.protocol,
    readyState: ws.readyState
  });
};

ws.onclose = (event) => {
  const sessionDuration = connectionStartTime ? Date.now() - connectionStartTime : 0;
  statusEl.textContent = 'Disconnected';
  statusEl.className = 'status-disconnected';
  
  ClientLogger.warn('WebSocket connection closed', {
    code: event.code,
    reason: event.reason,
    wasClean: event.wasClean,
    sessionDuration: sessionDuration,
    messagesReceived: messagesReceived,
    totalBytesReceived: totalBytesReceived
  });
};

ws.onerror = (error) => {
  statusEl.textContent = 'Error';
  statusEl.className = 'status-disconnected';
  
  ClientLogger.error('WebSocket connection error', {
    error: error,
    readyState: ws.readyState,
    url: ws.url
  });
};

// Message batching and rate limiting
ws.onmessage = (event) => {
  const dataSize = new Blob([event.data]).size;
  totalBytesReceived += dataSize;
  messagesReceived++;
  
  const lines = event.data.split('\n').filter(line => line.trim());
  pendingMessages.push(...lines);
  
  ClientLogger.debug('WebSocket message received', {
    messageSize: dataSize,
    linesCount: lines.length,
    totalMessages: messagesReceived,
    totalBytes: totalBytesReceived,
    pendingMessagesCount: pendingMessages.length
  });
  
  // Immediate processing for high-volume scenarios
  if (!renderTimeout) {
    const immediateDelay = pendingMessages.length > 100 ? 5 : RENDER_DELAY;
    renderTimeout = setTimeout(processPendingMessages, immediateDelay);
  }
};

function processPendingMessages() {
  // If user has scrolled up or manually paused, don't process new messages - just keep them pending
  if (userHasScrolledUp || manuallyPaused) {
    const reason = manuallyPaused ? 'manually paused' : 'user scrolled up';
    ClientLogger.debug(`Log processing paused - ${reason}`, {
      pendingMessagesCount: pendingMessages.length
    });
    renderTimeout = null;
    updateScrollStatus();
    return;
  }
  
  // Process larger batches when there are many pending messages
  const adaptiveBatchSize = pendingMessages.length > 200 ? Math.min(100, pendingMessages.length) : BATCH_SIZE;
  const batch = pendingMessages.splice(0, adaptiveBatchSize);
  
  batch.forEach(line => {
    allLogs.push(line);
  });
  
  // Trim logs more aggressively when we have too many
  const logsRemoved = Math.max(0, allLogs.length - MAX_LOGS);
  if (allLogs.length > MAX_LOGS) {
    allLogs.splice(0, allLogs.length - MAX_LOGS);
  }
  
  if (batch.length > 0) {
    ClientLogger.debug('Processed message batch', {
      batchSize: batch.length,
      adaptiveBatchSize: adaptiveBatchSize,
      totalLogs: allLogs.length,
      logsRemoved: logsRemoved,
      pendingMessages: pendingMessages.length
    });
  }
  
  // Apply filter and render only when batch processing is complete or every few batches
  const shouldRender = pendingMessages.length < 50 || batch.length >= 50;
  if (shouldRender) {
    applyFilter();
  }
  
  // Continue processing if more messages are pending - use shorter delay for high volume
  if (pendingMessages.length > 0) {
    const adaptiveDelay = pendingMessages.length > 100 ? 10 : RENDER_DELAY;
    renderTimeout = setTimeout(processPendingMessages, adaptiveDelay);
  } else {
    renderTimeout = null;
    // Ensure final render if we skipped some
    if (!shouldRender) {
      applyFilter();
    }
  }
  
  // Update log count display
  updateLogCount();
  updateScrollStatus();
}

// Debounced filter input
filterInput.addEventListener('input', () => {
  clearTimeout(filterTimeout);
  const filterValue = filterInput.value;
  
  ClientLogger.debug('Filter input changed', {
    filterLength: filterValue.length,
    filterValue: filterValue.substring(0, 50) // Log first 50 chars only
  });
  
  filterTimeout = setTimeout(applyFilter, 150);
});

// Pause/Resume button functionality
pauseButton.addEventListener('click', () => {
  manuallyPaused = !manuallyPaused;
  
  if (manuallyPaused) {
    pauseButton.textContent = '▶️ Resume';
    pauseButton.classList.add('paused');
    ClientLogger.info('Log processing manually paused');
  } else {
    pauseButton.textContent = '⏸️ Pause';
    pauseButton.classList.remove('paused');
    ClientLogger.info('Log processing manually resumed');
    
    // Resume processing if there are pending messages
    if (pendingMessages.length > 0 && !renderTimeout) {
      renderTimeout = setTimeout(processPendingMessages, RENDER_DELAY);
    }
  }
  
  updateScrollStatus();
});

function applyFilter() {
  const keyword = filterInput.value.toLowerCase();
  const startTime = performance.now();
  
  // Skip filtering and rendering if we have too many pending messages (prioritize processing)
  if (pendingMessages.length > 500) {
    ClientLogger.debug('Skipping filter during high load', {
      pendingMessages: pendingMessages.length
    });
    return;
  }
  
  // Filter logs efficiently with early termination for performance
  if (keyword) {
    filteredLogs = [];
    for (let i = 0; i < allLogs.length; i++) {
      if (allLogs[i].toLowerCase().includes(keyword)) {
        filteredLogs.push(allLogs[i]);
      }
    }
  } else {
    filteredLogs = [...allLogs];
  }
  
  const filterTime = performance.now() - startTime;
  
  ClientLogger.debug('Filter applied', {
    keyword: keyword.substring(0, 20), // Log first 20 chars only
    totalLogs: allLogs.length,
    filteredLogs: filteredLogs.length,
    filterTimeMs: filterTime.toFixed(2)
  });
  
  renderLogs();
  
  // Update log count display
  updateLogCount();
}

function renderLogs() {
  const startTime = performance.now();
  
  // Use document fragment for efficient DOM updates
  const fragment = document.createDocumentFragment();
  
  // Only render the last N logs to prevent DOM bloat - increased for better UX
  const logsToRender = filteredLogs.slice(-500); // Increased from 300 to 500
  
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  
  // Use more efficient DOM creation
  logsToRender.forEach(line => {
    const div = document.createElement('div');
    div.className = 'log-line';

    // Optimized regex patterns with early termination
    if (/\s500\s|fatal|[Ee]rror|php fatal|proxy_error|error_log/.test(line)) {
      div.className += ' log-error';
      errorCount++;
    } else if (/\s4\d\d\s|[Ww]arning|php warning|proxy_warn/.test(line)) {
      div.className += ' log-warning';
      warningCount++;
    } else if (/\s2\d\d\s|[Ii]nfo|access_log/.test(line)) {
      div.className += ' log-info';
      infoCount++;
    }

    div.textContent = line;
    fragment.appendChild(div);
  });
  
  // Use requestAnimationFrame for smoother updates during high load
  requestAnimationFrame(() => {
    // Replace all content at once
    logBox.innerHTML = '';
    logBox.appendChild(fragment);
    
    // Only auto-scroll if user hasn't manually scrolled up
    if (!userHasScrolledUp) {
      logBox.scrollTop = logBox.scrollHeight;
    }
  });
  
  const renderTime = performance.now() - startTime;
  
  ClientLogger.debug('Logs rendered', {
    logsRendered: logsToRender.length,
    errorCount,
    warningCount,
    infoCount,
    renderTimeMs: renderTime.toFixed(2)
  });
}

// Function to update log count display
function updateLogCount() {
  if (logCountEl) {
    const isPending = (userHasScrolledUp || manuallyPaused) && pendingMessages.length > 0;
    const isHighLoad = pendingMessages.length > 100;
    
    let statusText = `${filteredLogs.length} lines`;
    if (isPending) {
      statusText += ` (${pendingMessages.length} pending)`;
    }
    if (isHighLoad && !isPending) {
      statusText += ` (⚡ processing ${pendingMessages.length})`;
    }
    
    logCountEl.textContent = statusText;
  }
}

// Function to update scroll status indicator
function updateScrollStatus() {
  // Update visual indicator when logs are paused or under high load
  if (logCountEl) {
    const isPending = (userHasScrolledUp || manuallyPaused) && pendingMessages.length > 0;
    const isHighLoad = pendingMessages.length > 100 && !isPending;
    
    logCountEl.classList.remove('log-count-paused', 'log-count-high-load');
    
    if (isPending) {
      logCountEl.classList.add('log-count-paused');
    } else if (isHighLoad) {
      logCountEl.classList.add('log-count-high-load');
    }
  }
  updateLogCount();
}

// Detect user scrolling to prevent auto-scroll
logBox.addEventListener('scroll', () => {
  const isAtBottom = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 5;
  const wasScrolledUp = userHasScrolledUp;
  userHasScrolledUp = !isAtBottom;
  
  // If user just scrolled back to bottom and there are pending messages, resume processing (only if not manually paused)
  if (wasScrolledUp && !userHasScrolledUp && !manuallyPaused && pendingMessages.length > 0) {
    ClientLogger.info('User scrolled to bottom - resuming log processing', {
      pendingMessagesCount: pendingMessages.length
    });
    
    // Resume processing pending messages
    if (!renderTimeout) {
      renderTimeout = setTimeout(processPendingMessages, RENDER_DELAY);
    }
  }
  
  // Update status when scroll state changes
  if (wasScrolledUp !== userHasScrolledUp) {
    updateScrollStatus();
    
    ClientLogger.debug('Scroll state changed', {
      scrollTop: logBox.scrollTop,
      clientHeight: logBox.clientHeight,
      scrollHeight: logBox.scrollHeight,
      isAtBottom,
      userHasScrolledUp,
      manuallyPaused,
      pendingMessages: pendingMessages.length
    });
  }
});

// Initialize client-side logging and performance monitoring
ClientLogger.info('Live log stream client initialized', {
  userAgent: navigator.userAgent,
  windowDimensions: {
    width: window.innerWidth,
    height: window.innerHeight
  },
  url: window.location.href,
  websocketUrl: ws.url
});

// Performance monitoring
let lastStatsReport = Date.now();
const STATS_INTERVAL = 30000; // 30 seconds

setInterval(() => {
  const now = Date.now();
  const timeSinceLastReport = now - lastStatsReport;
  
  if (timeSinceLastReport >= STATS_INTERVAL) {
    const sessionDuration = connectionStartTime ? now - connectionStartTime : 0;
    
    ClientLogger.info('Client performance stats', {
      sessionDuration,
      messagesReceived,
      totalBytesReceived,
      currentLogsCount: allLogs.length,
      filteredLogsCount: filteredLogs.length,
      pendingMessagesCount: pendingMessages.length,
      connectionState: ws.readyState,
      memoryUsage: performance.memory ? {
        used: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
        total: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024),
        limit: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024)
      } : 'unavailable'
    });
    
    lastStatsReport = now;
  }
}, 5000); // Check every 5 seconds

// Handle page visibility changes
document.addEventListener('visibilitychange', () => {
  ClientLogger.info('Page visibility changed', {
    hidden: document.hidden,
    visibilityState: document.visibilityState
  });
});

// Handle page unload
window.addEventListener('beforeunload', () => {
  const sessionDuration = connectionStartTime ? Date.now() - connectionStartTime : 0;
  
  ClientLogger.info('Page unloading', {
    sessionDuration,
    messagesReceived,
    totalBytesReceived,
    finalLogsCount: allLogs.length
  });
});
