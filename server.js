const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

// Enhanced logging utility
class Logger {
  static formatTimestamp() {
    return new Date().toISOString();
  }
  
  static log(level, message, data = {}) {
    const timestamp = this.formatTimestamp();
    const logEntry = {
      timestamp,
      level: level.toUpperCase(),
      message,
      ...data
    };
    
    // Console output for Docker logs
    console.log(JSON.stringify(logEntry));
  }
  
  static info(message, data) {
    this.log('info', message, data);
  }
  
  static warn(message, data) {
    this.log('warn', message, data);
  }
  
  static error(message, data) {
    this.log('error', message, data);
  }
  
  static debug(message, data) {
    this.log('debug', message, data);
  }
}

// Function to obfuscate IP addresses in log data
function obfuscateIPAddresses(logData) {
  // IPv4 pattern: matches standard IPv4 addresses
  const ipv4Pattern = /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
  
  // IPv6 pattern: matches standard IPv6 addresses
  const ipv6Pattern = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}\b|\b(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}\b|\b(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}\b|\b[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}\b|\b::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b/g;
  
  // Replace IPv4 addresses with obfuscated version (show first 2 octets, mask the rest)
  let obfuscated = logData.replace(ipv4Pattern, (match) => {
    const parts = match.split('.');
    return `${parts[0]}.${parts[1]}.xxx.xxx`;
  });
  
  // Replace IPv6 addresses with obfuscated version (show first 2 segments, mask the rest)
  obfuscated = obfuscated.replace(ipv6Pattern, (match) => {
    if (match.includes('::')) {
      const firstPart = match.split('::')[0];
      const segments = firstPart.split(':');
      if (segments.length >= 2) {
        return `${segments[0]}:${segments[1]}::xxxx:xxxx:xxxx:xxxx`;
      } else {
        return `${segments[0]}:xxxx::xxxx:xxxx:xxxx:xxxx`;
      }
    } else {
      const parts = match.split(':');
      return `${parts[0]}:${parts[1]}:xxxx:xxxx:xxxx:xxxx:xxxx:xxxx`;
    }
  });
  
  return obfuscated;
}

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    const file = path.join(__dirname, 'index.html');
    res.setHeader('Content-Type', 'text/html');
    fs.createReadStream(file).pipe(res);
  } else if (req.url === '/app.js') {
    const file = path.join(__dirname, 'app.js');
    res.setHeader('Content-Type', 'application/javascript');
    fs.createReadStream(file).pipe(res);
  } else {
    res.writeHead(404);
    res.end();
  }
});

// Global state for managing single log tail process and multiple clients
class LogBroadcaster {
  constructor() {
    this.clients = new Map(); // Changed to Map to store client state including filters
    this.tail = null;
    this.messageBuffer = [];
    this.bufferTimeout = null;
    this.isStarted = false;
    this.BUFFER_SIZE = 100; // Increased from 5 to 50 for better throughput
    this.BUFFER_DELAY = 50; // Reduced from 100ms to 50ms for faster transmission
    
    // Server-side log storage
    this.storedLogs = [];
    this.MAX_STORED_LOGS = 5000; // Store last 5,000 logs server-side
    this.CLIENT_HISTORY_LIMIT = 1000; // Send last 1,000 matching logs to new clients (after filtering)
    
    // Stats tracking
    this.stats = {
      totalMessagesProcessed: 0,
      totalBytesProcessed: 0,
      totalClientConnections: 0,
      totalClientDisconnections: 0,
      totalMessagesSent: 0,
      totalBytesSent: 0,
      lastStatsReset: Date.now()
    };
    
    // Start periodic stats logging
    this.startStatsReporting();
  }

  addClient(ws, clientInfo) {
    // Store client with text search state only
    const clientData = { 
      ws, 
      clientInfo, 
      messagesSent: 0, 
      totalBytesSent: 0,
      textSearch: '', // Current text search
      textSearchLowerCase: '' // Pre-computed lowercase for performance
    };
    
    this.clients.set(ws, clientData);
    this.stats.totalClientConnections++;

    // Send stored log history to new client immediately
    this.sendLogHistoryToClient(clientData);

    // Tail process is always running, no need to start it here
  }

  removeClient(ws, clientInfo) {
    // Find and remove the client
    const client = this.clients.get(ws);
    if (client) {
      this.stats.totalClientDisconnections++;
      this.clients.delete(ws);
    }

    // Keep the tail process running even if no clients remain
    // The process will be stopped only on server shutdown
  }

  startTailProcess() {
    if (this.isStarted) return;

    // First, read the last 5000 lines from existing log files to populate stored logs
    const initialRead = spawn('bash', ['-c',
      `find /mnt/vhosts/*/logs/ -type f ! -name "*.gz" -exec tail -n 100 {} + | tail -n ${this.MAX_STORED_LOGS} | ts '[%Y-%m-%d %H:%M:%S]'`
    ]);

    initialRead.stdout.on('data', (data) => {
      const logData = data.toString().trim();
      if (!logData) return;
      
      const logLines = logData.split('\n').filter(line => line.trim());
      const obfuscatedLines = logLines.map(line => obfuscateIPAddresses(line));
      
      // Add to stored logs
      this.storedLogs.push(...obfuscatedLines);
      if (this.storedLogs.length > this.MAX_STORED_LOGS) {
        const excess = this.storedLogs.length - this.MAX_STORED_LOGS;
        this.storedLogs.splice(0, excess);
      }
    });

    initialRead.on('close', () => {
      // Now start the live tail process
      this.tail = spawn('bash', ['-c',
        `find /mnt/vhosts/*/logs/ -type f ! -name "*.gz" -exec tail -f -n 0 {} + | ts '[%Y-%m-%d %H:%M:%S]'`
      ]);

      this.isStarted = true;

      this.tail.stdout.on('data', (data) => {
        const logData = data.toString().trim();
        if (!logData) return;
        
        // Update stats
        this.stats.totalBytesProcessed += Buffer.byteLength(logData);
        
        // Store logs server-side for new clients
        const logLines = logData.split('\n').filter(line => line.trim());
        const obfuscatedLines = logLines.map(line => obfuscateIPAddresses(line));
        
        this.stats.totalMessagesProcessed += obfuscatedLines.length;
        
        // Add to stored logs with size limit
        this.storedLogs.push(...obfuscatedLines);
        if (this.storedLogs.length > this.MAX_STORED_LOGS) {
          const excess = this.storedLogs.length - this.MAX_STORED_LOGS;
          this.storedLogs.splice(0, excess);
        }
        
        // Add to buffer for broadcasting to existing clients
        this.messageBuffer.push(...obfuscatedLines);
        
        // Send buffer when it's full or after timeout
        if (this.messageBuffer.length >= this.BUFFER_SIZE) {
          clearTimeout(this.bufferTimeout);
          this.broadcastBufferedMessages();
        } else if (!this.bufferTimeout) {
          this.bufferTimeout = setTimeout(() => this.broadcastBufferedMessages(), this.BUFFER_DELAY);
        }
      });

      this.tail.stderr.on('data', (data) => {
        // Only log critical errors, not routine stderr output
        const errorText = data.toString();
        if (errorText.includes('No such file') || errorText.includes('Permission denied') || errorText.includes('fatal')) {
          Logger.error('Critical tail process error', { 
            error: errorText,
            pid: this.tail.pid
          });
        }
      });

      this.tail.on('close', (code, signal) => {
        Logger.warn('Global log tail process closed', { 
          code, 
          signal, 
          pid: this.tail.pid,
          clientCount: this.clients.size
        });
        this.isStarted = false;
      });

      this.tail.on('error', (error) => {
        Logger.error('Global log tail process error', { 
          error: error.message,
          pid: this.tail.pid,
          clientCount: this.clients.size
        });
        this.isStarted = false;
      });
    });
  }

  stopTailProcess() {
    if (!this.isStarted || !this.tail) return;

    clearTimeout(this.bufferTimeout);
    this.bufferTimeout = null;

    if (!this.tail.killed) {
      this.tail.kill();
    }

    this.isStarted = false;
    this.tail = null;
    this.messageBuffer = [];
    this.stopStatsReporting();
    // Keep stored logs even when tail process stops for immediate client serving
  }

  sendLogHistoryToClient(client) {
    if (this.storedLogs.length === 0) {
      return;
    }

    // If there's a text search filter, we need to search through more logs
    // to find up to 1,000 matching results
    let filteredLogs;
    if (client.textSearch) {
      // Filter all stored logs first, then take the last 1,000 matches
      const allFilteredLogs = this.filterLogsForClient(client, this.storedLogs);
      filteredLogs = allFilteredLogs.slice(-this.CLIENT_HISTORY_LIMIT);
    } else {
      // No filter - send the last 1,000 logs (or all available if less than 1,000)
      const logsToSend = this.storedLogs.slice(-this.CLIENT_HISTORY_LIMIT);
      filteredLogs = this.filterLogsForClient(client, logsToSend);
    }
    
    if (filteredLogs.length === 0) {
      // Send empty response to signal history is complete
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send('');
        } catch (error) {
          // Silent fail for empty response
        }
      }
      return;
    }
    
    const historicalData = filteredLogs.join('\n');
    const dataSize = Buffer.byteLength(historicalData, 'utf8');
    
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(historicalData);
        client.messagesSent += filteredLogs.length;
        client.totalBytesSent += dataSize;
        
        // Update stats
        this.stats.totalMessagesSent += filteredLogs.length;
        this.stats.totalBytesSent += dataSize;
      } catch (error) {
        Logger.error('Failed to send filtered log history to client', {
          error: error.message,
          clientAddress: client.clientInfo.remoteAddress
        });
      }
    }
  }

  updateClientTextSearch(ws, textSearch) {
    const client = this.clients.get(ws);
    if (client) {
      const oldTextSearch = client.textSearch;
      
      client.textSearch = textSearch || '';
      client.textSearchLowerCase = client.textSearch.toLowerCase();
      
      // Only send filtered history if text search actually changed
      if (oldTextSearch !== client.textSearch) {
        this.sendLogHistoryToClient(client);
      }
      
      return true;
    }
    return false;
  }

  // Apply server-side filtering to log lines
  filterLogsForClient(client, logLines) {
    let filtered = logLines;
    
    // Apply text search filter if present
    if (client.textSearch) {
      const textSearchFiltered = [];
      for (const line of filtered) {
        if (line.toLowerCase().includes(client.textSearchLowerCase)) {
          textSearchFiltered.push(line);
        }
      }
      filtered = textSearchFiltered;
    }
    
    return filtered;
  }

  broadcastBufferedMessages() {
    if (this.messageBuffer.length === 0) {
      this.bufferTimeout = null;
      return;
    }

    let successfulSends = 0;
    let totalBytesSent = 0;

    // Apply per-client filtering and send individually
    for (const [ws, client] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          // Apply server-side filtering for this client
          const filteredLogs = this.filterLogsForClient(client, this.messageBuffer);
          
          if (filteredLogs.length > 0) {
            const filteredData = filteredLogs.join('\n');
            const filteredDataSize = Buffer.byteLength(filteredData, 'utf8');
            
            ws.send(filteredData);
            client.messagesSent += filteredLogs.length;
            client.totalBytesSent += filteredDataSize;
            
            totalBytesSent += filteredDataSize;
            successfulSends++;
          }
        } catch (error) {
          // Only log repeated client send failures if they're different errors
          if (error.message !== client.lastErrorMessage) {
            Logger.error('Failed to send filtered logs to client', {
              error: error.message,
              clientAddress: client.clientInfo.remoteAddress
            });
            client.lastErrorMessage = error.message;
          }
        }
      }
    }

    // Update stats
    this.stats.totalMessagesSent += this.messageBuffer.length * successfulSends;
    this.stats.totalBytesSent += totalBytesSent;
    
    this.messageBuffer = [];
    this.bufferTimeout = null;
  }

  startStatsReporting() {
    this.statsInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastReset = now - this.stats.lastStatsReset;
      const secondsElapsed = timeSinceLastReset / 1000;
      
      // Only log if there's activity or clients connected
      if (this.clients.size > 0 || this.stats.totalMessagesProcessed > 0) {
        Logger.info('Periodic stats report', {
          activeClients: this.clients.size,
          storedLogsCount: this.storedLogs.length,
          messagesProcessedRate: Math.round(this.stats.totalMessagesProcessed / secondsElapsed * 10) / 10,
          bytesProcessedRate: Math.round(this.stats.totalBytesProcessed / secondsElapsed / 1024 * 10) / 10, // KB/s
          totalConnections: this.stats.totalClientConnections,
          totalDisconnections: this.stats.totalClientDisconnections,
          messagesSentRate: Math.round(this.stats.totalMessagesSent / secondsElapsed * 10) / 10,
          bytesSentRate: Math.round(this.stats.totalBytesSent / secondsElapsed / 1024 * 10) / 10, // KB/s
          tailProcessActive: this.isStarted,
          uptimeSeconds: Math.round(secondsElapsed)
        });
      }
      
      // Reset counters for next period
      this.stats.totalMessagesProcessed = 0;
      this.stats.totalBytesProcessed = 0;
      this.stats.totalMessagesSent = 0;
      this.stats.totalBytesSent = 0;
      this.stats.lastStatsReset = now;
    }, 5000); // Every 5 seconds
  }

  stopStatsReporting() {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }
}

// Create global broadcaster instance
const logBroadcaster = new LogBroadcaster();

const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: {
    // Enable compression to reduce bandwidth
    deflate: true,
    threshold: 1024,
    concurrencyLimit: 10,
  }
});

wss.on('connection', function connection(ws, req) {
  const clientInfo = {
    remoteAddress: req.connection.remoteAddress,
    userAgent: req.headers['user-agent'],
    connectionTime: new Date().toISOString()
  };

  // Add client to the global broadcaster
  logBroadcaster.addClient(ws, clientInfo);

  // Handle messages from client (text search updates only)
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'setTextSearch') {
        // Handle text search message
        const textSearchValue = typeof data.value === 'string' ? data.value.trim() : '';
        logBroadcaster.updateClientTextSearch(ws, textSearchValue);
      }
    } catch (error) {
      Logger.error('Invalid message from client', {
        error: error.message,
        clientAddress: clientInfo.remoteAddress
      });
    }
  });

  ws.on('close', (code, reason) => {
    // Remove client from broadcaster
    logBroadcaster.removeClient(ws, clientInfo);
  });

  ws.on('error', (error) => {
    Logger.error('WebSocket connection error', {
      error: error.message,
      clientAddress: clientInfo.remoteAddress,
      errorCode: error.code
    });
    
    // Remove client from broadcaster
    logBroadcaster.removeClient(ws, clientInfo);
  });
});

const PORT = 9123;

// Handle process termination gracefully
process.on('SIGTERM', () => {
  Logger.info('Received SIGTERM, shutting down gracefully');
  
  // Stop the global tail process
  logBroadcaster.stopTailProcess();
  
  server.close(() => {
    Logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  Logger.info('Received SIGINT, shutting down gracefully');
  
  // Stop the global tail process
  logBroadcaster.stopTailProcess();
  
  server.close(() => {
    Logger.info('HTTP server closed');
    process.exit(0);
  });
});

server.listen(PORT, () => {
  Logger.info('Live log stream server started', {
    port: PORT,
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
    url: `http://localhost:${PORT}`,
    maxClients: 'unlimited (shared tail process)',
    maxStoredLogs: logBroadcaster.MAX_STORED_LOGS,
    clientHistoryLimit: logBroadcaster.CLIENT_HISTORY_LIMIT,
    features: ['IP obfuscation', 'Log broadcasting', 'Server-side log storage', 'Server-side filtering', 'Instant history delivery', 'Compression', 'Graceful shutdown']
  });
  
  // Start the tail process immediately when server starts
  logBroadcaster.startTailProcess();
});

// Periodic health check and cleanup
setInterval(() => {
  // Clean up any closed connections that weren't properly removed
  const activeBefore = logBroadcaster.clients.size;
  
  for (const [ws, client] of logBroadcaster.clients) {
    if (ws.readyState !== WebSocket.OPEN) {
      logBroadcaster.clients.delete(ws);
    }
  }
  
  const activeAfter = logBroadcaster.clients.size;
  const cleaned = activeBefore - activeAfter;
  
  // Only log health check if there were issues or significant activity
  if (cleaned > 0) {
    Logger.info('Health check - cleaned up connections', {
      activeClients: activeAfter,
      cleanedConnections: cleaned,
      tailProcessActive: logBroadcaster.isStarted,
      tailPid: logBroadcaster.tail ? logBroadcaster.tail.pid : null
    });
  }
  
  // Keep tail process running even with no clients for immediate response
  // when new clients connect
}, 30000); // Every 30 seconds
