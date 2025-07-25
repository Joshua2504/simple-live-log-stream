// WebSocket connection management
let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isReconnecting = false;
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 30000; // 30 seconds

const logBox = document.getElementById('logs');
const textSearchInput = document.getElementById('text-search');
const statusEl = document.getElementById('status');
const logCountEl = document.getElementById('log-count');
const pauseButton = document.getElementById('pause-button');

let allLogs = [];
let pendingMessages = [];
let renderTimeout = null;
let searchTimeout = null;
let connectionStartTime = null;
let messagesReceived = 0;
let totalBytesReceived = 0;
let userHasScrolledUp = false;
let manuallyPaused = false; // New variable for manual pause state
let currentTextSearch = ''; // Track current text search for server communication
let filterJustApplied = false; // Flag to track when a new filter was just applied
const MAX_LOGS = 1000; // Keep only 1000 logs at all times - client displays all of them
const BATCH_SIZE = 100; // Increased from 10 to 50 for faster processing 
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

// WebSocket connection and reconnection management
function createWebSocketConnection() {
  const wsUrl = 'ws://' + window.location.hostname + ':9123';
  
  ClientLogger.info('Creating WebSocket connection', {
    url: wsUrl,
    attemptNumber: reconnectAttempts + 1,
    isReconnecting: isReconnecting
  });
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = handleWebSocketOpen;
  ws.onclose = handleWebSocketClose;
  ws.onerror = handleWebSocketError;
  ws.onmessage = handleWebSocketMessage;
}

function handleWebSocketOpen() {
  connectionStartTime = Date.now();
  statusEl.textContent = 'Connected';
  statusEl.className = 'status-connected';
  
  // Reset reconnection state on successful connection
  reconnectAttempts = 0;
  isReconnecting = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  // Initialize log count display
  updateScrollStatus();
  
  ClientLogger.info('WebSocket connection established', {
    url: ws.url,
    protocol: ws.protocol,
    readyState: ws.readyState,
    wasReconnecting: isReconnecting
  });
  
  // Clear existing logs to prepare for server history
  allLogs = [];
  pendingMessages = [];
  
  // Send current text search to server if it exists
  if (currentTextSearch) {
    sendTextSearchToServer(currentTextSearch);
  }
  
  // Update display immediately
  updateLogCount();
  renderLogs();
}

function handleWebSocketClose(event) {
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
  
  // Attempt to reconnect unless it was a clean close or we've exceeded max attempts
  if (!event.wasClean && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    attemptReconnection();
  } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    statusEl.textContent = 'Connection Failed';
    statusEl.className = 'status-disconnected';
    ClientLogger.error('Max reconnection attempts reached', {
      maxAttempts: MAX_RECONNECT_ATTEMPTS,
      totalAttempts: reconnectAttempts
    });
  }
}

function handleWebSocketError(error) {
  statusEl.textContent = 'Connection Error';
  statusEl.className = 'status-disconnected';
  
  ClientLogger.error('WebSocket connection error', {
    error: error,
    readyState: ws ? ws.readyState : 'null',
    url: ws ? ws.url : 'unknown'
  });
}

function attemptReconnection() {
  if (isReconnecting || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    return;
  }
  
  isReconnecting = true;
  reconnectAttempts++;
  
  // Calculate exponential backoff delay
  const baseDelay = INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
  const delay = Math.min(baseDelay, MAX_RECONNECT_DELAY);
  
  statusEl.textContent = `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`;
  statusEl.className = 'status-reconnecting';
  
  ClientLogger.info('Attempting to reconnect', {
    attemptNumber: reconnectAttempts,
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    delayMs: delay
  });
  
  reconnectTimer = setTimeout(() => {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      createWebSocketConnection();
    }
  }, delay);
}

// Message batching and rate limiting
function handleWebSocketMessage(event) {
  const dataSize = new Blob([event.data]).size;
  totalBytesReceived += dataSize;
  messagesReceived++;
  
  const lines = event.data.split('\n').filter(line => line.trim());
  
  // Check if this looks like a large initial batch (server history)
  const isLikelyHistoryBatch = lines.length > 100 && allLogs.length === 0;
  
  if (isLikelyHistoryBatch) {
    ClientLogger.info('Received log history from server', {
      linesCount: lines.length,
      messageSize: dataSize
    });
    
    // For history, add directly to allLogs without pending queue
    allLogs.push(...lines);
    
    // Ensure we don't exceed MAX_LOGS
    if (allLogs.length > MAX_LOGS) {
      allLogs.splice(0, allLogs.length - MAX_LOGS);
    }
    
    // Render immediately for history (no client-side filtering needed)
    renderLogs();
    updateLogCount();
    updateScrollStatus();
  } else {
    // Regular streaming logs - use existing pending queue system
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
  }
}

function processPendingMessages() {
  // If user has scrolled up or manually paused, don't process new messages - just keep them pending
  // EXCEPTION: If a filter was just applied, process the filtered results immediately
  if ((userHasScrolledUp || manuallyPaused) && !filterJustApplied) {
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
  
  // Ensure we never exceed MAX_LOGS (1000) - trim immediately after adding
  if (allLogs.length > MAX_LOGS) {
    const excess = allLogs.length - MAX_LOGS;
    allLogs.splice(0, excess);
  }
  
  // Clear the filterJustApplied flag after processing the first batch of filtered results
  if (filterJustApplied) {
    filterJustApplied = false;
    ClientLogger.info('Processed first batch of filtered results');
  }
  
  if (batch.length > 0) {
    ClientLogger.debug('Processed message batch', {
      batchSize: batch.length,
      adaptiveBatchSize: adaptiveBatchSize,
      totalLogs: allLogs.length,
      pendingMessages: pendingMessages.length
    });
  }
  
  // Apply filter and render only when batch processing is complete or every few batches
  const shouldRender = pendingMessages.length < 50 || batch.length >= 50;
  if (shouldRender) {
    renderLogs(); // No client-side filtering needed - server already filtered
  }
  
  // Continue processing if more messages are pending - use shorter delay for high volume
  if (pendingMessages.length > 0) {
    const adaptiveDelay = pendingMessages.length > 100 ? 10 : RENDER_DELAY;
    renderTimeout = setTimeout(processPendingMessages, adaptiveDelay);
  } else {
    renderTimeout = null;
    // Ensure final render if we skipped some
    if (!shouldRender) {
      renderLogs();
    }
  }
  
  // Update log count display
  updateLogCount();
  updateScrollStatus();
}

// Function to send text search to server
function sendTextSearchToServer(textSearch) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    currentTextSearch = textSearch || '';
    
    // Clear existing logs and set flag when applying new search
    allLogs = [];
    pendingMessages = [];
    filterJustApplied = true;
    
    const message = JSON.stringify({
      type: 'setTextSearch',
      value: currentTextSearch
    });
    
    try {
      ws.send(message);
      ClientLogger.info('Text search sent to server', {
        textSearch: currentTextSearch.substring(0, 30),
        textSearchLength: currentTextSearch.length
      });
      
      // Clear the log display immediately
      renderLogs();
    } catch (error) {
      ClientLogger.error('Failed to send text search to server', {
        error: error.message,
        textSearch: currentTextSearch.substring(0, 30)
      });
    }
  } else {
    ClientLogger.warn('Cannot send text search - WebSocket not connected', {
      readyState: ws ? ws.readyState : 'null',
      textSearch: currentTextSearch.substring(0, 30)
    });
  }
}

// Debounced text search input
textSearchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const searchValue = textSearchInput.value.trim();
  
  ClientLogger.debug('Text search input changed', {
    searchLength: searchValue.length,
    searchValue: searchValue.substring(0, 50)
  });
  
  searchTimeout = setTimeout(() => sendTextSearchToServer(searchValue), 300);
});

// Handle DOM ready for clear button
document.addEventListener('DOMContentLoaded', () => {
  const clearSearchBtn = document.getElementById('clear-search');
  
  clearSearchBtn.addEventListener('click', () => {
    textSearchInput.value = '';
    currentTextSearch = '';
    sendTextSearchToServer('');
  });
});

function clearAllFilters() {
  textSearchInput.value = '';
  currentTextSearch = '';
  sendTextSearchToServer('');
}

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

function renderLogs() {
  const startTime = performance.now();
  
  // Use document fragment for efficient DOM updates
  const fragment = document.createDocumentFragment();
  
  // Server handles all filtering (both regex and text search) - no client-side filtering needed
  let logsToProcess = allLogs.slice(-1000); // Display the last 1000 logs (all filtered results from server)
  
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;
  
  // Use more efficient DOM creation
  logsToProcess.forEach(line => {
    const div = document.createElement('div');
    div.className = 'log-line';

    // Optimized regex patterns with early termination
    if (/\s500\s|fatal|[Ee]rror|error_log|ERROR|FATAL/.test(line)) {
      div.className += ' log-error';
      errorCount++;
    } else if (/\s4\d\d\s|[Ww]arning|WARN|WARNING/.test(line)) {
      div.className += ' log-warning';
      warningCount++;
    } else if (/\s2\d\d\s|[Ii]nfo|INFO|access_log/.test(line)) {
      div.className += ' log-info';
      infoCount++;
    }

    // Server already did all filtering - just display the text
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
    totalLogs: allLogs.length,
    logsDisplayed: logsToProcess.length,
    errorCount,
    warningCount,
    infoCount,
    renderTimeMs: renderTime.toFixed(2),
    currentTextSearch: currentTextSearch.substring(0, 20)
  });
}

// Function to update log count display
function updateLogCount() {
  if (logCountEl) {
    const isPending = (userHasScrolledUp || manuallyPaused) && pendingMessages.length > 0;
    const isHighLoad = pendingMessages.length > 100;
    
    let statusText = `${allLogs.length} lines`;
    
    // Show text search info
    if (currentTextSearch) {
      const searchDisplay = currentTextSearch.length > 10 ? 
        currentTextSearch.substring(0, 10) + '...' : 
        currentTextSearch;
      statusText += ` [search: "${searchDisplay}"]`;
    }
    
    if (isPending) {
      statusText += ` (${pendingMessages.length} pending)`;
    }
    if (isHighLoad && !isPending) {
      statusText += ` (processing ${pendingMessages.length})`;
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
  url: window.location.href
});

// Start initial WebSocket connection
createWebSocketConnection();

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
      pendingMessagesCount: pendingMessages.length,
      currentTextSearch: currentTextSearch.substring(0, 20),
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
  
  // Clear reconnection timer on page unload
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  // Close WebSocket connection cleanly
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'Page unloading');
  }
  
  ClientLogger.info('Page unloading', {
    sessionDuration,
    messagesReceived,
    totalBytesReceived,
    finalLogsCount: allLogs.length,
    finalTextSearch: currentTextSearch.substring(0, 20),
    reconnectAttempts: reconnectAttempts
  });
});
